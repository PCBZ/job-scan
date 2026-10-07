import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/lib/config/load.js";
import { fingerprint } from "../../src/lib/fingerprint.js";
import { dedupeStep } from "../../src/lib/postings/dedupe.js";
import { FakeTable, store } from "./fake-table.js";
import { posting } from "./helpers.js";

const config = (repeat_suppression_days?: number) =>
  ({
    report: repeat_suppression_days === undefined ? {} : { repeat_suppression_days },
  }) as AppConfig;

const at = (iso: string) => () => new Date(iso);
// 08:00 in Vancouver on 2026-10-07.
const NOW = at("2026-10-07T15:00:00Z");

const a = posting({ company: "Lumen Ridge", title: "Backend Engineer" });
const b = posting({ company: "Saltmarsh Robotics", title: "Platform Engineer" });

/** Answers recommendedSince with `recent`, and records the cutoff asked for. */
function recentStore(...recent: (typeof a)[]) {
  const asked: string[] = [];
  return {
    asked,
    async recommendedSince(since: string) {
      asked.push(since);
      return new Set(recent.map(fingerprint));
    },
  };
}

describe("dedupeStep", () => {
  it("keeps first sightings and counts in-batch duplicates", async () => {
    const aAgain = posting({
      company: "Lumen Ridge Inc.",
      title: "Backend Engineer",
      account: "school",
    });
    const out = await dedupeStep(recentStore(), NOW)([a, b, aAgain], config());
    expect(out).toEqual({ fresh: [a, b], repeats: 0, duplicates: 1 });
  });

  it("counts every sighting of a repeat, so twice in one batch is two repeats", async () => {
    const out = await dedupeStep(recentStore(a), NOW)([a, a, b], config());
    expect(out).toEqual({ fresh: [b], repeats: 2, duplicates: 0 });
  });

  it("asks for repeat_suppression_days back from the run's day, 30 by default", async () => {
    const s = recentStore();
    for (const days of [undefined, 7, 0]) await dedupeStep(s, NOW)([a], config(days));
    expect(s.asked).toEqual(["2026-09-07", "2026-09-30", "2026-10-07"]);
  });

  it("counts the window from Vancouver's day when UTC is already on the next one", async () => {
    const s = recentStore();
    // 23:30 on 2026-10-07 in Vancouver.
    await dedupeStep(s, at("2026-10-08T06:30:00Z"))([a], config());
    expect(s.asked).toEqual(["2026-09-07"]);
  });

  it("a posting recommended yesterday appears only in today's repeat count", async () => {
    const table = store(new FakeTable());
    const day1 = await dedupeStep(table, at("2026-10-06T15:00:00Z"))([a], config());
    expect(day1).toMatchObject({ fresh: [a], repeats: 0 });
    await table.recordRecommended(day1.fresh, "2026-10-06");

    // Same role, with the next board's wording.
    const reworded = posting({ company: "Lumen Ridge Inc", title: "Backend Engineer (Req 12345)" });
    const day2 = await dedupeStep(table, NOW)([reworded], config());
    expect(day2).toEqual({ fresh: [], repeats: 1, duplicates: 0 });
  });

  it("never records what it only saw: a posting passed over can come back", async () => {
    const fake = new FakeTable();
    await dedupeStep(store(fake), NOW)([a], config());
    expect(fake.calls).toEqual([]);
  });
});
