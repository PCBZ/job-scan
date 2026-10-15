// The eval-reports queue (#128): after each run, a message naming its run
// record, for the evaluation report (#127) to pick up once the run's
// telemetry is in. The report is a separate function, so building it can't
// hold up or fail the daily run.

import type { TokenCredential } from "@azure/identity";
import { QueueClient } from "@azure/storage-queue";

/** What the evaluation report needs to find everything a run left behind. */
export interface EvalMessage {
  /** The run record's blob name in run-records. */
  record: string;
  /** The run's trace id, to find its spans in Application Insights. */
  traceId: string;
  startedAt: string;
  /** Times the report has already waited for the run's trace (#130). */
  waited?: number;
}

/**
 * How long a message stays hidden unless config.toml's
 * report.evaluation_delay_minutes says otherwise: long enough for Application
 * Insights to ingest the run's telemetry before the report looks for it.
 */
export const EVALUATION_DELAY_MINUTES = 15;

export interface EvalQueue {
  /** Queue the message, hidden for `delaySeconds`. */
  send(message: EvalMessage, delaySeconds: number): Promise<void>;
}

type Queue = Pick<QueueClient, "sendMessage">;

/**
 * Messages are plain JSON, readable in the portal; host.json sets the queue
 * trigger's messageEncoding to "none" to match.
 */
export function evalQueue(queue: Queue): EvalQueue {
  return {
    async send(message, delaySeconds) {
      await queue.sendMessage(JSON.stringify(message), { visibilityTimeout: delaySeconds });
    },
  };
}

/** From EVAL_QUEUE_URL, the queue's endpoint. */
export function evalQueueFromUrl(queueUrl: string, credential: TokenCredential): EvalQueue {
  return evalQueue(new QueueClient(queueUrl, credential));
}

/** What evalReport says about a smoke test (#134), for CD to wait on. */
export interface SmokeResult {
  id: string;
  ok: boolean;
  /** The run record it reported on. */
  record?: string;
  subject?: string;
  error?: string;
}

/** Sends smoke results to the eval-smoke queue, visible at once, as plain JSON. */
export function smokeResults(queue: Queue): (result: SmokeResult) => Promise<void> {
  return async (result) => {
    await queue.sendMessage(JSON.stringify(result));
  };
}

/** From EVAL_SMOKE_URL, the eval-smoke queue's endpoint. */
export function smokeResultsFromUrl(
  queueUrl: string,
  credential: TokenCredential,
): (result: SmokeResult) => Promise<void> {
  return smokeResults(new QueueClient(queueUrl, credential));
}
