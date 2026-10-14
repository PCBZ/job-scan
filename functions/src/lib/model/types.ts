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
  /**
   * Of the input, tokens Azure served from its prompt cache (#115), billed at
   * a tenth of the input price. Absent when the provider doesn't say.
   */
  cached?: number;
}

/** Two usages summed; cached is kept when either side reports it. */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const sum = { input: a.input + b.input, output: a.output + b.output };
  if (a.cached === undefined && b.cached === undefined) return sum;
  return { ...sum, cached: (a.cached ?? 0) + (b.cached ?? 0) };
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
