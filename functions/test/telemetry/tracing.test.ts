import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { modelClientFromEnv } from "../../src/lib/model/config.js";
import { instrumentOpenAI } from "../../src/lib/telemetry/instrument.js";
import { runDay } from "../run/helpers.js";
import { fakes } from "../workflow/fakes.js";

// A real provider over an in-memory exporter: the spans the app would export.
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

beforeAll(() => {
  provider.register();
  instrumentOpenAI(provider);
});
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
});
beforeEach(() => exporter.reset());

const quiet = { log: () => {}, error: () => {} };

// The real SDK over a fake HTTP layer, so the instrumented create() runs.
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "retry-after-ms": "1" },
  });
const ok = (async () =>
  json(200, {
    id: "c1",
    object: "chat.completion",
    created: 0,
    model: "gpt-5.4-mini",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: '{"ok":true}', refusal: null },
      },
    ],
    usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
  })) as typeof fetch;
const busy = (async () => json(503, { error: { message: "overloaded" } })) as typeof fetch;
const model = (fetch: typeof globalThis.fetch) =>
  modelClientFromEnv(
    {
      MODEL_PROVIDER: "azure-openai",
      MODEL_ENDPOINT: "https://example.openai.azure.com/",
      MODEL_NAME: "gpt-5.4-mini",
      MODEL_MAX_RETRIES: "1",
    },
    { getToken: async () => ({ token: "t", expiresOnTimestamp: Date.now() + 3_600_000 }) },
    { fetch },
  );
const spans = () => exporter.getFinishedSpans();
const named = (name: string) => spans().find((s) => s.name === name);

describe("tracing", () => {
  it("nests every node's span under its stage's, in one trace, with the node's tokens", async () => {
    await runDay(fakes(), quiet);
    const source = named("daily run");
    const collect = named("collect run");
    const judge = named("node judge");
    expect(source).toBeDefined();
    expect(collect).toBeDefined();
    // collect continues the source's trace: one trace per day's run.
    expect(collect?.spanContext().traceId).toBe(source?.spanContext().traceId);
    expect(collect?.parentSpanContext?.spanId).toBe(source?.spanContext().spanId);
    expect(judge?.parentSpanContext?.spanId).toBe(collect?.spanContext().spanId);
    expect(judge?.attributes).toMatchObject({
      "job_scan.node": "judge",
      "gen_ai.usage.input_tokens": 10,
      "gen_ai.usage.output_tokens": 2,
    });
    const nodes = spans().filter((s) => s.name.startsWith("node "));
    expect(nodes.map((s) => s.name)).toContain("node mark_seen");
    expect(named("node extract_postings")?.parentSpanContext?.spanId).toBe(
      source?.spanContext().spanId,
    );
    expect(named("node mark_seen")?.parentSpanContext?.spanId).toBe(collect?.spanContext().spanId);
  });

  it("names the run's trace in its evaluation report message (#128)", async () => {
    const sent: { traceId: string }[] = [];
    await runDay({ ...fakes(), evalQueue: { send: async (m) => void sent.push(m) } }, quiet);
    expect(sent[0]?.traceId).toBe(named("daily run")?.spanContext().traceId);
    expect(sent[0]?.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("marks a failed node and the run as errors", async () => {
    await expect(runDay(fakes({ deliverFails: true }), quiet)).rejects.toThrow("smtp down");
    expect(named("node deliver")?.status).toMatchObject({
      code: SpanStatusCode.ERROR,
      message: "smtp down",
    });
    expect(named("collect run")?.status.code).toBe(SpanStatusCode.ERROR);
    expect(named("daily run")?.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it("nests each model call under its node, with tokens but never the prompt or answer", async () => {
    const f = fakes();
    const judge = f.modelSteps.judge;
    f.modelSteps.judge = async (...args) => {
      await model(ok).structured({
        name: "judgement",
        system: "Judge the posting.",
        user: "Resume text: Go and Postgres at Northwind Labs",
        schema: z.object({ ok: z.boolean() }),
      });
      return judge(...args);
    };
    await runDay(f, quiet);
    const call = named("OpenAI Chat Completions");
    expect(call?.parentSpanContext?.spanId).toBe(named("node judge")?.spanContext().spanId);
    expect(call?.attributes).toMatchObject({
      "llm.provider": "azure",
      "llm.token_count.prompt": 50,
      "llm.token_count.completion": 10,
      "input.value": "__REDACTED__",
      "output.value": "__REDACTED__",
    });
    const all = JSON.stringify(spans().map((s) => s.attributes));
    expect(all).not.toContain("Postgres");
    expect(all).not.toContain("Judge the posting");
  });

  // OpenInference ends a call's span only on success (4.2.7 to 4.4.1): a
  // rejected create() leaves it open, never exported. The node's span carries
  // the failure instead.
  it("shows a failed model call as its node's error", async () => {
    const f = fakes();
    f.modelSteps.judge = async () => {
      await model(busy).structured({ name: "x", system: "s", user: "u", schema: z.object({}) });
      throw new Error("unreachable");
    };
    await expect(runDay(f, quiet)).rejects.toMatchObject({ code: "model_provider" });
    expect(named("node judge")?.status).toMatchObject({ code: SpanStatusCode.ERROR });
    expect(named("node judge")?.status.message).toContain("503");
    expect(spans().filter((s) => s.name === "OpenAI Chat Completions")).toEqual([]);
  });
});
