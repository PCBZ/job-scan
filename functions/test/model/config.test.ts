import type { TokenCredential } from "@azure/identity";
import { APIUserAbortError } from "openai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  extractClientFromEnv,
  modelClientFromEnv,
  nodeModels,
} from "../../src/lib/model/config.js";
import { FallbackClient } from "../../src/lib/model/fallback.js";
import { OpenAIChatClient } from "../../src/lib/model/openai-chat.js";
import { RateLimitedClient } from "../../src/lib/model/rate-limit.js";

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
      expect.objectContaining({ code: "config" }),
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
      // The version that answered, as the provider names it (#148).
      usage: { input: 50, output: 10, models: ["m"] },
      served_by: "primary",
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]?.url).toContain(
      "/openai/deployments/gpt-5.4-mini/chat/completions?api-version=2024-10-21",
    );
    expect(seen[0]?.auth).toBe("Bearer entra-token");
  });

  it("sends the main slot's reasoning effort, and never to the extract slot (#156)", async () => {
    const bodies: Record<string, unknown>[] = [];
    const recording = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(okBody({ title: "Engineer" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const env = {
      ...AZURE,
      MODEL_REASONING_EFFORT: "minimal",
      MODEL_EXTRACT_NAME: "gpt-5.4-nano",
    };
    const request = {
      name: "posting",
      system: "Extract.",
      user: "Engineer",
      schema: z.object({ title: z.string() }),
    };
    const main = modelClientFromEnv(env, credential, { fetch: recording });
    await main.structured(request);
    await extractClientFromEnv(env, credential, main, { fetch: recording }).structured(request);
    expect(bodies[0]).toMatchObject({ reasoning_effort: "minimal" });
    expect(bodies[1]).not.toHaveProperty("reasoning_effort");
  });

  it("counts every 429, the SDK's own retries included", async () => {
    let n = 0;
    const busyTwice = (async () => {
      n++;
      if (n <= 2) {
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
    let limited = 0;
    const model = modelClientFromEnv({ ...AZURE, MODEL_MAX_RETRIES: "3" }, credential, {
      fetch: busyTwice,
      onRateLimited: () => limited++,
    });
    await model.structured({
      name: "posting",
      system: "Extract.",
      user: "Engineer",
      schema: z.object({ title: z.string() }),
    });
    expect(limited).toBe(2);
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
    ).rejects.toMatchObject({ code: "model_provider", status: 503 });
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

describe("extractClientFromEnv (#148)", () => {
  const schema = z.object({ title: z.string() });
  const ask = (model: ReturnType<typeof modelClientFromEnv>) =>
    model.structured({ name: "posting", system: "Extract.", user: "Engineer", schema });
  /** The SDK's HTTP layer: records each deployment called; `failing` ones answer 500. */
  function http(failing: string[] = []) {
    const calls: string[] = [];
    const fetch = (async (url: string | URL | Request) => {
      const deployment = /\/deployments\/([^/]+)\//.exec(String(url))?.[1] ?? "";
      calls.push(deployment);
      if (failing.includes(deployment)) {
        return new Response(JSON.stringify({ error: { message: "down" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(okBody({ title: "Engineer" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    return { calls, fetch };
  }

  it("is the main client when MODEL_EXTRACT_NAME isn't set", () => {
    const main = modelClientFromEnv(AZURE, credential);
    expect(extractClientFromEnv(AZURE, credential, main)).toBe(main);
  });

  it("calls its own deployment on the main endpoint, signed in the same way", async () => {
    const h = http();
    const env = { ...AZURE, MODEL_EXTRACT_NAME: "gpt-5.4-nano", MODEL_EXTRACT_TPM: "150000" };
    const main = modelClientFromEnv(env, credential, { fetch: h.fetch });
    const out = await ask(extractClientFromEnv(env, credential, main, { fetch: h.fetch }));
    expect(out).toMatchObject({ value: { title: "Engineer" }, served_by: "extract" });
    expect(h.calls).toEqual(["gpt-5.4-nano"]);
  });

  it("doesn't fall back: a provider error on its deployment fails the call", async () => {
    const h = http(["gpt-5.4-nano"]);
    const env = { ...AZURE, MODEL_EXTRACT_NAME: "gpt-5.4-nano", MODEL_MAX_RETRIES: "0" };
    const main = modelClientFromEnv(env, credential, { fetch: h.fetch });
    await expect(
      ask(extractClientFromEnv(env, credential, main, { fetch: h.fetch })),
    ).rejects.toThrow();
    expect(h.calls).toEqual(["gpt-5.4-nano"]);
  });

  it("paces to MODEL_EXTRACT_TPM", () => {
    const env = { ...AZURE, MODEL_EXTRACT_NAME: "gpt-5.4-nano" };
    const main = modelClientFromEnv(env, credential);
    expect(
      extractClientFromEnv({ ...env, MODEL_EXTRACT_TPM: "150000" }, credential, main),
    ).toBeInstanceOf(RateLimitedClient);
    expect(extractClientFromEnv(env, credential, main)).toBeInstanceOf(OpenAIChatClient);
  });

  it("names who serves each node it configures, and with which model", () => {
    const mini = { provider: "azure-openai", model: "gpt-5.4-mini" };
    expect(nodeModels({ ...AZURE, MODEL_EXTRACT_NAME: "gpt-5.4-nano" })).toEqual({
      extract_postings: { provider: "azure-openai", model: "gpt-5.4-nano" },
      judge: mini,
      explain: mini,
    });
    expect(nodeModels(AZURE).extract_postings).toEqual(mini);
  });
});

describe("modelClientFromEnv pacing", () => {
  const env = {
    MODEL_PROVIDER: "azure-openai",
    MODEL_ENDPOINT: "https://acct.openai.azure.com/",
    MODEL_NAME: "gpt-5.4-mini",
  };
  const credential = { getToken: async () => null };
  it("paces to MODEL_TPM when it's set, and not otherwise", () => {
    expect(modelClientFromEnv({ ...env, MODEL_TPM: "250000" }, credential)).toBeInstanceOf(
      RateLimitedClient,
    );
    expect(modelClientFromEnv(env, credential)).not.toBeInstanceOf(RateLimitedClient);
    expect(modelClientFromEnv({ ...env, MODEL_TPM: "0" }, credential)).not.toBeInstanceOf(
      RateLimitedClient,
    );
  });
  it("rejects a MODEL_TPM that isn't a whole number", () => {
    expect(() => modelClientFromEnv({ ...env, MODEL_TPM: "lots" }, credential)).toThrow(
      'MODEL_TPM must be a whole number, got "lots"',
    );
  });
});
