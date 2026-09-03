-- ============================================================================
-- DISPENSING-SUSPENSION-ENFORCEMENT-WAREHOUSE-SEND-207
--
-- 205 filtered suspended batches out of the shared FEFO candidate list, but
-- every "send a SPECIFIC warehouse_stock_id" function loads that row by id
-- directly and only consults the (now-filtered) candidate list to ask "is
-- this the earliest-expiring batch, or does the caller need a FEFO override".
-- A suspended batch that happens to be the only (or earliest remaining) batch
-- of its material would fall into that override branch — i.e. a holder of
-- inventory.fefo_override could still push it through with an override
-- reason. Suspension is not a FEFO-ordering question and must never be
-- satisfiable by a FEFO override: this migration adds an explicit,
-- unconditional check to each of those functions, independent of
-- p_fefo_override.
--
-- Four internal functions carry the real logic behind six public entry
-- points (all reachable only through their one-line SQL wrappers, already
-- REVOKEd from direct client execution):
--
--   * _phoenix_150_send_routed_v1        → phoenix_send_warehouse_transfer_line[_fefo_guarded]
--   * _phoenix_150_send_direct_v1        → phoenix_send_direct_warehouse_transfer_line[_fefo_guarded]
--   * _phoenix_150_add_dispatch_line_v1  → phoenix_add_dispatch_line[_fefo_guarded]  (draft-time)
--   * phoenix_send_warehouse_dispatch                                                 (send-time —
--     the real, final gate: a line can be added to a draft dispatch before its
--     material is suspended and the dispatch only actually moves stock here,
--     so this is where the authoritative re-check belongs; unconditional, no
--     override path exists for it here either)
--
-- Everything else in all four bodies is byte-for-byte identical to 150's
-- definitions; only the check blocks below are added.
--
-- PRECONDITIONS: 203 applied.
-- ============================================================================

DO $precond$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = '_phoenix_is_material_dispensing_suspended_v1'
       AND p.pronamespace = 'public'::regnamespace
  ) THEN
    RAISE EXCEPTION '207 PRECONDITION FAILED: 203 missing — apply 203 first';
  END IF;
END;
$precond$;

