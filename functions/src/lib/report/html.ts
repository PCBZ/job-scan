// The report as HTML: templates/report.html, a Mustache template built on
// Cerberus Responsive, which renders in browsers, Gmail and Outlook alike.
// Mustache escapes every {{value}}, so text from the mail can't add markup;
// the template never uses unescaped {{{triple}}} tags.

import { readFileSync } from "node:fs";
import Mustache from "mustache";
import type { Report } from "./types.js";

/** Three levels up from both src/lib/report and dist/lib/report. */
const TEMPLATE = readFileSync(new URL("../../../templates/report.html", import.meta.url), "utf8");

const BADGE = { high: "#067647", medium: "#b54708", low: "#667085" } as const;

/** The report shaped for the template: Mustache has no logic, so this does it. */
export function view(r: Report, webUrl?: string) {
  const best = r.top[0];
  return {
    day: r.day,
    webUrl: webUrl ?? "",
    preview: best ? `${best.title} at ${best.company}, ${best.score}/100` : r.funnel,
    alerts: r.alerts,
    funnel: r.funnel,
    counts: r.counts,
    notes: r.notes,
    hasNotes: r.notes.length > 0,
    top: r.top.map((p, i) => ({
      ...p,
      n: i + 1,
      badge: BADGE[p.confidence],
      capped: p.caps.join(", "),
      facts: [p.location, p.salary].filter(Boolean).join(" · "),
      send: p.either ? `${p.variant} or ${p.either}` : p.variant,
    })),
    others: r.others,
    hasOthers: r.others.length > 0,
    filtered: r.filtered.map((g) => ({ ...g, count: g.items.length })),
    housekeeping: r.housekeeping,
    hasHousekeeping: r.housekeeping.length > 0,
  };
}

/** `webUrl`, the report's SAS link, adds "View in a browser" for the email. */
export function renderHtml(r: Report, webUrl?: string): string {
  return Mustache.render(TEMPLATE, view(r, webUrl));
}
