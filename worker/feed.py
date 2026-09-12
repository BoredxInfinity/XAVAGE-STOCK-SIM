"""yfinance price fetching, batched and defensive.

yfinance is a scraper: fields go missing, symbols delist, and occasional
requests just fail. Everything here degrades to "skip this symbol this cycle"
rather than raising, because a live competition must not stall on one bad tick.

Performance notes, because this file runs every few seconds on one shared core:

* **Nothing iterates a DataFrame row by row.** `iterrows()` materialises a
  Series per row; over ~500 bars x ~100 symbols that was ~50k object
  allocations per cycle. Columns are pulled out as numpy arrays once and
  walked as plain floats instead.
* **Index filtering is `searchsorted`, not a list comprehension.** Selecting
  "today" and "the regular session" used to compare every timestamp in Python
  (~470k comparisons per cycle). The index is sorted, so both are O(log n)
  slices.
* **Only bars newer than what the DB already holds are converted at all.** The
  caller passes its high-water marks in, so a steady-state cycle formats a
  couple of hundred rows rather than tens of thousands.
"""
from __future__ import annotations

import logging
import math
import os
import tempfile
from datetime import datetime, timezone
from typing import Any, Iterable

import numpy as np
import pandas as pd
import yfinance as yf

from market import NY, normalise_state, session_anchor

# yfinance caches exchange timezones on disk. Its default location can be
# unwritable or race between threads ("Failed to create TzCache"), which is
# harmless but noisy and costs a lookup per symbol. Point it somewhere
# reliably writable instead.
try:
    _CACHE = os.environ.get("YF_CACHE_DIR", os.path.join(tempfile.gettempdir(), "yfinance-cache"))
    os.makedirs(_CACHE, exist_ok=True)
    yf.set_tz_cache_location(_CACHE)
except Exception:  # noqa: BLE001 - caching is an optimisation, never fatal
    pass

log = logging.getLogger("xavage.feed")

_ISO_UTC = "%Y-%m-%dT%H:%M:%S+00:00"

# Yahoo stamps the bar that is still forming with the moment you asked, not
# with its own boundary -- so polling every ~20s yields 09:31:00, then
# 09:31:22, then 09:31:41, all of which are "the 09:31 bar". Each one is a
# distinct primary key, so they accumulate as sliver candles beside the real
# one instead of updating it. Floor intraday stamps to the interval and the
# upsert collapses them, which is what the inclusive high-water mark assumed
# all along.
#
# Daily bars are deliberately absent: they arrive aligned to the exchange's
# own day, and flooring those to a UTC midnight would shift the key and
# duplicate every bar already stored.
_FLOOR_TO = {"1m": "1min", "2m": "2min", "5m": "5min", "15m": "15min",
             "30m": "30min", "60m": "60min", "90m": "90min", "1h": "1h"}

# A bar with no volume and an implausible range is Yahoo junk, not a trade.
# Real minute bars on these names run a few tenths of a percent; the ones
# being discarded here ran 3.6% to 9.4% on zero volume, which is what drew
# those enormous candles out of an otherwise flat post-market.
_JUNK_RANGE_PCT = 0.02

# The same bad data also arrives flattened -- o=h=l=c, zero volume, sitting
# 3-4% off the real price, which has no range for the rule above to catch.
# Those only give themselves away against their neighbours, so a zero-volume
# bar that jumps this far from the last accepted close is dropped too.
_JUNK_JUMP_PCT = 0.02

# ...but only when the previous bar is recent. Across a session boundary a
# genuine gap of several percent is ordinary, and the first print of a
# pre-market session can legitimately carry no volume.
_NEIGHBOUR_WINDOW_SEC = 900
_REGULAR_OPEN = pd.Timedelta(hours=9, minutes=30)
_REGULAR_CLOSE = pd.Timedelta(hours=16)
_NAN = float("nan")


def _clean(value: Any) -> float | None:
    """Coerce to a finite float, or None. Guards against NaN leaking into the DB."""
    if value is None:
        return None
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    return num if math.isfinite(num) else None


def _chunks(items: list[str], size: int) -> Iterable[list[str]]:
    for i in range(0, len(items), size):
        yield items[i : i + size]


def _download(symbols: list[str], period: str, interval: str, prepost: bool, threads: int):
    """One bulk request per batch, returning None on any failure."""
    try:
        return yf.download(
            tickers=" ".join(symbols),
            period=period,
            interval=interval,
            group_by="ticker",
            auto_adjust=False,
            prepost=prepost,
            threads=threads,
            progress=False,
        )
    except Exception as exc:  # noqa: BLE001 - never kill the loop
        log.warning("download failed (%s/%s, %d symbols): %s", period, interval, len(symbols), exc)
        return None


