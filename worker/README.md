# Xavage price worker

Primary market-data feed. Pulls live prices from **yfinance**, writes them to
Supabase, and runs the matching engine on every tick so resting limit, stop and
trailing orders fill against real prices.

## Run it locally

```bash
cd worker
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env      # fill in SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
python poller.py
```

You should see a line per cycle:

```
14:31:02  INFO    xavage.worker  cycle 12 | regular | 101 quotes | 2 fill(s) | 1.84s
```

## Run it on a host

Any container platform works — Railway, Fly.io, Render, a small VPS:

```bash
docker build -t xavage-worker .
docker run -e SUPABASE_URL=... -e SUPABASE_SERVICE_ROLE_KEY=... xavage-worker
```

Set it as a **worker/background service**, not a web service — it doesn't listen
on a port.

## Cadence

| Setting                  | Default | Notes                                        |
| ------------------------ | ------- | -------------------------------------------- |
| `POLL_INTERVAL_SECONDS`  | `5`     | While the regular session is open            |
| `IDLE_INTERVAL_SECONDS`  | `120`   | Outside the session — nothing is moving      |
| `BAR_INTERVAL_SECONDS`   | `300`   | Chart-history backfill, off the hot path     |
| `MAX_SYMBOLS`            | `400`   | Ceiling on the polled universe               |

## Safety

- **Idempotent with the Vercel cron.** `match_orders()` takes a transaction-level
  advisory lock, so if the cron and the worker tick simultaneously, the second
  caller returns immediately instead of double-filling.
- **Never crashes the loop.** Every stage catches its own exceptions; a bad
  symbol or a Yahoo hiccup costs one cycle, not the competition.
- **Uses the service-role key**, so it bypasses RLS. Keep the key off any client
  and out of version control.

## If the worker dies mid-competition

The Vercel cron at `/api/cron/tick` keeps refreshing prices and matching orders
once a minute. The game degrades to one-minute prices rather than a frozen
market. Restart the worker and it resumes on its next cycle.
