// The post-processing resume_text.text_for applies to every extracted
// variant: right-strip each line, collapse runs of blank lines.

import { WHITESPACE } from "../unicode.js";

// Python's str.splitlines() boundaries, not just "\n".
// biome-ignore lint/suspicious/noControlCharactersInRegex: splitlines() also breaks on \x1c-\x1e
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u;
// biome-ignore lint/suspicious/noControlCharactersInRegex: as LINE_BREAK, anchored at the end
const ENDS_WITH_BREAK = /(?:\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029])$/u;
const TRAILING = new RegExp(`${WHITESPACE}+$`, "u");

/** Python's str.splitlines(): no trailing empty line for a final break. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(LINE_BREAK);
  if (ENDS_WITH_BREAK.test(text)) lines.pop();
  return lines;
}

export function normalizeResumeText(text: string): string {
  let out = splitLines(text)
    .map((ln) => ln.replace(TRAILING, ""))
    .join("\n");
  while (out.includes("\n\n\n")) out = out.replaceAll("\n\n\n", "\n\n");
  return out;
}
