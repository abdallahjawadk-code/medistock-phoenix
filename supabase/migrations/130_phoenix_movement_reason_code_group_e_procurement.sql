-- ============================================================================
-- MOVEMENT-REASON-CODE-GROUP-E-PROCUREMENT-130
--
-- Fourteenth slice of Unified Movements & Outlet Operations (PR #57, item
-- A). Fifth of eight domain slices wiring reason_code + server-owned
-- correlation_id/causation_id into the 20 audited ledger-writer RPCs.
--
-- GROUP E — procurement receipt (root) and return-to-supplier (chained):
--
--   * _phoenix_procurement_post_receipt_line (088) — an internal OUT-param
--     helper (never itself EXECUTE-granted to authenticated; called only by
--     its wrapping RPCs) that is the sole writer of the
--     warehouse_stock_movements row for every procurement receipt.
--     reason_code hardcoded to 'received' (same root-receipt bucket as
--     Group A/B's receive-side fixes) -- this helper has no p_reason
--     parameter at all today, so there is nothing to preserve or validate,
--     only to add. correlation_id freshly generated (true root: a
--     procurement receipt has no upstream movement). causation_id stays
--     NULL. No signature change.
--
--   * phoenix_procurement_return_to_supplier (087) — one of the six
--     confirmed free-text-to-ledger gaps in the audit: p_reason is
--     mandatory client free text with zero vocabulary check today. Gains
--     exactly one new mandatory-alongside-p_reason parameter,
--     p_reason_code, validated against the same closed anomaly subset as
--     Group A's phoenix_apply_warehouse_stock_movement (a return to the
--     supplier is exactly this kind of manual, human-observed anomaly --
--     never received/transferred/dispensed/counted/released). Unlike every
--     other CHAINED function fixed so far, no schema change is needed
--     here: procurement_receipt_lines.warehouse_stock_id's sibling column
--     movement_id (added at CREATE TABLE time in 087, populated by
--     _phoenix_procurement_post_receipt_line's OUT parameter) is ALREADY
--     the exact predecessor-movement pointer every other group had to add
--     a new column to obtain. This function already reads the full
--     procurement_receipt_lines row (v_receipt_line) for unrelated reasons
--     (capping the return quantity against what was received), so
--     v_receipt_line.movement_id is free: it becomes causation_id
--     verbatim, and its correlation_id is looked up and reused, chaining
--     the return to the exact receipt it reverses.
--
-- PRECONDITIONS: 129 applied (Group D slice).
-- ============================================================================

DO $precond$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'phoenix_send_direct_warehouse_transfer_line'
       AND p.pronamespace = 'public'::regnamespace
  ) THEN
    RAISE EXCEPTION '130 PRECONDITION FAILED: 129 (Group D slice) missing — apply 129 first';
  END IF;
END;
$precond$;

-- ── E1. _phoenix_procurement_post_receipt_line — root, reason_code='received' ─

