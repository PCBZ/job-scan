// A job posting as the pipeline carries it: what the model read, plus where it
// came from. Field names follow the local skill's /tmp/jobs.json (SKILL.md
// step 3), so both runs can be compared.

import type { ExtractedPosting } from "./schema.js";

export type Workplace = ExtractedPosting["workplace"];
export type Source = "linkedin" | "indeed" | "glassdoor" | "other";

/** Filled in by code from the message, never by the model. */
export interface Provenance {
  url: string;
  source: Source;
  account: string;
  message_id: string;
  message_subject: string;
  /** Position of this row in the model's answer for its message. */
  row: number;
  /** Gate questions code couldn't settle, for Jev in judge (#17). */
  gate_questions?: string[];
}

export type Posting = ExtractedPosting & Provenance;
