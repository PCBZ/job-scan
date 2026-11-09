// What a source hands to `collect`: its postings and everything the run
// learned getting them, as one JSON file in the private postings container, and
// a message on the postings-ready queue naming it. A source runs on its own and
// never calls the next stage; `collect` merges what has arrived and runs the
// rest of the pipeline.
//
// A file holds real mail text, like a run record: private container, short
// retention, never in the repo or a log.

import { createHash, randomBytes } from "node:crypto";
import type { TokenCredential } from "@azure/identity";
import { ContainerClient, RestError } from "@azure/storage-blob";
import { QueueClient } from "@azure/storage-queue";
import type { AllAccountsFailed, FetchPayload } from "../mail/types.js";
import { addUsage, type TokenUsage } from "../model/types.js";
import type { Source } from "../postings/types.js";
import type { LoopState, State, Update } from "../workflow/state.js";
import type { Posting, SuspiciousByMessage } from "../workflow/types.js";

/** The sources `collect` waits for. A source joins this list when it exists. */
export const EXPECTED_SOURCES = ["mail"] as const;

/** How long `collect` waits for a missing source before it runs with what it has. */
export const COLLECT_DEADLINE_MINUTES = 60;

/** How often a waiting `collect` looks again. */
export const COLLECT_RECHECK_SECONDS = 5 * 60;

export interface SourceHandoff {
  version: 1;
  /** Which source wrote it: "mail". */
  source: string;
  /** The run day, in the run's own zone. */
  day: string;
  started_at: string;
  /** Where the run's trace stands, so `collect`'s spans join it (one trace per run). */
  trace: { trace_id: string; span_id: string } | null;
  /** Milliseconds per node, summed over its runs. */
  node_ms: Record<string, number>;
  throttled_ms: number;
  rate_limited: number;
  mail: FetchPayload | AllAccountsFailed | null;
  extracted: Posting[];
  /** The rows that passed validation. */
  postings: Posting[];
  dropped: Partial<Record<Source, number>>;
  suspicious: SuspiciousByMessage;
  usage: Record<string, TokenUsage>;
  extract_loop: LoopState;
  warnings: string[];
}

/** The queue message: which file, and when `collect` first heard of this run. */
export interface HandoffMessage {
  day: string;
  source: string;
  /** The file's blob name in the postings container. */
  blob: string;
  /** When the first message of the run was sent; the deadline counts from here. */
  first_seen: string;
}

export interface HandoffStore {
  /** Write one source's file; returns the blob's name. */
  write(handoff: SourceHandoff): Promise<string>;
  read(name: string): Promise<SourceHandoff>;
  /** The newest file one source wrote on `day`; null if it hasn't. */
  latest(day: string, source: string): Promise<string | null>;
  /**
   * True if this caller now holds the mark for collecting exactly these files;
   * false if another does. Two messages that find the same files present run
   * once, a redelivered message doesn't deliver the report twice, and a failed
   * collect isn't retried: its mail is reported again tomorrow, as before.
   */
  claim(day: string, files: string[]): Promise<boolean>;
}

type Container = Pick<ContainerClient, "getBlockBlobClient" | "listBlobsFlat">;

/** A stuck upload ends as a failed write, not a run held to the host's timeout. */
export const WRITE_TIMEOUT_MS = 60_000;

/** `<day>/<source>/<started-at>-<random>.json`: a rerun on the same day keeps both. */
export function handoffStore(container: Container): HandoffStore {
  return {
    async write(handoff) {
      const suffix = randomBytes(4).toString("hex");
      const name = `${handoff.day}/${handoff.source}/${handoff.started_at}-${suffix}.json`;
      const body = Buffer.from(JSON.stringify(handoff), "utf8");
      await container.getBlockBlobClient(name).upload(body, body.length, {
        blobHTTPHeaders: { blobContentType: "application/json; charset=utf-8" },
        abortSignal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
      });
      return name;
    },
    async read(name) {
      const text = (await container.getBlockBlobClient(name).downloadToBuffer()).toString("utf8");
      const handoff = JSON.parse(text) as SourceHandoff;
      if (handoff.version !== 1) throw new Error(`handoff ${name}: unknown version`);
      return handoff;
    },
    async latest(day, source) {
      const names: string[] = [];
      for await (const blob of container.listBlobsFlat({ prefix: `${day}/${source}/` })) {
        if (blob.name.endsWith(".json")) names.push(blob.name);
      }
      // Names end in the start time, so they sort by it.
      return names.sort().at(-1) ?? null;
    },
    async claim(day, files) {
      const key = createHash("sha256")
        .update([...files].sort().join("\n"))
        .digest("hex");
      try {
        await container
          .getBlockBlobClient(`${day}/collected/${key.slice(0, 16)}`)
          .upload("", 0, { conditions: { ifNoneMatch: "*" } });
        return true;
      } catch (err) {
        if (err instanceof RestError && err.statusCode === 409) return false;
        throw err;
      }
    },
  };
}

