#!/usr/bin/env python3
"""Job-level dedupe so the same posting isn't recommended day after day.

A job's fingerprint is a normalized "company|title" pair, which survives the
minor title/formatting drift between LinkedIn, Indeed, and recruiter emails.

`filter` splits its input three ways:
    new         first sighting, rank these
    repeat      recommended on an earlier day, inside --days
    duplicates  the same posting twice in one batch, which is what happens
                when an alert is delivered to two of your mailboxes

Usage:
    python3 seen_jobs.py filter < jobs.json
    python3 seen_jobs.py add    < jobs.json   # record as seen
    python3 seen_jobs.py list --days 30       # what's been recommended lately

Input JSON is a list of objects each having at least "company" and "title".
"""

import _bootstrap  # noqa: F401  — must precede any import that assumes 3.14

import argparse
import json
import os
import re
import sys
from datetime import datetime, timedelta

from workspace import DEFAULT_WORKSPACE, load_state, resolve, save_state

# Suffixes and decorations that differ between job boards but mean the same role.
NOISE = re.compile(
    r"\b(inc|llc|ltd|corp|corporation|co|company|technologies|technology|labs|"
    r"group|holdings|the)\b|[^a-z0-9 ]",
    re.I,
)
REQ_ID = re.compile(
    r"(\b(?:job\s*id|req(?:uisition)?(?:\s*id)?|posting\s*id|job|id)\b\s*[-:.#]*\s*"
    r"|#\s*)[a-z]*\d{3,}[a-z0-9-]*",
    re.I,
)


def normalize(value):
    value = REQ_ID.sub(" ", (value or "").lower())
    value = NOISE.sub(" ", value)
    return re.sub(r"\s+", " ", value).strip()


def fingerprint(job):
    return "%s|%s" % (normalize(job.get("company")), normalize(job.get("title")))


def read_jobs():
    raw = sys.stdin.read().strip()
    if not raw:
        return []
    jobs = json.loads(raw)
    if isinstance(jobs, dict):
        jobs = jobs.get("jobs", [])
    return jobs


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("command", choices=["filter", "add", "list"])
    ap.add_argument("--workspace", default=DEFAULT_WORKSPACE)
    ap.add_argument("--days", type=int, default=30,
                    help="for `list`, and the repeat-suppression window for `filter`")
    args = ap.parse_args()

    ws = resolve(args.workspace)
    state = load_state(ws)
    seen = state["seen_jobs"]
    today = datetime.now().strftime("%Y-%m-%d")

    if args.command == "list":
        cutoff = (datetime.now() - timedelta(days=args.days)).strftime("%Y-%m-%d")
        rows = [dict(v, fingerprint=k) for k, v in seen.items()
                if v.get("last_seen", "") >= cutoff]
        rows.sort(key=lambda r: r.get("last_seen", ""), reverse=True)
        print(json.dumps(rows, indent=2, ensure_ascii=False))
        return 0

    jobs = read_jobs()
    if args.command == "filter":
        cutoff = (datetime.now() - timedelta(days=args.days)).strftime("%Y-%m-%d")
        new, repeat, duplicates = [], [], []
        # Two buckets of duplication, and they mean different things:
        # `repeat` was recommended on an earlier day; `duplicates` arrived
        # twice today because the same alert went to two mailboxes.
        batch = {}
        for job in jobs:
            fp = fingerprint(job)
            prior = seen.get(fp)
            if prior and prior.get("last_seen", "") >= cutoff:
                repeat.append(dict(job, _fingerprint=fp,
                                   _first_seen=prior.get("first_seen")))
                continue
            if fp in batch:
                kept = new[batch[fp]]
                kept["_duplicate_count"] = kept.get("_duplicate_count", 1) + 1
                duplicates.append(dict(job, _fingerprint=fp))
                continue
            batch[fp] = len(new)
            new.append(dict(job, _fingerprint=fp))
        print(json.dumps({"new": new, "repeat": repeat,
                          "duplicates": duplicates}, indent=2,
                         ensure_ascii=False))
        return 0

    for job in jobs:
        fp = fingerprint(job)
        entry = seen.get(fp, {"first_seen": today})
        entry.update({
            "last_seen": today,
            "title": job.get("title", ""),
            "company": job.get("company", ""),
        })
        seen[fp] = entry
    save_state(ws, state)
    print(json.dumps({"recorded": len(jobs), "total_tracked": len(seen)}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
