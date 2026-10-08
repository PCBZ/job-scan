// The exclude_keywords gate: whole phrases, any case. Matches by meaning
// ("100% commission-based" for "commission only") are Jev's, in judge (#17).

import type { Posting } from "../types.js";
import type { Rule } from "./rules.js";

interface KeywordFacts {
  /** The first keyword found as a whole phrase, and the field it is in. */
  hit: { keyword: string; field: string } | undefined;
}

export function keywordFacts(p: Posting, keywords: string[]): KeywordFacts {
  const fields: [string, string][] = [
    ["title", p.title],
    ["company", p.company],
    ["salary", p.salary],
    ["requirements", p.requirements.join("; ")],
  ];
  for (const keyword of keywords.map((k) => k.trim()).filter(Boolean)) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const phrase = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "iu");
    const field = fields.find(([, text]) => phrase.test(text))?.[0];
    if (field) return { hit: { keyword, field } };
  }
  return { hit: undefined };
}

export const KEYWORD: readonly Rule<KeywordFacts>[] = [
  [
    (f) => f.hit !== undefined,
    (f) => ({ fail: `exclude_keywords: "${f.hit?.keyword}" in ${f.hit?.field}` }),
  ],
];
