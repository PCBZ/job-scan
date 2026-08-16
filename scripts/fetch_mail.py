#!/usr/bin/env python3
"""Fetch recent job-alert emails over IMAP and emit cleaned, deduped JSON.

Strictly read-only against the mailbox: it SEARCHes and FETCHes with BODY.PEEK
so the \\Seen flag is never set, and it never moves, flags, or deletes anything.

Usage:
    python3 fetch_mail.py --check                 # verify credentials only
    python3 fetch_mail.py --days 2                # fetch and write data/raw/<date>.json
    python3 fetch_mail.py --days 7 --stdout       # print to stdout, don't touch state
"""

import _bootstrap  # noqa: F401  — must precede any import that assumes 3.14

import argparse
import email
import email.header
import email.utils
import imaplib
import json
import os
import re
import ssl
import sys
import tomllib
from datetime import datetime, timedelta, timezone
from html import unescape

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_WORKSPACE = os.path.expanduser("~/.job-scan")

# Footer markers: everything from the first match onward is boilerplate.
FOOTER_MARKERS = [
    "unsubscribe",
    "this email was sent to",
    "you are receiving this",
    "you're receiving this",
    "manage your email",
    "email preferences",
    "update your preferences",
    "privacy policy",
    "view this email in your browser",
    "©",
    "©",
]

TRACKING_PARAMS = re.compile(
    r"[?&](utm_[a-z]+|trk|trkEmail|midToken|midSig|eid|ct|lipi|refId|_ga)=[^&]*",
    re.I,
)


# --------------------------------------------------------------------------- #
# config / env
# --------------------------------------------------------------------------- #

def load_env(workspace):
    """Minimal .env parser. Never logs or echoes values."""
    path = os.path.join(workspace, ".env")
    if not os.path.exists(path):
        return {}
    out = {}
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            val = val.strip().strip('"').strip("'")
            out[key.strip()] = val
    return out


def is_placeholder(value):
    """True for the untouched values shipped in .env.example."""
    value = (value or "").strip()
    if not value:
        return True
    lowered = value.lower()
    if lowered in ("you@gmail.com", "you@example.com", "your@email.com"):
        return True
    # A run of x's is the stand-in for the 16-character app password.
    return set(lowered) <= {"x"}


SHARED_KEYS = ("senders", "subject_keywords", "exclude_senders",
               "max_messages", "max_chars_per_message")


def load_config(workspace):
    """Return {"accounts": [...]}, each account merged over the [mail] defaults.

    Credentials never live in config.toml — an account names the .env keys to
    read, so the config file stays safe to share and only .env needs chmod 600.
    """
    path = os.path.join(workspace, "config.toml")
    # Never proceed on defaults: an empty `senders` list collapses the IMAP
    # search to "everything since <date>", which would pull ordinary personal
    # mail into data/raw/ and hand it to the model as job data.
    if not os.path.exists(path):
        raise SystemExit(
            "error: %s not found.\n       Refusing to run without a sender "
            "allowlist — that would fetch unrelated mail.\n       Fix: run "
            "./install.sh, or copy config.example.toml there." % path
        )
    try:
        with open(path, "rb") as fh:
            cfg = tomllib.load(fh)
    except tomllib.TOMLDecodeError as exc:
        raise SystemExit("error: %s is not valid TOML — %s" % (path, exc))

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

        account = dict(shared)
        for key in SHARED_KEYS:          # per-account override of the defaults
            if entry.get(key) is not None:
                account[key] = entry[key]
        account.update({
            "name": name,
            "host": entry.get("host", "imap.gmail.com"),
            "port": int(entry.get("port", 993)),
            "folder": entry.get("folder", "INBOX"),
            "user_env": entry.get("user_env", "%s_USER" % slug),
            "password_env": entry.get("password_env", "%s_PASSWORD" % slug),
        })

        # Distinct names can flatten to the same env slug ("gmail-work" and
        # "gmail.work" both give GMAIL_WORK_USER). Two accounts silently
        # reading one mailbox's credentials is worse than a startup error.
        key = (account["user_env"], account["password_env"])
        if key in seen_env:
            raise SystemExit(
                "error: accounts %r and %r both resolve to %s / %s in %s.\n"
                "       Set user_env and password_env explicitly on at least "
                "one of them." % (seen_env[key], name, key[0], key[1], path)
            )
        seen_env[key] = name
        accounts.append(account)
    return {"accounts": accounts}


def load_state(workspace):
    path = os.path.join(workspace, "data", "state.json")
    if not os.path.exists(path):
        return {"seen_messages": {}, "seen_jobs": {}, "last_run": None}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            state = json.load(fh)
    except (ValueError, IOError):
        return {"seen_messages": {}, "seen_jobs": {}, "last_run": None}
    state.setdefault("seen_messages", {})
    state.setdefault("seen_jobs", {})
    return state


