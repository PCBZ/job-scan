// Quality checks the runtime doesn't make (#98), computed for the run records
// (#97, evaluation plan §4). They only measure: nothing is repaired or dropped
// on their account, so a run behaves as before.

import { fingerprint, normalize } from "../fingerprint.js";
import type { FetchedMessage } from "../mail/types.js";
import { WHITESPACE } from "../unicode.js";
import type { Filtered, Posting } from "../workflow/types.js";

/** true passed, false failed, null not checked (the field was empty). */
export type Check = boolean | null;

const ANY_SPACE = new RegExp(`${WHITESPACE}+`, "gu");
/** Case and whitespace don't count: "$120 K" is "$120k". */
const squash = (s: string) => s.toLowerCase().replace(ANY_SPACE, "");

/** The fields an alert shows as text, which extraction should copy, not reword. */
export const VERBATIM_FIELDS = ["salary", "location", "posted"] as const;
export type VerbatimField = (typeof VERBATIM_FIELDS)[number];

/** Whether each non-empty field appears in its message's cleaned text. */
export function verbatimFields(
  posting: Posting,
  message: FetchedMessage | undefined,
): Record<VerbatimField, Check> {
  const body = message ? squash(message.body) : null;
  const one = (field: VerbatimField): Check => {
    const value = squash(posting[field]);
    if (!value || body === null) return null;
    return body.includes(value);
  };
  return { salary: one("salary"), location: one("location"), posted: one("posted") };
}

/** Whether the link the model chose names this posting; null without a link. */
export function linkMatchesTitle(posting: Posting, message: FetchedMessage | undefined): Check {
  const link = posting.link === null ? undefined : message?.links[posting.link];
  if (!link) return null;
  const text = normalize(link.text);
  const title = normalize(posting.title);
  if (!text || !title) return false;
  return text.includes(title) || title.includes(text);
}

/** rank's model-gate reasons end in the posting's quote: `reason ("quote")`. */
const QUOTED = /^([\s\S]*) \("([\s\S]*)"\)$/;

/**
 * A reason must say something. A model gate's must also quote the posting:
 * failing a posting on its silence is a guess.
 */
export function filterReason(f: Filtered): boolean {
  const m = QUOTED.exec(f.reason);
  if (m) return (m[1] ?? "").trim() !== "" && (m[2] ?? "").trim() !== "";
  return f.reason.trim() !== "";
}

/** Fingerprints seen more than once among postings that dedupe let through. */
export function duplicates(postings: Posting[]): string[] {
  const counts = new Map<string, number>();
  for (const p of postings) {
    const key = fingerprint(p);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].filter(([, n]) => n > 1).map(([key]) => key);
}
