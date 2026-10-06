// Live extraction against the deployed model, on the synthetic fixtures.
// Skipped unless EVAL_LIVE=1. Signs in with DefaultAzureCredential, so the
// operator's `az login` (Terraform grants it Cognitive Services OpenAI User):
//
//   export MODEL_PROVIDER=azure-openai
//   export MODEL_ENDPOINT=$(terraform -chdir=../infra output -raw openai_endpoint)
//   export MODEL_NAME=$(terraform -chdir=../infra output -raw openai_deployment)
//   npm run eval:extract

import { DefaultAzureCredential } from "@azure/identity";
import { describe, expect, it } from "vitest";
import { modelClientFromEnv } from "../../src/lib/model/config.js";
import type { RepairTurn } from "../../src/lib/model/types.js";
import { extractStep } from "../../src/lib/postings/extract.js";
import type { Posting } from "../../src/lib/postings/types.js";
import { validatePostings } from "../../src/lib/postings/validate.js";
import { fixture, VENDORS } from "../postings/fixtures.js";

const MAX_REPAIRS = 2;

describe.skipIf(!process.env.EVAL_LIVE)("extraction, live", () => {
  // Built on first use: a skipped suite still runs this body to collect tests.
  let step: ReturnType<typeof extractStep> | undefined;
  const extract = () => {
    step ??= extractStep(modelClientFromEnv(process.env, new DefaultAzureCredential()));
    return step;
  };

  it.each(VENDORS)(
    "%s: every row aligned, nothing missing",
    { timeout: 180_000 },
    async (vendor) => {
      const { message, expected } = fixture(vendor);
      const repairs: RepairTurn[] = [];
      let rows: Posting[] = [];
      let problems: string[] = [];
      // The same loop as extract_postings ⇄ validate in the graph.
      for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
        rows = (await extract()({ messages: [message] }, repairs)).value;
        problems = validatePostings(rows).problems;
        console.log(
          `${vendor} attempt ${attempt + 1}: ${rows.length} rows, ${problems.length} problems`,
        );
        for (const p of problems) console.log(`  ${p}`);
        if (problems.length === 0) break;
        repairs.push({ previous: rows, problems });
      }
      for (const r of rows) {
        console.log(
          `  ${r.title} | ${r.company} | ${r.location} | ${r.salary} | ${r.workplace} | link ${r.link}`,
        );
      }

      expect(problems).toEqual([]);
      expect(rows.map((r) => [r.title, r.company, r.link])).toEqual(
        expected.map((e) => [e.title, e.company, e.link]),
      );
      expect(rows.map((r) => r.location)).toEqual(expected.map((e) => e.location));
      expect(rows.map((r) => r.salary)).toEqual(expected.map((e) => e.salary));
    },
  );
});
