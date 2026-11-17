"""One scraped row as the `Posting` the Node pipeline carries, handed over unread.

The field names and values are the ones functions/src/lib/postings/types.ts
and schema.ts define. Every field comes from the row; the requirements and
skills are left empty, and the description goes with the posting, for collect
to read after the title and location gates (#203, #204).
"""

from __future__ import annotations

import hashlib

from jobspy.model import Site

# jobspy's own site names; a posting's source is the site it came from.
SITES = {site.value for site in Site}

# A long description is cut here, so one posting can't dominate the day's tokens.
MAX_DESCRIPTION_CHARS = 6000

# jobspy's pay intervals, as the salary text says them.
INTERVALS = {
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


def fingerprint(row: dict) -> tuple[str, str]:
    """Company and title, folded: the same job on two boards is one."""
    return text(row.get("company")).lower(), text(row.get("title")).lower()


def usable(row: dict) -> bool:
    """A row needs a title, company, link and a site jobspy knows."""
    return bool(
        text(row.get("title"))
        and text(row.get("company"))
        and text(row.get("job_url"))
        and text(row.get("site")).lower() in SITES
    )


def amount(value: object) -> float | None:
    """A pay figure, or None for a missing (NaN) or unusable cell."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value != value or value <= 0:
        return None
    return float(value)


def figure(value: float) -> str:
    """120000.0 -> "120,000"; 55.5 -> "55.5"."""
    return f"{value:,.0f}" if value >= 1000 else f"{value:g}"


def salary_of(row: dict) -> str:
    """The board's pay figures as text, e.g. "USD 120,000 - 150,000 a year"; "" when it gave none."""
    figures = [amount(row.get("min_amount")), amount(row.get("max_amount"))]
    # One figure when the board gave one, or the same twice.
    shown = list(dict.fromkeys(figure(v) for v in figures if v is not None))
    if not shown:
        return ""
    currency = text(row.get("currency")).upper()
    interval = INTERVALS.get(text(row.get("interval")).lower(), "")
    return " ".join(part for part in (currency, " - ".join(shown), interval) if part)


def posting_from(row: dict, index: int) -> dict:
    """The posting for a usable row, with what the board's fields say. A row with
    a description carries it, for collect to read; one without is handed over
    as read, with no requirements, which the judge treats as thin."""
    site, url = text(row.get("site")).lower(), text(row.get("job_url"))
    posted = row.get("date_posted")
    description = text(row.get("description"))[:MAX_DESCRIPTION_CHARS]
    return {
        "title": text(row.get("title")),
        "company": text(row.get("company")),
        "location": text(row.get("location")),
        "workplace": "remote" if row.get("is_remote") is True else "unknown",
        "salary": salary_of(row),
        "posted": text(posted.isoformat() if hasattr(posted, "isoformat") else posted),
        "requirements": [],
        "skills": [],
        "link": None,
        "url": url,
        "source": site,
        "account": "jobspy",
        "message_id": hashlib.sha256(f"{site}|{url}".encode()).hexdigest()[:16],
        "message_subject": f"jobspy {site}",
        "row": index,
        **({"description": description} if description else {}),
    }
