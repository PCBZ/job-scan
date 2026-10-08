// Countries a posting's location can name. Each country reads its own regions
// and carries its currency; lookups ask every country in turn.

import { CANADA } from "./places/ca.js";
import type { Country } from "./places/country.js";
import { UNITED_STATES } from "./places/us.js";

export type { Country, Currency } from "./places/country.js";

export const COUNTRIES: readonly Country[] = [CANADA, UNITED_STATES];

/** A region's code in any country. */
export function regionCode(text: string): string | undefined {
  for (const c of COUNTRIES) {
    const code = c.regionCode(text);
    if (code) return code;
  }
  return undefined;
}

/** Whether the text is a region or a country, as a misread company or title can be. */
export function isPlaceName(text: string): boolean {
  return COUNTRIES.some((c) => c.isCountry(text) || c.regionCode(text) !== undefined);
}

/** The country a location names through a region or the country itself. */
export function countryOf(location: string): Country | undefined {
  // Commas, dashes and brackets all separate parts: "Remote - USA",
  // "Vancouver, BC", "Remote (US)"; a note like "(Hybrid)" matches nothing.
  for (const part of location.split(/[,()\-–—/|]/)) {
    const found = COUNTRIES.find((c) => c.isCountry(part) || c.regionCode(part) !== undefined);
    if (found) return found;
  }
  return undefined;
}
