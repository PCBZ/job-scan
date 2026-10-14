// The judge prompt: the rubric is SKILL.md step 5's, written per level.

import { readFileSync } from "node:fs";
import type { ProfileConfig } from "../config/schema.js";
import type { Posting } from "../postings/types.js";
import type { ResumeVariant } from "../resume/load.js";
import { postingFields } from "./fields.js";
import type { AskedGate } from "./gates.js";

/** The system prompt, kept as prose in prompts/judge.md. */
export const JUDGE_SYSTEM = readFileSync(
  // Three levels up from both src/lib/judge and dist/lib/judge.
  new URL("../../../prompts/judge.md", import.meta.url),
  "utf8",
).trimEnd();

/**
 * The profile fields the judgement uses, the resumes, the gates and the
 * posting, as JSON. What every call shares comes first and the posting last,
 * so Azure's prompt cache serves the shared prefix (#115): a cache hit needs
 * the prompt's start to match exactly, and the posting is ~1% of the prompt.
 */
export function judgeUser(
  p: Posting,
  profile: ProfileConfig,
  gates: AskedGate[],
  resumes: ResumeVariant[],
): string {
  const { target_titles, seniority, years_experience, locations, open_to_remote, core_skills } =
    profile;
  return JSON.stringify(
    {
      candidate: {
        target_titles,
        seniority,
        years_experience,
        locations,
        open_to_remote,
        core_skills,
      },
      resumes: resumes.map((r) => ({ variant: r.name, text: r.text })),
      gates: gates.map(({ gate, rule }) => ({ gate, rule })),
      posting: postingFields(p),
    },
    null,
    2,
  );
}
