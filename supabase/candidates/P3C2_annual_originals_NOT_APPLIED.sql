-- P3-C2: immutable annual original bytes and confirmed upload receipts.
-- UNNUMBERED / NOT_APPLIED. Requires exact accepted M235 + P1 + A1 + P3-B.
-- No hosted apply, legacy quantity intake, parser trust, membership or stock writes.
BEGIN;
SET LOCAL search_path=pg_catalog,pg_temp;

DO $pre$
DECLARE r record; actual text;
BEGIN
  IF to_regclass('public.central_needs_annual_originals') IS NOT NULL
     OR to_regclass('public.central_needs_annual_original_uploads') IS NOT NULL THEN
    RAISE EXCEPTION 'P3C2_precondition_failed: already present';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('phoenix_private.central_needs_capability_breaches_v1()')
      AND md5(prosrc)='e6612a673d5bdf4e30135c02a54dbda1' AND NOT prosecdef
      AND proowner=(SELECT datdba FROM pg_database WHERE datname=current_database())) THEN
    RAISE EXCEPTION 'P3C2_precondition_failed: accepted P3-B capability seal required';
  END IF;
  IF EXISTS(SELECT 1 FROM phoenix_private.central_needs_capability_breaches_v1()) THEN
    RAISE EXCEPTION 'P3C2_precondition_failed: capability breach';
  END IF;
  FOR r IN SELECT * FROM (VALUES
    ('phoenix_private.annual_catalog_guard_v1(uuid,integer,boolean)','a31aedea1bbec8fafc4ae85d43a3fd44'),
    ('phoenix_private.annual_catalog_year_v1(uuid,integer,boolean)','6b96b427b27750cdec48077927770df5'),
    ('phoenix_private.annual_catalog_replay_v1(uuid,integer,text,text,jsonb)','5e47f1dc81aafa41ee1499f7adf9c33f'),
    ('phoenix_private.annual_catalog_receipt_v1(uuid,integer,text,text,jsonb,jsonb,text,uuid)','83f85fb1671cc691ad99b652df1737a8'),
    ('phoenix_private.annual_catalog_trim_v1(text)','81d02dff872b4af5c9097ea4c1113cfc'),
    ('phoenix_private.annual_catalog_utf16_length_v1(text)','25a4794abce121a1cbc7a6d06416b87f'),
    ('phoenix_private.annual_needs_actor_name_v1()','1f976f77a9ed496c443ee95f2f05a159'),
    ('phoenix_private.central_needs_append_only_v1()','a2fc21fb24ccc845608d882a2f8fb704')
  ) expected(sig,body_md5) LOOP
    SELECT md5(prosrc) INTO actual FROM pg_proc WHERE oid=to_regprocedure(r.sig);
    IF actual IS DISTINCT FROM r.body_md5 THEN
      RAISE EXCEPTION 'P3C2_precondition_failed: body drift %',r.sig;
    END IF;
  END LOOP;
END $pre$;

CREATE TABLE public.central_needs_annual_originals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  planning_year integer NOT NULL,
  sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
  byte_size integer NOT NULL CHECK(byte_size BETWEEN 1 AND 3145728),
  original_bytes bytea NOT NULL,
  first_filename text NOT NULL,
  created_by uuid NOT NULL,
  created_by_name text NOT NULL,
  created_by_role text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE(organization_id,planning_year,sha256),
  UNIQUE(organization_id,planning_year,id),
  FOREIGN KEY(organization_id,planning_year)
    REFERENCES public.central_needs_catalog_years(organization_id,planning_year) ON DELETE RESTRICT,
  CHECK(octet_length(original_bytes)=byte_size),
  CHECK(encode(pg_catalog.sha256(original_bytes),'hex')=sha256)
);

CREATE TABLE public.central_needs_annual_original_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  planning_year integer NOT NULL,
  original_id uuid NOT NULL,
  filename text NOT NULL,
  actor_id uuid NOT NULL,
  actor_name text NOT NULL,
  actor_role text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE(organization_id,planning_year,id),
  FOREIGN KEY(organization_id,planning_year,original_id)
    REFERENCES public.central_needs_annual_originals(organization_id,planning_year,id) ON DELETE RESTRICT
);
CREATE INDEX annual_original_uploads_page ON public.central_needs_annual_original_uploads
  (organization_id,planning_year,created_at,id);

