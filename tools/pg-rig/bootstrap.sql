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

-- ---------------------------------------------------------------------------
-- THE PLATFORM AUTHORIZATION BASELINE THAT EXISTS *BEFORE* MIGRATION 001.
--
-- This block models the state a real Supabase project is provisioned WITH, at
-- project-creation time, before a single Phoenix migration runs. It is a
-- PLATFORM model: it must never encode Phoenix's own post-migration hardening,
-- because doing so would make the rig agree with Production for the wrong
-- reason and hide exactly the reproducibility defects it exists to expose.
--
-- H UNIT 2 (H-23) corrected TWO measured deficiencies here. Both are additive,
-- both are service_role only, and both are platform facts rather than Phoenix
-- policy:
--
--   1. FUNCTION default EXECUTE for service_role. A real Supabase project
--      carries a default privilege granting `service_role` EXECUTE on
--      functions. Default ACLs are NOT retroactive — they apply at CREATE
--      time only — so because this bootstrap never modelled it, every function
--      created BEFORE migration 109 (where the chain first installs its own
--      function default) silently missed it. Measured at ceiling 193 on a
--      clean replay: service_role reached 139/349 first-party functions;
--      Production reaches 315/349. The 176-function gap is exactly this.
--      At ceiling 108 the pre-109 population goes from 31/207 to 207/207.
--
--   2. CREATE on schema `public` for service_role. anon/authenticated get
--      USAGE only. One tuple, measured, not assumed.
--
-- WHAT WAS DELIBERATELY *NOT* CHANGED, AND WHY IT MATTERS
--
-- The blanket `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES/SEQUENCES TO
-- authenticated` below is RETAINED. It is not an invention: migration 108's
-- own root-cause section documents this exact statement, run once at project
-- creation, as the mechanism that silently handed `authenticated` TRUNCATE/
-- TRIGGER/REFERENCES on every custody-chain table — the bug 108 was written to
-- close. It is a faithful model of the platform, so it stays.
--
-- Its consequence is real and is NOT hidden here: on a clean replay
-- `authenticated` ends up with 263 relation privilege tuples across 77
-- relations, where Production has 79 across 75 — a 184-tuple excess of
-- INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER spread over 46 relations
-- created before 109, including `profiles`, `permission_keys`,
-- `role_permission_defaults`, `profile_permission_overrides` and `audit_logs`.
-- That excess (H-25), together with the two manual availability-writer
-- EXECUTE grants Production does not have (H-24), is the entire remaining
-- rig-vs-Production delta at 193: 186 tuples.
--
-- Deleting the `authenticated` default from this file would make that delta
-- disappear from the rig WITHOUT making the repository able to reproduce
-- Production from a fresh platform baseline — it would paper over a genuine
-- disaster-recovery defect. The owner-chosen remedy is forward-only instead:
-- migration 194 retroactively converges the legacy objects. See
-- supabase/migrations/194_phoenix_authorization_surface_reproducibility_convergence.sql.
--
-- Migration 109 remains IMMUTABLE and still does its job on top of this: after
-- 109 the default ACL for FUTURE objects denies anon/authenticated/PUBLIC and
-- keeps service_role. What changed here is only the state 109 inherits.
--
-- anon is still never blanket-granted — its access is managed explicitly by
-- the migrations (GRANT for public-QR reads, REVOKE for locked-down writers).
--
-- The authoritative contract for the post-194 surface is
-- tools/pg-rig/production-authorization-baseline-v194.json, enforced by
-- supabase/migrations/__tests__/pg-rig-production-authorization-baseline.dynamic.test.ts.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
-- H-23 (2): Production grants service_role CREATE on `public`;
-- anon/authenticated get USAGE only. Measured, not assumed.
GRANT CREATE ON SCHEMA public TO service_role;
-- Platform baseline, retained deliberately — see the note above. Migration 194
-- converges the legacy relations this produces; it is not repaired here.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated, service_role;
-- H-23 (1): the pre-109 function baseline. Scoped to `public` because that is
-- where Production carries it; migration 109 later adds its own global entry.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO service_role;

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
