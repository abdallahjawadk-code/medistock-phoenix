-- Additive transaction adapters. NOT APPLIED HOSTED. No data/role changes.
-- The original STABLE reads call a locking authorization guard. PostgREST POST
-- therefore needs VOLATILE entry points, as documented by canonical M214.
BEGIN;
SET LOCAL search_path=pg_catalog,pg_temp;
DO $pre$
BEGIN
  IF current_user<>pg_get_userbyid((SELECT datdba FROM pg_database WHERE datname=current_database()))
    OR to_regprocedure('phoenix_private.central_needs_capability_breaches_v1()') IS NULL
    OR EXISTS(SELECT 1 FROM phoenix_private.central_needs_capability_breaches_v1())
    OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname~'^phoenix_manual_read_')
    OR (SELECT count(*) FROM pg_proc WHERE oid IN (
      to_regprocedure('public.phoenix_central_needs_list_dossiers(uuid,integer)'),
      to_regprocedure('public.phoenix_central_needs_annual_summary(uuid,integer)'),
      to_regprocedure('public.phoenix_central_needs_dossier_revisions(uuid)')) AND provolatile='s')<>3
    THEN RAISE EXCEPTION 'manual_read_adapter_precondition_failed'; END IF;
END $pre$;
-- Transaction-local evidence: preserve every existing application routine and ACL.
CREATE TEMP TABLE manual_read_previous_routines ON COMMIT DROP AS
  SELECT p.oid,pg_get_functiondef(p.oid) definition,p.proacl,p.proowner
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE (n.nspname='public' OR n.nspname LIKE 'phoenix%') AND p.prokind IN ('f','p');

CREATE FUNCTION public.phoenix_manual_read_dossiers_v1(p_organization_id uuid,p_plan_year integer)
RETURNS SETOF jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  RETURN QUERY SELECT * FROM public.phoenix_central_needs_list_dossiers(p_organization_id,p_plan_year);
END $$;
CREATE FUNCTION public.phoenix_manual_read_annual_summary_v1(p_organization_id uuid,p_plan_year integer)
RETURNS SETOF jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  RETURN QUERY SELECT * FROM public.phoenix_central_needs_annual_summary(p_organization_id,p_plan_year);
END $$;
CREATE FUNCTION public.phoenix_manual_read_dossier_revisions_v1(p_plan_id uuid)
RETURNS SETOF public.central_needs_plan_revisions LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  RETURN QUERY SELECT * FROM public.phoenix_central_needs_dossier_revisions(p_plan_id);
END $$;
REVOKE ALL ON FUNCTION public.phoenix_manual_read_dossiers_v1(uuid,integer),
  public.phoenix_manual_read_annual_summary_v1(uuid,integer),public.phoenix_manual_read_dossier_revisions_v1(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.phoenix_manual_read_dossiers_v1(uuid,integer),
  public.phoenix_manual_read_annual_summary_v1(uuid,integer),public.phoenix_manual_read_dossier_revisions_v1(uuid)
  TO authenticated;

DO $verify$
DECLARE r record; principal record;
BEGIN
  IF EXISTS(SELECT 1 FROM manual_read_previous_routines old LEFT JOIN pg_proc p ON p.oid=old.oid
    WHERE p.oid IS NULL OR pg_get_functiondef(p.oid) IS DISTINCT FROM old.definition
      OR p.proacl IS DISTINCT FROM old.proacl OR p.proowner IS DISTINCT FROM old.proowner)
    OR EXISTS(SELECT 1 FROM phoenix_private.central_needs_capability_breaches_v1())
    THEN RAISE EXCEPTION 'manual_read_adapter_prior_contract_drift'; END IF;
  FOR r IN SELECT p.*,l.lanname FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
    WHERE p.pronamespace='public'::regnamespace AND p.proname~'^phoenix_manual_read_' LOOP
    IF r.prosecdef OR r.provolatile<>'v' OR r.lanname<>'plpgsql'
      OR r.proowner<>(SELECT datdba FROM pg_database WHERE datname=current_database())
      OR r.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
      THEN RAISE EXCEPTION 'manual_read_adapter_metadata_invalid'; END IF;
    FOR principal IN SELECT * FROM pg_roles WHERE NOT rolsuper AND oid<>r.proowner LOOP
      IF has_function_privilege(principal.oid,r.oid,'EXECUTE') IS DISTINCT FROM (principal.rolname='authenticated')
        THEN RAISE EXCEPTION 'manual_read_adapter_acl_invalid'; END IF;
    END LOOP;
  END LOOP;
END $verify$;
NOTIFY pgrst,'reload schema';
COMMIT;
