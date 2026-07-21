-- ===========================================================================
-- Disposable-rig bootstrap: the minimal Supabase-shaped surface that the
-- canonical migrations assume already exists in a real Supabase project.
-- Applied to a THROWAWAY PostgreSQL cluster ONLY. Never to production.
--
-- Provides exactly what migrations 001+ reference and nothing more:
--   * roles: anon, authenticated, service_role (NOLOGIN, as in Supabase)
--   * schema auth + auth.users (only the columns the migrations read)
--   * auth.uid()  reading a per-connection GUC we control to impersonate users
-- ===========================================================================

DO $$ BEGIN CREATE ROLE anon          NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role  NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT anon, authenticated, service_role TO CURRENT_USER;

CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

-- Supabase grants table/sequence/function privileges to these roles by default,
-- with RLS doing the actual row gating on top. Emulate that so `authenticated`
-- has the TABLE-LEVEL privileges the migrations assume (they only ever add
-- explicit REVOKEs where a table must be locked down — those REVOKEs still win,
-- exactly as in production). Set BEFORE the migrations create their objects.
-- Grant TABLE/SEQUENCE privileges to authenticated + service_role (RLS gates
-- rows on top). Do NOT blanket-grant to anon or touch FUNCTION execute: anon's
-- table access and every function's EXECUTE are managed explicitly by the
-- migrations (GRANT for public-QR reads, REVOKE for locked-down writers), and
-- Postgres already grants EXECUTE to PUBLIC on new functions. Over-granting here
-- would mask the very posture those migrations assert.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated, service_role;

CREATE TABLE IF NOT EXISTS auth.users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              text,
  phone              text,
  raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_app_meta_data  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON auth.users TO authenticated, service_role;

-- auth.uid(): Supabase reads the verified JWT 'sub' claim. The rig drives it
-- from a per-connection GUC so a test can impersonate any principal:
--   SELECT set_config('request.jwt.claim.sub', '<uuid>', true);  -- txn-local
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE
  AS $fn$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $fn$;

CREATE OR REPLACE FUNCTION auth.role() RETURNS text
  LANGUAGE sql STABLE
  AS $fn$ SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), 'authenticated') $fn$;

CREATE OR REPLACE FUNCTION auth.email() RETURNS text
  LANGUAGE sql STABLE
  AS $fn$ SELECT NULLIF(current_setting('request.jwt.claim.email', true), '') $fn$;

GRANT EXECUTE ON FUNCTION auth.uid(), auth.role(), auth.email() TO anon, authenticated, service_role;
