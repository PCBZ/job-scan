// One morning run: the workflow over the composed pipeline, logged node by
// node. A failure is rethrown so the invocation fails and the host records it;
// mark_seen then never ran, so tomorrow sees the same mail. After a run, its
// records are written for offline evaluation (#97); a failed write is logged,
// not a failed run, since the report is already out.

import type { Source } from "../postings/types.js";
import { inSpan } from "../telemetry/tracing.js";
import { buildWorkflow, type State } from "../workflow/graph.js";
import type { Loop } from "../workflow/state.js";
import type { NodeEvent } from "../workflow/types.js";
import type { Pipeline } from "./compose.js";
import { loopRecord, runRecords } from "./records.js";

/** Under host.json's functionTimeout of 30 minutes, so the run stops cleanly first. */
export const RUN_TIMEOUT_MS = 25 * 60 * 1000;

export interface RunLog {
  log(message: string): void;
  error(message: string): void;
}

export interface RunSummary {
  outcome: string;
  top: number;
  warnings: number;
  usage: Record<string, { input: number; output: number }>;
  /** Time model calls spent waiting for the TPM budget. */
  throttledMs: number;
  /** 429s the provider answered, the SDK's retries included (#99). */
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

export async function runDaily(
  pipeline: Pipeline,
  log: RunLog,
  signal: AbortSignal = AbortSignal.timeout(RUN_TIMEOUT_MS),
) {
  const startedAt = new Date();
  const nodeMs: Record<string, number> = {};
  const onNode = (e: NodeEvent) => {
    nodeMs[e.node] = (nodeMs[e.node] ?? 0) + Math.round(e.ms);
    log.log(
      `node ${e.node} ${e.ok ? "ok" : "failed"} ${Math.round(e.ms)}ms${e.usage ? ` tokens ${e.usage.input}/${e.usage.output}${e.usage.cached !== undefined ? ` cached ${e.usage.cached}` : ""}` : ""}`,
    );
  };
  const workflow = buildWorkflow(
    pipeline.deterministicSteps,
    pipeline.modelSteps,
    pipeline.effects,
    { onNode },
  );
  try {
    // One span over the whole graph; the nodes' spans nest under it (#101).
    const state = await inSpan("daily run", {}, () => workflow.invoke({}, { signal }));
    const summary: RunSummary = {
      outcome: state.outcome,
      top: state.top.length,
      warnings: state.warnings.length,
      usage: state.usage,
      throttledMs: Math.round(pipeline.throttledMs?.() ?? 0),
      rateLimited: pipeline.rateLimited?.() ?? 0,
      extracted: perSource(state),
      dropped: state.dropped,
      loops: loopCounts(state),
    };
    log.log(`daily: done ${JSON.stringify(summary)}`);
    try {
      const records = runRecords(state, {
        started_at: startedAt.toISOString(),
        version: pipeline.version,
        node_ms: nodeMs,
        throttled_ms: summary.throttledMs,
        rate_limited: summary.rateLimited,
      });
      const name = await pipeline.records.write(records, startedAt);
      log.log(`daily: run records ${name} (${records.length})`);
    } catch (err) {
      log.error(`daily: run records not written: ${errorText(err)}`);
    }
    return summary;
  } catch (err) {
    log.error(`daily: failed: ${errorText(err)}`);
    throw err;
  }
}

const errorText = (err: unknown) =>
  err instanceof Error ? `${err.name}: ${err.message}` : String(err);
