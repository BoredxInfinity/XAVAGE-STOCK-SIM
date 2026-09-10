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

        return cls(
            supabase_url=url,
            service_role_key=key,
            poll_interval=_int("POLL_INTERVAL_SECONDS", 5),
            idle_interval=_int("IDLE_INTERVAL_SECONDS", 120),
            history_interval=_int("HISTORY_INTERVAL_SECONDS", 1800),
            batch_size=_int("BATCH_SIZE", 60),
            max_symbols=_int("MAX_SYMBOLS", 400),
        )