/** From POSTINGS_URL, the container's endpoint. */
export function handoffStoreFromUrl(containerUrl: string, credential: TokenCredential) {
  return handoffStore(new ContainerClient(containerUrl, credential));
}

export interface HandoffQueue {
  /** Queue the message, hidden for `delaySeconds`. */
  send(message: HandoffMessage, delaySeconds?: number): Promise<void>;
}

type Queue = Pick<QueueClient, "sendMessage">;

/** Plain JSON, readable in the portal; host.json's messageEncoding "none" matches. */
export function handoffQueue(queue: Queue): HandoffQueue {
  return {
    async send(message, delaySeconds = 0) {
      await queue.sendMessage(JSON.stringify(message), { visibilityTimeout: delaySeconds });
    },
  };
}

/** From POSTINGS_QUEUE_URL, the queue's endpoint. */
export function handoffQueueFromUrl(queueUrl: string, credential: TokenCredential) {
  return handoffQueue(new QueueClient(queueUrl, credential));
}

/** A source's file, from its graph's final state and what the run measured. */
export function handoffFrom(
  state: State,
  meta: Pick<
    SourceHandoff,
    "source" | "day" | "started_at" | "trace" | "node_ms" | "throttled_ms" | "rate_limited"
  >,
): SourceHandoff {
  return {
    version: 1,
    ...meta,
    mail: state.mail,
    extracted: state.extracted,
    postings: state.postings,
    dropped: state.dropped,
    suspicious: state.suspicious,
    usage: state.usage,
    extract_loop: state.loops.extract,
    warnings: state.warnings,
  };
}

/** The workflow state `collect` starts from: the sources' files, merged. */
export function seedFrom(handoffs: SourceHandoff[]): Update {
  const dropped: Partial<Record<Source, number>> = {};
  const usage: Record<string, TokenUsage> = {};
  const suspicious: SuspiciousByMessage = {};
  for (const h of handoffs) {
    for (const [source, n] of Object.entries(h.dropped) as [Source, number][])
      dropped[source] = (dropped[source] ?? 0) + n;
    for (const [node, u] of Object.entries(h.usage))
      usage[node] = addUsage(usage[node] ?? { input: 0, output: 0 }, u);
    Object.assign(suspicious, h.suspicious);
  }
  const withLoop = handoffs.find((h) => h.source === "mail");
  return {
    mail: handoffs.find((h) => h.mail !== null)?.mail ?? null,
    extracted: handoffs.flatMap((h) => h.extracted),
    postings: handoffs.flatMap((h) => h.postings),
    dropped,
    suspicious,
    usage,
    warnings: handoffs.flatMap((h) => h.warnings),
    ...(withLoop ? { loops: { extract: withLoop.extract_loop } } : {}),
  };
}

/** What the run's records and summary need from the sources, summed. */
export function mergeMeta(handoffs: SourceHandoff[]) {
  const nodeMs: Record<string, number> = {};
  for (const h of handoffs)
    for (const [node, ms] of Object.entries(h.node_ms)) nodeMs[node] = (nodeMs[node] ?? 0) + ms;
  return {
    startedAt: handoffs.map((h) => h.started_at).sort()[0] ?? new Date().toISOString(),
    nodeMs,
    throttledMs: handoffs.reduce((n, h) => n + h.throttled_ms, 0),
    rateLimited: handoffs.reduce((n, h) => n + h.rate_limited, 0),
    trace: handoffs.find((h) => h.trace)?.trace ?? null,
  };
}
