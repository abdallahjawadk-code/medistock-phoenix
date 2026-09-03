-- ============================================================================
-- DISPENSING-SUSPENSION-ENFORCEMENT-REPLENISHMENT-AND-DRAFTS-208
--
-- Closes the two enforcement points identified during discovery and
-- deliberately deferred in 203-207's design doc pending a real read of their
-- bodies. Both reads are now done; both had a genuine, source-backed reason
-- to act.
--
-- ── A. phoenix_replenish_emergency_outlet (168) ─────────────────────────────
--
-- This is a real outlet_stock-to-outlet_stock physical movement (pharmacy →
-- crash cabinet / rescue cart) — "replenishment" in the brief's own words,
-- not merely FEFO-adjacent to it. It already calls
-- phoenix_inventory_fefo_batches (150), which 205 made suspension-aware, so a
-- suspended material with NO OTHER eligible batch at that outlet is already
-- refused (no_fefo_candidate_for_material) — but that is an ACCIDENT of
-- candidate-starvation, not a deliberate gate, and it is bypassable exactly
-- the way 207 found for the warehouse-side guarded sends: if a DIFFERENT,
-- non-suspended batch of the same material exists at the source outlet, FEFO
-- returns THAT batch as v_fefo_first, which is DISTINCT FROM the caller's
-- explicitly-named p_source_outlet_stock_id (the suspended one) — routing
-- into the fefo_override branch. A caller holding inventory.fefo_override
-- could then push the suspended-specific batch through with an override
-- reason, and the debit proceeds against v_src_stock, loaded directly by id,
-- with no suspension check anywhere in the path. Fixed the same way as 207:
-- an explicit, unconditional check placed immediately after the source stock
-- row is loaded, ahead of the FEFO revalidation — never satisfiable via
-- p_fefo_override_reason.
--
-- ── B. phoenix_create_transfer_draft_from_suggestion (150) ──────────────────
--
-- Converts an already-suggested transfer into a real draft line
-- (warehouse_transfer_request_lines / warehouse_dispatch_lines /
-- outlet_return_request_lines). 206 already filters suspended materials out
-- of suggestion CREATION, so a fresh suggestion for a suspended material
-- should not exist — but a suggestion already 'open'/'accepted' before a
-- suspension took effect can go stale between suggest-time and draft-time.
--
-- This is NOT a hole in the primary gate: a draft line moves no physical
-- stock by itself — the actual movement happens later, through
-- phoenix_send_warehouse_transfer_line[_fefo_guarded],
-- phoenix_send_direct_warehouse_transfer_line[_fefo_guarded], or
-- phoenix_add_dispatch_line[_fefo_guarded] feeding
-- phoenix_send_warehouse_dispatch — every one of which 207 already made an
-- unconditional, final gate. A draft created here for a since-suspended
-- material can never actually be sent.
--
-- It is added anyway, for two source-backed reasons rather than none: (1)
-- fail-fast UX — no drafted document should exist that is guaranteed to be
-- refused the moment someone tries to send it, and (2) the RPC is already
-- reachable and cheap to check here, with inventory_transfer_suggestions'
-- own central_item_id/source_organization_id/source_scope_kind/
-- source_scope_id columns (verified present in 150/206's INSERT lists) —
-- no new lookup is required to add it correctly.
--
-- PRECONDITIONS: 207 applied.
-- ============================================================================

DO $precond$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = '_phoenix_is_material_dispensing_suspended_v1'
       AND p.pronamespace = 'public'::regnamespace
  ) THEN
    RAISE EXCEPTION '208 PRECONDITION FAILED: 203 missing — apply 203 first';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'phoenix_replenish_emergency_outlet'
       AND p.pronamespace = 'public'::regnamespace
  ) THEN
    RAISE EXCEPTION '208 PRECONDITION FAILED: 168 missing — apply 168 first';
  END IF;
END;
$precond$;

