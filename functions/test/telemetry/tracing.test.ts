import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { TracedClient } from "../../src/lib/model/traced.js";
import type { ModelClient } from "../../src/lib/model/types.js";
import { runDaily } from "../../src/lib/run/daily.js";
import { inSpan } from "../../src/lib/telemetry/tracing.js";
import { fakes } from "../workflow/fakes.js";

// A real provider over an in-memory exporter: the spans the app would export.
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

beforeAll(() => {
  provider.register();
});
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
});
beforeEach(() => exporter.reset());

const quiet = { log: () => {}, error: () => {} };
const spans = () => exporter.getFinishedSpans();
const named = (name: string) => spans().find((s) => s.name === name);

describe("tracing", () => {
  it("nests every node's span under the run's, with the node's tokens", async () => {
    await runDaily(fakes(), quiet);
    const run = named("daily run");
    const judge = named("node judge");
    expect(run).toBeDefined();
    expect(judge?.parentSpanContext?.spanId).toBe(run?.spanContext().spanId);
    expect(judge?.attributes).toMatchObject({
      "job_scan.node": "judge",
      "gen_ai.usage.input_tokens": 10,
      "gen_ai.usage.output_tokens": 2,
    });
    const nodes = spans().filter((s) => s.name.startsWith("node "));
    expect(nodes.map((s) => s.name)).toContain("node mark_seen");
    expect(nodes.every((s) => s.parentSpanContext?.spanId === run?.spanContext().spanId)).toBe(
      true,
    );
  });

  it("marks a failed node and the run as errors", async () => {
    await expect(runDaily(fakes({ deliverFails: true }), quiet)).rejects.toThrow("smtp down");
    expect(named("node deliver")?.status).toMatchObject({
      code: SpanStatusCode.ERROR,
      message: "smtp down",
    });
    expect(named("daily run")?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("records a model call under its node: deployment, tokens and repair round, never the prompt", async () => {
    const inner: ModelClient = {
      async structured<T>() {
        return {
          value: { ok: true } as T,
          usage: { input: 120, output: 30 },
          served_by: "primary",
        };
      },
    };
    const client = new TracedClient(inner, "az.ai.openai", "gpt-5.4-mini", "primary");
    const prompt = "Resume text: Go and Postgres at Northwind Labs";
    await inSpan("node judge", {}, () =>
      client.structured({
        name: "judgement",
        system: "Judge the posting.",
        user: prompt,
        schema: z.object({ ok: z.boolean() }),
        repairs: [{ previous: {}, problems: ["quote not found"] }],
      }),
    );
    const call = named("chat gpt-5.4-mini");
    expect(call?.parentSpanContext?.spanId).toBe(named("node judge")?.spanContext().spanId);
    expect(call?.attributes).toEqual({
      "gen_ai.operation.name": "chat",
      "gen_ai.system": "az.ai.openai",
      "gen_ai.request.model": "gpt-5.4-mini",
      "job_scan.schema": "judgement",
      "job_scan.slot": "primary",
      "job_scan.repair_round": 1,
      "gen_ai.usage.input_tokens": 120,
      "gen_ai.usage.output_tokens": 30,
    });
    expect(JSON.stringify(spans().map((s) => s.attributes))).not.toContain("Postgres");
  });

  it("marks a failed model call", async () => {
    const failing: ModelClient = {
      async structured() {
        throw new Error("429 after retries");
      },
    };
    const client = new TracedClient(failing, "az.ai.openai", "gpt-5.4-mini", "primary");
    await expect(
      client.structured({ name: "x", system: "s", user: "u", schema: z.object({}) }),
    ).rejects.toThrow("429 after retries");
    expect(named("chat gpt-5.4-mini")?.status.code).toBe(SpanStatusCode.ERROR);
  });
});
