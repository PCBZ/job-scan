// The validate node: SKILL.md step 3's misalignment checks, in code. A parser
// (or a model) that loses a row's alignment produces plausible nonsense, not
// an error, and a schema can't see it: every field is still a string.

import { isPlaceName, regionCode } from "./places.js";
import type { Posting, Source } from "./types.js";

/** Glassdoor badges and ages, LinkedIn's trailing lines: never a company or title. */
const BADGE =
  /^(easy apply|just posted|today|yesterday|new|promoted|actively recruiting|be an early applicant|view job|\d+\+?\s*(minutes?|hours?|days?|weeks?|months?)( ago)?|\d+\s+(alumni|connections?)\b.*)$/i;
/** "4d", "23h": short ages are lower case, so a company like "3M" is not one. */
const SHORT_AGE = /^\d+\s*[hdwm]$/;
const isBadge = (s: string) => BADGE.test(s) || SHORT_AGE.test(s);
const RATING = /★/;
const MONEY =
  /[$£€]\s?\d|\b\d+(\.\d+)?\s?k\b|\b(a|an|per)\s+(year|hour|month)\b|\/\s?(yr|hr|year|hour)\b/i;
/** "Vancouver, BC": a city with a province or state code. */
const CITY_CODE = /^[A-Z][A-Za-z .'-]+,\s*([A-Z]{2})$/;
const norm = (s: string) => s.trim().toLowerCase();

function looksLikePlace(value: string, location: string): boolean {
  const v = norm(value);
  return (
    v === norm(location) ||
    // Only real codes, so a title like "Developer, AI" is not a place.
    regionCode(CITY_CODE.exec(value.trim())?.[1] ?? "") !== undefined ||
    v === "remote" ||
    isPlaceName(value)
  );
}

/**
 * What is wrong with one posting; empty means it passed. The six checks are
 * SKILL.md's: each catches one way a row loses its alignment.
 */
export function checkPosting(p: Posting): string[] {
  const problems: string[] = [];
  const say = (ok: boolean, problem: string) => {
    if (!ok) problems.push(problem);
  };
  const company = p.company.trim();
  const title = p.title.trim();

  // 1. A posting needs a title and a company.
  say(title !== "", "title is empty");
  say(company !== "", "company is empty");
  if (company) {
    // 2. A badge or an age read as the company shifts every row after it.
    say(!isBadge(company), `company "${company}" is a badge or an age, not a company`);
    // 3. Glassdoor's rating suffix stayed on the company.
    say(!RATING.test(company), `company "${company}" still carries a rating; drop it`);
    // 4. A place in the company or title field.
    say(!looksLikePlace(company, p.location), `company "${company}" looks like a location`);
  }
  if (title) {
    say(!looksLikePlace(title, p.location), `title "${title}" looks like a location`);
    // 6. Title and company read from the same line.
    say(norm(title) !== norm(company), `title and company are both "${title}"`);
  }
  // 5. The salary landed in another field.
  for (const [field, value] of [
    ["company", company],
    ["title", title],
    ["location", p.location],
  ] as const) {
    say(!MONEY.test(value), `${field} "${value}" looks like a salary`);
  }
  return problems;
}

// Problems name their message and row, so a repair goes back to the one
// message that produced them. The id is quoted as a JSON string: a quoted id
// ends at its closing quote, so one id's prefix never matches another id that
// merely starts with it (fallback ids carry raw subjects).
const prefixOf = (messageId: string) => `message ${JSON.stringify(messageId)} row `;

export function problemFor(messageId: string, row: number, problem: string): string {
  return `${prefixOf(messageId)}${row}: ${problem}`;
}

/** The problems that belong to one message. */
export function problemsFor(problems: string[], messageId: string): string[] {
  const prefix = prefixOf(messageId);
  return problems.filter((p) => p.startsWith(prefix));
}

export interface Validated {
  valid: Posting[];
  problems: string[];
  /** Rows that failed a check, per job board. */
  dropped: Partial<Record<Source, number>>;
}

export function validatePostings(postings: Posting[]): Validated {
  const valid: Posting[] = [];
  const problems: string[] = [];
  const dropped: Partial<Record<Source, number>> = {};
  for (const p of postings) {
    const found = checkPosting(p);
    if (found.length === 0) {
      valid.push(p);
      continue;
    }
    problems.push(...found.map((f) => problemFor(p.message_id, p.row, f)));
    dropped[p.source] = (dropped[p.source] ?? 0) + 1;
  }
  return { valid, problems, dropped };
}
