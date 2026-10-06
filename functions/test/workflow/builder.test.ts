import { describe, expect, it } from "vitest";
import { END, START, WorkflowBuilder } from "../../src/lib/workflow/builder.js";

// A one-loop graph: extract_postings → validate, failing the first `fails` checks.
function loop(fails: number, maxRepairs = 2) {
  let attempts = 0;
  let checks = 0;
  const graph = new WorkflowBuilder({ maxRepairs })
    .node("extract_postings", () => ({ extracted: [{ attempt: ++attempts }] }))
    .edge(START, "extract_postings")
    .repairLoop("extract", {
      generate: "extract_postings",
      check: "validate",
      next: "done",
      // A fresh copy each time, as a resumed checkpoint would hold: routing
      // must not depend on the output being the same object.
      output: (s) => structuredClone(s.extracted),
      run: () => ({ problems: checks++ < fails ? [`bad ${checks}`] : [] }),
    })
    .node("done", () => ({}))
    .edge("done", END)
    .compile();
  return { graph, attempts: () => attempts };
}

describe("WorkflowBuilder.repairLoop", () => {
  it("retries while the check fails, sending every repair so far", async () => {
    const { graph, attempts } = loop(2);
    const out = await graph.invoke({});
    expect(attempts()).toBe(3);
    expect(out.loops.extract).toEqual({
      turns: [
        { previous: [{ attempt: 1 }], problems: ["bad 1"] },
        { previous: [{ attempt: 2 }], problems: ["bad 2"] },
      ],
      problems: [],
      retry: false,
    });
    expect(out.warnings).toEqual([]);
  });

  it("goes on after the last repair, recording what is unresolved", async () => {
    const { graph, attempts } = loop(10, 1);
    const out = await graph.invoke({});
    expect(attempts()).toBe(2);
    expect(out.loops.extract.retry).toBe(false);
    expect(out.warnings).toEqual(["validate: unresolved after 1 repair(s): bad 2"]);
  });

  it("never retries with no repairs allowed", async () => {
    const { graph, attempts } = loop(10, 0);
    const out = await graph.invoke({});
    expect(attempts()).toBe(1);
    expect(out.warnings).toEqual(["validate: unresolved after 0 repair(s): bad 1"]);
  });
});
