// The US stock market's trading days (#212): job-scan runs only when NYSE is
// open. NYSE's closures come from one source for both apps, the Python
// `holidays` library: the scanner calls it at run time
// (jobspy-scanner/scanner/market_days.py), and this app reads its closures as
// exported to nyse-closures.ts, which the scanner's tests keep current.

import { addDays } from "./day.js";
import { FIRST_YEAR, LAST_YEAR, NYSE_CLOSURES } from "./nyse-closures.js";

/**
 * The most days from one trading day to the next, around NYSE's scheduled
 * holidays: Thursday to Monday, around a Friday holiday.
 */
export const MAX_TRADING_GAP = 4;

const weekday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();

function covered(year: number): void {
  if (year < FIRST_YEAR || year > LAST_YEAR) {
    throw new Error(
      `NYSE closures cover ${FIRST_YEAR}–${LAST_YEAR}, not ${year}: widen them in jobspy-scanner/scripts/export_closures.py`,
    );
  }
}

/** NYSE's closures in `year`, date to holiday name. */
export function marketHolidays(year: number): Map<string, string> {
  covered(year);
  return new Map(Object.entries(NYSE_CLOSURES).filter(([d]) => d.startsWith(`${year}-`)));
}

/** Why the market is closed on `day` (YYYY-MM-DD), or null when it's open. */
export function marketClosed(day: string): string | null {
  covered(Number(day.slice(0, 4)));
  const dow = weekday(day);
  if (dow === 0 || dow === 6) return "weekend";
  return NYSE_CLOSURES[day] ?? null;
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
