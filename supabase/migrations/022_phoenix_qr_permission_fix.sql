-- ============================================================================
-- MIGRATION 022 — Permission-based QR RPC gating
-- ============================================================================
-- MANUAL APPLY ONLY — DO NOT use `npx supabase db push`.
-- Apply via Supabase Dashboard > SQL Editor after a verified backup.
--
-- Prerequisites: 003 (create_qr_for_target / disable_qr_token RPCs),
--                010 (permission matrix with phoenix_profile_has_permission,
--                     qr.generate / qr.revoke permission keys).
--
-- Purpose:
--   Replaces hardcoded role-based gating in the two QR RPCs with
--   permission-based checks that use the existing
--   phoenix_profile_has_permission(uuid, text) helper from migration 010:
--
--   create_qr_for_target:
--     BEFORE:  v_role IN ('super_admin','hospital_admin','warehouse_manager')
--     AFTER:   super_admin  OR  qr.generate permission
--
--   disable_qr_token:
--     BEFORE:  v_role IN ('super_admin','hospital_admin','warehouse_manager')
--     AFTER:   super_admin  OR  qr.revoke permission
--
--   This lets any role (port_officer, point_operator, etc.) use QR
--   functionality if their permission matrix grants qr.generate / qr.revoke,
--   without hardcoding role names in the RPC.
--
-- What this does NOT do:
--   - Does NOT modify qr_targets / qr_tokens RLS policies in migration 002
--     (those are role-based FOR ALL; a future migration may align them).
--   - Does NOT change the org-scope checks inside either RPC.
--   - Does NOT touch any other RPCs, tables, or triggers.
--
-- Safety:
--   - CREATE OR REPLACE: no data changes, idempotent on re-apply.
--   - GRANT/REVOKE re-stated to match migration 003.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. create_qr_for_target — replace role-gate with qr.generate permission
-- ============================================================================

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

  -- generate token
  v_plain_token := encode(gen_random_bytes(32), 'hex');
  v_token_hash  := encode(digest(v_plain_token, 'sha256'), 'hex');
  v_public_id   := encode(gen_random_bytes(12), 'hex');

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

REVOKE ALL ON FUNCTION create_qr_for_target(text, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION create_qr_for_target(text, uuid, text) TO authenticated;

-- ============================================================================
-- 2. disable_qr_token — replace role-gate with qr.revoke permission
-- ============================================================================

CREATE OR REPLACE FUNCTION disable_qr_token(
  p_token_id  uuid,
  p_reason    text DEFAULT 'manual_disable'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   text;
  v_org_id uuid;
  v_token  qr_tokens%ROWTYPE;
BEGIN
  v_role   := phoenix_my_role();
  v_org_id := phoenix_my_org();

  -- Permission-based: super_admin always allowed; others need qr.revoke
  IF v_role <> 'super_admin'
     AND NOT phoenix_profile_has_permission(auth.uid(), 'qr.revoke') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_PERMISSION');
  END IF;

  SELECT * INTO v_token FROM qr_tokens WHERE id = p_token_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'TOKEN_NOT_FOUND');
  END IF;

  IF v_role <> 'super_admin' AND v_token.organization_id <> v_org_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'FORBIDDEN_ORG');
  END IF;

  IF v_token.status = 'disabled' THEN
    RETURN jsonb_build_object('ok', true, 'already_disabled', true);
  END IF;

  UPDATE qr_tokens
  SET status         = 'disabled',
      disabled_at    = now(),
      disabled_by    = auth.uid(),
      disable_reason = p_reason
  WHERE id = p_token_id;

  INSERT INTO audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id)
  VALUES (v_token.organization_id, auth.uid(), v_role, 'qr_disabled', 'qr_token', p_token_id);

  RETURN jsonb_build_object('ok', true, 'disabled', true);
END;
$$;

REVOKE ALL ON FUNCTION disable_qr_token(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION disable_qr_token(uuid, text) TO authenticated;

-- ============================================================================
-- VERIFY
-- ============================================================================

DO $$
DECLARE
  v_create_src text;
  v_disable_src text;
BEGIN
  -- Load function source bodies
  SELECT prosrc INTO v_create_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'create_qr_for_target';

  SELECT prosrc INTO v_disable_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'disable_qr_token';

  -- A. create_qr_for_target must reference qr.generate permission
  ASSERT v_create_src LIKE '%qr.generate%',
    'VERIFY FAILED: create_qr_for_target does not reference qr.generate permission';

  -- B. create_qr_for_target must NOT contain the old role-list check
  ASSERT v_create_src NOT LIKE '%hospital_admin%' OR v_create_src LIKE '%qr.generate%',
    'VERIFY FAILED: create_qr_for_target still contains old role-based gate without permission check';

  -- C. disable_qr_token must reference qr.revoke permission
  ASSERT v_disable_src LIKE '%qr.revoke%',
    'VERIFY FAILED: disable_qr_token does not reference qr.revoke permission';

  -- D. disable_qr_token must NOT contain the old role-list check as primary gate
  ASSERT v_disable_src NOT LIKE '%hospital_admin%' OR v_disable_src LIKE '%qr.revoke%',
    'VERIFY FAILED: disable_qr_token still contains old role-based gate without permission check';

  RAISE NOTICE '022 ✓ create_qr_for_target uses qr.generate; disable_qr_token uses qr.revoke';
END $$;

COMMIT;

-- ============================================================================
-- END OF MIGRATION 022
--
-- Post-apply verification (run manually):
--
-- 1. Confirm permission check in create_qr_for_target:
--    SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'create_qr_for_target';
--    -- body should contain 'qr.generate' and not have the role-list as the
--    -- primary gate (hospital_admin check should be absent or secondary)
--
-- 2. Confirm permission check in disable_qr_token:
--    SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'disable_qr_token';
--    -- body should contain 'qr.revoke'
--
-- 3. As a user with role port_officer (no qr.generate by default in migration 010):
--      SELECT create_qr_for_target('distribution_point', '<port-id>', 'test');
--    -- expect: {"ok": false, "error": "INSUFFICIENT_PERMISSION"}
--
-- 4. Grant qr.generate to that user and retry:
--      SELECT create_qr_for_target('distribution_point', '<port-id>', 'test');
--    -- expect: {"ok": true, "created": true, ...}
--
-- 5. As a user without qr.revoke:
--      SELECT disable_qr_token('<token-id>');
--    -- expect: {"ok": false, "error": "INSUFFICIENT_PERMISSION"}
-- ============================================================================
