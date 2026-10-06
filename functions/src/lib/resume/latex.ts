// Port of scripts/latex_text.py: flatten LaTeX resume source to plain text.
// The walk is brace-aware: formatting macros unwrap, layout macros drop with
// their arguments, and unknown macros keep every argument joined by " | ",
// since in a resume they carry content. tests/fixtures/latex_text.json holds
// the Python results this must reproduce.

import { stripWhitespace, WHITESPACE } from "../unicode.js";

/** Layout and preamble commands: drop the command and everything it wraps. */
const DROP_WITH_ARGS = new Set([
  "documentclass",
  "usepackage",
  "newcommand",
  "renewcommand",
  "providecommand",
  "definecolor",
  "pagestyle",
  "thispagestyle",
  "fancyhf",
  "fancyfoot",
  "fancyhead",
  "titleformat",
  "titlespacing",
  "setlength",
  "addtolength",
  "vspace",
  "hspace",
  "includegraphics",
  "hypersetup",
  "geometry",
  "input",
  "include",
  "label",
  "ref",
  "pagenumbering",
  "urlstyle",
  "raggedbottom",
  "raggedright",
  "newlength",
  "setcounter",
  "AtBeginDocument",
  "phantom",
  "vphantom",
  "hphantom",
  "rule",
  "raisebox",
]);

/** Fixed arity, so a following brace group is content, not another argument. */
const ARITY: Record<string, number> = {
  textbf: 1,
  textit: 1,
  emph: 1,
  underline: 1,
  texttt: 1,
  textsc: 1,
  textrm: 1,
  textsf: 1,
  text: 1,
  mbox: 1,
  small: 1,
  large: 1,
  Large: 1,
  LARGE: 1,
  huge: 1,
  Huge: 1,
  footnotesize: 1,
  scriptsize: 1,
  normalsize: 1,
  section: 1,
  subsection: 1,
  subsubsection: 1,
  paragraph: 1,
  href: 2,
  textcolor: 2,
  colorbox: 2,
  begin: 1,
  end: 1,
  raisebox: 1,
};

/** Argument-less spacing and font switches: replace with a single space. */
const DROP_BARE = new Set([
  "scshape",
  "bfseries",
  "itshape",
  "rmfamily",
  "sffamily",
  "ttfamily",
  "centering",
  "hfill",
  "vfill",
  "noindent",
  "clearpage",
  "newpage",
  "quad",
  "qquad",
  "ldots",
  "dots",
  "smallskip",
  "medskip",
  "bigskip",
  "linebreak",
  "newline",
  "par",
  "leavevmode",
  "strut",
]);

const CMD = /\\([A-Za-z]+)\*?/y;
const ESCAPED = new Set("&%$#_{}");

function stripComments(src: string): string {
  return src.replace(/(?<!\\)%.*/g, "");
}

/** Everything before \begin{document} is macro plumbing, not content. */
function stripPreamble(src: string): string {
  const marker = "\\begin{document}";
  const idx = src.indexOf(marker);
  return idx === -1 ? src : src.slice(idx + marker.length);
}

/** src[i] must be "{". Returns the inner text and the index after the closing brace. */
function readGroup(src: string, start: number): [string, number] {
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return [src.slice(start + 1, i), i + 1];
    }
    i++;
  }
  return [src.slice(start + 1), src.length];
}

/** Following {...} groups, skipping [...] optional arguments. */
function collectArgs(src: string, from: number, limit: number | undefined): [string[], number] {
  const args: string[] = [];
  let i = from;
  while (i < src.length) {
    if (limit !== undefined && args.length >= limit) break;
    let j = i;
    while (j < src.length && " \t\n".includes(src[j] as string)) j++;
    if (j >= src.length) break;
    if (src[j] === "[") {
      const close = src.indexOf("]", j);
      if (close === -1) break;
      i = close + 1;
      continue;
    }
    if (src[j] === "{") {
      const [inner, next] = readGroup(src, j);
      args.push(inner);
      i = next;
      continue;
    }
    break;
  }
  return [args, i];
}

function emit(name: string, args: string[]): string {
  const lower = name.toLowerCase();
  if (DROP_WITH_ARGS.has(name)) return " ";
  if (name === "begin" || name === "end") return "\n";
  if (DROP_BARE.has(name)) return " ";

  const rendered = args.map((a) => stripWhitespace(render(a))).filter((r) => r !== "");

  if (lower === "section" || lower === "subsection" || lower === "subsubsection") {
    return `\n\n## ${rendered[0] ?? ""}\n`;
  }
  if (lower === "href" || lower === "url") return rendered.at(-1) ?? "";
  if (lower === "textcolor" && rendered.length === 2) return rendered[1] as string;
  if (lower === "item" || lower.endsWith("item")) {
    return rendered.length > 0 ? `\n- ${rendered.join(" ")}` : "\n- ";
  }
  if (rendered.length === 0) return " ";
  if (rendered.length === 1) return rendered[0] as string;
  // Unknown multi-argument macro: a content carrier (subheading, project entry).
  return `\n${rendered.join(" | ")}`;
}

function render(src: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === "\\") {
      const next = src[i + 1];
      if (next !== undefined && ESCAPED.has(next)) {
        out.push(next);
        i += 2;
        continue;
      }
      if (next === "\\") {
        out.push("\n");
        i += 2;
        continue;
      }
      CMD.lastIndex = i;
      const match = CMD.exec(src);
      if (!match) {
        i++;
        continue;
      }
      const name = match[1] as string;
      let args: string[] = [];
      i = CMD.lastIndex;
      if (!DROP_BARE.has(name)) [args, i] = collectArgs(src, i, ARITY[name]);
      out.push(emit(name, args));
      continue;
    }
    if (c === "{" || c === "}" || c === "$") {
      i++;
      continue;
    }
    if (c === "~" || c === "&") {
      out.push(" ");
      i++;
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join("");
}

const PUNCTUATION_ONLY = new RegExp(`^(?:[-|,.:;·•]|${WHITESPACE})*$`, "u");

function tidy(text: string): string {
  const collapsed = text
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n");
  const lines = collapsed
    .split("\n")
    .map(stripWhitespace)
    // Drop lines that are pure leftover punctuation from stripped macros.
    .filter((ln) => ln !== "" && !PUNCTUATION_ONLY.test(ln));
  return stripWhitespace(lines.join("\n"));
}

export function latexToText(src: string): string {
  return tidy(render(stripPreamble(stripComments(src))));
}
