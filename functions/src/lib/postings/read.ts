// Reading a scraped posting (#203): a source that scrapes hands its rows over
// unread, with the description beside the board's own fields. collect reads
// only the rows left after the title and location gates, one model call each,
// so a row screened out never costs an extraction.

import { readFileSync } from "node:fs";
import type { z } from "zod";
import { isAppError } from "../errors.js";
import { addUsage, type ModelClient, type TokenUsage } from "../model/types.js";
import { mapWithLimit } from "../workflow/limit.js";
import type { ModelSteps } from "../workflow/types.js";
import { extractedPosting } from "./schema.js";
import type { Posting } from "./types.js";

/** The system prompt, kept as prose in prompts/read.md. */
export const READ_SYSTEM = readFileSync(
  // Three levels up from both src/lib/postings and dist/lib/postings.
  new URL("../../../prompts/read.md", import.meta.url),
  "utf8",
).trimEnd();

/** A long description is cut here, so one posting can't dominate the day's tokens. */
export const MAX_DESCRIPTION_CHARS = 6000;

/** What the model reads from the description; the other fields are the board's. */
export const readAnswer = extractedPosting.pick({
  workplace: true,
  salary: true,
  requirements: true,
  skills: true,
});

export type ReadAnswer = z.infer<typeof readAnswer>;

/** The posting as the model sees it: the fields it needs, the description capped. */
export function readUser(p: Posting): string {
  return JSON.stringify({
    title: p.title,
    company: p.company,
    location: p.location,
    workplace: p.workplace,
    salary: p.salary,
    description: (p.description ?? "").slice(0, MAX_DESCRIPTION_CHARS),
  });
}

/** The posting with what was read, and without its description. */
function withAnswer(p: Posting, answer: ReadAnswer | null): Posting {
  const { description: _, ...rest } = p;
  return answer ? { ...rest, ...answer } : rest;
}

export interface ReadOptions {
  /** Postings in flight at once. */
  concurrency?: number;
}

/**
 * Reads each posting's description. A call that fails keeps the posting with
 * what the board said and no requirements, which judge treats as thin: one
 * row, or a provider outage, mustn't cost the day's report.
 */
export function readStep(
  client: ModelClient,
  options: ReadOptions = {},
): ModelSteps["readPostings"] {
  const concurrency = options.concurrency ?? 4;
  return async ({ postings }, signal) => {
    let usage: TokenUsage = { input: 0, output: 0 };
    let unread = 0;
    let failure = "";
    const value = await mapWithLimit(postings, concurrency, async (p) => {
      try {
        const r = await client.structured({
          name: "posting",
          system: READ_SYSTEM,
          user: readUser(p),
          schema: readAnswer,
          ...(signal ? { signal } : {}),
        });
        usage = addUsage(usage, r.usage);
        return withAnswer(p, r.value);
      } catch (err) {
        if (!isAppError(err, "model_output") && !isAppError(err, "model_provider")) throw err;
        unread++;
        failure = err.message;
        return withAnswer(p, null);
      }
    });
    const warnings = unread
      ? [`extract_postings: ${unread} of ${postings.length} scraped posting(s) unread: ${failure}`]
      : [];
    return { value, usage, warnings };
  };
}
