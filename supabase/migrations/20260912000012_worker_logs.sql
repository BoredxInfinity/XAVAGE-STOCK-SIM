-- =====================================================================
-- XAVAGE STOCK SIM :: 0012 -- worker log stream
-- =====================================================================
-- The price worker runs on a box nobody is watching. When it went quiet for
-- 50 minutes the only evidence was a stale `system_state.last_tick_at`, and
-- the journal on the instance was volatile, so the reason was gone by the
-- time anyone looked.
--
-- This gives the worker somewhere durable to talk, readable from Admin ->
-- Control room. It is deliberately NOT a firehose: the worker ships one row
-- per cycle plus anything at WARNING or above, batched, and prunes to 48
-- hours. At a 5s cadence that is ~17k rows a day, which is small and bounded.
-- =====================================================================

create table if not exists public.worker_logs (
  id          bigserial primary key,
  ts          timestamptz not null default now(),
  level       text        not null check (level in ('DEBUG','INFO','WARNING','ERROR','CRITICAL')),
  event       text        not null,   -- machine-readable: cycle, history, startup, backfill...
  message     text        not null,   -- the human-readable line
  cycle       bigint,                 -- which cycle it belongs to, when relevant
  duration_ms integer,                -- how long the stage took
  rss_mb      integer,                -- worker resident memory at the time
  detail      jsonb,                  -- stage-specific numbers, free-form
  source      text        not null default 'worker'
);

-- The panel reads "newest first, optionally filtered by level", and the
-- pruner deletes by age. Both are covered here.
create index if not exists worker_logs_ts_idx    on public.worker_logs (ts desc);
create index if not exists worker_logs_level_idx on public.worker_logs (level, ts desc);
create index if not exists worker_logs_event_idx on public.worker_logs (event, ts desc);

alter table public.worker_logs enable row level security;

-- Operational detail is for organisers only. Participants have no business
-- seeing feed internals, and a stack trace could leak a symbol list or a URL.
drop policy if exists worker_logs_admin_read on public.worker_logs;
create policy worker_logs_admin_read on public.worker_logs
  for select to authenticated
  using ((select private.is_admin()));

grant select on public.worker_logs to authenticated;
grant all    on public.worker_logs to service_role;
grant usage, select on sequence public.worker_logs_id_seq to service_role;

-- ---------------------------------------------------------------------
-- Retention. Called by the worker on a slow timer rather than by a cron, so
-- the table cannot grow without bound if the Vercel cron is ever removed.
-- ---------------------------------------------------------------------
create or replace function public.prune_worker_logs(p_hours integer default 48)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  removed integer;
begin
  delete from public.worker_logs
   where ts < now() - make_interval(hours => greatest(p_hours, 1));
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.prune_worker_logs(integer) from public, anon, authenticated;
grant execute on function public.prune_worker_logs(integer) to service_role;

comment on table public.worker_logs is
  'Durable operational log from the price worker. Admin-readable, 48h retention.';
