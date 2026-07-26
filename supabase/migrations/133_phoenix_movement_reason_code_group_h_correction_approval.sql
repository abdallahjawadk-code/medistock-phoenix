-- ============================================================================
-- MOVEMENT-REASON-CODE-GROUP-H-CORRECTION-APPROVAL-133
--
-- Nineteenth slice of Unified Movements & Outlet Operations (PR #57, item
-- A). Eighth and FINAL of eight domain slices wiring reason_code + server-
-- owned correlation_id/causation_id into the 20 audited ledger-writer RPCs.
--
-- GROUP H — second-person correction approval, the two remaining writers:
--
--   * phoenix_approve_outlet_stock_correction (098) — writes
--     outlet_stock_movements directly (NOT delegated to
--     phoenix_count_outlet_stock_guarded, by design: approval authority is
--     independent of counting authority). reason_code hardcoded to
--     'corrected' (125's vocabulary) -- this is always a correction-request
--     approval, never any other operation.
--
--   * phoenix_approve_warehouse_stock_correction (101) — writes
--     warehouse_stock_movements directly, same fix: reason_code hardcoded
--     to 'corrected'.
--
-- Neither writer needs a new parameter: the correction-request row (already
-- FOR UPDATE locked) carries everything needed, and reason_code is a fixed
-- constant for this operation, not derived from client input.
--
-- CORRELATION/CAUSATION: neither request row (phoenix_stock_correction_
-- requests / phoenix_warehouse_correction_requests) is itself a movement,
-- so there is no single-hop movement_id to reuse the way Groups D/E do. The
-- real predecessor is the MOST RECENT prior movement against this exact
-- stock row (queried before this call's own INSERT) -- typically the
-- original count/receipt that produced the on_hand_quantity this correction
-- now revises. Its correlation_id is reused and its own id becomes
-- causation_id -- a real, queryable predecessor, never a guess. A stock row
-- with no prior movement (freshly created, never moved) falls back to a
-- fresh correlation_id and NULL causation_id, exactly as Group G's first-
-- ever-movement case.
--
-- This is the LAST of the 8 groups: once 133 applies, all 20 originally
-- audited writer RPCs (plus the 2 real gaps found mid-slice in Groups A and
-- F) have reason_code + correlation_id/causation_id wired.
--
-- PRECONDITIONS: 132 applied (Group G slice).
-- ============================================================================

DO $precond$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'phoenix_release_quarantine_stock'
       AND p.pronamespace = 'public'::regnamespace
       AND pg_get_function_arguments(p.oid) LIKE '%p_destination_warehouse_stock_id%'
  ) THEN
    RAISE EXCEPTION '133 PRECONDITION FAILED: 132 (Group G slice) missing — apply 132 first';
  END IF;
END;
$precond$;

-- ── H1. phoenix_approve_outlet_stock_correction — reason_code='corrected' ──

CREATE OR REPLACE FUNCTION public.phoenix_approve_outlet_stock_correction(
  p_correction_request_id uuid,
  p_expected_generation   bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $approve$
DECLARE
  v_actor  uuid := auth.uid();
  v_req    public.phoenix_stock_correction_requests%ROWTYPE;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_correction_request_id IS NULL THEN
    RAISE EXCEPTION 'correction_request_id_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_req
  FROM public.phoenix_stock_correction_requests WHERE id = p_correction_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'correction_request_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'correction_request_not_pending' USING ERRCODE = '23514';
  END IF;

  -- THE gate: the proposer can never be their own approver, by identity, not
  -- by role — checked BEFORE the permission check so a proposer who also
  -- happens to hold the approval permission is still refused.
  IF v_req.proposed_by = v_actor THEN
    RAISE EXCEPTION 'proposer_cannot_approve_own_correction' USING ERRCODE = '42501';
  END IF;

  IF NOT public.phoenix_status_center_authorized(v_req.organization_id, 'outlet_stock.approve_correction') THEN
    RAISE EXCEPTION 'forbidden_correction_approval' USING ERRCODE = '42501';
  END IF;

  -- NOT delegated to phoenix_count_outlet_stock_guarded: that RPC
  -- authorizes against outlet_stock.count of the CURRENT caller, which
  -- would require the APPROVER to also hold counting authority —
  -- central_warehouse_manager (the only role granted approve_correction)
  -- deliberately does NOT hold outlet_stock.count (067), and it must not
  -- need to: approval authority is a stronger, independent gate already
  -- checked above, not a substitute for counting authority nor something
  -- that should require it. The write is therefore applied directly here,
  -- reusing 086/067's exact generation-guard + movement shape.
  DECLARE
    v_stock  public.outlet_stock%ROWTYPE;
    v_actor_role text;
    v_actor_name text;
    v_movement_id uuid;
    v_avail_id    uuid;
    v_fp          text;
    v_predecessor_id uuid;
    v_correlation_id uuid;
  BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(v_req.underlying_request_id::text, 67067));

    SELECT * INTO v_stock FROM public.outlet_stock WHERE id = v_req.outlet_stock_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'outlet_stock_not_found' USING ERRCODE = 'P0002';
    END IF;

    IF p_expected_generation IS NOT NULL AND v_stock.movement_seq IS DISTINCT FROM p_expected_generation THEN
      RAISE EXCEPTION 'outlet_stock_generation_conflict' USING ERRCODE = '40001',
        DETAIL = format('expected generation %s, canonical generation %s', p_expected_generation, v_stock.movement_seq);
    END IF;
    IF v_req.counted_quantity < v_stock.reserved_quantity THEN
      RAISE EXCEPTION 'outlet_quantity_below_reserved' USING ERRCODE = '23514';
    END IF;

    SELECT p.role, p.full_name INTO v_actor_role, v_actor_name FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';

    v_fp := encode(sha256(convert_to(jsonb_build_object(
      'operation', 'count', 'outlet_stock_id', v_req.outlet_stock_id,
      'counted_quantity', v_req.counted_quantity, 'reason', v_req.reason, 'notes', v_req.notes
    )::text, 'UTF8')), 'hex');

    -- 133: the real predecessor is whatever most recently touched this
    -- exact outlet stock row -- typically the count/receipt this correction
    -- revises. Queried BEFORE this call's own INSERT, so it never finds
    -- itself.
    SELECT id, correlation_id INTO v_predecessor_id, v_correlation_id
    FROM public.outlet_stock_movements
    WHERE outlet_stock_id = v_stock.id
    ORDER BY created_at DESC
    LIMIT 1;
    v_correlation_id := COALESCE(v_correlation_id, gen_random_uuid());

    UPDATE public.outlet_stock
       SET on_hand_quantity = v_req.counted_quantity, notes = COALESCE(v_req.notes, notes), updated_by = v_actor
     WHERE id = v_stock.id;

    INSERT INTO public.outlet_stock_movements (
      outlet_stock_id, organization_id, distribution_point_id, movement_type,
      on_hand_before, on_hand_delta, on_hand_after,
      reserved_before, reserved_delta, reserved_after,
      reason, reason_code, reference_type, reference_id, request_fingerprint,
      actor_id, actor_role, actor_name,
      scientific_name_snapshot, concentration_snapshot, dosage_form_snapshot,
      batch_number_snapshot, internal_batch_reference_snapshot, expiry_date_snapshot,
      correlation_id, causation_id
    ) VALUES (
      v_stock.id, v_stock.organization_id, v_stock.distribution_point_id, 'correction',
      v_stock.on_hand_quantity, v_req.counted_quantity - v_stock.on_hand_quantity, v_req.counted_quantity,
      v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
      v_req.reason, 'corrected', 'outlet_request', v_req.underlying_request_id, v_fp,
      v_actor, v_actor_role, v_actor_name,
      v_stock.scientific_name, v_stock.concentration, v_stock.dosage_form,
      v_stock.batch_number, v_stock.internal_batch_reference, v_stock.expiry_date,
      v_correlation_id, v_predecessor_id
    )
    RETURNING id INTO v_movement_id;

    v_avail_id := public.phoenix_project_outlet_availability(v_stock.id);

    v_result := jsonb_build_object(
      'ok', true, 'outlet_stock_id', v_stock.id, 'movement_id', v_movement_id,
      'quantity_before', v_stock.on_hand_quantity, 'quantity_after', v_req.counted_quantity
    );
  END;

  UPDATE public.phoenix_stock_correction_requests
     SET status = 'approved', decided_by = v_actor, decided_at = now(),
         applied_movement_id = NULLIF(v_result ->> 'movement_id', '')::uuid
   WHERE id = v_req.id;

  RETURN v_result || jsonb_build_object('correction_request_id', v_req.id, 'status', 'approved');
END;
$approve$;

-- Signature unchanged; no privilege change to reapply.

-- ── H2. phoenix_approve_warehouse_stock_correction — reason_code='corrected' ─

CREATE OR REPLACE FUNCTION public.phoenix_approve_warehouse_stock_correction(
  p_correction_request_id uuid,
  p_expected_generation   bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $approve$
DECLARE
  v_actor  uuid := auth.uid();
  v_req    public.phoenix_warehouse_correction_requests%ROWTYPE;
  v_stock  public.warehouse_stock%ROWTYPE;
  v_actor_role text;
  v_actor_name text;
  v_before integer;
  v_delta  integer;
  v_movement_id uuid;
  v_fp     text;
  v_predecessor_id uuid;
  v_correlation_id uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_correction_request_id IS NULL THEN
    RAISE EXCEPTION 'correction_request_id_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_req
  FROM public.phoenix_warehouse_correction_requests WHERE id = p_correction_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'correction_request_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'correction_request_not_pending' USING ERRCODE = '23514';
  END IF;
  IF v_req.proposed_by = v_actor THEN
    RAISE EXCEPTION 'proposer_cannot_approve_own_correction' USING ERRCODE = '42501';
  END IF;
  IF NOT public.phoenix_status_center_authorized(v_req.organization_id, 'warehouse_stock.approve_correction') THEN
    RAISE EXCEPTION 'forbidden_correction_approval' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_req.underlying_request_id::text, 65065));

  SELECT * INTO v_stock FROM public.warehouse_stock WHERE id = v_req.warehouse_stock_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse_stock_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF p_expected_generation IS NOT NULL AND v_stock.movement_seq IS DISTINCT FROM p_expected_generation THEN
    RAISE EXCEPTION 'warehouse_receipt_generation_conflict' USING ERRCODE = '40001',
      DETAIL = format('expected generation %s, canonical generation %s', p_expected_generation, v_stock.movement_seq);
  END IF;

  v_before := v_stock.on_hand_quantity;
  v_delta  := v_req.new_quantity - v_before;
  IF v_req.new_quantity < 0 THEN
    RAISE EXCEPTION 'warehouse_quantity_cannot_go_negative' USING ERRCODE = '23514';
  END IF;
  IF v_req.new_quantity < v_stock.reserved_quantity THEN
    RAISE EXCEPTION 'warehouse_quantity_below_reserved' USING ERRCODE = '23514';
  END IF;

  SELECT p.role, p.full_name INTO v_actor_role, v_actor_name FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';

  v_fp := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'adjust', 'warehouse_stock_id', v_req.warehouse_stock_id, 'movement_type', 'correction',
    'amount', v_req.new_quantity, 'reason', v_req.reason,
    'source_document_number', v_req.source_document_number, 'notes', v_req.notes
  )::text, 'UTF8')), 'hex');

  -- 133: the real predecessor is whatever most recently touched this exact
  -- warehouse stock row -- typically the receipt/count this correction
  -- revises. Queried BEFORE this call's own INSERT, so it never finds
  -- itself.
  SELECT id, correlation_id INTO v_predecessor_id, v_correlation_id
  FROM public.warehouse_stock_movements
  WHERE warehouse_stock_id = v_stock.id
  ORDER BY created_at DESC
  LIMIT 1;
  v_correlation_id := COALESCE(v_correlation_id, gen_random_uuid());

  UPDATE public.warehouse_stock
     SET on_hand_quantity = v_req.new_quantity,
         source_document_number = COALESCE(v_req.source_document_number, source_document_number),
         notes = COALESCE(v_req.notes, notes),
         updated_by = v_actor
   WHERE id = v_stock.id;

  INSERT INTO public.warehouse_stock_movements (
    warehouse_stock_id, organization_id, warehouse_id, movement_type,
    on_hand_before, on_hand_delta, on_hand_after,
    reserved_before, reserved_delta, reserved_after,
    reason, reason_code, reference_type, reference_id, request_fingerprint,
    source_document_number, actor_id, actor_role, actor_name,
    scientific_name_snapshot, concentration_snapshot, dosage_form_snapshot,
    batch_number_snapshot, internal_batch_reference_snapshot,
    correlation_id, causation_id
  ) VALUES (
    v_stock.id, v_stock.organization_id, v_stock.warehouse_id, 'correction',
    v_before, v_delta, v_req.new_quantity,
    v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
    v_req.reason, 'corrected', 'warehouse_request', v_req.underlying_request_id, v_fp,
    v_req.source_document_number, v_actor, v_actor_role, v_actor_name,
    v_stock.scientific_name, v_stock.concentration, v_stock.dosage_form,
    v_stock.batch_number, v_stock.internal_batch_reference,
    v_correlation_id, v_predecessor_id
  )
  RETURNING id INTO v_movement_id;

  UPDATE public.phoenix_warehouse_correction_requests
     SET status = 'approved', decided_by = v_actor, decided_at = now(), applied_movement_id = v_movement_id
   WHERE id = v_req.id;

  RETURN jsonb_build_object(
    'ok', true, 'warehouse_stock_id', v_stock.id, 'movement_id', v_movement_id,
    'quantity_before', v_before, 'quantity_after', v_req.new_quantity,
    'correction_request_id', v_req.id, 'status', 'approved'
  );
END;
$approve$;

-- Signature unchanged; no privilege change to reapply.

DO $verify$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc p
  WHERE p.proname IN ('phoenix_approve_outlet_stock_correction', 'phoenix_approve_warehouse_stock_correction')
    AND p.pronamespace = 'public'::regnamespace;
  IF v_count <> 2 THEN
    RAISE EXCEPTION '133 VERIFY FAILED: expected exactly 2 Group H functions, found %', v_count;
  END IF;

  RAISE NOTICE 'MOVEMENT-REASON-CODE-GROUP-H-CORRECTION-APPROVAL-133: verified. All 8 groups complete.';
END;
$verify$;
