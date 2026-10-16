import { describe, expect, it } from "vitest";
import {
  fullLines,
  lineOf,
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
});

describe("short evidence (#138)", () => {
  const short = (evidence: string) =>
    judgement({
      answer: {
        variants: [
          {
            variant: "Backend",
            skills: dimension({ evidence }),
            domain: dimension({ evidence: "Postgres and Kafka" }),
            seniority: dimension({ level: "none", evidence: "" }),
          },
        ],
      },
    });

  it("passes a phrase from within one line", () => {
    expect(verifyJudgements([short("payment services in Go")], RESUMES)).toEqual([]);
  });

  it("flags a paraphrased phrase, so a repair asks for the resume's words", () => {
    expect(verifyJudgements([short("payment systems in Go")], RESUMES)[0]).toContain(
      'Backend skills: evidence "payment systems in Go" is not a line of that resume',
    );
  });

  it("flags a phrase that only matches inside a word, and restores no line for it", () => {
    const rebuilt: ResumeSet = {
      ...RESUMES,
      variants: [{ path: "B.tex", name: "Backend", text: "Rebuilt Go services at Northwind" }],
    };
    const j = short("Built Go services");
    expect(verifyJudgements([j], rebuilt)[0]).toContain('evidence "Built Go services" is not');
    expect(fullLines([j], rebuilt)[0]?.answer.variants[0]?.skills.evidence).toBe(
      "Built Go services",
    );
  });

  it("finds the line that holds a phrase, trimmed, or null", () => {
    const text = RESUMES.variants[0]?.text ?? "";
    expect(lineOf(text, "PAYMENT services")).toBe(
      "Built payment services in Go,  serving 2M users.",
    );
    expect(lineOf(text, "Kafka streams")).toBeNull();
  });

  it("restores each phrase to its whole line, and keeps the rest of the answer", () => {
    const j = short("payment services in Go");
    const [full] = fullLines([j], RESUMES);
    const v = full?.answer.variants[0];
    expect(v?.skills.evidence).toBe("Built payment services in Go,  serving 2M users.");
    expect(v?.domain.evidence).toBe("Postgres and Kafka");
    expect(v?.seniority).toEqual(j.answer.variants[0]?.seniority);
    expect(full?.posting).toBe(j.posting);
    expect({ ...full?.answer, variants: [] }).toEqual({ ...j.answer, variants: [] });
  });

  it("takes the first line when a phrase is in two", () => {
    const twice: ResumeSet = {
      ...RESUMES,
      variants: [
        { path: "B.tex", name: "Backend", text: "Go services at Northwind\nGo services at Lumen" },
      ],
    };
    const [full] = fullLines([short("Go services")], twice);
    expect(full?.answer.variants[0]?.skills.evidence).toBe("Go services at Northwind");
  });

  it("leaves a phrase found nowhere as it is", () => {
    const [full] = fullLines([short("payment systems in Go")], RESUMES);
    expect(full?.answer.variants[0]?.skills.evidence).toBe("payment systems in Go");
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
