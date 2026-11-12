import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { modelClientFromEnv } from "../../src/lib/model/config.js";
import { runCollect } from "../../src/lib/run/collect.js";
import type { HandoffMessage } from "../../src/lib/run/handoff.js";
import { runIngest } from "../../src/lib/run/ingest.js";
import type { RunRecord, RunStatsRecord } from "../../src/lib/run/records.js";
import { instrumentOpenAI } from "../../src/lib/telemetry/instrument.js";
import type { TracePoint } from "../../src/lib/telemetry/tracing.js";
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
  it("nests every node's span under its stage's, each stage in its own trace, with the node's tokens", async () => {
    await runDay(fakes(), quiet);
    const source = named("daily run");
    const collect = named("collect run");
    const judge = named("node judge");
    expect(source).toBeDefined();
    expect(collect).toBeDefined();
    // collect has its own trace, linked to the source's run span.
    expect(collect?.spanContext().traceId).not.toBe(source?.spanContext().traceId);
    expect(collect?.parentSpanContext).toBeUndefined();
    expect(collect?.links.map((l) => l.context.spanId)).toEqual([source?.spanContext().spanId]);
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

  it("names the collect run's trace in its evaluation report message (#128)", async () => {
    const sent: { traceId: string }[] = [];
    await runDay({ ...fakes(), evalQueue: { send: async (m) => void sent.push(m) } }, quiet);
    expect(sent[0]?.traceId).toBe(named("collect run")?.spanContext().traceId);
    expect(sent[0]?.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  describe("the run record's traces", () => {
    /** The mail source runs; the jobspy scanner's file, if given, is written beside it. */
    async function collectWith(jobspyTrace: TracePoint | null | undefined) {
      const f = fakes();
      const written: RunRecord[][] = [];
      f.records.write = async (records) => {
        written.push(records);
        return "x.jsonl";
      };
      await runIngest(f, quiet);
      const message = f.handoffMessages[0] as HandoffMessage;
      if (jobspyTrace !== undefined) {
        const mail = await f.handoffs.read(message.blob);
        await f.handoffs.write({ ...mail, source: "jobspy", mail: null, trace: jobspyTrace });
      }
      await runCollect(f, message, quiet, {
        expected: jobspyTrace === undefined ? ["mail"] : ["mail", "jobspy"],
      });
      const run = written[0]?.find((r): r is RunStatsRecord => r.kind === "run");
      return { run, mail: named("daily run"), collect: named("collect run") };
    }
    const JOBSPY = { trace_id: "c".repeat(32), span_id: "d".repeat(16) };

    it("keeps collect's trace first, then the mail source's, on a mail-only day", async () => {
      const { run, mail, collect } = await collectWith(undefined);
      expect(run?.trace_id).toBe(collect?.spanContext().traceId);
      expect(run?.trace_ids).toEqual([collect?.spanContext().traceId, mail?.spanContext().traceId]);
    });

    it("links both sources when both handed over", async () => {
      const { run, mail, collect } = await collectWith(JOBSPY);
      expect(collect?.links.map((l) => l.context.traceId)).toEqual([
        mail?.spanContext().traceId,
        JOBSPY.trace_id,
      ]);
      expect(run?.trace_ids).toEqual([
        collect?.spanContext().traceId,
        mail?.spanContext().traceId,
        JOBSPY.trace_id,
      ]);
    });

    it("leaves out a source that named no trace", async () => {
      const { run, collect } = await collectWith(null);
      expect(collect?.links).toHaveLength(1);
      expect(run?.trace_ids).toHaveLength(2);
    });
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
