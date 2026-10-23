import { describe, expect, it } from "vitest";
import type { ProfileConfig } from "../../src/lib/config/schema.js";
import {
  CACHE_FORMAT,
  type CachedJudgement,
  JudgementCache,
  type JudgementStore,
  judgementKey,
} from "../../src/lib/judge/cache.js";
import { postingId } from "../../src/lib/judge/verify.js";
import type { ResumeVariant } from "../../src/lib/resume/load.js";
import { posting } from "../postings/helpers.js";
import { answer, judgement } from "./helpers.js";

const RESUMES: ResumeVariant[] = [
  { path: "Resume.tex", name: "Resume", text: "Built payment services in Go" },
];
const PROFILE: ProfileConfig = {
  locations: ["Vancouver, BC"],
  seniority: "mid",
  needs_sponsorship: false,
};
const A = posting({ title: "Backend Engineer", message_id: "<m@x>", row: 0, posted: "4d" });
const B = posting({ title: "Data Engineer", message_id: "<m@x>", row: 1 });
const key = (p = A, profile = PROFILE, resumes = RESUMES) => judgementKey(p, profile, resumes);

/** A store that holds items in a Map and says what was asked of it. */
function store(
  o: { items?: Map<string, unknown>; fail?: "read" | "write" | "hang"; charge?: number } = {},
) {
  const items = o.items ?? new Map<string, unknown>();
  const reads: string[] = [];
  const writes: CachedJudgement[] = [];
  let charged = 0;
  const s: JudgementStore = {
    async get(k, signal) {
      reads.push(k);
      if (o.fail === "read") throw new Error("cosmos 503");
      if (o.fail === "hang") {
        await new Promise((_, reject) =>
          signal?.addEventListener("abort", () => reject(signal.reason)),
        );
      }
      charged += o.charge ?? 0;
      return items.get(k) ?? null;
    },
    async put(item) {
      if (o.fail === "write") throw new Error("cosmos 429");
      writes.push(item);
      items.set(item.id, item);
      charged += o.charge ?? 0;
    },
    requestCharge: () => charged,
  };
  return { s, items, reads, writes };
}

const cache = (s: JudgementStore, extra = {}) => new JudgementCache(s, extra);

/**
 * A store whose reads and writes each wait until `n` of them are under way at
 * once, so a test passes only if they were started together: one at a time,
 * the first would wait for the rest forever and the barrier gives up.
 */
function togetherStore(n: number, items: Map<string, unknown> = new Map()) {
  const arrived = { get: 0, put: 0 };
  const waiting = { get: [] as (() => void)[], put: [] as (() => void)[] };
  const barrier = (kind: "get" | "put") =>
    new Promise<void>((resolve, reject) => {
      arrived[kind]++;
      waiting[kind].push(resolve);
      if (arrived[kind] === n) for (const go of waiting[kind]) go();
      setTimeout(() => reject(new Error(`${kind}s weren't started together`)), 1000).unref();
    });
  const s: JudgementStore = {
    async get(k) {
      await barrier("get");
      return items.get(k) ?? null;
    },
    async put(item) {
      await barrier("put");
      items.set(item.id, item);
    },
    requestCharge: () => 0,
  };
  return { s, items, arrived };
}

const kept = (k: string, over: Partial<CachedJudgement> = {}): CachedJudgement => ({
  id: k,
  format: CACHE_FORMAT,
  answer: answer(),
  ...over,
});

describe("judgementKey (#150)", () => {
  it("is the same for the same request, and not changed by the posting's age", () => {
    expect(key()).toMatch(/^[0-9a-f]{64}$/);
    expect(key()).toBe(key());
    expect(key(posting({ ...A, posted: "9d" }))).toBe(key());
    // What isn't in the prompt doesn't matter either.
    expect(key(posting({ ...A, row: 7, message_id: "<other@x>" }))).toBe(key());
  });

  it.each([
    ["the posting's title", () => key(posting({ ...A, title: "Staff Engineer" }))],
    ["its requirements", () => key(posting({ ...A, requirements: ["10+ years"] }))],
    ["its location", () => key(posting({ ...A, location: "Toronto, ON" }))],
    ["its salary", () => key(posting({ ...A, salary: "$200,000" }))],
    [
      "the resume",
      () => key(A, PROFILE, [{ ...RESUMES[0], text: "Built Rust services" } as ResumeVariant]),
    ],
    ["the profile", () => key(A, { ...PROFILE, seniority: "senior" })],
  ])("changes with %s", (_what, other) => {
    expect(other()).not.toBe(key());
  });
});

