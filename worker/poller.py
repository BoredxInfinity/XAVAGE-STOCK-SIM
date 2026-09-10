#!/usr/bin/env python3
"""
Xavage price worker.

Primary market-data feed for the competition. On every cycle it:
  1. reads the tradable universe from Supabase
  2. pulls live prices from yfinance
  3. upserts them into `quotes`
  4. calls match_orders() so resting limit/stop/trailing orders fill on the tick
  5. snapshots equity and runs the daily accrual on schedule

Runs anywhere Python does -- a laptop during the event, or Railway/Fly/Render.
Safe to run alongside the Vercel cron fallback: match_orders() takes a
transaction-level advisory lock, so a doubled call is a no-op, not a double fill.
"""
from __future__ import annotations

import logging
import random
import signal
import sys
import time
from datetime import datetime, timezone

import httpx
from supabase import Client, create_client

from config import Config
from feed import fetch_bars_bulk, fetch_daily_closes, fetch_intraday, fetch_profile
from market import just_closed, now_ny, session_state

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s %(name)s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("xavage.worker")

_running = True

# Supabase sits behind an HTTP/2 proxy that will reset a stream under load --
# the initial chart backfill fires ~100 upserts back to back and reliably
# trips it, surfacing as httpx.RemoteProtocolError(StreamReset). These are
# transient: the same request succeeds moments later. Retry them rather than
# losing the whole cycle.
TRANSIENT = (
    httpx.RemoteProtocolError,
    httpx.ReadTimeout,
    httpx.WriteTimeout,
    httpx.ConnectTimeout,
    httpx.ConnectError,
    httpx.ReadError,
    httpx.WriteError,
    httpx.PoolTimeout,
)


def with_retry(label: str, fn, attempts: int = 4, base_delay: float = 0.6):
    """Run a Supabase call, retrying transient network failures with backoff."""
    for attempt in range(1, attempts + 1):
        try:
            return fn()
        except TRANSIENT as exc:
            if attempt == attempts:
                log.error("%s failed after %d attempts: %s", label, attempts, exc)
                raise
            # jitter so parallel retries don't resynchronise into another burst
            delay = base_delay * (2 ** (attempt - 1)) + random.uniform(0, 0.3)
            log.warning("%s: %s (attempt %d/%d, retrying in %.1fs)",
                        label, type(exc).__name__, attempt, attempts, delay)
            time.sleep(delay)


def _stop(signum, _frame):
    global _running
    log.info("signal %s received - finishing this cycle then exiting", signum)
    _running = False


def force_http1(db: Client) -> bool:
    """
    Make PostgREST talk HTTP/1.1 instead of HTTP/2.

    postgrest-py hardcodes http2=True when it builds its httpx client. Some
    egress paths -- Railway's among them -- have the intermediate proxy reset
    every HTTP/2 stream, so *every* request dies with
    RemoteProtocolError(StreamReset), even a single-row select. It is not load
    related and retrying never helps, because the whole connection is affected.
    The same image against the same project works fine from a laptop, which is
    what makes this so easy to misdiagnose as flakiness.

    postgrest exposes `session`, so swap in an equivalent HTTP/1.1 client,
    carrying over the base URL, auth headers and timeout. HTTP/1.1 costs a
    little multiplexing we were never using at this request rate.
    """
    try:
        old = db.postgrest.session
        db.postgrest.session = httpx.Client(
            base_url=old.base_url,
            headers=old.headers,
            timeout=old.timeout,
            follow_redirects=True,
            http2=False,
        )
        return True
    except Exception as exc:  # noqa: BLE001 - never block startup on this
        log.warning("could not force HTTP/1.1, continuing with the default: %s", exc)
        return False


