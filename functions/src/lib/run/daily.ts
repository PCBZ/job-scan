// One morning run: the workflow over the composed pipeline, logged node by
// node. A failure is rethrown so the invocation fails and the host records it;
// mark_seen then never ran, so tomorrow sees the same mail.

import { buildWorkflow } from "../workflow/graph.js";
import type { NodeEvent } from "../workflow/types.js";
import type { Pipeline } from "./compose.js";

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
}

export async function runDaily(
  pipeline: Pipeline,
  log: RunLog,
  signal: AbortSignal = AbortSignal.timeout(RUN_TIMEOUT_MS),
) {
  const onNode = (e: NodeEvent) =>
    log.log(
      `node ${e.node} ${e.ok ? "ok" : "failed"} ${Math.round(e.ms)}ms${e.usage ? ` tokens ${e.usage.input}/${e.usage.output}` : ""}`,
    );
  const workflow = buildWorkflow(
    pipeline.deterministicSteps,
    pipeline.modelSteps,
    pipeline.effects,
    { onNode },
  );
  try {
    const state = await workflow.invoke({}, { signal });
    const summary: RunSummary = {
      outcome: state.outcome,
      top: state.top.length,
      warnings: state.warnings.length,
      usage: state.usage,
    };
    log.log(`daily: done ${JSON.stringify(summary)}`);
    return summary;
  } catch (err) {
    log.error(
      `daily: failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
    );
    throw err;
  }
}
