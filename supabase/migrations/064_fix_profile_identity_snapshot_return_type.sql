-- ============================================================================
-- PROFILE-IDENTITY-SNAPSHOT-RETURN-TYPE-064-A
--
-- Fix SQLSTATE 42804 in public.get_profile_identity_snapshot by aligning the
-- third returned expression with the declared text result type.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ROOT CAUSE
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 013 declared the function's third OUT column as `email text`, but
-- the body returns auth.users.email, which Supabase declares as
-- `character varying(255)`. plpgsql validates the query structure against the
-- declared result type at RETURN QUERY, so every call raises:
--
--   SQLSTATE 42804 — structure of query does not match function result type
--   Returned type character varying(255) does not match expected type text
--   in column 3.
--
-- The other four columns already match their declarations exactly:
--   1. profiles.identity_version  integer (013)
--   2. profiles.full_name         text    (001)
--   4. profiles.role              text    (001)
--   5. profiles.organization_id   uuid    (001)
--
-- ─────────────────────────────────────────────────────────────────────────────
-- FIX
-- ─────────────────────────────────────────────────────────────────────────────
-- Cast the third expression to text: `u.email::text`. The declared signature is
-- kept rather than widened to varchar(255), because `text` is the type every
-- caller and snapshot column already expects.
--
-- Deliberately unchanged:
--   * function name and (uuid) parameter list
--   * RETURNS TABLE signature and column order
--   * SECURITY DEFINER
--   * SET search_path = public, pg_temp
--   * LANGUAGE plpgsql
--   * privileges — CREATE OR REPLACE preserves the existing ACL, so 013's
--     `grant execute ... to authenticated` is neither re-issued nor widened
--
-- This migration creates no object, alters no table, touches no policy, trigger,
-- grant or revoke, and reads/writes no business data.
-- ============================================================================

create or replace function public.get_profile_identity_snapshot(p_profile_id uuid)
returns table (
  identity_version  integer,
  full_name         text,
  email             text,
  role              text,
  organization_id   uuid
)
security definer
set search_path = public, pg_temp
language plpgsql as $$
begin
  return query
    select
      p.identity_version,
      p.full_name,
      u.email::text,
      p.role,
      p.organization_id
    from public.profiles p
    left join auth.users u on u.id = p.id
    where p.id = p_profile_id;
end;
$$;
