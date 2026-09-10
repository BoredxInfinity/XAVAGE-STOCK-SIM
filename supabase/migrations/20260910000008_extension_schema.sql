-- =====================================================================
-- XAVAGE STOCK SIM :: 0008 -- move pg_trgm out of the public schema
-- =====================================================================
-- `supabase db advisors` flags extensions living in `public` (lint 0014):
-- everything in an exposed schema is reachable through the Data API, so
-- pg_trgm's functions would be callable by any signed-in participant.
-- pgcrypto is already in `extensions` on Supabase, so only pg_trgm moved.
--
-- Safe for the existing trigram indexes on public.instruments: an index
-- stores its operator class by OID, so relocating the extension does not
-- invalidate it. Verified below rather than assumed.
--
-- Written as a follow-up migration instead of an edit to 0001, because 0001
-- is already applied remotely and editing it would diverge the checksums.
-- =====================================================================

do $$
declare
  v_schema text;
  v_indexes integer;
begin
  select n.nspname into v_schema
    from pg_extension e join pg_namespace n on n.oid = e.extnamespace
   where e.extname = 'pg_trgm';

  if v_schema is null then
    raise notice 'pg_trgm is not installed; nothing to move';
    return;
  end if;

  if v_schema = 'public' then
    execute 'alter extension pg_trgm set schema extensions';
    raise notice 'pg_trgm moved from public to extensions';
  else
    raise notice 'pg_trgm already in %; leaving it alone', v_schema;
  end if;

  -- The two trigram indexes that power ticker search must still exist and
  -- still be bound to a gin_trgm_ops operator class.
  select count(*) into v_indexes
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    join pg_opclass o on o.oid = any (i.indclass::oid[])
   where c.relname in ('instruments_symbol_trgm_idx', 'instruments_name_trgm_idx')
     and o.opcname = 'gin_trgm_ops';

  if v_indexes < 2 then
    raise exception 'trigram indexes did not survive the extension move (found %)', v_indexes;
  end if;

  raise notice 'ticker-search trigram indexes intact (%)', v_indexes;
end $$;
