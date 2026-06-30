-- ============================================================================
-- MIGRATION 024 — distribution_points RLS live-state repair
-- ============================================================================
-- MANUAL APPLY ONLY — DO NOT use `npx supabase db push`.
-- Apply via Supabase Dashboard > SQL Editor after a verified backup.
--
-- Prerequisites: 020, warehouse_id must already be nullable (021 ALTER TABLE)
--
-- Root cause (DISTRIBUTION-POINTS-RLS-LIVE-STATE-REPAIR-A):
--   Migration 023 failed with:
--     P0004: VERIFY FAILED: dp_insert_perm policy missing from distribution_points
--
--   This means the live DB has an inconsistent policy state. Migration 021
--   wraps all its DDL in BEGIN...COMMIT, so the ALTER TABLE that made
--   warehouse_id nullable must have been applied separately (before 021's
--   transaction ran). When 021 ran as a full transaction, it failed the VERIFY
--   block (either old policies were still present, or permission_keys rows were
--   missing), causing a full rollback — leaving no split policies (dp_read_perm,
--   dp_insert_perm, dp_update_perm), no archive trigger, and likely the old
--   role-based policies from migration 002 still in place.
--
-- What this migration does:
--   A. Idempotently drops ALL known distribution_points policy names (old and new).
--   B. Creates the 3 final permission-based policies — identical to the target
--      state defined by migrations 021 + 023 combined:
--        dp_read_perm  (SELECT) — super_admin bypass first (023 fix applied here)
--        dp_insert_perm (INSERT)
--        dp_update_perm (UPDATE)
--   C. Re-creates phoenix_guard_dp_archive_update() trigger function (from 021).
--   D. Re-creates trg_guard_dp_archive trigger (from 021).
--   E. Re-creates archive_entity() with ports.archive permission check (from 021).
--   F. Verify block — 10 assertions confirming final state.
--
-- ⚠️  auth.uid() CAVEAT:
--   Supabase Dashboard SQL Editor runs as postgres/service role — no JWT.
--   auth.uid() returns NULL in that context. Phoenix RLS helper functions
--   (phoenix_my_role, phoenix_my_org, phoenix_profile_has_permission) all
--   depend on auth.uid() internally. Do NOT use them in diagnostic queries
--   run from SQL Editor.
--   Safe diagnostic alternatives:
--     A. Browser DevTools console: commit 5ec29db logs the exact Supabase
--        error code/message on port create failure.
--     B. Pass a known profile UUID directly:
--          SELECT phoenix_profile_has_permission('<super-admin-uuid>'::uuid, 'ports.view');
--
-- Safe diagnostics to run BEFORE applying (no auth.uid() dependency):
--
--   -- Confirm warehouse_id is already nullable (prerequisite)
--   SELECT is_nullable FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'distribution_points'
--     AND column_name = 'warehouse_id';
--   -- expect: YES
--
--   -- Inspect current live policies on distribution_points
--   SELECT policyname, cmd, qual FROM pg_policies
--   WHERE schemaname = 'public' AND tablename = 'distribution_points'
--   ORDER BY cmd, policyname;
--   -- Shows what policies are currently active
--
--   -- Confirm permission keys exist (needed for the permission-based policies)
--   SELECT key FROM permission_keys
--   WHERE key IN ('ports.view','ports.create','ports.edit','ports.archive')
--   ORDER BY key;
--   -- expect: 4 rows (must be present from migration 010)
--
-- What this does NOT do:
--   - Does NOT alter warehouse_id (already nullable — prerequisite).
--   - Does NOT create a DELETE policy on distribution_points.
--   - Does NOT create a FOR ALL policy on distribution_points.
--   - Does NOT change permission_keys or role_permission_defaults tables.
--   - Does NOT modify phoenix_my_role(), phoenix_my_org(), or
--     phoenix_profile_has_permission() functions.
--   - Does NOT touch any other table, trigger, or RPC outside of
--     distribution_points and its archive helpers.
--   - Does NOT expose service_role keys.
--   - Does NOT write to auth.users.
--   - No DROP TABLE, DROP COLUMN, TRUNCATE, destructive DELETE, unsafe CASCADE.
--
-- Safety:
--   - All DDL is idempotent: DROP IF EXISTS + CREATE / CREATE OR REPLACE.
--   - Wrapped in BEGIN...COMMIT — rolls back fully on any VERIFY failure.
--   - No data is changed.
-- ============================================================================

