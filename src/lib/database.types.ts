/**
 * NOTE: these are `type` aliases, not `interface`s, on purpose.
 * supabase-js constrains each table Row to `Record<string, unknown>`;
 * an interface has no implicit index signature and fails that check,
 * which silently degrades every query result to `never`.
 *
 * Hand-maintained mirror of the SQL migrations.
 * Regenerate once the Supabase project exists:
 *   npx supabase gen types typescript --project-id <ref> > src/lib/database.types.ts
 */

export type AppRole = "admin" | "participant";
export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit" | "stop" | "stop_limit" | "trailing_stop";
export type TimeInForce = "day" | "gtc" | "ioc" | "fok";
export type OrderStatus =
  | "pending" | "open" | "partially_filled" | "filled"
  | "cancelled" | "rejected" | "expired";
export type MarketState = "pre" | "regular" | "post" | "closed";

/**
 * What the price worker is doing, derived from the exchange session:
 * regular -> live (5s), pre/post -> regular (slow poll), closed -> idle (no
 * feed requests at all). The book is open in any mode but idle.
 */
export type WorkerMode = "idle" | "regular" | "live";
export type LedgerType =
  | "initial_capital" | "trade_buy" | "trade_sell" | "commission" | "cash_interest"
  | "margin_interest" | "borrow_fee" | "dividend" | "tax" | "admin_adjustment";

