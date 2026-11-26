"""The US stock market's trading days (#212): the scan runs only when NYSE is open.

Computed from NYSE's holiday rules, so there's no list to keep up to date;
unscheduled closures (a national day of mourning, a storm) can't be foreseen and
so are trading days here. The Node app has the same rules
(functions/src/lib/market-days.ts); both test suites check theirs against NYSE's
published closures (tests/fixtures/nyse-closures.json).
"""

from __future__ import annotations

from datetime import date, timedelta

# The most days from one trading day to the next: Thursday to Monday, around a Friday holiday.
MAX_TRADING_GAP = 4

_DAY = timedelta(days=1)


def _nth(year: int, month: int, weekday: int, n: int) -> date:
    """The `n`th `weekday` (0 is Monday) of `month`; `n` of -1 is the last."""
    if n > 0:
        first = date(year, month, 1)
        return first + timedelta(days=(weekday - first.weekday()) % 7 + 7 * (n - 1))
    last = date(year + month // 12, month % 12 + 1, 1) - _DAY
    return last - timedelta(days=(last.weekday() - weekday) % 7)


def _easter(year: int) -> date:
    """Easter Sunday, by the anonymous Gregorian algorithm."""
    a, b, c = year % 19, year // 100, year % 100
    d, e = b // 4, b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    el = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * el) // 451
    month, day = divmod(h + el - 7 * m + 114, 31)
    return date(year, month, day + 1)


def _observed(day: date, new_year: bool = False) -> date | None:
    """A fixed-date holiday's day off: Saturday's moves to the Friday before and
    Sunday's to the Monday after. NYSE doesn't observe a Saturday New Year's Day
    on Dec 31, so that one has no day off at all."""
    if day.weekday() == 5:
        return None if new_year else day - _DAY
    if day.weekday() == 6:
        return day + _DAY
    return day


def market_holidays(year: int) -> dict[date, str]:
    """NYSE's closures in `year`, date to holiday name."""
    days: list[tuple[date | None, str]] = [
        (_observed(date(year, 1, 1), new_year=True), "New Year's Day"),
        (_nth(year, 1, 0, 3), "Martin Luther King Jr. Day"),
        (_nth(year, 2, 0, 3), "Washington's Birthday"),
        (_easter(year) - 2 * _DAY, "Good Friday"),
        (_nth(year, 5, 0, -1), "Memorial Day"),
        # A market holiday from 2022.
        (_observed(date(year, 6, 19)) if year >= 2022 else None, "Juneteenth"),
        (_observed(date(year, 7, 4)), "Independence Day"),
        (_nth(year, 9, 0, 1), "Labor Day"),
        (_nth(year, 11, 3, 4), "Thanksgiving"),
        (_observed(date(year, 12, 25)), "Christmas"),
    ]
    return {day: name for day, name in days if day is not None}


def market_closed(day: date) -> str | None:
    """Why the market is closed on `day`, or None when it's open."""
    if day.weekday() >= 5:
        return "weekend"
    return market_holidays(day.year).get(day)


def previous_trading_day(day: date) -> date:
    d = day - _DAY
    while market_closed(d):
        d -= _DAY
    return d


def trading_gap(day: date) -> int:
    """Days since the last trading day: 1 on most days, 3 on a Monday, 4 after a Friday holiday."""
    return (day - previous_trading_day(day)).days
