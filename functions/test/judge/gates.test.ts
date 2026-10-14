import { describe, expect, it } from "vitest";
import type { ProfileConfig } from "../../src/lib/config/schema.js";
import { gatesFor, sponsorshipApplies } from "../../src/lib/judge/gates.js";
import { posting } from "../postings/helpers.js";

const US: ProfileConfig = { locations: ["Seattle, WA", "Remote (US)"] };
const CANADA: ProfileConfig = { locations: ["Vancouver, BC", "Burnaby"] };
const modes = (profile: ProfileConfig, p = posting()) =>
  gatesFor(p, profile).map((g) => `${g.gate}:${g.mode}`);

describe("gatesFor", () => {
  it("asks nothing when every gate is off", () => {
    expect(gatesFor(posting(), { seniority: "all", needs_sponsorship: false })).toEqual([]);
  });

  it("filters on sponsorship only when it applies: needed, and a US place listed", () => {
    expect(modes({ ...US, needs_sponsorship: true })).toEqual(["sponsorship:filter"]);
    expect(modes({ ...CANADA, needs_sponsorship: true })).toEqual([]);
    expect(sponsorshipApplies(US)).toBe(true);
    expect(sponsorshipApplies(CANADA)).toBe(false);
  });

  it("still asks a sentinel gate, to note what it would have caught", () => {
    expect(modes({ ...CANADA, needs_sponsorship: "unknown" })).toEqual(["sponsorship:note"]);
  });

  it("asks seniority against the profile's level, failing on yes, with years when known", () => {
    const [gate] = gatesFor(posting(), { seniority: "mid", years_experience: 4 });
    expect(gate).toMatchObject({ gate: "seniority", mode: "filter", failsOn: "yes" });
    expect(gate?.question).toContain('two or more steps away from "mid"');
    expect(gate?.question).toContain("4 years of experience");
    expect(gate?.failure).toBe('seniority far from "mid"');
    expect(gatesFor(posting(), { seniority: "mid" })[0]?.question).not.toContain("years");
  });

  it("asks exclude_keywords by meaning, ignoring blanks", () => {
    const [gate] = gatesFor(posting(), { exclude_keywords: ["unpaid", " ", "commission only"] });
    expect(gate).toMatchObject({
      question:
        'Does the posting describe any of these, even in other words: "unpaid", "commission only"?',
      failsOn: "yes",
    });
  });

  it("asks each location question from #16 as it reads, failing on no, in order", () => {
    const p = posting({
      location: "Lower Mainland",
      gate_questions: ['Is "Lower Mainland" within commuting distance?', "Q2?"],
    });
    expect(gatesFor(p, {}).map((g) => [g.question, g.failsOn, g.failure])).toEqual([
      [
        'Is "Lower Mainland" within commuting distance?',
        "no",
        "location doesn't fit: Lower Mainland",
      ],
      ["Q2?", "no", "location doesn't fit: Lower Mainland"],
    ]);
  });
});
