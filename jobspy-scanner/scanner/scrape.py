"""Run the searches: one python-jobspy call per title and location.

A search that fails or finds nothing is a line in the warnings and
never stops the others. Nothing here logs what a posting says.
"""

from __future__ import annotations

import logging
import time
from collections import Counter
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, TimeoutError as SearchTimeout, as_completed
from dataclasses import dataclass, field

from .config import ScanConfig

log = logging.getLogger("jobspy-scanner")

# The whole scan has a budget under the host's 30 minutes; searches still
# running when it ends are abandoned and counted.
SCAN_BUDGET_SECONDS = 15 * 60

Scrape = Callable[..., object]


@dataclass
class Scraped:
    rows: list[dict] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    searches: int = 0
    failed: int = 0
    seconds: float = 0.0
    # Per site: rows returned, and searches in which it returned none. A blocked
    # site raises nothing; it goes quiet, and this is where that shows.
    sites: dict[str, dict[str, int]] = field(default_factory=dict)

    def stats(self) -> dict:
        """The Node side's ScrapeStats (functions/src/lib/postings/types.ts)."""
        return {"searches": self.searches, "failed": self.failed, "sites": self.sites}


def searches(config: ScanConfig) -> list[tuple[str, str]]:
    return [(title, place) for title in config.titles for place in config.locations]


def _where(place: str) -> tuple[str, bool]:
    """jobspy's location text, and whether the search is for remote work."""
    if place.lower().startswith("remote"):
        return remote_country(place), True
    return place, False


def remote_country(place: str) -> str:
    # "Remote (US)" searches the country; a bare "Remote" has no country to name.
    inside = place[place.find("(") + 1 : place.rfind(")")] if "(" in place else ""
    return {"us": "USA", "usa": "USA", "canada": "Canada", "ca": "Canada"}.get(
        inside.strip().lower(), inside.strip() or "USA"
    )


def _one(scrape: Scrape, config: ScanConfig, title: str, place: str) -> list[dict]:
    where, remote = _where(place)
    frame = scrape(
        site_name=[site.value for site in config.sites],
        search_term=title,
        location=where,
        is_remote=remote,
        results_wanted=config.results_wanted,
        hours_old=config.hours_old,
        country_indeed=config.country_indeed,
        linkedin_fetch_description=config.fetch_descriptions,
        description_format="plain",
        verbose=0,
    )
    return frame.to_dict("records")  # type: ignore[attr-defined]


def run_searches(
    config: ScanConfig,
    scrape: Scrape,
    *,
    budget: float = SCAN_BUDGET_SECONDS,
    clock: Callable[[], float] = time.monotonic,
) -> Scraped:
    todo = searches(config)
    out = Scraped(
        searches=len(todo),
        sites={site.value: {"rows": 0, "silent": 0} for site in config.sites},
    )
    failed = empty = unfinished = 0
    started = clock()
    pool = ThreadPoolExecutor(max_workers=config.concurrency)
    try:
        futures = {pool.submit(_one, scrape, config, t, p): (t, p) for t, p in todo}
        try:
            for future in as_completed(futures, timeout=budget):
                try:
                    rows = future.result()
                except Exception as err:  # a blocked or broken search, whatever the library raised
                    failed += 1
                    out.failed += 1
                    log.warning("search failed: %s", type(err).__name__)
                else:
                    empty += 0 if rows else 1
                    out.rows.extend(rows)
                    seen = Counter(str(row.get("site", "")).lower() for row in rows)
                    for site, counts in out.sites.items():
                        counts["rows"] += seen[site]
                        counts["silent"] += 0 if seen[site] else 1
        except SearchTimeout:
            unfinished = sum(1 for f in futures if not f.done())
    finally:
        # Searches still running are abandoned, not waited for.
        pool.shutdown(wait=False, cancel_futures=True)
    if failed:
        out.warnings.append(f"jobspy: {failed} of {len(todo)} searches failed")
    if unfinished:
        out.warnings.append(f"jobspy: {unfinished} searches unfinished after {budget:.0f}s")
    if empty:
        out.warnings.append(f"jobspy: {empty} of {len(todo)} searches found nothing")
    out.seconds = clock() - started
    log.info(
        "scanned %d searches in %.0fs: %d rows, %d failed, %d empty, %d unfinished",
        len(todo),
        out.seconds,
        len(out.rows),
        failed,
        empty,
        unfinished,
    )
    return out
