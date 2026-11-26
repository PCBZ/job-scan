import json
from datetime import date, timedelta
from pathlib import Path

from scanner.market_days import (
    MAX_TRADING_GAP,
    market_closed,
    market_holidays,
    previous_trading_day,
    trading_gap,
)
from scripts.export_closures import LAST_YEAR, NODE_MODULE, render

# NYSE's published closures, read off its site; the Node app's tests read the same file.
NYSE = json.loads((Path(__file__).parent / "fixtures" / "nyse-closures.json").read_text())
CLOSURES = {date.fromisoformat(d) for d in NYSE["closures"]}


def days(start: date, end: date):
    d = start
    while d <= end:
        yield d
        d += timedelta(days=1)


def test_the_holidays_are_nyses_published_closures():
    for year in NYSE["years"]:
        assert set(market_holidays(year)) == {d for d in CLOSURES if d.year == year}


def test_the_node_apps_copy_is_what_the_pinned_library_gives():
    # If this fails after bumping holidays: python -m scripts.export_closures
    assert NODE_MODULE.read_text() == render()


def test_the_special_closures_nyse_announced_are_closed():
    assert market_closed(date(2025, 1, 9)) == "National Day of Mourning for former President Jimmy Carter"


def test_a_saturday_new_years_day_is_not_observed_unlike_the_other_holidays():
    # 2022-01-01 was a Saturday: NYSE opened on 2021-12-31.
    assert market_closed(date(2021, 12, 31)) is None
    # A Sunday one moves to Monday: 2023-01-02.
    assert market_closed(date(2023, 1, 2)) == "New Year's Day (observed)"


def test_every_other_weekday_of_the_published_years_is_open():
    for d in days(date(2026, 1, 1), date(2028, 12, 31)):
        want = "weekend" if d.weekday() >= 5 else "holiday" if d in CLOSURES else None
        got = market_closed(d)
        assert (got if got in (None, "weekend") else "holiday") == want, d


def test_federal_holidays_nyse_trades_through_and_its_early_closes_are_open():
    # Columbus Day, Veterans Day, the day after Thanksgiving.
    assert [market_closed(d) for d in (date(2026, 10, 12), date(2026, 11, 11), date(2026, 11, 27))] == [
        None,
        None,
        None,
    ]


def test_previous_trading_day_steps_back_over_weekends_and_holidays():
    cases = [
        (date(2026, 11, 25), date(2026, 11, 24), 1),  # a Wednesday
        (date(2026, 11, 30), date(2026, 11, 27), 3),  # a Monday
        (date(2026, 11, 27), date(2026, 11, 25), 2),  # after Thanksgiving
        (date(2026, 1, 20), date(2026, 1, 16), 4),  # after Martin Luther King Jr. Day
        (date(2026, 4, 6), date(2026, 4, 2), 4),  # after Good Friday
    ]
    for day, previous, gap in cases:
        assert (previous_trading_day(day), trading_gap(day)) == (previous, gap), day


def test_the_gap_between_trading_days_never_exceeds_the_maximum():
    gaps = [trading_gap(d) for d in days(date(2026, 1, 1), date(LAST_YEAR, 12, 31)) if not market_closed(d)]
    assert max(gaps) == MAX_TRADING_GAP
