import type { Prices } from "../../src/lib/eval/prices.js";
import type { RunRecord, RunStatsRecord } from "../../src/lib/run/records.js";
import { posting } from "../postings/helpers.js";

/** A run line; override what a test is about. */
export function runLine(over: Partial<RunStatsRecord> = {}): RunStatsRecord {
  const noLoop = { repairs: 0, first_pass: [], unresolved: [] };
  return {
    kind: "run",
    started_at: "2026-10-15T15:00:00.000Z",
    ended_at: "2026-10-15T15:08:13.000Z",
    version: "v0.1.9",
    node_ms: { judge: 1000 },
    throttled_ms: 360_000,
    rate_limited: 0,
    outcome: "report",
    messages: 39,
    extracted: 3,
    judged: 1,
    filtered: 2,
    top: 1,
    repeats: 3,
    duplicates: 46,
    dropped: { glassdoor: 1 },
    loops: {
      extract: { ...noLoop, repairs: 1, first_pass: ["p"] },
      judge: { repairs: 2, first_pass: ["a", "b", "c"], unresolved: ["c"] },
      explain: noLoop,
    },
    warnings: 1,
    usage: {
      extract_postings: { input: 80_000, output: 16_000 },
      judge: { input: 1_000_000, output: 100_000, cached: 800_000 },
      explain: { input: 10_000, output: 800 },
      screen: { input: 30_000, output: 0 },
    },
    ...over,
  };
}

/** A run's records: two postings, a code filter, a Jev filter, an unsure pick. */
export function records(over: Partial<RunStatsRecord> = {}): RunRecord[] {
  const montreal = posting({
    title: "Full-Stack Developer",
    company: "Intact",
    location: "Montreal",
    row: 1,
  });
  const pick = posting({
    title: "Backend Engineer",
    source: "glassdoor",
    gate_notes: ['Possibly seniority far from "mid" (Jev 0.65)'],
  });
  return [
    { kind: "posting", posting: pick },
    { kind: "posting", posting: montreal },
    { kind: "posting", posting: posting({ source: "glassdoor", row: 2 }) },
    {
      kind: "filtered",
      posting: posting({ location: "Sunnyvale, CA", row: 3 }),
      gate: "location",
      reason: "outside locations: Sunnyvale, CA",
    },
    {
      kind: "filtered",
      posting: montreal,
      gate: "location",
      reason: "location doesn't fit: Montreal (Jev 0.97)",
    },
    {
      kind: "pick",
      posting: pick,
      score: 70,
      scores: { Resume: 70 },
      variant: "Resume",
      either: undefined,
      caps: [],
      confidence: "low",
      judgement: {} as never,
      explanation: null,
      resume: null,
    },
    runLine(over),
  ] as RunRecord[];
}

/** Synthetic prices: what a report would have read. */
export const PRICES: Prices = {
  azure: {
    "gpt-5.4-mini": { input: 0.75, cached: 0.075, output: 4.5 },
    "gpt-5.4-nano": { input: 0.2, cached: 0.02, output: 1.25 },
  },
  jev: { input: 0.042, cached: 0.042, output: 0 },
  azureOn: "2026-10-17",
};
