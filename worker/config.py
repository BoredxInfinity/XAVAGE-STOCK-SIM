"""Worker configuration, loaded from the environment and ./.env"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

ENV_FILE = Path(__file__).with_name(".env")


def load_env(path: Path = ENV_FILE) -> None:
    """Populate os.environ from a .env file.

    python-dotenv for `KEY=value` was a dependency we were paying for in every
    install; the handful of rules that actually matter are below. Real
    environment variables always win, so a systemd `Environment=` or an inline
    override still beats the file.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return

    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key.startswith("export "):
            key = key[7:].strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key and key not in os.environ:
            os.environ[key] = value


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class Config:
    supabase_url: str
    service_role_key: str
    poll_interval: int
    idle_interval: int
    history_interval: int
    batch_size: int
    max_symbols: int
    bars_per_symbol: int
    download_threads: int

    @classmethod
    def load(cls) -> "Config":
        load_env()
        url = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()

        if not url or not key:
            raise SystemExit(
                "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.\n"
                "Copy worker/.env.example to worker/.env and fill them in."
            )

        # Pasting a multi-line block into a single field is an easy mistake and
        # the resulting failure is deeply unobvious: the key goes out as an HTTP
        # header, so you get "Illegal header value" on every request instead of
        # anything resembling "your config is wrong". Catch it here, at startup.
        for name, value in (("SUPABASE_URL", url), ("SUPABASE_SERVICE_ROLE_KEY", key)):
            if any(c in value for c in "\n\r\t") or " " in value:
                first = value.splitlines()[0] if value.splitlines() else ""
                raise SystemExit(
                    f"{name} contains whitespace or a line break, so it cannot be sent "
                    f"as an HTTP header.\n"
                    f"It looks like more than one variable was pasted into this field.\n"
                    f"  starts with: {first[:40]}...\n"
                    f"  length: {len(value)} characters\n"
                    f"Set {name} to a single value on one line, with each other "
                    f"variable in its own field."
                )

        if not url.startswith("https://") and not url.startswith("http://"):
            raise SystemExit(f"SUPABASE_URL must start with https:// (got: {url[:40]})")

        # A Supabase service-role key is a JWT: three dot-separated segments.
        if key.count(".") != 2:
            raise SystemExit(
                "SUPABASE_SERVICE_ROLE_KEY does not look like a JWT (expected three "
                f"dot-separated parts, found {key.count('.') + 1}).\n"
                "Copy the service_role key from Supabase -> Project Settings -> API."
            )

        return cls(
            supabase_url=url,
            service_role_key=key,
            poll_interval=_int("POLL_INTERVAL_SECONDS", 5),
            idle_interval=_int("IDLE_INTERVAL_SECONDS", 120),
            history_interval=_int("HISTORY_INTERVAL_SECONDS", 1800),
            batch_size=_int("BATCH_SIZE", 60),
            max_symbols=_int("MAX_SYMBOLS", 400),
            bars_per_symbol=_int("BARS_PER_SYMBOL", 500),
            # yfinance issues one request per symbol, so a cycle is bound by
            # concurrency rather than CPU. Measured on a 105-symbol universe:
            # 4 threads 4.2s, 8 threads 3.7s, 24 threads 3.5s -- past 8 the
            # gain is noise and the extra in-flight responses just cost RAM.
            download_threads=_int("DOWNLOAD_THREADS", 8),
        )
