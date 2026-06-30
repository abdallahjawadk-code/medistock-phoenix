-- ============================================================================
-- MIGRATION 026 — Fix gen_random_bytes / digest schema qualification in
--                 create_qr_for_target; harden mutation RPC execute grants
-- ============================================================================
-- MANUAL APPLY ONLY — DO NOT use `npx supabase db push`.
-- Apply via Supabase Dashboard > SQL Editor after a verified backup.
--
-- Prerequisites: 003 (create_qr_for_target initial), 022 (qr.generate gate).
--
-- Root cause (MIGRATION-026-QR-RANDOM-BYTES-FIX-A):
--   POST /rest/v1/rpc/create_qr_for_target → 404 / PostgreSQL error 42883:
--     "function gen_random_bytes(integer) does not exist"
--
--   create_qr_for_target has SET search_path = public.
--   pgcrypto (gen_random_bytes, digest) is installed in the `extensions`
--   schema, not `public`. Unqualified calls fail at runtime with 42883.
--
-- Secondary fix (MIGRATION-026-ANON-EXECUTE-REVOKE-FIX-A):
--   Initial migration 026 rolled back with:
--     P0004: VERIFY FAILED: anon can EXECUTE create_qr_for_target
--
--   PostgreSQL grants EXECUTE to the pseudo-role PUBLIC on every newly
--   created function. `REVOKE ALL FROM anon` alone does not prevent anon
--   from executing because anon INHERITS the PUBLIC grant at runtime.
--   The correct pattern is:
--     REVOKE ALL … FROM PUBLIC;   ← strips the inherited default
--     REVOKE ALL … FROM anon;     ← belt-and-suspenders
--     GRANT EXECUTE … TO authenticated;
--
--   The same PUBLIC-grant issue applies to disable_qr_token, which was
--   created in migration 003 with `REVOKE … FROM anon` but not `FROM PUBLIC`.
--   This migration also hardens disable_qr_token with the safe pattern.
--   (The disable_qr_token function BODY is NOT replaced — grants only.)
--
-- What this migration does:
--   A. Re-creates create_qr_for_target (CREATE OR REPLACE) with pgcrypto
--      calls fully schema-qualified. All other logic is unchanged from 022.
--   B. Safe EXECUTE grants for create_qr_for_target
--        (REVOKE FROM PUBLIC, REVOKE FROM anon, GRANT TO authenticated).
--   C. Safe EXECUTE grants for disable_qr_token (grants only, no body change).
--   D. VERIFY block — 15 assertions.
--
-- Safe diagnostics to run BEFORE applying:
--
--   -- Confirm pgcrypto location
--   SELECT extname, extnamespace::regnamespace AS schema
--   FROM pg_extension WHERE extname = 'pgcrypto';
--   -- Expected: pgcrypto | extensions
--
--   -- Confirm gen_random_bytes and digest exist in extensions schema
--   SELECT n.nspname AS schema, p.proname, pg_get_function_arguments(p.oid) AS args
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE p.proname IN ('gen_random_bytes', 'digest')
--   ORDER BY p.proname, n.nspname;
--   -- Expected rows: extensions | gen_random_bytes | size integer
--   --                extensions | digest | ...
--
--   -- Confirm current grant state (both functions)
--   SELECT n.nspname AS schema, p.proname,
--     pg_get_function_arguments(p.oid) AS args,
--     has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_execute,
--     has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_execute
--   FROM pg_proc p
--   JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public'
--     AND p.proname IN ('create_qr_for_target', 'disable_qr_token')
--   ORDER BY p.proname;
--   -- Expected BEFORE applying: anon_execute = true (the bug — inherited from PUBLIC)
--   -- Expected AFTER applying:  anon_execute = false for both functions
--
-- ⚠️  auth.uid() CAVEAT:
--   Supabase Dashboard SQL Editor runs as postgres/service role — no JWT.
--   Do NOT use RLS helper functions in diagnostic queries from SQL Editor.
-- ============================================================================

BEGIN;

-- ============================================================================
-- A. create_qr_for_target — qualify gen_random_bytes and digest with
--    extensions schema to resolve 42883
-- ============================================================================
-- Preserved exactly from migration 022 except three pgcrypto call sites.

