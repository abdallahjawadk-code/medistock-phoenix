-- R2-A authority foundation only. NOT APPLIED to any hosted database.
-- No allocation/dispatch/settlement writer exists in this slice. No role grants.
BEGIN;
DO $precondition$
BEGIN
  IF to_regprocedure('public._phoenix_central_needs_guard_v1(uuid,text)') IS NULL
    OR to_regprocedure('phoenix_private.central_needs_capability_breaches_v1()') IS NULL
    OR to_regnamespace('phoenix_r2') IS NOT NULL THEN
    RAISE EXCEPTION 'r2_authority_precondition_failed';
  END IF;
  IF EXISTS(SELECT 1 FROM phoenix_private.central_needs_capability_breaches_v1()) THEN
    RAISE EXCEPTION 'r2_prior_capability_seal_failed';
  END IF;
END $precondition$;

CREATE SCHEMA phoenix_r2;
REVOKE ALL ON SCHEMA phoenix_r2 FROM PUBLIC,anon,authenticated,service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA phoenix_r2 REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA phoenix_r2 REVOKE ALL ON TABLES FROM PUBLIC,anon,authenticated,service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA phoenix_r2 REVOKE ALL ON SEQUENCES FROM PUBLIC,anon,authenticated,service_role;

INSERT INTO public.permission_keys(key,module,action,label_en,label_ar,is_dangerous) VALUES
 ('central_needs.allocation.view','central_needs','allocation.view','View allocations','عرض التحصيص',false),
 ('central_needs.allocation.create','central_needs','allocation.create','Propose allocation','اقتراح حصة',true),
 ('central_needs.allocation.approve','central_needs','allocation.approve','Approve allocation','اعتماد حصة',true),
 ('central_needs.allocation.correct','central_needs','allocation.correct','Propose allocation correction','اقتراح تصحيح حصة',true),
 ('central_needs.allocation.settlement.create','central_needs','allocation.settlement.create','Propose execution settlement','اقتراح تسوية تنفيذ',true),
 ('central_needs.allocation.settlement.approve','central_needs','allocation.settlement.approve','Approve execution settlement','اعتماد تسوية تنفيذ',true);
-- Deliberately no INSERT into role_permission_defaults or profile overrides.

CREATE TABLE phoenix_r2.activation_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
 enabled boolean NOT NULL,
 release_reference text NOT NULL CHECK(length(btrim(release_reference)) BETWEEN 8 AND 2000),
 database_actor name NOT NULL DEFAULT session_user,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE phoenix_r2.activation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE phoenix_r2.activation_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON phoenix_r2.activation_events FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA phoenix_r2 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION phoenix_r2.reject_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN RAISE EXCEPTION 'r2_immutable_history' USING ERRCODE='42501'; END $$;
REVOKE ALL ON FUNCTION phoenix_r2.reject_mutation() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER r2_activation_immutable BEFORE UPDATE OR DELETE ON phoenix_r2.activation_events
 FOR EACH ROW EXECUTE FUNCTION phoenix_r2.reject_mutation();
CREATE TRIGGER r2_activation_no_truncate BEFORE TRUNCATE ON phoenix_r2.activation_events
 FOR EACH STATEMENT EXECUTE FUNCTION phoenix_r2.reject_mutation();

