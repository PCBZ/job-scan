#!/usr/bin/env python3
"""Single owner of config, credentials and dedupe state.

Three scripts used to reach into the workspace on their own and had drifted
apart. Every function takes an explicit workspace path so tests can point at a
temporary directory.
"""

import _bootstrap  # noqa: F401  — must precede any import that assumes 3.14

import json
import os
import re
import tomllib
from datetime import datetime, timedelta, timezone

# The repo directory is the workspace; private files there are gitignored.
DEFAULT_WORKSPACE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Keys under [mail] that an individual [[account]] may override.
SHARED_KEYS = ("senders", "subject_keywords", "exclude_senders",
               "max_messages", "max_chars_per_message")

# Saves repeating host strings, and names the provider for auth advice.
PROVIDERS = {
    "gmail":    {"host": "imap.gmail.com", "port": 993},
    "m365":     {"host": "outlook.office365.com", "port": 993},
    "outlook":  {"host": "outlook.office365.com", "port": 993},
    "icloud":   {"host": "imap.mail.me.com", "port": 993},
    "yahoo":    {"host": "imap.mail.yahoo.com", "port": 993},
    "fastmail": {"host": "imap.fastmail.com", "port": 993},
}

# Job fingerprints must outlive any repeat_suppression_days setting.
SEEN_MESSAGE_DAYS = 90
SEEN_JOB_DAYS = 365


# --------------------------------------------------------------------------- #
# paths
# --------------------------------------------------------------------------- #

def resolve(path, base=None):
    """User path input -> absolute path.

    Config values pass base=workspace so they are cwd-independent; the
    scheduled run starts in an arbitrary directory. CLI arguments pass no base,
    keeping cwd-relative behaviour, but are frozen to absolute at once.
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

    Asymmetric on purpose: mail config carries the sender allowlist, and
    without it the IMAP search matches every recent message. Resume config
    only picks a file.
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
    """Accounts fully populated from [mail] defaults, provider presets and
    per-account overrides, so callers never test whether a key is set.

    Credentials are not here — an account names the .env keys to read.
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

        # The invariant is "at least one filter", not "a config file exists":
        # with neither, the IMAP search is bare SINCE and matches everything.
        if not (account["senders"] or account["subject_keywords"]):
            raise SystemExit(
                "error: account %r in %s has neither senders nor "
                "subject_keywords.\n       With both empty the IMAP search "
                "matches every recent message, which would pull ordinary "
                "personal mail into data/raw/.\n       Set at least one filter, "
                "under [mail] or on the account." % (name, path)
            )

        # "gmail-work" and "gmail.work" both slug to GMAIL_WORK_USER; two
        # accounts silently sharing credentials is worse than a startup error.
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

    # max_messages is per account, so the whole-run ceiling caps total volume.
    return {"accounts": accounts,
            "max_total_messages": int(mail.get("max_total_messages", 150)),
            "days": int(mail.get("days", 2))}


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
    merged["lib"] = resolve(merged["lib"], base=workspace)
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
    """Atomic write, one retention policy for both writers."""
    path = state_path(workspace)
    os.makedirs(os.path.dirname(path), exist_ok=True)

    now = datetime.now(timezone.utc)
    msg_cutoff = (now - timedelta(days=SEEN_MESSAGE_DAYS)).strftime("%Y-%m-%d")
    job_cutoff = (now - timedelta(days=SEEN_JOB_DAYS)).strftime("%Y-%m-%d")

    state["seen_messages"] = {
        k: v for k, v in state.get("seen_messages", {}).items()
        if v >= msg_cutoff
    }
    state["seen_jobs"] = {
        k: v for k, v in state.get("seen_jobs", {}).items()
        if str(v.get("last_seen", "")) >= job_cutoff
    }

    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2, ensure_ascii=False)
    os.replace(tmp, path)
