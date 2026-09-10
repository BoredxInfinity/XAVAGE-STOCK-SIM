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

## Deploy to Railway

The worker is required infrastructure on a Vercel Hobby plan, because the cron
fallback is capped at once per day. It needs a host that stays up.

1. **[railway.app](https://railway.app)** → **New Project** → **Deploy from GitHub repo**
   → pick `XAVAGE-STOCK-SIM`. Authorise Railway for the repo if prompted (it's private).

2. Open the service → **Settings** → **Source** → set **Root Directory** to:

   ```
   worker
   ```

   This is the important step. Without it Railway builds the Next.js app at the
   repo root instead of the worker. Once set, it auto-detects `worker/Dockerfile`.

3. **Variables** tab → add:

   | Name | Value |
   | --- | --- |
   | `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
   | `SUPABASE_SERVICE_ROLE_KEY` | the service_role key |
   | `MAX_SYMBOLS` | `400` |

   The cadence variables are optional — the defaults (5s live / 120s idle /
   30min history) are what you want.

4. **Do not add a public domain.** This is a background worker; it listens on no
   port. Railway may note that nothing is listening — that is expected and fine.
   Ignore any "no open ports detected" hint; don't add a healthcheck.

5. **Deploy**, then watch the **Logs** tab. A healthy start looks like:

   ```
   cadence: 5s live / 120s idle | history refresh every 1800s
   cached 101 previous close(s)
   cycle 1 | pre (idle, mode=regular) | 101 quotes | 48017 new bars | no fills | 152.68s
   cycle 2 | regular | 101 quotes | 113 new bars | 2 fill(s) | 8.66s
   ```

   The first cycle is slow (a couple of minutes) because it backfills all chart
   history. Steady state is a few seconds.

6. Confirm from the app: **Admin → Overview** should show **"Price feed healthy"**
   with a recent tick.

### Things to check

- `101 quotes` should match your tradable instrument count. A `MAX_SYMBOLS`
  warning in the logs means symbols are being silently skipped — they'd have no
  price and orders on them would be refused.
- Occasional `Failed to get ticker 'XYZ' ... Connection timed out` lines are
  normal. yfinance logs them; the worker carries on and the symbol is picked up
  next cycle.
- Railway restarts the container on exit. The worker catches its own exceptions
  per stage, so a crash loop means something environmental — check the variables
  first.

### Other hosts

Any container platform works — Fly.io, Render, a small VPS:

```bash
docker build -t xavage-worker worker/
docker run -e SUPABASE_URL=... -e SUPABASE_SERVICE_ROLE_KEY=... xavage-worker
```

Always run it as a **background/worker** service, never a web service.

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
