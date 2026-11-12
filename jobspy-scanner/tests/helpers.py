"""Fakes at the library and SDK boundaries; the scanner's own code runs as shipped."""

from __future__ import annotations

from datetime import date, datetime, timezone
from types import SimpleNamespace

import pandas as pd
from openai.types.completion_usage import CompletionUsage

from scanner.extract import Extracted, Extractor

STARTED_AT = datetime(2026, 11, 10, 15, 0, 1, 113000, tzinfo=timezone.utc)

CONFIG = """
[profile]
target_titles = ["Software Engineer"]
locations = ["Boston, MA"]
"""

DESCRIPTION = "About the role. We build payment systems. Requirements: 3+ years of Python, Kubernetes and SQL."


def frame(*rows: dict) -> pd.DataFrame:
    """A frame with jobspy's columns, as scrape_jobs returns it."""
    columns = [
        "site", "title", "company", "location", "job_url", "date_posted", "description",
        "is_remote", "min_amount", "max_amount", "interval", "currency",
    ]  # fmt: skip
    return pd.DataFrame([{c: row.get(c) for c in columns} for row in rows], columns=columns)


INDEED = {
    "site": "indeed",
    "title": "Software Engineer",
    "company": "Acme Pay",
    "location": "Boston, MA, US",
    "job_url": "https://www.indeed.com/viewjob?jk=aaa111",
    "date_posted": date(2026, 11, 9),
    "description": DESCRIPTION,
    "is_remote": False,
    "min_amount": 120000.0,
    "max_amount": 150000.0,
    "interval": "yearly",
    "currency": "USD",
}
LINKEDIN = {
    "site": "linkedin",
    "title": "Backend Engineer",
    "company": "Globex",
    "location": "Remote",
    "job_url": "https://www.linkedin.com/jobs/view/222",
    "date_posted": date(2026, 11, 10),
    "description": "",
    "is_remote": True,
}
ZIP_HOURLY = {
    "site": "zip_recruiter",
    "title": "Data Engineer",
    "company": "Initech",
    "location": "Cambridge, MA, US",
    "job_url": "https://www.ziprecruiter.com/c/initech/job/333",
    "date_posted": None,
    "description": "Own the pipelines.",
    "is_remote": False,
    "min_amount": 55.0,
    "max_amount": 55.0,
    "interval": "hourly",
    "currency": "CAD",
}
NO_COMPANY = {**INDEED, "job_url": "https://www.indeed.com/viewjob?jk=bbb222", "company": None}

ROWS = [INDEED, LINKEDIN, ZIP_HOURLY, INDEED, NO_COMPANY]


class FakeContainer:
    """The ContainerClient call the writer makes."""

    def __init__(self) -> None:
        self.blobs: dict[str, bytes] = {}
        self.calls: list[dict] = []

    def upload_blob(self, name, data, *, overwrite, content_settings, timeout):
        self.calls.append(
            {
                "name": name,
                "overwrite": overwrite,
                "content_type": content_settings.content_type,
                "timeout": timeout,
            }
        )
        if not overwrite and name in self.blobs:
            raise FileExistsError(name)
        self.blobs[name] = data


class FakeQueue:
    """The QueueClient call the sender makes."""

    def __init__(self) -> None:
        self.sent: list[tuple[str, int]] = []

    def send_message(self, content, *, visibility_timeout):
        self.sent.append((content, visibility_timeout))


PYTHON_ROLE = Extracted(
    workplace="unknown",
    salary="USD 120,000 - 150,000 a year",
    requirements=["3+ years of Python", "Kubernetes and SQL"],
    skills=["Python", "Kubernetes", "SQL"],
)


class FakeOpenAI:
    """The one SDK call the extractor makes: client.beta.chat.completions.parse.

    `answer` gets the request's kwargs and returns an Extracted or raises.
    """

    def __init__(self, answer=lambda **_: PYTHON_ROLE) -> None:
        self.requests: list[dict] = []
        self._answer = answer
        completions = SimpleNamespace(parse=self._parse)
        self.beta = SimpleNamespace(chat=SimpleNamespace(completions=completions))

    def _parse(self, **kwargs):
        self.requests.append(kwargs)
        parsed = self._answer(**kwargs)
        message = SimpleNamespace(parsed=parsed)
        usage = CompletionUsage.model_validate(
            {
                "prompt_tokens": 100,
                "completion_tokens": 20,
                "total_tokens": 120,
                "prompt_tokens_details": {"cached_tokens": 40},
                "completion_tokens_details": {"reasoning_tokens": 5},
            }
        )
        return SimpleNamespace(
            choices=[SimpleNamespace(message=message)],
            usage=usage,
            model="extract-deployment-2026-03-17",
        )


def extractor(answer=lambda **_: PYTHON_ROLE) -> Extractor:
    client = FakeOpenAI(answer)
    return Extractor(client, "extract-deployment")  # type: ignore[arg-type]
