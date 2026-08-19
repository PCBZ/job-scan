#!/usr/bin/env python3
"""Load resume variants from the library and flatten them to plain text.

The library is any directory of variant files. Extraction is cached against
source mtime, so the daily run is a no-op after the first.

Usage:
    python3 resume_text.py --list             # variants + mtime, as JSON
    python3 resume_text.py                    # text of the default variant
    python3 resume_text.py --variant backend  # text of one variant
    python3 resume_text.py --all              # {name: text} for every variant
"""

import _bootstrap  # noqa: F401  — must precede any import that assumes 3.14

import argparse
import glob
import json
import os
import sys
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from workspace import DEFAULT_WORKSPACE, resolve, resume_config  # noqa: E402

SUPPORTED = (".tex", ".pdf", ".md", ".markdown", ".txt")

# Files a resume library carries that are not themselves resumes.
NOT_A_VARIANT = {"preamble", "macros", "commands", "styles", "header", "config"}


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
