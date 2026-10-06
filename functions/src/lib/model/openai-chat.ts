// ModelClient over OpenAI's Chat Completions API with structured outputs
// (response_format json_schema, strict). Works with Azure OpenAI and with any
// OpenAI-compatible endpoint; retries with backoff on 429 / 5xx / timeouts are
// the SDK's own (maxRetries, honouring retry-after).

import type OpenAI from "openai";
import { APIError } from "openai";
import { ContentFilterFinishReasonError, LengthFinishReasonError } from "openai/core/error";
import { zodResponseFormat } from "openai/helpers/zod";
import { ZodError } from "zod";
import {
  type ModelClient,
  ModelOutputError,
  ModelProviderError,
  type StructuredRequest,
  type StructuredResult,
} from "./types.js";

/** The part of the OpenAI client this adapter uses, so tests can fake it. */
export type ChatParser = Pick<OpenAI["chat"]["completions"], "parse">;

export class OpenAIChatClient implements ModelClient {
  constructor(
    private readonly completions: ChatParser,
    /** Model id, or the deployment name on Azure. */
    private readonly model: string,
    private readonly label = "primary",
  ) {}

  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    let completion: Awaited<ReturnType<ChatParser["parse"]>>;
    try {
      completion = await this.completions.parse({
        model: this.model,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        response_format: zodResponseFormat(req.schema, req.name),
      });
    } catch (err) {
      throw classify(err, req.name);
    }

    const message = completion.choices[0]?.message;
    if (message?.refusal) {
      throw new ModelOutputError(
        `${req.name}: the model refused: ${message.refusal.slice(0, 200)}`,
      );
    }
    if (message?.parsed === null || message?.parsed === undefined) {
      throw new ModelOutputError(`${req.name}: the model returned no structured output`);
    }
    return {
      value: message.parsed as T,
      usage: {
        input: completion.usage?.prompt_tokens ?? 0,
        output: completion.usage?.completion_tokens ?? 0,
      },
      served_by: this.label,
    };
  }
}

function classify(err: unknown, name: string): Error {
  if (err instanceof LengthFinishReasonError) {
    return new ModelOutputError(`${name}: output was cut off at the token limit`, { cause: err });
  }
  if (err instanceof ContentFilterFinishReasonError) {
    return new ModelOutputError(`${name}: output was blocked by the content filter`, {
      cause: err,
    });
  }
  if (err instanceof ZodError || err instanceof SyntaxError) {
    return new ModelOutputError(`${name}: output did not match the schema`, { cause: err });
  }
  if (err instanceof APIError) {
    // Includes connection errors and timeouts (no status), after the SDK's retries.
    return new ModelProviderError(`${name}: ${err.message}`.slice(0, 300), err.status, {
      cause: err,
    });
  }
  return err instanceof Error ? err : new Error(String(err));
}
