// Suspicious-content flags from extract_postings, kept only when their quote
// is really in the email: a flag the report can't back with the mail's own
// words would accuse a sender of something it never wrote.

import { sliceCodePoints } from "../unicode.js";
import type { SuspiciousFlag } from "./schema.js";

/** Longer quotes are cut for the report; a prefix is still verbatim. */
export const QUOTE_MAX = 300;

const squash = (s: string) => s.replace(/\s+/gu, " ").trim();

/** Whether `quote` appears in `text`, ignoring how whitespace was wrapped. */
export function quotedIn(quote: string, text: string): boolean {
  const q = squash(quote);
  return q.length > 0 && squash(text).includes(q);
}

/**
 * The flags whose quote is in `text`, which is what the model read. Each
 * dropped flag adds a warning that names its kind, not its unverified words.
 */
export function verifiedFlags(
  flags: SuspiciousFlag[],
  text: string,
  messageId: string,
  warnings: string[],
): SuspiciousFlag[] {
  return flags.flatMap((f) => {
    if (!quotedIn(f.quote, text)) {
      warnings.push(
        `extract_postings: message ${messageId}: dropped a "${f.kind}" flag whose quote isn't in the email`,
      );
      return [];
    }
    const quote = squash(f.quote);
    return [
      {
        kind: f.kind,
        reason: f.reason.trim(),
        quote: [...quote].length > QUOTE_MAX ? `${sliceCodePoints(quote, QUOTE_MAX)}…` : quote,
      },
    ];
  });
}
