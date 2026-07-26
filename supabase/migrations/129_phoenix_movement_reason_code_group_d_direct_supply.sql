-- ============================================================================
-- MOVEMENT-REASON-CODE-GROUP-D-DIRECT-SUPPLY-129
--
-- Twelfth slice of Unified Movements & Outlet Operations (PR #57, item A).
-- Fourth of eight domain slices wiring reason_code + server-owned
-- correlation_id/causation_id into the 20 audited ledger-writer RPCs.
--
-- GROUP D — direct central<->institution transfer/return send (077), the
-- route-free structural twins of Groups B and C's send functions. The
-- corresponding RECEIVE functions (phoenix_receive_warehouse_transfer_line,
-- phoenix_receive_warehouse_return_shipment_line) are SHARED between the
-- routed and direct corridors — they were already fixed in migrations
-- 127/128 and need no further change here; a direct send's line lands in
-- the exact same warehouse_transfer_lines/warehouse_return_shipment_lines
-- tables those receive functions already read source_movement_id from.
--
--   * phoenix_send_direct_warehouse_transfer_line (077) — identical fix to
--     127's phoenix_send_warehouse_transfer_line: reason_code hardcoded to
--     'transferred', fresh correlation_id (the mandatory
--     p_transfer_request_id is a request, not a movement, so still no
--     correlation_id to inherit), causation_id NULL, and the same
--     source_movement_id population immediately after the movement INSERT
--     (the column already exists on warehouse_transfer_lines since 127 —
--     no new schema in this migration).
--
--   * phoenix_send_direct_warehouse_return_shipment_line (077) — identical
--     fix to 128's phoenix_send_warehouse_return_shipment_line: propagates
--     v_reqline.reason_code verbatim (the same 9-value closed vocabulary,
--     same table), fresh correlation_id, causation_id NULL, and
--     source_movement_id population (warehouse_return_shipment_lines'
--     column already exists since 128).
--
-- Neither function's signature changes.
--
-- PRECONDITIONS: 128 applied (Group C slice; both source_movement_id
--   columns already exist).
-- ============================================================================

DO $precond$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'warehouse_return_shipment_lines'
       AND column_name = 'source_movement_id'
  ) THEN
    RAISE EXCEPTION '129 PRECONDITION FAILED: 128 (Group C slice) missing — apply 128 first';
  END IF;
END;
$precond$;

-- ── D1. phoenix_send_direct_warehouse_transfer_line — reason_code='transferred' ─

