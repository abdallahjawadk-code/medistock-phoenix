-- P3-B: annual field corrections, immutable actor snapshots and atomic need references.
-- UNNUMBERED / NOT_APPLIED. Requires exact accepted M235 + P1 + A1; no hosted apply.
BEGIN;
SET LOCAL search_path=pg_catalog,pg_temp;
DO $pre$
BEGIN
  IF to_regclass('public.central_needs_annual_catalog_changes') IS NOT NULL
     OR to_regclass('public.central_needs_annual_need_bindings') IS NOT NULL THEN
    RAISE EXCEPTION 'P3B_precondition_failed: already present';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('phoenix_private.central_needs_capability_breaches_v1()')
      AND md5(prosrc)='4038bd50bbb0863029efd11f86a9616e' AND NOT prosecdef
      AND proowner=(SELECT datdba FROM pg_database WHERE datname=current_database())) THEN
    RAISE EXCEPTION 'P3B_precondition_failed: accepted A1 capability seal required';
  END IF;
  IF EXISTS(SELECT 1 FROM phoenix_private.central_needs_capability_breaches_v1()) THEN
    RAISE EXCEPTION 'P3B_precondition_failed: capability breach';
  END IF;
END $pre$;
DO $bodies$
DECLARE r record; actual text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('phoenix_private.annual_catalog_guard_v1(uuid,integer,boolean)','a31aedea1bbec8fafc4ae85d43a3fd44'),
    ('phoenix_private.annual_catalog_write_item_v1(uuid,integer,uuid,uuid,uuid,text,jsonb,text)','ede9a7735d7f30bf0a71644297d75d7f'),
    ('phoenix_private.annual_catalog_item_result_v1(uuid,integer,uuid,uuid)','e0230f8aed66106b92af4d4fde1e9b80'),
    ('phoenix_private.annual_catalog_replay_v1(uuid,integer,text,text,jsonb)','5e47f1dc81aafa41ee1499f7adf9c33f'),
    ('phoenix_private.central_needs_add_manual_need_line_reserved_v1(boolean,uuid,uuid,uuid,uuid,text,text,text,uuid,text)','5bb5dad892e8316e7c3393d9d379d346'),
    ('public.phoenix_central_needs_correct_manual_need_line(uuid,uuid,uuid,uuid,text,text,text,uuid,text)','f371e6824c114e983df0a9b2c7736456'),
    ('public.phoenix_central_needs_void_manual_need_line(uuid,uuid,uuid,uuid,text,text,uuid,text)','d7d03c4118d0640fc48c8de9f57fc99d'),
    ('public.phoenix_central_needs_carry_forward_manual_lines(uuid,uuid)','565a5437c6f2d67ba8a956f850d4318d'),
    ('public.phoenix_central_needs_annual_summary(uuid,integer)','1e2e98cdcb48d36b68e1c8997f80f2f6'),
    ('public.phoenix_central_needs_search_annual_catalog(uuid,integer,text,integer,jsonb)','3e1f78af5b353dd327073688b53535b7')) expected(sig,body_md5) LOOP
    SELECT md5(prosrc) INTO actual FROM pg_proc WHERE oid=to_regprocedure(r.sig);
    IF actual IS DISTINCT FROM r.body_md5 THEN RAISE EXCEPTION 'P3B_precondition_failed: body drift %',r.sig; END IF;
  END LOOP;
END $bodies$;


