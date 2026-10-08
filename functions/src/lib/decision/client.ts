// DecisionClient over TypeSafe's System One API: one state and named, typed
// questions in; one typed answer per question out, through the official SDK.
// Jev makes bounded judgements (gates, scores, choices); it writes no text.
// Retries with backoff are the SDK's own (408, 429 and 5xx, honouring
// retry-after); this layer only normalises usage and sorts the failures.

import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
  type EntryType,
  type Questions,
  type SystemOneResult,
  type TypeSafeClient,
  TypeSafeError,
} from "@typesafe-ai/sdk";
import type { TokenUsage } from "../model/types.js";

export { choice, noul, score } from "@typesafe-ai/sdk";

export interface DecisionRequest<Q extends Questions> {
  /** What the questions are about: text, or a JSON object or array. */
  state: EntryType;
  /** Questions keyed by the names their answers come back under. */
  questions: Q;
  signal?: AbortSignal;
}

export interface DecisionResult<Q extends Questions> {
  answers: SystemOneResult<Q>["answers"];
  usage: TokenUsage;
  /** The versioned model that answered, e.g. "jev-1.13.0". */
  model: string;
}

/** Statuses the SDK retries; still failing after that is the provider's problem. */
const TRANSIENT = (status: number) => status === 408 || status === 429 || status >= 500;

/**
 * The provider failed after the SDK's retries: rate limit, overload, 5xx,
 * timeout or network. A later run may succeed.
 */
export class DecisionProviderError extends Error {
  override name = "DecisionProviderError";
  constructor(
    message: string,
    readonly status: number | undefined,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * The request itself is wrong: a bad key, a malformed question, a validation
 * error. Retrying won't help; the code or the configuration must change.
 */
export class DecisionRequestError extends Error {
  override name = "DecisionRequestError";
  constructor(
    message: string,
    readonly status: number | undefined,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class DecisionClient {
  constructor(private readonly client: Pick<TypeSafeClient, "systemOne">) {}

  async ask<const Q extends Questions>(req: DecisionRequest<Q>): Promise<DecisionResult<Q>> {
    try {
      const r = await this.client.systemOne(
        { state: req.state, questions: req.questions },
        req.signal ? { signal: req.signal } : {},
      );
      return {
        answers: r.answers,
        usage: { input: r.usage.input_tokens, output: r.usage.output_tokens },
        model: r.model,
      };
    } catch (err) {
      throw classify(err);
    }
  }
}

function classify(err: unknown): unknown {
  // A cancelled run is not a provider failure: pass it through untouched.
  if (err instanceof APIUserAbortError) return err;
  if (err instanceof APIError) {
    const message = `jev: ${err.message}`.slice(0, 300);
    return TRANSIENT(err.status)
      ? new DecisionProviderError(message, err.status, { cause: err })
      : new DecisionRequestError(message, err.status, { cause: err });
  }
  // Includes timeouts, which the SDK reports as connection errors.
  if (err instanceof APIConnectionError) {
    return new DecisionProviderError(`jev: ${err.message}`, undefined, { cause: err });
  }
  // The SDK's own checks before sending, e.g. empty questions.
  if (err instanceof TypeSafeError) {
    return new DecisionRequestError(`jev: ${err.message}`, undefined, { cause: err });
  }
  return err;
}
