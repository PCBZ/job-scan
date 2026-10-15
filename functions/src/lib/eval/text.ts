// The evaluation as plain text (#129), from the same view as the HTML, with
// the same sections in the same order, as the daily report's text.ts is.

import type { Evaluation } from "./evaluate.js";
import { view } from "./html.js";

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
    v.latency,
    ...(v.hasLatency
      ? [
          table(
            ["Node", "Calls", "p50", "p95", "Slowest"],
            v.byNode.map((n) => [n.node, String(n.calls), n.p50, n.p95, n.slowest]),
          ),
        ]
      : []),
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
