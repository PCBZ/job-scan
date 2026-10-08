// The location gate: remote work within any "Remote (X)" scope, otherwise a
// listed city. Areas and near-misses ("Lower Mainland", "North Vancouver") are
// questions, never failures.

import type { ProfileConfig } from "../../config/schema.js";
import { countryOf, regionCode } from "../places.js";
import type { Posting } from "../types.js";
import { PASS, type Rule } from "./rules.js";

const norm = (s: string) => s.trim().toLowerCase();
const wordIn = (text: string, word: string) =>
  word.trim() !== "" && ` ${norm(text)} `.includes(` ${norm(word)} `);

interface LocationFacts {
  location: string;
  /** The location without "(Hybrid)"-style notes. */
  where: string;
  remote: boolean;
  openToRemote: boolean;
  /** "Remote (US)" entries: where remote work must be from. */
  scopes: string[];
  inScope: boolean;
  /** Listed places that aren't remote scopes. */
  places: string[];
  /** The city is listed, with the region too where both sides state one. */
  listed: boolean;
  /** The location names a known region or country. */
  placed: boolean;
  /** The city's name contains a listed city: "North Vancouver". */
  near: boolean;
}

const words = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, " ");

/**
 * A remote posting is within a scope like "Remote (US)" when both name the
 * same country ("United States (Remote)", "Seattle, WA"); a scope that isn't a
 * country ("EMEA") must appear as whole words, so "Australia" isn't "US".
 */
function inScope(location: string, scope: string): boolean {
  const country = countryOf(scope);
  if (country) return countryOf(location) === country;
  return wordIn(words(location), words(scope));
}

export function locationFacts(p: Posting, profile: ProfileConfig): LocationFacts {
  const entries = profile.locations ?? [];
  const scopes = entries.flatMap((e) => /remote\s*\(([^)]+)\)/i.exec(e)?.[1]?.trim() ?? []);
  const places = entries.filter((e) => !/remote/i.test(e));
  const where = p.location.replace(/\([^)]*\)/g, "").trim();
  const [city = "", ...rest] = where.split(",").map((s) => s.trim());
  const code = rest[0] === undefined ? undefined : regionCode(rest[0]);
  // Listed cities whose region, where both sides state one, agrees.
  const cities = places
    .map((place) => place.split(",").map((s) => s.trim()))
    .filter(([, pr]) => {
      const listedCode = pr === undefined ? undefined : regionCode(pr);
      return code === undefined || listedCode === undefined || code === listedCode;
    })
    .map(([pc = ""]) => pc);
  return {
    location: p.location,
    where,
    remote: p.workplace === "remote" || /\bremote\b/i.test(p.location),
    openToRemote: profile.open_to_remote !== false,
    scopes,
    inScope: scopes.length === 0 || scopes.some((s) => inScope(p.location, s)),
    places,
    listed: cities.some((c) => norm(c) === norm(city)),
    placed: code !== undefined || countryOf(rest.join(",")) !== undefined,
    near: cities.some((c) => wordIn(city, c)),
  };
}

export const LOCATION: readonly Rule<LocationFacts>[] = [
  [(f) => f.remote && f.openToRemote && f.inScope, PASS],
  [
    (f) => f.remote && f.openToRemote,
    (f) => ({ ask: `Is this remote role open to someone working from ${f.scopes.join(" or ")}?` }),
  ],
  [(f) => f.places.length === 0, { fail: "not remote, and no locations are listed" }],
  [(f) => f.where === "", (f) => ({ ask: `Can this role be worked from ${f.places.join(", ")}?` })],
  [(f) => f.listed, PASS],
  [(f) => f.placed && !f.near, (f) => ({ fail: `outside locations: ${f.location}` })],
  [
    () => true,
    (f) => ({
      ask: `Is "${f.location}" within commuting distance of ${f.places.join(", ")}?`,
    }),
  ],
];
