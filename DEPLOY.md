# Deploying Xavage

Two targets: **Supabase** (database + auth) and **Vercel** (the app). The Python
price worker needs a host that stays up — see
[`worker/DEPLOY-ORACLE.md`](worker/DEPLOY-ORACLE.md) for the free Oracle Cloud setup.

---

## 1. Create the Supabase project

Dashboard → **New project**.

| Field | Value |
| --- | --- |
| Name | `Xavage` (anything) |
| Region | **Mumbai · ap-south-1** — lowest latency for participants in India |
| Database password | Generate a strong one and **save it in your password manager** |
| Plan | Free is fine for a 4–5 week event with this load |

Then copy the **project ref** — the `abcdefgh…` string in the dashboard URL
(`supabase.com/dashboard/project/<REF>`).

> Keep the database password. It's needed for `db push` and cannot be viewed
> again later — only reset.

---

## 2. Push the schema

From the repo root:

```bash
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
```

Both will prompt for the database password. To avoid retyping it, export it
first (this keeps it out of your shell history if you use a leading space):

```bash
export SUPABASE_DB_PASSWORD='your-db-password'
```

Then confirm every migration applied:

```bash
npx supabase migration list --linked
```

Every row must show a remote timestamp. Do not count to a fixed number — this
said "all seven" while the repo had grown to twenty-plus, so the check passed
with most of the schema missing. Compare the list against
`supabase/migrations/` and make sure nothing is local-only.

---

## 3. Lock down auth

This step matters and is easy to get wrong in *both* directions.

Dashboard → **Authentication → Sign In / Providers**:

- **Email provider: ENABLED** ✅
- **"Allow new users to sign up": OFF** ❌
- **"Confirm email": OFF** — organisers pre-confirm every account

> Do **not** disable the Email provider to block signups. Supabase maps that to
> `GOTRUE_EXTERNAL_EMAIL_ENABLED=false`, which switches off email/password
> *login* as well — nobody, including you, can sign in. The separate
> "Allow new users to sign up" toggle is the one you want. The admin API that
> creates accounts deliberately bypasses it.

---

## 4. Create the first admin

Get the keys from **Project Settings → API**, put them in `.env.local`, then:

```bash
node scripts/bootstrap-admin.mjs "you@example.com" "AStrongPassword123" "Your Name"
```

Sign in at `/login` and create teams and accounts from the admin console.

---

## 5. Deploy the app to Vercel

Import the repo, then set these environment variables:

| Variable | Value | Scope |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<REF>.supabase.co` | all |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon / publishable key | all |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key — **server only** | all |
| `CRON_SECRET` | `openssl rand -hex 32` | all |

> `SUPABASE_SERVICE_ROLE_KEY` must **never** get a `NEXT_PUBLIC_` prefix. Any
> `NEXT_PUBLIC_` variable is shipped to the browser, and that key bypasses RLS
> entirely — it would hand every participant full read/write on every team.

Once deployed, add the Vercel URL to Supabase → **Authentication → URL
Configuration → Site URL** and **Redirect URLs**.

`vercel.json` registers two crons automatically:

| Path | Schedule | Purpose |
| --- | --- | --- |
| `/api/cron/tick` | 13:35 UTC, Mon–Fri — **once a day** | fallback prices + matching pass |
| `/api/cron/settle` | 21:05 UTC, Mon–Fri | expire day orders, accrue interest, snapshot equity |

> **The tick cron is not a safety net.** Hobby-plan crons are daily-only, so
> `/api/cron/tick` fires once per weekday. If the price worker dies at 10:00
> the market stays frozen until a human notices. The schedule is also
> DST-fragile: 13:35 UTC is 09:35 ET only while EDT is in effect, and from
> 1 Nov it lands an hour *before* the open.
>
> What actually covers a dead worker is the **uptime monitor** below. Set it
> up; it is free and it takes two minutes.

### Uptime monitoring (do this before the event)

`/api/health` is unauthenticated and returns **503** when the market should be
open and prices have stopped advancing. It judges the age of the newest
**quote**, not `last_tick_at` — the worker heartbeats every cycle whether or
not Yahoo answered, so a tick timestamp stays fresh straight through a feed
outage.

1. Create a free monitor (UptimeRobot, Betterstack, Cronitor — any of them).
2. Point it at `https://<your-vercel-url>/api/health`, every 1 minute.
3. Alert on a non-200, to a phone that will be in the room.

Out of hours it returns 200 with `is_open: false`, so it will not page you at
3am for a market that is simply shut.

To see what it is reporting:

```bash
curl -s https://<your-vercel-url>/api/health | jq
```

### Web Analytics

`<Analytics />` is already in the root layout, but it records nothing until the
project is switched on: **Vercel → your project → Analytics → Enable**. Data
starts arriving on the next deployment that receives traffic.

Two things that are easy to get wrong here:

- The middleware matcher excludes `_vercel` deliberately. Without it the
  beacons — which post to `/_vercel/insights/view` — are answered with a
  redirect to `/login` for anyone not signed in, so the login page records no
  traffic at all, and every beacon from a signed-in participant costs a JWT
  revalidation and a profile lookup.
- Page views are recorded by route, and no route in this app carries a team or
  account id, so nothing identifying leaves the browser. Keep it that way if
  you add routes: a path like `/admin/teams/<uuid>` would put a team id into
  the analytics dashboard.

### Cron schedules and the Hobby plan

Hobby allows **at most 2 cron jobs, each running at most once per day**. A
minute-level schedule (`* * * * *`) is rejected outright at import with:

> Hobby accounts are limited to daily cron jobs.

So `vercel.json` ships with Hobby-compatible daily schedules:

| Path | Schedule (UTC) | In New York | What it does |
| --- | --- | --- | --- |
| `/api/cron/tick` | `35 13 * * 1-5` | 09:35 — just after the open | one price refresh + matching pass |
| `/api/cron/settle` | `5 21 * * 1-5` | 17:05 — after the close | expire day orders, accrue interest, snapshot equity |

**`/api/cron/settle` is fully functional on Hobby** — once per weekday is its
natural cadence anyway, so nothing is lost there.

**`/api/cron/tick` is degraded on Hobby.** It was designed as a once-a-minute
safety net for a dead price worker; once a day it can only nudge the market
back to life at the open. **The Python worker is the real feed** — treat it as
required infrastructure, not an optional extra, and make sure it stays running
for the whole competition.

On **Pro**, change the tick back to a real fallback:

```json
{ "path": "/api/cron/tick", "schedule": "* * * * *" }
```

---

## 6. Start the price worker

The worker is the primary market feed. Point it at the hosted project:

```bash
cd worker
cp .env.example .env      # SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
python poller.py
```

Check the log shows a healthy cycle:

```
17:49:22  INFO  xavage.worker  cycle 2 | regular | 101 quotes | 41 new bars | no fills | 5.29s
```

- `101 quotes` should match your tradable instrument count. If the worker warns
  about `MAX_SYMBOLS` truncating, raise it — truncated symbols silently have no
  price and orders on them are refused.
- Run it as a **background/worker** service (not a web service) if hosting on
  Railway/Fly/Render — it doesn't listen on a port.

---

## 7. Pre-event checklist

- [ ] `migration list --linked` shows all 7 applied
- [ ] Signups OFF, email provider ON, confirm-email OFF
- [ ] Admin can sign in; a test participant can sign in and is forced to rotate
- [ ] Admin → Overview shows **"Price feed healthy"**
- [ ] Symbols quoting == tradable instruments (no `MAX_SYMBOLS` warning)
- [ ] Game settings reviewed: starting capital, commissions, shorting/margin,
      concentration limit, `competition_start_at` / `competition_end_at`
- [ ] Rankings confirmed hidden from participants
- [ ] A test market order fills; a limit order rests and cancels cleanly
- [ ] Practice runs wiped via Admin → Teams → **Reset** for each team

---

## Rolling back a schema change

Migrations are forward-only. To change the schema mid-event, add a new
migration and `db push` again — never edit an applied migration file, since the
remote already has it and the checksums will diverge.

---

## Reading `supabase db advisors`

Running `npx supabase db advisors --linked --type security --level warn` reports
**14 findings of one kind**, and they are expected. Don't "fix" them by revoking
grants — that would break the game.

```
Signed-In Users Can Execute SECURITY DEFINER Function   (x14)
```

The linter flags every `SECURITY DEFINER` function callable by `authenticated`.
In this app those functions *are* the API, deliberately:

| Function | Why `authenticated` can call it |
| --- | --- |
| `place_order`, `cancel_order` | The only way to trade. Each loads the caller's profile from `auth.uid()` and scopes everything to their own team. |
| `get_portfolio`, `get_market_status` | Read APIs, scoped to the caller's team. |
| `mark_password_changed`, `touch_login` | Act only on the caller's own row. |
| `get_leaderboard` | Gated on `private.is_admin()` OR the `leaderboard_visible_to_participants` setting. |
| the 7 `admin_*` functions | Each calls `private.require_admin()` as its first statement and raises `42501` for everyone else. |

This *has* to work this way: an admin still authenticates as the Postgres role
`authenticated`, so there is no separate role to grant to. Role checks belong
inside the function, which is the pattern Supabase itself prescribes.

Verified against the live project with a real participant JWT, bypassing the app:

| Probe | Result |
| --- | --- |
| `select * from teams` | 1 row — only their own team |
| `select * from profiles` | 1 row — only themselves |
| `select * from audit_log` / `settings_history` | `[]` |
| `get_leaderboard()` | `42501 Rankings are not available.` |
| `admin_adjust_cash / create_team / update_settings / set_team_frozen` | `42501 Administrator access required.` |
| `UPDATE teams SET cash WHERE id=<own>` | `42501 permission denied` |
| `INSERT INTO orders` | `42501 permission denied` |
| `get_portfolio()` / `get_market_status()` | work normally |

If a future advisor run shows anything **other** than those 14, investigate it.

---

## Dependency security

`next` is **pinned exactly** (no `^`) so an unreviewed patch can't land on the
next install mid-competition. Same reasoning for the rest of the lockfile —
commit `package-lock.json` and don't regenerate it during the event.

Current posture (`npm audit`):

| Package | Status |
| --- | --- |
| `next` 15.5.25 | All critical and high advisories resolved, including the App Router **Middleware/Proxy bypass** family — directly relevant, since middleware is what gates `/admin`. |
| `postcss` | Advisories remain but are **not reachable here**: all concern attacker-controlled CSS / `sourceMappingURL`, and postcss only runs at build time over hand-authored CSS. No user CSS is ever processed. |
| `sharp` | Advisories remain but are **not reachable here**: they're triggered through Next's Image Optimizer. This app uses no `next/image` and sets no `images` config, so remote optimization is rejected outright — and on Vercel it runs on their infrastructure regardless. |

Clearing the last two requires **Next 16**, a semver-major upgrade. That is not
worth attempting days before a live event; revisit after the competition.

Re-check at any time with:

```bash
npm audit
```

If a *new* critical or high lands on `next` itself during the event, take the
patch — `npm install next@<patched-15.x>`, then `npm run build` to confirm, and
push. Vercel redeploys on push.
