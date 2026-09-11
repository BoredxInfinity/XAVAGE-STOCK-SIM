#!/usr/bin/env python3
"""
Xavage price worker.

Primary market-data feed for the competition. On every cycle it:
  1. reads the tradable universe from Supabase
  2. pulls live prices from yfinance
  3. upserts them into `quotes`
  4. calls match_orders() so resting limit/stop/trailing orders fill on the tick
  5. snapshots equity and runs the daily accrual on schedule

Sized for a 1 GB / 1 OCPU box: the only third-party dependency is yfinance,
Supabase is spoken to over the standard library, and each cycle touches the
network as few times as it can get away with.

Safe to run alongside the Vercel cron fallback: match_orders() takes a
transaction-level advisory lock, so a doubled call is a no-op, not a double fill.
"""
from __future__ import annotations

import os

# numpy links against OpenBLAS, which sizes its per-thread scratch buffers by
# core count at import time and can claim tens of megabytes before we do any
# work at all. Nothing here is a matrix workload, so pin it to one thread.
# This MUST happen before numpy is imported, i.e. before `feed`.
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")
os.environ.setdefault("NUMEXPR_NUM_THREADS", "1")

import logging  # noqa: E402
import signal  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

from config import Config  # noqa: E402
from db import Postgrest, PostgrestError  # noqa: E402
from feed import fetch_bars_bulk, fetch_daily_closes, fetch_intraday, fetch_profile  # noqa: E402
from market import just_closed, now_ny, session_state  # noqa: E402

# Route INFO/DEBUG to stdout and WARNING+ to stderr, so "error" in the log
# viewer means something actually went wrong rather than "the worker is
# running". journalctl preserves the split as priority levels.
_FORMAT = logging.Formatter("%(asctime)s  %(levelname)-7s %(name)s  %(message)s", "%H:%M:%S")

_stdout = logging.StreamHandler(sys.stdout)
_stdout.setFormatter(_FORMAT)
_stdout.addFilter(lambda record: record.levelno < logging.WARNING)

_stderr = logging.StreamHandler(sys.stderr)
_stderr.setFormatter(_FORMAT)
_stderr.setLevel(logging.WARNING)

logging.basicConfig(level=logging.INFO, handlers=[_stdout, _stderr])

# yfinance logs individual ticker timeouts at ERROR. They are expected and
# self-healing (the symbol is retried next cycle), so keep them out of the
# error stream where they would look like worker failures.
logging.getLogger("yfinance").setLevel(logging.CRITICAL)

log = logging.getLogger("xavage.worker")

_running = True

# How long the universe and the admin's market-hours setting may be reused
# before re-reading them. Both change by hand, minutes apart at most, and
# re-reading them every 5s was two thirds of the worker's request volume.
SETTINGS_TTL = 60.0


def _stop(signum, _frame):
    global _running
    log.info("signal %s received - finishing this cycle then exiting", signum)
    _running = False


