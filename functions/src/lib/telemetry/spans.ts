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

/**
 * What each run span says it is, in OTel's GenAI agent terms: Foundry's Traces
 * view lists traces by agent (#207), and an app outside Foundry has to name
 * itself. One agent for the whole day, across both apps; the scanner sets the
 * same (jobspy-scanner/scanner/telemetry.py, AGENT_ATTRIBUTES), and a test on
 * each side pins them.
 */
export const AGENT_ATTRIBUTES = {
  "gen_ai.operation.name": "invoke_agent",
  "gen_ai.agent.id": "job-scan",
  "gen_ai.agent.name": "job-scan",
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
