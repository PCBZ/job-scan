// The extraction prompt. The vendor layouts and traps are SKILL.md step 3's,
// learned from runs where a parser produced plausible but misaligned rows.

import { readFileSync } from "node:fs";
import type { FetchedMessage } from "../mail/types.js";

/** The system prompt, kept as prose in prompts/extract.md. */
export const EXTRACT_SYSTEM = readFileSync(
  // Three levels up from both src/lib/postings and dist/lib/postings.
  new URL("../../../prompts/extract.md", import.meta.url),
  "utf8",
).trimEnd();

/** The message as the model sees it: headers, cleaned body, numbered link texts. */
export function extractUser(m: FetchedMessage): string {
  const links = m.links.map((l, i) => `[${i}] ${l.text}`).join("\n");
  return [
    `From: ${m.from}`,
    `Subject: ${m.subject}`,
    "",
    "Body:",
    m.body,
    "",
    "Links:",
    links || "(none)",
  ].join("\n");
}
