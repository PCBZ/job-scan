// The contract between the workflow graph and its nodes.
//
// Code nodes do everything that can be computed exactly. LLM nodes do what
// needs judgement and receive data only: no tools, no clients, no callbacks.
// Side effects (delivery, marking mail seen) live in Effects, which only code
// nodes reached by graph edges ever call.

import type { AppConfig } from "../config/load.js";
import type { AllAccountsFailed, FetchedMessage, FetchPayload } from "../mail/types.js";
import type { RepairTurn, TokenUsage } from "../model/types.js";
import type { ResumeSet, ResumeVariant } from "../resume/load.js";

// Shapes the node issues define; the graph only moves them between nodes.
/** A posting extracted from alert mail. Shape: #14. */
export type Posting = Record<string, unknown>;
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
/** A posting a hard gate removed, with the reason. Shape: #16. */
export type Filtered = Record<string, unknown>;
/** The report every channel renders from. Shape: #19. */
export type Report = Record<string, unknown>;

export interface LlmResult<T> {
  value: T;
  usage: TokenUsage;
}

/** Nodes that call the model. Inputs are plain data. */
export interface LlmNodes {
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

/** Nodes computed in code. A check returns its problems; empty means it passed. */
export interface CodeNodes {
  loadConfig(signal?: AbortSignal): Promise<AppConfig>;
  loadResumes(config: AppConfig, signal?: AbortSignal): Promise<ResumeSet>;
  fetchMail(config: AppConfig, signal?: AbortSignal): Promise<FetchPayload | AllAccountsFailed>;
  validatePostings(postings: Posting[]): { valid: Posting[]; problems: string[] };
  dedupe(postings: Posting[]): Promise<{ fresh: Posting[]; repeats: number }>;
  hardGates(postings: Posting[], config: AppConfig): { kept: Posting[]; filtered: Filtered[] };
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
  filtered: Filtered[];
  top: Ranked[];
  explanations: Explanation[];
  coverage: Coverage[];
  warnings: string[];
}

/** Told about every node run, for per-node telemetry (#31). */
export interface NodeEvent {
  node: string;
  ms: number;
  ok: boolean;
  usage?: TokenUsage;
}
