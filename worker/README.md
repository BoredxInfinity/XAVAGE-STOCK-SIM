# Xavage price worker

Primary market-data feed. Pulls live prices from **yfinance**, writes them to
Supabase, and runs the matching engine on every tick so resting limit, stop and
trailing orders fill against real prices.

It is built to run on the smallest free box you can get — 1 OCPU, 1 GB RAM —
so it has exactly one third-party dependency and talks to Supabase over the
Python standard library.

```
poller.py    the loop: universe -> prices -> quotes -> match_orders -> snapshots
feed.py      yfinance fetching and parsing
db.py        a small PostgREST client over http.client
config.py    env + .env loading and validation
market.py    US exchange calendar and session state
setup.sh     one-shot installer for Oracle Linux / Ubuntu (systemd, no Docker)
build-bundle.sh  builds deps + interpreter RPMs on your laptop; the box runs no pip or dnf
```

## Run it locally

```bash
cd worker
python3 -m venv .venv && source .venv/bin/activate   # needs Python 3.10+
pip install -r requirements.txt
cp .env.example .env      # fill in SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
python poller.py
```

You should see a line per cycle:

```
14:31:02  INFO    xavage.worker  cycle 12 | regular | 105 quotes | 105 new bars | 2 fill(s) | 4.22s
```

`python poller.py --once` runs a single cycle and exits — the quickest way to
check a config change, a yfinance upgrade, or a new host's egress path.

## Deploy

**[DEPLOY-ORACLE.md](DEPLOY-ORACLE.md)** — Oracle Cloud Always Free, which is
the intended home for this.

On a 1 GB instance, run `build-bundle.sh` on your laptop and upload the ~56 MB
tarball it produces. The server then resolves nothing and downloads nothing:
`setup.sh` installs the bundled interpreter RPMs with `rpm -Uvh`, points
`PYTHONPATH` at the bundled `libs/`, and writes the systemd unit.

This is not a micro-optimisation. Both package managers are too heavy for the
box: `dnf` parses ~131 MB of uncompressed repo metadata before it installs
anything, and `pip` has to resolve and unpack numpy and pandas. Either is
enough to starve an E2.1.Micro until it stops answering and the OCI agent
stops reporting metrics. Anywhere with 2 GB or more, plain `setup.sh` is
fine.

Anywhere else with Python 3.10+ and outbound HTTPS works the same way: install
`requirements.txt`, set the two environment variables, run `poller.py` as a
long-lived background process. It listens on no port and needs no inbound
access, so never deploy it as a web service.

## What it costs

Measured against a 105-symbol universe:

| | |
| --- | --- |
| Packages installed | 23 (`yfinance` and its own requirements) |
| Resident memory, steady state | ~260 MB |
| Cycle time, steady state | ~4 s — almost entirely waiting on Yahoo |
| Network per cycle | one request per symbol, then ~3 Supabase writes |

The **first** cycle backfills all chart history (~160k rows) and takes a few
minutes. After that the worker tracks a high-water mark per series and only
sends bars the database has not seen.

### Why there is no Dockerfile and no supabase-py

Both were dropped deliberately when this moved to a 1 GB instance.

- **supabase-py** brought ~30 packages (pydantic, httpx, h2, realtime,
  storage3, gotrue, protobuf...) to make five kinds of REST call. `db.py` makes
  them with `http.client` over a single keep-alive HTTP/1.1 connection, which
  also removes the HTTP/2 stream-reset problem that used to need a client-swap
  hack at startup.
- **Docker** cost ~70 MB of daemon plus a second copy of Python on a box with
  1 GB. systemd already does restart-on-failure, restart-on-boot, log capture
  and memory limits.

## Cadence

| Setting | Default | Notes |
| --- | --- | --- |
| `POLL_INTERVAL_SECONDS` | `5` | The `live` cadence, while the regular session is open. A cycle takes ~4s, so this is about as tight as it usefully goes |
| `REGULAR_INTERVAL_SECONDS` | `120` | The `regular` cadence, through pre-market and after hours — real trading, but thin |
| `IDLE_INTERVAL_SECONDS` | `60` | The `idle` cadence. No feed requests are made at all; this is only how often the worker says it is still alive |
| `HISTORY_INTERVAL_SECONDS` | `1800` | 5D/1Y chart ranges. The 1m series rides the price tick, so it is never staler than the price |
| `MAX_SYMBOLS` | `400` | Ceiling on the polled universe |
| `BATCH_SIZE` | `60` | Symbols per bulk download |
| `DOWNLOAD_THREADS` | `8` | yfinance fetches one URL per symbol; past 8 the gain is noise |
| `BARS_PER_SYMBOL` | `500` | Cold-start backfill depth per symbol |

### Modes

The exchange clock picks the mode, and the mode picks the cadence:

| Exchange | Mode | What runs |
| --- | --- | --- |
| regular | `live` | The whole pipeline at `POLL_INTERVAL_SECONDS` |
| pre / post | `regular` | The same pipeline at `REGULAR_INTERVAL_SECONDS` |
| closed | `idle` | Nothing. No yfinance requests; settlement still runs, and the heartbeat keeps the control room honest |

`game_settings.worker_mode_override` forces a mode for rehearsals — set it from
Admin → Control room. It is ignored while the regular session is on, so nobody
can slow the feed under a live book. The engine reads the same rule
(`private.session_mode()`), and the book is open in any mode but `idle`, so the
feed and the order book can never disagree about whether the market is there.

## Safety

- **Idempotent with the Vercel cron.** `match_orders()` takes a
  transaction-level advisory lock, so if the cron and the worker tick
  simultaneously, the second caller returns immediately instead of
  double-filling.
- **Never crashes the loop.** Every stage catches its own exceptions; a bad
  symbol or a Yahoo hiccup costs one cycle, not the competition.
- **Writes are held back on failure.** A dropped chunk of chart bars leaves the
  high-water mark where it was, so the next cycle resends it instead of leaving
  a permanent hole.
- **Uses the service-role key**, so it bypasses RLS. Keep the key off any client
  and out of version control.

### Things to check

- The quote count should match your tradable instrument count. A `MAX_SYMBOLS`
  warning in the logs means symbols are being silently skipped — they'd have no
  price and orders on them would be refused.
- Occasional `Failed to get ticker 'XYZ' ... Connection timed out` lines are
  normal. yfinance logs them; the worker carries on and the symbol is picked up
  next cycle.
- `requirements.txt` does not pin yfinance. It is a scraper against a site that
  changes without notice, and pinning it is how you end up with a feed that
  quietly stops resolving mid-competition. Upgrade it freely and run
  `python poller.py --once` to check.

## If the worker dies mid-competition

The Vercel cron at `/api/cron/tick` keeps refreshing prices and matching orders
once a minute. The game degrades to one-minute prices rather than a frozen
market. Restart the worker and it resumes on its next cycle.