CREATE OR REPLACE FUNCTION create_qr_for_target(
  p_target_type  text,
  p_target_id    uuid,
  p_label        text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role          text;
  v_org_id        uuid;
  v_target_id     uuid;
  v_token_id      uuid;
  v_public_id     text;
  v_plain_token   text;
  v_token_hash    text;
  v_allowed_types text[] := ARRAY['warehouse', 'distribution_point', 'local_item'];
BEGIN
  v_role   := phoenix_my_role();
  v_org_id := phoenix_my_org();

  -- Permission-based: super_admin always allowed; others need qr.generate
  IF v_role <> 'super_admin'
     AND NOT phoenix_profile_has_permission(auth.uid(), 'qr.generate') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_PERMISSION');
  END IF;

  -- enforce allowlist
  IF p_target_type != ALL(v_allowed_types) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'TARGET_TYPE_NOT_ALLOWLISTED',
      'allowed', v_allowed_types
    );
  END IF;

  -- verify target belongs to caller's org (or caller is super_admin)
  CASE p_target_type
    WHEN 'warehouse' THEN
      IF NOT EXISTS (
        SELECT 1 FROM warehouses
        WHERE id = p_target_id
          AND (v_role = 'super_admin' OR organization_id = v_org_id)
      ) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TARGET_NOT_FOUND_OR_FORBIDDEN');
      END IF;
      SELECT organization_id INTO v_org_id FROM warehouses WHERE id = p_target_id;

    WHEN 'distribution_point' THEN
      IF NOT EXISTS (
        SELECT 1 FROM distribution_points
        WHERE id = p_target_id
          AND (v_role = 'super_admin' OR organization_id = v_org_id)
      ) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TARGET_NOT_FOUND_OR_FORBIDDEN');
      END IF;
      SELECT organization_id INTO v_org_id FROM distribution_points WHERE id = p_target_id;

    WHEN 'local_item' THEN
      IF NOT EXISTS (
        SELECT 1 FROM local_items
        WHERE id = p_target_id
          AND (v_role = 'super_admin' OR organization_id = v_org_id)
      ) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TARGET_NOT_FOUND_OR_FORBIDDEN');
      END IF;
      SELECT organization_id INTO v_org_id FROM local_items WHERE id = p_target_id;
  END CASE;

  -- idempotent: return existing active token if present
  SELECT qt.id, qt.public_id INTO v_token_id, v_public_id
  FROM qr_tokens qt
  JOIN qr_targets qtr ON qtr.id = qt.qr_target_id
  WHERE qtr.target_type = p_target_type::qr_target_type
    AND qtr.target_id = p_target_id
    AND qt.status = 'active'
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok',        true,
      'created',   false,
      'token_id',  v_token_id,
      'public_id', v_public_id
    );
  END IF;

  -- upsert qr_target
  INSERT INTO qr_targets (organization_id, target_type, target_id, label)
  VALUES (v_org_id, p_target_type::qr_target_type, p_target_id, p_label)
  ON CONFLICT (target_type, target_id) DO UPDATE SET label = EXCLUDED.label
  RETURNING id INTO v_target_id;

  -- FIX (026): fully qualify pgcrypto calls — gen_random_bytes and digest live in
  -- the `extensions` schema in Supabase; SET search_path = public makes them
  -- invisible without the schema prefix, causing 42883.
  v_plain_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_token_hash  := encode(extensions.digest(v_plain_token, 'sha256'), 'hex');
  v_public_id   := encode(extensions.gen_random_bytes(12), 'hex');

  INSERT INTO qr_tokens (qr_target_id, organization_id, public_id, token_hash, created_by)
  VALUES (v_target_id, v_org_id, v_public_id, v_token_hash, auth.uid())
  RETURNING id INTO v_token_id;

  -- audit
  INSERT INTO audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label)
  VALUES (v_org_id, auth.uid(), v_role, 'qr_created', p_target_type, p_target_id, p_label);

  RETURN jsonb_build_object(
    'ok',        true,
    'created',   true,
    'token_id',  v_token_id,
    'public_id', v_public_id
  );
END;
$$;

