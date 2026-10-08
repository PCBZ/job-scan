// The explain prompt: SKILL.md step 6's Fit / Gap / Unknown for the top picks.

import { readFileSync } from "node:fs";
import { postingFields } from "../judge/fields.js";
import type { Ranked } from "../judge/rank.js";
import { postingId } from "../judge/verify.js";
import type { ResumeVariant } from "../resume/load.js";

/** The system prompt, kept as prose in prompts/explain.md. */
export const EXPLAIN_SYSTEM = readFileSync(
  // Three levels up from both src/lib/explain and dist/lib/explain.
  new URL("../../../prompts/explain.md", import.meta.url),
  "utf8",
).trimEnd();

/** The chosen variant's judgement for a pick. */
export function chosenFit(pick: Ranked) {
  return pick.judgement.answer.variants.find((v) => v.variant === pick.variant);
}

/** Each pick: its id, posting, chosen resume and the judgement made, as JSON. */
export function explainUser(top: Ranked[], resumes: ResumeVariant[]): string {
  return JSON.stringify(
    {
      picks: top.map((pick) => {
        const fit = chosenFit(pick);
        return {
          id: postingId(pick.posting),
          posting: postingFields(pick.posting),
          resume: {
            variant: pick.variant,
            text: resumes.find((r) => r.name === pick.variant)?.text ?? "",
          },
          judgement: {
            skills: fit?.skills,
            domain: fit?.domain,
            seniority: fit?.seniority,
            unknowns: pick.judgement.answer.unknowns,
          },
        };
      }),
    },
    null,
    2,
  );
}
