-- Owner-published documented metadata only. NOT APPLIED HOSTED.
-- No employee policy publisher, default reference, quota or stock writer.
BEGIN;
SET LOCAL search_path=pg_catalog,pg_temp;
DO $pre$
BEGIN
  IF current_user<>pg_get_userbyid((SELECT datdba FROM pg_database WHERE datname=current_database()))
    OR to_regnamespace('phoenix_monthly') IS NOT NULL
    OR to_regprocedure('phoenix_private.annual_needs_reference_v1(uuid,integer,uuid,uuid,uuid,text)') IS NULL
    OR to_regprocedure('phoenix_r2.capability_breaches()') IS NULL
    OR EXISTS(SELECT 1 FROM phoenix_private.central_needs_capability_breaches_v1())
    OR EXISTS(SELECT 1 FROM phoenix_r2.capability_breaches())
    OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname~'^phoenix_monthly_') THEN RAISE EXCEPTION 'monthly_precondition_failed'; END IF;
END $pre$;
CREATE SCHEMA phoenix_monthly;
REVOKE ALL ON SCHEMA phoenix_monthly FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE phoenix_monthly.policy_references(
  id uuid PRIMARY KEY, context_key text NOT NULL, organization_id uuid NOT NULL, planning_year integer NOT NULL,
  annual_item_id uuid NOT NULL, field_version_id uuid NOT NULL, central_item_id uuid NOT NULL REFERENCES public.central_items(id),
  beneficiary_id uuid NOT NULL REFERENCES public.organizations(id), rule_beneficiary_id uuid REFERENCES public.organizations(id),
  version integer NOT NULL CHECK(version>0), active boolean NOT NULL, previous_id uuid,
  payload jsonb NOT NULL CHECK(octet_length(payload::text)<=65536), fingerprint text NOT NULL,
  published_by name NOT NULL DEFAULT session_user,published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(fingerprint=phoenix_private.annual_catalog_hash_v1(payload-'fingerprint') AND payload->>'fingerprint'=fingerprint),
  UNIQUE(context_key,version),UNIQUE(context_key,id),
  FOREIGN KEY(context_key,previous_id) REFERENCES phoenix_monthly.policy_references(context_key,id),
  FOREIGN KEY(organization_id,planning_year,annual_item_id,field_version_id)
    REFERENCES public.central_needs_annual_versions(organization_id,planning_year,annual_item_id,id));
CREATE TABLE phoenix_monthly.manifest(kind text NOT NULL CHECK(kind IN ('function','relation')),name text NOT NULL,
  definition jsonb NOT NULL,PRIMARY KEY(kind,name));
DO $tables$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['policy_references','manifest'] LOOP
    EXECUTE format('ALTER TABLE phoenix_monthly.%I ENABLE ROW LEVEL SECURITY',r);
    EXECUTE format('ALTER TABLE phoenix_monthly.%I FORCE ROW LEVEL SECURITY',r);
    EXECUTE format('REVOKE ALL ON TABLE phoenix_monthly.%I FROM PUBLIC,anon,authenticated,service_role',r);
  END LOOP;
END $tables$;

CREATE FUNCTION phoenix_monthly.immutable_v1() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN RAISE EXCEPTION 'monthly_history_immutable' USING ERRCODE='23514'; END $$;
DO $triggers$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['policy_references','manifest'] LOOP
    EXECUTE format('CREATE TRIGGER monthly_immutable_rows BEFORE UPDATE OR DELETE ON phoenix_monthly.%I FOR EACH ROW EXECUTE FUNCTION phoenix_monthly.immutable_v1()',r);
    EXECUTE format('CREATE TRIGGER monthly_immutable_truncate BEFORE TRUNCATE ON phoenix_monthly.%I FOR EACH STATEMENT EXECUTE FUNCTION phoenix_monthly.immutable_v1()',r);
  END LOOP;
