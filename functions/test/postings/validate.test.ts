import { describe, expect, it } from "vitest";
import {
  checkPosting,
  problemFor,
  problemsFor,
  validatePostings,
} from "../../src/lib/postings/validate.js";
import { fixture, VENDORS } from "./fixtures.js";
import { posting } from "./helpers.js";

describe("checkPosting", () => {
  it.each(VENDORS)("passes every correctly aligned %s row", (vendor) => {
    for (const row of fixture(vendor).expected) {
      expect(checkPosting(posting({ ...row, requirements: [], skills: [] }))).toEqual([]);
    }
  });

  it("passes titles and companies that only resemble a trap", () => {
    for (const over of [
      { title: "Developer, AI" },
      { title: "Engineer, ML Platform" },
      { title: "Remote Support Engineer" },
      { company: "New Relic" },
      { company: "Indeed Analytics" },
      { company: "Ontario Teachers' Pension Plan" },
      { company: "3M" },
      { location: "Remote" },
      { salary: "" },
    ]) {
      expect(checkPosting(posting(over)), JSON.stringify(over)).toEqual([]);
    }
  });

  it.each([
    [{ title: "" }, "title is empty"],
    [{ company: " " }, "company is empty"],
    [{ company: "4d" }, "is a badge or an age"],
    [{ company: "23h" }, "is a badge or an age"],
    [{ company: "Just posted" }, "is a badge or an age"],
    [{ company: "Easy Apply" }, "is a badge or an age"],
    [{ company: "2 alumni" }, "is a badge or an age"],
    [{ company: "Harbourline Credit Union 3.9 ★" }, "still carries a rating"],
    [{ company: "Burnaby, BC" }, "looks like a location"],
    [{ company: "British Columbia" }, "looks like a location"],
    [{ company: "Pinegrove", location: "Pinegrove" }, "looks like a location"],
    [{ company: "$105K - $125K (Employer Est.)" }, "looks like a salary"],
    [{ company: "LinkedIn Corporation" }, "is the job board itself"],
    [{ company: "Glassdoor, Inc." }, "is the job board itself"],
    [{ company: "1000 West Maude Avenue" }, "looks like a street address"],
    [{ title: "Easy Apply" }, "is a badge or an age"],
    [{ title: "Cedar & Finch Software 4.2 ★" }, "carries a rating"],
    [{ title: "Vancouver, BC" }, "looks like a location"],
    [{ title: "$140,000 a year" }, "looks like a salary"],
    [{ title: "Northwind Labs" }, "title and company are both"],
    [{ title: "Full Stack Developer jobs in Vancouver, BC" }, "saved-search name"],
    [{ location: "$100,000–$120,000 a year" }, "looks like a salary"],
    [{ location: "1000 West Maude Avenue, Sunnyvale, CA 94085" }, "looks like a street address"],
    [{ salary: "Vancouver, BC" }, "has no amount"],
  ])("flags %j", (over, problem) => {
    const found = checkPosting(posting(over));
    expect(
      found.some((f) => f.includes(problem)),
      found.join("; "),
    ).toBe(true);
  });
});

describe("validatePostings", () => {
  it("keeps clean rows, and names each failing row's message and row", () => {
    const good = posting();
    const shifted = posting({ company: "4d", row: 3, message_id: "<g@x>", source: "glassdoor" });
    const out = validatePostings([good, shifted]);
    expect(out.valid).toEqual([good]);
    expect(out.problems).toEqual([
      'message <g@x> row 3: company "4d" is a badge or an age, not a company',
    ]);
  });

  it("counts dropped rows per job board, once per row", () => {
    const out = validatePostings([
      posting({ title: "", company: "", source: "glassdoor" }),
      posting({ company: "Easy Apply", source: "glassdoor" }),
      posting({ salary: "n/a", source: "linkedin" }),
      posting({ source: "indeed" }),
    ]);
    expect(out.dropped).toEqual({ glassdoor: 2, linkedin: 1 });
  });
});

describe("problemsFor", () => {
  it("picks one message's problems, and no other message's", () => {
    const problems = [
      problemFor("<a@x>", 0, "one"),
      problemFor("<a@x>b", 0, "two"),
      problemFor("<b@x>", 1, "three"),
      problemFor("<a@x>", 2, "four"),
    ];
    expect(problemsFor(problems, "<a@x>")).toEqual([
      "message <a@x> row 0: one",
      "message <a@x> row 2: four",
    ]);
  });
});
