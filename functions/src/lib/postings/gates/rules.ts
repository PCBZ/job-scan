// A gate is a table of rules over a posting's facts: the first rule whose
// condition holds gives the outcome. A gate passes, fails with a reason, asks a
// question for Jev (#17), or notes what it couldn't compare.

export type Outcome = { pass: true } | { fail: string } | { ask: string } | { note: string };
export type Rule<F> = readonly [when: (f: F) => boolean, then: Outcome | ((f: F) => Outcome)];

export const PASS: Outcome = { pass: true };

/** The first rule that holds decides; no rule holding is a pass. */
export function decide<F>(rules: readonly Rule<F>[], facts: F): Outcome {
  for (const [when, then] of rules) {
    if (when(facts)) return typeof then === "function" ? then(facts) : then;
  }
  return PASS;
}
