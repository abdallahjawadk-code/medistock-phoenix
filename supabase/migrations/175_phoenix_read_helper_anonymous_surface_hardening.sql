-- ============================================================================
-- READ-HELPER-ANON-SURFACE-HARDENING-175 — Phase-2 Wave 2
--
-- Exact three-function ACL hardening only. These functions are authenticated
-- or internal read helpers with explicit authenticated + service_role EXECUTE;
-- their current anon reach is inherited from PUBLIC and is unnecessary.
--
-- Intentionally OUT OF SCOPE:
--   * public.get_public_qr_payload(text) — intentional anonymous product API
--   * phoenix_my_role() / phoenix_my_org() — load-bearing identity helpers
--   * trigger functions — separate empirical trigger-semantics wave
--   * function bodies/signatures/search_path, RLS/RBAC, tables/views/data,
--     indexes, default privileges, Auth configuration
--
-- MANUAL/APPLY_MIGRATION ONLY. NEVER `supabase db push`.
-- ============================================================================

DO $hardening$
DECLARE
  v_targets text[] := ARRAY[
    'public.phoenix_profile_has_permission(uuid,text)',
    'public.phoenix_provenance_reconciliation()',
    'public.phoenix_warehouse_source_balances(uuid)'
  ];
  v_target text;
  v_defs_before jsonb := '{}'::jsonb;
  v_def_after text;
  v_qr text := 'public.get_public_qr_payload(text)';
  v_qr_def_before text;
  v_qr_anon_before boolean;
  v_my_role_def_before text;
  v_my_org_def_before text;
  v_my_role_auth_before boolean;
  v_my_org_auth_before boolean;
BEGIN
  FOREACH v_target IN ARRAY v_targets LOOP
    IF to_regprocedure(v_target) IS NULL THEN
      RAISE EXCEPTION 'PREFLIGHT FAILED (175): target absent: %', v_target;
    END IF;

    -- Unlike inherited/effective checks alone, require direct grants to both
    -- legitimate API roles so removing PUBLIC cannot silently remove access.
    IF NOT EXISTS (
      SELECT 1
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) e
      JOIN pg_roles r ON r.oid = e.grantee
      WHERE p.oid = to_regprocedure(v_target)
        AND r.rolname = 'authenticated'
        AND e.privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'PREFLIGHT FAILED (175): authenticated direct grant absent: %', v_target;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) e
      JOIN pg_roles r ON r.oid = e.grantee
      WHERE p.oid = to_regprocedure(v_target)
        AND r.rolname = 'service_role'
        AND e.privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'PREFLIGHT FAILED (175): service_role direct grant absent: %', v_target;
    END IF;

    IF NOT has_function_privilege('anon', to_regprocedure(v_target), 'EXECUTE') THEN
      RAISE EXCEPTION 'PREFLIGHT FAILED (175): anon already closed for %, refusing duplicate/ambiguous hardening', v_target;
    END IF;

    v_defs_before := v_defs_before || jsonb_build_object(
      v_target,
      pg_get_functiondef(to_regprocedure(v_target))
    );
  END LOOP;

  IF to_regprocedure(v_qr) IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (175): public QR absent';
  END IF;
  v_qr_def_before := pg_get_functiondef(to_regprocedure(v_qr));
  v_qr_anon_before := has_function_privilege('anon', to_regprocedure(v_qr), 'EXECUTE');
  IF NOT v_qr_anon_before THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (175): public QR is not anonymous';
  END IF;

  v_my_role_def_before := pg_get_functiondef(to_regprocedure('public.phoenix_my_role()'));
  v_my_org_def_before := pg_get_functiondef(to_regprocedure('public.phoenix_my_org()'));
  v_my_role_auth_before := has_function_privilege('authenticated', to_regprocedure('public.phoenix_my_role()'), 'EXECUTE');
  v_my_org_auth_before := has_function_privilege('authenticated', to_regprocedure('public.phoenix_my_org()'), 'EXECUTE');
  IF NOT v_my_role_auth_before OR NOT v_my_org_auth_before THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (175): core identity helpers not in expected authenticated state';
  END IF;

  -- Exact three overloads only. No GRANT and no authenticated/service revoke.
  FOREACH v_target IN ARRAY v_targets LOOP
    EXECUTE 'REVOKE EXECUTE ON FUNCTION ' || v_target || ' FROM PUBLIC';
    EXECUTE 'REVOKE EXECUTE ON FUNCTION ' || v_target || ' FROM anon';
  END LOOP;

  FOREACH v_target IN ARRAY v_targets LOOP
    v_def_after := pg_get_functiondef(to_regprocedure(v_target));
    IF v_def_after IS DISTINCT FROM (v_defs_before ->> v_target) THEN
      RAISE EXCEPTION 'VERIFY FAILED (175): function definition changed: %', v_target;
    END IF;
    IF has_function_privilege('anon', to_regprocedure(v_target), 'EXECUTE') THEN
      RAISE EXCEPTION 'VERIFY FAILED (175): anon still executes: %', v_target;
    END IF;
    IF NOT has_function_privilege('authenticated', to_regprocedure(v_target), 'EXECUTE') THEN
      RAISE EXCEPTION 'VERIFY FAILED (175): authenticated lost EXECUTE: %', v_target;
    END IF;
    IF NOT has_function_privilege('service_role', to_regprocedure(v_target), 'EXECUTE') THEN
      RAISE EXCEPTION 'VERIFY FAILED (175): service_role lost EXECUTE: %', v_target;
    END IF;
  END LOOP;

  IF pg_get_functiondef(to_regprocedure(v_qr)) IS DISTINCT FROM v_qr_def_before
     OR NOT has_function_privilege('anon', to_regprocedure(v_qr), 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (175): public QR changed';
  END IF;

  IF pg_get_functiondef(to_regprocedure('public.phoenix_my_role()')) IS DISTINCT FROM v_my_role_def_before
     OR has_function_privilege('authenticated', to_regprocedure('public.phoenix_my_role()'), 'EXECUTE') IS DISTINCT FROM v_my_role_auth_before THEN
    RAISE EXCEPTION 'VERIFY FAILED (175): phoenix_my_role changed';
  END IF;

  IF pg_get_functiondef(to_regprocedure('public.phoenix_my_org()')) IS DISTINCT FROM v_my_org_def_before
     OR has_function_privilege('authenticated', to_regprocedure('public.phoenix_my_org()'), 'EXECUTE') IS DISTINCT FROM v_my_org_auth_before THEN
    RAISE EXCEPTION 'VERIFY FAILED (175): phoenix_my_org changed';
  END IF;
END;
$hardening$;

-- ROLLBACK GUIDANCE — documentation only.
-- If a legitimate anonymous integration is ever proven, restore only the exact
-- required role on the exact overload after review. Do not broadly GRANT PUBLIC.
