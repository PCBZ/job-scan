import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/lib/config/load.js";
import { rank } from "../../src/lib/judge/rank.js";
import { dimension, judgement } from "./helpers.js";

const config = (report: AppConfig["report"] = {}, profile: AppConfig["profile"] = {}) =>
  ({ report, profile }) as AppConfig;

const variant = (name: string, level: "none" | "weak" | "partial" | "strong" | "exact") => ({
  variant: name,
  skills: dimension({ level }),
  domain: dimension({ level }),
  seniority: dimension({ level, gap: "x" }),
});

describe("rank", () => {
  it("weights the levels 35/25/20/10/10 into 0–100", () => {
    // strong 0.75 × 35, partial 0.5 × 25, strong 0.75 × 20, exact 1 × 10, strong 0.75 × 10.
    const { top } = rank([judgement()], config());
    expect(top[0]?.score).toBe(Math.round(26.25 + 12.5 + 15 + 10 + 7.5));
  });

  it("names the best variant, and the runner-up as 'either' within 5 points", () => {
    const close = judgement({
      answer: { variants: [variant("A", "strong"), variant("B", "strong")] },
    });
    const apart = judgement({
      answer: { variants: [variant("A", "partial"), variant("B", "exact")] },
    });
    const [c] = rank([close], config({ min_score_to_recommend: 0 })).top;
    const [a] = rank([apart], config({ min_score_to_recommend: 0 })).top;
    expect([c?.variant, c?.either]).toEqual(["A", "B"]);
    expect([a?.variant, a?.either]).toEqual(["B", undefined]);
    // partial: 17.5 + 12.5 + 10, exact: 35 + 25 + 20; both + location 10 + signal 7.5.
    expect(a?.scores).toEqual({ A: 58, B: 98 });
  });

  it("calls 'either' at a 5-point gap, not at 10", () => {
    const named = (name: string, seniority: "strong" | "partial" | "weak") => ({
      variant: name,
      skills: dimension(),
      domain: dimension(),
      seniority: dimension({ level: seniority, gap: "x" }),
    });
    // All strong: 78. Seniority partial: 73 (5 behind). Seniority weak: 68 (10 behind).
    const five = judgement({ answer: { variants: [named("A", "strong"), named("B", "partial")] } });
    const ten = judgement({ answer: { variants: [named("A", "strong"), named("C", "weak")] } });
    expect(rank([five], config()).top[0]?.scores).toEqual({ A: 78, B: 73 });
    expect(rank([five], config()).top[0]?.either).toBe("B");
    expect(rank([ten], config()).top[0]?.either).toBeUndefined();
  });

  it("caps a posting with thin requirements at 70, with low confidence", () => {
    const j = judgement({
      posting: { requirements: ["Go"] },
      answer: { variants: [variant("A", "exact")] },
    });
    const [r] = rank([j], config()).top;
    expect([r?.score, r?.confidence, r?.caps]).toEqual([70, "low", ["thin requirements"]]);
    expect(r?.scores).toEqual({ A: 98 });
  });

  it("caps a variant with no stated gap at 70, with low confidence", () => {
    const gapless = {
      variant: "A",
      skills: dimension({ level: "exact" }),
      domain: dimension({ level: "exact" }),
      seniority: dimension({ level: "exact" }),
    };
    const [r] = rank([judgement({ answer: { variants: [gapless] } })], config()).top;
    expect([r?.score, r?.confidence, r?.caps]).toEqual([70, "low", ["no stated gap"]]);
    expect(r?.scores).toEqual({ A: 98 });
  });

  it("picks by the capped score, so a variant with a gap can win", () => {
    const gapless = {
      variant: "A",
      skills: dimension({ level: "exact" }),
      domain: dimension({ level: "exact" }),
      seniority: dimension({ level: "exact" }),
    };
    const [r] = rank(
      [judgement({ answer: { variants: [gapless, variant("B", "strong")] } })],
      config(),
    ).top;
    // A: 98 capped to 70. B: 78 with a gap.
    expect([r?.variant, r?.score, r?.either, r?.caps]).toEqual(["B", 78, undefined, []]);
  });

  it("names every reason a score was capped", () => {
    const gapless = {
      variant: "A",
      skills: dimension(),
      domain: dimension(),
      seniority: dimension(),
    };
    const j = judgement({ posting: { requirements: ["Go"] }, answer: { variants: [gapless] } });
    expect(rank([j], config()).top[0]?.caps).toEqual(["thin requirements", "no stated gap"]);
  });

  it("is medium-confidence when the alert left something unknown", () => {
    const [r] = rank([judgement({ answer: { unknowns: ["years required"] } })], config()).top;
    expect(r?.confidence).toBe("medium");
    expect(rank([judgement()], config()).top[0]?.confidence).toBe("high");
  });

  it("filters a failed model gate with its reason and quote, and notes a sentinel one", () => {
    const failed = judgement({
      asked: [{ gate: "sponsorship", mode: "filter", rule: "x" }],
      answer: {
        gates: [
          {
            gate: "sponsorship",
            fails: true,
            reason: "Requires citizenship",
            quote: "US citizens only",
          },
        ],
      },
    });
    const noted = judgement({
      posting: { title: "Other" },
      asked: [{ gate: "sponsorship", mode: "note", rule: "x" }],
      answer: {
        gates: [
          {
            gate: "sponsorship",
            fails: true,
            reason: "Requires citizenship",
            quote: "US citizens only",
          },
        ],
      },
    });
    const out = rank([failed, noted], config());
    expect(out.filtered).toEqual([
      {
        posting: failed.posting,
        gate: "sponsorship",
        reason: 'Requires citizenship ("US citizens only")',
      },
    ]);
    expect(out.top.map((r) => [r.posting.title, r.noted])).toEqual([
      ["Other", ['Requires citizenship ("US citizens only")']],
    ]);
  });

  it("applies the floor and top N, keeping the rest best first", () => {
    const judged = (["exact", "partial", "strong", "weak"] as const).map((level, i) =>
      judgement({
        posting: { title: `${level}`, row: i },
        answer: { variants: [variant("A", level)] },
      }),
    );
    const out = rank(judged, config({ min_score_to_recommend: 50, max_top_picks: 1 }));
    expect(out.top.map((r) => r.posting.title)).toEqual(["exact"]);
    expect(out.rest.map((r) => r.posting.title)).toEqual(["strong", "partial", "weak"]);
  });

  it("defaults to a floor of 60 and five picks", () => {
    const judged = Array.from({ length: 7 }, (_, i) =>
      judgement({
        posting: { row: i },
        answer: { variants: [variant("A", i < 6 ? "exact" : "weak")] },
      }),
    );
    const out = rank(judged, config());
    expect(out.top).toHaveLength(5);
    expect(out.rest).toHaveLength(2);
    // With room in the top, a posting below 60 still stays out.
    const low = rank(
      [judged[0], judged[6]].flatMap((j) => (j ? [j] : [])),
      config(),
    );
    expect(low.top).toHaveLength(1);
    // weak 0.25 × 80 + location 10 + signal 7.5 = 37.5.
    expect(low.rest.map((r) => r.score)).toEqual([38]);
  });

  it("says once why needs_sponsorship wasn't applied", () => {
    const note = rank(
      [],
      config({}, { needs_sponsorship: true, locations: ["Vancouver, BC"] }),
    ).notes;
    expect(note).toEqual([
      "needs_sponsorship is about US work visas and no listed location is in the US, so it wasn't applied",
    ]);
    expect(
      rank([], config({}, { needs_sponsorship: true, locations: ["Austin, TX"] })).notes,
    ).toEqual([]);
  });
});
