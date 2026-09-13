-- =====================================================================
-- XAVAGE STOCK SIM :: the equity curve carries only what is drawn
-- =====================================================================
-- 20260913030000 bucketed the curve but still returned five fields per
-- point -- 141 bytes a point, 34 KB a call. Both charts that consume it
-- render `{ ts, equity }` and nothing else, so four fifths of that was paid
-- for on every poll by every open tab and then discarded in the browser.
--
-- Equity is rounded to the cent on the way out: the column is numeric(20,4)
-- and serialises as "100000.0000", which is four characters a point spent on
-- precision no chart can draw and no participant is owed.
--
-- Anything that later wants cash or the return percentage on this series
-- should add them back deliberately, and know what it is spending.
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

  with ordered as (
    select ts, equity, ntile(v_points) over (order by ts) as bucket
      from public.portfolio_snapshots
     where team_id = v_team_id
  ),
  picked as (
    select distinct on (bucket) bucket, ts, equity
      from ordered
     order by bucket, ts desc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'ts', ts,
           'equity', round(equity, 2)
         ) order by ts), '[]'::jsonb)
    into v_rows
    from picked;

  return jsonb_build_object('team_id', v_team_id, 'points', v_rows);
end;
$$;

comment on function public.get_equity_curve(uuid, integer) is
  'Equity curve for a team as { ts, equity } points, bucketed to at most p_points so it spans the whole competition at a bounded size. Own team only, unless admin.';
