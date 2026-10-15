// The evaluation as HTML (#129): templates/evaluation.html, a Mustache
// template, as the daily report is (report/html.ts). Mustache escapes every
// {{value}}, so text from the mail can't add markup. text.ts writes the
// plain-text part from the same view; delivery/email.ts sends both.

import { readFileSync } from "node:fs";
import Mustache from "mustache";
import type { Evaluation } from "./evaluate.js";

/** Three levels up from both src/lib/eval and dist/lib/eval. */
const TEMPLATE = readFileSync(
  new URL("../../../templates/evaluation.html", import.meta.url),
  "utf8",
);

// Formats from Intl, built into Node.
const COMPACT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 });
const DOLLARS = new Intl.NumberFormat("en", { style: "currency", currency: "USD" });
/** Two significant digits under a cent, so Jev's cost isn't shown as $0.00. */
const CENTS = new Intl.NumberFormat("en", {
  style: "currency",
  currency: "USD",
  maximumSignificantDigits: 2,
});
const DURATION = new Intl.DurationFormat("en", { style: "narrow" });
const PERCENT = new Intl.NumberFormat("en", { style: "percent" });

/** 1.52M, 122.4K, 950. */
export const tokens = (n: number) => COMPACT.format(n);

/** $1.71; $0.0013 for a fraction of a cent. */
export const usd = (n: number) => (n > 0 && n < 0.01 ? CENTS : DOLLARS).format(n);

/** 8m 13s. */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return DURATION.format({ minutes: Math.floor(s / 60), seconds: s % 60 });
}

/** 3.5s: one decimal, as a call's time reads. */
const SECONDS = new Intl.NumberFormat("en", {
  style: "unit",
  unit: "second",
  unitDisplay: "narrow",
  maximumFractionDigits: 1,
});
const seconds = (ms: number) => SECONDS.format(ms / 1000);

const percent = (share: number | null) => (share === null ? "—" : PERCENT.format(share));

/** The evaluation shaped for both channels: Mustache has no logic, so this does it. */
export function view(e: Evaluation) {
  const f = e.funnel;
  const screenGates = Object.entries(e.screen.byGate)
    .map(([gate, n]) => `${gate} ${n}`)
    .join(", ");
  return {
    day: e.day,
    version: e.version,
    outcome: e.outcome,
    funnel:
      `${f.messages} emails → ${f.extracted} postings (${f.duplicates} duplicates, ${f.repeats} repeats) → ` +
      `${f.codeFiltered} filtered by code → ${f.screenFiltered} by Jev → ${f.judged} judged → ${f.top} picks`,
    cost: [
      { model: "Azure gpt-5.4-mini", spend: e.azure },
      { model: "Jev", spend: e.jev },
    ].map(({ model, spend }) => ({
      model,
      input: tokens(spend.input),
      cached: tokens(spend.cached),
      output: tokens(spend.output),
      usd: usd(spend.usd),
    })),
    total: usd(e.usd),
    time: [
      e.runMs === null ? "Run time not recorded" : `Run ${duration(e.runMs)}`,
      `${duration(e.throttledMs)} waiting on the TPM budget`,
      `${e.rateLimited} rate-limited`,
    ].join(" · "),
    latency:
      e.latency === null
        ? "Model-call latency missing: the run's trace wasn't in Application Insights within the hour."
        : `${e.latency.calls} model calls · p50 ${seconds(e.latency.p50Ms)} · p95 ${seconds(e.latency.p95Ms)} · slowest ${seconds(e.latency.slowestMs)} · ${e.latency.failed} failed`,
    hasLatency: (e.latency?.byNode.length ?? 0) > 0,
    byNode: (e.latency?.byNode ?? []).map((n) => ({
      node: n.node,
      calls: n.calls,
      p50: seconds(n.p50Ms),
      p95: seconds(n.p95Ms),
      slowest: seconds(n.slowestMs),
    })),
    quality: (["extract", "judge", "explain"] as const).map((loop) => ({
      loop,
      ...e.quality[loop],
    })),
    screenSummary:
      e.screen.filtered.length === 0
        ? `Nothing screened out. ${e.screen.unsurePicks} pick(s) Jev was unsure about.`
        : `${e.screen.filtered.length} screened out (${screenGates}). ${e.screen.unsurePicks} pick(s) Jev was unsure about.`,
    hasScreened: e.screen.filtered.length > 0,
    screened: e.screen.filtered.map((s) => ({ ...s, probability: s.probability.toFixed(2) })),
    dropped:
      e.dropped.map((d) => `${d.source} ${d.dropped}/${d.extracted}`).join(" · ") || "No postings.",
    trend: e.trend.map((t) => ({
      ...t,
      usd: usd(t.usd),
      cachedShare: percent(t.cachedShare),
    })),
  };
}

export function renderHtml(e: Evaluation): string {
  return Mustache.render(TEMPLATE, view(e));
}