def _split(frame, symbols: list[str]):
    """Yield (symbol, sub_frame) for each symbol present in a bulk download.

    yfinance hands back a ticker-keyed MultiIndex for a multi-symbol request
    and a flat frame for a single one, so both shapes are handled here rather
    than at every call site.
    """
    if frame is None or frame.empty:
        return

    if isinstance(frame.columns, pd.MultiIndex):
        present = set(frame.columns.get_level_values(0))
        for symbol in symbols:
            if symbol in present:
                yield symbol, frame[symbol]
    elif len(symbols) == 1:
        yield symbols[0], frame


def _column(frame, name: str, length: int) -> np.ndarray:
    """A column as a float64 array, or all-NaN if the field is absent.

    float64 is load-bearing, not just a default: np.float64 subclasses Python
    float, so json.dumps serialises the values in these rows without a custom
    encoder. np.float32 does not, and would raise at upsert time.
    """
    if name not in frame.columns:
        return np.full(length, _NAN)
    return frame[name].to_numpy(dtype="float64", copy=False, na_value=_NAN)


def _to_utc_index(frame):
    """A UTC-aware copy of the index. yfinance is inconsistent about tz."""
    idx = frame.index
    return idx.tz_localize("UTC") if idx.tz is None else idx.tz_convert("UTC")


def _rows_to_bars(symbol: str, interval: str, frame) -> list[dict]:
    """Convert an OHLCV frame into price_bars rows, normalised to UTC.

    Columns come out as numpy arrays and the timestamps are formatted by
    pandas in one vectorised pass; the loop below only ever touches plain
    floats, which is roughly an order of magnitude cheaper than `iterrows()`.
    """
    if frame is None or frame.empty:
        return []

    idx = _to_utc_index(frame)
    floor = _FLOOR_TO.get(interval)
    if floor:
        idx = idx.floor(floor)
        # Flooring can collapse two source rows onto one minute (the settled
        # bar and the forming one). Keeping both would put duplicate keys in a
        # single upsert, which Postgres rejects outright with "ON CONFLICT DO
        # UPDATE command cannot affect row a second time" -- losing the whole
        # chunk. Keep the later row: it is the more complete view of that bar.
        dup = idx.duplicated(keep="last")
        if dup.any():
            frame = frame[~dup]
            idx = idx[~dup]

    n = len(frame)
    stamps = idx.strftime(_ISO_UTC)
    seconds = idx.asi8 // 1_000_000_000
    closes = _column(frame, "Close", n)
    opens = _column(frame, "Open", n)
    highs = _column(frame, "High", n)
    lows = _column(frame, "Low", n)
    volumes = _column(frame, "Volume", n)

    rows: list[dict] = []
    append = rows.append
    prev_close = 0.0
    prev_sec = 0
    for i in range(n):
        close = closes[i]
        if not close > 0:  # also rejects NaN, which fails every comparison
            continue
        o, h, l, v = opens[i], highs[i], lows[i], volumes[i]
        traded = v > 0

        # Two shapes of the same Yahoo junk, both zero-volume. Volume is the
        # tell: every bad print observed had none, and every bar with real
        # volume had a sane range, so neither rule can touch a traded bar.
        if not traded:
            # a) an implausible range within the bar
            if h > 0 and l > 0 and (h - l) > close * _JUNK_RANGE_PCT:
                continue
            # b) a flat bar parked well away from its neighbours
            if (prev_close > 0
                    and seconds[i] - prev_sec <= _NEIGHBOUR_WINDOW_SEC
                    and abs(close - prev_close) > prev_close * _JUNK_JUMP_PCT):
                continue

        prev_close, prev_sec = close, seconds[i]

        append({
            "symbol": symbol,
            "interval": interval,
            "ts": stamps[i],
            "o": round(o if o > 0 else close, 6),
            "h": round(h if h > 0 else close, 6),
            "l": round(l if l > 0 else close, 6),
            "c": round(close, 6),
            "v": int(v) if v == v else 0,
        })
    return rows


