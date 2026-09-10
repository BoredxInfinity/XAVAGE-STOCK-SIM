-- =====================================================================
-- XAVAGE STOCK SIM :: 0005 -- read API + admin controls
-- =====================================================================

-- ---------------------------------------------------------------------
-- public.get_portfolio -- live marked book for the caller's team.
-- Admins may pass an explicit team_id; participants may not.
-- ---------------------------------------------------------------------
create or replace function public.get_portfolio(p_team_id uuid default null)
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
  v_team    public.teams;
  v_metrics record;
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

  -- Admins have no team. Return the SAME shape with zeroed metrics rather than
  -- omitting the key -- callers should never have to guard for a missing field.
  if v_team_id is null then
    return jsonb_build_object(
      'ok', true,
      'team', null,
      'metrics', jsonb_build_object(
        'cash', 0, 'reserved_cash', 0, 'positions_value', 0, 'gross_exposure', 0,
        'equity', 0, 'buying_power', 0, 'total_pnl', 0, 'total_return_pct', 0
      ),
      'positions', '[]'::jsonb
    );
  end if;

  select * into v_team from public.teams where id = v_team_id;
  select * into v_metrics from private.team_metrics(v_team_id);

  select coalesce(jsonb_agg(x order by x->>'symbol'), '[]'::jsonb) into v_rows
  from (
    select jsonb_build_object(
      'symbol',        p.symbol,
      'name',          i.name,
      'qty',           p.qty,
      'reserved_qty',  p.reserved_qty,
      'avg_cost',      p.avg_cost,
      'price',         q.price,
      'prev_close',    q.prev_close,
      'market_value',  round(p.qty * q.price, 4),
      'cost_basis',    round(p.qty * p.avg_cost, 4),
      'unrealized_pnl', round((q.price - p.avg_cost) * p.qty, 4),
      'unrealized_pct', case when p.avg_cost > 0
                          then round((q.price - p.avg_cost) / p.avg_cost * 100 * sign(p.qty), 4)
                          else 0 end,
      'day_change',    round((q.price - coalesce(q.prev_close, q.price)) * p.qty, 4),
      'realized_pnl',  p.realized_pnl,
      'updated_at',    q.updated_at
    ) as x
    from public.positions p
    join public.quotes q      on q.symbol = p.symbol
    join public.instruments i on i.symbol = p.symbol
    where p.team_id = v_team_id and p.qty <> 0
  ) sub;

  return jsonb_build_object(
    'ok', true,
    'team', jsonb_build_object(
      'id', v_team.id, 'name', v_team.name,
      'initial_capital', v_team.initial_capital, 'is_frozen', v_team.is_frozen
    ),
    'metrics', jsonb_build_object(
      'cash', v_metrics.cash,
      'reserved_cash', v_metrics.reserved_cash,
      'positions_value', v_metrics.positions_value,
      'gross_exposure', v_metrics.gross_exposure,
      'equity', v_metrics.equity,
      'buying_power', v_metrics.buying_power,
      'total_pnl', round(v_metrics.equity - v_team.initial_capital, 4),
      'total_return_pct', case when v_team.initial_capital > 0
        then round((v_metrics.equity - v_team.initial_capital) / v_team.initial_capital * 100, 4)
        else 0 end
    ),
    'positions', v_rows
  );
end;
$$;

-- ---------------------------------------------------------------------
-- public.get_leaderboard -- ADMIN ONLY unless explicitly opened up.
-- ---------------------------------------------------------------------
create or replace function public.get_leaderboard()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s      public.game_settings;
  v_rows jsonb;
begin
  s := private.get_settings();

  if not private.is_admin() and not s.leaderboard_visible_to_participants then
    raise exception 'Rankings are not available.' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(row order by (row->>'equity')::numeric desc), '[]'::jsonb) into v_rows
  from (
    select jsonb_build_object(
      'team_id',   t.id,
      'team_name', t.name,
      'cash',      round(t.cash, 4),
      'positions_value', round(coalesce(pv.value, 0), 4),
      'equity',    round(t.cash + coalesce(pv.value, 0), 4),
      'initial_capital', t.initial_capital,
      'total_pnl', round((t.cash + coalesce(pv.value, 0)) - t.initial_capital, 4),
      'return_pct', case when t.initial_capital > 0
        then round(((t.cash + coalesce(pv.value, 0)) - t.initial_capital) / t.initial_capital * 100, 4)
        else 0 end,
      'realized_pnl', round(coalesce(pv.realized, 0), 4),
      'unrealized_pnl', round(coalesce(pv.unrealized, 0), 4),
      'open_positions', coalesce(pv.n, 0),
      'trade_count', coalesce(tc.n, 0),
      'members', coalesce(mem.names, '[]'::jsonb),
      'is_frozen', t.is_frozen
    ) as row
    from public.teams t
    left join lateral (
      select sum(p.qty * q.price) as value,
             sum(p.realized_pnl)  as realized,
             sum((q.price - p.avg_cost) * p.qty) as unrealized,
             count(*)             as n
        from public.positions p join public.quotes q on q.symbol = p.symbol
       where p.team_id = t.id and p.qty <> 0
    ) pv on true
    left join lateral (
      select count(*) as n from public.trades tr where tr.team_id = t.id
    ) tc on true
    left join lateral (
      select jsonb_agg(pr.display_name order by pr.display_name) as names
        from public.profiles pr where pr.team_id = t.id and pr.role = 'participant'
    ) mem on true
    where t.is_active
  ) sub;

  return jsonb_build_object('ok', true, 'generated_at', now(), 'teams', v_rows);
