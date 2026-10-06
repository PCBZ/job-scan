import type { TokenCredential } from "@azure/identity";
import { APIUserAbortError } from "openai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ModelConfigError, modelClientFromEnv } from "../../src/lib/model/config.js";
import { FallbackClient } from "../../src/lib/model/fallback.js";
import { OpenAIChatClient } from "../../src/lib/model/openai-chat.js";

const credential: TokenCredential = {
  getToken: async () => ({ token: "entra-token", expiresOnTimestamp: Date.now() + 3_600_000 }),
};
const AZURE = {
  MODEL_PROVIDER: "azure-openai",
  MODEL_ENDPOINT: "https://example.openai.azure.com/",
  MODEL_NAME: "gpt-5.4-mini",
};
const COMPATIBLE = {
  MODEL_PROVIDER: "openai-compatible",
  MODEL_ENDPOINT: "https://llm.example/v1",
  MODEL_NAME: "some-model",
  MODEL_API_KEY: "test-key",
};

function okBody(content: unknown) {
  return JSON.stringify({
    id: "c1",
    object: "chat.completion",
    created: 0,
    model: "m",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: JSON.stringify(content), refusal: null },
      },
    ],
    usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
  });
}

describe("modelClientFromEnv", () => {
  it("builds the configured provider, with a fallback only when one is set", () => {
    expect(modelClientFromEnv(AZURE, credential)).toBeInstanceOf(OpenAIChatClient);
    expect(modelClientFromEnv(COMPATIBLE, credential)).toBeInstanceOf(OpenAIChatClient);
    const both = modelClientFromEnv(
      {
        ...AZURE,
        MODEL_FALLBACK_PROVIDER: "openai-compatible",
        MODEL_FALLBACK_ENDPOINT: "https://llm.example/v1",
        MODEL_FALLBACK_NAME: "some-model",
        MODEL_FALLBACK_API_KEY: "test-key",
      },
      credential,
    );
    expect(both).toBeInstanceOf(FallbackClient);
  });

  it.each([
    [{}, "MODEL_PROVIDER is not set"],
    [{ ...AZURE, MODEL_ENDPOINT: "" }, "MODEL_ENDPOINT is not set"],
    [{ ...COMPATIBLE, MODEL_API_KEY: undefined }, "MODEL_API_KEY is not set"],
    [{ ...AZURE, MODEL_PROVIDER: "anthropic" }, 'MODEL_PROVIDER "anthropic" is not supported'],
    [
      { ...AZURE, MODEL_MAX_RETRIES: "three" },
      'MODEL_MAX_RETRIES must be a whole number, got "three"',
    ],
    [{ ...AZURE, MODEL_FALLBACK_PROVIDER: "openai-compatible" }, "MODEL_FALLBACK_NAME is not set"],
  ])("rejects %j", (env, message) => {
    expect(() => modelClientFromEnv(env as Record<string, string>, credential)).toThrow(
      ModelConfigError,
    );
    expect(() => modelClientFromEnv(env as Record<string, string>, credential)).toThrow(message);
  });

  it("retries a 429 through the real SDK, then parses the structured answer", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    let n = 0;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      n++;
      if (n === 1) {
        return new Response(JSON.stringify({ error: { message: "slow down" } }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after-ms": "1" },
        });
      }
      return new Response(okBody({ title: "Engineer" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const model = modelClientFromEnv({ ...AZURE, MODEL_MAX_RETRIES: "2" }, credential, {
      fetch: fakeFetch,
    });
    const out = await model.structured({
      name: "posting",
      system: "Extract.",
      user: "Engineer",
      schema: z.object({ title: z.string() }),
    });
    expect(out).toEqual({
      value: { title: "Engineer" },
      usage: { input: 50, output: 10 },
      served_by: "primary",
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]?.url).toContain(
      "/openai/deployments/gpt-5.4-mini/chat/completions?api-version=2024-10-21",
    );
    expect(seen[0]?.auth).toBe("Bearer entra-token");
  });

  it("gives up after MODEL_MAX_RETRIES and reports a provider error", async () => {
    let n = 0;
    const alwaysBusy = (async () => {
      n++;
      return new Response(JSON.stringify({ error: { message: "overloaded" } }), {
        status: 503,
        headers: { "content-type": "application/json", "retry-after-ms": "1" },
      });
    }) as typeof fetch;
    const model = modelClientFromEnv({ ...COMPATIBLE, MODEL_MAX_RETRIES: "1" }, credential, {
      fetch: alwaysBusy,
    });
    await expect(
      model.structured({
        name: "x",
        system: "s",
        user: "u",
        schema: z.object({ ok: z.boolean() }),
      }),
    ).rejects.toMatchObject({ name: "ModelProviderError", status: 503 });
    expect(n).toBe(2);
  });

  it("stops an aborted call through the real SDK without retrying it", async () => {
    let n = 0;
    const neverCalled = (async () => {
      n++;
      return new Response(okBody({ title: "x" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const controller = new AbortController();
    controller.abort();
    const model = modelClientFromEnv({ ...AZURE, MODEL_MAX_RETRIES: "3" }, credential, {
      fetch: neverCalled,
    });
    await expect(
      model.structured({
        name: "posting",
        system: "s",
        user: "u",
        schema: z.object({ title: z.string() }),
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(APIUserAbortError);
    expect(n).toBe(0);
  });
});
