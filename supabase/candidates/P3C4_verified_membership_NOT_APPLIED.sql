-- C4: new membership from separately sealed server evidence. NOT APPLIED HOSTED.
-- Existing A1/C1/C2/R1 functions, attestations and roles remain unchanged.
BEGIN;
SET LOCAL search_path=pg_catalog,pg_temp;
DO $pre$
BEGIN
  IF current_user<>pg_get_userbyid((SELECT datdba FROM pg_database WHERE datname=current_database()))
    OR to_regnamespace('phoenix_c4') IS NOT NULL
    OR to_regprocedure('phoenix_private.annual_needs_actor_name_v1()') IS NULL
    OR to_regprocedure('public.phoenix_central_needs_download_annual_original(uuid,integer,uuid)') IS NULL THEN
    RAISE EXCEPTION 'c4_precondition_failed';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname~'^phoenix_c4_')
    OR EXISTS(SELECT 1 FROM phoenix_private.central_needs_capability_breaches_v1()) THEN
    RAISE EXCEPTION 'c4_precondition_failed';
  END IF;
END $pre$;

CREATE SCHEMA phoenix_c4;
REVOKE ALL ON SCHEMA phoenix_c4 FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE phoenix_c4.activation_events(
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  enabled boolean NOT NULL, reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
  recorded_by name NOT NULL DEFAULT session_user, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE phoenix_c4.proofs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, planning_year integer NOT NULL,
  actor_id uuid NOT NULL REFERENCES public.profiles(id), request_id uuid NOT NULL, original_id uuid NOT NULL,
  intent jsonb NOT NULL CHECK(octet_length(intent::text)<=524288),
  proof_sha256 text NOT NULL CHECK(proof_sha256=phoenix_private.annual_catalog_hash_v1(intent)),
  sealed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(organization_id,actor_id,request_id),
  UNIQUE(organization_id,planning_year,id),
  FOREIGN KEY(organization_id,planning_year,original_id)
    REFERENCES public.central_needs_annual_originals(organization_id,planning_year,id) ON DELETE RESTRICT);
CREATE TABLE phoenix_c4.commits(
  proof_id uuid PRIMARY KEY, organization_id uuid NOT NULL, planning_year integer NOT NULL,
  annual_item_id uuid NOT NULL, field_version_id uuid NOT NULL, result jsonb NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(organization_id,planning_year,proof_id) REFERENCES phoenix_c4.proofs(organization_id,planning_year,id),
  FOREIGN KEY(organization_id,planning_year,annual_item_id,field_version_id)
    REFERENCES public.central_needs_annual_versions(organization_id,planning_year,annual_item_id,id));
CREATE TABLE phoenix_c4.manifest(kind text NOT NULL CHECK(kind IN ('function','relation')), name text NOT NULL,
  definition jsonb NOT NULL, PRIMARY KEY(kind,name));
DO $tables$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['activation_events','proofs','commits','manifest'] LOOP
    EXECUTE format('ALTER TABLE phoenix_c4.%I ENABLE ROW LEVEL SECURITY',r);
    EXECUTE format('ALTER TABLE phoenix_c4.%I FORCE ROW LEVEL SECURITY',r);
    EXECUTE format('REVOKE ALL ON TABLE phoenix_c4.%I FROM PUBLIC,anon,authenticated,service_role',r);
  END LOOP;
END $tables$;

CREATE FUNCTION phoenix_c4.immutable_v1() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN RAISE EXCEPTION 'c4_history_immutable' USING ERRCODE='23514'; END $$;
DO $triggers$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['activation_events','proofs','commits','manifest'] LOOP
    EXECUTE format('CREATE TRIGGER c4_immutable_rows BEFORE UPDATE OR DELETE ON phoenix_c4.%I FOR EACH ROW EXECUTE FUNCTION phoenix_c4.immutable_v1()',r);
    EXECUTE format('CREATE TRIGGER c4_immutable_truncate BEFORE TRUNCATE ON phoenix_c4.%I FOR EACH STATEMENT EXECUTE FUNCTION phoenix_c4.immutable_v1()',r);
  END LOOP;
