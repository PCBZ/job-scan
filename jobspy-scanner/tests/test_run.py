import json
from pathlib import Path

import pytest

from scanner.config import parse_config
from scanner.handoff import iso, message_for, run_day
from scanner.run import postings_from, run_scan, scan

from .helpers import CONFIG, ROWS, STARTED_AT, FakeContainer, FakeQueue, frame


def scrape(**_):
    return frame(*ROWS)


def go(config=CONFIG, scraper=scrape):
    container, queue = FakeContainer(), FakeQueue()
    run = lambda: run_scan(  # noqa: E731
        config_text=lambda: config,
        scrape=scraper,
        container=container,
        queue=queue,
        now=lambda: STARTED_AT,
    )
    return run, container, queue


def test_times_are_written_as_javascript_writes_them_and_the_day_is_vancouvers():
    assert iso(STARTED_AT) == "2026-11-10T15:00:01.113Z"
    assert run_day(STARTED_AT) == "2026-11-10"
    # 03:00 UTC is still the evening before in Vancouver.
    assert run_day(STARTED_AT.replace(hour=3)) == "2026-11-09"


def test_a_link_seen_twice_is_one_posting_and_a_rowless_one_is_dropped():
    postings, dropped = postings_from(frame(*ROWS).to_dict("records"))
    assert [p["company"] for p in postings] == ["Acme Pay", "Globex", "Initech"]
    assert [p["row"] for p in postings] == [0, 1, 2]
    assert dropped == {"indeed": 1}


def test_a_scan_writes_the_file_then_queues_a_message_naming_it():
    run, container, queue = go()
    name = run()
    assert name and name.startswith("2026-11-10/jobspy/2026-11-10T15:00:01.113Z-")
    assert name.endswith(".json") and list(container.blobs) == [name]
    assert container.calls[0]["content_type"] == "application/json; charset=utf-8"
    assert container.calls[0]["overwrite"] is False
    handoff = json.loads(container.blobs[name])
    assert handoff["source"] == "jobspy" and len(handoff["postings"]) == 3
    (content, delay), = queue.sent
    assert delay == 0
    assert json.loads(content) == {
        "day": "2026-11-10",
        "source": "jobspy",
        "blob": name,
        "first_seen": "2026-11-10T15:00:01.113Z",
    }


def test_a_day_that_finds_nothing_still_hands_over_an_empty_file():
    run, container, queue = go(scraper=lambda **_: frame())
    run()
    handoff = json.loads(next(iter(container.blobs.values())))
    assert handoff["postings"] == [] and handoff["warnings"] == ["jobspy: 1 of 1 searches found nothing"]
    assert len(queue.sent) == 1


def test_a_config_that_turns_it_off_hands_over_nothing():
    run, container, queue = go(config="[jobspy]\nenabled = false")
    assert run() is None
    assert container.blobs == {} and queue.sent == []


def test_a_failed_scan_still_hands_over_so_collect_does_not_wait_the_deadline():
    run, container, queue = go(config='target_titles = ["A"]')
    with pytest.raises(ValueError):
        run()
    handoff = json.loads(next(iter(container.blobs.values())))
    assert handoff["postings"] == [] and handoff["warnings"] == ["jobspy: scan failed: ValidationError"]
    assert len(queue.sent) == 1


def test_the_file_matches_the_fixture_the_node_side_reads():
    """functions/test/run/jobspy-handoff.test.ts reads the same file."""
    fixture = json.loads((Path(__file__).parent / "fixtures" / "handoff.json").read_text())
    scanned = scan(parse_config(CONFIG), scrape, STARTED_AT)
    assert scanned == fixture


def test_the_message_matches_the_fixture_the_node_side_reads():
    fixtures = Path(__file__).parent / "fixtures"
    handoff = json.loads((fixtures / "handoff.json").read_text())
    message = json.loads((fixtures / "message.json").read_text())
    assert message_for(handoff, message["blob"], STARTED_AT) == message
