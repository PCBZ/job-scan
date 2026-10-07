// The dedupe node, a port of `seen_jobs.py filter`: a posting recommended within
// repeat_suppression_days (default 30) is a repeat, a fingerprint twice in one
// batch (one alert reaching two mailboxes) is a duplicate. Both are only counted.

import { addDays, runDay } from "../day.js";
import { fingerprint } from "../fingerprint.js";
import type { DeterministicSteps } from "../workflow/types.js";
import type { TableSeenJobsStore } from "./seen-jobs.js";

export function dedupeStep(
  store: Pick<TableSeenJobsStore, "recommendedSince">,
  now = () => new Date(),
): DeterministicSteps["dedupe"] {
  return async (postings, config) => {
    const days = config.report.repeat_suppression_days ?? 30;
    const recent = await store.recommendedSince(addDays(runDay(now()), -days));
    const kept = new Set<string>();
    const fresh = postings.filter((p) => {
      const fp = fingerprint(p);
      if (recent.has(fp) || kept.has(fp)) return false;
      kept.add(fp);
      return true;
    });
    const repeats = postings.filter((p) => recent.has(fingerprint(p))).length;
    return { fresh, repeats, duplicates: postings.length - fresh.length - repeats };
  };
}
