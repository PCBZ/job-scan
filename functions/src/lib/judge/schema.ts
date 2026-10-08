// What the model returns for one posting. Every outcome carries its reason:
// a gate quotes the posting, a rubric level quotes the resume and names a gap.

import { z } from "zod";

/** One scale for every rubric dimension; the prompt describes it per dimension. */
export const LEVELS = ["none", "weak", "partial", "strong", "exact"] as const;
export type Level = (typeof LEVELS)[number];
const level = z.enum(LEVELS);

/** Gates the model judges, after the code gates (#16) have run. */
export const MODEL_GATES = ["sponsorship", "seniority", "keyword", "location"] as const;
export type ModelGate = (typeof MODEL_GATES)[number];

const fit = z.object({
  level,
  /** A line quoted verbatim from this variant's resume; "" when the level is none. */
  evidence: z.string(),
  /** A requirement in the posting this resume does not meet; "" when there is none. */
  gap: z.string(),
});

export const judgeAnswer = z.object({
  /** One per gate asked, in the order asked. */
  gates: z.array(
    z.object({
      gate: z.enum(MODEL_GATES),
      fails: z.boolean(),
      reason: z.string(),
      /** The posting's own words that decide it; "" when the posting is silent. */
      quote: z.string(),
    }),
  ),
  /** One per resume variant, in the order given. */
  variants: z.array(z.object({ variant: z.string(), skills: fit, domain: fit, seniority: fit })),
  location: z.object({ level, reason: z.string() }),
  signal: z.object({ level, reason: z.string() }),
  /** What the alert doesn't say that the judgement needed. */
  unknowns: z.array(z.string()),
});

export type JudgeAnswer = z.infer<typeof judgeAnswer>;
