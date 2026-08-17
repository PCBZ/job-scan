#!/usr/bin/env python3
"""Single owner of everything read from or written to the workspace.

Config, credentials and dedupe state all live in ~/.job-scan/, and before this
module three scripts each reached in on their own. Two things had drifted:

  * `load_config` existed twice with the same name and different semantics —
    one hard-failed on a missing file, the other quietly defaulted.
  * `load_state` and `save_state` existed twice over the *same* JSON file with
    different invariants: one pruned old message ids, the other did not, and
    neither ever pruned job fingerprints.

Everything here takes an explicit workspace path so tests can point at a
temporary directory.
"""

import _bootstrap  # noqa: F401  — must precede any import that assumes 3.14

import json
import os
import re
import tomllib
from datetime import datetime, timedelta, timezone

DEFAULT_WORKSPACE = os.path.expanduser("~/.job-scan")

# Keys under [mail] that an individual [[account]] may override.
SHARED_KEYS = ("senders", "subject_keywords", "exclude_senders",
               "max_messages", "max_chars_per_message")

# Saves repeating host strings across half a dozen accounts, where one typo
# turns into a confusing connection error. Also tells the caller which auth
# advice to give without sniffing the hostname.
PROVIDERS = {
    "gmail":    {"host": "imap.gmail.com", "port": 993},
    "m365":     {"host": "outlook.office365.com", "port": 993},
    "outlook":  {"host": "outlook.office365.com", "port": 993},
    "icloud":   {"host": "imap.mail.me.com", "port": 993},
    "yahoo":    {"host": "imap.mail.yahoo.com", "port": 993},
    "fastmail": {"host": "imap.fastmail.com", "port": 993},
}

# Retention for the two halves of state.json. Message ids only matter inside
# the fetch window; job fingerprints must outlive any repeat-suppression
# setting, so they get a full year rather than the suppression window itself.
SEEN_MESSAGE_DAYS = 90
SEEN_JOB_DAYS = 365


# --------------------------------------------------------------------------- #
# paths
# --------------------------------------------------------------------------- #

def resolve(path, base=None):
    """Turn user-supplied path input into an absolute path.

    Paths were only run through expanduser, so a bare relative value resolved
    against the current working directory. `resume.lib = "my-resume"` therefore
    found the library when run from the repo and reported lib_not_found from
    anywhere else — including the scheduled run, whose cwd is arbitrary. Same
    config, three directories, three outcomes.

    `base` is for values that came out of config.toml: they resolve against the
    workspace, where that config lives, which is what makes them cwd-independent.
    CLI arguments pass no base and keep the conventional cwd-relative behaviour,
    but are frozen to absolute immediately so nothing later can reinterpret them.
    """
    path = os.path.expanduser(str(path))
    if os.path.isabs(path):
        return os.path.normpath(path)
    if base:
        return os.path.normpath(os.path.join(base, path))
    return os.path.abspath(path)


def config_path(workspace):
    return os.path.join(workspace, "config.toml")


def env_path(workspace):
    return os.path.join(workspace, ".env")


def state_path(workspace):
    return os.path.join(workspace, "data", "state.json")


# --------------------------------------------------------------------------- #
# credentials
# --------------------------------------------------------------------------- #

def load_env(workspace):
    """Minimal .env parser. Never logs or echoes values."""
    path = env_path(workspace)
    if not os.path.exists(path):
        return {}
    out = {}
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            out[key.strip()] = val.strip().strip('"').strip("'")
    return out


def is_placeholder(value):
    """True for the untouched values shipped in .env.example."""
    value = (value or "").strip()
    if not value:
        return True
    lowered = value.lower()
    if lowered in ("you@gmail.com", "you@example.com", "your@email.com",
                   "other@gmail.com", "you@university.edu", "you@outlook.com"):
        return True
    # A run of x's is the stand-in for the 16-character app password.
    return set(lowered) <= {"x"}


