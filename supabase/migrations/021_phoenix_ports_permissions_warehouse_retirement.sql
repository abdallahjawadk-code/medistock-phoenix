-- ============================================================================
-- MIGRATION 021 — Port permission-based RLS + warehouse retirement
-- ============================================================================
-- MANUAL APPLY ONLY — DO NOT use `npx supabase db push`.
-- Apply via Supabase Dashboard > SQL Editor after a verified backup.
--
-- Prerequisites: 001, 002, 003, 010 (permission matrix with
-- phoenix_profile_has_permission helper, archive_entity RPC).
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
--   C. Replaces archive_entity() RPC (migration 003) to enforce
--      ports.archive permission for distribution_point archiving instead
--      of the hardcoded role check. Warehouse and local_item branches
--      keep the original role-based check since those entity types do
--      not yet have dedicated permission keys.
--
-- How ports.archive is enforced at DB level:
--   The archive_entity() RPC is the ONLY path to archive a distribution
--   point (set status = 'archived'). The RLS write policy (dp_write_perm)
--   gates normal UPDATE via ports.edit. The RPC, being SECURITY DEFINER,
--   bypasses RLS and performs its own authorization:
--     - For distribution_point: requires ports.archive permission + org scope
--     - For warehouse/local_item: requires super_admin or hospital_admin role
--   This means a user with ports.edit but WITHOUT ports.archive can edit
--   port fields (name, type) but CANNOT archive via the RPC.
--
-- What this does NOT do:
--   - Does NOT drop the warehouses table or any warehouse data.
--   - Does NOT touch item_availability, migrations 019/020, or auth.users.
--   - Does NOT add new permission keys (ports.view/create/edit/archive
--     already exist in migration 010).
--   - Does NOT add role_permission_defaults for institution_admin.
--
-- Safety:
--   - Idempotent: DROP POLICY IF EXISTS, CREATE OR REPLACE FUNCTION.
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
    (
      phoenix_my_role() = 'super_admin'
      OR (
        organization_id = phoenix_my_org()
        AND phoenix_profile_has_permission(auth.uid(), 'ports.edit')
      )
    )
  )
  WITH CHECK (
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
-- C. Replace archive_entity() to enforce ports.archive for distribution_point
-- ============================================================================
-- CREATE OR REPLACE preserves the existing GRANT (authenticated) and
-- REVOKE (anon) from migration 003 — no need to re-grant.

CREATE OR REPLACE FUNCTION archive_entity(
  p_entity_type  text,
  p_entity_id    uuid,
  p_reason       text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role    text;
  v_org_id  uuid;
  v_allowed text[] := array['warehouse', 'distribution_point', 'local_item'];
  v_rows    int;
BEGIN
  v_role   := phoenix_my_role();
  v_org_id := phoenix_my_org();

  IF p_entity_type != ALL(v_allowed) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ENTITY_TYPE_NOT_ALLOWLISTED');
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'REASON_REQUIRED');
  END IF;

  -- Authorization: per-entity-type permission check
  CASE p_entity_type
    WHEN 'distribution_point' THEN
      -- Permission-based: requires ports.archive
      IF v_role <> 'super_admin'
         AND NOT phoenix_profile_has_permission(auth.uid(), 'ports.archive') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_PERMISSION');
      END IF;
    ELSE
      -- Warehouse / local_item: keep original role-based check
      IF v_role NOT IN ('super_admin', 'hospital_admin') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_ROLE');
      END IF;
  END CASE;

  CASE p_entity_type
    WHEN 'warehouse' THEN
      UPDATE warehouses
      SET status = 'archived', archived_at = now(), archived_by = auth.uid(), archive_reason = p_reason
      WHERE id = p_entity_id
        AND (v_role = 'super_admin' OR organization_id = v_org_id)
        AND archived_at IS NULL;
      GET DIAGNOSTICS v_rows = ROW_COUNT;

    WHEN 'distribution_point' THEN
      UPDATE distribution_points
      SET status = 'archived', archived_at = now(), archived_by = auth.uid(), archive_reason = p_reason
      WHERE id = p_entity_id
        AND (v_role = 'super_admin' OR organization_id = v_org_id)
        AND archived_at IS NULL;
      GET DIAGNOSTICS v_rows = ROW_COUNT;

    WHEN 'local_item' THEN
      UPDATE local_items
      SET status = 'archived', archived_at = now(), archived_by = auth.uid(), archive_reason = p_reason
      WHERE id = p_entity_id
        AND (v_role = 'super_admin' OR organization_id = v_org_id)
        AND archived_at IS NULL;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
  END CASE;

  IF v_rows = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND_OR_ALREADY_ARCHIVED');
  END IF;

  INSERT INTO audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, payload)
  VALUES (v_org_id, auth.uid(), v_role, 'archived', p_entity_type, p_entity_id,
          jsonb_build_object('reason', p_reason));

  RETURN jsonb_build_object('ok', true, 'archived', true);
END;
$$;

-- ============================================================================
-- VERIFY
-- ============================================================================

DO $$
DECLARE
  v_nullable text;
  v_policy_count integer;
  v_fn_exists boolean;
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

  -- D. archive_entity function must exist
  SELECT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'archive_entity'
  ) INTO v_fn_exists;
  ASSERT v_fn_exists,
    'VERIFY FAILED: archive_entity function not found';

  RAISE NOTICE '021 ✓ warehouse_id nullable, permission-based RLS + archive_entity with ports.archive enforcement';
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
--    -- expect: dp_read_perm + dp_write_perm only
--
-- 3. Confirm permission keys exist (no duplicates):
--    SELECT key FROM permission_keys
--    WHERE key IN ('ports.view','ports.create','ports.edit','ports.archive');
--    -- expect: 4 rows
--
-- 4. Test ports.archive enforcement:
--    As a user with ports.edit but WITHOUT ports.archive, call:
--      SELECT archive_entity('distribution_point', '<some-port-id>', 'test');
--    -- expect: {"ok": false, "error": "INSUFFICIENT_PERMISSION"}
--
--    As a user WITH ports.archive:
--      SELECT archive_entity('distribution_point', '<some-port-id>', 'test');
--    -- expect: {"ok": true, "archived": true}
-- ============================================================================
