"""yfinance price fetching, batched and defensive.

yfinance is a scraper: fields go missing, symbols delist, and occasional
requests just fail. Everything here degrades to "skip this symbol this cycle"
rather than raising, because a live competition must not stall on one bad tick.
"""
from __future__ import annotations

import logging
import math
from datetime import datetime, timezone
from typing import Any, Iterable

import yfinance as yf

from market import NY, REGULAR_CLOSE, REGULAR_OPEN, normalise_state

log = logging.getLogger("xavage.feed")


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


def fetch_quotes(symbols: list[str], batch_size: int = 60) -> list[dict]:
    """Return one quote dict per symbol we could price."""
    out: list[dict] = []
    stamp = datetime.now(timezone.utc)

    for batch in _chunks(symbols, batch_size):
        try:
            tickers = yf.Tickers(" ".join(batch))
        except Exception as exc:  # noqa: BLE001 - never kill the loop
            log.warning("batch construction failed for %s: %s", batch[:3], exc)
            continue

        for symbol in batch:
            try:
                ticker = tickers.tickers.get(symbol)
                if ticker is None:
                    continue

                info = ticker.fast_info
                price = _clean(getattr(info, "last_price", None))

                if price is None or price <= 0:
                    continue

                prev_close = _clean(getattr(info, "previous_close", None))
                day_open = _clean(getattr(info, "open", None))
                day_high = _clean(getattr(info, "day_high", None))
                day_low = _clean(getattr(info, "day_low", None))
                volume = _clean(getattr(info, "last_volume", None))

                raw_state = None
                try:
                    raw_state = ticker.info.get("marketState")
                except Exception:  # noqa: BLE001 - .info is the slow/fragile path
                    raw_state = None

                out.append({
                    "symbol": symbol,
                    "price": round(price, 6),
                    "prev_close": round(prev_close, 6) if prev_close else None,
                    "day_open": round(day_open, 6) if day_open else None,
                    "day_high": round(day_high, 6) if day_high else None,
                    "day_low": round(day_low, 6) if day_low else None,
                    "volume": int(volume) if volume else None,
                    "market_state": normalise_state(raw_state),
                    "quote_time": stamp.isoformat(),
                    "updated_at": stamp.isoformat(),
                })
            except Exception as exc:  # noqa: BLE001
                log.debug("skipping %s: %s", symbol, exc)
                continue

    return out


