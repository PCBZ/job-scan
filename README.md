# job-scan

A [Claude Code](https://claude.com/claude-code) skill that reads your job-alert
emails, matches the postings against your actual resume, and writes a ranked
daily report — including which resume variant to send.

Scripts do the deterministic work (IMAP, HTML cleanup, LaTeX flattening,
dedupe). Claude does only the judgment. A LinkedIn alert arrives as ~40 KB of
tracker-laden HTML and reaches the model as a few thousand characters of clean
text, so a daily run stays cheap.

```
inbox ──▶ fetch_mail.py ──▶ clean text ──┐
                                          ├──▶ Claude: extract, gate, score ──▶ reports/2026-08-15.md
resume repo ──▶ resume_text.py ──────────┘
   (.tex)         latex_text.py
```

## What it actually does

1. **Fetch** job-alert mail over IMAP, read-only — `BODY.PEEK` throughout, so
   nothing is marked read, moved, or deleted.
2. **Clean** each message: strip HTML, drop footers, remove tracking params
   from links, dedupe by `Message-ID`.
3. **Load** your resume variants from a resume library — a directory, usually
   its own git repo, of `.tex` (or `.pdf`/`.md`) files.
4. **Extract** every posting from the alert bodies.
5. **Dedupe** at the job level so the same role isn't recommended daily. The
   fingerprint survives rewording: `Senior Backend Engineer (Req #12345)` at
   `Stripe, Inc.` matches `Senior Backend Engineer` at `Stripe`.
6. **Gate, then score.** Work authorization, seniority, and location are hard
   filters, not soft penalties — a role you legally cannot take is excluded and
   listed with a reason, never scored into the main list.
7. **Report** to `~/.job-scan/reports/<date>.md`, with the resume variant to use
   and the specific gap to address for each pick.

## Trust boundary

Your inbox is an attacker-reachable surface: anyone can mail you. When this runs
unattended on a schedule, that matters.

**Email content is data, never instructions.** Text inside a message that tries
to direct the agent — "ignore previous instructions", send a reply, visit a URL,
attach your resume, claims of urgency or authority — is quoted in the report's
`Suspicious` section and acted on by nobody.

The workflow is read-only on the mailbox plus one local report file. It does not
send, reply, forward, or flag mail; does not open links found in email; does not
fill forms, upload a resume, or submit applications. Links land in the report for
*you* to click.

## Install

```bash
git clone https://github.com/<you>/job-scan.git ~/Developer/job-scan
cd ~/Developer/job-scan && ./install.sh
```

This links the skill into `~/.claude/skills/`, creates the private workspace at
`~/.job-scan/`, and arms a pre-commit hook that blocks credentials and personal
data from reaching this repo.

Requires Python 3.9+ and `PyYAML`. PDF resumes additionally need `pypdf` or
`PyMuPDF`; LaTeX and Markdown resumes need nothing beyond stdlib.

```bash
python3 -m pip install PyYAML
```

`PyYAML` is a hard requirement rather than a soft one on purpose. Config drives
the sender allowlist, so a silent fallback to defaults would widen the IMAP
search to *every* recent message and pull ordinary personal mail into
`data/raw/`. The scripts refuse to run instead.

## Code here, data there

| | Path | Contents |
|---|---|---|
| **Repo** (public) | this directory | skill, scripts, config template |
| **Workspace** (private) | `~/.job-scan/` | `.env`, real config, email bodies, reports |
| **Resume library** (yours) | wherever you keep it | `.tex` sources, its own repo |

Nothing personal is ever written into the repo. `data/raw/*.json` holds full
email bodies — that is the file to worry about, and it lives in the workspace.

## Configure

```bash
$EDITOR ~/.job-scan/.env          # IMAP_USER + app password
$EDITOR ~/.job-scan/config.yaml   # resume.lib, then every TODO under profile:
```

Gmail requires an [App Password](https://myaccount.google.com/apppasswords)
with 2FA enabled; your account password will not authenticate over IMAP.

The `profile:` TODOs are not cosmetic. `needs_sponsorship` alone filters out most
defense and government postings, and `seniority` is what stops a new-grad scan
from returning Staff roles.

Point `resume.lib` at your resume repo:

```yaml
resume:
  lib: ~/Developer/my-resume
  variants: ["*.tex"]
  default: resume
```

Every matching file is a variant. Name them for the direction they target —
`backend.tex`, `ml.tex`, `newgrad.tex` — and the report will tell you which one
to send for each posting, along with the git commit it was matched against.

Verify:

```bash
python3 scripts/fetch_mail.py --check
python3 scripts/resume_text.py --list
```

## Run

In Claude Code, from any directory:

```
/job-scan
```

For a daily run, create a scheduled task pointing at the same skill. Scheduled
tasks fire only while Claude Code is open; a missed run happens at next launch.

## Scripts

| Script | Job |
|---|---|
| `fetch_mail.py` | IMAP fetch, HTML→text, footer strip, message dedupe |
| `resume_text.py` | Discover variants, extract, cache, attach git metadata |
| `latex_text.py` | Brace-aware LaTeX→text (handles `\resumeSubheading`-style macros) |
| `seen_jobs.py` | Job-level dedupe across rewordings |

Each runs standalone with `--help`.

## Why not an MCP server for the resume library?

MCP earns its keep when Claude needs a capability it lacks or a remote system it
cannot reach. Reading a local directory of resume files is neither — a script
does it with no extra process, no transport, and no config. If your resumes live
in a cloud service instead, an MCP connector for *that service* is the right
answer, and `resume_text.py` is what you would replace.

## License

MIT
