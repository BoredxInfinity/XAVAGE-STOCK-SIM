"""Structured, durable logging for the worker.

Three destinations, each for a different reader:

* **stdout/stderr** -> journald, for someone on the box right now.
* **a rotating file**, one per hour with 48 kept, so 48 hours of history
  survives a reboot even if journald is volatile (OCI images ship it that
  way by default, which is why a 50-minute outage left no evidence at all).
* **the `worker_logs` table**, for Admin -> Control room, so an organiser can
  see what the feed is doing without an SSH key.

The table is not a firehose. Everything at WARNING or above ships, plus
anything explicitly marked, plus any stage that ran slowly or allocated
unusually -- which is exactly the set you want when something has gone wrong
and you are reading after the fact.
"""
from __future__ import annotations

import logging
import logging.handlers
import os
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone

log = logging.getLogger("xavage.worker")

# Ship a stage's line even at INFO when it took this long or grew RSS this
# much. Both are deliberately generous: the point is to catch the abnormal,
# not to narrate the routine.
SLOW_MS = 5_000
FAT_MB = 40

_STATUS = "/proc/self/status"


def rss_mb() -> int | None:
    """Resident set size in MB, or None off Linux."""
    try:
        with open(_STATUS) as fh:
            for line in fh:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) // 1024
    except OSError:
        pass
    return None


def mem_snapshot() -> dict:
    """System-wide memory, for the cycle summary. Empty off Linux."""
    try:
        want = {"MemTotal", "MemAvailable", "SwapTotal", "SwapFree"}
        out = {}
        with open("/proc/meminfo") as fh:
            for line in fh:
                key, _, rest = line.partition(":")
                if key in want:
                    out[key] = int(rest.split()[0]) // 1024
        return out
    except OSError:
        return {}


class SupabaseLogHandler(logging.Handler):
    """Batches selected records into `worker_logs`.

    Deliberately defensive. A logging handler that raises, blocks, or logs
    about its own failure through the same logger will take down the process
    it was meant to explain.
    """

    def __init__(self, batch: int = 25, max_buffer: int = 500, flush_every: float = 30.0):
        super().__init__(level=logging.DEBUG)
        self.db = None
        self.batch = batch
        self.max_buffer = max_buffer
        self.flush_every = flush_every
        self._rows: list[dict] = []
        self._lock = threading.Lock()
        self._last_flush = time.monotonic()
        self._dropped = 0
        # (level, event, message) -> (first_seen_monotonic, folded_count)
        self._recent: dict[tuple, tuple[float, int]] = {}

    def attach(self, db) -> None:
        self.db = db

    # ------------------------------------------------------------------
    def _wanted(self, record: logging.LogRecord) -> bool:
        if record.levelno >= logging.WARNING:
            return True
        return bool(getattr(record, "ship", False))

    def emit(self, record: logging.LogRecord) -> None:
        try:
            if not self._wanted(record):
                return
            if self._is_repeat(record):
                return
            row = {
                "ts": datetime.now(timezone.utc).isoformat(),
                "level": record.levelname,
                "event": getattr(record, "event", "log"),
                "message": record.getMessage()[:2000],
                "cycle": getattr(record, "cycle", None),
                "duration_ms": getattr(record, "duration_ms", None),
                "rss_mb": getattr(record, "rss_mb", None) or rss_mb(),
                "detail": getattr(record, "detail", None) or None,
            }
            with self._lock:
                if len(self._rows) >= self.max_buffer:
                    # Supabase is unreachable and the buffer is full. Losing
                    # the oldest lines beats growing without bound on a box
                    # with 500 MB of RAM.
                    self._rows.pop(0)
                    self._dropped += 1
                self._rows.append(row)
                due = (len(self._rows) >= self.batch
                       or time.monotonic() - self._last_flush > self.flush_every)
            if due:
                self.flush()
        except Exception:  # noqa: BLE001 - logging must never raise
            pass

    # Identical lines inside this window are shipped once.
    #
    # During a Yahoo outage feed.py logs one WARNING per batch per cycle: at
    # 150 symbols over batches of 60 that is 3 lines every 5s, ~2,000 an hour,
    # on top of db.py's retry warnings -- against a 500 MB free tier where
    # price_bars already claims most of the room. The hundredth copy of
    # "rate limited" tells an organiser nothing the first did not, so keep the
    # first, count the rest, and say how many were folded in.
    _REPEAT_WINDOW_SEC = 60.0

    def _is_repeat(self, record) -> bool:
        key = (record.levelname, getattr(record, "event", "log"), record.getMessage()[:200])
        now = time.monotonic()
        with self._lock:
            last, count = self._recent.get(key, (0.0, 0))
            if now - last < self._REPEAT_WINDOW_SEC:
                self._recent[key] = (last, count + 1)
                return True
            # First of a new window. If the previous window folded anything up,
            # note it on this line so the count is not silently lost.
            if count:
                record.msg = f"{record.getMessage()} [+{count} identical in the last "\
                             f"{int(self._REPEAT_WINDOW_SEC)}s]"
                record.args = ()
            self._recent[key] = (now, 0)

            # Bounded: distinct messages are few, but a message carrying a
            # symbol name would otherwise grow this per symbol.
            if len(self._recent) > 200:
                cutoff = now - self._REPEAT_WINDOW_SEC * 2
                for k, (t, _) in list(self._recent.items()):
                    if t < cutoff:
                        del self._recent[k]
        return False

    def flush(self) -> None:
        if self.db is None:
            return
        with self._lock:
            if not self._rows:
                return
            rows, self._rows = self._rows, []
            dropped, self._dropped = self._dropped, 0
            self._last_flush = time.monotonic()

        if dropped:
            rows.append({
                "ts": datetime.now(timezone.utc).isoformat(),
                "level": "WARNING", "event": "logship",
                "message": f"log buffer overflowed, {dropped} line(s) discarded",
                "rss_mb": rss_mb(),
            })
        try:
            self.db.insert("worker_logs", rows, label="worker_logs")
        except Exception:  # noqa: BLE001
            # Never re-log through this handler, and never raise into the
            # caller's stack. The line is lost; the worker carries on.
            pass