CREATE OR REPLACE FUNCTION public.phoenix_send_direct_warehouse_transfer_line(
  p_request_id               uuid,
  p_transfer_request_id      uuid,
  p_warehouse_stock_id       uuid,
  p_quantity                 integer,
  p_transfer_number          text,
  p_transfer_request_line_id uuid DEFAULT NULL,
  p_document_number          text DEFAULT NULL,
  p_notes                    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor        uuid := auth.uid();
  v_actor_role   text;
  v_actor_name   text;
  v_req          public.warehouse_transfer_requests%ROWTYPE;
  v_stock        public.warehouse_stock%ROWTYPE;
  v_src_org      uuid;
  v_dest_org     uuid;
  v_transfer     public.warehouse_transfers%ROWTYPE;
  v_existing     public.warehouse_stock_movements%ROWTYPE;
  v_reqline      public.warehouse_transfer_request_lines%ROWTYPE;
  v_number       text := NULLIF(btrim(p_transfer_number), '');
  v_doc          text := NULLIF(btrim(p_document_number), '');
  v_notes        text := NULLIF(btrim(p_notes), '');
  v_before       integer;
  v_after        integer;
  v_line_id      uuid;
  v_movement_id  uuid;
  v_fingerprint  text;
  v_correlation_id uuid := gen_random_uuid();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL OR p_transfer_request_id IS NULL THEN
    RAISE EXCEPTION 'request_and_transfer_request_required' USING ERRCODE = '23514';
  END IF;
  IF p_warehouse_stock_id IS NULL THEN
    RAISE EXCEPTION 'warehouse_stock_required' USING ERRCODE = '23514';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;
  IF v_number IS NULL THEN
    RAISE EXCEPTION 'transfer_number_required' USING ERRCODE = '23514';
  END IF;

  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'direct_transfer_send',
    'transfer_request_id', p_transfer_request_id,
    'warehouse_stock_id', p_warehouse_stock_id,
    'quantity', p_quantity,
    'transfer_number', v_number,
    'transfer_request_line_id', p_transfer_request_line_id,
    'document_number', v_doc,
    'notes', v_notes
  )::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 68068));

  SELECT * INTO v_existing
  FROM public.warehouse_stock_movements m
  WHERE m.reference_type = 'warehouse_transfer_send' AND m.reference_id = p_request_id;

  IF FOUND THEN
    IF v_existing.warehouse_stock_id IS DISTINCT FROM p_warehouse_stock_id
       OR v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true,
      'warehouse_stock_id', v_existing.warehouse_stock_id,
      'movement_id', v_existing.id,
      'quantity_before', v_existing.on_hand_before,
      'quantity_delta', v_existing.on_hand_delta,
      'quantity_after', v_existing.on_hand_after
    );
  END IF;

  SELECT * INTO v_req
  FROM public.warehouse_transfer_requests WHERE id = p_transfer_request_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transfer_request_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_req.route_id IS NOT NULL THEN
    RAISE EXCEPTION 'not_a_direct_request' USING ERRCODE = '23514';
  END IF;
  IF v_req.status NOT IN ('approved', 'partially_approved', 'partially_fulfilled') THEN
    RAISE EXCEPTION 'transfer_request_not_approved' USING ERRCODE = '23514';
  END IF;

  SELECT o_source_organization_id, o_destination_organization_id
    INTO v_src_org, v_dest_org
  FROM public.phoenix_assert_direct_supply_endpoints(
         v_req.source_warehouse_id, v_req.destination_warehouse_id,
         v_req.destination_organization_id);

  SELECT * INTO v_stock
  FROM public.warehouse_stock WHERE id = p_warehouse_stock_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse_stock_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_stock.warehouse_id IS DISTINCT FROM v_req.source_warehouse_id THEN
    RAISE EXCEPTION 'stock_not_in_source_warehouse' USING ERRCODE = '42501';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'warehouse_transfer.send', v_stock.organization_id, v_stock.warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_warehouse_transfer_send' USING ERRCODE = '42501';
  END IF;

  SELECT p.role, p.full_name INTO v_actor_role, v_actor_name
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  IF v_stock.expiry_date IS NOT NULL AND v_stock.expiry_date < current_date THEN
    RAISE EXCEPTION 'expired_batch_cannot_be_sent' USING ERRCODE = '23514';
  END IF;

  v_before := v_stock.on_hand_quantity;
  v_after  := v_before - p_quantity;
  IF v_after < 0 THEN
    RAISE EXCEPTION 'warehouse_quantity_cannot_go_negative' USING ERRCODE = '23514';
  END IF;
  IF v_after < v_stock.reserved_quantity THEN
    RAISE EXCEPTION 'warehouse_quantity_below_reserved' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_transfer
  FROM public.warehouse_transfers
  WHERE source_organization_id = v_stock.organization_id
    AND btrim(transfer_number) = v_number
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.warehouse_transfers (
      route_id, transfer_request_id,
      source_warehouse_id, source_organization_id,
      destination_warehouse_id, destination_organization_id,
      transfer_number, status, document_number, notes, sent_by, sent_at
    ) VALUES (
      NULL, NULL,
      v_req.source_warehouse_id, v_stock.organization_id,
      v_req.destination_warehouse_id, v_dest_org,
      v_number, 'in_transit', v_doc, v_notes, v_actor, now()
    )
    RETURNING * INTO v_transfer;
  ELSE
    IF v_transfer.route_id IS NOT NULL
       OR v_transfer.source_warehouse_id IS DISTINCT FROM v_req.source_warehouse_id
       OR v_transfer.destination_warehouse_id IS DISTINCT FROM v_req.destination_warehouse_id THEN
      RAISE EXCEPTION 'transfer_number_endpoint_conflict' USING ERRCODE = '23505';
    END IF;
    IF v_transfer.status <> 'in_transit' THEN
      RAISE EXCEPTION 'transfer_already_being_received' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF p_transfer_request_line_id IS NOT NULL THEN
    SELECT l.* INTO v_reqline
    FROM public.warehouse_transfer_request_lines l
    WHERE l.id = p_transfer_request_line_id AND l.transfer_request_id = v_req.id
    FOR UPDATE OF l;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'request_line_not_found_for_request' USING ERRCODE = 'P0002';
    END IF;
    IF v_reqline.status NOT IN ('approved', 'partially_fulfilled') THEN
      RAISE EXCEPTION 'request_line_not_approved' USING ERRCODE = '23514';
    END IF;
    IF v_reqline.fulfilled_quantity + p_quantity > v_reqline.approved_quantity THEN
      RAISE EXCEPTION 'request_line_would_be_over_fulfilled' USING ERRCODE = '23514';
    END IF;

    UPDATE public.warehouse_transfer_request_lines
       SET fulfilled_quantity = fulfilled_quantity + p_quantity,
           status = CASE WHEN fulfilled_quantity + p_quantity >= approved_quantity
                         THEN 'fulfilled' ELSE 'partially_fulfilled' END
     WHERE id = v_reqline.id;

    UPDATE public.warehouse_transfer_requests
       SET status = CASE WHEN NOT EXISTS (
                           SELECT 1 FROM public.warehouse_transfer_request_lines x
                           WHERE x.transfer_request_id = v_reqline.transfer_request_id
                             AND x.status NOT IN ('fulfilled', 'rejected', 'cancelled'))
                         THEN 'fulfilled' ELSE 'partially_fulfilled' END
     WHERE id = v_reqline.transfer_request_id;

    UPDATE public.warehouse_transfers
       SET transfer_request_id = COALESCE(transfer_request_id, v_reqline.transfer_request_id)
     WHERE id = v_transfer.id;
  END IF;

  UPDATE public.warehouse_stock
     SET on_hand_quantity = v_after,
         updated_by       = v_actor
   WHERE id = v_stock.id;

  INSERT INTO public.warehouse_transfer_lines (
    transfer_id, source_organization_id, source_warehouse_stock_id,
    transfer_request_line_id, central_item_id,
    scientific_name, trade_name, concentration, dosage_form, unit,
    national_code, has_no_national_code,
    batch_number, has_no_batch_number, internal_batch_reference,
    expiry_date, unit_price, price_basis, currency, supply_type_text,
    sent_quantity, status
  ) VALUES (
    v_transfer.id, v_stock.organization_id, v_stock.id,
    p_transfer_request_line_id, v_stock.central_item_id,
    v_stock.scientific_name, v_stock.trade_name, v_stock.concentration,
    v_stock.dosage_form, v_stock.unit,
    v_stock.national_code, v_stock.has_no_national_code,
    v_stock.batch_number, v_stock.has_no_batch_number, v_stock.internal_batch_reference,
    v_stock.expiry_date, v_stock.unit_price, v_stock.price_basis,
    v_stock.currency, v_stock.supply_type_text,
    p_quantity, 'in_transit'
  )
  RETURNING id INTO v_line_id;

  INSERT INTO public.warehouse_stock_movements (
    warehouse_stock_id, organization_id, warehouse_id, movement_type,
    on_hand_before, on_hand_delta, on_hand_after,
    reserved_before, reserved_delta, reserved_after,
    reason, reason_code, reference_type, reference_id, request_fingerprint,
    source_document_number, actor_id, actor_role, actor_name,
    scientific_name_snapshot, concentration_snapshot,
    dosage_form_snapshot, batch_number_snapshot,
    internal_batch_reference_snapshot,
    correlation_id
  ) VALUES (
    v_stock.id, v_stock.organization_id, v_stock.warehouse_id, 'dispatch_send',
    v_before, -p_quantity, v_after,
    v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
    'warehouse_transfer_send', 'transferred', 'warehouse_transfer_send', p_request_id, v_fingerprint,
    v_doc, v_actor, v_actor_role, v_actor_name,
    v_stock.scientific_name, v_stock.concentration,
    v_stock.dosage_form, v_stock.batch_number,
    v_stock.internal_batch_reference,
    v_correlation_id
  )
  RETURNING id INTO v_movement_id;

  -- 129: same source_movement_id linkage 127 established for the routed
  -- corridor's send function — the shared receive function reads this
  -- column regardless of whether the shipment was routed or direct.
  UPDATE public.warehouse_transfer_lines
     SET source_movement_id = v_movement_id
   WHERE id = v_line_id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role,
    action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_stock.organization_id, v_actor, v_actor_role,
    'warehouse_transfer.send', 'warehouse_transfer_lines', v_line_id,
    v_stock.scientific_name,
    jsonb_build_object(
      'request_id', p_request_id,
      'direct', true,
      'transfer_request_id', v_req.id,
      'transfer_id', v_transfer.id,
      'source_warehouse_id', v_req.source_warehouse_id,
      'destination_warehouse_id', v_req.destination_warehouse_id,
      'movement_id', v_movement_id,
      'quantity_before', v_before,
      'quantity_delta', -p_quantity,
      'quantity_after', v_after
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'transfer_id', v_transfer.id,
    'transfer_line_id', v_line_id,
    'warehouse_stock_id', v_stock.id,
    'movement_id', v_movement_id,
    'in_transit_quantity', p_quantity,
    'quantity_before', v_before,
    'quantity_delta', -p_quantity,
    'quantity_after', v_after
  );
