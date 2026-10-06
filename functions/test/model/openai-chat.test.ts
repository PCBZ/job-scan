import { APIUserAbortError, RateLimitError } from "openai";
import { LengthFinishReasonError } from "openai/core/error";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ChatParser,
  OpenAIChatClient,
  repairPrompt,
} from "../../src/lib/model/openai-chat.js";
import { ModelOutputError, ModelProviderError } from "../../src/lib/model/types.js";

const Posting = z.object({ title: z.string(), company: z.string() });
const REQ = { name: "posting", system: "Extract.", user: "Engineer at Northwind", schema: Posting };

function parser(result: unknown): ChatParser & { calls: unknown[]; options: unknown[] } {
  const calls: unknown[] = [];
  const options: unknown[] = [];
  return {
    calls,
    options,
    parse: (async (body: unknown, opts?: unknown) => {
      calls.push(body);
      options.push(opts);
      if (result instanceof Error) throw result;
      return result;
    }) as ChatParser["parse"],
  };
}

function completion(message: Record<string, unknown>) {
  return {
    choices: [{ message: { role: "assistant", content: null, refusal: null, ...message } }],
    usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
  };
}

describe("OpenAIChatClient", () => {
  it("sends system and user messages with a strict json_schema response format", async () => {
    const p = parser(completion({ parsed: { title: "Engineer", company: "Northwind" } }));
    const out = await new OpenAIChatClient(p, "gpt-5.4-mini").structured(REQ);
    expect(out).toEqual({
      value: { title: "Engineer", company: "Northwind" },
      usage: { input: 120, output: 30 },
      served_by: "primary",
    });
    const body = p.calls[0] as {
      model: string;
      messages: { role: string; content: string }[];
      response_format: { type: string; json_schema: { name: string; strict: boolean } };
    };
    expect(body.model).toBe("gpt-5.4-mini");
    expect(body.messages).toEqual([
      { role: "system", content: "Extract." },
      { role: "user", content: "Engineer at Northwind" },
    ]);
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema).toMatchObject({ name: "posting", strict: true });
  });

  it("treats a refusal or missing output as an output error", async () => {
    await expect(
      new OpenAIChatClient(
        parser(completion({ refusal: "I can't help with that." })),
        "m",
      ).structured(REQ),
    ).rejects.toBeInstanceOf(ModelOutputError);
    await expect(
      new OpenAIChatClient(parser(completion({ parsed: null })), "m").structured(REQ),
    ).rejects.toThrow("returned no structured output");
  });

  it("classifies truncation as an output error and API failures as provider errors", async () => {
    await expect(
      new OpenAIChatClient(parser(new LengthFinishReasonError()), "m").structured(REQ),
    ).rejects.toBeInstanceOf(ModelOutputError);
    const limited = new RateLimitError(
      429,
      { message: "slow down" },
      "429 slow down",
      new Headers(),
    );
    const err = await new OpenAIChatClient(parser(limited), "m")
      .structured(REQ)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelProviderError);
    expect((err as ModelProviderError).status).toBe(429);
  });

  it("appends each repair turn as the previous answer plus its problems, oldest first", async () => {
    const p = parser(completion({ parsed: { title: "Engineer", company: "Northwind" } }));
    await new OpenAIChatClient(p, "m").structured({
      ...REQ,
      repairs: [
        {
          previous: { title: "4d", company: "Engineer" },
          problems: ['company "Engineer" looks like a title'],
        },
        { previous: { title: "Engineer", company: "" }, problems: ["company is empty"] },
      ],
    });
    const { messages } = p.calls[0] as { messages: { role: string; content: string }[] };
    expect(messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    expect(messages[2]?.content).toBe(JSON.stringify({ title: "4d", company: "Engineer" }));
    expect(messages[3]?.content).toBe(
      'Your previous answer has these problems:\n- company "Engineer" looks like a title\nReturn a complete corrected answer in the same format.',
    );
    expect(messages[5]?.content).toBe(
      repairPrompt({ previous: null, problems: ["company is empty"] }),
    );
  });

  it("passes the abort signal to the SDK, and only when one is given", async () => {
    const p = parser(completion({ parsed: { title: "Engineer", company: "Northwind" } }));
    const controller = new AbortController();
    await new OpenAIChatClient(p, "m").structured({ ...REQ, signal: controller.signal });
    await new OpenAIChatClient(p, "m").structured(REQ);
    expect(p.options).toEqual([{ signal: controller.signal }, undefined]);
  });

  it("surfaces an abort as itself, not as a provider error", async () => {
    const err = await new OpenAIChatClient(parser(new APIUserAbortError()), "m")
      .structured(REQ)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIUserAbortError);
    expect(err).not.toBeInstanceOf(ModelProviderError);
  });
});
