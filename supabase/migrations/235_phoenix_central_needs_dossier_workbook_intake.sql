-- LOCAL CANDIDATE ONLY. M235 has not been applied to Production.
-- Human-confirmed manual intake, never a reopening of the frozen Excel pipeline.
BEGIN;
DO $authority_pre$
DECLARE r record; actual text; matches integer;
BEGIN
 FOR r IN SELECT * FROM (VALUES
 ('public.phoenix_central_needs_feature_contract','b7478934ded2998f78a12c31c4de051a'),
 ('phoenix_private.central_needs_capability_breaches_v1','fe56867edf8c15e7c47778b159e9dc42')
 ) expected(name,body_md5) LOOP
  SELECT count(*),min(md5(p.prosrc)) INTO matches,actual FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname=split_part(r.name,'.',1) AND p.proname=split_part(r.name,'.',2);
  IF matches<>1 OR actual IS DISTINCT FROM r.body_md5 THEN RAISE EXCEPTION 'M235_authority_precondition_failed: %',r.name; END IF;
 END LOOP;
 IF to_regprocedure('public.phoenix_central_needs_open_dossier(uuid,integer,text,text)') IS NULL
 OR to_regclass('public.central_needs_dossier_intakes') IS NOT NULL THEN RAISE EXCEPTION 'M235_precondition_failed'; END IF;
END $authority_pre$;

ALTER TABLE public.central_needs_plan_revisions ADD CONSTRAINT central_needs_revision_plan_org_key UNIQUE(id,plan_id,organization_id);
CREATE TABLE public.central_needs_dossier_documents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, plan_id uuid NOT NULL,
 file_hash text NOT NULL CHECK(file_hash ~ '^[0-9a-f]{64}$'),
 original_bytes bytea NOT NULL CHECK(octet_length(original_bytes) BETWEEN 1 AND 3145728),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(plan_id,file_hash), UNIQUE(id,plan_id,organization_id),
 FOREIGN KEY(plan_id,organization_id) REFERENCES public.central_needs_plans(id,organization_id),
 CHECK(encode(sha256(original_bytes),'hex')=file_hash)
);
CREATE TABLE public.central_needs_dossier_intakes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, plan_id uuid NOT NULL,
 plan_revision_id uuid NOT NULL, document_id uuid NOT NULL, operation_id uuid NOT NULL,
 filename text NOT NULL CHECK(char_length(filename) BETWEEN 1 AND 255 AND filename !~ '[/\\[:cntrl:]]' AND filename NOT LIKE '~$%'),
 write_plan jsonb NOT NULL CHECK(jsonb_typeof(write_plan)='array' AND jsonb_array_length(write_plan) BETWEEN 1 AND 10000),
 exclusions jsonb NOT NULL CHECK(jsonb_typeof(exclusions)='array' AND jsonb_array_length(exclusions)<=20000),
 confirmation jsonb NOT NULL CHECK(jsonb_typeof(confirmation)='object'), intent_hash text NOT NULL,
 actor_id uuid NOT NULL REFERENCES auth.users(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(plan_id,operation_id), UNIQUE(id,organization_id),
 FOREIGN KEY(plan_revision_id,plan_id,organization_id) REFERENCES public.central_needs_plan_revisions(id,plan_id,organization_id),
 FOREIGN KEY(document_id,plan_id,organization_id) REFERENCES public.central_needs_dossier_documents(id,plan_id,organization_id)
);
CREATE TABLE public.central_needs_dossier_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, intake_id uuid NOT NULL,
 batch_index integer NOT NULL CHECK(batch_index>=0 AND batch_index<100),
 event_ids uuid[] NOT NULL CHECK(cardinality(event_ids) BETWEEN 1 AND 100),
 actor_id uuid NOT NULL REFERENCES auth.users(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(intake_id,batch_index),
 FOREIGN KEY(intake_id,organization_id) REFERENCES public.central_needs_dossier_intakes(id,organization_id)
);
DO $tables$
DECLARE n text;
BEGIN
 FOREACH n IN ARRAY ARRAY['central_needs_dossier_documents','central_needs_dossier_intakes','central_needs_dossier_receipts'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',n);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',n);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',n);
  EXECUTE format('CREATE POLICY r1_actor_scope_restrictive ON public.%I AS RESTRICTIVE FOR SELECT TO authenticated USING (phoenix_cn_policy.actor_scope_org(''central_needs.view'')=organization_id)',n);
  EXECUTE format('CREATE TRIGGER dossier_evidence_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION phoenix_private.central_needs_append_only_v1()',n);
  EXECUTE format('CREATE TRIGGER dossier_evidence_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION phoenix_private.central_needs_append_only_v1()',n);
 END LOOP;
