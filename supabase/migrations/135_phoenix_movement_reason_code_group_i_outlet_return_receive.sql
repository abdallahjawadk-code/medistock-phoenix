-- ============================================================================
-- MOVEMENT-REASON-CODE-GROUP-I-OUTLET-RETURN-RECEIVE-135
--
-- Twentieth slice of Unified Movements & Outlet Operations (PR #57).
--
-- GROUP I — a REAL, LIVE, PREVIOUSLY-UNAUDITED GAP, found by the
-- writer-completeness discovery guard this same milestone introduces (see
-- supabase/migrations/__tests__/movement-writer-completeness.test.ts).
--
-- phoenix_receive_outlet_return_shipment_line (last defined in 104) is a
-- dual-ledger writer -- it credits warehouse_stock_movements on the
-- restockable branch and warehouse_quarantine_stock_movements on the
-- quarantine branch -- and it was NOT among the 20 writers the original
-- audit enumerated. Groups A-H therefore never touched it, and it still
-- wrote BOTH ledgers with:
--   * no reason_code at all (it COMPUTES v_reason_code from the closed
--     9-value outlet_return_request_lines.reason_code vocabulary to decide
--     disposition, then discards it -- the exact defect class Group C /
--     migration 128 fixed for the WAREHOUSE return-receive twin);
--   * no correlation_id;
--   * no causation_id.
-- It is live: src/features/outlet/outlet-return.service.ts calls it.
--
-- THE FIX, mirroring Group C exactly:
--   * outlet_return_shipment_lines gains a nullable source_movement_id FK
--     (the warehouse twin, warehouse_return_shipment_lines, has had one
--     since 128; the outlet twin was simply never given one). The send
--     function populates it right after its own movement INSERT.
--   * The receive function writes reason_code on BOTH branches: the
--     restockable branch takes v_reason_code verbatim (guaranteed non-NULL
--     and one of near_expiry/excess/shipment_error there, since every other
--     case is forced to mandatory quarantine above); the quarantine branch
--     takes v_quarantine.quarantine_reason -- the SAME disposition-classified
--     value the row was just resolved against, so the ledger and the
--     quarantine lot can never disagree.
--   * Both branches chain correlation_id/causation_id from source_movement_id.
--     A pre-135 legacy shipment line has no link and falls back to a fresh
--     correlation_id and NULL causation_id rather than guessing.
--
-- Both function bodies below are the CURRENT verified definitions (131's F4
-- send, 104's receive) transformed programmatically by tools-side script, not
-- hand-retranscribed, so nothing unrelated can drift.
--
-- PRECONDITIONS: 134 applied.
-- ============================================================================

DO $precond$
BEGIN
  IF to_regclass('public.phoenix_movement_dispense_context') IS NULL THEN
    RAISE EXCEPTION '135 PRECONDITION FAILED: 134 (dispense context) missing — apply 134 first';
  END IF;
END;
$precond$;

-- ── I0. The missing chain anchor, mirroring 128's warehouse twin ────────────

ALTER TABLE public.outlet_return_shipment_lines
  ADD COLUMN IF NOT EXISTS source_movement_id uuid
    REFERENCES public.outlet_stock_movements(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.outlet_return_shipment_lines.source_movement_id IS
  'GROUP-I-135: the outlet_stock_movements row the SEND half of this return '
  'recorded. Populated by phoenix_send_outlet_return_shipment_line; read by '
  'phoenix_receive_outlet_return_shipment_line as its causation_id and as the '
  'source of the shared correlation_id. NULL on pre-135 legacy lines, which '
  'fall back to a fresh correlation_id and NULL causation_id.';

-- ── I1. SEND — populate the anchor (only change; body otherwise verbatim) ───

CREATE OR REPLACE FUNCTION public.phoenix_send_outlet_return_shipment_line(
  p_request_id          uuid,
  p_return_request_line_id uuid,
  p_shipment_id           uuid,
  p_quantity              integer,
  p_shipment_number       text DEFAULT NULL,
  p_document_number       text DEFAULT NULL,
  p_notes                 text DEFAULT NULL
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
  v_line         public.outlet_return_request_lines%ROWTYPE;
  v_request      public.outlet_return_requests%ROWTYPE;
  v_stock        public.outlet_stock%ROWTYPE;
  v_shipment     public.outlet_return_shipments%ROWTYPE;
  v_existing     public.outlet_stock_movements%ROWTYPE;
  v_notes        text := NULLIF(btrim(p_notes), '');
  v_document     text := NULLIF(btrim(p_document_number), '');
  v_number       text := NULLIF(btrim(p_shipment_number), '');
  v_before       integer;
  v_after        integer;
  v_movement_id  uuid;
  v_shipment_line_id uuid;
  v_fingerprint  text;
  v_avail_id     uuid;
  v_correlation_id uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL OR p_return_request_line_id IS NULL THEN
    RAISE EXCEPTION 'request_id_and_line_required' USING ERRCODE = '23514';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;

  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'outlet_return_send',
    'return_request_line_id', p_return_request_line_id,
    'shipment_id', p_shipment_id,
    'quantity', p_quantity,
    'shipment_number', v_number,
    'document_number', v_document,
    'notes', v_notes
  )::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 70070));

  SELECT * INTO v_existing
  FROM public.outlet_stock_movements m
  WHERE m.reference_type = 'outlet_return_send' AND m.reference_id = p_request_id;
  IF FOUND THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true,
      'movement_id', v_existing.id,
      'quantity_before', v_existing.on_hand_before,
      'quantity_delta', v_existing.on_hand_delta,
      'quantity_after', v_existing.on_hand_after
    );
  END IF;

  SELECT * INTO v_line
  FROM public.outlet_return_request_lines WHERE id = p_return_request_line_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_request_line_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_line.status NOT IN ('approved', 'partially_fulfilled') THEN
    RAISE EXCEPTION 'return_request_line_not_approved' USING ERRCODE = '23514';
  END IF;
  IF v_line.fulfilled_quantity + p_quantity > v_line.approved_quantity THEN
    RAISE EXCEPTION 'quantity_exceeds_approved_remainder' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_request
  FROM public.outlet_return_requests WHERE id = v_line.return_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_request_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT s.* INTO v_stock FROM public.outlet_stock s
  WHERE s.id = v_line.source_outlet_stock_id
  FOR UPDATE OF s;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'source_outlet_stock_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'outlet_stock.return', v_stock.organization_id, NULL, v_stock.distribution_point_id
  ) THEN
    RAISE EXCEPTION 'forbidden_outlet_return_send' USING ERRCODE = '42501';
  END IF;

  SELECT p.role, p.full_name INTO v_actor_role, v_actor_name
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  IF v_stock.on_hand_quantity - v_stock.reserved_quantity < p_quantity THEN
    RAISE EXCEPTION 'insufficient_available_quantity' USING ERRCODE = '23514';
  END IF;

  IF p_shipment_id IS NOT NULL THEN
    SELECT * INTO v_shipment
    FROM public.outlet_return_shipments WHERE id = p_shipment_id FOR UPDATE;
    IF NOT FOUND OR v_shipment.status <> 'in_transit'
       OR v_shipment.distribution_point_id <> v_stock.distribution_point_id THEN
      RAISE EXCEPTION 'outlet_return_shipment_not_open' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF v_number IS NULL THEN
      RAISE EXCEPTION 'shipment_number_required' USING ERRCODE = '23514';
    END IF;
    INSERT INTO public.outlet_return_shipments (
      return_request_id, distribution_point_id, source_organization_id,
      destination_warehouse_id, destination_organization_id,
      shipment_number, document_number, notes, sent_by
    ) VALUES (
      v_request.id, v_stock.distribution_point_id, v_stock.organization_id,
      v_request.destination_warehouse_id, v_request.destination_organization_id,
      v_number, v_document, v_notes, v_actor
    )
    RETURNING * INTO v_shipment;
  END IF;

  v_before := v_stock.on_hand_quantity;
  v_after  := v_before - p_quantity;

  UPDATE public.outlet_stock
     SET on_hand_quantity = v_after, updated_by = v_actor
   WHERE id = v_stock.id;

  -- 131: chain correlation_id/causation_id from the dispatch_receive
  -- movement that first brought this exact lot into the outlet -- already
  -- resident on the request line since 071, no new column needed.
  IF v_line.original_inbound_movement_id IS NOT NULL THEN
    SELECT correlation_id INTO v_correlation_id
    FROM public.outlet_stock_movements
    WHERE id = v_line.original_inbound_movement_id;
  END IF;
  v_correlation_id := COALESCE(v_correlation_id, gen_random_uuid());

  INSERT INTO public.outlet_stock_movements (
    outlet_stock_id, organization_id, distribution_point_id, movement_type,
    on_hand_before, on_hand_delta, on_hand_after,
    reserved_before, reserved_delta, reserved_after,
    reason, reason_code, reference_type, reference_id, request_fingerprint,
    source_document_number, actor_id, actor_role, actor_name,
    scientific_name_snapshot, concentration_snapshot, dosage_form_snapshot,
    batch_number_snapshot, internal_batch_reference_snapshot, expiry_date_snapshot,
    correlation_id, causation_id
  ) VALUES (
    v_stock.id, v_stock.organization_id, v_stock.distribution_point_id, 'return_send',
    v_before, -p_quantity, v_after,
    v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
    'outlet_return', v_line.reason_code, 'outlet_return_send', p_request_id, v_fingerprint,
    v_shipment.document_number, v_actor, v_actor_role, v_actor_name,
    v_stock.scientific_name, v_stock.concentration, v_stock.dosage_form,
    v_stock.batch_number, v_stock.internal_batch_reference, v_stock.expiry_date,
    v_correlation_id, v_line.original_inbound_movement_id
  )
  RETURNING id INTO v_movement_id;

  v_avail_id := public.phoenix_project_outlet_availability(v_stock.id);

  INSERT INTO public.outlet_return_shipment_lines (
    shipment_id, source_organization_id, source_outlet_stock_id,
    return_request_line_id,
    original_dispatch_line_id, original_inbound_movement_id,
    source_movement_id,
    central_item_id,
    scientific_name, trade_name, concentration, dosage_form, unit,
    national_code, has_no_national_code, batch_number, has_no_batch_number,
    internal_batch_reference, expiry_date, unit_price, price_basis, currency, supply_type_text,
    supply_type, purchase_origin,
    sent_quantity
  ) VALUES (
    v_shipment.id, v_stock.organization_id, v_stock.id,
    v_line.id,
    v_line.original_dispatch_line_id, v_line.original_inbound_movement_id,
    v_movement_id,
    v_stock.central_item_id,
    v_stock.scientific_name, v_stock.trade_name, v_stock.concentration, v_stock.dosage_form, v_stock.unit,
    v_stock.national_code, v_stock.has_no_national_code, v_stock.batch_number, v_stock.has_no_batch_number,
    v_stock.internal_batch_reference, v_stock.expiry_date, v_stock.unit_price, v_stock.price_basis,
    v_stock.currency, v_stock.supply_type_text,
    v_stock.supply_type, v_stock.purchase_origin,
    p_quantity
  )
  RETURNING id INTO v_shipment_line_id;

  UPDATE public.warehouse_dispatch_lines
     SET returned_quantity = returned_quantity + p_quantity
   WHERE id = v_line.original_dispatch_line_id;

  UPDATE public.outlet_return_request_lines
     SET fulfilled_quantity = fulfilled_quantity + p_quantity,
         status = CASE WHEN fulfilled_quantity + p_quantity = approved_quantity
                        THEN 'fulfilled' ELSE 'partially_fulfilled' END
   WHERE id = v_line.id;

  UPDATE public.outlet_return_shipments
     SET status = 'in_transit'
   WHERE id = v_shipment.id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_stock.organization_id, v_actor, v_actor_role,
    'outlet_stock.return_sent', 'outlet_return_shipment_lines', v_shipment_line_id, v_stock.scientific_name,
    jsonb_build_object(
      'request_id', p_request_id, 'shipment_id', v_shipment.id,
      'movement_id', v_movement_id, 'quantity_before', v_before,
      'quantity_delta', -p_quantity, 'quantity_after', v_after
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'shipment_id', v_shipment.id, 'shipment_line_id', v_shipment_line_id,
    'movement_id', v_movement_id, 'item_availability_id', v_avail_id,
    'quantity_before', v_before, 'quantity_delta', -p_quantity, 'quantity_after', v_after
  );
