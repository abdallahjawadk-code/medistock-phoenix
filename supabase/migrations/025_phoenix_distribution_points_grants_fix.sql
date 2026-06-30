-- ============================================================================
-- MIGRATION 025 — distribution_points table-level privilege grant
-- ============================================================================
-- MANUAL APPLY ONLY — DO NOT use `npx supabase db push`.
-- Apply via Supabase Dashboard > SQL Editor after a verified backup.
--
-- Prerequisites: migration 024 applied (3 RLS policies in place).
--
-- Root cause (MIGRATION-025-DISTRIBUTION-POINTS-GRANTS-FIX-A):
--   Port creation fails with HTTP 403 / PostgreSQL error 42501:
--     "permission denied for table distribution_points"
--   The Supabase PostgREST hint was:
--     "Grant the required privileges to the current role ...
--      ON public.distribution_points TO authenticated;"
--
--   PostgreSQL enforces TWO independent access layers:
--     1. Table-level privileges (GRANT/REVOKE) — controls WHETHER a role
--        can touch the table at all.
--     2. Row-level security (RLS policies) — controls WHICH rows a role
--        can see/write once table-level access is permitted.
--   Both must be satisfied. Migration 024 established the correct RLS
--   policies but the table-level SELECT / INSERT / UPDATE privileges were
--   never granted to the `authenticated` role (no GRANT statement exists
--   in migrations 001-024).
--
-- What this migration does:
--   A. Grant SELECT, INSERT, UPDATE on distribution_points to authenticated.
--   B. Revoke DELETE on distribution_points from authenticated (safety).
--   C. Revoke INSERT, UPDATE, DELETE on distribution_points from anon (safety).
--   D. VERIFY block — 11 assertions confirming final privilege and policy state.
--
-- Safe diagnostics to run BEFORE applying (confirm current grant state):
--
--   SELECT grantee, privilege_type
--   FROM information_schema.role_table_grants
--   WHERE table_schema = 'public'
--     AND table_name = 'distribution_points'
--     AND grantee IN ('authenticated', 'anon')
--   ORDER BY grantee, privilege_type;
--
--   Expected result BEFORE applying: 0 rows (or SELECT-only rows).
--   Expected result AFTER applying:
--     authenticated | INSERT
--     authenticated | SELECT
--     authenticated | UPDATE
--
-- ⚠️  auth.uid() CAVEAT:
--   Supabase Dashboard SQL Editor runs as postgres/service role — no JWT.
--   auth.uid() returns NULL in that context. Do NOT use RLS helper functions
--   (phoenix_my_role, phoenix_my_org, phoenix_profile_has_permission) in
--   diagnostic queries run from SQL Editor.
-- ============================================================================

BEGIN;

-- ============================================================================
-- A. Grant table-level read and write privileges to authenticated
-- ============================================================================
-- SELECT: required for RETURNING clause after INSERT and for reading ports list.
-- INSERT: required for creating distribution points (port creation).
-- UPDATE: required for editing distribution point name/status.
-- DELETE: intentionally NOT granted — soft-delete only via archive_entity().
GRANT SELECT, INSERT, UPDATE ON TABLE public.distribution_points TO authenticated;

-- ============================================================================
-- B. Revoke DELETE from authenticated (belt-and-suspenders)
-- ============================================================================
-- Idempotent: REVOKE on a privilege that was never granted is a no-op in PG.
REVOKE DELETE ON TABLE public.distribution_points FROM authenticated;

-- ============================================================================
-- C. Revoke all write privileges from anon (belt-and-suspenders)
-- ============================================================================
-- Anon users must never be able to write to distribution_points.
-- Idempotent: REVOKE on a privilege that was never granted is a no-op in PG.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.distribution_points FROM anon;

-- ============================================================================
-- D. VERIFY — 11 assertions
-- ============================================================================

DO $$
DECLARE
  v_policy_count integer;
