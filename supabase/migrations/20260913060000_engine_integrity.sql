-- Engine integrity: lock ordering, staleness, and the cash floor.
--
-- Three defects found in the pre-event audit, all of which only show up under
-- the conditions of a live event (concurrency, a dead feed, a team trading its
-- whole balance) and so survived manual testing.

-- ---------------------------------------------------------------- staleness
-- price_staleness_seconds was sitting at 1000000000 on the live project -- ~31
-- years, i.e. the guard could never fire. A bound stops that recurring, in
-- either direction: 0 would make make_interval(secs => 0) mark every quote
-- stale and brick all trading, which is the same outage from the other side.
update public.game_settings
   set price_staleness_seconds = 60
 where price_staleness_seconds is null
    or price_staleness_seconds < 5
    or price_staleness_seconds > 3600;

alter table public.game_settings
  drop constraint if exists game_settings_staleness_sane;
alter table public.game_settings
  add constraint game_settings_staleness_sane
  check (price_staleness_seconds between 5 and 3600);


-- ------------------------------------------------- can_afford_fill, corrected
-- Two bugs. It compared against raw `cash` rather than uncommitted cash, so a
-- team with resting orders elsewhere could overdraw; and it had no way to add
-- back the reservation held by the very order being filled, so simply
-- switching to (cash - reserved_cash) would have double-counted. Taking the
-- order row solves both and matches private.apply_fill's shape.
drop function if exists private.can_afford_fill(uuid, text, public.order_side, numeric, numeric, public.game_settings);

create or replace function private.can_afford_fill(
  p_order public.orders, p_qty numeric, p_price numeric, s public.game_settings
) returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_pos_qty   numeric;
  v_new_qty   numeric;
  v_delta     numeric;
  v_team      public.teams;
  v_metrics   record;
  v_available numeric;
  v_notional  numeric := round(p_qty * p_price, 4);
begin
  select coalesce(qty, 0) into v_pos_qty
    from public.positions where team_id = p_order.team_id and symbol = p_order.symbol;
  v_pos_qty := coalesce(v_pos_qty, 0);

  v_new_qty := v_pos_qty + case when p_order.side = 'buy' then p_qty else -p_qty end;
  v_delta   := round((abs(v_new_qty) - abs(v_pos_qty)) * p_price, 4);

  if v_delta <= 0 then
    return true;                                  -- reducing exposure is always allowed
  end if;

  select * into v_metrics from private.team_metrics(p_order.team_id);

  -- reserved cash for THIS order is still held, so add it back as available
  if v_delta > (v_metrics.buying_power + v_notional) then
    return false;
  end if;

  if p_order.side = 'buy' and not s.allow_margin then
    select * into v_team from public.teams where id = p_order.team_id;
    -- Uncommitted cash, plus back whatever this order itself is holding.
    v_available := v_team.cash - v_team.reserved_cash + coalesce(p_order.reserved_cash, 0);
    if (v_available - v_notional - private.commission_for(v_notional, s)) < 0 then
      return false;
    end if;
  end if;

  return true;
end;
$$;

revoke execute on function private.can_afford_fill(public.orders, numeric, numeric, public.game_settings)
  from public, anon, authenticated;


-- ------------------------------------------------------------ fills_allowed
-- session_mode drives the WORKER's cadence, where 'pre'/'post' -> 'regular' is
-- right: there is data worth polling out of hours. It was also, via
-- market_is_open, deciding whether the BOOK clears trades -- and those are not
-- the same question.
--
-- Because pre-market opened the book at 04:00 ET against a price that is still
-- yesterday's close until the first real print, a participant could read
-- overnight news, queue a market order, and have it fill at the prior close.
-- place_order's staleness check cannot see this: the quote_time is fresh, it
-- is the *price* that is stale.
--
-- So fills are now the regular session only. An organiser can still open the
-- book out of hours deliberately via worker_mode_override, for a demo or a
-- make-up session.
create or replace function private.fills_allowed(p_state public.market_state, p_override text)
returns boolean language sql immutable set search_path = '' as $$
  select case
    when p_state = 'regular'                then true   -- the real session
    when p_override in ('regular', 'live')  then true   -- organiser-run session
    else                                         false
  end;
