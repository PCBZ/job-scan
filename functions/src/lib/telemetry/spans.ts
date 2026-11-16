// The span names the pipeline writes and the evaluation's latency query reads
// (#130, #190), in one place so the two can't drift apart.

/**
 * Each trace's root span. The scanner's is written in Python
 * (jobspy-scanner/scanner/telemetry.py, RUN_SPAN); a test on each side pins it.
 */
export const RUN_SPANS = {
  collect: "collect run",
  mail: "daily run",
  jobspy: "jobspy run",
} as const;

/** A graph node's span is "node <name>", in both apps. */
export const NODE_SPAN_PREFIX = "node ";

export const nodeSpan = (name: string) => `${NODE_SPAN_PREFIX}${name}`;

/**
 * Model-call spans. The OpenInference instrumentations name them, not us: the
 * Node SDK's calls one way, the Python SDK's another. The scanner made the
 * Python ones until #204; the name stays so a run traced before it, the one CD's
 * smoke test may read, still counts its calls. The Node telemetry tests go
 * through the real instrumentation, so an upgrade that renames it fails there.
 */
export const MODEL_CALL_SPANS = {
  node: "OpenAI Chat Completions",
  python: "ChatCompletion",
} as const;
