// The workflow's state: one channel per field, each with how updates merge.

import { Annotation } from "@langchain/langgraph";
import type { AppConfig } from "../config/load.js";
import type { AllAccountsFailed, FetchPayload } from "../mail/types.js";
import type { RepairTurn, TokenUsage } from "../model/types.js";
import type { Source } from "../postings/types.js";
import type { ResumeSet } from "../resume/load.js";
import type {
  Coverage,
  Explanation,
  Filtered,
  Judgement,
  Outcome,
  Posting,
  Ranked,
  Report,
  SkillSets,
} from "./types.js";

/** The three generate-and-check loops. */
export type Loop = "extract" | "judge" | "explain";

/** Where a loop stands after its latest check. */
export interface LoopState {
  /** Every repair sent so far, oldest first. */
  turns: RepairTurn[];
  problems: string[];
  /** The check asked for another attempt; the router reads only this. */
  retry: boolean;
}

/** A check's update to its own loop: turns append, the rest replace. */
export type LoopUpdate = Partial<Record<Loop, LoopState>>;

const NO_LOOP: LoopState = { turns: [], problems: [], retry: false };

const last = <T>(fallback: T) =>
  Annotation<T>({ reducer: (_old: T, next: T) => next, default: () => fallback });
const appended = <T>() =>
  Annotation<T[]>({ reducer: (old: T[], next: T[]) => old.concat(next), default: () => [] });

export const WorkflowState = Annotation.Root({
  outcome: last<Outcome>("report"),
  config: last<AppConfig | null>(null),
  resumes: last<ResumeSet | null>(null),
  resumeSkills: last<SkillSets>({}),
  mail: last<FetchPayload | AllAccountsFailed | null>(null),

  extracted: last<Posting[]>([]),
  postings: last<Posting[]>([]),
  repeats: last<number>(0),
  duplicates: last<number>(0),
  filtered: last<Filtered[]>([]),
  dropped: last<Partial<Record<Source, number>>>({}),
  judged: last<Judgement[]>([]),
  top: last<Ranked[]>([]),
  explanations: last<Explanation[]>([]),
  postingSkills: last<SkillSets>({}),
  coverage: last<Coverage[]>([]),
  report: last<Report | null>(null),

  loops: Annotation<Record<Loop, LoopState>, LoopUpdate>({
    reducer: (old, next) => {
      const out = { ...old };
      for (const [loop, u] of Object.entries(next) as [Loop, LoopState][]) {
        out[loop] = {
          turns: old[loop].turns.concat(u.turns),
          problems: u.problems,
          retry: u.retry,
        };
      }
      return out;
    },
    default: () => ({ extract: NO_LOOP, judge: NO_LOOP, explain: NO_LOOP }),
  }),
  warnings: appended<string>(),
  usage: Annotation<Record<string, TokenUsage>>({
    reducer: (old, next) => {
      const out = { ...old };
      for (const [node, u] of Object.entries(next)) {
        const prev = out[node] ?? { input: 0, output: 0 };
        out[node] = { input: prev.input + u.input, output: prev.output + u.output };
      }
      return out;
    },
    default: () => ({}),
  }),
});

export type State = typeof WorkflowState.State;
export type Update = typeof WorkflowState.Update;
