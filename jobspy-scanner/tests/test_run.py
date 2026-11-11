import json
from pathlib import Path

import pytest

from scanner.config import parse_config
from scanner.handoff import iso, message_for, run_day
from scanner.run import distinct, run_scan, scan

from .helpers import CONFIG, LINKEDIN, ROWS, STARTED_AT, FakeContainer, FakeQueue, extractor, frame


def scrape(**_):
    return frame(*ROWS)


def go(config=CONFIG, scraper=scrape, model=None):
    container, queue = FakeContainer(), FakeQueue()
    run = lambda: run_scan(  # noqa: E731
        config_text=lambda: config,
        scrape=scraper,
        extractor=lambda: model or extractor(),
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


def test_a_link_or_a_job_seen_twice_is_one_row_and_a_rowless_one_is_dropped():
    same_job_elsewhere = {**LINKEDIN, "title": "software engineer", "company": "ACME PAY"}
    rows, dropped = distinct(frame(*ROWS, same_job_elsewhere).to_dict("records"))
    assert [r["company"] for r in rows] == ["Acme Pay", "Globex", "Initech"]
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


def test_a_config_that_turns_it_off_hands_over_an_empty_file_and_needs_no_model():
    def no_model():
        raise AssertionError("the model is not needed")

    container, queue = FakeContainer(), FakeQueue()
    name = run_scan(
        config_text=lambda: "[jobspy]\nenabled = false",
        scrape=scrape,
        extractor=no_model,
        container=container,  # type: ignore[arg-type]
        queue=queue,  # type: ignore[arg-type]
    )
    handoff = json.loads(container.blobs[name])
    assert handoff["postings"] == [] and handoff["warnings"] == []
    assert len(queue.sent) == 1


def test_postings_over_the_cap_are_left_out_with_a_warning():
    run, container, _ = go(config=CONFIG + "[jobspy]\nmax_postings = 2")
    run()
    handoff = json.loads(next(iter(container.blobs.values())))
    assert len(handoff["postings"]) == 2
    assert handoff["warnings"] == ["jobspy: 1 postings left out (max_postings)"]


def test_a_failed_extraction_keeps_the_posting_without_its_requirements():
    def answer(**_):
        raise RuntimeError("model down")

    run, container, _ = go(model=extractor(answer))
    run()
    handoff = json.loads(next(iter(container.blobs.values())))
    assert len(handoff["postings"]) == 3
    assert all(p["requirements"] == [] for p in handoff["postings"])
    assert handoff["warnings"] == [
        "jobspy: 3 of 3 postings kept without their requirements "
        "(extraction failed or ran out of time)"
    ]


def test_a_failed_scan_still_hands_over_so_collect_does_not_wait_the_deadline():
    run, container, queue = go(config='[profile]\ntarget_titles = ["A"]')
    with pytest.raises(ValueError):
        run()
    handoff = json.loads(next(iter(container.blobs.values())))
    assert handoff["postings"] == [] and handoff["warnings"] == ["jobspy: scan failed: ValidationError"]
    assert len(queue.sent) == 1


def test_the_file_matches_the_golden_file():
    """The shape SourceHandoff (functions/src/lib/run/handoff.ts) reads, kept as a golden file."""
    fixture = json.loads((Path(__file__).parent / "fixtures" / "handoff.json").read_text())
    scanned = scan(parse_config(CONFIG), scrape, extractor(), STARTED_AT)
    assert scanned == fixture


def test_the_message_matches_the_golden_file():
    fixtures = Path(__file__).parent / "fixtures"
    handoff = json.loads((fixtures / "handoff.json").read_text())
    message = json.loads((fixtures / "message.json").read_text())
    assert message_for(handoff, message["blob"], STARTED_AT) == message
