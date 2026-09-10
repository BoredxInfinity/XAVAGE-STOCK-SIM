"""US equity session helpers.

yfinance reports a `marketState` per symbol, but it can be absent or lag at the
open/close, so we corroborate it with the exchange clock in America/New_York.
"""
from __future__ import annotations

from datetime import date, datetime, time
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")

REGULAR_OPEN = time(9, 30)
REGULAR_CLOSE = time(16, 0)
PRE_OPEN = time(4, 0)
POST_CLOSE = time(20, 0)

# NYSE/NASDAQ full-day closures. Extend each year the competition runs.
HOLIDAYS_2026 = {
    date(2026, 1, 1), date(2026, 1, 19), date(2026, 2, 16), date(2026, 4, 3),
    date(2026, 5, 25), date(2026, 6, 19), date(2026, 7, 3), date(2026, 9, 7),
    date(2026, 11, 26), date(2026, 12, 25),
}
HOLIDAYS_2027 = {
    date(2027, 1, 1), date(2027, 1, 18), date(2027, 2, 15), date(2027, 3, 26),
    date(2027, 5, 31), date(2027, 6, 18), date(2027, 7, 5), date(2027, 9, 6),
    date(2027, 11, 25), date(2027, 12, 24),
}
HOLIDAYS = HOLIDAYS_2026 | HOLIDAYS_2027


def now_ny() -> datetime:
    return datetime.now(NY)


def is_trading_day(moment: datetime | None = None) -> bool:
    moment = moment or now_ny()
    return moment.weekday() < 5 and moment.date() not in HOLIDAYS


def session_state(moment: datetime | None = None) -> str:
    """One of 'pre' | 'regular' | 'post' | 'closed', from the exchange clock."""
    moment = moment or now_ny()
    if not is_trading_day(moment):
        return "closed"

    clock = moment.time()
    if REGULAR_OPEN <= clock < REGULAR_CLOSE:
        return "regular"
    if PRE_OPEN <= clock < REGULAR_OPEN:
        return "pre"
    if REGULAR_CLOSE <= clock < POST_CLOSE:
        return "post"
    return "closed"


def normalise_state(raw: str | None, moment: datetime | None = None) -> str:
    """Map yfinance's marketState onto our enum, falling back to the clock."""
    clock_state = session_state(moment)

    if not raw:
        return clock_state

    upper = str(raw).upper()
    mapped = {
        "REGULAR": "regular",
        "PRE": "pre",
        "PREPRE": "pre",
        "POST": "post",
        "POSTPOST": "post",
        "CLOSED": "closed",
    }.get(upper)

    if mapped is None:
        return clock_state

    # Yahoo occasionally reports REGULAR outside the session; trust the clock
    # when the two disagree about whether the regular session is live.
    if mapped == "regular" and clock_state != "regular":
        return clock_state
    return mapped


def just_closed(previous: str, current: str) -> bool:
    """True on the transition out of the regular session -- time to expire day orders."""
    return previous == "regular" and current != "regular"
