// The one model call the pipeline makes: a system and user prompt in, a value
// matching a zod schema out. extract / gate / score / explain build on this.

import type { ZodType } from "zod";

/**
 * One round of a check-and-retry loop: what the model returned last time and
 * what the code check found wrong with it.
 */
export interface RepairTurn {
  previous: unknown;
  problems: string[];
}

export interface StructuredRequest<T> {
  /** Names the schema for the provider, e.g. "postings". */
  name: string;
  system: string;
  user: string;
  schema: ZodType<T>;
  /** Earlier attempts and their problems, oldest first. */
  repairs?: RepairTurn[];
  /** Cancels the call when the run is cancelled; an abort never falls back. */
  signal?: AbortSignal;
}

export interface TokenUsage {
  input: number;
  output: number;
}

export interface StructuredResult<T> {
  value: T;
  usage: TokenUsage;
  /** Which configured model answered: "primary" or "fallback". */
  served_by: string;
}

export interface ModelClient {
  structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
}
