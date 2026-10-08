import { describe, expect, it } from "vitest";
import {
  postingId,
  problemAbout,
  problemsAbout,
  verifyJudgements,
} from "../../src/lib/judge/verify.js";
import type { ResumeSet } from "../../src/lib/resume/load.js";
import { dimension, judgement } from "./helpers.js";

const RESUMES: ResumeSet = {
  variants: [
    {
      path: "Backend.tex",
      name: "Backend",
      text: "Software Engineer, Northwind\n  Built payment services in Go,  serving 2M users.\nPostgres and Kafka",
    },
  ],
  defaultPath: "Backend.tex",
  warnings: [],
  stale: false,
  extracted: 0,
};
const gate = (fails: boolean, quote: string) => ({
  gate: "sponsorship" as const,
  fails,
  reason: "r",
  quote,
});
const ASKED = [{ gate: "sponsorship" as const, mode: "filter" as const, rule: "x" }];

describe("verifyJudgements", () => {
  it("passes a judgement whose quotes are real, ignoring case, spacing and edge punctuation", () => {
    const j = judgement({
      answer: {
        variants: [
          {
            variant: "Backend",
            skills: dimension({ evidence: "- built payment services in go, serving 2m users." }),
            domain: dimension({ evidence: "POSTGRES AND KAFKA" }),
            seniority: dimension({ level: "none", evidence: "", gap: "8+ years" }),
          },
        ],
      },
    });
    expect(verifyJudgements([j], RESUMES)).toEqual([]);
  });

  it("flags evidence that isn't a line of the resume", () => {
    const j = judgement({
      answer: {
        variants: [
          {
            variant: "Backend",
            skills: dimension({ evidence: "Led a team of 12" }),
            domain: dimension(),
            seniority: dimension({ gap: "8+ years required" }),
          },
        ],
      },
    });
    expect(verifyJudgements([j], RESUMES)).toEqual([
      problemAbout(
        postingId(j.posting),
        'Backend skills: evidence "Led a team of 12" is not a line of that resume',
      ),
    ]);
  });

  it("flags a gap that isn't a requirement the posting states", () => {
    const j = judgement({
      answer: {
        variants: [
          {
            variant: "Backend",
            skills: dimension(),
            domain: dimension({ gap: "product area not stated" }),
            seniority: dimension(),
          },
        ],
      },
    });
    expect(verifyJudgements([j], RESUMES)).toEqual([
      problemAbout(
        postingId(j.posting),
        'Backend domain: gap "product area not stated" is not a requirement the posting states; copy it verbatim, or leave it empty',
      ),
    ]);
  });

  it("flags a gap taken from a field that isn't a requirement, such as the title", () => {
    const j = judgement({
      posting: { title: "Staff Engineer" },
      answer: {
        variants: [
          {
            variant: "Backend",
            skills: dimension(),
            domain: dimension({ gap: "Staff Engineer" }),
            seniority: dimension(),
          },
        ],
      },
    });
    expect(verifyJudgements([j], RESUMES)[0]).toContain(
      'Backend domain: gap "Staff Engineer" is not a requirement',
    );
  });

  it("rejects evidence that joins two resume lines", () => {
    const j = judgement({
      answer: {
        variants: [
          {
            variant: "Backend",
            skills: dimension({ evidence: "Northwind Built payment services" }),
            domain: dimension(),
            seniority: dimension({ gap: "8+ years required" }),
          },
        ],
      },
    });
    expect(verifyJudgements([j], RESUMES)[0]).toContain(
      'evidence "Northwind Built payment services" is not a line of that resume',
    );
  });

  it("allows a variant with no gap: rank caps it instead", () => {
    const j = judgement({
      answer: {
        variants: [
          { variant: "Backend", skills: dimension(), domain: dimension(), seniority: dimension() },
        ],
      },
    });
    expect(verifyJudgements([j], RESUMES)).toEqual([]);
  });

  it("flags variants missing, extra or out of order", () => {
    const j = judgement({ answer: { variants: [] } });
    expect(verifyJudgements([j], RESUMES)[0]).toContain(
      "answer one entry per resume, in this order: Backend",
    );
  });

  it("flags gates that don't match those asked", () => {
    const j = judgement({ asked: ASKED, answer: { gates: [] } });
    expect(verifyJudgements([j], RESUMES)[0]).toContain(
      "answer exactly these gates, in this order: sponsorship",
    );
  });

  it("flags a failed gate whose quote isn't in the posting, and allows a passing one without", () => {
    const p = { requirements: ["Must be a US citizen", "8+ years required"] };
    const ok = judgement({
      posting: p,
      asked: ASKED,
      answer: { gates: [gate(true, "must be a US citizen")] },
    });
    const silent = judgement({ posting: p, asked: ASKED, answer: { gates: [gate(false, "")] } });
    const unquoted = judgement({ posting: p, asked: ASKED, answer: { gates: [gate(true, "")] } });
    const invented = judgement({
      posting: p,
      asked: ASKED,
      answer: { gates: [gate(true, "no visas")] },
    });
    expect(verifyJudgements([ok, silent], RESUMES)).toEqual([]);
    expect(verifyJudgements([unquoted], RESUMES)[0]).toContain(
      'gate sponsorship fails, but its quote "" is not in the posting',
    );
    expect(verifyJudgements([invented], RESUMES)[0]).toContain(
      'its quote "no visas" is not in the posting',
    );
  });

  it("accepts a gate quote from any field the model was shown, workplace and age included", () => {
    const asked = [{ gate: "location" as const, mode: "filter" as const, rule: "x" }];
    const onsite = {
      gate: "location" as const,
      fails: true,
      reason: "Fully on-site",
      quote: "onsite",
    };
    const p = { workplace: "onsite" as const, location: "Lower Mainland" };
    expect(
      verifyJudgements([judgement({ posting: p, asked, answer: { gates: [onsite] } })], RESUMES),
    ).toEqual([]);
    const aged = { ...onsite, quote: "30+ days ago" };
    expect(
      verifyJudgements(
        [
          judgement({
            posting: { ...p, posted: "30+ days ago" },
            asked,
            answer: { gates: [aged] },
          }),
        ],
        RESUMES,
      ),
    ).toEqual([]);
  });
});

describe("problemsAbout", () => {
  it("picks one posting's problems by its JSON-quoted id", () => {
    const problems = [
      problemAbout("<a@x>#0", "one"),
      problemAbout("<a@x>#01", "two"),
      problemAbout("<a@x>#0", "three"),
    ];
    expect(problemsAbout(problems, "<a@x>#0")).toEqual([
      'posting "<a@x>#0": one',
      'posting "<a@x>#0": three',
    ]);
  });
});
