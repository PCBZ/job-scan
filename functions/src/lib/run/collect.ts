// The collect run: what the sources handed over, merged, then the rest of
// the pipeline: dedupe, gates, screen, judge, rank, explain, report, delivery
// and mark_seen. It runs when every expected source has handed over, or at the
// deadline with what it has, so a source that never reports can't stop the day's
// report. A failure is rethrown so the invocation fails and the host records it;
// mark_seen then never ran, so tomorrow sees the same mail. The message is not
// retried (see HandoffStore.claim): a retry after a delivery would send the
// report again.
//
// After a run, its records are written for offline evaluation; a failed
// write is logged, not a failed run, since the report is already out.

import type { Source } from "../postings/types.js";
import { RUN_SPANS } from "../telemetry/spans.js";
import { inSpan } from "../telemetry/tracing.js";
import { buildCollectWorkflow, type State } from "../workflow/graph.js";
import type { Loop } from "../workflow/state.js";
import type { NodeEvent } from "../workflow/types.js";
import type { Pipeline } from "./compose.js";
import { EVALUATION_DELAY_MINUTES } from "./eval-queue.js";
import {
  COLLECT_DEADLINE_MINUTES,
  COLLECT_RECHECK_SECONDS,
  EXPECTED_SOURCES,
  type HandoffMessage,
  mergeMeta,
  type SourceHandoff,
  seedFrom,
} from "./handoff.js";
import { RUN_TIMEOUT_MS, type RunLog } from "./ingest.js";
import { loopRecord, runRecords } from "./records.js";

export interface RunSummary {
  outcome: string;
  top: number;
  warnings: number;
  usage: Record<string, { input: number; output: number }>;
  /** Time model calls spent waiting for the TPM budget. */
  throttledMs: number;
  /** 429s the provider answered, the SDK's retries included. */
  rateLimited: number;
  /** Rows extracted per job board, so dropped can be read as a rate. */
  extracted: Partial<Record<Source, number>>;
  /** Rows dropped as misaligned after the last repair, per job board. */
  dropped: Partial<Record<Source, number>>;
  /** Per loop: repairs sent, problems the first check found, problems left. */
  loops: Record<Loop, { repairs: number; firstPass: number; unresolved: number }>;
}

function loopCounts(state: State): RunSummary["loops"] {
  const counts = (loop: Loop) => {
    const r = loopRecord(state.loops[loop]);
    return { repairs: r.repairs, firstPass: r.first_pass.length, unresolved: r.unresolved.length };
  };
  return { extract: counts("extract"), judge: counts("judge"), explain: counts("explain") };
}

function perSource(state: State): Partial<Record<Source, number>> {
  const out: Partial<Record<Source, number>> = {};
  for (const p of state.extracted) out[p.source] = (out[p.source] ?? 0) + 1;
  return out;
}

export interface CollectOptions {
  /** The sources to wait for; defaults to every source there is. */
  expected?: readonly string[];
  now?: () => Date;
  signal?: AbortSignal;
}

/** What a message led to: a run, a wait for a missing source, or nothing to do. */
export type CollectResult =
  | { status: "ran"; summary: RunSummary }
  | { status: "waiting"; missing: string[] }
  | { status: "duplicate" };