CREATE OR REPLACE FUNCTION public.phoenix_replenish_emergency_outlet(
  p_request_id               uuid,
  p_route_id                 uuid,
  p_source_outlet_stock_id   uuid,
  p_quantity                 integer,
  p_fefo_override_reason     text DEFAULT NULL,
  p_notes                    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor          uuid := auth.uid();
  v_actor_role     text;
  v_actor_name     text;
  v_override       text := NULLIF(btrim(p_fefo_override_reason), '');
  v_notes          text := NULLIF(btrim(p_notes), '');
  v_fingerprint    text;
  v_route          public.outlet_replenishment_routes%ROWTYPE;
  v_src_ctx        record;
  v_dst_ctx        record;
  v_src_stock      public.outlet_stock%ROWTYPE;
  v_dst_stock      public.outlet_stock%ROWTYPE;
  v_point_a        uuid;
  v_point_b        uuid;
  v_stock_first    uuid;
  v_stock_second   uuid;
  v_send_existing  public.outlet_stock_movements%ROWTYPE;
  v_recv_existing  public.outlet_stock_movements%ROWTYPE;
  v_fefo_first     uuid;
  v_src_before     integer;
  v_src_after      integer;
  v_dst_before     integer;
  v_dst_after      integer;
  v_send_id        uuid;
  v_recv_id        uuid;
  v_correlation_id uuid := gen_random_uuid();
  v_avail_src      uuid;
  v_avail_dst      uuid;
  v_tmp_stock      public.outlet_stock%ROWTYPE;
  v_dst_stock_id   uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_route_id IS NULL THEN
    RAISE EXCEPTION 'route_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_source_outlet_stock_id IS NULL THEN
    RAISE EXCEPTION 'source_outlet_stock_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;

  v_fingerprint := public._phoenix_replenishment_fingerprint_v1(
    p_route_id, p_source_outlet_stock_id, p_quantity, v_override, v_notes
  );

  -- 1. Advisory lock FIRST (salt 168168 — distinct from 067/106/156).
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 168168));

  -- 2. Route row share-lock BEFORE the replay probe. Authorization scope
  --    derives from the route row, and EVERY successful return from this
  --    SECURITY DEFINER function — including idempotent_replay = true —
  --    must first prove an active profile holding outlet_stock.replenish
  --    for the source pharmacy scope. Lock order stays advisory → route →
  --    points → stocks (V4 §14 / §19.2); moving the route acquisition ahead
  --    of the replay probe does not invert any pair in that order.
  SELECT * INTO v_route
  FROM public.outlet_replenishment_routes
  WHERE id = p_route_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'route_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Authorization — existing key only; scoped to the route's source pharmacy.
  -- Enforced BEFORE any replay return so an unauthorized caller can never
  -- obtain successful replay semantics or operation details for an existing
  -- request_id. The fresh path later re-proves that the route's organization
  -- still equals the CURRENT canonical organization of both endpoints, so
  -- this route-scoped check is equivalent for every executable request.
  SELECT p.role, p.full_name INTO v_actor_role, v_actor_name
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'outlet_stock.replenish', v_route.organization_id,
    NULL, v_route.source_point_id
  ) THEN
    RAISE EXCEPTION 'forbidden_outlet_stock_replenish' USING ERRCODE = '42501';
  END IF;

  -- Idempotent replay probe — no dedup table (V4 §14 / 070:342 idiom).
  -- Reached only by an authorized, active caller (above).
  SELECT * INTO v_send_existing
  FROM public.outlet_stock_movements m
  WHERE m.reference_type = 'outlet_replenishment'
    AND m.reference_id = p_request_id
    AND m.movement_type = 'replenish_send';

  SELECT * INTO v_recv_existing
  FROM public.outlet_stock_movements m
  WHERE m.reference_type = 'outlet_replenishment'
    AND m.reference_id = p_request_id
    AND m.movement_type = 'replenish_receive';

  IF FOUND OR v_send_existing.id IS NOT NULL THEN
    IF v_send_existing.id IS NULL OR v_recv_existing.id IS NULL THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505',
        DETAIL = 'partial replenishment legs for this request_id — refresh and resubmit';
    END IF;
    IF v_send_existing.request_fingerprint IS DISTINCT FROM v_fingerprint
       OR v_recv_existing.request_fingerprint IS DISTINCT FROM v_fingerprint
       OR v_send_existing.outlet_stock_id IS DISTINCT FROM p_source_outlet_stock_id THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505',
        DETAIL = 'same request_id previously submitted with a different payload';
    END IF;
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent_replay', true,
      'request_id', p_request_id,
      'route_id', p_route_id,
      'source_outlet_stock_id', v_send_existing.outlet_stock_id,
      'destination_outlet_stock_id', v_recv_existing.outlet_stock_id,
      'send_movement_id', v_send_existing.id,
      'receive_movement_id', v_recv_existing.id,
      'quantity', abs(v_send_existing.on_hand_delta),
      'source_quantity_before', v_send_existing.on_hand_before,
      'source_quantity_after', v_send_existing.on_hand_after,
      'destination_quantity_before', v_recv_existing.on_hand_before,
      'destination_quantity_after', v_recv_existing.on_hand_after,
      'request_fingerprint', v_fingerprint
    );
  END IF;

  -- Fresh execution from here on (route already share-locked above). A route
  -- deactivated AFTER a request completed must not break the authorized
  -- replay of that completed request, so is_active gates only fresh work.
  IF NOT v_route.is_active THEN
    RAISE EXCEPTION 'route_not_active' USING ERRCODE = '23514';
  END IF;

  -- 3. Distribution-point / facility context share-lock, ascending id.
  IF v_route.source_point_id < v_route.destination_point_id THEN
    v_point_a := v_route.source_point_id;
    v_point_b := v_route.destination_point_id;
  ELSE
    v_point_a := v_route.destination_point_id;
    v_point_b := v_route.source_point_id;
  END IF;

  PERFORM 1 FROM public.distribution_points WHERE id = v_point_a FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'distribution_point_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM public.distribution_points WHERE id = v_point_b FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'distribution_point_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Resolve CURRENT canonical context (Addendum §F movement-time revalidation).
  SELECT * INTO v_src_ctx
  FROM public._phoenix_outlet_facility_context_v1(v_route.source_point_id);
  IF v_src_ctx.o_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'source_outlet_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_dst_ctx
  FROM public._phoenix_outlet_facility_context_v1(v_route.destination_point_id);
  IF v_dst_ctx.o_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'destination_outlet_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Active endpoints.
  IF v_src_ctx.o_point_status <> 'active' THEN
    RAISE EXCEPTION 'source_outlet_inactive' USING ERRCODE = '23514';
  END IF;
  IF v_dst_ctx.o_point_status <> 'active' THEN
    RAISE EXCEPTION 'destination_outlet_inactive' USING ERRCODE = '23514';
  END IF;

  -- Typed endpoints must still match the route AND the Shape matrix.
  IF v_src_ctx.o_point_type <> 'pharmacy'
     OR v_src_ctx.o_point_type IS DISTINCT FROM v_route.source_point_type THEN
    RAISE EXCEPTION 'source_must_be_pharmacy' USING ERRCODE = '23514';
  END IF;
  IF v_dst_ctx.o_point_type NOT IN ('rescue_cart', 'crash_cabinet')
     OR v_dst_ctx.o_point_type IS DISTINCT FROM v_route.destination_point_type THEN
    RAISE EXCEPTION 'destination_must_be_emergency_outlet' USING ERRCODE = '23514';
  END IF;

  -- Organization relationship still matches the approved route.
  IF v_src_ctx.o_organization_id IS DISTINCT FROM v_dst_ctx.o_organization_id
     OR v_src_ctx.o_organization_id IS DISTINCT FROM v_route.organization_id THEN
    RAISE EXCEPTION 'cross_organization_route_forbidden' USING ERRCODE = '42501';
  END IF;

  IF v_src_ctx.o_institution_class IS NULL THEN
    RAISE EXCEPTION 'organization_institution_class_required' USING ERRCODE = '23514';
  END IF;
  IF v_dst_ctx.o_clinical_location_kind IS NULL THEN
    RAISE EXCEPTION 'destination_clinical_location_kind_required' USING ERRCODE = '23514';
  END IF;

  -- ── Addendum §F Shape H / Shape I (facility-based; NOT warehouse equality) ─
  IF v_src_ctx.o_institution_class = 'health_sector' THEN
    IF v_src_ctx.o_facility_id IS NULL OR v_dst_ctx.o_facility_id IS NULL THEN
      RAISE EXCEPTION 'health_center_route_requires_facility' USING ERRCODE = '23514';
    END IF;
    IF v_src_ctx.o_facility_id IS DISTINCT FROM v_dst_ctx.o_facility_id THEN
      RAISE EXCEPTION 'cross_facility_route_forbidden' USING ERRCODE = '42501';
    END IF;
    IF v_dst_ctx.o_facility_class NOT IN ('primary_health_center', 'subordinate_health_center') THEN
      RAISE EXCEPTION 'invalid_facility_class_for_route' USING ERRCODE = '23514';
    END IF;
    IF v_dst_ctx.o_facility_status <> 'active' THEN
      RAISE EXCEPTION 'facility_not_active' USING ERRCODE = '23514';
    END IF;
    IF v_dst_ctx.o_point_type <> 'crash_cabinet' THEN
      RAISE EXCEPTION 'health_center_rescue_cart_forbidden' USING ERRCODE = '23514';
    END IF;
    IF v_dst_ctx.o_clinical_location_kind <> 'emergency' THEN
      RAISE EXCEPTION 'health_center_crash_cabinet_requires_emergency' USING ERRCODE = '23514';
    END IF;

  ELSIF v_src_ctx.o_institution_class IN ('hospital', 'specialized_center') THEN
    IF v_src_ctx.o_facility_id IS NOT NULL OR v_dst_ctx.o_facility_id IS NOT NULL THEN
      RAISE EXCEPTION 'facility_not_permitted_for_this_institution_class' USING ERRCODE = '23514';
    END IF;

    IF v_dst_ctx.o_point_type = 'rescue_cart' THEN
      IF v_src_ctx.o_institution_class <> 'hospital' THEN
        RAISE EXCEPTION 'rescue_cart_requires_hospital' USING ERRCODE = '23514';
      END IF;
      IF v_dst_ctx.o_clinical_location_kind <> 'emergency' THEN
        RAISE EXCEPTION 'rescue_cart_requires_emergency_context' USING ERRCODE = '23514';
      END IF;
    ELSE
      IF v_dst_ctx.o_clinical_location_kind <> 'non_emergency' THEN
        RAISE EXCEPTION 'crash_cabinet_requires_non_emergency_context' USING ERRCODE = '23514';
      END IF;
    END IF;

  ELSE
    RAISE EXCEPTION 'unsupported_institution_class_for_route' USING ERRCODE = '23514';
  END IF;

  -- Authorization already enforced above (before the replay probe) against
  -- the route's organization/source point; the cross-organization check just
  -- above proves that scope equals the CURRENT canonical organization.

  -- Resolve source stock WITHOUT locking yet (lock order requires both stock
  -- rows FOR UPDATE ascending id after destination identity is known).
  SELECT * INTO v_src_stock
  FROM public.outlet_stock
  WHERE id = p_source_outlet_stock_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'source_outlet_stock_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_src_stock.distribution_point_id IS DISTINCT FROM v_route.source_point_id THEN
    RAISE EXCEPTION 'source_stock_not_on_route_pharmacy' USING ERRCODE = '23514';
  END IF;
  IF v_src_stock.organization_id IS DISTINCT FROM v_route.organization_id THEN
    RAISE EXCEPTION 'source_stock_organization_mismatch' USING ERRCODE = '42501';
  END IF;
  IF v_src_stock.expiry_date IS NOT NULL AND v_src_stock.expiry_date < current_date THEN
    RAISE EXCEPTION 'expired_batch_cannot_be_replenished' USING ERRCODE = '23514';
  END IF;

  -- 208: موقوف الصرف — unconditional, checked before the FEFO revalidation
  -- below so a suspended source is refused clearly, never as a side effect
  -- of candidate-starvation, and never satisfiable via p_fefo_override_reason.
  IF v_src_stock.central_item_id IS NOT NULL AND public._phoenix_is_material_dispensing_suspended_v1(
    v_src_stock.central_item_id, v_src_stock.organization_id, v_src_stock.distribution_point_id
  ) THEN
    RAISE EXCEPTION 'material_dispensing_suspended' USING ERRCODE = '23514';
  END IF;

  -- FEFO revalidation via phoenix_inventory_fefo_batches (150:1597 / V4 §14).
  -- No second FEFO implementation.
  SELECT b.stock_id INTO v_fefo_first
  FROM public.phoenix_inventory_fefo_batches(
    v_src_stock.organization_id,
    'outlet',
    v_src_stock.distribution_point_id,
    v_src_stock.scientific_name,
    v_src_stock.national_code
  ) b
  LIMIT 1;

  IF v_fefo_first IS NULL THEN
    RAISE EXCEPTION 'no_fefo_candidate_for_material' USING ERRCODE = 'P0002';
  END IF;

  IF v_fefo_first IS DISTINCT FROM p_source_outlet_stock_id THEN
    IF v_override IS NULL THEN
      RAISE EXCEPTION 'fefo_override_required' USING ERRCODE = '23514';
    END IF;
    IF NOT public.phoenix_profile_has_scoped_permission(
      v_actor, 'inventory.fefo_override', v_src_stock.organization_id,
      NULL, v_src_stock.distribution_point_id
    ) THEN
      RAISE EXCEPTION 'forbidden_fefo_override' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Resolve (or create) destination outlet_stock with exact material identity
  -- including supply_type / purchase_origin (V4 §14 / §19.2 provenance).
  --
  -- CORRECTION (independent review, PR #109): Migration 150 makes
  -- material_identity_key (central_item_id, scientific_name, national_code,
  -- concentration, dosage_form, unit) the canonical material boundary, and
  -- outlet_stock_identity_v150_uniq allows two destination rows to coexist
  -- for the SAME distribution_point_id + lot/provenance tuple when their
  -- material_identity_key differs (e.g. unit='box' vs unit='strip', or a
  -- different central_item_id). The resolution below MUST therefore key off
  -- the generated material_identity_key — never rebuild identity from a
  -- partial field list — combined with the exact lot/provenance tuple the
  -- unique index enforces, so it can never match a different canonical
  -- material that merely shares scientific_name/national_code/concentration/
  -- dosage_form/batch/expiry/provenance.
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
    v_src_stock.organization_id, v_route.destination_point_id,
    v_dst_ctx.o_point_type, v_src_stock.central_item_id,
    v_src_stock.scientific_name, v_src_stock.trade_name,
    v_src_stock.concentration, v_src_stock.dosage_form, v_src_stock.unit,
    v_src_stock.national_code, v_src_stock.has_no_national_code,
    v_src_stock.batch_number, v_src_stock.has_no_batch_number,
    v_src_stock.internal_batch_reference,
    v_src_stock.expiry_date, 0, 0,
    v_src_stock.unit_price, v_src_stock.price_basis, v_src_stock.currency,
    v_src_stock.supply_type_text,
    v_src_stock.supply_type, v_src_stock.purchase_origin,
    v_src_stock.source_document_number, v_notes, v_actor, v_actor
  )
  ON CONFLICT DO NOTHING;

  SELECT s.id INTO v_dst_stock_id
  FROM public.outlet_stock s
  WHERE s.distribution_point_id = v_route.destination_point_id
    AND s.organization_id = v_src_stock.organization_id
    AND s.material_identity_key = v_src_stock.material_identity_key
    AND COALESCE(s.batch_number, '')  = COALESCE(v_src_stock.batch_number, '')
    AND COALESCE(s.expiry_date, DATE '0001-01-01')
        = COALESCE(v_src_stock.expiry_date, DATE '0001-01-01')
    AND COALESCE(s.internal_batch_reference, '')
        = COALESCE(v_src_stock.internal_batch_reference, '')
    AND COALESCE(s.supply_type, '') = COALESCE(v_src_stock.supply_type, '')
    AND COALESCE(s.purchase_origin, '') = COALESCE(v_src_stock.purchase_origin, '');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'destination_outlet_stock_identity_resolution_failed' USING ERRCODE = 'P0002';
  END IF;

  -- 4. Both outlet_stock rows FOR UPDATE in ascending id order (070:1121-1124).
  IF p_source_outlet_stock_id < v_dst_stock_id THEN
    v_stock_first := p_source_outlet_stock_id;
    v_stock_second := v_dst_stock_id;
  ELSE
    v_stock_first := v_dst_stock_id;
    v_stock_second := p_source_outlet_stock_id;
  END IF;

  SELECT * INTO v_tmp_stock FROM public.outlet_stock WHERE id = v_stock_first FOR UPDATE;
  SELECT * INTO v_dst_stock FROM public.outlet_stock WHERE id = v_stock_second FOR UPDATE;

  IF v_tmp_stock.id = p_source_outlet_stock_id THEN
    v_src_stock := v_tmp_stock;
  ELSE
    v_src_stock := v_dst_stock;
    v_dst_stock := v_tmp_stock;
  END IF;

  IF v_src_stock.id IS DISTINCT FROM p_source_outlet_stock_id
     OR v_dst_stock.id IS DISTINCT FROM v_dst_stock_id THEN
    RAISE EXCEPTION 'stock_lock_identity_mismatch' USING ERRCODE = 'P0002';
  END IF;

  -- Quantity checks after final locks.
  IF v_src_stock.available_quantity < p_quantity THEN
    RAISE EXCEPTION 'insufficient_source_stock' USING ERRCODE = '23514';
  END IF;

  v_src_before := v_src_stock.on_hand_quantity;
  v_src_after  := v_src_before - p_quantity;
  IF v_src_after < 0 THEN
    RAISE EXCEPTION 'outlet_quantity_cannot_go_negative' USING ERRCODE = '23514';
  END IF;
  IF v_src_after < v_src_stock.reserved_quantity THEN
    RAISE EXCEPTION 'outlet_quantity_below_reserved' USING ERRCODE = '23514';
  END IF;

  v_dst_before := v_dst_stock.on_hand_quantity;
  v_dst_after  := v_dst_before + p_quantity;

  UPDATE public.outlet_stock
     SET on_hand_quantity = v_src_after,
         notes            = COALESCE(v_notes, notes),
         updated_by       = v_actor
   WHERE id = v_src_stock.id;

  UPDATE public.outlet_stock
     SET on_hand_quantity = v_dst_after,
         unit_price       = COALESCE(v_src_stock.unit_price, unit_price),
         notes            = COALESCE(v_notes, notes),
         updated_by       = v_actor
   WHERE id = v_dst_stock.id;

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
    v_src_stock.id, v_src_stock.organization_id, v_src_stock.distribution_point_id,
    'replenish_send',
    v_src_before, -p_quantity, v_src_after,
    v_src_stock.reserved_quantity, 0, v_src_stock.reserved_quantity,
    v_notes, 'transferred', 'outlet_replenishment', p_request_id, v_fingerprint,
    v_actor, v_actor_role, v_actor_name,
    v_src_stock.scientific_name, v_src_stock.concentration, v_src_stock.dosage_form,
    v_src_stock.batch_number, v_src_stock.internal_batch_reference, v_src_stock.expiry_date,
    v_correlation_id
  )
  RETURNING id INTO v_send_id;

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
    v_dst_stock.id, v_dst_stock.organization_id, v_dst_stock.distribution_point_id,
    'replenish_receive',
    v_dst_before, p_quantity, v_dst_after,
    v_dst_stock.reserved_quantity, 0, v_dst_stock.reserved_quantity,
    v_notes, 'transferred', 'outlet_replenishment', p_request_id, v_fingerprint,
    v_actor, v_actor_role, v_actor_name,
    v_dst_stock.scientific_name, v_dst_stock.concentration, v_dst_stock.dosage_form,
    v_dst_stock.batch_number, v_dst_stock.internal_batch_reference, v_dst_stock.expiry_date,
    v_correlation_id
  )
  RETURNING id INTO v_recv_id;

  v_avail_src := public.phoenix_project_outlet_availability(v_src_stock.id);
  v_avail_dst := public.phoenix_project_outlet_availability(v_dst_stock.id);

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role,
    action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_src_stock.organization_id, v_actor, v_actor_role,
    'outlet_stock.replenish', 'outlet_replenishment_routes', p_route_id,
    v_src_stock.scientific_name,
    jsonb_build_object(
      'request_id', p_request_id,
      'route_id', p_route_id,
      'source_outlet_stock_id', v_src_stock.id,
      'destination_outlet_stock_id', v_dst_stock.id,
      'source_distribution_point_id', v_route.source_point_id,
      'destination_distribution_point_id', v_route.destination_point_id,
      'send_movement_id', v_send_id,
      'receive_movement_id', v_recv_id,
      'quantity', p_quantity,
      'source_quantity_before', v_src_before,
      'source_quantity_after', v_src_after,
      'destination_quantity_before', v_dst_before,
      'destination_quantity_after', v_dst_after,
      'fefo_override_applied', (v_override IS NOT NULL AND v_fefo_first IS DISTINCT FROM p_source_outlet_stock_id),
      'request_fingerprint', v_fingerprint,
      'correlation_id', v_correlation_id,
      'source_availability_id', v_avail_src,
      'destination_availability_id', v_avail_dst
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'idempotent_replay', false,
    'request_id', p_request_id,
    'route_id', p_route_id,
    'source_outlet_stock_id', v_src_stock.id,
    'destination_outlet_stock_id', v_dst_stock.id,
    'send_movement_id', v_send_id,
    'receive_movement_id', v_recv_id,
    'quantity', p_quantity,
    'source_quantity_before', v_src_before,
    'source_quantity_after', v_src_after,
    'destination_quantity_before', v_dst_before,
    'destination_quantity_after', v_dst_after,
    'request_fingerprint', v_fingerprint,
    'fefo_override_applied', (v_override IS NOT NULL AND v_fefo_first IS DISTINCT FROM p_source_outlet_stock_id)
  );
