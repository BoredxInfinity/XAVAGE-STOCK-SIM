# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A live-market stock trading simulation for the **Xavage** business-school competition: teams share
a book, trade real US equities at real prices, and organisers steer the game (rates, costs, halts,
limits) while it runs. Next.js 15 App Router + React 19 on Vercel, Supabase Postgres/Auth/Realtime,
a Python + yfinance price worker, and a matching engine written in plpgsql.

`README.md` covers running the competition; `DEPLOY.md` covers Supabase/Vercel setup and the auth
toggles that are easy to get wrong. Both are current — read them before changing deployment or
auth behaviour.

## Commands

```bash
npm run dev          # Next dev server on :3000
npm run build        # production build — the real typecheck of app code
npm run typecheck    # tsc --noEmit
npm run lint         # next lint
npm audit            # dependency posture; see DEPLOY.md for which findings are expected
```

Schema:

```bash
npx supabase db push                     # apply migrations to the linked project
npx supabase migration list --linked     # confirm what the remote actually has
npx supabase db advisors --linked --type security --level warn
```

Worker (from `worker/`, Python 3.10+, one dependency):

```bash
python poller.py            # the real price feed
python poller.py --once     # single cycle then exit — fastest way to check a config/yfinance change
```

There is no test suite. Verification is manual: `npm run build`, `poller.py --once`, and the
engine checks listed in `README.md`.

## Architecture

### The engine lives in Postgres, not in the app

**No app code ever writes a position, a fill, or cash.** `INSERT`/`UPDATE`/`DELETE` are revoked
from `authenticated` on every game table. The only way in is a `SECURITY DEFINER` plpgsql function
that locks the team row first, so several members of a team trading from different laptops still
come out arithmetically correct.

- `place_order`, `cancel_order` — the participant write API (`supabase/migrations/…_engine.sql`)
- `get_portfolio`, `get_market_status`, `get_leaderboard` — read API, scoped to the caller's team
- `match_orders`, `expire_day_orders`, `accrue_daily_interest`, `take_snapshots` — the tick and
  settlement passes (`…_matching.sql`)
- `admin_*` — organiser levers; each calls `private.require_admin()` as its first statement
- `private.*` — helpers (`is_admin`, `current_team`, `apply_fill`, `release_reservations`, …),
  not reachable from PostgREST

Adding a feature that mutates game state means writing a migration, not a route handler.
`match_orders()` takes a transaction-level advisory lock, so the worker and the Vercel cron can
tick simultaneously without double-filling.

Migrations are **forward-only** — never edit an applied file; add a new one. `src/lib/database.types.ts`
is a hand-maintained mirror of the SQL and must be updated alongside any schema change (its types
are `type` aliases, not `interface`s, on purpose — see the note at the top of the file).

### Two clients, two trust levels

- `src/lib/supabase/server.ts` / `client.ts` — anon key, caller's session, **RLS applies**.
- `src/lib/supabase/admin.ts` — service role, **bypasses RLS entirely**. Server-only; never import
  into a client component, never give the key a `NEXT_PUBLIC_` prefix.

Every route that reaches for the admin client must go through `requireAdmin()` in
`src/lib/admin-guard.ts` — that check *is* the security boundary — and record the change with
`writeAudit()`. `src/middleware.ts` gates routes by session and role (inactive → signed out,
`must_change_password` → `/change-password`, non-admin on `/admin` → `/dashboard`); it uses
`getUser()` deliberately, which revalidates the JWT — do not swap it for `getSession()`.

Admin operations split by what they touch: anything that is game state is an `admin_*` RPC called
from the client with the user's own session; anything touching **auth users** (creating accounts,
issuing credentials) is a `/api/admin/*` route, because that needs the admin API.

### Price flow

```
Python worker (5s) ──upsert──▶ quotes ──▶ match_orders() ──▶ fills
        │                                                      │
        └── Broadcast "xavage:prices" ──▶ browsers ◀── Postgres Changes on orders/positions/trades
Vercel cron /api/cron/tick ── fallback tick + matching pass
```

Prices ride **Broadcast**, one batched message per cycle carrying only symbols that moved. Postgres
Changes on `quotes` emits one message per row per subscriber — ~105× the volume, which would exhaust
the Realtime quota mid-event. The order book stays on Postgres Changes, where per-row RLS is doing
real work. The rationale and the exact numbers are in `supabase/migrations/…_price_broadcast.sql`
and `src/components/market-data-provider.tsx`; don't undo this.

`MarketDataProvider` opens the app's single realtime connection, self-heals to Postgres Changes if
the private channel is refused, and re-seeds from `quotes` on a slow reconcile poll. Set
`NEXT_PUBLIC_QUOTES_TRANSPORT=postgres_changes` (app) or `BROADCAST_QUOTES=0` (worker) to force the
old path without a deploy.

Anything that renders a relative time ("updated 8s ago", "last tick 14s ago") must take
its clock from `useNow()` (`src/hooks/use-now.ts`) and pass it to `relative()`. These strings are
computed during render, so without it they freeze between data changes and a live page reads as a
dead one. It is one shared interval for the whole app — don't add a per-component timer.

Quotes do **not** go through React Query. `src/lib/quote-store.ts` is an external store consumed via
`useSyncExternalStore` (`src/hooks/use-quote.ts`) so a tick in one symbol re-renders only the
components watching that symbol. Everything else — portfolio, orders, trades, leaderboard — is
React Query in `src/hooks/use-app-data.ts`, invalidated by the book channel.

### Worker

`worker/` targets a 1 GB free box: exactly one third-party dependency (yfinance), PostgREST spoken
over `http.client` in `db.py`, no Docker, no supabase-py. `poller.py` is the loop; `feed.py` fetches;
`market.py` tracks the US session and follows the admin's market-hours mode; `logbook.py` ships
WARNING+ and anomalous stages to the `worker_logs` table, which is what Admin → Control room reads.
`worker/README.md` explains the cadence knobs and why the dependency diet is deliberate.

### App structure

`src/app/**/page.tsx` files are thin — metadata plus a single component from `src/components/views/`,
which holds the actual client view. Layouts do the server-side session/profile fetch. Charts use
`lightweight-charts` and are served from the local `price_bars` table via `/api/chart/[symbol]`;
only three ranges exist (1D/5D/1M) and that constraint is what keeps history refresh affordable
for the worker.

Styling is Tailwind v4 with tokens declared in `@theme` in `src/app/globals.css` — a dark
terminal palette plus `.panel`, `.num` (tabular figures for every numeric readout) and friends.
Use the tokens and utility classes there rather than introducing new colours.

## Environment

`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
`CRON_SECRET` for the app; `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` for the worker.
See `.env.example`.

Note that `.env.local` points at the **local** Supabase stack (`http://127.0.0.1:54321`), so
`npm run dev` cannot sign anyone in unless `npx supabase start` is running. Verifying a change
against real data usually means the Vercel deployment, not localhost.

`next` is pinned exactly (no `^`) so an unreviewed patch can't land mid-competition; leave
`package-lock.json` alone during an event.
