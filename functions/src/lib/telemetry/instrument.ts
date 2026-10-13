// OpenInference's span for every OpenAI call (#101): model, tokens, finish
// reason and status, retries included. Patched through manuallyInstrument,
// which needs no require hook, so it works under ESM. Prompts and answers are
// hidden: they are real mail and resumes, and an attribute is capped at 8,192
// characters; the run records (#97) keep the content.
//
// LangGraph's nodes are spanned by the workflow builder instead: OpenInference's
// LangChain spans aren't current while a node runs, so model calls wouldn't
// nest under them.

import { OpenAIInstrumentation } from "@arizeai/openinference-instrumentation-openai";
import type { TracerProvider } from "@opentelemetry/api";
import OpenAI from "openai";

export function instrumentOpenAI(tracerProvider: TracerProvider): OpenAIInstrumentation {
  const instrumentation = new OpenAIInstrumentation({
    tracerProvider,
    traceConfig: { hideInputs: true, hideOutputs: true },
  });
  instrumentation.manuallyInstrument(
    OpenAI as unknown as Parameters<typeof instrumentation.manuallyInstrument>[0],
  );
  return instrumentation;
}
