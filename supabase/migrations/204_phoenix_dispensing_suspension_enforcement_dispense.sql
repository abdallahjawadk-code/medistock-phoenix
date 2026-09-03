-- ============================================================================
-- DISPENSING-SUSPENSION-ENFORCEMENT-DISPENSE-204
--
-- Wires 203's public._phoenix_is_material_dispensing_suspended_v1(...) into the
-- single patient-dispensing RPC. phoenix_dispense_outlet_stock_with_context
-- (136) delegates to this function for its own dispense half, so it inherits
-- the check for free — no separate edit needed there (136's own comment: "this
-- function is exactly as restrictive as the STRICTER of the two").
--
-- Placement: alongside the existing expired-batch check, after the permission
-- and active-profile checks, before any quantity mutation — a suspended
-- material is rejected before touching stock, exactly like an expired batch.
--
-- A row with central_item_id IS NULL (unresolved material identity) cannot be
-- matched against any suspension and is therefore unaffected — consistent with
-- 203's design: a suspension always targets a resolved central_items row.
--
-- Everything else in the function body is byte-for-byte identical to 131's
-- definition; only the one new check block is added.
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
    RAISE EXCEPTION '204 PRECONDITION FAILED: 203 missing — apply 203 first';
  END IF;
END;
$precond$;

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

  -- 204: موقوف الصرف — a material actively suspended from dispensing in this
  -- scope (org-wide or this exact distribution point) cannot be dispensed
  -- through the normal path, independent of quarantine/expiry/quantity.
  IF v_stock.central_item_id IS NOT NULL AND public._phoenix_is_material_dispensing_suspended_v1(
    v_stock.central_item_id, v_stock.organization_id, v_stock.distribution_point_id
  ) THEN
    RAISE EXCEPTION 'material_dispensing_suspended' USING ERRCODE = '23514';
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

DO $verify$
BEGIN
  IF to_regprocedure('public.phoenix_dispense_outlet_stock(uuid,uuid,integer,text,text)') IS NULL THEN
    RAISE EXCEPTION '204 VERIFY FAILED: phoenix_dispense_outlet_stock missing after redefinition';
  END IF;
  RAISE NOTICE 'DISPENSING-SUSPENSION-ENFORCEMENT-DISPENSE-204: verified.';
END;
$verify$;
