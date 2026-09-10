# Deploying Xavage

Two targets: **Supabase** (database + auth) and **Vercel** (the app). The Python
price worker runs wherever you like — see [`worker/README.md`](worker/README.md).

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

Then confirm all seven applied:

```bash
npx supabase migration list --linked
```

You should see `20260910000001_schema` through `20260910000007_seed`, all with a
remote timestamp.

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
| `/api/cron/tick` | every minute | fallback prices + matching pass |
| `/api/cron/settle` | 21:05 UTC, Mon–Fri | expire day orders, accrue interest, snapshot equity |

Minute-level crons need Vercel **Pro**. On Hobby they run once a day, so the
Python worker is the real feed and the cron is only a safety net.

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
