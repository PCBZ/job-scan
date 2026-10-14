import { describe, expect, it } from "vitest";
import type { AskedGate } from "../../src/lib/judge/gates.js";
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
const SENIORITY: AskedGate[] = [{ gate: "seniority", rule: "Not above mid level", mode: "filter" }];

/** The length of the longest common prefix. */
function sharedPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return i;
}

describe("judgeUser", () => {
  it("puts what every call shares first and the posting last, so the prompt cache can serve it", () => {
    const user = judgeUser(posting(), PROFILE, SENIORITY, RESUMES);
    expect(Object.keys(JSON.parse(user))).toEqual(["candidate", "resumes", "gates", "posting"]);
  });

  it("gives two postings the same prompt up to their gates", () => {
    const a = judgeUser(posting({ title: "Backend Engineer" }), PROFILE, SENIORITY, RESUMES);
    const b = judgeUser(posting({ title: "Data Engineer", row: 1 }), PROFILE, [], RESUMES);
    const shared = sharedPrefix(a, b);
    // Everything through the resumes is identical; they diverge at the gates.
    expect(shared).toBeGreaterThanOrEqual(a.indexOf('"gates"'));
    expect(a.slice(0, shared)).toContain("Built Spark pipelines");
    expect(a.indexOf('"posting"')).toBeGreaterThan(shared);
  });
});
