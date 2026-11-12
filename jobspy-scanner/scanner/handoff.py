"""What the scanner hands to `collect`: one JSON file and one queue message.

The file is the Node side's SourceHandoff (functions/src/lib/run/handoff.ts,
version 1) and the message its HandoffMessage; `collect` reads both with the
code that reads the mail source's. A file holds posting text: private
container, short retention, never in the repo or a log.
"""

from __future__ import annotations

import json
import secrets
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from azure.storage.blob import ContainerClient, ContentSettings
from azure.storage.queue import QueueClient

SOURCE = "jobspy"
RUN_TIME_ZONE = "America/Vancouver"
# A stuck upload ends as a failed write, not a run held to the host's timeout.
WRITE_TIMEOUT_SECONDS = 60


def iso(moment: datetime) -> str:
    """The instant as JavaScript's toISOString writes it: milliseconds, Z."""
    return moment.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def run_day(moment: datetime) -> str:
    """The run's day in Vancouver's zone, like the Node side's runDay."""
    return moment.astimezone(ZoneInfo(RUN_TIME_ZONE)).strftime("%Y-%m-%d")


def build_handoff(
    *,
    started_at: datetime,
    extracted: list[dict],
    postings: list[dict],
    dropped: dict[str, int],
    warnings: list[str],
    scrape: dict | None = None,
) -> dict:
    return {
        "version": 1,
        "source": SOURCE,
        "day": run_day(started_at),
        "started_at": iso(started_at),
        "trace": None,
        "node_ms": {},
        "throttled_ms": 0,
        "rate_limited": 0,
        "mail": None,
        "extracted": extracted,
        "postings": postings,
        "dropped": dropped,
        **({"scrape": scrape} if scrape else {}),
        "suspicious": {},
        "usage": {},
        "extract_loop": {"turns": [], "problems": [], "retry": False},
        "warnings": warnings,
    }


def blob_name(handoff: dict) -> str:
    """`<day>/<source>/<started-at>-<random>.json`: a rerun on the same day keeps both."""
    return f"{handoff['day']}/{handoff['source']}/{handoff['started_at']}-{secrets.token_hex(4)}.json"


def write_handoff(container: ContainerClient, handoff: dict) -> str:
    """Upload the file to the postings container; returns the blob's name."""
    name = blob_name(handoff)
    body = json.dumps(handoff, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    container.upload_blob(
        name,
        body,
        overwrite=False,
        content_settings=ContentSettings(content_type="application/json; charset=utf-8"),
        timeout=WRITE_TIMEOUT_SECONDS,
    )
    return name


def message_for(handoff: dict, blob: str, first_seen: datetime) -> dict:
    return {
        "day": handoff["day"],
        "source": handoff["source"],
        "blob": blob,
        "first_seen": iso(first_seen),
    }


def send_message(queue: QueueClient, message: dict, delay_seconds: int = 0) -> None:
    """Plain JSON, readable in the portal; host.json's messageEncoding "none" matches."""
    queue.send_message(
        json.dumps(message, separators=(",", ":")), visibility_timeout=delay_seconds
    )
