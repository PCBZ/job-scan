// The decision client from app settings.
//
//   TYPESAFE_API_KEY  the account key; in Azure a Key Vault reference
//   JEV_MODEL         a versioned model id; pinned, because thresholds are
//                     tuned against one version and an alias moves on release
//   JEV_TIMEOUT_MS    per attempt (default 10000, the SDK's)
//   JEV_MAX_RETRIES   after the first attempt (default 2, the SDK's)

import { TypeSafeClient } from "@typesafe-ai/sdk";
import { DecisionClient } from "./client.js";

export const DEFAULT_JEV_MODEL = "jev-1.13.0";

type Env = Record<string, string | undefined>;

export class DecisionConfigError extends Error {
  override name = "DecisionConfigError";
}

function wholeNumber(env: Env, key: string, fallback: number, min: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new DecisionConfigError(`${key} must be a whole number of at least ${min}, got "${raw}"`);
  }
  return n;
}

export interface DecisionClientOptions {
  /** For tests: the HTTP layer the SDK uses. */
  fetch?: typeof fetch;
}

export function decisionClientFromEnv(
  env: Env,
  options: DecisionClientOptions = {},
): DecisionClient {
  const apiKey = env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) throw new DecisionConfigError("TYPESAFE_API_KEY is not set");
  // Every setting is passed explicitly, so the SDK's own TYPESAFE_* lookups
  // and defaults never decide which model answers.
  return new DecisionClient(
    new TypeSafeClient({
      apiKey,
      defaultModel: env.JEV_MODEL?.trim() || DEFAULT_JEV_MODEL,
      timeout: wholeNumber(env, "JEV_TIMEOUT_MS", 10_000, 1),
      retry: { maxRetries: wholeNumber(env, "JEV_MAX_RETRIES", 2, 0) },
      logLevel: "warn",
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
  );
}
