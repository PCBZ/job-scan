// What the model returns for one posting. Every outcome carries its reason: a
// rubric level quotes the resume and names a gap. Gates are Jev's (#118).

import { z } from "zod";

/** One scale for every rubric dimension; the prompt describes it per dimension. */
export const LEVELS = ["none", "weak", "partial", "strong", "exact"] as const;
export type Level = (typeof LEVELS)[number];
const level = z.enum(LEVELS);

const fit = z.object({
  level,
  /** A line quoted verbatim from this variant's resume; "" when the level is none. */
  evidence: z.string(),
  /** A requirement in the posting this resume does not meet; "" when there is none. */
  gap: z.string(),
});

export const judgeAnswer = z.object({
  /** One per resume variant, in the order given. */
  variants: z.array(z.object({ variant: z.string(), skills: fit, domain: fit, seniority: fit })),
  location: z.object({ level, reason: z.string() }),
  signal: z.object({ level, reason: z.string() }),
  /** What the alert doesn't say that the judgement needed. */
  unknowns: z.array(z.string()),
});

export type JudgeAnswer = z.infer<typeof judgeAnswer>;