BEGIN;

-- ============================================================================
-- A. Drop all known distribution_points policy names (old + new, idempotent)
-- ============================================================================

-- Old role-based policies from migration 002
DROP POLICY IF EXISTS "dp_select_org"          ON distribution_points;
DROP POLICY IF EXISTS "dp_write_superadmin"    ON distribution_points;
DROP POLICY IF EXISTS "dp_write_hospitaladmin" ON distribution_points;
DROP POLICY IF EXISTS "dp_write_wh_manager"    ON distribution_points;

-- Intermediate / legacy FOR ALL policy
DROP POLICY IF EXISTS "dp_write_perm"          ON distribution_points;

-- New split policies from migration 021 / 023 (drop to recreate cleanly)
DROP POLICY IF EXISTS "dp_read_perm"           ON distribution_points;
DROP POLICY IF EXISTS "dp_insert_perm"         ON distribution_points;
DROP POLICY IF EXISTS "dp_update_perm"         ON distribution_points;

-- ============================================================================
-- B. Create the 3 final permission-based policies
--    dp_read_perm   — SELECT  — 023 shape: super_admin bypass first
--    dp_insert_perm — INSERT  — 021 shape: super_admin OR (org + ports.create)
--    dp_update_perm — UPDATE  — 021 shape: super_admin OR (org + ports.edit)
-- ============================================================================

-- Read policy: super_admin bypass first (023 fix), then org-scoped + ports.view
CREATE POLICY "dp_read_perm" ON distribution_points
  FOR SELECT TO authenticated
  USING (
    phoenix_my_role() = 'super_admin'
    OR (
      phoenix_profile_has_permission(auth.uid(), 'ports.view')
      AND organization_id = phoenix_my_org()
    )
  );

-- Insert policy: super_admin bypass first, then org-scoped + ports.create
-- FOR INSERT has no USING clause (only WITH CHECK applies).
CREATE POLICY "dp_insert_perm" ON distribution_points
  FOR INSERT TO authenticated
  WITH CHECK (
    phoenix_my_role() = 'super_admin'
    OR (
      organization_id = phoenix_my_org()
      AND phoenix_profile_has_permission(auth.uid(), 'ports.create')
    )
  );

-- Update policy: super_admin bypass first, then org-scoped + ports.edit
-- Archive-related fields are further guarded by trg_guard_dp_archive (ports.archive).
CREATE POLICY "dp_update_perm" ON distribution_points
  FOR UPDATE TO authenticated
  USING (
    phoenix_my_role() = 'super_admin'
    OR (
      organization_id = phoenix_my_org()
      AND phoenix_profile_has_permission(auth.uid(), 'ports.edit')
    )
  )
  WITH CHECK (
    phoenix_my_role() = 'super_admin'
    OR (
      organization_id = phoenix_my_org()
      AND phoenix_profile_has_permission(auth.uid(), 'ports.edit')
    )
  );

-- No DELETE policy: direct row deletion is prohibited.
-- Port retirement must go through archive_entity() which sets status='archived'.

-- ============================================================================
-- C. Re-create phoenix_guard_dp_archive_update() trigger function (from 021)
--    Prevents direct UPDATE to archived status without ports.archive permission.
--    archive_entity() bypasses this check via the phoenix.archive_bypass flag.
-- ============================================================================

