-- =====================================================================
-- XAVAGE STOCK SIM :: 0002 -- identity helpers, pricing, order entry
-- =====================================================================
-- Every state mutation funnels through these SECURITY DEFINER functions.
-- They take row locks in a fixed order (team -> position) so concurrent
-- traders on the same book serialise instead of corrupting each other,
-- while different teams proceed fully in parallel.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Identity helpers (private schema, never client-callable)
-- ---------------------------------------------------------------------
create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'admin'
      and p.is_active
  );
$$;

create or replace function private.current_team()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.team_id from public.profiles p
  where p.id = (select auth.uid()) and p.is_active;
$$;

create or replace function private.get_settings()
returns public.game_settings
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.game_settings where id;
$$;

revoke execute on function private.is_admin(), private.current_team(), private.get_settings()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Market hours. The worker stamps quotes.market_state from yfinance;
-- `market_hours_mode` lets an admin widen or force-open the session.
-- ---------------------------------------------------------------------
create or replace function private.market_is_open(p_state public.market_state, p_mode text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case p_mode
    when 'always_open' then true
    when 'extended'    then p_state in ('pre', 'regular', 'post')
    else                    p_state = 'regular'
  end;
$$;

-- ---------------------------------------------------------------------
-- Trade cost model
-- ---------------------------------------------------------------------
create or replace function private.commission_for(p_notional numeric, s public.game_settings)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select greatest(
    round(s.commission_per_trade + (p_notional * s.commission_bps / 10000.0), 4),
    s.min_commission
  );
$$;

-- Market/stop fills cross the spread; limit fills do not.
create or replace function private.apply_slippage(p_price numeric, p_side public.order_side, s public.game_settings)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select round(
    case when p_side = 'buy'
      then p_price * (1 + s.slippage_bps / 10000.0)
      else p_price * (1 - s.slippage_bps / 10000.0)
    end, 6);
$$;

-- ---------------------------------------------------------------------
-- Team risk metrics, marked to the live quote table.
--   equity          = cash + net position value (shorts are negative)
--   gross_exposure  = sum of |qty| * price -- what leverage is measured on
-- ---------------------------------------------------------------------
create or replace function private.team_metrics(p_team_id uuid)
returns table (
  cash numeric, reserved_cash numeric, positions_value numeric,
  gross_exposure numeric, equity numeric, buying_power numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s public.game_settings;
  v_cash numeric;
  v_reserved numeric;
  v_value numeric;
  v_gross numeric;
begin
  s := private.get_settings();

  select t.cash, t.reserved_cash into v_cash, v_reserved
  from public.teams t where t.id = p_team_id;

  if v_cash is null then
    raise exception 'team % not found', p_team_id using errcode = 'no_data_found';
  end if;

  select
    coalesce(sum(p.qty * q.price), 0),
    coalesce(sum(abs(p.qty) * q.price), 0)
  into v_value, v_gross
  from public.positions p
  join public.quotes q on q.symbol = p.symbol
  where p.team_id = p_team_id and p.qty <> 0;

  cash            := round(v_cash, 4);
  reserved_cash   := round(v_reserved, 4);
  positions_value := round(v_value, 4);
  gross_exposure  := round(v_gross, 4);
  equity          := round(v_cash + v_value, 4);
  -- headroom for NEW exposure, after leverage and cash already committed
  buying_power    := round(greatest(0, (equity * s.max_leverage) - v_gross - v_reserved), 4);
  return next;
end;
$$;

revoke execute on function private.team_metrics(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- private.apply_fill -- the single place a position/cash ever changes.
-- Caller MUST already hold the team row lock.
-- ---------------------------------------------------------------------
create or replace function private.apply_fill(
  p_order   public.orders,
  p_qty     numeric,
  p_price   numeric,
  p_settings public.game_settings
)
returns public.trades
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.game_settings := p_settings;
  v_pos          public.positions;
  v_old_qty      numeric;
  v_old_avg      numeric;
  v_signed       numeric;
  v_new_qty      numeric;
  v_new_avg      numeric;
  v_closing      numeric := 0;
  v_realized     numeric := 0;
  v_tax          numeric := 0;
  v_notional     numeric;
  v_commission   numeric;
  v_cash_delta   numeric;
  v_balance      numeric;
  v_trade        public.trades;
  v_release_cash numeric := 0;
  v_release_qty  numeric := 0;
  v_open_before  numeric;
begin
  v_notional   := round(p_qty * p_price, 4);
  v_commission := private.commission_for(v_notional, s);
  v_signed     := case when p_order.side = 'buy' then p_qty else -p_qty end;

  -- Lock the position row (team lock already held -> consistent order).
  select * into v_pos from public.positions
   where team_id = p_order.team_id and symbol = p_order.symbol
   for update;

  if not found then
    insert into public.positions (team_id, symbol, qty, avg_cost)
    values (p_order.team_id, p_order.symbol, 0, 0)
    on conflict (team_id, symbol) do nothing;

    select * into v_pos from public.positions
     where team_id = p_order.team_id and symbol = p_order.symbol
     for update;
  end if;

  v_old_qty := v_pos.qty;
  v_old_avg := v_pos.avg_cost;
  v_new_qty := round(v_old_qty + v_signed, 6);

  if v_old_qty = 0 or sign(v_old_qty) = sign(v_signed) then
    -- Opening or adding to exposure: weighted-average the cost basis.
    v_new_avg := round(
      ((abs(v_old_qty) * v_old_avg) + (abs(v_signed) * p_price)) / nullif(abs(v_new_qty), 0), 6);
    v_new_avg := coalesce(v_new_avg, p_price);
  else
    -- Reducing, closing, or flipping: realise P&L on the closed portion.
    v_closing  := least(abs(v_old_qty), abs(v_signed));
    v_realized := round(v_closing * (p_price - v_old_avg) * sign(v_old_qty), 4);

    if abs(v_signed) > abs(v_old_qty) then
      v_new_avg := p_price;                       -- flipped long <-> short
    elsif v_new_qty = 0 then
      v_new_avg := 0;
    else
      v_new_avg := v_old_avg;                     -- basis unchanged on a partial close
    end if;
  end if;

  -- Cash: buys pay out, sells (including short opens) bring cash in.
  v_cash_delta := case when p_order.side = 'buy' then -v_notional else v_notional end;

  if s.capital_gains_tax_pct > 0 and v_realized > 0 then
    v_tax := round(v_realized * s.capital_gains_tax_pct / 100.0, 4);
  end if;

  -- ---- release the proportional share of this order's reservations ----
  v_open_before := p_order.qty - p_order.filled_qty;
  if v_open_before > 0 then
    v_release_cash := round(p_order.reserved_cash * (p_qty / v_open_before), 4);
    v_release_qty  := round(p_order.reserved_qty  * (p_qty / v_open_before), 6);
  end if;

  update public.teams
     set cash          = round(cash + v_cash_delta - v_commission - v_tax, 4),
         reserved_cash = greatest(0, round(reserved_cash - v_release_cash, 4))
   where id = p_order.team_id
   returning cash into v_balance;

  update public.positions
     set qty          = v_new_qty,
         avg_cost     = v_new_avg,
         realized_pnl = round(realized_pnl + v_realized, 4),
         reserved_qty = greatest(0, round(reserved_qty - v_release_qty, 6))
   where team_id = p_order.team_id and symbol = p_order.symbol;

  -- ---- ledger: one entry per economic event, running balance kept exact ----
  insert into public.cash_ledger (team_id, entry_type, amount, balance_after, ref_id, note)
  values (
    p_order.team_id,
    (case when p_order.side = 'buy' then 'trade_buy' else 'trade_sell' end)::public.ledger_type,
    v_cash_delta,
    round(v_balance + v_commission + v_tax, 4),
    p_order.id,
    format('%s %s %s @ %s', p_order.side, p_qty, p_order.symbol, p_price)
  );

  if v_commission > 0 then
    insert into public.cash_ledger (team_id, entry_type, amount, balance_after, ref_id, note)
    values (p_order.team_id, 'commission', -v_commission, round(v_balance + v_tax, 4), p_order.id,
            format('Commission on %s', p_order.symbol));
  end if;

  if v_tax > 0 then
    insert into public.cash_ledger (team_id, entry_type, amount, balance_after, ref_id, note)
    values (p_order.team_id, 'tax', -v_tax, v_balance, p_order.id,
            format('Capital gains tax on realised %s', v_realized));
  end if;

  insert into public.trades (
    order_id, team_id, user_id, symbol, side, qty, price,
    gross_amount, commission, slippage_cost, net_cash_delta,
    realized_pnl, position_qty_after
  ) values (
    p_order.id, p_order.team_id, p_order.user_id, p_order.symbol, p_order.side, p_qty, p_price,
    v_notional, v_commission, 0, round(v_cash_delta - v_commission - v_tax, 4),
    round(v_realized - v_tax, 4), v_new_qty
  )
  returning * into v_trade;

  -- ---- roll the order forward ----
  update public.orders o
     set filled_qty     = round(o.filled_qty + p_qty, 6),
         avg_fill_price = round(
           ((coalesce(o.avg_fill_price, 0) * o.filled_qty) + (p_price * p_qty))
           / nullif(o.filled_qty + p_qty, 0), 6),
         reserved_cash  = greatest(0, round(o.reserved_cash - v_release_cash, 4)),
         reserved_qty   = greatest(0, round(o.reserved_qty - v_release_qty, 6)),
         status         = case when round(o.filled_qty + p_qty, 6) >= o.qty
                               then 'filled'::public.order_status
                               else 'partially_filled'::public.order_status end,
         filled_at      = case when round(o.filled_qty + p_qty, 6) >= o.qty then now() else o.filled_at end,
         closed_at      = case when round(o.filled_qty + p_qty, 6) >= o.qty then now() else o.closed_at end
   where o.id = p_order.id;

  return v_trade;
end;
$$;

revoke execute on function private.apply_fill(public.orders, numeric, numeric, public.game_settings)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- private.release_reservations -- unwind holds when an order dies
-- ---------------------------------------------------------------------
create or replace function private.release_reservations(p_order public.orders)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_order.reserved_cash > 0 then
    update public.teams
       set reserved_cash = greatest(0, round(reserved_cash - p_order.reserved_cash, 4))
     where id = p_order.team_id;
  end if;

  if p_order.reserved_qty > 0 then
    update public.positions
       set reserved_qty = greatest(0, round(reserved_qty - p_order.reserved_qty, 6))
     where team_id = p_order.team_id and symbol = p_order.symbol;
  end if;

  update public.orders set reserved_cash = 0, reserved_qty = 0 where id = p_order.id;
end;
$$;

revoke execute on function private.release_reservations(public.orders) from public, anon, authenticated;
