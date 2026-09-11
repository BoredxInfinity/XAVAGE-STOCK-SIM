# Xavage Trading Floor

A live-market stock trading simulation built for the **Xavage** business-school
competition. Teams share a single book, trade real US equities at real prices,
and organisers steer the game — interest rates, costs, halts, limits — while
it's running.

- **Next.js 15** (App Router, React 19, TypeScript) on **Vercel**
- **Supabase** Postgres + Auth + Realtime
- **Python + yfinance** price worker
- Matching engine written in **plpgsql**, so order execution is atomic

---

## How it's put together

```
Python worker (yfinance)  ──upsert──▶  quotes  ──▶  match_orders()  ──▶  fills
   every 5s                              │                                 │
                                    Supabase Realtime                      │
                                          │                                ▼
Vercel cron (fallback, 1/min) ────────────┼──────────▶  Next.js app  ◀── positions,
                                          │                              orders, P&L
                                          ▼
                                   participants' browsers
```

**Why the engine lives in the database.** Every mutation — placing an order,
cancelling one, a limit filling on a tick — runs inside a `SECURITY DEFINER`
Postgres function that locks the team row first. Several members of a team can
hammer the same book from different laptops and the arithmetic still comes out
right. Ten simultaneous orders against $100,000 of buying power fill exactly two
and reject eight; cash lands on $0.00, never negative. There is no code path
where the app writes a position directly.

**Why prices come from a worker, not the browser.** One process polls yfinance
and writes to `quotes`; every participant reads from Supabase. A hundred
students refreshing does not become a hundred calls to Yahoo.

---

## Features

**Trading**
- Market, limit, stop, stop-limit and trailing-stop orders
- Day / GTC / IOC / FOK time-in-force
- Pending → executed → cancelled lifecycle, with per-order cancellation
- Cash and share reservations, so the same money can't be committed twice
- Commission, slippage, and optional capital-gains tax
- Optional shorting and margin with a leverage ceiling
- Realised / unrealised P&L, average cost basis, full cash ledger

**Live data**
- Real prices and OHLCV charts (area + candlestick, 1D → 1Y)
- Ticker search that resolves *any* listed symbol via Yahoo, not just a seed list
- Realtime price flashes, positions and order updates over websockets

**Admin**
- Provision every account; forced password rotation on first sign-in
- Create and fund teams, adjust cash, freeze, reset, force-liquidate
- Mid-game levers: interest rates, commissions, slippage, leverage,
  concentration limits, order size caps, market-hours mode
- Halt the whole market or a single symbol, with a reason shown to participants
- **Rankings, admin-only by default** — participants cannot see standings
- Announcement wire, full audit log, and a settings-change history

---

> **Deploying?** Follow [`DEPLOY.md`](DEPLOY.md) — it covers the Supabase push,
> the auth toggles that are easy to get wrong, Vercel env vars, and a pre-event
> checklist.

## Setup

### 1. Supabase

