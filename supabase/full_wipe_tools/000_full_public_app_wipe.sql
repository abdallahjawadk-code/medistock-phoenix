-- =============================================================================
-- ██████████████████████████████████████████████████████████████████████████
-- ██                                                                        ██
-- ██   DANGER: FULL PUBLIC APP SCHEMA WIPE                                 ██
-- ██   MediStock Phoenix V2 — Supabase project: eyrzxgfkvqybjdgyphap       ██
-- ██                                                                        ██
-- ██   THIS FILE:                                                           ██
-- ██   • Drops the entire `public` schema with CASCADE                      ██
-- ██   • Destroys ALL public tables, views, functions, triggers, policies   ██
-- ██   • Destroys ALL data in public tables                                 ██
-- ██   • Then recreates a clean `public` schema for Phoenix                 ██
-- ██                                                                        ██
-- ██   THIS FILE DOES NOT:                                                  ██
-- ██   • Touch auth, storage, realtime, extensions, vault, graphql          ██
-- ██   • Delete Supabase Auth users                                         ██
-- ██   • Delete storage buckets                                             ██
-- ██   • Drop the database                                                  ██
-- ██                                                                        ██
-- ██   PREREQUISITE:                                                        ██
-- ██   • pg_dump backup must be completed first                             ██
-- ██   • FULL_PUBLIC_APP_WIPE_APPROVED=yes must be set                      ██
-- ██   • Run inspect_public_before_wipe.sql first                           ██
-- ██   • Apply migrations 001 → 002 → 003 → 004 after this file            ██
-- ██                                                                        ██
-- ██   DO NOT RUN VIA: npx supabase db push                                ██
-- ██   APPLY VIA: Supabase SQL Editor or psql                              ██
-- ██                                                                        ██
-- ██████████████████████████████████████████████████████████████████████████
-- =============================================================================

-- STEP 1: Verify we are on the expected project
-- The database name on Supabase is always 'postgres'.
-- The server_version and current_database are our safety checks.
do $$
declare
  v_db text;
begin
  select current_database() into v_db;
  if v_db != 'postgres' then
    raise exception 'SAFETY_ABORT: Expected database "postgres", got "%". Wrong connection?', v_db;
  end if;
  -- Confirm public schema exists (it always should, but sanity check)
  if not exists (select 1 from pg_namespace where nspname = 'public') then
    raise exception 'SAFETY_ABORT: public schema not found. Nothing to wipe.';
  end if;
  raise notice 'Safety check passed: database = %, public schema exists.', v_db;
end $$;

-- STEP 2: Confirm internal Supabase schemas are present (they must survive)
do $$
declare
  v_missing text[] := '{}';
  v_schema text;
begin
  foreach v_schema in array array['auth', 'storage', 'extensions'] loop
    if not exists (select 1 from pg_namespace where nspname = v_schema) then
      v_missing := array_append(v_missing, v_schema);
    end if;
  end loop;
  if array_length(v_missing, 1) > 0 then
    raise exception 'SAFETY_ABORT: Critical Supabase schemas missing: %. Aborting wipe.', v_missing;
  end if;
  raise notice 'Critical schemas confirmed present: auth, storage, extensions.';
end $$;

-- =============================================================================
-- STEP 3: DROP public schema WITH CASCADE
-- This removes: all tables, views, functions, triggers, policies, indexes,
-- sequences, types, and all data owned by the public schema.
-- Supabase system schemas (auth, storage, realtime, etc.) are untouched.
-- =============================================================================

drop schema if exists public cascade;

-- =============================================================================
-- STEP 4: RECREATE public schema
-- =============================================================================

create schema public;

-- =============================================================================
-- STEP 5: RESTORE required grants for Supabase operation
-- These grants are required by Supabase internals.
-- Note: service_role is a Supabase DB role — this is NOT the same as
-- exposing service_role in the frontend (which is forbidden).
-- =============================================================================

grant usage on schema public to postgres, anon, authenticated, service_role;
grant all   on schema public to postgres;
grant all   on schema public to service_role;

alter default privileges in schema public
  grant all on tables    to postgres, service_role;
alter default privileges in schema public
  grant all on functions to postgres, service_role;
alter default privileges in schema public
  grant all on sequences to postgres, service_role;

-- anon and authenticated need SELECT on tables exposed via API
alter default privileges in schema public
  grant select on tables to anon, authenticated;

-- =============================================================================
-- STEP 6: RESTORE required extensions
-- These were in extensions schema but public may need the functions accessible.
-- =============================================================================

-- pgcrypto: needed by Phoenix (gen_random_bytes, digest)
create extension if not exists "pgcrypto"  schema extensions;
create extension if not exists "pg_trgm"   schema extensions;
create extension if not exists "uuid-ossp" schema extensions;

-- Make extension functions accessible from public
-- (Supabase normally does this, but after schema recreate we ensure it)
grant usage on schema extensions to anon, authenticated, service_role;

-- =============================================================================
-- STEP 7: Verify wipe result
-- =============================================================================

do $$
declare
  v_count int;
begin
  select count(*) into v_count
  from pg_tables where schemaname = 'public';

  if v_count > 0 then
    raise exception 'WIPE_INCOMPLETE: % public tables still exist after wipe.', v_count;
  end if;

  raise notice 'WIPE_COMPLETE: public schema is clean. Tables: 0. Ready for Phoenix migrations.';
  raise notice 'NEXT STEPS:';
  raise notice '  1. Run supabase/migrations/001_phoenix_core_schema.sql';
  raise notice '  2. Run supabase/migrations/002_phoenix_rls_policies.sql';
  raise notice '  3. Run supabase/migrations/003_phoenix_rpc_lifecycle.sql';
  raise notice '  4. Run supabase/migrations/004_phoenix_seed_demo_data.sql';
  raise notice '  5. Run supabase/full_wipe_tools/create_first_admin_profile.sql';
  raise notice '  6. Run supabase/full_wipe_tools/verify_phoenix_after_full_wipe.sql';
end $$;

-- =============================================================================
-- END OF FULL PUBLIC APP WIPE
-- =============================================================================
