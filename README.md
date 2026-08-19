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
2. **Clean** each message: strip HTML, normalise whitespace, remove tracking
   params from links, dedupe by `Message-ID`. Unsubscribe footers are left in
   place — see below for why.
3. **Load** your resume variants from a resume library — a directory, usually
   its own git repo, of `.tex` (or `.pdf`/`.md`) files.
4. **Extract** every posting from the alert bodies.
5. **Dedupe** at the job level so the same role isn't recommended daily. The
   fingerprint survives rewording: `Senior Backend Engineer (Req #12345)` at
   `Stripe, Inc.` matches `Senior Backend Engineer` at `Stripe`.
6. **Gate, then score.** Work authorization, seniority, and location are hard
   filters, not soft penalties — a role you legally cannot take is excluded and
   listed with a reason, never scored into the main list.
7. **Report** to `reports/<date>.md`, with the resume variant to use
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

This links the skill into `~/.claude/skills/`, creates the private files
alongside the code, and arms a pre-commit hook that blocks credentials and
personal data from reaching this repo.

## Requirements

**Python 3.14 or newer. Nothing else.**

| | |
|---|---|
| Python | **≥ 3.14** — declared in `pyproject.toml` (`requires-python`), pinned in `.python-version`, enforced at import by `scripts/_bootstrap.py` |
| Runtime dependencies | none — `pip install -r requirements.txt` is a deliberate no-op |
| Optional | `pypdf`, only if your resume library holds PDFs instead of LaTeX/Markdown: `pip install -r requirements-pdf.txt` |

There is no compatibility layer and no backport path: older interpreters are
rejected at import with a message naming the version they ran under. Config is
TOML via stdlib `tomllib`, HTML is cleaned with `html.parser` + `html.unescape`,
and LaTeX is handled by `scripts/latex_text.py` in this repo.

`install.sh` locates a 3.14+ interpreter, builds a virtualenv at `venv/`, and
pins it at `bin/python`, which is what the skill and the scheduled task invoke.
Never call bare `python3` — on macOS that is the 3.9 system build.

**There is nothing to activate.** `source venv/bin/activate` exists if you want
a shell session inside it, but no workflow requires it — commands are run from
this directory via `bin/python`.

The venv is not about resolving dependencies — there are none. It is about where
an optional one would land: without it, `pip install pypdf` for a PDF resume
library goes into the base interpreter's global `site-packages`, which on a
pyenv build is shared with every other project on that version.

`bin/python` is a wrapper that `exec`s the venv, not a symlink to it. CPython
locates `pyvenv.cfg` from the path it was invoked with and does not resolve
symlinks first, so a symlink would look beside the *link*, find nothing, and
silently run as the base interpreter with the venv inert. `install.sh` asserts
`sys.prefix != sys.base_prefix` after writing it.

The installer resolves pyenv shims to their real binary before pinning. A shim
picks its version from the *current directory's* `.python-version` and
dispatches on `argv[0]`, so pinning one would work in this repo and fail
everywhere else. Override the choice with `JOB_SCAN_PYTHON=/path/to/python`.

Missing or unparseable config is a hard error, never a fallback to defaults.
Config carries the sender allowlist, so defaulting would widen the IMAP search
to *every* recent message and pull ordinary personal mail into `data/raw/`.

## Code and data in one directory

| | Path | Contents |
|---|---|---|
| **Repo + workspace** | this directory | scripts and skill, plus `.env`, `config.toml`, `data/`, `reports/` |
| **Resume library** (yours) | wherever you keep it | `.tex` sources, its own repo |

The private half is gitignored and guarded by `.githooks/pre-commit`, and that
is now the *only* thing keeping it out of a public repo — there is no physical
separation to fall back on, so edit `.gitignore` carefully. `data/raw/*.json`
holds full email bodies and is the file to worry about.

## Configure

```bash
$EDITOR config.toml   # resume.lib, then every TODO under [profile]
$EDITOR .env          # one USER/PASSWORD pair per account
```

Edit `config.toml` first: account names there derive the `.env` key names. Ask
the tool which keys yours needs rather than copying the example, which is only
correct for the example config:

```bash
bin/python scripts/fetch_mail.py --env-template
```

It reads your `config.toml` and emits the exact skeleton with per-provider notes.
It never reads the existing `.env`, so it cannot echo a credential.

