-- =====================================================================
-- XAVAGE STOCK SIM :: 0011 -- notice password changes we can't prevent
-- =====================================================================
-- Credentials are organiser-issued, so the Accounts tab is only trustworthy
-- while the stored value is still the working password. mark_password_changed()
-- flags it stale, but that only fires when someone uses OUR form.
--
-- Supabase lets any signed-in user change their own password via
-- auth.updateUser(), and GoTrue has no per-role switch to forbid it. So a
-- participant with the browser console can change theirs regardless of what
-- the UI allows, and the organiser would keep seeing a password that silently
-- stopped working -- the worst outcome, because it looks fine.
--
-- Since it can't be prevented, detect it: watch encrypted_password on
-- auth.users and flag the credential stale however the change arrived.
--
-- Admin resets are unaffected: the admin route sets the password (firing this
-- trigger) and then upserts the credential with is_stale = false, so the
-- explicit write wins.
-- =====================================================================

create or replace function private.flag_credential_stale()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.encrypted_password is distinct from old.encrypted_password then
    update public.issued_credentials
       set is_stale = true
     where user_id = new.id;
  end if;
  return new;
end;
$$;

revoke execute on function private.flag_credential_stale() from public, anon, authenticated;

drop trigger if exists on_auth_password_changed on auth.users;
create trigger on_auth_password_changed
  after update of encrypted_password on auth.users
  for each row execute function private.flag_credential_stale();
