"""One scan: read the config, scrape, write the file, queue the message."""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import datetime, timezone

from azure.storage.blob import ContainerClient
from azure.storage.queue import QueueClient

from .config import ScanConfig, parse_config
from .handoff import build_handoff, message_for, send_message, write_handoff
from .mapping import SITES, posting_from
from .scrape import Scrape, run_searches

log = logging.getLogger("jobspy-scanner")


def postings_from(rows: list[dict]) -> tuple[list[dict], dict[str, int]]:
    """The postings of the rows, once per job link, and the rows dropped per source."""
    postings: list[dict] = []
    dropped: dict[str, int] = {}
    seen: set[tuple[str, str]] = set()
    for row in rows:
        site = str(row.get("site", "")).lower()
        key = (site, str(row.get("job_url", "")))
        if key in seen:
            continue
        seen.add(key)
        posting = posting_from(row, len(postings))
        if posting is None:
            if site in SITES:
                dropped[site] = dropped.get(site, 0) + 1
            continue
        postings.append(posting)
    return postings, dropped


def scan(config: ScanConfig, scrape: Scrape, started_at: datetime) -> dict:
    scraped = run_searches(config, scrape)
    postings, dropped = postings_from(scraped.rows)
    return build_handoff(
        started_at=started_at,
        # Rows that were postings before the checks here dropped some of them.
        extracted=postings,
        postings=postings,
        dropped=dropped,
        warnings=scraped.warnings,
    )


def run_scan(
    *,
    config_text: Callable[[], str],
    scrape: Scrape,
    container: ContainerClient,
    queue: QueueClient,
    now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
) -> str | None:
    """Scan and hand over; returns the file's blob name, or None when scanning is off.

    `collect` waits for this source, so a scan that fails still writes an empty
    file (with the reason as a warning) before the error goes on: the day's
    report runs on the mail alone instead of waiting out the deadline.
    """
    started_at = now()
    try:
        config = parse_config(config_text())
        if not config.enabled:
            log.info("jobspy scan is off in the config")
            return None
        handoff = scan(config, scrape, started_at)
        error = None
    except Exception as err:
        error = err
        handoff = build_handoff(
            started_at=started_at,
            extracted=[],
            postings=[],
            dropped={},
            warnings=[f"jobspy: scan failed: {type(err).__name__}"],
        )
    blob = write_handoff(container, handoff)
    send_message(queue, message_for(handoff, blob, now()))
    log.info("handed over %d postings", len(handoff["postings"]))
    if error:
        raise error
    return blob
