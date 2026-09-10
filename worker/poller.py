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
import signal
import sys
import time
from datetime import datetime, timezone

from supabase import Client, create_client

from config import Config
from feed import fetch_bars, fetch_daily_closes, fetch_profile, fetch_quotes_fast
from market import just_closed, now_ny, session_state

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s %(name)s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("xavage.worker")

_running = True


def _stop(signum, _frame):
    global _running
    log.info("signal %s received - finishing this cycle then exiting", signum)
    _running = False


class Worker:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.db: Client = create_client(cfg.supabase_url, cfg.service_role_key)
        self.last_state = session_state()
        self.last_bar_run = 0.0
        self.last_snapshot = 0.0
        self.last_profile_run = 0.0
        self.last_closes_run = 0.0
        # official previous closes, refreshed from daily bars a few times a day
        self.prev_closes: dict[str, float] = {}
        self.cycle = 0

    # ---------------------------------------------------------------- helpers
    def universe(self) -> list[str]:
        res = (
            self.db.table("instruments")
            .select("symbol")
            .eq("is_tradable", True)
            .limit(self.cfg.max_symbols)
            .execute()
        )
        return [row["symbol"] for row in (res.data or [])]

    def heartbeat(self, source: str = "worker") -> None:
        self.db.table("system_state").update({
            "last_tick_at": datetime.now(timezone.utc).isoformat(),
            "last_tick_source": source,
        }).eq("id", True).execute()

    # ----------------------------------------------------------------- stages
    def refresh_prev_closes(self, symbols: list[str]) -> None:
        """Official prior-session closes. Cheap, and only changes once a day."""
        closes = fetch_daily_closes(symbols, self.cfg.batch_size)
        if closes:
            self.prev_closes.update(closes)
            log.info("cached %d previous close(s)", len(closes))

    def push_quotes(self, symbols: list[str]) -> int:
        quotes = fetch_quotes_fast(symbols, self.cfg.batch_size, self.prev_closes)
        if not quotes:
            return 0

        # on_conflict=symbol -> one round trip for the whole universe
        self.db.table("quotes").upsert(quotes, on_conflict="symbol").execute()
        return len(quotes)

    def run_matching(self) -> dict | None:
        try:
            res = self.db.rpc("match_orders", {}).execute()
            return res.data
        except Exception as exc:  # noqa: BLE001
            log.error("match_orders failed: %s", exc)
            return None

    def backfill_bars(self, symbols: list[str]) -> int:
        """
        Chart history. Intraday minutes for the live view, daily bars for the
        longer ranges. Chunked upserts keep each request small.
        """
        written = 0
        plans = [("1d", "1m"), ("5d", "5m"), ("1y", "1d")]

        for symbol in symbols:
            for period, interval in plans:
                bars = fetch_bars(symbol, period, interval)
                if not bars:
                    continue
                for i in range(0, len(bars), 500):
                    self.db.table("price_bars").upsert(
                        bars[i : i + 500], on_conflict="symbol,interval,ts"
                    ).execute()
                written += len(bars)

            if not _running:
                break

        return written

    def enrich_profiles(self) -> int:
        """Fill in names/sectors for symbols added by search with bare metadata."""
        res = (
            self.db.table("instruments")
            .select("symbol, name, sector")
            .or_("sector.is.null,name.eq.")
            .limit(15)
            .execute()
        )
        pending = [r["symbol"] for r in (res.data or [])]
        if not pending:
            return 0

        updated = 0
        for symbol in pending:
            profile = fetch_profile(symbol)
            if not profile:
                continue
            self.db.table("instruments").update({
                k: v for k, v in profile.items() if k != "symbol" and v is not None
            }).eq("symbol", symbol).execute()
            updated += 1

        return updated

    def daily_jobs(self, state: str) -> None:
        """Expire day orders at the bell; accrue interest once a day after it."""
        if just_closed(self.last_state, state):
            log.info("regular session closed - expiring day orders")
            try:
                res = self.db.rpc("expire_day_orders", {}).execute()
                log.info("day orders expired: %s", res.data)
            except Exception as exc:  # noqa: BLE001
                log.error("expire_day_orders failed: %s", exc)

            try:
                res = self.db.rpc("accrue_daily_interest", {"p_force": False}).execute()
                log.info("interest accrual: %s", res.data)
            except Exception as exc:  # noqa: BLE001
                log.error("accrue_daily_interest failed: %s", exc)

    def snapshot(self) -> None:
        try:
            self.db.rpc("take_snapshots", {}).execute()
        except Exception as exc:  # noqa: BLE001
            log.error("take_snapshots failed: %s", exc)

    # ------------------------------------------------------------------- loop
    def run(self) -> None:
        log.info("Xavage worker starting - %s", self.cfg.supabase_url)
        log.info(
            "cadence: %ss live / %ss idle | bars every %ss",
            self.cfg.poll_interval, self.cfg.idle_interval, self.cfg.bar_interval,
        )

        while _running:
            started = time.monotonic()
            self.cycle += 1
            state = session_state()

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

                pushed = self.push_quotes(symbols)
                self.heartbeat()

                matched = self.run_matching() if pushed else None
                self.daily_jobs(state)
                self.last_state = state

                # Equity snapshots: every 5 minutes while the market is live,
                # so the ranking curve has resolution without bloating the table.
                if time.monotonic() - self.last_snapshot > 300:
                    self.snapshot()
                    self.last_snapshot = time.monotonic()

                # Bars and profiles are expensive; run them off the hot path.
                if time.monotonic() - self.last_bar_run > self.cfg.bar_interval:
                    count = self.backfill_bars(symbols)
                    self.last_bar_run = time.monotonic()
                    log.info("bar backfill wrote %d rows", count)

                if time.monotonic() - self.last_profile_run > 600:
                    enriched = self.enrich_profiles()
                    self.last_profile_run = time.monotonic()
                    if enriched:
                        log.info("enriched %d instrument profile(s)", enriched)

                elapsed = time.monotonic() - started
                fills = (matched or {}).get("filled") if isinstance(matched, dict) else None

                log.info(
                    "cycle %d | %s | %d quotes | %s | %.2fs",
                    self.cycle,
                    state,
                    pushed,
                    f"{fills} fill(s)" if fills else "no fills",
                    elapsed,
                )

            except KeyboardInterrupt:
                break
            except Exception as exc:  # noqa: BLE001 - the loop must survive anything
                log.exception("cycle failed: %s", exc)

            interval = self.cfg.poll_interval if state == "regular" else self.cfg.idle_interval
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
