-- =====================================================================
-- XAVAGE STOCK SIM :: one session rule, three worker modes
-- =====================================================================
-- `market_hours_mode` asked the organiser a question they should not have had
-- to answer: whether the game's session is 'regular', 'extended' or
-- 'always_open'. It sat next to a status chip that reported the *exchange's*
-- session, so the two could disagree -- a chip reading "Market closed" beside
-- a book that was happily filling orders, because the mode said always_open.
--
-- The exchange's clock is not a matter of opinion. It decides the session, and
-- everything else follows from it:
--
--     exchange       chip              worker
--     regular        open    (green)   live     -- 5s, the whole pipeline
--     pre / post     yellow            regular  -- slow poll; thin but real
--     closed         closed  (red)     idle     -- no feed requests at all
--
-- What remains is a *testing* lever, `worker_mode_override`: outside regular
-- hours an organiser can force idle/regular/live to rehearse the event without
-- waiting for New York. It is deliberately powerless during the regular
-- session -- private.session_mode() ignores it when the exchange is open, so
-- nobody can slow the feed down or stop it under a live book by ticking a box.
-- NULL, the default, means "follow the exchange".
--
-- Trading follows the same rule: the book is open whenever the effective mode
-- is not idle. So a forced-live weekend rehearsal can place orders, and an
-- ordinary closed market cannot -- which is what the old always_open was
-- really being used for.
-- =====================================================================

-- ---------------------------------------------------------------------
-- The column
-- ---------------------------------------------------------------------
alter table public.game_settings drop column if exists market_hours_mode;

alter table public.game_settings
  add column if not exists worker_mode_override text;

alter table public.game_settings drop constraint if exists game_settings_hours_mode;
alter table public.game_settings drop constraint if exists game_settings_worker_mode;
alter table public.game_settings
  add constraint game_settings_worker_mode
  check (worker_mode_override is null or worker_mode_override in ('idle', 'regular', 'live'));

comment on column public.game_settings.worker_mode_override is
  'Testing lever: force the worker to idle/regular/live outside the regular '
  'session. NULL follows the exchange. Ignored while the market is open.';

-- ---------------------------------------------------------------------
-- The rule, in one place
-- ---------------------------------------------------------------------
create or replace function private.session_mode(p_state public.market_state, p_override text)
returns text
language sql
immutable
set search_path = ''
as $fn$
  select case
    -- The open market wins, always. An override cannot touch a live book.
    when p_state = 'regular'              then 'live'
    when p_override in ('idle','regular','live') then p_override
    when p_state in ('pre', 'post')       then 'regular'
    else                                       'idle'
  end;
$fn$;

revoke all on function private.session_mode(public.market_state, text)
  from public, anon, authenticated;

-- Same signature as before, so every caller keeps working; only the second
-- argument has changed meaning, from a session policy to a testing override.
-- Dropped rather than replaced: Postgres will not rename an input parameter in
-- place, and the old one was called p_mode.
drop function if exists private.market_is_open(public.market_state, text);

create function private.market_is_open(p_state public.market_state, p_override text)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select private.session_mode(p_state, p_override) <> 'idle';
$fn$;

