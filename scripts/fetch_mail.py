#!/usr/bin/env python3
"""Fetch recent job-alert emails over IMAP and emit cleaned, deduped JSON.

Strictly read-only against the mailbox: it SEARCHes and FETCHes with BODY.PEEK
so the \\Seen flag is never set, and it never moves, flags, or deletes anything.

Usage:
    python3 fetch_mail.py --env-template          # print the .env keys this config needs
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
from html import unescape

from workspace import (DEFAULT_WORKSPACE, config_path, infer_provider,
                       is_placeholder, load_env, load_state, mail_config,
                       resolve, save_state)

TRACKING_PARAMS = re.compile(
    r"[?&](utm_[a-z]+|trk|trkEmail|midToken|midSig|eid|ct|lipi|refId|_ga)=[^&]*",
    re.I,
)


# --------------------------------------------------------------------------- #
# text extraction
# --------------------------------------------------------------------------- #

def html_to_text(html):
    """Render an email's HTML part to plain text. Conditional fallback only.

    Not on the main path. The caller prefers the text/plain alternative and only
    reaches here when that part is missing or under 200 characters, so for a
    multipart sender this never runs — verified at zero calls in test_mime.
    Whether it matters therefore depends entirely on who mails you:

        multipart + real plain part   -> not called (most large job boards)
        multipart + stub plain part   -> called ("view this in your browser")
        text/html only               -> called (common for direct recruiter mail)

    `stats.body_from_plain` / `body_from_html` report the split per run, which is
    the only honest way to know which case your inbox is.

    When it does run it is load-bearing, not a token optimisation. On an alert
    carrying the bulk real marketing HTML has — inlined style block with media
    queries, MSO conditionals, per-element inline styles, nested tables — 23k
    chars of HTML render to 694 chars of text, a 33x reduction. More to the
    point, fed raw HTML the first 6000 characters (max_chars_per_message) are
    still inside <style>, so the model sees CSS and finds 0 of 3 job titles;
    rendered first it finds 3 of 3. Raising the cap does not rescue that — 48 raw
    messages is ~275k tokens against ~8k rendered.

    Uses bs4 when available and falls back to stdlib regex plus html.unescape.
    Both paths were byte-identical on the test fixture, which is what keeps the
    LaTeX-resume path free of third-party dependencies.
    """
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


def dedupe_key(url):
    """Path plus whatever query params survived tracking removal.

    Keying on the path alone silently collapsed entire job boards. LinkedIn puts
    the posting id in the path (/jobs/view/3912847561), but Indeed uses ?jk= and
    Glassdoor ?jl=, so every Indeed posting shared the key
    "https://www.indeed.com/viewjob" and only the first one survived — a 20-job
    Indeed alert yielded exactly one link, and looked like Indeed simply doesn't
    link its postings.

    Params are sorted so the same posting keys identically regardless of order.
    This errs toward keeping a duplicate rather than dropping a distinct URL: a
    repeated link costs one line in the report, a missing one costs the user a
    manual search.
    """
    base, _, query = url.partition("?")
    if not query:
        return base
    return base + "?" + "&".join(sorted(p for p in query.split("&") if p))


def extract_links(html, limit=60):
    """Pull (anchor_text, url) pairs, de-tracked and deduped, preserving order.

    This is how a posting in the report gets a clickable URL: the body text has
    lost every href by the time it is rendered, so titles and links are carried
    separately and matched on anchor text. It runs on the HTML part even when the
    body came from text/plain, which is why the HTML part is always parsed.

    Footer and nav anchors (unsubscribe, app-store badges) land here too and eat
    into `limit`; 60 leaves room for a 25-posting alert plus its chrome.
    """
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
        key = dedupe_key(url)
        if key in seen:
            continue
        seen.add(key)
        links.append({"text": label[:120], "url": url})
        if len(links) >= limit:
            break
    return links


def clean_text(text, max_chars):
    """Normalise whitespace and enforce the per-message size cap.

    Deliberately does not strip unsubscribe footers. That was implemented and
    measured — ~135 tokens saved per message, and every candidate library did
    worse than the hand-rolled version — but neither number justified owning a
    marker list. Footers now reach the model intact, so SKILL.md carries the one
    instruction that matters: a sender's own corporate address is not a posting.

    The remaining truncation is `max_chars`, which bounds the token budget and
    is unrelated to footer detection.
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t ]+", " ", text)
    text = re.sub(r"\n\s*\n\s*\n+", "\n\n", text)
    lines = [ln.strip() for ln in text.split("\n")]
    text = "\n".join(ln for ln in lines if ln)

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
    """Fetch one account. `cfg` is a single account dict from workspace.mail_config."""
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
            # Most big job boards send multipart/alternative, so the plain part
            # usually wins and html_to_text never runs. Record which path was
            # taken: whether rendering is load-bearing or dead weight depends
            # entirely on who mails you, and that is a fact about the inbox,
            # not something to guess at.
            if len(plain.strip()) > 200:
                body, body_source = plain, "plain"
            else:
                body, body_source = html_to_text(html or plain), "html"
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
                "body_source": body_source,
                "links": extract_links(html) if html else [],
            })

        rendered = sum(1 for m in messages if m["body_source"] == "html")
        return messages, {"account": account_name, "candidates": len(ids),
                          "already_seen": skipped_seen,
                          "filtered_out": skipped_filter, "kept": len(messages),
                          "body_from_plain": len(messages) - rendered,
                          "body_from_html": rendered}
    finally:
        try:
            conn.close()
        except Exception:
            pass
        conn.logout()


