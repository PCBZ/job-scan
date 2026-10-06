// LaTeX resume source → plain text, on unified-latex's AST.
//
// The parser handles the syntax: groups, comments, escapes, optional
// arguments. Custom macros get their arguments from the document's own
// \newcommand definitions, so `\resumeSubheading{A}{B}{C}{D}` arrives with
// four arguments instead of four loose groups. What remains here is how each
// kind of macro reads in a resume: layout drops, formatting unwraps, and an
// unknown macro with several arguments keeps them all as "a | b | c", since
// in a resume those carry content (subheadings, project entries).

import type * as Ast from "@unified-latex/unified-latex-types";
import { attachMacroArgs } from "@unified-latex/unified-latex-util-arguments";
import { listNewcommands } from "@unified-latex/unified-latex-util-macros";
import { parse } from "@unified-latex/unified-latex-util-parse";
import { stripWhitespace, WHITESPACE } from "../unicode.js";

/**
 * Layout commands: drop the command and everything it wraps. The parser knows
 * `\vspace{-4pt}` has one argument, not that the argument is a length rather
 * than resume text; unified-latex's own renderers leak several of these
 * (\raisebox, \setlength). Only body content is rendered, so commands that
 * LaTeX allows in the preamble alone aren't listed.
 */
const DROP_WITH_ARGS = new Set([
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
  "input",
  "include",
  "label",
  "ref",
  "pagenumbering",
  "urlstyle",
  "newlength",
  "setcounter",
  "phantom",
  "vphantom",
  "hphantom",
  "rule",
  "raisebox",
]);

const LINE_BREAKS = new Set(["\\", "newline", "linebreak"]);
const HEADINGS = new Set(["section", "subsection", "subsubsection"]);
/** Characters LaTeX escapes with a backslash; the macro's name is the character. */
const ESCAPED = new Set(["&", "%", "$", "#", "_", "{", "}"]);

/** A string node holding exactly `text`. */
function isString(node: Ast.Node | undefined, text: string): boolean {
  return node?.type === "string" && node.content === text;
}

/**
 * A macro the parser knows no signature for (defined in a .cls or an
 * \input'd file) arrives with no arguments and its {...} groups as siblings.
 * Take those groups as its arguments, skipping whitespace and [...] options,
 * the way TeX would read them.
 */
function gatherArgs(nodes: Ast.Node[], from: number): { groups: Ast.Group[]; next: number } {
  const groups: Ast.Group[] = [];
  let i = from;
  let next = from;
  while (i < nodes.length) {
    const node = nodes[i] as Ast.Node;
    if (node.type === "whitespace") {
      i++;
    } else if (isString(node, "[")) {
      const close = nodes.findIndex((n, k) => k > i && isString(n, "]"));
      if (close === -1) break;
      i = close + 1;
    } else if (node.type === "group") {
      groups.push(node);
      i++;
      next = i;
    } else {
      break;
    }
  }
  return { groups, next };
}

function renderAll(nodes: Ast.Node[]): string {
  let out = "";
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i] as Ast.Node;
    if (node.type === "macro" && node.args === undefined && takesLooseGroups(node.content)) {
      const { groups, next } = gatherArgs(nodes, i + 1);
      if (groups.length > 0) {
        const args = groups.map(
          (g): Ast.Argument => ({
            type: "argument",
            openMark: "{",
            closeMark: "}",
            content: g.content,
          }),
        );
        out += renderMacro({ ...node, args });
        i = next - 1;
        continue;
      }
    }
    out += renderNode(node);
  }
  return out;
}

function takesLooseGroups(name: string): boolean {
  return !ESCAPED.has(name) && !LINE_BREAKS.has(name);
}

/** A starred command's star: an argument with no delimiters holding just "*". */
function isStar(arg: Ast.Argument): boolean {
  return arg.openMark === "" && arg.content.length === 1 && isString(arg.content[0], "*");
}

/**
 * Arguments that carry content: braced ones, and the undelimited body the
 * parser gives \item. Optional [...] arguments and a command's star are not.
 */
function contentArgs(macro: Ast.Macro): string[] {
  return (macro.args ?? [])
    .filter((a) => a.openMark !== "[" && !isStar(a))
    .map((a) => trimInline(renderAll(a.content)))
    .filter((t) => stripWhitespace(t) !== "");
}

/**
 * Trim spaces but keep line breaks: an \item wrapped in another macro
 * (`\small{\item{...}}`) must still start its own line.
 */
function trimInline(text: string): string {
  return text.replace(/^[ \t\xa0]+|[ \t\xa0]+$/g, "");
}

function renderMacro(macro: Ast.Macro): string {
  const name = macro.content;
  if (ESCAPED.has(name)) return name;
  if (LINE_BREAKS.has(name)) return "\n";
  if (DROP_WITH_ARGS.has(name)) return " ";

  const lower = name.toLowerCase();
  const args = contentArgs(macro);
  if (HEADINGS.has(lower)) return `\n\n## ${args[0] ?? ""}\n`;
  if (lower === "href" || lower === "url") return args.at(-1) ?? "";
  if ((lower === "textcolor" || lower === "colorbox") && args.length === 2)
    return args[1] as string;
  if (lower === "item" || lower.endsWith("item")) return `\n- ${args.join(" ")}`;
  if (args.length === 0) return " ";
  if (args.length === 1) return args[0] as string;
  return `\n${args.join(" | ")}`;
}

function renderNode(node: Ast.Node): string {
  switch (node.type) {
    case "string":
      // "~" is a non-breaking space; a bare "&" is a tabular column break;
      // a brace left as text is an unbalanced group.
      if (node.content === "~" || node.content === "&") return " ";
      return node.content === "{" || node.content === "}" ? "" : node.content;
    case "whitespace":
      return " ";
    case "parbreak":
      return "\n\n";
    case "comment":
      // A comment swallows the line break that ends it; give it back.
      return "\n";
    case "macro":
      return renderMacro(node);
    case "environment":
    case "mathenv":
      // Environment options ([leftmargin=…]) are attached to the node, not content.
      return `\n${renderAll(node.content)}\n`;
    case "group":
    case "inlinemath":
    case "displaymath":
    case "root":
      return renderAll(node.content);
    case "verbatim":
      return node.content;
    default:
      return "";
  }
}

const PUNCTUATION_ONLY = new RegExp(`^(?:[-|,.:;·•]|${WHITESPACE})*$`, "u");

function tidy(text: string): string {
  const lines = text
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map(stripWhitespace)
    // Lines left holding only punctuation from stripped macros.
    .filter((ln) => ln !== "" && !PUNCTUATION_ONLY.test(ln));
  return stripWhitespace(lines.join("\n"));
}

/** The body of \begin{document}…\end{document}, or the whole source without one. */
function documentBody(root: Ast.Root): Ast.Node[] {
  const doc = root.content.find(
    (n): n is Ast.Environment => n.type === "environment" && n.env === "document",
  );
  return doc ? doc.content : root.content;
}

export function latexToText(src: string): string {
  const root = parse(src);
  // Give custom macros the argument counts their \newcommand definitions declare.
  const specs = Object.fromEntries(
    listNewcommands(root).map((m) => [m.name, { signature: m.signature }]),
  );
  attachMacroArgs(root, specs);
  return tidy(renderAll(documentBody(root)));
}
