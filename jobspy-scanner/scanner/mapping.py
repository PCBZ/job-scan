"""One scraped row to the `Posting` the Node pipeline carries (no model call).

The field names and values are the ones functions/src/lib/postings/types.ts
and schema.ts define; the handoff test reads this module's output through the
Node side so the two can't drift apart.
"""

from __future__ import annotations

import hashlib
import re

from bs4 import BeautifulSoup
from jobspy.model import Site

# What the judge reads in place of an extracted requirements list: the
# description's own lines, capped so one long posting can't dominate its input.
MAX_REQUIREMENT_LINES = 40
MAX_LINE_CHARS = 300
MIN_LINE_CHARS = 4

# jobspy's own site names; a posting's source is the site it came from.
SITES = {site.value for site in Site}

_BULLET = re.compile(r"^\s*(?:[-*•·▪◦]|\d+[.)])\s+")
# Tags that end a line of text. jobspy's own "plain" format folds the whole
# description into one line, which would leave nothing to split.
_BLOCKS = ["p", "li", "div", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "table"]

_PER = {
    "yearly": "a year",
    "monthly": "a month",
    "weekly": "a week",
    "daily": "a day",
    "hourly": "an hour",
}


def text(value: object) -> str:
    """A cell as text; pandas' missing values (None, NaN, NaT) are empty."""
    if value is None or value != value:
        return ""
    return str(value).strip()


def _amount(value: object) -> float | None:
    if value is None or value != value:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _money(value: float) -> str:
    return f"{value:,.0f}" if value >= 100 else f"{value:,.2f}".rstrip("0").rstrip(".")


def salary_text(row: dict) -> str:
    """`USD 120,000 - 150,000 a year`: the currency's code, so any currency reads the same."""
    low, high = _amount(row.get("min_amount")), _amount(row.get("max_amount"))
    if low is None and high is None:
        return ""
    low = low if low is not None else high
    high = high if high is not None else low
    amount = _money(low) if low == high else f"{_money(low)} - {_money(high)}"
    currency = text(row.get("currency")).upper() or "USD"
    per = _PER.get(text(row.get("interval")).lower(), "")
    return f"{currency} {amount} {per}".strip()


def workplace_of(row: dict) -> str:
    # jobspy says only whether a posting is remote; hybrid and onsite aren't in its rows.
    return "remote" if row.get("is_remote") is True else "unknown"


def lines_of(description: str) -> list[str]:
    """The description as lines of plain text: one per block, no markup."""
    soup = BeautifulSoup(description, "html.parser")
    for br in soup.find_all("br"):
        br.replace_with("\n")
    for tag in soup.find_all(_BLOCKS):
        tag.insert_before("\n")
        tag.insert_after("\n")
    return soup.get_text().splitlines()


def requirements_from(description: str) -> list[str]:
    """The description's lines, capped; empty if there is none.

    `description` is jobspy's HTML (description_format="html"); text that is
    already plain passes through, one line per line.
    """
    lines: list[str] = []
    for raw in lines_of(description):
        line = " ".join(_BULLET.sub("", raw).split())
        if len(line) < MIN_LINE_CHARS:
            continue
        lines.append(line[:MAX_LINE_CHARS])
        if len(lines) == MAX_REQUIREMENT_LINES:
            break
    return lines


def posting_from(row: dict, index: int) -> dict | None:
    """The posting for one row, or None when it lacks a title, company or link."""
    title, company, url = text(row.get("title")), text(row.get("company")), text(row.get("job_url"))
    site = text(row.get("site")).lower()
    if not (title and company and url and site in SITES):
        return None
    posted = row.get("date_posted")
    return {
        "title": title,
        "company": company,
        "location": text(row.get("location")),
        "workplace": workplace_of(row),
        "salary": salary_text(row),
        "posted": text(posted.isoformat() if hasattr(posted, "isoformat") else posted),
        "requirements": requirements_from(text(row.get("description"))),
        "skills": [],
        "link": None,
        "url": url,
        "source": site,
        "account": "jobspy",
        "message_id": hashlib.sha256(f"{site}|{url}".encode()).hexdigest()[:16],
        "message_subject": f"jobspy {site}",
        "row": index,
    }