END $triggers$;
CREATE FUNCTION phoenix_c4.relation_definition_v1(p_relation regclass) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('owner',c.relowner,'kind',c.relkind,'rls',c.relrowsecurity,'force',c.relforcerowsecurity,
  'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,
    pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
  'constraints',(SELECT jsonb_agg(jsonb_build_array(x.conname,pg_get_constraintdef(x.oid,true)) ORDER BY x.conname) FROM pg_constraint x WHERE x.conrelid=c.oid),
  'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgname,t.tgenabled,pg_get_triggerdef(t.oid,true)) ORDER BY t.tgname)
    FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal)) FROM pg_class c WHERE c.oid=p_relation
$$;
CREATE FUNCTION phoenix_c4.active_v1() RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT coalesce((SELECT enabled FROM phoenix_c4.activation_events ORDER BY sequence DESC LIMIT 1),false)
$$;
CREATE FUNCTION phoenix_c4.capability_breaches_v1() RETURNS SETOF text LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE m record; function_row record; r record; owner_id oid:=(SELECT datdba FROM pg_database WHERE datname=current_database());
BEGIN
  IF (SELECT count(*) FROM phoenix_c4.manifest WHERE kind='relation')<>4 THEN RETURN NEXT 'c4_relation_manifest'; END IF;
  FOR m IN SELECT * FROM phoenix_c4.manifest WHERE kind='relation' LOOP
    IF phoenix_c4.relation_definition_v1(to_regclass(m.name)) IS DISTINCT FROM m.definition THEN RETURN NEXT 'c4_relation_drift:'||m.name; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phoenix_c4'
    AND c.relkind IN ('r','p','v','m','f') AND NOT EXISTS(SELECT 1 FROM phoenix_c4.manifest x WHERE x.kind='relation' AND to_regclass(x.name)=c.oid))
    THEN RETURN NEXT 'c4_unregistered_relation'; END IF;
  -- Predefined NOLOGIN capability roles are not login principals. Every
  -- effective member, including NOLOGIN application/platform aliases, is checked.
  FOR r IN SELECT * FROM pg_roles WHERE NOT rolsuper AND oid<>owner_id
    AND NOT (rolname IN ('pg_read_all_data','pg_write_all_data') AND NOT rolcanlogin) LOOP
    IF pg_has_role(r.oid,'pg_read_all_data','MEMBER') OR pg_has_role(r.oid,'pg_write_all_data','MEMBER') THEN
      RETURN NEXT 'c4_inherited_global_data:'||r.rolname; END IF;
    IF has_schema_privilege(r.oid,'phoenix_c4','USAGE,CREATE') THEN RETURN NEXT 'c4_schema_privilege:'||r.rolname; END IF;
    IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phoenix_c4' AND c.relkind='r'
      AND (has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
      THEN RETURN NEXT 'c4_table_privilege:'||r.rolname; END IF;
  END LOOP;
  FOR m IN SELECT * FROM phoenix_c4.manifest WHERE kind='function' LOOP
    SELECT q.*,l.lanname INTO function_row FROM pg_proc q JOIN pg_language l ON l.oid=q.prolang WHERE q.oid=to_regprocedure(m.name);
    IF NOT FOUND OR function_row.proowner<>owner_id OR md5(pg_get_functiondef(function_row.oid)) IS DISTINCT FROM m.definition->>'definitionMd5'
      OR function_row.prosecdef IS DISTINCT FROM (m.definition->>'definer')::boolean
      OR to_jsonb(function_row.proconfig) IS DISTINCT FROM m.definition->'config' OR function_row.lanname IS DISTINCT FROM m.definition->>'language'
      THEN RETURN NEXT 'c4_function_drift:'||m.name; CONTINUE; END IF;
    FOR r IN SELECT * FROM pg_roles WHERE NOT rolsuper AND oid<>owner_id LOOP
      IF has_function_privilege(r.oid,function_row.oid,'EXECUTE') IS DISTINCT FROM (r.rolname=coalesce(m.definition->>'allowedRole',''))
        THEN RETURN NEXT 'c4_function_privilege:'||m.name||':'||r.rolname; END IF;
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE (n.nspname='phoenix_c4' OR (n.nspname='public' AND p.proname~'^phoenix_c4_') OR (p.prosecdef AND p.prosrc~'\mphoenix_c4\M'))
      AND NOT EXISTS(SELECT 1 FROM phoenix_c4.manifest entry WHERE entry.kind='function' AND to_regprocedure(entry.name)=p.oid))
    THEN RETURN NEXT 'c4_unregistered_routine'; END IF;
