-- Execution fairness: what a fill costs, and when a fill may happen at all.
--
-- Two edges the audit found that a sharp participant would discover within a
-- day, plus the cash floor that let a full-balance buy land negative.

-- --------------------------------------------------------- executable_price
create or replace function private.executable_price(
  p_type public.order_type, p_side public.order_side, p_limit numeric,
  p_stop numeric, p_quote numeric, s public.game_settings
) returns numeric language sql immutable set search_path = '' as $$
  select case
    when p_type = 'market' then private.apply_slippage(p_quote, p_side, s)

    -- A marketable limit pays the spread a market order pays, then is clamped
    -- so it still never fills worse than its own limit.
    --
    -- It used to fill AT the quote with no slippage at all, which made a
    -- marketable limit strictly dominate the market button: identical
    -- certainty, ~3bp cheaper each way, ~6bp per round trip, forever, to
    -- whoever noticed first. stop_limit inherited the same edge, because on
    -- trigger it is rewritten to a plain limit and priced through this branch.
    when p_type = 'limit' and p_side = 'buy'  and p_quote <= p_limit
      then least(private.apply_slippage(p_quote, 'buy', s), p_limit)
    when p_type = 'limit' and p_side = 'sell' and p_quote >= p_limit
      then greatest(private.apply_slippage(p_quote, 'sell', s), p_limit)

    -- A triggered stop becomes a market order and pays the spread.
    when p_type = 'stop'  and p_side = 'buy'  and p_quote >= p_stop
      then private.apply_slippage(p_quote, p_side, s)
    when p_type = 'stop'  and p_side = 'sell' and p_quote <= p_stop
      then private.apply_slippage(p_quote, p_side, s)

    else null
  end;
$$;

revoke execute on function private.executable_price(
  public.order_type, public.order_side, numeric, numeric, numeric, public.game_settings)
  from public, anon, authenticated;


-- --------------------------------------------- game_settings: sane ranges
-- admin_update_settings does jsonb_populate_record and writes straight
-- through, so nothing stood between a mistyped decimal and the economy. A
-- negative commission_bps or slippage_bps does not just discount a trade, it
-- PAYS the team to trade and fills better than the market.
alter table public.game_settings
  drop constraint if exists game_settings_economics_sane;
alter table public.game_settings
  add constraint game_settings_economics_sane check (
    commission_per_trade       >= 0
    and commission_bps         >= 0 and commission_bps         <= 1000
    and min_commission         >= 0
    and slippage_bps           >= 0 and slippage_bps           <= 1000
    and starting_capital       >  0
    and capital_gains_tax_pct  >= 0 and capital_gains_tax_pct  <= 100
    and maintenance_margin_pct >= 0 and maintenance_margin_pct <= 100
    and max_position_pct_of_equity > 0 and max_position_pct_of_equity <= 100
    and min_order_notional     >= 0
    and (max_order_notional is null or max_order_notional > 0)
    and cash_interest_apr   between -100 and 100
    and margin_interest_apr between    0 and 100
    and short_borrow_apr    between    0 and 100
    and (competition_start_at is null or competition_end_at is null
         or competition_end_at > competition_start_at)
  );


-- ----------------------------------------------------------- get_market_status
-- is_open now answers "can I trade right now", which is what every caller of
-- it actually means -- the order ticket, the market bar, the halt chip.
create or replace function public.get_market_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  s       public.game_settings;
  v_state public.market_state;
  v_last  timestamptz;
  v_tick  timestamptz;
