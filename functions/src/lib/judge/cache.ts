// The judge's answers, kept across runs (#150): an alert keeps a posting for
// days, and only recommended postings are remembered as seen, so a posting
// passed over was judged again each day. An answer is reused only when the
// whole request that earned it is the same, so a change to the prompt, the
// resume, the profile, the posting or the model is a miss.
//
// recall runs before judge, remember after the repair loop. Neither ever fails
// the run: a read that fails or times out is a miss, a write that fails is a
// warning.

import { createHash } from "node:crypto";
import { z } from "zod";
import type { ProfileConfig } from "../config/schema.js";
import { runDay } from "../day.js";
import type { Posting } from "../postings/types.js";
import type { ResumeVariant } from "../resume/load.js";
import { mapWithLimit } from "../workflow/limit.js";
import { JUDGE_SYSTEM, judgeUser } from "./prompt.js";
import { judgeAnswer } from "./schema.js";
import { type Judgement, postingId, problemsAbout } from "./verify.js";

/** Bumped when an item changes shape or meaning, so older items are misses. */
export const CACHE_FORMAT = 1;

/** How long a read or write may take before it counts as failed. */
export const CACHE_TIMEOUT_MS = 5_000;

/** Lookups and writes in flight at once. */
const CONCURRENCY = 8;

/** What is kept under a key: the verified answer, before whole resume lines replace its phrases. */
export const cachedJudgement = z.object({
  id: z.string().min(1),
  format: z.number(),
  answer: judgeAnswer,
  /** The day it was judged. */
  judgedOn: z.string(),
  /** The models that answered, with their versions, e.g. "gpt-5.4-mini-2026-03-17". */
  models: z.array(z.string()).optional(),
});
export type CachedJudgement = z.infer<typeof cachedJudgement>;

/** Where items live. Cosmos DB in Azure; a test supplies the SDK's own container shape. */
export interface JudgementStore {
  /** The item under `key`, as stored, or null when there is none. */
  get(key: string, signal?: AbortSignal): Promise<unknown | null>;
  put(item: CachedJudgement, signal?: AbortSignal): Promise<void>;
  /** The request units charged so far. */
  requestCharge(): number;
}

/** What a run did with the cache, for its run record. */
export interface JudgementCacheStats {
  /** Answers reused: kept after verification, so the model wasn't asked. */
  reused: number;
  written: number;
  failed_reads: number;
  failed_writes: number;
  /** Request units Cosmos charged. */
  request_charge: number;
}

/**
 * The key: a hash of the exact request the judge sends: its prompt, and the
 * profile, resumes and posting in the message. The posting's age ("4d")
 * changes each day and the rubric doesn't use it, so it's blanked.
 */
export function judgementKey(
  posting: Posting,
  profile: ProfileConfig,
  resumes: ResumeVariant[],
  model: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        CACHE_FORMAT,
        model,
        JUDGE_SYSTEM,
        judgeUser({ ...posting, posted: "" }, profile, resumes),
      ]),
    )
    .digest("hex");
}

export interface JudgementCacheOptions {
  /** The judge's deployment name: another model's answers aren't reused. */
  model: string;
  now?: () => Date;
  timeoutMs?: number;
}

const within = (signal: AbortSignal | undefined, ms: number) =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class JudgementCache {
  private reused = 0;
  private written = 0;
  private failedReads = 0;
  private failedWrites = 0;

  constructor(
    private readonly store: JudgementStore,
    private readonly options: JudgementCacheOptions,
  ) {}

  private get timeoutMs() {
    return this.options.timeoutMs ?? CACHE_TIMEOUT_MS;
  }

  /**
   * The postings that already have an answer from an earlier run, as judgements
   * of today's postings. An item that is missing, unreadable or of another
   * format is a miss.
   */
  async recall(
    postings: Posting[],
    profile: ProfileConfig,
    resumes: ResumeVariant[],
    signal?: AbortSignal,
  ): Promise<{ recalled: Judgement[]; warnings: string[] }> {
    const failures: string[] = [];
    const found = await mapWithLimit(postings, CONCURRENCY, async (posting) => {
      const key = judgementKey(posting, profile, resumes, this.options.model);
      try {
        const item = await this.store.get(key, within(signal, this.timeoutMs));
        const parsed = cachedJudgement.safeParse(item);
        if (parsed.success && parsed.data.id === key && parsed.data.format === CACHE_FORMAT) {
          return [{ posting, answer: parsed.data.answer }];
        }
      } catch (err) {
        this.failedReads++;
        failures.push(errorText(err));
      }
      return [];
    });
    return { recalled: found.flat(), warnings: this.warn("read", failures, postings.length) };
  }

  /**
   * Keep the answers that passed verification and weren't just reused. An answer
   * that failed verification, or that a repair replaced, is never kept as it
   * stood.
   */
  async remember(input: {
    judged: Judgement[];
    recalled: Judgement[];
    /** The judge loop's problems left after its last turn. */
    problems: string[];
    profile: ProfileConfig;
    resumes: ResumeVariant[];
    models?: string[];
    signal?: AbortSignal;
  }): Promise<string[]> {
    const earlier = new Map(
      input.recalled.map((j) => [postingId(j.posting), JSON.stringify(j.answer)]),
    );
    const fresh: Judgement[] = [];
    for (const j of input.judged) {
      const id = postingId(j.posting);
      if (problemsAbout(input.problems, id).length > 0) continue;
      if (earlier.get(id) === JSON.stringify(j.answer)) this.reused++;
      else fresh.push(j);
    }
    const judgedOn = runDay((this.options.now ?? (() => new Date()))());
    const failures: string[] = [];
    await mapWithLimit(fresh, CONCURRENCY, async ({ posting, answer }) => {
      const id = judgementKey(posting, input.profile, input.resumes, this.options.model);
      try {
        await this.store.put(
          {
            id,
            format: CACHE_FORMAT,
            answer,
            judgedOn,
            ...(input.models?.length ? { models: input.models } : {}),
          },
          within(input.signal, this.timeoutMs),
        );
        this.written++;
      } catch (err) {
        this.failedWrites++;
        failures.push(errorText(err));
      }
    });
    return this.warn("write", failures, fresh.length);
  }

  stats(): JudgementCacheStats {
    return {
      reused: this.reused,
      written: this.written,
      failed_reads: this.failedReads,
      failed_writes: this.failedWrites,
      request_charge: Math.round(this.store.requestCharge() * 100) / 100,
    };
  }

  /** One warning for a step's failures, quoting the first. */
  private warn(what: "read" | "write", failures: string[], of: number): string[] {
    if (failures.length === 0) return [];
    return [
      `judgement cache: ${failures.length} of ${of} ${what}s failed, so they ran without it (${failures[0]})`,
    ];
  }
}
