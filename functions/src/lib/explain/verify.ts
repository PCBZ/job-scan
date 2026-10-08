// The verify_explanations node: an explanation must agree with the judgement
// it explains. A Fit quotes one line of the chosen resume; the Gap and the
// Unknown are ones the judgement found, and "none" only when it found none.
// One call explains every pick, so a repair resends them all.

import type { Ranked } from "../judge/rank.js";
import { postingId, quotesLine, samePhrase } from "../judge/verify.js";
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
    const fit = chosenFit(pick);
    const judgedGaps = [fit?.skills.gap, fit?.domain.gap, fit?.seniority.gap].filter(
      (g): g is string => Boolean(g),
    );

    if (!quotesLine(resume, e.fit.quote)) {
      say(`fit quote "${e.fit.quote}" is not a line of the ${pick.variant} resume`);
    }
    if (e.fit.sentence.trim() === "") say("fit needs a sentence");
    // The report's gap is one the judgement found, so it can't disagree
    // with the score it explains.
    const listed = (items: string[]) => items.map((g) => `"${g}"`).join(", ");
    if (e.gap.requirement) {
      if (!judgedGaps.some((g) => samePhrase(g, e.gap.requirement))) {
        say(
          judgedGaps.length
            ? `gap "${e.gap.requirement}" is not one the judgement found; use one of ${listed(judgedGaps)}`
            : `the judgement found no gap; leave the requirement empty`,
        );
      }
    } else if (judgedGaps.length > 0) {
      say(`the judgement found a gap (${listed(judgedGaps)}); name it`);
    }
    if (e.gap.advice.trim() === "") say("gap needs advice");

    const unknowns = pick.judgement.answer.unknowns;
    if (unknowns.length === 0 && e.unknown.trim() !== "") {
      say("the judgement lists no unknowns; leave unknown empty");
    } else if (unknowns.length > 0 && !unknowns.some((u) => samePhrase(u, e.unknown))) {
      say(`unknown must be one the judgement lists: ${listed(unknowns)}`);
    }
  }
  return problems;
}
