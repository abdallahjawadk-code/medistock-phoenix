-- P1: pending workbook/manual scope reservation. UNNUMBERED CANDIDATE.
-- Target: exact M234/M235 bodies below. Apply only to a verified target.
-- Historical migrations 001..235 are unchanged; no production application is claimed.
-- The public signature and every pre-existing authorization/replay/lock stay intact.
-- No new API bypass flag, table, data rewrite, dependency, or feature activation.
BEGIN;
SET LOCAL search_path = pg_catalog, pg_temp;
DO $pre$
DECLARE r record; actual text;
BEGIN
  IF to_regprocedure('phoenix_private.central_needs_add_manual_need_line_reserved_v1(boolean,uuid,uuid,uuid,uuid,text,text,text,uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'P1_precondition_failed: reservation implementation already exists';
  END IF;
  FOR r IN SELECT * FROM (VALUES
    ('public.phoenix_central_needs_add_manual_need_line(uuid,uuid,uuid,uuid,text,text,text,uuid,text)','23021b47830f2732d89f6ad0793f13f7'),
    ('public.phoenix_central_needs_apply_dossier_workbook_batch(uuid,integer)','5b1cf7e166971c032ec8e1e1a4e33416'),
    ('public.phoenix_central_needs_begin_dossier_workbook(uuid,text,text,text,jsonb,jsonb,jsonb,uuid)','ebc8d650870083733ff984a6ebadfa73'),
    ('public.phoenix_central_needs_carry_forward_manual_lines(uuid,uuid)','ea1edac9743d1a092b5a7c228831af6a'),
    ('public.phoenix_central_needs_correct_manual_need_line(uuid,uuid,uuid,uuid,text,text,text,uuid,text)','147e76ea9d5b4b75c6a4ff2fb7c22ab8'),
    ('public.phoenix_central_needs_void_manual_need_line(uuid,uuid,uuid,uuid,text,text,uuid,text)','9ca01f5e013e6074c9521873c82de52b'),
    ('phoenix_private.central_needs_capability_breaches_v1()','4af7f46388a2f90524e420d21b18ce47')) expected(sig, body_md5) LOOP
    SELECT md5(prosrc) INTO actual FROM pg_proc WHERE oid = to_regprocedure(r.sig);
    IF actual IS DISTINCT FROM r.body_md5 THEN
      RAISE EXCEPTION 'P1_precondition_failed: body drift %', r.sig;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM phoenix_private.central_needs_capability_breaches_v1()) THEN
    RAISE EXCEPTION 'P1_precondition_failed: capability seal';
  END IF;
END $pre$;

