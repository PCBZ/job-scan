// Our own spans (#101): the run and each graph node, with timings, tokens and
// status only; model calls come from OpenInference (instrument.ts) and nest
// under their node. No prompt or answer goes into a span: they hold real mail
// and resume text, and the run records (#97) keep the content. Without a
// registered provider (tests, local runs) these are no-ops.

import { type Attributes, type Span, SpanStatusCode, trace } from "@opentelemetry/api";

export const tracer = trace.getTracer("job-scan");

/** Runs `fn` in a span that is current for its duration; a throw marks it failed. */
export async function inSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err instanceof Error ? err : String(err));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}
