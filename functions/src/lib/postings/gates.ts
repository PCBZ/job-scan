// The hard_gates node: SKILL.md's gates that code can decide exactly. Each gate
// passes, filters with a reason, or, when code can't tell, keeps the posting
// with a question for Jev to settle in judge (#17). Code never filters on a guess.

import { z } from "zod";
import type { ProfileConfig } from "../config/schema.js";
import type { DeterministicSteps } from "../workflow/types.js";
import { countryOf, regionCode } from "./places.js";
import type { Posting } from "./types.js";

export type Gate = "location" | "salary" | "keyword";

export interface Filtered {
  posting: Posting;
  gate: Gate;
  reason: string;
}

type Verdict = { filter: string } | { ask: string } | { note: string } | null;
type Currency = "CAD" | "USD";

const norm = (s: string) => s.trim().toLowerCase();
const wordIn = (text: string, word: string) =>
  word.trim() !== "" && ` ${norm(text)} `.includes(` ${norm(word)} `);
const listed = (places: string[]) => places.join(", ");

function location(p: Posting, profile: ProfileConfig): Verdict {
  const entries = profile.locations ?? [];
  const places = entries.filter((e) => !/remote/i.test(e));
  // "Remote (US)" scopes remote work to a place.
  const scopes = entries.flatMap((e) => /remote\s*\(([^)]+)\)/i.exec(e)?.[1]?.trim() ?? []);

  if (
    (p.workplace === "remote" || /\bremote\b/i.test(p.location)) &&
    profile.open_to_remote !== false
  ) {
    if (scopes.length === 0 || scopes.some((s) => norm(p.location).includes(norm(s)))) return null;
    return { ask: `Is this remote role open to someone working from ${scopes.join(" or ")}?` };
  }
  if (places.length === 0) return { filter: "not remote, and no locations are listed" };

  const where = p.location.replace(/\([^)]*\)/g, "").trim();
  if (!where) return { ask: `Can this role be worked from ${listed(places)}?` };
  const [city = "", region] = where.split(",").map((s) => s.trim());
  const code = region === undefined ? undefined : regionCode(region);
  // Listed places whose region, where both sides state one, agrees.
  const sameRegion = places
    .map((place) => place.split(",").map((s) => s.trim()))
    .filter(([, pr]) => {
      const pcode = pr === undefined ? undefined : regionCode(pr);
      return code === undefined || pcode === undefined || code === pcode;
    })
    .map(([pc = ""]) => pc);
  if (sameRegion.some((pc) => norm(pc) === norm(city))) return null;
  // Filter only a city placed in a known province, state or country whose name
  // doesn't contain a listed city: "North Vancouver" or "Greater Vancouver
  // Area" may be a commute, so Jev decides those.
  const placed = code !== undefined || countryOf(where.split(",").slice(1).join(",")) !== undefined;
  const near = sameRegion.some((pc) => wordIn(city, pc));
  if (placed && !near) return { filter: `outside locations: ${p.location}` };
  return { ask: `Is "${p.location}" within commuting distance of ${listed(places)}?` };
}

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
  if (!p.salary.includes("$")) return undefined;
  const country = countryOf(p.location);
  return country === "CA" ? "CAD" : country === "US" ? "USD" : undefined;
}

const money = (n: number, c: Currency) =>
  `${c === "CAD" ? "CA$" : "US$"}${Math.round(n).toLocaleString("en-US")}`;

interface Floor {
  amount: number;
  currency: Currency;
}

function floorOf(profile: ProfileConfig): Floor | null {
  if (profile.min_salary !== undefined) {
    return profile.min_salary > 0
      ? { amount: profile.min_salary, currency: profile.salary_currency ?? "USD" }
      : null;
  }
  const usd = profile.min_salary_usd ?? 0;
  return usd > 0 ? { amount: usd, currency: "USD" } : null;
}

/** `cadPerUsd` is undefined when no exchange is needed, null when it failed. */
function salary(p: Posting, floor: Floor | null, cadPerUsd: number | null | undefined): Verdict {
  const top = floor && annualTop(p.salary);
  if (!floor || top === null) return null;
  const from = currencyOf(p);
  if (!from) return { note: "currency unknown" };
  let converted = top;
  if (from !== floor.currency) {
    if (!cadPerUsd) return { note: "no exchange rate" };
    converted = from === "USD" ? top * cadPerUsd : top / cadPerUsd;
  }
  if (converted >= floor.amount) return null;
  const approx = from === floor.currency ? "" : ` (≈ ${money(converted, floor.currency)})`;
  return {
    filter: `salary "${p.salary}"${approx} is below min_salary ${money(floor.amount, floor.currency)}`,
  };
}

function keyword(p: Posting, keywords: string[]): Verdict {
  const fields: [string, string][] = [
    ["title", p.title],
    ["company", p.company],
    ["salary", p.salary],
    ["requirements", p.requirements.join("; ")],
  ];
  for (const k of keywords) {
    const escaped = k.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const phrase = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "iu");
    const hit = fields.find(([, text]) => phrase.test(text));
    if (k.trim() && hit) return { filter: `exclude_keywords: "${k.trim()}" in ${hit[0]}` };
  }
  return null;
}

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

export function hardGatesStep(
  rate: () => Promise<number | null> = usdCad,
): DeterministicSteps["hardGates"] {
  return async (postings, config) => {
    const profile = config.profile;
    const floor = floorOf(profile);
    // Fetch the rate only when some stated salary is in the other currency.
    const needsRate = postings.some((p) => {
      const c = floor && annualTop(p.salary) !== null ? currencyOf(p) : undefined;
      return c !== undefined && c !== floor?.currency;
    });
    const cadPerUsd = needsRate ? await rate() : undefined;

    const kept: Posting[] = [];
    const filtered: Filtered[] = [];
    const unsettled = new Map<string, number>();
    for (const p of postings) {
      const verdicts: [Gate, Verdict][] = [
        ["location", location(p, profile)],
        ["salary", salary(p, floor, cadPerUsd)],
        ["keyword", keyword(p, profile.exclude_keywords ?? [])],
      ];
      const failed = verdicts.find(
        (v): v is [Gate, { filter: string }] => v[1] !== null && "filter" in v[1],
      );
      if (failed) {
        filtered.push({ posting: p, gate: failed[0], reason: failed[1].filter });
        continue;
      }
      const questions = verdicts.flatMap(([, v]) => (v && "ask" in v ? [v.ask] : []));
      for (const [, v] of verdicts) {
        if (v && "note" in v) unsettled.set(v.note, (unsettled.get(v.note) ?? 0) + 1);
      }
      kept.push(questions.length ? { ...p, gate_questions: questions } : p);
    }
    const notes = [...unsettled].map(
      ([why, n]) => `salary not compared for ${n} posting(s): ${why}`,
    );
    return { kept, filtered, notes };
  };
}
