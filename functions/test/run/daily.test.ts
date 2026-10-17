import { describe, expect, it } from "vitest";
import { runDaily } from "../../src/lib/run/daily.js";
import type { EvalMessage, EvalQueue } from "../../src/lib/run/eval-queue.js";
import type { RunRecord, RunRecordStore } from "../../src/lib/run/records.js";
import { fakes } from "../workflow/fakes.js";

function recorder() {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    log: { log: (m: string) => lines.push(m), error: (m: string) => errors.push(m) },
  };
}

describe("runDaily", () => {
  it("runs the workflow, logs every node, and returns a summary", async () => {
    const f = fakes();
    const r = recorder();
    const summary = await runDaily(f, r.log);
    expect(summary).toMatchObject({ outcome: "report", top: 1, warnings: 0 });
    expect(summary.usage.judge).toEqual({ input: 10, output: 2 });
    expect(r.lines).toContainEqual(expect.stringMatching(/^node judge ok \d+ms tokens 10\/2$/));
    expect(r.lines.some((l) => l.startsWith("node mark_seen ok"))).toBe(true);
    expect(r.lines.find((l) => l.startsWith("daily: done "))).toMatch(
      /^daily: done \{"outcome":"report","top":1,"warnings":0,/,
    );
  });

  it("reports how long model calls waited for the TPM budget", async () => {
    const f = fakes();
    const summary = await runDaily({ ...f, throttledMs: () => 1234.4 }, recorder().log);
    expect(summary.throttledMs).toBe(1234);
    expect((await runDaily(fakes(), recorder().log)).throttledMs).toBe(0);
  });

  it("logs the runtime checks' counts: extracted and dropped per board, and per loop", async () => {
    // validate finds a problem on the first attempt, then none after the repair.
    const f = fakes({ extractProblems: [['message "<m0@x>" row 0: title is empty'], []] });
    const summary = await runDaily({ ...f, rateLimited: () => 3 }, recorder().log);
    expect(summary).toMatchObject({
      rateLimited: 3,
      extracted: { indeed: 1 },
      dropped: {},
      loops: {
        extract: { repairs: 1, firstPass: 1, unresolved: 0 },
        judge: { repairs: 0, firstPass: 0, unresolved: 0 },
        explain: { repairs: 0, firstPass: 0, unresolved: 0 },
      },
    });
  });

  it("counts problems no repair fixed as unresolved", async () => {
    const stuck = ['posting "x": quote not found'];
    const f = fakes({ judgeProblems: [stuck, stuck, stuck, stuck] });
    const { loops } = await runDaily(f, recorder().log);
    expect(loops.judge.unresolved).toBe(1);
    expect(loops.judge.firstPass).toBe(1);
    expect(loops.judge.repairs).toBeGreaterThan(0);
  });

  it("logs a failed run and rethrows, so the host records it and nothing is marked seen", async () => {
    const f = fakes({ deliverFails: true });
    const r = recorder();
    await expect(runDaily(f, r.log)).rejects.toThrow("smtp down");
    expect(r.errors).toEqual(["daily: failed: Error: smtp down"]);
    expect(r.lines.some((l) => l.startsWith("node deliver failed"))).toBe(true);
    expect(f.log).not.toContain("mark_seen");
  });

  it("stops when its signal aborts", async () => {
    const f = fakes({ resumeDelayMs: 50 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    await expect(runDaily(f, recorder().log, controller.signal)).rejects.toThrow();
    expect(f.log).not.toContain("deliver");
  });

  describe("evaluation report (#128)", () => {
    function queue(fail = false) {
      const sent: { message: EvalMessage; delaySeconds: number }[] = [];
      const evalQueue: EvalQueue = {
        async send(message, delaySeconds) {
          if (fail) throw new Error("queue 403");
          sent.push({ message, delaySeconds });
        },
      };
      return { evalQueue, sent };
    }
    const written: RunRecordStore = { write: async () => "2026-10-15/run.jsonl" };

    it("queues the report once the run record is written, naming it and the run's trace", async () => {
      const q = queue();
      const r = recorder();
      await runDaily({ ...fakes(), records: written, ...q }, r.log);
      expect(q.sent).toEqual([
        {
          message: {
            record: "2026-10-15/run.jsonl",
            traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
            startedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
          },
          // 15 minutes unless config.toml says otherwise.
          delaySeconds: 900,
        },
      ]);
      expect(r.lines.at(-1)).toBe("daily: evaluation report queued for 2026-10-15/run.jsonl");
    });

    it("waits as long as config.toml's report.evaluation_delay_minutes says", async () => {
      const q = queue();
      const f = fakes();
      const loadConfig = f.deterministicSteps.loadConfig;
      f.deterministicSteps.loadConfig = async () => {
        const config = await loadConfig();
        return { ...config, report: { ...config.report, evaluation_delay_minutes: 5 } };
      };
      await runDaily({ ...f, records: written, ...q }, recorder().log);
      expect(q.sent[0]?.delaySeconds).toBe(300);
    });

    it("logs a failed enqueue without failing the run", async () => {
      const r = recorder();
      const summary = await runDaily({ ...fakes(), records: written, ...queue(true) }, r.log);
      expect(summary.outcome).toBe("report");
      expect(r.errors).toEqual(["daily: evaluation report not queued: Error: queue 403"]);
    });

    it("queues nothing when the run record wasn't written: the report reads it", async () => {
      const q = queue();
      const failing: RunRecordStore = {
        write: async () => {
          throw new Error("blob 403");
        },
      };
      await runDaily({ ...fakes(), records: failing, ...q }, recorder().log);
      expect(q.sent).toEqual([]);
    });

    it("queues nothing for a failed run", async () => {
      const q = queue();
      await expect(
        runDaily({ ...fakes({ deliverFails: true }), records: written, ...q }, recorder().log),
      ).rejects.toThrow();
      expect(q.sent).toEqual([]);
    });
  });

  describe("run records", () => {
    function store(fail = false) {
      const writes: { records: RunRecord[]; startedAt: Date }[] = [];
      const records: RunRecordStore = {
        async write(r, startedAt) {
          if (fail) throw new Error("blob 403");
          writes.push({ records: r, startedAt });
          return "2026-10-13/run.jsonl";
        },
      };
      return { records, writes };
    }

    it("writes the run's records after it, with the version, node times and wait", async () => {
      const s = store();
      const r = recorder();
      await runDaily({ ...fakes(), ...s, version: "v0.1.6", throttledMs: () => 7 }, r.log);
      expect(s.writes).toHaveLength(1);
      const records = s.writes[0]?.records ?? [];
      expect(records.map((x) => x.kind)).toEqual([
        "posting",
        "filtered",
        "filtered",
        "pick",
        "run",
      ]);
      const run = records.at(-1);
      expect(run).toMatchObject({
        kind: "run",
        version: "v0.1.6",
        throttled_ms: 7,
        top: 1,
        models: { extract_postings: "nano-test", judge: "mini-test", explain: "mini-test" },
      });
      expect(run && "node_ms" in run && Object.keys(run.node_ms)).toContain("judge");
      expect(r.lines).toContain("daily: run records 2026-10-13/run.jsonl (5)");
    });

    it("logs a failed write without failing the run: the report is already out", async () => {
      const r = recorder();
      const summary = await runDaily({ ...fakes(), ...store(true) }, r.log);
      expect(summary.outcome).toBe("report");
      expect(r.errors).toEqual(["daily: run records not written: Error: blob 403"]);
    });

    it("writes nothing for a failed run", async () => {
      const s = store();
      await expect(
        runDaily({ ...fakes({ deliverFails: true }), ...s }, recorder().log),
      ).rejects.toThrow();
      expect(s.writes).toEqual([]);
    });
  });
});
