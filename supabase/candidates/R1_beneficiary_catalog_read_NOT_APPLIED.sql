-- Narrow annual-journey lookup; NOT APPLIED HOSTED. No directory/RLS/role changes.
-- Eligibility matches the existing M226 manual-need beneficiary guard.
BEGIN;
SET LOCAL search_path=pg_catalog,pg_temp;
DO $pre$
BEGIN
  IF current_user<>pg_get_userbyid((SELECT datdba FROM pg_database WHERE datname=current_database()))
    OR to_regprocedure('phoenix_private.central_needs_capability_breaches_v1()') IS NULL
    OR EXISTS(SELECT 1 FROM phoenix_private.central_needs_capability_breaches_v1())
    OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='phoenix_manual_beneficiaries_v1')
    THEN RAISE EXCEPTION 'manual_beneficiaries_precondition_failed'; END IF;
END $pre$;
CREATE TEMP TABLE manual_beneficiaries_previous_routines ON COMMIT DROP AS
  SELECT p.oid,pg_get_functiondef(p.oid) definition,p.proacl,p.proowner
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE (n.nspname='public' OR n.nspname LIKE 'phoenix%') AND p.prokind IN ('f','p');

CREATE FUNCTION public.phoenix_manual_beneficiaries_v1(p_organization_id uuid,p_after_id uuid DEFAULT NULL,p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE result jsonb;
BEGIN
  PERFORM public._phoenix_central_needs_guard_v1(p_organization_id,'central_needs.view');
  IF EXISTS(SELECT 1 FROM phoenix_private.central_needs_capability_breaches_v1()) THEN
    RAISE EXCEPTION 'manual_beneficiaries_schema_not_ready' USING ERRCODE='55000'; END IF;
  IF p_limit IS NULL OR p_limit<1 OR p_limit>50 THEN
    RAISE EXCEPTION 'manual_beneficiaries_limit_invalid' USING ERRCODE='23514'; END IF;
  WITH candidates AS (
    SELECT o.id,o.name,coalesce(nullif(o.name_ar,''),o.name) name_ar
    FROM public.organizations o WHERE o.organization_kind='care_institution' AND o.status='active' AND o.archived_at IS NULL
      AND (p_after_id IS NULL OR o.id>p_after_id) ORDER BY o.id LIMIT p_limit+1
  ), page AS (SELECT * FROM candidates ORDER BY id LIMIT p_limit)
  SELECT jsonb_build_object('version',1,'ownerOrgId',p_organization_id,
    'rows',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'nameAr',name_ar) ORDER BY id) FROM page),'[]'::jsonb),
    'nextAfterId',CASE WHEN (SELECT count(*) FROM candidates)>p_limit THEN (SELECT id FROM page ORDER BY id DESC LIMIT 1) ELSE NULL END)
  INTO result;
  IF octet_length(result::text)>262144 THEN RAISE EXCEPTION 'manual_beneficiaries_response_limit' USING ERRCODE='54000'; END IF;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.phoenix_manual_beneficiaries_v1(uuid,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.phoenix_manual_beneficiaries_v1(uuid,uuid,integer) TO authenticated;

DO $verify$
DECLARE r record; principal record;
BEGIN
  IF EXISTS(SELECT 1 FROM manual_beneficiaries_previous_routines old LEFT JOIN pg_proc p ON p.oid=old.oid
    WHERE p.oid IS NULL OR pg_get_functiondef(p.oid) IS DISTINCT FROM old.definition
      OR p.proacl IS DISTINCT FROM old.proacl OR p.proowner IS DISTINCT FROM old.proowner)
    OR EXISTS(SELECT 1 FROM phoenix_private.central_needs_capability_breaches_v1())
    THEN RAISE EXCEPTION 'manual_beneficiaries_prior_contract_drift'; END IF;
  SELECT p.*,l.lanname INTO STRICT r FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
    WHERE p.oid='public.phoenix_manual_beneficiaries_v1(uuid,uuid,integer)'::regprocedure;
  IF NOT r.prosecdef OR r.provolatile<>'v' OR r.lanname<>'plpgsql'
    OR r.proowner<>(SELECT datdba FROM pg_database WHERE datname=current_database())
    OR r.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[] THEN
    RAISE EXCEPTION 'manual_beneficiaries_metadata_invalid'; END IF;
  FOR principal IN SELECT * FROM pg_roles WHERE NOT rolsuper AND oid<>r.proowner LOOP
    IF has_function_privilege(principal.oid,r.oid,'EXECUTE') IS DISTINCT FROM (principal.rolname='authenticated') THEN
      RAISE EXCEPTION 'manual_beneficiaries_acl_invalid'; END IF;
  END LOOP;
END $verify$;
NOTIFY pgrst,'reload schema';
COMMIT;
