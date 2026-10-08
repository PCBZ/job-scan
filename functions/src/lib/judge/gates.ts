// Which gates the model judges for a posting, and what a failure does. A gate
// a sentinel switched off is still asked, so the report can say what it would
// have caught; its failure is noted, never filtered.

import type { ProfileConfig } from "../config/schema.js";
import { countryOf } from "../postings/places.js";
import type { Posting } from "../postings/types.js";
import type { ModelGate } from "./schema.js";

export interface AskedGate {
  gate: ModelGate;
  /** "filter" removes a failing posting; "note" keeps it and says so. */
  mode: "filter" | "note";
  rule: string;
}

const SPONSORSHIP =
  "Fails if the posting requires citizenship or a security clearance, or says it will not sponsor a work visa.";

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
  if (sponsorship === true && sponsorshipApplies(profile)) {
    asked.push({ gate: "sponsorship", mode: "filter", rule: SPONSORSHIP });
  } else if (sponsorship === "unknown") {
    asked.push({ gate: "sponsorship", mode: "note", rule: SPONSORSHIP });
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
      rule:
        `Fails if the role is materially outside "${seniority}" in either direction: two or ` +
        `more steps away on the scale new-grad, junior, mid, senior, staff.${years}`,
    });
  }

  const keywords = (profile.exclude_keywords ?? []).map((k) => k.trim()).filter(Boolean);
  if (keywords.length > 0) {
    asked.push({
      gate: "keyword",
      mode: "filter",
      rule: `Fails if the posting describes any of these, even in other words: ${keywords.map((k) => `"${k}"`).join(", ")}.`,
    });
  }

  // The location questions code couldn't settle (#16).
  for (const question of p.gate_questions ?? []) {
    asked.push({
      gate: "location",
      mode: "filter",
      rule: `Fails if the answer is no: ${question}`,
    });
  }
  return asked;
}
