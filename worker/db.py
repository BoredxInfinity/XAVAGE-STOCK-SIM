"""Minimal PostgREST client built on the standard library.

The supabase-py SDK pulled in ~30 packages (pydantic, httpx, h2, realtime,
storage3, gotrue, protobuf...) to do what this worker actually needs: five
kinds of REST call against PostgREST. On a 1 GB box that tree costs both
install time and resident memory for no benefit, so this replaces it.

Two incidental wins over the SDK:

* **One keep-alive HTTP/1.1 connection.** postgrest-py hardcodes http2=True,
  and some egress paths (Railway's, notably) sit behind a proxy that resets
  every HTTP/2 stream -- which surfaced as RemoteProtocolError on every
  request and needed an ugly client-swap hack to work around. HTTP/1.1 with a
  reused socket sidesteps that entirely and spends no CPU on repeat TLS
  handshakes.
* **`return=minimal` everywhere it is safe.** The SDK asks PostgREST to echo
  back every row it wrote. Backfilling ~48k chart bars therefore downloaded
  ~48k rows we discarded. Now those responses are empty.
"""
from __future__ import annotations

import gzip
import http.client
import json
import logging
import random
import socket
import ssl
import time
from urllib.parse import quote, urlsplit

log = logging.getLogger("xavage.db")

# Failures that are worth retrying: the socket died, the proxy hung up, or the
# far end asked us to back off. Anything else is a bug in our request and
# retrying it just wastes the cycle.
TRANSIENT_EXC = (
    http.client.HTTPException,
    socket.timeout,
    ssl.SSLError,
    ConnectionError,
    OSError,
)
TRANSIENT_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})


class PostgrestError(RuntimeError):
    def __init__(self, status: int, body: str):
        super().__init__(f"HTTP {status}: {body[:400]}")
        self.status = status
        self.body = body


def _qs(params: dict[str, str]) -> str:
    """PostgREST filter syntax survives percent-encoding, but leaving the
    structural characters alone keeps request logs readable."""
    if not params:
        return ""
    safe = ",.*():"
    return "?" + "&".join(f"{k}={quote(str(v), safe=safe)}" for k, v in params.items())