Gmail requires an [App Password](https://myaccount.google.com/apppasswords)
with 2FA enabled; your account password will not authenticate over IMAP.

### Multiple mailboxes

Add one `[[account]]` block per inbox — job alerts to a personal Gmail,
recruiter mail to a school address. All are scanned in one run and merged into
a single report, tagged by which mailbox each lead came through.

```toml
[[account]]
name = "gmail-main"
provider = "gmail"        # fills in host and port

[[account]]
name = "gmail-alt"
provider = "gmail"        # reads GMAIL_ALT_USER / GMAIL_ALT_PASSWORD

[[account]]
name = "outlook-personal"
provider = "outlook"      # "m365" for a work or university tenant
senders = ["linkedin.com", "joinhandshake.com", "careers"]  # per-account override
```

`provider` accepts `gmail`, `m365`, `outlook`, `icloud`, `yahoo`, `fastmail`,
or set `host` yourself. An account with neither is an error — guessing a mail
server is how you connect to the wrong one. Credentials never appear in
`config.toml`; accounts name the `.env` keys to read.

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
bin/python scripts/fetch_mail.py --check
```

`max_messages` is per mailbox, so total volume grows linearly with account
count — four accounts at the default caps is roughly 360k tokens of email,
which will not fit in a context window. `max_total_messages` (default 150) is
the whole-run ceiling. Newest mail wins; anything dropped is reported in
`stats.dropped_by_account` and is deliberately **not** marked as seen, so it
can still arrive tomorrow. Persistent overflow means your `senders` list is
too broad.

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

The library is read as plain files — no git required, and nothing is written
back to it. `--list` reports each variant's `modified` date so the report can
flag one that has gone stale.

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
| `workspace.py` | Config, credentials and dedupe state — everything read from or written to the workspace |
| `fetch_mail.py` | Multi-account IMAP fetch, HTML→text, size cap, message dedupe |
| `resume_text.py` | Discover variants, extract, cache, attach git metadata |
| `latex_text.py` | Brace-aware LaTeX→text (handles `\resumeSubheading`-style macros) |
| `seen_jobs.py` | Job-level dedupe across rewordings |
| `_bootstrap.py` | The Python floor, enforced at import |

`workspace.py` exists because three scripts each reached into the workspace on
their own and had started to disagree. `load_config` existed twice under one
name with different semantics — one hard-failing on a missing file, the other
quietly defaulting — and `load_state`/`save_state` existed twice over the *same*
JSON file with different invariants: one pruned old message ids, the other did
not, and neither ever pruned job fingerprints, so that half of the file grew
without bound. One owner, one retention policy: 90 days for message ids, 365 for
job fingerprints, comfortably past any `repeat_suppression_days`.

Each runs standalone with `--help`.

## Why aren't unsubscribe footers stripped?

Because it was measured and did not earn its keep. Bodies reach the model with
their footers intact.

Footer stripping was built, then removed. It saved ~135 tokens per message —
about 6.5k on a realistic four-account day — which is not worth owning a marker
list that needs a new entry every time a sender changes its template. Two bugs
came out of that list before it was deleted.

The library route was checked too, on a representative LinkedIn alert: 15 job
facts that had to survive, 10 boilerplate strings that had to go.

| | built for | job data kept | boilerplate left |
|---|---|---|---|
| talon | email signatures/replies | *would not install* | — |
| email-reply-parser | quoted replies | 15/15 | 9/10 |
| trafilatura | web articles | 15/15 | 10/10 |
| html2text | HTML→Markdown | 15/15 | 10/10 |
| inscriptis | HTML→text | 15/15 | 10/10 |
| boilerpy3 | web articles | 0/15 | 3/10 |
| justext | web articles | 0/15 | 0/10 |

Nothing off the shelf does this. The open-source email-cleaning ecosystem
targets **conversational** mail — quoted replies and personal signatures —
because that is the corpus it was built on, and a job alert has neither.
`talon` is the only email-specific candidate and it pins `cchardet`, an
unmaintained C extension that fails to build on 3.14. The web tools mismatch
worse: justext and boilerpy3 classify boilerplate by short text at high link
density, which describes a job listing exactly, so every posting was labelled
boilerplate and justext returned an empty string.

The one thing footers do cost is a false-positive risk. A line like

```
LinkedIn Corporation, 1000 West Maude Avenue, Sunnyvale, CA 94085
```

is textually indistinguishable from the `company · location` pattern extraction
looks for. That mitigation lives in `SKILL.md` instead of in code: a posting
requires a job title, and a company name beside a city is not one.

`max_chars_per_message` still applies. It bounds the token budget and has
nothing to do with footers.

## Why not an MCP server for the resume library?

MCP earns its keep when Claude needs a capability it lacks or a remote system it
cannot reach. Reading a local directory of resume files is neither — a script
does it with no extra process, no transport, and no config. If your resumes live
in a cloud service instead, an MCP connector for *that service* is the right
answer, and `resume_text.py` is what you would replace.

## License

MIT
