#!/usr/bin/env python3
"""Turning email parts into the text and links the model reads.

Pure string in, string out — no IMAP, no config, no I/O.
"""

import _bootstrap  # noqa: F401  — must precede any import that assumes 3.14

import email.header
import re
from html import unescape

TRACKING_PARAMS = re.compile(
    r"[?&](utm_[a-z]+|trk|trkEmail|midToken|midSig|eid|ct|lipi|refId|_ga)=[^&]*",
    re.I,
)

# text/plain has no hyperlinks, so senders inline full tracking URLs as visible
# text and wrap them across lines. Measured at 63% of body text, which was
# consuming max_chars and truncating postings away. extract_links() keeps them.
URL_INLINE = re.compile(r"(?:https?://|www\.)\S+", re.I)
URL_FRAGMENT = re.compile(r"\S{28,}")


def html_to_text(html):
    """Render an email's HTML part. bs4 when present, stdlib otherwise.

    Only reached when the text/plain part is missing or stub-sized, so for a
    multipart sender it may never run — stats.body_from_html reports the split.
    When it does run it is load-bearing: raw HTML would spend the whole
    max_chars budget inside <style> and yield no postings at all.
    """
    try:
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html, "html.parser")
        for tag in soup(["script", "style", "head", "meta", "link"]):
            tag.decompose()
        return soup.get_text("\n")
    except ImportError:
        text = re.sub(r"(?is)<(script|style|head).*?</\1>", " ", html)
        text = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</tr>|</li>|</td>", "\n", text)
        text = re.sub(r"<[^>]+>", " ", text)
        # Full entity table: alerts are dense with &middot; and &bull; as
        # separators, and a hand-picked list leaks the rest.
        return unescape(text)


def strip_inline_urls(text):
    """Drop inlined URLs and their wrapped continuations."""
    text = URL_INLINE.sub(" ", text)
    kept = []
    for line in text.split("\n"):
        bare = line.strip()
        # A wrapped continuation is one long token with URL punctuation. Real
        # prose always has spaces, so job text is safe.
        if URL_FRAGMENT.fullmatch(bare) and any(c in bare for c in "?&=/%"):
            continue
        kept.append(line)
    return "\n".join(kept)


def clean_text(text, max_chars):
    """Normalise whitespace, drop inlined URLs, enforce the size cap.

    Does not strip unsubscribe footers: measured at 48% saving, which did not
    justify owning a marker list. SKILL.md tells the model a sender's own
    corporate address is not a posting.
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = strip_inline_urls(text)
    text = re.sub(r"[ \t ]+", " ", text)
    text = re.sub(r"\n\s*\n\s*\n+", "\n\n", text)
    text = "\n".join(ln.strip() for ln in text.split("\n") if ln.strip())
    if len(text) > max_chars:
        text = text[:max_chars] + "\n[...truncated]"
    return text


def dedupe_key(url):
    """Path plus surviving query params, sorted.

    Path alone collapsed whole boards: LinkedIn puts the id in the path, but
    Indeed uses ?jk= and Glassdoor ?jl=, so every Indeed posting shared one key
    and only the first survived.
    """
    base, _, query = url.partition("?")
    if not query:
        return base
    return base + "?" + "&".join(sorted(p for p in query.split("&") if p))


def extract_links(html, limit=60):
    """(anchor text, url) pairs, de-tracked and deduped, in order.

    The only source of posting URLs — clean_text removes them from the body.
    Runs on the HTML part even when the body came from text/plain. Footer and
    nav anchors compete for `limit`.
    """
    links, seen = [], set()
    for match in re.finditer(
        r'<a\s[^>]*href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', html, re.I | re.S
    ):
        url, label = match.group(1), match.group(2)
        if not url.lower().startswith("http"):
            continue
        url = TRACKING_PARAMS.sub("", url).rstrip("?&")
        label = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", label)).strip()
        key = dedupe_key(url)
        if key in seen:
            continue
        seen.add(key)
        links.append({"text": label[:120], "url": url})
        if len(links) >= limit:
            break
    return links


def decode_header_value(raw):
    """RFC 2047 header decode — subjects are often base64 encoded."""
    if not raw:
        return ""
    try:
        return str(email.header.make_header(email.header.decode_header(raw)))
    except (UnicodeDecodeError, LookupError, ValueError):
        return str(raw)


def message_body(msg):
    """Return (plain, html). Skips attachments."""
    plain, html = "", ""
    parts = msg.walk() if msg.is_multipart() else [msg]
    for part in parts:
        if part.get_content_maintype() == "multipart":
            continue
        if "attachment" in str(part.get("Content-Disposition") or "").lower():
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
    return plain, html
