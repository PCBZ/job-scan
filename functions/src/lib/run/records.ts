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
import {
  type Check,
  duplicates,
  filterReason,
  linkMatchesTitle,
  type VerbatimField,
  verbatimFields,
} from "./checks.js";

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
  /** #98: fields copied verbatim, and the chosen link naming the posting. */
  checks: { verbatim: Record<VerbatimField, Check>; link_title: Check };
}

export interface FilteredRecord {
  kind: "filtered";
  posting: Posting;
  gate: Filtered["gate"];
  reason: string;
  /** #98: the reason says something, and a model gate's quotes the posting. */
  checks: { reason: boolean };
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

/** Counts of a check over the run; failed is out of checked. */
export interface CheckTotal {
  checked: number;
  failed: number;
}

/** #98's checks over the whole run. */
export interface RunChecks {
  verbatim: CheckTotal;
  link_title: CheckTotal & { no_link: number };
  /** Fingerprints that repeat among the judged postings, i.e. past dedupe. */
  duplicates: { count: number; fingerprints: string[] };
  filter_reason: CheckTotal;
}

export interface RunMeta {
  started_at: string;
  /** The deployed release (APP_VERSION), "local" outside CD. */
  version: string;
  /** Milliseconds per node, summed over its runs. */
  node_ms: Record<string, number>;
  throttled_ms: number;
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
  /** Repeats within this batch, which dedupe removed. */
  duplicates: number;
  dropped: Partial<Record<Source, number>>;
  loops: Record<Loop, LoopRecord>;
  warnings: number;
  usage: Record<string, TokenUsage>;
  checks: RunChecks;
}

export type RunRecord = PostingRecord | FilteredRecord | PickRecord | RunStatsRecord;

const messageKey = (account: string, id: string) => `${account}\n${id}`;

function loopRecord(l: State["loops"][Loop]): LoopRecord {
  return {
    repairs: l.turns.length,
    first_pass: l.turns[0]?.problems ?? l.problems,
    unresolved: l.problems,
  };
}

function runChecks(
  postings: PostingRecord[],
  filtered: FilteredRecord[],
  judged: Posting[],
): RunChecks {
  const total = (results: Check[]): CheckTotal => ({
    checked: results.filter((r) => r !== null).length,
    failed: results.filter((r) => r === false).length,
  });
  const links = postings.map((p) => p.checks.link_title);
  const repeated = duplicates(judged);
  return {
    verbatim: total(postings.flatMap((p) => Object.values(p.checks.verbatim))),
    link_title: { ...total(links), no_link: links.filter((r) => r === null).length },
    duplicates: { count: repeated.length, fingerprints: repeated },
    filter_reason: total(filtered.map((f) => f.checks.reason)),
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
    const checks = {
      verbatim: verbatimFields(posting, m),
      link_title: linkMatchesTitle(posting, m),
    };
    if (!m || written.has(key)) return { kind: "posting", posting, checks };
    written.add(key);
    return {
      kind: "posting",
      posting,
      message: { subject: m.subject, from: m.from, date: m.date, body: m.body, links: m.links },
      checks,
    };
  });

  const filtered: FilteredRecord[] = state.filtered.map((f) => ({
    kind: "filtered",
    posting: f.posting,
    gate: f.gate,
    reason: f.reason,
    checks: { reason: filterReason(f) },
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
    checks: runChecks(
      postings,
      filtered,
      state.judged.map((j) => j.posting),
    ),
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
