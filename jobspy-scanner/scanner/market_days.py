"""The US stock market's trading days (#212): the scan runs only when NYSE is open.

NYSE's closures come from the `holidays` library, which also lists the special
ones NYSE has announced, such as a national day of mourning; one announced after
the pinned version can't be known until it's bumped. The Node app reads the
same library's closures, exported to functions/src/lib/nyse-closures.ts by
scripts/export_closures.py.
"""

from __future__ import annotations

from datetime import date, timedelta
from functools import cache

import holidays

# The most days from one trading day to the next, around NYSE's scheduled
# holidays: Thursday to Monday, around a Friday holiday.
MAX_TRADING_GAP = 4

_DAY = timedelta(days=1)


@cache
def market_holidays(year: int) -> dict[date, str]:
    """NYSE's closures in `year`, date to holiday name."""
    return dict(holidays.financial_holidays("NYSE", years=year))


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