def _fresh_slice(frame, mark):
    """Bars at or after the caller's high-water mark.

    Deliberately inclusive of the mark itself: the newest bar in any series is
    still forming (today's daily candle, the current minute), so re-writing it
    each pass is what keeps the last point on a chart live. Anything older has
    settled and never needs sending again.
    """
    if mark is None:
        return frame
    try:
        return frame.iloc[frame.index.searchsorted(mark, side="left"):]
    except (TypeError, ValueError):  # tz or dtype mismatch -- resend everything
        return frame


def fetch_daily_closes(symbols: list[str], batch_size: int = 60, threads: int = 4) -> dict[str, float]:
    """
    Official previous closes, from DAILY bars.

    Deliberately separate from the intraday feed: a minute-bar series with
    prepost=True ends on an after-hours print, and using that as "previous
    close" makes every day-change percentage wrong. Daily bars carry the real
    4pm close. These only change once a day, so the caller caches them.
    """
    closes: dict[str, float] = {}

    for batch in _chunks(symbols, batch_size):
        frame = _download(batch, "5d", "1d", prepost=False, threads=threads)
        # Anchored on the session the current price belongs to, not on the
        # calendar day. Those are the same thing during a session and differ
        # from midnight ET until the next one opens -- and using the calendar
        # there makes "previous close" mean this session's own close, which
        # turns every day-change figure into the after-hours drift.
        anchor = session_anchor()

        for symbol, sub in _split(frame, batch):
            try:
                # Compare on the TRADING DATE, which is the bar's UTC date.
                # yfinance stamps a daily bar at UTC midnight of its session,
                # so in New York it reads 20:00 the evening before: anchoring
                # an ET-midnight cutoff against that is off by a day, and the
                # slice that was meant to drop the forming bar kept it --
                # making "previous close" the live price, and the day change
                # roughly zero, for the whole session.
                dates = _to_utc_index(sub).date
                prior = sub[dates < anchor]
                if prior.empty:
                    prior = sub.iloc[:-1]
                if prior.empty:
                    continue

                series = prior["Close"].to_numpy(dtype="float64", copy=False, na_value=_NAN)
                usable = series[np.isfinite(series)]
                if usable.size and usable[-1] > 0:
                    closes[symbol] = round(float(usable[-1]), 6)
            except Exception as exc:  # noqa: BLE001
                log.debug("no daily close for %s: %s", symbol, exc)

    return closes


def fetch_intraday(
    symbols: list[str],
    batch_size: int = 60,
    prev_closes: dict[str, float] | None = None,
    marks: dict[tuple[str, str], Any] | None = None,
    bars_per_symbol: int = 500,
    threads: int = 4,
) -> tuple[list[dict], list[dict], dict[tuple[str, str], Any]]:
    """
    High-frequency path. ONE bulk minute-bar download per batch yields both the
    live quote and the intraday chart series -- the frame we need for the price
    already *is* the chart data, so re-downloading it separately would double
    the requests and leave the chart staler than the price.

    prepost=True matters: with it off, the newest bar during pre-market is
    yesterday's 16:00 close, so the chart sits ~16h behind a live price.

    Returns (quotes, bars, marks) where `marks` is the new high-water mark per
    (symbol, interval). The caller applies them only once the write lands, so a
    failed upsert is retried rather than silently skipped.
    """
    quotes: list[dict] = []
    bars: list[dict] = []
    new_marks: dict[tuple[str, str], Any] = {}
    state = normalise_state(None)
    prev_closes = prev_closes or {}
    marks = marks or {}

    for batch in _chunks(symbols, batch_size):
        frame = _download(batch, "2d", "1m", prepost=True, threads=threads)
        # Stamped AFTER the download, and per batch.
        #
        # This used to be a single reading taken before the first request went
        # out, so every quote in the cycle was born already as stale as the
        # whole download took -- on the micro instance that is tens of seconds,
        # and the last batch wore the first batch's clock. Participants saw a
        # price that had just arrived described as "updated 19s ago", and the
        # engine's own staleness check (price_staleness_seconds) was spending
        # that budget on our download rather than on the price going off.
        iso = datetime.now(timezone.utc).strftime(_ISO_UTC)

        for symbol, sub in _split(frame, batch):
            try:
                sub = sub.dropna(subset=["Close"])
                if sub.empty:
                    continue

                # Work in exchange-local time so "today" and the regular
                # session window survive DST. The index is sorted, so every
                # window below is a slice rather than a scan.
                local = sub.set_axis(_to_utc_index(sub).tz_convert(NY))
                idx = local.index
                day_start = idx[-1].normalize()

                todays = local.iloc[idx.searchsorted(day_start, side="left"):]
                t_idx = todays.index
                # Day open/high/low describe the REGULAR session, matching what
                # every finance site shows -- exclude pre/post prints.
                session = todays.iloc[
                    t_idx.searchsorted(day_start + _REGULAR_OPEN, side="left"):
                    t_idx.searchsorted(day_start + _REGULAR_CLOSE, side="left")
                ]
                if session.empty:
                    session = todays if not todays.empty else local.tail(1)

                closes = local["Close"].to_numpy(dtype="float64", copy=False, na_value=_NAN)
                price = _clean(closes[-1])
                if price is None or price <= 0:
                    continue

                prev_close = prev_closes.get(symbol)
                if prev_close is None:
                    # No cached official close yet -- fall back to the last
                    # print before today, which is what the frame can offer.
                    cut = idx.searchsorted(day_start, side="left")
                    if cut:
                        earlier = closes[:cut]
                        earlier = earlier[np.isfinite(earlier)]
                        prev_close = float(earlier[-1]) if earlier.size else None

                day_open = _clean(session["Open"].iloc[0])
                quotes.append({
                    "symbol": symbol,
                    "price": round(price, 6),
                    "prev_close": round(prev_close, 6) if prev_close else None,
                    "day_open": round(day_open or price, 6),
                    "day_high": round(_clean(session["High"].max()) or price, 6),
                    "day_low": round(_clean(session["Low"].min()) or price, 6),
                    "volume": int(_clean(session["Volume"].sum()) or 0),
                    "market_state": state,
                    "quote_time": iso,
                    "updated_at": iso,
                })

                # Same frame -> the 1m chart series, free of extra requests.
                # On a cold start only the recent tail is worth backfilling;
                # afterwards only what the DB has not seen.
                key = (symbol, "1m")
                mark = marks.get(key)
                window = _fresh_slice(local, mark) if mark is not None else local.tail(bars_per_symbol)
                if not window.empty:
                    bars.extend(_rows_to_bars(symbol, "1m", window))
                    new_marks[key] = window.index[-1]
            except Exception as exc:  # noqa: BLE001
                log.debug("skipping %s in bulk parse: %s", symbol, exc)

    return quotes, bars, new_marks


