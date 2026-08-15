#!/usr/bin/env bash
# Install job-scan: link the skill, create the private workspace, arm the hook.
# Safe to re-run — it never overwrites an existing config or .env.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="${JOB_SCAN_WORKSPACE:-$HOME/.job-scan}"
SKILLS="$HOME/.claude/skills"

say()  { printf '\033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '\033[33m!\033[0m %s\n' "$1"; }

# 1. Private workspace — data only, always outside this repo.
mkdir -p "$WORKSPACE"/{data/raw,reports,cache,profile}
say "workspace at $WORKSPACE"

if [ ! -f "$WORKSPACE/config.yaml" ]; then
  cp "$REPO/config.example.yaml" "$WORKSPACE/config.yaml"
  say "config.yaml created — edit the TODO fields"
else
  warn "config.yaml already exists, left untouched"
fi

if [ ! -f "$WORKSPACE/.env" ]; then
  cp "$REPO/.env.example" "$WORKSPACE/.env"
  chmod 600 "$WORKSPACE/.env"
  say ".env created (mode 600) — add your IMAP app password"
else
  warn ".env already exists, left untouched"
fi

# 2. Make the skill visible to Claude Code from any directory.
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

# 3. Arm the pre-commit hook that keeps personal data out of a public repo.
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
  2. Point resume.lib in $WORKSPACE/config.yaml at your resume repo,
     and fill in the TODO fields under profile:
  3. Verify:
       python3 $REPO/scripts/fetch_mail.py --check
       python3 $REPO/scripts/resume_text.py --list
  4. In Claude Code, run the skill:  /job-scan
EOF
