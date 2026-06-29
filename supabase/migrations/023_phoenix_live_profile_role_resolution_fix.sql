-- ============================================================================
-- MIGRATION 023 — Fix dp_read_perm SELECT policy super_admin bypass
-- ============================================================================
-- MANUAL APPLY ONLY — DO NOT use `npx supabase db push`.
-- Apply via Supabase Dashboard > SQL Editor after a verified backup.
--
-- Prerequisites: 021 (dp_read_perm / dp_insert_perm / dp_update_perm)
--
-- Root cause diagnosed (LIVE-PORT-INSERT-RLS-PROFILE-DIAG-A):
--
--   Migration 021 created dp_read_perm (SELECT) as:
--
--     USING (
--       phoenix_profile_has_permission(auth.uid(), 'ports.view')   ← required even for super_admin
--       AND (
--         phoenix_my_role() = 'super_admin'
--         OR organization_id = phoenix_my_org()
--       )
--     )
--
--   This is inconsistent with dp_insert_perm and dp_update_perm, which both
--   have the correct structure:
--
--     phoenix_my_role() = 'super_admin'         ← first — bypasses permission check
--     OR (org_scope AND permission_check)       ← second — scoped non-super check
--
--   Because PostgreSQL applies SELECT row-security to INSERT RETURNING, the
--   asymmetry in dp_read_perm causes `.insert(row).select().single()` to fail
--   for super_admin whenever phoenix_profile_has_permission(auth.uid(),
--   'ports.view') returns false — even though the INSERT itself succeeded
--   (dp_insert_perm has the correct super_admin bypass). PostgREST receives 0
--   rows from RETURNING, raises PGRST116, and the frontend shows
--   port_create_error.
--
--   phoenix_profile_has_permission can return false for super_admin when:
--     • migration 010 role_permission_defaults seed was partial or missed
--       ports.view (e.g., applied before all keys were in permission_keys)
--     • a profile_permission_overrides row explicitly denies ports.view
--     • any future DB-state drift removes the role default row
--
-- Fix:
--   Rewrite dp_read_perm to match the structure of dp_insert_perm and
--   dp_update_perm — super_admin bypass first, non-super org-scoped check
--   second:
--
--     USING (
--       phoenix_my_role() = 'super_admin'
--       OR (
--         phoenix_profile_has_permission(auth.uid(), 'ports.view')
--         AND organization_id = phoenix_my_org()
--       )
--     )
--
-- Security:
--   - super_admin already has full INSERT and UPDATE bypass via dp_insert_perm
--     / dp_update_perm. Adding the same bypass to dp_read_perm is consistent,
--     not a new privilege.
--   - Non-super users still require BOTH ports.view AND same-org scope to
--     read distribution_points — no weakening.
--   - institution_admin has ports.view (migration 012) + org scope → SELECT
--     still passes. They still lack ports.create by default → INSERT still
--     fails (42501) until a super_admin explicitly grants ports.create via the
--     permission matrix. This is expected/intended behavior.
--   - No data changes, no DROP TABLE, no DROP COLUMN, no TRUNCATE.
--   - Idempotent: DROP POLICY IF EXISTS + CREATE POLICY is safe to re-run.
--
-- What this does NOT do:
--   - Does NOT grant ports.create to institution_admin automatically (admin
--     must grant explicitly via permission matrix).
--   - Does NOT modify dp_insert_perm or dp_update_perm (already correct).
--   - Does NOT change phoenix_my_role(), phoenix_my_org(), or
--     phoenix_profile_has_permission() helper definitions.
--   - Does NOT touch any other table, RPC, or trigger.
--
-- Pre-apply diagnostic:
--
-- ⚠️  auth.uid() CAVEAT — IMPORTANT:
--   Running auth.uid() in Supabase Dashboard SQL Editor as the postgres/service-role
--   user returns NULL because there is no JWT in that context. This makes queries
--   like phoenix_my_role() or phoenix_profile_has_permission(auth.uid(), ...) useless
--   when run there directly.
--
--   Safe alternatives:
--     A. (Recommended) Open browser DevTools → Console after login and attempt port
--        creation. Commit 5ec29db added [phoenix] createDistributionPoint insert failed:
--        logging with the exact Supabase error code, message, details, hint, and
--        sanitized payload — this is the ground truth for live diagnosis.
--     B. Simulate auth.uid() using a known super_admin profile UUID. Replace <your-uuid>
--        with the actual UUID from auth.users / profiles:
--          SELECT
--            phoenix_profile_has_permission('<your-uuid>'::uuid, 'ports.view')   AS has_view,
--            phoenix_profile_has_permission('<your-uuid>'::uuid, 'ports.create') AS has_create;
--
-- Diagnostics safe to run in SQL Editor (no auth.uid() dependency):
--
--   -- 1. Confirm super_admin role_permission_defaults exist for ports.view
--   SELECT permission_key, allowed
--   FROM role_permission_defaults
--   WHERE role = 'super_admin'
--     AND permission_key IN ('ports.view', 'ports.create', 'ports.edit')
--   ORDER BY permission_key;
--   -- expect: 3 rows all allowed = true
--
--   -- 2. Confirm current policies on distribution_points
--   SELECT policyname, cmd, qual, with_check
--   FROM pg_policies
--   WHERE schemaname = 'public' AND tablename = 'distribution_points'
--   ORDER BY cmd, policyname;
--   -- expect: dp_insert_perm (INSERT), dp_read_perm (SELECT), dp_update_perm (UPDATE)
--   -- must NOT see: dp_write_perm, dp_write_superadmin, dp_write_hospitaladmin,
--   --               dp_write_wh_manager, any cmd='DELETE'
--
--   -- 3. Confirm archive guard trigger still exists
--   SELECT t.tgname FROM pg_trigger t
--   JOIN pg_class c ON c.oid = t.tgrelid
--   WHERE c.relname = 'distribution_points' AND t.tgname = 'trg_guard_dp_archive';
--   -- expect: 1 row
-- ============================================================================

