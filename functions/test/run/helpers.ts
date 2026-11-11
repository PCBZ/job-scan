import { type CollectOptions, runCollect } from "../../src/lib/run/collect.js";
import type { Pipeline } from "../../src/lib/run/compose.js";
import type { HandoffMessage } from "../../src/lib/run/handoff.js";
import { type RunLog, runIngest } from "../../src/lib/run/ingest.js";

type Day = Pipeline & { handoffMessages: HandoffMessage[] };

/**
 * One morning as the app runs it: the mail source, then collect on the message
 * the source queued. Returns collect's summary; a failure in either throws.
 */
export async function runDay(
  pipeline: Day,
  log: RunLog,
  signal?: AbortSignal,
  options: CollectOptions = { expected: ["mail"] },
) {
  await runIngest(pipeline, log, signal);
  const message = pipeline.handoffMessages.at(-1);
  if (!message) throw new Error("the source queued no message");
  // Each stage is its own invocation in the app, with its own counters; one
  // object stands in for both here, so collect starts its counters at zero.
  const collecting = { ...pipeline, throttledMs: () => 0, rateLimited: () => 0 };
  const result = await runCollect(collecting, message, log, {
    ...options,
    ...(signal ? { signal } : {}),
  });
  if (result.status !== "ran") throw new Error(`collect did not run: ${result.status}`);
  return result.summary;
}
