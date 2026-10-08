// The hard_gates node: SKILL.md's gates that code can decide exactly, each a
// table of rules in gates/. A posting fails on its first failing gate; the
// questions of the others go to Jev in judge (#17). Code never filters on a guess.

import type { AppConfig } from "../config/load.js";
import type { ProfileConfig } from "../config/schema.js";
import type { ModelGate } from "../judge/schema.js";
import type { DeterministicSteps } from "../workflow/types.js";
import { KEYWORD, keywordFacts } from "./gates/keyword.js";
import { LOCATION, locationFacts } from "./gates/location.js";
import { decide } from "./gates/rules.js";
import { type Floor, floorOf, SALARY, salaryFacts, usdCad } from "./gates/salary.js";
import type { Posting } from "./types.js";

export { annualTop, currencyOf, USD_CAD_URL, usdCad } from "./gates/salary.js";

interface Context {
  profile: ProfileConfig;
  floor: Floor | null;
  cadPerUsd: number | null;
}

/** Location first: the report lists location failures first. */
const GATES = {
  location: (p: Posting, c: Context) => decide(LOCATION, locationFacts(p, c.profile)),
  salary: (p: Posting, c: Context) => decide(SALARY, salaryFacts(p, c.floor, c.cadPerUsd)),
  keyword: (p: Posting, c: Context) =>
    decide(KEYWORD, keywordFacts(p, c.profile.exclude_keywords ?? [])),
};

export type Gate = keyof typeof GATES;

export interface Filtered {
  posting: Posting;
  /** A code gate here, or a model gate from judge (#17). */
  gate: Gate | ModelGate;
  reason: string;
}

export function hardGatesStep(
  rate: () => Promise<number | null> = usdCad,
): DeterministicSteps["hardGates"] {
  return async (postings, config: AppConfig) => {
    const profile = config.profile;
    const floor = floorOf(profile);
    // Fetch the rate only when some stated salary is in the other currency.
    const needsRate = postings.some((p) => salaryFacts(p, floor, null).exchanged);
    const context: Context = { profile, floor, cadPerUsd: needsRate ? await rate() : null };

    const kept: Posting[] = [];
    const filtered: Filtered[] = [];
    const unsettled = new Map<string, number>();
    for (const p of postings) {
      const outcomes = Object.entries(GATES).map(
        ([gate, check]) => [gate as Gate, check(p, context)] as const,
      );
      const failed = outcomes.find(([, o]) => "fail" in o);
      if (failed && "fail" in failed[1]) {
        filtered.push({ posting: p, gate: failed[0], reason: failed[1].fail });
        continue;
      }
      const questions = outcomes.flatMap(([, o]) => ("ask" in o ? [o.ask] : []));
      for (const [, o] of outcomes) {
        if ("note" in o) unsettled.set(o.note, (unsettled.get(o.note) ?? 0) + 1);
      }
      kept.push(questions.length ? { ...p, gate_questions: questions } : p);
    }
    const notes = [...unsettled].map(
      ([why, n]) => `salary not compared for ${n} posting(s): ${why}`,
    );
    return { kept, filtered, notes };
  };
}
