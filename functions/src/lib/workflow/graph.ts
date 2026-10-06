// The daily run as a LangGraph state graph (plan §3, #55).
//
//   load_config ─┬─ fetch_mail ─ extract_postings ⇄ validate ─ dedupe ─ hard_gates ─ await_resumes ─┐
//                └─ load_resumes ─ canonicalize_resume_skills ──────────────────────────────────────┴─ judge ⇄ verify_judgements
//   ─ rank ─ explain ⇄ verify_explanations ─ canonicalize_posting_skills ─ keyword_coverage ─ render_report ─ deliver ─ mark_seen
//
// No new mail, or nothing past the hard gates, skips straight to render_report.

import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { AppConfig } from "../config/load.js";
import type { AllAccountsFailed, FetchPayload } from "../mail/types.js";
import type { RepairTurn, TokenUsage } from "../model/types.js";
import type { ResumeSet } from "../resume/load.js";
import type {
  CodeNodes,
  Coverage,
  Effects,
  Explanation,
  Filtered,
  Judgement,
  LlmNodes,
  NodeEvent,
  Outcome,
  Posting,
  Ranked,
  Report,
  SkillSets,
} from "./types.js";

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
  extractProblems: last<string[]>([]),
  extractRepairs: appended<RepairTurn>(),
  postings: last<Posting[]>([]),
  repeats: last<number>(0),
  filtered: last<Filtered[]>([]),

  judged: last<Judgement[]>([]),
  judgeProblems: last<string[]>([]),
  judgeRepairs: appended<RepairTurn>(),
  top: last<Ranked[]>([]),

  explanations: last<Explanation[]>([]),
  explainProblems: last<string[]>([]),
  explainRepairs: appended<RepairTurn>(),
  postingSkills: last<SkillSets>({}),
  coverage: last<Coverage[]>([]),

  report: last<Report | null>(null),
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
type Update = typeof WorkflowState.Update;

export interface WorkflowOptions {
  /** Repair rounds after the first attempt, per loop. */
  maxRepairs?: number;
  onNode?: (event: NodeEvent) => void;
}

function isPayload(mail: State["mail"]): mail is FetchPayload {
  return mail !== null && !("error" in mail);
}

function need<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`workflow: ${what} is missing`);
  return value;
}

