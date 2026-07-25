-- ============================================================================
-- RETURN-AVAILABILITY-CAP-095-A
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply after 094.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE GAP THIS CLOSES
-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 2 contract: `returnable = received − dispensed − reserved −
-- previously_returned`. 069's phoenix_add_warehouse_return_request_line and
-- 071's phoenix_add_outlet_return_request_line already enforce
-- `received − previously_returned` (via each line's own received_quantity/
-- returned_quantity columns) but NEVER check the SOURCE STOCK ROW'S current
-- balance. A lot that was received, then partly dispatched onward to outlets
-- (institution warehouse) or dispensed to a patient (outlet, via 067's
-- phoenix_dispense_outlet_stock) or reserved for an in-flight request, could
-- still be "returned" up to its full historical received quantity — a return
-- for material that has physically already left the building.
--
-- FIX: both RPCs now ALSO lock the source stock row (warehouse_stock /
-- outlet_stock) FOR UPDATE and cap the request additionally by
-- `on_hand_quantity − reserved_quantity` (that row's CURRENT available
-- balance). on_hand_quantity is decremented by every write that moves
-- material OUT of the lot (dispatch send, dispense, prior return send,
-- correction), so "current available" already nets out "dispensed" without
-- inventing a new tracked column. reserved_quantity nets out "reserved". The
-- historical received/returned check still runs too — the effective cap is
-- the MINIMUM of both, closing the formula exactly:
--   returnable = MIN(received − previously_returned, on_hand − reserved)
--              = received − dispensed − reserved − previously_returned
-- (the two dispensed/on_hand terms are the same fact expressed two ways: what
-- left the lot is exactly on_hand's decrease from received).
--
-- Both functions are FULL redefinitions (same signature/name, no overload),
-- with every existing line of business logic preserved verbatim except the
-- one new lock + check inserted at the same point the old cap already sat.
-- ============================================================================

BEGIN;

DO $precond$
BEGIN
  IF to_regprocedure(
    'public.phoenix_add_warehouse_return_request_line(uuid,uuid,integer,text,text)'
  ) IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 069 phoenix_add_warehouse_return_request_line is missing';
  END IF;
  IF to_regprocedure(
    'public.phoenix_add_outlet_return_request_line(uuid,uuid,integer,text,text)'
  ) IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 071 phoenix_add_outlet_return_request_line is missing';
  END IF;
END;
$precond$;

-- ── A. Institution -> central return line (069) ────────────────────────────

CREATE OR REPLACE FUNCTION public.phoenix_add_warehouse_return_request_line(
  p_return_request_id         uuid,
  p_original_transfer_line_id uuid,
  p_requested_quantity        integer,
  p_reason_code                text,
  p_reason_text                 text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor     uuid := auth.uid();
  v_request   public.warehouse_return_requests%ROWTYPE;
  v_orig      public.warehouse_transfer_lines%ROWTYPE;
  v_remaining integer;
  v_available integer;
  v_line_id   uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_return_request_id IS NULL OR p_original_transfer_line_id IS NULL THEN
    RAISE EXCEPTION 'request_and_original_line_required' USING ERRCODE = '23514';
  END IF;
  IF p_requested_quantity IS NULL OR p_requested_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;
  IF p_reason_code IS NULL THEN
    RAISE EXCEPTION 'reason_code_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_request
  FROM public.warehouse_return_requests WHERE id = p_return_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_request_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'warehouse_transfer.return_request',
    v_request.source_organization_id, v_request.source_warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_warehouse_return_request' USING ERRCODE = '42501';
  END IF;

  IF v_request.status <> 'draft' THEN
    RAISE EXCEPTION 'return_request_not_draft' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_orig
  FROM public.warehouse_transfer_lines WHERE id = p_original_transfer_line_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'original_transfer_line_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_orig.resulting_warehouse_stock_id IS NULL THEN
    RAISE EXCEPTION 'original_line_not_received' USING ERRCODE = '23514';
  END IF;

  -- 095: lock the CANONICAL source stock row while the cap is computed, so a
  -- concurrent dispatch-send/dispense/correction against the SAME lot cannot
  -- race this check.
  DECLARE
    v_stock public.warehouse_stock%ROWTYPE;
  BEGIN
    SELECT * INTO v_stock
    FROM public.warehouse_stock s
    WHERE s.id = v_orig.resulting_warehouse_stock_id
      AND s.organization_id = v_request.source_organization_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'original_line_not_at_this_institution' USING ERRCODE = '42501';
    END IF;
    v_available := COALESCE(v_stock.on_hand_quantity, 0) - COALESCE(v_stock.reserved_quantity, 0);
  END;

  v_remaining := COALESCE(v_orig.received_quantity, 0) - v_orig.returned_quantity;
  IF p_requested_quantity > v_remaining THEN
    RAISE EXCEPTION 'requested_quantity_exceeds_returnable' USING ERRCODE = '23514';
  END IF;
  IF p_requested_quantity > v_available THEN
    RAISE EXCEPTION 'requested_quantity_exceeds_current_availability' USING ERRCODE = '23514',
      DETAIL = format('requested %s, currently available %s (on_hand - reserved)',
                       p_requested_quantity, v_available);
  END IF;

  INSERT INTO public.warehouse_return_request_lines (
    return_request_id, source_organization_id, original_transfer_line_id,
    scientific_name, concentration, dosage_form, unit,
    national_code, batch_number, internal_batch_reference, expiry_date,
    reason_code, reason_text, requested_quantity
  ) VALUES (
    v_request.id, v_request.source_organization_id, v_orig.id,
    v_orig.scientific_name, v_orig.concentration, v_orig.dosage_form, v_orig.unit,
    v_orig.national_code, v_orig.batch_number, v_orig.internal_batch_reference, v_orig.expiry_date,
    p_reason_code, NULLIF(btrim(p_reason_text), ''), p_requested_quantity
  )
  RETURNING id INTO v_line_id;

  RETURN jsonb_build_object('ok', true, 'return_request_line_id', v_line_id);
END;
$$;

-- ── B. Outlet -> institution return line (071) ──────────────────────────────

CREATE OR REPLACE FUNCTION public.phoenix_add_outlet_return_request_line(
  p_return_request_id           uuid,
  p_original_dispatch_line_id    uuid DEFAULT NULL,
  p_requested_quantity           integer DEFAULT NULL,
  p_reason_code                  text DEFAULT NULL,
  p_reason_text                  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor        uuid := auth.uid();
  v_actor_role   text;
  v_request      public.outlet_return_requests%ROWTYPE;
  v_dispatch     public.warehouse_dispatch_lines%ROWTYPE;
  v_movement     public.outlet_stock_movements%ROWTYPE;
  v_stock        public.outlet_stock%ROWTYPE;
  v_reason_text  text := NULLIF(btrim(p_reason_text), '');
  v_line         public.outlet_return_request_lines%ROWTYPE;
  v_cap          integer;
  v_available    integer;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_return_request_id IS NULL THEN
    RAISE EXCEPTION 'return_request_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_original_dispatch_line_id IS NULL THEN
    RAISE EXCEPTION 'original_dispatch_line_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_requested_quantity IS NULL OR p_requested_quantity <= 0 THEN
    RAISE EXCEPTION 'requested_quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;
  IF p_reason_code IS NULL OR p_reason_code NOT IN (
    'excess', 'shipment_error', 'near_expiry', 'expired', 'damaged',
    'recalled', 'quality_issue', 'temperature_excursion', 'other'
  ) THEN
    RAISE EXCEPTION 'invalid_reason_code' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_request
  FROM public.outlet_return_requests WHERE id = p_return_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_request_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_request.status <> 'draft' THEN
    RAISE EXCEPTION 'return_request_not_editable' USING ERRCODE = '23514';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'outlet_stock.return_request', v_request.source_organization_id,
    NULL, v_request.distribution_point_id
  ) THEN
    RAISE EXCEPTION 'forbidden_outlet_return_request' USING ERRCODE = '42501';
  END IF;

  SELECT p.role INTO v_actor_role FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_dispatch
  FROM public.warehouse_dispatch_lines WHERE id = p_original_dispatch_line_id FOR UPDATE;
  IF NOT FOUND OR v_dispatch.organization_id <> v_request.source_organization_id THEN
    RAISE EXCEPTION 'original_dispatch_line_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_dispatch.status NOT IN ('accepted', 'accepted_with_difference')
     OR v_dispatch.resulting_outlet_stock_id IS NULL THEN
    RAISE EXCEPTION 'original_dispatch_line_not_a_completed_receipt' USING ERRCODE = '23514';
  END IF;

  -- 095: FOR UPDATE added — this row's current balance is now load-bearing,
  -- not just a source of immutable snapshot fields.
  SELECT * INTO v_stock
  FROM public.outlet_stock WHERE id = v_dispatch.resulting_outlet_stock_id FOR UPDATE;
  IF NOT FOUND OR v_stock.distribution_point_id <> v_request.distribution_point_id THEN
    RAISE EXCEPTION 'original_dispatch_line_not_at_this_outlet' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_movement
  FROM public.outlet_stock_movements
  WHERE dispatch_line_id = v_dispatch.id
    AND movement_type = 'dispatch_receive'
    AND outlet_stock_id = v_stock.id
    AND organization_id = v_request.source_organization_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dispatch_receive_movement_not_found_for_line' USING ERRCODE = 'P0002';
  END IF;

  IF v_dispatch.scientific_name IS DISTINCT FROM v_stock.scientific_name
     OR COALESCE(v_dispatch.concentration,'') IS DISTINCT FROM COALESCE(v_stock.concentration,'')
     OR COALESCE(v_dispatch.dosage_form,'')   IS DISTINCT FROM COALESCE(v_stock.dosage_form,'')
     OR COALESCE(v_dispatch.national_code,'') IS DISTINCT FROM COALESCE(v_stock.national_code,'')
     OR COALESCE(v_dispatch.batch_number,'')  IS DISTINCT FROM COALESCE(v_stock.batch_number,'')
     OR COALESCE(v_dispatch.internal_batch_reference,'') IS DISTINCT FROM COALESCE(v_stock.internal_batch_reference,'')
     OR v_dispatch.expiry_date IS DISTINCT FROM v_stock.expiry_date THEN
    RAISE EXCEPTION 'provenance_material_batch_expiry_mismatch' USING ERRCODE = '23514';
  END IF;

  -- Historical cap (unchanged from 071).
  v_cap := COALESCE(v_dispatch.received_quantity, 0) - v_dispatch.returned_quantity;
  IF p_requested_quantity > v_cap THEN
    RAISE EXCEPTION 'requested_quantity_exceeds_returnable_cap' USING ERRCODE = '23514';
  END IF;

  -- 095: current-availability cap — closes the "already dispensed/dispatched/
  -- reserved elsewhere" gap the historical cap alone could not see.
  v_available := COALESCE(v_stock.on_hand_quantity, 0) - COALESCE(v_stock.reserved_quantity, 0);
  IF p_requested_quantity > v_available THEN
    RAISE EXCEPTION 'requested_quantity_exceeds_current_availability' USING ERRCODE = '23514',
      DETAIL = format('requested %s, currently available %s (on_hand - reserved)',
                       p_requested_quantity, v_available);
  END IF;

  INSERT INTO public.outlet_return_request_lines (
    return_request_id, source_organization_id,
    original_dispatch_line_id, original_inbound_movement_id,
    original_inbound_movement_type, source_outlet_stock_id,
    scientific_name, concentration, dosage_form, unit, national_code,
    batch_number, internal_batch_reference, expiry_date,
    reason_code, reason_text, requested_quantity
  ) VALUES (
    p_return_request_id, v_request.source_organization_id,
    v_dispatch.id, v_movement.id,
    'dispatch_receive', v_stock.id,
    v_stock.scientific_name, v_stock.concentration, v_stock.dosage_form, v_stock.unit,
    v_stock.national_code, v_stock.batch_number, v_stock.internal_batch_reference, v_stock.expiry_date,
    p_reason_code, v_reason_text, p_requested_quantity
  )
  RETURNING * INTO v_line;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_request.source_organization_id, v_actor, v_actor_role,
    'outlet_stock.return_line_added', 'outlet_return_request_lines', v_line.id, v_line.scientific_name,
    jsonb_build_object(
      'return_request_id', p_return_request_id,
      'original_dispatch_line_id', v_dispatch.id,
      'original_inbound_movement_id', v_movement.id,
      'source_outlet_stock_id', v_stock.id,
      'reason_code', p_reason_code,
      'requested_quantity', p_requested_quantity
    )
  );

  RETURN jsonb_build_object('ok', true, 'return_request_line_id', v_line.id);
END;
$$;

COMMIT;

-- ============================================================================
-- POST-CONDITIONS
-- ============================================================================
-- 1. Both functions still resolve to exactly one overload each:
--    SELECT proname, count(*) FROM pg_proc
--     WHERE proname IN ('phoenix_add_warehouse_return_request_line',
--                        'phoenix_add_outlet_return_request_line')
--     GROUP BY proname;
--    -- expect count = 1 each.
-- 2. Grants/RLS/permission-key checks are byte-identical to 069/071 (no
--    privilege was widened) — diff this file's function bodies against
--    069/071's originals outside the two new v_available blocks.
-- ============================================================================
-- ROLLBACK: re-apply 069's/071's original CREATE OR REPLACE bodies verbatim.
-- No schema change, no data written by this migration — pure behavior.
-- ============================================================================