# ----------------------------------------------------------------- staging
@contextmanager
def stage(name: str, cycle: int | None = None, ship: bool = False, **detail):
    """Time a stage, and log it with duration, memory and whatever it reports.

    Yields a dict the body fills in -- row counts, symbol counts, whatever is
    worth knowing later. A stage that raises logs at ERROR with the elapsed
    time before re-raising, so a failure is never silent about how far it got.
    """
    started = time.monotonic()
    rss_before = rss_mb()
    payload: dict = dict(detail)
    try:
        yield payload
    except Exception as exc:
        ms = int((time.monotonic() - started) * 1000)
        log.error(
            "%s failed after %s: %s", name, _human(ms), exc,
            extra={"event": name, "cycle": cycle, "duration_ms": ms,
                   "rss_mb": rss_mb(), "detail": payload or None, "ship": True},
        )
        raise
    ms = int((time.monotonic() - started) * 1000)
    rss_after = rss_mb()
    grew = (rss_after - rss_before) if (rss_after is not None and rss_before is not None) else 0

    if grew:
        payload.setdefault("rss_delta_mb", grew)
    # Routine stages stay out of the table; slow or hungry ones go in, which
    # is what you want to find when reading back through an incident.
    notable = ship or ms >= SLOW_MS or grew >= FAT_MB
    log.info(
        "%s %s%s", name, _human(ms),
        f" ({_brief(payload)})" if payload else "",
        extra={"event": name, "cycle": cycle, "duration_ms": ms,
               "rss_mb": rss_after, "detail": payload or None, "ship": notable},
    )


def _human(ms: int) -> str:
    if ms < 1000:
        return f"{ms}ms"
    if ms < 60_000:
        return f"{ms / 1000:.1f}s"
    return f"{ms // 60000}m{(ms % 60000) // 1000:02d}s"


def _brief(d: dict) -> str:
    return ", ".join(f"{k}={v}" for k, v in d.items() if v is not None)


# ------------------------------------------------------------------- setup
def add_file_handler(path: str | None = None, hours: int = 48) -> str | None:
    """One file per hour, `hours` kept -- a rolling 48h window on disk.

    Independent of journald on purpose. The OCI Oracle Linux image ships
    journald with volatile storage, so a reboot takes the evidence with it.
    """
    path = path or os.environ.get(
        "XAVAGE_LOG_FILE", os.path.join(os.path.expanduser("~"), "xavage-worker.log"))
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        handler = logging.handlers.TimedRotatingFileHandler(
            path, when="H", interval=1, backupCount=hours, utc=True, delay=True)
        handler.setFormatter(logging.Formatter(
            "%(asctime)s %(levelname)-8s %(name)s %(message)s", "%Y-%m-%dT%H:%M:%S"))
        handler.setLevel(logging.INFO)
        logging.getLogger().addHandler(handler)
        return path
    except OSError as exc:
        log.warning("could not open log file %s: %s", path, exc)
        return None
