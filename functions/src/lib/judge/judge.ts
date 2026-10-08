// The judge node: one structured call per posting, with every resume variant
// in it. A repair goes back only to the postings verify_judgements flagged,
// each with its own earlier answers and problems.

import type { ProfileConfig } from "../config/schema.js";
import {
  type ModelClient,
  ModelOutputError,
  type RepairTurn,
  type TokenUsage,
} from "../model/types.js";
import type { Posting } from "../postings/types.js";
import type { ResumeVariant } from "../resume/load.js";
import { mapWithLimit } from "../workflow/limit.js";
import type { LlmResult } from "../workflow/types.js";
import { gatesFor } from "./gates.js";
import { JUDGE_SYSTEM, judgeUser } from "./prompt.js";
import { judgeAnswer } from "./schema.js";
import { type Judgement, postingId, problemsAbout } from "./verify.js";

export interface JudgeInput {
  postings: Posting[];
  resumes: ResumeVariant[];
  profile: ProfileConfig;
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

export function judgeStep(client: ModelClient, options: JudgeOptions = {}) {
  const concurrency = options.concurrency ?? 4;
  return async (
    { postings, resumes, profile }: JudgeInput,
    repairs: RepairTurn[],
    signal?: AbortSignal,
  ): Promise<LlmResult<Judgement[]>> => {
    const last = repairs.at(-1);
    const usage: TokenUsage = { input: 0, output: 0 };
    const warnings: string[] = [];

    const judged = await mapWithLimit(postings, concurrency, async (posting) => {
      const id = postingId(posting);
      const kept = judgementOf(last?.previous, id);
      // On a repair, a posting whose judgement passed keeps it as it is.
      if (last && problemsAbout(last.problems, id).length === 0) return kept ? [kept] : [];
      const asked = gatesFor(posting, profile);
      try {
        const r = await client.structured({
          name: "judgement",
          system: JUDGE_SYSTEM,
          user: judgeUser(posting, profile, asked, resumes),
          schema: judgeAnswer,
          repairs: historyOf(repairs, id),
          ...(signal ? { signal } : {}),
        });
        usage.input += r.usage.input;
        usage.output += r.usage.output;
        return [{ posting, asked, answer: r.value }];
      } catch (err) {
        // One unusable answer costs that posting, not the run.
        if (!(err instanceof ModelOutputError)) throw err;
        warnings.push(`judge: posting ${id}: ${err.message}`);
        return kept ? [kept] : [];
      }
    });

    return { value: judged.flat(), usage, warnings };
  };
}
