// The evaluation report's figures (#129), from a run's records and the run
// lines of the runs before it. Pure: reading and sending are elsewhere.

import { runDay } from "../day.js";
import type { TokenUsage } from "../model/types.js";
import type { FilteredRecord, PickRecord, RunRecord, RunStatsRecord } from "../run/records.js";
import type { Loop } from "../workflow/state.js";
import type { Latency } from "./latency.js";
import { costOf, legacyModel, modelKey, NO_PRICES, type NodeModel, type Prices } from "./prices.js";

/** Tokens and their estimated cost in USD; null when there's no price for them. */
export interface Spend extends TokenUsage {
  cached: number;
  usd: number | null;
}

/** One model's tokens and cost. */
export interface CostRow extends Spend, NodeModel {}

export interface ScreenedOut {
  title: string;
  company: string;
  location: string;
  gate: string;
  /** Jev's probability that the posting fails the gate. */
  probability: number;
}

export interface TrendRow {
  day: string;
  version: string;
  usd: number | null;
  judged: number;
  firstPass: number;
  filtered: number;
  /** Of the judge's input, the share served from the prompt cache. */
  cachedShare: number | null;
}

export interface Evaluation {
  day: string;
  version: string;
  startedAt: string;
  outcome: string;
  funnel: {
    messages: number;
    extracted: number;
    repeats: number;
    duplicates: number;
    codeFiltered: number;
    screenFiltered: number;
    judged: number;
    top: number;
  };
  /** Tokens and cost per model, at the prices the report found. */
  cost: CostRow[];
  /** Where each provider's prices came from, for the footer. */
  priceSources: string[];
  /** The run's cost; null when a part of it has no price. */
  usd: number | null;
  /** Start to end of the workflow; null for records from before #129. */
  runMs: number | null;
  throttledMs: number;
  rateLimited: number;
  /** Model-call times from the run's trace; null when it never came in (#130). */
  latency: Latency | null;
  quality: Record<Loop, { repairs: number; firstPass: number; unresolved: number }>;
  screen: {
    filtered: ScreenedOut[];
    /** Screened-out postings per gate. */
    byGate: Record<string, number>;
    /** Picks kept with an "unsure" note from Jev. */
    unsurePicks: number;
  };
  dropped: { source: string; dropped: number; extracted: number }[];
  warnings: number;
  /** This run and the ones before it, oldest first. */
  trend: TrendRow[];
}

/** screen's reasons end with Jev's probability: "location doesn't fit: Montreal (Jev 0.97)". */
const JEV_REASON = /\(Jev (\d(?:\.\d+)?)\)$/;

const LOOPS: Loop[] = ["extract", "judge", "explain"];

/** Who served a node, with which model; records before #148 name none. */
export const modelOf = (run: RunStatsRecord, node: string): NodeModel =>
  run.models?.[node] ?? legacyModel(node);

/** Every model these runs used, once each, to look up their prices. */
export function modelsUsed(runs: RunStatsRecord[]): NodeModel[] {
  const all = runs.flatMap((r) => Object.keys(r.usage).map((n) => modelOf(r, n)));
  return [...new Map(all.map((m) => [modelKey(m), m])).values()];
}

/** A run's tokens and cost per model, in the order its nodes ran. */
function costRows(run: RunStatsRecord, prices: Prices): CostRow[] {
  const rows = new Map<string, CostRow>();
  for (const [node, u] of Object.entries(run.usage)) {
    const m = modelOf(run, node);
    const key = modelKey(m);
    const price = prices.byModel[key] ?? null;
    const row = rows.get(key) ?? { ...m, input: 0, output: 0, cached: 0, usd: 0 };
    row.input += u.input;
    row.output += u.output;
    row.cached += u.cached ?? 0;
    row.usd = row.usd === null || price === null ? null : row.usd + costOf(u, price);
    rows.set(key, row);
  }
  return [...rows.values()];
}

