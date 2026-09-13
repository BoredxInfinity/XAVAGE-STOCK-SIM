-- =====================================================================
-- XAVAGE STOCK SIM :: the worker's cadences, steerable from the app
-- =====================================================================
-- How often the worker does anything was fixed in environment variables on a
-- box behind an SSH key. Changing the live cadence for a busy final hour, or
-- slowing the history refresh because the instance is struggling, meant a
-- session on the instance and a restart -- during the event, with the feed
-- down for the length of a cold start.
--
-- Four nullable columns, one per cadence. NULL means "whatever the worker was
-- started with", so an untouched deployment behaves exactly as before and the
-- environment stays the place to set a default; a value here overrides it from
-- the next settings refresh, within a minute, without a restart.
--
-- The bounds are not taste. A live cadence below the time a cycle takes (~4s)
-- means every cycle starts late and the worker never catches up; a history
-- refresh under a minute is the worker's largest allocation on a loop.
-- =====================================================================

alter table public.game_settings
  add column if not exists worker_live_interval    integer,
  add column if not exists worker_regular_interval integer,
  add column if not exists worker_idle_interval    integer,
  add column if not exists worker_history_interval integer;

alter table public.game_settings drop constraint if exists game_settings_worker_cadence;
alter table public.game_settings
  add constraint game_settings_worker_cadence check (
        (worker_live_interval    is null or worker_live_interval    between 3 and 600)
    and (worker_regular_interval is null or worker_regular_interval between 10 and 3600)
    and (worker_idle_interval    is null or worker_idle_interval    between 15 and 3600)
    and (worker_history_interval is null or worker_history_interval between 60 and 86400)
  );

comment on column public.game_settings.worker_live_interval is
  'Seconds between cycles while the regular session is open. NULL keeps the worker''s own default.';
comment on column public.game_settings.worker_regular_interval is
  'Seconds between cycles through pre-market and after hours. NULL keeps the worker''s own default.';
comment on column public.game_settings.worker_idle_interval is
  'Seconds between heartbeats while the exchange is shut. No feed requests are made either way.';
comment on column public.game_settings.worker_history_interval is
  'Seconds between refreshes of the 5D chart series. The worker''s largest single allocation.';

-- ---------------------------------------------------------------------
-- admin_update_settings, recreated so the patch carries the new columns.
-- Unchanged otherwise.
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
    worker_mode_override = v_new.worker_mode_override,
    worker_live_interval = v_new.worker_live_interval,
    worker_regular_interval = v_new.worker_regular_interval,
    worker_idle_interval = v_new.worker_idle_interval,
    worker_history_interval = v_new.worker_history_interval,
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