def save_state(workspace, state):
    path = os.path.join(workspace, "data", "state.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # Prune message ids older than 90 days so state.json stays small.
    cutoff = (datetime.now(timezone.utc) - timedelta(days=90)).strftime("%Y-%m-%d")
    state["seen_messages"] = {
        k: v for k, v in state.get("seen_messages", {}).items() if v >= cutoff
    }
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


# --------------------------------------------------------------------------- #
# text extraction
# --------------------------------------------------------------------------- #

def html_to_text(html):
    try:
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html, "html.parser")
        for tag in soup(["script", "style", "head", "meta", "link"]):
            tag.decompose()
        return soup.get_text("\n")
    except ImportError:
        # stdlib path — equivalent for alert emails, and keeps the LaTeX
        # pipeline dependency-free.
        text = re.sub(r"(?is)<(script|style|head).*?</\1>", " ", html)
        text = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</tr>|</li>|</td>", "\n", text)
        text = re.sub(r"<[^>]+>", " ", text)
        # Full entity table, not a hand-picked handful: job alerts are dense
        # with &middot;, &bull;, &#8217; and friends as visual separators.
        return unescape(text)


def extract_links(html, limit=40):
    """Pull (anchor_text, url) pairs, de-tracked and deduped, preserving order."""
    links, seen = [], set()
    for match in re.finditer(
        r'<a\s[^>]*href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', html, re.I | re.S
    ):
        url, label = match.group(1), match.group(2)
        if not url.lower().startswith("http"):
            continue
        url = TRACKING_PARAMS.sub("", url).rstrip("?&")
        label = re.sub(r"<[^>]+>", " ", label)
        label = re.sub(r"\s+", " ", label).strip()
        key = url.split("?")[0]
        if key in seen:
            continue
        seen.add(key)
        links.append({"text": label[:120], "url": url})
        if len(links) >= limit:
            break
    return links


def clean_text(text, max_chars):
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t ]+", " ", text)
    text = re.sub(r"\n\s*\n\s*\n+", "\n\n", text)
    lines = [ln.strip() for ln in text.split("\n")]
    text = "\n".join(ln for ln in lines if ln)

    lowered = text.lower()
    cut = len(text)
    for marker in FOOTER_MARKERS:
        idx = lowered.find(marker)
        # Only trust a footer marker in the last 40% of the body.
        if idx != -1 and idx > len(text) * 0.6:
            cut = min(cut, idx)
    text = text[:cut].strip()

    if len(text) > max_chars:
        text = text[:max_chars] + "\n[...truncated]"
    return text


def decode_header_value(raw):
    if not raw:
        return ""
    try:
        return str(email.header.make_header(email.header.decode_header(raw)))
    except (UnicodeDecodeError, LookupError, ValueError):
        return str(raw)


def message_body(msg):
    """Return (text, html). Prefers text/plain, keeps html for link extraction."""
    plain, html = "", ""
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_maintype() == "multipart":
                continue
            disp = str(part.get("Content-Disposition") or "")
            if "attachment" in disp.lower():
                continue
            ctype = part.get_content_type()
            if ctype not in ("text/plain", "text/html"):
                continue
            payload = part.get_payload(decode=True)
            if not payload:
                continue
            charset = part.get_content_charset() or "utf-8"
            try:
                decoded = payload.decode(charset, errors="replace")
            except LookupError:
                decoded = payload.decode("utf-8", errors="replace")
            if ctype == "text/plain":
                plain += decoded + "\n"
            else:
                html += decoded + "\n"
    else:
        payload = msg.get_payload(decode=True) or b""
        charset = msg.get_content_charset() or "utf-8"
        try:
            decoded = payload.decode(charset, errors="replace")
        except LookupError:
            decoded = payload.decode("utf-8", errors="replace")
        if msg.get_content_type() == "text/html":
            html = decoded
        else:
            plain = decoded
    return plain, html


# --------------------------------------------------------------------------- #
# IMAP
# --------------------------------------------------------------------------- #

def build_search(days, senders):
    since = (datetime.now() - timedelta(days=days)).strftime("%d-%b-%Y")
    criteria = '(SINCE %s)' % since
    if senders:
        terms = ['FROM "%s"' % s.replace('"', "") for s in senders]
        combined = terms[0]
        for term in terms[1:]:
            combined = "OR %s %s" % (term, combined)
        criteria += " (%s)" % combined
    return criteria, since


