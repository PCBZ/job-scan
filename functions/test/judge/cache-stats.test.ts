import { describe, expect, it } from "vitest";
import { JudgementCacheCounts } from "../../src/lib/judge/cache-stats.js";

describe("JudgementCacheCounts (#150)", () => {
  it("starts at nothing, and names its counts as the run line does", () => {
    expect(new JudgementCacheCounts().snapshot(0)).toEqual({
      reused: 0,
      written: 0,
      failed_reads: 0,
      failed_writes: 0,
      request_charge: 0,
    });
    const counts = new JudgementCacheCounts();
    counts.reused += 12;
    counts.written += 30;
    counts.failedReads += 1;
    counts.failedWrites += 2;
    expect(counts.snapshot(214.4567)).toEqual({
      reused: 12,
      written: 30,
      failed_reads: 1,
      failed_writes: 2,
      // Whole centi-units: more digits say nothing about a cost.
      request_charge: 214.46,
    });
  });
});