-- A freshly created function grants EXECUTE to public; the dropped one had
-- that revoked, and PostgREST must not be able to reach it.
revoke all on function private.market_is_open(public.market_state, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Callers, recreated against the new column. Bodies are unchanged apart
-- from the settings field the session rule reads, and the status payload.
-- ---------------------------------------------------------------------

-- ---- public.get_market_status --------------------------------------
create or replace function public.get_market_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
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
    'is_open', private.market_is_open(coalesce(v_state, 'closed'), s.worker_mode_override),
    'worker_mode', private.session_mode(coalesce(v_state, 'closed'), s.worker_mode_override),
    'worker_mode_override', s.worker_mode_override,
    'worker_mode_locked', coalesce(v_state, 'closed') = 'regular',
    'trading_enabled', s.trading_enabled,
    'halt_reason', s.halt_reason,
    'last_quote_at', v_last,
    'last_tick_at', v_tick,
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

-- ---- public.admin_update_settings ----------------------------------
create or replace function public.admin_update_settings(p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin uuid := private.require_admin();
  v_cur   public.game_settings;
  v_new   public.game_settings;
  v_patch jsonb;
  v_key   text;
  v_old_v text;
  v_new_v text;
  v_changed jsonb := '[]'::jsonb;
begin
  -- strip fields a client must never set directly
  v_patch := p_patch - 'id' - 'updated_at' - 'updated_by';

  select * into v_cur from public.game_settings where id for update;
  v_new := jsonb_populate_record(v_cur, v_patch);

  update public.game_settings set
    trading_enabled = v_new.trading_enabled,
    halt_reason = v_new.halt_reason,
    starting_capital = v_new.starting_capital,
    commission_per_trade = v_new.commission_per_trade,
    commission_bps = v_new.commission_bps,
    min_commission = v_new.min_commission,
    slippage_bps = v_new.slippage_bps,
    allow_shorting = v_new.allow_shorting,
    allow_margin = v_new.allow_margin,
    max_leverage = v_new.max_leverage,
    maintenance_margin_pct = v_new.maintenance_margin_pct,
    cash_interest_apr = v_new.cash_interest_apr,
    margin_interest_apr = v_new.margin_interest_apr,
    short_borrow_apr = v_new.short_borrow_apr,
    capital_gains_tax_pct = v_new.capital_gains_tax_pct,
    max_position_pct_of_equity = v_new.max_position_pct_of_equity,
    max_order_notional = v_new.max_order_notional,
    min_order_notional = v_new.min_order_notional,
    allow_fractional_shares = v_new.allow_fractional_shares,
    worker_mode_override = v_new.worker_mode_override,
    price_staleness_seconds = v_new.price_staleness_seconds,
    competition_start_at = v_new.competition_start_at,
    competition_end_at = v_new.competition_end_at,
    leaderboard_visible_to_participants = v_new.leaderboard_visible_to_participants,
    updated_at = now(),
    updated_by = v_admin
  where id;

  for v_key in select jsonb_object_keys(v_patch) loop
    v_old_v := to_jsonb(v_cur) ->> v_key;
    v_new_v := to_jsonb(v_new) ->> v_key;
    if v_old_v is distinct from v_new_v then
      insert into public.settings_history (field, old_value, new_value, changed_by)
      values (v_key, v_old_v, v_new_v, v_admin);
      v_changed := v_changed || jsonb_build_object('field', v_key, 'from', v_old_v, 'to', v_new_v);
    end if;
  end loop;

  insert into public.audit_log (actor_id, action, entity_type, entity_id, details)
  values (v_admin, 'settings.update', 'game_settings', 'singleton',
          jsonb_build_object('changes', v_changed));

  return jsonb_build_object('ok', true, 'changed', v_changed);
end;
$$;

-- ---- public.place_order --------------------------------------------
create or replace function public.place_order(
  p_symbol          text,
  p_side            text,
  p_order_type      text,
  p_qty             numeric,
  p_limit_price     numeric default null,
  p_stop_price      numeric default null,
  p_trail_percent   numeric default null,
  p_trail_amount    numeric default null,
  p_tif             text    default 'day',
  p_client_order_id text    default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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

  -- ---- idempotency: a retried submit returns the original order ----
  if p_client_order_id is not null then
    select * into v_existing from public.orders
     where team_id = v_profile.team_id and client_order_id = p_client_order_id;
    if found then
      return jsonb_build_object('ok', true, 'duplicate', true,
                                'order', to_jsonb(v_existing),
                                'message', 'Order already submitted.');
    end if;
  end if;

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
  if now() - v_quote.quote_time > make_interval(secs => s.price_staleness_seconds) then
    raise exception 'Price data for % is stale. Try again shortly.', v_symbol using errcode = 'P0001';
  end if;

  v_ref  := v_quote.price;
  v_open := private.market_is_open(v_quote.market_state, s.worker_mode_override);

  -- ---- quantity ----
  v_qty := round(p_qty, 6);
  if v_qty is null or v_qty <= 0 then
    raise exception 'Quantity must be greater than zero.' using errcode = '22023';
  end if;
  if not s.allow_fractional_shares and v_qty <> trunc(v_qty) then
    raise exception 'Fractional shares are disabled. Enter a whole number of shares.' using errcode = '22023';
  end if;

  -- ---- price sanity: reject fat-finger prices far away from the market ----
  if v_type in ('limit', 'stop_limit') and (p_limit_price is null or p_limit_price <= 0) then
    raise exception 'A limit price is required for % orders.', p_order_type using errcode = '22023';
  end if;
  if v_type in ('stop', 'stop_limit') and (p_stop_price is null or p_stop_price <= 0) then
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
  if v_side = 'buy' and not s.allow_margin then
    if (v_team.cash - v_team.reserved_cash - v_notional - v_commission) < 0 then
      raise exception 'Insufficient cash. Order costs % but % is uncommitted.',
        round(v_notional + v_commission, 2), round(v_team.cash - v_team.reserved_cash, 2) using errcode = 'P0001';
    end if;
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
      -- untriggered at entry (we validated the stop sits away from the market)
      v_exec_price := null;
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
      -- Hold cash at the worst realistic price so buying power can't be double-spent.
      v_res_cash := round(v_notional * (case when v_type = 'market' then 1.02 else 1.0 end) + v_commission, 4);
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

-- ---- public.match_orders -------------------------------------------
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
       and private.market_is_open(q.market_state, s.worker_mode_override)
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
    continue when not private.market_is_open(v_state, s.worker_mode_override);

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
