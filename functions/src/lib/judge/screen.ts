// The screen node (#121): the model gates, decided by Jev before judge. One
// Jev call per posting with gates, one Noul per gate. A gate needs a yes or
// no and a confidence, not a written reason, so the report's reason is the
// gate's own failure label with Jev's probability. A screened-out posting
// never reaches judge, so it costs no judge call.

import type { ProfileConfig } from "../config/schema.js";
import { type DecisionClient, noul } from "../decision/client.js";
import { isAppError } from "../errors.js";
import { addUsage, type TokenUsage } from "../model/types.js";
import type { Filtered } from "../postings/gates.js";
import type { Posting } from "../postings/types.js";
import { mapWithLimit } from "../workflow/limit.js";
import { postingFields } from "./fields.js";
import { type AskedGate, gatesFor } from "./gates.js";

/** A gate fails at this probability or above. */
export const FAILS_AT = 0.8;
/** Between this and FAILS_AT Jev is unsure: the posting stays, with a note. */
export const UNSURE_AT = 0.5;

export interface ScreenInput {
  postings: Posting[];
  profile: ProfileConfig;
}

export interface ScreenResult {
  kept: Posting[];
  filtered: Filtered[];
  usage: TokenUsage;
  warnings: string[];
}

export interface ScreenOptions {
  /** Postings in flight at once. */
  concurrency?: number;
}

const percent = (p: number) => `Jev ${p.toFixed(2)}`;

type Outcome = { kept: Posting } | { filtered: Filtered };

/** The probability that the gate fails, from Jev's probability of "yes". */
const failing = (gate: AskedGate, yes: number) => (gate.failsOn === "yes" ? yes : 1 - yes);

/**
 * Screens each posting through its gates. Without a client (no key), or when
 * Jev fails, postings pass unscreened and the report says so: a filter that
 * can't run mustn't cost the day's report.
 */
export function screenStep(decision: DecisionClient | null, options: ScreenOptions = {}) {
  const concurrency = options.concurrency ?? 4;
  return async (
    { postings, profile }: ScreenInput,
    signal?: AbortSignal,
  ): Promise<ScreenResult> => {
    let usage: TokenUsage = { input: 0, output: 0 };
    let unscreened = 0;
    let failure = "";

    // Each posting's outcome, in input order whichever call returns first.
    const outcomes = await mapWithLimit(
      postings,
      concurrency,
      async (posting): Promise<Outcome> => {
        const gates = gatesFor(posting, profile);
        if (gates.length === 0) return { kept: posting };
        if (!decision) {
          unscreened++;
          return { kept: posting };
        }
        let yes: number[];
        try {
          const r = await decision.ask({
            state: postingFields(posting),
            questions: Object.fromEntries(gates.map((g, i) => [`g${i}`, noul(g.question)])),
            ...(signal ? { signal } : {}),
          });
          usage = addUsage(usage, r.usage);
          yes = gates.map((_, i) => r.answers[`g${i}`]?.noul ?? 0.5);
        } catch (err) {
          if (!isAppError(err, "decision_provider") && !isAppError(err, "decision_request"))
            throw err;
          unscreened++;
          failure = err.message;
          return { kept: posting };
        }

        const notes: string[] = [];
        for (const [i, gate] of gates.entries()) {
          const p = failing(gate, yes[i] ?? 0.5);
          if (p >= FAILS_AT && gate.mode === "filter") {
            return {
              filtered: { posting, gate: gate.gate, reason: `${gate.failure} (${percent(p)})` },
            };
          }
          if (p >= FAILS_AT)
            notes.push(`Would have been filtered: ${gate.failure} (${percent(p)})`);
          else if (p >= UNSURE_AT) notes.push(`Possibly ${gate.failure} (${percent(p)})`);
        }
        return { kept: notes.length ? { ...posting, gate_notes: notes } : posting };
      },
    );

    const warnings =
      unscreened === 0
        ? []
        : [
            decision
              ? `screen: Jev failed, so ${unscreened} posting(s) weren't screened: ${failure}`
              : `screen: TYPESAFE_API_KEY isn't set, so ${unscreened} posting(s) weren't screened`,
          ];
    return {
      kept: outcomes.flatMap((o) => ("kept" in o ? [o.kept] : [])),
      filtered: outcomes.flatMap((o) => ("filtered" in o ? [o.filtered] : [])),
      usage,
      warnings,
    };
  };
}
