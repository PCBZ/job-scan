import type { LogsQueryClient } from "@azure/monitor-query-logs";
import { describe, expect, it } from "vitest";
import { latencyFromLogs } from "../../src/lib/eval/latency.js";
import { MODEL_CALL_SPANS } from "../../src/lib/telemetry/spans.js";

const TRACE = "0d3354b7b5fa70d10000805a9af26a96";
const STARTED = new Date("2026-10-14T15:00:00Z");

/** A Log Analytics client answering each query with the next table, recording the queries. */
function fakeLogs(...tables: { columns: string[]; rows: unknown[][] }[] | ["fail"][]) {
  const queries: { kql: string; timespan: unknown }[] = [];
  const logs = {
    queryWorkspace: async (_workspace: string, kql: string, timespan: unknown) => {
      queries.push({ kql, timespan });
      const t = tables[queries.length - 1];
      if (Array.isArray(t)) {
        return {
          status: "PartialFailure",
          partialTables: [],
          partialError: { message: "query timed out" },
        };
      }
      return {
        status: "Success",
        tables: [
          { columnDescriptors: t?.columns.map((name) => ({ name })) ?? [], rows: t?.rows ?? [] },
        ],
      };
    },
  };
  return { logs: logs as unknown as LogsQueryClient, queries };
}

describe("latencyFromLogs", () => {
  it("summarizes the run's model calls, overall and per node", async () => {
    const { logs, queries } = fakeLogs(
      {
        columns: ["calls", "p50Ms", "p95Ms", "slowestMs", "failed", "runs", "callingIn"],
        rows: [[220, 3477.2, 6436.4, 9491, 0, 1, 1]],
      },
      {
        columns: ["Node", "calls", "p50Ms", "p95Ms", "slowestMs"],
        rows: [
          ["judge", 179, 3591, 6849, 9491],
          ["", 1, 100, 100, 100],
        ],
      },
    );
    const latency = await latencyFromLogs(logs, "ws")([TRACE], STARTED, [TRACE]);
    expect(latency).toEqual({
      calls: 220,
      p50Ms: 3477,
      p95Ms: 6436,
      slowestMs: 9491,
      failed: 0,
      byNode: [
        { node: "judge", calls: 179, p50Ms: 3591, p95Ms: 6849, slowestMs: 9491 },
        { node: "(no node)", calls: 1, p50Ms: 100, p95Ms: 100, slowestMs: 100 },
      ],
    });
    expect(queries[0]?.kql).toContain(`OperationId in ("${TRACE}")`);
    // Node's model-call spans and the scanner's, named differently by their SDKs.
    expect(queries[0]?.kql).toContain(
      `Name in ("${MODEL_CALL_SPANS.node}", "${MODEL_CALL_SPANS.python}")`,
    );
    expect(queries[0]?.timespan).toMatchObject({ startTime: new Date("2026-10-14T14:55:00Z") });
  });

  it("is null while the run's trace isn't in yet", async () => {
    const { logs, queries } = fakeLogs({ columns: ["calls", "runs"], rows: [[0, 0]] });
    expect(await latencyFromLogs(logs, "ws")([TRACE], STARTED, [TRACE])).toBeNull();
    expect(queries).toHaveLength(1);
  });

  it("queries all of the run's traces, and waits until each one's run span is in", async () => {
    const SOURCE = "1".repeat(32);
    const total = (runs: number) => ({
      columns: ["calls", "p50Ms", "p95Ms", "slowestMs", "failed", "runs", "callingIn"],
      rows: [[3, 10, 20, 30, 0, runs, 1]],
    });
    const waiting = fakeLogs(total(1));
    expect(await latencyFromLogs(waiting.logs, "ws")([TRACE, SOURCE], STARTED, [TRACE])).toBeNull();
    expect(waiting.queries[0]?.kql).toContain(`OperationId in ("${TRACE}", "${SOURCE}")`);
    const done = fakeLogs(total(2), { columns: ["Node", "calls"], rows: [] });
    expect(await latencyFromLogs(done.logs, "ws")([TRACE, SOURCE], STARTED, [TRACE])).toMatchObject(
      { calls: 3 },
    );
  });

  it("waits for a call in each trace that made calls, not just one of them", async () => {
    // Collect's judge calls are in; the mail trace has its run span but not its calls yet.
    const MAIL = "1".repeat(32);
    const total = (callingIn: number) => ({
      columns: ["calls", "p50Ms", "p95Ms", "slowestMs", "failed", "runs", "callingIn"],
      rows: [[3, 10, 20, 30, 0, 2, callingIn]],
    });
    const partial = fakeLogs(total(1));
    expect(
      await latencyFromLogs(partial.logs, "ws")([TRACE, MAIL], STARTED, [TRACE, MAIL]),
    ).toBeNull();
    expect(partial.queries[0]?.kql).toContain(
      `calls | where OperationId in ("${TRACE}", "${MAIL}") | summarize dcount(OperationId)`,
    );
    const all = fakeLogs(total(2), { columns: ["Node", "calls"], rows: [] });
    expect(
      await latencyFromLogs(all.logs, "ws")([TRACE, MAIL], STARTED, [TRACE, MAIL]),
    ).toMatchObject({ calls: 3 });
  });

  it("keeps waiting while a run that made model calls shows none yet", async () => {
    const zero = {
      columns: ["calls", "p50Ms", "p95Ms", "slowestMs", "failed", "runs", "callingIn"],
      rows: [[0, 0, 0, 0, 0, 1, 0]],
    };
    expect(await latencyFromLogs(fakeLogs(zero).logs, "ws")([TRACE], STARTED, [TRACE])).toBeNull();
    // A run that made none (no mail) is complete with none.
    const none = await latencyFromLogs(
      fakeLogs(zero, { columns: ["Node", "calls"], rows: [] }).logs,
      "ws",
    )([TRACE], STARTED, []);
    expect(none).toMatchObject({ calls: 0, byNode: [] });
  });

  it("throws on a failed query, and never queries with something that isn't a trace id", async () => {
    await expect(
      latencyFromLogs(fakeLogs(["fail"]).logs, "ws")([TRACE], STARTED, [TRACE]),
    ).rejects.toThrow("query timed out");
    const { logs, queries } = fakeLogs();
    await expect(
      latencyFromLogs(logs, "ws")([TRACE, '" | drop'], STARTED, [TRACE]),
    ).rejects.toThrow("not a trace id");
    await expect(latencyFromLogs(logs, "ws")([TRACE], STARTED, ["nope"])).rejects.toThrow(
      "not a trace id",
    );
    await expect(latencyFromLogs(logs, "ws")([], STARTED, [TRACE])).rejects.toThrow("no trace ids");
    expect(queries).toEqual([]);
  });
});
