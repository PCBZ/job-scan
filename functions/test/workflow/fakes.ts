import type { AppConfig } from "../../src/lib/config/load.js";
import type { FetchPayload } from "../../src/lib/mail/types.js";
import type { ResumeSet } from "../../src/lib/resume/load.js";
import type {
  DeterministicSteps,
  Effects,
  ModelSteps,
  ReportInput,
} from "../../src/lib/workflow/types.js";
import { judgement, rankedOf } from "../judge/helpers.js";
import { posting } from "../postings/helpers.js";

export const CONFIG = { mail: {}, resume: {}, profile: {}, report: {} } as unknown as AppConfig;

export const RESUMES: ResumeSet = {
  variants: [{ path: "General/Resume.tex", name: "Resume", text: "Go and Postgres" }],
  defaultPath: "General/Resume.tex",
  warnings: [],
  stale: false,
  extracted: 0,
};

export function mail(count: number): FetchPayload {
  return {
    messages: Array.from({ length: count }, (_, i) => ({ message_id: `<m${i}@x>` })),
  } as unknown as FetchPayload;
}

const USAGE = { input: 10, output: 2 };

export interface FakeOptions {
  messages?: number;
  allAccountsFailed?: boolean;
  keepNone?: boolean;
  /** Problems a check reports on each attempt, until the list runs out. */
  extractProblems?: string[][];
  judgeProblems?: string[][];
  explainProblems?: string[][];
  resumeDelayMs?: number;
  deliverFails?: boolean;
  extractWarnings?: string[];
}

/** Nodes that record every call, in order, with their arguments. */
export function fakes(o: FakeOptions = {}) {
  const log: string[] = [];
  const llmInputs: { node: string; args: unknown[] }[] = [];
  const counters = { extract: 0, judge: 0, explain: 0 };
  /** What render_report was given: everything the run carried to the report. */
  const reported: ReportInput[] = [];
  const take = (lists: string[][] | undefined, n: number) => lists?.[n] ?? [];
  const llmCall = (node: string, args: unknown[]) => {
    log.push(node);
    llmInputs.push({ node, args });
  };

  const code: DeterministicSteps = {
    async loadConfig() {
      log.push("load_config");
      return CONFIG;
    },
    async loadResumes() {
      log.push("load_resumes:start");
      if (o.resumeDelayMs) await new Promise((r) => setTimeout(r, o.resumeDelayMs));
      log.push("load_resumes:end");
      return RESUMES;
    },
    async fetchMail() {
      log.push("fetch_mail");
      if (o.allAccountsFailed) return { error: "all_accounts_failed", failures: [] };
      return mail(o.messages ?? 2);
    },
    validatePostings(postings) {
      log.push("validate");
      const problems = take(o.extractProblems, counters.extract - 1);
      return { valid: postings, problems, dropped: problems.length ? { indeed: 1 } : {} };
    },
    async dedupe(postings) {
      log.push("dedupe");
      return { fresh: postings, repeats: 1, duplicates: 2 };
    },
    async hardGates(postings) {
      log.push("hard_gates");
      return o.keepNone
        ? {
            kept: [],
            filtered: postings.map((p) => ({ posting: p, gate: "location" as const, reason: "x" })),
            notes: [],
          }
        : {
            kept: postings,
            filtered: [{ posting: posting({ title: "far away" }), gate: "location", reason: "x" }],
            notes: ["salary not compared for 1 posting(s): currency unknown"],
          };
    },
    verifyJudgements() {
      log.push("verify_judgements");
      return take(o.judgeProblems, counters.judge - 1);
    },
    rank(judged) {
      log.push("rank");
      return {
        top: judged.map((j) => rankedOf(j)),
        rest: [],
        filtered: [
          { posting: posting({ title: "citizens only" }), gate: "sponsorship", reason: "y" },
        ],
        notes: ["needs_sponsorship wasn't applied"],
      };
    },
    verifyExplanations() {
      log.push("verify_explanations");
      return take(o.explainProblems, counters.explain - 1);
    },
    renderReport(input) {
      log.push("render_report");
      reported.push(input);
      return {
        day: "2026-10-08",
        outcome: input.outcome,
        alerts: [],
        funnel: "",
        counts: "",
        notes: [],
        top: [],
        others: [],
        filtered: [],
        suspicious: "not checked",
        housekeeping: [],
      };
    },
  };

  const llm: ModelSteps = {
    async extractPostings(...args) {
      counters.extract++;
      llmCall("extract_postings", args);
      return {
        value: [posting({ title: `attempt ${counters.extract}` })],
        usage: USAGE,
        ...(o.extractWarnings ? { warnings: o.extractWarnings } : {}),
      };
    },
    async judge(...args) {
      counters.judge++;
      llmCall("judge", args);
      return {
        value: [judgement({ posting: { title: `judged ${counters.judge}` } })],
        usage: USAGE,
      };
    },
    async explain(...args) {
      counters.explain++;
      llmCall("explain", args);
      return {
        value: [
          {
            id: `pick ${counters.explain}`,
            fit: { sentence: "Built it", quote: "Go" },
            gap: { requirement: "", advice: "Check the years" },
            unknown: "",
          },
        ],
        usage: USAGE,
      };
    },
  };

  const effects: Effects = {
    async deliver() {
      log.push("deliver");
      if (o.deliverFails) throw new Error("smtp down");
    },
    async markSeen() {
      log.push("mark_seen");
    },
  };

  return { code, llm, effects, log, llmInputs, counters, reported };
}
