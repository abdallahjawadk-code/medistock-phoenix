-- ============================================================================
-- MIGRATION 026 — Fix gen_random_bytes / digest schema qualification in
--                 create_qr_for_target
-- ============================================================================
-- MANUAL APPLY ONLY — DO NOT use `npx supabase db push`.
-- Apply via Supabase Dashboard > SQL Editor after a verified backup.
--
-- Prerequisites: 003 (create_qr_for_target initial), 022 (qr.generate gate).
--
-- Root cause (MIGRATION-026-QR-RANDOM-BYTES-FIX-A):
--   POST /rest/v1/rpc/create_qr_for_target → 404 / PostgreSQL error 42883:
--     "function gen_random_bytes(integer) does not exist"
--     "No function matches the given name and argument types."
--
--   The function create_qr_for_target is declared with:
--     SET search_path = public
--   This means only the public schema is searched for unqualified function calls.
--   pgcrypto (gen_random_bytes, digest) is installed by Supabase in the
--   `extensions` schema, NOT in `public`. With search_path = public, the
--   unqualified calls:
--     gen_random_bytes(32)           — 42883: not found
--     digest(v_plain_token, 'sha256') — 42883: not found
--     gen_random_bytes(12)           — 42883: not found
--   cannot be resolved.
--
-- Safe diagnostics to run BEFORE applying (confirm pgcrypto location):
--
--   SELECT extname, extnamespace::regnamespace AS schema
--   FROM pg_extension
--   WHERE extname = 'pgcrypto';
--   -- Expected: pgcrypto | extensions
--
--   SELECT n.nspname AS schema, p.proname, pg_get_function_arguments(p.oid) AS args
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE p.proname = 'gen_random_bytes'
--   ORDER BY n.nspname;
--   -- Expected: extensions | gen_random_bytes | size integer
--
-- What this migration does:
--   A. Re-creates create_qr_for_target (CREATE OR REPLACE) with all three
--      pgcrypto calls fully schema-qualified:
--        gen_random_bytes(32)  →  extensions.gen_random_bytes(32)
--        digest(…, 'sha256')   →  extensions.digest(…, 'sha256')
--        gen_random_bytes(12)  →  extensions.gen_random_bytes(12)
--      All other logic is preserved verbatim from migration 022.
--   B. Re-states GRANT/REVOKE for create_qr_for_target (idempotent).
--   C. Leaves disable_qr_token unchanged — it does not call pgcrypto.
--   D. VERIFY block — 11 assertions.
--
-- ⚠️  auth.uid() CAVEAT:
--   Supabase Dashboard SQL Editor runs as postgres/service role — no JWT.
--   auth.uid() returns NULL in that context. Do NOT use RLS helper functions
--   (phoenix_my_role, phoenix_my_org, phoenix_profile_has_permission) in
--   diagnostic queries run from SQL Editor.
-- ============================================================================

BEGIN;

