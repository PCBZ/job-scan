// Calendar days for the daily run. The run is in Vancouver's morning, and the
// local skill dates its state in local time, so a "day" is Vancouver's.

export const RUN_TIME_ZONE = "America/Vancouver";

/** The run's day as YYYY-MM-DD, in RUN_TIME_ZONE. */
export function runDay(now: Date, timeZone = RUN_TIME_ZONE): string {
  // en-CA formats a date as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(now);
}

/** `day` moved by `n` calendar days (negative goes back). */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