END $triggers$;
CREATE FUNCTION phoenix_monthly.relation_definition_v1(p_relation regclass) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('owner',c.relowner,'kind',c.relkind,'rls',c.relrowsecurity,'force',c.relforcerowsecurity,
  'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,
    pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
  'constraints',(SELECT jsonb_agg(jsonb_build_array(x.conname,pg_get_constraintdef(x.oid,true)) ORDER BY x.conname) FROM pg_constraint x WHERE x.conrelid=c.oid),
  'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgname,t.tgenabled,pg_get_triggerdef(t.oid,true)) ORDER BY t.tgname)
    FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal)) FROM pg_class c WHERE c.oid=p_relation
$$;
CREATE FUNCTION phoenix_monthly.capability_breaches_v1() RETURNS SETOF text LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE m record; function_row record; r record; owner_id oid:=(SELECT datdba FROM pg_database WHERE datname=current_database());
BEGIN
  IF (SELECT count(*) FROM phoenix_monthly.manifest WHERE kind='relation')<>2 THEN RETURN NEXT 'monthly_relation_manifest'; END IF;
  FOR m IN SELECT * FROM phoenix_monthly.manifest WHERE kind='relation' LOOP
    IF phoenix_monthly.relation_definition_v1(to_regclass(m.name)) IS DISTINCT FROM m.definition THEN RETURN NEXT 'monthly_relation_drift:'||m.name; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phoenix_monthly'
    AND c.relkind IN ('r','p','v','m','f') AND NOT EXISTS(SELECT 1 FROM phoenix_monthly.manifest x WHERE x.kind='relation' AND to_regclass(x.name)=c.oid))
    THEN RETURN NEXT 'monthly_unregistered_relation'; END IF;
  -- Predefined NOLOGIN capability roles are not login principals. Every
  -- effective member, including NOLOGIN application/platform aliases, is checked.
  FOR r IN SELECT * FROM pg_roles WHERE NOT rolsuper AND oid<>owner_id
    AND NOT (rolname IN ('pg_read_all_data','pg_write_all_data') AND NOT rolcanlogin) LOOP
    IF pg_has_role(r.oid,'pg_read_all_data','MEMBER') OR pg_has_role(r.oid,'pg_write_all_data','MEMBER') THEN
      RETURN NEXT 'monthly_inherited_global_data:'||r.rolname; END IF;
    IF has_schema_privilege(r.oid,'phoenix_monthly','USAGE,CREATE') THEN RETURN NEXT 'monthly_schema_privilege:'||r.rolname; END IF;
    IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phoenix_monthly' AND c.relkind='r'
      AND (has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
      THEN RETURN NEXT 'monthly_table_privilege:'||r.rolname; END IF;
  END LOOP;
  FOR m IN SELECT * FROM phoenix_monthly.manifest WHERE kind='function' LOOP
    SELECT q.*,l.lanname INTO function_row FROM pg_proc q JOIN pg_language l ON l.oid=q.prolang WHERE q.oid=to_regprocedure(m.name);
    IF NOT FOUND OR function_row.proowner<>owner_id OR md5(pg_get_functiondef(function_row.oid)) IS DISTINCT FROM m.definition->>'definitionMd5'
      OR function_row.prosecdef IS DISTINCT FROM (m.definition->>'definer')::boolean
      OR to_jsonb(function_row.proconfig) IS DISTINCT FROM m.definition->'config' OR function_row.lanname IS DISTINCT FROM m.definition->>'language'
      THEN RETURN NEXT 'monthly_function_drift:'||m.name; CONTINUE; END IF;
    FOR r IN SELECT * FROM pg_roles WHERE NOT rolsuper AND oid<>owner_id LOOP
      IF has_function_privilege(r.oid,function_row.oid,'EXECUTE') IS DISTINCT FROM (r.rolname=coalesce(m.definition->>'allowedRole',''))
        THEN RETURN NEXT 'monthly_function_privilege:'||m.name||':'||r.rolname; END IF;
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE (n.nspname='phoenix_monthly' OR (n.nspname='public' AND p.proname~'^phoenix_monthly_') OR (p.prosecdef AND p.prosrc~'\mphoenix_monthly\M'))
      AND NOT EXISTS(SELECT 1 FROM phoenix_monthly.manifest entry WHERE entry.kind='function' AND to_regprocedure(entry.name)=p.oid))
    THEN RETURN NEXT 'monthly_unregistered_routine'; END IF;
