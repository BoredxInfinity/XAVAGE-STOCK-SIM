-- =====================================================================
-- XAVAGE STOCK SIM :: the symbol cap means the same thing everywhere
-- =====================================================================
-- MAX_SYMBOLS lived in the worker's environment and bounded only what the
-- worker quoted: `instruments ... order by symbol limit MAX_SYMBOLS`. The app
-- knew nothing about it, so past the cap the two disagreed in the worst
-- direction -- a symbol stayed listed, searchable and orderable while no
-- price ever arrived for it. A participant would find it, try to trade it,
-- and get an error about a missing price for a stock the app had just offered
-- them.
--
-- The cap now lives in game_settings next to the cadences, so the worker and
-- the app read one number, an organiser can change it from the control room,
-- and NULL still means "whatever the worker was started with".
--
-- `public.tradable_instruments` applies it the way the worker does -- the
-- first N by symbol -- so anything the worker is not quoting is not listed,
-- not searchable, and cannot be ordered. Beyond the cap a symbol does not
-- exist as far as participants are concerned, which is the honest behaviour:
-- the alternative is offering a price we do not have.
--
-- Alphabetical, because that is what the worker does, and the two must not
-- drift. It is arbitrary as a selection rule -- which is an argument for
-- keeping the universe under the cap rather than for ranking it differently
-- here, and the worker already warns loudly when it has to truncate.
-- =====================================================================

alter table public.game_settings
  add column if not exists worker_max_symbols integer;

alter table public.game_settings drop constraint if exists game_settings_worker_max_symbols;
alter table public.game_settings
  add constraint game_settings_worker_max_symbols check (
    worker_max_symbols is null or worker_max_symbols between 1 and 2000
  );

comment on column public.game_settings.worker_max_symbols is
  'How many instruments the worker quotes, and therefore how many the app lists. NULL keeps the worker''s own MAX_SYMBOLS.';

-- ---------------------------------------------------------------------
-- The universe, as participants see it.
-- ---------------------------------------------------------------------
-- security_invoker so the caller's RLS on `instruments` still applies: this
-- view narrows what is visible, it must never widen it.
create or replace view public.tradable_instruments
with (security_invoker = true) as
with cap as (
  select coalesce(
           (select worker_max_symbols from public.game_settings where id),
           2000
         ) as n
),
ranked as (
  select i.*, row_number() over (order by i.symbol) as rn
    from public.instruments i
   where i.is_tradable
)
select r.symbol, r.name, r.exchange, r.sector, r.asset_type,
       r.is_tradable, r.is_halted, r.halt_reason
  from ranked r, cap
 where r.rn <= cap.n;

grant select on public.tradable_instruments to authenticated;

comment on view public.tradable_instruments is
  'The instruments the worker is actually quoting: is_tradable, by symbol, capped at game_settings.worker_max_symbols. What participants may list, search and trade.';
