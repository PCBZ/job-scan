#!/usr/bin/env python3
"""Flatten LaTeX resume source into plain text suitable for semantic matching.

Resume templates (Jake's Resume and its many forks) are built out of custom
macros -- `\\resumeSubheading{Role}{Dates}{Company}{Location}` -- so a naive
regex strip either eats the content along with the command or leaves macro
noise that pollutes skill matching. This walks the source with a brace-aware
parser instead: known formatting commands are unwrapped, layout commands are
dropped with their arguments, and unknown macros (which in a resume are almost
always content carriers) keep their arguments joined by ' | '.

Usage:
    python3 latex_text.py resume.tex
"""

import _bootstrap  # noqa: F401  — must precede any import that assumes 3.14

import re
import sys

# Layout/preamble commands: drop the command *and* everything it wraps.
DROP_WITH_ARGS = {
    "documentclass", "usepackage", "newcommand", "renewcommand",
    "providecommand", "definecolor", "pagestyle", "thispagestyle", "fancyhf",
    "fancyfoot", "fancyhead", "titleformat", "titlespacing", "setlength",
    "addtolength", "vspace", "hspace", "includegraphics", "hypersetup",
    "geometry", "input", "include", "label", "ref", "pagenumbering",
    "urlstyle", "raggedbottom", "raggedright", "newlength", "setcounter",
    "AtBeginDocument", "phantom", "vphantom", "hphantom", "rule",
    "raisebox",
}

# Commands with a fixed arity, so a following brace group is real content
# rather than another argument (`\textbf{Languages}{: Java, Go}`).
ARITY = {
    "textbf": 1, "textit": 1, "emph": 1, "underline": 1, "texttt": 1,
    "textsc": 1, "textrm": 1, "textsf": 1, "text": 1, "mbox": 1,
    "small": 1, "large": 1, "Large": 1, "LARGE": 1, "huge": 1, "Huge": 1,
    "footnotesize": 1, "scriptsize": 1, "normalsize": 1,
    "section": 1, "subsection": 1, "subsubsection": 1, "paragraph": 1,
    "href": 2, "textcolor": 2, "colorbox": 2,
    # begin/end take exactly one argument: the environment name. Without this
    # they were unbounded, so `\begin{center}` collected the *next* brace group
    # too — `{\Huge \scshape Wenshuang Zhou}` became begin's second argument and
    # was discarded with it. The resume header lost the candidate's name, and
    # every `\begin{env}` immediately followed by a group had the same hole.
    "begin": 1, "end": 1,
    # \raisebox{lift}{text}: the lift is layout. Pinning the arity to 1 makes
    # the whole call drop, since the icon usages in resume headers are
    # `\raisebox{-0.2\height}\faGithub` — one group, no text argument — and the
    # bare offset was leaking into the output as "-0.2".
    "raisebox": 1,
}

# Arg-less spacing/font switches: replace with a single space.
DROP_BARE = {
    "scshape", "bfseries", "itshape", "rmfamily", "sffamily", "ttfamily",
    "centering", "hfill", "vfill", "noindent", "clearpage", "newpage",
    "quad", "qquad", "ldots", "dots", "smallskip", "medskip", "bigskip",
    "linebreak", "newline", "par", "leavevmode", "strut",
}

CMD = re.compile(r"\\([A-Za-z]+)\*?")
ESCAPED = set("&%$#_{}")


def strip_comments(src):
    return re.sub(r"(?<!\\)%.*", "", src)


def strip_preamble(src):
    """Everything before \\begin{document} is macro plumbing, not content."""
    idx = src.find(r"\begin{document}")
    if idx == -1:
        return src
    return src[idx + len(r"\begin{document}"):]


def read_group(src, i):
    """src[i] must be '{'. Return (inner_text, index_after_closing_brace)."""
    depth, start, n = 0, i + 1, len(src)
    while i < n:
        c = src[i]
        if c == "\\":
            i += 2
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return src[start:i], i + 1
        i += 1
    return src[start:], n


def collect_args(src, i, limit=None):
    """Gather following {...} groups, skipping [...] optional args."""
    args, n = [], len(src)
    while i < n:
        if limit is not None and len(args) >= limit:
            break
        j = i
        while j < n and src[j] in " \t\n":
            j += 1
        if j >= n:
            break
        if src[j] == "[":
            close = src.find("]", j)
            if close == -1:
                break
            i = close + 1
            continue
        if src[j] == "{":
            inner, i = read_group(src, j)
            args.append(inner)
            continue
        break
    return args, i


def emit(name, args):
    lower = name.lower()

    if name in DROP_WITH_ARGS:
        return " "
    if name in ("begin", "end"):
        return "\n"
    if name in DROP_BARE:
        return " "

    rendered = [render(a).strip() for a in args]
    rendered = [r for r in rendered if r]

    if lower in ("section", "subsection", "subsubsection"):
        return "\n\n## %s\n" % (rendered[0] if rendered else "")
    if lower in ("href", "url"):
        return rendered[-1] if rendered else ""
    if lower == "textcolor" and len(rendered) == 2:
        return rendered[1]
    if lower == "item" or lower.endswith("item"):
        return "\n- " + " ".join(rendered) if rendered else "\n- "

    if not rendered:
        return " "
    if len(rendered) == 1:
        return rendered[0]
    # Unknown multi-arg macro: in a resume this is a content carrier
    # (subheading, project entry), so keep every argument.
    return "\n" + " | ".join(rendered)


def render(src):
    out, i, n = [], 0, len(src)
    while i < n:
        c = src[i]
        if c == "\\":
            if i + 1 < n and src[i + 1] in ESCAPED:
                out.append(src[i + 1])
                i += 2
                continue
            if i + 1 < n and src[i + 1] == "\\":
                out.append("\n")
                i += 2
                continue
            match = CMD.match(src, i)
            if not match:
                i += 1
                continue
            name = match.group(1)
            limit = ARITY.get(name)
            if name in DROP_BARE:
                args, i = [], match.end()
            else:
                args, i = collect_args(src, match.end(), limit)
            out.append(emit(name, args))
            continue
        if c in "{}$":
            i += 1
            continue
        if c in "~&":
            out.append(" ")
            i += 1
            continue
        out.append(c)
        i += 1
    return "".join(out)


def tidy(text):
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    lines = [ln.strip() for ln in text.split("\n")]
    # Drop lines that are pure leftover punctuation from stripped macros.
    lines = [ln for ln in lines if ln and not re.fullmatch(r"[-|,.:;·•\s]*", ln)]
    return "\n".join(lines).strip()


def latex_to_text(src):
    return tidy(render(strip_preamble(strip_comments(src))))


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("usage: latex_text.py <file.tex>\n")
        return 2
    with open(sys.argv[1], "r", encoding="utf-8", errors="replace") as fh:
        sys.stdout.write(latex_to_text(fh.read()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