END $$;
CREATE FUNCTION phoenix_monthly.ready_v1() RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM phoenix_private.central_needs_capability_breaches_v1())
    OR EXISTS(SELECT 1 FROM phoenix_r2.capability_breaches())
    OR EXISTS(SELECT 1 FROM phoenix_monthly.capability_breaches_v1()) THEN
    RAISE EXCEPTION 'monthly_schema_not_ready' USING ERRCODE='55000'; END IF;
END $$;
CREATE FUNCTION phoenix_monthly.quantity_v1(p_value jsonb) RETURNS numeric LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE q text;
BEGIN
  PERFORM phoenix_private.annual_catalog_text_v1(p_value,256); q:=p_value#>>'{}';
  IF q !~ '^(0|[1-9][0-9]*)([.][0-9]*[1-9])?$' THEN RAISE EXCEPTION 'monthly_policy_invalid' USING ERRCODE='23514'; END IF;
  RETURN q::numeric;
END $$;
CREATE FUNCTION phoenix_monthly.validate_v1(p_ref jsonb,p_context jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE c jsonb; b jsonb; item jsonb; value jsonb; seen integer[]:='{}'; eligible integer[]:='{}'; m integer; fixed_count integer;
BEGIN
  IF p_ref IS NULL OR octet_length(p_ref::text)>65536 THEN RAISE EXCEPTION 'monthly_policy_invalid' USING ERRCODE='23514'; END IF;
  PERFORM phoenix_private.annual_catalog_object_v1(p_ref,ARRAY['policyId','version','fingerprint','status','context','unitStep','eligibleMonths','fixedMonths','basis'],
    ARRAY['policyId','version','fingerprint','status','context','unitStep','eligibleMonths','fixedMonths','basis']);
  c:=p_ref->'context'; b:=p_ref->'basis';
  PERFORM phoenix_private.annual_catalog_object_v1(c,ARRAY['ownerOrgId','planningYear','annualItemId','fieldVersionId','canonicalItemId','unit','beneficiaryOrganizationId'],
    ARRAY['ownerOrgId','planningYear','annualItemId','fieldVersionId','canonicalItemId','unit','beneficiaryOrganizationId']);
  IF (c-'beneficiaryOrganizationId') IS DISTINCT FROM (p_context-'beneficiaryOrganizationId')
    OR (c->'beneficiaryOrganizationId'<>'null'::jsonb AND c->'beneficiaryOrganizationId' IS DISTINCT FROM p_context->'beneficiaryOrganizationId')
    OR p_ref->>'status' IS DISTINCT FROM 'approved' OR jsonb_typeof(p_ref->'version') IS DISTINCT FROM 'number'
    OR p_ref->>'version' !~ '^[1-9][0-9]{0,8}$' OR p_ref->>'policyId' IS NULL THEN
    RAISE EXCEPTION 'monthly_policy_invalid' USING ERRCODE='23514'; END IF;
  PERFORM (p_ref->>'policyId')::uuid;
  FOREACH value IN ARRAY ARRAY[p_ref->'fingerprint',b->'documentSha256',b->'ledgerSnapshotSha256'] LOOP
    IF jsonb_typeof(value) IS DISTINCT FROM 'string' OR value#>>'{}' !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'monthly_policy_invalid' USING ERRCODE='23514'; END IF;
  END LOOP;
  IF phoenix_monthly.quantity_v1(p_ref->'unitStep')<=0 OR jsonb_typeof(p_ref->'eligibleMonths') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_ref->'fixedMonths') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'monthly_policy_invalid' USING ERRCODE='23514'; END IF;
  IF jsonb_array_length(p_ref->'eligibleMonths') NOT BETWEEN 1 AND 12 OR jsonb_array_length(p_ref->'fixedMonths')>12 THEN
    RAISE EXCEPTION 'monthly_policy_invalid' USING ERRCODE='23514'; END IF;
  FOR value IN SELECT x FROM jsonb_array_elements(p_ref->'eligibleMonths') x LOOP
    IF jsonb_typeof(value) IS DISTINCT FROM 'number' OR value#>>'{}' !~ '^(1[0-2]|[1-9])$' THEN RAISE EXCEPTION 'monthly_policy_invalid' USING ERRCODE='23514'; END IF;
    m:=(value#>>'{}')::integer;
    IF m=ANY(eligible) THEN RAISE EXCEPTION 'monthly_policy_invalid' USING ERRCODE='23514'; END IF; eligible:=array_append(eligible,m);
  END LOOP;
  FOR item IN SELECT x FROM jsonb_array_elements(p_ref->'fixedMonths') x LOOP
    PERFORM phoenix_private.annual_catalog_object_v1(item,ARRAY['month','quantity','status','ledgerReference'],ARRAY['month','quantity','status','ledgerReference']);
    IF jsonb_typeof(item->'month') IS DISTINCT FROM 'number' OR item->>'month' !~ '^(1[0-2]|[1-9])$'
      OR item->>'status' NOT IN ('approved','locked') OR jsonb_typeof(item->'status') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'monthly_policy_invalid' USING ERRCODE='23514'; END IF;
    m:=(item->>'month')::integer;
    IF m=ANY(seen) OR m=ANY(eligible) THEN RAISE EXCEPTION 'monthly_policy_invalid' USING ERRCODE='23514'; END IF;
    seen:=array_append(seen,m); PERFORM phoenix_monthly.quantity_v1(item->'quantity');
    PERFORM phoenix_private.annual_catalog_text_v1(item->'ledgerReference',2000);
  END LOOP;
  PERFORM phoenix_private.annual_catalog_object_v1(b,ARRAY['beneficiaryOrganizationId','documentReference','documentSha256','periodReference',
    'priorAllocationStatus','ledgerSnapshotSha256','approvedById','approvedByName','approvedAt'],ARRAY['beneficiaryOrganizationId','documentReference','documentSha256','periodReference',
    'priorAllocationStatus','ledgerSnapshotSha256','approvedById','approvedByName','approvedAt']);
  fixed_count:=jsonb_array_length(p_ref->'fixedMonths');
  IF b->'beneficiaryOrganizationId' IS DISTINCT FROM p_context->'beneficiaryOrganizationId'
    OR b->>'priorAllocationStatus' IS DISTINCT FROM (CASE WHEN fixed_count>0 THEN 'snapshot_verified' ELSE 'none_verified' END) THEN
    RAISE EXCEPTION 'monthly_policy_invalid' USING ERRCODE='23514'; END IF;
  PERFORM phoenix_private.annual_catalog_text_v1(b->'approvedById',36); PERFORM (b->>'approvedById')::uuid;
  PERFORM phoenix_private.annual_catalog_text_v1(b->'approvedAt',64);
  IF b->>'approvedAt' !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]{1,6})?(Z|[+-][0-9]{2}:[0-5][0-9])$' THEN
    RAISE EXCEPTION 'monthly_policy_invalid' USING ERRCODE='23514'; END IF;
  PERFORM (b->>'approvedAt')::timestamptz;
  PERFORM phoenix_private.annual_catalog_text_v1(b->'approvedByName',4000);
  PERFORM phoenix_private.annual_catalog_text_v1(b->'documentReference',2000);
  PERFORM phoenix_private.annual_catalog_text_v1(b->'periodReference',2000);
