// The evaluation email (#129): templates/evaluation.html (Mustache, which
// escapes every {{value}}) and a plain-text part with the same sections.

import { readFileSync } from "node:fs";
import Mustache from "mustache";
import type { Evaluation } from "./evaluate.js";

/** Three levels up from both src/lib/eval and dist/lib/eval. */
const TEMPLATE = readFileSync(
  new URL("../../../templates/evaluation.html", import.meta.url),
  "utf8",
);

/** 1.52M, 122K, 950. */
export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/** $1.71; $0.0013 for a fraction of a cent, so Jev's cost isn't shown as zero. */
export function usd(n: number): string {
  return n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

/** 8m 13s. */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

const percent = (share: number | null) => (share === null ? "—" : `${Math.round(share * 100)}%`);

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

/** Numbers only: the subject never carries a posting's own words. */
export function subjectOf(e: Evaluation): string {
  return `Job Scan — evaluation ${e.day} (${e.version}): ≈ ${usd(e.usd)}`;
}

export function renderHtml(e: Evaluation): string {
  return Mustache.render(TEMPLATE, view(e));
}

export function renderText(e: Evaluation): string {
  const v = view(e);
  const table = (header: string[], rows: string[][]) =>
    [header, ...rows].map((r) => r.join(" | ")).join("\n");
  return [
    `Job Scan — evaluation, ${v.day}`,
    `${v.version} · ${v.outcome} · costs are estimates at list prices`,
    "",
    "Funnel",
    v.funnel,
    "",
    "Cost (estimated)",
    table(
      ["Model", "Input", "Cached", "Output", "≈ USD"],
      v.cost.map((c) => [c.model, c.input, c.cached, c.output, c.usd]),
    ),
    `Total ${v.total}`,
    "",
    "Time",
    v.time,
    "",
    "Quality",
    table(
      ["Loop", "First-pass problems", "Repairs", "Unresolved"],
      v.quality.map((q) => [q.loop, String(q.firstPass), String(q.repairs), String(q.unresolved)]),
    ),
    "",
    "Screen (Jev)",
    v.screenSummary,
    ...(v.hasScreened
      ? [
          table(
            ["Role", "Company", "Location", "Gate", "Jev"],
            v.screened.map((s) => [s.title, s.company, s.location, s.gate, s.probability]),
          ),
        ]
      : []),
    "",
    "Dropped as misaligned",
    v.dropped,
    "",
    "Recent runs",
    table(
      ["Day", "Version", "≈ USD", "Judged", "Judge 1st-pass", "Filtered", "Cached"],
      v.trend.map((t) => [
        t.day,
        t.version,
        t.usd,
        String(t.judged),
        String(t.firstPass),
        String(t.filtered),
        t.cachedShare,
      ]),
    ),
    "",
    "job-scan · evaluation · prices: Azure Retail Prices API 2026-10; Jev from secondary sources",
  ].join("\n");
}