END $$;
CREATE FUNCTION phoenix_c4.ready_v1(p_active boolean) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  -- A successful active check linearizes before a later owner deactivation:
  -- hold its append table against INSERT until this transaction finishes.
  IF p_active THEN LOCK TABLE phoenix_c4.activation_events IN SHARE MODE; END IF;
  IF EXISTS(SELECT 1 FROM phoenix_private.central_needs_capability_breaches_v1()) OR EXISTS(SELECT 1 FROM phoenix_c4.capability_breaches_v1()) THEN
    RAISE EXCEPTION 'c4_schema_not_ready' USING ERRCODE='55000';
  END IF;
  IF p_active AND NOT phoenix_c4.active_v1() THEN RAISE EXCEPTION 'c4_not_enabled' USING ERRCODE='55000'; END IF;
END $$;

CREATE FUNCTION phoenix_c4.verify_evidence_v1(p_org uuid,p_year integer,p_canonical jsonb,p_fingerprint text,p_evidence jsonb)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE o jsonb; s jsonb; f text; observation jsonb; required boolean; anchor jsonb; matches integer;
  fields constant text[]:=ARRAY['scientificName','nameAr','nationalCode','currentNationalCode','previousNationalCode','barcode','dosageForm','concentration','unit'];
  parser constant jsonb:='{"contractVersion":"1.2.0","sheetjsVersion":"0.20.3","sheetjsTarballSha256":"8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8","runtime":"node"}';
