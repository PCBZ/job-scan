from datetime import date

from scanner.extract import Extracted
from scanner.mapping import fingerprint, posting_from, text, usable

from .helpers import INDEED, LINKEDIN, PYTHON_ROLE, ZIP_HOURLY


def test_missing_cells_are_empty_text():
    assert text(None) == text(float("nan")) == ""
    assert text(" x ") == "x"


def test_a_row_needs_a_title_company_link_and_a_site_jobspy_knows():
    assert usable(INDEED)
    for gap in ({"title": ""}, {"company": None}, {"job_url": ""}, {"site": "monster"}):
        assert not usable({**INDEED, **gap})


def test_the_same_job_on_two_boards_has_one_fingerprint():
    assert fingerprint(INDEED) == fingerprint({**LINKEDIN, "title": " software ENGINEER ", "company": "acme pay"})


def test_the_row_supplies_the_fields_and_the_model_the_rest():
    p = posting_from({**INDEED, "date_posted": date(2026, 11, 9)}, PYTHON_ROLE, 3)
    assert (p["title"], p["company"], p["source"], p["account"], p["row"]) == (
        "Software Engineer", "Acme Pay", "indeed", "jobspy", 3,
    )  # fmt: skip
    assert p["location"] == "Boston, MA, US" and p["url"] == INDEED["job_url"]
    assert p["posted"] == "2026-11-09"
    assert p["salary"] == PYTHON_ROLE.salary and p["requirements"] == PYTHON_ROLE.requirements
    assert p["skills"] == PYTHON_ROLE.skills and p["workplace"] == "unknown"
    assert p["link"] is None


def test_a_missing_date_is_empty():
    assert posting_from(ZIP_HOURLY, PYTHON_ROLE, 0)["posted"] == ""


def test_the_same_link_has_the_same_id():
    a, b = posting_from(INDEED, PYTHON_ROLE, 0), posting_from(INDEED, PYTHON_ROLE, 9)
    assert a["message_id"] == b["message_id"]
    assert posting_from(ZIP_HOURLY, PYTHON_ROLE, 0)["source"] == "zip_recruiter"


def test_without_an_extraction_the_posting_keeps_the_row_and_is_thin():
    p = posting_from(LINKEDIN, None, 0)
    assert p["workplace"] == "remote" and p["requirements"] == [] and p["salary"] == ""
    assert posting_from(INDEED, None, 0)["workplace"] == "unknown"


def test_the_models_workplace_is_used_when_there_is_one():
    remote = Extracted(workplace="hybrid", salary="", requirements=[], skills=[])
    assert posting_from(INDEED, remote, 0)["workplace"] == "hybrid"