export function buildWorkflow(
  code: CodeNodes,
  llm: LlmNodes,
  effects: Effects,
  options: WorkflowOptions = {},
) {
  const maxRepairs = options.maxRepairs ?? 2;

  // Times every node and reports its token use; the update passes through.
  const timed =
    (node: string, fn: (s: State, signal?: AbortSignal) => Promise<Update> | Update) =>
    async (s: State, config?: { signal?: AbortSignal }): Promise<Update> => {
      const started = performance.now();
      try {
        const update = await fn(s, config?.signal);
        const usage = (update.usage as Record<string, TokenUsage> | undefined)?.[node];
        options.onNode?.({
          node,
          ms: performance.now() - started,
          ok: true,
          ...(usage ? { usage } : {}),
        });
        return update;
      } catch (err) {
        options.onNode?.({ node, ms: performance.now() - started, ok: false });
        throw err;
      }
    };

  // A check that still fails after the last repair: carry on, but say so.
  const giveUp = (node: string, problems: string[]) =>
    problems.map((p) => `${node}: unresolved after ${maxRepairs} repair(s): ${p}`);

  return (
    new StateGraph(WorkflowState)
      .addNode(
        "load_config",
        timed("load_config", async (_s, signal) => ({ config: await code.loadConfig(signal) })),
      )
      .addNode(
        "load_resumes",
        timed("load_resumes", async (s, signal) => {
          const resumes = await code.loadResumes(need(s.config, "config"), signal);
          return { resumes, warnings: resumes.warnings };
        }),
      )
      .addNode(
        "canonicalize_resume_skills",
        timed("canonicalize_resume_skills", async (s, signal) => {
          const r = await llm.canonicalizeResumeSkills(
            { resumes: need(s.resumes, "resumes").variants },
            signal,
          );
          return { resumeSkills: r.value, usage: { canonicalize_resume_skills: r.usage } };
        }),
      )
      .addNode(
        "fetch_mail",
        timed("fetch_mail", async (s, signal) => ({
          mail: await code.fetchMail(need(s.config, "config"), signal),
        })),
      )
      .addNode(
        "extract_postings",
        timed("extract_postings", async (s, signal) => {
          const mail = s.mail as FetchPayload;
          const r = await llm.extractPostings(
            { messages: mail.messages },
            s.extractRepairs,
            signal,
          );
          return { extracted: r.value, usage: { extract_postings: r.usage } };
        }),
      )
      .addNode(
        "validate",
        timed("validate", (s) => {
          const { valid, problems } = code.validatePostings(s.extracted);
          const retry = problems.length > 0 && s.extractRepairs.length < maxRepairs;
          return {
            postings: valid,
            extractProblems: problems,
            ...(retry ? { extractRepairs: [{ previous: s.extracted, problems }] } : {}),
            ...(problems.length > 0 && !retry ? { warnings: giveUp("validate", problems) } : {}),
          };
        }),
      )
      .addNode(
        "dedupe",
        timed("dedupe", async (s) => {
          const { fresh, repeats } = await code.dedupe(s.postings);
          return { postings: fresh, repeats };
        }),
      )
      .addNode(
        "hard_gates",
        timed("hard_gates", (s) => {
          const { kept, filtered } = code.hardGates(s.postings, need(s.config, "config"));
          return { postings: kept, filtered };
        }),
      )
      .addNode(
        "await_resumes",
        timed("await_resumes", () => ({})),
      )
      .addNode(
        "judge",
        timed("judge", async (s, signal) => {
          const r = await llm.judge(
            { postings: s.postings, resumes: need(s.resumes, "resumes").variants },
            s.judgeRepairs,
            signal,
          );
          return { judged: r.value, usage: { judge: r.usage } };
        }),
      )
      .addNode(
        "verify_judgements",
        timed("verify_judgements", (s) => {
          const problems = code.verifyJudgements(s.judged, need(s.resumes, "resumes"));
          const retry = problems.length > 0 && s.judgeRepairs.length < maxRepairs;
          return {
            judgeProblems: problems,
            ...(retry ? { judgeRepairs: [{ previous: s.judged, problems }] } : {}),
            ...(problems.length > 0 && !retry
              ? { warnings: giveUp("verify_judgements", problems) }
              : {}),
          };
        }),
      )
      .addNode(
        "rank",
        timed("rank", (s) => ({ top: code.rank(s.judged, need(s.config, "config")) })),
      )
      .addNode(
        "explain",
        timed("explain", async (s, signal) => {
          const r = await llm.explain(
            { top: s.top, resumes: need(s.resumes, "resumes").variants },
            s.explainRepairs,
            signal,
          );
          return { explanations: r.value, usage: { explain: r.usage } };
        }),
      )
      .addNode(
        "verify_explanations",
        timed("verify_explanations", (s) => {
          const problems = code.verifyExplanations(s.explanations, need(s.resumes, "resumes"));
          const retry = problems.length > 0 && s.explainRepairs.length < maxRepairs;
          return {
            explainProblems: problems,
            ...(retry ? { explainRepairs: [{ previous: s.explanations, problems }] } : {}),
            ...(problems.length > 0 && !retry
              ? { warnings: giveUp("verify_explanations", problems) }
              : {}),
          };
        }),
      )
      .addNode(
        "canonicalize_posting_skills",
        timed("canonicalize_posting_skills", async (s, signal) => {
          const r = await llm.canonicalizePostingSkills({ top: s.top }, signal);
          return { postingSkills: r.value, usage: { canonicalize_posting_skills: r.usage } };
        }),
      )
      .addNode(
        "keyword_coverage",
        timed("keyword_coverage", (s) => ({
          coverage: code.keywordCoverage(s.top, s.postingSkills, s.resumeSkills),
        })),
      )
      .addNode(
        "render_report",
        timed("render_report", (s) => ({
          report: code.renderReport({
            outcome: s.outcome,
            config: need(s.config, "config"),
            resumes: s.resumes,
            mail: s.mail,
            repeats: s.repeats,
            filtered: s.filtered,
            top: s.top,
            explanations: s.explanations,
            coverage: s.coverage,
            warnings: s.warnings,
          }),
        })),
      )
      .addNode(
        "deliver",
        timed("deliver", async (s, signal) => {
          await effects.deliver(need(s.report, "report"), signal);
          return {};
        }),
      )
      .addNode(
        "mark_seen",
        timed("mark_seen", async (s, signal) => {
          // Only after a delivery: a failed run must see the same mail tomorrow.
          if (isPayload(s.mail)) await effects.markSeen({ mail: s.mail, top: s.top }, signal);
          return {};
        }),
      )
      // The short paths only set the outcome, then share render_report.
      .addNode("short_no_mail", () => ({ outcome: "no_mail" as const }))
      .addNode("short_nothing_left", () => ({ outcome: "nothing_left" as const }))

      .addEdge(START, "load_config")
      .addEdge("load_config", "fetch_mail")
      .addEdge("load_config", "load_resumes")
      .addEdge("load_resumes", "canonicalize_resume_skills")

      .addConditionalEdges(
        "fetch_mail",
        (s) => (isPayload(s.mail) && s.mail.messages.length > 0 ? "extract_postings" : "no_mail"),
        { extract_postings: "extract_postings", no_mail: "short_no_mail" },
      )
      .addEdge("extract_postings", "validate")
      .addConditionalEdges(
        "validate",
        // A retry was queued only if this pass appended a repair for this output.
        (s) =>
          s.extractProblems.length > 0 && s.extractRepairs.at(-1)?.previous === s.extracted
            ? "retry"
            : "next",
        { retry: "extract_postings", next: "dedupe" },
      )
      .addEdge("dedupe", "hard_gates")
      .addConditionalEdges(
        "hard_gates",
        (s) => (s.postings.length > 0 ? "continue" : "nothing_left"),
        {
          continue: "await_resumes",
          nothing_left: "short_nothing_left",
        },
      )
      .addEdge(["await_resumes", "canonicalize_resume_skills"], "judge")
      .addEdge("judge", "verify_judgements")
      .addConditionalEdges(
        "verify_judgements",
        (s) =>
          s.judgeProblems.length > 0 && s.judgeRepairs.at(-1)?.previous === s.judged
            ? "retry"
            : "next",
        { retry: "judge", next: "rank" },
      )
      .addEdge("rank", "explain")
      .addEdge("explain", "verify_explanations")
      .addConditionalEdges(
        "verify_explanations",
        (s) =>
          s.explainProblems.length > 0 && s.explainRepairs.at(-1)?.previous === s.explanations
            ? "retry"
            : "next",
        { retry: "explain", next: "canonicalize_posting_skills" },
      )
      .addEdge("canonicalize_posting_skills", "keyword_coverage")
      .addEdge("keyword_coverage", "render_report")
      .addEdge("render_report", "deliver")
      .addEdge("deliver", "mark_seen")
      .addEdge("mark_seen", END)

      .addEdge("short_no_mail", "render_report")
      .addEdge("short_nothing_left", "render_report")
      .compile()
      // About 18 supersteps on the longest path, plus two (generate and check)
      // per repair in each of the three loops; LangGraph's default of 25 is too low.
      .withConfig({ recursionLimit: 30 + 3 * 2 * maxRepairs })
  );
}
