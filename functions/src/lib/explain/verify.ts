// The verify_explanations node: a Fit quotes the chosen resume, a Gap quotes
// the posting, and a pick says it has no gap only when its judgement found
// none. One call explains every pick, so a repair resends them all.

import type { Ranked } from "../judge/rank.js";
import { postingId, postingText, quotes } from "../judge/verify.js";
import type { ResumeSet } from "../resume/load.js";
import { chosenFit } from "./prompt.js";
import type { Explanation } from "./schema.js";

export function verifyExplanations(
  explained: Explanation[],
  top: Ranked[],
  resumes: ResumeSet,
): string[] {
  const problems: string[] = [];
  const ids = top.map((pick) => postingId(pick.posting));
  if (explained.map((e) => e.id).join() !== ids.join()) {
    problems.push(`answer one entry per pick, in this order: ${ids.join(", ") || "none"}`);
  }
  for (const e of explained) {
    const pick = top.find((p) => postingId(p.posting) === e.id);
    if (!pick) continue;
    const say = (problem: string) => problems.push(`pick ${JSON.stringify(e.id)}: ${problem}`);
    const resume = resumes.variants.find((v) => v.name === pick.variant)?.text ?? "";
    const posting = postingText(pick.posting);
    const fit = chosenFit(pick);
    const judgedGaps = [fit?.skills.gap, fit?.domain.gap, fit?.seniority.gap].filter(Boolean);

    if (!quotes(resume, e.fit.quote)) {
      say(`fit quote "${e.fit.quote}" is not a line of the ${pick.variant} resume`);
    }
    if (e.fit.sentence.trim() === "") say("fit needs a sentence");
    if (e.gap.requirement) {
      if (!quotes(posting, e.gap.requirement)) {
        say(`gap "${e.gap.requirement}" is not a requirement the posting states; copy it verbatim`);
      }
    } else if (judgedGaps.length > 0) {
      say(`the judgement found a gap (${judgedGaps.map((g) => `"${g}"`).join(", ")}); name it`);
    }
    if (e.gap.advice.trim() === "") say("gap needs advice");
  }
  return problems;
}