def fetch_daily_closes(symbols: list[str], batch_size: int = 60) -> dict[str, float]:
    """
    Official previous closes, from DAILY bars.

    Deliberately separate from the intraday feed: a minute-bar series with
    prepost=True ends on an after-hours print, and using that as "previous
    close" makes every day-change percentage wrong. Daily bars carry the real
    4pm close. These only change once a day, so the caller caches them.
    """
    closes: dict[str, float] = {}

    for batch in _chunks(symbols, batch_size):
        try:
            frame = yf.download(
                tickers=" ".join(batch),
                period="5d",
                interval="1d",
                group_by="ticker",
                auto_adjust=False,
                prepost=False,
                threads=True,
                progress=False,
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("daily close download failed (%d symbols): %s", len(batch), exc)
            continue

        if frame is None or frame.empty:
            continue

        today = datetime.now(NY).date()

        for symbol in batch:
            try:
                sub = frame if len(batch) == 1 else (
                    frame[symbol] if symbol in frame.columns.get_level_values(0) else None
                )
                if sub is None:
                    continue

                sub = sub.dropna(subset=["Close"])
                if sub.empty:
                    continue

                # Skip today's (still forming) bar -- we want the PRIOR close.
                prior = sub[[d.date() < today for d in sub.index]]
                source = prior if not prior.empty else sub.iloc[:-1]
                if source.empty:
                    continue

                value = _clean(source["Close"].iloc[-1])
                if value and value > 0:
                    closes[symbol] = round(value, 6)
            except Exception as exc:  # noqa: BLE001
                log.debug("no daily close for %s: %s", symbol, exc)
                continue

    return closes


def fetch_intraday(
    symbols: list[str],
    batch_size: int = 60,
    prev_closes: dict[str, float] | None = None,
    bars_per_symbol: int = 500,
) -> tuple[list[dict], list[dict]]:
    """
    High-frequency path. ONE bulk minute-bar download per batch yields both the
    live quote and the intraday chart series -- the frame we need for the price
    already *is* the chart data, so re-downloading it separately would double the
    requests and leave the chart staler than the price.

    prepost=True matters: with it off, the newest bar during pre-market is
    yesterday's 16:00 close, so the chart sits ~16h behind a live price.

    Returns (quotes, bars_1m).
    """
    out: list[dict] = []
    bars: list[dict] = []
    stamp = datetime.now(timezone.utc)
    state = normalise_state(None)
    prev_closes = prev_closes or {}

    for batch in _chunks(symbols, batch_size):
        try:
            frame = yf.download(
                tickers=" ".join(batch),
                period="2d",
                interval="1m",
                group_by="ticker",
                auto_adjust=False,
                prepost=True,
                threads=True,
                progress=False,
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("bulk download failed (%d symbols): %s", len(batch), exc)
            continue

        if frame is None or frame.empty:
            continue

        for symbol in batch:
            try:
                # With a single symbol yfinance returns a flat frame rather than
                # a ticker-keyed one -- handle both shapes.
                if len(batch) == 1:
                    sub = frame
                else:
                    if symbol not in frame.columns.get_level_values(0):
                        continue
                    sub = frame[symbol]

                sub = sub.dropna(subset=["Close"])
                if sub.empty:
                    continue

                price = _clean(sub["Close"].iloc[-1])
                if price is None or price <= 0:
                    continue

                # Work in exchange-local time so "today" and the regular
                # session window survive DST.
                local = sub.tz_convert(NY) if sub.index.tz is not None else sub.tz_localize("UTC").tz_convert(NY)
                today = local.index[-1].date()
                todays = local[[ts.date() == today for ts in local.index]]

                # Day open/high/low describe the REGULAR session, matching what
                # every finance site shows -- exclude pre/post prints.
                regular = todays[
                    [REGULAR_OPEN <= ts.time() < REGULAR_CLOSE for ts in todays.index]
                ]
                session = regular if not regular.empty else todays
                if session.empty:
                    session = local.tail(1)

                prev_close = prev_closes.get(symbol)
                if prev_close is None:
                    prior = local[[ts.date() < today for ts in local.index]]
                    prev_close = _clean(prior["Close"].iloc[-1]) if not prior.empty else None

                out.append({
                    "symbol": symbol,
                    "price": round(price, 6),
                    "prev_close": round(prev_close, 6) if prev_close else None,
                    "day_open": round(_clean(session["Open"].iloc[0]) or price, 6),
                    "day_high": round(_clean(session["High"].max()) or price, 6),
                    "day_low": round(_clean(session["Low"].min()) or price, 6),
                    "volume": int(_clean(session["Volume"].sum()) or 0),
                    "market_state": state,
                    "quote_time": stamp.isoformat(),
                    "updated_at": stamp.isoformat(),
                })

                # Same frame -> the 1m chart series, free of extra requests.
                bars.extend(_rows_to_bars(symbol, "1m", sub.tail(bars_per_symbol)))
            except Exception as exc:  # noqa: BLE001
                log.debug("skipping %s in bulk parse: %s", symbol, exc)
                continue

    return out, bars


def _rows_to_bars(symbol: str, interval: str, frame) -> list[dict]:
    """Convert an OHLCV frame into price_bars rows, normalised to UTC."""
    rows: list[dict] = []
    for ts, row in frame.iterrows():
        close = _clean(row.get("Close"))
        if close is None or close <= 0:
            continue

        moment = ts.to_pydatetime()
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=timezone.utc)

        rows.append({
            "symbol": symbol,
            "interval": interval,
            "ts": moment.astimezone(timezone.utc).isoformat(),
            "o": round(_clean(row.get("Open")) or close, 6),
            "h": round(_clean(row.get("High")) or close, 6),
            "l": round(_clean(row.get("Low")) or close, 6),
            "c": round(close, 6),
            "v": int(_clean(row.get("Volume")) or 0),
        })
    return rows


def fetch_bars_bulk(
    symbols: list[str], period: str, interval: str, batch_size: int = 60,
) -> list[dict]:
    """
    Longer chart ranges (5m, 1d) for the whole universe in one download per
    batch, rather than one request per symbol per range.
    """
    intraday = interval.endswith("m") or interval.endswith("h")
    out: list[dict] = []

    for batch in _chunks(symbols, batch_size):
        try:
            frame = yf.download(
                tickers=" ".join(batch),
                period=period,
                interval=interval,
                group_by="ticker",
                auto_adjust=False,
                prepost=intraday,
                threads=True,
                progress=False,
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("bulk bar download failed (%s/%s): %s", period, interval, exc)
            continue

        if frame is None or frame.empty:
            continue

        for symbol in batch:
            try:
                sub = frame if len(batch) == 1 else (
                    frame[symbol] if symbol in frame.columns.get_level_values(0) else None
                )
                if sub is None:
                    continue
                sub = sub.dropna(subset=["Close"])
                if sub.empty:
                    continue
                out.extend(_rows_to_bars(symbol, interval, sub))
            except Exception as exc:  # noqa: BLE001
                log.debug("bar parse failed for %s: %s", symbol, exc)
                continue

    return out


def fetch_bars(symbol: str, period: str, interval: str) -> list[dict]:
    """OHLCV history for the chart. Returns [] on any failure."""
    try:
        frame = yf.Ticker(symbol).history(
            period=period, interval=interval, auto_adjust=False, prepost=False,
        )
    except Exception as exc:  # noqa: BLE001
        log.debug("bar fetch failed for %s (%s/%s): %s", symbol, period, interval, exc)
        return []

    if frame is None or frame.empty:
        return []

    bars: list[dict] = []
    for ts, row in frame.iterrows():
        close = _clean(row.get("Close"))
        if close is None or close <= 0:
            continue

        moment = ts.to_pydatetime()
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=timezone.utc)

        bars.append({
            "symbol": symbol,
            "interval": interval,
            "ts": moment.astimezone(timezone.utc).isoformat(),
            "o": round(_clean(row.get("Open")) or close, 6),
            "h": round(_clean(row.get("High")) or close, 6),
            "l": round(_clean(row.get("Low")) or close, 6),
            "c": round(close, 6),
            "v": int(_clean(row.get("Volume")) or 0),
        })

    return bars


def fetch_profile(symbol: str) -> dict | None:
    """Company metadata used to enrich the instruments table."""
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
