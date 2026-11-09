// What a source hands to `collect`: its postings and everything the run
// learned getting them. The mail source's graph ends with this; collect's graph
// starts from it, merged over the sources that have one.

import type { AllAccountsFailed, FetchPayload } from "../mail/types.js";
import { addUsage, type TokenUsage } from "../model/types.js";
import type { Source } from "../postings/types.js";
import type { LoopState, State, Update } from "../workflow/state.js";
import type { Posting, SuspiciousByMessage } from "../workflow/types.js";

export interface SourceHandoff {
  version: 1;
  /** Which source wrote it: "mail". */
  source: string;
  /** The run day, in the run's own zone. */
  day: string;
  started_at: string;
  /** Where the run's trace stands, so `collect`'s spans join it (one trace per run). */
  trace: { trace_id: string; span_id: string } | null;
  /** Milliseconds per node, summed over its runs. */
  node_ms: Record<string, number>;
  throttled_ms: number;
  rate_limited: number;
  mail: FetchPayload | AllAccountsFailed | null;
  extracted: Posting[];
  /** The rows that passed validation. */
  postings: Posting[];
  dropped: Partial<Record<Source, number>>;
  suspicious: SuspiciousByMessage;
  usage: Record<string, TokenUsage>;
  extract_loop: LoopState;
  warnings: string[];
}

/** A source's file, from its graph's final state and what the run measured. */
export function handoffFrom(
  state: State,
  meta: Pick<
    SourceHandoff,
    "source" | "day" | "started_at" | "trace" | "node_ms" | "throttled_ms" | "rate_limited"
  >,
): SourceHandoff {
  return {
    version: 1,
    ...meta,
    mail: state.mail,
    extracted: state.extracted,
    postings: state.postings,
    dropped: state.dropped,
    suspicious: state.suspicious,
    usage: state.usage,
    extract_loop: state.loops.extract,
    warnings: state.warnings,
  };
}

/** The workflow state `collect` starts from: the sources' files, merged. */
export function seedFrom(handoffs: SourceHandoff[]): Update {
  const dropped: Partial<Record<Source, number>> = {};
  const usage: Record<string, TokenUsage> = {};
  const suspicious: SuspiciousByMessage = {};
  for (const h of handoffs) {
    for (const [source, n] of Object.entries(h.dropped) as [Source, number][])
      dropped[source] = (dropped[source] ?? 0) + n;
    for (const [node, u] of Object.entries(h.usage))
      usage[node] = addUsage(usage[node] ?? { input: 0, output: 0 }, u);
    Object.assign(suspicious, h.suspicious);
  }
  const withLoop = handoffs.find((h) => h.source === "mail");
  return {
    mail: handoffs.find((h) => h.mail !== null)?.mail ?? null,
    extracted: handoffs.flatMap((h) => h.extracted),
    postings: handoffs.flatMap((h) => h.postings),
    dropped,
    suspicious,
    usage,
    warnings: handoffs.flatMap((h) => h.warnings),
    ...(withLoop ? { loops: { extract: withLoop.extract_loop } } : {}),
  };
}