END;
$$;

-- ── D2. phoenix_send_direct_warehouse_return_shipment_line — propagates reason_code ─

CREATE OR REPLACE FUNCTION public.phoenix_send_direct_warehouse_return_shipment_line(
  p_request_id              uuid,
  p_return_request_line_id  uuid,
  p_quantity                integer,
  p_shipment_number         text,
  p_document_number         text DEFAULT NULL,
  p_notes                   text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor        uuid := auth.uid();
  v_actor_role   text;
  v_actor_name   text;
  v_reqline      public.warehouse_return_request_lines%ROWTYPE;
  v_request      public.warehouse_return_requests%ROWTYPE;
  v_orig         public.warehouse_transfer_lines%ROWTYPE;
  v_stock        public.warehouse_stock%ROWTYPE;
  v_shipment     public.warehouse_return_shipments%ROWTYPE;
  v_existing     public.warehouse_stock_movements%ROWTYPE;
  v_number       text := NULLIF(btrim(p_shipment_number), '');
  v_doc          text := NULLIF(btrim(p_document_number), '');
  v_notes        text := NULLIF(btrim(p_notes), '');
  v_before       integer;
  v_after        integer;
  v_line_id      uuid;
  v_movement_id  uuid;
  v_fingerprint  text;
  v_correlation_id uuid := gen_random_uuid();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL OR p_return_request_line_id IS NULL THEN
    RAISE EXCEPTION 'request_and_line_required' USING ERRCODE = '23514';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;
  IF v_number IS NULL THEN
    RAISE EXCEPTION 'shipment_number_required' USING ERRCODE = '23514';
  END IF;

  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'direct_return_send',
    'return_request_line_id', p_return_request_line_id,
    'quantity', p_quantity,
    'shipment_number', v_number,
    'document_number', v_doc,
    'notes', v_notes
  )::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 69069));

  SELECT * INTO v_existing
  FROM public.warehouse_stock_movements m
  WHERE m.reference_type = 'warehouse_return_send' AND m.reference_id = p_request_id;

  IF FOUND THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true,
      'warehouse_stock_id', v_existing.warehouse_stock_id,
      'movement_id', v_existing.id,
      'quantity_before', v_existing.on_hand_before,
      'quantity_delta', v_existing.on_hand_delta,
      'quantity_after', v_existing.on_hand_after
    );
  END IF;

  SELECT l.* INTO v_reqline
  FROM public.warehouse_return_request_lines l
  JOIN public.warehouse_return_requests r ON r.id = l.return_request_id
  WHERE l.id = p_return_request_line_id AND r.route_id IS NULL
  FOR UPDATE OF l;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_request_line_not_found_for_direct' USING ERRCODE = 'P0002';
  END IF;
  IF v_reqline.status NOT IN ('approved', 'partially_fulfilled') THEN
    RAISE EXCEPTION 'return_request_line_not_approved' USING ERRCODE = '23514';
  END IF;
  IF v_reqline.fulfilled_quantity + p_quantity > v_reqline.approved_quantity THEN
    RAISE EXCEPTION 'return_line_would_be_over_fulfilled' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_request
  FROM public.warehouse_return_requests WHERE id = v_reqline.return_request_id FOR UPDATE;

  PERFORM public.phoenix_assert_direct_return_endpoints(
    v_request.source_warehouse_id, v_request.destination_warehouse_id);

  SELECT * INTO v_orig
  FROM public.warehouse_transfer_lines WHERE id = v_reqline.original_transfer_line_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'original_transfer_line_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_orig.returned_quantity + p_quantity > COALESCE(v_orig.received_quantity, 0) THEN
    RAISE EXCEPTION 'original_line_would_be_over_returned' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_stock
  FROM public.warehouse_stock WHERE id = v_orig.resulting_warehouse_stock_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse_stock_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_stock.warehouse_id IS DISTINCT FROM v_request.source_warehouse_id THEN
    RAISE EXCEPTION 'stock_not_in_source_warehouse' USING ERRCODE = '42501';
  END IF;
  IF v_stock.organization_id IS DISTINCT FROM v_reqline.source_organization_id THEN
    RAISE EXCEPTION 'stock_organization_mismatch' USING ERRCODE = '42501';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'warehouse_transfer.return_send', v_stock.organization_id, v_stock.warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_warehouse_return_send' USING ERRCODE = '42501';
  END IF;

  SELECT p.role, p.full_name INTO v_actor_role, v_actor_name
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  v_before := v_stock.on_hand_quantity;
  v_after  := v_before - p_quantity;
  IF v_after < 0 THEN
    RAISE EXCEPTION 'warehouse_quantity_cannot_go_negative' USING ERRCODE = '23514';
  END IF;
  IF v_after < v_stock.reserved_quantity THEN
    RAISE EXCEPTION 'warehouse_quantity_below_reserved' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_shipment
  FROM public.warehouse_return_shipments
  WHERE source_organization_id = v_stock.organization_id
    AND btrim(shipment_number) = v_number
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.warehouse_return_shipments (
      route_id, return_request_id,
      source_warehouse_id, source_organization_id,
      destination_warehouse_id, destination_organization_id,
      shipment_number, status, document_number, notes, sent_by, sent_at
    ) VALUES (
      NULL, v_reqline.return_request_id,
      v_request.source_warehouse_id, v_stock.organization_id,
      v_request.destination_warehouse_id, v_request.destination_organization_id,
      v_number, 'in_transit', v_doc, v_notes, v_actor, now()
    )
    RETURNING * INTO v_shipment;
  ELSE
    IF v_shipment.route_id IS NOT NULL
       OR v_shipment.source_warehouse_id IS DISTINCT FROM v_request.source_warehouse_id
       OR v_shipment.destination_warehouse_id IS DISTINCT FROM v_request.destination_warehouse_id THEN
      RAISE EXCEPTION 'shipment_number_endpoint_conflict' USING ERRCODE = '23505';
    END IF;
    IF v_shipment.status <> 'in_transit' THEN
      RAISE EXCEPTION 'shipment_already_being_received' USING ERRCODE = '23514';
    END IF;
  END IF;

  UPDATE public.warehouse_return_request_lines
     SET fulfilled_quantity = fulfilled_quantity + p_quantity,
         status = CASE WHEN fulfilled_quantity + p_quantity >= approved_quantity
                       THEN 'fulfilled' ELSE 'partially_fulfilled' END
   WHERE id = v_reqline.id;

  UPDATE public.warehouse_return_requests
     SET status = CASE WHEN NOT EXISTS (
                         SELECT 1 FROM public.warehouse_return_request_lines x
                         WHERE x.return_request_id = v_reqline.return_request_id
                           AND x.status NOT IN ('fulfilled', 'rejected', 'cancelled'))
                       THEN 'fulfilled' ELSE 'partially_fulfilled' END
   WHERE id = v_reqline.return_request_id;

  UPDATE public.warehouse_transfer_lines
     SET returned_quantity = returned_quantity + p_quantity
   WHERE id = v_orig.id;

  UPDATE public.warehouse_stock
     SET on_hand_quantity = v_after,
         updated_by       = v_actor
   WHERE id = v_stock.id;

  INSERT INTO public.warehouse_return_shipment_lines (
    shipment_id, source_organization_id, source_warehouse_stock_id,
    return_request_line_id, original_transfer_line_id, central_item_id,
    scientific_name, trade_name, concentration, dosage_form, unit,
    national_code, has_no_national_code,
    batch_number, has_no_batch_number, internal_batch_reference,
    expiry_date, unit_price, price_basis, currency, supply_type_text,
    sent_quantity, status
  ) VALUES (
    v_shipment.id, v_stock.organization_id, v_stock.id,
    v_reqline.id, v_orig.id, v_stock.central_item_id,
    v_stock.scientific_name, v_stock.trade_name, v_stock.concentration,
    v_stock.dosage_form, v_stock.unit,
    v_stock.national_code, v_stock.has_no_national_code,
    v_stock.batch_number, v_stock.has_no_batch_number, v_stock.internal_batch_reference,
    v_stock.expiry_date, v_stock.unit_price, v_stock.price_basis,
    v_stock.currency, v_stock.supply_type_text,
    p_quantity, 'in_transit'
  )
  RETURNING id INTO v_line_id;

  INSERT INTO public.warehouse_stock_movements (
    warehouse_stock_id, organization_id, warehouse_id, movement_type,
    on_hand_before, on_hand_delta, on_hand_after,
    reserved_before, reserved_delta, reserved_after,
    reason, reason_code, reference_type, reference_id, request_fingerprint,
    source_document_number, actor_id, actor_role, actor_name,
    scientific_name_snapshot, concentration_snapshot,
    dosage_form_snapshot, batch_number_snapshot,
    internal_batch_reference_snapshot,
    correlation_id
  ) VALUES (
    v_stock.id, v_stock.organization_id, v_stock.warehouse_id, 'dispatch_return',
    v_before, -p_quantity, v_after,
    v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
    'warehouse_transfer_return', v_reqline.reason_code, 'warehouse_return_send', p_request_id, v_fingerprint,
    v_doc, v_actor, v_actor_role, v_actor_name,
    v_stock.scientific_name, v_stock.concentration,
    v_stock.dosage_form, v_stock.batch_number,
    v_stock.internal_batch_reference,
    v_correlation_id
  )
  RETURNING id INTO v_movement_id;

  -- 129: same source_movement_id linkage 128 established for the routed
  -- corridor's send function.
  UPDATE public.warehouse_return_shipment_lines
     SET source_movement_id = v_movement_id
   WHERE id = v_line_id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role,
    action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_stock.organization_id, v_actor, v_actor_role,
    'warehouse_transfer.return_send', 'warehouse_return_shipment_lines', v_line_id,
    v_stock.scientific_name,
    jsonb_build_object(
      'request_id', p_request_id,
      'direct', true,
      'return_request_id', v_request.id,
      'shipment_id', v_shipment.id,
      'source_warehouse_id', v_request.source_warehouse_id,
      'destination_warehouse_id', v_request.destination_warehouse_id,
      'movement_id', v_movement_id,
      'quantity_before', v_before,
      'quantity_delta', -p_quantity,
      'quantity_after', v_after
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'shipment_id', v_shipment.id,
    'shipment_line_id', v_line_id,
    'warehouse_stock_id', v_stock.id,
    'movement_id', v_movement_id,
    'in_transit_quantity', p_quantity,
    'quantity_before', v_before,
    'quantity_delta', -p_quantity,
    'quantity_after', v_after
  );
END;
$$;

DO $verify$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc p
  WHERE p.proname IN ('phoenix_send_direct_warehouse_transfer_line', 'phoenix_send_direct_warehouse_return_shipment_line')
    AND p.pronamespace = 'public'::regnamespace;
  IF v_count <> 2 THEN
    RAISE EXCEPTION '129 VERIFY FAILED: expected exactly 2 Group D functions, found %', v_count;
  END IF;

  RAISE NOTICE 'MOVEMENT-REASON-CODE-GROUP-D-DIRECT-SUPPLY-129: verified.';
END;
$verify$;
