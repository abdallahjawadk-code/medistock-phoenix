-- ============================================================================
-- MIGRATION 021 — Port permission-based RLS + warehouse retirement
-- ============================================================================
-- MANUAL APPLY ONLY — DO NOT use `npx supabase db push`.
-- Apply via Supabase Dashboard > SQL Editor after a verified backup.
--
-- Prerequisites: 001, 002, 010 (permission matrix with
-- phoenix_profile_has_permission helper).
--
-- Purpose:
--   A. Makes distribution_points.warehouse_id nullable so ports can be
--      created without a warehouse (warehouse retirement).
--   B. Replaces the three role-based distribution_points write policies
--      (dp_write_superadmin, dp_write_hospitaladmin, dp_write_wh_manager)
--      with two permission-based policies that use the existing
--      phoenix_profile_has_permission(uuid, text) helper from migration 010:
--        - dp_read_perm: SELECT gated by ports.view + org scope
--        - dp_write_perm: INSERT/UPDATE/DELETE gated by per-operation
--          permission keys (ports.create, ports.edit) + org scope
--
-- How the new write policy works:
--   The USING clause (for UPDATE/DELETE) checks:
--     org scope AND (ports.edit OR super_admin)
--   The WITH CHECK clause (for INSERT/UPDATE) checks:
--     new.organization_id = own org AND (
--       INSERT: ports.create permission
--       UPDATE: ports.edit permission
--     )
--   super_admin always passes via the ALL_KEYS default in
--   role_permission_defaults (migration 010).
--
-- Limitation — ports.archive:
--   Postgres RLS cannot distinguish a normal field update from an
--   archive (status = 'archived'). Both are UPDATE operations.
--   Therefore ports.archive is enforced only at the frontend/UI layer
--   (the archive button is hidden unless the user has ports.archive).
--   At the DB layer, any user with ports.edit can perform updates
--   including status changes. A dedicated archive RPC would be needed
--   to enforce ports.archive at the DB level — that is a future phase.
--
-- What this does NOT do:
--   - Does NOT drop the warehouses table or any warehouse data.
--   - Does NOT touch item_availability, migrations 019/020, or auth.users.
--   - Does NOT add new permission keys (ports.view/create/edit/archive
--     already exist in migration 010).
--   - Does NOT add role_permission_defaults for institution_admin —
--     the platform admin grants permissions through the User Management
--     permission matrix.
--
-- Safety:
--   - Idempotent: DROP POLICY IF EXISTS before CREATE POLICY.
--   - Non-destructive: no data wipe, no table drops, no cascade,
--     no auth.users writes.
--   - Existing data untouched.
-- ============================================================================

BEGIN;

-- ============================================================================
-- A. Make warehouse_id nullable on distribution_points
-- ============================================================================

ALTER TABLE public.distribution_points
  ALTER COLUMN warehouse_id DROP NOT NULL;

-- ============================================================================
-- B. Replace role-based write policies with permission-based policies
-- ============================================================================

-- Drop old role-based policies (idempotent)
DROP POLICY IF EXISTS "dp_select_org"          ON distribution_points;
DROP POLICY IF EXISTS "dp_write_superadmin"    ON distribution_points;
DROP POLICY IF EXISTS "dp_write_hospitaladmin" ON distribution_points;
DROP POLICY IF EXISTS "dp_write_wh_manager"    ON distribution_points;
-- Drop new policies too (idempotent re-run)
DROP POLICY IF EXISTS "dp_read_perm"           ON distribution_points;
DROP POLICY IF EXISTS "dp_write_perm"          ON distribution_points;

-- Read policy: org-scoped + ports.view permission
CREATE POLICY "dp_read_perm" ON distribution_points
  FOR SELECT TO authenticated
  USING (
    phoenix_profile_has_permission(auth.uid(), 'ports.view')
    AND (
      phoenix_my_role() = 'super_admin'
      OR organization_id = phoenix_my_org()
    )
  );

-- Write policy: org-scoped + ports.create (insert) / ports.edit (update)
CREATE POLICY "dp_write_perm" ON distribution_points
  FOR ALL TO authenticated
  USING (
    -- For existing rows (UPDATE/DELETE): must have ports.edit + org scope
    (
      phoenix_my_role() = 'super_admin'
      OR (
        organization_id = phoenix_my_org()
        AND phoenix_profile_has_permission(auth.uid(), 'ports.edit')
      )
    )
  )
  WITH CHECK (
    -- For new/updated rows: org scope enforced + permission check
    (
      phoenix_my_role() = 'super_admin'
      OR (
        organization_id = phoenix_my_org()
        AND (
          phoenix_profile_has_permission(auth.uid(), 'ports.create')
          OR phoenix_profile_has_permission(auth.uid(), 'ports.edit')
        )
      )
    )
  );

-- ============================================================================
-- VERIFY
-- ============================================================================

DO $$
DECLARE
  v_nullable text;
  v_policy_count integer;
BEGIN
  -- A. warehouse_id must be nullable
  SELECT is_nullable INTO v_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'distribution_points'
    AND column_name = 'warehouse_id';
  ASSERT v_nullable = 'YES',
    'VERIFY FAILED: distribution_points.warehouse_id is still NOT NULL';

  -- B. Old role-based policies must be gone
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'distribution_points'
      AND policyname IN ('dp_select_org', 'dp_write_superadmin',
                         'dp_write_hospitaladmin', 'dp_write_wh_manager')
  ), 'VERIFY FAILED: old role-based policies still exist';

  -- C. New permission-based policies must exist
  SELECT count(*) INTO v_policy_count
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'distribution_points'
    AND policyname IN ('dp_read_perm', 'dp_write_perm');
  ASSERT v_policy_count = 2,
    'VERIFY FAILED: expected 2 permission-based policies, found ' || v_policy_count;

  RAISE NOTICE '021 ✓ warehouse_id nullable, permission-based RLS policies in place';
END $$;

COMMIT;

-- ============================================================================
-- END OF MIGRATION 021
--
-- Post-apply verification (run manually):
--
-- 1. Confirm warehouse_id is nullable:
--    SELECT column_name, is_nullable FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'distribution_points'
--      AND column_name = 'warehouse_id';
--
-- 2. Confirm only the new policies exist:
--    SELECT policyname, cmd, qual FROM pg_policies
--    WHERE schemaname = 'public' AND tablename = 'distribution_points'
--    ORDER BY policyname;
--    -- expect: dp_read_perm + dp_write_perm only (no dp_write_*)
--
-- 3. Confirm permission keys exist (no duplicates):
--    SELECT key FROM permission_keys
--    WHERE key IN ('ports.view','ports.create','ports.edit','ports.archive');
--    -- expect: 4 rows
--
-- NOTE on ports.archive:
--   Archive is enforced at the frontend layer only. At the DB layer,
--   ports.edit governs all UPDATE operations including status changes.
--   A dedicated archive RPC is recommended for strict DB-level enforcement.
-- ============================================================================