-- ============================================================================
-- B. Safe EXECUTE grants for create_qr_for_target
-- ============================================================================
-- Step 1: Revoke from PUBLIC — removes the default grant PostgreSQL applies to
--         every newly created function. Without this, anon inherits EXECUTE
--         from PUBLIC even after REVOKE FROM anon.
-- Step 2: Belt-and-suspenders revoke from anon directly.
-- Step 3: Grant EXECUTE to authenticated only.
-- All three statements are idempotent.
REVOKE ALL ON FUNCTION public.create_qr_for_target(text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_qr_for_target(text, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_qr_for_target(text, uuid, text) TO authenticated;

-- ============================================================================
-- C. Safe EXECUTE grants for disable_qr_token
-- ============================================================================
-- Migration 003 issued REVOKE FROM anon but not FROM PUBLIC.
-- This migration applies the same safe pattern to close the inherited gap.
-- The disable_qr_token function BODY is NOT changed here — grants only.
REVOKE ALL ON FUNCTION public.disable_qr_token(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.disable_qr_token(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.disable_qr_token(uuid, text) TO authenticated;

-- ============================================================================
-- D. VERIFY — 15 assertions
-- ============================================================================

DO $$
DECLARE
  v_fn_src      text;
  v_fn_oid      oid;
  v_dq_oid      oid;
  v_is_secdef   boolean;
  v_disable_src text;
BEGIN

  -- Resolve OIDs once (used for privilege checks)
  SELECT p.oid INTO v_fn_oid
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'create_qr_for_target';

  SELECT p.oid INTO v_dq_oid
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'disable_qr_token';

  -- 1. create_qr_for_target exists
  ASSERT v_fn_oid IS NOT NULL,
    'VERIFY FAILED: create_qr_for_target not found in public schema';

  -- 2. create_qr_for_target is SECURITY DEFINER
  SELECT p.prosecdef INTO v_is_secdef FROM pg_proc p WHERE p.oid = v_fn_oid;
  ASSERT v_is_secdef,
    'VERIFY FAILED: create_qr_for_target is not SECURITY DEFINER';

  -- Load create_qr_for_target source body
  SELECT p.prosrc INTO v_fn_src FROM pg_proc p WHERE p.oid = v_fn_oid;

  -- 3. body uses extensions-qualified gen_random_bytes (42883 fix applied)
  ASSERT v_fn_src LIKE '%extensions.gen_random_bytes%',
    'VERIFY FAILED: create_qr_for_target does not use extensions.gen_random_bytes — 42883 fix not applied';

  -- 4. body uses extensions-qualified digest (42883 fix applied)
  ASSERT v_fn_src LIKE '%extensions.digest%',
    'VERIFY FAILED: create_qr_for_target does not use extensions.digest — 42883 fix not applied';

  -- 5. body references qr.generate permission
  ASSERT v_fn_src LIKE '%qr.generate%',
    'VERIFY FAILED: create_qr_for_target does not reference qr.generate';

  -- 6. body references phoenix_profile_has_permission
  ASSERT v_fn_src LIKE '%phoenix_profile_has_permission%',
    'VERIFY FAILED: create_qr_for_target does not reference phoenix_profile_has_permission';

  -- 7. body contains org guard
  ASSERT v_fn_src LIKE '%TARGET_NOT_FOUND_OR_FORBIDDEN%',
    'VERIFY FAILED: create_qr_for_target does not contain org guard TARGET_NOT_FOUND_OR_FORBIDDEN';

  -- 8. authenticated can EXECUTE create_qr_for_target
  ASSERT has_function_privilege('authenticated', v_fn_oid, 'EXECUTE'),
    'VERIFY FAILED: authenticated cannot EXECUTE create_qr_for_target';

  -- 9. anon cannot EXECUTE create_qr_for_target
  -- (anon must not inherit EXECUTE from PUBLIC after REVOKE ALL FROM PUBLIC)
  ASSERT NOT has_function_privilege('anon', v_fn_oid, 'EXECUTE'),
    'VERIFY FAILED: anon can EXECUTE create_qr_for_target — REVOKE FROM PUBLIC may not have applied';

  -- 10. PUBLIC pseudo-role has no EXECUTE on create_qr_for_target
  -- In pg_proc ACL entries, grantee OID 0 represents the pseudo-role PUBLIC.
  -- proacl IS NULL means no explicit ACL exists and default PUBLIC EXECUTE applies — a bug here.
  ASSERT (SELECT proacl IS NOT NULL FROM pg_proc WHERE oid = v_fn_oid),
    'VERIFY FAILED: create_qr_for_target proacl is NULL — REVOKE FROM PUBLIC was not persisted (default PUBLIC EXECUTE still in effect)';
  ASSERT NOT EXISTS (
    SELECT 1 FROM aclexplode((SELECT proacl FROM pg_proc WHERE oid = v_fn_oid))
    WHERE grantee = 0 AND privilege_type = 'EXECUTE'
  ), 'VERIFY FAILED: PUBLIC (grantee OID 0) still has EXECUTE on create_qr_for_target';

  -- 11. disable_qr_token exists and still contains qr.revoke and phoenix_profile_has_permission
  ASSERT v_dq_oid IS NOT NULL,
    'VERIFY FAILED: disable_qr_token not found in public schema';
  SELECT p.prosrc INTO v_disable_src FROM pg_proc p WHERE p.oid = v_dq_oid;
  ASSERT v_disable_src LIKE '%qr.revoke%',
    'VERIFY FAILED: disable_qr_token does not reference qr.revoke (migration 022 may not be applied)';
  ASSERT v_disable_src LIKE '%phoenix_profile_has_permission%',
    'VERIFY FAILED: disable_qr_token does not reference phoenix_profile_has_permission';

  -- 12. authenticated can EXECUTE disable_qr_token
  ASSERT has_function_privilege('authenticated', v_dq_oid, 'EXECUTE'),
    'VERIFY FAILED: authenticated cannot EXECUTE disable_qr_token';

  -- 13. anon cannot EXECUTE disable_qr_token
  ASSERT NOT has_function_privilege('anon', v_dq_oid, 'EXECUTE'),
    'VERIFY FAILED: anon can EXECUTE disable_qr_token — REVOKE FROM PUBLIC may not have applied';

  -- 14. PUBLIC has no EXECUTE on disable_qr_token
  ASSERT (SELECT proacl IS NOT NULL FROM pg_proc WHERE oid = v_dq_oid),
    'VERIFY FAILED: disable_qr_token proacl is NULL — REVOKE FROM PUBLIC was not persisted';
  ASSERT NOT EXISTS (
    SELECT 1 FROM aclexplode((SELECT proacl FROM pg_proc WHERE oid = v_dq_oid))
    WHERE grantee = 0 AND privilege_type = 'EXECUTE'
  ), 'VERIFY FAILED: PUBLIC (grantee OID 0) still has EXECUTE on disable_qr_token';

  -- 15. no service_role reference in create_qr_for_target body
  ASSERT v_fn_src NOT LIKE '%service_role%',
    'VERIFY FAILED: create_qr_for_target references service_role — security risk';

  RAISE NOTICE '026 ✓ create_qr_for_target: extensions.gen_random_bytes/digest qualified; qr.generate preserved; SECURITY DEFINER preserved; org guard preserved; PUBLIC+anon EXECUTE revoked; authenticated EXECUTE granted. disable_qr_token: PUBLIC+anon EXECUTE revoked; authenticated EXECUTE granted; qr.revoke intact.';
END $$;

COMMIT;

-- ============================================================================
-- END OF MIGRATION 026
--
-- Post-apply verification (run in Supabase SQL Editor):
--
-- 1. Confirm fix applied to function body:
--    SELECT
--      prosrc LIKE '%extensions.gen_random_bytes%' AS gen_random_bytes_qualified,
--      prosrc LIKE '%extensions.digest%'            AS digest_qualified,
--      prosrc NOT LIKE '%service_role%'             AS no_service_role,
--      prosrc LIKE '%qr.generate%'                  AS qr_generate_present,
--      prosrc LIKE '%TARGET_NOT_FOUND_OR_FORBIDDEN%' AS org_guard_present
--    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'create_qr_for_target';
--    Expected: all five columns = true
--
-- 2. Confirm EXECUTE grant state (both functions):
--    SELECT n.nspname AS schema, p.proname,
--      pg_get_function_arguments(p.oid) AS args,
--      has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_execute,
--      has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_execute
--    FROM pg_proc p
--    JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND p.proname IN ('create_qr_for_target', 'disable_qr_token')
--    ORDER BY p.proname;
--    Expected: auth_execute = true, anon_execute = false for both
--
-- 3. Confirm via role_routine_grants (PUBLIC should not appear):
--    SELECT grantee, privilege_type
--    FROM information_schema.role_routine_grants
--    WHERE routine_schema = 'public'
--      AND routine_name IN ('create_qr_for_target', 'disable_qr_token')
--    ORDER BY routine_name, grantee;
--    Expected: only authenticated | EXECUTE for each (no anon, no PUBLIC row)
--
-- 4. Confirm disable_qr_token qr.revoke intact:
--    SELECT prosrc LIKE '%qr.revoke%' AS qr_revoke_present
--    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'disable_qr_token';
--    Expected: true
-- ============================================================================
