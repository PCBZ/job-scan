import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/lib/config/load.js";
import { fingerprint } from "../../src/lib/fingerprint.js";
import { dedupeStep } from "../../src/lib/postings/dedupe.js";
import { MemorySeenJobsStore } from "../../src/lib/postings/seen-jobs.js";
import { posting } from "./helpers.js";

const config = (repeat_suppression_days?: number) =>
  ({
    report: repeat_suppression_days === undefined ? {} : { repeat_suppression_days },
  }) as AppConfig;

// 08:00 in Vancouver on 2026-10-07.
const NOW = new Date("2026-10-07T15:00:00Z");
const at = (iso: string) => () => new Date(iso);

const a = posting({ company: "Lumen Ridge", title: "Backend Engineer" });
const b = posting({ company: "Saltmarsh Robotics", title: "Platform Engineer" });

async function storeWith(day: string, ...jobs: (typeof a)[]) {
  const store = new MemorySeenJobsStore();
  await store.recordRecommended(jobs, day);
  return store;
}

describe("dedupeStep", () => {
  it("keeps first sightings and counts in-batch duplicates", async () => {
    const aAgain = posting({
      company: "Lumen Ridge Inc.",
      title: "Backend Engineer",
      account: "school",
    });
    const out = await dedupeStep(new MemorySeenJobsStore(), at(NOW.toISOString()))(
      [a, b, aAgain],
      config(),
    );
    expect(out).toEqual({ fresh: [a, b], repeats: 0, duplicates: 1 });
  });

  it("counts every sighting of a repeat, so twice in one batch is two repeats", async () => {
    const store = await storeWith("2026-10-06", a);
    const out = await dedupeStep(store, at(NOW.toISOString()))([a, a, b], config());
    expect(out).toEqual({ fresh: [b], repeats: 2, duplicates: 0 });
  });

  it("a posting recommended yesterday appears only in today's repeat count", async () => {
    const store = new MemorySeenJobsStore();
    const day1 = await dedupeStep(store, at("2026-10-06T15:00:00Z"))([a], config());
    expect(day1).toMatchObject({ fresh: [a], repeats: 0 });
    await store.recordRecommended(day1.fresh, "2026-10-06");

    // Same role, with the next board's wording.
    const reworded = posting({ company: "Lumen Ridge Inc", title: "Backend Engineer (Req 12345)" });
    const day2 = await dedupeStep(store, at(NOW.toISOString()))([reworded], config());
    expect(day2).toEqual({ fresh: [], repeats: 1, duplicates: 0 });
  });

  it("holds a repeat back for 30 days by default, and lets it back the day after", async () => {
    const store = await storeWith("2026-09-07", a);
    expect((await dedupeStep(store, at(NOW.toISOString()))([a], config())).repeats).toBe(1);
    expect((await dedupeStep(store, at("2026-10-08T15:00:00Z"))([a], config())).fresh).toEqual([a]);
  });

  it("uses repeat_suppression_days, where 0 holds back only today's picks", async () => {
    const store = await storeWith("2026-09-29", a);
    expect((await dedupeStep(store, at(NOW.toISOString()))([a], config(7))).fresh).toEqual([a]);
    expect((await dedupeStep(store, at(NOW.toISOString()))([a], config(8))).repeats).toBe(1);

    const today = await storeWith("2026-10-07", a);
    const yesterday = await storeWith("2026-10-06", a);
    expect((await dedupeStep(today, at(NOW.toISOString()))([a], config(0))).repeats).toBe(1);
    expect((await dedupeStep(yesterday, at(NOW.toISOString()))([a], config(0))).fresh).toEqual([a]);
  });

  it("counts the window from Vancouver's day when UTC is already on the next one", async () => {
    // 23:30 on 2026-10-07 in Vancouver: 2026-09-07 is still inside the window.
    const store = await storeWith("2026-09-07", a);
    expect((await dedupeStep(store, at("2026-10-08T06:30:00Z"))([a], config())).repeats).toBe(1);
  });

  it("never records what it only saw: a posting passed over can come back", async () => {
    const store = new MemorySeenJobsStore();
    await dedupeStep(store, at(NOW.toISOString()))([a], config());
    expect(store.rows.size).toBe(0);
  });
});

describe("MemorySeenJobsStore.recordRecommended", () => {
  it("keeps the first day and moves the last", async () => {
    const store = await storeWith("2026-09-01", a);
    await store.recordRecommended([a], "2026-10-07");
    expect(store.rows.get(fingerprint(a))).toMatchObject({
      firstSeen: "2026-09-01",
      lastSeen: "2026-10-07",
    });
  });
});
