import { describe, expect, it } from "vitest";
import { runCollect } from "../../src/lib/run/collect.js";
import {
  COLLECT_DEADLINE_MINUTES,
  COLLECT_RECHECK_SECONDS,
  type HandoffMessage,
} from "../../src/lib/run/handoff.js";
import { runIngest } from "../../src/lib/run/ingest.js";
import { posting } from "../postings/helpers.js";
import { fakes } from "../workflow/fakes.js";

const quiet = { log: () => {}, error: () => {} };

/** The mail source alone, as before another source existed. */
const MAIL = { expected: ["mail"] };

/** The mail source has run; its message is what collect gets. */
async function afterMail(options: Parameters<typeof fakes>[0] = {}) {
  const f = fakes(options);
  await runIngest(f, quiet);
  const message = f.handoffMessages[0] as HandoffMessage;
  return { f, message };
}

/** Another source's file for the same day, as a second source would write it. */
async function otherSource(
  f: Awaited<ReturnType<typeof afterMail>>["f"],
  message: HandoffMessage,
  source = "second",
) {
  const mailFile = await f.handoffs.read(message.blob);
  return f.handoffs.write({
    ...mailFile,
    source,
    started_at: "2026-10-13T12:00:00.000Z",
    mail: null,
    extracted: [posting({ title: "Platform Engineer", row: 9 })],
    postings: [posting({ title: "Platform Engineer", row: 9 })],
    dropped: {},
    suspicious: {},
    usage: {},
    node_ms: { scrape: 4000 },
    throttled_ms: 0,
    rate_limited: 0,
    warnings: [],
  });
}

