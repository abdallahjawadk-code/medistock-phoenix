-- ============================================================================
-- MOVEMENT-REASON-CODE-GROUP-F-OUTLET-131
--
-- Sixteenth slice of Unified Movements & Outlet Operations (PR #57, item
-- A). Sixth of eight domain slices wiring reason_code + server-owned
-- correlation_id/causation_id into the 20 audited ledger-writer RPCs.
--
-- GROUP F — outlet dispatch-receive, dispense, count, return-send:
--
--   * phoenix_receive_outlet_dispatch_line (088) — one of the six
--     confirmed free-text-to-ledger gaps (p_difference_reason passed
--     straight through, conditionally mandatory). Gains one new optional
--     trailing p_reason_code parameter, validated against the same
--     9-value quality/loss vocabulary as Group A/E, mandatory in lockstep
--     with the existing difference-reason requirement, defaulting to
--     'received' when quantities match exactly. NEEDS NO NEW SCHEMA: the
--     send-side warehouse_stock_movements row already carries
--     reference_type='warehouse_dispatch_send' with reference_id =
--     the dispatch LINE's own id (070's phoenix_send_warehouse_dispatch)
--     -- exactly the p_dispatch_line_id this function already receives
--     and locks. correlation_id/causation_id are looked up directly by
--     that join; no column to add anywhere.
--
--   * phoenix_dispense_outlet_stock (067) — the clearest non-fit for the
--     quality/loss vocabulary in the whole audit (dispensing to a
--     patient/crash-cart/order is not a loss or anomaly). reason_code
--     hardcoded to 'dispensed', no client choice, no signature change.
--     correlation_id freshly generated: this is the terminal consumption
--     event of the whole supply chain, genuinely root-like (no upstream
--     document). causation_id stays NULL.
--
--   * phoenix_count_outlet_stock (067) — another confirmed free-text gap,
--     the outlet twin of Group A's phoenix_apply_warehouse_stock_movement.
--     Gains one new MANDATORY trailing p_reason_code parameter (mirrors
--     the existing mandatory free-text reason -- unlike Group A's
--     add/subtract, there is no safe default here since every count is a
--     deliberate, reason-bearing action), validated against the same
--     10-value subset Group A uses (9 quality/loss values plus
--     'corrected'). correlation_id freshly generated (a physical count has
--     no upstream document to chain from). causation_id stays NULL.
--
--   * phoenix_send_outlet_return_shipment_line (088) — the fourth
--     confirmed hardcoded-reason-drops-an-available-closed-vocabulary gap
--     (alongside Groups C/D's warehouse-return sends): propagates
--     v_line.reason_code (outlet_return_request_lines' own 9-value closed
--     vocabulary) verbatim. NEEDS NO NEW SCHEMA either -- this function
--     already reads v_line.original_inbound_movement_id, a direct pointer
--     to the dispatch_receive movement that first brought this exact lot
--     into the outlet (071's own design), which becomes causation_id
--     verbatim; its correlation_id is looked up and reused.
--
--   * phoenix_send_warehouse_dispatch (070) — A GENUINE GAP FOUND WHILE
--     VERIFYING THIS SLICE, not one of the 20 originally audited writers:
--     it writes the warehouse-side half of every outlet dispatch (the
--     movement F1 above chains its causation_id from) but was never wired
--     for reason_code/correlation_id by any prior slice. Fixed here as
--     part of the SAME dispatch corridor Group F's receive-side already
--     covers, rather than left as a documented gap for the eventual
--     contract-completeness test to trip over. reason_code hardcoded to
--     'transferred' (a routine warehouse-to-outlet dispatch, no anomaly,
--     no client choice). This function inserts ONE movement PER DISPATCH
--     LINE inside a loop, so correlation_id is freshly generated PER LINE
--     (matching F1's per-line causation chaining granularity) rather than
--     shared across every line of one dispatch call. causation_id stays
--     NULL (true root -- a dispatch send has no predecessor movement).
--
-- PRECONDITIONS: 130 applied (Group E slice).
-- ============================================================================

DO $precond$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'phoenix_procurement_return_to_supplier'
       AND p.pronamespace = 'public'::regnamespace
       AND pg_get_function_arguments(p.oid) LIKE '%p_reason_code%'
  ) THEN
    RAISE EXCEPTION '131 PRECONDITION FAILED: 130 (Group E slice) missing — apply 130 first';
  END IF;
END;
$precond$;

-- ── F1. phoenix_receive_outlet_dispatch_line — validated reason_code, chains ─
-- ── from the send-side movement via the ALREADY-SHARED dispatch_line_id ─────

DROP FUNCTION IF EXISTS public.phoenix_receive_outlet_dispatch_line(
  uuid, uuid, integer, text, text
);

CREATE OR REPLACE FUNCTION public.phoenix_receive_outlet_dispatch_line(
  p_request_id        uuid,
  p_dispatch_line_id  uuid,
  p_received_quantity integer,
  p_difference_reason text DEFAULT NULL,
  p_notes             text DEFAULT NULL,
  p_reason_code       text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor       uuid := auth.uid();
  v_actor_role  text;
  v_actor_name  text;
  v_dispatch_id uuid;
  v_line        public.warehouse_dispatch_lines%ROWTYPE;
  v_dispatch    public.warehouse_dispatches%ROWTYPE;
  v_point       public.distribution_points%ROWTYPE;
  v_stock       public.outlet_stock%ROWTYPE;
  v_existing    public.outlet_stock_movements%ROWTYPE;
  v_reason      text := NULLIF(btrim(p_difference_reason), '');
  v_reason_code text := NULLIF(btrim(p_reason_code), '');
  v_notes       text := NULLIF(btrim(p_notes), '');
  v_before      integer;
  v_after       integer;
  v_movement_id uuid;
  v_avail_id    uuid;
  v_line_status text;
  v_fingerprint text;
  v_send_movement_id uuid;
  v_correlation_id   uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_dispatch_line_id IS NULL THEN
    RAISE EXCEPTION 'dispatch_line_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_received_quantity IS NULL OR p_received_quantity < 0 THEN
    RAISE EXCEPTION 'received_quantity_must_be_non_negative' USING ERRCODE = '23514';
  END IF;

  -- 131: reason_code is the closed-vocabulary companion to the existing
  -- difference-reason free text -- mandatory only when there IS a
  -- difference, defaulting to 'received' on an exact match.
  IF v_reason_code IS NOT NULL AND v_reason_code NOT IN (
    'excess', 'shipment_error', 'near_expiry', 'expired', 'damaged',
    'recalled', 'quality_issue', 'temperature_excursion', 'other'
  ) THEN
    RAISE EXCEPTION 'invalid_outlet_dispatch_receive_reason_code' USING ERRCODE = '23514';
  END IF;

  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'receive_dispatch_line',
    'dispatch_line_id', p_dispatch_line_id,
    'received_quantity', p_received_quantity,
    'difference_reason', v_reason,
    'notes', v_notes
  )::text, 'UTF8')), 'hex');

  SELECT dispatch_id INTO v_dispatch_id
  FROM public.warehouse_dispatch_lines WHERE id = p_dispatch_line_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dispatch_line_not_found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_dispatch_id::text, 70170));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 67067));

  SELECT * INTO v_existing
  FROM public.outlet_stock_movements m
  WHERE m.reference_type = 'outlet_request' AND m.reference_id = p_request_id;

  IF FOUND THEN
    IF v_existing.dispatch_line_id IS DISTINCT FROM p_dispatch_line_id
       OR v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true,
      'outlet_stock_id', v_existing.outlet_stock_id,
      'movement_id', v_existing.id,
      'quantity_before', v_existing.on_hand_before,
      'quantity_delta', v_existing.on_hand_delta,
      'quantity_after', v_existing.on_hand_after
    );
  END IF;

  SELECT * INTO v_dispatch
  FROM public.warehouse_dispatches
  WHERE id = v_dispatch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'dispatch_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_line
  FROM public.warehouse_dispatch_lines
  WHERE id = p_dispatch_line_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'dispatch_line_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_dispatch.status NOT IN ('sent', 'partially_accepted') THEN
    RAISE EXCEPTION 'dispatch_not_receivable' USING ERRCODE = '23514';
  END IF;
  IF v_line.status <> 'pending' THEN
    RAISE EXCEPTION 'dispatch_line_already_decided' USING ERRCODE = '23505';
  END IF;
  IF p_received_quantity > v_line.sent_quantity THEN
    RAISE EXCEPTION 'received_quantity_exceeds_sent' USING ERRCODE = '23514';
  END IF;
  IF p_received_quantity <> v_line.sent_quantity AND v_reason IS NULL THEN
    RAISE EXCEPTION 'difference_reason_required' USING ERRCODE = '23514';
  END IF;
  IF p_received_quantity <> v_line.sent_quantity AND v_reason_code IS NULL THEN
    RAISE EXCEPTION 'difference_reason_code_required' USING ERRCODE = '23514';
  END IF;
  IF v_reason_code IS NULL THEN
    v_reason_code := 'received';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'outlet_stock.receive', v_dispatch.organization_id,
    NULL, v_dispatch.destination_distribution_point_id
  ) THEN
    RAISE EXCEPTION 'forbidden_outlet_stock_receive' USING ERRCODE = '42501';
  END IF;

  SELECT p.role, p.full_name INTO v_actor_role, v_actor_name
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_point
  FROM public.distribution_points
  WHERE id = v_dispatch.destination_distribution_point_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'destination_outlet_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_point.point_type NOT IN ('pharmacy', 'crash_cabinet', 'rescue_cart') THEN
    RAISE EXCEPTION 'outlet_type_not_approved_for_stock: %', v_point.point_type
      USING ERRCODE = '23514';
  END IF;

  IF v_line.expiry_date IS NOT NULL AND v_line.expiry_date < current_date THEN
    RAISE EXCEPTION 'expired_batch_cannot_be_received' USING ERRCODE = '23514';
  END IF;

  v_line_status := CASE
    WHEN p_received_quantity = 0 THEN 'rejected'
    WHEN p_received_quantity = v_line.sent_quantity THEN 'accepted'
    ELSE 'accepted_with_difference'
  END;

  IF p_received_quantity = 0 THEN
    UPDATE public.warehouse_dispatch_lines
       SET status = 'rejected', received_quantity = 0,
           rejection_reason = v_reason, rejected_by = v_actor, rejected_at = now()
     WHERE id = v_line.id;

    PERFORM public.phoenix_recompute_warehouse_dispatch_header_status(v_dispatch.id);

    INSERT INTO public.audit_logs (
      organization_id, actor_id, actor_role,
      action, entity_type, entity_id, entity_label, payload
    ) VALUES (
      v_dispatch.organization_id, v_actor, v_actor_role,
      'outlet_stock.dispatch_rejected', 'warehouse_dispatch_lines', v_line.id,
      v_line.scientific_name,
      jsonb_build_object(
        'request_id', p_request_id,
        'dispatch_id', v_dispatch.id,
        'distribution_point_id', v_dispatch.destination_distribution_point_id,
        'sent_quantity', v_line.sent_quantity,
        'received_quantity', 0,
        'reason', v_reason
      )
    );

    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', false,
      'line_status', 'rejected', 'outlet_stock_id', NULL, 'movement_id', NULL,
      'quantity_before', 0, 'quantity_delta', 0, 'quantity_after', 0
    );
  END IF;

  INSERT INTO public.outlet_stock (
    organization_id, distribution_point_id, point_type, central_item_id,
    scientific_name, trade_name, concentration, dosage_form, unit,
    national_code, has_no_national_code,
    batch_number, has_no_batch_number, internal_batch_reference,
    expiry_date, on_hand_quantity, reserved_quantity,
    unit_price, price_basis, currency, supply_type_text,
    supply_type, purchase_origin,
    source_document_number, notes, created_by, updated_by
  ) VALUES (
    v_dispatch.organization_id, v_dispatch.destination_distribution_point_id,
    v_point.point_type, v_line.central_item_id,
    v_line.scientific_name, v_line.trade_name, v_line.concentration,
    v_line.dosage_form, v_line.unit,
    v_line.national_code, v_line.has_no_national_code,
    v_line.batch_number, v_line.has_no_batch_number, v_line.internal_batch_reference,
    v_line.expiry_date, 0, 0,
    v_line.unit_price, v_line.price_basis, v_line.currency, v_line.supply_type_text,
    v_line.supply_type, v_line.purchase_origin,
    v_dispatch.document_number, v_notes, v_actor, v_actor
  )
  ON CONFLICT DO NOTHING;

  SELECT * INTO v_stock
  FROM public.outlet_stock s
  WHERE s.distribution_point_id = v_dispatch.destination_distribution_point_id
    AND s.scientific_name = v_line.scientific_name
    AND COALESCE(s.concentration, '') = COALESCE(v_line.concentration, '')
    AND COALESCE(s.dosage_form, '')   = COALESCE(v_line.dosage_form, '')
    AND COALESCE(s.national_code, '') = COALESCE(v_line.national_code, '')
    AND COALESCE(s.batch_number, '')  = COALESCE(v_line.batch_number, '')
    AND COALESCE(s.expiry_date, DATE '0001-01-01')
        = COALESCE(v_line.expiry_date, DATE '0001-01-01')
    AND COALESCE(s.internal_batch_reference, '')
        = COALESCE(v_line.internal_batch_reference, '')
    AND COALESCE(s.supply_type, '') = COALESCE(v_line.supply_type, '')
    AND COALESCE(s.purchase_origin, '') = COALESCE(v_line.purchase_origin, '')
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'outlet_stock_identity_resolution_failed' USING ERRCODE = 'P0002';
  END IF;

  v_before := v_stock.on_hand_quantity;
  v_after  := v_before + p_received_quantity;

  UPDATE public.outlet_stock
     SET on_hand_quantity       = v_after,
         central_item_id        = COALESCE(v_stock.central_item_id, v_line.central_item_id),
         unit_price             = COALESCE(v_line.unit_price, unit_price),
         source_document_number = COALESCE(v_dispatch.document_number, source_document_number),
         notes                  = COALESCE(v_notes, notes),
         updated_by             = v_actor
   WHERE id = v_stock.id;

  -- 131: chain correlation_id/causation_id from the send-side movement,
  -- already resident via the SHARED dispatch_line_id join -- no new column.
  SELECT id, correlation_id INTO v_send_movement_id, v_correlation_id
  FROM public.warehouse_stock_movements
  WHERE reference_type = 'warehouse_dispatch_send' AND reference_id = p_dispatch_line_id;
  v_correlation_id := COALESCE(v_correlation_id, gen_random_uuid());

  INSERT INTO public.outlet_stock_movements (
    outlet_stock_id, organization_id, distribution_point_id,
    movement_type,
    on_hand_before, on_hand_delta, on_hand_after,
    reserved_before, reserved_delta, reserved_after,
    reason, reason_code, reference_type, reference_id, dispatch_line_id, request_fingerprint,
    source_document_number, actor_id, actor_role, actor_name,
    scientific_name_snapshot, concentration_snapshot, dosage_form_snapshot,
    batch_number_snapshot, internal_batch_reference_snapshot, expiry_date_snapshot,
    correlation_id, causation_id
  ) VALUES (
    v_stock.id, v_dispatch.organization_id, v_dispatch.destination_distribution_point_id,
    'dispatch_receive',
    v_before, p_received_quantity, v_after,
    v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
    v_reason, v_reason_code, 'outlet_request', p_request_id, v_line.id, v_fingerprint,
    v_dispatch.document_number, v_actor, v_actor_role, v_actor_name,
    v_stock.scientific_name, v_stock.concentration, v_stock.dosage_form,
    v_stock.batch_number, v_stock.internal_batch_reference, v_stock.expiry_date,
    v_correlation_id, v_send_movement_id
  )
  RETURNING id INTO v_movement_id;

  v_avail_id := public.phoenix_project_outlet_availability(v_stock.id);

  UPDATE public.warehouse_dispatch_lines
     SET status                         = v_line_status,
         received_quantity              = p_received_quantity,
         difference_reason              = v_reason,
         accepted_by                    = v_actor,
         accepted_at                    = now(),
         resulting_outlet_stock_id      = v_stock.id,
         resulting_item_availability_id = v_avail_id
   WHERE id = v_line.id;

  PERFORM public.phoenix_recompute_warehouse_dispatch_header_status(v_dispatch.id);

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role,
    action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_dispatch.organization_id, v_actor, v_actor_role,
    'outlet_stock.dispatch_receive', 'outlet_stock', v_stock.id,
    v_stock.scientific_name,
    jsonb_build_object(
      'request_id', p_request_id,
      'dispatch_id', v_dispatch.id,
      'dispatch_line_id', v_line.id,
      'distribution_point_id', v_dispatch.destination_distribution_point_id,
      'movement_id', v_movement_id,
      'line_status', v_line_status,
      'sent_quantity', v_line.sent_quantity,
      'quantity_before', v_before,
      'quantity_delta', p_received_quantity,
      'quantity_after', v_after,
      'reason', v_reason
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'line_status', v_line_status,
    'outlet_stock_id', v_stock.id,
    'movement_id', v_movement_id,
    'item_availability_id', v_avail_id,
    'quantity_before', v_before,
    'quantity_delta', p_received_quantity,
    'quantity_after', v_after
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_receive_outlet_dispatch_line(uuid, uuid, integer, text, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_receive_outlet_dispatch_line(uuid, uuid, integer, text, text, text)
  TO authenticated;

-- ── F2. phoenix_dispense_outlet_stock — reason_code='dispensed', fresh ──────
-- ── correlation_id, no causation (terminal consumption event) ───────────────

CREATE OR REPLACE FUNCTION public.phoenix_dispense_outlet_stock(
  p_request_id     uuid,
  p_outlet_stock_id uuid,
  p_quantity       integer,
  p_reason         text DEFAULT NULL,
  p_notes          text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor       uuid := auth.uid();
  v_actor_role  text;
  v_actor_name  text;
  v_stock       public.outlet_stock%ROWTYPE;
  v_existing    public.outlet_stock_movements%ROWTYPE;
  v_reason      text := NULLIF(btrim(p_reason), '');
  v_notes       text := NULLIF(btrim(p_notes), '');
  v_before      integer;
  v_after       integer;
  v_movement_id uuid;
  v_avail_id    uuid;
  v_fingerprint text;
  v_correlation_id uuid := gen_random_uuid();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_outlet_stock_id IS NULL THEN
    RAISE EXCEPTION 'outlet_stock_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;

  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'dispense',
    'outlet_stock_id', p_outlet_stock_id,
    'quantity', p_quantity,
    'reason', v_reason,
    'notes', v_notes
  )::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 67067));

  SELECT * INTO v_existing
  FROM public.outlet_stock_movements m
  WHERE m.reference_type = 'outlet_request' AND m.reference_id = p_request_id;

  IF FOUND THEN
    IF v_existing.outlet_stock_id IS DISTINCT FROM p_outlet_stock_id
       OR v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true,
      'outlet_stock_id', v_existing.outlet_stock_id,
      'movement_id', v_existing.id,
      'quantity_before', v_existing.on_hand_before,
      'quantity_delta', v_existing.on_hand_delta,
      'quantity_after', v_existing.on_hand_after
    );
  END IF;

  SELECT * INTO v_stock
  FROM public.outlet_stock WHERE id = p_outlet_stock_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'outlet_stock_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'outlet_stock.dispense', v_stock.organization_id,
    NULL, v_stock.distribution_point_id
  ) THEN
    RAISE EXCEPTION 'forbidden_outlet_stock_dispense' USING ERRCODE = '42501';
  END IF;

  SELECT p.role, p.full_name INTO v_actor_role, v_actor_name
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  IF v_stock.expiry_date IS NOT NULL AND v_stock.expiry_date < current_date THEN
    RAISE EXCEPTION 'expired_batch_cannot_be_dispensed' USING ERRCODE = '23514';
  END IF;

  v_before := v_stock.on_hand_quantity;
  v_after  := v_before - p_quantity;

  IF v_after < 0 THEN
    RAISE EXCEPTION 'outlet_quantity_cannot_go_negative' USING ERRCODE = '23514';
  END IF;
  IF v_after < v_stock.reserved_quantity THEN
    RAISE EXCEPTION 'outlet_quantity_below_reserved' USING ERRCODE = '23514';
  END IF;

  UPDATE public.outlet_stock
     SET on_hand_quantity = v_after,
         notes            = COALESCE(v_notes, notes),
         updated_by       = v_actor
   WHERE id = v_stock.id;

  INSERT INTO public.outlet_stock_movements (
    outlet_stock_id, organization_id, distribution_point_id,
    movement_type,
    on_hand_before, on_hand_delta, on_hand_after,
    reserved_before, reserved_delta, reserved_after,
    reason, reason_code, reference_type, reference_id, request_fingerprint,
    actor_id, actor_role, actor_name,
    scientific_name_snapshot, concentration_snapshot, dosage_form_snapshot,
    batch_number_snapshot, internal_batch_reference_snapshot, expiry_date_snapshot,
    correlation_id
  ) VALUES (
    v_stock.id, v_stock.organization_id, v_stock.distribution_point_id,
    'dispense',
    v_before, -p_quantity, v_after,
    v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
    v_reason, 'dispensed', 'outlet_request', p_request_id, v_fingerprint,
    v_actor, v_actor_role, v_actor_name,
    v_stock.scientific_name, v_stock.concentration, v_stock.dosage_form,
    v_stock.batch_number, v_stock.internal_batch_reference, v_stock.expiry_date,
    v_correlation_id
  )
  RETURNING id INTO v_movement_id;

  v_avail_id := public.phoenix_project_outlet_availability(v_stock.id);

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role,
    action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_stock.organization_id, v_actor, v_actor_role,
    'outlet_stock.dispense', 'outlet_stock', v_stock.id, v_stock.scientific_name,
    jsonb_build_object(
      'request_id', p_request_id,
      'distribution_point_id', v_stock.distribution_point_id,
      'movement_id', v_movement_id,
      'quantity_before', v_before,
      'quantity_delta', -p_quantity,
      'quantity_after', v_after,
      'reason', v_reason
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'outlet_stock_id', v_stock.id,
    'movement_id', v_movement_id,
    'item_availability_id', v_avail_id,
    'quantity_before', v_before,
    'quantity_delta', -p_quantity,
    'quantity_after', v_after
  );
