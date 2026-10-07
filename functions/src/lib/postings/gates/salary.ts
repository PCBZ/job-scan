// The salary gate: the top of the stated band, annualized and converted into
// the floor's currency at the Bank of Canada's daily rate. An unknown currency
// or a missing rate is noted, never filtered.

import { z } from "zod";
import type { ProfileConfig } from "../../config/schema.js";
import { type Currency, countryOf } from "../places.js";
import type { Posting } from "../types.js";
import { PASS, type Rule } from "./rules.js";

const AMOUNT = /(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k)?\b/gi;

/** The top of the stated band as an annual amount, or null when there is none. */
export function annualTop(salary: string): number | null {
  const amounts = [...salary.matchAll(AMOUNT)].map(
    ([, n = "", k]) => Number(n.replaceAll(",", "")) * (k ? 1000 : 1),
  );
  if (amounts.length === 0) return null;
  const per = /\b(hour|hr)\b|hourly/i.test(salary)
    ? 2080
    : /\b(month|mo)\b|monthly/i.test(salary)
      ? 12
      : 1;
  const annual = Math.max(...amounts) * per;
  // Below this the number is a rate or a range we didn't read right.
  return annual >= 10_000 ? annual : null;
}

/** From an explicit marker, else a bare "$" read through the location's country. */
export function currencyOf(p: Posting): Currency | undefined {
  if (/\bCAD\b|\bCA?\$/.test(p.salary)) return "CAD";
  if (/\bUSD\b|\bUS\$/.test(p.salary)) return "USD";
  return p.salary.includes("$") ? countryOf(p.location)?.currency : undefined;
}

export interface Floor {
  amount: number;
  currency: Currency;
}

export function floorOf(profile: ProfileConfig): Floor | null {
  if (profile.min_salary !== undefined) {
    return profile.min_salary > 0
      ? { amount: profile.min_salary, currency: profile.salary_currency ?? "USD" }
      : null;
  }
  const usd = profile.min_salary_usd ?? 0;
  return usd > 0 ? { amount: usd, currency: "USD" } : null;
}

const money = (n: number, c: Currency) =>
  `${c === "CAD" ? "CA$" : "US$"}${Math.round(n).toLocaleString("en-US")}`;

interface SalaryFacts {
  salary: string;
  /** A floor is set and the posting states an amount. */
  applies: boolean;
  floor: Floor;
  currency: Currency | undefined;
  /** The band's top in the floor's currency; null when no rate was had. */
  converted: number | null;
  exchanged: boolean;
}

/** What one unit of `from` is worth in the other currency; null without a rate. */
function exchangeRate(from: Currency, cadPerUsd: number | null): number | null {
  if (cadPerUsd === null) return null;
  return from === "USD" ? cadPerUsd : 1 / cadPerUsd;
}

export function salaryFacts(
  p: Posting,
  floor: Floor | null,
  cadPerUsd: number | null,
): SalaryFacts {
  const top = annualTop(p.salary);
  const currency = currencyOf(p);
  const exchanged = currency !== undefined && floor !== null && currency !== floor.currency;
  const rate = exchanged ? exchangeRate(currency, cadPerUsd) : 1;
  return {
    salary: p.salary,
    applies: floor !== null && top !== null,
    floor: floor ?? { amount: 0, currency: "USD" },
    currency,
    converted: top === null || rate === null ? null : top * rate,
    exchanged,
  };
}

export const SALARY: readonly Rule<SalaryFacts>[] = [
  [(f) => !f.applies, PASS],
  [(f) => f.currency === undefined, { note: "currency unknown" }],
  [(f) => f.converted === null, { note: "no exchange rate" }],
  [
    (f) => (f.converted ?? 0) < f.floor.amount,
    (f) => ({
      fail:
        `salary "${f.salary}"` +
        (f.exchanged ? ` (≈ ${money(f.converted ?? 0, f.floor.currency)})` : "") +
        ` is below min_salary ${money(f.floor.amount, f.floor.currency)}`,
    }),
  ],
];

export const USD_CAD_URL = "https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?recent=1";
const valet = z.object({
  observations: z.array(z.object({ FXUSDCAD: z.object({ v: z.string() }) })).min(1),
});

/** Bank of Canada's latest daily USD/CAD rate, or null when it can't be had. */
export async function usdCad(fetchFn: typeof fetch = fetch): Promise<number | null> {
  try {
    const res = await fetchFn(USD_CAD_URL);
    if (!res.ok) return null;
    const rate = Number(valet.parse(await res.json()).observations[0]?.FXUSDCAD.v);
    return rate > 0 ? rate : null;
  } catch {
    return null;
  }
}
