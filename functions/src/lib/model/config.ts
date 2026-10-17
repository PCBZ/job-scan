// Choose the model from app settings, so switching providers is configuration.
//
//   MODEL_PROVIDER     azure-openai | openai-compatible
//   MODEL_ENDPOINT     Azure resource endpoint, or the API base URL
//   MODEL_NAME         deployment name on Azure, model id elsewhere
//   MODEL_API_KEY      openai-compatible only; Azure uses Entra ID
//   MODEL_API_VERSION  azure-openai only (default below)
//
//   MODEL_TPM          the deployment's tokens per minute; calls are paced to
//                      it (rate-limit.ts). Unset or 0: no pacing.
//
// The same keys prefixed MODEL_FALLBACK_ configure an optional fallback, which
// is paced to its own MODEL_FALLBACK_TPM. MODEL_MAX_RETRIES and
// MODEL_TIMEOUT_MS apply to both.
//
// MODEL_EXTRACT_NAME gives extraction its own deployment (#148), paced to
// MODEL_EXTRACT_TPM; its other MODEL_EXTRACT_ keys default to the MODEL_ ones.

import { getBearerTokenProvider, type TokenCredential } from "@azure/identity";
import OpenAI, { AzureOpenAI } from "openai";
import { type AppError, appError } from "../errors.js";
import { FallbackClient } from "./fallback.js";
import { OpenAIChatClient } from "./openai-chat.js";
import { RateLimitedClient } from "./rate-limit.js";
import type { ModelClient } from "./types.js";

export const DEFAULT_AZURE_API_VERSION = "2024-10-21";
const AZURE_SCOPE = "https://cognitiveservices.azure.com/.default";

type Env = Record<string, string | undefined>;

function required(env: Env, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw appError("config", `${key} is not set`);
  return value;
}

function positiveInt(env: Env, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0)
    throw appError("config", `${key} must be a whole number, got "${raw}"`);
  return n;
}

export interface ModelClientOptions {
  /** Told why the fallback was used, for the run's warnings. */
  onFallback?: (err: AppError<"model_provider">) => void;
  /** Told how long a call waited for the TPM budget, for the run's summary. */
  onThrottle?: (ms: number) => void;
  /**
   * Told of every 429 the provider answers, the SDK's own retries included:
   * pacing should keep this at zero (#99).
   */
  onRateLimited?: () => void;
  /** For tests: the HTTP layer the SDK uses. */
  fetch?: typeof fetch;
}

/** The SDK's HTTP layer, counting 429s when asked to. */
function httpLayer(options: ModelClientOptions): typeof fetch | undefined {
  const { onRateLimited } = options;
  if (!onRateLimited) return options.fetch;
  const base = options.fetch ?? globalThis.fetch;
  return (async (...args: Parameters<typeof fetch>) => {
    const response = await base(...args);
    if (response.status === 429) onRateLimited();
    return response;
  }) as typeof fetch;
}

/** The slot's client, paced to its TPM when one is set. */
function paced(client: ModelClient, env: Env, prefix: string, options: ModelClientOptions) {
  const tpm = positiveInt(env, `${prefix}_TPM`, 0);
  return tpm > 0 ? new RateLimitedClient(client, tpm, options.onThrottle) : client;
}

function slot(
  env: Env,
  prefix: string,
  label: string,
  credential: TokenCredential,
  options: ModelClientOptions,
): ModelClient {
  const provider = required(env, `${prefix}_PROVIDER`);
  const maxRetries = positiveInt(env, "MODEL_MAX_RETRIES", 3);
  const timeout = positiveInt(env, "MODEL_TIMEOUT_MS", 60_000);
  const name = required(env, `${prefix}_NAME`);
  const http = httpLayer(options);
  switch (provider) {
    case "azure-openai": {
      const bearer = getBearerTokenProvider(credential, AZURE_SCOPE);
      const client = new AzureOpenAI({
        endpoint: required(env, `${prefix}_ENDPOINT`),
        deployment: name,
        apiVersion: env[`${prefix}_API_VERSION`]?.trim() || DEFAULT_AZURE_API_VERSION,
        azureADTokenProvider: bearer,
        maxRetries,
        timeout,
        ...(http ? { fetch: http } : {}),
      });
      return new OpenAIChatClient(client.chat.completions, name, label);
    }
    case "openai-compatible": {
      const client = new OpenAI({
        baseURL: required(env, `${prefix}_ENDPOINT`),
        apiKey: required(env, `${prefix}_API_KEY`),
        maxRetries,
        timeout,
        ...(http ? { fetch: http } : {}),
      });
      return new OpenAIChatClient(client.chat.completions, name, label);
    }
    default:
      throw appError(
        "config",
        `${prefix}_PROVIDER "${provider}" is not supported; use azure-openai or openai-compatible`,
      );
  }
}

/** The configured model, wrapped in a fallback when MODEL_FALLBACK_PROVIDER is set. */
export function modelClientFromEnv(
  env: Env,
  credential: TokenCredential,
  options: ModelClientOptions = {},
): ModelClient {
  const primary = paced(slot(env, "MODEL", "primary", credential, options), env, "MODEL", options);
  if (!env.MODEL_FALLBACK_PROVIDER?.trim()) return primary;
  const fallback = paced(
    slot(env, "MODEL_FALLBACK", "fallback", credential, options),
    env,
    "MODEL_FALLBACK",
    options,
  );
  return new FallbackClient(primary, fallback, options.onFallback);
}

/** The keys an extract slot takes from the main one unless it sets its own. */
const SHARED_KEYS = ["PROVIDER", "ENDPOINT", "API_VERSION", "API_KEY"];

/**
 * The client extraction calls (#148): its own deployment when
 * MODEL_EXTRACT_NAME is set, otherwise `main` itself.
 */
export function extractClientFromEnv(
  env: Env,
  credential: TokenCredential,
  main: ModelClient,
  options: ModelClientOptions = {},
): ModelClient {
  if (!env.MODEL_EXTRACT_NAME?.trim()) return main;
  const merged: Env = { ...env };
  for (const key of SHARED_KEYS) {
    if (!env[`MODEL_EXTRACT_${key}`]?.trim()) merged[`MODEL_EXTRACT_${key}`] = env[`MODEL_${key}`];
  }
  return paced(
    slot(merged, "MODEL_EXTRACT", "extract", credential, options),
    merged,
    "MODEL_EXTRACT",
    options,
  );
}

/** The model behind each Azure OpenAI node, so the evaluation prices it (#148). */
export function modelNames(env: Env): Record<string, string> {
  const main = env.MODEL_NAME?.trim() ?? "";
  return {
    extract_postings: env.MODEL_EXTRACT_NAME?.trim() || main,
    judge: main,
    explain: main,
  };
}
