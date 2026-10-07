import type { Source } from "./types.js";

const VENDORS: [Source, RegExp][] = [
  ["linkedin", /(^|[@.])linkedin\.com>?$/i],
  ["indeed", /(^|[@.])indeed\.(com|ca)>?$/i],
  ["glassdoor", /(^|[@.])glassdoor\.(com|ca)>?$/i],
];

/** The job board a message came from, by its sender's domain. */
export function sourceOf(from: string): Source {
  const address = from.trim().split(/\s+/).at(-1) ?? "";
  for (const [source, domain] of VENDORS) if (domain.test(address)) return source;
  return "other";
}
