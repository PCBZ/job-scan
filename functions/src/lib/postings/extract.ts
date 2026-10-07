// The extract_postings node: one model call per alert message, so a repair
// goes back only to the messages whose rows failed validation, each with its
// own earlier answers and problems.

import type { FetchedMessage } from "../mail/types.js";
import {
  type ModelClient,
  ModelOutputError,
  type RepairTurn,
  type TokenUsage,
} from "../model/types.js";
import { mapWithLimit } from "../workflow/limit.js";
import type { ModelSteps } from "../workflow/types.js";
import { EXTRACT_SYSTEM, extractUser } from "./prompt.js";
import { type ExtractedPosting, extractedPosting, extractedPostings } from "./schema.js";
import { sourceOf } from "./source.js";
import type { Posting } from "./types.js";
import { problemsFor } from "./validate.js";

export interface ExtractOptions {
  /** Messages in flight at once. */
  concurrency?: number;
}

export function extractStep(
  client: ModelClient,
  options: ExtractOptions = {},
): ModelSteps["extractPostings"] {
  const concurrency = options.concurrency ?? 4;
  return async ({ messages }, repairs, signal) => {
    const last = repairs.at(-1);
    const usage: TokenUsage = { input: 0, output: 0 };
    const warnings: string[] = [];

    const perMessage = await mapWithLimit(messages, concurrency, async (m) => {
      const kept = rowsOf(last?.previous, m.message_id);
      // On a repair, a message whose rows all passed keeps them as they are.
      if (last && problemsFor(last.problems, m.message_id).length === 0) return kept;
      try {
        const r = await client.structured({
          name: "postings",
          system: EXTRACT_SYSTEM,
          user: extractUser(m),
          schema: extractedPostings,
          repairs: historyOf(repairs, m.message_id),
          ...(signal ? { signal } : {}),
        });
        usage.input += r.usage.input;
        usage.output += r.usage.output;
        return r.value.postings.map((e, row) => toPosting(e, m, row));
      } catch (err) {
        // One unusable answer costs that message's rows, not the run. A
        // provider failure still fails the run, so the mail is retried tomorrow.
        if (!(err instanceof ModelOutputError)) throw err;
        warnings.push(`extract_postings: message ${m.message_id}: ${err.message}`);
        return kept;
      }
    });

    return { value: perMessage.flat(), usage, warnings };
  };
}

function rowsOf(previous: unknown, messageId: string): Posting[] {
  return ((previous ?? []) as Posting[]).filter((p) => p.message_id === messageId);
}

/** A row as the model answered it: zod drops the fields code added. */
const asAnswer = (p: Posting): ExtractedPosting => extractedPosting.parse(p);

/** This message's own repair turns: its earlier answers and their problems. */
function historyOf(repairs: RepairTurn[], messageId: string): RepairTurn[] {
  return repairs
    .map((t) => ({
      previous: { postings: rowsOf(t.previous, messageId).map(asAnswer) },
      problems: problemsFor(t.problems, messageId),
    }))
    .filter((t) => t.problems.length > 0);
}

function toPosting(e: ExtractedPosting, m: FetchedMessage, row: number): Posting {
  return {
    ...e,
    title: e.title.trim(),
    company: e.company.trim(),
    location: e.location.trim(),
    skills: uniqueSkills(e.skills),
    url: (e.link === null ? undefined : m.links[e.link]?.url) ?? "",
    source: sourceOf(m.from),
    account: m.account,
    message_id: m.message_id,
    message_subject: m.subject,
    row,
  };
}

/** Trimmed, without blanks, and each skill once, ignoring case; first spelling wins. */
function uniqueSkills(skills: string[]): string[] {
  const trimmed = skills.map((s) => s.trim()).filter(Boolean);
  return trimmed.filter(
    (s, i) => trimmed.findIndex((t) => t.toLowerCase() === s.toLowerCase()) === i,
  );
}