BEGIN

  -- 1. authenticated has SELECT
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE grantee = 'authenticated'
      AND table_schema = 'public'
      AND table_name = 'distribution_points'
      AND privilege_type = 'SELECT'
  ), 'VERIFY FAILED: authenticated does not have SELECT on distribution_points';

  -- 2. authenticated has INSERT
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE grantee = 'authenticated'
      AND table_schema = 'public'
      AND table_name = 'distribution_points'
      AND privilege_type = 'INSERT'
  ), 'VERIFY FAILED: authenticated does not have INSERT on distribution_points';

  -- 3. authenticated has UPDATE
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE grantee = 'authenticated'
      AND table_schema = 'public'
      AND table_name = 'distribution_points'
      AND privilege_type = 'UPDATE'
  ), 'VERIFY FAILED: authenticated does not have UPDATE on distribution_points';

  -- 4. authenticated does NOT have DELETE
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE grantee = 'authenticated'
      AND table_schema = 'public'
      AND table_name = 'distribution_points'
      AND privilege_type = 'DELETE'
  ), 'VERIFY FAILED: authenticated has DELETE on distribution_points — REVOKE failed';

  -- 5. anon does NOT have INSERT
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE grantee = 'anon'
      AND table_schema = 'public'
      AND table_name = 'distribution_points'
      AND privilege_type = 'INSERT'
  ), 'VERIFY FAILED: anon has INSERT on distribution_points';

  -- 6. anon does NOT have UPDATE
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE grantee = 'anon'
      AND table_schema = 'public'
      AND table_name = 'distribution_points'
      AND privilege_type = 'UPDATE'
  ), 'VERIFY FAILED: anon has UPDATE on distribution_points';

  -- 7. anon does NOT have DELETE
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE grantee = 'anon'
      AND table_schema = 'public'
      AND table_name = 'distribution_points'
      AND privilege_type = 'DELETE'
  ), 'VERIFY FAILED: anon has DELETE on distribution_points';

  -- 8. Exactly 3 RLS policies still exist (migration 024 state preserved)
  SELECT count(*) INTO v_policy_count
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'distribution_points';
  ASSERT v_policy_count = 3,
    'VERIFY FAILED: expected exactly 3 total policies on distribution_points; found ' || v_policy_count;

  -- 9. No DELETE policy exists
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'distribution_points'
      AND cmd = 'DELETE'
  ), 'VERIFY FAILED: unexpected DELETE policy found on distribution_points';

  -- 10. No FOR ALL policy exists
  -- Note: pg_policies.cmd for FOR ALL policies is 'ALL', not '*'
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'distribution_points'
      AND cmd = 'ALL'
  ), 'VERIFY FAILED: unexpected FOR ALL policy found on distribution_points';

  -- 11. trg_guard_dp_archive trigger still exists (migration 024 preserved)
  ASSERT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'distribution_points' AND t.tgname = 'trg_guard_dp_archive'
  ), 'VERIFY FAILED: trg_guard_dp_archive trigger not found on distribution_points';

  RAISE NOTICE '025 ✓ distribution_points grants applied: authenticated has SELECT/INSERT/UPDATE (no DELETE); anon has no write grants; 3 RLS policies intact; archive trigger intact';
END $$;

COMMIT;

-- ============================================================================
-- END OF MIGRATION 025
--
-- Post-apply verification (run in Supabase SQL Editor):
--
-- 1. Confirm authenticated privileges:
--    SELECT grantee, privilege_type
--    FROM information_schema.role_table_grants
--    WHERE table_schema = 'public'
--      AND table_name = 'distribution_points'
--      AND grantee IN ('authenticated', 'anon')
--    ORDER BY grantee, privilege_type;
--    Expected: 3 rows (authenticated: INSERT, SELECT, UPDATE)
--
-- 2. Confirm RLS policies unchanged:
--    SELECT policyname, cmd, roles
--    FROM pg_policies
--    WHERE schemaname = 'public' AND tablename = 'distribution_points'
--    ORDER BY cmd, policyname;
--    Expected: 3 rows (dp_insert_perm/INSERT, dp_read_perm/SELECT, dp_update_perm/UPDATE)
--
-- 3. Confirm archive trigger still present:
--    SELECT tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
--    WHERE c.relname = 'distribution_points';
--    Expected: trg_guard_dp_archive
-- ============================================================================
