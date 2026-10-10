import { describe, expect, it } from "vitest";
import { runDaily } from "../../src/lib/run/daily.js";
import { fakes } from "../workflow/fakes.js";

function recorder() {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    log: { log: (m: string) => lines.push(m), error: (m: string) => errors.push(m) },
  };
}

describe("runDaily", () => {
  it("runs the workflow, logs every node, and returns a summary", async () => {
    const f = fakes();
    const r = recorder();
    const summary = await runDaily(f, r.log);
    expect(summary).toMatchObject({ outcome: "report", top: 1, warnings: 0 });
    expect(summary.usage.judge).toEqual({ input: 10, output: 2 });
    expect(r.lines).toContainEqual(expect.stringMatching(/^node judge ok \d+ms tokens 10\/2$/));
    expect(r.lines.some((l) => l.startsWith("node mark_seen ok"))).toBe(true);
    expect(r.lines.at(-1)).toMatch(/^daily: done \{"outcome":"report","top":1,"warnings":0,/);
  });

  it("logs a failed run and rethrows, so the host records it and nothing is marked seen", async () => {
    const f = fakes({ deliverFails: true });
    const r = recorder();
    await expect(runDaily(f, r.log)).rejects.toThrow("smtp down");
    expect(r.errors).toEqual(["daily: failed: Error: smtp down"]);
    expect(r.lines.some((l) => l.startsWith("node deliver failed"))).toBe(true);
    expect(f.log).not.toContain("mark_seen");
  });

  it("stops when its signal aborts", async () => {
    const f = fakes({ resumeDelayMs: 50 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    await expect(runDaily(f, recorder().log, controller.signal)).rejects.toThrow();
    expect(f.log).not.toContain("deliver");
  });
});
