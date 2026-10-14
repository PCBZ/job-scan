// Which gates a posting is checked against, and what a failure does. Jev
// screens them first, as yes/no questions (#121); until #122 the judge still
// answers them too, by their rule. A gate a sentinel switched off is still
// asked, so the report can say what it would have caught; its failure is
// noted, never filtered.

import type { ProfileConfig } from "../config/schema.js";
import { countryOf } from "../postings/places.js";
import type { Posting } from "../postings/types.js";
import type { ModelGate } from "./schema.js";

export interface AskedGate {
  gate: ModelGate;
  /** "filter" removes a failing posting; "note" keeps it and says so. */
  mode: "filter" | "note";
  /** The rule as the judge reads it. */
  rule: string;
  /** A yes/no question about the posting, asked of Jev (#121). */
  question: string;
  /** The answer that fails the gate: questions are asked as plainly as they read. */
  failsOn: "yes" | "no";
  /** What a failure means, for the report: Jev gives no reason of its own. */
  failure: string;
}

const SPONSORSHIP =
  "Fails if the posting requires citizenship or a security clearance, or says it will not sponsor a work visa.";
const SPONSORSHIP_GATE = {
  rule: SPONSORSHIP,
  question:
    "Does the posting require citizenship or a security clearance, or say it will not sponsor a work visa?",
  failsOn: "yes" as const,
  failure: "requires citizenship or a clearance, or won't sponsor a visa",
};

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
    asked.push({ gate: "sponsorship", mode: "filter", ...SPONSORSHIP_GATE });
  } else if (sponsorship === "unknown") {
    asked.push({ gate: "sponsorship", mode: "note", ...SPONSORSHIP_GATE });
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
      question:
        `Is this role two or more steps away from "${seniority}", in either direction, on the ` +
        `scale new-grad, junior, mid, senior, staff?${years}`,
      failsOn: "yes",
      failure: `seniority far from "${seniority}"`,
    });
  }

  const keywords = (profile.exclude_keywords ?? []).map((k) => k.trim()).filter(Boolean);
  if (keywords.length > 0) {
    const list = keywords.map((k) => `"${k}"`).join(", ");
    asked.push({
      gate: "keyword",
      mode: "filter",
      rule: `Fails if the posting describes any of these, even in other words: ${list}.`,
      question: `Does the posting describe any of these, even in other words: ${list}?`,
      failsOn: "yes",
      failure: "describes an excluded keyword",
    });
  }

  // The location questions code couldn't settle (#16).
  for (const question of p.gate_questions ?? []) {
    asked.push({
      gate: "location",
      mode: "filter",
      rule: `Fails if the answer is no: ${question}`,
      question,
      failsOn: "no",
      failure: `location doesn't fit: ${p.location.trim() || "not stated"}`,
    });
  }
  return asked;
}
