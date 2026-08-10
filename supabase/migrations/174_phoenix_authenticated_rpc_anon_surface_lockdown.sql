-- 174_phoenix_authenticated_rpc_anon_surface_lockdown.sql
--
-- Purpose: remove anonymous reachability from a deliberately small set of
-- authenticated/admin SECURITY DEFINER RPCs whose bodies already reject
-- unauthenticated callers. Their authenticated + service_role EXECUTE grants
-- are explicit in the reviewed baseline, so removing PUBLIC does not change
-- legitimate client/service reachability.
--
-- SAFETY CONTRACT
--   * ACL-only: no function body/signature/search_path change.
--   * No RLS/table/view/trigger/data mutation.
--   * Public QR remains anonymously executable.
--   * phoenix_my_role()/phoenix_my_org() authenticated reachability is pinned.
--   * Trigger functions are intentionally NOT included in this wave.
--   * Entire change + verification lives in one DO statement, so any failed
--     postcondition aborts the statement atomically.

DO $hardening$
DECLARE
  v_targets text[] := ARRAY[
    'public.archive_entity(text,uuid,text)',
    'public.assign_profile_permissions(uuid,jsonb)',
    'public.assign_profile_role(uuid,text)',
    'public.get_effective_permissions(uuid)',
    'public.get_entity_purge_impact(text,uuid)',
    'public.purge_entity_with_all_data(text,uuid,text)',
    'public.reset_profile_permissions(uuid)'
  ];
  v_sig text;
  v_oid oid;
  v_defs jsonb := '{}'::jsonb;
BEGIN
  -- PRE-FLIGHT: exact objects, exact positive-path principals, and the
  -- currently-open anonymous surface must all match the reviewed baseline.
  FOREACH v_sig IN ARRAY v_targets LOOP
    v_oid := to_regprocedure(v_sig);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'PREFLIGHT FAILED (174): required function % is absent', v_sig;
    END IF;

    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_oid) THEN
      RAISE EXCEPTION 'PREFLIGHT FAILED (174): % is no longer SECURITY DEFINER', v_sig;
    END IF;

    IF NOT has_function_privilege('anon', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'PREFLIGHT FAILED (174): anon already lacks EXECUTE on %; refusing baseline drift', v_sig;
    END IF;
    IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'PREFLIGHT FAILED (174): authenticated lacks EXECUTE on %', v_sig;
    END IF;
    IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'PREFLIGHT FAILED (174): service_role lacks EXECUTE on %', v_sig;
    END IF;

    v_defs := v_defs || jsonb_build_object(v_sig, pg_get_functiondef(v_oid));
  END LOOP;

  IF to_regprocedure('public.get_public_qr_payload(text)') IS NULL
     OR NOT has_function_privilege('anon', to_regprocedure('public.get_public_qr_payload(text)'), 'EXECUTE') THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (174): anonymous public QR contract is not healthy';
  END IF;

  -- Remove the inherited/default PUBLIC path and any direct anon grant. The
  -- explicit authenticated/service_role grants are intentionally untouched.
  FOREACH v_sig IN ARRAY v_targets LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', v_sig);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', v_sig);
  END LOOP;

  -- VERIFY: negative path is closed; every legitimate positive path and every
  -- function definition remains unchanged.
  FOREACH v_sig IN ARRAY v_targets LOOP
    v_oid := to_regprocedure(v_sig);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'VERIFY FAILED (174): % disappeared', v_sig;
    END IF;
    IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'VERIFY FAILED (174): anon still executes %', v_sig;
    END IF;
    IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'VERIFY FAILED (174): authenticated lost EXECUTE on %', v_sig;
    END IF;
    IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'VERIFY FAILED (174): service_role lost EXECUTE on %', v_sig;
    END IF;
    IF pg_get_functiondef(v_oid) IS DISTINCT FROM (v_defs ->> v_sig) THEN
      RAISE EXCEPTION 'VERIFY FAILED (174): function definition changed for %', v_sig;
    END IF;
  END LOOP;

  IF NOT has_function_privilege('anon', to_regprocedure('public.get_public_qr_payload(text)'), 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (174): public QR lost anonymous EXECUTE';
  END IF;
  IF NOT has_function_privilege('authenticated', to_regprocedure('public.phoenix_my_role()'), 'EXECUTE')
     OR NOT has_function_privilege('authenticated', to_regprocedure('public.phoenix_my_org()'), 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (174): core authenticated identity helpers changed';
  END IF;
END;
$hardening$;
