// The explain node: one structured call for all the top picks, on the
// generative model, since Fit and Gap are prose with reasons.

import type { Ranked } from "../judge/rank.js";
import type { ModelClient, RepairTurn } from "../model/types.js";
import type { ResumeVariant } from "../resume/load.js";
import type { LlmResult } from "../workflow/types.js";
import { EXPLAIN_SYSTEM, explainUser } from "./prompt.js";
import { type Explanation, explanations } from "./schema.js";

export interface ExplainInput {
  top: Ranked[];
  resumes: ResumeVariant[];
}

export function explainStep(client: ModelClient) {
  return async (
    { top, resumes }: ExplainInput,
    repairs: RepairTurn[],
    signal?: AbortSignal,
  ): Promise<LlmResult<Explanation[]>> => {
    // A dud day has nothing to explain: no call.
    if (top.length === 0) return { value: [], usage: { input: 0, output: 0 } };
    const r = await client.structured({
      name: "explanations",
      system: EXPLAIN_SYSTEM,
      user: explainUser(top, resumes),
      schema: explanations,
      // The previous answers in the shape the model gave them.
      repairs: repairs.map((t) => ({ previous: { picks: t.previous }, problems: t.problems })),
      ...(signal ? { signal } : {}),
    });
    return { value: r.value.picks, usage: r.usage };
  };
}