CREATE TABLE public.central_needs_annual_catalog_changes (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  planning_year integer NOT NULL,
  annual_item_id uuid NOT NULL,
  from_field_version_id uuid NOT NULL,
  to_field_version_id uuid NOT NULL UNIQUE,
  before_fields jsonb NOT NULL CHECK(jsonb_typeof(before_fields)='object'),
  after_fields jsonb NOT NULL CHECK(jsonb_typeof(after_fields)='object'),
  requires_legal_review text[] NOT NULL,
  reason text NOT NULL,
  actor_id uuid NOT NULL,
  actor_name text NOT NULL CHECK(nullif(phoenix_private.annual_catalog_trim_v1(actor_name),'') IS NOT NULL),
  actor_role text NOT NULL,
  created_at timestamptz NOT NULL,
  CHECK(id=to_field_version_id AND from_field_version_id<>to_field_version_id),
  FOREIGN KEY(organization_id,planning_year,annual_item_id,from_field_version_id)
    REFERENCES public.central_needs_annual_versions(organization_id,planning_year,annual_item_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(organization_id,planning_year,annual_item_id,to_field_version_id)
    REFERENCES public.central_needs_annual_versions(organization_id,planning_year,annual_item_id,id) ON DELETE RESTRICT
);
CREATE INDEX annual_catalog_changes_scope_page ON public.central_needs_annual_catalog_changes
  (organization_id,planning_year,annual_item_id,created_at DESC,id DESC);

ALTER TABLE public.central_needs_manual_need_events
  ADD CONSTRAINT annual_need_event_org_key UNIQUE(organization_id,id);
CREATE TABLE public.central_needs_annual_need_bindings (
  event_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  planning_year integer NOT NULL,
  annual_item_id uuid NOT NULL,
  field_version_id uuid NOT NULL,
  central_item_id uuid NOT NULL REFERENCES public.central_items(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL,
  actor_name text NOT NULL CHECK(nullif(phoenix_private.annual_catalog_trim_v1(actor_name),'') IS NOT NULL),
  actor_role text NOT NULL,
  created_at timestamptz NOT NULL,
  FOREIGN KEY(organization_id,event_id)
    REFERENCES public.central_needs_manual_need_events(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(organization_id,planning_year,annual_item_id,field_version_id)
    REFERENCES public.central_needs_annual_versions(organization_id,planning_year,annual_item_id,id) ON DELETE RESTRICT
);
CREATE INDEX annual_need_bindings_scope ON public.central_needs_annual_need_bindings
  (organization_id,planning_year,annual_item_id,field_version_id);
DO $tables$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['central_needs_annual_catalog_changes','central_needs_annual_need_bindings'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
    EXECUTE format('CREATE POLICY r1_actor_scope_restrictive ON public.%I AS RESTRICTIVE FOR ALL TO authenticated
      USING (organization_id=(SELECT phoenix_cn_policy.actor_scope_org(''central_needs.view''))) WITH CHECK(false)',t);
    EXECUTE format('CREATE TRIGGER annual_append_only BEFORE UPDATE OR DELETE ON public.%I
      FOR EACH ROW EXECUTE FUNCTION phoenix_private.central_needs_append_only_v1()',t);
    EXECUTE format('CREATE TRIGGER annual_no_truncate BEFORE TRUNCATE ON public.%I
      FOR EACH STATEMENT EXECUTE FUNCTION phoenix_private.central_needs_append_only_v1()',t);
  END LOOP;
END $tables$;

CREATE FUNCTION phoenix_private.annual_needs_flat_fields_v1(p_fields jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE f text; result jsonb:='{}';
BEGIN
  FOREACH f IN ARRAY ARRAY['scientificName','nameAr','nationalCode','barcode','dosageForm','concentration','unit'] LOOP
    IF p_fields->f->>'state' NOT IN ('known','missing') OR p_fields->f->>'state' IS NULL THEN
      RAISE EXCEPTION 'annual_needs_field_state_invalid' USING ERRCODE='23514';
    END IF;
    result:=result||jsonb_build_object(f,CASE WHEN p_fields->f->>'state'='known' THEN p_fields->f->>'value' ELSE NULL END);
  END LOOP;
  RETURN result;
END $$;

CREATE FUNCTION phoenix_private.annual_needs_validate_fields_v1(p_fields jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE f text; value text;
BEGIN
  PERFORM phoenix_private.annual_catalog_object_v1(p_fields,
    ARRAY['scientificName','nameAr','nationalCode','barcode','dosageForm','concentration','unit'],
    ARRAY['scientificName','nameAr','nationalCode','barcode','dosageForm','concentration','unit']);
  FOREACH f IN ARRAY ARRAY['scientificName','nameAr','nationalCode','barcode','dosageForm','concentration','unit'] LOOP
    IF jsonb_typeof(p_fields->f) NOT IN ('string','null') THEN
      RAISE EXCEPTION 'annual_needs_field_value_invalid' USING ERRCODE='23514';
    END IF;
    value:=p_fields->>f;
    IF value IS NOT NULL AND (nullif(phoenix_private.annual_catalog_trim_v1(value),'') IS NULL
        OR phoenix_private.annual_catalog_utf16_length_v1(value)>4000 OR value ~ '[[:cntrl:]]') THEN
      RAISE EXCEPTION 'annual_needs_field_value_invalid' USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF p_fields->>'unit' IS NOT NULL AND p_fields->>'unit' NOT IN
      ('box','vial','ampoule','tablet','bottle','tube','sachet','other','test') THEN
    RAISE EXCEPTION 'annual_needs_unit_invalid' USING ERRCODE='23514';
  END IF;
END $$;

CREATE FUNCTION phoenix_private.annual_needs_legal_differences_v1(p_values jsonb,p_canonical jsonb) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE f text; canonical_value text; result text[]:='{}';
BEGIN
  FOREACH f IN ARRAY ARRAY['scientificName','nationalCode','barcode','dosageForm','concentration','unit'] LOOP
    canonical_value:=p_canonical->>f;
    IF nullif(phoenix_private.annual_catalog_trim_v1(canonical_value),'') IS NULL THEN canonical_value:=NULL; END IF;
    IF p_values->>f IS DISTINCT FROM canonical_value THEN result:=array_append(result,f); END IF;
  END LOOP;
  RETURN result;
END $$;

CREATE FUNCTION phoenix_private.annual_needs_actor_name_v1() RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE p public.profiles%ROWTYPE;
BEGIN
  SELECT * INTO p FROM public.profiles WHERE id=auth.uid() FOR SHARE;
  IF NOT FOUND OR p.status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'annual_needs_actor_ineligible' USING ERRCODE='42501';
  END IF;
  IF nullif(phoenix_private.annual_catalog_trim_v1(p.full_name),'') IS NULL
      OR phoenix_private.annual_catalog_utf16_length_v1(p.full_name)>4000 OR p.full_name ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'annual_needs_actor_name_required' USING ERRCODE='23514';
  END IF;
  RETURN p.full_name;
END $$;

CREATE FUNCTION phoenix_private.annual_needs_capture_version_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE previous public.central_needs_annual_versions%ROWTYPE; before_values jsonb; after_values jsonb;
  actor_name text; actor_role text; differences text[];
BEGIN
  IF NEW.version_number=1 THEN RETURN NEW; END IF;
  IF auth.uid() IS NULL OR NEW.created_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'annual_needs_version_actor_mismatch' USING ERRCODE='42501';
  END IF;
  actor_name:=phoenix_private.annual_needs_actor_name_v1();
  SELECT role INTO actor_role FROM public.profiles WHERE id=auth.uid();
  SELECT * INTO previous FROM public.central_needs_annual_versions
   WHERE organization_id=NEW.organization_id AND planning_year=NEW.planning_year
     AND annual_item_id=NEW.annual_item_id AND version_number=NEW.version_number-1;
  IF NOT FOUND THEN RAISE EXCEPTION 'annual_needs_previous_version_missing' USING ERRCODE='23514'; END IF;
  before_values:=phoenix_private.annual_needs_flat_fields_v1(previous.fields);
  after_values:=phoenix_private.annual_needs_flat_fields_v1(NEW.fields);
  differences:=phoenix_private.annual_needs_legal_differences_v1(after_values,NEW.canonical_snapshot);
  INSERT INTO public.central_needs_annual_catalog_changes(id,organization_id,planning_year,annual_item_id,
    from_field_version_id,to_field_version_id,before_fields,after_fields,requires_legal_review,reason,
    actor_id,actor_name,actor_role,created_at)
  VALUES(NEW.id,NEW.organization_id,NEW.planning_year,NEW.annual_item_id,previous.id,NEW.id,
    before_values,after_values,differences,NEW.reason,auth.uid(),actor_name,actor_role,NEW.created_at);
  INSERT INTO public.audit_logs(organization_id,actor_id,actor_role,action,entity_type,entity_id,payload)
  VALUES(NEW.organization_id,auth.uid(),actor_role,'central_needs.annual_catalog.fields_versioned','annual_catalog',NEW.annual_item_id,
    jsonb_build_object('planning_year',NEW.planning_year,'change_id',NEW.id,'from_field_version_id',previous.id,
      'to_field_version_id',NEW.id,'before_fields',before_values,'after_fields',after_values,'reason',NEW.reason,
      'actor_name',actor_name,'actor_name_source','profiles_snapshot','requires_legal_review',to_jsonb(differences)));
  RETURN NEW;
END $$;
CREATE TRIGGER annual_version_capture_employee AFTER INSERT ON public.central_needs_annual_versions
 FOR EACH ROW EXECUTE FUNCTION phoenix_private.annual_needs_capture_version_v1();

CREATE FUNCTION phoenix_private.annual_needs_change_object_v1(p_version uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE v public.central_needs_annual_versions%ROWTYPE; previous public.central_needs_annual_versions%ROWTYPE;
  c public.central_needs_annual_catalog_changes%ROWTYPE; captured boolean;
BEGIN
  SELECT * INTO v FROM public.central_needs_annual_versions WHERE id=p_version AND version_number>1;
  IF NOT FOUND THEN RAISE EXCEPTION 'annual_needs_change_missing' USING ERRCODE='P0002'; END IF;
  SELECT * INTO previous FROM public.central_needs_annual_versions WHERE organization_id=v.organization_id
    AND planning_year=v.planning_year AND annual_item_id=v.annual_item_id AND version_number=v.version_number-1;
  IF NOT FOUND THEN RAISE EXCEPTION 'annual_needs_previous_version_missing' USING ERRCODE='23514'; END IF;
  SELECT * INTO c FROM public.central_needs_annual_catalog_changes WHERE id=v.id;
  captured:=FOUND;
  RETURN jsonb_build_object('changeId',v.id,'fromFieldVersionId',previous.id,'toFieldVersionId',v.id,
    'actorId',v.created_by,'actorName',CASE WHEN captured THEN c.actor_name ELSE NULL END,
    'fromTrustedProfile',captured,'createdAt',v.created_at,'reason',v.reason,
    'beforeFields',phoenix_private.annual_needs_flat_fields_v1(previous.fields),
    'afterFields',phoenix_private.annual_needs_flat_fields_v1(v.fields),
    'requiresLegalReview',to_jsonb(phoenix_private.annual_needs_legal_differences_v1(
      phoenix_private.annual_needs_flat_fields_v1(v.fields),v.canonical_snapshot)));
END $$;

CREATE FUNCTION public.phoenix_central_needs_annual_needs_contract() RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
  SELECT jsonb_build_object('version',1,'quantityBinding',true,'annualEdits',true,'actorSnapshots',true,
    'scope','owner_year','editPolicy','annual_snapshot_with_legal_review')
$$;

CREATE FUNCTION public.phoenix_central_needs_edit_annual_catalog_item(
 p_organization_id uuid,p_planning_year integer,p_annual_item_id uuid,p_expected_field_version_id uuid,
 p_expected_canonical_fingerprint text,p_fields jsonb,p_reason text,p_idempotency_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE role_name text; intent jsonb; result jsonb; i public.central_needs_annual_items%ROWTYPE;
  v public.central_needs_annual_versions%ROWTYPE; c jsonb; fields jsonb; before_values jsonb; f text;
  version_id uuid:=gen_random_uuid(); reason text; differences text[]; next_status text;
BEGIN
  role_name:=phoenix_private.annual_catalog_guard_v1(p_organization_id,p_planning_year,true);
  intent:=jsonb_build_object('ownerOrgId',p_organization_id,'planningYear',p_planning_year,'annualItemId',p_annual_item_id,
    'expectedFieldVersionId',p_expected_field_version_id,'expectedCanonicalFingerprint',p_expected_canonical_fingerprint,
    'fields',p_fields,'reason',p_reason);
  result:=phoenix_private.annual_catalog_replay_v1(p_organization_id,p_planning_year,p_idempotency_key,'edit_item',intent);
  IF result IS NOT NULL THEN RETURN result; END IF;
  reason:=phoenix_private.annual_catalog_reason_v1(p_reason);
  PERFORM phoenix_private.annual_needs_validate_fields_v1(p_fields);
  PERFORM phoenix_private.annual_needs_actor_name_v1();
  PERFORM phoenix_private.annual_catalog_year_v1(p_organization_id,p_planning_year,true);
  SELECT * INTO i FROM public.central_needs_annual_items WHERE organization_id=p_organization_id
    AND planning_year=p_planning_year AND id=p_annual_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'annual_catalog_item_missing' USING ERRCODE='P0002'; END IF;
  c:=phoenix_private.annual_catalog_canonical_v1(i.central_item_id,true);
  IF c IS NULL OR c->>'status' IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'annual_catalog_canonical_inactive' USING ERRCODE='23514';
  END IF;
  IF p_expected_canonical_fingerprint IS NULL OR p_expected_canonical_fingerprint IS DISTINCT FROM phoenix_private.annual_catalog_hash_v1(c) THEN
    RAISE EXCEPTION 'annual_catalog_canonical_stale' USING ERRCODE='23514';
  END IF;
  SELECT * INTO i FROM public.central_needs_annual_items WHERE organization_id=p_organization_id
    AND planning_year=p_planning_year AND id=p_annual_item_id FOR UPDATE;
  IF i.status='retired' THEN RAISE EXCEPTION 'annual_catalog_member_retired' USING ERRCODE='23514'; END IF;
  IF p_expected_field_version_id IS NULL OR i.current_field_version_id IS DISTINCT FROM p_expected_field_version_id THEN
    RAISE EXCEPTION 'annual_catalog_version_stale' USING ERRCODE='23514';
  END IF;
  SELECT * INTO v FROM public.central_needs_annual_versions WHERE id=i.current_field_version_id;
  before_values:=phoenix_private.annual_needs_flat_fields_v1(v.fields);
  IF before_values=p_fields THEN RAISE EXCEPTION 'annual_needs_edit_no_change' USING ERRCODE='23514'; END IF;
  fields:=v.fields;
  FOREACH f IN ARRAY ARRAY['scientificName','nameAr','nationalCode','barcode','dosageForm','concentration','unit'] LOOP
    IF before_values->f IS DISTINCT FROM p_fields->f THEN
      fields:=fields||jsonb_build_object(f,CASE WHEN p_fields->f='null'::jsonb
        THEN jsonb_build_object('state','missing','reason','annual_correction_missing')
        ELSE jsonb_build_object('state','known','value',p_fields->>f,'origins',jsonb_build_array(
          jsonb_build_object('kind','manual','decisionReference',version_id))) END);
    END IF;
  END LOOP;
  differences:=phoenix_private.annual_needs_legal_differences_v1(p_fields,c);
  next_status:=CASE WHEN cardinality(differences)=0 AND cardinality(phoenix_private.annual_catalog_missing_v1(c))=0
    THEN 'active' ELSE 'preparing' END;
  INSERT INTO public.central_needs_annual_versions(id,organization_id,planning_year,annual_item_id,version_number,
    fields,canonical_snapshot,canonical_fingerprint,reason,created_by)
  VALUES(version_id,p_organization_id,p_planning_year,i.id,v.version_number+1,fields,c,
    phoenix_private.annual_catalog_hash_v1(c),reason,auth.uid());
  UPDATE public.central_needs_annual_items SET current_field_version_id=version_id,status=next_status WHERE id=i.id;
  result:=phoenix_private.annual_catalog_item_result_v1(p_organization_id,p_planning_year,i.id,NULL)
    ||jsonb_build_object('change',phoenix_private.annual_needs_change_object_v1(version_id));
  RETURN phoenix_private.annual_catalog_receipt_v1(p_organization_id,p_planning_year,p_idempotency_key,
    'edit_item',intent,result,role_name,i.id);
END $$;

CREATE FUNCTION public.phoenix_central_needs_list_annual_catalog_changes(
 p_organization_id uuid,p_planning_year integer,p_annual_item_id uuid,p_limit integer,p_after_change_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE at_time timestamptz; r record; rows jsonb:='[]'; last_id uuid; next_id uuid;
BEGIN
  PERFORM phoenix_private.annual_catalog_guard_v1(p_organization_id,p_planning_year,false);
  PERFORM phoenix_private.annual_catalog_year_v1(p_organization_id,p_planning_year,false);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'annual_needs_limit_invalid' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.central_needs_annual_items WHERE organization_id=p_organization_id
      AND planning_year=p_planning_year AND id=p_annual_item_id) THEN
    RAISE EXCEPTION 'annual_catalog_item_missing' USING ERRCODE='P0002';
  END IF;
  IF p_after_change_id IS NOT NULL THEN
    SELECT created_at INTO at_time FROM public.central_needs_annual_versions WHERE id=p_after_change_id
      AND organization_id=p_organization_id AND planning_year=p_planning_year AND annual_item_id=p_annual_item_id AND version_number>1;
    IF NOT FOUND THEN RAISE EXCEPTION 'annual_needs_cursor_invalid' USING ERRCODE='23514'; END IF;
  END IF;
  FOR r IN SELECT id FROM public.central_needs_annual_versions WHERE organization_id=p_organization_id
    AND planning_year=p_planning_year AND annual_item_id=p_annual_item_id AND version_number>1
    AND (p_after_change_id IS NULL OR (created_at,id)<(at_time,p_after_change_id))
    ORDER BY created_at DESC,id DESC LIMIT p_limit+1 LOOP
    IF jsonb_array_length(rows)=p_limit THEN next_id:=last_id; EXIT; END IF;
    rows:=rows||jsonb_build_array(phoenix_private.annual_needs_change_object_v1(r.id)); last_id:=r.id;
  END LOOP;
  RETURN jsonb_build_object('scope',jsonb_build_object('ownerOrgId',p_organization_id,'planningYear',p_planning_year),
    'annualItemId',p_annual_item_id,'changes',rows,'nextAfterChangeId',next_id);
END $$;

CREATE FUNCTION public.phoenix_central_needs_list_annual_material_requests(
 p_organization_id uuid,p_planning_year integer,p_limit integer,p_after_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE at_time timestamptz; r record; rows jsonb:='[]'; last_id uuid; next_id uuid;
BEGIN
  PERFORM phoenix_private.annual_catalog_guard_v1(p_organization_id,p_planning_year,false);
  PERFORM phoenix_private.annual_catalog_year_v1(p_organization_id,p_planning_year,false);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'annual_needs_limit_invalid' USING ERRCODE='23514'; END IF;
  IF p_after_request_id IS NOT NULL THEN
    SELECT q.created_at INTO at_time FROM public.central_needs_material_requests q
      JOIN public.central_needs_annual_request_contexts x ON x.request_id=q.id AND x.organization_id=q.organization_id
      WHERE x.organization_id=p_organization_id AND x.planning_year=p_planning_year AND q.id=p_after_request_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'annual_needs_cursor_invalid' USING ERRCODE='23514'; END IF;
  END IF;
  FOR r IN SELECT q.* FROM public.central_needs_material_requests q
    JOIN public.central_needs_annual_request_contexts x ON x.request_id=q.id AND x.organization_id=q.organization_id
    WHERE x.organization_id=p_organization_id AND x.planning_year=p_planning_year
      AND (p_after_request_id IS NULL OR (q.created_at,q.id)<(at_time,p_after_request_id))
    ORDER BY q.created_at DESC,q.id DESC LIMIT p_limit+1 LOOP
    IF jsonb_array_length(rows)=p_limit THEN next_id:=last_id; EXIT; END IF;
    rows:=rows||jsonb_build_array(jsonb_build_object('id',r.id,'organizationId',r.organization_id,'requesterId',r.requester_id,
      'status',r.status,'version',r.version,'scientificName',r.scientific_name,'nameAr',r.name_ar,'tradeName',r.trade_name,
      'strength',r.strength,'dosageForm',r.dosage_form,'unit',r.unit,'barcode',r.barcode,'nationalCode',r.national_code,
      'note',r.note,'provenanceKind',r.provenance_kind,'reviewerId',r.reviewer_id,'resolvedItemId',r.resolved_item_id,
      'decisionReason',r.decision_reason,'createdAt',r.created_at)); last_id:=r.id;
  END LOOP;
  RETURN jsonb_build_object('scope',jsonb_build_object('ownerOrgId',p_organization_id,'planningYear',p_planning_year),
    'requests',rows,'nextAfterRequestId',next_id);
END $$;

CREATE FUNCTION phoenix_private.annual_needs_reference_v1(
 p_org uuid,p_year integer,p_item uuid,p_version uuid,p_canonical uuid,p_mode text)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE y public.central_needs_catalog_years%ROWTYPE; i public.central_needs_annual_items%ROWTYPE;
  v public.central_needs_annual_versions%ROWTYPE; c jsonb; values_flat jsonb; differences text[];
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('selection','carry','void') THEN
    RAISE EXCEPTION 'annual_needs_reference_mode_invalid' USING ERRCODE='23514';
  END IF;
  SELECT * INTO y FROM public.central_needs_catalog_years WHERE organization_id=p_org AND planning_year=p_year FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'annual_catalog_year_missing' USING ERRCODE='P0002'; END IF;
  c:=phoenix_private.annual_catalog_canonical_v1(p_canonical,true);
  SELECT * INTO i FROM public.central_needs_annual_items WHERE organization_id=p_org AND planning_year=p_year
    AND id=p_item AND central_item_id=p_canonical FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'annual_needs_reference_scope_mismatch' USING ERRCODE='23514'; END IF;
  SELECT * INTO v FROM public.central_needs_annual_versions WHERE organization_id=p_org AND planning_year=p_year
    AND annual_item_id=p_item AND id=p_version;
  IF NOT FOUND THEN RAISE EXCEPTION 'annual_needs_reference_scope_mismatch' USING ERRCODE='23514'; END IF;
  IF p_mode<>'void' THEN
    IF y.status<>'active' OR i.status='retired' OR c IS NULL OR c->>'status' IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'annual_needs_reference_ineligible' USING ERRCODE='23514';
    END IF;
    values_flat:=phoenix_private.annual_needs_flat_fields_v1(v.fields);
    differences:=phoenix_private.annual_needs_legal_differences_v1(values_flat,c);
    IF cardinality(differences)>0 OR cardinality(phoenix_private.annual_catalog_missing_v1(values_flat))>0 THEN
      RAISE EXCEPTION 'annual_needs_reference_legal_conflict' USING ERRCODE='23514';
    END IF;
    IF p_mode='selection' AND (i.status<>'active' OR i.current_field_version_id IS DISTINCT FROM p_version
        OR v.canonical_fingerprint IS DISTINCT FROM phoenix_private.annual_catalog_hash_v1(c)) THEN
      RAISE EXCEPTION 'annual_needs_reference_not_current' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN jsonb_build_object('scope',jsonb_build_object('ownerOrgId',p_org,'planningYear',p_year),
    'annualItemId',i.id,'fieldVersionId',v.id,'versionNumber',v.version_number,'canonicalItemId',i.central_item_id,'fields',v.fields);
END $$;

CREATE FUNCTION phoenix_private.annual_needs_binding_object_v1(p_event uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('scope',jsonb_build_object('ownerOrgId',b.organization_id,'planningYear',b.planning_year),
   'annualItemId',b.annual_item_id,'fieldVersionId',b.field_version_id,'versionNumber',v.version_number,
   'canonicalItemId',b.central_item_id,'fields',v.fields)
 FROM public.central_needs_annual_need_bindings b
 JOIN public.central_needs_annual_versions v ON (v.organization_id,v.planning_year,v.annual_item_id,v.id)=
   (b.organization_id,b.planning_year,b.annual_item_id,b.field_version_id)
 WHERE b.event_id=p_event
$$;

CREATE FUNCTION phoenix_private.annual_needs_binding_guard_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE e public.central_needs_manual_need_events%ROWTYPE; actual_year integer; actual_item uuid; unit_value text;
BEGIN
  SELECT * INTO e FROM public.central_needs_manual_need_events WHERE id=NEW.event_id;
  IF NOT FOUND OR e.organization_id IS DISTINCT FROM NEW.organization_id OR e.central_item_id IS DISTINCT FROM NEW.central_item_id
      OR e.actor_id IS DISTINCT FROM NEW.actor_id OR NEW.actor_id IS DISTINCT FROM auth.uid()
      OR e.actor_role IS DISTINCT FROM NEW.actor_role OR e.created_at IS DISTINCT FROM NEW.created_at
      OR e.txid IS DISTINCT FROM txid_current() THEN
    RAISE EXCEPTION 'annual_needs_event_binding_mismatch' USING ERRCODE='23514';
  END IF;
  SELECT plan_year INTO actual_year FROM public.central_needs_plans WHERE id=e.plan_id AND organization_id=NEW.organization_id;
  IF actual_year IS DISTINCT FROM NEW.planning_year THEN
    RAISE EXCEPTION 'annual_needs_event_year_mismatch' USING ERRCODE='23514';
  END IF;
  SELECT i.central_item_id,v.fields->'unit'->>'value' INTO actual_item,unit_value
    FROM public.central_needs_annual_items i JOIN public.central_needs_annual_versions v
      ON (v.organization_id,v.planning_year,v.annual_item_id)=(i.organization_id,i.planning_year,i.id)
    WHERE i.organization_id=NEW.organization_id AND i.planning_year=NEW.planning_year
      AND i.id=NEW.annual_item_id AND v.id=NEW.field_version_id;
  IF NOT FOUND OR actual_item IS DISTINCT FROM NEW.central_item_id
      OR (e.event_kind<>'void' AND e.approved_unit IS DISTINCT FROM unit_value)
      OR NEW.actor_name IS DISTINCT FROM phoenix_private.annual_needs_actor_name_v1() THEN
    RAISE EXCEPTION 'annual_needs_event_binding_mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER annual_need_binding_scope BEFORE INSERT ON public.central_needs_annual_need_bindings
 FOR EACH ROW EXECUTE FUNCTION phoenix_private.annual_needs_binding_guard_v1();

CREATE FUNCTION phoenix_private.annual_needs_attach_binding_v1(
 p_event uuid,p_org uuid,p_year integer,p_item uuid,p_version uuid,p_canonical uuid,p_mode text)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE e public.central_needs_manual_need_events%ROWTYPE; binding jsonb; actor_name text;
BEGIN
  binding:=phoenix_private.annual_needs_reference_v1(p_org,p_year,p_item,p_version,p_canonical,p_mode);
  SELECT * INTO e FROM public.central_needs_manual_need_events WHERE id=p_event;
  IF NOT FOUND THEN RAISE EXCEPTION 'annual_needs_event_missing' USING ERRCODE='P0002'; END IF;
  actor_name:=phoenix_private.annual_needs_actor_name_v1();
  INSERT INTO public.central_needs_annual_need_bindings(event_id,organization_id,planning_year,annual_item_id,
    field_version_id,central_item_id,actor_id,actor_name,actor_role,created_at)
  VALUES(p_event,p_org,p_year,p_item,p_version,p_canonical,e.actor_id,actor_name,e.actor_role,e.created_at);
  INSERT INTO public.audit_logs(organization_id,actor_id,actor_role,action,entity_type,entity_id,payload)
  VALUES(p_org,e.actor_id,e.actor_role,'central_needs.annual_need.binding','central_needs_plan_revision',e.plan_revision_id,
    jsonb_build_object('event_id',e.id,'planning_year',p_year,'annual_binding',binding,'actor_name',actor_name,
      'actor_name_source','profiles_snapshot','reason',e.reason,'event_kind',e.event_kind));
  RETURN binding;
END $$;

-- A commit cannot leave a new annual command, or a descendant of a bound event,
-- without its own immutable reference. No session GUC grants writer authority.
CREATE FUNCTION phoenix_private.annual_needs_event_fence_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE b public.central_needs_annual_need_bindings%ROWTYPE; previous public.central_needs_annual_need_bindings%ROWTYPE;
  bound boolean; prior_bound boolean;
BEGIN
  SELECT * INTO b FROM public.central_needs_annual_need_bindings WHERE event_id=NEW.id; bound:=FOUND;
  SELECT * INTO previous FROM public.central_needs_annual_need_bindings
    WHERE event_id=coalesce(NEW.carried_from_event_id,NEW.supersedes_event_id); prior_bound:=FOUND;
  IF (NEW.idempotency_key LIKE 'annual-needs:%' OR prior_bound) AND NOT bound THEN
    RAISE EXCEPTION 'annual_needs_binding_required' USING ERRCODE='23514';
  END IF;
  IF bound AND prior_bound AND NEW.event_kind IN ('void','carried_forward')
      AND (b.organization_id,b.planning_year,b.annual_item_id,b.field_version_id,b.central_item_id)
        IS DISTINCT FROM (previous.organization_id,previous.planning_year,previous.annual_item_id,previous.field_version_id,previous.central_item_id) THEN
    RAISE EXCEPTION 'annual_needs_historical_binding_changed' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER annual_need_binding_required AFTER INSERT ON public.central_needs_manual_need_events
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION phoenix_private.annual_needs_event_fence_v1();

CREATE FUNCTION phoenix_private.annual_needs_capture_carry_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE b public.central_needs_annual_need_bindings%ROWTYPE;
BEGIN
  IF NEW.event_kind<>'carried_forward' THEN RETURN NEW; END IF;
  SELECT * INTO b FROM public.central_needs_annual_need_bindings WHERE event_id=NEW.carried_from_event_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  PERFORM phoenix_private.annual_catalog_guard_v1(NEW.organization_id,b.planning_year,false);
  PERFORM phoenix_private.annual_needs_attach_binding_v1(NEW.id,NEW.organization_id,b.planning_year,
    b.annual_item_id,b.field_version_id,NEW.central_item_id,'carry');
  RETURN NEW;
END $$;
CREATE TRIGGER annual_need_carry_reference AFTER INSERT ON public.central_needs_manual_need_events
 FOR EACH ROW EXECUTE FUNCTION phoenix_private.annual_needs_capture_carry_v1();

CREATE FUNCTION phoenix_private.annual_needs_readiness_guard_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r record; actual_year integer;
BEGIN
  IF NEW.status NOT IN ('submitted','approved') OR NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  SELECT plan_year INTO actual_year FROM public.central_needs_plans WHERE id=NEW.plan_id AND organization_id=NEW.organization_id;
  FOR r IN SELECT e.central_item_id,b.annual_item_id,b.field_version_id,b.planning_year
    FROM public.central_needs_manual_need_events e JOIN public.central_needs_annual_need_bindings b ON b.event_id=e.id
    WHERE e.plan_revision_id=NEW.id AND e.event_kind<>'void'
      AND NOT EXISTS(SELECT 1 FROM public.central_needs_manual_need_events later
        WHERE later.plan_revision_id=e.plan_revision_id AND later.beneficiary_organization_id=e.beneficiary_organization_id
          AND later.central_item_id=e.central_item_id AND later.target_warehouse_id IS NOT DISTINCT FROM e.target_warehouse_id
          AND later.event_seq>e.event_seq)
    ORDER BY e.beneficiary_organization_id,e.central_item_id,e.target_warehouse_id NULLS FIRST LOOP
    IF r.planning_year IS DISTINCT FROM actual_year THEN RAISE EXCEPTION 'annual_needs_event_year_mismatch' USING ERRCODE='23514'; END IF;
    PERFORM phoenix_private.annual_needs_reference_v1(NEW.organization_id,actual_year,r.annual_item_id,r.field_version_id,r.central_item_id,'carry');
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER annual_need_legal_readiness BEFORE UPDATE OF status ON public.central_needs_plan_revisions
 FOR EACH ROW EXECUTE FUNCTION phoenix_private.annual_needs_readiness_guard_v1();

CREATE FUNCTION phoenix_private.annual_needs_record_receipt_v1(
 p_org uuid,p_year integer,p_key text,p_action text,p_intent jsonb,p_result jsonb,p_role text)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  INSERT INTO public.central_needs_annual_receipts(organization_id,planning_year,actor_id,idempotency_key,action,intent,result)
  VALUES(p_org,p_year,auth.uid(),p_key,p_action,p_intent,p_result||jsonb_build_object('idempotentReplay',false));
  INSERT INTO public.audit_logs(organization_id,actor_id,actor_role,action,entity_type,entity_id,payload)
  VALUES(p_org,auth.uid(),p_role,'central_needs.annual_need.'||p_action,'central_needs_plan_revision',
    (p_result->>'planRevisionId')::uuid,jsonb_build_object('planning_year',p_year,'event_id',p_result->>'eventId',
      'intent_sha256',phoenix_private.annual_catalog_hash_v1(p_intent),'annual_binding',p_result->'annualBinding'));
  RETURN p_result||jsonb_build_object('idempotentReplay',false);
END $$;

CREATE FUNCTION phoenix_private.annual_needs_write_v1(
 p_action text,p_org uuid,p_year integer,p_revision uuid,p_beneficiary uuid,p_canonical uuid,p_warehouse uuid,
 p_quantity text,p_reason text,p_key text,p_expected_event uuid,p_reference text,p_item uuid,p_version uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE role_name text; intent jsonb; result jsonb; written jsonb; binding jsonb; inner_key text; reason text;
  revision public.central_needs_plan_revisions%ROWTYPE; plan public.central_needs_plans%ROWTYPE;
  previous public.central_needs_annual_need_bindings%ROWTYPE; event_id uuid; event_mode text;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'annual_catalog_requires_read_committed' USING ERRCODE='25000'; END IF;
  IF p_action IS NULL OR p_action NOT IN ('add','correct','void') THEN RAISE EXCEPTION 'annual_needs_action_invalid' USING ERRCODE='23514'; END IF;
  PERFORM phoenix_private.annual_catalog_guard_v1(p_org,p_year,false);
  role_name:=public._phoenix_central_needs_guard_v1(p_org,'central_needs.manual_need.set');
  SELECT * INTO revision FROM public.central_needs_plan_revisions WHERE id=p_revision AND organization_id=p_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'annual_needs_revision_scope_mismatch' USING ERRCODE='23514'; END IF;
  SELECT * INTO plan FROM public.central_needs_plans WHERE id=revision.plan_id AND organization_id=p_org AND plan_year=p_year;
  IF NOT FOUND THEN RAISE EXCEPTION 'annual_needs_revision_scope_mismatch' USING ERRCODE='23514'; END IF;
  intent:=jsonb_build_object('ownerOrgId',p_org,'planningYear',p_year,'planRevisionId',p_revision,
    'beneficiaryOrganizationId',p_beneficiary,'canonicalItemId',p_canonical,'targetWarehouseId',p_warehouse,
    'quantityText',p_quantity,'reason',p_reason,'expectedLastEventId',p_expected_event,'reference',p_reference,
    'annualItemId',p_item,'fieldVersionId',p_version);
  result:=phoenix_private.annual_catalog_replay_v1(p_org,p_year,p_key,'need_'||p_action,intent);
  IF result IS NOT NULL THEN RETURN result; END IF;
  PERFORM phoenix_private.annual_needs_actor_name_v1();
  reason:=phoenix_private.annual_catalog_reason_v1(p_reason);
  PERFORM phoenix_private.central_needs_lock_plan_id_v1(plan.id);
  -- Stabilize the existing beneficiary/warehouse eligibility predicate for this
  -- new command; the reused writer still performs its original scope checks.
  PERFORM 1 FROM public.organizations WHERE id=p_beneficiary AND organization_kind='care_institution'
    AND status='active' AND archived_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'manual_beneficiary_ineligible' USING ERRCODE='23514'; END IF;
  IF p_warehouse IS NOT NULL THEN
    PERFORM 1 FROM public.warehouses WHERE id=p_warehouse AND organization_id=p_beneficiary
      AND status='active' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'manual_warehouse_ineligible' USING ERRCODE='23514'; END IF;
  END IF;
  event_mode:=CASE WHEN p_action='void' THEN 'void' ELSE 'selection' END;
  IF p_action='void' THEN
    SELECT b.* INTO previous FROM public.central_needs_annual_need_bindings b WHERE b.event_id=p_expected_event;
    IF NOT FOUND OR (previous.organization_id,previous.planning_year,previous.annual_item_id,previous.field_version_id,previous.central_item_id)
        IS DISTINCT FROM (p_org,p_year,p_item,p_version,p_canonical) THEN
      RAISE EXCEPTION 'annual_needs_void_binding_mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  binding:=phoenix_private.annual_needs_reference_v1(p_org,p_year,p_item,p_version,p_canonical,event_mode);
  inner_key:='annual-needs:'||phoenix_private.annual_catalog_hash_v1(jsonb_build_object('actorId',auth.uid(),
    'idempotencyKey',p_key,'action',p_action,'intent',intent));
  IF p_action='add' THEN
    written:=public.phoenix_central_needs_add_manual_need_line(p_revision,p_beneficiary,p_canonical,p_warehouse,
      p_quantity,reason,inner_key,p_expected_event,p_reference);
  ELSIF p_action='correct' THEN
    written:=public.phoenix_central_needs_correct_manual_need_line(p_revision,p_beneficiary,p_canonical,p_warehouse,
      p_quantity,reason,inner_key,p_expected_event,p_reference);
  ELSE
    written:=public.phoenix_central_needs_void_manual_need_line(p_revision,p_beneficiary,p_canonical,p_warehouse,
      reason,inner_key,p_expected_event,p_reference);
  END IF;
  IF written->'idempotent_replay' IS DISTINCT FROM 'false'::jsonb OR written->>'event_id' IS NULL THEN
    RAISE EXCEPTION 'annual_needs_untracked_writer_replay' USING ERRCODE='23514';
  END IF;
  event_id:=(written->>'event_id')::uuid;
  binding:=phoenix_private.annual_needs_attach_binding_v1(event_id,p_org,p_year,p_item,p_version,p_canonical,event_mode);
  result:=jsonb_build_object('scope',jsonb_build_object('ownerOrgId',p_org,'planningYear',p_year),
    'planRevisionId',p_revision,'eventId',event_id,'eventSeq',(written->>'event_seq')::integer,'annualBinding',binding);
  RETURN phoenix_private.annual_needs_record_receipt_v1(p_org,p_year,p_key,'need_'||p_action,intent,result,role_name);
END $$;

CREATE FUNCTION public.phoenix_central_needs_add_annual_need_line(
 p_organization_id uuid,p_planning_year integer,p_plan_revision_id uuid,p_beneficiary_organization_id uuid,
 p_central_item_id uuid,p_target_warehouse_id uuid,p_quantity_text text,p_reason text,p_idempotency_key text,
 p_expected_last_event_id uuid,p_reference text,p_annual_item_id uuid,p_field_version_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT phoenix_private.annual_needs_write_v1('add',p_organization_id,p_planning_year,p_plan_revision_id,
   p_beneficiary_organization_id,p_central_item_id,p_target_warehouse_id,p_quantity_text,p_reason,p_idempotency_key,
   p_expected_last_event_id,p_reference,p_annual_item_id,p_field_version_id)
$$;
CREATE FUNCTION public.phoenix_central_needs_correct_annual_need_line(
 p_organization_id uuid,p_planning_year integer,p_plan_revision_id uuid,p_beneficiary_organization_id uuid,
 p_central_item_id uuid,p_target_warehouse_id uuid,p_quantity_text text,p_reason text,p_idempotency_key text,
 p_expected_last_event_id uuid,p_reference text,p_annual_item_id uuid,p_field_version_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT phoenix_private.annual_needs_write_v1('correct',p_organization_id,p_planning_year,p_plan_revision_id,
   p_beneficiary_organization_id,p_central_item_id,p_target_warehouse_id,p_quantity_text,p_reason,p_idempotency_key,
   p_expected_last_event_id,p_reference,p_annual_item_id,p_field_version_id)
$$;
CREATE FUNCTION public.phoenix_central_needs_void_annual_need_line(
 p_organization_id uuid,p_planning_year integer,p_plan_revision_id uuid,p_beneficiary_organization_id uuid,
 p_central_item_id uuid,p_target_warehouse_id uuid,p_reason text,p_idempotency_key text,
 p_expected_last_event_id uuid,p_reference text,p_annual_item_id uuid,p_field_version_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT phoenix_private.annual_needs_write_v1('void',p_organization_id,p_planning_year,p_plan_revision_id,
   p_beneficiary_organization_id,p_central_item_id,p_target_warehouse_id,NULL,p_reason,p_idempotency_key,
   p_expected_last_event_id,p_reference,p_annual_item_id,p_field_version_id)
$$;

CREATE FUNCTION public.phoenix_central_needs_list_annual_need_events(
 p_organization_id uuid,p_planning_year integer,p_plan_revision_id uuid,p_limit integer,p_after_event_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE at_time timestamptz; r record; rows jsonb:='[]'; last_id uuid; next_id uuid;
BEGIN
  PERFORM phoenix_private.annual_catalog_guard_v1(p_organization_id,p_planning_year,false);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'annual_needs_limit_invalid' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.central_needs_plan_revisions v JOIN public.central_needs_plans p ON p.id=v.plan_id
      WHERE v.id=p_plan_revision_id AND v.organization_id=p_organization_id AND p.organization_id=p_organization_id
        AND p.plan_year=p_planning_year) THEN
    RAISE EXCEPTION 'annual_needs_revision_scope_mismatch' USING ERRCODE='23514';
  END IF;
  IF p_after_event_id IS NOT NULL THEN
    SELECT created_at INTO at_time FROM public.central_needs_manual_need_events WHERE id=p_after_event_id
      AND organization_id=p_organization_id AND plan_revision_id=p_plan_revision_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'annual_needs_cursor_invalid' USING ERRCODE='23514'; END IF;
  END IF;
  FOR r IN SELECT e.*,b.actor_name,b.event_id AS binding_event_id FROM public.central_needs_manual_need_events e
    LEFT JOIN public.central_needs_annual_need_bindings b ON b.event_id=e.id
    WHERE e.organization_id=p_organization_id AND e.plan_revision_id=p_plan_revision_id
      AND (p_after_event_id IS NULL OR (e.created_at,e.id)<(at_time,p_after_event_id))
    ORDER BY e.created_at DESC,e.id DESC LIMIT p_limit+1 LOOP
    IF jsonb_array_length(rows)=p_limit THEN next_id:=last_id; EXIT; END IF;
    rows:=rows||jsonb_build_array(jsonb_build_object('id',r.id,'planRevisionId',r.plan_revision_id,
      'beneficiaryOrganizationId',r.beneficiary_organization_id,'centralItemId',r.central_item_id,
      'targetWarehouseId',r.target_warehouse_id,'eventSeq',r.event_seq,'eventKind',r.event_kind,
      'quantityText',r.quantity_text,'approvedUnit',r.approved_unit,'reason',r.reason,'reference',r.reference,
      'actorId',r.actor_id,'createdAt',r.created_at,'actorName',r.actor_name,'fromTrustedProfile',r.binding_event_id IS NOT NULL,
      'annualBinding',phoenix_private.annual_needs_binding_object_v1(r.id))); last_id:=r.id;
  END LOOP;
  RETURN jsonb_build_object('scope',jsonb_build_object('ownerOrgId',p_organization_id,'planningYear',p_planning_year),
    'planRevisionId',p_plan_revision_id,'events',rows,'nextAfterEventId',next_id);
END $$;

-- Preserve the established report signature/ACL and legal quantities, while
-- displaying the field version actually used by bound manual lines.
CREATE OR REPLACE FUNCTION public.phoenix_central_needs_annual_summary(p_organization_id uuid,p_plan_year integer)
RETURNS SETOF jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM public._phoenix_central_needs_guard_v1(p_organization_id,'central_needs.view');
  IF EXISTS(SELECT 1 FROM public.central_needs_plan_revisions r JOIN public.central_needs_plans p ON p.id=r.plan_id
    WHERE p.organization_id=p_organization_id AND p.plan_year=p_plan_year AND r.status='approved'
    GROUP BY p.id HAVING count(*)<>1) THEN RAISE EXCEPTION 'central_needs_lifecycle_state_ambiguous' USING ERRCODE='23514'; END IF;
  RETURN QUERY SELECT jsonb_build_object('dossier_id',p.id,'dossier_name',p.dossier_name,'revision_id',r.id,
    'beneficiary_id',n.beneficiary_organization_id,'item_id',n.central_item_id,
    'name',CASE WHEN bound.snapshot IS NOT NULL THEN bound.snapshot#>>'{fields,scientificName,value}' ELSE i.name END,
    'name_ar',CASE WHEN bound.snapshot IS NOT NULL THEN bound.snapshot#>>'{fields,nameAr,value}' ELSE i.name_ar END,
    'national_code',CASE WHEN bound.snapshot IS NOT NULL THEN bound.snapshot#>>'{fields,nationalCode,value}' ELSE i.national_code END,
    'quantity_text',n.approved_quantity::text,'unit',n.approved_unit,'warehouse_id',n.target_warehouse_id,
    'annual_binding',bound.snapshot,'identity_source',CASE WHEN bound.snapshot IS NULL THEN 'legacy_current_canonical' ELSE 'annual_version' END)
  FROM public.central_needs_plans p JOIN public.central_needs_plan_revisions r ON r.plan_id=p.id AND r.status='approved'
  JOIN public.central_needs_need_lines n ON n.plan_revision_id=r.id JOIN public.central_items i ON i.id=n.central_item_id
  LEFT JOIN LATERAL(SELECT e.id,e.event_kind FROM public.central_needs_manual_need_events e
    WHERE e.plan_revision_id=n.plan_revision_id AND e.beneficiary_organization_id=n.beneficiary_organization_id
      AND e.central_item_id=n.central_item_id AND e.target_warehouse_id IS NOT DISTINCT FROM n.target_warehouse_id
    ORDER BY e.event_seq DESC LIMIT 1) latest ON latest.event_kind<>'void'
  LEFT JOIN LATERAL(SELECT phoenix_private.annual_needs_binding_object_v1(latest.id) AS snapshot) bound ON true
  WHERE p.organization_id=p_organization_id AND p.plan_year=p_plan_year
  ORDER BY p.dossier_key,n.beneficiary_organization_id,n.central_item_id,n.id;
END $$;

-- Search the displayed annual version, including proposed values, without implying legal selectability.
CREATE OR REPLACE FUNCTION public.phoenix_central_needs_search_annual_catalog(
 p_organization_id uuid,p_planning_year integer,p_query text,p_limit integer,p_cursor jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE query_text text:=phoenix_private.annual_catalog_trim_v1(p_query); after_rank integer:=-1; after_id uuid; page record;
  items jsonb:='[]'; next_cursor jsonb; last_id uuid; last_rank integer; count_rows integer:=0;
BEGIN
  PERFORM phoenix_private.annual_catalog_guard_v1(p_organization_id,p_planning_year,false);
  PERFORM phoenix_private.annual_catalog_year_v1(p_organization_id,p_planning_year,false);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 OR query_text IS NULL OR phoenix_private.annual_catalog_utf16_length_v1(query_text)>200 OR query_text ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'annual_catalog_page_invalid' USING ERRCODE='23514';
  END IF;
  IF p_cursor IS NOT NULL THEN
    PERFORM phoenix_private.annual_catalog_object_v1(p_cursor,ARRAY['ownerOrgId','planningYear','query','rank','annualItemId'],
      ARRAY['ownerOrgId','planningYear','query','rank','annualItemId']);
    IF p_cursor->'ownerOrgId' IS DISTINCT FROM to_jsonb(p_organization_id)
      OR p_cursor->'planningYear' IS DISTINCT FROM to_jsonb(p_planning_year)
      OR p_cursor->'query' IS DISTINCT FROM to_jsonb(query_text)
      OR p_cursor->'rank' NOT IN ('0'::jsonb,'1'::jsonb) OR p_cursor->'rank'='null'::jsonb
      OR jsonb_typeof(p_cursor->'annualItemId') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'annual_catalog_cursor_scope_mismatch' USING ERRCODE='23514';
    END IF;
    after_rank:=(p_cursor->>'rank')::integer; after_id:=(p_cursor->>'annualItemId')::uuid;
  END IF;
  FOR page IN
    SELECT * FROM (
      SELECT i.id,CASE WHEN query_text<>'' AND field_values.national_code=query_text THEN 0 ELSE 1 END rank
      FROM public.central_needs_annual_items i JOIN public.central_needs_annual_versions v
        ON (v.organization_id,v.planning_year,v.annual_item_id,v.id)=(i.organization_id,i.planning_year,i.id,i.current_field_version_id)
      CROSS JOIN LATERAL (SELECT
        CASE WHEN v.fields->'scientificName'->>'state'='known' THEN v.fields->'scientificName'->>'value' END scientific_name,
        CASE WHEN v.fields->'nameAr'->>'state'='known' THEN v.fields->'nameAr'->>'value' END name_ar,
        CASE WHEN v.fields->'nationalCode'->>'state'='known' THEN v.fields->'nationalCode'->>'value' END national_code) field_values
      WHERE i.organization_id=p_organization_id AND i.planning_year=p_planning_year
        AND (query_text='' OR position(lower(query_text) IN lower(coalesce(field_values.scientific_name,'')))>0
          OR position(lower(query_text) IN lower(coalesce(field_values.name_ar,'')))>0
          OR position(lower(query_text) IN lower(coalesce(field_values.national_code,'')))>0)
    ) scoped WHERE rank>after_rank OR (rank=after_rank AND id>after_id)
    ORDER BY rank,id LIMIT p_limit+1
  LOOP
    count_rows:=count_rows+1;
    IF count_rows>p_limit THEN
      next_cursor:=jsonb_build_object('ownerOrgId',p_organization_id,'planningYear',p_planning_year,
        'query',query_text,'rank',last_rank,'annualItemId',last_id); EXIT;
    END IF;
    items:=items||jsonb_build_array(phoenix_private.annual_catalog_item_result_v1(p_organization_id,p_planning_year,page.id,NULL));
    last_id:=page.id; last_rank:=page.rank;
  END LOOP;
  RETURN jsonb_build_object('scope',jsonb_build_object('ownerOrgId',p_organization_id,'planningYear',p_planning_year),
    'items',items,'nextCursor',next_cursor);
END $$;

REVOKE ALL ON FUNCTION phoenix_private.annual_needs_flat_fields_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION phoenix_private.annual_needs_validate_fields_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION phoenix_private.annual_needs_legal_differences_v1(jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION phoenix_private.annual_needs_actor_name_v1() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION phoenix_private.annual_needs_capture_version_v1() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION phoenix_private.annual_needs_change_object_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_annual_needs_contract() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_edit_annual_catalog_item(uuid,integer,uuid,uuid,text,jsonb,text,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_list_annual_catalog_changes(uuid,integer,uuid,integer,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_list_annual_material_requests(uuid,integer,integer,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION phoenix_private.annual_needs_reference_v1(uuid,integer,uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION phoenix_private.annual_needs_binding_object_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION phoenix_private.annual_needs_binding_guard_v1() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION phoenix_private.annual_needs_attach_binding_v1(uuid,uuid,integer,uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION phoenix_private.annual_needs_event_fence_v1() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION phoenix_private.annual_needs_capture_carry_v1() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION phoenix_private.annual_needs_readiness_guard_v1() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION phoenix_private.annual_needs_record_receipt_v1(uuid,integer,text,text,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION phoenix_private.annual_needs_write_v1(text,uuid,integer,uuid,uuid,uuid,uuid,text,text,text,uuid,text,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_add_annual_need_line(uuid,integer,uuid,uuid,uuid,uuid,text,text,text,uuid,text,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_correct_annual_need_line(uuid,integer,uuid,uuid,uuid,uuid,text,text,text,uuid,text,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_void_annual_need_line(uuid,integer,uuid,uuid,uuid,uuid,text,text,uuid,text,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_list_annual_need_events(uuid,integer,uuid,integer,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_annual_needs_contract() TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_edit_annual_catalog_item(uuid,integer,uuid,uuid,text,jsonb,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_list_annual_catalog_changes(uuid,integer,uuid,integer,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_list_annual_material_requests(uuid,integer,integer,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_add_annual_need_line(uuid,integer,uuid,uuid,uuid,uuid,text,text,text,uuid,text,uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_correct_annual_need_line(uuid,integer,uuid,uuid,uuid,uuid,text,text,text,uuid,text,uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_void_annual_need_line(uuid,integer,uuid,uuid,uuid,uuid,text,text,uuid,text,uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_list_annual_need_events(uuid,integer,uuid,integer,uuid) TO authenticated;

-- Explicit full A1 capability seal with exact P3-B relation/function additions.
CREATE OR REPLACE FUNCTION phoenix_private.central_needs_capability_breaches_v1()
RETURNS SETOF text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  WITH
  annual_relations(relname) AS (VALUES ('central_needs_catalog_years'), ('central_needs_annual_items'), ('central_needs_annual_versions'), ('central_needs_annual_sources'), ('central_needs_annual_occurrences'), ('central_needs_annual_request_contexts'), ('central_needs_annual_request_resolutions'), ('central_needs_annual_receipts'), ('central_needs_annual_catalog_changes'), ('central_needs_annual_need_bindings')),
  annual_writers(sig) AS (VALUES ('phoenix_private.annual_catalog_capture_v1(uuid,integer,uuid,jsonb)'), ('phoenix_private.annual_catalog_receipt_v1(uuid,integer,text,text,jsonb,jsonb,text,uuid)'), ('phoenix_private.annual_catalog_write_item_v1(uuid,integer,uuid,uuid,uuid,text,jsonb,text)'), ('public.phoenix_central_needs_open_catalog_year(uuid,integer,text)'), ('public.phoenix_central_needs_create_annual_material_request(uuid,integer,jsonb,text)'), ('public.phoenix_central_needs_complete_annual_material_request(uuid,integer,uuid,integer,text,text,text)'), ('phoenix_private.annual_needs_capture_version_v1()'), ('phoenix_private.annual_needs_attach_binding_v1(uuid,uuid,integer,uuid,uuid,uuid,text)'), ('phoenix_private.annual_needs_record_receipt_v1(uuid,integer,text,text,jsonb,jsonb,text)'), ('public.phoenix_central_needs_edit_annual_catalog_item(uuid,integer,uuid,uuid,text,jsonb,text,text)')),
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
           ('central_needs_material_requests'), ('central_needs_material_request_events'), ('central_needs_material_request_links'), ('central_needs_dossier_intakes'), ('central_needs_dossier_documents'), ('central_needs_dossier_receipts'), ('central_needs_catalog_years'), ('central_needs_annual_items'), ('central_needs_annual_versions'), ('central_needs_annual_sources'), ('central_needs_annual_occurrences'), ('central_needs_annual_request_contexts'), ('central_needs_annual_request_resolutions'), ('central_needs_annual_receipts'), ('central_needs_annual_catalog_changes'), ('central_needs_annual_need_bindings')
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
    FROM (VALUES ('phoenix_private.annual_needs_flat_fields_v1(jsonb)'), ('phoenix_private.annual_needs_validate_fields_v1(jsonb)'), ('phoenix_private.annual_needs_legal_differences_v1(jsonb,jsonb)'), ('phoenix_private.annual_needs_actor_name_v1()'), ('phoenix_private.annual_needs_capture_version_v1()'), ('phoenix_private.annual_needs_change_object_v1(uuid)'), ('phoenix_private.annual_needs_reference_v1(uuid,integer,uuid,uuid,uuid,text)'), ('phoenix_private.annual_needs_binding_object_v1(uuid)'), ('phoenix_private.annual_needs_binding_guard_v1()'), ('phoenix_private.annual_needs_attach_binding_v1(uuid,uuid,integer,uuid,uuid,uuid,text)'), ('phoenix_private.annual_needs_event_fence_v1()'), ('phoenix_private.annual_needs_capture_carry_v1()'), ('phoenix_private.annual_needs_readiness_guard_v1()'), ('phoenix_private.annual_needs_record_receipt_v1(uuid,integer,text,text,jsonb,jsonb,text)'), ('phoenix_private.annual_needs_write_v1(text,uuid,integer,uuid,uuid,uuid,uuid,text,text,text,uuid,text,uuid,uuid)'), ('phoenix_private.annual_catalog_trim_v1(text)'), ('phoenix_private.annual_catalog_utf16_length_v1(text)'), ('phoenix_private.annual_catalog_identity_guard_v1()'), ('phoenix_private.annual_catalog_guard_v1(uuid,integer,boolean)'), ('phoenix_private.annual_catalog_year_v1(uuid,integer,boolean)'), ('phoenix_private.annual_catalog_hash_v1(jsonb)'), ('phoenix_private.annual_catalog_canonical_v1(uuid,boolean)'), ('phoenix_private.annual_catalog_missing_v1(jsonb)'), ('phoenix_private.annual_catalog_fields_v1(jsonb,text)'), ('phoenix_private.annual_catalog_reason_v1(text)'), ('phoenix_private.annual_catalog_replay_v1(uuid,integer,text,text,jsonb)'), ('phoenix_private.annual_catalog_receipt_v1(uuid,integer,text,text,jsonb,jsonb,text,uuid)'), ('phoenix_private.annual_catalog_object_v1(jsonb,text[],text[])'), ('phoenix_private.annual_catalog_text_v1(jsonb,integer,boolean)'), ('phoenix_private.annual_catalog_cell_v1(jsonb)'), ('phoenix_private.annual_catalog_observation_v1(jsonb,text,integer)'), ('phoenix_private.annual_catalog_capture_v1(uuid,integer,uuid,jsonb)'), ('phoenix_private.annual_catalog_item_result_v1(uuid,integer,uuid,uuid)'), ('phoenix_private.annual_catalog_write_item_v1(uuid,integer,uuid,uuid,uuid,text,jsonb,text)')) a(sig)
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
$$;

DO $verify$
BEGIN
  IF EXISTS(SELECT 1 FROM phoenix_private.central_needs_capability_breaches_v1()) THEN
    RAISE EXCEPTION 'P3B_verify_failed: capability seal';
  END IF;
END $verify$;
COMMIT;
