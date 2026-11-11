"""One scan: read the config, scrape, read the postings, write the file, queue the message."""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import datetime, timezone

from azure.storage.blob import ContainerClient
from azure.storage.queue import QueueClient

from .config import ScanConfig, parse_config
from .extract import Extractor, extract_all
from .handoff import build_handoff, message_for, send_message, write_handoff
from .mapping import SITES, fingerprint, posting_from, text, usable
from .scrape import Scrape, run_searches

log = logging.getLogger("jobspy-scanner")

# With the scrape's 15 minutes this stays inside the host's 30.
EXTRACT_BUDGET_SECONDS = 10 * 60


def distinct(rows: list[dict]) -> tuple[list[dict], dict[str, int]]:
    """The usable rows, once per job link and once per company and title, and the
    rows dropped for lacking a title, company or link, per site."""
    kept: list[dict] = []
    dropped: dict[str, int] = {}
    links: set[tuple[str, str]] = set()
    jobs: set[tuple[str, str]] = set()
    for row in rows:
        site = text(row.get("site")).lower()
        link = (site, text(row.get("job_url")))
        if link in links:
            continue
        links.add(link)
        if not usable(row):
            if site in SITES:
                dropped[site] = dropped.get(site, 0) + 1
            continue
        if fingerprint(row) in jobs:
            continue
        jobs.add(fingerprint(row))
        kept.append(row)
    return kept, dropped


def scan(config: ScanConfig, scrape: Scrape, extractor: Extractor, started_at: datetime) -> dict:
    scraped = run_searches(config, scrape)
    rows, dropped = distinct(scraped.rows)
    warnings = list(scraped.warnings)
    if len(rows) > config.max_postings:
        warnings.append(f"jobspy: {len(rows) - config.max_postings} postings left out (max_postings)")
        rows = rows[: config.max_postings]
    done = extract_all(
        rows,
        extractor,
        concurrency=config.extract_concurrency,
        budget=EXTRACT_BUDGET_SECONDS,
    )
    if done.failed or done.unfinished:
        warnings.append(
            f"jobspy: {done.failed + done.unfinished} of {len(rows)} postings kept without "
            "their requirements (extraction failed or ran out of time)"
        )
    postings = [posting_from(row, done.results[i], i) for i, row in enumerate(rows)]
    return build_handoff(
        started_at=started_at,
        extracted=postings,
        postings=postings,
        dropped=dropped,
        warnings=warnings,
    )


def run_scan(
    *,
    config_text: Callable[[], str],
    scrape: Scrape,
    extractor: Callable[[], Extractor],
    container: ContainerClient,
    queue: QueueClient,
    now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
) -> str:
    """Scan and hand over; returns the file's blob name.

    `collect` waits for this source, so a day with nothing to hand over still
    writes an empty file: a scan the config turns off, and a scan that fails
    (with the reason as a warning, before the error goes on). The day's report
    then runs on the mail alone instead of waiting out the deadline.
    `extractor` is built only once a scan is going to run, so a config that turns
    scanning off needs no model settings.
    """
    started_at = now()
    try:
        config = parse_config(config_text())
        if config.enabled:
            handoff = scan(config, scrape, extractor(), started_at)
        else:
            log.info("jobspy scan is off in the config")
            handoff = build_handoff(
                started_at=started_at, extracted=[], postings=[], dropped={}, warnings=[]
            )
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