# --------------------------------------------------------------------------- #
# config
# --------------------------------------------------------------------------- #

def load_toml(workspace, required):
    """Parse config.toml. `required` decides whether absence is fatal.

    The asymmetry is deliberate and is the reason this lives in one place:
    mail config carries the sender allowlist, and running without it collapses
    the IMAP search to "everything since <date>", pulling ordinary personal
    mail into data/raw/. Resume config only decides which file to read, so a
    missing one costs a feature, not privacy.
    """
    path = config_path(workspace)
    if not os.path.exists(path):
        if not required:
            return {}
        raise SystemExit(
            "error: %s not found.\n       Refusing to run without a sender "
            "allowlist — that would fetch unrelated mail.\n       Fix: run "
            "./install.sh, or copy config.example.toml there." % path
        )
    try:
        with open(path, "rb") as fh:
            return tomllib.load(fh)
    except tomllib.TOMLDecodeError as exc:
        raise SystemExit("error: %s is not valid TOML — %s" % (path, exc))


def infer_provider(host):
    host = (host or "").lower()
    if "gmail" in host or "googlemail" in host:
        return "gmail"
    if "office365" in host or "outlook" in host or "hotmail" in host:
        return "m365"
    if "me.com" in host or "icloud" in host:
        return "icloud"
    return "imap"


def mail_config(workspace):
    """Return {"accounts": [...], "max_total_messages": int}.

    Each account is fully populated: [mail] defaults, then provider presets,
    then its own overrides. Callers never have to test whether a key is set.

    Credentials are not here. An account names the .env keys to read, so
    config.toml stays safe to share and only .env needs chmod 600.
    """
    path = config_path(workspace)
    cfg = load_toml(workspace, required=True)

    shared = {"senders": [], "subject_keywords": [], "exclude_senders": [],
              "max_messages": 60, "max_chars_per_message": 6000}
    mail = cfg.get("mail") or {}
    for key in SHARED_KEYS:
        if mail.get(key) is not None:
            shared[key] = mail[key]

    raw = cfg.get("account") or []
    if not raw:
        raise SystemExit(
            "error: no [[account]] block in %s.\n"
            "       Define at least one mailbox — see config.example.toml."
            % path
        )

    accounts, seen_names, seen_env = [], set(), {}
    for index, entry in enumerate(raw):
        name = str(entry.get("name") or "account%d" % (index + 1)).strip()
        if name.lower() in seen_names:
            raise SystemExit(
                "error: duplicate account name %r in %s — names key the "
                "dedupe state, so they must be unique." % (name, path)
            )
        seen_names.add(name.lower())
        slug = re.sub(r"[^A-Z0-9]+", "_", name.upper()).strip("_") or "ACCOUNT"

        provider = str(entry.get("provider") or "").lower().strip()
        if provider and provider not in PROVIDERS:
            raise SystemExit(
                "error: account %r has unknown provider %r in %s.\n"
                "       Known: %s — or set host directly."
                % (name, provider, path, ", ".join(sorted(PROVIDERS)))
            )
        preset = PROVIDERS.get(provider, {})
        host = entry.get("host") or preset.get("host")
        if not host:
            raise SystemExit(
                "error: account %r in %s sets neither provider nor host.\n"
                "       Guessing a mail server is how you end up connecting to "
                "the wrong one." % (name, path)
            )

        account = dict(shared)
        for key in SHARED_KEYS:          # per-account override of the defaults
            if entry.get(key) is not None:
                account[key] = entry[key]
        account.update({
            "name": name,
            "provider": provider or infer_provider(host),
            "host": host,
            "port": int(entry.get("port") or preset.get("port") or 993),
            "folder": entry.get("folder", "INBOX"),
            "user_env": entry.get("user_env", "%s_USER" % slug),
            "password_env": entry.get("password_env", "%s_PASSWORD" % slug),
        })

        # A present-but-empty allowlist slipped past the missing-file check and
        # produced exactly the outcome that check exists to prevent: with no
        # senders and no keywords the IMAP search is bare SINCE, matching every
        # message in the window. The invariant is "at least one filter", not
        # "a config file exists".
        if not (account["senders"] or account["subject_keywords"]):
            raise SystemExit(
                "error: account %r in %s has neither senders nor "
                "subject_keywords.\n       With both empty the IMAP search "
                "matches every recent message, which would pull ordinary "
                "personal mail into data/raw/.\n       Set at least one filter, "
                "under [mail] or on the account." % (name, path)
            )

        # Distinct names can flatten to the same env slug ("gmail-work" and
        # "gmail.work" both give GMAIL_WORK_USER). Two accounts silently
        # reading one mailbox's credentials is worse than a startup error.
        env_key = (account["user_env"], account["password_env"])
        if env_key in seen_env:
            raise SystemExit(
                "error: accounts %r and %r both resolve to %s / %s in %s.\n"
                "       Set user_env and password_env explicitly on at least "
                "one of them."
                % (seen_env[env_key], name, env_key[0], env_key[1], path)
            )
        seen_env[env_key] = name
        accounts.append(account)

    # max_messages is per account, so total volume grows linearly with the
    # number of mailboxes — six accounts can hand the model half a million
    # tokens of email. Cap the run as a whole.
    return {"accounts": accounts,
            "max_total_messages": int(mail.get("max_total_messages", 150))}


