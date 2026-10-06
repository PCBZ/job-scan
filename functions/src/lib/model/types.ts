// The one model call the pipeline makes: a system and user prompt in, a value
// matching a zod schema out. extract / gate / score / explain build on this.

import type { ZodType } from "zod";

export interface StructuredRequest<T> {
  /** Names the schema for the provider, e.g. "postings". */
  name: string;
  system: string;
  user: string;
  schema: ZodType<T>;
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

/**
 * The provider failed after its own retries (rate limit, 5xx, timeout,
 * network, auth). Another provider might succeed, so a fallback may take it.
 */
export class ModelProviderError extends Error {
  override name = "ModelProviderError";
  constructor(
    message: string,
    readonly status: number | undefined,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * The model answered, but not usably: a refusal, truncation, a content
 * filter, or output that fails the schema. Asking another provider would hide
 * a prompt or schema problem, so these are never passed to a fallback.
 */
export class ModelOutputError extends Error {
  override name = "ModelOutputError";
}
