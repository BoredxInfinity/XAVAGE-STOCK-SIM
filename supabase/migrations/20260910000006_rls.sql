-- =====================================================================
-- XAVAGE STOCK SIM :: 0006 -- row level security + grants
-- =====================================================================
-- Model: participants may READ their own team's book and nothing else.
-- They may never write directly -- every mutation goes through a
-- SECURITY DEFINER function that enforces the game rules first.
-- Note: auth.uid() is wrapped in (select ...) so Postgres evaluates it
-- once per statement instead of once per row.
-- =====================================================================

alter table public.teams               enable row level security;
alter table public.profiles            enable row level security;
alter table public.instruments         enable row level security;
alter table public.quotes              enable row level security;
alter table public.price_bars          enable row level security;
alter table public.positions           enable row level security;
alter table public.orders              enable row level security;
alter table public.trades              enable row level security;
alter table public.cash_ledger         enable row level security;
alter table public.game_settings       enable row level security;
alter table public.settings_history    enable row level security;
alter table public.portfolio_snapshots enable row level security;
alter table public.announcements       enable row level security;
alter table public.audit_log           enable row level security;
alter table public.system_state        enable row level security;

-- ---------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------
drop policy if exists profiles_self_read on public.profiles;
create policy profiles_self_read on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

drop policy if exists profiles_teammates_read on public.profiles;
create policy profiles_teammates_read on public.profiles
  for select to authenticated
  using (team_id is not null and team_id = (select private.current_team()));

drop policy if exists profiles_admin_read on public.profiles;
create policy profiles_admin_read on public.profiles
  for select to authenticated
  using ((select private.is_admin()));

-- ---------------------------------------------------------------------
-- teams  (a participant sees only their own team -- never a rival's book)
-- ---------------------------------------------------------------------
drop policy if exists teams_own_read on public.teams;
create policy teams_own_read on public.teams
  for select to authenticated
  using (id = (select private.current_team()) or (select private.is_admin()));

-- ---------------------------------------------------------------------
-- Reference data: readable by every signed-in user
-- ---------------------------------------------------------------------
drop policy if exists instruments_read on public.instruments;
create policy instruments_read on public.instruments
  for select to authenticated using (true);

drop policy if exists quotes_read on public.quotes;
create policy quotes_read on public.quotes
  for select to authenticated using (true);

drop policy if exists price_bars_read on public.price_bars;
create policy price_bars_read on public.price_bars
  for select to authenticated using (true);

drop policy if exists game_settings_read on public.game_settings;
create policy game_settings_read on public.game_settings
  for select to authenticated using (true);

drop policy if exists system_state_read on public.system_state;
create policy system_state_read on public.system_state
  for select to authenticated using (true);

drop policy if exists announcements_read on public.announcements;
create policy announcements_read on public.announcements
  for select to authenticated
  using (is_published or (select private.is_admin()));

drop policy if exists announcements_admin_write on public.announcements;
create policy announcements_admin_write on public.announcements
  for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

-- ---------------------------------------------------------------------
-- Team-scoped book data
-- ---------------------------------------------------------------------
drop policy if exists positions_team_read on public.positions;
create policy positions_team_read on public.positions
  for select to authenticated
  using (team_id = (select private.current_team()) or (select private.is_admin()));

drop policy if exists orders_team_read on public.orders;
create policy orders_team_read on public.orders
  for select to authenticated
  using (team_id = (select private.current_team()) or (select private.is_admin()));

drop policy if exists trades_team_read on public.trades;
create policy trades_team_read on public.trades
  for select to authenticated
  using (team_id = (select private.current_team()) or (select private.is_admin()));

drop policy if exists cash_ledger_team_read on public.cash_ledger;
create policy cash_ledger_team_read on public.cash_ledger
  for select to authenticated
  using (team_id = (select private.current_team()) or (select private.is_admin()));

drop policy if exists snapshots_team_read on public.portfolio_snapshots;
create policy snapshots_team_read on public.portfolio_snapshots
  for select to authenticated
  using (team_id = (select private.current_team()) or (select private.is_admin()));

-- ---------------------------------------------------------------------
-- Admin-only tables
-- ---------------------------------------------------------------------
drop policy if exists settings_history_admin on public.settings_history;
create policy settings_history_admin on public.settings_history
  for select to authenticated using ((select private.is_admin()));

drop policy if exists audit_log_admin on public.audit_log;
create policy audit_log_admin on public.audit_log
  for select to authenticated using ((select private.is_admin()));

-- =====================================================================
-- GRANTS -- no direct writes for clients; RPC only.
-- =====================================================================
revoke insert, update, delete on
  public.teams, public.profiles, public.instruments, public.quotes,
  public.price_bars, public.positions, public.orders, public.trades,
  public.cash_ledger, public.game_settings, public.settings_history,
  public.portfolio_snapshots, public.audit_log, public.system_state
from anon, authenticated;

revoke all on public.settings_history, public.audit_log from anon;

-- Functions default to EXECUTE for PUBLIC -- lock that down, then re-grant.
revoke execute on function
  public.place_order(text, text, text, numeric, numeric, numeric, numeric, numeric, text, text),
  public.cancel_order(uuid),
  public.get_portfolio(uuid),
  public.get_leaderboard(),
  public.get_market_status(),
  public.match_orders(text[]),
  public.expire_day_orders(),
  public.accrue_daily_interest(boolean),
  public.take_snapshots(),
  public.admin_update_settings(jsonb),
  public.admin_adjust_cash(uuid, numeric, text),
  public.admin_set_symbol_halt(text, boolean, text),
  public.admin_create_team(text, numeric),
  public.admin_reset_team(uuid, numeric),
  public.admin_liquidate_team(uuid, text),
  public.admin_set_team_frozen(uuid, boolean)
from public, anon;

-- participant + admin surface
grant execute on function
  public.place_order(text, text, text, numeric, numeric, numeric, numeric, numeric, text, text),
  public.cancel_order(uuid),
  public.get_portfolio(uuid),
  public.get_leaderboard(),
  public.get_market_status()
to authenticated;

-- admin surface (each function re-checks private.require_admin() itself)
grant execute on function
  public.admin_update_settings(jsonb),
  public.admin_adjust_cash(uuid, numeric, text),
  public.admin_set_symbol_halt(text, boolean, text),
  public.admin_create_team(text, numeric),
  public.admin_reset_team(uuid, numeric),
  public.admin_liquidate_team(uuid, text),
  public.admin_set_team_frozen(uuid, boolean)
to authenticated;

-- engine jobs: the Python worker / Vercel cron only (service_role key)
grant execute on function
  public.match_orders(text[]),
  public.expire_day_orders(),
  public.accrue_daily_interest(boolean),
  public.take_snapshots()
to service_role;

-- =====================================================================
-- Auth glue
-- =====================================================================

-- Fallback profile creation: keeps auth.users and profiles in lockstep even
-- if a user is created outside the admin API.
--
-- SECURITY: raw_user_meta_data is USER-EDITABLE (any signed-in user can rewrite
-- it via auth.updateUser). It must never decide privilege. So this trigger hard
-- codes role = 'participant' and must_change_password = true, and ignores any
-- 'role' the caller put in metadata -- otherwise a self-signup carrying
-- {"role":"admin"} would mint an administrator, handing out the rankings and
-- every admin RPC. Genuine admins are promoted afterwards by an explicit
-- service-role UPDATE (see /api/admin/users and scripts/bootstrap-admin.mjs),
-- which is a path a participant cannot reach.
-- display_name is cosmetic, never an authorization input, so a metadata
-- fallback is fine there.
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name, role, must_change_password)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), split_part(coalesce(new.email, 'trader'), '@', 1)),
    'participant',   -- never from metadata
    true             -- never from metadata; admins clear it explicitly
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- Called by the app right after a successful password rotation.
create or replace function public.mark_password_changed()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  update public.profiles
     set must_change_password = false, last_login_at = now()
   where id = v_uid;

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.mark_password_changed() from public, anon;
grant execute on function public.mark_password_changed() to authenticated;

