from datetime import date

from scanner.mapping import (
    MAX_LINE_CHARS,
    MAX_REQUIREMENT_LINES,
    posting_from,
    requirements_from,
    salary_text,
    text,
    workplace_of,
)

from .helpers import DESCRIPTION, INDEED, LINKEDIN, ZIP_HOURLY


def test_missing_cells_are_empty_text():
    assert text(None) == text(float("nan")) == ""
    assert text(" x ") == "x"


def test_salary_reads_like_an_alert_would():
    assert salary_text(INDEED) == "$120,000 - $150,000 a year"
    assert salary_text(ZIP_HOURLY) == "CA$55 an hour"
    assert salary_text({"min_amount": 90000.0, "interval": "yearly"}) == "$90,000 a year"
    assert salary_text({"min_amount": float("nan"), "max_amount": None}) == ""


def test_workplace_from_the_board_then_the_remote_flag():
    assert workplace_of(ZIP_HOURLY) == "hybrid"
    assert workplace_of(LINKEDIN) == "remote"
    assert workplace_of(INDEED) == "unknown"


def test_requirements_are_the_descriptions_lines_as_plain_text():
    assert requirements_from(DESCRIPTION) == [
        "About the role",
        "We build payment systems.",
        "Requirements",
        "3+ years of Python",
        "Experience with Kubernetes & SQL",
        "Comfortable with",
        "on-call",
    ]
    assert requirements_from("") == []


def test_text_that_is_already_plain_keeps_its_lines():
    assert requirements_from("- Python\n- Go and Rust\n\n1) SQL basics\n- C") == [
        "Python",
        "Go and Rust",
        "SQL basics",
    ]


def test_requirements_are_capped():
    lines = requirements_from("\n".join(f"line number {i}" for i in range(100)))
    assert len(lines) == MAX_REQUIREMENT_LINES
    assert len(requirements_from("x" * 1000)[0]) == MAX_LINE_CHARS


def test_a_row_becomes_a_posting():
    p = posting_from({**INDEED, "date_posted": date(2026, 11, 9)}, 3)
    assert p is not None
    assert (p["title"], p["company"], p["source"], p["account"], p["row"]) == (
        "Software Engineer",
        "Acme Pay",
        "indeed",
        "jobspy",
        3,
    )
    assert p["posted"] == "2026-11-09"
    assert p["link"] is None and p["skills"] == []
    assert p["url"] == INDEED["job_url"]


def test_the_same_link_has_the_same_id_and_zip_recruiter_is_one_word():
    a, b = posting_from(INDEED, 0), posting_from(INDEED, 9)
    assert a and b and a["message_id"] == b["message_id"]
    z = posting_from(ZIP_HOURLY, 0)
    assert z and z["source"] == "ziprecruiter" and z["posted"] == ""


def test_a_row_without_a_title_company_link_or_known_site_is_not_a_posting():
    for gap in ({"title": ""}, {"company": None}, {"job_url": ""}, {"site": "bayt"}):
        assert posting_from({**INDEED, **gap}, 0) is None
