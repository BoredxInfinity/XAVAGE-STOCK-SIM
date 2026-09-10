-- =====================================================================
-- XAVAGE STOCK SIM :: 0001 -- core schema
-- =====================================================================
-- Conventions (per Supabase Postgres best practices):
--   * lowercase identifiers, no quoted CamelCase
--   * timestamptz everywhere (never bare timestamp)
--   * numeric for money/qty (never float) -- exact decimal arithmetic
--   * text + enums, never varchar(n)
--   * every FK gets an index; every RLS predicate column gets an index
-- =====================================================================

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

-- Private schema: helper functions that must never be callable by clients.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------
do $$ begin
  create type public.app_role      as enum ('admin', 'participant');
  create type public.order_side    as enum ('buy', 'sell');
  create type public.order_type    as enum ('market', 'limit', 'stop', 'stop_limit', 'trailing_stop');
  create type public.time_in_force as enum ('day', 'gtc', 'ioc', 'fok');
  create type public.order_status  as enum ('pending', 'open', 'partially_filled', 'filled', 'cancelled', 'rejected', 'expired');
  create type public.ledger_type   as enum (
    'initial_capital', 'trade_buy', 'trade_sell', 'commission', 'cash_interest',
    'margin_interest', 'borrow_fee', 'dividend', 'tax', 'admin_adjustment'
  );
  create type public.market_state  as enum ('pre', 'regular', 'post', 'closed');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- updated_at trigger helper
-- ---------------------------------------------------------------------
create or replace function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- teams :: one shared book per team (single cash balance + positions)
-- ---------------------------------------------------------------------
create table if not exists public.teams (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  join_code       text not null,
  cash            numeric(20,4) not null default 0,
  -- cash committed to resting buy orders; buying power = cash - reserved_cash
  reserved_cash   numeric(20,4) not null default 0,
  initial_capital numeric(20,4) not null default 0,
  is_active       boolean not null default true,
  -- admin can freeze a single team without halting the whole game
  is_frozen       boolean not null default false,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint teams_name_key       unique (name),
  constraint teams_join_code_key  unique (join_code),
  constraint teams_reserved_cash_nonneg check (reserved_cash >= 0)
);

create trigger teams_touch before update on public.teams
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------
-- profiles :: 1:1 with auth.users, carries role + team membership
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id                   uuid primary key references auth.users (id) on delete cascade,
  email                text not null,
  display_name         text not null,
  role                 public.app_role not null default 'participant',
  team_id              uuid references public.teams (id) on delete set null,
  -- admin provisions the account with a temp password; force a rotation on first login
  must_change_password boolean not null default true,
  is_active            boolean not null default true,
  last_login_at        timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists profiles_team_id_idx on public.profiles (team_id);
create index if not exists profiles_role_idx    on public.profiles (role);
create index if not exists profiles_email_idx   on public.profiles (lower(email));

create trigger profiles_touch before update on public.profiles
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------
-- instruments :: the tradable universe (populated from yfinance)
-- ---------------------------------------------------------------------
create table if not exists public.instruments (
  symbol      text primary key,
  name        text not null default '',
  exchange    text,
  asset_type  text not null default 'EQUITY',
  currency    text not null default 'USD',
  sector      text,
  industry    text,
  is_tradable boolean not null default true,
  -- admin lever: halt one symbol mid-game without disabling it
  is_halted   boolean not null default false,
  halt_reason text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint instruments_symbol_upper check (symbol = upper(symbol))
);

-- trigram indexes power the ticker search box (symbol + company name)
create index if not exists instruments_symbol_trgm_idx on public.instruments using gin (symbol gin_trgm_ops);
create index if not exists instruments_name_trgm_idx   on public.instruments using gin (name   gin_trgm_ops);
create index if not exists instruments_tradable_idx    on public.instruments (symbol) where is_tradable;

create trigger instruments_touch before update on public.instruments
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------
-- quotes :: current price snapshot, one row per symbol (worker upserts)
-- ---------------------------------------------------------------------
create table if not exists public.quotes (
  symbol       text primary key references public.instruments (symbol) on delete cascade,
  price        numeric(18,6) not null,
  prev_close   numeric(18,6),
  day_open     numeric(18,6),
  day_high     numeric(18,6),
  day_low      numeric(18,6),
  bid          numeric(18,6),
  ask          numeric(18,6),
  volume       bigint,
  market_state public.market_state not null default 'closed',
  quote_time   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint quotes_price_positive check (price > 0)
);

create index if not exists quotes_updated_at_idx on public.quotes (updated_at desc);

-- ---------------------------------------------------------------------
-- price_bars :: OHLCV history for charts
-- ---------------------------------------------------------------------
create table if not exists public.price_bars (
  id       bigint generated always as identity primary key,
  symbol   text not null references public.instruments (symbol) on delete cascade,
  interval text not null,
  ts       timestamptz not null,
  o        numeric(18,6) not null,
  h        numeric(18,6) not null,
  l        numeric(18,6) not null,
  c        numeric(18,6) not null,
  v        bigint not null default 0,
  constraint price_bars_uniq unique (symbol, interval, ts)
);

