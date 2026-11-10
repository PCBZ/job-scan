"""The scan's settings, read from the same config.toml the Node app reads.

Searches come from `target_titles` and `locations`, which the mail pipeline
already uses. An optional `[jobspy]` table tunes the scrape; every key has a
default, so a config without the table scans with those.
"""

from __future__ import annotations

import tomllib
from dataclasses import dataclass

SITES = ("indeed", "linkedin", "glassdoor", "zip_recruiter", "google")
DEFAULT_SITES = ("indeed", "linkedin", "glassdoor", "zip_recruiter")


class ConfigError(Exception):
    """The config can't be scanned with; the message says why."""


@dataclass(frozen=True)
class ScanConfig:
    enabled: bool
    titles: tuple[str, ...]
    locations: tuple[str, ...]
    sites: tuple[str, ...]
    results_wanted: int
    hours_old: int
    concurrency: int
    country_indeed: str
    fetch_descriptions: bool


def _strings(data: dict, key: str, where: str) -> tuple[str, ...]:
    value = data.get(key, [])
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise ConfigError(f"{where}{key} must be a list of strings")
    return tuple(v.strip() for v in value if v.strip())


def _whole(table: dict, key: str, default: int) -> int:
    value = table.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ConfigError(f"[jobspy] {key} must be a positive whole number")
    return value


def parse_config(text: str) -> ScanConfig:
    try:
        data = tomllib.loads(text)
    except tomllib.TOMLDecodeError as err:
        raise ConfigError(f"config is not valid TOML: {err}") from err
    table = data.get("jobspy", {})
    if not isinstance(table, dict):
        raise ConfigError("[jobspy] must be a table")

    # A `titles` list in [jobspy] narrows the scan; the mail pipeline's list is the default.
    titles = _strings(table, "titles", "[jobspy] ") or _strings(data, "target_titles", "")
    locations = _strings(data, "locations", "")
    sites = _strings(table, "sites", "[jobspy] ") or DEFAULT_SITES
    unknown = [s for s in sites if s not in SITES]
    if unknown:
        raise ConfigError(f"[jobspy] sites: unknown {', '.join(unknown)}")
    enabled = table.get("enabled", True)
    if not isinstance(enabled, bool):
        raise ConfigError("[jobspy] enabled must be true or false")
    fetch = table.get("fetch_descriptions", True)
    if not isinstance(fetch, bool):
        raise ConfigError("[jobspy] fetch_descriptions must be true or false")
    country = table.get("country_indeed", "USA")
    if not isinstance(country, str) or not country.strip():
        raise ConfigError("[jobspy] country_indeed must be a country name")
    if enabled and not titles:
        raise ConfigError("no target_titles to search for")
    if enabled and not locations:
        raise ConfigError("no locations to search in")
    return ScanConfig(
        enabled=enabled,
        titles=titles,
        locations=locations,
        sites=tuple(sites),
        results_wanted=_whole(table, "results_wanted", 15),
        hours_old=_whole(table, "hours_old", 48),
        concurrency=_whole(table, "concurrency", 2),
        country_indeed=country.strip(),
        fetch_descriptions=fetch,
    )
