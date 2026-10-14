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
  /** The run's trace id, to find its spans in Application Insights; absent untraced. */
  traceId?: string;
  startedAt: string;
}

/**
 * Seconds a message stays hidden: long enough for Application Insights to
 * ingest the run's telemetry before the report looks for it.
 */
export const REPORT_DELAY_SECONDS = 15 * 60;

export interface EvalQueue {
  send(message: EvalMessage): Promise<void>;
}

type Queue = Pick<QueueClient, "sendMessage">;

/**
 * Messages are base64-encoded JSON: the Functions queue trigger decodes
 * base64 by default.
 */
export function evalQueue(queue: Queue, delaySeconds = REPORT_DELAY_SECONDS): EvalQueue {
  return {
    async send(message) {
      const text = Buffer.from(JSON.stringify(message), "utf8").toString("base64");
      await queue.sendMessage(text, { visibilityTimeout: delaySeconds });
    },
  };
}

/** From EVAL_QUEUE_URL, the queue's endpoint. */
export function evalQueueFromUrl(queueUrl: string, credential: TokenCredential): EvalQueue {
  return evalQueue(new QueueClient(queueUrl, credential));
}
