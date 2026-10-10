// Port of normalize() / fingerprint() in scripts/seen_jobs.py. Both must give
// identical output; tests/fixtures/fingerprints.json holds Python's results.
// Regex classes come from unicode.ts so they match Python's Unicode rules.

import { createHash } from "node:crypto";
import { WORD_BOUNDARY as B, DIGIT as D, WHITESPACE as S, stripWhitespace } from "./unicode.js";

// Suffixes and decorations that differ between job boards but mean the same role.
const NOISE = new RegExp(
  `${B}(?:inc|llc|ltd|corp|corporation|co|company|technologies|technology|labs|` +
    `group|holdings|the)${B}|[^a-z0-9 ]`,
  "giu",
);

const REQ_ID = new RegExp(
  `(?:${B}(?:job${S}*id|req(?:uisition)?(?:${S}*id)?|posting${S}*id|job|id)${B}${S}*[-:.#]*${S}*` +
    `|#${S}*)[a-z]*${D}{3,}[a-z0-9-]*`,
  "giu",
);

const SPACE_RUN = new RegExp(`${S}+`, "gu");

export function normalize(value: string | null | undefined): string {
  let v = (value ?? "").toLowerCase();
  v = v.replace(REQ_ID, " ");
  v = v.replace(NOISE, " ");
  return stripWhitespace(v.replace(SPACE_RUN, " "));
}

export interface JobIdentity {
  company?: string | null;
  title?: string | null;
}

export function fingerprint(job: JobIdentity): string {
  return `${normalize(job.company)}|${normalize(job.title)}`;
}

/**
 * A posting's short key: 16 hex characters of the SHA-256 of its fingerprint.
 * It keys the application records and the Telegram buttons, where "a:<fp16>"
 * stays far under callback_data's "1-64 bytes":
 * https://core.telegram.org/bots/api#inlinekeyboardbutton
 */
export const fp16 = (p: JobIdentity) =>
  createHash("sha256").update(fingerprint(p)).digest("hex").slice(0, 16);