-- covering index: chart reads are always (symbol, interval) ordered by ts
create index if not exists price_bars_lookup_idx
  on public.price_bars (symbol, interval, ts desc) include (o, h, l, c, v);

-- ---------------------------------------------------------------------
-- positions :: signed qty (negative = short). PK is (team_id, symbol).
-- ---------------------------------------------------------------------
create table if not exists public.positions (
  team_id      uuid not null references public.teams (id) on delete cascade,
  symbol       text not null references public.instruments (symbol) on delete cascade,
  qty          numeric(18,6) not null default 0,
  avg_cost     numeric(18,6) not null default 0,
  realized_pnl numeric(20,4) not null default 0,
  -- shares committed to resting sell orders, so the same lot can't be sold twice
  reserved_qty numeric(18,6) not null default 0,
  opened_at    timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (team_id, symbol),
  constraint positions_reserved_nonneg check (reserved_qty >= 0)
);

create index if not exists positions_symbol_idx on public.positions (symbol);
create index if not exists positions_open_idx   on public.positions (team_id) where qty <> 0;

create trigger positions_touch before update on public.positions
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------
-- orders
-- ---------------------------------------------------------------------
create table if not exists public.orders (
  id               uuid primary key default gen_random_uuid(),
  team_id          uuid not null references public.teams (id) on delete cascade,
  user_id          uuid references public.profiles (id) on delete set null,
  symbol           text not null references public.instruments (symbol) on delete restrict,
  side             public.order_side not null,
  order_type       public.order_type not null,
  qty              numeric(18,6) not null,
  limit_price      numeric(18,6),
  stop_price       numeric(18,6),
  trail_percent    numeric(9,4),
  trail_amount     numeric(18,6),
  -- high/low water mark used to ratchet a trailing stop
  trail_reference  numeric(18,6),
  tif              public.time_in_force not null default 'day',
  status           public.order_status not null default 'pending',
  filled_qty       numeric(18,6) not null default 0,
  avg_fill_price   numeric(18,6),
  reserved_cash    numeric(20,4) not null default 0,
  reserved_qty     numeric(18,6) not null default 0,
  reject_reason    text,
  -- idempotency key: a retried submit must not double-place
  client_order_id  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  filled_at        timestamptz,
  closed_at        timestamptz,
  expires_at       timestamptz,

  constraint orders_qty_positive   check (qty > 0),
  constraint orders_filled_bounds  check (filled_qty >= 0 and filled_qty <= qty),
  constraint orders_limit_required check (
    (order_type in ('limit', 'stop_limit') and limit_price is not null and limit_price > 0)
    or (order_type not in ('limit', 'stop_limit'))
  ),
  constraint orders_stop_required check (
    (order_type in ('stop', 'stop_limit') and stop_price is not null and stop_price > 0)
    or (order_type not in ('stop', 'stop_limit'))
  ),
  constraint orders_trail_required check (
    (order_type = 'trailing_stop' and (trail_percent is not null or trail_amount is not null))
    or (order_type <> 'trailing_stop')
  ),
  constraint orders_client_id_uniq unique (team_id, client_order_id)
);

create index if not exists orders_team_created_idx on public.orders (team_id, created_at desc);
create index if not exists orders_user_idx         on public.orders (user_id);
create index if not exists orders_symbol_idx       on public.orders (symbol);
-- the matching engine only ever scans live orders -> partial index keeps it tiny
create index if not exists orders_working_idx
  on public.orders (symbol, status) where status in ('open', 'partially_filled');

create trigger orders_touch before update on public.orders
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------
-- trades :: immutable fill records
-- ---------------------------------------------------------------------
create table if not exists public.trades (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid not null references public.orders (id) on delete cascade,
  team_id           uuid not null references public.teams (id) on delete cascade,
  user_id           uuid references public.profiles (id) on delete set null,
  symbol            text not null,
  side              public.order_side not null,
  qty               numeric(18,6) not null,
  price             numeric(18,6) not null,
  gross_amount      numeric(20,4) not null,
  commission        numeric(20,4) not null default 0,
  slippage_cost     numeric(20,4) not null default 0,
  net_cash_delta    numeric(20,4) not null,
  realized_pnl      numeric(20,4) not null default 0,
  position_qty_after numeric(18,6) not null,
  executed_at       timestamptz not null default now()
);

create index if not exists trades_team_time_idx on public.trades (team_id, executed_at desc);
create index if not exists trades_order_idx     on public.trades (order_id);
create index if not exists trades_symbol_idx    on public.trades (symbol, executed_at desc);
create index if not exists trades_user_idx      on public.trades (user_id);

