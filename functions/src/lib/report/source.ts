// The render_report node: ReportInput into one Report, in SKILL.md step 6's
// order. No model call; every sentence here comes from an earlier step.

import { runDay } from "../day.js";
import { chosenFit } from "../explain/prompt.js";
import type { Ranked } from "../judge/rank.js";
import { postingId } from "../judge/verify.js";
import type { Posting } from "../postings/types.js";
import type { ReportInput } from "../workflow/types.js";
import type { FilteredGroup, OtherPick, Report, TopPick } from "./types.js";

/** The report lists location failures first, as SKILL.md asks. */
const GATE_ORDER = ["location", "salary", "keyword", "sponsorship", "seniority"];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Only http(s) links reach a report: an alert's text is untrusted. */
const safeUrl = (url: string) => (/^https?:\/\//i.test(url.trim()) ? url.trim() : "");

const where = (p: Posting) =>
  [p.location, p.workplace === "unknown" ? "" : p.workplace].filter(Boolean).join(" · ");

function topPick(pick: Ranked, input: ReportInput): TopPick {
  const p = pick.posting;
  const e = input.explanations.find((x) => x.id === postingId(p));
  return {
    title: p.title,
    company: p.company,
    location: where(p),
    salary: p.salary,
    url: safeUrl(p.url),
    score: pick.score,
    confidence: pick.confidence,
    variant: pick.variant,
    either: pick.either,
    account: p.account,
    fit: e?.fit,
    gap: e?.gap,
    unknown: e?.unknown ?? "",
    caps: pick.caps,
    noted: pick.noted,
  };
}

function otherPick(pick: Ranked): OtherPick {
  const p = pick.posting;
  const fit = chosenFit(pick);
  const gap = [fit?.skills.gap, fit?.domain.gap, fit?.seniority.gap].find(Boolean);
  return {
    title: p.title,
    company: p.company,
    location: where(p),
    salary: p.salary,
    url: safeUrl(p.url),
    score: pick.score,
    check: gap ?? pick.judgement.answer.unknowns[0] ?? "",
  };
}

function filteredGroups(input: ReportInput): FilteredGroup[] {
  const groups = new Map<string, FilteredGroup>();
  for (const f of input.filtered) {
    const group = groups.get(f.gate) ?? { gate: f.gate, items: [] };
    group.items.push({
      title: f.posting.title,
      company: f.posting.company,
      location: f.posting.location,
      reason: f.reason,
    });
    groups.set(f.gate, group);
  }
  const rank = (gate: string) =>
    GATE_ORDER.includes(gate) ? GATE_ORDER.indexOf(gate) : GATE_ORDER.length;
  return [...groups.values()].sort((a, b) => rank(a.gate) - rank(b.gate));
}

/** The alert for a run with no resumes; subjectOf tells it from mailbox alerts. */
export const NO_RESUMES =
  "No resumes could be read, so today's postings weren't scored. The next run scores the same mail.";

export function buildReport(input: ReportInput, now: Date = new Date()): Report {
  const mail = input.mail;
  const payload = mail && !("error" in mail) ? mail : null;
  const failures = mail ? (mail.failures ?? []) : [];
  const alerts = [
    ...(input.outcome === "no_resumes" ? [NO_RESUMES] : []),
    ...failures.map(
      (f) =>
        `${f.account} mailbox failed to sync: ${f.error}${f.detail ? ` (${f.detail})` : ""}. Today's results cover the others only.`,
    ),
  ];

  const dropped = Object.values(input.dropped).reduce((n, c) => n + (c ?? 0), 0);
  const inScope = input.top.length + input.rest.length;
  const newPostings = inScope + input.filtered.length;
  const postings = newPostings + input.repeats + input.duplicates + dropped;
  const emails = payload?.stats.kept ?? 0;
  const accounts = payload
    ? `${payload.stats.accounts_scanned} of ${payload.stats.accounts_scanned + payload.stats.accounts_failed} mailboxes`
    : "no mailboxes";
  // Every mailbox failing is a failure, not a quiet day, whatever the list says.
  const funnel =
    mail && "error" in mail
      ? "Every mailbox failed to sync, so nothing was scanned today."
      : input.outcome === "no_mail"
        ? `No new mail across ${accounts}.`
        : input.outcome === "no_resumes"
          ? `Scanned ${plural(emails, "new email")} across ${accounts}; nothing was scored without resumes.`
          : `Scanned ${plural(emails, "new email")} across ${accounts} → ${plural(postings, "posting")} → ${newPostings} new → ${inScope} in scope → ${input.top.length} worth your time.`;
  const counts = [
    payload && payload.stats.already_seen > 0
      ? `${plural(payload.stats.already_seen, "email")} skipped as already seen`
      : "",
    input.duplicates > 0 ? `${plural(input.duplicates, "duplicate")} collapsed` : "",
    input.repeats > 0 ? `${plural(input.repeats, "repeat")} suppressed` : "",
    dropped > 0 ? `${plural(dropped, "misaligned row")} dropped` : "",
  ]
    .filter(Boolean)
    .join(". ");

  const housekeeping = [
    ...Object.entries(payload?.stats.dropped_by_account ?? {}).map(
      ([account, n]) =>
        `${account} hit the message budget: ${plural(n, "message")} left for the next run.`,
    ),
    ...(input.resumes?.stale
      ? ["The resume library couldn't be read; the last good texts were used."]
      : []),
    ...(input.resumes?.warnings ?? []),
    ...input.warnings,
  ];

  return {
    day: runDay(now),
    outcome: input.outcome,
    alerts,
    funnel,
    counts: counts ? `${counts}.` : "",
    notes: input.notes,
    top: input.top.map((pick) => topPick(pick, input)),
    others: input.rest.map(otherPick),
    filtered: filteredGroups(input),
    suspicious: "not checked",
    housekeeping,
  };
}
