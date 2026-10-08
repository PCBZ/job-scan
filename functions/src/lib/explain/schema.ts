// What the model returns for the top picks: SKILL.md's Fit, Gap and "Unknown
// from the email", each pinned to text code can check.

import { z } from "zod";

export const explanation = z.object({
  /** The pick's id, as given in the request. */
  id: z.string(),
  fit: z.object({
    /** Why this resume fits, built on the quote; not a restatement of the title. */
    sentence: z.string(),
    /** A line copied verbatim from the chosen resume. */
    quote: z.string(),
  }),
  gap: z.object({
    /** One of the judgement's gaps, copied; "" when it found none. */
    requirement: z.string(),
    /** What to do about it, or, with no gap, what to check before applying. */
    advice: z.string(),
  }),
  /** One of the judgement's unknowns, copied; "" when it lists none. */
  unknown: z.string(),
});

// Structured outputs need an object at the top level.
export const explanations = z.object({ picks: z.array(explanation) });

export type Explanation = z.infer<typeof explanation>;