CREATE FUNCTION phoenix_private.central_needs_add_manual_need_line_reserved_v1(
  p_workbook_batch boolean,
  p_plan_revision_id uuid, p_beneficiary_organization_id uuid, p_central_item_id uuid, p_target_warehouse_id uuid,
  p_quantity_text text, p_reason text, p_idempotency_key text, p_expected_last_event_id uuid DEFAULT NULL, p_reference text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor  uuid := auth.uid();
  v_role   text;
  v_org    uuid;
  v_year   integer;
  v_rev    public.central_needs_plan_revisions%ROWTYPE;
  v_qty    text;
  v_reason text := public._phoenix_central_needs_human_text_v1(p_reason);
  v_ref    text := public._phoenix_central_needs_human_text_v1(p_reference);
  v_unit   text;
  v_prior  public.central_needs_manual_need_events%ROWTYPE;
  v_last   public.central_needs_manual_need_events%ROWTYPE;
  v_line   uuid := gen_random_uuid();
  v_event  uuid;
  v_seq    integer;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'manual_requires_read_committed' USING ERRCODE = '25000';
  END IF;
  v_qty := phoenix_private.central_needs_manual_quantity_v1(p_quantity_text);
  IF v_reason IS NULL OR char_length(v_reason) > 2000 THEN RAISE EXCEPTION 'manual_reason_required' USING ERRCODE = '23514'; END IF;
  IF v_ref IS NOT NULL AND char_length(v_ref) > 200 THEN RAISE EXCEPTION 'manual_reference_too_long' USING ERRCODE = '23514'; END IF;
  IF p_idempotency_key IS NULL OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 128 THEN
    RAISE EXCEPTION 'manual_idempotency_key_invalid' USING ERRCODE = '23514';
  END IF;
  SELECT r1.organization_id, p.plan_year INTO v_org, v_year
    FROM public.central_needs_plan_revisions r1 JOIN public.central_needs_plans p ON p.id = r1.plan_id WHERE r1.id = p_plan_revision_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'plan_revision_not_found' USING ERRCODE = 'P0002'; END IF;
  v_role := public._phoenix_central_needs_guard_v1(v_org, 'central_needs.manual_need.set');

  PERFORM phoenix_private.central_needs_lock_plan_id_v1(
    (SELECT plan_id FROM public.central_needs_plan_revisions WHERE id = p_plan_revision_id));
  v_rev := public._phoenix_central_needs_load_revision_v1(p_plan_revision_id);

  -- replay check precedes the stale fence and assert_draft (C11)
  SELECT * INTO v_prior FROM public.central_needs_manual_need_events WHERE plan_id = v_rev.plan_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_prior.event_kind = 'add' AND v_prior.plan_revision_id = p_plan_revision_id
       AND v_prior.beneficiary_organization_id = p_beneficiary_organization_id AND v_prior.central_item_id = p_central_item_id
       AND v_prior.target_warehouse_id IS NOT DISTINCT FROM p_target_warehouse_id AND v_prior.quantity_text = v_qty
       AND v_prior.reason = v_reason AND v_prior.reference IS NOT DISTINCT FROM v_ref THEN
      RETURN jsonb_build_object('ok', true, 'idempotent_replay', true, 'event_id', v_prior.id, 'event_seq', v_prior.event_seq,
        'need_line_id', v_prior.need_line_id, 'event_kind', v_prior.event_kind, 'quantity_text', v_prior.quantity_text);
    END IF;
    RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = '23505', DETAIL = format('key=%s', p_idempotency_key);
  END IF;

  PERFORM public._phoenix_central_needs_assert_draft_v1(p_plan_revision_id, v_rev.status);
  IF v_rev.source_mode <> 'manual' THEN
    RAISE EXCEPTION 'manual_revision_required' USING ERRCODE = '23514', DETAIL = format('revision=%s', v_rev.id);
  END IF;
  v_unit := phoenix_private.central_needs_manual_scope_v1(p_beneficiary_organization_id, p_central_item_id, p_target_warehouse_id);

  -- Only the sealed batch entry point may consume its immutable reservation.
  -- Replay above stays available after a response loss or a lifecycle change.
  -- A receipt releases precisely its 100-row batch, never another pending cell.
  -- Workbook rows reserve institution totals, which exclude warehouse splits too (M225).
  IF p_workbook_batch IS NOT TRUE AND EXISTS (
    SELECT 1
      FROM public.central_needs_dossier_intakes intake
      CROSS JOIN LATERAL jsonb_array_elements(intake.write_plan)
        WITH ORDINALITY AS selected(entry, row_ordinal)
     WHERE intake.organization_id = v_org AND intake.plan_revision_id = p_plan_revision_id
       AND (selected.entry->>'beneficiary_id')::uuid = p_beneficiary_organization_id
       AND (selected.entry->>'item_id')::uuid = p_central_item_id
       AND NOT EXISTS (
         SELECT 1 FROM public.central_needs_dossier_receipts receipt
          WHERE receipt.intake_id = intake.id
            AND receipt.batch_index = (selected.row_ordinal - 1) / 100)
  ) THEN
    RAISE EXCEPTION 'dossier_pending_workbook_scope' USING ERRCODE = '23505';
  END IF;

  -- Internal receipt keys belong to the batch writer, even for other materials.
  -- A matching historical replay above is still a read, not a new key claim.
  IF p_workbook_batch IS NOT TRUE AND p_idempotency_key LIKE 'intake:%' THEN
    RAISE EXCEPTION 'manual_idempotency_key_reserved' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_last FROM public.central_needs_manual_need_events e
   WHERE e.plan_revision_id = p_plan_revision_id AND e.beneficiary_organization_id = p_beneficiary_organization_id
     AND e.central_item_id = p_central_item_id AND e.target_warehouse_id IS NOT DISTINCT FROM p_target_warehouse_id
   ORDER BY e.event_seq DESC LIMIT 1;
  IF FOUND THEN
    IF p_expected_last_event_id IS DISTINCT FROM v_last.id THEN
      RAISE EXCEPTION 'manual_need_line_stale' USING ERRCODE = '23514', DETAIL = format('last=%s', v_last.id);
    END IF;
    IF v_last.event_kind <> 'void' THEN
      RAISE EXCEPTION 'manual_need_line_already_live' USING ERRCODE = '23514', DETAIL = format('last=%s', v_last.id);
    END IF;
  ELSIF p_expected_last_event_id IS NOT NULL THEN
    RAISE EXCEPTION 'manual_need_line_stale' USING ERRCODE = '23514', DETAIL = 'no event exists for this line';
  END IF;
  v_seq := COALESCE(v_last.event_seq, 0) + 1;

  -- EVENT FIRST, then the projection (the BEFORE trigger needs the event)
  INSERT INTO public.central_needs_manual_need_events (
    organization_id, plan_id, plan_revision_id, beneficiary_organization_id, central_item_id, target_warehouse_id,
    event_seq, event_kind, quantity_text, approved_unit, supersedes_event_id, reason, reference, actor_id, actor_role, idempotency_key, need_line_id)
  VALUES (v_org, v_rev.plan_id, p_plan_revision_id, p_beneficiary_organization_id, p_central_item_id, p_target_warehouse_id,
    v_seq, 'add', v_qty, v_unit, v_last.id, v_reason, v_ref, v_actor, v_role, p_idempotency_key, v_line)
  RETURNING id INTO v_event;
  INSERT INTO public.central_needs_need_lines (
    id, plan_revision_id, organization_id, beneficiary_organization_id, target_warehouse_id, central_item_id,
    approved_quantity, approved_unit, unit_conversion_state, mapping_reason, mapped_by)
  VALUES (v_line, p_plan_revision_id, v_org, p_beneficiary_organization_id, p_target_warehouse_id, p_central_item_id,
    v_qty::numeric, v_unit, 'canonical', v_reason, v_actor);

  INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (v_org, v_actor, v_role, 'central_needs.manual_need.add', 'central_needs_plan_revision', p_plan_revision_id, format('event %s', v_seq),
          jsonb_build_object('event_id', v_event, 'beneficiary_organization_id', p_beneficiary_organization_id, 'central_item_id', p_central_item_id,
            'target_warehouse_id', p_target_warehouse_id, 'quantity_before', NULL, 'quantity_after', v_qty, 'reason', v_reason));

  RETURN jsonb_build_object('ok', true, 'idempotent_replay', false, 'event_id', v_event, 'event_seq', v_seq,
    'need_line_id', v_line, 'event_kind', 'add', 'quantity_text', v_qty);
END;
$$;
REVOKE ALL ON FUNCTION phoenix_private.central_needs_add_manual_need_line_reserved_v1(boolean,uuid,uuid,uuid,uuid,text,text,text,uuid,text) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.phoenix_central_needs_add_manual_need_line(
  p_plan_revision_id uuid, p_beneficiary_organization_id uuid, p_central_item_id uuid, p_target_warehouse_id uuid,
  p_quantity_text text, p_reason text, p_idempotency_key text, p_expected_last_event_id uuid DEFAULT NULL, p_reference text DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT phoenix_private.central_needs_add_manual_need_line_reserved_v1(
    false, p_plan_revision_id, p_beneficiary_organization_id, p_central_item_id, p_target_warehouse_id,
    p_quantity_text, p_reason, p_idempotency_key, p_expected_last_event_id, p_reference);
$$;

CREATE OR REPLACE FUNCTION public.phoenix_central_needs_apply_dossier_workbook_batch(p_intake_id uuid,p_offset integer)
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
  result:=phoenix_private.central_needs_add_manual_need_line_reserved_v1(true,r.id,(e->>'beneficiary_id')::uuid,(e->>'item_id')::uuid,NULL,e->>'quantity_text',
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

CREATE OR REPLACE FUNCTION public.phoenix_central_needs_begin_dossier_workbook(
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
   AND m.beneficiary_organization_id=(n->>'beneficiary_id')::uuid AND m.central_item_id=(n->>'item_id')::uuid)
 -- The institution total cannot coexist with a live warehouse split (M225).
 OR EXISTS(SELECT 1 FROM public.central_needs_need_lines l CROSS JOIN jsonb_array_elements(p_rows)n
  WHERE l.plan_revision_id=r.id AND l.target_warehouse_id IS NOT NULL
   AND l.beneficiary_organization_id=(n->>'beneficiary_id')::uuid AND l.central_item_id=(n->>'item_id')::uuid) THEN
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

CREATE OR REPLACE FUNCTION public.phoenix_central_needs_carry_forward_manual_lines(p_plan_revision_id uuid, p_expected_source_revision_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor  uuid := auth.uid();
  v_role   text;
  v_org    uuid;
  v_year   integer;
  v_rev    public.central_needs_plan_revisions%ROWTYPE;
  v_src    public.central_needs_plan_revisions%ROWTYPE;
  v_n      integer := 0;
  v_existing integer;
  r        record;
  v_line   uuid;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'manual_requires_read_committed' USING ERRCODE = '25000';
  END IF;
  IF p_plan_revision_id IS NULL OR p_expected_source_revision_id IS NULL THEN
    RAISE EXCEPTION 'manual_carry_arguments_required' USING ERRCODE = '23514';
  END IF;
  SELECT r1.organization_id, p.plan_year INTO v_org, v_year
    FROM public.central_needs_plan_revisions r1 JOIN public.central_needs_plans p ON p.id = r1.plan_id
   WHERE r1.id = p_plan_revision_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'plan_revision_not_found' USING ERRCODE = 'P0002'; END IF;
  v_role := public._phoenix_central_needs_guard_v1(v_org, 'central_needs.edit');

  PERFORM phoenix_private.central_needs_lock_plan_id_v1(
    (SELECT plan_id FROM public.central_needs_plan_revisions WHERE id = p_plan_revision_id));
  v_rev := public._phoenix_central_needs_load_revision_v1(p_plan_revision_id);
  PERFORM public._phoenix_central_needs_assert_draft_v1(p_plan_revision_id, v_rev.status);
  IF v_rev.source_mode <> 'manual' THEN
    RAISE EXCEPTION 'manual_revision_required' USING ERRCODE = '23514', DETAIL = format('revision=%s', v_rev.id);
  END IF;

  SELECT count(*) INTO v_existing FROM public.central_needs_manual_need_events WHERE plan_revision_id = p_plan_revision_id;
  IF v_existing > 0 THEN
    IF EXISTS (SELECT 1 FROM public.central_needs_manual_need_events e
                 JOIN public.central_needs_manual_need_events c ON c.id = e.carried_from_event_id
                WHERE e.plan_revision_id = p_plan_revision_id AND e.event_kind = 'carried_forward' AND c.plan_revision_id = p_expected_source_revision_id)
       AND NOT EXISTS (SELECT 1 FROM public.central_needs_manual_need_events e WHERE e.plan_revision_id = p_plan_revision_id AND e.event_kind <> 'carried_forward' AND e.event_seq = 1) THEN
      RETURN jsonb_build_object('ok', true, 'idempotent_replay', true, 'plan_revision_id', p_plan_revision_id,
        'source_revision_id', p_expected_source_revision_id,
        'carried_count', (SELECT count(*) FROM public.central_needs_manual_need_events WHERE plan_revision_id = p_plan_revision_id AND event_kind = 'carried_forward'));
    END IF;
    RAISE EXCEPTION 'manual_carry_requires_empty_revision' USING ERRCODE = '23514', DETAIL = format('revision=%s events=%s', p_plan_revision_id, v_existing);
  END IF;

  -- the source must be the plan's single approved MANUAL revision and equal the expected one
  SELECT * INTO v_src FROM public.central_needs_plan_revisions
   WHERE plan_id = v_rev.plan_id AND status = 'approved' AND id <> p_plan_revision_id;
  IF NOT FOUND OR v_src.id <> p_expected_source_revision_id THEN
    RAISE EXCEPTION 'manual_carry_source_stale' USING ERRCODE = '23514', DETAIL = format('expected=%s', p_expected_source_revision_id);
  END IF;
  IF v_src.source_mode <> 'manual' THEN
    RAISE EXCEPTION 'manual_carry_source_not_manual' USING ERRCODE = '23514',
      DETAIL = format('source=%s source_mode=%s', v_src.id, v_src.source_mode),
      HINT = 'Excel quantities are never carried into a manual revision (D27).';
  END IF;

  -- Carry-forward is a second canonical writer. It must respect captures even
  -- when a caller opened this named correction through the generic manual RPC.
  -- Refuse the whole carry before any event; never skip or replace source lines.
  IF EXISTS (
    SELECT 1 FROM public.central_needs_manual_need_events source
      JOIN public.central_needs_dossier_intakes intake ON intake.plan_revision_id = p_plan_revision_id
      CROSS JOIN LATERAL jsonb_array_elements(intake.write_plan)
        WITH ORDINALITY AS selected(entry, row_ordinal)
     WHERE source.plan_revision_id = v_src.id AND source.event_kind <> 'void'
       AND source.event_seq = (
         SELECT max(latest.event_seq) FROM public.central_needs_manual_need_events latest
          WHERE latest.plan_revision_id = source.plan_revision_id
            AND latest.beneficiary_organization_id = source.beneficiary_organization_id
            AND latest.central_item_id = source.central_item_id
            AND latest.target_warehouse_id IS NOT DISTINCT FROM source.target_warehouse_id)
       AND (selected.entry->>'beneficiary_id')::uuid = source.beneficiary_organization_id
       AND (selected.entry->>'item_id')::uuid = source.central_item_id
       AND NOT EXISTS (
         SELECT 1 FROM public.central_needs_dossier_receipts receipt
          WHERE receipt.intake_id = intake.id
            AND receipt.batch_index = (selected.row_ordinal - 1) / 100)
  ) THEN
    RAISE EXCEPTION 'dossier_pending_workbook_scope' USING ERRCODE = '23505';
  END IF;

  FOR r IN
    SELECT e.* FROM public.central_needs_manual_need_events e
     WHERE e.plan_revision_id = v_src.id
       AND e.event_seq = (SELECT max(e2.event_seq) FROM public.central_needs_manual_need_events e2
                           WHERE e2.plan_revision_id = e.plan_revision_id AND e2.beneficiary_organization_id = e.beneficiary_organization_id
                             AND e2.central_item_id = e.central_item_id AND e2.target_warehouse_id IS NOT DISTINCT FROM e.target_warehouse_id)
       AND e.event_kind <> 'void'
     ORDER BY e.beneficiary_organization_id, e.central_item_id, e.target_warehouse_id NULLS FIRST
  LOOP
    v_line := gen_random_uuid();
    INSERT INTO public.central_needs_manual_need_events (
      organization_id, plan_id, plan_revision_id, beneficiary_organization_id, central_item_id, target_warehouse_id,
      event_seq, event_kind, quantity_text, approved_unit, carried_from_event_id, reason, actor_id, actor_role, idempotency_key, need_line_id)
    VALUES (v_org, v_rev.plan_id, p_plan_revision_id, r.beneficiary_organization_id, r.central_item_id, r.target_warehouse_id,
      1, 'carried_forward', r.quantity_text, r.approved_unit, r.id,
      format('carried forward from revision %s', v_src.revision_number), v_actor, v_role,
      'carry:' || p_plan_revision_id::text || ':' || r.id::text, v_line);
    INSERT INTO public.central_needs_need_lines (
      id, plan_revision_id, organization_id, beneficiary_organization_id, target_warehouse_id, central_item_id,
      approved_quantity, approved_unit, unit_conversion_state, mapping_reason, mapped_by)
    VALUES (v_line, p_plan_revision_id, v_org, r.beneficiary_organization_id, r.target_warehouse_id, r.central_item_id,
      r.quantity_text::numeric, r.approved_unit, 'canonical', format('carried forward from revision %s', v_src.revision_number), v_actor);
    v_n := v_n + 1;
  END LOOP;

  INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (v_org, v_actor, v_role, 'central_needs.manual_need.carry_forward', 'central_needs_plan_revision', p_plan_revision_id,
          format('carry from revision %s', v_src.revision_number),
          jsonb_build_object('source_revision_id', v_src.id, 'carried_count', v_n));

  RETURN jsonb_build_object('ok', true, 'idempotent_replay', false, 'plan_revision_id', p_plan_revision_id,
    'source_revision_id', v_src.id, 'carried_count', v_n);
END;
$$;

CREATE OR REPLACE FUNCTION public.phoenix_central_needs_correct_manual_need_line(
  p_plan_revision_id uuid, p_beneficiary_organization_id uuid, p_central_item_id uuid, p_target_warehouse_id uuid,
  p_quantity_text text, p_reason text, p_idempotency_key text, p_expected_last_event_id uuid, p_reference text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor  uuid := auth.uid();
  v_role   text;
  v_org    uuid;
  v_year   integer;
  v_rev    public.central_needs_plan_revisions%ROWTYPE;
  v_qty    text;
  v_reason text := public._phoenix_central_needs_human_text_v1(p_reason);
  v_ref    text := public._phoenix_central_needs_human_text_v1(p_reference);
  v_prior  public.central_needs_manual_need_events%ROWTYPE;
  v_last   public.central_needs_manual_need_events%ROWTYPE;
  v_event  uuid;
  v_seq    integer;
  v_rows   integer;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'manual_requires_read_committed' USING ERRCODE = '25000';
  END IF;
  v_qty := phoenix_private.central_needs_manual_quantity_v1(p_quantity_text);
  IF v_reason IS NULL OR char_length(v_reason) > 2000 THEN RAISE EXCEPTION 'manual_reason_required' USING ERRCODE = '23514'; END IF;
  IF v_ref IS NOT NULL AND char_length(v_ref) > 200 THEN RAISE EXCEPTION 'manual_reference_too_long' USING ERRCODE = '23514'; END IF;
  IF p_idempotency_key IS NULL OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 128 THEN
    RAISE EXCEPTION 'manual_idempotency_key_invalid' USING ERRCODE = '23514';
  END IF;
  IF p_expected_last_event_id IS NULL THEN RAISE EXCEPTION 'manual_expected_last_event_required' USING ERRCODE = '23514'; END IF;
  SELECT r1.organization_id, p.plan_year INTO v_org, v_year
    FROM public.central_needs_plan_revisions r1 JOIN public.central_needs_plans p ON p.id = r1.plan_id WHERE r1.id = p_plan_revision_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'plan_revision_not_found' USING ERRCODE = 'P0002'; END IF;
  v_role := public._phoenix_central_needs_guard_v1(v_org, 'central_needs.manual_need.set');

  PERFORM phoenix_private.central_needs_lock_plan_id_v1(
    (SELECT plan_id FROM public.central_needs_plan_revisions WHERE id = p_plan_revision_id));
  v_rev := public._phoenix_central_needs_load_revision_v1(p_plan_revision_id);

  SELECT * INTO v_prior FROM public.central_needs_manual_need_events WHERE plan_id = v_rev.plan_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_prior.event_kind = 'correct' AND v_prior.plan_revision_id = p_plan_revision_id
       AND v_prior.beneficiary_organization_id = p_beneficiary_organization_id AND v_prior.central_item_id = p_central_item_id
       AND v_prior.target_warehouse_id IS NOT DISTINCT FROM p_target_warehouse_id AND v_prior.quantity_text = v_qty
       AND v_prior.reason = v_reason AND v_prior.reference IS NOT DISTINCT FROM v_ref THEN
      RETURN jsonb_build_object('ok', true, 'idempotent_replay', true, 'event_id', v_prior.id, 'event_seq', v_prior.event_seq,
        'need_line_id', v_prior.need_line_id, 'event_kind', v_prior.event_kind, 'quantity_text', v_prior.quantity_text);
    END IF;
    RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = '23505', DETAIL = format('key=%s', p_idempotency_key);
  END IF;

  -- Reserve the batch namespace across ALL public manual event writers.
  IF p_idempotency_key LIKE 'intake:%' THEN
    RAISE EXCEPTION 'manual_idempotency_key_reserved' USING ERRCODE = '23514';
  END IF;

  PERFORM public._phoenix_central_needs_assert_draft_v1(p_plan_revision_id, v_rev.status);
  IF v_rev.source_mode <> 'manual' THEN
    RAISE EXCEPTION 'manual_revision_required' USING ERRCODE = '23514', DETAIL = format('revision=%s', v_rev.id);
  END IF;
  PERFORM phoenix_private.central_needs_manual_scope_v1(p_beneficiary_organization_id, p_central_item_id, p_target_warehouse_id);

  SELECT * INTO v_last FROM public.central_needs_manual_need_events e
   WHERE e.plan_revision_id = p_plan_revision_id AND e.beneficiary_organization_id = p_beneficiary_organization_id
     AND e.central_item_id = p_central_item_id AND e.target_warehouse_id IS NOT DISTINCT FROM p_target_warehouse_id
   ORDER BY e.event_seq DESC LIMIT 1;
  IF NOT FOUND OR v_last.event_kind = 'void' THEN
    RAISE EXCEPTION 'manual_need_line_not_live' USING ERRCODE = '23514';
  END IF;
  IF v_last.id <> p_expected_last_event_id THEN
    RAISE EXCEPTION 'manual_need_line_stale' USING ERRCODE = '23514', DETAIL = format('last=%s', v_last.id);
  END IF;
  IF v_last.quantity_text = v_qty THEN
    RAISE EXCEPTION 'manual_need_line_no_change' USING ERRCODE = '23514', DETAIL = format('quantity=%s', v_qty);
  END IF;
  v_seq := v_last.event_seq + 1;

  INSERT INTO public.central_needs_manual_need_events (
    organization_id, plan_id, plan_revision_id, beneficiary_organization_id, central_item_id, target_warehouse_id,
    event_seq, event_kind, quantity_text, approved_unit, supersedes_event_id, reason, reference, actor_id, actor_role, idempotency_key, need_line_id)
  VALUES (v_org, v_rev.plan_id, p_plan_revision_id, p_beneficiary_organization_id, p_central_item_id, p_target_warehouse_id,
    v_seq, 'correct', v_qty, v_last.approved_unit, v_last.id, v_reason, v_ref, v_actor, v_role, p_idempotency_key, v_last.need_line_id)
  RETURNING id INTO v_event;
  UPDATE public.central_needs_need_lines
     SET approved_quantity = v_qty::numeric, mapping_reason = v_reason, mapped_by = v_actor
   WHERE plan_revision_id = p_plan_revision_id AND beneficiary_organization_id = p_beneficiary_organization_id
     AND central_item_id = p_central_item_id AND target_warehouse_id IS NOT DISTINCT FROM p_target_warehouse_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'manual_projection_row_missing' USING ERRCODE = '23514', DETAIL = format('rows=%s', v_rows);
  END IF;

  INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (v_org, v_actor, v_role, 'central_needs.manual_need.correct', 'central_needs_plan_revision', p_plan_revision_id, format('event %s', v_seq),
          jsonb_build_object('event_id', v_event, 'beneficiary_organization_id', p_beneficiary_organization_id, 'central_item_id', p_central_item_id,
            'target_warehouse_id', p_target_warehouse_id, 'quantity_before', v_last.quantity_text, 'quantity_after', v_qty, 'reason', v_reason));

  RETURN jsonb_build_object('ok', true, 'idempotent_replay', false, 'event_id', v_event, 'event_seq', v_seq,
    'need_line_id', v_last.need_line_id, 'event_kind', 'correct', 'quantity_text', v_qty);
END;
$$;

CREATE OR REPLACE FUNCTION public.phoenix_central_needs_void_manual_need_line(
  p_plan_revision_id uuid, p_beneficiary_organization_id uuid, p_central_item_id uuid, p_target_warehouse_id uuid,
  p_reason text, p_idempotency_key text, p_expected_last_event_id uuid, p_reference text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor  uuid := auth.uid();
  v_role   text;
  v_org    uuid;
  v_year   integer;
  v_rev    public.central_needs_plan_revisions%ROWTYPE;
  v_reason text := public._phoenix_central_needs_human_text_v1(p_reason);
  v_ref    text := public._phoenix_central_needs_human_text_v1(p_reference);
  v_prior  public.central_needs_manual_need_events%ROWTYPE;
  v_last   public.central_needs_manual_need_events%ROWTYPE;
  v_event  uuid;
  v_seq    integer;
  v_rows   integer;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'manual_requires_read_committed' USING ERRCODE = '25000';
  END IF;
  IF v_reason IS NULL OR char_length(v_reason) > 2000 THEN RAISE EXCEPTION 'manual_reason_required' USING ERRCODE = '23514'; END IF;
  IF v_ref IS NOT NULL AND char_length(v_ref) > 200 THEN RAISE EXCEPTION 'manual_reference_too_long' USING ERRCODE = '23514'; END IF;
  IF p_idempotency_key IS NULL OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 128 THEN
    RAISE EXCEPTION 'manual_idempotency_key_invalid' USING ERRCODE = '23514';
  END IF;
  IF p_expected_last_event_id IS NULL THEN RAISE EXCEPTION 'manual_expected_last_event_required' USING ERRCODE = '23514'; END IF;
  SELECT r1.organization_id, p.plan_year INTO v_org, v_year
    FROM public.central_needs_plan_revisions r1 JOIN public.central_needs_plans p ON p.id = r1.plan_id WHERE r1.id = p_plan_revision_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'plan_revision_not_found' USING ERRCODE = 'P0002'; END IF;
  v_role := public._phoenix_central_needs_guard_v1(v_org, 'central_needs.manual_need.set');

  PERFORM phoenix_private.central_needs_lock_plan_id_v1(
    (SELECT plan_id FROM public.central_needs_plan_revisions WHERE id = p_plan_revision_id));
  v_rev := public._phoenix_central_needs_load_revision_v1(p_plan_revision_id);

  SELECT * INTO v_prior FROM public.central_needs_manual_need_events WHERE plan_id = v_rev.plan_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_prior.event_kind = 'void' AND v_prior.plan_revision_id = p_plan_revision_id
       AND v_prior.beneficiary_organization_id = p_beneficiary_organization_id AND v_prior.central_item_id = p_central_item_id
       AND v_prior.target_warehouse_id IS NOT DISTINCT FROM p_target_warehouse_id
       AND v_prior.reason = v_reason AND v_prior.reference IS NOT DISTINCT FROM v_ref THEN
      RETURN jsonb_build_object('ok', true, 'idempotent_replay', true, 'event_id', v_prior.id, 'event_seq', v_prior.event_seq,
        'event_kind', v_prior.event_kind);
    END IF;
    RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = '23505', DETAIL = format('key=%s', p_idempotency_key);
  END IF;

  -- Reserve the batch namespace across ALL public manual event writers.
  IF p_idempotency_key LIKE 'intake:%' THEN
    RAISE EXCEPTION 'manual_idempotency_key_reserved' USING ERRCODE = '23514';
  END IF;

  PERFORM public._phoenix_central_needs_assert_draft_v1(p_plan_revision_id, v_rev.status);
  IF v_rev.source_mode <> 'manual' THEN
    RAISE EXCEPTION 'manual_revision_required' USING ERRCODE = '23514', DETAIL = format('revision=%s', v_rev.id);
  END IF;

  SELECT * INTO v_last FROM public.central_needs_manual_need_events e
   WHERE e.plan_revision_id = p_plan_revision_id AND e.beneficiary_organization_id = p_beneficiary_organization_id
     AND e.central_item_id = p_central_item_id AND e.target_warehouse_id IS NOT DISTINCT FROM p_target_warehouse_id
   ORDER BY e.event_seq DESC LIMIT 1;
  IF NOT FOUND OR v_last.event_kind = 'void' THEN
    RAISE EXCEPTION 'manual_need_line_not_live' USING ERRCODE = '23514';
  END IF;
  IF v_last.id <> p_expected_last_event_id THEN
    RAISE EXCEPTION 'manual_need_line_stale' USING ERRCODE = '23514', DETAIL = format('last=%s', v_last.id);
  END IF;
  v_seq := v_last.event_seq + 1;

  INSERT INTO public.central_needs_manual_need_events (
    organization_id, plan_id, plan_revision_id, beneficiary_organization_id, central_item_id, target_warehouse_id,
    event_seq, event_kind, quantity_text, approved_unit, supersedes_event_id, reason, reference, actor_id, actor_role, idempotency_key, need_line_id)
  VALUES (v_org, v_rev.plan_id, p_plan_revision_id, p_beneficiary_organization_id, p_central_item_id, p_target_warehouse_id,
    v_seq, 'void', NULL, NULL, v_last.id, v_reason, v_ref, v_actor, v_role, p_idempotency_key, NULL)
  RETURNING id INTO v_event;
  DELETE FROM public.central_needs_need_lines
   WHERE plan_revision_id = p_plan_revision_id AND beneficiary_organization_id = p_beneficiary_organization_id
     AND central_item_id = p_central_item_id AND target_warehouse_id IS NOT DISTINCT FROM p_target_warehouse_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'manual_projection_row_missing' USING ERRCODE = '23514', DETAIL = format('rows=%s', v_rows);
  END IF;

  INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (v_org, v_actor, v_role, 'central_needs.manual_need.void', 'central_needs_plan_revision', p_plan_revision_id, format('event %s', v_seq),
          jsonb_build_object('event_id', v_event, 'beneficiary_organization_id', p_beneficiary_organization_id, 'central_item_id', p_central_item_id,
            'target_warehouse_id', p_target_warehouse_id, 'quantity_before', v_last.quantity_text, 'quantity_after', NULL, 'reason', v_reason));

  RETURN jsonb_build_object('ok', true, 'idempotent_replay', false, 'event_id', v_event, 'event_seq', v_seq, 'event_kind', 'void');
END;
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
    RAISE EXCEPTION 'P1_verify_failed: capability seal';
  END IF;
END $verify$;
COMMIT;