class Postgrest:
    """One connection, reused. Not thread-safe -- the worker is single-threaded."""

    def __init__(self, url: str, key: str, timeout: float = 45.0):
        parts = urlsplit(url)
        self.host = parts.netloc
        self.secure = parts.scheme != "http"
        self.timeout = timeout
        self.base = "/rest/v1"
        self._headers = {
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Accept": "application/json",
            "Accept-Encoding": "gzip",
            "Content-Type": "application/json",
            "User-Agent": "xavage-worker/2",
            "Connection": "keep-alive",
        }
        self._conn: http.client.HTTPConnection | None = None

    # ------------------------------------------------------------- transport
    def _connect(self) -> http.client.HTTPConnection:
        if self._conn is None:
            if self.secure:
                self._conn = http.client.HTTPSConnection(
                    self.host, timeout=self.timeout, context=ssl.create_default_context()
                )
            else:
                self._conn = http.client.HTTPConnection(self.host, timeout=self.timeout)
        return self._conn

    def _drop(self) -> None:
        if self._conn is not None:
            try:
                self._conn.close()
            except Exception:  # noqa: BLE001 - closing a dead socket may itself fail
                pass
            self._conn = None

    def _once(self, method: str, path: str, body: bytes | None, extra: dict | None):
        conn = self._connect()
        headers = dict(self._headers)
        if extra:
            headers.update(extra)
        if body is None:
            headers.pop("Content-Type", None)

        conn.request(method, path, body=body, headers=headers)
        resp = conn.getresponse()
        # The body MUST be drained in full or the socket cannot be reused.
        raw = resp.read()
        if resp.getheader("Content-Encoding") == "gzip" and raw:
            raw = gzip.decompress(raw)

        # The server gets the final say on keep-alive.
        if resp.getheader("Connection", "").lower() == "close" or resp.version == 10:
            self._drop()

        return resp.status, resp.getheader("Content-Range"), raw

    def request(
        self,
        method: str,
        path: str,
        body: bytes | None = None,
        extra: dict | None = None,
        label: str = "request",
        attempts: int = 4,
    ) -> tuple[bytes, str | None]:
        """Returns (body, content_range). Retries transient failures."""
        for attempt in range(1, attempts + 1):
            reason: str
            try:
                status, crange, raw = self._once(method, path, body, extra)
                if status < 300:
                    return raw, crange
                if status not in TRANSIENT_STATUS:
                    self._drop()
                    raise PostgrestError(status, raw.decode("utf-8", "replace"))
                reason = f"HTTP {status}"
            except TRANSIENT_EXC as exc:
                # A server closing an idle keep-alive socket lands here and is
                # entirely routine; reconnecting on the next pass handles it.
                reason = type(exc).__name__
            self._drop()

            if attempt == attempts:
                raise PostgrestError(0, f"{label}: giving up after {attempts} attempts ({reason})")
            delay = 0.4 * (2 ** (attempt - 1)) + random.uniform(0, 0.3)
            log.warning("%s: %s (attempt %d/%d, retrying in %.1fs)",
                        label, reason, attempt, attempts, delay)
            time.sleep(delay)
        raise AssertionError("unreachable")

    def close(self) -> None:
        self._drop()

    # ----------------------------------------------------------------- verbs
    def select(
        self, table: str, params: dict, count: bool = False, label: str | None = None
    ) -> tuple[list[dict], int | None]:
        extra = {"Prefer": "count=exact"} if count else None
        raw, crange = self.request(
            "GET", f"{self.base}/{table}{_qs(params)}", extra=extra, label=label or f"select {table}"
        )
        rows = json.loads(raw) if raw else []
        if isinstance(rows, dict):  # maybe_single-style responses
            rows = [rows]

        total = None
        if crange and "/" in crange:
            tail = crange.rsplit("/", 1)[1]
            if tail.isdigit():
                total = int(tail)
        return rows, total

    def insert(self, table: str, rows: list[dict], label: str | None = None) -> None:
        """Plain append, no conflict handling. For log-style tables."""
        if not rows:
            return
        body = json.dumps(rows, separators=(",", ":")).encode()
        self.request(
            "POST", f"{self.base}/{table}",
            body=body,
            extra={"Prefer": "return=minimal"},
            label=label or f"insert {table}",
            # Log lines are not worth a long retry storm; if the first two
            # attempts fail the batch is dropped and the worker moves on.
            attempts=2,
        )

    def upsert(self, table: str, rows: list[dict], on_conflict: str, label: str | None = None) -> None:
        if not rows:
            return
        body = json.dumps(rows, separators=(",", ":")).encode()
        self.request(
            "POST",
            f"{self.base}/{table}{_qs({'on_conflict': on_conflict})}",
            body=body,
            extra={"Prefer": "resolution=merge-duplicates,return=minimal"},
            label=label or f"upsert {table}",
        )

    def update(self, table: str, patch: dict, params: dict, label: str | None = None) -> None:
        body = json.dumps(patch, separators=(",", ":")).encode()
        self.request(
            "PATCH",
            f"{self.base}/{table}{_qs(params)}",
            body=body,
            extra={"Prefer": "return=minimal"},
            label=label or f"update {table}",
        )

    def broadcast(self, topic: str, event: str, payload: dict, label: str | None = None) -> None:
        """Send one Realtime Broadcast message over the HTTP API.

        Deliberately not the websocket protocol: this worker already holds a
        keep-alive HTTP connection to the same host, so a POST costs nothing
        extra and needs no client library, no persistent socket to babysit and
        no reconnect logic on a box with 945 MB of RAM.
        """
        body = json.dumps(
            {"messages": [{"topic": topic, "event": event, "payload": payload}]},
            separators=(",", ":"),
        ).encode()
        self.request(
            "POST", "/realtime/v1/api/broadcast", body=body,
            label=label or f"broadcast {topic}",
            # Prices are superseded a few seconds later, so a missed tick is
            # not worth a retry storm -- the next cycle carries the truth.
            attempts=2,
        )

    def rpc(self, fn: str, args: dict | None = None, label: str | None = None):
        body = json.dumps(args or {}, separators=(",", ":")).encode()
        raw, _ = self.request("POST", f"{self.base}/rpc/{fn}", body=body, label=label or f"rpc {fn}")
        if not raw:
            return None
        try:
            return json.loads(raw)
        except ValueError:
            return raw.decode("utf-8", "replace")