class Worker:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.db: Client = create_client(cfg.supabase_url, cfg.service_role_key)
        if force_http1(self.db):
            log.info("PostgREST pinned to HTTP/1.1")
        self.last_state = session_state()
        self.last_snapshot = 0.0
        self.last_profile_run = 0.0
        self.last_closes_run = 0.0
        self.last_history_run = 0.0
        # newest 1m bar already written per symbol, so each cycle writes only
        # the handful of new bars instead of re-upserting the whole day
        self.bar_hwm: dict[str, str] = {}
        # official previous closes, refreshed from daily bars a few times a day
        self.prev_closes: dict[str, float] = {}
        self.cycle = 0

    # ---------------------------------------------------------------- helpers
    def universe(self) -> list[str]:
        """
        Symbols to quote. Ordered so that if MAX_SYMBOLS ever truncates the
        universe it does so predictably, and loudly -- a silent cap means
        participants get "no live price" on symbols the admin enabled, which
        is very hard to diagnose mid-competition.
        """
        res = with_retry("universe", lambda: (
            self.db.table("instruments")
            .select("symbol", count="exact")
            .eq("is_tradable", True)
            .order("symbol")
            .limit(self.cfg.max_symbols)
            .execute()
        ))
        symbols = [row["symbol"] for row in (res.data or [])]

        total = res.count if res.count is not None else len(symbols)
        if total > len(symbols):
            log.warning(
                "MAX_SYMBOLS=%d is truncating the universe: %d tradable "
                "instruments, only %d quoted. Raise MAX_SYMBOLS or disable "
                "instruments you don't need.",
                self.cfg.max_symbols, total, len(symbols),
            )

        return symbols

    def game_hours_mode(self) -> str:
        """
        The app decides what "open" means: an admin can widen the session to
        pre/post or force it always-open. Polling on a 2-minute idle cadence
        while participants are actively trading extended hours would look like
        a lagging feed, so the worker follows the same rule the engine does.
        """
        try:
            res = with_retry("game_settings", lambda: (
                self.db.table("game_settings")
                .select("market_hours_mode")
                .eq("id", True)
                .maybe_single()
                .execute()
            ))
            return (res.data or {}).get("market_hours_mode") or "regular"
        except Exception:  # noqa: BLE001
            return "regular"

    @staticmethod
    def is_live(state: str, mode: str) -> bool:
        if mode == "always_open":
            return True
        if mode == "extended":
            return state in ("pre", "regular", "post")
        return state == "regular"

    def heartbeat(self, source: str = "worker") -> None:
        with_retry("heartbeat", lambda: self.db.table("system_state").update({
            "last_tick_at": datetime.now(timezone.utc).isoformat(),
            "last_tick_source": source,
        }).eq("id", True).execute())

    # ----------------------------------------------------------------- stages
    def refresh_prev_closes(self, symbols: list[str]) -> None:
        """Official prior-session closes. Cheap, and only changes once a day."""
        closes = fetch_daily_closes(symbols, self.cfg.batch_size)
        if closes:
            self.prev_closes.update(closes)
            log.info("cached %d previous close(s)", len(closes))

    def push_market_data(self, symbols: list[str]) -> tuple[int, int]:
        """
        One download feeds both the live quote and the intraday chart, so the
        chart can never fall behind the price.
        """
        quotes, bars = fetch_intraday(symbols, self.cfg.batch_size, self.prev_closes)
        if not quotes:
            return 0, 0

        # on_conflict=symbol -> one round trip for the whole universe
        with_retry("quotes upsert",
                   lambda: self.db.table("quotes").upsert(quotes, on_conflict="symbol").execute())

        # Only bars newer than what we already stored.
        fresh = [b for b in bars if b["ts"] > self.bar_hwm.get(b["symbol"], "")]
        if fresh:
            self.write_bars(fresh)
            for b in fresh:
                if b["ts"] > self.bar_hwm.get(b["symbol"], ""):
                    self.bar_hwm[b["symbol"]] = b["ts"]

        return len(quotes), len(fresh)

    def write_bars(self, bars: list[dict]) -> None:
        """
        Chunked so no single request is huge, retried so a reset stream costs a
        chunk rather than the cycle, and paced with a short pause so the first
        backfill (~100 chunks) doesn't look like a flood to the proxy.
        """
        chunk = 200
        total = (len(bars) + chunk - 1) // chunk

        for n, i in enumerate(range(0, len(bars), chunk), start=1):
            batch = bars[i : i + chunk]
            try:
                with_retry(
                    f"price_bars chunk {n}/{total}",
                    lambda b=batch: self.db.table("price_bars")
                    .upsert(b, on_conflict="symbol,interval,ts").execute(),
                )
            except TRANSIENT:
                # One lost chunk is a small gap in chart history that the next
                # history refresh repairs. Never abandon the remaining chunks.
                continue
            if total > 5:
                time.sleep(0.05)

    def run_matching(self) -> dict | None:
        try:
            res = with_retry("match_orders", lambda: self.db.rpc("match_orders", {}).execute())
            return res.data
        except Exception as exc:  # noqa: BLE001
            log.error("match_orders failed: %s", exc)
            return None

    def refresh_history(self, symbols: list[str]) -> int:
        """
        The longer chart ranges (5D and 1M-1Y). Bulk-downloaded per interval
        rather than per symbol -- the old per-symbol loop was 3 requests x N
        symbols and took ~30s, which delayed the next price tick.

        The 1m series is NOT refreshed here; it comes from the quote download
        on every cycle.
        """
        written = 0
        for period, interval in (("5d", "5m"), ("1y", "1d")):
            bars = fetch_bars_bulk(symbols, period, interval, self.cfg.batch_size)
            if bars:
                self.write_bars(bars)
                written += len(bars)
            if not _running:
                break
        return written

    def enrich_profiles(self) -> int:
        """Fill in names/sectors for symbols added by search with bare metadata."""
        res = with_retry("pending profiles", lambda: (
            self.db.table("instruments")
            .select("symbol, name, sector")
            .or_("sector.is.null,name.eq.")
            .limit(15)
            .execute()
        ))
        pending = [r["symbol"] for r in (res.data or [])]
        if not pending:
            return 0

        updated = 0
        for symbol in pending:
            profile = fetch_profile(symbol)
            if not profile:
                continue
            with_retry(f"profile {symbol}", lambda pr=profile, sym=symbol: (
                self.db.table("instruments").update({
                    k: v for k, v in pr.items() if k != "symbol" and v is not None
                }).eq("symbol", sym).execute()
            ))
            updated += 1

        return updated

    def daily_jobs(self, state: str) -> None:
        """Expire day orders at the bell; accrue interest once a day after it."""
        if just_closed(self.last_state, state):
            log.info("regular session closed - expiring day orders")
            try:
                res = with_retry("expire_day_orders",
                             lambda: self.db.rpc("expire_day_orders", {}).execute())
                log.info("day orders expired: %s", res.data)
            except Exception as exc:  # noqa: BLE001
                log.error("expire_day_orders failed: %s", exc)

            try:
                res = with_retry("accrue_daily_interest",
                                 lambda: self.db.rpc("accrue_daily_interest", {"p_force": False}).execute())
                log.info("interest accrual: %s", res.data)
            except Exception as exc:  # noqa: BLE001
                log.error("accrue_daily_interest failed: %s", exc)

    def snapshot(self) -> None:
        try:
            with_retry("take_snapshots", lambda: self.db.rpc("take_snapshots", {}).execute())
        except Exception as exc:  # noqa: BLE001
            log.error("take_snapshots failed: %s", exc)

    # ------------------------------------------------------------------- loop
    def run(self) -> None:
        log.info("Xavage worker starting - %s", self.cfg.supabase_url)
        log.info(
            "cadence: %ss live / %ss idle | history refresh every %ss",
            self.cfg.poll_interval, self.cfg.idle_interval, self.cfg.history_interval,
        )

        while _running:
            started = time.monotonic()
            self.cycle += 1
            state = session_state()
            mode = self.game_hours_mode()
            live = self.is_live(state, mode)

            try:
                symbols = self.universe()
                if not symbols:
                    log.warning("no tradable instruments configured - sleeping")
                    time.sleep(self.cfg.idle_interval)
                    continue

                # Refresh official closes on startup and every 6 hours, so the
                # day-change figures are measured from the real 4pm close.
                if time.monotonic() - self.last_closes_run > 21_600 or not self.prev_closes:
                    self.refresh_prev_closes(symbols)
                    self.last_closes_run = time.monotonic()

                pushed, new_bars = self.push_market_data(symbols)
                self.heartbeat()

                matched = self.run_matching() if pushed else None
                self.daily_jobs(state)
                self.last_state = state

                # Equity snapshots: every 5 minutes while the market is live,
                # so the ranking curve has resolution without bloating the table.
                if time.monotonic() - self.last_snapshot > 300:
                    self.snapshot()
                    self.last_snapshot = time.monotonic()

                # Long chart ranges only; the 1m series rides the quote download.
                if time.monotonic() - self.last_history_run > self.cfg.history_interval:
                    count = self.refresh_history(symbols)
                    self.last_history_run = time.monotonic()
                    log.info("history refresh wrote %d rows", count)

                if time.monotonic() - self.last_profile_run > 600:
                    enriched = self.enrich_profiles()
                    self.last_profile_run = time.monotonic()
                    if enriched:
                        log.info("enriched %d instrument profile(s)", enriched)

                elapsed = time.monotonic() - started
                fills = (matched or {}).get("filled") if isinstance(matched, dict) else None

                log.info(
                    "cycle %d | %s%s | %d quotes | %d new bars | %s | %.2fs",
                    self.cycle,
                    state,
                    "" if live else f" (idle, mode={mode})",
                    pushed,
                    new_bars,
                    f"{fills} fill(s)" if fills else "no fills",
                    elapsed,
                )

            except KeyboardInterrupt:
                break
            except Exception as exc:  # noqa: BLE001 - the loop must survive anything
                log.exception("cycle failed: %s", exc)

            interval = self.cfg.poll_interval if live else self.cfg.idle_interval
            sleep_for = max(0.5, interval - (time.monotonic() - started))
            for _ in range(int(sleep_for * 2)):
                if not _running:
                    break
                time.sleep(0.5)

        log.info("worker stopped after %d cycles", self.cycle)


def main() -> int:
    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    cfg = Config.load()
    log.info("exchange clock: %s (%s)", now_ny().strftime("%Y-%m-%d %H:%M:%S"), session_state())

    Worker(cfg).run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
