import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/lib/config/load.js";
import { fingerprint } from "../../src/lib/fingerprint.js";
import { dedupeStep, repeatCutoff, splitRepeats } from "../../src/lib/postings/dedupe.js";
import { MemorySeenJobsStore } from "../../src/lib/postings/seen-jobs.js";
import { posting } from "./helpers.js";

const config = (repeat_suppression_days?: number) =>
  ({
    report: repeat_suppression_days === undefined ? {} : { repeat_suppression_days },
  }) as AppConfig;

// 08:00 in Vancouver on 2026-10-07.
const NOW = new Date("2026-10-07T15:00:00Z");

describe("splitRepeats", () => {
  const a = posting({ company: "Lumen Ridge", title: "Backend Engineer" });
  const b = posting({ company: "Saltmarsh Robotics", title: "Platform Engineer" });

  it("keeps first sightings, counts repeats and in-batch duplicates", () => {
    const aAgain = posting({
      company: "Lumen Ridge Inc.",
      title: "Backend Engineer",
      account: "school",
    });
    const out = splitRepeats([a, b, aAgain], new Set());
    expect(out.fresh).toEqual([a, b]);
    expect(out).toMatchObject({ repeats: 0, duplicates: 1 });
  });

  it("counts every sighting of a repeat, so twice in one batch is two repeats", () => {
    const out = splitRepeats([a, a, b], new Set([fingerprint(a)]));
    expect(out.fresh).toEqual([b]);
    expect(out).toMatchObject({ repeats: 2, duplicates: 0 });
  });
});

describe("repeatCutoff", () => {
  it("goes back repeat_suppression_days from the run's day, 30 by default", () => {
    expect(repeatCutoff(config(), NOW)).toBe("2026-09-07");
    expect(repeatCutoff(config(7), NOW)).toBe("2026-09-30");
    expect(repeatCutoff(config(0), NOW)).toBe("2026-10-07");
  });

  it("counts from Vancouver's day when UTC is already on the next one", () => {
    // 23:30 on 2026-10-07 in Vancouver.
    expect(repeatCutoff(config(), new Date("2026-10-08T06:30:00Z"))).toBe("2026-09-07");
  });
});

describe("dedupeStep", () => {
  const job = posting({ company: "Lumen Ridge", title: "Backend Engineer" });

  it("a posting recommended yesterday appears only in today's repeat count", async () => {
    const store = new MemorySeenJobsStore();
    const yesterday = new Date("2026-10-06T15:00:00Z");

    const day1 = await dedupeStep(store, () => yesterday)([job], config());
    expect(day1).toMatchObject({ fresh: [job], repeats: 0 });
    await store.recordRecommended(day1.fresh, "2026-10-06");

    // Same role, with the next board's wording.
    const reworded = posting({ company: "Lumen Ridge Inc", title: "Backend Engineer (Req 12345)" });
    const day2 = await dedupeStep(store, () => NOW)([reworded], config());
    expect(day2).toEqual({ fresh: [], repeats: 1, duplicates: 0 });
  });

  it("holds a repeat back for the whole window, and lets it back the day after", async () => {
    const store = new MemorySeenJobsStore();
    await store.recordRecommended([job], "2026-09-07");
    expect((await dedupeStep(store, () => NOW)([job], config())).repeats).toBe(1);

    const dayAfter = new Date("2026-10-08T15:00:00Z");
    expect((await dedupeStep(store, () => dayAfter)([job], config())).fresh).toEqual([job]);
  });

  it("with a window of 0, only today's recommendations are repeats", async () => {
    const store = new MemorySeenJobsStore();
    await store.recordRecommended([job], "2026-10-06");
    expect((await dedupeStep(store, () => NOW)([job], config(0))).fresh).toEqual([job]);
  });

  it("never records what it only saw: a posting passed over can come back", async () => {
    const store = new MemorySeenJobsStore();
    await dedupeStep(store, () => NOW)([job], config());
    expect(store.rows.size).toBe(0);
  });
});

describe("MemorySeenJobsStore.recordRecommended", () => {
  it("keeps the first day and moves the last", async () => {
    const store = new MemorySeenJobsStore();
    const job = posting();
    await store.recordRecommended([job], "2026-09-01");
    await store.recordRecommended([job], "2026-10-07");
    expect(store.rows.get(fingerprint(job))).toMatchObject({
      firstSeen: "2026-09-01",
      lastSeen: "2026-10-07",
    });
  });
});
