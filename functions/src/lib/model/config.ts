// Choose the model from app settings, so switching providers is configuration.
//
//   MODEL_PROVIDER     azure-openai | openai-compatible
//   MODEL_ENDPOINT     Azure resource endpoint, or the API base URL
//   MODEL_NAME         deployment name on Azure, model id elsewhere
//   MODEL_API_KEY      openai-compatible only; Azure uses Entra ID
//   MODEL_API_VERSION  azure-openai only (default below)
//
// The same keys prefixed MODEL_FALLBACK_ configure an optional fallback.
// MODEL_MAX_RETRIES and MODEL_TIMEOUT_MS apply to both.

import { getBearerTokenProvider, type TokenCredential } from "@azure/identity";
import OpenAI, { AzureOpenAI } from "openai";
import { FallbackClient } from "./fallback.js";
import { OpenAIChatClient } from "./openai-chat.js";
import type { ModelClient, ModelProviderError } from "./types.js";

export const DEFAULT_AZURE_API_VERSION = "2024-10-21";
const AZURE_SCOPE = "https://cognitiveservices.azure.com/.default";

type Env = Record<string, string | undefined>;

export class ModelConfigError extends Error {
  override name = "ModelConfigError";
}

function required(env: Env, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new ModelConfigError(`${key} is not set`);
  return value;
}

function positiveInt(env: Env, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0)
    throw new ModelConfigError(`${key} must be a whole number, got "${raw}"`);
  return n;
}

export interface ModelClientOptions {
  /** Told why the fallback was used, for the run's warnings. */
  onFallback?: (err: ModelProviderError) => void;
  /** For tests: the HTTP layer the SDK uses. */
  fetch?: typeof fetch;
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
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      return new OpenAIChatClient(client.chat.completions, name, label);
    }
    case "openai-compatible": {
      const client = new OpenAI({
        baseURL: required(env, `${prefix}_ENDPOINT`),
        apiKey: required(env, `${prefix}_API_KEY`),
        maxRetries,
        timeout,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      return new OpenAIChatClient(client.chat.completions, name, label);
    }
    default:
      throw new ModelConfigError(
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
  const primary = slot(env, "MODEL", "primary", credential, options);
  if (!env.MODEL_FALLBACK_PROVIDER?.trim()) return primary;
  const fallback = slot(env, "MODEL_FALLBACK", "fallback", credential, options);
  return new FallbackClient(primary, fallback, options.onFallback);
}
