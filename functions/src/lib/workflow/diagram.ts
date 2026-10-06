import { buildWorkflow } from "./graph.js";
import type { CodeNodes, Effects, LlmNodes } from "./types.js";

/** Nodes that call the model; every other node is plain code. */
export const LLM_NODES = [
  "extract_postings",
  "canonicalize_resume_skills",
  "judge",
  "explain",
  "canonicalize_posting_skills",
] as const;

// Never called: drawing only reads the graph's structure.
const unused = new Proxy(
  {},
  {
    get: () => () => {
      throw new Error("workflow diagram: nodes are not runnable");
    },
  },
);

/**
 * The workflow as Mermaid, drawn from the compiled graph, with code nodes in
 * blue and LLM nodes in orange (the same colours as the wiki's §3).
 */
export async function workflowMermaid(): Promise<string> {
  const graph = await buildWorkflow(
    unused as CodeNodes,
    unused as LlmNodes,
    unused as Effects,
  ).getGraphAsync();
  const nodes = Object.keys(graph.nodes).filter((n) => !n.startsWith("__"));
  const llm = new Set<string>(LLM_NODES);
  const code = nodes.filter((n) => !llm.has(n));
  return [
    graph.drawMermaid().trimEnd(),
    "\tclassDef code fill:#dbeafe,stroke:#1d4ed8,color:#0b1f4d;",
    "\tclassDef llm fill:#fed7aa,stroke:#c2410c,color:#431407;",
    `\tclass ${code.join(",")} code;`,
    `\tclass ${LLM_NODES.join(",")} llm;`,
    "",
  ].join("\n");
}
