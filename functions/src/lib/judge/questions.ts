// The gates' yes/no questions for Jev (#121), kept as templates in
// prompts/gates.json beside the other prompts, and rendered with Mustache.

import { readFileSync } from "node:fs";
import Mustache from "mustache";

export type QuestionName =
  | "sponsorship"
  | "seniority"
  | "keyword"
  | "commute"
  | "remote"
  | "unlocated";

/** Three levels up from both src/lib/judge and dist/lib/judge. */
const TEMPLATES = JSON.parse(
  readFileSync(new URL("../../../prompts/gates.json", import.meta.url), "utf8"),
) as Record<QuestionName, string>;

/** A question with its values filled in. Plain text: nothing is HTML-escaped. */
export function question(name: QuestionName, view: Record<string, string> = {}): string {
  const template = TEMPLATES[name];
  if (template === undefined) throw new Error(`prompts/gates.json has no "${name}" question`);
  return Mustache.render(template, view, {}, { escape: (value: unknown) => String(value) });
}
