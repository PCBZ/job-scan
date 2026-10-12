// Pace model calls to the deployment's tokens-per-minute (#93). Azure answers
// 429 once a minute's tokens are spent, and a backlog run spends them in
// seconds; waiting here turns that failure into a slower run.
//
// A token bucket (limiter's TokenBucket) holding a minute's budget, refilled
// at the budget per minute. A call takes its estimated tokens before it goes,
// waiting while the bucket is short; limiter queues waiters in arrival order,
// so concurrent calls can't overshoot together. When the call returns, what
// the estimate overstated goes back in.

import { TokenBucket } from "limiter";
import { toJSONSchema } from "zod";
import type { ModelClient, StructuredRequest, StructuredResult } from "./types.js";

/** The share of the TPM the limiter spends: estimates are rough, so leave room. */
export const BUDGET_SHARE = 0.8;

/** English text and JSON run about four characters a token. */
const CHARS_PER_TOKEN = 4;

/**
 * Output isn't known before the call, and requests set no output cap. Reserve
 * a quarter of the input, at least 500: extraction answered with ~21% of its
 * input on 2026-10-12.
 */
const OUTPUT_SHARE = 0.25;
const OUTPUT_MIN = 500;

/** Tokens a call is expected to use: its whole prompt, plus room for the answer. */
export function estimateTokens<T>(req: StructuredRequest<T>): number {
  const prompt =
    req.system.length +
    req.user.length +
    JSON.stringify(req.repairs ?? []).length +
    JSON.stringify(toJSONSchema(req.schema)).length;
  const input = Math.ceil(prompt / CHARS_PER_TOKEN);
  return input + Math.max(OUTPUT_MIN, Math.ceil(input * OUTPUT_SHARE));
}

/**
 * Rejects when `signal` aborts. limiter's waits can't be cancelled themselves,
 * so the queued removal still happens later; only an ended run aborts, so
 * nothing is left to wait on it.
 */
function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

export class RateLimitedClient implements ModelClient {
  private readonly bucket: TokenBucket;

  constructor(
    private readonly inner: ModelClient,
    tokensPerMinute: number,
    /** Told how long each call waited, for the run's summary. */
    private readonly onThrottle: (ms: number) => void = () => {},
  ) {
    const budget = Math.max(1, Math.floor(tokensPerMinute * BUDGET_SHARE));
    this.bucket = new TokenBucket({
      bucketSize: budget,
      tokensPerInterval: budget,
      interval: "minute",
    });
    // limiter starts a bucket empty; a run starts with a full minute's budget.
    this.bucket.content = budget;
  }

  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    // A call bigger than the whole budget takes the whole bucket and goes alone:
    // limiter rejects a count above the bucket size.
    const taken = Math.min(estimateTokens(req), this.bucket.bucketSize);
    const started = performance.now();
    await abortable(this.bucket.removeTokens(taken), req.signal);
    const waited = performance.now() - started;
    if (waited >= 1) this.onThrottle(waited);

    const result = await this.inner.structured(req);
    // Settle to what the call really used: give back an overestimate, take an
    // underestimate (the bucket may go below zero; the next call then waits
    // longer). A failed call keeps what it took.
    const used = result.usage.input + result.usage.output;
    this.bucket.content = Math.min(this.bucket.bucketSize, this.bucket.content + taken - used);
    return result;
  }
}