CREATE OR REPLACE FUNCTION phoenix_guard_dp_archive_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Allow if called from archive_entity() (flag set by RPC)
  IF current_setting('phoenix.archive_bypass', true) = 'true' THEN
    RETURN NEW;
  END IF;

  -- Block organization_id tampering for non-super users
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    IF phoenix_my_role() <> 'super_admin' THEN
      RAISE EXCEPTION 'CROSS_INSTITUTION_UPDATE_BLOCKED';
    END IF;
  END IF;

  -- Detect archive-related field changes
  IF (NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'archived')
     OR (NEW.archived_at IS DISTINCT FROM OLD.archived_at)
     OR (NEW.archived_by IS DISTINCT FROM OLD.archived_by)
     OR (NEW.archive_reason IS DISTINCT FROM OLD.archive_reason) THEN
    -- Require ports.archive permission
    IF phoenix_my_role() <> 'super_admin'
       AND NOT phoenix_profile_has_permission(auth.uid(), 'ports.archive') THEN
      RAISE EXCEPTION 'PORT_ARCHIVE_PERMISSION_REQUIRED';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- ============================================================================
-- D. Re-create trg_guard_dp_archive trigger (from 021)
-- ============================================================================

DROP TRIGGER IF EXISTS trg_guard_dp_archive ON distribution_points;

CREATE TRIGGER trg_guard_dp_archive
  BEFORE UPDATE ON public.distribution_points
  FOR EACH ROW
  EXECUTE FUNCTION phoenix_guard_dp_archive_update();

-- ============================================================================
-- E. Re-create archive_entity() with ports.archive permission check (from 021)
--    CREATE OR REPLACE: preserves existing GRANT from migration 003.
-- ============================================================================

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
      PERFORM set_config('phoenix.archive_bypass', 'true', true);
      UPDATE distribution_points
      SET status = 'archived', archived_at = now(), archived_by = auth.uid(), archive_reason = p_reason
      WHERE id = p_entity_id
        AND (v_role = 'super_admin' OR organization_id = v_org_id)
        AND archived_at IS NULL;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      PERFORM set_config('phoenix.archive_bypass', '', true);

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
-- F. VERIFY — 10 assertions
-- ============================================================================

DO $$
DECLARE
  v_read_src    text;
  v_insert_src  text;
  v_update_src  text;
  v_policy_count integer;
  v_nullable    text;
  v_fn_src      text;
BEGIN

  -- 1a. Named policies: all 3 expected policies exist
  SELECT count(*) INTO v_policy_count
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'distribution_points'
    AND policyname IN ('dp_read_perm', 'dp_insert_perm', 'dp_update_perm');
  ASSERT v_policy_count = 3,
    'VERIFY FAILED: expected 3 named permission-based policies; found ' || v_policy_count;

  -- 1b. Total count: exactly 3 policies total (no unknown extras)
  SELECT count(*) INTO v_policy_count
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'distribution_points';
  ASSERT v_policy_count = 3,
    'VERIFY FAILED: expected exactly 3 total policies on distribution_points; found ' || v_policy_count;

  -- 2. No DELETE policy exists
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'distribution_points'
      AND cmd = 'DELETE'
  ), 'VERIFY FAILED: unexpected DELETE policy found on distribution_points';

  -- 3. No FOR ALL policy exists
  -- Note: pg_policies.cmd for FOR ALL policies is 'ALL' (not '*');
  --       '*' is the pg_policy.polcmd char but the view maps it to 'ALL'.
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'distribution_points'
      AND cmd = 'ALL'
  ), 'VERIFY FAILED: unexpected FOR ALL policy found on distribution_points';

  -- 4. All legacy role-based policies are gone
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'distribution_points'
      AND policyname IN ('dp_select_org', 'dp_write_superadmin',
                         'dp_write_hospitaladmin', 'dp_write_wh_manager',
                         'dp_write_perm')
  ), 'VERIFY FAILED: legacy role-based policy still present on distribution_points';

  -- 5. trg_guard_dp_archive exists on distribution_points
  ASSERT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'distribution_points' AND t.tgname = 'trg_guard_dp_archive'
  ), 'VERIFY FAILED: trg_guard_dp_archive trigger not found on distribution_points';

  -- 6. archive_entity contains ports.archive and archive_bypass
  SELECT prosrc INTO v_fn_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'archive_entity';
  ASSERT v_fn_src IS NOT NULL,
    'VERIFY FAILED: archive_entity function not found';
  ASSERT v_fn_src LIKE '%ports.archive%',
    'VERIFY FAILED: archive_entity does not reference ports.archive permission';
  ASSERT v_fn_src LIKE '%archive_bypass%',
    'VERIFY FAILED: archive_entity does not reference archive_bypass session flag';

  -- 7. warehouse_id is nullable (prerequisite — must have been applied before 024)
  SELECT is_nullable INTO v_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'distribution_points'
    AND column_name = 'warehouse_id';
  ASSERT v_nullable = 'YES',
    'VERIFY FAILED: distribution_points.warehouse_id is still NOT NULL — apply ALTER COLUMN warehouse_id DROP NOT NULL first';

  -- 8. dp_read_perm has super_admin bypass (phoenix_my_role check present)
  SELECT qual INTO v_read_src
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'distribution_points'
    AND policyname = 'dp_read_perm';
  ASSERT v_read_src LIKE '%phoenix_my_role%',
    'VERIFY FAILED: dp_read_perm does not reference phoenix_my_role()';
  ASSERT v_read_src LIKE '%ports.view%',
    'VERIFY FAILED: dp_read_perm does not reference ports.view for non-super users';

  -- 9. dp_insert_perm references ports.create
  SELECT with_check INTO v_insert_src
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'distribution_points'
    AND policyname = 'dp_insert_perm';
  ASSERT v_insert_src LIKE '%ports.create%',
    'VERIFY FAILED: dp_insert_perm does not reference ports.create permission';

  -- 10. dp_update_perm references ports.edit
  SELECT qual INTO v_update_src
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'distribution_points'
    AND policyname = 'dp_update_perm';
  ASSERT v_update_src LIKE '%ports.edit%',
    'VERIFY FAILED: dp_update_perm does not reference ports.edit permission';

  RAISE NOTICE '024 ✓ distribution_points RLS repaired: 3 permission-based policies (no DELETE/FOR ALL), archive trigger + archive_entity with ports.archive, warehouse_id nullable';