END;
$$;

-- ── I2. RECEIVE — reason_code on both ledger branches + the chain ──────────

CREATE OR REPLACE FUNCTION public.phoenix_receive_outlet_return_shipment_line(
  p_request_id           uuid,
  p_shipment_line_id      uuid,
  p_received_quantity     integer,
  p_difference_reason     text DEFAULT NULL,
  p_notes                 text DEFAULT NULL,
  p_disposition_decision  text DEFAULT NULL
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
  v_line         public.outlet_return_shipment_lines%ROWTYPE;
  v_shipment     public.outlet_return_shipments%ROWTYPE;
  v_orig_dispatch public.warehouse_dispatch_lines%ROWTYPE;
  v_stock        public.warehouse_stock%ROWTYPE;
  v_quarantine   public.warehouse_quarantine_stock%ROWTYPE;
  v_existing     public.warehouse_stock_movements%ROWTYPE;
  v_existing_q   public.warehouse_quarantine_stock_movements%ROWTYPE;
  v_reason       text := NULLIF(btrim(p_difference_reason), '');
  v_notes        text := NULLIF(btrim(p_notes), '');
  v_internal     text;
  v_before       integer;
  v_after        integer;
  v_movement_id  uuid;
  v_status       text;
  v_fingerprint  text;
  v_reason_code  text;
  v_objectively_expired boolean;
  v_mandatory_quarantine boolean;
  v_disposition  text;
  v_custody      text;
  v_predecessor_id uuid;
  v_correlation_id uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL OR p_shipment_line_id IS NULL THEN
    RAISE EXCEPTION 'request_id_and_line_required' USING ERRCODE = '23514';
  END IF;
  IF p_received_quantity IS NULL OR p_received_quantity < 0 THEN
    RAISE EXCEPTION 'received_quantity_must_be_non_negative' USING ERRCODE = '23514';
  END IF;
  IF p_disposition_decision IS NOT NULL AND p_disposition_decision NOT IN ('restockable', 'quarantined') THEN
    RAISE EXCEPTION 'invalid_disposition_decision' USING ERRCODE = '23514';
  END IF;

  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'outlet_return_receive',
    'shipment_line_id', p_shipment_line_id,
    'received_quantity', p_received_quantity,
    'difference_reason', v_reason,
    'notes', v_notes,
    'disposition_decision', p_disposition_decision
  )::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 70070));

  SELECT * INTO v_existing
  FROM public.warehouse_stock_movements m
  WHERE m.reference_type = 'outlet_return_receive' AND m.reference_id = p_request_id;
  IF FOUND THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true, 'disposition', 'restockable',
      'warehouse_stock_id', v_existing.warehouse_stock_id, 'movement_id', v_existing.id,
      'quantity_before', v_existing.on_hand_before, 'quantity_delta', v_existing.on_hand_delta,
      'quantity_after', v_existing.on_hand_after
    );
  END IF;

  SELECT * INTO v_existing_q
  FROM public.warehouse_quarantine_stock_movements m
  WHERE m.reference_type = 'outlet_return_quarantine_receive' AND m.reference_id = p_request_id;
  IF FOUND THEN
    IF v_existing_q.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true, 'disposition', 'quarantined',
      'quarantine_stock_id', v_existing_q.quarantine_stock_id, 'movement_id', v_existing_q.id,
      'quantity_before', v_existing_q.quantity_before, 'quantity_delta', v_existing_q.quantity_delta,
      'quantity_after', v_existing_q.quantity_after
    );
  END IF;

  SELECT * INTO v_line
  FROM public.outlet_return_shipment_lines WHERE id = p_shipment_line_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_shipment_line_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_line.status <> 'in_transit' THEN
    RAISE EXCEPTION 'return_shipment_line_already_received' USING ERRCODE = '23505';
  END IF;
  IF p_received_quantity > v_line.sent_quantity THEN
    RAISE EXCEPTION 'received_quantity_exceeds_sent' USING ERRCODE = '23514';
  END IF;
  IF p_received_quantity <> v_line.sent_quantity AND v_reason IS NULL THEN
    RAISE EXCEPTION 'difference_reason_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_shipment
  FROM public.outlet_return_shipments WHERE id = v_line.shipment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_shipment_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'outlet_stock.return_receive', v_shipment.destination_organization_id,
    v_shipment.destination_warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_outlet_return_receive' USING ERRCODE = '42501';
  END IF;

  SELECT p.role, p.full_name INTO v_actor_role, v_actor_name
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_orig_dispatch
  FROM public.warehouse_dispatch_lines WHERE id = v_line.original_dispatch_line_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'original_dispatch_line_not_found' USING ERRCODE = 'P0002';
  END IF;

  v_status := CASE
    WHEN p_received_quantity = 0 THEN 'rejected'
    WHEN p_received_quantity = v_line.sent_quantity THEN 'received'
    ELSE 'received_with_difference'
  END;

  v_reason_code := (
    SELECT rl.reason_code FROM public.outlet_return_request_lines rl
    WHERE rl.id = v_line.return_request_line_id
  );

  -- 135: chain from the SEND movement this shipment line recorded (the real,
  -- same-corridor predecessor). A pre-135 legacy line has no link -- fall back
  -- to a fresh correlation_id and NULL causation_id rather than guessing.
  v_predecessor_id := v_line.source_movement_id;
  IF v_predecessor_id IS NOT NULL THEN
    SELECT correlation_id INTO v_correlation_id
    FROM public.outlet_stock_movements WHERE id = v_predecessor_id;
  END IF;
  v_correlation_id := COALESCE(v_correlation_id, gen_random_uuid());

  IF p_received_quantity = 0 THEN
    UPDATE public.outlet_return_shipment_lines
       SET status = 'rejected', received_quantity = 0,
           difference_reason = v_reason, received_by = v_actor, received_at = now(),
           disposition = NULL, custody_state = 'exception_pending'
     WHERE id = v_line.id;

    UPDATE public.outlet_return_shipments
       SET status = CASE WHEN NOT EXISTS (
                           SELECT 1 FROM public.outlet_return_shipment_lines x
                           WHERE x.shipment_id = v_shipment.id AND x.status = 'in_transit')
                         THEN 'received' ELSE 'partially_received' END
     WHERE id = v_shipment.id;

    INSERT INTO public.audit_logs (
      organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
    ) VALUES (
      v_shipment.destination_organization_id, v_actor, v_actor_role,
      'outlet_stock.return_rejected', 'outlet_return_shipment_lines', v_line.id, v_line.scientific_name,
      jsonb_build_object(
        'request_id', p_request_id, 'shipment_id', v_shipment.id,
        'reason_code', v_reason_code,
        'sent_quantity', v_line.sent_quantity, 'received_quantity', 0,
        'custody_state', 'exception_pending', 'reason', v_reason
      )
    );

    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', false, 'line_status', 'rejected',
      'disposition', NULL, 'custody_state', 'exception_pending',
      'warehouse_stock_id', NULL, 'quarantine_stock_id', NULL, 'movement_id', NULL,
      'quantity_before', 0, 'quantity_delta', 0, 'quantity_after', 0
    );
  END IF;

  v_objectively_expired := v_line.expiry_date IS NOT NULL AND v_line.expiry_date < current_date;
  v_mandatory_quarantine := v_objectively_expired
    OR v_reason_code IS NULL
    OR v_reason_code IN (
         'expired', 'damaged', 'recalled', 'quality_issue', 'temperature_excursion', 'other'
       );

  IF v_mandatory_quarantine THEN
    v_disposition := 'quarantined';
  ELSIF v_reason_code IN ('near_expiry', 'excess', 'shipment_error') THEN
    IF p_disposition_decision IS NULL THEN
      RAISE EXCEPTION 'return_receive_requires_explicit_disposition_decision' USING ERRCODE = '23514';
    END IF;
    v_disposition := p_disposition_decision;
  ELSE
    RAISE EXCEPTION 'return_receive_unclassified_reason_code' USING ERRCODE = '23514';
  END IF;

  v_custody := CASE v_disposition WHEN 'restockable' THEN 'destination_stock' ELSE 'destination_quarantine' END;
  v_internal := v_line.internal_batch_reference;

  IF v_disposition = 'restockable' THEN
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
      v_shipment.destination_organization_id, v_shipment.destination_warehouse_id,
      v_line.central_item_id,
      v_line.scientific_name, v_line.trade_name, v_line.concentration,
      v_line.dosage_form, v_line.unit,
      v_line.national_code, v_line.has_no_national_code,
      v_line.batch_number, v_line.has_no_batch_number, v_internal,
      v_line.expiry_date, 0, 0,
      v_line.unit_price, v_line.price_basis, v_line.currency, v_line.supply_type_text,
      v_line.supply_type, v_line.purchase_origin,
      NULL, v_notes, v_actor, v_actor
    )
    ON CONFLICT DO NOTHING;

    SELECT * INTO v_stock
    FROM public.warehouse_stock s
    WHERE s.warehouse_id = v_shipment.destination_warehouse_id
      AND s.scientific_name = v_line.scientific_name
      AND COALESCE(s.concentration, '') = COALESCE(v_line.concentration, '')
      AND COALESCE(s.dosage_form, '')   = COALESCE(v_line.dosage_form, '')
      AND COALESCE(s.national_code, '') = COALESCE(v_line.national_code, '')
      AND COALESCE(s.batch_number, '')  = COALESCE(v_line.batch_number, '')
      AND COALESCE(s.expiry_date, DATE '0001-01-01')
          = COALESCE(v_line.expiry_date, DATE '0001-01-01')
      AND COALESCE(s.internal_batch_reference, '') = COALESCE(v_internal, '')
      AND COALESCE(s.supply_type, '') = COALESCE(v_line.supply_type, '')
      AND COALESCE(s.purchase_origin, '') = COALESCE(v_line.purchase_origin, '')
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'destination_stock_identity_resolution_failed' USING ERRCODE = 'P0002';
    END IF;

    v_before := v_stock.on_hand_quantity;
    v_after  := v_before + p_received_quantity;

    UPDATE public.warehouse_stock
       SET on_hand_quantity = v_after,
           central_item_id  = COALESCE(v_stock.central_item_id, v_line.central_item_id),
           updated_by       = v_actor
     WHERE id = v_stock.id;

    UPDATE public.outlet_return_shipment_lines
       SET status = v_status, received_quantity = p_received_quantity,
           difference_reason = v_reason, received_by = v_actor, received_at = now(),
           disposition = 'restockable', custody_state = 'destination_stock',
           resulting_warehouse_stock_id = v_stock.id
     WHERE id = v_line.id;

    INSERT INTO public.warehouse_stock_movements (
      warehouse_stock_id, organization_id, warehouse_id, movement_type,
      on_hand_before, on_hand_delta, on_hand_after,
      reserved_before, reserved_delta, reserved_after,
      reason, reason_code, reference_type, reference_id, request_fingerprint,
      source_document_number, actor_id, actor_role, actor_name,
      scientific_name_snapshot, concentration_snapshot,
      dosage_form_snapshot, batch_number_snapshot,
      internal_batch_reference_snapshot,
      correlation_id, causation_id
    ) VALUES (
      v_stock.id, v_stock.organization_id, v_stock.warehouse_id, 'add',
      v_before, p_received_quantity, v_after,
      v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
      'outlet_return', v_reason_code, 'outlet_return_receive', p_request_id, v_fingerprint,
      NULL, v_actor, v_actor_role, v_actor_name,
      v_stock.scientific_name, v_stock.concentration,
      v_stock.dosage_form, v_stock.batch_number,
      v_stock.internal_batch_reference,
      v_correlation_id, v_predecessor_id
    )
    RETURNING id INTO v_movement_id;
  ELSE
    -- 104-FIX: supply_type/purchase_origin are now supplied HERE, matching
    -- the 20-column list above — they were previously appended to the
    -- audit_logs INSERT far below, which has no matching columns at all and
    -- could never have succeeded.
    INSERT INTO public.warehouse_quarantine_stock (
      organization_id, warehouse_id, central_item_id,
      scientific_name, trade_name, concentration, dosage_form, unit,
      national_code, has_no_national_code,
      batch_number, has_no_batch_number, internal_batch_reference,
      expiry_date, quarantine_reason, quantity, created_by, updated_by,
      supply_type, purchase_origin
    ) VALUES (
      v_shipment.destination_organization_id, v_shipment.destination_warehouse_id,
      v_line.central_item_id,
      v_line.scientific_name, v_line.trade_name, v_line.concentration,
      v_line.dosage_form, v_line.unit,
      v_line.national_code, v_line.has_no_national_code,
      v_line.batch_number, v_line.has_no_batch_number, v_internal,
      v_line.expiry_date,
      -- 104-FIX: warehouse_quarantine_stock.quarantine_reason is CHECK-
      -- constrained to the six canonical quality-hold reasons (069's
      -- wqs_reason_chk) — it never included 'near_expiry'/'excess'/
      -- 'shipment_error', the three reasons a human can explicitly DECIDE
      -- to quarantine rather than restock. Passing one of those three
      -- through unchanged (the ORIGINAL code) violated that constraint on
      -- every such explicit-decision quarantine, so no return with one of
      -- these three reason codes could ever be received as 'quarantined' —
      -- confirmed unreachable until this fix, same defect class as the
      -- column/value fix above.
      CASE
        WHEN v_objectively_expired AND v_reason_code IS DISTINCT FROM 'expired' THEN 'expired'
        WHEN v_reason_code IN ('expired', 'damaged', 'recalled', 'quality_issue', 'temperature_excursion', 'other')
          THEN v_reason_code
        ELSE 'other'
      END,
      0, v_actor, v_actor,
      v_line.supply_type, v_line.purchase_origin
    )
    ON CONFLICT DO NOTHING;

    SELECT * INTO v_quarantine
    FROM public.warehouse_quarantine_stock q
    WHERE q.warehouse_id = v_shipment.destination_warehouse_id
      AND q.scientific_name = v_line.scientific_name
      AND COALESCE(q.concentration, '') = COALESCE(v_line.concentration, '')
      AND COALESCE(q.dosage_form, '')   = COALESCE(v_line.dosage_form, '')
      AND COALESCE(q.national_code, '') = COALESCE(v_line.national_code, '')
      AND COALESCE(q.batch_number, '')  = COALESCE(v_line.batch_number, '')
      AND COALESCE(q.expiry_date, DATE '0001-01-01')
          = COALESCE(v_line.expiry_date, DATE '0001-01-01')
      AND COALESCE(q.internal_batch_reference, '') = COALESCE(v_internal, '')
      AND q.quarantine_reason = (
            CASE
              WHEN v_objectively_expired AND v_reason_code IS DISTINCT FROM 'expired' THEN 'expired'
              WHEN v_reason_code IN ('expired', 'damaged', 'recalled', 'quality_issue', 'temperature_excursion', 'other')
                THEN v_reason_code
              ELSE 'other'
            END)
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'destination_quarantine_identity_resolution_failed' USING ERRCODE = 'P0002';
    END IF;

    v_before := v_quarantine.quantity;
    v_after  := v_before + p_received_quantity;

    UPDATE public.warehouse_quarantine_stock
       SET quantity = v_after, updated_by = v_actor
     WHERE id = v_quarantine.id;

    UPDATE public.outlet_return_shipment_lines
       SET status = v_status, received_quantity = p_received_quantity,
           difference_reason = v_reason, received_by = v_actor, received_at = now(),
           disposition = 'quarantined', custody_state = 'destination_quarantine',
           resulting_quarantine_stock_id = v_quarantine.id
     WHERE id = v_line.id;

    -- 104-FIX: the two stray trailing values are removed from here — this
    -- table has no supply_type/purchase_origin columns.
    INSERT INTO public.warehouse_quarantine_stock_movements (
      quarantine_stock_id, organization_id, warehouse_id, movement_type,
      quantity_before, quantity_delta, quantity_after,
      reason, reason_code, reference_type, reference_id, request_fingerprint,
      source_document_number, actor_id, actor_role, actor_name,
      scientific_name_snapshot, concentration_snapshot,
      dosage_form_snapshot, batch_number_snapshot,
      internal_batch_reference_snapshot,
      correlation_id, causation_id
    ) VALUES (
      v_quarantine.id, v_quarantine.organization_id, v_quarantine.warehouse_id, 'quarantine_receive',
      v_before, p_received_quantity, v_after,
      'outlet_return', v_quarantine.quarantine_reason, 'outlet_return_quarantine_receive', p_request_id, v_fingerprint,
      NULL, v_actor, v_actor_role, v_actor_name,
      v_quarantine.scientific_name, v_quarantine.concentration,
      v_quarantine.dosage_form, v_quarantine.batch_number,
      v_quarantine.internal_batch_reference,
      v_correlation_id, v_predecessor_id
    )
    RETURNING id INTO v_movement_id;
  END IF;

  UPDATE public.outlet_return_shipments
     SET status = CASE WHEN NOT EXISTS (
                         SELECT 1 FROM public.outlet_return_shipment_lines x
                         WHERE x.shipment_id = v_shipment.id AND x.status = 'in_transit')
                       THEN 'received' ELSE 'partially_received' END
   WHERE id = v_shipment.id;

  UPDATE public.warehouse_dispatch_lines
     SET return_received_quantity = return_received_quantity + p_received_quantity
   WHERE id = v_line.original_dispatch_line_id;

  -- 104-FIX: the two stray trailing values are removed from here — audit_logs
  -- has no supply_type/purchase_origin columns; the payload jsonb closes the
  -- VALUES list.
  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_shipment.destination_organization_id, v_actor, v_actor_role,
    'outlet_stock.return_receive',
    CASE WHEN v_disposition = 'restockable' THEN 'warehouse_stock' ELSE 'warehouse_quarantine_stock' END,
    COALESCE(v_stock.id, v_quarantine.id),
    v_line.scientific_name,
    jsonb_build_object(
      'request_id', p_request_id, 'shipment_id', v_shipment.id, 'shipment_line_id', v_line.id,
      'movement_id', v_movement_id, 'line_status', v_status,
      'reason_code', v_reason_code, 'disposition', v_disposition,
      'disposition_decision', p_disposition_decision, 'custody_state', v_custody,
      'sent_quantity', v_line.sent_quantity,
      'quantity_before', v_before, 'quantity_delta', p_received_quantity, 'quantity_after', v_after,
      'reason', v_reason
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'line_status', v_status, 'disposition', v_disposition, 'custody_state', v_custody,
    'shipment_id', v_shipment.id,
    'warehouse_stock_id', v_stock.id, 'quarantine_stock_id', v_quarantine.id,
    'movement_id', v_movement_id,
    'quantity_before', v_before, 'quantity_delta', p_received_quantity, 'quantity_after', v_after
  );