END $tables$;

CREATE FUNCTION public.phoenix_central_needs_begin_dossier_workbook(
 p_revision_id uuid,p_filename text,p_file_hash text,p_original_base64 text,p_rows jsonb,p_exclusions jsonb,p_confirmation jsonb,p_operation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public.central_needs_plan_revisions%ROWTYPE; p public.central_needs_plans%ROWTYPE;
 old public.central_needs_dossier_intakes%ROWTYPE; doc uuid; source_bytes bytea; intent text; v_entry jsonb; x jsonb; intake uuid;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'manual_requires_read_committed' USING ERRCODE='25000'; END IF;
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE='28000'; END IF;
 SELECT * INTO r FROM public.central_needs_plan_revisions WHERE id=p_revision_id
  AND organization_id=phoenix_cn_policy.actor_scope_org('central_needs.manual_need.set');
 IF NOT FOUND THEN RAISE EXCEPTION 'forbidden_central_needs' USING ERRCODE='42501'; END IF;
 PERFORM public._phoenix_central_needs_guard_v1(r.organization_id,'central_needs.view');
 PERFORM public._phoenix_central_needs_guard_v1(r.organization_id,'central_needs.manual_need.set');
 IF phoenix_cn_policy.excel_read_restriction_state(r.organization_id) IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'manual_intake_not_activated' USING ERRCODE='23514'; END IF;
 p:=phoenix_private.central_needs_lock_plan_id_v1(r.plan_id);
 SELECT * INTO r FROM public.central_needs_plan_revisions WHERE id=p_revision_id;
 IF p.dossier_key='' THEN RAISE EXCEPTION 'named_dossier_required' USING ERRCODE='23514'; END IF;
 IF p_filename IS NULL OR char_length(p_filename) NOT BETWEEN 1 AND 255 OR p_filename ~ '[/\\[:cntrl:]]' OR p_filename LIKE '~$%' OR p_filename !~* '\.(xlsx|xls|csv)$'
 OR p_file_hash IS NULL OR p_file_hash !~ '^[0-9a-f]{64}$' OR p_original_base64 IS NULL OR char_length(p_original_base64)>4194304
 OR p_operation_id IS NULL OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 10000
 OR jsonb_typeof(p_exclusions) IS DISTINCT FROM 'array' OR jsonb_array_length(p_exclusions)>20000 OR octet_length(p_exclusions::text)>2000000
 OR jsonb_typeof(p_confirmation) IS DISTINCT FROM 'object' OR octet_length(p_rows::text)>8000000 OR octet_length(p_confirmation::text)>100000
 OR COALESCE(p_confirmation->>'format','') NOT IN('matrix-v2','legacy-v1') OR p_confirmation->'year_confirmed' IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(p_confirmation->'plan_year') IS DISTINCT FROM 'number' OR p_confirmation->>'plan_year' IS DISTINCT FROM p.plan_year::text THEN
  RAISE EXCEPTION 'dossier_intake_invalid' USING ERRCODE='23514';
 END IF;
 source_bytes:=decode(p_original_base64,'base64');
 IF octet_length(source_bytes) NOT BETWEEN 1 AND 3145728 OR encode(sha256(source_bytes),'hex')<>p_file_hash THEN RAISE EXCEPTION 'dossier_intake_hash_mismatch' USING ERRCODE='23514'; END IF;
 intent:=encode(sha256(convert_to(jsonb_build_array(p_revision_id,p_filename,p_file_hash,p_rows,p_exclusions,p_confirmation)::text,'UTF8')),'hex');
 SELECT * INTO old FROM public.central_needs_dossier_intakes WHERE plan_id=r.plan_id AND operation_id=p_operation_id;
 IF FOUND THEN
  IF old.intent_hash<>intent OR old.actor_id IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'dossier_intake_operation_conflict' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('ok',true,'idempotent_replay',true,'intake_id',old.id,'rows',jsonb_array_length(old.write_plan));
 END IF;
 PERFORM public._phoenix_central_needs_assert_draft_v1(r.id,r.status);
 IF r.source_mode<>'manual' THEN RAISE EXCEPTION 'manual_revision_required' USING ERRCODE='23514'; END IF;
 -- The physical quantity CELL and business scope are distinct immutable claims.
 FOR v_entry IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
  IF jsonb_typeof(v_entry)<>'object' OR (v_entry-ARRAY['sheet','row','quantity_column','name_column','code_column','unit_column','item_id','beneficiary_id','quantity_text','unit','source_unit','source_name','source_code'])<>'{}'::jsonb
   OR jsonb_typeof(v_entry->'quantity_text') IS DISTINCT FROM 'string' OR jsonb_typeof(v_entry->'source_name') IS DISTINCT FROM 'string'
   OR length(v_entry->>'source_name') NOT BETWEEN 1 AND 4000 OR jsonb_typeof(v_entry->'unit') IS DISTINCT FROM 'string'
   OR jsonb_typeof(v_entry->'sheet') IS DISTINCT FROM 'number' OR jsonb_typeof(v_entry->'row') IS DISTINCT FROM 'number' OR COALESCE(v_entry->>'sheet','') !~ '^[0-9]{1,3}$' OR (v_entry->>'sheet')::integer>199
   OR COALESCE(v_entry->>'row','') !~ '^[1-9][0-9]{0,6}$' OR (v_entry->>'row')::integer>1048576 THEN
    RAISE EXCEPTION 'dossier_intake_row_invalid' USING ERRCODE='23514';
  END IF;
  FOREACH x IN ARRAY ARRAY[v_entry->'quantity_column',v_entry->'name_column',v_entry->'unit_column'] LOOP
   IF x IS NULL OR x::text !~ '^[0-9]{1,5}$' OR x::text::integer>16383 THEN RAISE EXCEPTION 'dossier_intake_row_invalid' USING ERRCODE='23514'; END IF;
  END LOOP;
  IF v_entry->>'code_column' IS NOT NULL AND (jsonb_typeof(v_entry->'code_column')<>'number' OR v_entry->>'code_column' !~ '^[0-9]{1,5}$' OR (v_entry->>'code_column')::integer>16383) THEN RAISE EXCEPTION 'dossier_intake_row_invalid' USING ERRCODE='23514'; END IF;
  IF v_entry->>'quantity_column' IN(v_entry->>'name_column',v_entry->>'unit_column',v_entry->>'code_column') OR v_entry->>'name_column'=v_entry->>'unit_column'
   OR (v_entry->>'code_column' IS NOT NULL AND v_entry->>'code_column' IN(v_entry->>'name_column',v_entry->>'unit_column')) THEN RAISE EXCEPTION 'dossier_intake_row_invalid' USING ERRCODE='23514'; END IF;
  IF v_entry->>'source_code' IS NOT NULL AND (jsonb_typeof(v_entry->'source_code')<>'string' OR char_length(v_entry->>'source_code') NOT BETWEEN 1 AND 128 OR v_entry->>'source_code'<>btrim(v_entry->>'source_code')) THEN RAISE EXCEPTION 'national_code_requires_text' USING ERRCODE='23514'; END IF;
  IF lower(btrim(COALESCE(v_entry->>'source_unit',v_entry->>'unit'))) IS DISTINCT FROM lower(v_entry->>'unit') THEN RAISE EXCEPTION 'manual_line_unit_mismatch' USING ERRCODE='23514'; END IF;
  PERFORM phoenix_private.central_needs_manual_quantity_v1(v_entry->>'quantity_text');
  PERFORM phoenix_private.central_needs_manual_scope_v1((v_entry->>'beneficiary_id')::uuid,(v_entry->>'item_id')::uuid,NULL);
  IF NOT EXISTS(SELECT 1 FROM public.central_items WHERE id=(v_entry->>'item_id')::uuid AND status='active' AND unit=v_entry->>'unit') THEN RAISE EXCEPTION 'manual_line_unit_mismatch' USING ERRCODE='23514'; END IF;
  IF v_entry->>'source_code' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.central_items WHERE id=(v_entry->>'item_id')::uuid AND national_code=v_entry->>'source_code') THEN RAISE EXCEPTION 'national_code_assignment_conflict' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows)e GROUP BY e->>'sheet',e->>'row',e->>'quantity_column' HAVING count(*)>1)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows)e GROUP BY e->>'beneficiary_id',e->>'item_id' HAVING count(*)>1) THEN RAISE EXCEPTION 'dossier_duplicate_selection' USING ERRCODE='23505'; END IF;
 FOR v_entry IN SELECT value FROM jsonb_array_elements(p_exclusions) LOOP
  IF jsonb_typeof(v_entry)<>'object' OR (v_entry-ARRAY['sheet','row','quantity_column','reason'])<>'{}'::jsonb
   OR jsonb_typeof(v_entry->'sheet') IS DISTINCT FROM 'number' OR jsonb_typeof(v_entry->'row') IS DISTINCT FROM 'number' OR COALESCE(v_entry->>'sheet','') !~ '^[0-9]{1,3}$' OR (v_entry->>'sheet')::integer>199
   OR COALESCE(v_entry->>'row','') !~ '^[1-9][0-9]{0,6}$' OR (v_entry->>'row')::integer>1048576
   OR jsonb_typeof(v_entry->'quantity_column') IS DISTINCT FROM 'number' OR COALESCE(v_entry->>'quantity_column','') !~ '^[0-9]{1,5}$' OR (v_entry->>'quantity_column')::integer>16383
   OR jsonb_typeof(v_entry->'reason') IS DISTINCT FROM 'string' OR length(btrim(v_entry->>'reason')) NOT BETWEEN 3 AND 500 THEN RAISE EXCEPTION 'dossier_exclusion_invalid' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM (SELECT value e FROM jsonb_array_elements(p_rows) UNION ALL SELECT value FROM jsonb_array_elements(p_exclusions))cells
 GROUP BY e->>'sheet',e->>'row',e->>'quantity_column' HAVING count(*)>1) THEN RAISE EXCEPTION 'dossier_duplicate_selection' USING ERRCODE='23505'; END IF;
 SELECT id INTO doc FROM public.central_needs_dossier_documents WHERE plan_id=r.plan_id AND file_hash=p_file_hash;
 -- The plan lock serializes reservations against all simultaneous captures.
 IF EXISTS(SELECT 1 FROM public.central_needs_dossier_intakes oldi CROSS JOIN LATERAL jsonb_array_elements(oldi.write_plan)o
 CROSS JOIN jsonb_array_elements(p_rows)n WHERE oldi.plan_revision_id=r.id AND
 ((oldi.document_id=doc AND o->>'sheet'=n->>'sheet' AND o->>'row'=n->>'row' AND o->>'quantity_column'=n->>'quantity_column')
 OR (o->>'beneficiary_id'=n->>'beneficiary_id' AND o->>'item_id'=n->>'item_id'))) THEN RAISE EXCEPTION 'dossier_duplicate_selection' USING ERRCODE='23505'; END IF;
 -- Refuse an already-entered/carried scope before creating a pending capture.
 -- Import never silently corrects or revives an existing canonical event chain.
 IF EXISTS(SELECT 1 FROM public.central_needs_manual_need_events m CROSS JOIN jsonb_array_elements(p_rows)n
  WHERE m.plan_revision_id=r.id AND m.target_warehouse_id IS NULL
   AND m.beneficiary_organization_id=(n->>'beneficiary_id')::uuid AND m.central_item_id=(n->>'item_id')::uuid) THEN
  RAISE EXCEPTION 'dossier_existing_manual_scope' USING ERRCODE='23505';
 END IF;
 IF doc IS NULL THEN INSERT INTO public.central_needs_dossier_documents(organization_id,plan_id,file_hash,original_bytes)
  VALUES(r.organization_id,r.plan_id,p_file_hash,source_bytes) RETURNING id INTO doc; END IF;
 INSERT INTO public.central_needs_dossier_intakes(organization_id,plan_id,plan_revision_id,document_id,operation_id,filename,write_plan,exclusions,confirmation,intent_hash,actor_id)
 VALUES(r.organization_id,r.plan_id,r.id,doc,p_operation_id,p_filename,p_rows,p_exclusions,p_confirmation,intent,auth.uid()) RETURNING id INTO intake;
 INSERT INTO public.audit_logs(organization_id,actor_id,actor_role,action,entity_type,entity_id,payload)
 VALUES(r.organization_id,auth.uid(),public._phoenix_central_needs_guard_v1(r.organization_id,'central_needs.manual_need.set'),
 'central_needs.dossier.workbook_capture','central_needs_dossier_intake',intake,jsonb_build_object('rows',jsonb_array_length(p_rows),'file_hash',p_file_hash,'source_authority','human_confirmed'));
 RETURN jsonb_build_object('ok',true,'idempotent_replay',false,'intake_id',intake,'rows',jsonb_array_length(p_rows));
