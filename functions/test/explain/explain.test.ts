import { describe, expect, it } from "vitest";
import { explainStep } from "../../src/lib/explain/explain.js";
import { EXPLAIN_SYSTEM } from "../../src/lib/explain/prompt.js";
import type { Explanation } from "../../src/lib/explain/schema.js";
import { verifyExplanations } from "../../src/lib/explain/verify.js";
import { postingId } from "../../src/lib/judge/verify.js";
import type { ModelClient, StructuredRequest } from "../../src/lib/model/types.js";
import type { ResumeSet } from "../../src/lib/resume/load.js";
import { dimension, judgement, rankedOf } from "../judge/helpers.js";

const RESUMES: ResumeSet = {
  variants: [
    {
      path: "Backend.tex",
      name: "Backend",
      text: "Software Engineer, Northwind\nBuilt payment services in Go",
    },
    { path: "Data.tex", name: "Data", text: "Built Spark pipelines" },
  ],
  defaultPath: "Backend.tex",
  warnings: [],
  stale: false,
  extracted: 0,
};

const pick = rankedOf(judgement({ posting: { title: "Backend Engineer", row: 0 } }));
const gapless = rankedOf(
  judgement({
    posting: { title: "Platform Engineer", row: 1 },
    answer: {
      variants: [
        { variant: "Backend", skills: dimension(), domain: dimension(), seniority: dimension() },
      ],
      unknowns: ["years required"],
    },
  }),
);

const good = (over: Partial<Explanation> = {}): Explanation => ({
  id: postingId(pick.posting),
  fit: {
    sentence: "Shipped the same kind of service the role owns.",
    quote: "Built payment services in Go",
  },
  gap: { requirement: "8+ years required", advice: "Lead with the scope of the ledger work." },
  unknown: "",
  ...over,
});
const none = (over: Partial<Explanation> = {}): Explanation => ({
  ...good(),
  id: postingId(gapless.posting),
  gap: {
    requirement: "",
    advice: "The listed requirements are all met; check the years required.",
  },
  ...over,
});

describe("verifyExplanations", () => {
  it("passes a fit quoting the resume and a gap quoting the posting, or a stated none", () => {
    expect(verifyExplanations([good(), none()], [pick, gapless], RESUMES)).toEqual([]);
  });

  it("flags picks missing, extra or out of order", () => {
    expect(verifyExplanations([none(), good()], [pick, gapless], RESUMES)[0]).toBe(
      `answer one entry per pick, in this order: ${postingId(pick.posting)}, ${postingId(gapless.posting)}`,
    );
  });

  it.each([
    [
      { fit: { sentence: "x", quote: "Led a team of 12" } },
      'fit quote "Led a team of 12" is not a line of the Backend resume',
    ],
    [{ fit: { sentence: " ", quote: "Built payment services in Go" } }, "fit needs a sentence"],
    [
      { gap: { requirement: "product area not stated", advice: "x" } },
      'gap "product area not stated" is not a requirement the posting states',
    ],
    [
      { gap: { requirement: "", advice: "x" } },
      'the judgement found a gap ("8+ years required"); name it',
    ],
    [{ gap: { requirement: "8+ years required", advice: "" } }, "gap needs advice"],
  ])("flags %j", (over, problem) => {
    const found = verifyExplanations([good(over)], [pick], RESUMES);
    expect(
      found.some((f) => f.includes(problem)),
      found.join("; "),
    ).toBe(true);
  });

  it("checks the quote against the resume chosen for the pick, not another", () => {
    const data = { ...pick, variant: "Data" };
    expect(verifyExplanations([good()], [data], RESUMES)[0]).toContain(
      "is not a line of the Data resume",
    );
  });
});

describe("explainStep", () => {
  function client(picks: Explanation[]) {
    const calls: StructuredRequest<unknown>[] = [];
    const c: ModelClient = {
      async structured<T>(req: StructuredRequest<T>) {
        calls.push(req as StructuredRequest<unknown>);
        return { value: { picks } as T, usage: { input: 900, output: 300 }, served_by: "primary" };
      },
    };
    return { c, calls };
  }

  it("explains all the picks in one call, with each chosen resume and its judgement", async () => {
    const { c, calls } = client([good(), none()]);
    const out = await explainStep(c)({ top: [pick, gapless], resumes: RESUMES.variants }, []);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.system).toBe(EXPLAIN_SYSTEM);
    const user = JSON.parse(calls[0]?.user ?? "{}");
    expect(user.picks.map((p: { id: string }) => p.id)).toEqual([
      postingId(pick.posting),
      postingId(gapless.posting),
    ]);
    expect(user.picks[0].resume).toEqual({ variant: "Backend", text: RESUMES.variants[0]?.text });
    expect(user.picks[0].judgement.seniority.gap).toBe("8+ years required");
    expect(user.picks[1].judgement.unknowns).toEqual(["years required"]);
    expect(out).toEqual({ value: [good(), none()], usage: { input: 900, output: 300 } });
  });

  it("sends earlier answers back in the shape the model gave them", async () => {
    const { c, calls } = client([good()]);
    await explainStep(c)({ top: [pick], resumes: RESUMES.variants }, [
      { previous: [good()], problems: ["p"] },
    ]);
    expect(calls[0]?.repairs).toEqual([{ previous: { picks: [good()] }, problems: ["p"] }]);
  });

  it("makes no call on a day with no picks", async () => {
    const { c, calls } = client([]);
    const out = await explainStep(c)({ top: [], resumes: RESUMES.variants }, []);
    expect([calls.length, out]).toEqual([0, { value: [], usage: { input: 0, output: 0 } }]);
  });

  it("passes the cancellation signal", async () => {
    const controller = new AbortController();
    const { c, calls } = client([good()]);
    await explainStep(c)({ top: [pick], resumes: RESUMES.variants }, [], controller.signal);
    expect(calls[0]?.signal).toBe(controller.signal);
  });
});
