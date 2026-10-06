import { describe, expect, it } from "vitest";
import { mapWithLimit } from "../../src/lib/workflow/limit.js";

describe("mapWithLimit", () => {
  it("keeps input order and never exceeds the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapWithLimit([30, 5, 20, 1, 10], 2, async (ms, i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, ms));
      inFlight--;
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  it("handles an empty list and rejects a limit below 1", async () => {
    expect(await mapWithLimit([], 3, async () => 1)).toEqual([]);
    await expect(mapWithLimit([1], 0, async () => 1)).rejects.toThrow("limit must be at least 1");
  });
});
