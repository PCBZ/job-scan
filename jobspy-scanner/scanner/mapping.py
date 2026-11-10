"""One scraped row to the `Posting` the Node pipeline carries (no model call).

The field names and values are the ones functions/src/lib/postings/types.ts
and schema.ts define; the handoff test reads this module's output through the
Node side so the two can't drift apart.
"""

from __future__ import annotations

import hashlib
import re

# jobspy's site names to the pipeline's source labels.
SOURCES = {
    "linkedin": "linkedin",
    "indeed": "indeed",
    "glassdoor": "glassdoor",
    "zip_recruiter": "ziprecruiter",
    "google": "google",
}

# What the judge reads in place of an extracted requirements list: the
# description's own lines, capped so one long posting can't dominate its input.
MAX_REQUIREMENT_LINES = 40
MAX_LINE_CHARS = 300
MIN_LINE_CHARS = 4

_BULLET = re.compile(r"^\s*(?:[-*•·▪◦]|\d+[.)])\s+")
_MARKUP = re.compile(r"[*_`#>]+")
_ESCAPE = re.compile(r"\\([^\w\s])")

_CURRENCY = {"USD": "$", "CAD": "CA$", "GBP": "£", "EUR": "€"}
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
    low, high = _amount(row.get("min_amount")), _amount(row.get("max_amount"))
    if low is None and high is None:
        return ""
    currency = text(row.get("currency")).upper() or "USD"
    sign = _CURRENCY.get(currency, f"{currency} ")
    per = _PER.get(text(row.get("interval")).lower(), "")
    low = low if low is not None else high
    high = high if high is not None else low
    amount = f"{sign}{_money(low)}" if low == high else f"{sign}{_money(low)} - {sign}{_money(high)}"
    return f"{amount} {per}".strip()


def workplace_of(row: dict) -> str:
    kind = text(row.get("work_from_home_type")).lower()
    if kind in ("remote", "hybrid", "onsite"):
        return kind
    return "remote" if row.get("is_remote") is True else "unknown"


def requirements_from(description: str) -> list[str]:
    """The description's lines, without markdown, capped; empty if there is none."""
    lines: list[str] = []
    for raw in description.splitlines():
        line = _ESCAPE.sub(r"\1", _BULLET.sub("", raw))
        line = " ".join(_MARKUP.sub("", line).split())
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
    if not (title and company and url and site in SOURCES):
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
        "source": SOURCES[site],
        "account": "jobspy",
        "message_id": hashlib.sha256(f"{site}|{url}".encode()).hexdigest()[:16],
        "message_subject": f"jobspy {site}",
        "row": index,
    }
