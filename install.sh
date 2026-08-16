#!/usr/bin/env bash
# Install job-scan: pin an interpreter, link the skill, create the private
# workspace, arm the hook. Safe to re-run — it never overwrites config or .env.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="${JOB_SCAN_WORKSPACE:-$HOME/.job-scan}"
SKILLS="$HOME/.claude/skills"

say()  { printf '\033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '\033[33m!\033[0m %s\n' "$1"; }
die()  { printf '\033[31m✗\033[0m %s\n' "$1"; exit 1; }

# 1. Find an interpreter with tomllib (3.11+). `python3` is often the system
#    build, which on macOS is still 3.9 — so probe explicitly rather than
#    assuming, and pin the result so every later run agrees.
usable() { "$1" -c 'import sys,tomllib; sys.exit(0)' >/dev/null 2>&1; }

PY=""
for cand in python3.14 python3.13 python3.12 python3.11 python3; do
  path="$(command -v "$cand" 2>/dev/null)" || continue
  if usable "$path"; then PY="$path"; break; fi
done
if [ -z "$PY" ]; then                       # pyenv builds that aren't on PATH
  for path in "$HOME"/.pyenv/versions/3.1[1-9]*/bin/python3.*; do
    [ -x "$path" ] || continue
    if usable "$path"; then PY="$path"; break; fi
  done
fi
[ -n "$PY" ] || die "no Python 3.11+ found (needed for tomllib).
  Install one, e.g.:  brew install python@3.13"

mkdir -p "$WORKSPACE"/{data/raw,reports,cache,profile,bin}
ln -sfn "$PY" "$WORKSPACE/bin/python"
say "interpreter pinned: $("$PY" -V 2>&1) at $PY"

# 2. Private workspace — data only, always outside this repo.
say "workspace at $WORKSPACE"

if [ ! -f "$WORKSPACE/config.toml" ]; then
  cp "$REPO/config.example.toml" "$WORKSPACE/config.toml"
  say "config.toml created — edit the TODO fields"
else
  warn "config.toml already exists, left untouched"
fi

if [ ! -f "$WORKSPACE/.env" ]; then
  cp "$REPO/.env.example" "$WORKSPACE/.env"
  chmod 600 "$WORKSPACE/.env"
  say ".env created (mode 600) — add your IMAP app password"
else
  warn ".env already exists, left untouched"
fi

# 3. Make the skill visible to Claude Code from any directory.
mkdir -p "$SKILLS"
if [ -L "$SKILLS/job-scan" ]; then
  ln -sfn "$REPO" "$SKILLS/job-scan"
  say "skill symlink refreshed"
elif [ -e "$SKILLS/job-scan" ]; then
  warn "$SKILLS/job-scan exists and is not a symlink — leaving it alone"
else
  ln -s "$REPO" "$SKILLS/job-scan"
  say "skill linked into $SKILLS"
fi

# 4. Arm the pre-commit hook that keeps personal data out of a public repo.
if [ -d "$REPO/.git" ]; then
  chmod +x "$REPO/.githooks/pre-commit"
  git -C "$REPO" config core.hooksPath .githooks
  say "pre-commit hook armed"
else
  warn "not a git repo yet — run 'git init' then re-run to arm the hook"
fi

cat <<EOF

Next:
  1. Put your IMAP app password in $WORKSPACE/.env
     Gmail needs an App Password (2FA on): https://myaccount.google.com/apppasswords
  2. Point resume.lib in $WORKSPACE/config.toml at your resume repo,
     and fill in the TODO fields under [profile]
  3. Verify:
       $WORKSPACE/bin/python $REPO/scripts/fetch_mail.py --check
       $WORKSPACE/bin/python $REPO/scripts/resume_text.py --list
  4. In Claude Code, run the skill:  /job-scan
EOF
