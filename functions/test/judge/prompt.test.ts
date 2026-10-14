import { describe, expect, it } from "vitest";
import { judgeUser } from "../../src/lib/judge/prompt.js";
import type { ResumeVariant } from "../../src/lib/resume/load.js";
import { posting } from "../postings/helpers.js";

const RESUMES: ResumeVariant[] = [
  { path: "Backend.tex", name: "Backend", text: "Built payment services in Go\n".repeat(40) },
  { path: "Data.tex", name: "Data", text: "Built Spark pipelines\n".repeat(40) },
];
const PROFILE = {
  locations: ["Vancouver, BC"],
  seniority: "mid" as const,
  needs_sponsorship: false,
};

/** The length of the longest common prefix. */
function sharedPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return i;
}

describe("judgeUser", () => {
  it("puts what every call shares first and the posting last, so the prompt cache can serve it", () => {
    const user = judgeUser(posting(), PROFILE, RESUMES);
    expect(Object.keys(JSON.parse(user))).toEqual(["candidate", "resumes", "posting"]);
  });

  it("gives two postings the same prompt up to the posting", () => {
    const a = judgeUser(posting({ title: "Backend Engineer" }), PROFILE, RESUMES);
    const b = judgeUser(posting({ title: "Data Engineer", row: 1 }), PROFILE, RESUMES);
    const shared = sharedPrefix(a, b);
    // Everything through the resumes is identical; they diverge in the posting.
    expect(shared).toBeGreaterThan(a.indexOf('"posting"'));
    expect(a.slice(0, shared)).toContain("Built Spark pipelines");
  });
});