BEGIN;

-- ============================================================================
-- Fix dp_read_perm: add super_admin bypass (consistent with INSERT/UPDATE)
-- ============================================================================

DROP POLICY IF EXISTS "dp_read_perm" ON distribution_points;

CREATE POLICY "dp_read_perm" ON distribution_points
  FOR SELECT TO authenticated
  USING (
    phoenix_my_role() = 'super_admin'
    OR (
      phoenix_profile_has_permission(auth.uid(), 'ports.view')
      AND organization_id = phoenix_my_org()
    )
  );

-- ============================================================================
-- VERIFY
-- ============================================================================

DO $$
DECLARE
  v_read_src   text;
  v_insert_src text;
  v_update_src text;
BEGIN
  -- Load policy qual (USING clause) for each policy
  SELECT qual INTO v_read_src
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'distribution_points'
    AND policyname = 'dp_read_perm';

  SELECT qual INTO v_insert_src
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'distribution_points'
    AND policyname = 'dp_insert_perm';

  SELECT qual INTO v_update_src
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'distribution_points'
    AND policyname = 'dp_update_perm';

  -- A. dp_read_perm must exist
  ASSERT v_read_src IS NOT NULL,
    'VERIFY FAILED: dp_read_perm policy not found on distribution_points';

  -- B. dp_read_perm must reference phoenix_my_role for super_admin bypass
  ASSERT v_read_src LIKE '%phoenix_my_role%',
    'VERIFY FAILED: dp_read_perm does not reference phoenix_my_role()';

  -- C. dp_read_perm must still reference ports.view for non-super users
  ASSERT v_read_src LIKE '%ports.view%',
    'VERIFY FAILED: dp_read_perm does not reference ports.view permission';

  -- D. dp_insert_perm must still exist (must not have been dropped)
  ASSERT v_insert_src IS NOT NULL,
    'VERIFY FAILED: dp_insert_perm policy missing from distribution_points';

  -- E. dp_update_perm must still exist
  ASSERT v_update_src IS NOT NULL,
    'VERIFY FAILED: dp_update_perm policy missing from distribution_points';

  -- F. No DELETE policy must exist
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'distribution_points'
      AND cmd = 'DELETE'
  ), 'VERIFY FAILED: unexpected DELETE policy found on distribution_points';

  -- G. Legacy FOR ALL policy must not exist
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'distribution_points'
      AND policyname IN ('dp_write_perm', 'dp_write_superadmin',
                         'dp_write_hospitaladmin', 'dp_write_wh_manager',
                         'dp_select_org')
  ), 'VERIFY FAILED: legacy role-based policy still exists on distribution_points';

  RAISE NOTICE '023 ✓ dp_read_perm SELECT policy has super_admin bypass; INSERT/UPDATE unchanged';
END $$;

COMMIT;

-- ============================================================================
-- END OF MIGRATION 023
--
-- Post-apply verification (run manually as super_admin):
--
-- 1. Confirm dp_read_perm has super_admin bypass first:
--    SELECT policyname, cmd, qual
--    FROM pg_policies
--    WHERE schemaname = 'public' AND tablename = 'distribution_points'
--    ORDER BY cmd;
--    -- dp_read_perm qual should start with:
--    --   (phoenix_my_role() = 'super_admin') OR (...)
--    -- NOT with phoenix_profile_has_permission at top level
--
-- 2. Smoke test — insert a test port via SQL Editor (runs as postgres/service role,
--    so RLS is bypassed — this only verifies the INSERT/RETURNING plumbing, not RLS):
--    INSERT INTO distribution_points (organization_id, name, name_ar, point_type)
--    SELECT id, 'smoke-test', 'smoke-test', 'dispensing'
--    FROM organizations LIMIT 1
--    RETURNING id, organization_id, point_type;
--    -- expect: 1 row returned
--    -- then DELETE that row manually (service role bypasses RLS in SQL Editor)
--    ⚠️  To test RLS specifically, use the browser UI or the authenticated Supabase client —
--    SQL Editor as postgres/service role bypasses all RLS policies.
--
-- 3. Smoke test — as institution_admin WITHOUT ports.create, try insert:
--    -- expect: "new row violates row-level security policy" (42501) — CORRECT
--
-- 4. After UI smoke test (npm run dev):
--    super_admin → select institution → Add Port → create
--    -- expect: port created + QR generated (no port_create_error)
-- ============================================================================
