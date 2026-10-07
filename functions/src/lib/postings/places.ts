// Canadian provinces and US states, for reading a posting's location.

const PROVINCES: Record<string, string> = {
  alberta: "AB",
  "british columbia": "BC",
  manitoba: "MB",
  "new brunswick": "NB",
  "newfoundland and labrador": "NL",
  "northwest territories": "NT",
  "nova scotia": "NS",
  nunavut: "NU",
  ontario: "ON",
  "prince edward island": "PE",
  quebec: "QC",
  saskatchewan: "SK",
  yukon: "YT",
};
const CA_CODES = new Set(Object.values(PROVINCES));
const US_CODES = new Set(
  (
    "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT " +
    "NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY"
  ).split(" "),
);

/** Every province and state code. */
export const PLACE_CODES = new Set([...CA_CODES, ...US_CODES]);
/** Province and country names, as a location (or a misread company) spells them. */
export const PLACE_NAMES = new Set([...Object.keys(PROVINCES), "canada", "united states", "usa"]);

/** A region's code, from a code ("BC") or a province name ("British Columbia"). */
export function regionCode(region: string): string | undefined {
  const r = region.trim();
  return PLACE_CODES.has(r) ? r : PROVINCES[r.toLowerCase()];
}

/** The country a location names through a province, state or country, if any. */
export function countryOf(location: string): "CA" | "US" | undefined {
  for (const part of location.replace(/\([^)]*\)/g, "").split(",")) {
    const p = part.trim();
    if (p.toLowerCase() === "canada" || CA_CODES.has(regionCode(p) ?? "")) return "CA";
    if (/^(united states|usa|us)$/i.test(p) || US_CODES.has(p)) return "US";
  }
  return undefined;
}
