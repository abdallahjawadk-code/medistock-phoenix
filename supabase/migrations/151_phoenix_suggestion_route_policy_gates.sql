-- ============================================================================
-- 151 — Real operational route roles + scoped suggestion policy gate
--
-- Phase 7 proved on the final 001->150 schema that outlet_officer owns the
-- exact outlet_stock.return_request permission at its assigned outlet, but is
-- denied before that corridor RPC runs because the suggestion bridge also
-- requires inventory.act_on_suggestions. The other two operational roles pass
-- only because their role defaults happen to include that queue permission.
--
-- Contract:
--   active actor + exact route permission + exact source scope + valid state
--
-- inventory.act_on_suggestions remains the permission for suggestion-level
-- actions such as reject. It is not granted broadly and is no longer a second
-- prerequisite for creating a real corridor Draft. Every delegated corridor
-- RPC remains the final authorization and process-state boundary.
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF to_regprocedure(
       'public._phoenix_150_delegate_create_transfer_draft_from_suggestion(uuid,text)'
     ) IS NULL
     OR to_regprocedure(
       'public.phoenix_profile_has_scoped_permission(uuid,text,uuid,uuid,uuid)'
     ) IS NULL THEN
    RAISE EXCEPTION
      'ABORT 151: expected Phase 6 suggestion bridge and scoped RBAC helper are missing';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public._phoenix_authorize_suggestion_draft_route_v1(
  p_actor uuid,
  p_suggestion public.inventory_transfer_suggestions
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  CASE p_suggestion.route_kind
    WHEN 'central_to_institution' THEN
      IF p_suggestion.source_scope_kind <> 'warehouse'
         OR p_suggestion.target_scope_kind <> 'warehouse'
         OR NOT public.phoenix_profile_has_scoped_permission(
           p_actor,
           'warehouse_transfer.send',
           p_suggestion.source_organization_id,
           p_suggestion.source_scope_id,
           NULL
         ) THEN
        RAISE EXCEPTION 'forbidden_suggestion_central_to_institution'
          USING ERRCODE = '42501';
      END IF;

    WHEN 'warehouse_to_outlet' THEN
      IF p_suggestion.source_scope_kind <> 'warehouse'
         OR p_suggestion.target_scope_kind <> 'outlet'
         OR p_suggestion.source_organization_id
              IS DISTINCT FROM p_suggestion.target_organization_id
         OR NOT public.phoenix_profile_has_scoped_permission(
           p_actor,
           'warehouse_dispatch.create',
           p_suggestion.source_organization_id,
           p_suggestion.source_scope_id,
           NULL
         ) THEN
        RAISE EXCEPTION 'forbidden_suggestion_warehouse_to_outlet'
          USING ERRCODE = '42501';
      END IF;

    WHEN 'outlet_to_warehouse' THEN
      IF p_suggestion.source_scope_kind <> 'outlet'
         OR p_suggestion.target_scope_kind <> 'warehouse'
         OR p_suggestion.source_organization_id
              IS DISTINCT FROM p_suggestion.target_organization_id
         OR NOT public.phoenix_profile_has_scoped_permission(
           p_actor,
           'outlet_stock.return_request',
           p_suggestion.source_organization_id,
           NULL,
           p_suggestion.source_scope_id
         ) THEN
        RAISE EXCEPTION 'forbidden_suggestion_outlet_to_warehouse'
          USING ERRCODE = '42501';
      END IF;

    ELSE
      RAISE EXCEPTION 'unsupported_route_kind: %', p_suggestion.route_kind
        USING ERRCODE = '23514';
  END CASE;
END;
$$;

REVOKE ALL ON FUNCTION public._phoenix_authorize_suggestion_draft_route_v1(
  uuid, public.inventory_transfer_suggestions
) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._phoenix_authorize_suggestion_draft_route_v1(
  uuid, public.inventory_transfer_suggestions
) IS
  'PHASE-7-151: internal fail-closed route policy gate. Requires the exact '
  'source-scoped corridor permission for the suggestion route and an active '
  'actor through phoenix_profile_has_scoped_permission. No public execution.';

CREATE OR REPLACE FUNCTION public._phoenix_150_delegate_create_transfer_draft_from_suggestion(
  p_suggestion_id uuid,
  p_document_number text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_doc text := NULLIF(btrim(p_document_number), '');
  v_s public.inventory_transfer_suggestions%ROWTYPE;
  v_initial_source_org uuid;
  v_initial_target_org uuid;
  v_policy_minutes integer;
  v_src_key text;
  v_tgt_key text;
  v_src_threshold_key text;
  v_tgt_threshold_key text;
  v_lock_a text;
  v_lock_b text;
  v_src_pos record;
  v_tgt_pos record;
  v_headroom integer;
  v_deficit integer;
  v_batch_available integer;
  v_batch_committed integer;
  v_batch_remaining integer;
  v_returnable integer;
  v_eligible integer;
  v_src_central_item_id uuid;
  v_src_concentration text;
  v_src_dosage_form text;
  v_src_unit text;
  v_src_scientific_name text;
  v_create_result jsonb;
  v_line_result jsonb;
  v_request_id uuid;
  v_request_line_id uuid;
  v_dispatch_id uuid;
  v_dispatch_line_id uuid;
  v_return_request_id uuid;
  v_return_request_line_id uuid;
  r record;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF v_doc IS NULL THEN RAISE EXCEPTION 'document_number_required'; END IF;

  SELECT * INTO v_s
  FROM public.inventory_transfer_suggestions
  WHERE id = p_suggestion_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'suggestion_not_found'; END IF;
  v_initial_source_org := v_s.source_organization_id;
  v_initial_target_org := v_s.target_organization_id;

  v_lock_a := LEAST(v_initial_source_org::text, v_initial_target_org::text);
  v_lock_b := GREATEST(v_initial_source_org::text, v_initial_target_org::text);
  PERFORM public._phoenix_lock_inventory_resources(ARRAY[
    'inv_suggest:' || v_lock_a,
    'inv_suggest:' || v_lock_b
  ]);

  SELECT * INTO v_s
  FROM public.inventory_transfer_suggestions
  WHERE id = p_suggestion_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'suggestion_not_found'; END IF;
  IF v_s.source_organization_id IS DISTINCT FROM v_initial_source_org
     OR v_s.target_organization_id IS DISTINCT FROM v_initial_target_org THEN
    RAISE EXCEPTION 'suggestion_changed_retry';
  END IF;

  IF v_s.status = 'accepted' THEN
    IF v_s.accepted_by = v_actor THEN
      IF v_s.lineage_state = 'line_deleted' THEN
        RAISE EXCEPTION 'suggestion_draft_line_deleted';
      END IF;
      RETURN jsonb_build_object(
        'ok', true, 'suggestion_id', v_s.id, 'idempotent_replay', true,
        'route_kind', v_s.route_kind, 'quantity', v_s.suggested_quantity,
        'document_number', v_s.draft_document_number,
        'warehouse_transfer_request_id', v_s.draft_warehouse_transfer_request_id,
        'warehouse_transfer_request_line_id', v_s.draft_warehouse_transfer_request_line_id,
        'warehouse_dispatch_id', v_s.draft_warehouse_dispatch_id,
        'warehouse_dispatch_line_id', v_s.draft_warehouse_dispatch_line_id,
        'outlet_return_request_id', v_s.draft_outlet_return_request_id,
        'outlet_return_request_line_id', v_s.draft_outlet_return_request_line_id
      );
    END IF;
    RAISE EXCEPTION 'suggestion_already_drafted';
  END IF;
  IF v_s.status <> 'open' THEN RAISE EXCEPTION 'suggestion_not_open'; END IF;

  PERFORM public._phoenix_authorize_suggestion_draft_route_v1(v_actor, v_s);

  SELECT staleness_minutes INTO v_policy_minutes
  FROM public.inventory_suggestion_policy
  WHERE organization_id = v_s.source_organization_id;
  IF v_s.last_validated_at IS NULL
     OR v_s.last_validated_at < now() - make_interval(mins => COALESCE(v_policy_minutes, 30)) THEN
    UPDATE public.inventory_transfer_suggestions
    SET status = 'expired', updated_at = now()
    WHERE id = v_s.id;
    RAISE EXCEPTION 'suggestion_stale_revalidate_required';
  END IF;

  v_src_key := 'inv_position:' || v_s.source_organization_id::text || ':'
               || v_s.source_scope_kind || ':' || v_s.source_scope_id::text || ':'
               || lower(btrim(v_s.scientific_name)) || ':'
               || COALESCE(NULLIF(btrim(v_s.national_code), ''), '*');
  v_tgt_key := 'inv_position:' || v_s.target_organization_id::text || ':'
               || v_s.target_scope_kind || ':' || v_s.target_scope_id::text || ':'
               || lower(btrim(v_s.scientific_name)) || ':'
               || COALESCE(NULLIF(btrim(v_s.national_code), ''), '*');
  v_src_threshold_key := 'inv_threshold:' || v_s.source_organization_id::text || ':'
                         || v_s.source_scope_kind || ':' || lower(btrim(v_s.scientific_name));
  v_tgt_threshold_key := 'inv_threshold:' || v_s.target_organization_id::text || ':'
                         || v_s.target_scope_kind || ':' || lower(btrim(v_s.scientific_name));

  IF v_s.route_kind = 'outlet_to_warehouse' THEN
    PERFORM public._phoenix_lock_inventory_resources(ARRAY[
      'inv_provline:' || v_s.provenance_dispatch_line_id::text
    ]);
  END IF;
  PERFORM public._phoenix_lock_inventory_resources(ARRAY[
    v_src_key, v_tgt_key, v_src_threshold_key, v_tgt_threshold_key
  ]);

  IF v_s.route_kind = 'outlet_to_warehouse' THEN
    PERFORM 1
    FROM public.warehouse_dispatch_lines wdl
    WHERE wdl.id = v_s.provenance_dispatch_line_id
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'suggestion_no_longer_available: provenance_gone';
    END IF;
  END IF;

  FOR r IN
    SELECT *
    FROM (VALUES
      (v_s.source_scope_kind, v_s.source_scope_id, v_s.source_organization_id),
      (v_s.target_scope_kind, v_s.target_scope_id, v_s.target_organization_id)
    ) AS x(scope_kind, scope_id, organization_id)
    ORDER BY scope_kind, scope_id
  LOOP
    IF r.scope_kind = 'warehouse' THEN
      PERFORM 1 FROM public.warehouses w
      WHERE w.id = r.scope_id AND w.organization_id = r.organization_id
      FOR UPDATE;
    ELSE
      PERFORM 1 FROM public.distribution_points dp
      WHERE dp.id = r.scope_id AND dp.organization_id = r.organization_id
      FOR UPDATE;
    END IF;
    IF NOT FOUND THEN RAISE EXCEPTION 'scope_not_in_organization'; END IF;
  END LOOP;

  FOR r IN
    SELECT q.stock_kind, q.stock_id
    FROM (
      SELECT 'warehouse'::text AS stock_kind, ws.id AS stock_id
      FROM public.warehouse_stock ws
      WHERE lower(ws.scientific_name) = lower(btrim(v_s.scientific_name))
        AND (v_s.national_code IS NULL OR ws.national_code IS NOT DISTINCT FROM v_s.national_code)
        AND (
          (v_s.source_scope_kind = 'warehouse'
           AND ws.organization_id = v_s.source_organization_id
           AND ws.warehouse_id = v_s.source_scope_id)
          OR
          (v_s.target_scope_kind = 'warehouse'
           AND ws.organization_id = v_s.target_organization_id
           AND ws.warehouse_id = v_s.target_scope_id)
        )
      UNION ALL
      SELECT 'outlet'::text AS stock_kind, os.id AS stock_id
      FROM public.outlet_stock os
      WHERE lower(os.scientific_name) = lower(btrim(v_s.scientific_name))
        AND (v_s.national_code IS NULL OR os.national_code IS NOT DISTINCT FROM v_s.national_code)
        AND (
          (v_s.source_scope_kind = 'outlet'
           AND os.organization_id = v_s.source_organization_id
           AND os.distribution_point_id = v_s.source_scope_id)
          OR
          (v_s.target_scope_kind = 'outlet'
           AND os.organization_id = v_s.target_organization_id
           AND os.distribution_point_id = v_s.target_scope_id)
        )
    ) q
    ORDER BY q.stock_kind, q.stock_id
  LOOP
    IF r.stock_kind = 'warehouse' THEN
      PERFORM 1 FROM public.warehouse_stock ws WHERE ws.id = r.stock_id FOR UPDATE;
    ELSE
      PERFORM 1 FROM public.outlet_stock os WHERE os.id = r.stock_id FOR UPDATE;
    END IF;
  END LOOP;

  SELECT * INTO v_src_pos FROM public._phoenix_live_suggestion_scope_position(
    v_s.source_organization_id, v_s.source_scope_kind, v_s.source_scope_id,
    v_s.scientific_name, v_s.national_code);
  SELECT * INTO v_tgt_pos FROM public._phoenix_live_suggestion_scope_position(
    v_s.target_organization_id, v_s.target_scope_kind, v_s.target_scope_id,
    v_s.scientific_name, v_s.national_code);

  v_headroom := GREATEST(
    COALESCE(v_src_pos.live_available, 0) - COALESCE(v_src_pos.target_max, 0), 0
  );
  IF v_headroom <= 0 THEN
    RAISE EXCEPTION 'suggestion_no_longer_available: no_source_surplus';
  END IF;
  v_headroom := v_headroom - COALESCE((
    SELECT sum(c.source_commitment)
    FROM public.inventory_transfer_suggestions s
    CROSS JOIN LATERAL public.phoenix_inventory_suggestion_commitments(s.id) c
    WHERE s.source_scope_kind = v_s.source_scope_kind
      AND s.source_scope_id = v_s.source_scope_id
      AND s.source_organization_id = v_s.source_organization_id
      AND lower(s.scientific_name) = lower(v_s.scientific_name)
      AND s.national_code IS NOT DISTINCT FROM v_s.national_code
      AND s.id <> v_s.id
      AND c.is_active
  ), 0);
  IF v_headroom <= 0 THEN
    RAISE EXCEPTION 'suggestion_no_longer_available: source_surplus_committed';
  END IF;

  v_deficit := GREATEST(
    COALESCE(v_tgt_pos.reorder_point, 0) - COALESCE(v_tgt_pos.live_available, 0), 0
  );
  IF v_deficit <= 0 THEN
    RAISE EXCEPTION 'suggestion_no_longer_available: no_target_shortfall';
  END IF;
  v_deficit := v_deficit - COALESCE((
    SELECT sum(c.target_commitment)
    FROM public.inventory_transfer_suggestions s
    CROSS JOIN LATERAL public.phoenix_inventory_suggestion_commitments(s.id) c
    WHERE s.target_scope_kind = v_s.target_scope_kind
      AND s.target_scope_id = v_s.target_scope_id
      AND s.target_organization_id = v_s.target_organization_id
      AND lower(s.scientific_name) = lower(v_s.scientific_name)
      AND s.national_code IS NOT DISTINCT FROM v_s.national_code
      AND s.id <> v_s.id
      AND c.is_active
  ), 0);
  IF v_deficit <= 0 THEN
    RAISE EXCEPTION 'suggestion_no_longer_available: target_shortfall_committed';
  END IF;

  IF v_s.source_scope_kind = 'warehouse' THEN
    SELECT ws.available_quantity, ws.central_item_id, ws.concentration,
           ws.dosage_form, ws.unit, ws.scientific_name
      INTO v_batch_available, v_src_central_item_id, v_src_concentration,
           v_src_dosage_form, v_src_unit, v_src_scientific_name
    FROM public.warehouse_stock ws
    WHERE ws.id = v_s.source_stock_id
      AND ws.warehouse_id = v_s.source_scope_id
      AND ws.organization_id = v_s.source_organization_id
      AND lower(ws.scientific_name) = lower(v_s.scientific_name)
      AND (v_s.national_code IS NULL OR ws.national_code = v_s.national_code)
      AND (ws.expiry_date IS NULL OR ws.expiry_date >= current_date)
    FOR UPDATE;
  ELSE
    SELECT os.available_quantity, os.central_item_id, os.concentration,
           os.dosage_form, os.unit, os.scientific_name
      INTO v_batch_available, v_src_central_item_id, v_src_concentration,
           v_src_dosage_form, v_src_unit, v_src_scientific_name
    FROM public.outlet_stock os
    WHERE os.id = v_s.source_stock_id
      AND os.distribution_point_id = v_s.source_scope_id
      AND os.organization_id = v_s.source_organization_id
      AND lower(os.scientific_name) = lower(v_s.scientific_name)
      AND (v_s.national_code IS NULL OR os.national_code = v_s.national_code)
      AND (os.expiry_date IS NULL OR os.expiry_date >= current_date)
    FOR UPDATE;
  END IF;
  IF v_batch_available IS NULL THEN
    RAISE EXCEPTION 'suggestion_no_longer_available: batch_gone_or_identity_mismatch';
  END IF;

  SELECT COALESCE(sum(c.batch_commitment), 0)::integer
    INTO v_batch_committed
  FROM public.inventory_transfer_suggestions s
  CROSS JOIN LATERAL public.phoenix_inventory_suggestion_commitments(s.id) c
  WHERE s.source_stock_id = v_s.source_stock_id
    AND s.id <> v_s.id
    AND c.is_active;
  v_batch_remaining := v_batch_available - v_batch_committed;

  IF v_s.route_kind = 'outlet_to_warehouse' THEN
    SELECT COALESCE(wdl.received_quantity, 0) - wdl.returned_quantity
      INTO v_returnable
    FROM public.warehouse_dispatch_lines wdl
    WHERE wdl.id = v_s.provenance_dispatch_line_id
      AND wdl.status IN ('accepted', 'accepted_with_difference')
    FOR SHARE;
    IF v_returnable IS NULL THEN
      RAISE EXCEPTION 'suggestion_no_longer_available: provenance_gone';
    END IF;
    v_batch_remaining := LEAST(v_batch_remaining, v_returnable - COALESCE((
      SELECT sum(c.provenance_commitment)
      FROM public.inventory_transfer_suggestions s
      CROSS JOIN LATERAL public.phoenix_inventory_suggestion_commitments(s.id) c
      WHERE s.provenance_dispatch_line_id = v_s.provenance_dispatch_line_id
        AND s.id <> v_s.id
        AND c.is_active
    ), 0));
  END IF;

  v_eligible := LEAST(v_s.suggested_quantity, v_headroom, v_deficit, v_batch_remaining);
  IF v_eligible IS NULL OR v_eligible <= 0 THEN
    RAISE EXCEPTION 'suggestion_no_longer_available: eligible_quantity_zero';
  END IF;

  IF v_s.route_kind = 'central_to_institution' THEN
    v_create_result := public.phoenix_create_direct_warehouse_transfer_request(
      v_s.source_scope_id, v_s.target_organization_id, v_s.target_scope_id,
      v_doc, 'Auto-drafted from inventory suggestion ' || v_s.id::text);
    v_request_id := (v_create_result->>'transfer_request_id')::uuid;
    v_line_result := public.phoenix_add_warehouse_transfer_request_line(
      v_request_id, v_src_scientific_name, v_eligible, v_src_central_item_id,
      v_src_concentration, v_src_dosage_form, v_src_unit, NULL);
    v_request_line_id := (v_line_result->>'transfer_request_line_id')::uuid;

  ELSIF v_s.route_kind = 'warehouse_to_outlet' THEN
    v_create_result := public.phoenix_create_warehouse_dispatch(
      v_s.source_scope_id, v_s.target_scope_id, v_doc, NULL, NULL, NULL);
    v_dispatch_id := (v_create_result->>'dispatch_id')::uuid;
    v_line_result := public.phoenix_add_dispatch_line_fefo_guarded(
      v_dispatch_id, v_s.source_stock_id, v_eligible, false, NULL, p_suggestion_id);
    v_dispatch_line_id := (v_line_result->>'dispatch_line_id')::uuid;

  ELSIF v_s.route_kind = 'outlet_to_warehouse' THEN
    v_create_result := public.phoenix_request_outlet_return(
      v_s.source_scope_id, v_doc,
      'Auto-drafted from inventory suggestion ' || v_s.id::text);
    v_return_request_id := (v_create_result->>'return_request_id')::uuid;
    v_line_result := public.phoenix_add_outlet_return_request_line(
      v_return_request_id, v_s.provenance_dispatch_line_id, v_eligible,
      'excess', 'Auto-drafted from inventory suggestion ' || v_s.id::text);
    v_return_request_line_id := (v_line_result->>'return_request_line_id')::uuid;
  ELSE
    RAISE EXCEPTION 'unsupported_route_kind: %', v_s.route_kind;
  END IF;

  IF (v_s.route_kind = 'central_to_institution' AND v_request_line_id IS NULL)
     OR (v_s.route_kind = 'warehouse_to_outlet' AND v_dispatch_line_id IS NULL)
     OR (v_s.route_kind = 'outlet_to_warehouse' AND v_return_request_line_id IS NULL) THEN
    RAISE EXCEPTION 'draft_line_id_missing';
  END IF;

  UPDATE public.inventory_transfer_suggestions
  SET status = 'accepted',
      accepted_at = now(),
      accepted_by = v_actor,
      draft_document_number = v_doc,
      draft_warehouse_transfer_request_id = v_request_id,
      draft_warehouse_transfer_request_line_id = v_request_line_id,
      draft_warehouse_dispatch_id = v_dispatch_id,
      draft_warehouse_dispatch_line_id = v_dispatch_line_id,
      draft_outlet_return_request_id = v_return_request_id,
      draft_outlet_return_request_line_id = v_return_request_line_id,
      lineage_version = 1,
      lineage_state = 'linked',
      suggested_quantity = v_eligible,
      updated_at = now()
  WHERE id = p_suggestion_id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action,
    entity_type, entity_id, entity_label, payload
  )
  VALUES (
    v_s.target_organization_id, v_actor, public.phoenix_my_role(), 'update',
    'inventory_transfer_suggestion', p_suggestion_id,
    v_s.route_kind || ':' || v_s.scientific_name,
    jsonb_build_object(
      'lifecycle', 'draft_created',
      'document_number', v_doc,
      'quantity', v_eligible,
      'route_kind', v_s.route_kind,
      'warehouse_transfer_request_line_id', v_request_line_id,
      'warehouse_dispatch_line_id', v_dispatch_line_id,
      'outlet_return_request_line_id', v_return_request_line_id
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'suggestion_id', p_suggestion_id, 'status', 'accepted',
    'quantity', v_eligible, 'route_kind', v_s.route_kind,
    'document_number', v_doc,
    'warehouse_transfer_request_id', v_request_id,
    'warehouse_transfer_request_line_id', v_request_line_id,
    'warehouse_dispatch_id', v_dispatch_id,
    'warehouse_dispatch_line_id', v_dispatch_line_id,
    'outlet_return_request_id', v_return_request_id,
    'outlet_return_request_line_id', v_return_request_line_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public._phoenix_150_delegate_create_transfer_draft_from_suggestion(
  uuid, text
) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._phoenix_150_delegate_create_transfer_draft_from_suggestion(
  uuid, text
) IS
  'PHASE-7-151: internal Draft bridge delegate. Uses the route-specific '
  'source-scoped policy gate within the unchanged 4B lock protocol, live eligibility, '
  'lineage, FEFO/provenance, idempotency, and corridor RPCs.';

-- Migration 150's outer identity wrapper referenced
-- outlet_return_request_lines.central_item_id, but that corridor line has no
-- such column. The source suggestion identity is already resolved from the
-- exact outlet_stock row and the lineage predicates below pin the returned
-- line to that source stock and provenance. Reuse that proven central_item_id
-- while still recomputing the complete line tuple.
CREATE OR REPLACE FUNCTION public.phoenix_create_transfer_draft_from_suggestion(
  p_suggestion_id uuid,
  p_document_number text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_s public.inventory_transfer_suggestions%ROWTYPE;
  v_source_key text;
  v_result jsonb;
  v_line_key text;
  v_line_id uuid;
  v_line record;
BEGIN
  SELECT * INTO v_s FROM public.inventory_transfer_suggestions
  WHERE id=p_suggestion_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'suggestion_not_found'; END IF;

  -- Fail before material/resource locks or identity diagnostics. The delegate
  -- repeats this same centralized decision after locking the suggestion row.
  PERFORM public._phoenix_authorize_suggestion_draft_route_v1(v_actor, v_s);

  IF v_s.material_identity_state<>'resolved'
     OR v_s.material_identity_version<>1 OR v_s.material_identity_key IS NULL THEN
    RAISE EXCEPTION 'suggestion_material_identity_unresolved';
  END IF;

  IF v_s.source_scope_kind='warehouse' THEN
    SELECT ws.material_identity_key INTO v_source_key
    FROM public.warehouse_stock ws
    WHERE ws.id=v_s.source_stock_id
      AND ws.organization_id=v_s.source_organization_id
      AND ws.warehouse_id=v_s.source_scope_id;
  ELSE
    SELECT os.material_identity_key INTO v_source_key
    FROM public.outlet_stock os
    WHERE os.id=v_s.source_stock_id
      AND os.organization_id=v_s.source_organization_id
      AND os.distribution_point_id=v_s.source_scope_id;
  END IF;
  IF v_source_key IS DISTINCT FROM v_s.material_identity_key THEN
    RAISE EXCEPTION 'suggestion_source_material_identity_mismatch';
  END IF;

  PERFORM public._phoenix_lock_inventory_resources(ARRAY[
    'inv_material:' || v_s.material_identity_key
  ]);
  PERFORM set_config('phoenix.material_identity_v1',v_s.material_identity_key,true);

  v_result:=public._phoenix_150_delegate_create_transfer_draft_from_suggestion(
    p_suggestion_id,p_document_number
  );

  IF v_s.route_kind='central_to_institution' THEN
    v_line_id:=(v_result->>'warehouse_transfer_request_line_id')::uuid;
    SELECT l.* INTO v_line FROM public.warehouse_transfer_request_lines l
    WHERE l.id=v_line_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'draft_line_id_missing'; END IF;
    v_line_key:=public._phoenix_material_identity_v1(
      v_line.central_item_id,v_line.scientific_name,v_s.national_code,
      v_line.concentration,v_line.dosage_form,v_line.unit
    );
  ELSIF v_s.route_kind='warehouse_to_outlet' THEN
    v_line_id:=(v_result->>'warehouse_dispatch_line_id')::uuid;
    SELECT l.* INTO v_line FROM public.warehouse_dispatch_lines l
    WHERE l.id=v_line_id AND l.warehouse_stock_id=v_s.source_stock_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'draft_line_id_missing'; END IF;
    v_line_key:=public._phoenix_material_identity_v1(
      v_line.central_item_id,v_line.scientific_name,v_line.national_code,
      v_line.concentration,v_line.dosage_form,v_line.unit
    );
  ELSIF v_s.route_kind='outlet_to_warehouse' THEN
    v_line_id:=(v_result->>'outlet_return_request_line_id')::uuid;
    SELECT l.* INTO v_line FROM public.outlet_return_request_lines l
    WHERE l.id=v_line_id AND l.source_outlet_stock_id=v_s.source_stock_id
      AND l.original_dispatch_line_id=v_s.provenance_dispatch_line_id
      AND l.original_inbound_movement_id=v_s.provenance_inbound_movement_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'draft_line_id_missing'; END IF;
    v_line_key:=public._phoenix_material_identity_v1(
      v_s.central_item_id,v_line.scientific_name,v_line.national_code,
      v_line.concentration,v_line.dosage_form,v_line.unit
    );
  ELSE
    RAISE EXCEPTION 'unsupported_route_kind: %',v_s.route_kind;
  END IF;

  IF v_line_key IS DISTINCT FROM v_s.material_identity_key THEN
    RAISE EXCEPTION 'draft_line_material_identity_mismatch';
  END IF;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_create_transfer_draft_from_suggestion(uuid,text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_create_transfer_draft_from_suggestion(uuid,text)
  TO authenticated;

DO $$
DECLARE
  v_gate_def text;
  v_bridge_def text;
BEGIN
  v_gate_def := pg_get_functiondef(
    'public._phoenix_authorize_suggestion_draft_route_v1(uuid,public.inventory_transfer_suggestions)'
      ::regprocedure
  );
  v_bridge_def := pg_get_functiondef(
    'public._phoenix_150_delegate_create_transfer_draft_from_suggestion(uuid,text)'
      ::regprocedure
  );

  IF v_gate_def NOT LIKE '%SECURITY DEFINER%'
     OR v_gate_def NOT LIKE '%SET search_path TO ''public'', ''pg_temp''%'
     OR v_gate_def NOT LIKE '%warehouse_transfer.send%'
     OR v_gate_def NOT LIKE '%warehouse_dispatch.create%'
     OR v_gate_def NOT LIKE '%outlet_stock.return_request%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (151): route policy helper contract drift';
  END IF;

  IF v_bridge_def NOT LIKE '%_phoenix_authorize_suggestion_draft_route_v1%'
     OR v_bridge_def LIKE '%inventory.act_on_suggestions%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (151): bridge still uses the broad queue key';
  END IF;

  IF EXISTS (
       SELECT 1
       FROM pg_proc p
       CROSS JOIN LATERAL aclexplode(
         COALESCE(p.proacl, acldefault('f', p.proowner))
       ) acl
       WHERE p.oid =
         'public._phoenix_authorize_suggestion_draft_route_v1(uuid,public.inventory_transfer_suggestions)'
           ::regprocedure
         AND acl.grantee = 0
         AND acl.privilege_type = 'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public._phoenix_authorize_suggestion_draft_route_v1(uuid,public.inventory_transfer_suggestions)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public._phoenix_authorize_suggestion_draft_route_v1(uuid,public.inventory_transfer_suggestions)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (151): internal route policy helper is executable publicly';
  END IF;

  IF NOT has_function_privilege(
       'authenticated',
       'public.phoenix_create_transfer_draft_from_suggestion(uuid,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.phoenix_create_transfer_draft_from_suggestion(uuid,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (151): public bridge ACL drift';
  END IF;

  IF (SELECT allowed FROM public.role_permission_defaults
      WHERE role='outlet_officer' AND permission_key='inventory.act_on_suggestions')
       IS DISTINCT FROM false
     OR (SELECT allowed FROM public.role_permission_defaults
         WHERE role='outlet_officer' AND permission_key='outlet_stock.return_request')
       IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'VERIFY FAILED (151): role defaults were broadened or regressed';
  END IF;
END;
$$;

COMMIT;