def resume_config(workspace):
    """Return {"lib": path, "variants": [globs], "default": name or None}."""
    cfg = load_toml(workspace, required=False)
    merged = {"lib": os.path.join(workspace, "profile"),
              "variants": ["*.tex", "*.pdf", "*.md", "*.txt"],
              "default": None}
    resume = cfg.get("resume") or {}
    for key in ("lib", "variants", "default"):
        if resume.get(key):
            merged[key] = resume[key]
    # Config-supplied, so relative means "relative to the workspace", not to
    # whatever directory the scheduled task happened to start in.
    merged["lib"] = resolve(merged["lib"], base=workspace)
    return merged


def report_config(workspace):
    """The [report] section, with defaults, for whoever writes the report."""
    cfg = load_toml(workspace, required=False)
    merged = {"max_top_picks": 5, "min_score_to_recommend": 60,
              "repeat_suppression_days": 30, "suggest_variant": True}
    merged.update({k: v for k, v in (cfg.get("report") or {}).items()
                   if v is not None})
    return merged


# --------------------------------------------------------------------------- #
# state
# --------------------------------------------------------------------------- #

def load_state(workspace):
    path = state_path(workspace)
    empty = {"seen_messages": {}, "seen_jobs": {}, "last_run": None}
    if not os.path.exists(path):
        return empty
    try:
        with open(path, "r", encoding="utf-8") as fh:
            state = json.load(fh)
    except (ValueError, IOError):
        return empty
    state.setdefault("seen_messages", {})
    state.setdefault("seen_jobs", {})
    return state


def save_state(workspace, state):
    """Write atomically, applying one retention policy for both writers."""
    path = state_path(workspace)
    os.makedirs(os.path.dirname(path), exist_ok=True)

    now = datetime.now(timezone.utc)
    msg_cutoff = (now - timedelta(days=SEEN_MESSAGE_DAYS)).strftime("%Y-%m-%d")
    job_cutoff = (now - timedelta(days=SEEN_JOB_DAYS)).strftime("%Y-%m-%d")

    state["seen_messages"] = {
        k: v for k, v in state.get("seen_messages", {}).items()
        if v >= msg_cutoff
    }
    # Previously never pruned by either writer, so this dict grew forever.
    state["seen_jobs"] = {
        k: v for k, v in state.get("seen_jobs", {}).items()
        if str(v.get("last_seen", "")) >= job_cutoff
    }

    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2, ensure_ascii=False)
    os.replace(tmp, path)