CREATE OR REPLACE FUNCTION public._phoenix_150_send_routed_v1(
  p_request_id uuid,p_route_id uuid,p_warehouse_stock_id uuid,
  p_quantity integer,p_transfer_number text,p_transfer_request_line_id uuid,
  p_document_number text,p_notes text,p_fefo_override boolean,
  p_override_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
  v_actor uuid:=auth.uid();
  v_actor_role text;
  v_stock public.warehouse_stock%ROWTYPE;
  v_existing public.warehouse_stock_movements%ROWTYPE;
  v_number text:=NULLIF(btrim(p_transfer_number),'');
  v_doc text:=NULLIF(btrim(p_document_number),'');
  v_notes text:=NULLIF(btrim(p_notes),'');
  v_reason text:=NULLIF(btrim(p_override_reason),'');
  v_fp text;
  v_candidate_fp text;
  v_earliest record;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE='28000';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE='23514';
  END IF;
  v_fp:=encode(sha256(convert_to(jsonb_build_object(
    'operation','transfer_send','route_id',p_route_id,
    'warehouse_stock_id',p_warehouse_stock_id,'quantity',p_quantity,
    'transfer_number',v_number,
    'transfer_request_line_id',p_transfer_request_line_id,
    'document_number',v_doc,'notes',v_notes
  )::text,'UTF8')),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text,68068));
  SELECT * INTO v_existing FROM public.warehouse_stock_movements m
  WHERE m.reference_type='warehouse_transfer_send'
    AND m.reference_id=p_request_id;
  IF FOUND THEN
    IF v_existing.warehouse_stock_id IS DISTINCT FROM p_warehouse_stock_id
       OR v_existing.request_fingerprint IS DISTINCT FROM v_fp THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE='23505';
    END IF;
    RETURN jsonb_build_object(
      'ok',true,'idempotent_replay',true,
      'warehouse_stock_id',v_existing.warehouse_stock_id,
      'movement_id',v_existing.id,'quantity_before',v_existing.on_hand_before,
      'quantity_delta',v_existing.on_hand_delta,
      'quantity_after',v_existing.on_hand_after
    );
  END IF;

  SELECT * INTO v_stock FROM public.warehouse_stock
  WHERE id=p_warehouse_stock_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse_stock_not_found' USING ERRCODE='P0002';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('inv_material:'||v_stock.material_identity_key,0)
  );
  PERFORM 1 FROM public.warehouse_supply_routes WHERE id=p_route_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'supply_route_not_found' USING ERRCODE='P0002';
  END IF;
  IF p_transfer_request_line_id IS NOT NULL THEN
    PERFORM 1 FROM public.warehouse_transfer_request_lines
    WHERE id=p_transfer_request_line_id FOR UPDATE;
  END IF;
  PERFORM 1 FROM public.warehouses
  WHERE id=v_stock.warehouse_id AND organization_id=v_stock.organization_id
  FOR UPDATE;
  PERFORM 1 FROM public.warehouse_stock ws
  WHERE ws.organization_id=v_stock.organization_id
    AND ws.warehouse_id=v_stock.warehouse_id
    AND ws.material_identity_key=v_stock.material_identity_key
  ORDER BY ws.id FOR UPDATE;
  SELECT * INTO v_stock FROM public.warehouse_stock
  WHERE id=p_warehouse_stock_id FOR UPDATE;

  -- 207: موقوف الصرف — unconditional; never satisfiable via p_fefo_override.
  IF v_stock.central_item_id IS NOT NULL AND public._phoenix_is_material_dispensing_suspended_v1(
    v_stock.central_item_id, v_stock.organization_id, NULL
  ) THEN
    RAISE EXCEPTION 'material_dispensing_suspended' USING ERRCODE='23514';
  END IF;

  SELECT b.* INTO v_earliest
  FROM public._phoenix_inventory_fefo_batches_exact_v1(
    v_stock.organization_id,'warehouse',v_stock.warehouse_id,
    v_stock.material_identity_key
  ) b
  ORDER BY b.expiry_date ASC NULLS LAST,b.stock_id ASC LIMIT 1;
  v_candidate_fp:=public._phoenix_fefo_candidate_fingerprint_v1(
    v_stock.organization_id,'warehouse',v_stock.warehouse_id,
    v_stock.material_identity_key
  );
  IF v_earliest.stock_id IS DISTINCT FROM p_warehouse_stock_id THEN
    IF NOT COALESCE(p_fefo_override,false) THEN
      RAISE EXCEPTION 'fefo_revalidation_required' USING ERRCODE='23514';
    END IF;
    IF v_reason IS NULL THEN
      RAISE EXCEPTION 'fefo_override_reason_required' USING ERRCODE='23514';
    END IF;
    IF NOT public.phoenix_profile_has_scoped_permission(
      v_actor,'inventory.fefo_override',v_stock.organization_id,
      v_stock.warehouse_id,NULL
    ) THEN
      RAISE EXCEPTION 'forbidden_fefo_override' USING ERRCODE='42501';
    END IF;
  END IF;

  v_result:=public._phoenix_150_delegate_send_warehouse_transfer_line(
    p_request_id,p_route_id,p_warehouse_stock_id,p_quantity,p_transfer_number,
    p_transfer_request_line_id,p_document_number,p_notes
  );
  IF v_earliest.stock_id IS DISTINCT FROM p_warehouse_stock_id THEN
    SELECT p.role INTO v_actor_role FROM public.profiles p
    WHERE p.id=v_actor AND p.status='active';
    INSERT INTO public.audit_logs(
      organization_id,actor_id,actor_role,action,entity_type,entity_id,
      entity_label,payload
    ) VALUES (
      v_stock.organization_id,v_actor,v_actor_role,'inventory.fefo_overridden',
      'warehouse_stock_movements',NULLIF(v_result->>'movement_id','')::uuid,
      v_stock.scientific_name,jsonb_build_object(
        'request_id',p_request_id,'route_id',p_route_id,
        'transfer_request_line_id',p_transfer_request_line_id,
        'material_identity_key',v_stock.material_identity_key,
        'earliest_stock_id',v_earliest.stock_id,
        'earliest_batch',v_earliest.batch_number,
        'earliest_expiry',v_earliest.expiry_date,
        'selected_stock_id',v_stock.id,'selected_batch',v_stock.batch_number,
        'selected_expiry',v_stock.expiry_date,
        'candidate_fingerprint',v_candidate_fp,'reason',v_reason
      )
    );
  END IF;
  RETURN v_result||jsonb_build_object(
    'fefo_override_applied',
    v_earliest.stock_id IS DISTINCT FROM p_warehouse_stock_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public._phoenix_150_send_direct_v1(
  p_request_id uuid,p_transfer_request_id uuid,p_warehouse_stock_id uuid,
  p_quantity integer,p_transfer_number text,p_transfer_request_line_id uuid,
  p_document_number text,p_notes text,p_fefo_override boolean,
  p_override_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
  v_actor uuid:=auth.uid();
  v_actor_role text;
  v_stock public.warehouse_stock%ROWTYPE;
  v_existing public.warehouse_stock_movements%ROWTYPE;
  v_line public.warehouse_transfer_request_lines%ROWTYPE;
  v_number text:=NULLIF(btrim(p_transfer_number),'');
  v_doc text:=NULLIF(btrim(p_document_number),'');
  v_notes text:=NULLIF(btrim(p_notes),'');
  v_reason text:=NULLIF(btrim(p_override_reason),'');
  v_fp text;
  v_candidate_fp text;
  v_earliest record;
  v_line_identity_count integer;
  v_line_identity_key text;
  v_expected_stock_id uuid;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE='28000';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE='23514';
  END IF;
  v_fp:=encode(sha256(convert_to(jsonb_build_object(
    'operation','direct_transfer_send',
    'transfer_request_id',p_transfer_request_id,
    'warehouse_stock_id',p_warehouse_stock_id,'quantity',p_quantity,
    'transfer_number',v_number,
    'transfer_request_line_id',p_transfer_request_line_id,
    'document_number',v_doc,'notes',v_notes
  )::text,'UTF8')),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text,68068));
  SELECT * INTO v_existing FROM public.warehouse_stock_movements m
  WHERE m.reference_type='warehouse_transfer_send'
    AND m.reference_id=p_request_id;
  IF FOUND THEN
    IF v_existing.warehouse_stock_id IS DISTINCT FROM p_warehouse_stock_id
       OR v_existing.request_fingerprint IS DISTINCT FROM v_fp THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE='23505';
    END IF;
    RETURN jsonb_build_object(
      'ok',true,'idempotent_replay',true,
      'warehouse_stock_id',v_existing.warehouse_stock_id,
      'movement_id',v_existing.id,'quantity_before',v_existing.on_hand_before,
      'quantity_delta',v_existing.on_hand_delta,
      'quantity_after',v_existing.on_hand_after
    );
  END IF;

  SELECT * INTO v_stock FROM public.warehouse_stock
  WHERE id=p_warehouse_stock_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse_stock_not_found' USING ERRCODE='P0002';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('inv_material:'||v_stock.material_identity_key,0)
  );
  IF p_transfer_request_line_id IS NOT NULL THEN
    PERFORM public._phoenix_lock_linked_suggestions(
      'central_line',p_transfer_request_line_id,false
    );
  END IF;
  PERFORM 1 FROM public.warehouse_transfer_requests
  WHERE id=p_transfer_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transfer_request_not_found' USING ERRCODE='P0002';
  END IF;
  IF p_transfer_request_line_id IS NOT NULL THEN
    SELECT * INTO v_line FROM public.warehouse_transfer_request_lines
    WHERE id=p_transfer_request_line_id
      AND transfer_request_id=p_transfer_request_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'request_line_not_found_for_request' USING ERRCODE='P0002';
    END IF;
  END IF;
  PERFORM 1 FROM public.warehouses
  WHERE id=v_stock.warehouse_id AND organization_id=v_stock.organization_id
  FOR UPDATE;
  PERFORM 1 FROM public.warehouse_stock ws
  WHERE ws.organization_id=v_stock.organization_id
    AND ws.warehouse_id=v_stock.warehouse_id
    AND ws.material_identity_key=v_stock.material_identity_key
  ORDER BY ws.id FOR UPDATE;
  SELECT * INTO v_stock FROM public.warehouse_stock
  WHERE id=p_warehouse_stock_id FOR UPDATE;

  -- 207: موقوف الصرف — unconditional; never satisfiable via p_fefo_override.
  IF v_stock.central_item_id IS NOT NULL AND public._phoenix_is_material_dispensing_suspended_v1(
    v_stock.central_item_id, v_stock.organization_id, NULL
  ) THEN
    RAISE EXCEPTION 'material_dispensing_suspended' USING ERRCODE='23514';
  END IF;

  IF p_transfer_request_line_id IS NOT NULL THEN
    SELECT count(DISTINCT ws.material_identity_key),min(ws.material_identity_key)
      INTO v_line_identity_count,v_line_identity_key
    FROM public.warehouse_stock ws
    WHERE ws.organization_id=v_stock.organization_id
      AND ws.warehouse_id=v_stock.warehouse_id
      AND ws.central_item_id IS NOT DISTINCT FROM v_line.central_item_id
      AND lower(ws.scientific_name)=lower(v_line.scientific_name)
      AND lower(COALESCE(ws.concentration,''))=
          lower(COALESCE(v_line.concentration,''))
      AND lower(COALESCE(ws.dosage_form,''))=
          lower(COALESCE(v_line.dosage_form,''))
      AND lower(COALESCE(ws.unit,''))=lower(COALESCE(v_line.unit,''));
    IF v_line_identity_count<>1
       OR v_line_identity_key IS DISTINCT FROM v_stock.material_identity_key THEN
      RAISE EXCEPTION 'direct_request_line_material_mismatch'
        USING ERRCODE='23514';
    END IF;
    SELECT s.source_stock_id INTO v_expected_stock_id
    FROM public.inventory_transfer_suggestions s
    WHERE s.status='accepted' AND s.lineage_version=1
      AND s.lineage_state='linked'
      AND s.draft_warehouse_transfer_request_line_id=p_transfer_request_line_id;
    IF FOUND AND v_expected_stock_id IS DISTINCT FROM p_warehouse_stock_id THEN
      RAISE EXCEPTION 'suggestion_source_stock_mismatch' USING ERRCODE='23514';
    END IF;
  END IF;

  SELECT b.* INTO v_earliest
  FROM public._phoenix_inventory_fefo_batches_exact_v1(
    v_stock.organization_id,'warehouse',v_stock.warehouse_id,
    v_stock.material_identity_key
  ) b
  ORDER BY b.expiry_date ASC NULLS LAST,b.stock_id ASC LIMIT 1;
  v_candidate_fp:=public._phoenix_fefo_candidate_fingerprint_v1(
    v_stock.organization_id,'warehouse',v_stock.warehouse_id,
    v_stock.material_identity_key
  );
  IF v_earliest.stock_id IS DISTINCT FROM p_warehouse_stock_id THEN
    IF NOT COALESCE(p_fefo_override,false) THEN
      RAISE EXCEPTION 'fefo_revalidation_required' USING ERRCODE='23514';
    END IF;
    IF v_reason IS NULL THEN
      RAISE EXCEPTION 'fefo_override_reason_required' USING ERRCODE='23514';
    END IF;
    IF NOT public.phoenix_profile_has_scoped_permission(
      v_actor,'inventory.fefo_override',v_stock.organization_id,
      v_stock.warehouse_id,NULL
    ) THEN
      RAISE EXCEPTION 'forbidden_fefo_override' USING ERRCODE='42501';
    END IF;
  END IF;
  v_result:=public._phoenix_149_delegate_send_direct_warehouse_transfer_line(
    p_request_id,p_transfer_request_id,p_warehouse_stock_id,p_quantity,
    p_transfer_number,p_transfer_request_line_id,p_document_number,p_notes
  );
  IF v_earliest.stock_id IS DISTINCT FROM p_warehouse_stock_id THEN
    SELECT p.role INTO v_actor_role FROM public.profiles p
    WHERE p.id=v_actor AND p.status='active';
    INSERT INTO public.audit_logs(
      organization_id,actor_id,actor_role,action,entity_type,entity_id,
      entity_label,payload
    ) VALUES (
      v_stock.organization_id,v_actor,v_actor_role,'inventory.fefo_overridden',
      'warehouse_stock_movements',NULLIF(v_result->>'movement_id','')::uuid,
      v_stock.scientific_name,jsonb_build_object(
        'request_id',p_request_id,
        'transfer_request_id',p_transfer_request_id,
        'transfer_request_line_id',p_transfer_request_line_id,
        'material_identity_key',v_stock.material_identity_key,
        'earliest_stock_id',v_earliest.stock_id,
        'earliest_batch',v_earliest.batch_number,
        'earliest_expiry',v_earliest.expiry_date,
        'selected_stock_id',v_stock.id,'selected_batch',v_stock.batch_number,
        'selected_expiry',v_stock.expiry_date,
        'candidate_fingerprint',v_candidate_fp,'reason',v_reason
      )
    );
  END IF;
  RETURN v_result||jsonb_build_object(
    'fefo_override_applied',
    v_earliest.stock_id IS DISTINCT FROM p_warehouse_stock_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public._phoenix_150_add_dispatch_line_v1(
  p_dispatch_id uuid,p_warehouse_stock_id uuid,p_quantity integer,
  p_fefo_override boolean,p_override_reason text,p_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
  v_actor uuid:=auth.uid();
  v_actor_role text;
  v_dispatch public.warehouse_dispatches%ROWTYPE;
  v_stock public.warehouse_stock%ROWTYPE;
  v_existing public.phoenix_dispatch_line_requests%ROWTYPE;
  v_reason text:=NULLIF(btrim(p_override_reason),'');
  v_fp text;
  v_candidate_fp text;
  v_earliest record;
  v_result jsonb;
  v_line_id uuid;
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE='23514';
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE='28000';
  END IF;
  v_fp:=encode(sha256(convert_to(jsonb_build_object(
    'operation','add_dispatch_line_fefo_guarded',
    'dispatch_id',p_dispatch_id,'warehouse_stock_id',p_warehouse_stock_id,
    'quantity',p_quantity,'fefo_override',COALESCE(p_fefo_override,false),
    'override_reason',v_reason,'actor',v_actor
  )::text,'UTF8')),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text,106106));
  SELECT * INTO v_existing FROM public.phoenix_dispatch_line_requests
  WHERE request_id=p_request_id;
  IF FOUND THEN
    IF v_existing.payload_fingerprint IS DISTINCT FROM v_fp THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE='23505';
    END IF;
    RETURN v_existing.result;
  END IF;

  SELECT * INTO v_stock FROM public.warehouse_stock
  WHERE id=p_warehouse_stock_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse_stock_not_found' USING ERRCODE='P0002';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('inv_material:'||v_stock.material_identity_key,0)
  );
  PERFORM pg_advisory_xact_lock(
    hashtextextended('warehouse_dispatch:'||p_dispatch_id::text,0)
  );
  SELECT * INTO v_dispatch FROM public.warehouse_dispatches
  WHERE id=p_dispatch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dispatch_not_found' USING ERRCODE='P0002';
  END IF;
  PERFORM 1 FROM public.warehouses
  WHERE id=v_stock.warehouse_id AND organization_id=v_stock.organization_id
  FOR UPDATE;
  PERFORM 1 FROM public.warehouse_stock ws
  WHERE ws.organization_id=v_stock.organization_id
    AND ws.warehouse_id=v_stock.warehouse_id
    AND ws.material_identity_key=v_stock.material_identity_key
  ORDER BY ws.id FOR UPDATE;
  SELECT * INTO v_stock FROM public.warehouse_stock
  WHERE id=p_warehouse_stock_id FOR UPDATE;

  -- 207: موقوف الصرف — unconditional at draft-add time too, so the UI can
  -- surface the refusal as early as possible (send-time in
  -- phoenix_send_warehouse_dispatch remains the authoritative final gate).
  IF v_stock.central_item_id IS NOT NULL AND public._phoenix_is_material_dispensing_suspended_v1(
    v_stock.central_item_id, v_stock.organization_id, NULL
  ) THEN
    RAISE EXCEPTION 'material_dispensing_suspended' USING ERRCODE='23514';
  END IF;

  SELECT b.* INTO v_earliest
  FROM public._phoenix_inventory_fefo_batches_exact_v1(
    v_stock.organization_id,'warehouse',v_stock.warehouse_id,
    v_stock.material_identity_key
  ) b
  ORDER BY b.expiry_date ASC NULLS LAST,b.stock_id ASC LIMIT 1;
  v_candidate_fp:=public._phoenix_fefo_candidate_fingerprint_v1(
    v_stock.organization_id,'warehouse',v_stock.warehouse_id,
    v_stock.material_identity_key
  );
  IF v_earliest.stock_id IS DISTINCT FROM p_warehouse_stock_id THEN
    IF NOT COALESCE(p_fefo_override,false) THEN
      RAISE EXCEPTION 'fefo_revalidation_required' USING ERRCODE='23514';
    END IF;
    IF v_reason IS NULL THEN
      RAISE EXCEPTION 'fefo_override_reason_required' USING ERRCODE='23514';
    END IF;
    IF NOT public.phoenix_profile_has_scoped_permission(
      v_actor,'inventory.fefo_override',v_stock.organization_id,
      v_stock.warehouse_id,NULL
    ) THEN
      RAISE EXCEPTION 'forbidden_fefo_override' USING ERRCODE='42501';
    END IF;
  END IF;

  v_result:=public._phoenix_150_delegate_add_dispatch_line(
    p_dispatch_id,p_warehouse_stock_id,p_quantity
  );
  v_line_id:=NULLIF(v_result->>'dispatch_line_id','')::uuid;
  UPDATE public.warehouse_dispatch_lines
  SET fefo_candidate_fingerprint=v_candidate_fp,
      fefo_override_reason=CASE
        WHEN v_earliest.stock_id IS DISTINCT FROM p_warehouse_stock_id
        THEN v_reason END,
      fefo_override_actor_id=CASE
        WHEN v_earliest.stock_id IS DISTINCT FROM p_warehouse_stock_id
        THEN v_actor END,
      fefo_override_material_identity_key=CASE
        WHEN v_earliest.stock_id IS DISTINCT FROM p_warehouse_stock_id
        THEN v_stock.material_identity_key END,
      fefo_override_recorded_at=CASE
        WHEN v_earliest.stock_id IS DISTINCT FROM p_warehouse_stock_id
        THEN now() END
  WHERE id=v_line_id;
  IF v_earliest.stock_id IS DISTINCT FROM p_warehouse_stock_id THEN
    SELECT p.role INTO v_actor_role FROM public.profiles p
    WHERE p.id=v_actor AND p.status='active';
    INSERT INTO public.audit_logs(
      organization_id,actor_id,actor_role,action,entity_type,entity_id,
      entity_label,payload
    ) VALUES (
      v_stock.organization_id,v_actor,v_actor_role,'inventory.fefo_overridden',
      'warehouse_dispatch_lines',v_line_id,v_stock.scientific_name,
      jsonb_build_object(
        'request_id',p_request_id,'dispatch_id',p_dispatch_id,
        'dispatch_line_id',v_line_id,
        'material_identity_key',v_stock.material_identity_key,
        'earliest_stock_id',v_earliest.stock_id,
        'earliest_batch',v_earliest.batch_number,
        'earliest_expiry',v_earliest.expiry_date,
        'selected_stock_id',v_stock.id,'selected_batch',v_stock.batch_number,
        'selected_expiry',v_stock.expiry_date,
        'candidate_fingerprint',v_candidate_fp,'reason',v_reason
      )
    );
  END IF;
  v_result:=v_result||jsonb_build_object(
    'fefo_override_applied',
    v_earliest.stock_id IS DISTINCT FROM p_warehouse_stock_id
  );
  INSERT INTO public.phoenix_dispatch_line_requests(
    request_id,organization_id,dispatch_id,payload_fingerprint,result,
    dispatch_line_id,actor_id
  ) VALUES (
    p_request_id,v_dispatch.organization_id,p_dispatch_id,v_fp,v_result,
    v_line_id,v_actor
  );
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.phoenix_send_warehouse_dispatch(
  p_request_id uuid,p_dispatch_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
  v_actor uuid:=auth.uid();
  v_actor_role text;
  v_dispatch public.warehouse_dispatches%ROWTYPE;
  v_prior record;
  v_line record;
  v_key text;
  v_candidate_fp text;
  v_earliest record;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE='28000';
  END IF;
  IF p_request_id IS NULL OR p_dispatch_id IS NULL THEN
    RAISE EXCEPTION 'request_id_and_dispatch_id_required' USING ERRCODE='23514';
  END IF;

  -- Exact replay/conflict precedes all FEFO reads.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text,70169));
  SELECT a.entity_id,a.payload INTO v_prior
  FROM public.audit_logs a
  WHERE a.action='warehouse_dispatch.sent'
    AND a.payload->>'request_id'=p_request_id::text
  ORDER BY a.created_at,a.id LIMIT 1;
  IF FOUND THEN
    IF v_prior.entity_id IS DISTINCT FROM p_dispatch_id THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE='23505';
    END IF;
    RETURN jsonb_build_object(
      'ok',true,'idempotent_replay',true,'dispatch_id',p_dispatch_id,
      'status','sent','line_count',v_prior.payload->'line_count',
      'movement_ids',v_prior.payload->'movement_ids'
    );
  END IF;

  -- Canonical materials sort before suggestion/document/stock locks.
  FOR v_key IN
    SELECT DISTINCT ws.material_identity_key
    FROM public.warehouse_dispatch_lines l
    JOIN public.warehouse_stock ws ON ws.id=l.warehouse_stock_id
    WHERE l.dispatch_id=p_dispatch_id
    ORDER BY ws.material_identity_key
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('inv_material:'||v_key,0));
  END LOOP;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('warehouse_dispatch:'||p_dispatch_id::text,0)
  );
  PERFORM public._phoenix_lock_linked_suggestions(
    'dispatch_header',p_dispatch_id,false
  );
  SELECT * INTO v_dispatch FROM public.warehouse_dispatches
  WHERE id=p_dispatch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dispatch_not_found' USING ERRCODE='P0002';
  END IF;
  IF v_dispatch.status<>'draft' THEN
    RETURN public._phoenix_149_delegate_send_warehouse_dispatch(
      p_request_id,p_dispatch_id
    );
  END IF;
  PERFORM 1 FROM public.warehouse_dispatch_lines
  WHERE dispatch_id=p_dispatch_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.warehouses
  WHERE id=v_dispatch.warehouse_id
    AND organization_id=v_dispatch.organization_id FOR UPDATE;
  PERFORM 1 FROM public.warehouse_stock ws
  WHERE ws.organization_id=v_dispatch.organization_id
    AND ws.warehouse_id=v_dispatch.warehouse_id
    AND ws.material_identity_key IN (
      SELECT DISTINCT s.material_identity_key
      FROM public.warehouse_dispatch_lines l
      JOIN public.warehouse_stock s ON s.id=l.warehouse_stock_id
      WHERE l.dispatch_id=p_dispatch_id
    )
  ORDER BY ws.id FOR UPDATE;

  SELECT p.role INTO v_actor_role FROM public.profiles p
  WHERE p.id=v_actor AND p.status='active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE='42501';
  END IF;
  FOR v_line IN
    SELECT l.*,ws.material_identity_key,ws.central_item_id,
           ws.batch_number AS selected_batch,ws.expiry_date AS selected_expiry
    FROM public.warehouse_dispatch_lines l
    JOIN public.warehouse_stock ws ON ws.id=l.warehouse_stock_id
    WHERE l.dispatch_id=p_dispatch_id ORDER BY l.id
  LOOP
    -- 207: موقوف الصرف — the authoritative, final, unconditional gate. A line
    -- can be added to a draft dispatch before its material is suspended;
    -- this is the moment stock actually moves, so it is re-checked here
    -- regardless of what was true when the line was added.
    IF v_line.central_item_id IS NOT NULL AND public._phoenix_is_material_dispensing_suspended_v1(
      v_line.central_item_id, v_dispatch.organization_id, NULL
    ) THEN
      RAISE EXCEPTION 'material_dispensing_suspended' USING ERRCODE='23514';
    END IF;

    SELECT b.* INTO v_earliest
    FROM public._phoenix_inventory_fefo_batches_exact_v1(
      v_dispatch.organization_id,'warehouse',v_dispatch.warehouse_id,
      v_line.material_identity_key
    ) b
    ORDER BY b.expiry_date ASC NULLS LAST,b.stock_id ASC LIMIT 1;
    v_candidate_fp:=public._phoenix_fefo_candidate_fingerprint_v1(
      v_dispatch.organization_id,'warehouse',v_dispatch.warehouse_id,
      v_line.material_identity_key
    );
    IF v_earliest.stock_id IS DISTINCT FROM v_line.warehouse_stock_id THEN
      IF v_line.fefo_override_reason IS NULL
         OR v_line.fefo_override_material_identity_key
              IS DISTINCT FROM v_line.material_identity_key
         OR v_line.fefo_candidate_fingerprint IS DISTINCT FROM v_candidate_fp THEN
        RAISE EXCEPTION 'fefo_revalidation_required' USING ERRCODE='23514';
      END IF;
      IF NOT public.phoenix_profile_has_scoped_permission(
        v_actor,'inventory.fefo_override',v_dispatch.organization_id,
        v_dispatch.warehouse_id,NULL
      ) THEN
        RAISE EXCEPTION 'forbidden_fefo_override' USING ERRCODE='42501';
      END IF;
    END IF;
  END LOOP;

  v_result:=public._phoenix_149_delegate_send_warehouse_dispatch(
    p_request_id,p_dispatch_id
  );
  -- Send-time audit is emitted only for overrides still required and valid.
  FOR v_line IN
    SELECT l.*,ws.material_identity_key,ws.batch_number AS selected_batch,
           ws.expiry_date AS selected_expiry
    FROM public.warehouse_dispatch_lines l
    JOIN public.warehouse_stock ws ON ws.id=l.warehouse_stock_id
    WHERE l.dispatch_id=p_dispatch_id AND l.fefo_override_reason IS NOT NULL
    ORDER BY l.id
  LOOP
    SELECT b.* INTO v_earliest
    FROM public._phoenix_inventory_fefo_batches_exact_v1(
      v_dispatch.organization_id,'warehouse',v_dispatch.warehouse_id,
      v_line.material_identity_key
    ) b
    ORDER BY b.expiry_date ASC NULLS LAST,b.stock_id ASC LIMIT 1;
    IF v_earliest.stock_id IS DISTINCT FROM v_line.warehouse_stock_id THEN
      INSERT INTO public.audit_logs(
        organization_id,actor_id,actor_role,action,entity_type,entity_id,
        entity_label,payload
      ) VALUES (
        v_dispatch.organization_id,v_actor,v_actor_role,
        'inventory.fefo_override_revalidated','warehouse_dispatch_lines',
        v_line.id,v_line.scientific_name,jsonb_build_object(
          'request_id',p_request_id,'dispatch_id',p_dispatch_id,
          'dispatch_line_id',v_line.id,
          'material_identity_key',v_line.material_identity_key,
          'earliest_stock_id',v_earliest.stock_id,
          'earliest_batch',v_earliest.batch_number,
          'earliest_expiry',v_earliest.expiry_date,
          'selected_stock_id',v_line.warehouse_stock_id,
          'selected_batch',v_line.selected_batch,
          'selected_expiry',v_line.selected_expiry,
          'candidate_fingerprint',v_line.fefo_candidate_fingerprint,
          'reason',v_line.fefo_override_reason
        )
      );
    END IF;
  END LOOP;
  RETURN v_result;
