// The rank node: levels become scores in code. Each variant is weighted
// 35/25/20/10/10 into 0–100, the best one is named (or "either" when two are
// within 5 points), thin postings are capped, and the floor and top N apply.
// Failed model gates leave with their reasons; noted ones stay, flagged.

import type { AppConfig } from "../config/load.js";
import type { Filtered } from "../postings/gates.js";
import type { Posting } from "../postings/types.js";
import { sponsorshipApplies } from "./gates.js";
import type { Level } from "./schema.js";
import type { Judgement } from "./verify.js";

const FRACTION: Record<Level, number> = {
  none: 0,
  weak: 0.25,
  partial: 0.5,
  strong: 0.75,
  exact: 1,
};
export const WEIGHTS = { skills: 35, domain: 25, seniority: 20, location: 10, signal: 10 };
/** SKILL.md: two variants this close are "either". */
const EITHER_WITHIN = 5;
/** SKILL.md: a posting with thin requirements is capped and low-confidence. */
const THIN_BELOW = 3;
const THIN_CAP = 70;

export interface Ranked {
  posting: Posting;
  judgement: Judgement;
  /** The best-fitting variant. */
  variant: string;
  /** The runner-up when it is within EITHER_WITHIN points: send either. */
  either: string | undefined;
  score: number;
  /** Every variant's score, before any cap. */
  scores: Record<string, number>;
  confidence: "high" | "medium" | "low";
  /** Gates switched off by a sentinel that this posting would have failed. */
  noted: string[];
}

export interface RankResult {
  top: Ranked[];
  /** Scored postings that didn't make the top, best first: near misses and more. */
  rest: Ranked[];
  filtered: Filtered[];
  notes: string[];
}

function scoreOf(j: Judgement, variant: Judgement["answer"]["variants"][number]): number {
  const { answer } = j;
  const total =
    WEIGHTS.skills * FRACTION[variant.skills.level] +
    WEIGHTS.domain * FRACTION[variant.domain.level] +
    WEIGHTS.seniority * FRACTION[variant.seniority.level] +
    WEIGHTS.location * FRACTION[answer.location.level] +
    WEIGHTS.signal * FRACTION[answer.signal.level];
  return Math.round(total);
}

export function rank(judged: Judgement[], config: AppConfig): RankResult {
  const floor = config.report.min_score_to_recommend ?? 60;
  const topN = config.report.max_top_picks ?? 5;
  const filtered: Filtered[] = [];
  const scored: Ranked[] = [];

  for (const j of judged) {
    const outcomes = j.answer.gates.map((g, i) => ({ ...g, mode: j.asked[i]?.mode ?? "filter" }));
    const failed = outcomes.find((g) => g.fails && g.mode === "filter");
    if (failed) {
      filtered.push({
        posting: j.posting,
        gate: failed.gate,
        reason: `${failed.reason} ("${failed.quote}")`,
      });
      continue;
    }
    const scores = Object.fromEntries(j.answer.variants.map((v) => [v.variant, scoreOf(j, v)]));
    const [best, second] = Object.entries(scores).sort(([, a], [, b]) => b - a);
    if (!best) continue;
    const thin = j.posting.requirements.length < THIN_BELOW;
    scored.push({
      posting: j.posting,
      judgement: j,
      variant: best[0],
      either: second && best[1] - second[1] <= EITHER_WITHIN ? second[0] : undefined,
      score: thin ? Math.min(best[1], THIN_CAP) : best[1],
      scores,
      confidence: thin ? "low" : j.answer.unknowns.length > 0 ? "medium" : "high",
      noted: outcomes
        .filter((g) => g.fails && g.mode === "note")
        .map((g) => `${g.reason} ("${g.quote}")`),
    });
  }

  scored.sort((a, b) => b.score - a.score);
  const passing = scored.filter((r) => r.score >= floor);
  const top = passing.slice(0, topN);
  const rest = scored.filter((r) => !top.includes(r));
  const notes =
    config.profile.needs_sponsorship === true && !sponsorshipApplies(config.profile)
      ? [
          "needs_sponsorship is about US work visas and no listed location is in the US, so it wasn't applied",
        ]
      : [];
  return { top, rest, filtered, notes };
}