END $$;

COMMIT;

-- ============================================================================
-- END OF MIGRATION 024
--
-- Post-apply verification (run in Supabase SQL Editor — no auth.uid() needed):
--
-- 1. Confirm exactly 3 policies, correct commands:
--    SELECT policyname, cmd FROM pg_policies
--    WHERE schemaname = 'public' AND tablename = 'distribution_points'
--    ORDER BY cmd, policyname;
--    -- expect: dp_insert_perm (INSERT), dp_read_perm (SELECT), dp_update_perm (UPDATE)
--    -- must NOT see any cmd='DELETE' or cmd='*' (FOR ALL)
--
-- 2. Confirm dp_read_perm has super_admin bypass at top level:
--    SELECT qual FROM pg_policies
--    WHERE schemaname = 'public' AND tablename = 'distribution_points'
--      AND policyname = 'dp_read_perm';
--    -- qual should begin with phoenix_my_role() = 'super_admin'::text) OR (...)
--    -- NOT with phoenix_profile_has_permission at top level
--
-- 3. Confirm archive trigger exists:
--    SELECT t.tgname FROM pg_trigger t
--    JOIN pg_class c ON c.oid = t.tgrelid
--    WHERE c.relname = 'distribution_points' AND t.tgname = 'trg_guard_dp_archive';
--    -- expect: 1 row
--
-- 4. Confirm permission keys exist (from migration 010):
--    SELECT key FROM permission_keys
--    WHERE key IN ('ports.view','ports.create','ports.edit','ports.archive')
--    ORDER BY key;
--    -- expect: 4 rows
--
-- 5. Confirm super_admin role_permission_defaults exist:
--    SELECT permission_key, allowed FROM role_permission_defaults
--    WHERE role = 'super_admin'
--      AND permission_key IN ('ports.view','ports.create','ports.edit','ports.archive')
--    ORDER BY permission_key;
--    -- expect: 4 rows, all allowed = true
--
-- After applying, smoke test via browser (auth.uid() has JWT context in browser):
--    super_admin → Institution → Add Port → port created + QR (no port_create_error)
--    institution_admin WITHOUT ports.create → blocked (expected)
--    institution_admin WITH ports.create (granted via permission matrix) → port created
--    user without ports.create → blocked
-- ============================================================================
