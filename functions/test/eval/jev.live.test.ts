// One live call to Jev with a Noul, a Score and a Choice whose answers are
// obvious, to check the key, the pinned model and the answer shapes. Skipped
// unless EVAL_LIVE=1:
//
//   export TYPESAFE_API_KEY=...   # the same key that goes in Key Vault
//   npm run eval:jev

import { describe, expect, it } from "vitest";
import { choice, noul, score } from "../../src/lib/decision/client.js";
import { DEFAULT_JEV_MODEL, decisionClientFromEnv } from "../../src/lib/decision/config.js";

const POSTING = {
  title: "Senior Backend Engineer",
  location: "Remote, Canada",
  description:
    "Fully remote for anyone living in Canada. 8+ years building distributed systems in Go; " +
    "you will lead the payments team.",
};

describe.skipIf(!process.env.EVAL_LIVE)("Jev, live", () => {
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
});
