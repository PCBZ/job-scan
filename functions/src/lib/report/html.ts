// The report as HTML that reads the same in a browser and in a mail client.
// MJML compiles it to table layout with inline styles, which Gmail and Outlook
// render. Every string from an alert is escaped: the mail is untrusted.

import mjml2html from "mjml";
import type { FilteredGroup, OtherPick, Report, TopPick } from "./types.js";

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const MUTED = "#5f6b7a";
const ALERT = "#b42318";
const RULE = "#e4e7ec";

const text = (html: string, attrs = "") => `<mj-text ${attrs}>${html}</mj-text>`;
const section = (body: string, attrs = "") =>
  `<mj-section ${attrs}><mj-column>${body}</mj-column></mj-section>`;
const heading = (title: string) =>
  text(`<h2 style="margin:0">${esc(title)}</h2>`, `padding-top="24px"`);
const divider = `<mj-divider border-width="1px" border-color="${RULE}" />`;

function pick(p: TopPick, n: number): string {
  const via = p.either
    ? `send <b>${esc(p.variant)}</b> or <b>${esc(p.either)}</b>`
    : `send <b>${esc(p.variant)}</b>`;
  const facts = [esc(p.location), esc(p.salary), via].filter(Boolean).join(" · ");
  const capped = p.caps.length ? ` (capped: ${esc(p.caps.join(", "))})` : "";
  const gap = p.gap
    ? p.gap.requirement
      ? `<b>Gap:</b> ${esc(p.gap.requirement)}. ${esc(p.gap.advice)}`
      : `<b>Gap:</b> ${esc(p.gap.advice)}`
    : "";
  return [
    text(
      `<h3 style="margin:0">${n}. ${esc(p.title)} — ${esc(p.company)}</h3>` +
        `<p style="margin:4px 0 0">${p.score}/100 · confidence: ${p.confidence}${capped}</p>`,
    ),
    text(
      `<p style="margin:0">${facts}</p><p style="margin:4px 0 0;color:${MUTED}"><i>via ${esc(p.account)}</i></p>`,
    ),
    p.fit
      ? text(
          `<b>Fit:</b> ${esc(p.fit.sentence)}<br/><span style="color:${MUTED}">“${esc(p.fit.quote)}”</span>`,
        )
      : "",
    gap ? text(gap) : "",
    p.unknown ? text(`<b>Unknown from the email:</b> ${esc(p.unknown)}`) : "",
    ...p.noted.map((n) => text(`<b>Would have been filtered:</b> ${esc(n)}`, `color="${ALERT}"`)),
    p.url ? `<mj-button href="${esc(p.url)}" align="left">Open the posting</mj-button>` : "",
    divider,
  ].join("");
}

const cell = (html: string) =>
  `<td style="padding:6px 8px;border-bottom:1px solid ${RULE};vertical-align:top">${html}</td>`;
const head = (cols: string[]) =>
  `<tr>${cols.map((c) => `<th align="left" style="padding:6px 8px;border-bottom:2px solid ${RULE};white-space:nowrap">${c}</th>`).join("")}</tr>`;
const link = (title: string, url: string) =>
  url ? `<a href="${esc(url)}">${esc(title)}</a>` : esc(title);

function others(rows: OtherPick[]): string {
  const body = rows
    .map(
      (r) =>
        `<tr>${[link(r.title, r.url), esc(r.company), esc(r.location), esc(r.salary), String(r.score), esc(r.check)].map(cell).join("")}</tr>`,
    )
    .join("");
  return `<mj-table>${head(["Role", "Company", "Location", "Salary", "Score", "The one thing to check"])}${body}</mj-table>`;
}

function filtered(group: FilteredGroup): string {
  const body = group.items
    .map(
      (i) =>
        `<tr>${[esc(i.title), esc(i.company), esc(i.location), esc(i.reason)].map(cell).join("")}</tr>`,
    )
    .join("");
  return (
    text(`<h3 style="margin:0">${esc(group.gate)} (${group.items.length})</h3>`) +
    `<mj-table>${head(["Role", "Company", "Location", "Reason"])}${body}</mj-table>`
  );
}

const list = (items: string[]) =>
  text(
    `<ul style="margin:0;padding-left:20px">${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`,
  );

/** The report as MJML; exported so tests can read the source before compiling. */
export function reportMjml(r: Report): string {
  const preview = r.top[0]
    ? `${r.top[0].title} at ${r.top[0].company}, ${r.top[0].score}/100`
    : r.funnel;
  const body = [
    section(
      text(`<h1 style="margin:0">Job Scan — ${esc(r.day)}</h1>`) +
        r.alerts.map((a) => text(`⚠️ ${esc(a)}`, `color="${ALERT}"`)).join("") +
        text(
          `<p style="margin:0">${esc(r.funnel)}</p>${r.counts ? `<p style="margin:4px 0 0;color:${MUTED}"><i>${esc(r.counts)}</i></p>` : ""}`,
        ) +
        (r.notes.length ? list(r.notes) : ""),
    ),
    section(
      heading("Top picks") +
        (r.top.length
          ? r.top.map((p, i) => pick(p, i + 1)).join("")
          : text("Nothing cleared the floor today. The near misses are below.")),
    ),
    r.others.length ? section(heading("Also worth a look") + others(r.others)) : "",
    section(
      heading("Filtered out") +
        (r.filtered.length ? r.filtered.map(filtered).join("") : text("Nothing.")),
    ),
    section(
      heading("Suspicious") +
        text("Not checked: no step looks for suspicious mail yet.", `color="${MUTED}"`),
    ),
    section(
      heading("Housekeeping") + (r.housekeeping.length ? list(r.housekeeping) : text("Nothing.")),
    ),
  ].join("");

  return `<mjml>
  <mj-head>
    <mj-title>Job Scan — ${esc(r.day)}</mj-title>
    <mj-preview>${esc(preview)}</mj-preview>
    <mj-attributes>
      <mj-all font-family="-apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif" />
      <mj-text font-size="15px" line-height="1.5" color="#1d2939" padding="6px 24px" />
      <mj-table font-size="14px" line-height="1.4" padding="6px 24px" />
      <mj-button background-color="#1d4ed8" font-size="14px" padding="8px 24px" />
      <mj-divider padding="12px 24px" />
    </mj-attributes>
  </mj-head>
  <mj-body width="720px" background-color="#f8f9fb">${body}</mj-body>
</mjml>`;
}

/** Strict validation: a template mistake fails loudly instead of rendering wrong. */
export async function renderHtml(r: Report): Promise<string> {
  const { html } = await mjml2html(reportMjml(r), { validationLevel: "strict" });
  return html;
}