export async function runCollect(
  pipeline: Pipeline,
  message: HandoffMessage,
  log: RunLog,
  o: CollectOptions = {},
): Promise<CollectResult> {
  const now = o.now ?? (() => new Date());
  const signal = o.signal ?? AbortSignal.timeout(RUN_TIMEOUT_MS);
  const expected = o.expected ?? EXPECTED_SOURCES;

  // The message's own file, and the newest one each other source wrote today.
  const files = new Map<string, string>([[message.source, message.blob]]);
  for (const source of expected) {
    if (files.has(source)) continue;
    const latest = await pipeline.handoffs.latest(message.day, source);
    if (latest) files.set(source, latest);
  }
  const missing = expected.filter((s) => !files.has(s));
  if (missing.length > 0) {
    const waitedMs = now().getTime() - Date.parse(message.first_seen);
    if (waitedMs < COLLECT_DEADLINE_MINUTES * 60_000) {
      await pipeline.handoffQueue.send(message, COLLECT_RECHECK_SECONDS);
      log.log(`collect: waiting for ${missing.join(", ")}`);
      return { status: "waiting", missing };
    }
    log.log(`collect: deadline passed without ${missing.join(", ")}`);
  }

  if (!(await pipeline.handoffs.claim(message.day, [...files.values()]))) {
    log.log("collect: these files were already collected");
    return { status: "duplicate" };
  }

  const handoffs: SourceHandoff[] = [];
  for (const name of files.values()) handoffs.push(await pipeline.handoffs.read(name));
  const meta = mergeMeta(handoffs);

  const nodeMs = { ...meta.nodeMs };
  const onNode = (e: NodeEvent) => {
    nodeMs[e.node] = (nodeMs[e.node] ?? 0) + Math.round(e.ms);
    log.log(
      `node ${e.node} ${e.ok ? "ok" : "failed"} ${Math.round(e.ms)}ms${e.usage ? ` tokens ${e.usage.input}/${e.usage.output}${e.usage.cached !== undefined ? ` cached ${e.usage.cached}` : ""}` : ""}`,
    );
  };
  const workflow = buildCollectWorkflow(
    pipeline.deterministicSteps,
    pipeline.modelSteps,
    pipeline.effects,
    { onNode },
  );
  try {
    // Its own trace, linked to each source's: several sources lead to one
    // collect, so none of them is its parent.
    let traceId = "";
    const state = await inSpan(
      RUN_SPANS.collect,
      {},
      (span) => {
        traceId = span.spanContext().traceId;
        return workflow.invoke(seedFrom(handoffs), { signal });
      },
      meta.traces,
    );
    const traceIds = [...new Set([traceId, ...meta.traces.map((t) => t.trace_id)])];
    const throttledMs = meta.throttledMs + Math.round(pipeline.throttledMs?.() ?? 0);
    const rateLimited = meta.rateLimited + (pipeline.rateLimited?.() ?? 0);
    const summary: RunSummary = {
      outcome: state.outcome,
      top: state.top.length,
      warnings: state.warnings.length,
      usage: state.usage,
      throttledMs,
      rateLimited,
      extracted: perSource(state),
      dropped: state.dropped,
      loops: loopCounts(state),
    };
    log.log(`collect: done ${JSON.stringify(summary)}`);
    try {
      const records = runRecords(state, {
        started_at: meta.startedAt,
        ended_at: now().toISOString(),
        trace_id: traceId,
        trace_ids: traceIds,
        version: pipeline.version,
        node_ms: nodeMs,
        throttled_ms: throttledMs,
        rate_limited: rateLimited,
        models: pipeline.models,
        ...(pipeline.judgementCache ? { judgement_cache: pipeline.judgementCache() } : {}),
      });
      const name = await pipeline.records.write(records, new Date(meta.startedAt));
      log.log(`collect: run records ${name} (${records.length})`);
      // The evaluation report reads this record, so it's queued only once written.
      try {
        await pipeline.evalQueue.send(
          { record: name, traceId, startedAt: meta.startedAt },
          (state.config?.report.evaluation_delay_minutes ?? EVALUATION_DELAY_MINUTES) * 60,
        );
        log.log(`collect: evaluation report queued for ${name}`);
      } catch (err) {
        log.error(`collect: evaluation report not queued: ${errorText(err)}`);
      }
    } catch (err) {
      log.error(`collect: run records not written: ${errorText(err)}`);
    }
    return { status: "ran", summary };
  } catch (err) {
    log.error(`collect: failed: ${errorText(err)}`);
    throw err;
  }
}

const errorText = (err: unknown) =>
  err instanceof Error ? `${err.name}: ${err.message}` : String(err);