def connect(account, user, password):
    ctx = ssl.create_default_context()
    conn = imaplib.IMAP4_SSL(account["host"], account["port"], ssl_context=ctx)
    conn.login(user, password)
    return conn


def fetch(cfg, user, password, days, state, verbose=False):
    """Fetch one account. `cfg` is a single account dict from load_config."""
    conn = connect(cfg, user, password)
    folder = cfg.get("folder", "INBOX")
    account_name = cfg["name"]
    try:
        typ, _ = conn.select('"%s"' % folder, readonly=True)
        if typ != "OK":
            raise RuntimeError("cannot open folder %r" % folder)

        criteria, since = build_search(days, cfg.get("senders") or [])
        typ, data = conn.search(None, criteria)
        if typ != "OK":
            if verbose:
                sys.stderr.write("warn: search %r failed, falling back to SINCE\n" % criteria)
            typ, data = conn.search(None, "(SINCE %s)" % since)
            if typ != "OK":
                raise RuntimeError("IMAP SEARCH failed")

        ids = (data[0] or b"").split()
        ids = ids[-int(cfg.get("max_messages", 60)):]
        if verbose:
            sys.stderr.write("info: [%s] %d candidate messages in %s\n"
                             % (account_name, len(ids), folder))

        keywords = [k.lower() for k in (cfg.get("subject_keywords") or [])]
        blocked = [b.lower() for b in (cfg.get("exclude_senders") or [])]
        max_chars = int(cfg.get("max_chars_per_message", 6000))
        seen = state.get("seen_messages", {})

        messages, skipped_seen, skipped_filter = [], 0, 0
        for num in ids:
            typ, raw = conn.fetch(num, "(BODY.PEEK[])")
            if typ != "OK" or not raw or not isinstance(raw[0], tuple):
                continue
            msg = email.message_from_bytes(raw[0][1])

            msg_id = (msg.get("Message-ID") or "").strip()
            if not msg_id:
                msg_id = "no-id:%s:%s" % (msg.get("Date", ""), msg.get("Subject", ""))
            # Namespaced by account: the same alert delivered to two mailboxes
            # is two messages, and each account tracks its own history.
            if "%s|%s" % (account_name, msg_id) in seen:
                skipped_seen += 1
                continue

            sender = decode_header_value(msg.get("From"))
            subject = decode_header_value(msg.get("Subject"))
            low_sender, low_subject = sender.lower(), subject.lower()

            if any(b in low_sender for b in blocked):
                skipped_filter += 1
                continue
            # Keyword filter only applies to senders not on the allowlist.
            if keywords and not any(
                s.lower() in low_sender for s in (cfg.get("senders") or [])
            ):
                if not any(k in low_subject for k in keywords):
                    skipped_filter += 1
                    continue

            try:
                dt = email.utils.parsedate_to_datetime(msg.get("Date"))
                date_iso = dt.isoformat()
            except (TypeError, ValueError):
                date_iso = ""

            plain, html = message_body(msg)
            body = plain if len(plain.strip()) > 200 else html_to_text(html or plain)
            body = clean_text(body, max_chars)
            if len(body) < 40:
                skipped_filter += 1
                continue

            messages.append({
                "account": account_name,
                "message_id": msg_id,
                "from": sender,
                "subject": subject,
                "date": date_iso,
                "body": body,
                "links": extract_links(html) if html else [],
            })

        return messages, {"account": account_name, "candidates": len(ids),
                          "already_seen": skipped_seen,
                          "filtered_out": skipped_filter, "kept": len(messages)}
    finally:
        try:
            conn.close()
        except Exception:
            pass
        conn.logout()


# --------------------------------------------------------------------------- #

def credentials_for(account, env):
    user = env.get(account["user_env"]) or os.environ.get(account["user_env"])
    password = (env.get(account["password_env"])
                or os.environ.get(account["password_env"]))
    return user, password


