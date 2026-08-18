#!/usr/bin/env python3
"""Fetch job-alert emails over IMAP and emit cleaned, deduped JSON.

Read-only: BODY.PEEK throughout, so \\Seen is never set, and nothing is moved,
flagged or deleted.

    fetch_mail.py --env-template   # the .env keys this config needs
    fetch_mail.py --check          # verify logins only
    fetch_mail.py                  # fetch into data/raw/<date>.json
    fetch_mail.py --stdout         # print instead; leaves state untouched
"""

import _bootstrap  # noqa: F401  — must precede any import that assumes 3.14

import argparse
import email
import email.utils
import imaplib
import json
import os
import ssl
import sys
from datetime import datetime, timedelta, timezone

from mail_text import (clean_text, decode_header_value, extract_links,
                       html_to_text, message_body)
from workspace import (DEFAULT_WORKSPACE, config_path, infer_provider,
                       is_placeholder, load_env, load_state, mail_config,
                       resolve, save_state)

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
            # Namespaced: one alert in two mailboxes is two messages.
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
            # Whether rendering runs at all depends on who mails you, so
            # record it rather than assume.
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

# What goes in the PASSWORD field, which is not the same everywhere: a
# university or self-hosted IMAP server wants the account password, so telling
# everyone "app password" sends some of them hunting for a setting that does
# not exist.
PASSWORD_HINT = {
    "gmail": ("16-character App Password, NOT the account password. Google "
              "disabled plain-password IMAP in 2022, so this is the only "
              "option and it needs 2-Step Verification. Four groups: "
              "abcd efgh ijkl mnop"),
    "m365": ("app password if the tenant permits one. Many work and university "
             "tenants disable basic auth outright — run --check before hunting"),
    "outlook": ("app password, created after enabling two-step verification on "
                "the Microsoft account"),
    "icloud": "app-specific password from appleid.apple.com",
    "yahoo": "app password from Account Security, not the account password",
    "fastmail": "app password with IMAP access, Settings > Privacy & Security",
    "imap": ("the account password — unless this provider requires an "
             "app-specific one, which most large webmail now does"),
}


def env_template(workspace, accounts):
    """Print the .env skeleton this config needs.

    Derived, not documented: a renamed account changes its key names, which is
    exactly when you need to know them. Never reads the existing .env, so it
    cannot echo a credential.
    """
    lines = [
        "# Generated by: fetch_mail.py --env-template",
        "# One USER/PASSWORD pair per [[account]] in %s" % config_path(workspace),
        "# Values are left empty on purpose — fill each one in yourself.",
        "# USER is the full email address, not a username.",
        "#",
        "# Read-only IMAP credentials. The scan never sends, replies or deletes.",
        "",
    ]
    for account in accounts:
        provider = account.get("provider") or "imap"
        # Empty, not a dummy string: sixteen x's read as a redacted value rather
        # than a blank. The format hint goes on its own line because this parser
        # does not strip trailing comments — a real password may contain '#'.
        lines += [
            "# account %r (%s)" % (account["name"], account["host"]),
            "# full email address",
            "%s=" % account["user_env"],
            "# %s" % PASSWORD_HINT.get(provider, PASSWORD_HINT["imap"]),
            "%s=" % account["password_env"],
            "",
        ]
    print("\n".join(lines).rstrip() + "\n")


def credentials_for(account, env):
    user = env.get(account["user_env"]) or os.environ.get(account["user_env"])
    password = (env.get(account["password_env"])
                or os.environ.get(account["password_env"]))
    return user, password


def auth_hint(detail, workspace, account):
    """Provider-specific advice: the two failures need opposite responses."""
    upper = detail.upper()
    if not any(sig in upper for sig in
               ("AUTHENTICATIONFAILED", "AUTHENTICATE FAILED", "LOGIN FAILED",
                "INVALID CREDENTIALS")):
        return None
    env_file = os.path.join(workspace, ".env")
    provider = account.get("provider") or infer_provider(account.get("host"))

    if provider in ("m365", "outlook"):
        # No password fixes a tenant policy, so don't send them hunting.
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
    ap.add_argument("--days", type=int, default=None,
                    help="lookback window; overrides [mail] days in config")
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
    days = args.days if args.days is not None else cfg["days"]

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
            got, stats = fetch(account, user, password, days, state,
                               verbose=not args.quiet)
        except Exception as exc:  # noqa: BLE001
            # One bad mailbox must not sink the run.
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

    # Whole-run ceiling, newest first; undated mail sorts last.
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
        "window_days": days,
        "stats": {
            "accounts_scanned": len(per_account),
            "accounts_failed": len(failures),
            "kept": len(messages),
            "already_seen": sum(s["already_seen"] for s in per_account),
            "filtered_out": sum(s["filtered_out"] for s in per_account),
            "total_chars": sum(len(m["body"]) for m in messages),
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
