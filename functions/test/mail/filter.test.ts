import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { searchTerms } from "../../src/lib/mail/mailbox.js";
import { passesFilter } from "../../src/lib/mail/message.js";

// Generated from scripts/fetch_mail.py: the two implementations must keep and
// search for the same mail.
const fx = JSON.parse(
  readFileSync(new URL("../../../tests/fixtures/mail_filter.json", import.meta.url), "utf8"),
) as {
  passes_filter: {
    name: string;
    sender: string;
    subject: string;
    senders: string[];
    subject_keywords: string[];
    exclude_senders: string[];
    expected: boolean;
  }[];
  search_terms: { senders: string[]; subject_keywords: string[]; expected: [string, string][] }[];
};

describe("passesFilter matches fetch_mail.passes_filter", () => {
  it.each(fx.passes_filter.map((c) => [c.name, c] as const))("%s", (_n, c) => {
    const account = {
      senders: c.senders,
      subjectKeywords: c.subject_keywords,
      excludeSenders: c.exclude_senders,
    };
    expect(passesFilter(c.sender, c.subject, account)).toBe(c.expected);
  });
});

describe("searchTerms matches fetch_mail.search_terms", () => {
  it.each(
    fx.search_terms.map((c) => [JSON.stringify([c.senders, c.subject_keywords]), c] as const),
  )("%s", (_n, c) => {
    expect(searchTerms({ from: c.senders, subject: c.subject_keywords })).toEqual(c.expected);
  });
});