$$;

revoke execute on function private.fills_allowed(public.market_state, text)
  from public, anon, authenticated;


-- ------------------------------------------------ match_orders: stale quotes
-- place_order refuses to trade a quote older than price_staleness_seconds;
-- match_orders never checked. Nothing resets market_state when the worker
-- dies -- stamp_closed() only runs on the worker's own idle transition -- so a
-- feed outage mid-session left the book "open" and every resting stop and
-- limit kept filling against a frozen price for as long as the outage lasted.
create or replace function public.match_orders(p_symbols text[] default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s          public.game_settings;
  r          record;
  v_order    public.orders;
  v_quote    numeric;
  v_state    public.market_state;
  v_qtime    timestamptz;
  v_exec     numeric;
  v_stop     numeric;
  v_open_qty numeric;
  v_filled   integer := 0;
  v_rejected integer := 0;
  v_stale    integer := 0;
  v_scanned  integer := 0;
begin
  if not pg_try_advisory_xact_lock(hashtext('xavage_match_orders')) then
    return jsonb_build_object('ok', true, 'skipped', true, 'reason', 'another matching pass is running');
  end if;

  s := private.get_settings();
  if not s.trading_enabled then
    return jsonb_build_object('ok', true, 'skipped', true, 'reason', 'trading halted');
  end if;

  -- Ratchet every trailing stop against the new price in one bulk statement.
  update public.orders o
     set trail_reference = case
           when o.side = 'sell' then greatest(coalesce(o.trail_reference, q.price), q.price)
           else                      least(coalesce(o.trail_reference, q.price), q.price)
         end
    from public.quotes q
   where q.symbol = o.symbol
     and o.order_type = 'trailing_stop'
     and o.status in ('open', 'partially_filled')
     and (p_symbols is null or o.symbol = any (p_symbols));

  -- FIFO across the book; team_id in the sort keeps lock acquisition ordered.
  for r in
    select o.id
      from public.orders o
      join public.quotes q on q.symbol = o.symbol
      join public.instruments i on i.symbol = o.symbol
     where o.status in ('open', 'partially_filled')
       and (p_symbols is null or o.symbol = any (p_symbols))
       and i.is_tradable and not i.is_halted
       and private.fills_allowed(q.market_state, s.worker_mode_override)
     order by o.team_id, o.created_at
  loop
    v_scanned := v_scanned + 1;

    -- Lock the team book first, then the order: same order as place_order.
    select * into v_order from public.orders where id = r.id;
    continue when not found;
    perform 1 from public.teams where id = v_order.team_id and is_active and not is_frozen for update;
    continue when not found;

    select * into v_order from public.orders where id = r.id for update skip locked;
    continue when not found or v_order.status not in ('open', 'partially_filled');

    select price, market_state, quote_time into v_quote, v_state, v_qtime
      from public.quotes where symbol = v_order.symbol;
    continue when v_quote is null;
    continue when not private.fills_allowed(v_state, s.worker_mode_override);

    -- The guard place_order has always had, applied where fills actually happen.
    if v_qtime is null
       or now() - v_qtime > make_interval(secs => s.price_staleness_seconds) then
      v_stale := v_stale + 1;
      continue;
    end if;

    -- Trailing stop -> resolve the moving trigger level for this tick.
    if v_order.order_type = 'trailing_stop' then
      v_stop := case
        when v_order.side = 'sell' then
          coalesce(v_order.trail_reference - v_order.trail_amount,
                   v_order.trail_reference * (1 - v_order.trail_percent / 100.0))
        else
          coalesce(v_order.trail_reference + v_order.trail_amount,
                   v_order.trail_reference * (1 + v_order.trail_percent / 100.0))
      end;

      if (v_order.side = 'sell' and v_quote <= v_stop)
      or (v_order.side = 'buy'  and v_quote >= v_stop) then
        v_exec := private.apply_slippage(v_quote, v_order.side, s);
      else
        v_exec := null;
      end if;

    -- Stop-limit -> on trigger it becomes a plain limit order and rests.
    elsif v_order.order_type = 'stop_limit' then
      if (v_order.side = 'buy'  and v_quote >= v_order.stop_price)
      or (v_order.side = 'sell' and v_quote <= v_order.stop_price) then
        update public.orders set order_type = 'limit', stop_price = null where id = v_order.id;
        select * into v_order from public.orders where id = v_order.id;
        v_exec := private.executable_price('limit', v_order.side, v_order.limit_price, null, v_quote, s);
      else
        v_exec := null;
      end if;

    else
      v_exec := private.executable_price(v_order.order_type, v_order.side,
                                         v_order.limit_price, v_order.stop_price, v_quote, s);
    end if;

    continue when v_exec is null;

    v_open_qty := round(v_order.qty - v_order.filled_qty, 6);
    continue when v_open_qty <= 0;

    if not private.can_afford_fill(v_order, v_open_qty, v_exec, s) then
      perform private.release_reservations(v_order);
      update public.orders
         set status = 'rejected', closed_at = now(),
             reject_reason = 'Insufficient buying power at execution time'
       where id = v_order.id;
      v_rejected := v_rejected + 1;
      continue;
    end if;

    perform private.apply_fill(v_order, v_open_qty, v_exec, s);
    v_filled := v_filled + 1;
  end loop;

  update public.system_state
     set last_tick_at = now(), tick_count = tick_count + 1
   where id;

  return jsonb_build_object('ok', true, 'scanned', v_scanned, 'filled', v_filled,
                            'rejected', v_rejected, 'stale', v_stale);
end;
$$;

revoke execute on function public.match_orders(text[]) from public, anon;
grant execute on function public.match_orders(text[]) to service_role;


-- ------------------------------------------- expire_day_orders: lock ordering
-- This locked orders first and only then reached teams (via
-- release_reservations). Every other writer -- place_order, match_orders,
-- cancel_order, admin_liquidate_team -- goes teams then orders. A textbook
-- ABBA deadlock, and it fired where it hurts: the worker runs match_orders
-- every 5s while daily_jobs calls this on the close transition. Postgres kills
-- one side, and whichever loses leaves settlement half-done with reservations
-- stranded.
--
-- Now teams-first, one team's orders at a time, behind the same advisory lock
-- that match_orders and accrue_daily_interest already use.
create or replace function public.expire_day_orders()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  t record;
  r public.orders;
  n integer := 0;
begin
  if not pg_try_advisory_xact_lock(hashtext('xavage_expire_day_orders')) then
    return jsonb_build_object('ok', true, 'skipped', true, 'reason', 'expiry already running');
  end if;

  for t in
    select id from public.teams
     where exists (
       select 1 from public.orders o
        where o.team_id = teams.id
          and o.tif = 'day'
          and o.status in ('open', 'partially_filled')
     )
     order by id
     for update
  loop
    for r in
      select * from public.orders
       where team_id = t.id
         and tif = 'day'
         and status in ('open', 'partially_filled')
       order by created_at
       for update
    loop
      perform private.release_reservations(r);
      update public.orders
         set status = 'expired', closed_at = now(),
             reject_reason = 'Day order expired at the close'
       where id = r.id;
      n := n + 1;
    end loop;
  end loop;

  return jsonb_build_object('ok', true, 'expired', n);
end;
$$;

revoke execute on function public.expire_day_orders() from public, anon;
grant execute on function public.expire_day_orders() to service_role;


-- ------------------------------------------------- stamp_quote_written_at
-- The one function in the schema without a pinned search_path, and it is
-- executable by authenticated and anon. SECURITY INVOKER so it is not an
-- escalation, but there is no reason for it to be the exception.
create or replace function private.stamp_quote_written_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