CREATE FUNCTION phoenix_r2.owner_guard(p_org uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE actor uuid:=auth.uid(); role_name text;
BEGIN
  -- Preserve the existing annual membership/view predicate and its whitelist.
  role_name:=public._phoenix_central_needs_guard_v1(p_org,'central_needs.view');
  PERFORM 1 FROM public.profiles WHERE id=actor FOR SHARE;
  PERFORM 1 FROM public.organizations WHERE id=p_org FOR SHARE;
  role_name:=public._phoenix_central_needs_guard_v1(p_org,'central_needs.view');
  IF NOT EXISTS(SELECT 1 FROM public.organizations WHERE id=p_org AND status='active' AND archived_at IS NULL) THEN
    RAISE EXCEPTION 'r2_owner_inactive' USING ERRCODE='42501';
  END IF;
  RETURN role_name;
END $$;
REVOKE ALL ON FUNCTION phoenix_r2.owner_guard(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION phoenix_r2.has_explicit_key(p_org uuid,p_key text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT COALESCE(p_key IN ('central_needs.allocation.view','central_needs.allocation.create',
   'central_needs.allocation.approve','central_needs.allocation.correct',
   'central_needs.allocation.settlement.create','central_needs.allocation.settlement.approve')
   AND public.phoenix_profile_has_permission(auth.uid(),p_key)
   AND EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.status='active' AND p.organization_id=p_org
     AND (EXISTS(SELECT 1 FROM public.profile_permission_overrides o WHERE o.profile_id=p.id AND o.permission_key=p_key
         AND o.allowed=true AND (o.scope_organization_id IS NULL OR o.scope_organization_id=p_org)
         AND o.scope_warehouse_id IS NULL AND o.scope_point_id IS NULL)
       OR (NOT EXISTS(SELECT 1 FROM public.profile_permission_overrides o WHERE o.profile_id=p.id AND o.permission_key=p_key AND o.allowed IS NOT NULL)
         AND EXISTS(SELECT 1 FROM public.role_permission_defaults d WHERE d.role=p.role AND d.permission_key=p_key AND d.allowed=true))))
 ,false)
$$;
REVOKE ALL ON FUNCTION phoenix_r2.has_explicit_key(uuid,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION phoenix_r2.is_enabled(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT COALESCE((SELECT enabled FROM phoenix_r2.activation_events WHERE organization_id=p_org ORDER BY id DESC LIMIT 1),false)
$$;
REVOKE ALL ON FUNCTION phoenix_r2.is_enabled(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION phoenix_r2.require_authority(p_org uuid,p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE role_name text; employee text;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'r2_requires_read_committed' USING ERRCODE='25000';
  END IF;
  role_name:=phoenix_r2.owner_guard(p_org);
  IF NOT phoenix_r2.has_explicit_key(p_org,'central_needs.allocation.view')
     OR NOT phoenix_r2.has_explicit_key(p_org,p_key) THEN
    RAISE EXCEPTION 'r2_permission_denied' USING ERRCODE='42501';
  END IF;
  IF NOT phoenix_r2.is_enabled(p_org) THEN RAISE EXCEPTION 'r2_not_activated' USING ERRCODE='55000'; END IF;
  SELECT p.full_name INTO employee FROM public.profiles p WHERE p.id=auth.uid();
  IF nullif(btrim(employee),'') IS NULL THEN RAISE EXCEPTION 'r2_employee_name_required' USING ERRCODE='23514'; END IF;
  RETURN jsonb_build_object('actorId',auth.uid(),'actorName',employee,'actorRole',role_name,'ownerOrgId',p_org);
END $$;
REVOKE ALL ON FUNCTION phoenix_r2.require_authority(uuid,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.phoenix_r2_capabilities(p_organization_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE visible boolean; enabled boolean;
BEGIN
  PERFORM phoenix_r2.owner_guard(p_organization_id);
  visible:=phoenix_r2.has_explicit_key(p_organization_id,'central_needs.allocation.view');
  enabled:=phoenix_r2.is_enabled(p_organization_id);
  RETURN jsonb_build_object('version',1,'phase','authority_foundation','ownerOrgId',p_organization_id,
    'operationalWritesImplemented',false,'authorityActivated',enabled,'view',visible,
    'create',visible AND enabled AND phoenix_r2.has_explicit_key(p_organization_id,'central_needs.allocation.create'),
    'approve',visible AND enabled AND phoenix_r2.has_explicit_key(p_organization_id,'central_needs.allocation.approve'),
    'correct',visible AND enabled AND phoenix_r2.has_explicit_key(p_organization_id,'central_needs.allocation.correct'),
    'settlementCreate',visible AND enabled AND phoenix_r2.has_explicit_key(p_organization_id,'central_needs.allocation.settlement.create'),
    'settlementApprove',visible AND enabled AND phoenix_r2.has_explicit_key(p_organization_id,'central_needs.allocation.settlement.approve'));
END $$;
REVOKE ALL ON FUNCTION public.phoenix_r2_capabilities(uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.phoenix_r2_capabilities(uuid) TO authenticated;

CREATE FUNCTION phoenix_r2.capability_breaches() RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT 'R2 private schema is accessible to API role '||r.rolname
 FROM pg_roles r WHERE r.rolname IN ('anon','authenticated','service_role') AND has_schema_privilege(r.oid,'phoenix_r2','USAGE')
 UNION ALL
 SELECT 'R2 private routine is callable by API role '||r.rolname||': '||p.oid::regprocedure::text
 FROM pg_proc p CROSS JOIN pg_roles r WHERE p.pronamespace='phoenix_r2'::regnamespace
   AND r.rolname IN ('anon','authenticated','service_role') AND has_function_privilege(r.oid,p.oid,'EXECUTE')
 UNION ALL
 SELECT 'R2 private relation is accessible to API role '||r.rolname||': '||c.relname
 FROM pg_class c CROSS JOIN pg_roles r WHERE c.relnamespace='phoenix_r2'::regnamespace AND c.relkind IN ('r','S')
   AND r.rolname IN ('anon','authenticated','service_role')
   AND CASE WHEN c.relkind='S' THEN has_sequence_privilege(r.oid,c.oid,'USAGE,SELECT,UPDATE')
     ELSE has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') END
 UNION ALL
 SELECT 'R2 activation history lacks forced RLS' FROM pg_class c WHERE c.oid='phoenix_r2.activation_events'::regclass
   AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)
 UNION ALL
 SELECT 'R2 activation history lacks immutable trigger '||g.name FROM (VALUES ('r2_activation_immutable'),('r2_activation_no_truncate')) g(name)
 WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='phoenix_r2.activation_events'::regclass
   AND t.tgname=g.name AND t.tgfoid='phoenix_r2.reject_mutation()'::regprocedure AND t.tgenabled='O'
   AND t.tgtype=CASE WHEN g.name='r2_activation_immutable' THEN 27 ELSE 34 END)
 UNION ALL
 SELECT 'Unexpected R2 private routine: '||p.oid::regprocedure::text FROM pg_proc p
 WHERE p.pronamespace='phoenix_r2'::regnamespace AND p.oid NOT IN (
   'phoenix_r2.reject_mutation()'::regprocedure,'phoenix_r2.owner_guard(uuid)'::regprocedure,
   'phoenix_r2.has_explicit_key(uuid,text)'::regprocedure,'phoenix_r2.is_enabled(uuid)'::regprocedure,
   'phoenix_r2.require_authority(uuid,text)'::regprocedure,'phoenix_r2.capability_breaches()'::regprocedure)
 UNION ALL
 SELECT 'Unexpected R2 public routine: '||p.oid::regprocedure::text FROM pg_proc p
 WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'phoenix_r2_%'
   AND p.oid<>'public.phoenix_r2_capabilities(uuid)'::regprocedure
 UNION ALL
 SELECT 'R2 object owned by API role: '||p.oid::regprocedure::text FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
 WHERE (p.pronamespace='phoenix_r2'::regnamespace OR p.oid='public.phoenix_r2_capabilities(uuid)'::regprocedure)
   AND r.rolname IN ('anon','authenticated','service_role')
 UNION ALL
 SELECT 'R2 discovery execute boundary changed' WHERE NOT has_function_privilege('authenticated','public.phoenix_r2_capabilities(uuid)','EXECUTE')
   OR has_function_privilege('anon','public.phoenix_r2_capabilities(uuid)','EXECUTE')
   OR has_function_privilege('service_role','public.phoenix_r2_capabilities(uuid)','EXECUTE')
$$;
REVOKE ALL ON FUNCTION phoenix_r2.capability_breaches() FROM PUBLIC,anon,authenticated,service_role;

DO $verify$
BEGIN
 IF EXISTS(SELECT 1 FROM public.role_permission_defaults WHERE permission_key LIKE 'central_needs.allocation.%')
   OR EXISTS(SELECT 1 FROM public.profile_permission_overrides WHERE permission_key LIKE 'central_needs.allocation.%')
   OR EXISTS(SELECT 1 FROM phoenix_r2.activation_events)
   OR EXISTS(SELECT 1 FROM phoenix_private.central_needs_capability_breaches_v1())
   OR EXISTS(SELECT 1 FROM phoenix_r2.capability_breaches()) THEN
   RAISE EXCEPTION 'r2_authority_verify_failed';
 END IF;
END $verify$;
COMMIT;
