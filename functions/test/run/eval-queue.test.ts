import type { QueueClient } from "@azure/storage-queue";
import { describe, expect, it } from "vitest";
import { evalQueue, REPORT_DELAY_SECONDS } from "../../src/lib/run/eval-queue.js";

/** The QueueClient calls the adapter makes, recorded. */
function fakeQueue() {
  const sent: { text: string; visibilityTimeout: number | undefined }[] = [];
  const queue = {
    sendMessage: async (text: string, options?: { visibilityTimeout?: number }) => {
      sent.push({ text, visibilityTimeout: options?.visibilityTimeout });
      return {};
    },
  };
  return { queue: queue as unknown as QueueClient, sent };
}

describe("evalQueue", () => {
  it("sends the message as base64 JSON, hidden until the run's telemetry is in", async () => {
    const { queue, sent } = fakeQueue();
    const message = {
      record: "2026-10-15/2026-10-15T15:00:00.000Z-abcd1234.jsonl",
      traceId: "0af7651916cd43dd8448eb211c80319c",
      startedAt: "2026-10-15T15:00:00.000Z",
    };
    await evalQueue(queue).send(message);
    expect(sent).toHaveLength(1);
    // The Functions queue trigger decodes base64 by default.
    expect(JSON.parse(Buffer.from(sent[0]?.text ?? "", "base64").toString("utf8"))).toEqual(
      message,
    );
    expect(sent[0]?.visibilityTimeout).toBe(REPORT_DELAY_SECONDS);
    expect(REPORT_DELAY_SECONDS).toBe(900);
  });

  it("takes another delay when given one", async () => {
    const { queue, sent } = fakeQueue();
    await evalQueue(queue, 60).send({ record: "r.jsonl", startedAt: "2026-10-15T15:00:00.000Z" });
    expect(sent[0]?.visibilityTimeout).toBe(60);
  });
});
