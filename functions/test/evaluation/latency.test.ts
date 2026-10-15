import type { LogsQueryClient } from "@azure/monitor-query-logs";
import { describe, expect, it } from "vitest";
import { latencyFromLogs } from "../../src/lib/eval/latency.js";

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
        columns: ["calls", "p50Ms", "p95Ms", "slowestMs", "failed", "runs"],
        rows: [[220, 3477.2, 6436.4, 9491, 0, 1]],
      },
      {
        columns: ["Node", "calls", "p50Ms", "p95Ms", "slowestMs"],
        rows: [
          ["judge", 179, 3591, 6849, 9491],
          ["", 1, 100, 100, 100],
        ],
      },
    );
    const latency = await latencyFromLogs(logs, "ws")(TRACE, STARTED);
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
    expect(queries[0]?.kql).toContain(`OperationId == "${TRACE}"`);
    expect(queries[0]?.timespan).toMatchObject({ startTime: new Date("2026-10-14T14:55:00Z") });
  });

  it("is null while the run's trace isn't in yet", async () => {
    const { logs, queries } = fakeLogs({ columns: ["calls", "runs"], rows: [[0, 0]] });
    expect(await latencyFromLogs(logs, "ws")(TRACE, STARTED)).toBeNull();
    expect(queries).toHaveLength(1);
  });

  it("throws on a failed query, and never queries with something that isn't a trace id", async () => {
    await expect(latencyFromLogs(fakeLogs(["fail"]).logs, "ws")(TRACE, STARTED)).rejects.toThrow(
      "query timed out",
    );
    const { logs, queries } = fakeLogs();
    await expect(latencyFromLogs(logs, "ws")('" | drop', STARTED)).rejects.toThrow(
      "not a trace id",
    );
    expect(queries).toEqual([]);
  });
});
