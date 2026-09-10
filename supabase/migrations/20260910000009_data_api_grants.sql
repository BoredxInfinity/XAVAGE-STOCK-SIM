-- =====================================================================
-- XAVAGE STOCK SIM :: 0009 -- explicit Data API grants
-- =====================================================================
-- Tables created by a migration are NOT automatically reachable through the
-- Data API. On the hosted project every table came out with only
-- REFERENCES/TRIGGER/TRUNCATE for anon/authenticated/service_role -- no
-- SELECT -- so every read failed with 42501 "permission denied", even for
-- service_role. A local stack can hide this if its default privileges were
-- widened before the tables existed, which is exactly what happened here.
--
-- So grant explicitly rather than relying on default privileges:
--
--   authenticated : SELECT only. RLS (migration 0006) then decides WHICH rows,
--                   and every mutation still has to go through a SECURITY
--                   DEFINER RPC that enforces the game rules first.
--   anon          : nothing. There is no unauthenticated surface.
--   service_role  : full DML. This is the trusted server path -- admin API
--                   routes, the price worker, and the Vercel crons. It
--                   bypasses RLS by design.
-- =====================================================================

-- ---- read access for signed-in users (RLS still filters rows) ----
grant select on
  public.teams, public.profiles, public.instruments, public.quotes,
  public.price_bars, public.positions, public.orders, public.trades,
  public.cash_ledger, public.game_settings, public.settings_history,
  public.portfolio_snapshots, public.announcements, public.audit_log,
  public.system_state
to authenticated;

-- ---- the trusted server path needs everything ----
grant select, insert, update, delete on
  public.teams, public.profiles, public.instruments, public.quotes,
  public.price_bars, public.positions, public.orders, public.trades,
  public.cash_ledger, public.game_settings, public.settings_history,
  public.portfolio_snapshots, public.announcements, public.audit_log,
  public.system_state
to service_role;

grant usage on all sequences in schema public to service_role;

-- ---- anon stays shut out ----
revoke all on
  public.teams, public.profiles, public.instruments, public.quotes,
  public.price_bars, public.positions, public.orders, public.trades,
  public.cash_ledger, public.game_settings, public.settings_history,
  public.portfolio_snapshots, public.announcements, public.audit_log,
  public.system_state
from anon;

-- ---- clients may never write directly, only through the engine RPCs ----
revoke insert, update, delete on
  public.teams, public.profiles, public.instruments, public.quotes,
  public.price_bars, public.positions, public.orders, public.trades,
  public.cash_ledger, public.game_settings, public.settings_history,
  public.portfolio_snapshots, public.announcements, public.audit_log,
  public.system_state
from authenticated;

-- announcements are the one thing admins write via the table API (policy
-- announcements_admin_write in 0006 gates it to admins).
grant insert, update, delete on public.announcements to authenticated;

-- ---- verify, rather than assume ----
do $$
declare v_missing text;
begin
  select string_agg(t.table_name, ', ' order by t.table_name) into v_missing
  from information_schema.tables t
  where t.table_schema = 'public'
    and t.table_type = 'BASE TABLE'
    and not exists (
      select 1 from information_schema.role_table_grants g
      where g.table_schema = 'public' and g.table_name = t.table_name
        and g.grantee = 'authenticated' and g.privilege_type = 'SELECT'
    );

  if v_missing is not null then
    raise exception 'tables still unreadable by authenticated: %', v_missing;
  end if;

  raise notice 'Data API grants verified for every public table';
end $$;
