// Unicode-aware text rules for regexes and strings. JavaScript regexes are
// ASCII by default, while the Python scripts these modules port (and must
// match) treat whitespace, word characters and digits as Unicode. Use the
// classes with the `u` flag, plus `i` for case-insensitive matching.

/** Whitespace: exactly the characters Python's str.isspace() accepts. */
export const WHITESPACE = String.raw`[\t\n\v\f\r \x1c-\x1f\x85\xa0  -     　]`;
/** Anything but WHITESPACE. */
export const NON_WHITESPACE = String.raw`[^\t\n\v\f\r \x1c-\x1f\x85\xa0  -     　]`;
/** A letter, number or underscore in any script. */
export const WORD_CHAR = String.raw`[\p{L}\p{N}_]`;
/** A word boundary over WORD_CHAR, written as lookarounds. */
export const WORD_BOUNDARY = `(?:(?<=${WORD_CHAR})(?!${WORD_CHAR})|(?<!${WORD_CHAR})(?=${WORD_CHAR}))`;
/** A decimal digit in any script. */
export const DIGIT = String.raw`\p{Nd}`;

const EDGE_WHITESPACE = new RegExp(`^${WHITESPACE}+|${WHITESPACE}+$`, "gu");

/** Trim WHITESPACE from both ends. */
export function stripWhitespace(value: string): string {
  return value.replace(EDGE_WHITESPACE, "");
}

/** Length in code points, not UTF-16 units. */
export function codePointLength(value: string): number {
  return Array.from(value).length;
}

/** The first `end` code points. */
export function sliceCodePoints(value: string, end: number): string {
  return Array.from(value).slice(0, end).join("");
}

/** Order strings by code point, not by UTF-16 unit. */
export function compareCodePoints(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}