DO $tables$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['central_needs_annual_originals','central_needs_annual_original_uploads'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
    EXECUTE format('CREATE POLICY r1_actor_scope_restrictive ON public.%I AS RESTRICTIVE FOR ALL TO authenticated
      USING (organization_id=(SELECT phoenix_cn_policy.actor_scope_org(''central_needs.view''))) WITH CHECK(false)',t);
    EXECUTE format('CREATE TRIGGER annual_original_append_only BEFORE UPDATE OR DELETE ON public.%I
      FOR EACH ROW EXECUTE FUNCTION phoenix_private.central_needs_append_only_v1()',t);
    EXECUTE format('CREATE TRIGGER annual_original_no_truncate BEFORE TRUNCATE ON public.%I
      FOR EACH STATEMENT EXECUTE FUNCTION phoenix_private.central_needs_append_only_v1()',t);
  END LOOP;
END $tables$;

CREATE FUNCTION phoenix_private.annual_original_intent_v1(
 p_org uuid,p_year integer,p_filename text,p_sha256 text,p_byte_size integer)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF p_org IS NULL OR p_year IS NULL OR p_year NOT BETWEEN 2000 AND 2100
      OR p_filename IS NULL OR phoenix_private.annual_catalog_utf16_length_v1(p_filename) NOT BETWEEN 1 AND 255
      OR p_filename<>phoenix_private.annual_catalog_trim_v1(p_filename)
      OR p_filename ~ '[/\\]' OR p_filename ~ U&'[\0001-\001F\007F-\009F\061C\200E\200F\202A-\202E\2066-\2069]'
      OR p_filename LIKE '~$%' OR p_filename !~* '\.(xls|xlsx|csv)$'
      OR p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$'
      OR p_byte_size IS NULL OR p_byte_size NOT BETWEEN 1 AND 3145728 THEN
    RAISE EXCEPTION 'annual_original_intent_invalid' USING ERRCODE='23514';
  END IF;
  RETURN jsonb_build_object('ownerOrgId',p_org,'planningYear',p_year,
    'filename',p_filename,'sha256',p_sha256,'byteSize',p_byte_size);
END $$;

CREATE FUNCTION phoenix_private.annual_original_object_v1(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('originalId',o.id,'sha256',o.sha256,'byteSize',o.byte_size,
   'firstFilename',o.first_filename,'createdBy',o.created_by,'createdByName',o.created_by_name,
   'createdByRole',o.created_by_role,'createdAt',o.created_at,'attestation','server_received_original')
 FROM public.central_needs_annual_originals o WHERE o.id=p_id
$$;

CREATE FUNCTION phoenix_private.annual_original_upload_object_v1(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('uploadId',u.id,'originalId',u.original_id,'filename',u.filename,
   'actorId',u.actor_id,'actorName',u.actor_name,'actorRole',u.actor_role,'createdAt',u.created_at)
 FROM public.central_needs_annual_original_uploads u WHERE u.id=p_id
$$;

CREATE FUNCTION public.phoenix_central_needs_annual_originals_contract() RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE='28000'; END IF;
  RETURN jsonb_build_object('version',1,'scope','owner_year','maxFileBytes',3145728,
    'extensions',jsonb_build_array('xls','xlsx','csv'),'attestation','server_received_original',
    'atomicReceipt',true,'intentBoundReplay',true);
END $$;

CREATE FUNCTION public.phoenix_central_needs_store_annual_original(
 p_organization_id uuid,p_planning_year integer,p_filename text,p_sha256 text,
 p_byte_size integer,p_base64 text,p_idempotency_key text,p_expected_actor_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE role_name text; actor_name text; intent jsonb; result jsonb; bytes bytea;
  original public.central_needs_annual_originals%ROWTYPE;
  original_id uuid; upload_id uuid:=gen_random_uuid(); received_at timestamptz;
  deduplicated boolean;
BEGIN
  role_name:=phoenix_private.annual_catalog_guard_v1(p_organization_id,p_planning_year,true);
  IF p_expected_actor_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'annual_original_actor_mismatch' USING ERRCODE='42501';
  END IF;
  intent:=phoenix_private.annual_original_intent_v1(p_organization_id,p_planning_year,p_filename,p_sha256,p_byte_size);
  -- Validate bytes even on replay: a hash supplied by the client is not retained evidence.
  IF p_base64 IS NULL OR octet_length(p_base64) NOT BETWEEN 4 AND 4194304
      OR octet_length(p_base64)%4<>0 OR p_base64 ~ '[^A-Za-z0-9+/=]' THEN
    RAISE EXCEPTION 'annual_original_base64_invalid' USING ERRCODE='23514';
  END IF;
  BEGIN
    bytes:=decode(p_base64,'base64');
  EXCEPTION WHEN invalid_parameter_value THEN
    RAISE EXCEPTION 'annual_original_base64_invalid' USING ERRCODE='23514';
  END;
  IF replace(encode(bytes,'base64'),E'\n','')<>p_base64 THEN
    RAISE EXCEPTION 'annual_original_base64_invalid' USING ERRCODE='23514';
  END IF;
  IF octet_length(bytes)<>p_byte_size OR encode(sha256(bytes),'hex')<>p_sha256 THEN
    RAISE EXCEPTION 'annual_original_bytes_mismatch' USING ERRCODE='23514';
  END IF;
  result:=phoenix_private.annual_catalog_replay_v1(p_organization_id,p_planning_year,p_idempotency_key,'store_original_v1',intent);
  IF result IS NOT NULL THEN RETURN result; END IF;
  PERFORM phoenix_private.annual_catalog_year_v1(p_organization_id,p_planning_year,true);
  actor_name:=phoenix_private.annual_needs_actor_name_v1();
  received_at:=clock_timestamp();
  SELECT * INTO original FROM public.central_needs_annual_originals
    WHERE organization_id=p_organization_id AND planning_year=p_planning_year AND sha256=p_sha256;
  deduplicated:=FOUND;
  IF deduplicated THEN
    IF original.byte_size<>p_byte_size OR original.original_bytes<>bytes THEN
      RAISE EXCEPTION 'annual_original_integrity_failed' USING ERRCODE='23514';
    END IF;
    original_id:=original.id;
  ELSE
    INSERT INTO public.central_needs_annual_originals(organization_id,planning_year,sha256,byte_size,
      original_bytes,first_filename,created_by,created_by_name,created_by_role,created_at)
    VALUES(p_organization_id,p_planning_year,p_sha256,p_byte_size,bytes,p_filename,auth.uid(),actor_name,role_name,received_at)
    RETURNING id INTO original_id;
  END IF;
  INSERT INTO public.central_needs_annual_original_uploads(id,organization_id,planning_year,original_id,
    filename,actor_id,actor_name,actor_role,created_at)
  VALUES(upload_id,p_organization_id,p_planning_year,original_id,p_filename,auth.uid(),actor_name,role_name,received_at);
  result:=jsonb_build_object('scope',jsonb_build_object('ownerOrgId',p_organization_id,'planningYear',p_planning_year),
    'idempotencyKey',p_idempotency_key,'original',phoenix_private.annual_original_object_v1(original_id),
    'upload',phoenix_private.annual_original_upload_object_v1(upload_id),'deduplicated',deduplicated);
  RETURN phoenix_private.annual_catalog_receipt_v1(p_organization_id,p_planning_year,p_idempotency_key,
    'store_original_v1',intent,result,role_name,upload_id);
END $$;

CREATE FUNCTION public.phoenix_central_needs_get_annual_original_receipt(
 p_organization_id uuid,p_planning_year integer,p_filename text,p_sha256 text,
 p_byte_size integer,p_idempotency_key text,p_expected_actor_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE intent jsonb; result jsonb;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'annual_original_requires_read_committed' USING ERRCODE='25000';
  END IF;
  PERFORM phoenix_private.annual_catalog_guard_v1(p_organization_id,p_planning_year,false);
  IF p_expected_actor_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'annual_original_actor_mismatch' USING ERRCODE='42501';
  END IF;
  intent:=phoenix_private.annual_original_intent_v1(p_organization_id,p_planning_year,p_filename,p_sha256,p_byte_size);
  -- This helper locks the SAME actor/key before its fresh receipt SELECT. A negative
  -- response still permits only a same-key/intent retry, never a new-key command.
  result:=phoenix_private.annual_catalog_replay_v1(p_organization_id,p_planning_year,p_idempotency_key,'store_original_v1',intent);
  PERFORM phoenix_private.annual_catalog_year_v1(p_organization_id,p_planning_year,false);
  RETURN jsonb_build_object('scope',jsonb_build_object('ownerOrgId',p_organization_id,'planningYear',p_planning_year),
    'intent',jsonb_build_object('filename',p_filename,'sha256',p_sha256,'byteSize',p_byte_size,'idempotencyKey',p_idempotency_key),
    'result',result);
END $$;

CREATE FUNCTION public.phoenix_central_needs_list_annual_original_uploads(
 p_organization_id uuid,p_planning_year integer,p_limit integer DEFAULT 25,p_after_upload_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE after_time timestamptz; page public.central_needs_annual_original_uploads%ROWTYPE;
  uploads jsonb:='[]'; last_id uuid; has_more boolean:=false;
BEGIN
  PERFORM phoenix_private.annual_catalog_guard_v1(p_organization_id,p_planning_year,false);
  PERFORM phoenix_private.annual_catalog_year_v1(p_organization_id,p_planning_year,false);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'annual_original_limit_invalid' USING ERRCODE='23514';
  END IF;
  IF p_after_upload_id IS NOT NULL THEN
    SELECT created_at INTO after_time FROM public.central_needs_annual_original_uploads
      WHERE organization_id=p_organization_id AND planning_year=p_planning_year AND id=p_after_upload_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'annual_original_cursor_invalid' USING ERRCODE='23514'; END IF;
  END IF;
  FOR page IN SELECT * FROM public.central_needs_annual_original_uploads
    WHERE organization_id=p_organization_id AND planning_year=p_planning_year
      AND (p_after_upload_id IS NULL OR (created_at,id)>(after_time,p_after_upload_id))
    ORDER BY created_at,id LIMIT p_limit+1
  LOOP
    IF jsonb_array_length(uploads)=p_limit THEN has_more:=true; EXIT; END IF;
    uploads:=uploads||jsonb_build_array(jsonb_build_object('original',phoenix_private.annual_original_object_v1(page.original_id),
      'upload',phoenix_private.annual_original_upload_object_v1(page.id)));
    last_id:=page.id;
  END LOOP;
  RETURN jsonb_build_object('scope',jsonb_build_object('ownerOrgId',p_organization_id,'planningYear',p_planning_year),
    'uploads',uploads,'nextAfterUploadId',CASE WHEN has_more THEN last_id ELSE NULL END);
END $$;

CREATE FUNCTION public.phoenix_central_needs_download_annual_original(
 p_organization_id uuid,p_planning_year integer,p_original_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE original public.central_needs_annual_originals%ROWTYPE;
BEGIN
  PERFORM phoenix_private.annual_catalog_guard_v1(p_organization_id,p_planning_year,false);
  PERFORM phoenix_private.annual_catalog_year_v1(p_organization_id,p_planning_year,false);
  SELECT * INTO original FROM public.central_needs_annual_originals
    WHERE organization_id=p_organization_id AND planning_year=p_planning_year AND id=p_original_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'annual_original_missing' USING ERRCODE='P0002'; END IF;
  IF octet_length(original.original_bytes)<>original.byte_size
      OR encode(sha256(original.original_bytes),'hex')<>original.sha256 THEN
    RAISE EXCEPTION 'annual_original_integrity_failed' USING ERRCODE='23514';
  END IF;
  RETURN jsonb_build_object('scope',jsonb_build_object('ownerOrgId',p_organization_id,'planningYear',p_planning_year),
    'original',phoenix_private.annual_original_object_v1(original.id),
    'base64',replace(encode(original.original_bytes,'base64'),E'\n',''));
END $$;

REVOKE ALL ON FUNCTION phoenix_private.annual_original_intent_v1(uuid,integer,text,text,integer) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION phoenix_private.annual_original_object_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION phoenix_private.annual_original_upload_object_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_annual_originals_contract() FROM PUBLIC,anon,service_role;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_store_annual_original(uuid,integer,text,text,integer,text,text,uuid) FROM PUBLIC,anon,service_role;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_get_annual_original_receipt(uuid,integer,text,text,integer,text,uuid) FROM PUBLIC,anon,service_role;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_list_annual_original_uploads(uuid,integer,integer,uuid) FROM PUBLIC,anon,service_role;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_download_annual_original(uuid,integer,uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_annual_originals_contract() TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_store_annual_original(uuid,integer,text,text,integer,text,text,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_get_annual_original_receipt(uuid,integer,text,text,integer,text,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_list_annual_original_uploads(uuid,integer,integer,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_download_annual_original(uuid,integer,uuid) TO authenticated;

-- The complete accepted P3-B seal is extended below with exact C2 membership.
CREATE OR REPLACE FUNCTION phoenix_private.central_needs_capability_breaches_v1()
RETURNS SETOF text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  WITH
  annual_relations(relname) AS (VALUES ('central_needs_catalog_years'), ('central_needs_annual_items'), ('central_needs_annual_versions'), ('central_needs_annual_sources'), ('central_needs_annual_occurrences'), ('central_needs_annual_request_contexts'), ('central_needs_annual_request_resolutions'), ('central_needs_annual_receipts'), ('central_needs_annual_catalog_changes'), ('central_needs_annual_need_bindings'), ('central_needs_annual_originals'), ('central_needs_annual_original_uploads')),
  annual_writers(sig) AS (VALUES ('phoenix_private.annual_catalog_capture_v1(uuid,integer,uuid,jsonb)'), ('phoenix_private.annual_catalog_receipt_v1(uuid,integer,text,text,jsonb,jsonb,text,uuid)'), ('phoenix_private.annual_catalog_write_item_v1(uuid,integer,uuid,uuid,uuid,text,jsonb,text)'), ('public.phoenix_central_needs_open_catalog_year(uuid,integer,text)'), ('public.phoenix_central_needs_create_annual_material_request(uuid,integer,jsonb,text)'), ('public.phoenix_central_needs_complete_annual_material_request(uuid,integer,uuid,integer,text,text,text)'), ('phoenix_private.annual_needs_capture_version_v1()'), ('phoenix_private.annual_needs_attach_binding_v1(uuid,uuid,integer,uuid,uuid,uuid,text)'), ('phoenix_private.annual_needs_record_receipt_v1(uuid,integer,text,text,jsonb,jsonb,text)'), ('public.phoenix_central_needs_edit_annual_catalog_item(uuid,integer,uuid,uuid,text,jsonb,text,text)'), ('public.phoenix_central_needs_store_annual_original(uuid,integer,text,text,integer,text,text,uuid)')),
  c2_routines(sig) AS (VALUES ('phoenix_private.annual_original_intent_v1(uuid,integer,text,text,integer)'), ('phoenix_private.annual_original_object_v1(uuid)'), ('phoenix_private.annual_original_upload_object_v1(uuid)'), ('public.phoenix_central_needs_annual_originals_contract()'), ('public.phoenix_central_needs_store_annual_original(uuid,integer,text,text,integer,text,text,uuid)'), ('public.phoenix_central_needs_get_annual_original_receipt(uuid,integer,text,text,integer,text,uuid)'), ('public.phoenix_central_needs_list_annual_original_uploads(uuid,integer,integer,uuid)'), ('public.phoenix_central_needs_download_annual_original(uuid,integer,uuid)')),
  nonroot AS (
    SELECT r.oid, r.rolname
      FROM pg_catalog.pg_roles r
     WHERE NOT r.rolsuper
       AND r.rolname !~ '^pg_'
       AND r.oid <> (SELECT d.datdba FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database())
  ),
  guarded_schema AS (
    SELECT n.oid, n.nspname, n.nspowner
      FROM pg_catalog.pg_namespace n
     WHERE n.nspname IN ('public', 'phoenix_private', 'phoenix_cn_policy')
  ),
  manifest(relname) AS (
    VALUES ('central_needs_plans'), ('central_needs_plan_revisions'), ('central_needs_source_files'),
           ('central_needs_import_sessions'), ('central_needs_source_records'), ('central_needs_record_mappings'),
           ('central_needs_field_overrides'), ('central_needs_import_batches'), ('central_needs_import_batch_entries'),
           ('central_needs_beneficiary_column_mappings'), ('central_needs_beneficiary_regions'),
           ('central_needs_need_lines'), ('central_needs_need_line_sources'), ('central_needs_manual_need_events'),
           ('central_needs_revision_withdrawals'), ('central_needs_manual_coverage_acknowledgements'), ('central_needs_cutover_inventory'),
           ('central_needs_material_requests'), ('central_needs_material_request_events'), ('central_needs_material_request_links'), ('central_needs_dossier_intakes'), ('central_needs_dossier_documents'), ('central_needs_dossier_receipts'), ('central_needs_catalog_years'), ('central_needs_annual_items'), ('central_needs_annual_versions'), ('central_needs_annual_sources'), ('central_needs_annual_occurrences'), ('central_needs_annual_request_contexts'), ('central_needs_annual_request_resolutions'), ('central_needs_annual_receipts'), ('central_needs_annual_catalog_changes'), ('central_needs_annual_need_bindings'), ('central_needs_annual_originals'), ('central_needs_annual_original_uploads')
  ),
  cn AS (
    SELECT c.oid, c.relowner, n.nspname, c.relname
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE (n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'central\_needs\_%')
        OR (n.nspname = 'phoenix_private' AND c.relname = 'central_needs_lifecycle_attestations')
  ),
  acl_manifest(sig) AS (
    VALUES
           ('phoenix_private.annual_original_intent_v1(uuid,integer,text,text,integer)'),
           ('phoenix_private.annual_original_object_v1(uuid)'),
           ('phoenix_private.annual_original_upload_object_v1(uuid)'),
           ('public.phoenix_central_needs_annual_originals_contract()'),
           ('public.phoenix_central_needs_store_annual_original(uuid,integer,text,text,integer,text,text,uuid)'),
           ('public.phoenix_central_needs_get_annual_original_receipt(uuid,integer,text,text,integer,text,uuid)'),
           ('public.phoenix_central_needs_list_annual_original_uploads(uuid,integer,integer,uuid)'),
           ('public.phoenix_central_needs_download_annual_original(uuid,integer,uuid)'),
           ('phoenix_private.annual_needs_flat_fields_v1(jsonb)'),
           ('phoenix_private.annual_needs_validate_fields_v1(jsonb)'),
           ('phoenix_private.annual_needs_legal_differences_v1(jsonb,jsonb)'),
           ('phoenix_private.annual_needs_actor_name_v1()'),
           ('phoenix_private.annual_needs_capture_version_v1()'),
           ('phoenix_private.annual_needs_change_object_v1(uuid)'),
           ('public.phoenix_central_needs_annual_needs_contract()'),
           ('public.phoenix_central_needs_edit_annual_catalog_item(uuid,integer,uuid,uuid,text,jsonb,text,text)'),
           ('public.phoenix_central_needs_list_annual_catalog_changes(uuid,integer,uuid,integer,uuid)'),
           ('public.phoenix_central_needs_list_annual_material_requests(uuid,integer,integer,uuid)'),
           ('phoenix_private.annual_needs_reference_v1(uuid,integer,uuid,uuid,uuid,text)'),
           ('phoenix_private.annual_needs_binding_object_v1(uuid)'),
           ('phoenix_private.annual_needs_binding_guard_v1()'),
           ('phoenix_private.annual_needs_attach_binding_v1(uuid,uuid,integer,uuid,uuid,uuid,text)'),
           ('phoenix_private.annual_needs_event_fence_v1()'),
           ('phoenix_private.annual_needs_capture_carry_v1()'),
           ('phoenix_private.annual_needs_readiness_guard_v1()'),
           ('phoenix_private.annual_needs_record_receipt_v1(uuid,integer,text,text,jsonb,jsonb,text)'),
           ('phoenix_private.annual_needs_write_v1(text,uuid,integer,uuid,uuid,uuid,uuid,text,text,text,uuid,text,uuid,uuid)'),
           ('public.phoenix_central_needs_add_annual_need_line(uuid,integer,uuid,uuid,uuid,uuid,text,text,text,uuid,text,uuid,uuid)'),
           ('public.phoenix_central_needs_correct_annual_need_line(uuid,integer,uuid,uuid,uuid,uuid,text,text,text,uuid,text,uuid,uuid)'),
           ('public.phoenix_central_needs_void_annual_need_line(uuid,integer,uuid,uuid,uuid,uuid,text,text,uuid,text,uuid,uuid)'),
           ('public.phoenix_central_needs_list_annual_need_events(uuid,integer,uuid,integer,uuid)'),
           ('phoenix_private.annual_catalog_trim_v1(text)'),
           ('phoenix_private.annual_catalog_utf16_length_v1(text)'),
           ('phoenix_private.annual_catalog_identity_guard_v1()'),
           ('phoenix_private.annual_catalog_guard_v1(uuid,integer,boolean)'),
           ('phoenix_private.annual_catalog_year_v1(uuid,integer,boolean)'),
           ('phoenix_private.annual_catalog_hash_v1(jsonb)'),
           ('phoenix_private.annual_catalog_canonical_v1(uuid,boolean)'),
           ('phoenix_private.annual_catalog_missing_v1(jsonb)'),
           ('phoenix_private.annual_catalog_fields_v1(jsonb,text)'),
           ('phoenix_private.annual_catalog_reason_v1(text)'),
           ('phoenix_private.annual_catalog_replay_v1(uuid,integer,text,text,jsonb)'),
           ('phoenix_private.annual_catalog_receipt_v1(uuid,integer,text,text,jsonb,jsonb,text,uuid)'),
           ('phoenix_private.annual_catalog_object_v1(jsonb,text[],text[])'),
           ('phoenix_private.annual_catalog_text_v1(jsonb,integer,boolean)'),
           ('phoenix_private.annual_catalog_cell_v1(jsonb)'),
           ('phoenix_private.annual_catalog_observation_v1(jsonb,text,integer)'),
           ('phoenix_private.annual_catalog_capture_v1(uuid,integer,uuid,jsonb)'),
           ('phoenix_private.annual_catalog_item_result_v1(uuid,integer,uuid,uuid)'),
           ('public.phoenix_central_needs_annual_catalog_contract()'),
           ('public.phoenix_central_needs_open_catalog_year(uuid,integer,text)'),
           ('public.phoenix_central_needs_list_catalog_years(uuid,integer,integer)'),
           ('public.phoenix_central_needs_preview_annual_canonical(uuid,integer,uuid)'),
           ('public.phoenix_central_needs_get_annual_catalog_item(uuid,integer,uuid,uuid)'),
           ('public.phoenix_central_needs_search_annual_catalog(uuid,integer,text,integer,jsonb)'),
           ('public.phoenix_central_needs_list_annual_catalog_occurrences(uuid,integer,uuid,integer,uuid)'),
           ('phoenix_private.annual_catalog_write_item_v1(uuid,integer,uuid,uuid,uuid,text,jsonb,text)'),
           ('public.phoenix_central_needs_add_annual_catalog_item(uuid,integer,uuid,text,jsonb,text,text)'),
           ('public.phoenix_central_needs_refresh_annual_catalog_item(uuid,integer,uuid,uuid,text,jsonb,text,text)'),
           ('public.phoenix_central_needs_create_annual_material_request(uuid,integer,jsonb,text)'),
           ('public.phoenix_central_needs_complete_annual_material_request(uuid,integer,uuid,integer,text,text,text)'),
           ('phoenix_private.central_needs_add_manual_need_line_reserved_v1(boolean,uuid,uuid,uuid,uuid,text,text,text,uuid,text)'),
           ('public.phoenix_central_needs_begin_dossier_workbook(uuid,text,text,text,jsonb,jsonb,jsonb,uuid)'),
           ('public.phoenix_central_needs_apply_dossier_workbook_batch(uuid,integer)'),
           ('phoenix_private.central_needs_dossier_intake_fence_v1()'), ('public.phoenix_central_needs_import_dossier_workbook(uuid,text,text,text,jsonb)'),
           ('public.phoenix_central_needs_dossier_sources(uuid)'),
           ('public.phoenix_central_needs_download_dossier_source(uuid)'),
           ('public.phoenix_central_needs_open_dossier_correction(uuid,integer,uuid,text)'),
           ('public.phoenix_central_needs_dossier_revisions(uuid)'),
           ('public.phoenix_central_needs_dossier_lifecycle(uuid,integer,uuid)'),
           ('phoenix_private.central_needs_lock_plan_id_v1(uuid)'),
           ('public.phoenix_central_needs_open_dossier(uuid,integer,text,text)'),
           ('public.phoenix_central_needs_list_dossiers(uuid,integer)'),
           ('public.phoenix_central_needs_annual_summary(uuid,integer)'),
           ('phoenix_private.central_needs_dossier_approval_guard_v1()'),
           ('public.phoenix_central_needs_create_material_request_with_code(uuid,text,text,text,text,text,text,text,text,text,text,jsonb,uuid,text)'),
           ('public.phoenix_central_needs_update_material_request_with_code(uuid,integer,text,text,text,text,text,text,text,text,text)'),
           ('phoenix_private.central_needs_national_code_v1(text)'),
           ('public.phoenix_central_needs_feature_contract()'),
           ('public.phoenix_central_needs_resolve_material_existing_with_code(uuid,integer,uuid,text,text,boolean)'),
           ('public.phoenix_central_needs_approve_material_with_code(uuid,integer,uuid[],text,text)'),
           ('public.phoenix_central_needs_material_request_code_candidates(uuid)'),
           ('phoenix_cn_policy.actor_scope_org(text)'),
           ('public.phoenix_central_needs_actor_authorized(uuid,text)'),
           ('phoenix_private.central_needs_source_mode_immutable_v1()'),
           ('phoenix_private.central_needs_lineage_mode_v1()'),
           ('phoenix_private.central_needs_manual_event_guard_v1()'),
           ('phoenix_private.central_needs_manual_projection_guard_v1()'),
           ('phoenix_private.central_needs_revision_authority_gate_v1()'),
           ('public._phoenix_central_needs_assert_manual_projection_v1()'),
           ('phoenix_cn_policy.excel_sod_enabled()'),
           ('phoenix_private.central_needs_append_only_v1()'),
           ('phoenix_private.central_needs_sod_excluded_v1(uuid,uuid)'),
           ('phoenix_private.central_needs_manual_quantity_v1(text)'),
           ('phoenix_private.central_needs_manual_scope_v1(uuid,uuid,uuid)'),
           ('phoenix_private.central_needs_coverage_digest_v1(uuid,uuid)'),
           ('phoenix_private.central_needs_effective_predecessor_v1(uuid)'),
           ('public.phoenix_central_needs_open_manual_plan_revision(uuid,integer)'),
           ('public.phoenix_central_needs_open_manual_correction_revision(uuid,integer,uuid,text)'),
           ('public.phoenix_central_needs_carry_forward_manual_lines(uuid,uuid)'),
           ('public.phoenix_central_needs_add_manual_need_line(uuid,uuid,uuid,uuid,text,text,text,uuid,text)'),
           ('public.phoenix_central_needs_correct_manual_need_line(uuid,uuid,uuid,uuid,text,text,text,uuid,text)'),
           ('public.phoenix_central_needs_void_manual_need_line(uuid,uuid,uuid,uuid,text,text,uuid,text)'),
           ('public.phoenix_central_needs_withdraw_draft_revision(uuid,uuid,text,text)'),
           ('public.phoenix_central_needs_acknowledge_manual_coverage(uuid,text,text)'),
           ('phoenix_private.central_needs_excel_review_blockers_v1(uuid)'),
           ('phoenix_private.central_needs_submission_state_digest_v1(uuid)'),
           ('public._phoenix_central_needs_review_blockers_v1(uuid)'),
           ('phoenix_cn_policy.material_reviewer_org()'),
           ('phoenix_private.central_material_norm_v1(text)'),
           ('phoenix_private.central_material_name_key_v1(text,text,text,text)'),
           ('phoenix_private.central_material_identity_key_v1(text,text,text,text,text)'),
           ('phoenix_private.central_material_lock_catalog_v1(text,text,text,text,text)'),
           ('phoenix_private.central_material_candidates_v1(text,text,text,text,text)'),
           ('phoenix_private.central_material_transition_guard_v1()'),
           ('phoenix_private.central_material_load_v1(uuid,integer)'),
           ('phoenix_private.central_material_event_v1(uuid,text,text,jsonb)'),
           ('phoenix_private.central_material_assert_reviewer_v1(uuid,uuid,uuid,boolean)'),
           ('public.phoenix_central_needs_create_material_request_draft(uuid,text,text,text,text,text,text,text,text,text,jsonb,uuid,text)'),
           ('public.phoenix_central_needs_update_material_request_draft(uuid,integer,text,text,text,text,text,text,text,text)'),
           ('public.phoenix_central_needs_submit_material_request(uuid,integer)'),
           ('public.phoenix_central_needs_start_material_review(uuid,integer)'),
           ('public.phoenix_central_needs_request_material_info(uuid,integer,text)'),
           ('public.phoenix_central_needs_resolve_material_existing(uuid,integer,uuid,text)'),
           ('public.phoenix_central_needs_approve_new_material(uuid,integer,uuid[],text)'),
           ('public.phoenix_central_needs_reject_material_request(uuid,integer,text)'),
           ('public.phoenix_central_needs_cancel_material_request(uuid,integer,text)'),
           ('public.phoenix_central_needs_link_material_request_to_draft(uuid,uuid)'),
           ('public.phoenix_central_needs_list_material_requests(uuid)'),
           ('public.phoenix_central_needs_list_material_request_events(uuid)'),
           ('public.phoenix_central_needs_material_request_candidates(uuid)'),
           ('public.phoenix_central_needs_my_material_capabilities(uuid)')
  ),
  expected_catalog_writers(proname) AS (
    VALUES
      ('phoenix_central_needs_resolve_material_existing_with_code'),
           ('phoenix_central_needs_approve_material_with_code'),
           ('phoenix_central_needs_create_material_request_with_code'),
           ('phoenix_central_needs_update_material_request_with_code'),
           ('phoenix_central_needs_create_material_request_draft'),
           ('phoenix_central_needs_update_material_request_draft'),
           ('phoenix_central_needs_submit_material_request'),
           ('phoenix_central_needs_start_material_review'),
           ('phoenix_central_needs_request_material_info'),
           ('phoenix_central_needs_resolve_material_existing'),
           ('phoenix_central_needs_approve_new_material'),
           ('phoenix_central_needs_reject_material_request'),
           ('phoenix_central_needs_cancel_material_request'),
           ('phoenix_central_needs_link_material_request_to_draft'),
           ('central_material_event_v1')
  )
  -- (a) no non-root write, TRUNCATE, REFERENCES, TRIGGER or MAINTAIN on any
  --     Central Needs relation or on the private store
  SELECT pg_catalog.format('%s holds %s on %I.%I', u.rolname, p.priv, cn.nspname, cn.relname)
    FROM nonroot u
   CROSS JOIN cn
   CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')) AS p(priv)
   WHERE u.oid <> cn.relowner
     AND pg_catalog.has_table_privilege(u.oid, cn.oid, p.priv)
  UNION ALL
  SELECT pg_catalog.format('%s holds a column-level %s on %I.%I', u.rolname, p.priv, cn.nspname, cn.relname)
    FROM nonroot u
   CROSS JOIN cn
   CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('REFERENCES')) AS p(priv)
   WHERE u.oid <> cn.relowner
     AND NOT pg_catalog.has_table_privilege(u.oid, cn.oid, p.priv)
     AND pg_catalog.has_any_column_privilege(u.oid, cn.oid, p.priv)
  UNION ALL
  -- A1 RPC-only provenance/receipts have no direct SELECT or column SELECT surface.
  SELECT pg_catalog.format('%s holds SELECT on RPC-only annual relation %I', u.rolname, c.relname)
    FROM nonroot u CROSS JOIN annual_relations a
    JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass(pg_catalog.format('public.%I',a.relname))
   WHERE u.oid<>c.relowner AND (pg_catalog.has_table_privilege(u.oid,c.oid,'SELECT')
     OR pg_catalog.has_any_column_privilege(u.oid,c.oid,'SELECT'))
  UNION ALL
  -- A1 exact writer OIDs: a new name, schema or overload does not gain annual authority.
  SELECT pg_catalog.format('unlisted_annual_catalog_writer %s.%s', n.nspname,p.proname)
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog','information_schema')
     AND pg_catalog.regexp_replace(p.prosrc,'--[^\n]*','','g')
       ~* '(insert\s+into|update|delete\s+from|truncate|merge\s+into)\s+(only\s+)?(table\s+)?("?public"?\.)?"?(central_needs_catalog_years|central_needs_annual_[a-z_]+)\y'
     AND NOT EXISTS(SELECT 1 FROM annual_writers w WHERE pg_catalog.to_regprocedure(w.sig)=p.oid)
  UNION ALL
  -- (b) no non-root TRIGGER on any relation of the application schema
  SELECT pg_catalog.format('%s holds TRIGGER on public.%I', u.rolname, c.relname)
    FROM nonroot u
   CROSS JOIN pg_catalog.pg_class c
    JOIN guarded_schema s ON s.oid = c.relnamespace AND s.nspname = 'public'
   WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND u.oid <> c.relowner
     AND pg_catalog.has_table_privilege(u.oid, c.oid, 'TRIGGER')
  UNION ALL
  -- (c) no non-root CREATE on public, the private schema or the policy schema
  SELECT pg_catalog.format('%s holds %s on schema %I', u.rolname, p.priv, s.nspname)
    FROM nonroot u
   CROSS JOIN guarded_schema s
   CROSS JOIN (VALUES ('CREATE')) AS p(priv)
   WHERE u.oid <> s.nspowner
     AND pg_catalog.has_schema_privilege(u.oid, s.oid, p.priv)
  UNION ALL
  -- (d) no object in a guarded schema owned by an API role
  SELECT pg_catalog.format('%s owns %s %I.%I', r.rolname, o.kind, s.nspname, o.name)
    FROM (SELECT c.relowner AS owner, 'relation' AS kind, c.relname::text AS name, c.relnamespace AS ns FROM pg_catalog.pg_class c
          UNION ALL
          SELECT p.proowner, 'routine', p.proname::text, p.pronamespace FROM pg_catalog.pg_proc p
          UNION ALL
          SELECT t.typowner, 'type', t.typname::text, t.typnamespace FROM pg_catalog.pg_type t
          UNION ALL
          SELECT o.oprowner, 'operator', o.oprname::text, o.oprnamespace FROM pg_catalog.pg_operator o) AS o
    JOIN guarded_schema s ON s.oid = o.ns
    JOIN pg_catalog.pg_roles r ON r.oid = o.owner
   WHERE r.rolname IN ('anon', 'authenticated', 'service_role')
  UNION ALL
  -- (e1) the catalog-derived relation set must equal the manifest
  SELECT pg_catalog.format('unlisted_central_needs_relation %I', c.relname)
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'central\_needs\_%'
     AND c.relname NOT IN (SELECT relname FROM manifest)
  UNION ALL
  SELECT pg_catalog.format('missing_central_needs_relation %I', m.relname)
    FROM manifest m
   WHERE pg_catalog.to_regclass(pg_catalog.format('public.%I', m.relname)) IS NULL
  UNION ALL
  -- (e2) the explicit ACL manifest: PUBLIC, anon or service_role must not EXECUTE
  SELECT pg_catalog.format('routine %s is executable by %s', m.sig, w.who)
    FROM acl_manifest m
   CROSS JOIN LATERAL (SELECT pg_catalog.to_regprocedure(m.sig) AS oid) r
   CROSS JOIN (VALUES ('anon'), ('service_role')) AS w(who)
   WHERE r.oid IS NOT NULL AND pg_catalog.has_function_privilege(w.who, r.oid, 'EXECUTE')
  UNION ALL
  SELECT pg_catalog.format('routine %s is executable by PUBLIC', m.sig)
    FROM acl_manifest m
   CROSS JOIN LATERAL (SELECT pg_catalog.to_regprocedure(m.sig) AS oid) r
   JOIN pg_catalog.pg_proc p ON p.oid = r.oid
   WHERE EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a WHERE a.grantee = 0)
  UNION ALL
  SELECT pg_catalog.format('manifest routine %s is missing', m.sig)
    FROM acl_manifest m
   WHERE pg_catalog.to_regprocedure(m.sig) IS NULL
  UNION ALL
  -- P1: a batch-only implementation is never an authenticated API surface.
  SELECT 'private workbook reservation writer is executable by authenticated'
   WHERE pg_catalog.has_function_privilege('authenticated',
     'phoenix_private.central_needs_add_manual_need_line_reserved_v1(boolean,uuid,uuid,uuid,uuid,text,text,text,uuid,text)'::regprocedure,
     'EXECUTE')
  UNION ALL
  -- A1: exact private helpers never become authenticated API entry points.
  SELECT pg_catalog.format('private annual helper %s is executable by authenticated', a.sig)
    FROM (VALUES ('phoenix_private.annual_original_intent_v1(uuid,integer,text,text,integer)'), ('phoenix_private.annual_original_object_v1(uuid)'), ('phoenix_private.annual_original_upload_object_v1(uuid)'), ('phoenix_private.annual_needs_flat_fields_v1(jsonb)'), ('phoenix_private.annual_needs_validate_fields_v1(jsonb)'), ('phoenix_private.annual_needs_legal_differences_v1(jsonb,jsonb)'), ('phoenix_private.annual_needs_actor_name_v1()'), ('phoenix_private.annual_needs_capture_version_v1()'), ('phoenix_private.annual_needs_change_object_v1(uuid)'), ('phoenix_private.annual_needs_reference_v1(uuid,integer,uuid,uuid,uuid,text)'), ('phoenix_private.annual_needs_binding_object_v1(uuid)'), ('phoenix_private.annual_needs_binding_guard_v1()'), ('phoenix_private.annual_needs_attach_binding_v1(uuid,uuid,integer,uuid,uuid,uuid,text)'), ('phoenix_private.annual_needs_event_fence_v1()'), ('phoenix_private.annual_needs_capture_carry_v1()'), ('phoenix_private.annual_needs_readiness_guard_v1()'), ('phoenix_private.annual_needs_record_receipt_v1(uuid,integer,text,text,jsonb,jsonb,text)'), ('phoenix_private.annual_needs_write_v1(text,uuid,integer,uuid,uuid,uuid,uuid,text,text,text,uuid,text,uuid,uuid)'), ('phoenix_private.annual_catalog_trim_v1(text)'), ('phoenix_private.annual_catalog_utf16_length_v1(text)'), ('phoenix_private.annual_catalog_identity_guard_v1()'), ('phoenix_private.annual_catalog_guard_v1(uuid,integer,boolean)'), ('phoenix_private.annual_catalog_year_v1(uuid,integer,boolean)'), ('phoenix_private.annual_catalog_hash_v1(jsonb)'), ('phoenix_private.annual_catalog_canonical_v1(uuid,boolean)'), ('phoenix_private.annual_catalog_missing_v1(jsonb)'), ('phoenix_private.annual_catalog_fields_v1(jsonb,text)'), ('phoenix_private.annual_catalog_reason_v1(text)'), ('phoenix_private.annual_catalog_replay_v1(uuid,integer,text,text,jsonb)'), ('phoenix_private.annual_catalog_receipt_v1(uuid,integer,text,text,jsonb,jsonb,text,uuid)'), ('phoenix_private.annual_catalog_object_v1(jsonb,text[],text[])'), ('phoenix_private.annual_catalog_text_v1(jsonb,integer,boolean)'), ('phoenix_private.annual_catalog_cell_v1(jsonb)'), ('phoenix_private.annual_catalog_observation_v1(jsonb,text,integer)'), ('phoenix_private.annual_catalog_capture_v1(uuid,integer,uuid,jsonb)'), ('phoenix_private.annual_catalog_item_result_v1(uuid,integer,uuid,uuid)'), ('phoenix_private.annual_catalog_write_item_v1(uuid,integer,uuid,uuid,uuid,text,jsonb,text)')) a(sig)
   WHERE pg_catalog.has_function_privilege('authenticated', pg_catalog.to_regprocedure(a.sig), 'EXECUTE')
  UNION ALL
  -- (e3) the policy schema: USAGE for authenticated only
  SELECT pg_catalog.format('%s holds USAGE on schema phoenix_cn_policy', w.who)
    FROM (VALUES ('anon'), ('service_role')) AS w(who)
   WHERE pg_catalog.to_regnamespace('phoenix_cn_policy') IS NOT NULL
     AND pg_catalog.has_schema_privilege(w.who, 'phoenix_cn_policy', 'USAGE')
  UNION ALL
  SELECT 'PUBLIC holds a privilege on schema phoenix_cn_policy'
   WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n,
                        pg_catalog.aclexplode(COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
                  WHERE n.nspname = 'phoenix_cn_policy' AND a.grantee = 0)
  UNION ALL
  -- M4' (t1): every manifest relation has FORCED row level security
  SELECT pg_catalog.format('relation %I lacks forced row level security', m.relname)
    FROM manifest m JOIN pg_catalog.pg_class c ON c.oid = pg_catalog.to_regclass(pg_catalog.format('public.%I', m.relname))
   WHERE NOT (c.relrowsecurity AND c.relforcerowsecurity)
  UNION ALL
  -- M4' (t2): ... and the restrictive actor-scope policy
  SELECT pg_catalog.format('relation %I lacks the restrictive actor-scope policy', m.relname)
    FROM manifest m JOIN pg_catalog.pg_class c ON c.oid = pg_catalog.to_regclass(pg_catalog.format('public.%I', m.relname))
   WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy po WHERE po.polrelid = c.oid AND po.polname = 'r1_actor_scope_restrictive' AND NOT po.polpermissive)
  UNION ALL
  -- M4' (t3): every SECURITY DEFINER routine of the ACL manifest pins its search_path
  SELECT pg_catalog.format('manifest routine %s has no pinned search_path', m.sig)
    FROM acl_manifest m JOIN pg_catalog.pg_proc p ON p.oid = pg_catalog.to_regprocedure(m.sig)
   WHERE p.prosecdef AND NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(COALESCE(p.proconfig, ARRAY[]::text[])) cfg WHERE cfg LIKE 'search_path=%')
  UNION ALL
  -- M4' (t4): STRUCTURAL - a relation with a foreign key to the plan revisions or to the request relations must be in the manifest, whatever its name
  SELECT pg_catalog.format('unlisted_fk_dependent_relation %I', t.relname)
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class t ON t.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
   WHERE con.contype = 'f' AND n.nspname = 'public'
     AND con.confrelid IN (pg_catalog.to_regclass('public.central_needs_plan_revisions'), pg_catalog.to_regclass('public.central_needs_material_requests'))
     AND t.relname NOT IN (SELECT relname FROM manifest)
  UNION ALL
  -- M4' (t5): STRUCTURAL - a routine that writes central_items or the request relations must be on the expected list, whatever its name
  SELECT pg_catalog.format('unlisted_catalog_writer %s.%s', n.nspname, p.proname)
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND pg_catalog.regexp_replace(p.prosrc, '--[^\n]*', '', 'g')
         ~* '(insert\s+into|update|delete\s+from|truncate|merge\s+into)\s+(only\s+)?(table\s+)?("?public"?\.)?"?(central_items|central_needs_material_[a-z_]+)\y'
     AND p.proname NOT IN (SELECT proname FROM expected_catalog_writers)
  UNION ALL
  -- C2: exact schema/signature discovery; aliases and shadow overloads are not API capabilities.
  SELECT pg_catalog.format('unlisted_annual_original_routine %s.%s', n.nspname,p.proname)
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog','information_schema')
     AND p.proname IN (SELECT q.proname FROM c2_routines m
       JOIN pg_catalog.pg_proc q ON q.oid=pg_catalog.to_regprocedure(m.sig))
     AND NOT EXISTS(SELECT 1 FROM c2_routines m WHERE pg_catalog.to_regprocedure(m.sig)=p.oid)
  UNION ALL
  -- C2: both original bytes and upload metadata remain append-only even if a guard is removed.
  SELECT pg_catalog.format('annual original relation %I lacks immutable guard %s', t.name,g.name)
    FROM (VALUES ('central_needs_annual_originals'),('central_needs_annual_original_uploads')) t(name)
   CROSS JOIN (VALUES ('annual_original_append_only',27),('annual_original_no_truncate',34)) g(name,kind)
   WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger tr
     WHERE tr.tgrelid=pg_catalog.to_regclass(pg_catalog.format('public.%I',t.name))
       AND tr.tgname=g.name AND tr.tgtype=g.kind AND tr.tgenabled='O'
       AND tr.tgfoid=pg_catalog.to_regprocedure('phoenix_private.central_needs_append_only_v1()'))
$$;

DO $verify$
BEGIN
  IF EXISTS(SELECT 1 FROM phoenix_private.central_needs_capability_breaches_v1()) THEN
    RAISE EXCEPTION 'P3C2_verify_failed: capability seal';
  END IF;
END $verify$;
COMMIT;
