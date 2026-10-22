// The judge node: one structured call per posting, with every resume variant
// in it. A repair goes back only to the postings verify_judgements flagged,
// each with its own earlier answers and problems.

import type { ProfileConfig } from "../config/schema.js";
import { isAppError } from "../errors.js";
import { addUsage, type ModelClient, type RepairTurn, type TokenUsage } from "../model/types.js";
import type { Posting } from "../postings/types.js";
import type { ResumeVariant } from "../resume/load.js";
import { mapWithLimit } from "../workflow/limit.js";
import type { LlmResult } from "../workflow/types.js";
import { JUDGE_SYSTEM, judgeUser } from "./prompt.js";
import { type JudgeAnswer, judgeAnswer } from "./schema.js";
import { type Judgement, postingId, problemsAbout } from "./verify.js";

export interface JudgeInput {
  postings: Posting[];
  resumes: ResumeVariant[];
  profile: ProfileConfig;
  /**
   * Answers kept from earlier runs for some of these postings (#150). The first
   * pass uses them in place of a model call; a repair turn asks the model, so
   * a kept answer that fails verification is replaced, not repeated.
   */
  recalled?: Judgement[];
}

export interface JudgeOptions {
  /** Postings in flight at once. */
  concurrency?: number;
}

const judgementOf = (previous: unknown, id: string) =>
  ((previous ?? []) as Judgement[]).find((j) => postingId(j.posting) === id);

/** This posting's own repair turns: its earlier answers and their problems. */
function historyOf(repairs: RepairTurn[], id: string): RepairTurn[] {
  return repairs
    .map((t) => ({
      previous: judgementOf(t.previous, id)?.answer,
      problems: problemsAbout(t.problems, id),
    }))
    .filter((t) => t.problems.length > 0);
}

/**
 * A gap quotes one of the posting's requirements. Most alerts list none, and
 * then the model fills the gap from the title or invents one; repairing that
 * only resent whole prompts (#112: 230 of a run's 289 first-pass problems).
 * With nothing to quote, every gap is "".
 */
export function withoutUnstatedGaps(posting: Posting, answer: JudgeAnswer): JudgeAnswer {
  if (posting.requirements.length > 0) return answer;
  return {
    ...answer,
    variants: answer.variants.map((v) => ({
      ...v,
      skills: { ...v.skills, gap: "" },
      domain: { ...v.domain, gap: "" },
      seniority: { ...v.seniority, gap: "" },
    })),
  };
}

export function judgeStep(client: ModelClient, options: JudgeOptions = {}) {
  const concurrency = options.concurrency ?? 4;
  return async (
    { postings, resumes, profile, recalled = [] }: JudgeInput,
    repairs: RepairTurn[],
    signal?: AbortSignal,
  ): Promise<LlmResult<Judgement[]>> => {
    const last = repairs.at(-1);
    let usage: TokenUsage = { input: 0, output: 0 };
    const warnings: string[] = [];

    const earlier = new Map(recalled.map((j) => [postingId(j.posting), j]));
    const judged = await mapWithLimit(postings, concurrency, async (posting) => {
      const id = postingId(posting);
      const kept = judgementOf(last?.previous, id);
      // On a repair, a posting whose judgement passed keeps it as it is.
      if (last && problemsAbout(last.problems, id).length === 0) return kept ? [kept] : [];
      const remembered = last ? undefined : earlier.get(id);
      if (remembered) return [remembered];
      try {
        const r = await client.structured({
          name: "judgement",
          system: JUDGE_SYSTEM,
          user: judgeUser(posting, profile, resumes),
          schema: judgeAnswer,
          repairs: historyOf(repairs, id),
          ...(signal ? { signal } : {}),
        });
        usage = addUsage(usage, r.usage);
        return [{ posting, answer: withoutUnstatedGaps(posting, r.value) }];
      } catch (err) {
        // One unusable answer costs that posting, not the run.
        if (!isAppError(err, "model_output")) throw err;
        warnings.push(`judge: posting ${id}: ${err.message}`);
        return kept ? [kept] : [];
      }
    });

    return { value: judged.flat(), usage, warnings };
  };
}
