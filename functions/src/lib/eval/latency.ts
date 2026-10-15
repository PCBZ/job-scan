// The run's model-call latency (#130), from its trace in Application
// Insights: the OpenInference spans under each graph node's span (#101).
// Null until the run's telemetry is in, so the report knows to wait.

import type { TokenCredential } from "@azure/identity";
import { LogsQueryClient, type LogsTable } from "@azure/monitor-query-logs";

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
 * `expectCalls` says whether the run made model calls, from its record. Then
 * a trace with no calls yet isn't complete: Azure ingests spans in no set
 * order, so the run's span can arrive before its calls'.
 */
export type LatencySource = (
  traceId: string,
  startedAt: Date,
  expectCalls: boolean,
) => Promise<Latency | null>;

type Logs = Pick<LogsQueryClient, "queryWorkspace">;

/** Trace ids are 32 hex digits, checked before they go into a query. */
const TRACE_ID = /^[0-9a-f]{32}$/;

/** The run's spans, with each model call's node; its run span tells whether it's in yet. */
const spans = (traceId: string) => `
let deps = AppDependencies | where OperationId == "${traceId}";
let nodes = deps | where Name startswith "node " | project NodeId = Id, Node = substring(Name, 5);
let calls = deps | where Name == "OpenAI Chat Completions"
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
  return async (traceId, startedAt, expectCalls) => {
    if (!TRACE_ID.test(traceId)) throw new Error(`not a trace id: ${traceId}`);
    // From just before the run to now: the spans are in it whenever they land.
    const timespan = { startTime: new Date(startedAt.getTime() - 5 * 60_000), endTime: new Date() };
    const query = async (kql: string) => {
      const r = await logs.queryWorkspace(workspaceId, kql, timespan);
      if (r.status !== "Success") throw new Error(`latency query: ${r.partialError.message}`);
      return rowsOf(r.tables[0]);
    };

    const [total] = await query(`${spans(traceId)}
calls | summarize ${TIMES}, failed = countif(Success == false)
| extend runs = toscalar(deps | where Name == "daily run" | count)`);
    if (!total || num(total.runs) === 0) return null;
    if (expectCalls && num(total.calls) === 0) return null;
    const byNode = await query(`${spans(traceId)}
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
