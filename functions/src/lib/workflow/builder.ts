// A thin facade over LangGraph's StateGraph for this workflow. It times every
// node, builds each generate-and-check loop from one call, and keeps edges
// next to the nodes they leave from; LangGraph checks the wiring at compile().

import { END, START, StateGraph } from "@langchain/langgraph";
import type { TokenUsage } from "../model/types.js";
import { type Loop, type State, type Update, WorkflowState } from "./state.js";
import type { NodeEvent } from "./types.js";

export { END, START };

type NodeFn = (s: State, signal?: AbortSignal) => Promise<Update> | Update;
type Graph = StateGraph<typeof WorkflowState, State, Update, string>;

export interface BuilderOptions {
  /** Repair rounds after the first attempt, per loop. */
  maxRepairs?: number;
  onNode?: (event: NodeEvent) => void;
}

export interface RepairLoop {
  /** The model node that produces the output; it reads `s.loops[loop].turns`. */
  generate: string;
  /** The code check that runs after it. */
  check: string;
  /** Where the run goes once the check passes, or the repairs run out. */
  next: string;
  /** The output the check judges, sent back with its problems. */
  output: (s: State) => unknown;
  /** Returns the problems (empty: passed) and any other fields to update. */
  run: (s: State) => { problems: string[]; update?: Update };
}

export class WorkflowBuilder {
  readonly maxRepairs: number;
  private readonly graph: Graph = new StateGraph(WorkflowState) as unknown as Graph;
  private readonly edges: ((g: Graph) => void)[] = [];
  private loops = 0;

  constructor(private readonly options: BuilderOptions = {}) {
    this.maxRepairs = options.maxRepairs ?? 2;
  }

  /** A node; its token use (under `usage[name]`) and time go to onNode. */
  node(name: string, fn: NodeFn): this {
    const { onNode } = this.options;
    this.graph.addNode(name, async (s: State, config?: { signal?: AbortSignal }) => {
      const started = performance.now();
      try {
        const update = await fn(s, config?.signal);
        const usage = (update.usage as Record<string, TokenUsage> | undefined)?.[name];
        onNode?.({
          node: name,
          ms: performance.now() - started,
          ok: true,
          ...(usage ? { usage } : {}),
        });
        return update;
      } catch (err) {
        onNode?.({ node: name, ms: performance.now() - started, ok: false });
        throw err;
      }
    });
    return this;
  }

  edge(from: string, to: string): this {
    this.edges.push((g) => g.addEdge(from, to));
    return this;
  }

  /** `to` runs once, after every node in `from` has run. */
  join(from: string[], to: string): this {
    this.edges.push((g) => g.addEdge(from, to));
    return this;
  }

  /** Goes to `routes[route(s)]`. */
  branch(from: string, route: (s: State) => string, routes: Record<string, string>): this {
    this.edges.push((g) => g.addConditionalEdges(from, route, routes));
    return this;
  }

  /**
   * generate → check, and back to generate with the problems while repairs
   * remain. When they run out, the run records what is unresolved and goes on.
   */
  repairLoop(loop: Loop, o: RepairLoop): this {
    this.loops++;
    const max = this.maxRepairs;
    this.node(o.check, (s) => {
      const { problems, update } = o.run(s);
      const retry = problems.length > 0 && s.loops[loop].turns.length < max;
      const turns = retry ? [{ previous: o.output(s), problems }] : [];
      return {
        ...update,
        loops: { [loop]: { turns, problems, retry } },
        ...(problems.length > 0 && !retry
          ? { warnings: problems.map((p) => `${o.check}: unresolved after ${max} repair(s): ${p}`) }
          : {}),
      };
    });
    this.edge(o.generate, o.check);
    return this.branch(o.check, (s) => (s.loops[loop].retry ? "retry" : "next"), {
      retry: o.generate,
      next: o.next,
    });
  }

  compile() {
    for (const add of this.edges) add(this.graph);
    // About 18 supersteps on the longest path, plus two (generate and check)
    // per repair in each loop; LangGraph's default of 25 is too low.
    return this.graph
      .compile()
      .withConfig({ recursionLimit: 30 + this.loops * 2 * this.maxRepairs });
  }
}