-- ============================================================================
-- A. create_qr_for_target — qualify gen_random_bytes and digest with
--    extensions schema to resolve 42883
-- ============================================================================
-- Preserved exactly from migration 022, except three pgcrypto call sites.

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
-- B. Re-state GRANT/REVOKE (idempotent, preserves migration 022 intent)
-- ============================================================================
REVOKE ALL ON FUNCTION create_qr_for_target(text, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION create_qr_for_target(text, uuid, text) TO authenticated;

-- ============================================================================
-- C. VERIFY — 11 assertions
-- ============================================================================

DO $$
DECLARE
  v_fn_src      text;
  v_fn_oid      oid;
  v_is_secdef   boolean;
  v_disable_src text;
BEGIN

  -- Resolve function OID once (used for privilege checks)
  SELECT p.oid INTO v_fn_oid
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'create_qr_for_target';

  -- 1. create_qr_for_target exists
  ASSERT v_fn_oid IS NOT NULL,
    'VERIFY FAILED: create_qr_for_target not found in public schema';

  -- 2. create_qr_for_target is SECURITY DEFINER
  SELECT p.prosecdef INTO v_is_secdef
  FROM pg_proc p WHERE p.oid = v_fn_oid;
  ASSERT v_is_secdef,
    'VERIFY FAILED: create_qr_for_target is not SECURITY DEFINER';

  -- Load function source body
  SELECT p.prosrc INTO v_fn_src FROM pg_proc p WHERE p.oid = v_fn_oid;

  -- 3. body references qr.generate permission
  ASSERT v_fn_src LIKE '%qr.generate%',
    'VERIFY FAILED: create_qr_for_target does not reference qr.generate';

  -- 4. body references phoenix_profile_has_permission
  ASSERT v_fn_src LIKE '%phoenix_profile_has_permission%',
    'VERIFY FAILED: create_qr_for_target does not reference phoenix_profile_has_permission';

  -- 5. body uses extensions-qualified gen_random_bytes (fix applied)
  ASSERT v_fn_src LIKE '%extensions.gen_random_bytes%',
    'VERIFY FAILED: create_qr_for_target does not use extensions.gen_random_bytes — 42883 fix not applied';

  -- 6. extensions.gen_random_bytes is resolvable (pgcrypto in extensions schema)
  ASSERT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'extensions' AND p.proname = 'gen_random_bytes'
  ), 'VERIFY FAILED: extensions.gen_random_bytes not found — pgcrypto may not be installed in extensions schema';

  -- 7. authenticated can EXECUTE create_qr_for_target
  ASSERT has_function_privilege('authenticated', v_fn_oid, 'EXECUTE'),
    'VERIFY FAILED: authenticated cannot EXECUTE create_qr_for_target';

  -- 8. anon cannot EXECUTE create_qr_for_target
  ASSERT NOT has_function_privilege('anon', v_fn_oid, 'EXECUTE'),
    'VERIFY FAILED: anon can EXECUTE create_qr_for_target — REVOKE may not have applied';

  -- 9. disable_qr_token still references qr.revoke and phoenix_profile_has_permission
  SELECT p.prosrc INTO v_disable_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'disable_qr_token';
  ASSERT v_disable_src IS NOT NULL,
    'VERIFY FAILED: disable_qr_token not found in public schema';
  ASSERT v_disable_src LIKE '%qr.revoke%',
    'VERIFY FAILED: disable_qr_token does not reference qr.revoke (migration 022 may not be applied)';
  ASSERT v_disable_src LIKE '%phoenix_profile_has_permission%',
    'VERIFY FAILED: disable_qr_token does not reference phoenix_profile_has_permission';

  -- 10. no service_role reference in create_qr_for_target body
  ASSERT v_fn_src NOT LIKE '%service_role%',
    'VERIFY FAILED: create_qr_for_target references service_role — security risk';

  -- 11. create_qr_for_target preserves org guard (TARGET_NOT_FOUND_OR_FORBIDDEN)
  ASSERT v_fn_src LIKE '%TARGET_NOT_FOUND_OR_FORBIDDEN%',
    'VERIFY FAILED: create_qr_for_target does not contain org guard TARGET_NOT_FOUND_OR_FORBIDDEN';

  RAISE NOTICE '026 ✓ create_qr_for_target: extensions.gen_random_bytes qualified; qr.generate preserved; SECURITY DEFINER preserved; org guard preserved; authenticated EXECUTE granted; anon EXECUTE revoked; disable_qr_token qr.revoke intact';
END $$;

COMMIT;

-- ============================================================================
-- END OF MIGRATION 026
--
-- Post-apply verification (run in Supabase SQL Editor):
--
-- 1. Confirm pgcrypto location:
--    SELECT extname, extnamespace::regnamespace AS schema
--    FROM pg_extension WHERE extname = 'pgcrypto';
--    Expected: pgcrypto | extensions
--
-- 2. Confirm gen_random_bytes is visible at extensions schema:
--    SELECT n.nspname AS schema, p.proname, pg_get_function_arguments(p.oid) AS args
--    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE p.proname = 'gen_random_bytes' ORDER BY n.nspname;
--    Expected: extensions | gen_random_bytes | size integer
--
-- 3. Confirm create_qr_for_target body uses extensions-qualified calls:
--    SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'create_qr_for_target';
--    Expected: body contains 'extensions.gen_random_bytes'
--
-- 4. Confirm EXECUTE grant:
--    SELECT grantee, privilege_type
--    FROM information_schema.role_routine_grants
--    WHERE routine_schema = 'public' AND routine_name = 'create_qr_for_target';
--    Expected: authenticated | EXECUTE (and no anon row)
-- ============================================================================
