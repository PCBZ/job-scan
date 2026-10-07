// The daily run as a LangGraph state graph (plan §3, #55).
//
//   load_config ─┬─ fetch_mail ─ extract_postings ⇄ validate ─ dedupe ─ hard_gates ─ await_resumes ─┐
//                └─ load_resumes ─ canonicalize_resume_skills ──────────────────────────────────────┴─ judge ⇄ verify_judgements
//   ─ rank ─ explain ⇄ verify_explanations ─ canonicalize_posting_skills ─ keyword_coverage ─ render_report ─ deliver ─ mark_seen
//
// No new mail, or nothing past the hard gates, skips straight to render_report.

import type { FetchPayload } from "../mail/types.js";
import { type BuilderOptions, END, START, WorkflowBuilder } from "./builder.js";
import type { State } from "./state.js";
import type { DeterministicSteps, Effects, ModelSteps } from "./types.js";

export { type State, WorkflowState } from "./state.js";
export type WorkflowOptions = BuilderOptions;

function isPayload(mail: State["mail"]): mail is FetchPayload {
  return mail !== null && !("error" in mail);
}

function need<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`workflow: ${what} is missing`);
  return value;
}

export function buildWorkflow(
  steps: DeterministicSteps,
  model: ModelSteps,
  effects: Effects,
  options: WorkflowOptions = {},
) {
  const config = (s: State) => need(s.config, "config");
  const resumes = (s: State) => need(s.resumes, "resumes");

  return (
    new WorkflowBuilder(options)
      .node("load_config", async (_s, signal) => ({ config: await steps.loadConfig(signal) }))
      .edge(START, "load_config")
      .edge("load_config", "fetch_mail")
      .edge("load_config", "load_resumes")

      // Resume branch.
      .node("load_resumes", async (s, signal) => {
        const set = await steps.loadResumes(config(s), signal);
        return { resumes: set, warnings: set.warnings };
      })
      .edge("load_resumes", "canonicalize_resume_skills")
      .node("canonicalize_resume_skills", async (s, signal) => {
        const r = await model.canonicalizeResumeSkills({ resumes: resumes(s).variants }, signal);
        return { resumeSkills: r.value, usage: { canonicalize_resume_skills: r.usage } };
      })

      // Mail branch.
      .node("fetch_mail", async (s, signal) => ({ mail: await steps.fetchMail(config(s), signal) }))
      .branch(
        "fetch_mail",
        (s) => (isPayload(s.mail) && s.mail.messages.length > 0 ? "extract" : "no_mail"),
        { extract: "extract_postings", no_mail: "short_no_mail" },
      )
      .node("extract_postings", async (s, signal) => {
        const mail = s.mail as FetchPayload;
        const r = await model.extractPostings(
          { messages: mail.messages },
          s.loops.extract.turns,
          signal,
        );
        return {
          extracted: r.value,
          usage: { extract_postings: r.usage },
          ...(r.warnings?.length ? { warnings: r.warnings } : {}),
        };
      })
      .repairLoop("extract", {
        generate: "extract_postings",
        check: "validate",
        next: "dedupe",
        output: (s) => s.extracted,
        run: (s) => {
          const { valid, problems, dropped } = steps.validatePostings(s.extracted);
          return { problems, update: { postings: valid, dropped } };
        },
      })
      .node("dedupe", async (s) => {
        const { fresh, repeats, duplicates } = await steps.dedupe(s.postings, config(s));
        return { postings: fresh, repeats, duplicates };
      })
      .edge("dedupe", "hard_gates")
      .node("hard_gates", (s) => {
        const { kept, filtered } = steps.hardGates(s.postings, config(s));
        return { postings: kept, filtered };
      })
      .branch("hard_gates", (s) => (s.postings.length > 0 ? "continue" : "nothing_left"), {
        continue: "await_resumes",
        nothing_left: "short_nothing_left",
      })
      // The mail branch's last stop before the join.
      .node("await_resumes", () => ({}))

      // Both branches meet here.
      .join(["await_resumes", "canonicalize_resume_skills"], "judge")
      .node("judge", async (s, signal) => {
        const r = await model.judge(
          { postings: s.postings, resumes: resumes(s).variants },
          s.loops.judge.turns,
          signal,
        );
        return { judged: r.value, usage: { judge: r.usage } };
      })
      .repairLoop("judge", {
        generate: "judge",
        check: "verify_judgements",
        next: "rank",
        output: (s) => s.judged,
        run: (s) => ({ problems: steps.verifyJudgements(s.judged, resumes(s)) }),
      })
      .node("rank", (s) => ({ top: steps.rank(s.judged, config(s)) }))
      .edge("rank", "explain")
      .node("explain", async (s, signal) => {
        const r = await model.explain(
          { top: s.top, resumes: resumes(s).variants },
          s.loops.explain.turns,
          signal,
        );
        return { explanations: r.value, usage: { explain: r.usage } };
      })
      .repairLoop("explain", {
        generate: "explain",
        check: "verify_explanations",
        next: "canonicalize_posting_skills",
        output: (s) => s.explanations,
        run: (s) => ({ problems: steps.verifyExplanations(s.explanations, resumes(s)) }),
      })
      .node("canonicalize_posting_skills", async (s, signal) => {
        const r = await model.canonicalizePostingSkills({ top: s.top }, signal);
        return { postingSkills: r.value, usage: { canonicalize_posting_skills: r.usage } };
      })
      .edge("canonicalize_posting_skills", "keyword_coverage")
      .node("keyword_coverage", (s) => ({
        coverage: steps.keywordCoverage(s.top, s.postingSkills, s.resumeSkills),
      }))
      .edge("keyword_coverage", "render_report")

      // The short paths only set the outcome, then share the report.
      .node("short_no_mail", () => ({ outcome: "no_mail" as const }))
      .edge("short_no_mail", "render_report")
      .node("short_nothing_left", () => ({ outcome: "nothing_left" as const }))
      .edge("short_nothing_left", "render_report")

      .node("render_report", (s) => ({
        report: steps.renderReport({
          outcome: s.outcome,
          config: config(s),
          resumes: s.resumes,
          mail: s.mail,
          repeats: s.repeats,
          duplicates: s.duplicates,
          filtered: s.filtered,
          dropped: s.dropped,
          top: s.top,
          explanations: s.explanations,
          coverage: s.coverage,
          warnings: s.warnings,
        }),
      }))
      .edge("render_report", "deliver")
      .node("deliver", async (s, signal) => {
        await effects.deliver(need(s.report, "report"), signal);
        return {};
      })
      .edge("deliver", "mark_seen")
      .node("mark_seen", async (s, signal) => {
        // Only after a delivery: a failed run must see the same mail tomorrow.
        if (isPayload(s.mail)) await effects.markSeen({ mail: s.mail, top: s.top }, signal);
        return {};
      })
      .edge("mark_seen", END)
      .compile()
  );
}
