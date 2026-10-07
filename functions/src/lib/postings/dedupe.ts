// The dedupe node: a port of `seen_jobs.py filter`. A posting recommended
// within repeat_suppression_days is a repeat; a fingerprint twice in one batch
// (one alert reaching two mailboxes) is a duplicate. Both are only counted.

import type { AppConfig } from "../config/load.js";
import { addDays, runDay } from "../day.js";
import { fingerprint } from "../fingerprint.js";
import type { DeterministicSteps } from "../workflow/types.js";
import type { SeenJobsStore } from "./seen-jobs.js";
import type { Posting } from "./types.js";

/** The local skill's default window. */
export const DEFAULT_REPEAT_DAYS = 30;

export interface Deduped {
  fresh: Posting[];
  repeats: number;
  duplicates: number;
}

/** Each sighting of a repeat counts; among the rest, the first of each fingerprint is kept. */
export function splitRepeats(postings: Posting[], recent: ReadonlySet<string>): Deduped {
  const fresh: Posting[] = [];
  const kept = new Set<string>();
  let repeats = 0;
  let duplicates = 0;
  for (const p of postings) {
    const fp = fingerprint(p);
    if (recent.has(fp)) repeats++;
    else if (kept.has(fp)) duplicates++;
    else {
      kept.add(fp);
      fresh.push(p);
    }
  }
  return { fresh, repeats, duplicates };
}

/** The first day still inside the repeat window. */
export function repeatCutoff(config: AppConfig, now: Date): string {
  const days = config.report.repeat_suppression_days ?? DEFAULT_REPEAT_DAYS;
  return addDays(runDay(now), -days);
}

export function dedupeStep(
  store: SeenJobsStore,
  now: () => Date = () => new Date(),
): DeterministicSteps["dedupe"] {
  return async (postings, config) =>
    splitRepeats(postings, await store.recommendedSince(repeatCutoff(config, now())));
}
