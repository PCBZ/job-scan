// Which gates screen a posting, as yes/no questions for Jev (#118), and what a
// failure does. A gate a sentinel switched off is still asked, so the report
// can say what it would have caught; its failure is noted, never filtered.

import type { ProfileConfig } from "../config/schema.js";
import { countryOf } from "../postings/places.js";
import type { Posting } from "../postings/types.js";

/** Gates a model decides, after the code gates (#16). */
export const MODEL_GATES = ["sponsorship", "seniority", "keyword", "location"] as const;
export type ModelGate = (typeof MODEL_GATES)[number];

export interface AskedGate {
  gate: ModelGate;
  /** "filter" removes a failing posting; "note" keeps it and says so. */
  mode: "filter" | "note";
  /** A yes/no question about the posting, asked of Jev. */
  question: string;
  /** The answer that fails the gate: questions are asked as plainly as they read. */
  failsOn: "yes" | "no";
  /** What a failure means, for the report: Jev gives no reason of its own. */
  failure: string;
}

const SPONSORSHIP =
  "Does the posting require citizenship or a security clearance, or say it will not sponsor a work visa?";

/**
 * needs_sponsorship is framed around US work visas (H-1B, OPT). With no US
 * place in `locations` it asks the wrong question, so it isn't applied.
 */
export function sponsorshipApplies(profile: ProfileConfig): boolean {
  return (profile.locations ?? []).some((place) => countryOf(place)?.code === "US");
}

export function gatesFor(p: Posting, profile: ProfileConfig): AskedGate[] {
  const asked: AskedGate[] = [];
  const sponsorship = profile.needs_sponsorship;
  const sponsorshipGate = {
    question: SPONSORSHIP,
    failsOn: "yes" as const,
    failure: "requires citizenship or a clearance, or won't sponsor a visa",
  };
  if (sponsorship === true && sponsorshipApplies(profile)) {
    asked.push({ gate: "sponsorship", mode: "filter", ...sponsorshipGate });
  } else if (sponsorship === "unknown") {
    asked.push({ gate: "sponsorship", mode: "note", ...sponsorshipGate });
  }

  const seniority = profile.seniority;
  if (seniority && seniority !== "all") {
    const years =
      typeof profile.years_experience === "number"
        ? ` The candidate has ${profile.years_experience} years of experience.`
        : "";
    asked.push({
      gate: "seniority",
      mode: "filter",
      question:
        `Is this role two or more steps away from "${seniority}", in either direction, on the ` +
        `scale new-grad, junior, mid, senior, staff?${years}`,
      failsOn: "yes",
      failure: `seniority far from "${seniority}"`,
    });
  }

  const keywords = (profile.exclude_keywords ?? []).map((k) => k.trim()).filter(Boolean);
  if (keywords.length > 0) {
    asked.push({
      gate: "keyword",
      mode: "filter",
      question: `Does the posting describe any of these, even in other words: ${keywords.map((k) => `"${k}"`).join(", ")}?`,
      failsOn: "yes",
      failure: "describes an excluded keyword",
    });
  }

  // The location questions code couldn't settle (#16): each asks whether it fits.
  for (const question of p.gate_questions ?? []) {
    asked.push({
      gate: "location",
      mode: "filter",
      question,
      failsOn: "no",
      failure: `location doesn't fit: ${p.location.trim() || "not stated"}`,
    });
  }
  return asked;
}