END $$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_begin_dossier_workbook(uuid,text,text,text,jsonb,jsonb,jsonb,uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_begin_dossier_workbook(uuid,text,text,text,jsonb,jsonb,jsonb,uuid) TO authenticated;

CREATE FUNCTION public.phoenix_central_needs_apply_dossier_workbook_batch(p_intake_id uuid,p_offset integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE s public.central_needs_dossier_intakes%ROWTYPE; r public.central_needs_plan_revisions%ROWTYPE; e jsonb; result jsonb;
 ids uuid[]:=ARRAY[]::uuid[]; old_ids uuid[]; done integer; total integer; i integer;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'manual_requires_read_committed' USING ERRCODE='25000'; END IF;
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE='28000'; END IF;
 SELECT * INTO s FROM public.central_needs_dossier_intakes WHERE id=p_intake_id
  AND organization_id=phoenix_cn_policy.actor_scope_org('central_needs.manual_need.set');
 IF NOT FOUND THEN RAISE EXCEPTION 'forbidden_central_needs' USING ERRCODE='42501'; END IF;
 PERFORM public._phoenix_central_needs_guard_v1(s.organization_id,'central_needs.view');
 PERFORM public._phoenix_central_needs_guard_v1(s.organization_id,'central_needs.manual_need.set');
 IF phoenix_cn_policy.excel_read_restriction_state(s.organization_id) IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'manual_intake_not_activated' USING ERRCODE='23514'; END IF;
 IF auth.uid() IS DISTINCT FROM s.actor_id THEN RAISE EXCEPTION 'forbidden_central_needs' USING ERRCODE='42501'; END IF;
 PERFORM phoenix_private.central_needs_lock_plan_id_v1(s.plan_id);
 total:=jsonb_array_length(s.write_plan);
 IF p_offset IS NULL OR p_offset<0 OR p_offset>=total OR p_offset%100<>0 THEN RAISE EXCEPTION 'dossier_batch_offset_invalid' USING ERRCODE='23514'; END IF;
 SELECT event_ids INTO old_ids FROM public.central_needs_dossier_receipts WHERE intake_id=s.id AND batch_index=p_offset/100;
 IF FOUND THEN RETURN jsonb_build_object('ok',true,'idempotent_replay',true,'intake_id',s.id,'offset',p_offset,'rows',cardinality(old_ids),'complete',
  (SELECT coalesce(sum(cardinality(event_ids)),0) FROM public.central_needs_dossier_receipts WHERE intake_id=s.id)=total); END IF;
 SELECT coalesce(sum(cardinality(event_ids)),0)::integer INTO done FROM public.central_needs_dossier_receipts WHERE intake_id=s.id;
 IF p_offset<>done THEN RAISE EXCEPTION 'dossier_batch_out_of_order' USING ERRCODE='23514'; END IF;
 SELECT * INTO r FROM public.central_needs_plan_revisions WHERE id=s.plan_revision_id;
 PERFORM public._phoenix_central_needs_assert_draft_v1(r.id,r.status);
 FOR i IN p_offset..LEAST(p_offset+99,total-1) LOOP
  e:=s.write_plan->i;
  PERFORM 1 FROM public.central_items WHERE id=(e->>'item_id')::uuid FOR SHARE;
  IF NOT EXISTS(SELECT 1 FROM public.central_items WHERE id=(e->>'item_id')::uuid AND status='active' AND unit=e->>'unit'
   AND (e->>'source_code' IS NULL OR national_code=e->>'source_code')) THEN RAISE EXCEPTION 'manual_line_unit_or_code_mismatch' USING ERRCODE='23514'; END IF;
  result:=public.phoenix_central_needs_add_manual_need_line(r.id,(e->>'beneficiary_id')::uuid,(e->>'item_id')::uuid,NULL,e->>'quantity_text',
   'Human-confirmed workbook cell','intake:'||s.id::text||':'||i::text,NULL,'workbook:'||(SELECT file_hash FROM public.central_needs_dossier_documents WHERE id=s.document_id));
  IF result->>'event_id' IS NULL THEN RAISE EXCEPTION 'dossier_event_not_confirmed' USING ERRCODE='23514'; END IF;
  ids:=array_append(ids,(result->>'event_id')::uuid);
 END LOOP;
 INSERT INTO public.central_needs_dossier_receipts(organization_id,intake_id,batch_index,event_ids,actor_id)
 VALUES(s.organization_id,s.id,p_offset/100,ids,auth.uid());
 INSERT INTO public.audit_logs(organization_id,actor_id,actor_role,action,entity_type,entity_id,payload)
 VALUES(s.organization_id,auth.uid(),public._phoenix_central_needs_guard_v1(s.organization_id,'central_needs.manual_need.set'),
 'central_needs.dossier.workbook_batch','central_needs_dossier_intake',s.id,jsonb_build_object('offset',p_offset,'rows',cardinality(ids)));
 RETURN jsonb_build_object('ok',true,'idempotent_replay',false,'intake_id',s.id,'offset',p_offset,'rows',cardinality(ids),'complete',done+cardinality(ids)=total);
END $$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_apply_dossier_workbook_batch(uuid,integer) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_apply_dossier_workbook_batch(uuid,integer) TO authenticated;

-- Old <=100-row clients remain atomic and preserve their exact captured plan.
CREATE FUNCTION public.phoenix_central_needs_import_dossier_workbook(p_revision_id uuid,p_filename text,p_file_hash text,p_original_base64 text,p_rows jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE capture jsonb; batch jsonb; y integer; op uuid;
BEGIN
 IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'dossier_intake_invalid' USING ERRCODE='23514'; END IF;
 SELECT p.plan_year INTO y FROM public.central_needs_plans p JOIN public.central_needs_plan_revisions r ON r.plan_id=p.id WHERE r.id=p_revision_id;
 op:=md5(jsonb_build_array(p_revision_id,p_filename,p_file_hash,p_rows,auth.uid())::text)::uuid;
 capture:=public.phoenix_central_needs_begin_dossier_workbook(p_revision_id,p_filename,p_file_hash,p_original_base64,p_rows,'[]'::jsonb,jsonb_build_object('format','legacy-v1','plan_year',y,'year_confirmed',true),op);
 batch:=public.phoenix_central_needs_apply_dossier_workbook_batch((capture->>'intake_id')::uuid,0);
 RETURN capture||jsonb_build_object('complete',true,'idempotent_replay',(capture->>'idempotent_replay')::boolean AND (batch->>'idempotent_replay')::boolean);
END $$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_import_dossier_workbook(uuid,text,text,text,jsonb) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_import_dossier_workbook(uuid,text,text,text,jsonb) TO authenticated;

CREATE FUNCTION public.phoenix_central_needs_dossier_sources(p_plan_id uuid)
RETURNS SETOF jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE org uuid;
BEGIN
 SELECT organization_id INTO org FROM public.central_needs_plans WHERE id=p_plan_id AND organization_id=phoenix_cn_policy.actor_scope_org('central_needs.view');
 IF NOT FOUND THEN RAISE EXCEPTION 'forbidden_central_needs' USING ERRCODE='42501'; END IF;
 PERFORM public._phoenix_central_needs_guard_v1(org,'central_needs.view');
 RETURN QUERY SELECT jsonb_build_object('id',s.id,'filename',s.filename,'file_hash',d.file_hash,'revision_id',s.plan_revision_id,'operation_id',s.operation_id,
 'rows',jsonb_array_length(s.write_plan),'applied_rows',coalesce((SELECT sum(cardinality(b.event_ids)) FROM public.central_needs_dossier_receipts b WHERE b.intake_id=s.id),0),
 'actor_id',s.actor_id,'can_resume',s.actor_id=auth.uid(),'created_at',s.created_at)
 FROM public.central_needs_dossier_intakes s JOIN public.central_needs_dossier_documents d ON d.id=s.document_id WHERE s.plan_id=p_plan_id ORDER BY s.created_at,s.id;
END $$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_dossier_sources(uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_dossier_sources(uuid) TO authenticated;

CREATE FUNCTION public.phoenix_central_needs_download_dossier_source(p_intake_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE s public.central_needs_dossier_intakes%ROWTYPE; d public.central_needs_dossier_documents%ROWTYPE;
BEGIN
 SELECT * INTO s FROM public.central_needs_dossier_intakes WHERE id=p_intake_id AND organization_id=phoenix_cn_policy.actor_scope_org('central_needs.view');
 IF NOT FOUND THEN RAISE EXCEPTION 'forbidden_central_needs' USING ERRCODE='42501'; END IF;
 PERFORM public._phoenix_central_needs_guard_v1(s.organization_id,'central_needs.view');
 SELECT * INTO d FROM public.central_needs_dossier_documents WHERE id=s.document_id;
 RETURN jsonb_build_object('filename',s.filename,'file_hash',d.file_hash,'base64',encode(d.original_bytes,'base64'),'write_plan',s.write_plan,
 'exclusions',s.exclusions,'confirmation',s.confirmation,'event_ids',COALESCE((SELECT jsonb_agg(e ORDER BY b.batch_index,n) FROM public.central_needs_dossier_receipts b CROSS JOIN LATERAL unnest(b.event_ids) WITH ORDINALITY es(e,n) WHERE b.intake_id=s.id),'[]'::jsonb),'source_authority','human_confirmed');
END $$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_download_dossier_source(uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_download_dossier_source(uuid) TO authenticated;

CREATE FUNCTION phoenix_private.central_needs_dossier_intake_fence_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF NEW.status IN('submitted','approved') AND NEW.status IS DISTINCT FROM OLD.status AND EXISTS(
  SELECT 1 FROM public.central_needs_dossier_intakes s WHERE s.plan_revision_id=NEW.id AND jsonb_array_length(s.write_plan)<>
  (SELECT coalesce(sum(cardinality(b.event_ids)),0) FROM public.central_needs_dossier_receipts b WHERE b.intake_id=s.id)) THEN
  RAISE EXCEPTION 'dossier_intake_incomplete' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION phoenix_private.central_needs_dossier_intake_fence_v1() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER r1_dossier_intake_completion BEFORE UPDATE OF status ON public.central_needs_plan_revisions FOR EACH ROW
 EXECUTE FUNCTION phoenix_private.central_needs_dossier_intake_fence_v1();
CREATE OR REPLACE FUNCTION public.phoenix_central_needs_feature_contract() RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('national_code',true,'same_actor_manual',true,'dossiers',true,'workbook_intake',true,'workbook_matrix_v2',true)
$$;

CREATE OR REPLACE FUNCTION phoenix_private.central_needs_capability_breaches_v1()
RETURNS SETOF text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  WITH
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
           ('central_needs_material_requests'), ('central_needs_material_request_events'), ('central_needs_material_request_links'), ('central_needs_dossier_intakes'), ('central_needs_dossier_documents'), ('central_needs_dossier_receipts')
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
  IF EXISTS (SELECT 1 FROM phoenix_private.central_needs_capability_breaches_v1()) THEN
    RAISE EXCEPTION 'central_needs_capability_seal_breached';
  END IF;
END $verify$;
COMMIT;
