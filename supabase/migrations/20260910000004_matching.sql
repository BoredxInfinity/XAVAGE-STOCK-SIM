-- =====================================================================
-- XAVAGE STOCK SIM :: 0004 -- matching engine + scheduled jobs
-- =====================================================================

-- Re-check affordability at execution time: a queued market/stop order can
-- become unaffordable if the market gapped while it was resting.
create or replace function private.can_afford_fill(
  p_team_id uuid, p_symbol text, p_side public.order_side,
  p_qty numeric, p_price numeric, s public.game_settings
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_pos_qty  numeric;
  v_new_qty  numeric;
  v_signed   numeric;
  v_delta    numeric;
  v_cash     numeric;
  v_metrics  record;
  v_notional numeric := round(p_qty * p_price, 4);
begin
  select coalesce(qty, 0) into v_pos_qty
    from public.positions where team_id = p_team_id and symbol = p_symbol;
  v_pos_qty := coalesce(v_pos_qty, 0);

  v_signed  := case when p_side = 'buy' then p_qty else -p_qty end;
  v_new_qty := v_pos_qty + v_signed;
  v_delta   := round((abs(v_new_qty) - abs(v_pos_qty)) * p_price, 4);

  if v_delta <= 0 then
    return true;                                  -- reducing exposure is always allowed
  end if;

  select * into v_metrics from private.team_metrics(p_team_id);

  -- reserved cash for THIS order is still held, so add it back as available
  if v_delta > (v_metrics.buying_power + v_notional) then
    return false;
  end if;

  if p_side = 'buy' and not s.allow_margin then
    select cash into v_cash from public.teams where id = p_team_id;
    if (v_cash - v_notional - private.commission_for(v_notional, s)) < 0 then
      return false;
    end if;
  end if;

  return true;
end;
$$;

revoke execute on function private.can_afford_fill(uuid, text, public.order_side, numeric, numeric, public.game_settings)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- public.match_orders -- run after every price tick.
-- Service-role / admin only. Idempotent and safe to run concurrently:
-- a transaction-level advisory lock means a second caller returns
-- immediately rather than double-filling.
-- ---------------------------------------------------------------------
create or replace function public.match_orders(p_symbols text[] default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s          public.game_settings;
  r          record;
  v_order    public.orders;
  v_quote    numeric;
  v_state    public.market_state;
  v_exec     numeric;
  v_stop     numeric;
  v_open_qty numeric;
  v_filled   integer := 0;
  v_rejected integer := 0;
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
       and private.market_is_open(q.market_state, s.market_hours_mode)
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

    select price, market_state into v_quote, v_state from public.quotes where symbol = v_order.symbol;
    continue when v_quote is null;
    continue when not private.market_is_open(v_state, s.market_hours_mode);

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

    if not private.can_afford_fill(v_order.team_id, v_order.symbol, v_order.side, v_open_qty, v_exec, s) then
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

  return jsonb_build_object('ok', true, 'scanned', v_scanned, 'filled', v_filled, 'rejected', v_rejected);
end;
$$;

-- ---------------------------------------------------------------------
-- public.expire_day_orders -- called by the worker at the closing bell
-- ---------------------------------------------------------------------
create or replace function public.expire_day_orders()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.orders;
  n integer := 0;
begin
  for r in
    select * from public.orders
     where tif = 'day' and status in ('open', 'partially_filled')
     order by team_id
     for update
  loop
    perform private.release_reservations(r);
    update public.orders
       set status = 'expired', closed_at = now(),
           reject_reason = 'Day order expired at the close'
     where id = r.id;
    n := n + 1;
  end loop;

  return jsonb_build_object('ok', true, 'expired', n);
end;
$$;

-- ---------------------------------------------------------------------
-- public.accrue_daily_interest -- the economic levers, applied once a day.
--   * credit on idle cash        (cash_interest_apr)
--   * debit on margin borrowing  (margin_interest_apr)
--   * borrow fee on short book   (short_borrow_apr)
-- ---------------------------------------------------------------------
create or replace function public.accrue_daily_interest(p_force boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s        public.game_settings;
  v_last   date;
  v_today  date := (now() at time zone 'America/New_York')::date;
  r        record;
  v_amt    numeric;
  v_bal    numeric;
  v_shorts numeric;
  n        integer := 0;
begin
  if not pg_try_advisory_xact_lock(hashtext('xavage_accrual')) then
    return jsonb_build_object('ok', true, 'skipped', true, 'reason', 'accrual already running');
  end if;

  select last_accrual_date into v_last from public.system_state where id;
  if not p_force and v_last is not null and v_last >= v_today then
    return jsonb_build_object('ok', true, 'skipped', true, 'reason', 'already accrued today');
  end if;

  s := private.get_settings();

  for r in select id, cash from public.teams where is_active order by id for update loop
    v_bal := r.cash;

    -- interest on cash (credit if positive, margin charge if negative)
    if r.cash > 0 and s.cash_interest_apr <> 0 then
      v_amt := round(r.cash * s.cash_interest_apr / 100.0 / 365.0, 4);
      if v_amt <> 0 then
        v_bal := round(v_bal + v_amt, 4);
        update public.teams set cash = v_bal where id = r.id;
        insert into public.cash_ledger (team_id, entry_type, amount, balance_after, note)
        values (r.id, 'cash_interest', v_amt, v_bal,
                format('Daily interest @ %s%% APR', s.cash_interest_apr));
      end if;
    elsif r.cash < 0 and s.margin_interest_apr <> 0 then
      v_amt := round(abs(r.cash) * s.margin_interest_apr / 100.0 / 365.0, 4);
      if v_amt <> 0 then
        v_bal := round(v_bal - v_amt, 4);
        update public.teams set cash = v_bal where id = r.id;
        insert into public.cash_ledger (team_id, entry_type, amount, balance_after, note)
        values (r.id, 'margin_interest', -v_amt, v_bal,
                format('Daily margin interest @ %s%% APR', s.margin_interest_apr));
      end if;
    end if;

    -- borrow fee on the short book
    if s.short_borrow_apr <> 0 then
      select coalesce(sum(abs(p.qty) * q.price), 0) into v_shorts
        from public.positions p join public.quotes q on q.symbol = p.symbol
       where p.team_id = r.id and p.qty < 0;

      if v_shorts > 0 then
        v_amt := round(v_shorts * s.short_borrow_apr / 100.0 / 365.0, 4);
        if v_amt <> 0 then
          v_bal := round(v_bal - v_amt, 4);
          update public.teams set cash = v_bal where id = r.id;
          insert into public.cash_ledger (team_id, entry_type, amount, balance_after, note)
          values (r.id, 'borrow_fee', -v_amt, v_bal,
                  format('Short borrow fee @ %s%% APR', s.short_borrow_apr));
        end if;
      end if;
    end if;

    n := n + 1;
  end loop;

  update public.system_state set last_accrual_date = v_today where id;
  return jsonb_build_object('ok', true, 'teams', n, 'date', v_today);
end;
$$;

-- ---------------------------------------------------------------------
-- public.take_snapshots -- the equity curve behind rankings
-- ---------------------------------------------------------------------
create or replace function public.take_snapshots()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ts timestamptz := date_trunc('minute', now());
  n    integer;
begin
  insert into public.portfolio_snapshots
    (team_id, ts, cash, positions_value, equity, realized_pnl, unrealized_pnl, total_return_pct)
  select
    t.id,
    v_ts,
    round(t.cash, 4),
    round(coalesce(pv.value, 0), 4),
    round(t.cash + coalesce(pv.value, 0), 4),
    round(coalesce(pv.realized, 0), 4),
    round(coalesce(pv.unrealized, 0), 4),
    case when t.initial_capital > 0
      then round(((t.cash + coalesce(pv.value, 0)) - t.initial_capital) / t.initial_capital * 100, 6)
      else 0 end
  from public.teams t
  left join lateral (
    select sum(p.qty * q.price)                        as value,
           sum(p.realized_pnl)                         as realized,
           sum((q.price - p.avg_cost) * p.qty)         as unrealized
      from public.positions p
      join public.quotes q on q.symbol = p.symbol
     where p.team_id = t.id and p.qty <> 0
  ) pv on true
  where t.is_active
  on conflict (team_id, ts) do update
    set cash = excluded.cash,
        positions_value = excluded.positions_value,
        equity = excluded.equity,
        realized_pnl = excluded.realized_pnl,
        unrealized_pnl = excluded.unrealized_pnl,
        total_return_pct = excluded.total_return_pct;

  get diagnostics n = row_count;
  update public.system_state set last_snapshot_at = now() where id;
  return jsonb_build_object('ok', true, 'snapshots', n, 'ts', v_ts);
end;
$$;