export type Profile = {
  id: string;
  email: string;
  display_name: string;
  role: AppRole;
  team_id: string | null;
  must_change_password: boolean;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

export type Team = {
  id: string;
  name: string;
  join_code: string;
  cash: number;
  reserved_cash: number;
  initial_capital: number;
  is_active: boolean;
  is_frozen: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export type Instrument = {
  symbol: string;
  name: string;
  exchange: string | null;
  asset_type: string;
  currency: string;
  sector: string | null;
  industry: string | null;
  is_tradable: boolean;
  is_halted: boolean;
  halt_reason: string | null;
}

export type Quote = {
  symbol: string;
  price: number;
  prev_close: number | null;
  day_open: number | null;
  day_high: number | null;
  day_low: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  market_state: MarketState;
  quote_time: string;
  updated_at: string;
}

export type Order = {
  id: string;
  team_id: string;
  user_id: string | null;
  symbol: string;
  side: OrderSide;
  order_type: OrderType;
  qty: number;
  limit_price: number | null;
  stop_price: number | null;
  trail_percent: number | null;
  trail_amount: number | null;
  trail_reference: number | null;
  tif: TimeInForce;
  status: OrderStatus;
  filled_qty: number;
  avg_fill_price: number | null;
  reserved_cash: number;
  reserved_qty: number;
  reject_reason: string | null;
  client_order_id: string | null;
  created_at: string;
  updated_at: string;
  filled_at: string | null;
  closed_at: string | null;
}

export type Trade = {
  id: string;
  order_id: string;
  team_id: string;
  user_id: string | null;
  symbol: string;
  side: OrderSide;
  qty: number;
  price: number;
  gross_amount: number;
  commission: number;
  net_cash_delta: number;
  realized_pnl: number;
  position_qty_after: number;
  executed_at: string;
}

export type PositionRow = {
  team_id: string;
  symbol: string;
  qty: number;
  avg_cost: number;
  realized_pnl: number;
  reserved_qty: number;
  updated_at: string;
}

export type CashLedgerRow = {
  id: number;
  team_id: string;
  entry_type: LedgerType;
  amount: number;
  balance_after: number;
  ref_id: string | null;
  note: string | null;
  created_at: string;
}

export type GameSettings = {
  id: boolean;
  trading_enabled: boolean;
  halt_reason: string | null;
  starting_capital: number;
  commission_per_trade: number;
  commission_bps: number;
  min_commission: number;
  slippage_bps: number;
  allow_shorting: boolean;
  allow_margin: boolean;
  max_leverage: number;
  maintenance_margin_pct: number;
  cash_interest_apr: number;
  margin_interest_apr: number;
  short_borrow_apr: number;
  capital_gains_tax_pct: number;
  max_position_pct_of_equity: number;
  max_order_notional: number | null;
  min_order_notional: number;
  allow_fractional_shares: boolean;
  /** Testing lever only: force the worker outside regular hours. See WorkerMode. */
  worker_mode_override: WorkerMode | null;
  price_staleness_seconds: number;
  competition_start_at: string | null;
  competition_end_at: string | null;
  leaderboard_visible_to_participants: boolean;
  updated_at: string;
  updated_by: string | null;
}

export type PortfolioSnapshot = {
  id: number;
  team_id: string;
  ts: string;
  cash: number;
  positions_value: number;
  equity: number;
  realized_pnl: number;
  unrealized_pnl: number;
  total_return_pct: number;
}

/**
 * Admin-issued login credential. These are organiser-generated codes, never a
 * password the participant chose, which is what makes storing them acceptable.
 * Readable only by admins (RLS).
 */
export type IssuedCredential = {
  user_id: string;
  password: string;
  is_stale: boolean;
  issued_at: string;
  issued_by: string | null;
};

export type WorkerLogLevel = "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL";

/** One line from the price worker. See migration 0012 and worker/logbook.py. */
export type WorkerLog = {
  id: number;
  ts: string;
  level: WorkerLogLevel;
  /** Machine-readable stage name: cycle, history, backfill, startup, ... */
  event: string;
  message: string;
  cycle: number | null;
  duration_ms: number | null;
  /** Worker resident memory when the line was written. */
  rss_mb: number | null;
  detail: Record<string, unknown> | null;
  source: string;
};

export type Announcement = {
  id: string;
  title: string;
  body: string;
  severity: "info" | "success" | "warning" | "critical";
  is_published: boolean;
  created_by: string | null;
  created_at: string;
}

/* ---------------- RPC payload shapes ---------------- */

export type PortfolioPosition = {
  symbol: string;
  name: string;
  qty: number;
  reserved_qty: number;
  avg_cost: number;
  price: number;
  prev_close: number | null;
  market_value: number;
  cost_basis: number;
  unrealized_pnl: number;
  unrealized_pct: number;
  day_change: number;
  realized_pnl: number;
  updated_at: string;
}

export type PortfolioMetrics = {
  cash: number;
  reserved_cash: number;
  positions_value: number;
  gross_exposure: number;
  equity: number;
  buying_power: number;
  total_pnl: number;
  total_return_pct: number;
}

export type PortfolioResponse = {
  ok: true;
  team: { id: string; name: string; initial_capital: number; is_frozen: boolean } | null;
  metrics: PortfolioMetrics;
  positions: PortfolioPosition[];
}

export type LeaderboardRow = {
  team_id: string;
  team_name: string;
  cash: number;
  positions_value: number;
  equity: number;
  initial_capital: number;
  total_pnl: number;
  return_pct: number;
  realized_pnl: number;
  unrealized_pnl: number;
  open_positions: number;
  trade_count: number;
  members: string[];
  is_frozen: boolean;
}

export type MarketStatus = {
  ok: true;
  market_state: MarketState;
  /** True whenever the effective worker mode is not idle. */
  is_open: boolean;
  /** The mode in force right now, override included. */
  worker_mode: WorkerMode;
  /** What an organiser has forced, or null while following the exchange. */
  worker_mode_override: WorkerMode | null;
  /** True while the regular session is on, when the override is ignored. */
  worker_mode_locked: boolean;
  trading_enabled: boolean;
  halt_reason: string | null;
  last_quote_at: string | null;
  last_tick_at: string | null;
  competition_start_at: string | null;
  competition_end_at: string | null;
  settings: Pick<GameSettings,
    | "allow_shorting" | "allow_margin" | "allow_fractional_shares" | "max_leverage"
    | "commission_per_trade" | "commission_bps" | "min_commission" | "slippage_bps"
    | "cash_interest_apr" | "margin_interest_apr" | "short_borrow_apr"
    | "capital_gains_tax_pct" | "max_position_pct_of_equity"
    | "max_order_notional" | "min_order_notional"
    | "leaderboard_visible_to_participants">;
}

export type PlaceOrderResult = {
  ok: boolean;
  executed?: boolean;
  duplicate?: boolean;
  order: Order;
  trade?: Trade;
  message: string;
}

/* ---------------- minimal Database generic for supabase-js ---------------- */

type Row<T> = { Row: T; Insert: Partial<T>; Update: Partial<T>; Relationships: [] };

export type Database = {
  public: {
    Tables: {
      profiles: Row<Profile>;
      teams: Row<Team>;
      instruments: Row<Instrument>;
      quotes: Row<Quote>;
      orders: Row<Order>;
      trades: Row<Trade>;
      positions: Row<PositionRow>;
      cash_ledger: Row<CashLedgerRow>;
      game_settings: Row<GameSettings>;
      portfolio_snapshots: Row<PortfolioSnapshot>;
      announcements: Row<Announcement>;
      issued_credentials: Row<IssuedCredential>;
      price_bars: Row<{
        id: number; symbol: string; interval: string; ts: string;
        o: number; h: number; l: number; c: number; v: number;
      }>;
      settings_history: Row<{
        id: number; field: string; old_value: string | null;
        new_value: string | null; changed_by: string | null; changed_at: string;
      }>;
      audit_log: Row<{
        id: number; actor_id: string | null; action: string;
        entity_type: string | null; entity_id: string | null;
        details: Record<string, unknown>; created_at: string;
      }>;
      system_state: Row<{
        id: boolean; last_tick_at: string | null; last_tick_source: string | null;
        tick_count: number; last_accrual_date: string | null; last_snapshot_at: string | null;
      }>;
      worker_logs: Row<WorkerLog>;
    };
    Views: { [_ in never]: never };
    Functions: {
      place_order: { Args: Record<string, unknown>; Returns: PlaceOrderResult };
      cancel_order: { Args: { p_order_id: string }; Returns: { ok: boolean; message: string } };
      get_portfolio: { Args: { p_team_id?: string }; Returns: PortfolioResponse };
      get_leaderboard: { Args: Record<PropertyKey, never>; Returns: { ok: true; generated_at: string; teams: LeaderboardRow[] } };
      get_market_status: { Args: Record<PropertyKey, never>; Returns: MarketStatus };
      admin_update_settings: { Args: { p_patch: Record<string, unknown> }; Returns: Record<string, unknown> };
      admin_adjust_cash: { Args: { p_team_id: string; p_amount: number; p_note?: string }; Returns: Record<string, unknown> };
      admin_set_symbol_halt: { Args: { p_symbol: string; p_halted: boolean; p_reason?: string }; Returns: Record<string, unknown> };
      admin_create_team: { Args: { p_name: string; p_capital?: number }; Returns: Record<string, unknown> };
      admin_reset_team: { Args: { p_team_id: string; p_capital?: number }; Returns: Record<string, unknown> };
      admin_liquidate_team: { Args: { p_team_id: string; p_note?: string }; Returns: Record<string, unknown> };
      admin_set_team_frozen: { Args: { p_team_id: string; p_frozen: boolean }; Returns: Record<string, unknown> };
      mark_password_changed: { Args: Record<PropertyKey, never>; Returns: { ok: boolean } };
      touch_login: { Args: Record<PropertyKey, never>; Returns: Record<string, unknown> };
      match_orders: { Args: { p_symbols?: string[] }; Returns: Record<string, unknown> };
      expire_day_orders: { Args: Record<PropertyKey, never>; Returns: Record<string, unknown> };
      accrue_daily_interest: { Args: { p_force?: boolean }; Returns: Record<string, unknown> };
      take_snapshots: { Args: Record<PropertyKey, never>; Returns: Record<string, unknown> };
    };
    Enums: {
      app_role: AppRole; order_side: OrderSide; order_type: OrderType;
      time_in_force: TimeInForce; order_status: OrderStatus;
      market_state: MarketState; ledger_type: LedgerType;
    };
    CompositeTypes: { [_ in never]: never };
  };
}