end;
$$;

-- ---------------------------------------------------------------------
-- public.get_market_status
-- ---------------------------------------------------------------------
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
    'is_open', private.market_is_open(coalesce(v_state, 'closed'), s.market_hours_mode),
    'hours_mode', s.market_hours_mode,
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

-- =====================================================================
-- ADMIN CONTROLS
-- =====================================================================

create or replace function private.require_admin()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null or not private.is_admin() then
    raise exception 'Administrator access required.' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

revoke execute on function private.require_admin() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Mid-game settings changes. Accepts a partial patch; every changed
-- field is diffed into settings_history so the game stays auditable.
-- ---------------------------------------------------------------------
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
    market_hours_mode = v_new.market_hours_mode,
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

-- ---------------------------------------------------------------------
-- Cash injections / penalties
-- ---------------------------------------------------------------------
create or replace function public.admin_adjust_cash(p_team_id uuid, p_amount numeric, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin uuid := private.require_admin();
  v_bal   numeric;
begin
  if p_amount = 0 then
    raise exception 'Amount must be non-zero.' using errcode = '22023';
  end if;

  update public.teams set cash = round(cash + p_amount, 4)
   where id = p_team_id returning cash into v_bal;

  if not found then
    raise exception 'Team not found.' using errcode = 'P0001';
  end if;

  insert into public.cash_ledger (team_id, entry_type, amount, balance_after, note, created_by)
  values (p_team_id, 'admin_adjustment', round(p_amount, 4), v_bal,
          coalesce(p_note, 'Administrator adjustment'), v_admin);

  insert into public.audit_log (actor_id, action, entity_type, entity_id, details)
  values (v_admin, 'team.adjust_cash', 'team', p_team_id::text,
          jsonb_build_object('amount', p_amount, 'balance_after', v_bal, 'note', p_note));

  return jsonb_build_object('ok', true, 'balance', v_bal);
end;
$$;

-- ---------------------------------------------------------------------
-- Halt / resume a single symbol
-- ---------------------------------------------------------------------
create or replace function public.admin_set_symbol_halt(p_symbol text, p_halted boolean, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin uuid := private.require_admin();
  v_sym   text := upper(btrim(p_symbol));
begin
  update public.instruments
     set is_halted = p_halted, halt_reason = case when p_halted then p_reason end
   where symbol = v_sym;

  if not found then
    raise exception 'Unknown symbol "%"', v_sym using errcode = 'P0001';
  end if;

  insert into public.audit_log (actor_id, action, entity_type, entity_id, details)
  values (v_admin, case when p_halted then 'symbol.halt' else 'symbol.resume' end,
          'instrument', v_sym, jsonb_build_object('reason', p_reason));

  return jsonb_build_object('ok', true, 'symbol', v_sym, 'halted', p_halted);
end;
$$;

-- ---------------------------------------------------------------------
-- Create a team and fund it (writes the opening ledger entry)
-- ---------------------------------------------------------------------
create or replace function public.admin_create_team(p_name text, p_capital numeric default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin   uuid := private.require_admin();
  s         public.game_settings := private.get_settings();
  v_capital numeric := coalesce(p_capital, s.starting_capital);
  v_team    public.teams;
  v_code    text;
  i         integer;
begin
  if btrim(coalesce(p_name, '')) = '' then
    raise exception 'Team name is required.' using errcode = '22023';
  end if;

  -- Short reference code. gen_random_uuid() is pg_catalog, so it resolves
  -- under `search_path = ''` on both Supabase and vanilla Postgres.
  -- Hex has no O/I/l, so the code is already visually unambiguous.
  for i in 1..10 loop
    v_code := upper(left(replace(gen_random_uuid()::text, '-', ''), 6));
    begin
      insert into public.teams (name, join_code, cash, initial_capital)
      values (btrim(p_name), v_code, v_capital, v_capital)
      returning * into v_team;
      exit;
    exception
      when unique_violation then
        -- a duplicate NAME is a real user error; only retry on code collisions
        if exists (select 1 from public.teams where name = btrim(p_name)) then
          raise exception 'A team named "%" already exists.', btrim(p_name) using errcode = 'P0001';
        end if;
    end;
  end loop;

  if v_team.id is null then
    raise exception 'Could not allocate a unique join code; please retry.' using errcode = 'P0001';
  end if;

  insert into public.cash_ledger (team_id, entry_type, amount, balance_after, note, created_by)
  values (v_team.id, 'initial_capital', v_capital, v_capital, 'Opening balance', v_admin);

  insert into public.audit_log (actor_id, action, entity_type, entity_id, details)
  values (v_admin, 'team.create', 'team', v_team.id::text,
          jsonb_build_object('name', v_team.name, 'capital', v_capital));

  return jsonb_build_object('ok', true, 'team', to_jsonb(v_team));
end;
$$;

-- ---------------------------------------------------------------------
-- Reset a team to its opening state (use before the competition starts)
-- ---------------------------------------------------------------------
create or replace function public.admin_reset_team(p_team_id uuid, p_capital numeric default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin   uuid := private.require_admin();
  s         public.game_settings := private.get_settings();
  v_capital numeric;
begin
  select coalesce(p_capital, nullif(initial_capital, 0), s.starting_capital)
    into v_capital from public.teams where id = p_team_id for update;

  if v_capital is null then
    raise exception 'Team not found.' using errcode = 'P0001';
  end if;

  delete from public.trades          where team_id = p_team_id;
  delete from public.orders          where team_id = p_team_id;
  delete from public.positions       where team_id = p_team_id;
  delete from public.cash_ledger     where team_id = p_team_id;
  delete from public.portfolio_snapshots where team_id = p_team_id;

  update public.teams
     set cash = v_capital, reserved_cash = 0, initial_capital = v_capital
   where id = p_team_id;

  insert into public.cash_ledger (team_id, entry_type, amount, balance_after, note, created_by)
  values (p_team_id, 'initial_capital', v_capital, v_capital, 'Team reset', v_admin);

  insert into public.audit_log (actor_id, action, entity_type, entity_id, details)
  values (v_admin, 'team.reset', 'team', p_team_id::text, jsonb_build_object('capital', v_capital));

  return jsonb_build_object('ok', true, 'capital', v_capital);
end;
$$;

-- ---------------------------------------------------------------------
-- Flatten a team's book at the live market (settlement / rule breach)
-- ---------------------------------------------------------------------
create or replace function public.admin_liquidate_team(p_team_id uuid, p_note text default 'Administrative liquidation')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin uuid := private.require_admin();
  s       public.game_settings := private.get_settings();
  r       record;
  v_order public.orders;
  n       integer := 0;
begin
  perform 1 from public.teams where id = p_team_id for update;
  if not found then
    raise exception 'Team not found.' using errcode = 'P0001';
  end if;

  -- cancel working orders first so reservations unwind
  for r in select * from public.orders
            where team_id = p_team_id and status in ('open', 'partially_filled', 'pending') loop
    perform private.release_reservations(r);
    update public.orders set status = 'cancelled', closed_at = now(),
           reject_reason = p_note where id = r.id;
  end loop;

  for r in
    select p.symbol, p.qty, q.price
      from public.positions p join public.quotes q on q.symbol = p.symbol
     where p.team_id = p_team_id and p.qty <> 0
     order by p.symbol
  loop
    insert into public.orders (team_id, user_id, symbol, side, order_type, qty, tif, status)
    values (p_team_id, v_admin, r.symbol,
            (case when r.qty > 0 then 'sell' else 'buy' end)::public.order_side,
            'market', abs(r.qty), 'ioc', 'pending')
    returning * into v_order;

    perform private.apply_fill(v_order, abs(r.qty), private.apply_slippage(r.price, v_order.side, s), s);
    n := n + 1;
  end loop;

  insert into public.audit_log (actor_id, action, entity_type, entity_id, details)
  values (v_admin, 'team.liquidate', 'team', p_team_id::text,
          jsonb_build_object('positions_closed', n, 'note', p_note));

  return jsonb_build_object('ok', true, 'positions_closed', n);
end;
$$;

-- ---------------------------------------------------------------------
-- Freeze / unfreeze a single team without halting the whole competition
-- ---------------------------------------------------------------------
create or replace function public.admin_set_team_frozen(p_team_id uuid, p_frozen boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin uuid := private.require_admin();
  v_name  text;
begin
  update public.teams set is_frozen = p_frozen
   where id = p_team_id returning name into v_name;

  if not found then
    raise exception 'Team not found.' using errcode = 'P0001';
  end if;

  insert into public.audit_log (actor_id, action, entity_type, entity_id, details)
  values (v_admin, case when p_frozen then 'team.freeze' else 'team.unfreeze' end,
          'team', p_team_id::text, jsonb_build_object('name', v_name));

  return jsonb_build_object('ok', true, 'team', v_name, 'frozen', p_frozen);
end;
$$;
