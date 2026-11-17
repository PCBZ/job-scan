from datetime import date

from scanner.mapping import MAX_DESCRIPTION_CHARS, fingerprint, posting_from, salary_of, text, usable

from .helpers import DESCRIPTION, INDEED, LINKEDIN, ZIP_HOURLY


def test_missing_cells_are_empty_text():
    assert text(None) == text(float("nan")) == ""
    assert text(" x ") == "x"


def test_a_row_needs_a_title_company_link_and_a_site_jobspy_knows():
    assert usable(INDEED)
    for gap in ({"title": ""}, {"company": None}, {"job_url": ""}, {"site": "monster"}):
        assert not usable({**INDEED, **gap})


def test_the_same_job_on_two_boards_has_one_fingerprint():
    assert fingerprint(INDEED) == fingerprint({**LINKEDIN, "title": " software ENGINEER ", "company": "acme pay"})


def test_the_row_supplies_every_field_and_the_description_goes_along_unread():
    p = posting_from({**INDEED, "date_posted": date(2026, 11, 9)}, 3)
    assert (p["title"], p["company"], p["source"], p["account"], p["row"]) == (
        "Software Engineer", "Acme Pay", "indeed", "jobspy", 3,
    )  # fmt: skip
    assert p["location"] == "Boston, MA, US" and p["url"] == INDEED["job_url"]
    assert p["posted"] == "2026-11-09" and p["link"] is None
    assert (p["workplace"], p["salary"]) == ("unknown", "USD 120,000 - 150,000 a year")
    # collect reads it (#203); nothing is read here.
    assert (p["requirements"], p["skills"], p["description"]) == ([], [], DESCRIPTION)


def test_a_long_description_is_cut():
    p = posting_from({**INDEED, "description": "x" * 10_000}, 0)
    assert len(p["description"]) == MAX_DESCRIPTION_CHARS


def test_a_row_without_a_description_goes_over_as_read_and_thin():
    p = posting_from(LINKEDIN, 0)
    assert "description" not in p and p["requirements"] == []
    assert p["workplace"] == "remote"


def test_the_salary_is_the_boards_figures_as_text():
    assert salary_of(ZIP_HOURLY) == "CAD 55 an hour"
    assert salary_of({**INDEED, "max_amount": float("nan")}) == "USD 120,000 a year"
    assert salary_of(LINKEDIN) == ""
    assert salary_of({**INDEED, "currency": None, "interval": None}) == "120,000 - 150,000"


def test_a_missing_date_is_empty():
    assert posting_from(ZIP_HOURLY, 0)["posted"] == ""


def test_the_same_link_has_the_same_id():
    a, b = posting_from(INDEED, 0), posting_from(INDEED, 9)
    assert a["message_id"] == b["message_id"]
    assert posting_from(ZIP_HOURLY, 0)["source"] == "zip_recruiter"
