import { describe, expect, it } from "vitest";
import type { ProfileConfig } from "../../src/lib/config/schema.js";
import { gatesFor, sponsorshipApplies } from "../../src/lib/judge/gates.js";
import { posting } from "../postings/helpers.js";

const US: ProfileConfig = { locations: ["Seattle, WA", "Remote (US)"] };
const CANADA: ProfileConfig = { locations: ["Vancouver, BC", "Burnaby"] };
const modes = (profile: ProfileConfig, p = posting()) =>
  gatesFor(p, profile).map((g) => `${g.gate}:${g.mode}`);

describe("gatesFor", () => {
  it("asks each gate of Jev as a plain question, with the answer that fails it (#121)", () => {
    const p = posting({
      location: "Montreal",
      gate_questions: ['Is "Montreal" within commuting distance of Vancouver, BC?'],
    });
    const gates = gatesFor(p, {
      seniority: "mid",
      exclude_keywords: ["unpaid"],
      needs_sponsorship: "unknown",
    });
    expect(gates.map((g) => [g.gate, g.failsOn, g.failure])).toEqual([
      ["sponsorship", "yes", "requires citizenship or a clearance, or won't sponsor a visa"],
      ["seniority", "yes", 'seniority far from "mid"'],
      ["keyword", "yes", "describes an excluded keyword"],
      ["location", "no", "location doesn't fit: Montreal"],
    ]);
    expect(gates.map((g) => g.question)).toEqual([
      "Does the posting require citizenship or a security clearance, or say it will not sponsor a work visa?",
      'Is this role two or more steps away from "mid", in either direction, on the scale new-grad, junior, mid, senior, staff?',
      'Does the posting describe any of these, even in other words: "unpaid"?',
      'Is "Montreal" within commuting distance of Vancouver, BC?',
    ]);
  });

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
    expect(gate?.question).toContain('two or more steps away from "mid"');
    expect(gate?.question).toContain("4 years of experience");
    expect(gatesFor(posting(), { seniority: "mid" })[0]?.question).not.toContain("years");
  });

  it("asks exclude_keywords by meaning, ignoring blanks", () => {
    const [gate] = gatesFor(posting(), { exclude_keywords: ["unpaid", " ", "commission only"] });
    expect(gate?.question).toBe(
      'Does the posting describe any of these, even in other words: "unpaid", "commission only"?',
    );
  });

  it("turns each location question from #16 into a gate, in order", () => {
    const p = posting({
      gate_questions: ['Is "Lower Mainland" within commuting distance?', "Q2?"],
    });
    expect(gatesFor(p, {}).map((g) => [g.question, g.failsOn])).toEqual([
      ['Is "Lower Mainland" within commuting distance?', "no"],
      ["Q2?", "no"],
    ]);
  });
});