-- ---------------------------------------------------------------------
-- cash_ledger :: every cash movement, double-entry style audit trail
-- ---------------------------------------------------------------------
create table if not exists public.cash_ledger (
  id            bigint generated always as identity primary key,
  team_id       uuid not null references public.teams (id) on delete cascade,
  entry_type    public.ledger_type not null,
  amount        numeric(20,4) not null,
  balance_after numeric(20,4) not null,
  ref_id        uuid,
  note          text,
  created_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists cash_ledger_team_time_idx on public.cash_ledger (team_id, created_at desc);
create index if not exists cash_ledger_created_by_idx on public.cash_ledger (created_by);

-- ---------------------------------------------------------------------
-- game_settings :: single row, every field is an admin lever
-- ---------------------------------------------------------------------
create table if not exists public.game_settings (
  id                        boolean primary key default true,
  trading_enabled           boolean not null default true,
  halt_reason               text,

  starting_capital          numeric(20,4) not null default 1000000,

  -- costs
  commission_per_trade      numeric(20,4) not null default 0,
  commission_bps            numeric(9,4)  not null default 0,
  min_commission            numeric(20,4) not null default 0,
  slippage_bps              numeric(9,4)  not null default 0,

  -- leverage / shorting
  allow_shorting            boolean not null default false,
  allow_margin              boolean not null default false,
  max_leverage              numeric(9,4) not null default 1.0,
  maintenance_margin_pct    numeric(9,4) not null default 25,

  -- rates (annualised %, accrued daily) -- the mid-game economic levers
  cash_interest_apr         numeric(9,4) not null default 0,
  margin_interest_apr       numeric(9,4) not null default 0,
  short_borrow_apr          numeric(9,4) not null default 0,
  capital_gains_tax_pct     numeric(9,4) not null default 0,

  -- risk limits
  max_position_pct_of_equity numeric(9,4) not null default 100,
  max_order_notional        numeric(20,4),
  min_order_notional        numeric(20,4) not null default 0,
  allow_fractional_shares   boolean not null default false,

  -- session control
  market_hours_mode         text not null default 'regular',
  price_staleness_seconds   integer not null default 900,

  competition_start_at      timestamptz,
  competition_end_at        timestamptz,
  leaderboard_visible_to_participants boolean not null default false,

  updated_at                timestamptz not null default now(),
  updated_by                uuid references public.profiles (id) on delete set null,

  constraint game_settings_singleton check (id),
  constraint game_settings_hours_mode check (market_hours_mode in ('regular', 'extended', 'always_open')),
  constraint game_settings_leverage   check (max_leverage >= 1.0)
);

create table if not exists public.settings_history (
  id         bigint generated always as identity primary key,
  field      text not null,
  old_value  text,
  new_value  text,
  changed_by uuid references public.profiles (id) on delete set null,
  changed_at timestamptz not null default now()
);

create index if not exists settings_history_time_idx on public.settings_history (changed_at desc);
create index if not exists settings_history_by_idx   on public.settings_history (changed_by);

-- ---------------------------------------------------------------------
-- portfolio_snapshots :: equity curve + ranking history
-- ---------------------------------------------------------------------
create table if not exists public.portfolio_snapshots (
  id               bigint generated always as identity primary key,
  team_id          uuid not null references public.teams (id) on delete cascade,
  ts               timestamptz not null default now(),
  cash             numeric(20,4) not null,
  positions_value  numeric(20,4) not null,
  equity           numeric(20,4) not null,
  realized_pnl     numeric(20,4) not null default 0,
  unrealized_pnl   numeric(20,4) not null default 0,
  total_return_pct numeric(12,6) not null default 0,
  constraint portfolio_snapshots_uniq unique (team_id, ts)
);

create index if not exists portfolio_snapshots_team_ts_idx on public.portfolio_snapshots (team_id, ts desc);

-- ---------------------------------------------------------------------
-- announcements :: admin-pushed market news / event injections
-- ---------------------------------------------------------------------
create table if not exists public.announcements (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  body         text not null default '',
  severity     text not null default 'info',
  is_published boolean not null default true,
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  constraint announcements_severity check (severity in ('info', 'success', 'warning', 'critical'))
);

create index if not exists announcements_published_idx on public.announcements (created_at desc) where is_published;
create index if not exists announcements_created_by_idx on public.announcements (created_by);

-- ---------------------------------------------------------------------
-- audit_log :: who did what (admin actions especially)
-- ---------------------------------------------------------------------
create table if not exists public.audit_log (
  id          bigint generated always as identity primary key,
  actor_id    uuid references public.profiles (id) on delete set null,
  action      text not null,
  entity_type text,
  entity_id   text,
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists audit_log_time_idx  on public.audit_log (created_at desc);
create index if not exists audit_log_actor_idx on public.audit_log (actor_id);

-- ---------------------------------------------------------------------
-- system_state :: worker heartbeat + accrual bookkeeping
-- ---------------------------------------------------------------------
create table if not exists public.system_state (
  id                 boolean primary key default true,
  last_tick_at       timestamptz,
  last_tick_source   text,
  tick_count         bigint not null default 0,
  last_accrual_date  date,
  last_snapshot_at   timestamptz,
  constraint system_state_singleton check (id)
);

insert into public.system_state (id) values (true) on conflict (id) do nothing;