describe("collect", () => {
  it("runs on the mail source's message alone, as the whole day's run once did", async () => {
    const { f, message } = await afterMail();
    const result = await runCollect(f, message, quiet, MAIL);
    expect(result).toMatchObject({ status: "ran", summary: { outcome: "report", top: 1 } });
    expect(f.log).toContain("deliver");
    expect(f.log).toContain("mark_seen");
  });

  it("does nothing for a message it already collected", async () => {
    const { f, message } = await afterMail();
    await runCollect(f, message, quiet, MAIL);
    f.log.length = 0;
    expect(await runCollect(f, message, quiet, MAIL)).toEqual({ status: "duplicate" });
    expect(f.log).toEqual([]);
  });

  it("is not retried after a failed run: its mail is reported again tomorrow", async () => {
    const { f, message } = await afterMail({ deliverFails: true });
    await expect(runCollect(f, message, quiet, MAIL)).rejects.toThrow("smtp down");
    expect(await runCollect(f, message, quiet, MAIL)).toEqual({ status: "duplicate" });
    expect(f.log).not.toContain("mark_seen");
  });

  it("starts from the source's start, so the record's times cover the whole run", async () => {
    const { f, message } = await afterMail();
    const written: string[] = [];
    f.records.write = async (_r, startedAt) => {
      written.push(startedAt.toISOString());
      return "x.jsonl";
    };
    await runCollect(f, message, quiet, MAIL);
    const mailFile = await f.handoffs.read(message.blob);
    expect(written).toEqual([mailFile.started_at]);
  });

  describe("with every source there is", () => {
    const at = (message: HandoffMessage, minutes: number) => () =>
      new Date(Date.parse(message.first_seen) + minutes * 60_000);

    it("runs on mail and jobspy together, merging their postings", async () => {
      const { f, message } = await afterMail();
      await otherSource(f, message, "jobspy");
      const result = await runCollect(f, message, quiet);
      expect(result).toMatchObject({ status: "ran", summary: { outcome: "report" } });
      if (result.status === "ran") expect(result.summary.extracted).toEqual({ indeed: 2 });
    });

    it("goes on with jobspy's postings on a day with no mail", async () => {
      const { f, message } = await afterMail({ messages: 0 });
      await otherSource(f, message, "jobspy");
      const result = await runCollect(f, message, quiet);
      expect(result).toMatchObject({ status: "ran", summary: { outcome: "report" } });
      expect(f.log).toContain("mark_seen");
    });

    it("sends the short report when neither source has anything", async () => {
      const { f, message } = await afterMail({ messages: 0 });
      const mailFile = await f.handoffs.read(message.blob);
      await f.handoffs.write({ ...mailFile, source: "jobspy", mail: null });
      const result = await runCollect(f, message, quiet);
      expect(result).toMatchObject({ status: "ran", summary: { outcome: "no_mail" } });
    });

    it("waits for jobspy, and runs on the mail alone at the deadline", async () => {
      const { f, message } = await afterMail();
      const sent: unknown[] = [];
      f.handoffQueue.send = async (m) => void sent.push(m);
      const waiting = await runCollect(f, message, quiet, { now: at(message, 5) });
      expect(waiting).toEqual({ status: "waiting", missing: ["jobspy"] });
      expect(sent).toHaveLength(1);
      const late = await runCollect(f, message, quiet, {
        now: at(message, COLLECT_DEADLINE_MINUTES + 1),
      });
      expect(late.status).toBe("ran");
    });

    it("runs on jobspy's message when mail's file is the one missing", async () => {
      const { f, message } = await afterMail();
      const blob = await otherSource(f, message, "jobspy");
      const result = await runCollect(f, { ...message, source: "jobspy", blob }, quiet);
      expect(result.status).toBe("ran");
    });
  });

  describe("with a second source expected", () => {
    const expected = ["mail", "second"];

    it("waits for it, asking again later, until the deadline", async () => {
      const { f, message } = await afterMail();
      const sent: [HandoffMessage, number | undefined][] = [];
      f.handoffQueue.send = async (m, delay) => void sent.push([m, delay]);
      const at = (minutes: number) => () =>
        new Date(Date.parse(message.first_seen) + minutes * 60_000);

      const result = await runCollect(f, message, quiet, { expected, now: at(1) });
      expect(result).toEqual({ status: "waiting", missing: ["second"] });
      expect(sent).toEqual([[message, COLLECT_RECHECK_SECONDS]]);
      expect(f.log).not.toContain("deliver");

      // Nothing is claimed while it waits: the next look can still run.
      const late = await runCollect(f, message, quiet, {
        expected,
        now: at(COLLECT_DEADLINE_MINUTES + 1),
      });
      expect(late.status).toBe("ran");
      expect(f.log).toContain("deliver");
    });

    it("merges both sources' postings once the second has handed over", async () => {
      const { f, message } = await afterMail();
      await otherSource(f, message);
      const result = await runCollect(f, message, quiet, { expected });
      expect(result.status).toBe("ran");
      if (result.status !== "ran") return;
      expect(result.summary.extracted).toEqual({ indeed: 2 });
      expect(f.reported[0]?.top.length).toBeGreaterThan(0);
    });

    it("runs once when both sources' messages arrive together", async () => {
      const { f, message } = await afterMail();
      const second: HandoffMessage = {
        ...message,
        source: "second",
        blob: await otherSource(f, message),
      };
      const results = await Promise.all([
        runCollect(f, message, quiet, { expected }),
        runCollect(f, second, quiet, { expected }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(["duplicate", "ran"]);
      expect(f.log.filter((l) => l === "deliver")).toHaveLength(1);
    });
  });

  it("adds the source's waiting and rate limits to its own", async () => {
    const f = fakes();
    await runIngest({ ...f, throttledMs: () => 10, rateLimited: () => 1 }, quiet);
    const message = f.handoffMessages[0] as HandoffMessage;
    const result = await runCollect(
      { ...f, throttledMs: () => 5, rateLimited: () => 2 },
      message,
      quiet,
      MAIL,
    );
    expect(result).toMatchObject({ summary: { throttledMs: 15, rateLimited: 3 } });
  });
});

describe("ingest", () => {
  it("hands over the postings and queues one message naming them", async () => {
    const f = fakes();
    await runIngest(f, quiet);
    expect(f.handoffMessages).toHaveLength(1);
    const message = f.handoffMessages[0] as HandoffMessage;
    expect(message).toMatchObject({
      source: "mail",
      day: expect.stringMatching(/^\d{4}-\d\d-\d\d$/),
    });
    expect(f.postingBlobs.has(message.blob)).toBe(true);
    const file = await f.handoffs.read(message.blob);
    expect(file.postings).toHaveLength(1);
    expect(file.node_ms).toHaveProperty("extract_postings");
    // Nothing past extraction happened here.
    expect(f.log).not.toContain("dedupe");
    expect(f.log).not.toContain("deliver");
    expect(f.log).not.toContain("mark_seen");
  });

  it("hands over a quiet day too, so collect sends the short report", async () => {
    const f = fakes({ messages: 0 });
    await runIngest(f, quiet);
    expect(f.handoffMessages).toHaveLength(1);
    const result = await runCollect(f, f.handoffMessages[0] as HandoffMessage, quiet, MAIL);
    expect(result).toMatchObject({ status: "ran", summary: { outcome: "no_mail" } });
  });

  it("hands over nothing when it fails, so tomorrow reads the same mail", async () => {
    const f = fakes();
    f.modelSteps.extractPostings = async () => {
      throw new Error("model down");
    };
    await expect(runIngest(f, quiet)).rejects.toThrow("model down");
    expect(f.handoffMessages).toEqual([]);
    expect(f.postingBlobs.size).toBe(0);
  });
});
