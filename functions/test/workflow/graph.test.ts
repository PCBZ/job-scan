import { describe, expect, it } from "vitest";
import { buildWorkflow } from "../../src/lib/workflow/graph.js";
import type { NodeEvent } from "../../src/lib/workflow/types.js";
import { posting } from "../postings/helpers.js";
import { fakes } from "./fakes.js";

function run(f: ReturnType<typeof fakes>, options = {}, signal?: AbortSignal) {
  return buildWorkflow(f.code, f.llm, f.effects, options).invoke({}, signal ? { signal } : {});
}

const ranBefore = (log: string[], a: string, b: string) => log.indexOf(a) < log.indexOf(b);

describe("workflow graph", () => {
  it("runs the full path in order, delivering before marking mail seen", async () => {
    const f = fakes();
    const out = await run(f);
    expect(out.outcome).toBe("report");
    expect(f.log[0]).toBe("load_config");
    for (const [a, b] of [
      ["extract_postings", "validate"],
      ["validate", "dedupe"],
      ["dedupe", "hard_gates"],
      ["hard_gates", "judge"],
      ["canonicalize_resume_skills", "judge"],
      ["judge", "verify_judgements"],
      ["verify_judgements", "rank"],
      ["rank", "explain"],
      ["explain", "verify_explanations"],
      ["verify_explanations", "canonicalize_posting_skills"],
      ["canonicalize_posting_skills", "keyword_coverage"],
      ["keyword_coverage", "render_report"],
      ["render_report", "deliver"],
    ]) {
      expect(ranBefore(f.log, a as string, b as string), `${a} before ${b}`).toBe(true);
    }
    expect(f.log.at(-1)).toBe("mark_seen");
    expect(out.report).toEqual({
      outcome: "report",
      warnings: [],
      top: 1,
      dropped: {},
      repeats: 1,
      duplicates: 2,
      notes: ["salary not compared for 1 posting(s): currency unknown"],
    });
  });

  it("loads mail and resumes in parallel and joins them at judge", async () => {
    const f = fakes({ resumeDelayMs: 30 });
    await run(f);
    // fetch_mail runs while load_resumes is still waiting. LangGraph runs in
    // supersteps, so the branches overlap step by step, not end to end.
    expect(ranBefore(f.log, "load_resumes:start", "load_resumes:end")).toBe(true);
    expect(ranBefore(f.log, "fetch_mail", "load_resumes:end")).toBe(true);
    // judge runs once, after the slower resume branch finished.
    expect(f.log.filter((n) => n === "judge")).toHaveLength(1);
    expect(ranBefore(f.log, "canonicalize_resume_skills", "judge")).toBe(true);
  });

  it("sends each failed check back with its problems, oldest repair first", async () => {
    const f = fakes({
      extractProblems: [["row 2: company looks like a date"], ["row 1: empty title"]],
    });
    const out = await run(f);
    const repairsSeen = f.llmInputs
      .filter((c) => c.node === "extract_postings")
      .map((c) => c.args[1]);
    expect(repairsSeen).toEqual([
      [],
      [
        {
          previous: [posting({ title: "attempt 1" })],
          problems: ["row 2: company looks like a date"],
        },
      ],
      [
        {
          previous: [posting({ title: "attempt 1" })],
          problems: ["row 2: company looks like a date"],
        },
        { previous: [posting({ title: "attempt 2" })], problems: ["row 1: empty title"] },
      ],
    ]);
    expect(out.warnings).toEqual([]);
  });

  it("stops each loop after the repair limit, records what's unresolved, and carries on", async () => {
    const always = Array.from({ length: 10 }, () => ["still wrong"]);
    const f = fakes({ extractProblems: always, judgeProblems: always, explainProblems: always });
    const out = await run(f, { maxRepairs: 2 });
    expect(f.counters).toEqual({ extract: 3, judge: 3, explain: 3 });
    expect((out.report as { warnings: string[] }).warnings).toHaveLength(3);
    // The last pass still failed, so its rows count as dropped.
    expect((out.report as { dropped: object }).dropped).toEqual({ indeed: 1 });
    expect(out.warnings).toEqual([
      "validate: unresolved after 2 repair(s): still wrong",
      "verify_judgements: unresolved after 2 repair(s): still wrong",
      "verify_explanations: unresolved after 2 repair(s): still wrong",
    ]);
    expect(f.log.slice(-2)).toEqual(["deliver", "mark_seen"]);
  });

  it("carries extraction warnings and the final dropped counts into the report", async () => {
    const f = fakes({
      extractProblems: [["x"], []],
      extractWarnings: ["extract_postings: message <m1@x>: refused"],
    });
    const out = await run(f);
    const report = out.report as { warnings: string[]; dropped: object };
    // The repair fixed the rows, so the last pass dropped nothing.
    expect(report.dropped).toEqual({});
    expect(report.warnings).toEqual([
      "extract_postings: message <m1@x>: refused",
      "extract_postings: message <m1@x>: refused",
    ]);
  });

  it("with no new mail, skips extraction and judging and sends a short report", async () => {
    const f = fakes({ messages: 0 });
    const out = await run(f);
    expect(out.outcome).toBe("no_mail");
    for (const n of ["extract_postings", "judge", "explain", "canonicalize_posting_skills"]) {
      expect(f.log).not.toContain(n);
    }
    expect(f.log.slice(-2)).toEqual(["deliver", "mark_seen"]);
  });

  it("when every mailbox failed, reports it and marks nothing seen", async () => {
    const f = fakes({ allAccountsFailed: true });
    const out = await run(f);
    expect(out.outcome).toBe("no_mail");
    expect(f.log).toContain("deliver");
    expect(f.log).not.toContain("mark_seen");
  });

  it("when nothing passes the hard gates, skips judging and sends a short report", async () => {
    const f = fakes({ keepNone: true });
    const out = await run(f);
    expect(out.outcome).toBe("nothing_left");
    expect(f.log).not.toContain("judge");
    expect(f.log.slice(-2)).toEqual(["deliver", "mark_seen"]);
  });

  it("never marks mail seen when delivery fails, and reports the failed node", async () => {
    const events: NodeEvent[] = [];
    const f = fakes({ deliverFails: true });
    await expect(run(f, { onNode: (e: NodeEvent) => events.push(e) })).rejects.toThrow("smtp down");
    expect(f.log).not.toContain("mark_seen");
    expect(events.find((e) => e.node === "deliver")?.ok).toBe(false);
    expect(events.find((e) => e.node === "render_report")?.ok).toBe(true);
  });

  it("gives LLM nodes data only: no functions anywhere in their input", async () => {
    const f = fakes({ extractProblems: [["x"]], judgeProblems: [["y"]], explainProblems: [["z"]] });
    await run(f);
    const callables: string[] = [];
    const scan = (v: unknown, path: string, seen = new Set<unknown>()) => {
      if (typeof v === "function") callables.push(path);
      if (v === null || typeof v !== "object" || seen.has(v) || v instanceof AbortSignal) return;
      seen.add(v);
      for (const [k, child] of Object.entries(v)) scan(child, `${path}.${k}`, seen);
    };
    for (const call of f.llmInputs) scan(call.args, call.node);
    // Every LLM node was exercised.
    expect(new Set(f.llmInputs.map((c) => c.node))).toEqual(
      new Set([
        "extract_postings",
        "canonicalize_resume_skills",
        "judge",
        "explain",
        "canonicalize_posting_skills",
      ]),
    );
    expect(callables).toEqual([]);
  });

  it("reports every node's duration and sums token use across retries", async () => {
    const events: NodeEvent[] = [];
    const f = fakes({ extractProblems: [["x"]] });
    const out = await run(f, { onNode: (e: NodeEvent) => events.push(e) });
    expect(events.filter((e) => e.node === "extract_postings")).toHaveLength(2);
    expect(events.every((e) => e.ok && e.ms >= 0)).toBe(true);
    expect(events.find((e) => e.node === "judge")?.usage).toEqual({ input: 10, output: 2 });
    expect(out.usage.extract_postings).toEqual({ input: 20, output: 4 });
  });

  it("stops when the run is cancelled, before anything is delivered", async () => {
    const controller = new AbortController();
    const f = fakes({ resumeDelayMs: 50 });
    setTimeout(() => controller.abort(), 10);
    await expect(run(f, {}, controller.signal)).rejects.toThrow();
    expect(f.log).not.toContain("deliver");
  });

  it("allows the full repair budget with a higher limit", async () => {
    const always = Array.from({ length: 20 }, () => ["still wrong"]);
    const f = fakes({ extractProblems: always, judgeProblems: always, explainProblems: always });
    await run(f, { maxRepairs: 5 });
    expect(f.counters).toEqual({ extract: 6, judge: 6, explain: 6 });
  });
});
