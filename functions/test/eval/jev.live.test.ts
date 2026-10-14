// One live call to Jev with a Noul, a Score and a Choice whose answers are
// obvious, to check the key, the pinned model and the answer shapes. Skipped
// unless EVAL_LIVE is exactly 1:
//
//   export TYPESAFE_API_KEY=...   # the same key that goes in Key Vault
//   npm run eval:jev

import { describe, expect, it } from "vitest";
import { choice, noul, score } from "../../src/lib/decision/client.js";
import { DEFAULT_JEV_MODEL, decisionClientFromEnv } from "../../src/lib/decision/config.js";
import { screenStep } from "../../src/lib/judge/screen.js";
import { posting } from "../postings/helpers.js";

const POSTING = {
  title: "Senior Backend Engineer",
  location: "Remote, Canada",
  description:
    "Fully remote for anyone living in Canada. 8+ years building distributed systems in Go; " +
    "you will lead the payments team.",
};

describe.skipIf(process.env.EVAL_LIVE !== "1")("Jev, live", () => {
  it("answers a Noul, a Score and a Choice in one call", { timeout: 60_000 }, async () => {
    const r = await decisionClientFromEnv(process.env).ask({
      state: POSTING,
      questions: {
        canada: noul("Can someone living in Vancouver, Canada work this role?"),
        seniority: score("How senior is this role?", [
          "Entry level: new graduates, no prior experience required",
          "Mid level: two to five years of experience",
          "Senior: six or more years, or leading a team",
        ]),
        language: choice("Which programming language does the posting require?", {
          go: "Go (Golang)",
          java: "Java",
          python: "Python",
        }),
      },
    });
    console.log(JSON.stringify({ model: r.model, usage: r.usage, answers: r.answers }, null, 2));

    expect(r.model).toBe(process.env.JEV_MODEL?.trim() || DEFAULT_JEV_MODEL);
    expect(r.answers.canada.noul).toBeGreaterThan(0.5);
    expect(r.answers.seniority.score).toBeGreaterThan(1.5);
    expect(r.answers.language.choice).toBe("go");
    expect(r.usage.input).toBeGreaterThan(0);
  });

  it("screens postings through their gates (#118)", { timeout: 60_000 }, async () => {
    const screen = screenStep(decisionClientFromEnv(process.env));
    const vancouver = posting({ row: 0, title: "Backend Engineer", location: "Vancouver, BC" });
    const citizens = posting({
      row: 1,
      title: "Software Engineer",
      location: "Seattle, WA",
      requirements: ["Must be a US citizen with an active security clearance"],
    });
    const montreal = posting({
      row: 2,
      title: "Full-Stack Developer",
      location: "Montreal",
      gate_questions: [
        'Is "Montreal" within commuting distance of Vancouver, BC, Burnaby, Surrey?',
      ],
    });
    const out = await screen({
      postings: [vancouver, citizens, montreal],
      profile: {
        locations: ["Vancouver, BC", "Seattle, WA"],
        seniority: "mid",
        years_experience: 4,
        needs_sponsorship: true,
      },
    });
    console.log(
      JSON.stringify(
        { filtered: out.filtered.map((f) => [f.posting.title, f.reason]), usage: out.usage },
        null,
        2,
      ),
    );
    expect(out.kept.map((p) => p.title)).toEqual(["Backend Engineer"]);
    expect(out.filtered.map((f) => [f.posting.title, f.gate])).toEqual([
      ["Software Engineer", "sponsorship"],
      ["Full-Stack Developer", "location"],
    ]);
  });
});
