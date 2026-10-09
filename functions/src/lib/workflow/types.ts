// The contract between the workflow graph and its nodes.
//
// Deterministic steps do everything that can be computed exactly. Model steps
// do what needs judgement and receive data only: no tools, no clients, no
// callbacks. Side effects (delivery, marking mail seen) live in Effects, which
// only deterministic nodes reached by graph edges ever call.

import type { AppConfig } from "../config/load.js";
import type { ExplainInput } from "../explain/explain.js";
import type { Explanation } from "../explain/schema.js";
import type { JudgeInput } from "../judge/judge.js";
import type { Ranked, RankResult } from "../judge/rank.js";
import type { Judgement } from "../judge/verify.js";
import type { AllAccountsFailed, FetchedMessage, FetchPayload } from "../mail/types.js";
import type { RepairTurn, TokenUsage } from "../model/types.js";
import type { Filtered } from "../postings/gates.js";
import type { Posting, Source } from "../postings/types.js";
import type { Report } from "../report/types.js";
import type { ResumeSet } from "../resume/load.js";

export type { Explanation, Filtered, Judgement, Posting, Ranked, Report };

// Shapes the node issues define; the graph only moves them between nodes.

export interface LlmResult<T> {
  value: T;
  usage: TokenUsage;
  /** What went wrong but didn't stop the step, for the report. */
  warnings?: string[];
}

/** Steps that call the model. Inputs are plain data. */
export interface ModelSteps {
  extractPostings(
    input: { messages: FetchedMessage[] },
    repairs: RepairTurn[],
    signal?: AbortSignal,
  ): Promise<LlmResult<Posting[]>>;
  judge(
    input: JudgeInput,
    repairs: RepairTurn[],
    signal?: AbortSignal,
  ): Promise<LlmResult<Judgement[]>>;
  explain(
    input: ExplainInput,
    repairs: RepairTurn[],
    signal?: AbortSignal,
  ): Promise<LlmResult<Explanation[]>>;
}

/** Steps computed exactly in code. A check returns its problems; empty means it passed. */
export interface DeterministicSteps {
  loadConfig(signal?: AbortSignal): Promise<AppConfig>;
  loadResumes(config: AppConfig, signal?: AbortSignal): Promise<ResumeSet>;
  fetchMail(config: AppConfig, signal?: AbortSignal): Promise<FetchPayload | AllAccountsFailed>;
  validatePostings(postings: Posting[]): {
    valid: Posting[];
    problems: string[];
    /** Rows that failed a check, per job board. */
    dropped: Partial<Record<Source, number>>;
  };
  /** Repeats (recommended recently) and duplicates (twice in this batch) are only counted. */
  dedupe(
    postings: Posting[],
    config: AppConfig,
  ): Promise<{ fresh: Posting[]; repeats: number; duplicates: number }>;
  /** Kept postings may carry gate_questions; notes say what a gate couldn't compare. */
  hardGates(
    postings: Posting[],
    config: AppConfig,
  ): Promise<{ kept: Posting[]; filtered: Filtered[]; notes: string[] }>;
  verifyJudgements(judged: Judgement[], resumes: ResumeSet): string[];
  /** Top N past the floor, the rest, model-gate failures and notes. */
  rank(judged: Judgement[], config: AppConfig): RankResult;
  verifyExplanations(explained: Explanation[], top: Ranked[], resumes: ResumeSet): string[];
  renderReport(input: ReportInput): Report;
}

/** The only side effects in the run. */
export interface Effects {
  /** Publish and send the report; the config names the recipients. */
  deliver(report: Report, config: AppConfig, signal?: AbortSignal): Promise<void>;
  /** After delivery: record seen messages and pending application rows. */
  markSeen(input: { mail: FetchPayload; top: Ranked[] }, signal?: AbortSignal): Promise<void>;
}

export type Outcome = "report" | "no_mail" | "nothing_left";

/** Everything renderReport sees; the short paths leave the later fields empty. */
export interface ReportInput {
  outcome: Outcome;
  config: AppConfig;
  resumes: ResumeSet | null;
  mail: FetchPayload | AllAccountsFailed | null;
  repeats: number;
  duplicates: number;
  filtered: Filtered[];
  /** Rows dropped as misaligned after the last repair, per job board. */
  dropped: Partial<Record<Source, number>>;
  top: Ranked[];
  /** Scored postings outside the top, best first. */
  rest: Ranked[];
  explanations: Explanation[];
  warnings: string[];
  /** What a gate couldn't compare, said once in the report. */
  notes: string[];
}

/** Told about every node run, for per-node telemetry (#31). */
export interface NodeEvent {
  node: string;
  ms: number;
  ok: boolean;
  usage?: TokenUsage;
}
