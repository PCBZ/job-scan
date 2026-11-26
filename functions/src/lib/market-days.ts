// The US stock market's trading days (#212): job-scan runs only when NYSE is
// open. Computed from NYSE's holiday rules, so there's no list to keep up to
// date; unscheduled closures (a national day of mourning, a storm) can't be
// foreseen and so are trading days here. The scanner has the same rules in
// Python (jobspy-scanner/scanner/market_days.py); both test suites check theirs
// against NYSE's published closures (jobspy-scanner/tests/fixtures/nyse-closures.json).

import { addDays } from "./day.js";

/** The most days from one trading day to the next: Thursday to Monday, around a Friday holiday. */
export const MAX_TRADING_GAP = 4;

const weekday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();
const ymd = (year: number, month: number, date: number) =>
  `${year}-${String(month).padStart(2, "0")}-${String(date).padStart(2, "0")}`;

/** The `n`th `dow` (0 is Sunday) of `month`; `n` of -1 is the last. */
function nth(year: number, month: number, dow: number, n: number): string {
  if (n > 0) {
    const first = ymd(year, month, 1);
    return addDays(first, ((dow - weekday(first) + 7) % 7) + 7 * (n - 1));
  }
  const last = addDays(ymd(month === 12 ? year + 1 : year, (month % 12) + 1, 1), -1);
  return addDays(last, -((weekday(last) - dow + 7) % 7));
}

/** Easter Sunday, by the anonymous Gregorian algorithm. */
function easter(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  return ymd(year, month, ((h + l - 7 * m + 114) % 31) + 1);
}

/**
 * A fixed-date holiday's day off: Saturday's moves to the Friday before and
 * Sunday's to the Monday after. NYSE doesn't observe a Saturday New Year's Day
 * on Dec 31, so that one has no day off at all.
 */
function observed(day: string, newYear = false): string | null {
  const dow = weekday(day);
  if (dow === 6) return newYear ? null : addDays(day, -1);
  if (dow === 0) return addDays(day, 1);
  return day;
}

/** NYSE's closures in `year`, date to holiday name. */
export function marketHolidays(year: number): Map<string, string> {
  const days: [string | null, string][] = [
    [observed(ymd(year, 1, 1), true), "New Year's Day"],
    [nth(year, 1, 1, 3), "Martin Luther King Jr. Day"],
    [nth(year, 2, 1, 3), "Washington's Birthday"],
    [addDays(easter(year), -2), "Good Friday"],
    [nth(year, 5, 1, -1), "Memorial Day"],
    // A market holiday from 2022.
    [year >= 2022 ? observed(ymd(year, 6, 19)) : null, "Juneteenth"],
    [observed(ymd(year, 7, 4)), "Independence Day"],
    [nth(year, 9, 1, 1), "Labor Day"],
    [nth(year, 11, 4, 4), "Thanksgiving"],
    [observed(ymd(year, 12, 25)), "Christmas"],
  ];
  return new Map(days.filter((d): d is [string, string] => d[0] !== null));
}

/** Why the market is closed on `day` (YYYY-MM-DD), or null when it's open. */
export function marketClosed(day: string): string | null {
  const dow = weekday(day);
  if (dow === 0 || dow === 6) return "weekend";
  return marketHolidays(Number(day.slice(0, 4))).get(day) ?? null;
}

/** The last trading day before `day`. */
export function previousTradingDay(day: string): string {
  let d = addDays(day, -1);
  while (marketClosed(d)) d = addDays(d, -1);
  return d;
}

/** Days since the last trading day: 1 on most days, 3 on a Monday, 4 after a Friday holiday. */
export function tradingGap(day: string): number {
  return Math.round(
    (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${previousTradingDay(day)}T00:00:00Z`)) /
      86_400_000,
  );
}

/** Whether `day` is its week's first trading day: Monday, or Tuesday after a Monday holiday. */
export function isFirstTradingDayOfWeek(day: string): boolean {
  const monday = addDays(day, -((weekday(day) + 6) % 7));
  return !marketClosed(day) && previousTradingDay(day) < monday;
}
