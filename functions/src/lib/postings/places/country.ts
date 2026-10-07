// What every country provides; places.ts asks each one in turn.

export type Currency = "CAD" | "USD";

export interface Country {
  readonly code: "CA" | "US";
  readonly currency: Currency;
  /** The region's code, from a code ("BC") or a name ("British Columbia"). */
  regionCode(text: string): string | undefined;
  /** Whether the text names the country itself ("Canada", "USA"). */
  isCountry(text: string): boolean;
}

/** A country from its region table: codes are upper case, names any case. */
export function country(
  code: Country["code"],
  currency: Currency,
  names: RegExp,
  regions: Record<string, string>,
): Country {
  const codes = new Set(Object.values(regions));
  return {
    code,
    currency,
    regionCode(text) {
      const t = text.trim();
      return codes.has(t) ? t : regions[t.toLowerCase()];
    },
    isCountry: (text) => names.test(text.trim()),
  };
}
