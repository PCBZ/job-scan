#!/usr/bin/env python3
"""Load resume variants from a resume library and flatten them to plain text.

The library is a directory -- typically a separate git repo of LaTeX sources --
holding one or more resume variants (backend.tex, ml.tex, ...). Each variant is
extracted once and cached; re-extraction happens only when the source is newer
than its cache, so the daily scan is a no-op after the first run.

Git metadata travels with each variant so the report can say which commit a
recommendation was matched against, and warn when a resume has gone stale.

Usage:
    python3 resume_text.py --list             # variants + git info, as JSON
    python3 resume_text.py                    # text of the default variant
    python3 resume_text.py --variant backend  # text of one variant
    python3 resume_text.py --all              # {name: text} for every variant
"""

import _bootstrap  # noqa: F401  — must precede any import that assumes 3.14

import argparse
import glob
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from workspace import DEFAULT_WORKSPACE, resolve, resume_config  # noqa: E402

SUPPORTED = (".tex", ".pdf", ".md", ".markdown", ".txt")

# Files a LaTeX resume repo carries that are not themselves resumes.
NOT_A_VARIANT = {"preamble", "macros", "commands", "styles", "header", "config"}


def _git(directory, *args, timeout=5):
    """Run git in `directory`; return stripped stdout, or None on any failure."""
    try:
        out = subprocess.run(["git", "-C", directory, *args],
                             capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    return out.stdout.strip()


def git_info(path, fetch=False):
    """Commit, date, dirty state and upstream position for one file.

    `behind_upstream` matters more than it looks. A library cloned from GitHub
    and edited on another machine leaves this clone with an older HEAD, and every
    other signal here says it is fine: committed_at and days_since_commit
    describe the local commit, and dirty is False because nothing is uncommitted.
    So a clone several commits behind reports as freshly updated, and the scan
    matches against a resume missing whatever was added upstream — silently.

    Without a fetch this only knows what the last fetch learned, so
    `upstream_checked` says whether the comparison is meaningful. Pass
    fetch=True to refresh first; it is a network call, so it is opt-in.
    """
    directory = os.path.dirname(os.path.abspath(path))
    name = os.path.basename(path)

    head = _git(directory, "log", "-1", "--format=%h%x1f%cI", "--", name)
    if not head:
        return {}
    commit, _, iso = head.partition("\x1f")
    info = {"commit": commit, "committed_at": iso,
            "dirty": bool(_git(directory, "status", "--porcelain", "--", name))}
    try:
        info["days_since_commit"] = (
            datetime.now(timezone.utc) - datetime.fromisoformat(iso)).days
    except ValueError:
        pass

    upstream = _git(directory, "rev-parse", "--abbrev-ref", "@{upstream}")
    if not upstream:
        info["upstream"] = None          # no remote tracking branch configured
        return info
    info["upstream"] = upstream
    if fetch:
        _git(directory, "fetch", "--quiet", timeout=20)
    info["upstream_checked"] = bool(fetch)
    behind = _git(directory, "rev-list", "--count", "HEAD..@{upstream}")
    if behind is not None and behind.isdigit():
        info["behind_upstream"] = int(behind)
    return info


def discover(cfg):
    """Every resume variant in the library, newest first."""
    lib = cfg["lib"]
    if os.path.isfile(lib):
        return [lib]
    found = []
    for pattern in cfg["variants"]:
        found.extend(glob.glob(os.path.join(lib, pattern)))
    variants = []
    for path in sorted(set(found)):
        stem = os.path.splitext(os.path.basename(path))[0].lower()
        if stem in NOT_A_VARIANT or not path.lower().endswith(SUPPORTED):
            continue
        variants.append(path)
    return sorted(variants, key=os.path.getmtime, reverse=True)


def variant_name(path):
    return os.path.splitext(os.path.basename(path))[0]


def extract_pdf(path):
    try:
        import fitz  # PyMuPDF: best layout fidelity of what's installed
        doc = fitz.open(path)
        text = "\n".join(page.get_text() for page in doc)
        doc.close()
        if text.strip():
            return text
    except ImportError:
        pass
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write("warn: PyMuPDF failed on %s (%s), trying pypdf\n"
                         % (os.path.basename(path), exc))
    try:
        from pypdf import PdfReader
    except ImportError:
        try:
            from PyPDF2 import PdfReader  # type: ignore
        except ImportError:
            raise SystemExit("error: install pypdf or PyMuPDF to read PDF resumes")
    return "\n".join((p.extract_text() or "") for p in PdfReader(path).pages)


def extract(path):
    lower = path.lower()
    if lower.endswith(".tex"):
        from latex_text import latex_to_text
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            return latex_to_text(fh.read())
    if lower.endswith(".pdf"):
        return extract_pdf(path)
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        return fh.read()


def text_for(path, workspace, force=False):
    cache_dir = os.path.join(workspace, "cache")
    os.makedirs(cache_dir, exist_ok=True)
    cache = os.path.join(cache_dir, variant_name(path) + ".txt")
    if (not force and os.path.exists(cache)
            and os.path.getmtime(cache) >= os.path.getmtime(path)):
        with open(cache, "r", encoding="utf-8") as fh:
            return fh.read()
    text = extract(path)
    text = "\n".join(ln.rstrip() for ln in text.splitlines())
    while "\n\n\n" in text:
        text = text.replace("\n\n\n", "\n\n")
    with open(cache, "w", encoding="utf-8") as fh:
        fh.write(text)
    return text


def pick_default(variants, cfg):
    wanted = cfg.get("default")
    if wanted:
        for path in variants:
            if variant_name(path).lower() == str(wanted).lower().rsplit(".", 1)[0]:
                return path
    for path in variants:
        if variant_name(path).lower() in ("resume", "cv", "main"):
            return path
    return variants[0] if variants else None


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--workspace", default=DEFAULT_WORKSPACE)
    ap.add_argument("--lib", help="override the library path from config.toml")
    ap.add_argument("--variant", help="variant name (filename without extension)")
    ap.add_argument("--list", action="store_true", help="list variants as JSON")
    ap.add_argument("--all", action="store_true", help="{name: text} as JSON")
    ap.add_argument("--force", action="store_true", help="ignore the cache")
    ap.add_argument("--fetch", action="store_true",
                    help="git fetch the library first, so behind_upstream is real")
    args = ap.parse_args()

    ws = resolve(args.workspace)
    cfg = resume_config(ws)
    if args.lib:
        cfg["lib"] = resolve(args.lib)

    if not os.path.exists(cfg["lib"]):
        print(json.dumps({
            "error": "lib_not_found",
            "lib": cfg["lib"],
            "hint": "Point resume.lib in %s/config.toml at your resume repo."
                    % ws,
        }, indent=2))
        return 2

    variants = discover(cfg)
    if not variants:
        print(json.dumps({
            "error": "no_variants",
            "lib": cfg["lib"],
            "patterns": cfg["variants"],
            "hint": "No files matched. Check resume.variants globs.",
        }, indent=2))
        return 2

    if args.list:
        rows = []
        for path in variants:
            rows.append({
                "name": variant_name(path),
                "path": path,
                "format": os.path.splitext(path)[1].lstrip("."),
                "modified": datetime.fromtimestamp(
                    os.path.getmtime(path)).strftime("%Y-%m-%d"),
                "is_default": path == pick_default(variants, cfg),
                "git": git_info(path, fetch=args.fetch),
            })
        print(json.dumps({"lib": cfg["lib"], "variants": rows}, indent=2,
                         ensure_ascii=False))
        return 0

    if args.all:
        out = {}
        for path in variants:
            out[variant_name(path)] = text_for(path, ws, args.force)
        print(json.dumps(out, indent=2, ensure_ascii=False))
        return 0

    if args.variant:
        match = [p for p in variants
                 if variant_name(p).lower() == args.variant.lower()]
        if not match:
            print(json.dumps({
                "error": "variant_not_found",
                "requested": args.variant,
                "available": [variant_name(p) for p in variants],
            }, indent=2))
            return 2
        target = match[0]
    else:
        target = pick_default(variants, cfg)

    sys.stdout.write("# variant: %s\n# source: %s\n\n"
                     % (variant_name(target), target))
    sys.stdout.write(text_for(target, ws, args.force))
    return 0


if __name__ == "__main__":
    sys.exit(main())
