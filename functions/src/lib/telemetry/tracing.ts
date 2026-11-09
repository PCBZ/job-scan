// Our own spans (#101): the run and each graph node, with timings, tokens and
// status only; model calls come from OpenInference (instrument.ts) and nest
// under their node. No prompt or answer goes into a span: they hold real mail
// and resume text, and the run records (#97) keep the content. Without a
// registered provider (tests, local runs) these are no-ops.

import {
  type Attributes,
  context,
  ROOT_CONTEXT,
  type Span,
  SpanStatusCode,
  TraceFlags,
  trace,
} from "@opentelemetry/api";

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
      // Anything can be thrown; ours and the SDKs' are Errors, a stray value isn't.
      const message = err instanceof Error ? err.message : String(err);
      span.recordException(err instanceof Error ? err : message);
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Runs `fn` as a continuation of a trace another invocation started: spans
 * opened inside it join that trace instead of beginning their own. How the
 * collect run keeps one trace per day's run (#171).
 */
export function inTrace<T>(parent: { trace_id: string; span_id: string }, fn: () => T): T {
  const parentContext = trace.setSpanContext(ROOT_CONTEXT, {
    traceId: parent.trace_id,
    spanId: parent.span_id,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });
  return context.with(parentContext, fn);
}