END;
$$;

DO $verify$
BEGIN
  IF to_regprocedure(
    '_phoenix_150_send_routed_v1(uuid,uuid,uuid,integer,text,uuid,text,text,boolean,text)'
  ) IS NULL THEN
    RAISE EXCEPTION '207 VERIFY FAILED: _phoenix_150_send_routed_v1 missing after redefinition';
  END IF;
  IF to_regprocedure(
    '_phoenix_150_send_direct_v1(uuid,uuid,uuid,integer,text,uuid,text,text,boolean,text)'
  ) IS NULL THEN
    RAISE EXCEPTION '207 VERIFY FAILED: _phoenix_150_send_direct_v1 missing after redefinition';
  END IF;
  IF to_regprocedure(
    '_phoenix_150_add_dispatch_line_v1(uuid,uuid,integer,boolean,text,uuid)'
  ) IS NULL THEN
    RAISE EXCEPTION '207 VERIFY FAILED: _phoenix_150_add_dispatch_line_v1 missing after redefinition';
  END IF;
  IF to_regprocedure('public.phoenix_send_warehouse_dispatch(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION '207 VERIFY FAILED: phoenix_send_warehouse_dispatch missing after redefinition';
  END IF;
  RAISE NOTICE 'DISPENSING-SUSPENSION-ENFORCEMENT-WAREHOUSE-SEND-207: verified.';
END;
$verify$;
