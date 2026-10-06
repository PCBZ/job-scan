import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { latexToText } from "../../src/lib/resume/latex.js";
import { normalizeResumeText } from "../../src/lib/resume/text.js";

const TEMPLATE = String.raw`\documentclass[letterpaper,11pt]{article}
\usepackage[hidelinks]{hyperref}
\newcommand{\resumeSubheading}[4]{\item \textbf{#1} \hfill #2 \\ \textit{#3} \hfill #4}
\newcommand{\resumeItem}[1]{\item\small{#1}}
\definecolor{accent}{RGB}{0,90,160}
\begin{document}
%-------- HEADING --------
\begin{center}
    \textbf{\Huge \scshape Alex Rivera} \\ \vspace{1pt}
    \small 604-555-0100 $|$ \href{mailto:alex@example.com}{\underline{alex@example.com}} $|$
    \href{https://github.com/example}{\raisebox{-0.2\height}\faGithub\ \underline{github.com/example}}
\end{center}

\section{Experience}
  \begin{itemize}
    \resumeSubheading
      {Northwind Traders}{Jan 2024 -- Present}
      {Senior Backend Engineer}{Vancouver, BC}
      \begin{itemize}
        \resumeItem{Cut p99 latency 40\% by moving hot paths to Go \& gRPC}
        \resumeItem{Owned \textbf{Postgres} migrations; on-call for 3 services} % internal note
      \end{itemize}
  \end{itemize}

\section{Technical Skills}
 \begin{itemize}[leftmargin=0.15in, label={}]
    \small{\item{
     \textbf{Languages}{: Python, Go, TypeScript, SQL} \\
     \textbf{Cloud}{: Azure Functions, Terraform, \textcolor{accent}{Kubernetes}}
    }}
 \end{itemize}
\end{document}
`;

describe("latexToText", () => {
  it("flattens a resume template", () => {
    expect(latexToText(TEMPLATE)).toBe(
      [
        "Alex Rivera",
        "604-555-0100 | alex@example.com | github.com/example",
        "## Experience",
        "Northwind Traders | Jan 2024 -- Present | Senior Backend Engineer | Vancouver, BC",
        "- Cut p99 latency 40% by moving hot paths to Go & gRPC",
        "- Owned Postgres migrations; on-call for 3 services",
        "## Technical Skills",
        "- Languages: Python, Go, TypeScript, SQL",
        "Cloud: Azure Functions, Terraform, Kubernetes",
      ].join("\n"),
    );
  });

  it.each([
    // [case, LaTeX, expected text]
    [
      "no begin{document}: the whole source is content",
      String.raw`\section{Summary} Backend engineer with \emph{five} years.`,
      "## Summary\nBackend engineer with five years.",
    ],
    [
      "escapes and specials",
      String.raw`R\&D at A\_B \#1 for 50\% \$ off~now \{x\} a$\cdot$b`,
      "R&D at A_B #1 for 50% $ off now {x} a b",
    ],
    [
      "comments are dropped, an escaped percent is kept",
      "Top 10\\% performer % hidden remark\nNext line",
      "Top 10% performer\nNext line",
    ],
    [
      "\\\\ and \\newline break lines; spacing switches are spaces",
      String.raw`Line one\\Line two \hfill right \quad gap \newline three`,
      "Line one\nLine two right gap\nthree",
    ],
    [
      "an undefined macro takes its following groups: every argument kept",
      String.raw`\project{Job Scan}{TypeScript, Azure}{2026}`,
      "Job Scan | TypeScript, Azure | 2026",
    ],
    [
      "an undefined macro's [options] are skipped",
      String.raw`\cventry[3mm]{2020}{Engineer}{Contoso}`,
      "2020 | Engineer | Contoso",
    ],
    [
      "a defined macro gets its arguments from \\newcommand",
      String.raw`\newcommand{\entry}[3]{#1}\begin{document}\entry{Role}{Org}{City}\end{document}`,
      "Role | Org | City",
    ],
    [
      "a defined macro takes only as many groups as \\newcommand declares",
      String.raw`\newcommand{\role}[1]{#1}\begin{document}\role{Engineer}{ at Contoso}\end{document}`,
      "Engineer at Contoso",
    ],
    [
      "a one-argument macro keeps the next group as content",
      String.raw`\textbf{Languages}{: Java, Go}`,
      "Languages: Java, Go",
    ],
    [
      "href shows the link text, url shows the url",
      String.raw`\href{https://x.example}{Portfolio} and \url{https://y.example}`,
      "Portfolio and https://y.example",
    ],
    [
      "environments break lines; their [options] don't leak",
      String.raw`\begin{itemize}[leftmargin=0.15in]\item Name\end{itemize}Rest`,
      "- Name\nRest",
    ],
    ["starred headings", String.raw`\section*{Projects}\subsection*{Side}`, "## Projects\n## Side"],
    [
      "the preamble never reaches the text",
      String.raw`\documentclass{article}\usepackage{hyperref}\hypersetup{pdftitle={Private Title}}\geometry{margin=1in}\begin{document}Body\end{document}`,
      "Body",
    ],
    [
      "layout commands drop with their arguments",
      String.raw`\vspace{-4pt}\setlength{\tabcolsep}{0in}\includegraphics[width=1in]{me.png}Kept`,
      "Kept",
    ],
    [
      "lines of leftover punctuation are removed",
      String.raw`Real line\\$|$ , . ;\\· •\\-\\Another`,
      "Real line\nAnother",
    ],
    ["nested braces", String.raw`\textbf{Outer {inner {deep}} end}`, "Outer inner deep end"],
    ["an unterminated group keeps its text", String.raw`\textbf{never closed`, "never closed"],
    [
      "unicode passes through",
      String.raw`\section{Expérience} Développeur — Zürich · 東京 🚀`,
      "## Expérience\nDéveloppeur — Zürich · 東京 🚀",
    ],
    [
      "items, with options and as macros ending in item",
      String.raw`\begin{itemize}\item First\item[*] Second \resumeItem{Third}\end{itemize}`,
      "- First\n- Second\n- Third",
    ],
    [
      "an item wrapped in another macro still starts its own line",
      String.raw`\begin{itemize}\small{\item{A}}\small{\item{B}}\end{itemize}`,
      "- A\n- B",
    ],
  ])("%s", (_name, tex, expected) => {
    expect(latexToText(tex)).toBe(expected);
  });
});

// The normalisation in scripts/resume_text.text_for is still matched exactly:
// these expected values were generated by the Python implementation.
const norm: { normalize: { name: string; text: string; expected: string }[] } = JSON.parse(
  readFileSync(new URL("../../../tests/fixtures/text_normalize.json", import.meta.url), "utf8"),
);

describe("normalizeResumeText matches resume_text.text_for", () => {
  it.each(norm.normalize.map((c) => [c.name, c] as const))("%s", (_n, c) => {
    expect(normalizeResumeText(c.text)).toBe(c.expected);
  });
});
