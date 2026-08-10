-- ============================================================================
-- AUTHENTICATED-RPC-SURFACE-HARDENING-174 — Phase-2 Wave 1
--
-- Forward-only ACL hardening. No function body/signature/search_path change,
-- no RLS/RBAC/table/view/trigger/data change, and no default-privilege change.
--
-- Live Production catalog evidence before authoring:
--   * 304 public-schema functions
--   * 19 effectively reachable by anon/PUBLIC
--   * the nine targets below are authenticated application APIs
--   * every target has authenticated + service_role EXECUTE before this change
--   * anon reach is accidental, inherited from PUBLIC
--   * public.get_public_qr_payload(text) is intentional anonymous API and is
--     explicitly preserved before and after this migration
--
-- MANUAL/APPLY_MIGRATION ONLY. NEVER `supabase db push`.
-- ============================================================================

DO $hardening$
DECLARE
  v_targets text[] := ARRAY[
    'public.archive_entity(text,uuid,text)',
    'public.assign_profile_permissions(uuid,jsonb)',
    'public.assign_profile_role(uuid,text)',
    'public.get_effective_permissions(uuid)',
    'public.get_entity_purge_impact(text,uuid)',
    'public.get_scoped_inter_institution_alerts()',
    'public.phoenix_mark_password_changed()',
    'public.purge_entity_with_all_data(text,uuid,text)',
    'public.reset_profile_permissions(uuid)'
  ];
  v_target text;
  v_defs_before jsonb := '{}'::jsonb;
  v_def_after text;
  v_qr text := 'public.get_public_qr_payload(text)';
  v_qr_anon_before boolean;
  v_qr_auth_before boolean;
  v_qr_service_before boolean;
  v_my_role_auth_before boolean;
  v_my_org_auth_before boolean;
