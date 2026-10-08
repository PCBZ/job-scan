import { describe, expect, it } from "vitest";
import { judgeStep } from "../../src/lib/judge/judge.js";
import { JUDGE_SYSTEM } from "../../src/lib/judge/prompt.js";
import type { JudgeAnswer } from "../../src/lib/judge/schema.js";
import { postingId, problemAbout } from "../../src/lib/judge/verify.js";
import {
  type ModelClient,
  ModelOutputError,
  ModelProviderError,
  type StructuredRequest,
} from "../../src/lib/model/types.js";
import type { ResumeVariant } from "../../src/lib/resume/load.js";
import { posting } from "../postings/helpers.js";
import { answer } from "./helpers.js";

const RESUMES: ResumeVariant[] = [
  { path: "Backend.tex", name: "Backend", text: "Built payment services in Go" },
  { path: "Data.tex", name: "Data", text: "Built Spark pipelines" },
];
const PROFILE = {
  locations: ["Vancouver, BC"],
  seniority: "mid" as const,
  needs_sponsorship: false,
};
const a = posting({ title: "Backend Engineer", message_id: "<m@x>", row: 0 });
const b = posting({ title: "Data Engineer", message_id: "<m@x>", row: 1 });

/** Answers every call with `reply(user)`, recording each request. */
function client(reply: (user: string) => JudgeAnswer = () => answer()) {
  const calls: StructuredRequest<unknown>[] = [];
  const c: ModelClient = {
    async structured<T>(req: StructuredRequest<T>) {
      calls.push(req as StructuredRequest<unknown>);
      return {
        value: reply(req.user) as T,
        usage: { input: 1000, output: 100 },
        served_by: "primary",
      };
    },
  };
  return { c, calls };
}

describe("judgeStep", () => {
  it("judges each posting in one call, with the profile, its gates and every resume", async () => {
    const { c, calls } = client();
    const out = await judgeStep(c)({ postings: [a, b], resumes: RESUMES, profile: PROFILE }, []);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.system).toBe(JUDGE_SYSTEM);
    const user = JSON.parse(calls[0]?.user ?? "{}");
    expect(user.posting.title).toBe("Backend Engineer");
    expect(user.candidate).toMatchObject({ seniority: "mid", locations: ["Vancouver, BC"] });
    expect(user.gates.map((g: { gate: string }) => g.gate)).toEqual(["seniority"]);
    expect(user.resumes).toEqual([
      { variant: "Backend", text: "Built payment services in Go" },
      { variant: "Data", text: "Built Spark pipelines" },
    ]);

    expect(out.value.map((j) => [j.posting.title, j.asked.map((g) => g.gate)])).toEqual([
      ["Backend Engineer", ["seniority"]],
      ["Data Engineer", ["seniority"]],
    ]);
    expect(out.usage).toEqual({ input: 2000, output: 200 });
    expect(out.warnings).toEqual([]);
  });

  it("on a repair, re-asks only the flagged posting, with its own history", async () => {
    let round = 0;
    const { c, calls } = client(() => answer({ unknowns: [`round ${round}`] }));
    const step = judgeStep(c);
    const first = await step({ postings: [a, b], resumes: RESUMES, profile: PROFILE }, []);

    round = 1;
    const problems = [problemAbout(postingId(b), "Backend names no gap")];
    const second = await step({ postings: [a, b], resumes: RESUMES, profile: PROFILE }, [
      { previous: first.value, problems },
    ]);

    expect(calls).toHaveLength(3);
    expect(JSON.parse(calls[2]?.user ?? "{}").posting.title).toBe("Data Engineer");
    expect(calls[2]?.repairs).toEqual([{ previous: answer({ unknowns: ["round 0"] }), problems }]);
    expect(second.value.map((j) => [j.posting.title, j.answer.unknowns])).toEqual([
      ["Backend Engineer", ["round 0"]],
      ["Data Engineer", ["round 1"]],
    ]);
  });

  it("sends a posting only the repair turns where it had problems", async () => {
    const { c, calls } = client();
    const step = judgeStep(c);
    const first = (await step({ postings: [a, b], resumes: RESUMES, profile: PROFILE }, [])).value;
    const turn1 = { previous: first, problems: [problemAbout(postingId(a), "one")] };
    const turn2 = { previous: first, problems: [problemAbout(postingId(b), "two")] };
    await step({ postings: [a, b], resumes: RESUMES, profile: PROFILE }, [turn1, turn2]);
    expect(JSON.parse(calls.at(-1)?.user ?? "{}").posting.title).toBe("Data Engineer");
    expect(calls.at(-1)?.repairs).toEqual([
      { previous: answer(), problems: [problemAbout(postingId(b), "two")] },
    ]);
  });

  it("an unusable answer costs that posting and is reported; a provider failure fails the run", async () => {
    const refusing: ModelClient = {
      async structured<T>(req: StructuredRequest<T>) {
        if (req.user.includes("Data Engineer")) throw new ModelOutputError("judgement: refused");
        return { value: answer() as T, usage: { input: 1, output: 1 }, served_by: "primary" };
      },
    };
    const out = await judgeStep(refusing)(
      { postings: [a, b], resumes: RESUMES, profile: PROFILE },
      [],
    );
    expect(out.value.map((j) => j.posting.title)).toEqual(["Backend Engineer"]);
    expect(out.warnings).toEqual([`judge: posting ${postingId(b)}: judgement: refused`]);

    const down: ModelClient = {
      async structured() {
        throw new ModelProviderError("rate limited", 429);
      },
    };
    await expect(
      judgeStep(down)({ postings: [a], resumes: RESUMES, profile: PROFILE }, []),
    ).rejects.toThrow("rate limited");
  });

  it("keeps a posting's earlier judgement when its repair is unusable", async () => {
    let refuse = false;
    const c: ModelClient = {
      async structured<T>() {
        if (refuse) throw new ModelOutputError("judgement: cut off");
        return { value: answer() as T, usage: { input: 1, output: 1 }, served_by: "primary" };
      },
    };
    const step = judgeStep(c);
    const first = await step({ postings: [a], resumes: RESUMES, profile: PROFILE }, []);
    refuse = true;
    const problems = [problemAbout(postingId(a), "bad")];
    const out = await step({ postings: [a], resumes: RESUMES, profile: PROFILE }, [
      { previous: first.value, problems },
    ]);
    expect(out.value).toEqual(first.value);
  });

  it("passes the cancellation signal to every call", async () => {
    const controller = new AbortController();
    const { c, calls } = client();
    await judgeStep(c)(
      { postings: [a], resumes: RESUMES, profile: PROFILE },
      [],
      controller.signal,
    );
    expect(calls[0]?.signal).toBe(controller.signal);
  });
});
