// The report as plain text: the text/plain part of the email, for clients
// and filters that read it. Same content as the HTML, in the same order.

import type { Report } from "./types.js";

const section = (title: string, lines: string[]) => [`## ${title}`, ...lines, ""];

export function renderText(r: Report, webUrl?: string): string {
  const top = r.top.flatMap((p, i) => [
    `${i + 1}. ${p.title} — ${p.company} · ${p.score}/100 · confidence: ${p.confidence}${p.caps.length ? ` (capped: ${p.caps.join(", ")})` : ""}`,
    `   ${[p.location, p.salary].filter(Boolean).join(" · ")} · send ${p.either ? `${p.variant} or ${p.either}` : p.variant} · via ${p.account}`,
    ...(p.fit ? [`   Fit: ${p.fit.sentence} "${p.fit.quote}"`] : []),
    ...(p.gap
      ? [`   Gap: ${p.gap.requirement ? `${p.gap.requirement}. ` : ""}${p.gap.advice}`]
      : []),
    ...(p.unknown ? [`   Unknown from the email: ${p.unknown}`] : []),
    ...p.noted.map((n) => `   Would have been filtered: ${n}`),
    ...(p.url ? [`   ${p.url}`] : []),
    "",
  ]);
  const nothing = r.others.length
    ? "Nothing cleared the floor today. The near misses are below."
    : "Nothing cleared the floor today.";
  return [
    `Job Scan — ${r.day}`,
    ...(webUrl ? [`View in a browser: ${webUrl}`] : []),
    "",
    ...r.alerts.map((a) => `! ${a}`),
    r.funnel,
    ...(r.counts ? [r.counts] : []),
    ...r.notes.map((n) => `- ${n}`),
    "",
    ...section("Top picks", r.top.length ? top : [nothing, ""]),
    ...(r.others.length
      ? section(
          "Also worth a look",
          r.others.map(
            (o) =>
              `- ${o.title} — ${o.company} · ${o.location} · ${o.score} · check: ${o.check}${o.url ? `\n  ${o.url}` : ""}`,
          ),
        )
      : []),
    ...section(
      "Filtered out",
      r.filtered.length
        ? r.filtered.flatMap((g) => [
            `${g.gate} (${g.items.length})`,
            ...g.items.map((i) => `- ${i.title} — ${i.company} · ${i.location}: ${i.reason}`),
          ])
        : ["Nothing."],
    ),
    ...section("Suspicious", ["Not checked: no step looks for suspicious mail yet."]),
    ...section(
      "Housekeeping",
      r.housekeeping.length ? r.housekeeping.map((h) => `- ${h}`) : ["Nothing."],
    ),
  ]
    .join("\n")
    .trimEnd()
    .concat("\n");
}
