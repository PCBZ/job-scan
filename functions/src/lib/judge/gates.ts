// Which gates screen a posting, as yes/no questions for Jev (#121), and what
// a failure does. A gate a sentinel switched off is still asked, so the
// report can say what it would have caught; its failure is noted, never
// filtered.

import type { ProfileConfig } from "../config/schema.js";
import { countryOf } from "../postings/places.js";
import type { Posting } from "../postings/types.js";
import { question } from "./questions.js";

/** Gates a model decides, after the code gates (#16). */
export const MODEL_GATES = ["sponsorship", "seniority", "keyword", "location", "title"] as const;
export type ModelGate = (typeof MODEL_GATES)[number];

export interface AskedGate {
  gate: ModelGate;
  /** "filter" removes a failing posting; "note" keeps it and says so. */
  mode: "filter" | "note";
  /** A yes/no question about the posting, asked of Jev (#121), from prompts/gates.json. */
  question: string;
  /** The answer that fails the gate: questions are asked as plainly as they read. */
  failsOn: "yes" | "no";
  /** What a failure means, for the report: Jev gives no reason of its own. */
  failure: string;
}

const SPONSORSHIP_GATE = {
  question: question("sponsorship"),
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
    asked.push({
      gate: "seniority",
      mode: "filter",
      question: question("seniority", {
        seniority,
        ...(typeof profile.years_experience === "number"
          ? { years: String(profile.years_experience) }
          : {}),
      }),
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
      question: question("keyword", { keywords: list }),
      failsOn: "yes",
      failure: "describes an excluded keyword",
    });
  }

  // The location questions code couldn't settle (#16).
  for (const question of p.gate_questions ?? []) {
    asked.push({
      gate: "location",
      mode: "filter",
      question,
      failsOn: "no",
      failure: `location doesn't fit: ${p.location.trim() || "not stated"}`,
    });
  }
  // A plainly unrelated role skips judge, the run's costliest call (#137).
  const targets = (profile.target_titles ?? []).map((t) => t.trim()).filter(Boolean);
  if (targets.length > 0) {
    asked.push({
      gate: "title",
      mode: "filter",
      question: question("title", { targets: targets.map((t) => `"${t}"`).join(", ") }),
      failsOn: "no",
      failure: "title far from your target roles",
    });
  }
  return asked;
}
