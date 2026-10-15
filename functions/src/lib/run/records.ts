// Run records (#97): what one run read, filtered, picked and spent, kept for
// offline evaluation (evaluation plan §4). Built from the workflow's final
// state after the run, so no node changes; written as one JSONL file per run.
//
// Records hold real mail and resume text: they go to the private run-records
// container and never into the repo or a log.

import { randomBytes } from "node:crypto";
import type { TokenCredential } from "@azure/identity";
import { ContainerClient } from "@azure/storage-blob";
import { runDay } from "../day.js";
import { postingId } from "../judge/verify.js";
import type { FetchedMessage } from "../mail/types.js";
import type { TokenUsage } from "../model/types.js";
import type { Source } from "../postings/types.js";
import type { Loop, State } from "../workflow/state.js";
import type { Explanation, Filtered, Outcome, Posting, Ranked } from "../workflow/types.js";

/** The message a posting came from; written once, on its first posting. */
export interface MessageText {
  subject: string;
  from: string;
  date: string;
  body: string;
  links: FetchedMessage["links"];
}

export interface PostingRecord {
  kind: "posting";
  posting: Posting;
  message?: MessageText;
}

export interface FilteredRecord {
  kind: "filtered";
  posting: Posting;
  gate: Filtered["gate"];
  reason: string;
}

export interface PickRecord {
  kind: "pick";
  posting: Posting;
  score: number;
  scores: Record<string, number>;
  variant: string;
  either: string | undefined;
  caps: string[];
  confidence: Ranked["confidence"];
  judgement: Ranked["judgement"]["answer"];
  explanation: Explanation | null;
  /** The chosen variant's resume, as judged. */
  resume: { name: string; path: string; text: string } | null;
}

export interface LoopRecord {
  /** Repairs sent. */
  repairs: number;
  /** What the first check found. */
  first_pass: string[];
  /** What the last check still found. */
  unresolved: string[];
}

export interface RunMeta {
  started_at: string;
  /** When the workflow finished, before the record was written (#129). */
  ended_at: string;
  /** The deployed release (APP_VERSION), "local" outside CD. */
  version: string;
  /** Milliseconds per node, summed over its runs. */
  node_ms: Record<string, number>;
  throttled_ms: number;
  /** 429s the provider answered, retries included. */
  rate_limited: number;
}

export interface RunStatsRecord extends RunMeta {
  kind: "run";
  outcome: Outcome;
  messages: number;
  extracted: number;
  /** Past dedupe and the code gates: what judge was given. */
  judged: number;
  filtered: number;
  top: number;
  repeats: number;
  duplicates: number;
  dropped: Partial<Record<Source, number>>;
  loops: Record<Loop, LoopRecord>;
  warnings: number;
  usage: Record<string, TokenUsage>;
}

export type RunRecord = PostingRecord | FilteredRecord | PickRecord | RunStatsRecord;

const messageKey = (account: string, id: string) => `${account}\n${id}`;

export function loopRecord(l: State["loops"][Loop]): LoopRecord {
  return {
    repairs: l.turns.length,
    first_pass: l.turns[0]?.problems ?? l.problems,
    unresolved: l.problems,
  };
}

/** Every record of one run, the run's own last. */
export function runRecords(state: State, meta: RunMeta): RunRecord[] {
  const messages =
    state.mail && "messages" in state.mail
      ? new Map(state.mail.messages.map((m) => [messageKey(m.account, m.message_id), m]))
      : new Map<string, FetchedMessage>();
  const written = new Set<string>();

  const postings: PostingRecord[] = state.extracted.map((posting) => {
    const key = messageKey(posting.account, posting.message_id);
    const m = messages.get(key);
    if (!m || written.has(key)) return { kind: "posting", posting };
    written.add(key);
    return {
      kind: "posting",
      posting,
      message: { subject: m.subject, from: m.from, date: m.date, body: m.body, links: m.links },
    };
  });

  const filtered: FilteredRecord[] = state.filtered.map((f) => ({
    kind: "filtered",
    posting: f.posting,
    gate: f.gate,
    reason: f.reason,
  }));

  const explanations = new Map(state.explanations.map((e) => [e.id, e]));
  const variants = new Map((state.resumes?.variants ?? []).map((v) => [v.name, v]));
  const picks: PickRecord[] = state.top.map((r) => {
    const v = variants.get(r.variant);
    return {
      kind: "pick",
      posting: r.posting,
      score: r.score,
      scores: r.scores,
      variant: r.variant,
      either: r.either,
      caps: r.caps,
      confidence: r.confidence,
      judgement: r.judgement.answer,
      explanation: explanations.get(postingId(r.posting)) ?? null,
      resume: v ? { name: v.name, path: v.path, text: v.text } : null,
    };
  });

  const run: RunStatsRecord = {
    kind: "run",
    ...meta,
    outcome: state.outcome,
    messages: messages.size,
    extracted: state.extracted.length,
    judged: state.judged.length,
    filtered: state.filtered.length,
    top: state.top.length,
    repeats: state.repeats,
    duplicates: state.duplicates,
    dropped: state.dropped,
    loops: {
      extract: loopRecord(state.loops.extract),
      judge: loopRecord(state.loops.judge),
      explain: loopRecord(state.loops.explain),
    },
    warnings: state.warnings.length,
    usage: state.usage,
  };

  return [...postings, ...filtered, ...picks, run];
}

