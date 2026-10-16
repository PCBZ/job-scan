// What the model returns for one posting. A rubric level quotes the resume
// and names a gap; location and signal are levels. Gates are screen's (#121).

import { z } from "zod";

/** One scale for every rubric dimension; the prompt describes it per dimension. */
export const LEVELS = ["none", "weak", "partial", "strong", "exact"] as const;
export type Level = (typeof LEVELS)[number];
const level = z.enum(LEVELS);

const fit = z.object({
  level,
  /**
   * A phrase quoted verbatim from one line of this variant's resume; "" when
   * the level is none. After verification it holds that whole line (#138).
   */
  evidence: z.string(),
  /** A requirement in the posting this resume does not meet; "" when there is none. */
  gap: z.string(),
});

export const judgeAnswer = z.object({
  /** One per resume variant, in the order given. */
  variants: z.array(z.object({ variant: z.string(), skills: fit, domain: fit, seniority: fit })),
  // Levels only: rank reads nothing else, and a reason was output paid for (#138).
  location: z.object({ level }),
  signal: z.object({ level }),
  /** What the alert doesn't say that the judgement needed. */
  unknowns: z.array(z.string()),
});

export type JudgeAnswer = z.infer<typeof judgeAnswer>;