/** The sum, or null when any part has no price. */
const total = (rows: CostRow[]) =>
  rows.reduce<number | null>((t, r) => (t === null || r.usd === null ? null : t + r.usd), 0);

function cachedShare(run: RunStatsRecord): number | null {
  const judge = run.usage.judge;
  if (!judge || judge.input === 0 || judge.cached === undefined) return null;
  return judge.cached / judge.input;
}

function trendRow(run: RunStatsRecord, prices: Prices): TrendRow {
  return {
    day: runDay(new Date(run.started_at)),
    version: run.version,
    usd: total(costRows(run, prices)),
    judged: run.judged,
    firstPass: run.loops.judge.first_pass.length,
    filtered: run.filtered,
    cachedShare: cachedShare(run),
  };
}

/**
 * The evaluation of one run. `records` are the run's own; `earlier` are the
 * run lines of the runs before it, any order.
 */
export function evaluate(
  records: RunRecord[],
  earlier: RunStatsRecord[],
  latency: Latency | null = null,
  prices: Prices = NO_PRICES,
): Evaluation {
  const run = records.find((r): r is RunStatsRecord => r.kind === "run");
  if (!run) throw new Error("the run record has no run line");
  const filtered = records.filter((r): r is FilteredRecord => r.kind === "filtered");
  const picks = records.filter((r): r is PickRecord => r.kind === "pick");

  const screened: ScreenedOut[] = [];
  for (const f of filtered) {
    const m = JEV_REASON.exec(f.reason);
    if (!m) continue;
    screened.push({
      title: f.posting.title,
      company: f.posting.company,
      location: f.posting.location,
      gate: f.gate,
      probability: Number(m[1]),
    });
  }
  const byGate: Record<string, number> = {};
  for (const s of screened) byGate[s.gate] = (byGate[s.gate] ?? 0) + 1;

  const extractedBy: Record<string, number> = {};
  for (const r of records) {
    if (r.kind === "posting")
      extractedBy[r.posting.source] = (extractedBy[r.posting.source] ?? 0) + 1;
  }

  const cost = costRows(run, prices);
  const ended = run.ended_at ? Date.parse(run.ended_at) : Number.NaN;
  const trend = [...earlier.filter((e) => e.started_at < run.started_at), run]
    .sort((a, b) => a.started_at.localeCompare(b.started_at))
    .map((r) => trendRow(r, prices));

  return {
    day: runDay(new Date(run.started_at)),
    version: run.version,
    startedAt: run.started_at,
    outcome: run.outcome,
    funnel: {
      messages: run.messages,
      extracted: run.extracted,
      repeats: run.repeats,
      duplicates: run.duplicates,
      codeFiltered: filtered.length - screened.length,
      screenFiltered: screened.length,
      judged: run.judged,
      top: run.top,
    },
    cost,
    priceSources: prices.sources,
    usd: total(cost),
    runMs: Number.isNaN(ended) ? null : ended - Date.parse(run.started_at),
    throttledMs: run.throttled_ms,
    rateLimited: run.rate_limited ?? 0,
    latency,
    quality: Object.fromEntries(
      LOOPS.map((l) => [
        l,
        {
          repairs: run.loops[l].repairs,
          firstPass: run.loops[l].first_pass.length,
          unresolved: run.loops[l].unresolved.length,
        },
      ]),
    ) as Evaluation["quality"],
    screen: {
      filtered: screened,
      byGate,
      unsurePicks: picks.filter((p) =>
        (p.posting.gate_notes ?? []).some((n) => n.startsWith("Possibly")),
      ).length,
    },
    dropped: Object.entries(extractedBy)
      .map(([source, extracted]) => ({
        source,
        extracted,
        dropped: run.dropped[source as keyof typeof run.dropped] ?? 0,
      }))
      .sort((a, b) => b.extracted - a.extracted),
    warnings: run.warnings,
    trend,
  };
}
