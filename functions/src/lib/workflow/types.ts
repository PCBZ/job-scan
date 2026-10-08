// The contract between the workflow graph and its nodes.
//
// Deterministic steps do everything that can be computed exactly. Model steps
// do what needs judgement and receive data only: no tools, no clients, no
// callbacks. Side effects (delivery, marking mail seen) live in Effects, which
// only deterministic nodes reached by graph edges ever call.

import type { AppConfig } from "../config/load.js";
import type { AllAccountsFailed, FetchedMessage, FetchPayload } from "../mail/types.js";
import type { RepairTurn, TokenUsage } from "../model/types.js";
import type { Filtered } from "../postings/gates.js";
import type { Posting, Source } from "../postings/types.js";
import type { ResumeSet, ResumeVariant } from "../resume/load.js";

export type { Filtered, Posting };

// Shapes the node issues define; the graph only moves them between nodes.
/** A posting with gates, rubric score, variant and evidence. Shape: #17. */
export type Judgement = Record<string, unknown>;
/** A judged posting after weighting and the floor. Shape: #17. */
export type Ranked = Record<string, unknown>;
/** Fit / Gap prose for a top pick. Shape: #18. */
export type Explanation = Record<string, unknown>;
/** Canonical skills per resume variant or per posting. Shape: #28. */
export type SkillSets = Record<string, string[]>;
/** Coverage of a top pick's requirements by its variant. Shape: #28. */
export type Coverage = Record<string, unknown>;
/** The report every channel renders from. Shape: #19. */
export type Report = Record<string, unknown>;

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
  canonicalizeResumeSkills(
    input: { resumes: ResumeVariant[] },
    signal?: AbortSignal,
  ): Promise<LlmResult<SkillSets>>;
  judge(
    input: { postings: Posting[]; resumes: ResumeVariant[] },
    repairs: RepairTurn[],
    signal?: AbortSignal,
  ): Promise<LlmResult<Judgement[]>>;
  explain(
    input: { top: Ranked[]; resumes: ResumeVariant[] },
    repairs: RepairTurn[],
    signal?: AbortSignal,
  ): Promise<LlmResult<Explanation[]>>;
  canonicalizePostingSkills(
    input: { top: Ranked[] },
    signal?: AbortSignal,
  ): Promise<LlmResult<SkillSets>>;
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
  rank(judged: Judgement[], config: AppConfig): Ranked[];
  verifyExplanations(explained: Explanation[], resumes: ResumeSet): string[];
  keywordCoverage(top: Ranked[], postingSkills: SkillSets, resumeSkills: SkillSets): Coverage[];
  renderReport(input: ReportInput): Report;
}

/** The only side effects in the run. */
export interface Effects {
  deliver(report: Report, signal?: AbortSignal): Promise<void>;
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
  explanations: Explanation[];
  coverage: Coverage[];
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
