# job-scan

A [Claude Code](https://claude.com/claude-code) skill that reads your job-alert
emails, matches the postings against your actual resume, and writes a ranked
daily report — including which resume variant to send.

Scripts do the deterministic work (IMAP, HTML cleanup, LaTeX flattening,
dedupe). Claude does only the judgment. A LinkedIn alert arrives as ~40 KB of
tracker-laden HTML and reaches the model as a few thousand characters of clean
text, so a daily run stays cheap.

```
inbox ─┐
inbox ─┴▶ fetch_mail.py ──▶ clean text ──┐
                                          ├──▶ Claude: extract, gate, score ──▶ reports/2026-08-15.md
resume repo ──▶ resume_text.py ──────────┘
   (.tex)         latex_text.py
```

## What it actually does

1. **Fetch** job-alert mail over IMAP from every configured mailbox, read-only
   — `BODY.PEEK` throughout, so nothing is marked read, moved, or deleted. One
   mailbox failing doesn't sink the run; the failure is reported at the top of
   the report rather than quietly halving your coverage.
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

## Requirements

**Python 3.14 or newer. Nothing else.**

| | |
|---|---|
| Python | **≥ 3.14** — declared in `pyproject.toml` (`requires-python`), pinned in `.python-version`, enforced at import by `scripts/_bootstrap.py` |
| Runtime dependencies | none |
| Optional | `pypdf` — only if your resume library holds PDFs instead of LaTeX/Markdown (`pip install 'job-scan[pdf]'`) |

There is no compatibility layer and no backport path: older interpreters are
rejected at import with a message naming the version they ran under. Config is
TOML via stdlib `tomllib`, HTML is cleaned with `html.parser` + `html.unescape`,
and LaTeX is handled by `scripts/latex_text.py` in this repo.

`install.sh` locates a 3.14+ interpreter and pins it at
`~/.job-scan/bin/python`, which is what the skill and the scheduled task
invoke. Never call bare `python3` — on macOS that is the 3.9 system build.

The installer resolves pyenv shims to their real binary before pinning. A shim
picks its version from the *current directory's* `.python-version` and
dispatches on `argv[0]`, so pinning one would work in this repo and fail
everywhere else. Override the choice with `JOB_SCAN_PYTHON=/path/to/python`.

Missing or unparseable config is a hard error, never a fallback to defaults.
Config carries the sender allowlist, so defaulting would widen the IMAP search
to *every* recent message and pull ordinary personal mail into `data/raw/`.

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
$EDITOR ~/.job-scan/config.toml   # resume.lib, then every TODO under [profile]
```

Gmail requires an [App Password](https://myaccount.google.com/apppasswords)
with 2FA enabled; your account password will not authenticate over IMAP.

### Multiple mailboxes

Add one `[[account]]` block per inbox — job alerts to a personal Gmail,
recruiter mail to a school address. All are scanned in one run and merged into
a single report, tagged by which mailbox each lead came through.

```toml
[[account]]
name = "personal"
host = "imap.gmail.com"
user_env = "GMAIL_USER"          # names the .env keys; credentials never
password_env = "GMAIL_PASSWORD"  # appear in config.toml

[[account]]
name = "school"
host = "outlook.office365.com"
senders = ["linkedin.com", "joinhandshake.com", "careers"]  # per-account override
```

Omit `user_env`/`password_env` and they default to `<NAME>_USER` /
`<NAME>_PASSWORD`, uppercased with punctuation replaced by `_`. Any `[mail]`
key can be overridden per account.

Account names key the dedupe state, so keep them stable — renaming one makes
its history look unseen and costs you a day of repeats. They must also stay
unique *after* slugging: `gmail-alt` and `gmail.alt` both yield
`GMAIL_ALT_USER`, and the loader refuses to start rather than let two accounts
silently read one mailbox's credentials.

Dedupe is deliberately per-account at the message level, and global at the job
level: the same alert landing in two inboxes is two messages but one posting.

Accounts fail independently. An expired password on one is reported and the
rest still run. Check them with:

```bash
~/.job-scan/bin/python scripts/fetch_mail.py --check
```

### Per-provider notes

**Gmail** — every account needs its **own** App Password with 2FA enabled.
They are per-account, not per-device, so one for your main inbox does nothing
for the others.

**Microsoft 365 / Outlook** — Microsoft disabled basic auth for Exchange
Online, and most university and corporate tenants never re-enabled it. When a
365 account fails with `AUTHENTICATIONFAILED` regardless of the password, the
tenant is the cause and no app password will fix it. `--check` reports each
account separately so you can tell which ones actually work.

There is no local fallback for this. Reading Outlook's on-disk mail via
AppleScript works only on the *legacy* Outlook for Mac; the current "new
Outlook" has no AppleScript dictionary at all and returns error `-1728` for
any account query. If your tenant blocks IMAP, forward that mailbox to a Gmail
account and scan that instead.

The `[profile]` TODOs are not cosmetic. `needs_sponsorship` alone filters out
most defense and government postings, and `seniority` is what stops a new-grad
scan from returning Staff roles.

Point `resume.lib` at your resume repo:

```toml
[resume]
lib = "~/Developer/my-resume"
variants = ["*.tex"]
default = "resume"
```

Every matching file is a variant. Name them for the direction they target —
`backend.tex`, `ml.tex`, `newgrad.tex` — and the report will tell you which one
to send for each posting, along with the git commit it was matched against.

Verify:

```bash
~/.job-scan/bin/python scripts/fetch_mail.py --check
~/.job-scan/bin/python scripts/resume_text.py --list
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
