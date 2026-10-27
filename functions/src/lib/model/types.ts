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
  /**
   * The start of `user` that every call of this kind shares. A model that
   * caches explicitly (#160) is told the prompt is reusable up to its end;
   * others ignore it.
   */
  sharedPrefix?: string;
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
  /**
   * The models that answered, as the provider names them with their version,
   * e.g. "gpt-5.4-nano-2026-03-17" (#148): a deployment that follows the
   * default version shows here when it moves. Absent when it doesn't say.
   */
  models?: string[];
}

/** Two usages summed; cached is kept when either side reports it. */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const sum: TokenUsage = { input: a.input + b.input, output: a.output + b.output };
  if (a.cached !== undefined || b.cached !== undefined)
    sum.cached = (a.cached ?? 0) + (b.cached ?? 0);
  if (a.models || b.models)
    sum.models = [...new Set([...(a.models ?? []), ...(b.models ?? [])])].sort();
  return sum;
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
