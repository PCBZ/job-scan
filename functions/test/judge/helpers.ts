import type { AskedGate } from "../../src/lib/judge/gates.js";
import type { Ranked } from "../../src/lib/judge/rank.js";
import type { JudgeAnswer } from "../../src/lib/judge/schema.js";
import type { Judgement } from "../../src/lib/judge/verify.js";
import type { Posting } from "../../src/lib/postings/types.js";
import { posting } from "../postings/helpers.js";

type Fit = JudgeAnswer["variants"][number]["skills"];

export const dimension = (over: Partial<Fit> = {}): Fit => ({
  level: "strong",
  evidence: "Built payment services in Go",
  gap: "",
  ...over,
});

/** A well-formed answer for one variant named "Backend"; override what a test is about. */
export function answer(over: Partial<JudgeAnswer> = {}): JudgeAnswer {
  return {
    gates: [],
    variants: [
      {
        variant: "Backend",
        skills: dimension(),
        domain: dimension({ level: "partial" }),
        seniority: dimension({ gap: "8+ years required" }),
      },
    ],
    location: { level: "exact", reason: "Vancouver is listed" },
    signal: { level: "strong", reason: "Names the stack" },
    unknowns: [],
    ...over,
  };
}

export function judgement(
  over: { posting?: Partial<Posting>; asked?: AskedGate[]; answer?: Partial<JudgeAnswer> } = {},
): Judgement {
  return {
    posting: posting({
      requirements: ["Go", "Postgres", "Kafka", "8+ years required"],
      ...over.posting,
    }),
    asked: over.asked ?? [],
    answer: answer(over.answer),
  };
}

export const rankedOf = (j: Judgement, score = 80): Ranked => ({
  posting: j.posting,
  judgement: j,
  variant: "Backend",
  either: undefined,
  score,
  scores: { Backend: score },
  caps: [],
  confidence: "high",
  noted: [],
});