class Worker:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.db = Postgrest(cfg.supabase_url, cfg.service_role_key)
        self.last_state = session_state()
        self.last_snapshot = 0.0
        self.last_profile_run = 0.0
        self.last_closes_run = 0.0
        self.last_history_run = 0.0
        self.last_settings_run = 0.0
        self._symbols: list[str] = []
        self._mode = "regular"
        # Newest bar already written per (symbol, interval), so each cycle
        # sends the handful that are new instead of the whole series.
        self.marks: dict[tuple[str, str], object] = {}
        # Official previous closes, refreshed from daily bars a few times a day
        self.prev_closes: dict[str, float] = {}
        self.cycle = 0

    # ---------------------------------------------------------------- helpers
    def refresh_settings(self) -> None:
        """
        Universe + market-hours mode, on a slow timer.

        The universe is ordered so that if MAX_SYMBOLS ever truncates it, it
        does so predictably and loudly -- a silent cap means participants get
        "no live price" on symbols the admin enabled, which is very hard to
        diagnose mid-competition.
        """
        rows, total = self.db.select(
            "instruments",
            {"select": "symbol", "is_tradable": "eq.true", "order": "symbol",
             "limit": self.cfg.max_symbols},
            count=True,
            label="universe",
        )
        self._symbols = [row["symbol"] for row in rows]

        if total is not None and total > len(self._symbols):
            log.warning(
                "MAX_SYMBOLS=%d is truncating the universe: %d tradable "
                "instruments, only %d quoted. Raise MAX_SYMBOLS or disable "
                "instruments you don't need.",
                self.cfg.max_symbols, total, len(self._symbols),
            )

        # The app decides what "open" means: an admin can widen the session to
        # pre/post or force it always-open. Polling on the idle cadence while
        # participants actively trade extended hours would look like a lagging
        # feed, so the worker follows the same rule the engine does.
        try:
            settings, _ = self.db.select(
                "game_settings",
                {"select": "market_hours_mode", "id": "eq.true", "limit": 1},
                label="game_settings",
            )
            self._mode = (settings[0].get("market_hours_mode") if settings else None) or "regular"
        except PostgrestError as exc:
            log.warning("could not read market_hours_mode, assuming 'regular': %s", exc)
            self._mode = "regular"

    @staticmethod
    def is_live(state: str, mode: str) -> bool:
        if mode == "always_open":
            return True
        if mode == "extended":
            return state in ("pre", "regular", "post")
        return state == "regular"

    def heartbeat(self, source: str = "worker") -> None:
        self.db.update(
            "system_state",
            {"last_tick_at": datetime.now(timezone.utc).isoformat(),
             "last_tick_source": source},
            {"id": "eq.true"},
            label="heartbeat",
        )

    # ----------------------------------------------------------------- stages
    def refresh_prev_closes(self, symbols: list[str]) -> None:
        """Official prior-session closes. Cheap, and only changes once a day."""
        closes = fetch_daily_closes(symbols, self.cfg.batch_size, self.cfg.download_threads)
        if closes:
            self.prev_closes.update(closes)
            log.info("cached %d previous close(s)", len(closes))

    def push_market_data(self, symbols: list[str]) -> tuple[int, int]:
        """
        One download feeds both the live quote and the intraday chart, so the
        chart can never fall behind the price.
        """
        quotes, bars, marks = fetch_intraday(
            symbols,
            self.cfg.batch_size,
            self.prev_closes,
            self.marks,
            self.cfg.bars_per_symbol,
            self.cfg.download_threads,
        )
        if not quotes:
            return 0, 0

        # on_conflict=symbol -> one round trip for the whole universe
        self.db.upsert("quotes", quotes, "symbol", label="quotes upsert")

        written, failed = self.write_bars(bars)
        if not failed:
            self.marks.update(marks)
        return len(quotes), written

    def write_bars(self, bars: list[dict]) -> tuple[int, int]:
        """
        Chunked so no single request is huge, and retried inside the client so
        a dropped socket costs a chunk rather than the cycle.

        Returns (rows written, chunks lost). The caller holds its high-water
        marks back unless every chunk landed, so a dropped chunk is resent next
        cycle rather than becoming a permanent hole in the chart.
        """
        if not bars:
            return 0, 0

        chunk = 500
        written = failed = 0
        total = (len(bars) + chunk - 1) // chunk

        for n, i in enumerate(range(0, len(bars), chunk), start=1):
            batch = bars[i : i + chunk]
            try:
                self.db.upsert("price_bars", batch, "symbol,interval,ts",
                               label=f"price_bars chunk {n}/{total}")
                written += len(batch)
            except PostgrestError as exc:
                # Never abandon the remaining chunks over one bad request.
                log.warning("price_bars chunk %d/%d dropped: %s", n, total, exc)
                failed += 1
        return written, failed

    def run_matching(self) -> dict | None:
        try:
            return self.db.rpc("match_orders")
        except PostgrestError as exc:
            log.error("match_orders failed: %s", exc)
            return None

    def refresh_history(self, symbols: list[str]) -> int:
        """
        The longer chart ranges (5D and 1Y). Bulk-downloaded per interval
        rather than per symbol, and high-water marked like the 1m series, so
        after the first pass this writes the few bars that actually appeared
        instead of rewriting ~60k rows every half hour.

        The 1m series is NOT refreshed here; it rides the quote download.
        """
        written = 0
        for period, interval in (("5d", "5m"), ("1y", "1d")):
            bars, marks = fetch_bars_bulk(
                symbols, period, interval, self.cfg.batch_size,
                self.marks, self.cfg.download_threads,
            )
            rows, failed = self.write_bars(bars)
            written += rows
            if not failed:
                self.marks.update(marks)
            if not _running:
                break
        return written

    def enrich_profiles(self) -> int:
        """Fill in names/sectors for symbols added by search with bare metadata."""
        rows, _ = self.db.select(
            "instruments",
            {"select": "symbol", "or": "(sector.is.null,name.eq.)", "limit": 8},
            label="pending profiles",
        )
        pending = [r["symbol"] for r in rows]
        if not pending:
            return 0

        updated = 0
        for symbol in pending:
            profile = fetch_profile(symbol)
            if not profile:
                continue
            patch = {k: v for k, v in profile.items() if k != "symbol" and v is not None}
            self.db.update("instruments", patch, {"symbol": f"eq.{symbol}"},
                           label=f"profile {symbol}")
            updated += 1

        return updated

    def daily_jobs(self, state: str) -> None:
        """Expire day orders at the bell; accrue interest once a day after it."""
        if not just_closed(self.last_state, state):
            return

        log.info("regular session closed - expiring day orders")
        for fn, args in (("expire_day_orders", None), ("accrue_daily_interest", {"p_force": False})):
            try:
                log.info("%s: %s", fn, self.db.rpc(fn, args))
            except PostgrestError as exc:
                log.error("%s failed: %s", fn, exc)

    def snapshot(self) -> None:
        try:
            self.db.rpc("take_snapshots")
        except PostgrestError as exc:
            log.error("take_snapshots failed: %s", exc)

    # ------------------------------------------------------------------- loop
    def tick(self) -> bool:
        """One full cycle. Returns True if it was a live-market cycle."""
        started = time.monotonic()
        self.cycle += 1
        state = session_state()

        if time.monotonic() - self.last_settings_run > SETTINGS_TTL or not self._symbols:
            self.refresh_settings()
            self.last_settings_run = time.monotonic()

        symbols = self._symbols
        live = self.is_live(state, self._mode)
        if not symbols:
            log.warning("no tradable instruments configured - sleeping")
            return False

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

        # Equity snapshots: every 5 minutes while the market is live, so the
        # ranking curve has resolution without bloating the table.
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

        fills = (matched or {}).get("filled") if isinstance(matched, dict) else None
        log.info(
            "cycle %d | %s%s | %d quotes | %d new bars | %s | %.2fs",
            self.cycle,
            state,
            "" if live else f" (idle, mode={self._mode})",
            pushed,
            new_bars,
            f"{fills} fill(s)" if fills else "no fills",
            time.monotonic() - started,
        )
        return live

    def run(self) -> None:
        log.info("Xavage worker starting - %s", self.cfg.supabase_url)
        log.info(
            "cadence: %ss live / %ss idle | history refresh every %ss",
            self.cfg.poll_interval, self.cfg.idle_interval, self.cfg.history_interval,
        )

        while _running:
            started = time.monotonic()
            live = False
            try:
                live = self.tick()
            except KeyboardInterrupt:
                break
            except Exception as exc:  # noqa: BLE001 - the loop must survive anything
                log.exception("cycle failed: %s", exc)

            interval = self.cfg.poll_interval if live else self.cfg.idle_interval
            deadline = started + interval
            while _running and time.monotonic() < deadline:
                time.sleep(min(0.5, deadline - time.monotonic()))

        self.db.close()
        log.info("worker stopped after %d cycles", self.cycle)


def main() -> int:
    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    cfg = Config.load()
    log.info("exchange clock: %s (%s)", now_ny().strftime("%Y-%m-%d %H:%M:%S"), session_state())

    worker = Worker(cfg)
    # `--once` runs a single cycle and exits, which is what the installer uses
    # to prove the config and the network path before enabling the service.
    if "--once" in sys.argv:
        worker.tick()
        worker.db.close()
        return 0

    worker.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