-- Lightweight login stamp (also used to detect dormant accounts).
create or replace function public.touch_login()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.profiles;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  update public.profiles set last_login_at = now()
   where id = v_uid returning * into v_row;

  if not found or not v_row.is_active then
    raise exception 'Your account is inactive.' using errcode = '28000';
  end if;

  return jsonb_build_object('ok', true, 'role', v_row.role,
                            'must_change_password', v_row.must_change_password,
                            'team_id', v_row.team_id);
end;
$$;

revoke execute on function public.touch_login() from public, anon;
grant execute on function public.touch_login() to authenticated;

-- =====================================================================
-- Private schema lockdown
-- =====================================================================
-- RLS policy expressions are evaluated AS THE CALLING USER, so the two
-- helpers referenced by policies must be executable by `authenticated`.
-- That is safe: both are SECURITY DEFINER, take no arguments, and derive
-- everything from auth.uid() -- a user can only ever learn their own role
-- and their own team. Every other private function stays unreachable, so
-- nobody can call apply_fill() or team_metrics() directly to forge a fill.
grant usage on schema private to authenticated, service_role;

revoke execute on all functions in schema private from public, anon, authenticated;

grant execute on function private.is_admin(), private.current_team()
  to authenticated, service_role;

-- =====================================================================
-- Realtime: push live prices and the team's own book to the client.
-- RLS above still applies to every realtime payload.
-- =====================================================================
do $$ begin
  alter publication supabase_realtime add table public.quotes;
  alter publication supabase_realtime add table public.orders;
  alter publication supabase_realtime add table public.positions;
  alter publication supabase_realtime add table public.trades;
  alter publication supabase_realtime add table public.teams;
  alter publication supabase_realtime add table public.announcements;
  alter publication supabase_realtime add table public.game_settings;
exception when duplicate_object then null; end $$;
