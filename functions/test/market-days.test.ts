import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addDays } from "../src/lib/day.js";
import {
  isFirstTradingDayOfWeek,
  MAX_TRADING_GAP,
  marketClosed,
  marketHolidays,
  previousTradingDay,
  tradingGap,
} from "../src/lib/market-days.js";

// NYSE's published closures; the scanner's tests read the same file.
const NYSE: { years: number[]; closures: Record<string, string> } = JSON.parse(
  readFileSync(
    new URL("../../jobspy-scanner/tests/fixtures/nyse-closures.json", import.meta.url),
    "utf8",
  ),
);

function* days(from: string, to: string) {
  for (let d = from; d <= to; d = addDays(d, 1)) yield d;
}

describe("marketHolidays", () => {
  it("matches NYSE's published closures, name for name", () => {
    for (const year of NYSE.years) {
      const published = Object.entries(NYSE.closures).filter(([d]) => d.startsWith(`${year}-`));
      expect([...marketHolidays(year)].sort(), String(year)).toEqual(published.sort());
    }
  });

  it("finds Good Friday from Easter", () => {
    // Easter fell on 2019-04-21, 2024-03-31, 2025-04-20 and 2038-04-25.
    const goodFriday = (y: number) =>
      [...marketHolidays(y)].find(([, name]) => name === "Good Friday")?.[0];
    expect([2019, 2024, 2025, 2038].map(goodFriday)).toEqual([
      "2019-04-19",
      "2024-03-29",
      "2025-04-18",
      "2038-04-23",
    ]);
  });

  it("observes a Saturday New Year's Day not at all, unlike the other holidays", () => {
    // 2022-01-01 was a Saturday: NYSE opened on 2021-12-31.
    expect(marketClosed("2021-12-31")).toBeNull();
    expect([...marketHolidays(2022).keys()]).not.toContain("2021-12-31");
    // A Sunday one moves to Monday: 2023-01-02.
    expect(marketClosed("2023-01-02")).toBe("New Year's Day");
  });
});

describe("marketClosed", () => {
  it("is open on every other weekday of the published years", () => {
    for (const d of days("2026-01-01", "2028-12-31")) {
      const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
      const want = dow === 0 || dow === 6 ? "weekend" : (NYSE.closures[d] ?? null);
      expect(marketClosed(d), d).toBe(want);
    }
  });

  it("runs on federal holidays NYSE trades through, and on its early closes", () => {
    // Columbus Day, Veterans Day, the day after Thanksgiving.
    expect(["2026-10-12", "2026-11-11", "2026-11-27"].map(marketClosed)).toEqual([
      null,
      null,
      null,
    ]);
  });
});

describe("previousTradingDay and tradingGap", () => {
  it("steps back over weekends and holidays", () => {
    const cases: [string, string, number][] = [
      ["2026-11-25", "2026-11-24", 1], // a Wednesday
      ["2026-11-30", "2026-11-27", 3], // a Monday
      ["2026-11-27", "2026-11-25", 2], // after Thanksgiving
      ["2026-01-20", "2026-01-16", 4], // after Martin Luther King Jr. Day
      ["2026-04-06", "2026-04-02", 4], // after Good Friday
    ];
    for (const [day, previous, gap] of cases) {
      expect([previousTradingDay(day), tradingGap(day)], day).toEqual([previous, gap]);
    }
  });

  it("never exceeds MAX_TRADING_GAP from one trading day to the next", () => {
    let most = 0;
    for (const d of days("2026-01-01", "2060-12-31")) {
      if (!marketClosed(d)) most = Math.max(most, tradingGap(d));
    }
    expect(most).toBe(MAX_TRADING_GAP);
  });
});

describe("isFirstTradingDayOfWeek", () => {
  it("is Monday, or Tuesday after a Monday holiday", () => {
    expect(["2026-11-30", "2026-12-01"].map(isFirstTradingDayOfWeek)).toEqual([true, false]);
    // 2026-09-07 is Labor Day.
    expect(["2026-09-08", "2026-09-09"].map(isFirstTradingDayOfWeek)).toEqual([true, false]);
  });
});
