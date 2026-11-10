// The mail source's run: the alerts read and the postings extracted
// from them, then handed to `collect` as a file and a queue message. Nothing is
// judged, delivered or marked seen here. A failure is rethrown so the invocation
// fails and the host records it; the mail was not marked seen, so tomorrow sees
// it again.

import { runDay } from "../day.js";
import { inSpan } from "../telemetry/tracing.js";
import { buildMailWorkflow } from "../workflow/graph.js";
import type { NodeEvent } from "../workflow/types.js";
import type { Pipeline } from "./compose.js";
import { handoffFrom, type SourceHandoff } from "./handoff.js";

/** Under host.json's functionTimeout of 30 minutes, so the run stops cleanly first. */
export const RUN_TIMEOUT_MS = 25 * 60 * 1000;

export interface RunLog {
  log(message: string): void;
  error(message: string): void;
}

export async function runIngest(
  pipeline: Pipeline,
  log: RunLog,
  signal: AbortSignal = AbortSignal.timeout(RUN_TIMEOUT_MS),
  now: () => Date = () => new Date(),
) {
  const startedAt = now();
  const nodeMs: Record<string, number> = {};
  const onNode = (e: NodeEvent) => {
    nodeMs[e.node] = (nodeMs[e.node] ?? 0) + Math.round(e.ms);
    log.log(
      `node ${e.node} ${e.ok ? "ok" : "failed"} ${Math.round(e.ms)}ms${e.usage ? ` tokens ${e.usage.input}/${e.usage.output}${e.usage.cached !== undefined ? ` cached ${e.usage.cached}` : ""}` : ""}`,
    );
  };
  const workflow = buildMailWorkflow(pipeline.deterministicSteps, pipeline.modelSteps, { onNode });
  try {
    // One span over the source's graph; the nodes' spans nest under it,
    // and collect's join its trace, so the evaluation report finds the whole run.
    let trace: SourceHandoff["trace"] = null;
    const state = await inSpan("daily run", {}, (span) => {
      const { traceId, spanId } = span.spanContext();
      trace = { trace_id: traceId, span_id: spanId };
      return workflow.invoke({}, { signal });
    });
    const handoff = handoffFrom(state, {
      source: "mail",
      day: runDay(startedAt),
      started_at: startedAt.toISOString(),
      trace,
      node_ms: nodeMs,
      throttled_ms: Math.round(pipeline.throttledMs?.() ?? 0),
      rate_limited: pipeline.rateLimited?.() ?? 0,
    });
    const blob = await pipeline.handoffs.write(handoff);
    await pipeline.handoffQueue.send({
      day: handoff.day,
      source: handoff.source,
      blob,
      first_seen: now().toISOString(),
    });
    log.log(`daily: handed over ${state.postings.length} postings in ${blob}`);
    return { blob, postings: state.postings.length };
  } catch (err) {
    log.error(`daily: failed: ${errorText(err)}`);
    throw err;
  }
}

const errorText = (err: unknown) =>
  err instanceof Error ? `${err.name}: ${err.message}` : String(err);