# --------------------------------------------------------------------------- #

ENV_GUIDANCE = {
    "gmail": ("Gmail: needs an App Password, not the account password, and each "
              "account needs its own.\n#   Enable 2-Step Verification, then "
              "https://myaccount.google.com/apppasswords\n#   Paste the 16 "
              "characters as shown; spaces are stripped."),
    "m365": ("Microsoft 365: most school and work tenants have basic auth "
             "disabled, in which\n#   case no password here will connect. Run "
             "--check to find out before hunting for one."),
    "outlook": ("Outlook.com: needs an app password with two-step verification "
                "enabled.\n#   Microsoft is also tightening basic auth here, so "
                "verify with --check."),
}


def env_template(workspace, accounts):
    """Print the .env skeleton this config actually needs.

    Hand-maintaining .env.example against config.toml means the two drift the
    moment an account is renamed — and a renamed account changes its derived key
    names, which is exactly when you need to know them. Derive instead of
    document.

    Deliberately never reads the existing .env: it emits placeholders only, so
    running it can never echo a credential to a terminal or a log.
    """
    lines = [
        "# Generated by: fetch_mail.py --env-template",
        "# One USER/PASSWORD pair per [[account]] in %s" % config_path(workspace),
        "# Values are left empty on purpose — fill each one in yourself.",
        "#",
        "# USER is the full email address, not a username.",
        "# This file is read-only credentials for IMAP. The scan never sends,",
        "# replies to, or deletes mail.",
        "",
    ]
    seen_guidance = set()
    for account in accounts:
        provider = account.get("provider") or "imap"
        note = ENV_GUIDANCE.get(provider)
        if note and provider not in seen_guidance:
            seen_guidance.add(provider)
            lines.append("# %s" % note)
        # Values are left EMPTY rather than filled with a dummy string. Sixteen
        # x's read as a value someone already redacted, not as a blank waiting
        # to be filled; an empty one cannot be misread, and is_placeholder()
        # treats it as unset. The format goes in a comment, never inline after
        # the value — this parser does not strip trailing comments, because a
        # real password may legitimately contain '#'.
        lines.append("# account %r (%s)" % (account["name"], account["host"]))
        lines.append("# full email address")
        lines.append("%s=" % account["user_env"])
        lines.append("# 16-character app password, shown as four groups: "
                     "abcd efgh ijkl mnop")
        lines.append("%s=" % account["password_env"])
        lines.append("")
    print("\n".join(lines).rstrip() + "\n")


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
    provider = account.get("provider") or infer_provider(account.get("host"))

    if provider in ("m365", "outlook"):
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

    if provider != "gmail":
        return ("IMAP rejected the login for %r (%s). Check the username and "
                "password in %s under %s / %s, and whether the provider "
                "requires an app-specific password."
                % (account["name"], account["host"], env_file,
                   account["user_env"], account["password_env"]))

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
    ap.add_argument("--max-total", type=int, dest="max_total",
                    help="global message ceiling across all accounts")
    ap.add_argument("--check", action="store_true", help="verify logins only")
    ap.add_argument("--env-template", action="store_true", dest="env_template",
                    help="print the .env skeleton this config needs")
    ap.add_argument("--stdout", action="store_true",
                    help="print JSON to stdout and leave state untouched")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    ws = resolve(args.workspace)
    env = load_env(ws)
    cfg = mail_config(ws)
    accounts = cfg["accounts"]
    budget = args.max_total or cfg["max_total_messages"]

    if args.account:
        wanted = args.account.lower()
        accounts = [a for a in accounts if a["name"].lower() == wanted]
        if not accounts:
            print(json.dumps({
                "error": "unknown_account",
                "requested": args.account,
                "available": [a["name"] for a in cfg["accounts"]],
            }, indent=2))
            return 2

    if args.env_template:
        env_template(ws, accounts)
        return 0

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

    # Enforce the whole-run ceiling, newest first. Undated mail sorts last:
    # a message with no parseable Date is the least trustworthy thing to keep.
    dropped_by_account = {}
    if len(messages) > budget:
        messages.sort(key=lambda m: (bool(m["date"]), m["date"]), reverse=True)
        for msg in messages[budget:]:
            dropped_by_account[msg["account"]] = \
                dropped_by_account.get(msg["account"], 0) + 1
        messages = messages[:budget]

    kept_by_account = {}
    for msg in messages:
        kept_by_account[msg["account"]] = kept_by_account.get(msg["account"], 0) + 1
    for stats in per_account:
        stats["kept_after_budget"] = kept_by_account.get(stats["account"], 0)

    today = datetime.now().strftime("%Y-%m-%d")
    payload = {
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "window_days": args.days,
        "stats": {
            "accounts_scanned": len(per_account),
            "accounts_failed": len(failures),
            "kept": len(messages),
            "already_seen": sum(s["already_seen"] for s in per_account),
            "filtered_out": sum(s["filtered_out"] for s in per_account),
            "total_chars": sum(len(m["body"]) for m in messages),
            # Answers "is html_to_text actually doing anything for my mail?"
            "body_from_plain": sum(1 for m in messages
                                   if m["body_source"] == "plain"),
            "body_from_html": sum(1 for m in messages
                                  if m["body_source"] == "html"),
            "budget": budget,
            "dropped_for_budget": sum(dropped_by_account.values()),
            "dropped_by_account": dropped_by_account,
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