def auth_hint(detail, workspace, account):
    """Provider-specific advice — the two failures need opposite responses."""
    upper = detail.upper()
    if not any(sig in upper for sig in
               ("AUTHENTICATIONFAILED", "AUTHENTICATE FAILED", "LOGIN FAILED",
                "INVALID CREDENTIALS")):
        return None
    env_file = os.path.join(workspace, ".env")
    host = account["host"].lower()

    if "office365" in host or "outlook" in host or "hotmail" in host:
        # Microsoft turned off basic auth for Exchange Online; most school and
        # work tenants never turned it back on. No password fixes that, so say
        # so rather than sending the user round the app-password loop.
        return ("IMAP rejected the login for %r. Microsoft disabled basic auth "
                "for Exchange Online and most school/work tenants leave it off "
                "— if yours has, no app password will help. Confirm the tenant "
                "allows IMAP; if it doesn't, forward this mailbox to an account "
                "that works and scan that one instead. Credentials are read "
                "from %s in %s." % (account["name"], account["password_env"],
                                    env_file))

    return ("IMAP rejected the login for %r. Gmail does not accept an account "
            "password here — generate an App Password at "
            "https://myaccount.google.com/apppasswords (requires 2FA), and note "
            "that each Gmail account needs its own. Put it in %s under %s."
            % (account["name"], env_file, account["password_env"]))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--workspace", default=DEFAULT_WORKSPACE)
    ap.add_argument("--days", type=int, default=2,
                    help="lookback window; overlap is fine, dedupe handles it")
    ap.add_argument("--account", help="scan only this account (default: all)")
    ap.add_argument("--check", action="store_true", help="verify logins only")
    ap.add_argument("--stdout", action="store_true",
                    help="print JSON to stdout and leave state untouched")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    ws = os.path.expanduser(args.workspace)
    env = load_env(ws)
    accounts = load_config(ws)["accounts"]

    if args.account:
        wanted = args.account.lower()
        accounts = [a for a in accounts if a["name"].lower() == wanted]
        if not accounts:
            print(json.dumps({
                "error": "unknown_account",
                "requested": args.account,
                "available": [a["name"] for a in load_config(ws)["accounts"]],
            }, indent=2))
            return 2

    # ---- credential / connectivity check ---------------------------------- #
    if args.check:
        results = []
        for account in accounts:
            user, password = credentials_for(account, env)
            if is_placeholder(user) or is_placeholder(password):
                results.append({
                    "account": account["name"], "ok": False,
                    "error": "missing_credentials",
                    "hint": "Set %s and %s in %s/.env"
                            % (account["user_env"], account["password_env"], ws),
                })
                continue
            try:
                conn = connect(account, user, password)
                typ, _ = conn.select('"%s"' % account["folder"], readonly=True)
                conn.logout()
                results.append({"account": account["name"], "ok": typ == "OK",
                                "host": account["host"], "user": user,
                                "folder": account["folder"]})
            except Exception as exc:  # noqa: BLE001 - surface IMAP failures verbatim
                detail = str(exc)[:300]
                entry = {"account": account["name"], "ok": False,
                         "error": type(exc).__name__, "detail": detail}
                hint = auth_hint(detail, ws, account)
                if hint:
                    entry["hint"] = hint
                results.append(entry)
        healthy = sum(1 for r in results if r.get("ok"))
        print(json.dumps({"ok": healthy == len(results), "healthy": healthy,
                          "total": len(results), "accounts": results}, indent=2))
        return 0 if healthy else 1

    # ---- fetch ------------------------------------------------------------ #
    state = load_state(ws)
    messages, per_account, failures = [], [], []

    for account in accounts:
        user, password = credentials_for(account, env)
        if is_placeholder(user) or is_placeholder(password):
            failures.append({
                "account": account["name"], "error": "missing_credentials",
                "hint": "Set %s and %s in %s/.env"
                        % (account["user_env"], account["password_env"], ws),
            })
            continue
        try:
            got, stats = fetch(account, user, password, args.days, state,
                               verbose=not args.quiet)
        except Exception as exc:  # noqa: BLE001
            # One bad mailbox must not sink the run — an expired password on
            # the school account should still let the personal one through.
            detail = str(exc)[:300]
            entry = {"account": account["name"], "error": type(exc).__name__,
                     "detail": detail}
            hint = auth_hint(detail, ws, account)
            if hint:
                entry["hint"] = hint
            failures.append(entry)
            continue
        messages.extend(got)
        per_account.append(stats)

    if not per_account:
        print(json.dumps({"error": "all_accounts_failed", "failures": failures},
                         indent=2))
        return 1

    today = datetime.now().strftime("%Y-%m-%d")
    payload = {
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "window_days": args.days,
        "stats": {
            "accounts_scanned": len(per_account),
            "accounts_failed": len(failures),
            "kept": sum(s["kept"] for s in per_account),
            "already_seen": sum(s["already_seen"] for s in per_account),
            "filtered_out": sum(s["filtered_out"] for s in per_account),
            "per_account": per_account,
        },
        "failures": failures,
        "messages": messages,
    }

    if args.stdout:
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        return 0

    out_path = os.path.join(ws, "data", "raw", "%s.json" % today)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, ensure_ascii=False)

    for msg in messages:
        state["seen_messages"]["%s|%s" % (msg["account"], msg["message_id"])] = today
    state["last_run"] = payload["fetched_at"]
    save_state(ws, state)

    print(json.dumps({"written": out_path, "stats": payload["stats"],
                      "failures": failures}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
