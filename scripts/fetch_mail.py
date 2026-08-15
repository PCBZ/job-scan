#!/usr/bin/env python3
"""Fetch recent job-alert emails over IMAP and emit cleaned, deduped JSON.

Strictly read-only against the mailbox: it SEARCHes and FETCHes with BODY.PEEK
so the \\Seen flag is never set, and it never moves, flags, or deletes anything.

Usage:
    python3 fetch_mail.py --check                 # verify credentials only
    python3 fetch_mail.py --days 2                # fetch and write data/raw/<date>.json
    python3 fetch_mail.py --days 7 --stdout       # print to stdout, don't touch state
"""

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
from datetime import datetime, timedelta, timezone

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


def load_config(workspace):
    path = os.path.join(workspace, "config.yaml")
    defaults = {
        "imap": {"host": "imap.gmail.com", "port": 993, "folder": "INBOX"},
        "senders": [],
        "subject_keywords": [],
        "exclude_senders": [],
        "max_messages": 60,
        "max_chars_per_message": 6000,
    }
    if not os.path.exists(path):
        return defaults
    try:
        import yaml  # noqa
    except ImportError:
        sys.stderr.write("warn: PyYAML missing, using defaults\n")
        return defaults
    with open(path, "r", encoding="utf-8") as fh:
        cfg = yaml.safe_load(fh) or {}
    merged = dict(defaults)
    merged.update({k: v for k, v in cfg.items() if v is not None})
    imap = dict(defaults["imap"])
    imap.update(cfg.get("imap") or {})
    merged["imap"] = imap
    return merged


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
        text = re.sub(r"(?is)<(script|style|head).*?</\1>", " ", html)
        text = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</tr>|</li>", "\n", text)
        text = re.sub(r"<[^>]+>", " ", text)
        for ent, ch in [("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"),
                        ("&gt;", ">"), ("&quot;", '"'), ("&#39;", "'")]:
            text = text.replace(ent, ch)
        return text


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


def connect(cfg, user, password):
    host = cfg["imap"]["host"]
    port = int(cfg["imap"].get("port", 993))
    ctx = ssl.create_default_context()
    conn = imaplib.IMAP4_SSL(host, port, ssl_context=ctx)
    conn.login(user, password)
    return conn


def fetch(cfg, user, password, days, state, verbose=False):
    conn = connect(cfg, user, password)
    folder = cfg["imap"].get("folder", "INBOX")
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
            sys.stderr.write("info: %d candidate messages in %s\n" % (len(ids), folder))

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
            if msg_id in seen:
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
                "message_id": msg_id,
                "from": sender,
                "subject": subject,
                "date": date_iso,
                "body": body,
                "links": extract_links(html) if html else [],
            })

        return messages, {"candidates": len(ids), "already_seen": skipped_seen,
                          "filtered_out": skipped_filter, "kept": len(messages)}
    finally:
        try:
            conn.close()
        except Exception:
            pass
        conn.logout()


# --------------------------------------------------------------------------- #

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--workspace", default=DEFAULT_WORKSPACE)
    ap.add_argument("--days", type=int, default=2,
                    help="lookback window; overlap is fine, dedupe handles it")
    ap.add_argument("--check", action="store_true", help="verify login only")
    ap.add_argument("--stdout", action="store_true",
                    help="print JSON to stdout and leave state untouched")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    ws = os.path.expanduser(args.workspace)
    cfg = load_config(ws)
    env = load_env(ws)
    user = env.get("IMAP_USER") or os.environ.get("IMAP_USER")
    password = env.get("IMAP_PASSWORD") or os.environ.get("IMAP_PASSWORD")
    if cfg["imap"].get("host") in (None, "", "imap.gmail.com"):
        cfg["imap"]["host"] = env.get("IMAP_HOST") or cfg["imap"].get("host") or "imap.gmail.com"

    if is_placeholder(user) or is_placeholder(password):
        print(json.dumps({
            "error": "missing_credentials",
            "hint": "Fill in IMAP_USER and IMAP_PASSWORD in %s/.env — it still "
                    "holds the placeholders from .env.example." % ws,
            "gmail": "Needs an App Password (2FA on): "
                     "https://myaccount.google.com/apppasswords",
        }, indent=2))
        return 2

    if args.check:
        try:
            conn = connect(cfg, user, password)
            typ, _ = conn.select('"%s"' % cfg["imap"].get("folder", "INBOX"), readonly=True)
            conn.logout()
            print(json.dumps({"ok": typ == "OK", "host": cfg["imap"]["host"],
                              "user": user, "folder": cfg["imap"].get("folder")}, indent=2))
            return 0 if typ == "OK" else 1
        except Exception as exc:  # noqa: BLE001 - surface any IMAP failure verbatim
            detail = str(exc)[:300]
            result = {"ok": False, "error": type(exc).__name__, "detail": detail}
            if "AUTHENTICATIONFAILED" in detail.upper():
                result["hint"] = (
                    "IMAP rejected the login. Gmail does not accept your account "
                    "password here — generate an App Password at "
                    "https://myaccount.google.com/apppasswords (requires 2FA) and "
                    "put it in %s/.env" % ws
                )
            print(json.dumps(result, indent=2))
            return 1

    state = load_state(ws)
    try:
        messages, stats = fetch(cfg, user, password, args.days, state,
                                verbose=not args.quiet)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": type(exc).__name__, "detail": str(exc)[:300]},
                         indent=2))
        return 1

    today = datetime.now().strftime("%Y-%m-%d")
    payload = {
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "window_days": args.days,
        "stats": stats,
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
        state["seen_messages"][msg["message_id"]] = today
    state["last_run"] = payload["fetched_at"]
    save_state(ws, state)

    print(json.dumps({"written": out_path, "stats": stats}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
