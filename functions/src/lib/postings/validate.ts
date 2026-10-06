// The validate node: SKILL.md step 3's misalignment checks, in code. A parser
// (or a model) that loses a row's alignment produces plausible nonsense, not
// an error, so each check looks for one specific way that shows.

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
// Only real codes, so a title like "Developer, AI" is not a place.
const PLACE_CODES = new Set(
  (
    "AB BC MB NB NL NS NT NU ON PE QC SK YT " +
    "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT " +
    "NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY"
  ).split(" "),
);
const REGIONS = new Set([
  "remote",
  "canada",
  "united states",
  "usa",
  "alberta",
  "british columbia",
  "manitoba",
  "new brunswick",
  "newfoundland and labrador",
  "northwest territories",
  "nova scotia",
  "nunavut",
  "ontario",
  "prince edward island",
  "quebec",
  "saskatchewan",
  "yukon",
]);
/** The job board itself, as its footer names it. */
const SENDER = /^(linkedin|indeed|glassdoor),?(\s+(corporation|corp\.?|inc\.?|ltd\.?|llc))?$/i;
const STREET =
  /\b\d{2,6}\s+[\w .'-]+?\s(avenue|ave|street|st|road|rd|boulevard|blvd|drive|dr|way)\b/i;
/** "Software Engineer jobs in Vancouver": a saved-search name. */
const SAVED_SEARCH = /\bjobs\s+(in|near|for)\b|^\d+\s+new\s+jobs\b/i;

const norm = (s: string) => s.trim().toLowerCase();

function looksLikePlace(value: string, location: string): boolean {
  const v = norm(value);
  return (
    v === norm(location) ||
    PLACE_CODES.has(CITY_CODE.exec(value.trim())?.[1] ?? "") ||
    REGIONS.has(v)
  );
}

/** What is wrong with one posting; empty means it passed. */
export function checkPosting(p: Posting): string[] {
  const problems: string[] = [];
  const say = (ok: boolean, problem: string) => {
    if (!ok) problems.push(problem);
  };
  const company = p.company.trim();
  const title = p.title.trim();

  say(title !== "", "title is empty");
  say(company !== "", "company is empty");
  if (company) {
    say(!isBadge(company), `company "${company}" is a badge or an age, not a company`);
    say(!RATING.test(company), `company "${company}" still carries a rating; drop it`);
    say(!looksLikePlace(company, p.location), `company "${company}" looks like a location`);
    say(!MONEY.test(company), `company "${company}" looks like a salary`);
    say(!SENDER.test(company), `company "${company}" is the job board itself, from its footer`);
    say(!STREET.test(company), `company "${company}" looks like a street address`);
  }
  if (title) {
    say(!isBadge(title), `title "${title}" is a badge or an age, not a title`);
    say(!RATING.test(title), `title "${title}" carries a rating, so it is likely the company`);
    say(!looksLikePlace(title, p.location), `title "${title}" looks like a location`);
    say(!MONEY.test(title), `title "${title}" looks like a salary`);
    say(norm(title) !== norm(company), `title and company are both "${title}"`);
    say(!SAVED_SEARCH.test(title), `title "${title}" is a saved-search name, not a posting`);
  }
  say(!MONEY.test(p.location), `location "${p.location}" looks like a salary`);
  say(!STREET.test(p.location), `location "${p.location}" looks like a street address`);
  say(p.salary === "" || /\d/.test(p.salary), `salary "${p.salary}" has no amount`);
  return problems;
}

// Problems name their message and row, so a repair goes back to the one
// message that produced them.
export function problemFor(messageId: string, row: number, problem: string): string {
  return `message ${messageId} row ${row}: ${problem}`;
}

/** The problems that belong to one message. */
export function problemsFor(problems: string[], messageId: string): string[] {
  const prefix = `message ${messageId} row `;
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