BEGIN
  -- ══════════════════════════════════════════════════════════════════════════
  -- PREFLIGHT — all nine targets must match the reviewed live-catalog state.
  -- Any divergence aborts before the first ACL change.
  -- ══════════════════════════════════════════════════════════════════════════
  FOREACH v_target IN ARRAY v_targets LOOP
    IF to_regprocedure(v_target) IS NULL THEN
      RAISE EXCEPTION 'PREFLIGHT FAILED (174): target absent: %', v_target;
    END IF;

    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v_target)) THEN
      RAISE EXCEPTION 'PREFLIGHT FAILED (174): target is no longer SECURITY DEFINER: %', v_target;
    END IF;

    -- Every target was proven live as an authenticated API. If that grant is
    -- already gone, this migration is looking at an unexpected database state.
    IF NOT has_function_privilege('authenticated', to_regprocedure(v_target), 'EXECUTE') THEN
      RAISE EXCEPTION 'PREFLIGHT FAILED (174): authenticated cannot execute expected API: %', v_target;
    END IF;
    IF NOT has_function_privilege('service_role', to_regprocedure(v_target), 'EXECUTE') THEN
      RAISE EXCEPTION 'PREFLIGHT FAILED (174): service_role cannot execute expected API: %', v_target;
    END IF;

    -- This wave exists only to remove accidental anonymous reach. Refuse to
    -- run if that reach is already absent rather than operating blindly.
    IF NOT has_function_privilege('anon', to_regprocedure(v_target), 'EXECUTE') THEN
      RAISE EXCEPTION 'PREFLIGHT FAILED (174): anon already cannot execute %, refusing duplicate/ambiguous hardening', v_target;
    END IF;

    v_defs_before := v_defs_before || jsonb_build_object(
      v_target,
      pg_get_functiondef(to_regprocedure(v_target))
    );
  END LOOP;

  -- Public QR is intentional and must remain public.
  IF to_regprocedure(v_qr) IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (174): public QR function absent';
  END IF;
  v_qr_anon_before := has_function_privilege('anon', to_regprocedure(v_qr), 'EXECUTE');
  v_qr_auth_before := has_function_privilege('authenticated', to_regprocedure(v_qr), 'EXECUTE');
  v_qr_service_before := has_function_privilege('service_role', to_regprocedure(v_qr), 'EXECUTE');
  IF NOT v_qr_anon_before THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (174): public QR is not anonymous before hardening';
  END IF;

  -- Core authorization helpers are deliberately out of this wave.
  v_my_role_auth_before := has_function_privilege(
    'authenticated', to_regprocedure('public.phoenix_my_role()'), 'EXECUTE');
  v_my_org_auth_before := has_function_privilege(
    'authenticated', to_regprocedure('public.phoenix_my_org()'), 'EXECUTE');
  IF NOT v_my_role_auth_before OR NOT v_my_org_auth_before THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (174): core authenticated helpers not in expected state';
  END IF;

  -- ══════════════════════════════════════════════════════════════════════════
  -- CHANGE — exact nine overloads only. authenticated/service_role are NOT
  -- revoked and receive no replacement grant; their existing explicit grants
  -- remain intact.
  -- ══════════════════════════════════════════════════════════════════════════
  FOREACH v_target IN ARRAY v_targets LOOP
    EXECUTE 'REVOKE EXECUTE ON FUNCTION ' || v_target || ' FROM PUBLIC';
    EXECUTE 'REVOKE EXECUTE ON FUNCTION ' || v_target || ' FROM anon';
  END LOOP;

  -- ══════════════════════════════════════════════════════════════════════════
  -- VERIFY — a failure rolls this DO statement back atomically.
  -- ══════════════════════════════════════════════════════════════════════════
  FOREACH v_target IN ARRAY v_targets LOOP
    IF to_regprocedure(v_target) IS NULL THEN
      RAISE EXCEPTION 'VERIFY FAILED (174): target disappeared: %', v_target;
    END IF;

    v_def_after := pg_get_functiondef(to_regprocedure(v_target));
    IF v_def_after IS DISTINCT FROM (v_defs_before ->> v_target) THEN
      RAISE EXCEPTION 'VERIFY FAILED (174): function definition changed: %', v_target;
    END IF;

    IF has_function_privilege('anon', to_regprocedure(v_target), 'EXECUTE') THEN
      RAISE EXCEPTION 'VERIFY FAILED (174): anon can still execute: %', v_target;
    END IF;
    IF NOT has_function_privilege('authenticated', to_regprocedure(v_target), 'EXECUTE') THEN
      RAISE EXCEPTION 'VERIFY FAILED (174): authenticated lost EXECUTE: %', v_target;
    END IF;
    IF NOT has_function_privilege('service_role', to_regprocedure(v_target), 'EXECUTE') THEN
      RAISE EXCEPTION 'VERIFY FAILED (174): service_role lost EXECUTE: %', v_target;
    END IF;
  END LOOP;

  -- QR ACL must be byte-for-behaviour equivalent for API roles.
  IF NOT has_function_privilege('anon', to_regprocedure(v_qr), 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (174): anon lost public QR EXECUTE';
  END IF;
  IF has_function_privilege('authenticated', to_regprocedure(v_qr), 'EXECUTE')
       IS DISTINCT FROM v_qr_auth_before THEN
    RAISE EXCEPTION 'VERIFY FAILED (174): authenticated QR EXECUTE changed';
  END IF;
  IF has_function_privilege('service_role', to_regprocedure(v_qr), 'EXECUTE')
       IS DISTINCT FROM v_qr_service_before THEN
    RAISE EXCEPTION 'VERIFY FAILED (174): service_role QR EXECUTE changed';
  END IF;

  -- Explicitly prove out-of-scope core helpers remain usable by authenticated.
  IF has_function_privilege('authenticated', to_regprocedure('public.phoenix_my_role()'), 'EXECUTE')
       IS DISTINCT FROM v_my_role_auth_before THEN
    RAISE EXCEPTION 'VERIFY FAILED (174): phoenix_my_role() ACL changed';
  END IF;
  IF has_function_privilege('authenticated', to_regprocedure('public.phoenix_my_org()'), 'EXECUTE')
       IS DISTINCT FROM v_my_org_auth_before THEN
    RAISE EXCEPTION 'VERIFY FAILED (174): phoenix_my_org() ACL changed';
  END IF;
END;
$hardening$;

-- ============================================================================
-- ROLLBACK GUIDANCE — documentation only, deliberately NOT executed.
--
-- Normal application functionality should need no rollback because this file
-- preserves authenticated and service_role grants. If a previously unknown
-- anonymous integration were ever proven legitimate, restore only the exact
-- required role on the exact overload after review; do NOT broadly restore
-- PUBLIC. Re-granting PUBLIC would intentionally reopen anonymous access and
-- requires a separate explicit owner/security decision.
-- ============================================================================
