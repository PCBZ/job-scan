// The verify_judgements node: a judgement's reasons must be real. Resume quotes
// must be in that resume, a failed gate must quote the posting, and every
// variant must name a gap. Problems name their posting, so a repair goes back
// to that posting only.

import type { Posting } from "../postings/types.js";
import type { ResumeSet } from "../resume/load.js";
import { postingFields } from "./fields.js";
import type { AskedGate } from "./gates.js";
import type { JudgeAnswer } from "./schema.js";

export interface Judgement {
  posting: Posting;
  /** The gates asked, in order; the answer's gates must match them. */
  asked: AskedGate[];
  answer: JudgeAnswer;
}

/** A posting's id within a run: its message and its row there. */
export const postingId = (p: Posting) => `${p.message_id}#${p.row}`;

const prefixOf = (id: string) => `posting ${JSON.stringify(id)}: `;
export const problemAbout = (id: string, problem: string) => `${prefixOf(id)}${problem}`;
export const problemsAbout = (problems: string[], id: string) =>
  problems.filter((p) => p.startsWith(prefixOf(id)));

/** Case, spacing and surrounding punctuation don't count against a quote. */
const flat = (s: string) =>
  s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "");
const quotes = (text: string, quote: string) =>
  flat(quote) !== "" && flat(text).includes(flat(quote));

/** Everything the model was shown about the posting, which a gate may quote. */
const postingText = (p: Posting) => Object.values(postingFields(p)).flat().join("\n");

export function verifyJudgements(judged: Judgement[], resumes: ResumeSet): string[] {
  const texts = new Map(resumes.variants.map((v) => [v.name, v.text]));
  const names = resumes.variants.map((v) => v.name);
  const problems: string[] = [];
  for (const { posting, asked, answer } of judged) {
    const say = (problem: string) => problems.push(problemAbout(postingId(posting), problem));

    const askedGates = asked.map((g) => g.gate);
    if (answer.gates.map((g) => g.gate).join() !== askedGates.join()) {
      say(`answer exactly these gates, in this order: ${askedGates.join(", ") || "none"}`);
    }
    for (const g of answer.gates) {
      if (g.fails && !quotes(postingText(posting), g.quote)) {
        say(`gate ${g.gate} fails, but its quote "${g.quote}" is not in the posting`);
      }
    }

    if (answer.variants.map((v) => v.variant).join() !== names.join()) {
      say(`answer one entry per resume, in this order: ${names.join(", ")}`);
    }
    for (const v of answer.variants) {
      const text = texts.get(v.variant) ?? "";
      for (const dim of ["skills", "domain", "seniority"] as const) {
        const { level, evidence } = v[dim];
        if (level !== "none" && !quotes(text, evidence)) {
          say(`${v.variant} ${dim}: evidence "${evidence}" is not a line of that resume`);
        }
      }
      if (!v.skills.gap && !v.domain.gap && !v.seniority.gap) {
        say(`${v.variant} names no gap; find one, or lower the levels`);
      }
    }
  }
  return problems;
}