def fetch_bars_bulk(
    symbols: list[str],
    period: str,
    interval: str,
    batch_size: int = 60,
    marks: dict[tuple[str, str], Any] | None = None,
    threads: int = 4,
) -> tuple[list[dict], dict[tuple[str, str], Any]]:
    """
    Longer chart ranges (5m, 1d) for the whole universe in one download per
    batch, rather than one request per symbol per range.

    High-water marked like the 1m series: the first pass writes the full range,
    later passes only the bars that have appeared since (plus the still-forming
    final one). That turns a recurring ~60k-row rewrite into a few hundred.
    """
    intraday = interval.endswith("m") or interval.endswith("h")
    out: list[dict] = []
    new_marks: dict[tuple[str, str], Any] = {}
    marks = marks or {}

    for batch in _chunks(symbols, batch_size):
        frame = _download(batch, period, interval, prepost=intraday, threads=threads)

        for symbol, sub in _split(frame, batch):
            try:
                sub = sub.dropna(subset=["Close"])
                if sub.empty:
                    continue
                sub = sub.set_axis(_to_utc_index(sub))
                key = (symbol, interval)
                window = _fresh_slice(sub, marks.get(key))
                if window.empty:
                    continue
                out.extend(_rows_to_bars(symbol, interval, window))
                new_marks[key] = window.index[-1]
            except Exception as exc:  # noqa: BLE001
                log.debug("bar parse failed for %s: %s", symbol, exc)

    return out, new_marks


def fetch_profile(symbol: str) -> dict | None:
    """Company metadata used to enrich the instruments table.

    The only remaining `.info` caller -- it is a slow, fragile scrape, so it
    runs a few symbols at a time on a ten-minute timer and never on the hot
    path.
    """
    try:
        info = yf.Ticker(symbol).info
    except Exception:  # noqa: BLE001
        return None

    if not info:
        return None

    name = info.get("longName") or info.get("shortName")
    if not name:
        return None

    return {
        "symbol": symbol,
        "name": name,
        "exchange": info.get("fullExchangeName") or info.get("exchange"),
        "asset_type": (info.get("quoteType") or "EQUITY").upper(),
        "currency": info.get("currency") or "USD",
        "sector": info.get("sector"),
        "industry": info.get("industry"),
    }
