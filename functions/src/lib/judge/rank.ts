// The rank node: levels become scores in code. Each variant is weighted
// 35/25/20/10/10 into 0–100 and capped at 70 when the posting is thin or the
// variant has no stated gap. The best one is named (or "either" when two are
// within 5 points), and the floor and top N apply.
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
/** The score a capped variant can't exceed: thin requirements, or no stated gap. */
const CAP = 70;

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
  /** Why the chosen variant's score was capped at 70, if it was. */
  caps: string[];
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
    const thin = j.posting.requirements.length < THIN_BELOW;
    const variants = j.answer.variants.map((v) => {
      const caps = [
        ...(thin ? ["thin requirements"] : []),
        // SKILL.md: a fit with no stated gap is not credible; lower the score.
        ...(!v.skills.gap && !v.domain.gap && !v.seniority.gap ? ["no stated gap"] : []),
      ];
      const raw = scoreOf(j, v);
      return { name: v.variant, raw, score: caps.length ? Math.min(raw, CAP) : raw, caps };
    });
    // The best variant after its caps: a capped one can lose to one with a gap.
    const [best, second] = variants.sort((x, y) => y.score - x.score);
    if (!best) continue;
    scored.push({
      posting: j.posting,
      judgement: j,
      variant: best.name,
      either: second && best.score - second.score <= EITHER_WITHIN ? second.name : undefined,
      score: best.score,
      scores: Object.fromEntries(variants.map((v) => [v.name, v.raw])),
      caps: best.caps,
      confidence: best.caps.length ? "low" : j.answer.unknowns.length > 0 ? "medium" : "high",
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
