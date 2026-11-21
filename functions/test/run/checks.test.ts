import { describe, expect, it } from "vitest";
import type { FetchedMessage } from "../../src/lib/mail/types.js";
import {
  duplicates,
  filterReason,
  linkMatchesTitle,
  verbatimFields,
} from "../../src/lib/run/checks.js";
import { posting } from "../postings/helpers.js";

const MESSAGE = {
  account: "personal",
  message_id: "<m0@example.test>",
  body: "Backend Engineer\nNorthwind Labs · Vancouver,  BC\n$120,000–$140,000 a year\n2d",
  links: [
    { text: "Backend Engineer", url: "https://jobs.example.test/1" },
    { text: "Data Analyst", url: "https://jobs.example.test/2" },
  ],
} as unknown as FetchedMessage;

describe("verbatimFields", () => {
  it("finds each field in the message, ignoring case and whitespace", () => {
    const p = posting({
      location: "vancouver, bc",
      salary: "$120,000–$140,000 A YEAR",
      posted: "2d",
    });
    expect(verbatimFields(p, MESSAGE)).toEqual({ salary: true, location: true, posted: true });
  });

  it("catches a field the message doesn't say", () => {
    // The model normalised the salary instead of copying it.
    const p = posting({ salary: "CAD 120k–140k" });
    expect(verbatimFields(p, MESSAGE).salary).toBe(false);
  });

  it("doesn't check empty fields, or a posting whose message is unknown", () => {
    expect(verbatimFields(posting({ salary: "", posted: "" }), MESSAGE)).toMatchObject({
      salary: null,
      posted: null,
    });
    expect(verbatimFields(posting(), undefined)).toEqual({
      salary: null,
      location: null,
      posted: null,
    });
  });
});

describe("linkMatchesTitle", () => {
  it("passes when the chosen link's text names the posting", () => {
    expect(linkMatchesTitle(posting({ link: 0 }), MESSAGE)).toBe(true);
    expect(linkMatchesTitle(posting({ title: "Senior Backend Engineer", link: 0 }), MESSAGE)).toBe(
      true,
    );
  });

  it("catches a link that points at another job", () => {
    expect(linkMatchesTitle(posting({ link: 1 }), MESSAGE)).toBe(false);
  });

  it("doesn't check a posting without a link, or with one out of range", () => {
    expect(linkMatchesTitle(posting({ link: null }), MESSAGE)).toBeNull();
    expect(linkMatchesTitle(posting({ link: 9 }), MESSAGE)).toBeNull();
  });
});

describe("filterReason", () => {
  const f = (reason: string) => ({ posting: posting(), gate: "location" as const, reason });

  it("passes a code gate's reason and a model gate's quoted reason", () => {
    expect(filterReason(f("Toronto, ON is outside the allowed locations"))).toBe(true);
    expect(filterReason(f('requires citizenship ("Canadian citizens only")'))).toBe(true);
  });

  it("catches an empty reason", () => {
    expect(filterReason(f(""))).toBe(false);
    expect(filterReason(f("   "))).toBe(false);
  });

  it("catches a model gate that failed a posting without quoting it", () => {
    expect(filterReason(f('requires citizenship ("")'))).toBe(false);
    expect(filterReason(f(' ("Canadian citizens only")'))).toBe(false);
  });
});

describe("duplicates", () => {
  it("finds a company and title that dedupe let through twice", () => {
    const a = posting({ company: "Northwind Labs Inc.", title: "Backend Engineer" });
    const b = posting({ company: "Northwind Labs", title: "Backend Engineer", row: 1 });
    expect(duplicates([a, b, posting({ title: "Data Engineer", row: 2 })])).toEqual([
      "northwind|backend engineer",
    ]);
  });

  it("finds none in distinct postings", () => {
    expect(duplicates([posting(), posting({ title: "Data Engineer", row: 1 })])).toEqual([]);
  });
});
