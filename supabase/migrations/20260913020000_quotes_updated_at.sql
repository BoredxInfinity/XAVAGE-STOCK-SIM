-- =====================================================================
-- XAVAGE STOCK SIM :: quotes.updated_at means "when the row was written"
-- =====================================================================
-- The column had two writers disagreeing about what it meant. The Vercel cron
-- fallback set it to now(); the worker set it to the quote's own market
-- timestamp -- the same value it puts in `quote_time` (worker/feed.py). The
-- table has both columns precisely so they can differ: `quote_time` is when
-- the price is from, `updated_at` is when we stored it.
--
-- Nothing rendered the column, so the disagreement was invisible -- until the
-- reconcile poll in MarketDataProvider started using it as a cursor
-- ("give me rows newer than the newest I hold"). Under the worker's meaning
-- that cursor silently loses rows: a thin symbol written at 15:00 carrying a
-- 14:40 last trade sorts behind a cursor set from a liquid symbol, so its
-- update is never fetched. The client would sit on a stale price for that
-- symbol with nothing to indicate it.
--
-- A trigger rather than a fix in the worker: this has to hold for every
-- writer, including the cron fallback and anything added later, and it is the
-- cursor's correctness that depends on it.
-- =====================================================================

create or replace function private.stamp_quote_written_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists quotes_stamp_updated_at on public.quotes;
create trigger quotes_stamp_updated_at
  before insert or update on public.quotes
  for each row execute function private.stamp_quote_written_at();

comment on function private.stamp_quote_written_at() is
  'Forces quotes.updated_at to the write time, so it can be used as a reliable delta cursor by clients.';