/** One JSON object per line. */
export const toJsonl = (records: RunRecord[]) =>
  records.map((r) => `${JSON.stringify(r)}\n`).join("");

export interface RunRecordStore {
  /** Write one run's records; returns the blob's name. */
  write(records: RunRecord[], startedAt: Date): Promise<string>;
}

type Container = Pick<ContainerClient, "getBlockBlobClient">;

/** A stuck upload ends as a failed write, not a run held to the host's timeout. */
export const WRITE_TIMEOUT_MS = 60_000;

/**
 * `<day>/<started-at>-<random>.jsonl`: a rerun on the same day keeps both runs,
 * which version comparison and stability need, and the suffix keeps two runs
 * started together (a double-clicked Run) from overwriting each other.
 */
export function runRecordStore(container: Container): RunRecordStore {
  return {
    async write(records, startedAt) {
      const suffix = randomBytes(4).toString("hex");
      const name = `${runDay(startedAt)}/${startedAt.toISOString()}-${suffix}.jsonl`;
      const body = Buffer.from(toJsonl(records), "utf8");
      await container.getBlockBlobClient(name).upload(body, body.length, {
        blobHTTPHeaders: { blobContentType: "application/x-ndjson; charset=utf-8" },
        abortSignal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
      });
      return name;
    },
  };
}

/** From RUN_RECORDS_URL, the container's endpoint. */
export function runRecordStoreFromUrl(
  containerUrl: string,
  credential: TokenCredential,
): RunRecordStore {
  return runRecordStore(new ContainerClient(containerUrl, credential));
}

export interface RunRecordReader {
  /** One run's records, from its blob name. */
  read(name: string): Promise<RunRecord[]>;
  /**
   * The run lines of up to `count` runs before `name`, newest first. A record
   * that can't be read or has no run line is skipped, not fatal (#129).
   */
  earlier(name: string, count: number): Promise<RunStatsRecord[]>;
}

type ReadableContainer = Pick<ContainerClient, "getBlockBlobClient" | "listBlobsFlat">;

const parseJsonl = (text: string): RunRecord[] =>
  text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as RunRecord);

export function runRecordReader(container: ReadableContainer): RunRecordReader {
  const read = async (name: string) =>
    parseJsonl((await container.getBlockBlobClient(name).downloadToBuffer()).toString("utf8"));
  return {
    read,
    async earlier(name, count) {
      // Names are <day>/<started-at>-<suffix>.jsonl, so they sort by time.
      const names: string[] = [];
      for await (const blob of container.listBlobsFlat()) {
        if (blob.name.endsWith(".jsonl") && blob.name < name) names.push(blob.name);
      }
      const runs: RunStatsRecord[] = [];
      for (const n of names.sort().reverse()) {
        if (runs.length >= count) break;
        try {
          const run = (await read(n)).find((r): r is RunStatsRecord => r.kind === "run");
          if (run) runs.push(run);
        } catch {
          // A record that won't parse costs its row in the trend, nothing more.
        }
      }
      return runs;
    },
  };
}

/** From RUN_RECORDS_URL, the container's endpoint. */
export function runRecordReaderFromUrl(
  containerUrl: string,
  credential: TokenCredential,
): RunRecordReader {
  return runRecordReader(new ContainerClient(containerUrl, credential));
}
