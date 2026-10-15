import type { QueueClient } from "@azure/storage-queue";
import { describe, expect, it } from "vitest";
import { evalQueue, smokeResults } from "../../src/lib/run/eval-queue.js";

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
  it("sends the message as plain JSON, hidden for the delay it's given", async () => {
    const { queue, sent } = fakeQueue();
    const message = {
      record: "2026-10-15/2026-10-15T15:00:00.000Z-abcd1234.jsonl",
      traceId: "0af7651916cd43dd8448eb211c80319c",
      startedAt: "2026-10-15T15:00:00.000Z",
    };
    await evalQueue(queue).send(message, 900);
    // host.json's messageEncoding "none" reads it as is.
    expect(sent).toEqual([{ text: JSON.stringify(message), visibilityTimeout: 900 }]);
  });

  it("sends a smoke result as plain JSON, visible at once (#134)", async () => {
    const { queue, sent } = fakeQueue();
    await smokeResults(queue)({ id: "run-1", ok: true, subject: "s" });
    expect(sent).toEqual([
      { text: '{"id":"run-1","ok":true,"subject":"s"}', visibilityTimeout: undefined },
    ]);
  });
});
