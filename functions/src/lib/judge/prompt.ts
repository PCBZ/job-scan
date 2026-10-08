// The judge prompt: the rubric is SKILL.md step 5's, written per level.

import { readFileSync } from "node:fs";
import type { ProfileConfig } from "../config/schema.js";
import type { Posting } from "../postings/types.js";
import type { ResumeVariant } from "../resume/load.js";
import type { AskedGate } from "./gates.js";

/** The system prompt, kept as prose in prompts/judge.md. */
export const JUDGE_SYSTEM = readFileSync(
  // Three levels up from both src/lib/judge and dist/lib/judge.
  new URL("../../../prompts/judge.md", import.meta.url),
  "utf8",
).trimEnd();

/** The posting, the profile fields the judgement uses, the gates and the resumes, as JSON. */
export function judgeUser(
  p: Posting,
  profile: ProfileConfig,
  gates: AskedGate[],
  resumes: ResumeVariant[],
): string {
  const { title, company, location, workplace, salary, posted, requirements } = p;
  const { target_titles, seniority, years_experience, locations, open_to_remote, core_skills } =
    profile;
  return JSON.stringify(
    {
      posting: { title, company, location, workplace, salary, posted, requirements },
      candidate: {
        target_titles,
        seniority,
        years_experience,
        locations,
        open_to_remote,
        core_skills,
      },
      gates: gates.map(({ gate, rule }) => ({ gate, rule })),
      resumes: resumes.map((r) => ({ variant: r.name, text: r.text })),
    },
    null,
    2,
  );
}
