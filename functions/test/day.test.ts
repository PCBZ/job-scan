import { describe, expect, it } from "vitest";
import { addDays, runDay } from "../src/lib/day.js";

describe("runDay", () => {
  it("is Vancouver's date, not UTC's", () => {
    // The 08:00 run (15:00 UTC).
    expect(runDay(new Date("2026-10-07T15:00:00Z"))).toBe("2026-10-07");
    // 23:30 in Vancouver is already the next day in UTC.
    expect(runDay(new Date("2026-10-08T06:30:00Z"))).toBe("2026-10-07");
  });
});

describe("addDays", () => {
  it.each([
    ["2026-10-07", -30, "2026-09-07"],
    ["2026-10-07", 0, "2026-10-07"],
    ["2026-01-01", -1, "2025-12-31"],
    ["2028-03-01", -1, "2028-02-29"],
    ["2026-02-28", 1, "2026-03-01"],
  ])("%s %+d → %s", (day, n, out) => {
    expect(addDays(day, n)).toBe(out);
  });
});
