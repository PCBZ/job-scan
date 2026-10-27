// ModelClient over OpenAI's Chat Completions API with structured outputs
// (response_format json_schema, strict). Works with Azure OpenAI and with any
// OpenAI-compatible endpoint; retries with backoff on 429 / 5xx / timeouts are
// the SDK's own (maxRetries, honouring retry-after).

import type OpenAI from "openai";
import { APIError, APIUserAbortError } from "openai";
import { ContentFilterFinishReasonError, LengthFinishReasonError } from "openai/core/error";
import { zodResponseFormat } from "openai/helpers/zod";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ReasoningEffort } from "openai/resources/shared";
import { ZodError } from "zod";
import { appError } from "../errors.js";
import type { ModelClient, RepairTurn, StructuredRequest, StructuredResult } from "./types.js";

/** The part of the OpenAI client this adapter uses, so tests can fake it. */
export type ChatParser = Pick<OpenAI["chat"]["completions"], "parse">;

export class OpenAIChatClient implements ModelClient {
  constructor(
    private readonly completions: ChatParser,
    /** Model id, or the deployment name on Azure. */
    private readonly model: string,
    private readonly label = "primary",
    /** How hard a reasoning model thinks; unset sends none and leaves the model's default. */
    private readonly reasoningEffort?: ReasoningEffort,
  ) {}

  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    let completion: Awaited<ReturnType<ChatParser["parse"]>>;
    try {
      completion = await this.completions.parse(
        {
          model: this.model,
          messages: messagesFor(req),
          response_format: zodResponseFormat(req.schema, req.name),
          ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}),
        },
        req.signal ? { signal: req.signal } : undefined,
      );
    } catch (err) {
      throw classify(err, req.name);
    }

    const message = completion.choices[0]?.message;
    // The refusal's own text stays out of the error: it can quote the prompt,
    // and errors reach the logs and the run's spans (#101).
    if (message?.refusal) throw appError("model_output", `${req.name}: the model refused`);
    if (message?.parsed === null || message?.parsed === undefined) {
      throw appError("model_output", `${req.name}: the model returned no structured output`);
    }
    return {
      value: message.parsed as T,
      usage: {
        input: completion.usage?.prompt_tokens ?? 0,
        output: completion.usage?.completion_tokens ?? 0,
        ...(completion.usage?.prompt_tokens_details?.cached_tokens !== undefined
          ? { cached: completion.usage.prompt_tokens_details.cached_tokens }
          : {}),
        ...(completion.usage?.prompt_tokens_details?.cache_write_tokens !== undefined
          ? { cacheWrite: completion.usage.prompt_tokens_details.cache_write_tokens }
          : {}),
        ...(completion.usage?.completion_tokens_details?.reasoning_tokens !== undefined
          ? { reasoning: completion.usage.completion_tokens_details.reasoning_tokens }
          : {}),
        ...(completion.model ? { models: [completion.model] } : {}),
      },
      served_by: this.label,
    };
  }
}

/** The repair prompt, written once: each node only says what was wrong. */
export function repairPrompt(turn: RepairTurn): string {
  return [
    "Your previous answer has these problems:",
    ...turn.problems.map((p) => `- ${p}`),
    "Return a complete corrected answer in the same format.",
  ].join("\n");
}

function messagesFor<T>(req: StructuredRequest<T>): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: req.system },
    { role: "user", content: req.user },
  ];
  for (const turn of req.repairs ?? []) {
    messages.push({ role: "assistant", content: JSON.stringify(turn.previous) });
    messages.push({ role: "user", content: repairPrompt(turn) });
  }
  return messages;
}

function classify(err: unknown, name: string): Error {
  // A cancelled run is not a provider failure: no fallback, no rewrapping.
  if (err instanceof APIUserAbortError) return err;
  if (err instanceof LengthFinishReasonError) {
    return appError("model_output", `${name}: output was cut off at the token limit`, {
      cause: err,
    });
  }
  if (err instanceof ContentFilterFinishReasonError) {
    return appError("model_output", `${name}: output was blocked by the content filter`, {
      cause: err,
    });
  }
  if (err instanceof ZodError || err instanceof SyntaxError) {
    return appError("model_output", `${name}: output did not match the schema`, { cause: err });
  }
  if (err instanceof APIError) {
    // Includes connection errors and timeouts (no status), after the SDK's retries.
    return appError("model_provider", `${name}: ${err.message}`.slice(0, 300), {
      status: err.status,
      cause: err,
    });
  }
  return err instanceof Error ? err : new Error(String(err));
}
