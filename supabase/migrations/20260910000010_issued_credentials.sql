-- =====================================================================
-- XAVAGE STOCK SIM :: 0010 -- admin-visible issued credentials
-- =====================================================================
-- Organisers issue every account and need to hand the credentials out (and
-- re-read them when someone loses their slip mid-competition). Passwords in
-- auth.users are bcrypt hashes, so they can never be read back -- instead we
-- record the password the ADMIN GENERATED at the moment it was issued.
--
-- Why this is acceptable here, and would not be in a normal product:
-- these are random codes minted by the organiser for a four-week game, never
-- a secret the participant chose. The real danger of storing passwords is
-- credential reuse -- someone's password here also opening their email. A
-- value the user never picked cannot be reused, so that risk does not apply.
--
-- Deliberately a SEPARATE TABLE, not a column on profiles: the
-- profiles_teammates_read policy lets team members read each other's rows, so
-- a password column there would be visible to teammates. Here the only policy
-- is admin-only.
-- =====================================================================

create table if not exists public.issued_credentials (
  user_id     uuid primary key references public.profiles (id) on delete cascade,
  password    text not null,
  -- set when the participant changes their own password: the stored value is
  -- then no longer what works, and showing it would actively mislead an
  -- organiser trying to get someone back in.
  is_stale    boolean not null default false,
  issued_at   timestamptz not null default now(),
  issued_by   uuid references public.profiles (id) on delete set null
);

create index if not exists issued_credentials_issued_by_idx
  on public.issued_credentials (issued_by);

alter table public.issued_credentials enable row level security;

-- Admins only. Participants cannot read this table at all, including their own
-- row -- they already know their password, and a readable row would be one
-- more way for it to leak.
drop policy if exists issued_credentials_admin_read on public.issued_credentials;
create policy issued_credentials_admin_read on public.issued_credentials
  for select to authenticated
  using ((select private.is_admin()));

-- Reads go through RLS above; every write is done by the admin API routes
-- using the service role, never by a client.
grant select on public.issued_credentials to authenticated;
grant select, insert, update, delete on public.issued_credentials to service_role;
revoke all on public.issued_credentials from anon;
revoke insert, update, delete on public.issued_credentials from authenticated;

-- ---------------------------------------------------------------------
-- Participants no longer have to rotate: the issued credential IS the
-- password. Existing participant accounts are switched over too, so nobody
-- gets bounced to /change-password mid-event.
-- ---------------------------------------------------------------------
alter table public.profiles alter column must_change_password set default false;

update public.profiles set must_change_password = false where role = 'participant';

-- ---------------------------------------------------------------------
-- If someone does change their own password, flag the stored value stale
-- rather than letting an organiser read one that no longer works.
-- ---------------------------------------------------------------------
create or replace function public.mark_password_changed()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  update public.profiles
     set must_change_password = false, last_login_at = now()
   where id = v_uid;

  -- The admin-issued value is no longer the working password.
  update public.issued_credentials
     set is_stale = true
   where user_id = v_uid;

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.mark_password_changed() from public, anon;
grant execute on function public.mark_password_changed() to authenticated;

-- ---------------------------------------------------------------------
-- The auth trigger still hardcoded must_change_password = true, so an account
-- created outside the admin UI would be bounced to /change-password and
-- immediately invalidate its own issued credential. Align it with the
-- admin-owned model.
--
-- The security property from migration 0006 is unchanged and still the point
-- of this function: role is NEVER read from raw_user_meta_data, because that
-- field is user-editable and a self-signup carrying {"role":"admin"} would
-- otherwise mint an administrator.
-- ---------------------------------------------------------------------
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name, role, must_change_password)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), split_part(coalesce(new.email, 'trader'), '@', 1)),
    'participant',   -- never from metadata
    false            -- organiser-issued credential is the password
  )
  on conflict (id) do nothing;
  return new;
end;
$$;
