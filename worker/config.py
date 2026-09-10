"""Worker configuration, loaded from the environment."""
from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
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

    @classmethod
    def load(cls) -> "Config":
        url = os.getenv("SUPABASE_URL", "").strip()
        key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()

        if not url or not key:
            raise SystemExit(
                "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.\n"
                "Copy worker/.env.example to worker/.env and fill them in."
            )

        # Pasting a multi-line block into a single dashboard field is an easy
        # mistake, and the resulting failure is deeply unobvious: the key goes
        # out as an HTTP header, so you get "Illegal header value" (or, over
        # HTTP/2, an opaque stream reset) on every request instead of anything
        # resembling "your config is wrong". Catch it here, at startup.
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
        )
