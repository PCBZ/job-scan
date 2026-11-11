"""One scraped row, and what the model read from it, as the `Posting` the Node pipeline carries.

The field names and values are the ones functions/src/lib/postings/types.ts
and schema.ts define. Title, company, place, date and link are copied from the
row; the model supplies the rest (extract.py).
"""

from __future__ import annotations

import hashlib

from jobspy.model import Site

from .extract import Extracted

# jobspy's own site names; a posting's source is the site it came from.
SITES = {site.value for site in Site}


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


def posting_from(row: dict, extracted: Extracted | None, index: int) -> dict:
    """The posting for a usable row. Without an extraction (the call failed) the
    posting keeps what the row says and has no requirements, which the judge
    treats as thin."""
    site, url = text(row.get("site")).lower(), text(row.get("job_url"))
    posted = row.get("date_posted")
    return {
        "title": text(row.get("title")),
        "company": text(row.get("company")),
        "location": text(row.get("location")),
        "workplace": extracted.workplace
        if extracted
        else ("remote" if row.get("is_remote") is True else "unknown"),
        "salary": extracted.salary if extracted else "",
        "posted": text(posted.isoformat() if hasattr(posted, "isoformat") else posted),
        "requirements": extracted.requirements if extracted else [],
        "skills": extracted.skills if extracted else [],
        "link": None,
        "url": url,
        "source": site,
        "account": "jobspy",
        "message_id": hashlib.sha256(f"{site}|{url}".encode()).hexdigest()[:16],
        "message_subject": f"jobspy {site}",
        "row": index,
    }