describe("JudgementCache.recall", () => {
  it("returns today's posting with the answer kept for its key, and nothing for the rest", async () => {
    const { s, items } = store();
    items.set(key(A), kept(key(A)));
    const today = posting({ ...A, posted: "5d" });
    const out = await cache(s).recall([today, B], PROFILE, RESUMES);
    expect(out.warnings).toEqual([]);
    expect(out.recalled).toHaveLength(1);
    // The posting is today's, so its age and place in the mail are current.
    expect(out.recalled[0]?.posting).toBe(today);
    expect(out.recalled[0]?.answer).toEqual(answer());
  });

  it.each([
    ["another format", (k: string) => kept(k, { format: CACHE_FORMAT + 1 })],
    ["another key", (k: string) => kept(`${k}x`)],
    [
      "a shape the schema doesn't know",
      (k: string) => ({ id: k, format: CACHE_FORMAT, answer: { level: "x" } }),
    ],
    ["not an item", () => "garbage"],
  ])("treats an item of %s as a miss", async (_what, item) => {
    const { s, items } = store();
    items.set(key(A), item(key(A)));
    const out = await cache(s).recall([A], PROFILE, RESUMES);
    expect(out).toEqual({ recalled: [], warnings: [] });
  });

  it("reads every posting's key together, not one after another", async () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      posting({ ...A, title: `Engineer ${i}`, row: i }),
    );
    const items = new Map(many.map((p) => [key(p), kept(key(p))]));
    const { s, arrived } = togetherStore(many.length, items);
    const out = await cache(s).recall(many, PROFILE, RESUMES);
    expect(arrived.get).toBe(5);
    expect(out.warnings).toEqual([]);
    expect(out.recalled).toHaveLength(5);
  });

  it("counts a failed read as a miss and says so once", async () => {
    const c = cache(store({ fail: "read" }).s);
    const out = await c.recall([A, B], PROFILE, RESUMES);
    expect(out.recalled).toEqual([]);
    expect(out.warnings).toEqual([
      "judgement cache: 2 of 2 reads failed, so they ran without it (cosmos 503)",
    ]);
    expect(c.stats().failed_reads).toBe(2);
  });

  it("gives up on a read that takes too long", async () => {
    const c = cache(store({ fail: "hang" }).s, { timeoutMs: 20 });
    const out = await c.recall([A], PROFILE, RESUMES);
    expect(out.recalled).toEqual([]);
    expect(out.warnings[0]).toContain("1 of 1 reads failed");
  });
});

describe("JudgementCache.remember", () => {
  const mine = (p = A) => judgement({ posting: p });
  const input = (over: object = {}) => ({
    judged: [mine(A), mine(B)],
    recalled: [],
    problems: [],
    profile: PROFILE,
    resumes: RESUMES,
    ...over,
  });

  it("keeps each fresh answer under its key, with the models that answered", async () => {
    const { s, writes } = store();
    const c = cache(s);
    expect(await c.remember(input({ models: ["gpt-5.4-mini-2026-03-17"] }))).toEqual([]);
    expect(writes.map((w) => w.id).sort()).toEqual([key(A), key(B)].sort());
    expect(writes[0]).toMatchObject({
      format: CACHE_FORMAT,
      models: ["gpt-5.4-mini-2026-03-17"],
      answer: answer(),
    });
    expect(c.stats()).toMatchObject({ written: 2, reused: 0 });
  });

  it("writes every fresh answer together, not one after another", async () => {
    const many = Array.from({ length: 4 }, (_, i) =>
      mine(posting({ ...A, title: `Engineer ${i}`, row: i })),
    );
    const { s, items, arrived } = togetherStore(many.length);
    expect(await cache(s).remember(input({ judged: many }))).toEqual([]);
    expect(arrived.put).toBe(4);
    expect(items.size).toBe(4);
  });

  it("doesn't write an answer that was just reused, and counts it", async () => {
    const { s, writes } = store();
    const c = cache(s);
    await c.remember(input({ recalled: [mine(A)] }));
    expect(writes.map((w) => w.id)).toEqual([key(B)]);
    expect(c.stats()).toMatchObject({ written: 1, reused: 1 });
  });

  it("replaces a kept answer that a repair changed", async () => {
    const { s, writes } = store();
    const repaired = judgement({ posting: A, answer: { unknowns: ["years of experience"] } });
    await cache(s).remember(input({ judged: [repaired], recalled: [mine(A)] }));
    expect(writes).toHaveLength(1);
    expect(writes[0]?.answer.unknowns).toEqual(["years of experience"]);
  });

  it("never keeps an answer that still has a problem", async () => {
    const { s, writes } = store();
    const problem = `posting ${JSON.stringify(postingId(A))}: Resume skills: evidence "x" is not a line of that resume`;
    await cache(s).remember(input({ problems: [problem] }));
    expect(writes.map((w) => w.id)).toEqual([key(B)]);
  });

  it("warns, once, when writes fail, and carries on", async () => {
    const c = cache(store({ fail: "write" }).s);
    const warnings = await c.remember(input());
    expect(warnings).toEqual([
      "judgement cache: 2 of 2 writes failed, so they ran without it (cosmos 429)",
    ]);
    expect(c.stats()).toMatchObject({ written: 0, failed_writes: 2 });
  });

  it("reports the request units its store charged", async () => {
    const c = cache(store({ charge: 5.5 }).s);
    await c.recall([A], PROFILE, RESUMES);
    await c.remember(input({ judged: [mine(A)] }));
    expect(c.stats().request_charge).toBe(11);
  });
});
