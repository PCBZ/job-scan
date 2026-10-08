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

  it("frames seniority against the profile's level, with years when known", () => {
    const [gate] = gatesFor(posting(), { seniority: "mid", years_experience: 4 });
    expect(gate).toMatchObject({ gate: "seniority", mode: "filter" });
    expect(gate?.rule).toContain('outside "mid"');
    expect(gate?.rule).toContain("4 years of experience");
    expect(gatesFor(posting(), { seniority: "mid" })[0]?.rule).not.toContain("years");
  });

  it("asks exclude_keywords by meaning, ignoring blanks", () => {
    const [gate] = gatesFor(posting(), { exclude_keywords: ["unpaid", " ", "commission only"] });
    expect(gate?.rule).toBe(
      'Fails if the posting describes any of these, even in other words: "unpaid", "commission only".',
    );
  });

  it("turns each location question from #16 into a gate, in order", () => {
    const p = posting({
      gate_questions: ['Is "Lower Mainland" within commuting distance?', "Q2?"],
    });
    expect(gatesFor(p, {}).map((g) => g.rule)).toEqual([
      'Fails if the answer is no: Is "Lower Mainland" within commuting distance?',
      "Fails if the answer is no: Q2?",
    ]);
  });
});
