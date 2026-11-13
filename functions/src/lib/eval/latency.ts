// The run's model-call latency (#130), from its traces in Application
// Insights: the OpenInference spans under each graph node's span (#101).
// A run is collect's trace plus each source's (#189), so every query takes
// all of them. Null until the run's telemetry is in, so the report knows to wait.

import type { TokenCredential } from "@azure/identity";
import { LogsQueryClient, type LogsTable } from "@azure/monitor-query-logs";
import { MODEL_CALL_SPANS, NODE_SPAN_PREFIX, RUN_SPANS } from "../telemetry/spans.js";

export interface CallTimes {
  calls: number;
  p50Ms: number;
  p95Ms: number;
  slowestMs: number;
}

export interface Latency extends CallTimes {
  failed: number;
  byNode: (CallTimes & { node: string })[];
}

/**
 * `traceIds` are the run's traces, from its record. `expectCalls` says whether
 * the run made model calls, from its record. Then traces with no calls yet
 * aren't complete: Azure ingests spans in no set order, so the run's spans can
 * arrive before its calls'.
 */
export type LatencySource = (
  traceIds: string[],
  startedAt: Date,
  expectCalls: boolean,
) => Promise<Latency | null>;

type Logs = Pick<LogsQueryClient, "queryWorkspace">;

/** Trace ids are 32 hex digits, checked before they go into a query. */
const TRACE_ID = /^[0-9a-f]{32}$/;

const list = (names: string[]) => names.map((n) => `"${n}"`).join(", ");

/**
 * The run's spans, with each model call's node. A trace is in once its run
 * span is, the last the trace ends.
 */
const spans = (traceIds: string[]) => `
let deps = AppDependencies | where OperationId in (${list(traceIds)});
let nodes = deps | where Name startswith "${NODE_SPAN_PREFIX}"
  | project NodeId = Id, Node = substring(Name, ${NODE_SPAN_PREFIX.length});
let calls = deps | where Name in (${list(Object.values(MODEL_CALL_SPANS))})
  | join kind=leftouter nodes on $left.ParentId == $right.NodeId;`;

const TIMES = `calls = count(), p50Ms = percentile(DurationMs, 50),
  p95Ms = percentile(DurationMs, 95), slowestMs = max(DurationMs)`;

/** Rows as objects keyed by column name. */
function rowsOf(table: LogsTable | undefined): Record<string, unknown>[] {
  if (!table) return [];
  const names = table.columnDescriptors.map((c) => c.name ?? "");
  return table.rows.map((row) => Object.fromEntries(names.map((n, i) => [n, row[i]])));
}

const num = (v: unknown) => Math.round(Number(v ?? 0));

export function latencyFromLogs(logs: Logs, workspaceId: string): LatencySource {
  return async (traceIds, startedAt, expectCalls) => {
    if (traceIds.length === 0) throw new Error("no trace ids");
    for (const id of traceIds) if (!TRACE_ID.test(id)) throw new Error(`not a trace id: ${id}`);
    // From just before the run to now: the spans are in it whenever they land.
    const timespan = { startTime: new Date(startedAt.getTime() - 5 * 60_000), endTime: new Date() };
    const query = async (kql: string) => {
      const r = await logs.queryWorkspace(workspaceId, kql, timespan);
      if (r.status !== "Success") throw new Error(`latency query: ${r.partialError.message}`);
      return rowsOf(r.tables[0]);
    };

    const [total] = await query(`${spans(traceIds)}
calls | summarize ${TIMES}, failed = countif(Success == false)
| extend runs = toscalar(deps | where Name in (${list(Object.values(RUN_SPANS))}) | summarize dcount(OperationId))`);
    // Every trace's run span, or some of the run is still on its way.
    if (!total || num(total.runs) < new Set(traceIds).size) return null;
    if (expectCalls && num(total.calls) === 0) return null;
    const byNode = await query(`${spans(traceIds)}
calls | summarize ${TIMES} by Node | order by calls desc`);

    const times = (r: Record<string, unknown>): CallTimes => ({
      calls: num(r.calls),
      p50Ms: num(r.p50Ms),
      p95Ms: num(r.p95Ms),
      slowestMs: num(r.slowestMs),
    });
    return {
      ...times(total),
      failed: num(total.failed),
      byNode: byNode.map((r) => ({ node: String(r.Node || "(no node)"), ...times(r) })),
    };
  };
}

/** From LOG_ANALYTICS_WORKSPACE_ID, the workspace's id (a GUID). */
export function latencyFromWorkspace(
  workspaceId: string,
  credential: TokenCredential,
): LatencySource {
  return latencyFromLogs(new LogsQueryClient(credential), workspaceId);
}
