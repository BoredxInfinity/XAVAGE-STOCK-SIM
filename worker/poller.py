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
from logbook import (  # noqa: E402
    SupabaseLogHandler, add_file_handler, mem_snapshot, rss_mb, stage,
)
from feed import fetch_bars_bulk, fetch_daily_closes, fetch_intraday, fetch_profile  # noqa: E402
from market import just_closed, mode_for, now_ny, session_anchor, session_state  # noqa: E402

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

# A rolling 48h of history on disk, independent of journald -- the OCI image
# ships journald volatile, so a reboot otherwise takes the evidence with it.
_LOG_FILE = add_file_handler()

# ...and the subset worth showing an organiser in Admin -> Control room.
_shipper = SupabaseLogHandler()
logging.getLogger().addHandler(_shipper)

log = logging.getLogger("xavage.worker")

_running = True


def _trim_heap() -> None:
    """Ask glibc to return free heap to the OS. No-op where unavailable."""
    try:
        import ctypes
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except Exception:  # noqa: BLE001 - macOS, musl, or missing symbol
        pass

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
        _shipper.attach(self.db)
        self.last_prune = 0.0
        self.last_state = session_state()
        self.last_snapshot = 0.0
        self.last_profile_run = 0.0
        self.last_closes_run = 0.0
        # Which session the cached previous closes were measured against.
        self.closes_anchor = None
        self.last_history_run = 0.0
        # Per-interval timers: 5m and 1d age at different rates.
        self.history_run: dict[str, float] = {}
        self.last_settings_run = 0.0
        self._symbols: list[str] = []
        # The cadences in force, seconds. Seeded from the environment and
        # overridden by the control room; see refresh_settings().
        self.intervals = {
            "live": cfg.live_interval,
            "regular": cfg.regular_interval,
            "idle": cfg.idle_interval,
            "history": cfg.history_interval,
        }
        # An organiser's forced mode, or None while following the exchange.
        self._override: str | None = None
        # The mode the previous cycle ran in, so a change is noticed exactly
        # once: the transition into idle closes the book, and any transition is
        # logged. None until the first cycle, which announces what it started in
        # rather than inventing a switch that never happened.
        self.last_mode: str | None = None
        # Newest bar already written per (symbol, interval), so each cycle
        # sends the handful that are new instead of the whole series.
        self.marks: dict[tuple[str, str], object] = {}
        # Last values broadcast per symbol, so a tick only carries what moved.
        self.last_sent: dict[str, tuple] = {}
        self.sent_last_cycle = 0
        # Official previous closes, refreshed from daily bars a few times a day
        self.prev_closes: dict[str, float] = {}
        # Intervals whose deep history has been seeded once, so later refreshes
        # can ask for a short window instead of the full range.
        self.history_seeded: set[str] = set()
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

        # The exchange clock decides the session; the only thing the app can
        # say is whether an organiser is forcing a mode for a rehearsal. Read
        # it every settings refresh so flipping the switch in the control room
        # takes effect within the TTL rather than on the next deploy.
        try:
            settings, _ = self.db.select(
                "game_settings",
                {"select": "worker_mode_override,worker_live_interval,"
                           "worker_regular_interval,worker_idle_interval,"
                           "worker_history_interval",
                 "id": "eq.true", "limit": 1},
                label="game_settings",
            )
            row = settings[0] if settings else {}
            self._override = row.get("worker_mode_override") or None
            self.apply_cadence(row)
        except PostgrestError as exc:
            log.warning("could not read worker settings, keeping the ones in force: %s", exc)

    def apply_cadence(self, row: dict) -> None:
        """Take the cadences from the control room, and say so when they move.

        A null column means the organiser has not expressed an opinion, so the
        value the worker was started with stands. That way an untouched
        deployment behaves exactly as its environment says, and the app only
        ever overrides deliberately.
        """
        wanted = {
            "live": row.get("worker_live_interval") or self.cfg.live_interval,
            "regular": row.get("worker_regular_interval") or self.cfg.regular_interval,
            "idle": row.get("worker_idle_interval") or self.cfg.idle_interval,
            "history": row.get("worker_history_interval") or self.cfg.history_interval,
        }
        changed = {k: (self.intervals[k], v) for k, v in wanted.items() if self.intervals[k] != v}
        if not changed:
            return

        self.intervals = wanted
        # The line an organiser is looking for after pressing save: not that
        # the value was stored -- the app already told them that -- but that
        # the worker has read it and is running to it.
        log.info(
            "cadence now %s (was %s) - in force from this cycle",
            ", ".join(f"{k} {new}s" for k, (_, new) in sorted(changed.items())),
            ", ".join(f"{k} {old}s" for k, (old, _) in sorted(changed.items())),
            extra={"event": "cadence", "cycle": self.cycle, "ship": True,
                   "rss_mb": rss_mb(),
                   "detail": {**{f"{k}_interval": v for k, v in wanted.items()},
                              "changed": {k: {"from": o, "to": n}
                                          for k, (o, n) in sorted(changed.items())}}},
        )
        _shipper.flush()

    def note_mode(self, previous: str | None, mode: str, state: str) -> None:
        """Say so, once, when the gear changes.

        Every cycle line already carries the mode, but that is hundreds of
        lines a day and the one worth finding is the one where it changed.
        "When did the feed stop fetching?" should be answerable by reading a
        single line in Admin -> Stock worker, not by scrolling until the shape
        of the messages changes.

        Shipped to the table deliberately: a routine INFO line stays on the box,
        and this is the opposite of routine even though it is expected.
        """
        cadence = self.intervals[mode]

        if state == "regular" and self._override is not None:
            why = "regular session, override ignored while the market is open"
        elif self._override is not None:
            why = f"forced to {self._override} by an organiser"
        else:
            why = f"{state} session"

        doing = {
            "live": "full pipeline",
            "regular": "slow poll",
            "idle": "no feed requests",
        }[mode]

        if previous is None:
            message = f"worker starting in {mode} mode - {why}, {doing}, every {cadence}s"
        else:
            message = f"mode {previous} -> {mode} - {why}, {doing}, every {cadence}s"

        log.info(
            message,
            extra={"event": "mode", "cycle": self.cycle, "ship": True,
                   "rss_mb": rss_mb(),
                   "detail": {"from": previous, "to": mode, "session": state,
                              "override": self._override, "interval_s": cadence}},
        )
        # Straight out, rather than waiting for the batch: on the way into idle
        # the next flush is a minute away, and this is the line someone is
        # looking for when they wonder whether the feed died or stood down.
        _shipper.flush()

    def stamp_closed(self) -> None:
        """Mark the quotes closed on the way into idle.

        Nothing else will: the worker is about to stop fetching, and the last
        write of the day stamped whatever session it was in -- 'post', usually.
        Without this the chip would read "After hours" in amber all weekend,
        and the engine, which reads the same column, would keep the book open.
        One PATCH, no feed request.
        """
        try:
            self.db.update(
                "quotes", {"market_state": "closed"},
                {"market_state": "neq.closed"}, label="stamp_closed",
            )
        except PostgrestError as exc:
            log.warning("could not stamp quotes closed: %s", exc)

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
        self.sent_last_cycle = self.broadcast_quotes(quotes)

        written, failed = self.write_bars(bars)
        if not failed:
            self.marks.update(marks)
        return len(quotes), written

    def broadcast_quotes(self, quotes: list[dict]) -> int:
        """Push the moved symbols to subscribed clients in ONE message.

        The database write above is still the source of truth; this is only
        delivery. So a dropped tick costs nothing -- the next cycle carries
        the current price, and clients reconcile against `quotes` anyway.
        """
        if not self.cfg.broadcast_quotes:
            return 0

        moved = []
        for q in quotes:
            # quote_time changes every cycle whether or not anything happened,
            # so compare the values a client would actually render.
            fingerprint = (q["price"], q["day_high"], q["day_low"],
                           q["volume"], q["market_state"])
            if self.last_sent.get(q["symbol"]) != fingerprint:
                moved.append(q)
                self.last_sent[q["symbol"]] = fingerprint

        if not moved:
            return 0

        try:
            self.db.broadcast(self.cfg.broadcast_topic, "tick", {"quotes": moved})
        except PostgrestError as exc:
            # Never let delivery failure affect the cycle. Clients still have
            # their reconcile poll, and the row is already committed.
            log.warning("price broadcast failed (%d symbol(s)): %s", len(moved), exc,
                        extra={"event": "broadcast", "cycle": self.cycle})
            for q in moved:                      # resend next cycle
                self.last_sent.pop(q["symbol"], None)
            return 0
        return len(moved)

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
        started = time.monotonic()
        # A cold start writes ~160k rows over several minutes. The cycle line
        # is only printed at the end, so without this the worker looks hung at
        # exactly the moment someone is most likely to kill it.
        chatty = total > 20

        if chatty:
            log.info("writing %d bars in %d chunks - this is the slow part",
                     len(bars), total,
                     extra={"event": "backfill", "cycle": self.cycle,
                            "detail": {"rows": len(bars), "chunks": total}, "ship": True})

        for n, i in enumerate(range(0, len(bars), chunk), start=1):
            # A backfill is minutes long, so honour a shutdown request here
            # rather than making systemd wait it out. The marks are held back
            # on an incomplete write, so the next start resumes cleanly.
            if not _running:
                log.info("shutdown requested - stopping backfill at chunk %d/%d", n, total,
                         extra={"event": "backfill", "cycle": self.cycle, "ship": True})
                failed += 1          # keeps the high-water marks from advancing
                break
            batch = bars[i : i + chunk]
            try:
                self.db.upsert("price_bars", batch, "symbol,interval,ts",
                               label=f"price_bars chunk {n}/{total}")
                written += len(batch)
            except PostgrestError as exc:
                # Never abandon the remaining chunks over one bad request.
                log.warning("price_bars chunk %d/%d dropped: %s", n, total, exc,
                            extra={"event": "backfill", "cycle": self.cycle})
                failed += 1

            if chatty and n % 20 == 0:
                done = time.monotonic() - started
                rate = written / done if done else 0
                log.info("  ...%d/%d chunks, %d rows, %.0f rows/s, ~%.0fs left",
                         n, total, written, rate,
                         (len(bars) - written) / rate if rate else 0)

        if chatty:
            log.info("backfill wrote %d rows in %.0fs (%d chunk(s) lost)",
                     written, time.monotonic() - started, failed,
                     extra={"event": "backfill", "cycle": self.cycle,
                            "duration_ms": int((time.monotonic() - started) * 1000),
                            "detail": {"rows": written, "failed_chunks": failed},
                            "ship": True})
        return written, failed

    def run_matching(self) -> dict | None:
        try:
            return self.db.rpc("match_orders")
        except PostgrestError as exc:
            log.error("match_orders failed: %s", exc)
            return None

    def due_history(self) -> list[tuple[str, str]]:
        """Which chart series need pulling, and over what window.

        The two series age at completely different rates, so giving them one
        shared 30-minute timer made the 5D chart up to half an hour stale to
        keep the 1M chart cheap. They are now independent:

          5m bars close every five minutes  -> refresh every two
          1d bars only move within today    -> refresh every ten

        And once a series is seeded the deep history is already stored, so
        only the tail can hold anything new. Asking for a short window keeps
        both the download and the transient memory small, which is what makes
        the faster cadence affordable on a 945 MB box.
        """
        now = time.monotonic()
        due: list[tuple[str, str]] = []
        for interval, every, seed_period, tail_period in (
            ("5m", self.intervals["history"], "5d", "1d"),
            ("1d", self.cfg.daily_interval, "1mo", "5d"),
        ):
            if now - self.history_run.get(interval, 0.0) < every:
                continue
            seeded = interval in self.history_seeded
            due.append((tail_period if seeded else seed_period, interval))
        return due

    def refresh_history(self, symbols: list[str]) -> int:
        """
        The longer chart ranges (5D and 1Y). Bulk-downloaded per interval
        rather than per symbol, and high-water marked like the 1m series, so
        after the first pass this writes the few bars that actually appeared
        instead of rewriting ~60k rows every half hour.

        The 1m series is NOT refreshed here; it rides the quote download.
        """
        written = 0
        for period, interval in self.due_history():
            bars, marks = fetch_bars_bulk(
                symbols, period, interval, self.cfg.batch_size,
                self.marks, self.cfg.download_threads,
            )
            rows, failed = self.write_bars(bars)
            written += rows
            if not failed:
                self.marks.update(marks)
                self.history_seeded.add(interval)
                self.history_run[interval] = time.monotonic()
            if not _running:
                break

        # glibc holds freed heap rather than handing it back, and these frames
        # are the largest transient allocation the worker makes. Without this
        # the resident set only ever ratchets upward.
        _trim_heap()
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

    # ------------------------------------------------------------------ check
    def check(self) -> int:
        """Fast pre-flight: config, database, and the price feed. No writes."""
        ok = True
        mem = mem_snapshot()
        log.info("python %s | RAM %sMB (%sMB free), swap %sMB",
                 sys.version.split()[0], mem.get("MemTotal", "?"),
                 mem.get("MemAvailable", "?"), mem.get("SwapTotal", "?"))

        try:
            with stage("check_database") as d:
                self.refresh_settings()
                d["symbols"] = len(self._symbols)
                d["session"] = session_state()
                d["mode"] = mode_for(session_state(), self._override)
                d["override"] = self._override
            log.info("  database OK - %d tradable symbol(s), %s session -> %s mode%s",
                     len(self._symbols), session_state(),
                     mode_for(session_state(), self._override),
                     "" if self._override is None else f" (forced {self._override})")
        except Exception as exc:  # noqa: BLE001
            log.error("  database FAILED: %s", exc)
            return 1

        try:
            sample = self._symbols[:3] or ["AAPL"]
            with stage("check_feed") as d:
                quotes, _, _ = fetch_intraday(sample, 3, {}, {}, 5, 2)
                d["priced"] = len(quotes)
            if quotes:
                log.info("  price feed OK - %s",
                         ", ".join(f"{q['symbol']} {q['price']}" for q in quotes))
            else:
                log.error("  price feed returned nothing for %s", sample)
                ok = False
        except Exception as exc:  # noqa: BLE001
            log.error("  price feed FAILED: %s", exc)
            ok = False

        log.info("pre-flight %s", "PASSED" if ok else "FAILED")
        _shipper.flush()
        self.db.close()
        return 0 if ok else 1

    # ------------------------------------------------------------------- loop
    def tick(self) -> str:
        """One full cycle. Returns the mode it ran in: idle, regular or live."""
        started = time.monotonic()
        self.cycle += 1
        state = session_state()

        if time.monotonic() - self.last_settings_run > SETTINGS_TTL or not self._symbols:
            self.refresh_settings()
            self.last_settings_run = time.monotonic()

        symbols = self._symbols
        mode = mode_for(state, self._override)
        live = mode == "live"

        previous, self.last_mode = self.last_mode, mode
        if mode != previous:
            self.note_mode(previous, mode, state)

        # Idle: the exchange is shut, every price is the one it closed at, and
        # asking Yahoo for it again 700 times an hour buys nothing. Do the
        # settlement that is still owed, say we are alive so the control room
        # does not read this as a dead feed, and stop there.
        if mode == "idle":
            if previous != "idle":
                self.stamp_closed()
            self.daily_jobs(state)
            self.last_state = state
            self.heartbeat("worker-idle")
            log.info(
                "cycle %d | %s | idle%s - no feed requests",
                self.cycle, state, "" if self._override is None else " (forced)",
                extra={"event": "cycle", "cycle": self.cycle, "ship": True,
                       "duration_ms": int((time.monotonic() - started) * 1000),
                       "rss_mb": rss_mb(),
                       "detail": {"session": state, "mode": mode,
                                  "override": self._override, "live": False}},
            )
            _shipper.flush()
            return mode

        if not symbols:
            log.warning("no tradable instruments configured - sleeping")
            return "idle"

        # Refresh official closes on startup, when the session rolls over, and
        # every 6 hours otherwise. The rollover is the one that matters: a
        # six-hour timer can leave the previous close pointing at the session
        # before last for most of a morning, and every day-change figure in the
        # competition is measured against it.
        anchor = session_anchor()
        if (not self.prev_closes
                or anchor != self.closes_anchor
                or time.monotonic() - self.last_closes_run > 21_600):
            with stage("prev_closes", self.cycle, ship=True) as d:
                self.refresh_prev_closes(symbols)
                d["cached"] = len(self.prev_closes)
                d["anchor"] = str(anchor)
            self.last_closes_run = time.monotonic()
            self.closes_anchor = anchor

        with stage("market_data", self.cycle, symbols=len(symbols)) as d:
            pushed, new_bars = self.push_market_data(symbols)
            d["quotes"], d["bars"] = pushed, new_bars
            d["broadcast"] = self.sent_last_cycle
        self.heartbeat()

        matched = self.run_matching() if pushed else None
        self.daily_jobs(state)
        self.last_state = state

        # Equity snapshots: every 5 minutes while the market is live, so the
        # ranking curve has resolution without bloating the table.
        if time.monotonic() - self.last_snapshot > 300:
            with stage("snapshot", self.cycle):
                self.snapshot()
            self.last_snapshot = time.monotonic()

        # Long chart ranges only; the 1m series rides the quote download.
        # The 30-minute history refresh is the worker's largest transient
        # allocation, so it is always shipped with its duration and memory --
        # this is the stage to look at first when the box gets into trouble.
        due = self.due_history()
        if due:
            with stage("history", self.cycle, ship=True) as d:
                d["series"] = [f"{p}/{i}" for p, i in due]
                d["rows"] = self.refresh_history(symbols)

        if time.monotonic() - self.last_profile_run > 600:
            with stage("profiles", self.cycle) as d:
                d["enriched"] = self.enrich_profiles()
            self.last_profile_run = time.monotonic()

        # Retention, hourly, and failure is not fatal in either case. Bars are
        # pruned here rather than on a cron for the same reason the logs are:
        # the tables must not be able to grow without bound if the Vercel cron
        # is ever removed. price_bars is the one that actually matters -- it
        # grows ~40 MB per trading day and is most of the database.
        if time.monotonic() - self.last_prune > 3_600:
            self.last_prune = time.monotonic()
            try:
                removed = self.db.rpc("prune_worker_logs", {"p_hours": 48})
                if removed:
                    log.info("pruned %s expired log row(s)", removed,
                             extra={"event": "logprune", "detail": {"removed": removed}})
            except PostgrestError as exc:
                log.warning("prune_worker_logs failed: %s", exc)

            try:
                removed = self.db.rpc("prune_price_bars", {})
                if removed:
                    log.info("pruned %s expired price bar(s)", removed,
                             extra={"event": "barprune", "detail": {"removed": removed}})
            except PostgrestError as exc:
                log.warning("prune_price_bars failed: %s", exc)

        fills = (matched or {}).get("filled") if isinstance(matched, dict) else None
        elapsed = time.monotonic() - started
        mem = mem_snapshot()
        rss = rss_mb()

        log.info(
            "cycle %d | %s%s | %d quotes | %d new bars | %s | %.2fs | rss %sMB, avail %sMB",
            self.cycle,
            state,
            "" if live else f" ({mode})",
            pushed,
            new_bars,
            f"{fills} fill(s)" if fills else "no fills",
            elapsed,
            rss if rss is not None else "?",
            mem.get("MemAvailable", "?"),
            extra={
                "event": "cycle", "cycle": self.cycle,
                "duration_ms": int(elapsed * 1000), "rss_mb": rss, "ship": True,
                "detail": {
                    "session": state, "mode": mode, "override": self._override, "live": live,
                    "quotes": pushed, "bars": new_bars, "fills": fills or 0,
                    "mem_available_mb": mem.get("MemAvailable"),
                    "swap_free_mb": mem.get("SwapFree"),
                },
            },
        )
        # One flush per cycle: the table stays current without a request per line.
        _shipper.flush()
        return mode

    def run(self) -> None:
        mem = mem_snapshot()
        log.info(
            "worker starting | %d symbols max | cadence %ss live / %ss regular / %ss idle | "
            "history every %ss | RAM %sMB (%sMB free), swap %sMB | logfile %s",
            self.cfg.max_symbols, self.intervals["live"], self.intervals["regular"],
            self.intervals["idle"],
            self.intervals["history"], mem.get("MemTotal", "?"),
            mem.get("MemAvailable", "?"), mem.get("SwapTotal", "?"), _LOG_FILE or "none",
            extra={"event": "startup", "ship": True, "rss_mb": rss_mb(), "detail": {
                **{f"{k}_interval": v for k, v in self.intervals.items()},
                "batch_size": self.cfg.batch_size,
                "download_threads": self.cfg.download_threads,
                "mem_total_mb": mem.get("MemTotal"),
                "mem_available_mb": mem.get("MemAvailable"),
                "swap_total_mb": mem.get("SwapTotal"),
                "log_file": _LOG_FILE,
            }},
        )
        # A box this small is the usual cause of trouble, so say so up front
        # rather than leaving it to be inferred from a later crash.
        if mem.get("MemTotal") and mem["MemTotal"] < 900:
            log.warning(
                "only %dMB of RAM visible - check for a kdump crashkernel "
                "reservation (`cat /sys/kernel/kexec_crash_size`)", mem["MemTotal"],
                extra={"event": "startup", "detail": mem},
            )

        while _running:
            started = time.monotonic()
            # A cycle that blew up says nothing about the session, so fall back
            # to the pre/post cadence: fast enough to recover promptly, slow
            # enough not to hammer a feed that is already failing.
            mode = "regular"
            try:
                mode = self.tick()
            except KeyboardInterrupt:
                break
            except Exception as exc:  # noqa: BLE001 - the loop must survive anything
                log.exception("cycle failed: %s", exc)

            # Read per iteration: the control room can move these mid-event.
            interval = self.intervals[mode]
            deadline = started + interval
            while _running and time.monotonic() < deadline:
                time.sleep(min(0.5, deadline - time.monotonic()))

        log.info("worker stopping after %d cycle(s)", self.cycle,
                 extra={"event": "shutdown", "cycle": self.cycle, "ship": True,
                        "rss_mb": rss_mb()})
        _shipper.flush()          # get the last lines out before the socket goes
        self.db.close()


def main() -> int:
    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    cfg = Config.load()
    log.info("exchange clock: %s (%s)", now_ny().strftime("%Y-%m-%d %H:%M:%S"), session_state())

    worker = Worker(cfg)
    # `--check` proves the interpreter, dependency tree, credentials and egress
    # path in about ten seconds. This is what the installer runs: `--once` does
    # a FULL cycle, and on a cold start that means the ~160k-row backfill, so
    # using it as a smoke test blocked setup for ten silent minutes before the
    # service was even installed.
    if "--check" in sys.argv:
        return worker.check()

    # `--once` runs a single complete cycle and exits. Useful for testing a
    # change by hand; not for proving an install.
    if "--once" in sys.argv:
        worker.tick()
        worker.db.close()
        return 0

    worker.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