CREATE OR REPLACE FUNCTION public._phoenix_procurement_post_receipt_line(
  p_receipt_line public.procurement_receipt_lines,
  p_order        public.procurement_orders,
  p_line         public.procurement_order_lines,
  p_actor        uuid,
  p_actor_role   text,
  p_actor_name   text,
  OUT o_warehouse_stock_id uuid,
  OUT o_movement_id        uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_internal_ref text;
  v_source_doc   text := COALESCE(NULLIF(btrim(COALESCE(p_order.invoice_number, '')), ''), p_order.order_number);
  v_stock        public.warehouse_stock%ROWTYPE;
  v_before       integer;
  v_after        integer;
  v_correlation_id uuid := gen_random_uuid();
BEGIN
  v_internal_ref := CASE
    WHEN p_receipt_line.has_no_batch_number
      THEN 'PRNB-' || replace(p_receipt_line.id::text, '-', '')
    ELSE NULL
  END;

  INSERT INTO public.warehouse_stock (
    organization_id, warehouse_id, central_item_id,
    scientific_name, trade_name, concentration, dosage_form, unit,
    national_code, has_no_national_code,
    batch_number, has_no_batch_number, internal_batch_reference,
    expiry_date, on_hand_quantity, reserved_quantity,
    unit_price, price_basis, currency, supply_type_text,
    supply_type, purchase_origin,
    source_document_number, notes, created_by, updated_by
  ) VALUES (
    p_order.organization_id, p_order.warehouse_id, p_line.central_item_id,
    p_line.scientific_name, p_line.trade_name, p_line.concentration, p_line.dosage_form, p_line.unit,
    p_receipt_line.national_code, p_receipt_line.has_no_national_code,
    p_receipt_line.batch_number, p_receipt_line.has_no_batch_number, v_internal_ref,
    p_receipt_line.expiry_date, 0, 0,
    p_receipt_line.unit_price, 'purchase', COALESCE(p_line.currency, p_order.currency), 'local_procurement',
    'purchase', 'supplementary',
    v_source_doc, NULL, p_actor, p_actor
  )
  ON CONFLICT DO NOTHING;

  SELECT *
    INTO v_stock
  FROM public.warehouse_stock s
  WHERE s.warehouse_id = p_order.warehouse_id
    AND s.scientific_name = p_line.scientific_name
    AND COALESCE(s.concentration, '') = COALESCE(p_line.concentration, '')
    AND COALESCE(s.dosage_form, '') = COALESCE(p_line.dosage_form, '')
    AND COALESCE(s.national_code, '') = COALESCE(p_receipt_line.national_code, '')
    AND COALESCE(s.batch_number, '') = COALESCE(p_receipt_line.batch_number, '')
    AND COALESCE(s.expiry_date, DATE '0001-01-01')
        = COALESCE(p_receipt_line.expiry_date, DATE '0001-01-01')
    AND COALESCE(s.internal_batch_reference, '') = COALESCE(v_internal_ref, '')
    AND COALESCE(s.supply_type, '') = COALESCE('purchase', '')
    AND COALESCE(s.purchase_origin, '') = COALESCE('supplementary', '')
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse_stock_identity_resolution_failed'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_stock.central_item_id IS NOT NULL
     AND p_line.central_item_id IS NOT NULL
     AND v_stock.central_item_id IS DISTINCT FROM p_line.central_item_id THEN
    RAISE EXCEPTION 'warehouse_stock_central_item_conflict' USING ERRCODE = '23514';
  END IF;

  v_before := v_stock.on_hand_quantity;
  v_after  := v_before + p_receipt_line.quantity;

  UPDATE public.warehouse_stock
     SET on_hand_quantity       = v_after,
         central_item_id        = COALESCE(v_stock.central_item_id, p_line.central_item_id),
         trade_name             = COALESCE(p_line.trade_name, trade_name),
         unit                   = COALESCE(p_line.unit, unit),
         unit_price             = COALESCE(p_receipt_line.unit_price, unit_price),
         price_basis            = COALESCE(price_basis, 'purchase'),
         currency               = COALESCE(p_line.currency, p_order.currency, currency),
         supply_type_text       = COALESCE(supply_type_text, 'local_procurement'),
         source_document_number = COALESCE(v_source_doc, source_document_number),
         updated_by             = p_actor
   WHERE id = v_stock.id;

  INSERT INTO public.warehouse_stock_movements (
    warehouse_stock_id, organization_id, warehouse_id,
    movement_type,
    on_hand_before, on_hand_delta, on_hand_after,
    reserved_before, reserved_delta, reserved_after,
    reason, reason_code, reference_type, reference_id,
    source_document_number, actor_id, actor_role, actor_name,
    scientific_name_snapshot, concentration_snapshot,
    dosage_form_snapshot, batch_number_snapshot,
    internal_batch_reference_snapshot,
    correlation_id
  ) VALUES (
    v_stock.id, p_order.organization_id, p_order.warehouse_id,
    'add',
    v_before, p_receipt_line.quantity, v_after,
    v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
    'local_procurement_receipt', 'received', 'procurement_receipt_line', p_receipt_line.id,
    v_source_doc, p_actor, p_actor_role, p_actor_name,
    v_stock.scientific_name, v_stock.concentration,
    v_stock.dosage_form, v_stock.batch_number,
    v_stock.internal_batch_reference,
    v_correlation_id
  )
  RETURNING id INTO o_movement_id;

  o_warehouse_stock_id := v_stock.id;
END;
$$;

-- ── E2. phoenix_procurement_return_to_supplier — validated reason_code, chains ──
-- ── from the receipt line's own movement_id (already resident, no new column) ─

DROP FUNCTION IF EXISTS public.phoenix_procurement_return_to_supplier(
  uuid, uuid, integer, text, text, bigint
);

CREATE OR REPLACE FUNCTION public.phoenix_procurement_return_to_supplier(
  p_request_id          uuid,
  p_receipt_line_id     uuid,
  p_quantity            integer,
  p_reason              text,
  p_notes               text DEFAULT NULL,
  p_expected_generation bigint DEFAULT NULL,
  p_reason_code         text DEFAULT NULL
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
  v_reason       text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_reason_code  text := NULLIF(btrim(p_reason_code), '');
  v_notes        text := NULLIF(btrim(COALESCE(p_notes, '')), '');
  v_fingerprint  text;
  v_existing     public.procurement_returns%ROWTYPE;
  v_receipt_line public.procurement_receipt_lines%ROWTYPE;
  v_receipt      public.procurement_receipts%ROWTYPE;
  v_order        public.procurement_orders%ROWTYPE;
  v_stock        public.warehouse_stock%ROWTYPE;
  v_returned     integer;
  v_return       public.procurement_returns%ROWTYPE;
  v_movement_id  uuid;
  v_before       integer;
  v_after        integer;
  v_correlation_id uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_receipt_line_id IS NULL THEN
    RAISE EXCEPTION 'receipt_line_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'return_reason_required' USING ERRCODE = '23514';
  END IF;

  -- 130: reason_code is the closed-vocabulary companion to the existing
  -- free-text reason -- mandatory in lockstep with it, restricted to the
  -- original 9-value quality/loss vocabulary (069's wrrl_reason_code_chk):
  -- a return to the supplier is a quality/loss anomaly, never a manual
  -- correction and never received/transferred/dispensed/counted/released.
  IF v_reason_code IS NOT NULL AND v_reason_code NOT IN (
    'excess', 'shipment_error', 'near_expiry', 'expired', 'damaged',
    'recalled', 'quality_issue', 'temperature_excursion', 'other'
  ) THEN
    RAISE EXCEPTION 'invalid_procurement_return_reason_code' USING ERRCODE = '23514';
  END IF;
  IF v_reason_code IS NULL THEN
    RAISE EXCEPTION 'return_reason_code_required' USING ERRCODE = '23514';
  END IF;

  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'procurement_return',
    'receipt_line_id', p_receipt_line_id,
    'quantity', p_quantity,
    'reason', v_reason,
    'notes', v_notes
  )::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 87087));

  SELECT * INTO v_existing FROM public.procurement_returns WHERE request_id = p_request_id;
  IF FOUND THEN
    IF v_existing.receipt_line_id IS DISTINCT FROM p_receipt_line_id
       OR v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true,
      'return_id', v_existing.id, 'movement_id', v_existing.movement_id,
      'quantity', v_existing.quantity
    );
  END IF;

  SELECT * INTO v_receipt_line
  FROM public.procurement_receipt_lines WHERE id = p_receipt_line_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'receipt_line_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_receipt FROM public.procurement_receipts WHERE id = v_receipt_line.receipt_id;

  SELECT * INTO v_order FROM public.procurement_orders WHERE id = v_receipt.order_id FOR UPDATE;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'local_procurement.return', v_order.organization_id, v_order.warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_local_procurement_return' USING ERRCODE = '42501';
  END IF;

  SELECT o_role, o_name INTO v_actor_role, v_actor_name
  FROM public._phoenix_procurement_actor(v_actor);

  SELECT COALESCE(sum(quantity), 0) INTO v_returned
  FROM public.procurement_returns
  WHERE receipt_line_id = p_receipt_line_id;

  IF v_returned + p_quantity > v_receipt_line.quantity THEN
    RAISE EXCEPTION 'return_exceeds_received'
      USING ERRCODE = '23514',
            DETAIL  = format('receipt line %s: received %s, already returned %s, attempted %s',
                             p_receipt_line_id, v_receipt_line.quantity, v_returned, p_quantity);
  END IF;

  IF v_receipt_line.warehouse_stock_id IS NULL THEN
    RAISE EXCEPTION 'receipt_line_has_no_stock_reference' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_stock
  FROM public.warehouse_stock WHERE id = v_receipt_line.warehouse_stock_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse_stock_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF p_expected_generation IS NOT NULL
     AND v_stock.movement_seq IS DISTINCT FROM p_expected_generation THEN
    RAISE EXCEPTION 'warehouse_stock_generation_conflict'
      USING ERRCODE = '40001',
            DETAIL  = format('expected generation %s, canonical generation %s',
                             p_expected_generation, v_stock.movement_seq);
  END IF;

  IF v_stock.on_hand_quantity - v_stock.reserved_quantity < p_quantity THEN
    RAISE EXCEPTION 'insufficient_unreserved_stock'
      USING ERRCODE = '23514',
            DETAIL  = format('on hand %s, reserved %s, attempted return %s',
                             v_stock.on_hand_quantity, v_stock.reserved_quantity, p_quantity);
  END IF;

  v_before := v_stock.on_hand_quantity;
  v_after  := v_before - p_quantity;

  INSERT INTO public.procurement_returns (
    request_id, request_fingerprint, order_id, receipt_line_id,
    organization_id, warehouse_id, quantity, reason, notes,
    actor_id, actor_role, actor_name
  ) VALUES (
    p_request_id, v_fingerprint, v_order.id, p_receipt_line_id,
    v_order.organization_id, v_order.warehouse_id, p_quantity, v_reason, v_notes,
    v_actor, v_actor_role, v_actor_name
  )
  RETURNING * INTO v_return;

  UPDATE public.warehouse_stock
     SET on_hand_quantity = v_after, updated_by = v_actor
   WHERE id = v_stock.id;

  -- 130: chain correlation_id/causation_id from the receipt line's own
  -- movement_id -- already resident (087's CREATE TABLE + E1's OUT
  -- parameter), no new column needed unlike every other CHAINED group.
  IF v_receipt_line.movement_id IS NOT NULL THEN
    SELECT correlation_id INTO v_correlation_id
    FROM public.warehouse_stock_movements
    WHERE id = v_receipt_line.movement_id;
  END IF;
  v_correlation_id := COALESCE(v_correlation_id, gen_random_uuid());

  INSERT INTO public.warehouse_stock_movements (
    warehouse_stock_id, organization_id, warehouse_id,
    movement_type,
    on_hand_before, on_hand_delta, on_hand_after,
    reserved_before, reserved_delta, reserved_after,
    reason, reason_code, reference_type, reference_id,
    source_document_number, actor_id, actor_role, actor_name,
    scientific_name_snapshot, concentration_snapshot,
    dosage_form_snapshot, batch_number_snapshot,
    internal_batch_reference_snapshot,
    correlation_id, causation_id
  ) VALUES (
    v_stock.id, v_order.organization_id, v_order.warehouse_id,
    'subtract',
    v_before, -p_quantity, v_after,
    v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
    v_reason, v_reason_code, 'procurement_return', v_return.id,
    v_receipt.receipt_number, v_actor, v_actor_role, v_actor_name,
    v_stock.scientific_name, v_stock.concentration,
    v_stock.dosage_form, v_stock.batch_number,
    v_stock.internal_batch_reference,
    v_correlation_id, v_receipt_line.movement_id
  )
  RETURNING id INTO v_movement_id;

  UPDATE public.procurement_returns
     SET movement_id = v_movement_id
   WHERE id = v_return.id;

  PERFORM public._phoenix_procurement_log_event(
    v_order, 'return_posted', NULL, v_order.status, v_actor, v_actor_role, v_actor_name, v_reason,
    jsonb_build_object('return_id', v_return.id, 'receipt_line_id', p_receipt_line_id,
                       'quantity', p_quantity, 'movement_id', v_movement_id));

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_order.organization_id, v_actor, v_actor_role,
    'local_procurement.return_posted', 'procurement_returns', v_return.id,
    v_stock.scientific_name,
    jsonb_build_object('order_id', v_order.id, 'receipt_line_id', p_receipt_line_id,
                       'quantity', p_quantity, 'movement_id', v_movement_id,
                       'quantity_before', v_before, 'quantity_after', v_after)
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'return_id', v_return.id, 'movement_id', v_movement_id,
    'quantity', p_quantity,
    'quantity_before', v_before, 'quantity_after', v_after
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_procurement_return_to_supplier(
  uuid, uuid, integer, text, text, bigint, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_procurement_return_to_supplier(
  uuid, uuid, integer, text, text, bigint, text
) TO authenticated;

DO $verify$
DECLARE
  v_signature text;
BEGIN
  SELECT pg_get_function_arguments(p.oid) INTO v_signature
  FROM pg_proc p
  WHERE p.proname = 'phoenix_procurement_return_to_supplier'
    AND p.pronamespace = 'public'::regnamespace;
  IF v_signature IS NULL OR v_signature NOT LIKE '%p_reason_code text DEFAULT NULL%' THEN
    RAISE EXCEPTION '130 VERIFY FAILED: phoenix_procurement_return_to_supplier missing the new p_reason_code parameter, got: %', v_signature;
  END IF;

  RAISE NOTICE 'MOVEMENT-REASON-CODE-GROUP-E-PROCUREMENT-130: verified.';
END;
$verify$;
