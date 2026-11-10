"""The scan's settings, read from the same config.toml the Node app reads.

Searches come from `target_titles` and `locations`, which the mail pipeline
already uses. An optional `[jobspy]` table tunes the scrape; every key has a
default, so a config without the table scans with those. Unknown keys in the
table are an error, as in the Node app's config.
"""

from __future__ import annotations

import tomllib
from typing import Annotated, Self

from jobspy.model import Site
from pydantic import BaseModel, ConfigDict, Field, StrictBool, model_validator

# The boards the scan uses unless the config names others; the names are jobspy's own.
DEFAULT_SITES = [Site.INDEED, Site.LINKEDIN, Site.GLASSDOOR, Site.ZIP_RECRUITER]

Count = Annotated[int, Field(strict=True, gt=0)]


class ScanConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid", str_strip_whitespace=True)

    enabled: StrictBool = True
    titles: list[str] = []
    locations: list[str] = []
    sites: list[Site] = DEFAULT_SITES
    results_wanted: Count = 15
    hours_old: Count = 48
    concurrency: Count = 2
    country_indeed: str = Field(default="USA", min_length=1)
    fetch_descriptions: StrictBool = True

    @model_validator(mode="after")
    def _something_to_search(self) -> Self:
        if self.enabled and not self.titles:
            raise ValueError("no target_titles to search for")
        if self.enabled and not self.locations:
            raise ValueError("no locations to search in")
        return self


def parse_config(text: str) -> ScanConfig:
    data = tomllib.loads(text)
    table = dict(data.get("jobspy", {}))
    # A `titles` list in [jobspy] narrows the scan; the mail pipeline's list is the default.
    titles = table.pop("titles", None) or data.get("target_titles", [])
    return ScanConfig(titles=titles, locations=data.get("locations", []), **table)
