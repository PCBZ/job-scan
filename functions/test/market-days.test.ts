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
import { FIRST_YEAR, LAST_YEAR } from "../src/lib/nyse-closures.js";

// NYSE's published closures, read off its site; the scanner's tests read the same file.
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
  it("has NYSE's published closures", () => {
    for (const year of NYSE.years) {
      const published = Object.keys(NYSE.closures).filter((d) => d.startsWith(`${year}-`));
      expect([...marketHolidays(year).keys()].sort(), String(year)).toEqual(published.sort());
    }
  });

  it("has the special closures NYSE announced", () => {
    expect(marketClosed("2025-01-09")).toBe(
      "National Day of Mourning for former President Jimmy Carter",
    );
  });

  it("observes a Saturday New Year's Day not at all, unlike the other holidays", () => {
    // 2022-01-01 was a Saturday: NYSE opened on 2021-12-31.
    expect(marketClosed("2021-12-31")).toBeNull();
    // A Sunday one moves to Monday: 2023-01-02.
    expect(marketClosed("2023-01-02")).toBe("New Year's Day (observed)");
  });

  it("refuses a year the exported closures don't cover", () => {
    expect(() => marketClosed(`${FIRST_YEAR - 1}-12-31`)).toThrow(/export_closures/);
    expect(() => marketHolidays(LAST_YEAR + 1)).toThrow(/export_closures/);
  });
});

describe("marketClosed", () => {
  it("is open on every other weekday of the published years", () => {
    for (const d of days("2026-01-01", "2028-12-31")) {
      const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
      const want = dow === 0 || dow === 6 ? "weekend" : d in NYSE.closures ? "holiday" : null;
      const got = marketClosed(d);
      expect(got === null || got === "weekend" ? got : "holiday", d).toBe(want);
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
    for (const d of days("2026-01-01", `${LAST_YEAR}-12-31`)) {
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