Create a project at [supabase.com](https://supabase.com), then push the schema:

```bash
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
```

Then turn **off** public signups — organisers issue all accounts:
**Authentication → Sign In / Providers → uncheck "Allow new users to sign up"**.

> Leave the **Email provider itself enabled**. Disabling the email provider (or
> setting `[auth.email].enable_signup = false` in `config.toml`) switches off
> email/password *login* too, and nobody — including you — can sign in. The
> global signup toggle is the one you want; the admin API used to create
> accounts deliberately bypasses it.

### 2. Environment

Copy `.env.example` to `.env.local` and fill in the values from
Supabase → Project Settings → API:

```bash
cp .env.example .env.local
```

| Variable | Where it's used |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | browser + server |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser + server (RLS applies) |
| `SUPABASE_SERVICE_ROLE_KEY` | **server only** — admin routes and cron |
| `CRON_SECRET` | authenticates the Vercel cron |

Generate a cron secret with `openssl rand -hex 32`.

### 3. First admin

```bash
npm install
node scripts/bootstrap-admin.mjs "you@example.com" "AStrongPassword123" "Your Name"
```

### 4. Run it

```bash
npm run dev
```

Sign in at <http://localhost:3000/login>, then create teams and accounts under
**Admin → Teams** and **Admin → Accounts**.

### 5. Price worker

```bash
cd worker
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env      # SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
python poller.py
```

See [`worker/README.md`](worker/README.md) to run it, and
[`worker/DEPLOY-ORACLE.md`](worker/DEPLOY-ORACLE.md) to host it free on Oracle Cloud.

### 6. Deploy

Push to Vercel and set the same four environment variables. `vercel.json`
registers two crons:

| Path | Schedule | Does |
| --- | --- | --- |
| `/api/cron/tick` | every minute | fallback prices + matching pass |
| `/api/cron/settle` | 21:05 UTC, Mon–Fri | expire day orders, accrue interest, snapshot equity |

Vercel cron needs a Pro plan for minute-level schedules; on Hobby it runs daily,
so keep the Python worker as the real feed.

---

## Running the competition

**Before it starts**

1. Create teams (Admin → Teams). Each gets a shared book and starting capital.
2. Create accounts and assign them to teams. Hand out the one-time passwords.
3. Set the rules in Admin → Game settings — starting capital, commissions,
   whether shorting and margin are allowed, the concentration limit.
4. Set `competition_start_at` / `competition_end_at` so orders are refused
   outside the window.
5. Let teams practise, then **reset each team** to wipe the practice record.

**During**

- Watch Admin → Overview for feed health and standings.
- Change rates or costs any time; participants see it immediately and every
  change lands in the settings history.
- Use announcements to explain each change.
- Halt a symbol on a news event, or halt everything if you need a pause.

**After**

- Export final standings to CSV from Admin → Rankings.
- Teams can export their own blotter from History.

---

## Verification

The matching engine has been exercised against a real Postgres:

| Check | Result |
| --- | --- |
| Market buy, cost basis, cash | 100 @ 200 → cash 100,000 → 80,000 ✓ |
| Realised P&L on a partial close | sell 40 @ 210 → +400 realised, basis unchanged ✓ |
| Limit fill with price improvement | limit 380, market 375 → filled at 375 ✓ |
| Stop-loss trigger | stop 205, market 204 → filled ✓ |
| Trailing stop | ratchets on a rally, fires on the pullback ✓ |
| Reservations | held on placement, released on fill and on cancel ✓ |
| Idempotency | duplicate `client_order_id` returns the original order ✓ |
| **10 concurrent buys, $100k book** | exactly 2 filled, cash exactly $0.00 ✓ |
| **10 concurrent sells, 200 shares** | exactly 4 filled, no overselling ✓ |
| RLS isolation | a team sees 0 rows of another team's orders/positions/trades ✓ |
| Rankings gating | participant → "Rankings are not available" ✓ |
| Direct writes | `update teams set cash = …` → permission denied ✓ |

---

## Security

- **Row-Level Security on every table.** A participant can read their own team's
  book and nothing else. Rankings are gated behind an admin check in the
  database, not just in the UI.
- **No client writes.** `INSERT`/`UPDATE`/`DELETE` are revoked from
  `authenticated` on every game table. The only way in is an RPC that enforces
  the rules first.
- **The service-role key never reaches the browser.** It is used only in server
  routes, each of which re-checks the caller is an active admin.
- **Forced password rotation** on first sign-in, and disabling an account
  terminates its session on the next request.
- **Everything admins do is audited** — `audit_log` and `settings_history` are
  admin-readable and cannot be edited from the app.

---

## Layout

```
src/
  app/
    (app)/          participant pages — dashboard, trade, portfolio, orders, history
    admin/          organiser console
    api/            search, chart, cron, admin routes
  components/       UI, tables, trade widgets, admin views
  lib/              supabase clients, types, formatting, quote store
supabase/migrations/ schema, engine, RLS, seed
worker/             Python yfinance price worker (one dependency, systemd)
scripts/            admin bootstrap
```
