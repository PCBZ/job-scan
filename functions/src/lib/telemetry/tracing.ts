// Our own spans (#101): the run and each graph node, with timings, tokens and
// status only; model calls come from OpenInference (instrument.ts) and nest
// under their node. No prompt or answer goes into a span: they hold real mail
// and resume text, and the run records (#97) keep the content. Without a
// registered provider (tests, local runs) these are no-ops.

import {
  type Attributes,
  type Link,
  type Span,
  SpanStatusCode,
  TraceFlags,
  trace,
} from "@opentelemetry/api";

export const tracer = trace.getTracer("job-scan");

/** Where another invocation's trace stands: its trace and the span to link to. */
export interface TracePoint {
  trace_id: string;
  span_id: string;
}

/**
 * Runs `fn` in a span that is current for its duration; a throw marks it
 * failed. `links` point at spans in other traces that led to this one: how
 * the collect run names the sources it merged, each in its own trace.
 */
export async function inSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T> | T,
  links: TracePoint[] = [],
): Promise<T> {
  const linked: Link[] = links.map((l) => ({
    context: {
      traceId: l.trace_id,
      spanId: l.span_id,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    },
  }));
  return tracer.startActiveSpan(name, { attributes, links: linked }, async (span) => {
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
