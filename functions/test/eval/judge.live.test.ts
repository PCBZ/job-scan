// Live judging against the deployed model, on synthetic postings and resumes.
// Skipped unless EVAL_LIVE is exactly 1. Signs in with DefaultAzureCredential,
// like the extraction eval; set MODEL_PROVIDER, MODEL_ENDPOINT and MODEL_NAME
// the same way (see extract.live.test.ts), then: npm run eval:judge

import { DefaultAzureCredential } from "@azure/identity";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/lib/config/load.js";
import { judgeStep } from "../../src/lib/judge/judge.js";
import { rank } from "../../src/lib/judge/rank.js";
import { type Judgement, verifyJudgements } from "../../src/lib/judge/verify.js";
import { modelClientFromEnv } from "../../src/lib/model/config.js";
import type { RepairTurn } from "../../src/lib/model/types.js";
import type { ResumeSet } from "../../src/lib/resume/load.js";
import { posting } from "../postings/helpers.js";

const MAX_REPAIRS = 2;

const RESUMES: ResumeSet = {
  variants: [
    {
      path: "Backend.tex",
      name: "Backend",
      text: [
        "Software Engineer, Northwind Payments (2021 to present)",
        "Built a payment ledger service in Go on Postgres, handling 3M transactions a day",
        "Moved settlement jobs to Kafka consumers, cutting batch delays from hours to minutes",
        "Skills: Go, Postgres, Kafka, Docker, Kubernetes, gRPC",
      ].join("\n"),
    },
    {
      path: "Data.tex",
      name: "Data",
      text: [
        "Data Engineer, Northwind Payments (2021 to present)",
        "Built Spark pipelines on Databricks that feed the fraud models",
        "Modelled the analytics warehouse in dbt on Snowflake",
        "Skills: Python, Spark, SQL, Airflow, dbt, Snowflake",
      ].join("\n"),
    },
  ],
  defaultPath: "Backend.tex",
  warnings: [],
  stale: false,
  extracted: 0,
};

const CONFIG = {
  profile: {
    locations: ["Vancouver, BC", "Seattle, WA"],
    open_to_remote: true,
    seniority: "mid",
    years_experience: 4,
    needs_sponsorship: true,
    exclude_keywords: ["unpaid"],
  },
  report: { min_score_to_recommend: 0 },
} as AppConfig;

const BACKEND = posting({
  row: 0,
  title: "Backend Engineer, Payments",
  company: "Lumen Ridge",
  location: "Vancouver, BC",
  workplace: "hybrid",
  requirements: ["Go", "Postgres", "Kafka", "3+ years building payment systems"],
});
const CITIZENS = posting({
  row: 1,
  title: "Software Engineer",
  company: "Saltmarsh Defense",
  location: "Seattle, WA",
  requirements: ["Go", "Must be a US citizen with an active security clearance", "Kubernetes"],
});
const DATA = posting({
  row: 2,
  title: "Data Engineer",
  company: "Quillfeather",
  location: "Vancouver, BC",
  requirements: ["Spark", "Airflow", "SQL", "Snowflake"],
});

describe.skipIf(process.env.EVAL_LIVE !== "1")("judging, live", () => {
  it("judges, verifies and ranks three postings", { timeout: 300_000 }, async () => {
    const judge = judgeStep(modelClientFromEnv(process.env, new DefaultAzureCredential()));
    const input = {
      postings: [BACKEND, CITIZENS, DATA],
      resumes: RESUMES.variants,
      profile: CONFIG.profile,
    };
    const repairs: RepairTurn[] = [];
    let judged: Judgement[] = [];
    let problems: string[] = [];
    // The same loop as judge ⇄ verify_judgements in the graph.
    for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
      judged = (await judge(input, repairs)).value;
      problems = verifyJudgements(judged, RESUMES);
      console.log(`attempt ${attempt + 1}: ${problems.length} problems`);
      for (const p of problems) console.log(`  ${p}`);
      if (problems.length === 0) break;
      repairs.push({ previous: judged, problems });
    }
    const ranked = rank(judged, CONFIG);
    for (const r of [...ranked.top, ...ranked.rest]) {
      console.log(
        `${r.posting.title}: ${r.score} via ${r.variant}${r.either ? ` (either ${r.either})` : ""}, ${r.confidence}`,
        r.scores,
      );
      const v = r.judgement.answer.variants.find((x) => x.variant === r.variant);
      console.log(`  evidence: ${v?.skills.evidence}`);
      console.log(
        `  gaps: ${[v?.skills.gap, v?.domain.gap, v?.seniority.gap].filter(Boolean).join("; ")}`,
      );
    }
    for (const f of ranked.filtered)
      console.log(`filtered ${f.posting.title}: ${f.gate}: ${f.reason}`);

    expect(problems).toEqual([]);
    expect(ranked.filtered.map((f) => [f.posting.title, f.gate])).toEqual([
      ["Software Engineer", "sponsorship"],
    ]);
    const best = Object.fromEntries(ranked.top.map((r) => [r.posting.title, r.variant]));
    expect(best).toEqual({ "Backend Engineer, Payments": "Backend", "Data Engineer": "Data" });
  });
});