begin
  s := private.get_settings();

  select market_state, max(quote_time) into v_state, v_last
    from public.quotes group by market_state order by max(quote_time) desc limit 1;

  select last_tick_at into v_tick from public.system_state where id;

  return jsonb_build_object(
    'ok', true,
    'market_state', coalesce(v_state, 'closed'),
    'is_open', private.fills_allowed(coalesce(v_state, 'closed'), s.worker_mode_override),
    'worker_mode', private.session_mode(coalesce(v_state, 'closed'), s.worker_mode_override),
    'worker_mode_override', s.worker_mode_override,
    'worker_mode_locked', coalesce(v_state, 'closed') = 'regular',
    'trading_enabled', s.trading_enabled,
    'halt_reason', s.halt_reason,
    'last_quote_at', v_last,
    'last_tick_at', v_tick,
    'price_staleness_seconds', s.price_staleness_seconds,
    'competition_start_at', s.competition_start_at,
    'competition_end_at', s.competition_end_at,
    'settings', jsonb_build_object(
      'allow_shorting', s.allow_shorting,
      'allow_margin', s.allow_margin,
      'allow_fractional_shares', s.allow_fractional_shares,
      'max_leverage', s.max_leverage,
      'commission_per_trade', s.commission_per_trade,
      'commission_bps', s.commission_bps,
      'min_commission', s.min_commission,
      'slippage_bps', s.slippage_bps,
      'cash_interest_apr', s.cash_interest_apr,
      'margin_interest_apr', s.margin_interest_apr,
      'short_borrow_apr', s.short_borrow_apr,
      'capital_gains_tax_pct', s.capital_gains_tax_pct,
      'max_position_pct_of_equity', s.max_position_pct_of_equity,
      'max_order_notional', s.max_order_notional,
      'min_order_notional', s.min_order_notional,
      'leaderboard_visible_to_participants', s.leaderboard_visible_to_participants
    )
  );
end;
$$;