END;
$$;

-- ============================================================================
-- B. phoenix_create_transfer_draft_from_suggestion (150) — early, deliberate
--    fail-fast refusal for a since-suspended suggestion. Not the primary
--    gate (207 already is); see header.
-- ============================================================================

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
  IF v_s.material_identity_state<>'resolved'
     OR v_s.material_identity_version<>1 OR v_s.material_identity_key IS NULL THEN
    RAISE EXCEPTION 'suggestion_material_identity_unresolved';
  END IF;

  -- 208: موقوف الصرف — a suggestion can go stale between suggest-time (206
  -- already filters suspended materials out of fresh suggestions) and
  -- draft-time if a suspension is applied in between. Fail fast here rather
  -- than let an operator draft a document that 207's send-time gates will
  -- refuse anyway. distribution_point scope only applies when the SOURCE is
  -- an outlet; a warehouse source checks org-wide only, matching 205/206/207.
  IF v_s.central_item_id IS NOT NULL AND public._phoenix_is_material_dispensing_suspended_v1(
    v_s.central_item_id, v_s.source_organization_id,
    CASE WHEN v_s.source_scope_kind = 'outlet' THEN v_s.source_scope_id ELSE NULL END
  ) THEN
    RAISE EXCEPTION 'material_dispensing_suspended';
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
      v_line.central_item_id,v_line.scientific_name,v_line.national_code,
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

DO $verify$
BEGIN
  IF to_regprocedure(
    'public.phoenix_replenish_emergency_outlet(uuid,uuid,uuid,integer,text,text)'
  ) IS NULL THEN
    RAISE EXCEPTION '208 VERIFY FAILED: phoenix_replenish_emergency_outlet missing after redefinition';
  END IF;
  IF to_regprocedure(
    'public.phoenix_create_transfer_draft_from_suggestion(uuid,text)'
  ) IS NULL THEN
    RAISE EXCEPTION '208 VERIFY FAILED: phoenix_create_transfer_draft_from_suggestion missing after redefinition';
  END IF;
  RAISE NOTICE 'DISPENSING-SUSPENSION-ENFORCEMENT-REPLENISHMENT-AND-DRAFTS-208: verified.';
END;
$verify$;
