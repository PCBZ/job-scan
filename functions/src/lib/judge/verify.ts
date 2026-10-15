// The verify_judgements node: a judgement's reasons must be real. Resume quotes
// must be in that resume, and every gap must quote the posting. A variant may have no gap; rank caps it rather than have the model
// invent one. Problems name their posting, so a repair goes back to it only.

import type { Posting } from "../postings/types.js";
import type { ResumeSet } from "../resume/load.js";
import { postingFields } from "./fields.js";
import type { JudgeAnswer } from "./schema.js";

type Fit = JudgeAnswer["variants"][number]["skills"];

export interface Judgement {
  posting: Posting;
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
export const quotes = (text: string, quote: string) =>
  flat(quote) !== "" && flat(text).includes(flat(quote));
/** The quote within one line of the text: the prompts forbid joining lines. */
export const quotesLine = (text: string, quote: string) =>
  text.split("\n").some((line) => quotes(line, quote));
/** The first line of the text that holds the quote; null when none does. */
export const lineOf = (text: string, quote: string) =>
  text
    .split("\n")
    .find((line) => quotes(line, quote))
    ?.trim() ?? null;
/** The same phrase, give or take a few words at either end. */
export const samePhrase = (a: string, b: string) =>
  flat(a) !== "" && flat(b) !== "" && (flat(a).includes(flat(b)) || flat(b).includes(flat(a)));

/** Everything the model was shown about the posting, which a gate may quote. */
export const postingText = (p: Posting) => Object.values(postingFields(p)).flat().join("\n");

export function verifyJudgements(judged: Judgement[], resumes: ResumeSet): string[] {
  const texts = new Map(resumes.variants.map((v) => [v.name, v.text]));
  const names = resumes.variants.map((v) => v.name);
  const problems: string[] = [];
  for (const { posting, answer } of judged) {
    const say = (problem: string) => problems.push(problemAbout(postingId(posting), problem));

    if (answer.variants.map((v) => v.variant).join() !== names.join()) {
      say(`answer one entry per resume, in this order: ${names.join(", ")}`);
    }
    for (const v of answer.variants) {
      const text = texts.get(v.variant) ?? "";
      for (const dim of ["skills", "domain", "seniority"] as const) {
        const { level, evidence } = v[dim];
        if (level !== "none" && !quotesLine(text, evidence)) {
          say(`${v.variant} ${dim}: evidence "${evidence}" is not a line of that resume`);
        }
      }
      for (const dim of ["skills", "domain", "seniority"] as const) {
        const { gap } = v[dim];
        // A gap is one of the posting's requirements, not its title or place.
        if (gap && !quotesLine(posting.requirements.join("\n"), gap)) {
          say(
            `${v.variant} ${dim}: gap "${gap}" is not a requirement the posting states; copy it verbatim, or leave it empty`,
          );
        }
      }
    }
  }
  return problems;
}

/**
 * The judge quotes a short phrase, so its answer costs less (#138); explain,
 * the run record and the report show the whole resume line it came from. A
 * phrase found in no line, left unresolved by the repair loop, stays as it is.
 */
export function fullLines(judged: Judgement[], resumes: ResumeSet): Judgement[] {
  const texts = new Map(resumes.variants.map((v) => [v.name, v.text]));
  const full = (text: string, fit: Fit): Fit =>
    fit.evidence ? { ...fit, evidence: lineOf(text, fit.evidence) ?? fit.evidence } : fit;
  return judged.map(({ posting, answer }) => ({
    posting,
    answer: {
      ...answer,
      variants: answer.variants.map((v) => {
        const text = texts.get(v.variant) ?? "";
        return {
          ...v,
          skills: full(text, v.skills),
          domain: full(text, v.domain),
          seniority: full(text, v.seniority),
        };
      }),
    },
  }));
}