BEGIN
  IF p_canonical IS NULL OR p_canonical->>'status' IS DISTINCT FROM 'active' OR cardinality(phoenix_private.annual_catalog_missing_v1(p_canonical))<>0
    OR p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{64}$' OR phoenix_private.annual_catalog_hash_v1(p_canonical) IS DISTINCT FROM p_fingerprint THEN
    RAISE EXCEPTION 'c4_canonical_stale_or_incomplete' USING ERRCODE='23514';
  END IF;
  IF p_evidence IS NULL OR octet_length(p_evidence::text)>262144 THEN RAISE EXCEPTION 'c4_evidence_limit' USING ERRCODE='23514'; END IF;
  PERFORM phoenix_private.annual_catalog_object_v1(p_evidence,
    ARRAY['scope','original','template','coreTemplate','parser','registrySha256','classifications','rows','workerSha256'],
    ARRAY['scope','original','template','coreTemplate','parser','registrySha256','classifications','rows','workerSha256']);
  IF p_evidence->'scope' IS DISTINCT FROM jsonb_build_object('ownerOrgId',p_org,'planningYear',p_year)
    OR p_evidence->'parser' IS DISTINCT FROM parser THEN RAISE EXCEPTION 'c4_evidence_scope_or_parser' USING ERRCODE='23514'; END IF;
  PERFORM phoenix_private.annual_catalog_object_v1(p_evidence->'original',ARRAY['originalId','sha256','byteSize','firstFilename','attestation'],ARRAY['originalId','sha256','byteSize','firstFilename','attestation']);
  PERFORM phoenix_private.annual_catalog_object_v1(p_evidence->'template',ARRAY['id','version','sha256'],ARRAY['id','version','sha256']);
  PERFORM phoenix_private.annual_catalog_object_v1(p_evidence->'coreTemplate',ARRAY['id','version','reviewReference','sha256'],ARRAY['id','version','reviewReference','sha256']);
  IF p_evidence#>>'{original,attestation}' IS DISTINCT FROM 'server_received_original'
    OR jsonb_typeof(p_evidence#>'{original,originalId}') IS DISTINCT FROM 'string'
    OR p_evidence#>>'{original,originalId}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p_evidence#>'{original,byteSize}') IS DISTINCT FROM 'number'
    OR p_evidence#>>'{original,byteSize}' !~ '^[1-9][0-9]{0,6}$'
    OR (p_evidence#>>'{original,byteSize}')::integer>3145728
    OR p_evidence#>>'{template,id}' IS DISTINCT FROM p_evidence#>>'{coreTemplate,id}'
    OR jsonb_typeof(p_evidence#>'{coreTemplate,id}') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_evidence#>'{coreTemplate,version}') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_evidence#>'{template,version}') IS DISTINCT FROM 'string'
    OR p_evidence#>>'{template,version}' !~ '^[1-9][0-9]{0,8}$'
    OR p_evidence#>>'{template,version}' IS DISTINCT FROM p_evidence#>>'{coreTemplate,version}' THEN
    RAISE EXCEPTION 'c4_evidence_identity_invalid' USING ERRCODE='23514';
  END IF;
  PERFORM (p_evidence#>>'{original,originalId}')::uuid;
  PERFORM phoenix_private.annual_catalog_text_v1(p_evidence#>'{original,firstFilename}',255);
  PERFORM phoenix_private.annual_catalog_text_v1(p_evidence#>'{template,id}',100);
  PERFORM phoenix_private.annual_catalog_text_v1(p_evidence#>'{coreTemplate,reviewReference}',2000);
  FOREACH f IN ARRAY ARRAY['workerSha256','registrySha256'] LOOP
    IF jsonb_typeof(p_evidence->f) IS DISTINCT FROM 'string' OR p_evidence->>f !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'c4_evidence_identity_invalid' USING ERRCODE='23514'; END IF;
  END LOOP;
  IF jsonb_typeof(p_evidence#>'{original,sha256}') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_evidence#>'{template,sha256}') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_evidence#>'{coreTemplate,sha256}') IS DISTINCT FROM 'string'
    OR p_evidence#>>'{original,sha256}' !~ '^[0-9a-f]{64}$' OR p_evidence#>>'{template,sha256}' !~ '^[0-9a-f]{64}$'
    OR p_evidence#>>'{coreTemplate,sha256}' !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'c4_evidence_identity_invalid' USING ERRCODE='23514'; END IF;
  IF jsonb_typeof(p_evidence->'rows') IS DISTINCT FROM 'array' OR jsonb_typeof(p_evidence->'classifications') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'c4_evidence_invalid' USING ERRCODE='23514'; END IF;
  IF jsonb_array_length(p_evidence->'rows') NOT BETWEEN 1 AND 50 OR jsonb_array_length(p_evidence->'classifications')>32
    OR (SELECT count(DISTINCT value->>'occurrenceKey') FROM jsonb_array_elements(p_evidence->'rows'))<>jsonb_array_length(p_evidence->'rows') THEN
    RAISE EXCEPTION 'c4_evidence_limit' USING ERRCODE='23514'; END IF;
  FOR anchor IN SELECT value FROM jsonb_array_elements(p_evidence->'classifications') LOOP
    PERFORM phoenix_private.annual_catalog_object_v1(anchor,ARRAY['blockId','sheetIndex','cell'],ARRAY['blockId','sheetIndex','cell']);
    PERFORM phoenix_private.annual_catalog_cell_v1(anchor->'cell');
  END LOOP;
  FOR o IN SELECT value FROM jsonb_array_elements(p_evidence->'rows') LOOP
    PERFORM phoenix_private.annual_catalog_object_v1(o,ARRAY['occurrenceKey','scope','source','classification','fields'],ARRAY['occurrenceKey','scope','source','classification','fields']);
    PERFORM phoenix_private.annual_catalog_text_v1(o->'occurrenceKey',2000);
    PERFORM phoenix_private.annual_catalog_object_v1(o->'fields',fields,fields);
    s:=o->'source';
    PERFORM phoenix_private.annual_catalog_object_v1(s,ARRAY['sourceId','filename','sha256','parser','sheetIndex','sheetName','row','blockId','mappingReference'],
      ARRAY['sourceId','filename','sha256','parser','sheetIndex','sheetName','row','blockId','mappingReference']);
    IF jsonb_typeof(s->'row') IS DISTINCT FROM 'number' OR s->>'row' !~ '^[0-9]{1,4}$' THEN
      RAISE EXCEPTION 'c4_source_binding_invalid' USING ERRCODE='23514'; END IF;
    IF o->'scope' IS DISTINCT FROM p_evidence->'scope' OR s->>'sourceId' IS DISTINCT FROM p_evidence#>>'{original,originalId}'
      OR s->>'sha256' IS DISTINCT FROM p_evidence#>>'{original,sha256}' OR s->>'filename' IS DISTINCT FROM p_evidence#>>'{original,firstFilename}'
      OR s->'parser' IS DISTINCT FROM parser THEN RAISE EXCEPTION 'c4_source_binding_invalid' USING ERRCODE='23514'; END IF;
    FOREACH f IN ARRAY fields LOOP
      observation:=o->'fields'->f;
      PERFORM phoenix_private.annual_catalog_observation_v1(observation,f,(s->>'row')::integer);
      required:=f IN ('scientificName','nationalCode','unit') OR (f IN ('dosageForm','concentration') AND nullif(phoenix_private.annual_catalog_trim_v1(p_canonical->>f),'') IS NOT NULL);
      IF observation->>'state' IS DISTINCT FROM 'value' THEN
        IF required OR observation->>'state' IS DISTINCT FROM 'missing' THEN RAISE EXCEPTION 'c4_source_identity_held' USING ERRCODE='23514'; END IF;
      ELSIF f<>'previousNationalCode' AND phoenix_private.annual_catalog_trim_v1(observation->>'text') IS DISTINCT FROM
        phoenix_private.annual_catalog_trim_v1(p_canonical->>CASE WHEN f='currentNationalCode' THEN 'nationalCode' ELSE f END) THEN
        RAISE EXCEPTION 'c4_source_identity_conflict' USING ERRCODE='23514';
      END IF;
    END LOOP;
    SELECT count(*) INTO matches FROM jsonb_array_elements(p_evidence->'classifications') a
      WHERE a->>'blockId'=s->>'blockId' AND a->'sheetIndex'=s->'sheetIndex'
        AND a#>>'{cell,presence}'='value' AND a#>>'{cell,valueType}'='string' AND a#>'{cell,isFormula}'='false'::jsonb
        AND a#>>'{cell,rawValue}'=o#>>'{classification,label}';
    IF o->'classification'<>'null'::jsonb AND (o#>>'{classification,origin}' IS DISTINCT FROM 'source' OR matches<>1) THEN
      RAISE EXCEPTION 'c4_classification_held' USING ERRCODE='23514'; END IF;
  END LOOP;
END $$;

CREATE FUNCTION public.phoenix_c4_catalog_contract(p_organization_id uuid,p_planning_year integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM phoenix_private.annual_catalog_guard_v1(p_organization_id,p_planning_year,false);
  PERFORM phoenix_c4.ready_v1(false);
  RETURN jsonb_build_object('version',1,'scope','owner_year','enabled',phoenix_c4.active_v1(),
    'catalogCommitImplemented',true,'trustedPreparationRequiresServer',true,'maxPageRows',50,'maxEvidenceBytes',262144,
    'existingSourceAttestation','client_attested','verificationAttestation','server_verified_c2_extraction_v1');
END $$;
CREATE FUNCTION public.phoenix_c4_seal(p_organization_id uuid,p_planning_year integer,p_actor_id uuid,p_request_id uuid,
 p_canonical_id uuid,p_expected_canonical_fingerprint text,p_evidence jsonb,p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE c jsonb; intent jsonb; p phoenix_c4.proofs%ROWTYPE; reason text;
BEGIN
  PERFORM phoenix_c4.ready_v1(true);
  IF p_actor_id IS NULL OR p_request_id IS NULL OR p_planning_year IS NULL OR p_planning_year NOT BETWEEN 2000 AND 2100
    OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_actor_id AND organization_id=p_organization_id AND status='active') THEN
    RAISE EXCEPTION 'c4_actor_binding_invalid' USING ERRCODE='42501'; END IF;
  reason:=phoenix_private.annual_catalog_reason_v1(p_reason);
  c:=phoenix_private.annual_catalog_canonical_v1(p_canonical_id,true);
  PERFORM phoenix_c4.verify_evidence_v1(p_organization_id,p_planning_year,c,p_expected_canonical_fingerprint,p_evidence);
  intent:=jsonb_build_object('version',1,'action','add_new_membership','ownerOrgId',p_organization_id,'planningYear',p_planning_year,
    'actorId',p_actor_id,'requestId',p_request_id,'canonicalItemId',p_canonical_id,
    'canonicalFingerprint',p_expected_canonical_fingerprint,'evidence',p_evidence,'reason',reason);
  PERFORM pg_advisory_xact_lock(hashtextextended('c4:'||p_organization_id::text||':'||p_actor_id::text||':'||p_request_id::text,0));
  SELECT * INTO p FROM phoenix_c4.proofs WHERE organization_id=p_organization_id AND actor_id=p_actor_id AND request_id=p_request_id;
  IF FOUND THEN
    IF p.intent IS DISTINCT FROM intent THEN RAISE EXCEPTION 'c4_idempotency_conflict' USING ERRCODE='23505'; END IF;
  ELSE
    INSERT INTO phoenix_c4.proofs(organization_id,planning_year,actor_id,request_id,original_id,intent,proof_sha256)
      VALUES(p_organization_id,p_planning_year,p_actor_id,p_request_id,(p_evidence#>>'{original,originalId}')::uuid,intent,
        phoenix_private.annual_catalog_hash_v1(intent)) RETURNING * INTO p;
  END IF;
  RETURN jsonb_build_object('scope',p_evidence->'scope','requestId',p_request_id,'proofId',p.id,'proofSha256',p.proof_sha256,'proofState','sealed');
END $$;
CREATE FUNCTION public.phoenix_c4_commit(p_organization_id uuid,p_planning_year integer,p_request_id uuid,p_proof_id uuid,p_expected_proof_sha256 text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE p phoenix_c4.proofs%ROWTYPE; result jsonb; c jsonb; original jsonb; expected jsonb; role_name text;
  item_id uuid; actor_name text; request_key text:='c4:'||p_request_id::text;
BEGIN
  role_name:=phoenix_private.annual_catalog_guard_v1(p_organization_id,p_planning_year,true);
  PERFORM phoenix_c4.ready_v1(true);
  SELECT * INTO p FROM phoenix_c4.proofs WHERE id=p_proof_id AND organization_id=p_organization_id AND planning_year=p_planning_year
    AND actor_id=auth.uid() AND request_id=p_request_id;
  IF NOT FOUND OR p.proof_sha256 IS DISTINCT FROM p_expected_proof_sha256 THEN RAISE EXCEPTION 'c4_proof_unavailable' USING ERRCODE='42501'; END IF;
  result:=phoenix_private.annual_catalog_replay_v1(p_organization_id,p_planning_year,request_key,'c4_add_membership',p.intent);
  IF result IS NOT NULL THEN RETURN result; END IF;
  PERFORM phoenix_private.annual_catalog_year_v1(p_organization_id,p_planning_year,true);
  PERFORM 1 FROM phoenix_c4.proofs WHERE id=p.id FOR UPDATE;
  original:=public.phoenix_central_needs_download_annual_original(p_organization_id,p_planning_year,p.original_id);
  expected:=p.intent#>'{evidence,original}';
  IF original->'scope' IS DISTINCT FROM p.intent#>'{evidence,scope}' OR
    jsonb_build_object('originalId',original#>'{original,originalId}','sha256',original#>'{original,sha256}',
      'byteSize',original#>'{original,byteSize}','firstFilename',original#>'{original,firstFilename}',
      'attestation',original#>'{original,attestation}') IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'c4_source_binding_invalid' USING ERRCODE='23514'; END IF;
  c:=phoenix_private.annual_catalog_canonical_v1((p.intent->>'canonicalItemId')::uuid,true);
  PERFORM phoenix_c4.verify_evidence_v1(p_organization_id,p_planning_year,c,p.intent->>'canonicalFingerprint',p.intent->'evidence');
  actor_name:=phoenix_private.annual_needs_actor_name_v1();
  item_id:=phoenix_private.annual_catalog_write_item_v1(p_organization_id,p_planning_year,NULL,(p.intent->>'canonicalItemId')::uuid,NULL,
    p.intent->>'canonicalFingerprint',p.intent#>'{evidence,rows}',p.intent->>'reason');
  result:=phoenix_private.annual_catalog_item_result_v1(p_organization_id,p_planning_year,item_id,NULL)||jsonb_build_object('c4Verification',
    jsonb_build_object('attestation','server_verified_c2_extraction_v1','proofId',p.id,'proofSha256',p.proof_sha256,
      'originalId',p.original_id,'originalSha256',expected->'sha256','registrationSha256',p.intent#>'{evidence,template,sha256}',
      'workerSha256',p.intent#>'{evidence,workerSha256}','reviewedById',auth.uid(),'reviewedByName',actor_name,'reviewedAt',clock_timestamp()));
  result:=phoenix_private.annual_catalog_receipt_v1(p_organization_id,p_planning_year,request_key,'c4_add_membership',p.intent,result,role_name,item_id);
  INSERT INTO phoenix_c4.commits(proof_id,organization_id,planning_year,annual_item_id,field_version_id,result)
    VALUES(p.id,p_organization_id,p_planning_year,item_id,(result#>>'{fieldVersion,fieldVersionId}')::uuid,result);
  RETURN result;
END $$;
CREATE FUNCTION public.phoenix_c4_receipt(p_organization_id uuid,p_planning_year integer,p_request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE p phoenix_c4.proofs%ROWTYPE; result jsonb;
BEGIN
  PERFORM phoenix_private.annual_catalog_guard_v1(p_organization_id,p_planning_year,false);
  PERFORM phoenix_c4.ready_v1(false);
  SELECT * INTO p FROM phoenix_c4.proofs WHERE organization_id=p_organization_id AND planning_year=p_planning_year
    AND actor_id=auth.uid() AND request_id=p_request_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','missing','requestId',p_request_id); END IF;
  SELECT c.result INTO result FROM phoenix_c4.commits c WHERE c.proof_id=p.id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','prepared','requestId',p_request_id,'proofId',p.id,'proofSha256',p.proof_sha256); END IF;
  RETURN jsonb_build_object('status','committed','requestId',p_request_id,'result',result||jsonb_build_object('idempotentReplay',true,
    'selectable',false,'selectionBlockers',coalesce(result->'selectionBlockers','[]'::jsonb)||jsonb_build_array('receipt_replay_requires_refresh')));
END $$;

DO $acl$
DECLARE p record;
BEGIN
  FOR p IN SELECT q.oid::regprocedure signature FROM pg_proc q JOIN pg_namespace n ON n.oid=q.pronamespace
    WHERE n.nspname='phoenix_c4' OR (n.nspname='public' AND q.proname~'^phoenix_c4_') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',p.signature);
  END LOOP;
END $acl$;
GRANT EXECUTE ON FUNCTION public.phoenix_c4_catalog_contract(uuid,integer),public.phoenix_c4_commit(uuid,integer,uuid,uuid,text),
  public.phoenix_c4_receipt(uuid,integer,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_c4_seal(uuid,integer,uuid,uuid,uuid,text,jsonb,text) TO service_role;
INSERT INTO phoenix_c4.manifest(kind,name,definition)
 SELECT 'function',p.oid::regprocedure::text,jsonb_build_object('definitionMd5',md5(pg_get_functiondef(p.oid)),'definer',n.nspname='public',
  'config',to_jsonb(p.proconfig),'language',l.lanname,'allowedRole',CASE WHEN n.nspname='public'
    THEN CASE WHEN p.proname='phoenix_c4_seal' THEN 'service_role' ELSE 'authenticated' END ELSE NULL END)
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
 WHERE n.nspname='phoenix_c4' OR (n.nspname='public' AND p.proname~'^phoenix_c4_');
INSERT INTO phoenix_c4.manifest(kind,name,definition)
 SELECT 'relation',format('phoenix_c4.%I',name),phoenix_c4.relation_definition_v1(to_regclass(format('phoenix_c4.%I',name)))
 FROM unnest(ARRAY['activation_events','proofs','commits','manifest']) name;
DO $verify$
BEGIN
  IF EXISTS(SELECT 1 FROM phoenix_private.central_needs_capability_breaches_v1()) OR EXISTS(SELECT 1 FROM phoenix_c4.capability_breaches_v1())
    THEN RAISE EXCEPTION 'c4_install_verification_failed'; END IF;
END $verify$;
-- No activation event, staff grant, canonical/annual need or stock write.
COMMIT;