-- ------------------------------------------------------------- place_order
-- Three changes, all marked inline:
--   * the idempotency check now runs AFTER the team lock, so two concurrent
--     submits of the same client_order_id serialise instead of racing;
--   * fills are gated on fills_allowed, so an out-of-hours order rests;
--   * the no-margin cash floor is priced at what the fill will actually cost.
create or replace function public.place_order(
  p_symbol text, p_side text, p_order_type text, p_qty numeric,
  p_limit_price numeric default null, p_stop_price numeric default null,
  p_trail_percent numeric default null, p_trail_amount numeric default null,
  p_tif text default 'day', p_client_order_id text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s            public.game_settings;
  v_uid        uuid := (select auth.uid());
  v_profile    public.profiles;
  v_team       public.teams;
  v_inst       public.instruments;
  v_quote      public.quotes;
  v_symbol     text := upper(btrim(p_symbol));
  v_side       public.order_side;
  v_type       public.order_type;
  v_tif        public.time_in_force;
  v_qty        numeric;
  v_existing   public.orders;
  v_order      public.orders;
  v_open       boolean;
  v_ref        numeric;
  v_pos_qty    numeric := 0;
  v_pos_avail  numeric := 0;
  v_new_qty    numeric;
  v_signed     numeric;
  v_exp_delta  numeric;
  v_notional   numeric;
  v_worst      numeric;
  v_commission numeric;
  v_metrics    record;
  v_exec_price numeric;
  v_long_part  numeric;
  v_short_part numeric;
  v_res_cash   numeric := 0;
  v_res_qty    numeric := 0;
  v_status     public.order_status;
  v_trade      public.trades;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  select * into v_profile from public.profiles where id = v_uid;
  if not found or not v_profile.is_active then
    raise exception 'Your account is inactive. Contact an administrator.' using errcode = '28000';
  end if;
  if v_profile.team_id is null then
    raise exception 'You are not assigned to a team yet.' using errcode = 'P0001';
  end if;

  s := private.get_settings();

  if not s.trading_enabled then
    raise exception 'Trading is halted: %', coalesce(s.halt_reason, 'by the organisers') using errcode = 'P0001';
  end if;
  if s.competition_start_at is not null and now() < s.competition_start_at then
    raise exception 'The competition has not started yet.' using errcode = 'P0001';
  end if;
  if s.competition_end_at is not null and now() > s.competition_end_at then
    raise exception 'The competition has ended.' using errcode = 'P0001';
  end if;

  -- ---- enum validation with friendly errors ----
  if p_side not in ('buy', 'sell') then
    raise exception 'Invalid side "%"', p_side using errcode = '22023';
  end if;
  if p_order_type not in ('market', 'limit', 'stop', 'stop_limit', 'trailing_stop') then
    raise exception 'Invalid order type "%"', p_order_type using errcode = '22023';
  end if;
  if p_tif not in ('day', 'gtc', 'ioc', 'fok') then
    raise exception 'Invalid time-in-force "%"', p_tif using errcode = '22023';
  end if;
  v_side := p_side::public.order_side;
  v_type := p_order_type::public.order_type;
  v_tif  := p_tif::public.time_in_force;

  -- ---- instrument + quote ----
  select * into v_inst from public.instruments where symbol = v_symbol;
  if not found then
    raise exception 'Unknown symbol "%"', v_symbol using errcode = 'P0001';
  end if;
  if not v_inst.is_tradable then
    raise exception '% is not tradable in this competition.', v_symbol using errcode = 'P0001';
  end if;
  if v_inst.is_halted then
    raise exception '% is halted: %', v_symbol, coalesce(v_inst.halt_reason, 'by the organisers') using errcode = 'P0001';
  end if;

  select * into v_quote from public.quotes where symbol = v_symbol;
  if not found or v_quote.price is null or v_quote.price <= 0 then
    raise exception 'No live price available for % yet.', v_symbol using errcode = 'P0001';
  end if;
  v_ref  := v_quote.price;
  -- Not market_is_open: fills happen in the regular session only, so an order
  -- entered pre-market rests and prints at the open rather than executing
  -- against a price that is still yesterday's close.
  v_open := private.fills_allowed(v_quote.market_state, s.worker_mode_override);

  -- Staleness only means anything while the book is live. A closed market has
  -- no fresh price by definition -- the worker idles rather than asking Yahoo
  -- for Friday's close every two minutes -- and an order placed then does not
  -- execute against this quote anyway: it queues for the next session and
  -- fills at the price that session prints.
  if v_open and now() - v_quote.quote_time > make_interval(secs => s.price_staleness_seconds) then
    raise exception 'Price data for % is stale. Try again shortly.', v_symbol using errcode = 'P0001';
  end if;

  -- ---- quantity ----
  v_qty := round(p_qty, 6);
  -- `not (v_qty > 0)` rather than `v_qty <= 0`: NaN fails every comparison, so
  -- the old form let it through to be caught only incidentally downstream.
  if v_qty is null or not (v_qty > 0) then
    raise exception 'Quantity must be greater than zero.' using errcode = '22023';
  end if;
  if not s.allow_fractional_shares and v_qty <> trunc(v_qty) then
    raise exception 'Fractional shares are disabled. Enter a whole number of shares.' using errcode = '22023';
  end if;

  -- ---- price sanity: reject fat-finger prices far away from the market ----
  if v_type in ('limit', 'stop_limit') and (p_limit_price is null or not (p_limit_price > 0)) then
    raise exception 'A limit price is required for % orders.', p_order_type using errcode = '22023';
  end if;
  if v_type in ('stop', 'stop_limit') and (p_stop_price is null or not (p_stop_price > 0)) then
    raise exception 'A stop price is required for % orders.', p_order_type using errcode = '22023';
  end if;
  if v_type = 'trailing_stop' then
    if coalesce(p_trail_percent, 0) <= 0 and coalesce(p_trail_amount, 0) <= 0 then
      raise exception 'A trailing stop needs a trail percent or amount.' using errcode = '22023';
    end if;
    if p_trail_percent is not null and (p_trail_percent <= 0 or p_trail_percent >= 100) then
      raise exception 'Trail percent must be between 0 and 100.' using errcode = '22023';
    end if;
  end if;

  -- A stop must sit on the correct side of the market, or it is just a market order.
  if v_type in ('stop', 'stop_limit') then
    if v_side = 'buy' and p_stop_price <= v_ref then
      raise exception 'A buy stop must be above the current price (%).', v_ref using errcode = '22023';
    end if;
    if v_side = 'sell' and p_stop_price >= v_ref then
      raise exception 'A sell stop must be below the current price (%).', v_ref using errcode = '22023';
    end if;
  end if;

  -- ---- lock the team book (first lock -- fixed ordering prevents deadlock) ----
  select * into v_team from public.teams where id = v_profile.team_id for update;
  if not found or not v_team.is_active then
    raise exception 'Your team is not active.' using errcode = 'P0001';
  end if;
  if v_team.is_frozen then
    raise exception 'Your team account is frozen. Contact an administrator.' using errcode = 'P0001';
  end if;

  -- ---- idempotency: a retried submit returns the original order ----
  -- Deliberately AFTER the team lock. It used to run before any lock, so two
  -- submits of the same client_order_id -- a double-click, or a client retrying
  -- a request whose response was lost -- could both miss and the loser would
  -- surface a raw 23505 instead of the friendly duplicate. Behind the lock the
  -- second submit waits for the first to commit and then sees its row.
  if p_client_order_id is not null then
    select * into v_existing from public.orders
     where team_id = v_team.id and client_order_id = p_client_order_id;
    if found then
      return jsonb_build_object('ok', true, 'duplicate', true,
                                'order', to_jsonb(v_existing),
                                'message', 'Order already submitted.');
    end if;
  end if;

  select qty, greatest(0, qty - reserved_qty) into v_pos_qty, v_pos_avail
    from public.positions where team_id = v_team.id and symbol = v_symbol;
  v_pos_qty   := coalesce(v_pos_qty, 0);
  v_pos_avail := coalesce(v_pos_avail, 0);

  v_signed  := case when v_side = 'buy' then v_qty else -v_qty end;
  v_new_qty := v_pos_qty + v_signed;

  -- Value the order at the price it would realistically transact at.
  v_notional   := round(v_qty * coalesce(
                    case when v_type in ('limit', 'stop_limit') then p_limit_price
                         when v_type in ('stop') then p_stop_price end,
                    v_ref), 4);
  v_commission := private.commission_for(v_notional, s);

  -- ---- notional limits ----
  if s.min_order_notional > 0 and v_notional < s.min_order_notional then
    raise exception 'Order value % is below the minimum of %.', v_notional, s.min_order_notional using errcode = 'P0001';
  end if;
  if s.max_order_notional is not null and v_notional > s.max_order_notional then
    raise exception 'Order value % exceeds the per-order maximum of %.', v_notional, s.max_order_notional using errcode = 'P0001';
  end if;

  -- ---- shorting ----
  if v_new_qty < 0 and not s.allow_shorting then
    raise exception 'Short selling is disabled. You hold % share(s) of %.', v_pos_avail, v_symbol using errcode = 'P0001';
  end if;
  if v_side = 'sell' and not s.allow_shorting and v_qty > v_pos_avail then
    raise exception 'You only have % share(s) of % available to sell (the rest are committed to resting orders).',
      v_pos_avail, v_symbol using errcode = 'P0001';
  end if;

  select * into v_metrics from private.team_metrics(v_team.id);

  -- ---- buying power: only NEW exposure consumes it ----
  v_exp_delta := round((abs(v_new_qty) - abs(v_pos_qty)) * v_ref, 4);
  if v_exp_delta > 0 and (v_exp_delta + v_commission) > v_metrics.buying_power then
    raise exception 'Insufficient buying power. This order needs % but only % is available.',
      round(v_exp_delta + v_commission, 2), round(v_metrics.buying_power, 2) using errcode = 'P0001';
  end if;

  -- ---- hard cash floor when margin is off ----
  -- Priced at what the fill will ACTUALLY cost. v_notional comes off the raw
  -- quote, but a market order fills through apply_slippage(), so checking
  -- against v_notional let a team spend its entire balance and land a few
  -- basis points negative -- and negative cash then quietly starts accruing
  -- margin_interest_apr, in a game whose settings say margin is off.
  if v_side = 'buy' and not s.allow_margin then
    v_worst := round(v_qty * case
        when v_type in ('limit', 'stop_limit') then p_limit_price
        when v_type = 'stop'                   then private.apply_slippage(p_stop_price, v_side, s)
        else                                        private.apply_slippage(v_ref, v_side, s)
      end, 4);
    if (v_team.cash - v_team.reserved_cash - v_worst - private.commission_for(v_worst, s)) < 0 then
      raise exception 'Insufficient cash. Order costs % but % is uncommitted.',
        round(v_worst + private.commission_for(v_worst, s), 2),
        round(v_team.cash - v_team.reserved_cash, 2) using errcode = 'P0001';
    end if;
  else
    v_worst := v_notional;
  end if;

  -- ---- concentration limit ----
  if s.max_position_pct_of_equity < 100 and v_metrics.equity > 0 then
    if (abs(v_new_qty) * v_ref) > (v_metrics.equity * s.max_position_pct_of_equity / 100.0) then
      -- RAISE only understands plain %, not printf specifiers -- format the numbers first.
      raise exception 'That would put % of your book in a single name; the limit is %.',
        round((abs(v_new_qty) * v_ref) / v_metrics.equity * 100.0, 2)::text || '%',
        round(s.max_position_pct_of_equity, 2)::text || '%' using errcode = 'P0001';
    end if;
  end if;

  -- ---- can it execute right now? ----
  v_exec_price := null;
  if v_open then
    if v_type = 'stop_limit' then
      v_exec_price := null;      -- untriggered at entry
    elsif v_type = 'trailing_stop' then
      v_exec_price := null;
    else
      v_exec_price := private.executable_price(v_type, v_side, p_limit_price, p_stop_price, v_ref, s);
    end if;
  end if;

  -- ---- immediate-or-cancel / fill-or-kill cannot rest ----
  if v_exec_price is null and v_tif in ('ioc', 'fok') then
    insert into public.orders (
      team_id, user_id, symbol, side, order_type, qty, limit_price, stop_price,
      trail_percent, trail_amount, tif, status, reject_reason, client_order_id, closed_at
    ) values (
      v_team.id, v_uid, v_symbol, v_side, v_type, v_qty, p_limit_price, p_stop_price,
      p_trail_percent, p_trail_amount, v_tif, 'cancelled',
      case when v_open then 'Not immediately executable' else 'Market closed' end,
      p_client_order_id, now()
    ) returning * into v_order;

    return jsonb_build_object('ok', true, 'executed', false, 'order', to_jsonb(v_order),
      'message', format('%s order cancelled: not immediately executable.', upper(p_tif)));
  end if;

  -- ---- reservations for an order that will rest ----
  if v_exec_price is null then
    if v_side = 'buy' then
      -- Hold cash at the worst realistic price so buying power can't be
      -- double-spent. The 2% cushion on a market order covers the overnight
      -- gap between queueing and the opening print.
      v_res_cash := round(greatest(v_worst, v_notional) * (case when v_type = 'market' then 1.02 else 1.0 end)
                          + v_commission, 4);
    else
      v_long_part  := least(v_qty, v_pos_avail);
      v_short_part := v_qty - v_long_part;
      v_res_qty    := v_long_part;
      if v_short_part > 0 then
        v_res_cash := round(v_short_part * v_ref / greatest(s.max_leverage, 1), 4);
      end if;
    end if;
  end if;

  v_status := (case when v_exec_price is null then 'open' else 'pending' end)::public.order_status;

  insert into public.orders (
    team_id, user_id, symbol, side, order_type, qty, limit_price, stop_price,
    trail_percent, trail_amount, trail_reference, tif, status,
    reserved_cash, reserved_qty, client_order_id
  ) values (
    v_team.id, v_uid, v_symbol, v_side, v_type, v_qty, p_limit_price, p_stop_price,
    p_trail_percent, p_trail_amount,
    case when v_type = 'trailing_stop' then v_ref end,
    v_tif, v_status, v_res_cash, v_res_qty, p_client_order_id
  ) returning * into v_order;

  if v_res_cash > 0 then
    update public.teams set reserved_cash = round(reserved_cash + v_res_cash, 4) where id = v_team.id;
  end if;
  if v_res_qty > 0 then
    insert into public.positions (team_id, symbol, qty, avg_cost, reserved_qty)
    values (v_team.id, v_symbol, 0, 0, v_res_qty)
    on conflict (team_id, symbol)
      do update set reserved_qty = round(public.positions.reserved_qty + v_res_qty, 6);
  end if;

  -- ---- execute now if marketable ----
  if v_exec_price is not null then
    v_trade := private.apply_fill(v_order, v_qty, v_exec_price, s);
    select * into v_order from public.orders where id = v_order.id;

    return jsonb_build_object('ok', true, 'executed', true,
      'order', to_jsonb(v_order), 'trade', to_jsonb(v_trade),
      'message', format('Filled %s %s @ %s', v_qty, v_symbol, round(v_exec_price, 2)));
  end if;

  return jsonb_build_object('ok', true, 'executed', false, 'order', to_jsonb(v_order),
    'message', case when v_open then 'Order working.'
                    else 'Market is closed - order queued for the next session.' end);
end;
$$;

revoke execute on function public.place_order(
  text, text, text, numeric, numeric, numeric, numeric, numeric, text, text) from public, anon;
grant execute on function public.place_order(
  text, text, text, numeric, numeric, numeric, numeric, numeric, text, text) to authenticated;