END;
$$;

-- ── F3. phoenix_count_outlet_stock — mandatory validated reason_code ────────

DROP FUNCTION IF EXISTS public.phoenix_count_outlet_stock(
  uuid, uuid, integer, text, text
);

CREATE OR REPLACE FUNCTION public.phoenix_count_outlet_stock(
  p_request_id       uuid,
  p_outlet_stock_id  uuid,
  p_counted_quantity integer,
  p_reason           text,
  p_notes            text DEFAULT NULL,
  p_reason_code      text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor       uuid := auth.uid();
  v_actor_role  text;
  v_actor_name  text;
  v_stock       public.outlet_stock%ROWTYPE;
  v_existing    public.outlet_stock_movements%ROWTYPE;
  v_reason      text := NULLIF(btrim(p_reason), '');
  v_reason_code text := NULLIF(btrim(p_reason_code), '');
  v_notes       text := NULLIF(btrim(p_notes), '');
  v_before      integer;
  v_delta       integer;
  v_movement_id uuid;
  v_avail_id    uuid;
  v_fingerprint text;
  v_correlation_id uuid := gen_random_uuid();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_outlet_stock_id IS NULL THEN
    RAISE EXCEPTION 'outlet_stock_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_counted_quantity IS NULL OR p_counted_quantity < 0 THEN
    RAISE EXCEPTION 'counted_quantity_must_be_non_negative' USING ERRCODE = '23514';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'outlet_count_reason_required' USING ERRCODE = '23514';
  END IF;

  -- 131: reason_code is mandatory in lockstep with the existing free-text
  -- reason -- unlike Group A's add/subtract, a physical count always has a
  -- deliberate cause and no safe silent default.
  IF v_reason_code IS NOT NULL AND v_reason_code NOT IN (
    'excess', 'shipment_error', 'near_expiry', 'expired', 'damaged',
    'recalled', 'quality_issue', 'temperature_excursion', 'corrected', 'other'
  ) THEN
    RAISE EXCEPTION 'invalid_outlet_count_reason_code' USING ERRCODE = '23514';
  END IF;
  IF v_reason_code IS NULL THEN
    RAISE EXCEPTION 'outlet_count_reason_code_required' USING ERRCODE = '23514';
  END IF;

  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'count',
    'outlet_stock_id', p_outlet_stock_id,
    'counted_quantity', p_counted_quantity,
    'reason', v_reason,
    'notes', v_notes
  )::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 67067));

  SELECT * INTO v_existing
  FROM public.outlet_stock_movements m
  WHERE m.reference_type = 'outlet_request' AND m.reference_id = p_request_id;

  IF FOUND THEN
    IF v_existing.outlet_stock_id IS DISTINCT FROM p_outlet_stock_id
       OR v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true,
      'outlet_stock_id', v_existing.outlet_stock_id,
      'movement_id', v_existing.id,
      'quantity_before', v_existing.on_hand_before,
      'quantity_delta', v_existing.on_hand_delta,
      'quantity_after', v_existing.on_hand_after
    );
  END IF;

  SELECT * INTO v_stock
  FROM public.outlet_stock WHERE id = p_outlet_stock_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'outlet_stock_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'outlet_stock.count', v_stock.organization_id,
    NULL, v_stock.distribution_point_id
  ) THEN
    RAISE EXCEPTION 'forbidden_outlet_stock_count' USING ERRCODE = '42501';
  END IF;

  SELECT p.role, p.full_name INTO v_actor_role, v_actor_name
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  v_before := v_stock.on_hand_quantity;
  v_delta  := p_counted_quantity - v_before;

  IF p_counted_quantity < v_stock.reserved_quantity THEN
    RAISE EXCEPTION 'outlet_quantity_below_reserved' USING ERRCODE = '23514';
  END IF;

  UPDATE public.outlet_stock
     SET on_hand_quantity = p_counted_quantity,
         notes            = COALESCE(v_notes, notes),
         updated_by       = v_actor
   WHERE id = v_stock.id;

  INSERT INTO public.outlet_stock_movements (
    outlet_stock_id, organization_id, distribution_point_id,
    movement_type,
    on_hand_before, on_hand_delta, on_hand_after,
    reserved_before, reserved_delta, reserved_after,
    reason, reason_code, reference_type, reference_id, request_fingerprint,
    actor_id, actor_role, actor_name,
    scientific_name_snapshot, concentration_snapshot, dosage_form_snapshot,
    batch_number_snapshot, internal_batch_reference_snapshot, expiry_date_snapshot,
    correlation_id
  ) VALUES (
    v_stock.id, v_stock.organization_id, v_stock.distribution_point_id,
    'correction',
    v_before, v_delta, p_counted_quantity,
    v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
    v_reason, v_reason_code, 'outlet_request', p_request_id, v_fingerprint,
    v_actor, v_actor_role, v_actor_name,
    v_stock.scientific_name, v_stock.concentration, v_stock.dosage_form,
    v_stock.batch_number, v_stock.internal_batch_reference, v_stock.expiry_date,
    v_correlation_id
  )
  RETURNING id INTO v_movement_id;

  v_avail_id := public.phoenix_project_outlet_availability(v_stock.id);

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role,
    action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_stock.organization_id, v_actor, v_actor_role,
    'outlet_stock.count', 'outlet_stock', v_stock.id, v_stock.scientific_name,
    jsonb_build_object(
      'request_id', p_request_id,
      'distribution_point_id', v_stock.distribution_point_id,
      'movement_id', v_movement_id,
      'quantity_before', v_before,
      'quantity_delta', v_delta,
      'quantity_after', p_counted_quantity,
      'reason', v_reason
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'outlet_stock_id', v_stock.id,
    'movement_id', v_movement_id,
    'item_availability_id', v_avail_id,
    'quantity_before', v_before,
    'quantity_delta', v_delta,
    'quantity_after', p_counted_quantity
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_count_outlet_stock(uuid, uuid, integer, text, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_count_outlet_stock(uuid, uuid, integer, text, text, text)
  TO authenticated;

-- ── F4. phoenix_send_outlet_return_shipment_line — propagates v_line.reason_code ─
-- ── chains from the ALREADY-RESIDENT original_inbound_movement_id ───────────

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

-- ── F5. phoenix_send_warehouse_dispatch — the send-half of Group F's own ────
-- ── corridor; NOT one of the 20 originally audited writers, fixed here ──────

CREATE OR REPLACE FUNCTION public.phoenix_send_warehouse_dispatch(
  p_request_id  uuid,
  p_dispatch_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor       uuid := auth.uid();
  v_actor_role  text;
  v_actor_name  text;
  v_dispatch    public.warehouse_dispatches%ROWTYPE;
  v_warehouse   public.warehouses%ROWTYPE;
  v_point       public.distribution_points%ROWTYPE;
  v_line        RECORD;
  v_stock       public.warehouse_stock%ROWTYPE;
  v_before      integer;
  v_after       integer;
  v_movement_id uuid;
  v_fingerprint text;
  v_line_count  integer := 0;
  v_total_for_stock integer;
  v_movement_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL OR p_dispatch_id IS NULL THEN
    RAISE EXCEPTION 'request_id_and_dispatch_id_required' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 70169));

  SELECT * INTO v_dispatch
  FROM public.warehouse_dispatches WHERE id = p_dispatch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dispatch_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_dispatch.status = 'cancelled' THEN
    RAISE EXCEPTION 'dispatch_cancelled' USING ERRCODE = '23514';
  ELSIF v_dispatch.status IN ('sent', 'partially_accepted', 'accepted', 'rejected') THEN
    RETURN jsonb_build_object('ok', true, 'idempotent_replay', true, 'dispatch_id', v_dispatch.id, 'status', v_dispatch.status);
  ELSIF v_dispatch.status <> 'draft' THEN
    RAISE EXCEPTION 'dispatch_unexpected_status: %', v_dispatch.status USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.warehouse_dispatch_lines WHERE dispatch_id = v_dispatch.id) THEN
    RAISE EXCEPTION 'dispatch_has_no_lines' USING ERRCODE = '23514';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'warehouse_dispatch.send', v_dispatch.organization_id, v_dispatch.warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_warehouse_dispatch_send' USING ERRCODE = '42501';
  END IF;

  SELECT p.role, p.full_name INTO v_actor_role, v_actor_name
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_warehouse
  FROM public.warehouses WHERE id = v_dispatch.warehouse_id FOR SHARE;
  IF NOT FOUND OR v_warehouse.status <> 'active' THEN
    RAISE EXCEPTION 'warehouse_not_found_or_inactive' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_point
  FROM public.distribution_points WHERE id = v_dispatch.destination_distribution_point_id FOR SHARE;
  IF NOT FOUND OR v_point.status <> 'active' THEN
    RAISE EXCEPTION 'destination_outlet_not_found_or_inactive' USING ERRCODE = '23514';
  END IF;
  IF v_point.point_type NOT IN ('pharmacy', 'crash_cabinet', 'rescue_cart') THEN
    RAISE EXCEPTION 'outlet_type_not_approved_for_stock: %', v_point.point_type USING ERRCODE = '23514';
  END IF;
  IF v_point.warehouse_id IS DISTINCT FROM v_dispatch.warehouse_id THEN
    RAISE EXCEPTION 'destination_outlet_not_paired_with_this_warehouse' USING ERRCODE = '23514';
  END IF;

  v_line_count := (SELECT count(*) FROM public.warehouse_dispatch_lines WHERE dispatch_id = v_dispatch.id);

  FOR v_stock IN
    SELECT s.* FROM public.warehouse_stock s
    WHERE s.id IN (
      SELECT DISTINCT warehouse_stock_id FROM public.warehouse_dispatch_lines
      WHERE dispatch_id = v_dispatch.id
    )
    ORDER BY s.id
    FOR UPDATE
  LOOP
    SELECT coalesce(sum(l.sent_quantity), 0) INTO v_total_for_stock
    FROM public.warehouse_dispatch_lines l
    WHERE l.dispatch_id = v_dispatch.id AND l.warehouse_stock_id = v_stock.id;

    IF v_stock.on_hand_quantity - v_stock.reserved_quantity < v_total_for_stock THEN
      RAISE EXCEPTION 'insufficient_available_quantity_for_stock: %', v_stock.id USING ERRCODE = '23514';
    END IF;
    IF v_stock.expiry_date IS NOT NULL AND v_stock.expiry_date < current_date THEN
      RAISE EXCEPTION 'expired_batch_cannot_be_dispatched: %', v_stock.id USING ERRCODE = '23514';
    END IF;
  END LOOP;

  FOR v_line IN
    SELECT * FROM public.warehouse_dispatch_lines
    WHERE dispatch_id = v_dispatch.id
    ORDER BY id
  LOOP
    IF EXISTS (
      SELECT 1 FROM public.warehouse_stock_movements
      WHERE reference_type = 'warehouse_dispatch_send' AND reference_id = v_line.id
    ) THEN
      CONTINUE;
    END IF;

    SELECT * INTO v_stock FROM public.warehouse_stock WHERE id = v_line.warehouse_stock_id FOR UPDATE;

    v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
      'operation', 'warehouse_dispatch_send',
      'dispatch_line_id', v_line.id,
      'quantity', v_line.sent_quantity
    )::text, 'UTF8')), 'hex');

    v_before := v_stock.on_hand_quantity;
    v_after  := v_before - v_line.sent_quantity;

    UPDATE public.warehouse_stock
       SET on_hand_quantity = v_after, updated_by = v_actor
     WHERE id = v_stock.id;

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
      v_before, -v_line.sent_quantity, v_after,
      v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
      'warehouse_dispatch_send', 'transferred', 'warehouse_dispatch_send', v_line.id, v_fingerprint,
      v_dispatch.document_number, v_actor, v_actor_role, v_actor_name,
      v_stock.scientific_name, v_stock.concentration,
      v_stock.dosage_form, v_stock.batch_number,
      v_stock.internal_batch_reference,
      gen_random_uuid()
    )
    RETURNING id INTO v_movement_id;

    v_movement_ids := v_movement_ids || v_movement_id;
  END LOOP;

  UPDATE public.warehouse_dispatches
     SET status = 'sent', sent_by = v_actor, sent_at = now()
   WHERE id = v_dispatch.id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_dispatch.organization_id, v_actor, v_actor_role,
    'warehouse_dispatch.sent', 'warehouse_dispatches', v_dispatch.id, v_dispatch.dispatch_number,
    jsonb_build_object('request_id', p_request_id, 'line_count', v_line_count, 'movement_ids', to_jsonb(v_movement_ids))
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'dispatch_id', v_dispatch.id, 'status', 'sent',
    'line_count', v_line_count, 'movement_ids', to_jsonb(v_movement_ids)
  );
END;
$$;

DO $verify$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc p
  WHERE p.proname IN (
    'phoenix_receive_outlet_dispatch_line', 'phoenix_dispense_outlet_stock',
    'phoenix_count_outlet_stock', 'phoenix_send_outlet_return_shipment_line',
    'phoenix_send_warehouse_dispatch'
  )
    AND p.pronamespace = 'public'::regnamespace;
  IF v_count <> 5 THEN
    RAISE EXCEPTION '131 VERIFY FAILED: expected exactly 5 Group F functions, found %', v_count;
  END IF;

  RAISE NOTICE 'MOVEMENT-REASON-CODE-GROUP-F-OUTLET-131: verified.';
END;
$verify$;
