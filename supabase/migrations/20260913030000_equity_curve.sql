-- =====================================================================
-- XAVAGE STOCK SIM :: the equity curve, server-side and bounded
-- =====================================================================
-- The client fetched the curve as a raw table read:
--
--     portfolio_snapshots ... order by ts asc limit 2000
--
-- which is wrong in two ways that both get worse as the competition runs.
--
-- It takes the OLDEST 2000 rows. Snapshots land about every nine minutes, so
-- a team passes 2000 around day twelve of a five-week event -- and from then
-- on the dashboard curve silently stops advancing. No error, no gap, just a
-- chart frozen at week two while the number above it keeps moving.
--
-- And it is 54.6 KB on the wire, re-fetched every 60 seconds by every open
-- dashboard and portfolio tab: 3.3 MB per tab-hour, which at 200 participants
-- is the single largest line item in the whole system.
--
-- Bucketing server-side fixes both. The curve always spans the entire
-- competition, however long it runs, at a bounded number of points -- and a
-- chart a few hundred pixels wide cannot render more than a few hundred
-- points anyway, so nothing visible is lost.
-- =====================================================================

create or replace function public.get_equity_curve(
  p_team_id uuid default null,
  p_points  integer default 240
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_profile public.profiles;
  v_team_id uuid;
  v_points  integer := least(greatest(coalesce(p_points, 240), 24), 1000);
  v_rows    jsonb;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  select * into v_profile from public.profiles where id = v_uid and is_active;
  if not found then
    raise exception 'Your account is inactive.' using errcode = '28000';
  end if;

  -- Same rule as get_portfolio: your own team, unless you are an admin asking
  -- about someone else's.
  if p_team_id is not null and p_team_id is distinct from v_profile.team_id then
    if not private.is_admin() then
      raise exception 'Not permitted.' using errcode = '42501';
    end if;
    v_team_id := p_team_id;
  else
    v_team_id := v_profile.team_id;
  end if;

  if v_team_id is null then
    return jsonb_build_object('team_id', null, 'points', '[]'::jsonb);
  end if;

  -- One point per bucket, the LAST snapshot in it. Last rather than average
  -- because this is a running equity value, not a rate: the closing figure of
  -- a bucket is a real number the team actually had, an average is not.
  --
  -- ntile() spreads the buckets over the rows rather than over the clock, so
  -- a quiet overnight stretch does not consume the same resolution as an
  -- active session, and the newest point is always the newest snapshot.
  with ordered as (
    select ts, equity, cash, positions_value, total_return_pct,
           ntile(v_points) over (order by ts) as bucket
      from public.portfolio_snapshots
     where team_id = v_team_id
  ),
  picked as (
    select distinct on (bucket) bucket, ts, equity, cash, positions_value, total_return_pct
      from ordered
     order by bucket, ts desc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'ts', ts,
           'equity', equity,
           'cash', cash,
           'positions_value', positions_value,
           'total_return_pct', total_return_pct
         ) order by ts), '[]'::jsonb)
    into v_rows
    from picked;

  return jsonb_build_object('team_id', v_team_id, 'points', v_rows);
end;
$$;

revoke all on function public.get_equity_curve(uuid, integer) from public, anon;
grant execute on function public.get_equity_curve(uuid, integer) to authenticated;

comment on function public.get_equity_curve(uuid, integer) is
  'Equity curve for a team, bucketed to at most p_points so it spans the whole competition at a bounded size. Own team only, unless admin.';
