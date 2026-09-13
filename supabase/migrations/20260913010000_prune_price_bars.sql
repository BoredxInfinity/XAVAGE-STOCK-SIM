-- =====================================================================
-- XAVAGE STOCK SIM :: retention for price_bars
-- =====================================================================
-- `price_bars` was the only table that grew without bound. `worker_logs` has
-- had a 48h window since 20260912031845; bars had nothing, and they are by far
-- the largest thing in the database: three trading days of 1m candles for ~148
-- symbols came to 140 MB of a 500 MB free-tier allowance, growing ~40 MB per
-- trading day. On that curve the database fills in the second week of a
-- five-week competition, which ends the event rather than degrading it.
--
-- Nothing is lost, because /api/chart cannot ask for what this removes. The
-- route offers three ranges and each one bounds its own query:
--
--     1D -> 1m bars, now - 1 day
--     5D -> 5m bars, now - 5 days
--     1M -> 1d bars, now - 31 days
--
-- So the defaults below keep every bar any chart can request, with margin:
-- 3 days of 1m against a 1-day window, 12 days of 5m against 5, and a year of
-- daily bars against 31 -- daily bars are ~150 rows a day in total and are not
-- worth pruning tightly.
--
-- Steady state is roughly 190 MB instead of unbounded growth.
--
-- Called by the worker on its existing hourly prune timer rather than by a
-- cron, for the same reason prune_worker_logs is: the table must not be able
-- to grow without bound if the Vercel cron is ever removed.
-- =====================================================================

create or replace function public.prune_price_bars(
  p_minute_days  integer default 3,
  p_five_min_days integer default 12,
  p_daily_days   integer default 400
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  removed integer := 0;
  n       integer;
begin
  -- One statement per interval: the retention differs per series, and the
  -- (symbol, interval, ts) index makes each of these a range scan.
  -- GET DIAGNOSTICS assigns from a diagnostic item only, never an expression,
  -- so each count lands in `n` and is accumulated separately.
  delete from public.price_bars
   where interval = '1m'
     and ts < now() - make_interval(days => greatest(p_minute_days, 2));
  get diagnostics n = row_count;
  removed := removed + n;

  delete from public.price_bars
   where interval = '5m'
     and ts < now() - make_interval(days => greatest(p_five_min_days, 6));
  get diagnostics n = row_count;
  removed := removed + n;

  delete from public.price_bars
   where interval = '1d'
     and ts < now() - make_interval(days => greatest(p_daily_days, 35));
  get diagnostics n = row_count;
  removed := removed + n;

  return removed;
end;
$$;

-- The floors in those greatest() calls are not taste either: they are one day
-- more than the longest window /api/chart can request for that interval, so a
-- mistaken call cannot empty a chart that participants are looking at.

revoke all on function public.prune_price_bars(integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.prune_price_bars(integer, integer, integer)
  to service_role;

comment on function public.prune_price_bars(integer, integer, integer) is
  'Retention for price_bars: keeps more than every chart range can ask for, and nothing beyond it. Called hourly by the price worker.';
