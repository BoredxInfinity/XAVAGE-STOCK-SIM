-- Schema hardening: one index, one foreign key, one policy.

-- ------------------------------------------------- price_bars prune index
-- prune_price_bars filters on a LEADING `interval` predicate:
--     where interval = '1m' and ts < ...
-- The only index is price_bars_lookup_idx (symbol, interval, ts desc), which
-- cannot serve that -- `symbol` is the leading column. So the hourly retention
-- pass was three sequential scans of the largest table in the database
-- (~293k rows today, and it grows with the symbol universe).
create index if not exists price_bars_retention_idx
  on public.price_bars ("interval", ts);


-- --------------------------------------------- positions.symbol: no cascade
-- `on delete cascade` meant deleting an instrument silently deleted every
-- team's position in it -- no cash credit, no ledger entry, equity just drops.
-- orders.symbol is already `restrict`, so the behaviour was not even
-- consistent: the delete would be blocked by a resting order but would
-- happily vaporise a settled holding.
--
-- Nothing in the admin UI deletes instruments today (it toggles is_tradable).
-- This is to keep it that way when someone reaches for the SQL console during
-- an event.
alter table public.positions
  drop constraint if exists positions_symbol_fkey;
alter table public.positions
  add constraint positions_symbol_fkey
  foreign key (symbol) references public.instruments (symbol) on delete restrict;


-- ------------------------------------------------ game_settings: admin only
-- The policy was `using (true)`, so any participant could read the raw row
-- straight off PostgREST and see competition_end_at, short_borrow_apr,
-- capital_gains_tax_pct and worker_mode_override the moment an organiser wrote
-- them -- before any announcement, and before anyone else in the room.
--
-- The app does not need it: get_market_status() already returns the curated
-- subset the order ticket and market bar consume, and every direct reader is
-- either service-role (health, search, instruments) or an /admin view.
drop policy if exists game_settings_read on public.game_settings;
create policy game_settings_read on public.game_settings
  for select to authenticated
  using ((select private.is_admin()));
