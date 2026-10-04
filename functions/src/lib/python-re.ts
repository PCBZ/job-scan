// Python's `re` is Unicode-aware for str patterns; JavaScript's is ASCII by
// default. Ports of the Python scripts build their regexes from these so the
// two agree. Use them with the `u` flag (plus `i` where Python used re.I).

/** Python \s: exactly the characters str.isspace() accepts. */
export const PY_SPACE = String.raw`[\t\n\v\f\r \x1c-\x1f\x85\xa0  -     　]`;
/** Python \S. */
export const PY_NON_SPACE = String.raw`[^\t\n\v\f\r \x1c-\x1f\x85\xa0  -     　]`;
/** Python \w. */
export const PY_WORD = String.raw`[\p{L}\p{N}_]`;
/** Python \b, as lookarounds on \w. */
export const PY_BOUNDARY = `(?:(?<=${PY_WORD})(?!${PY_WORD})|(?<!${PY_WORD})(?=${PY_WORD}))`;
/** Python \d. */
export const PY_DIGIT = String.raw`\p{Nd}`;

const EDGE_SPACE = new RegExp(`^${PY_SPACE}+|${PY_SPACE}+$`, "gu");

/** Python str.strip() with no arguments. */
export function pyStrip(value: string): string {
  return value.replace(EDGE_SPACE, "");
}

/** Python len(): counts code points, not UTF-16 units. */
export function pyLen(value: string): number {
  return Array.from(value).length;
}

/** Python value[:n] on a str. */
export function pySlice(value: string, end: number): string {
  return Array.from(value).slice(0, end).join("");
}

/** Python's ordering of str: by code point. */
export function pyCompare(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}