END;
$$;

DO $verify$
DECLARE
  v_count integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='outlet_return_shipment_lines'
       AND column_name='source_movement_id'
  ) THEN
    RAISE EXCEPTION '135 VERIFY FAILED: outlet_return_shipment_lines.source_movement_id missing';
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_proc p
  WHERE p.proname IN ('phoenix_send_outlet_return_shipment_line',
                      'phoenix_receive_outlet_return_shipment_line')
    AND p.pronamespace = 'public'::regnamespace;
  IF v_count <> 2 THEN
    RAISE EXCEPTION '135 VERIFY FAILED: expected exactly 2 Group I functions, found %', v_count;
  END IF;

  -- The whole point of this slice: the receive function must now reference
  -- every contract field. Assert against the stored body, not a comment.
  SELECT count(*) INTO v_count
  FROM pg_proc p
  WHERE p.proname = 'phoenix_receive_outlet_return_shipment_line'
    AND p.pronamespace = 'public'::regnamespace
    AND p.prosrc LIKE '%reason_code%'
    AND p.prosrc LIKE '%correlation_id%'
    AND p.prosrc LIKE '%causation_id%';
  IF v_count <> 1 THEN
    RAISE EXCEPTION '135 VERIFY FAILED: receive function still missing a contract field';
  END IF;

  RAISE NOTICE 'MOVEMENT-REASON-CODE-GROUP-I-OUTLET-RETURN-RECEIVE-135: verified.';
END;
$verify$;