END $$;

-- PRIVATE owner-only publication. There is no public policy-writing RPC.
CREATE FUNCTION phoenix_monthly.publish_reference_v1(p_ref jsonb,p_expected_previous_id uuid,p_active boolean) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE c jsonb; binding jsonb; ctx jsonb; k text; previous phoenix_monthly.policy_references%ROWTYPE; employee text; fp text;
BEGIN
  IF current_user<>pg_get_userbyid((SELECT datdba FROM pg_database WHERE datname=current_database())) OR p_active IS NULL THEN
    RAISE EXCEPTION 'monthly_owner_publication_required' USING ERRCODE='42501'; END IF;
  PERFORM phoenix_monthly.ready_v1();
  IF p_ref#>>'{basis,beneficiaryOrganizationId}' IS NULL THEN RAISE EXCEPTION 'monthly_policy_invalid' USING ERRCODE='23514'; END IF;
  p_ref:=jsonb_set(p_ref,'{basis,beneficiaryOrganizationId}',to_jsonb((p_ref#>>'{basis,beneficiaryOrganizationId}')::uuid));
  c:=p_ref->'context';
  binding:=phoenix_private.annual_needs_reference_v1((c->>'ownerOrgId')::uuid,(c->>'planningYear')::integer,
    (c->>'annualItemId')::uuid,(c->>'fieldVersionId')::uuid,(c->>'canonicalItemId')::uuid,'selection');
  ctx:=jsonb_build_object('ownerOrgId',binding#>'{scope,ownerOrgId}','planningYear',binding#>'{scope,planningYear}',
    'annualItemId',binding->'annualItemId','fieldVersionId',binding->'fieldVersionId','canonicalItemId',binding->'canonicalItemId',
    'unit',binding#>'{fields,unit,value}','beneficiaryOrganizationId',p_ref#>'{basis,beneficiaryOrganizationId}');
  PERFORM 1 FROM public.organizations WHERE id=(ctx->>'beneficiaryOrganizationId')::uuid FOR SHARE;
  PERFORM phoenix_private.central_needs_manual_scope_v1((ctx->>'beneficiaryOrganizationId')::uuid,(ctx->>'canonicalItemId')::uuid,NULL);
  SELECT full_name INTO employee FROM public.profiles WHERE id=(p_ref#>>'{basis,approvedById}')::uuid AND status='active' FOR SHARE;
  IF NOT FOUND OR nullif(btrim(employee),'') IS NULL THEN RAISE EXCEPTION 'monthly_reviewer_required' USING ERRCODE='23514'; END IF;
  p_ref:=jsonb_set(p_ref,'{basis,approvedByName}',to_jsonb(employee));
  p_ref:=jsonb_set(p_ref,'{basis,approvedById}',to_jsonb((p_ref#>>'{basis,approvedById}')::uuid));
  p_ref:=jsonb_set(p_ref,'{policyId}',to_jsonb((p_ref->>'policyId')::uuid));
  fp:=phoenix_private.annual_catalog_hash_v1(p_ref-'fingerprint'); p_ref:=jsonb_set(p_ref,'{fingerprint}',to_jsonb(fp));
  PERFORM phoenix_monthly.validate_v1(p_ref,ctx);
  k:=phoenix_private.annual_catalog_hash_v1(jsonb_build_array(c,ctx->'beneficiaryOrganizationId'));
  PERFORM pg_advisory_xact_lock(hashtextextended('monthly-policy:'||k,0));
  SELECT * INTO previous FROM phoenix_monthly.policy_references WHERE context_key=k ORDER BY version DESC LIMIT 1;
  IF previous.id IS DISTINCT FROM p_expected_previous_id OR (p_ref->>'version')::integer<>coalesce(previous.version,0)+1 THEN
    RAISE EXCEPTION 'monthly_policy_stale' USING ERRCODE='40001'; END IF;
  INSERT INTO phoenix_monthly.policy_references(id,context_key,organization_id,planning_year,annual_item_id,field_version_id,
    central_item_id,beneficiary_id,rule_beneficiary_id,version,active,previous_id,payload,fingerprint)
  VALUES((p_ref->>'policyId')::uuid,k,(ctx->>'ownerOrgId')::uuid,(ctx->>'planningYear')::integer,(ctx->>'annualItemId')::uuid,
    (ctx->>'fieldVersionId')::uuid,(ctx->>'canonicalItemId')::uuid,(ctx->>'beneficiaryOrganizationId')::uuid,
    (c->>'beneficiaryOrganizationId')::uuid,(p_ref->>'version')::integer,p_active,previous.id,p_ref,fp);
  RETURN p_ref;
END $$;
CREATE FUNCTION public.phoenix_monthly_policy_reference(p_organization_id uuid,p_planning_year integer,p_annual_item_id uuid,
 p_field_version_id uuid,p_canonical_id uuid,p_beneficiary_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE binding jsonb; ctx jsonb; candidates jsonb; policy jsonb;
BEGIN
  PERFORM phoenix_r2.owner_guard(p_organization_id); PERFORM phoenix_monthly.ready_v1();
  binding:=phoenix_private.annual_needs_reference_v1(p_organization_id,p_planning_year,p_annual_item_id,p_field_version_id,p_canonical_id,'selection');
  PERFORM 1 FROM public.organizations WHERE id=p_beneficiary_id FOR SHARE;
  PERFORM phoenix_private.central_needs_manual_scope_v1(p_beneficiary_id,p_canonical_id,NULL);
  ctx:=jsonb_build_object('ownerOrgId',p_organization_id,'planningYear',p_planning_year,'annualItemId',p_annual_item_id,
    'fieldVersionId',p_field_version_id,'canonicalItemId',p_canonical_id,'unit',binding#>'{fields,unit,value}','beneficiaryOrganizationId',p_beneficiary_id);
  SELECT coalesce(jsonb_agg(payload),'[]'::jsonb) INTO candidates FROM (
    SELECT DISTINCT ON(context_key) * FROM phoenix_monthly.policy_references WHERE organization_id=p_organization_id
      AND planning_year=p_planning_year AND annual_item_id=p_annual_item_id AND field_version_id=p_field_version_id
      AND central_item_id=p_canonical_id AND beneficiary_id=p_beneficiary_id
      AND (rule_beneficiary_id IS NULL OR rule_beneficiary_id=p_beneficiary_id)
    ORDER BY context_key,version DESC) latest WHERE active;
  IF jsonb_array_length(candidates)<>1 THEN RETURN jsonb_build_object('status','awaiting_policy','context',ctx,
    'reason',CASE WHEN jsonb_array_length(candidates)=0 THEN 'missing' ELSE 'ambiguous' END); END IF;
  policy:=candidates->0; PERFORM phoenix_monthly.validate_v1(policy,ctx);
  RETURN jsonb_build_object('status','ready','context',ctx,'reference',policy,'effectiveAllocation',false,'draftJournalImplemented',false);
END $$;

DO $acl$
DECLARE p record;
BEGIN
  FOR p IN SELECT q.oid::regprocedure sig FROM pg_proc q JOIN pg_namespace n ON n.oid=q.pronamespace
    WHERE n.nspname='phoenix_monthly' OR (n.nspname='public' AND q.proname~'^phoenix_monthly_') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',p.sig);
  END LOOP;
END $acl$;
GRANT EXECUTE ON FUNCTION public.phoenix_monthly_policy_reference(uuid,integer,uuid,uuid,uuid,uuid) TO authenticated;
INSERT INTO phoenix_monthly.manifest(kind,name,definition)
 SELECT 'function',p.oid::regprocedure::text,jsonb_build_object('definitionMd5',md5(pg_get_functiondef(p.oid)),
  'definer',n.nspname='public','config',to_jsonb(p.proconfig),'language',l.lanname,
  'allowedRole',CASE WHEN n.nspname='public' THEN 'authenticated' ELSE NULL END)
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
 WHERE n.nspname='phoenix_monthly' OR (n.nspname='public' AND p.proname~'^phoenix_monthly_');
INSERT INTO phoenix_monthly.manifest(kind,name,definition)
 SELECT 'relation',format('phoenix_monthly.%I',name),phoenix_monthly.relation_definition_v1(to_regclass(format('phoenix_monthly.%I',name)))
 FROM unnest(ARRAY['policy_references','manifest']) name;
DO $verify$
BEGIN
  PERFORM phoenix_monthly.ready_v1();
END $verify$;
-- No policy data, employee publisher, draft journal, quotas or stock write.
COMMIT;
