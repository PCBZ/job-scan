// The judge's answers, kept across runs (#150): an alert keeps a posting for
// days, and only recommended postings are remembered as seen, so a posting
// passed over was judged again each day. An answer is reused only when the
// whole request that earned it is the same, so a change to the prompt, the
// resume, the profile or the posting is a miss. Which model answered, and with
// which settings (its reasoning effort, #156), doesn't matter: the same request
// is the same question, so a change of model keeps the answers it was given.
//
// recall runs before judge, remember after the repair loop. Neither ever fails
// the run: a read that fails or times out is a miss, a write that fails is a
// warning.

import { createHash } from "node:crypto";
import { z } from "zod";
import type { ProfileConfig } from "../config/schema.js";
import type { Posting } from "../postings/types.js";
import type { ResumeVariant } from "../resume/load.js";
import { JudgementCacheCounts, type JudgementCacheStats } from "./cache-stats.js";
import { JUDGE_SYSTEM, judgeUser } from "./prompt.js";
import { judgeAnswer } from "./schema.js";
import { type Judgement, postingId, problemsAbout } from "./verify.js";

/** Bumped when an item changes shape or meaning, so older items are misses. */
export const CACHE_FORMAT = 1;

/** What is kept under a key: the verified answer, before whole resume lines replace its phrases. */
export const cachedJudgement = z.object({
  id: z.string().min(1),
  format: z.number(),
  answer: judgeAnswer,
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

/**
 * The key: a hash of the exact request the judge sends: its prompt, and the
 * profile, resumes and posting in the message. The posting's age ("4d")
 * changes each day and the rubric doesn't use it, so it's blanked.
 */
export function judgementKey(
  posting: Posting,
  profile: ProfileConfig,
  resumes: ResumeVariant[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        CACHE_FORMAT,
        JUDGE_SYSTEM,
        judgeUser({ ...posting, posted: "" }, profile, resumes),
      ]),
    )
    .digest("hex");
}

export interface JudgementCacheOptions {
  /** How long a read or write may take before it counts as failed. */
  timeoutMs?: number;
}

const within = (signal: AbortSignal | undefined, ms: number) =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class JudgementCache {
  private readonly counts = new JudgementCacheCounts();
  private readonly timeoutMs: number;

  constructor(
    private readonly store: JudgementStore,
    { timeoutMs = 5_000 }: JudgementCacheOptions = {},
  ) {
    this.timeoutMs = timeoutMs;
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
    // Point reads of one request unit each: no reason to queue them.
    const found = await Promise.all(
      postings.map(async (posting): Promise<Judgement[]> => {
        const key = judgementKey(posting, profile, resumes);
        try {
          const item = await this.store.get(key, within(signal, this.timeoutMs));
          const parsed = cachedJudgement.safeParse(item);
          if (parsed.success && parsed.data.id === key && parsed.data.format === CACHE_FORMAT) {
            return [{ posting, answer: parsed.data.answer }];
          }
        } catch (err) {
          this.counts.failedReads++;
          failures.push(errorText(err));
        }
        return [];
      }),
    );
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
      if (earlier.get(id) === JSON.stringify(j.answer)) this.counts.reused++;
      else fresh.push(j);
    }
    const failures: string[] = [];
    await Promise.all(
      fresh.map(async ({ posting, answer }) => {
        const id = judgementKey(posting, input.profile, input.resumes);
        try {
          await this.store.put(
            {
              id,
              format: CACHE_FORMAT,
              answer,
              ...(input.models?.length ? { models: input.models } : {}),
            },
            within(input.signal, this.timeoutMs),
          );
          this.counts.written++;
        } catch (err) {
          this.counts.failedWrites++;
          failures.push(errorText(err));
        }
      }),
    );
    return this.warn("write", failures, fresh.length);
  }

  stats(): JudgementCacheStats {
    return this.counts.snapshot(this.store.requestCharge());
  }

  /** One warning for a step's failures, quoting the first. */
  private warn(what: "read" | "write", failures: string[], of: number): string[] {
    if (failures.length === 0) return [];
    return [
      `judgement cache: ${failures.length} of ${of} ${what}s failed, so they ran without it (${failures[0]})`,
    ];
  }
}
