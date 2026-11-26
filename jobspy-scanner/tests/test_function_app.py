"""The timer handler stops before building any client when the market is closed (#212)."""

import logging
from datetime import datetime, timezone

import pytest

import function_app


class Built(Exception):
    """Raised where the handler would build its first Azure client."""


def at(moment: datetime):
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return moment

    return Clock


@pytest.fixture
def no_clients(monkeypatch):
    def credential():
        raise Built()

    monkeypatch.setattr(function_app, "DefaultAzureCredential", credential)


@pytest.mark.parametrize(
    ("moment", "why"),
    [
        (datetime(2026, 11, 26, 15, tzinfo=timezone.utc), "Thanksgiving Day"),
        (datetime(2026, 11, 28, 15, tzinfo=timezone.utc), "weekend"),
    ],
)
def test_a_closed_day_logs_the_reason_and_builds_nothing(monkeypatch, no_clients, caplog, moment, why):
    monkeypatch.setattr(function_app, "datetime", at(moment))
    with caplog.at_level(logging.INFO):
        assert function_app.scan(None) is None
    assert caplog.messages == [f"jobspy scan: skipped: market closed ({why})"]


def test_a_trading_day_goes_on_to_build_its_clients(monkeypatch, no_clients):
    monkeypatch.setattr(function_app, "datetime", at(datetime(2026, 11, 25, 15, tzinfo=timezone.utc)))
    with pytest.raises(Built):
        function_app.scan(None)
