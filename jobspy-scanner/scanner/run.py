"""One scan: read the config, scrape, write the file, queue the message.

The postings go over unread; collect reads the ones left after its title and
location gates (#203, #204), so the scanner calls no model.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from datetime import date, datetime, timezone

from azure.storage.blob import ContainerClient
from azure.storage.queue import QueueClient

from .config import ScanConfig, parse_config
from .handoff import build_handoff, message_for, run_day, send_message, write_handoff
from .mapping import SITES, fingerprint, posting_from, text, usable
from .market_days import trading_gap
from .scrape import Scrape, run_searches
from .telemetry import AGENT_ATTRIBUTES, RUN_SPAN, node_span, span, trace_of

log = logging.getLogger("jobspy-scanner")


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


def widened(config: ScanConfig, day: date) -> ScanConfig:
    """The scan skips days the market is closed (#212), so the one after searches
    back over them too: `hours_old` on most days, two days more on a Monday."""
    return config.model_copy(update={"hours_old": config.hours_old + 24 * (trading_gap(day) - 1)})


def scan(
    config: ScanConfig,
    scrape: Scrape,
    started_at: datetime,
    clock: Callable[[], float] = time.monotonic,
) -> dict:
    with span(node_span("scrape")):
        scraped = run_searches(config, scrape, clock=clock)
    rows, dropped = distinct(scraped.rows)
    warnings = list(scraped.warnings)
    if len(rows) > config.max_postings:
        warnings.append(f"jobspy: {len(rows) - config.max_postings} postings left out (max_postings)")
        rows = rows[: config.max_postings]
    postings = [posting_from(row, i) for i, row in enumerate(rows)]
    return build_handoff(
        started_at=started_at,
        extracted=postings,
        postings=postings,
        dropped=dropped,
        warnings=warnings,
        scrape=scraped.stats(),
        usage={},
        node_ms={"scrape": round(scraped.seconds * 1000)},
    )


def run_scan(
    *,
    config_text: Callable[[], str],
    scrape: Scrape,
    container: ContainerClient,
    queue: QueueClient,
    now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
) -> str:
    """Scan and hand over; returns the file's blob name.

    `collect` waits for this source, so a scan that fails still writes an empty
    file (with the reason as a warning) before the error goes on: the day's
    report runs on the mail alone instead of waiting out the deadline.
    The run is one span, the root of its trace; the file names that trace so
    `collect` can link to it.
    """
    with span(RUN_SPAN, AGENT_ATTRIBUTES) as run:
        started_at = now()
        try:
            config = widened(parse_config(config_text()), date.fromisoformat(run_day(started_at)))
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
        handoff["trace"] = trace_of(run)
        blob = write_handoff(container, handoff)
        send_message(queue, message_for(handoff, blob, now()))
        log.info("handed over %d postings", len(handoff["postings"]))
        if error:
            raise error
        return blob
