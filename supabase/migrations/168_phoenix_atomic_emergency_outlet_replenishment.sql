-- ============================================================================
-- ATOMIC-EMERGENCY-OUTLET-REPLENISHMENT-168  (Stage E · subphase E-5)
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply after 167, via the Supabase SQL Editor, after reading this file in full.
--
-- NOT APPLIED BY THIS PR. Authored and replayed on a disposable PostgreSQL rig
-- only. Migrations 001-167 are immutable and are NOT edited here.
--
-- Stage E / E-5. Apply after 167. Independent of 166's initial-provisioning
-- columns except that it MUST NOT touch them.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE GAP THIS CLOSES
-- ─────────────────────────────────────────────────────────────────────────────
-- Pharmacy → emergency-outlet (rescue_cart / crash_cabinet) replenishment has
-- never been a first-class corridor. Migration 164 delivered the route metadata
-- (`outlet_replenishment_routes`) and the Shape H/I eligibility predicates
-- (Addendum §F), but stock still cannot move: `outlet_stock_movements_type_chk`
-- does not admit `replenish_send` / `replenish_receive`, and no atomic RPC
-- exists. Dispense + add is forbidden — it would break causality.
--
-- This migration adds ONLY the E-5 runtime delta (V4 §20):
--   1. Widen outlet_stock_movements_type_chk (+replenish_send, +replenish_receive)
--   2. Forward partial unique index (one send + one receive per reference)
--   3. Fingerprint CHECK (exact V4 §14 predicate — schema-prep includes the
--      future reversal namespace; NO reversal execution)
--   4. _phoenix_replenishment_fingerprint_v1 (sha256, 106/156 idiom)
--   5. phoenix_replenish_emergency_outlet — atomic debit+credit under lock,
--      with Addendum-F movement-time revalidation (NOT warehouse-equality)
--
-- Explicit non-goals: E-6 reversal RPC/index execution, E-7 UI, E-8, Stage F,
-- Availability, new tables/columns/permission keys/RLS, E-4 changes, 167 changes.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 0. PREFLIGHT
-- ============================================================================
DO $preflight$
BEGIN
  IF to_regclass('public.outlet_stock') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (168): public.outlet_stock is missing';
  END IF;
  IF to_regclass('public.outlet_stock_movements') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (168): public.outlet_stock_movements is missing';
  END IF;
  IF to_regclass('public.outlet_replenishment_routes') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (168): outlet_replenishment_routes (164) is missing';
  END IF;
  IF to_regprocedure('public._phoenix_outlet_facility_context_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (168): _phoenix_outlet_facility_context_v1 (164) is missing';
  END IF;
  IF to_regprocedure('public.phoenix_upsert_outlet_replenishment_route(uuid,uuid,uuid,boolean,text)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (168): phoenix_upsert_outlet_replenishment_route (164) is missing';
  END IF;
  IF to_regprocedure('public.phoenix_project_outlet_availability(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (168): phoenix_project_outlet_availability (067) is missing';
  END IF;
  IF to_regprocedure('public.phoenix_inventory_fefo_batches(uuid,text,uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (168): phoenix_inventory_fefo_batches (150) is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.permission_keys WHERE key = 'outlet_stock.replenish') THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (168): outlet_stock.replenish permission key (164) is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'outlet_stock_movements_type_chk'
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (168): outlet_stock_movements_type_chk is missing';
  END IF;
  -- Idempotency: this migration is not re-runnable.
  IF to_regprocedure(
       'public.phoenix_replenish_emergency_outlet(uuid,uuid,uuid,integer,text,text)'
     ) IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (168): phoenix_replenish_emergency_outlet already exists';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'outlet_stock_movements_replenishment_once_uniq'
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (168): replenishment_once_uniq already exists';
  END IF;
END;
$preflight$;

-- ============================================================================
-- 1. WIDEN movement_type CHECK — preserve every pre-existing value, add two.
-- ============================================================================
ALTER TABLE public.outlet_stock_movements
  DROP CONSTRAINT outlet_stock_movements_type_chk;
ALTER TABLE public.outlet_stock_movements
  ADD CONSTRAINT outlet_stock_movements_type_chk
  CHECK (movement_type IN (
    'set_exact', 'add', 'subtract', 'correction',
    'reserve', 'release', 'dispatch_receive', 'dispense', 'return_send',
    'replenish_send', 'replenish_receive'
  ));

-- ============================================================================
-- 2. FORWARD once-index — one send + one receive per outlet_replenishment
--    reference_id. (reference_id, movement_type) so the credit leg does not
--    collide with its own transaction's debit leg (V4 §14).
-- ============================================================================
CREATE UNIQUE INDEX outlet_stock_movements_replenishment_once_uniq
  ON public.outlet_stock_movements (reference_id, movement_type)
  WHERE reference_type = 'outlet_replenishment' AND reference_id IS NOT NULL;

-- ============================================================================
-- 3. Fingerprint CHECK — exact V4 §14 predicate.
--    Schema-prep intentionally names the future reversal namespace; E-6 owns
--    reversal execution. No reversal unique index and no reverse RPC here.
-- ============================================================================
ALTER TABLE public.outlet_stock_movements
  ADD CONSTRAINT osm_replenishment_fingerprint_chk
  CHECK (
    reference_type NOT IN ('outlet_replenishment', 'outlet_replenishment_reversal')
    OR (request_fingerprint IS NOT NULL AND request_fingerprint ~ '^[0-9a-f]{64}$')
  );

-- ============================================================================
-- 4. Fingerprint helper — sha256 over the effective mutation payload
--    (106/156 idiom). request_id is the lock/idempotency key and is NOT part
--    of the fingerprint body (same shape as 067/106/156).
-- ============================================================================
CREATE FUNCTION public._phoenix_replenishment_fingerprint_v1(
  p_route_id                 uuid,
  p_source_outlet_stock_id   uuid,
  p_quantity                 integer,
  p_fefo_override_reason     text,
  p_notes                    text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT encode(sha256(convert_to(jsonb_build_object(
    'operation', 'replenish_emergency_outlet',
    'route_id', p_route_id,
    'source_outlet_stock_id', p_source_outlet_stock_id,
    'quantity', p_quantity,
    'fefo_override_reason', NULLIF(btrim(p_fefo_override_reason), ''),
    'notes', NULLIF(btrim(p_notes), '')
  )::text, 'UTF8')), 'hex');
$$;

REVOKE ALL ON FUNCTION public._phoenix_replenishment_fingerprint_v1(uuid, uuid, integer, text, text)
  FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 5. Atomic forward corridor RPC
--    Signature (V4 §19.2):
--      phoenix_replenish_emergency_outlet(uuid,uuid,uuid,integer,text,text)
--    = (p_request_id, p_route_id, p_source_outlet_stock_id, p_quantity,
--       p_fefo_override_reason, p_notes)
--
--    Lock order (V4 §14 / §19.2, binding):
--      1. advisory xact lock on request_id
--      2. route row share-lock
--      3. source/destination points share-lock (ascending id)
--      4. outlet_stock rows update-lock (ascending id)
--
--    Movement-time revalidation (Addendum §F): Shape H / Shape I against
--    CURRENT canonical entities. Never trust route.is_active alone. Never
--    use the withdrawn warehouse-equality rule.
-- ============================================================================
CREATE FUNCTION public.phoenix_replenish_emergency_outlet(
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
    AND s.scientific_name = v_src_stock.scientific_name
    AND COALESCE(s.concentration, '') = COALESCE(v_src_stock.concentration, '')
    AND COALESCE(s.dosage_form, '')   = COALESCE(v_src_stock.dosage_form, '')
    AND COALESCE(s.national_code, '') = COALESCE(v_src_stock.national_code, '')
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

REVOKE ALL ON FUNCTION public.phoenix_replenish_emergency_outlet(uuid, uuid, uuid, integer, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_replenish_emergency_outlet(uuid, uuid, uuid, integer, text, text)
  TO authenticated;

COMMENT ON FUNCTION public.phoenix_replenish_emergency_outlet(uuid, uuid, uuid, integer, text, text) IS
  'E-5 atomic pharmacy→emergency-outlet replenishment. Debits the source '
  'pharmacy outlet_stock and credits the destination rescue_cart/crash_cabinet '
  'outlet_stock in one transaction under the Addendum-F Shape H/I matrix, with '
  'movement-time revalidation, FEFO via 150, and fingerprint idempotency. '
  'Permission: outlet_stock.replenish. No warehouse movement. No E-4 interaction.';

-- ============================================================================
-- 6. VERIFY
-- ============================================================================
DO $verify$
DECLARE
  v_type_def text;
  v_fp_def   text;
  v_rpc_def  text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_type_def
  FROM pg_constraint WHERE conname = 'outlet_stock_movements_type_chk';
  IF v_type_def IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (168): type_chk missing';
  END IF;
  IF v_type_def NOT LIKE '%replenish_send%' OR v_type_def NOT LIKE '%replenish_receive%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (168): type_chk missing E-5 movement types';
  END IF;
  IF v_type_def NOT LIKE '%dispatch_receive%' OR v_type_def NOT LIKE '%dispense%'
     OR v_type_def NOT LIKE '%return_send%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (168): type_chk lost a pre-existing movement type';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'outlet_stock_movements_replenishment_once_uniq'
      AND indexdef LIKE '%UNIQUE%'
      AND indexdef LIKE '%reference_id%'
      AND indexdef LIKE '%movement_type%'
      AND indexdef LIKE '%outlet_replenishment%'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (168): replenishment_once_uniq missing or wrong';
  END IF;

  -- E-6 reversal once-index must NOT exist yet.
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'outlet_stock_movements_replenishment_reversal_once_uniq'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (168): reversal once-index must not be created in E-5';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO v_fp_def
  FROM pg_constraint WHERE conname = 'osm_replenishment_fingerprint_chk';
  IF v_fp_def IS NULL
     OR v_fp_def NOT LIKE '%outlet_replenishment%'
     OR v_fp_def NOT LIKE '%outlet_replenishment_reversal%'
     OR v_fp_def NOT LIKE '%request_fingerprint%'
     OR v_fp_def NOT LIKE '%^[0-9a-f]{64}$%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (168): fingerprint CHECK predicate mismatch';
  END IF;

  IF to_regprocedure('public._phoenix_replenishment_fingerprint_v1(uuid,uuid,integer,text,text)') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (168): fingerprint helper missing';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc
          WHERE oid = 'public._phoenix_replenishment_fingerprint_v1(uuid,uuid,integer,text,text)'::regprocedure) THEN
    RAISE EXCEPTION 'VERIFY FAILED (168): fingerprint helper must be SECURITY DEFINER';
  END IF;
  IF has_function_privilege('authenticated',
       'public._phoenix_replenishment_fingerprint_v1(uuid,uuid,integer,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (168): fingerprint helper must revoke authenticated EXECUTE';
  END IF;

  IF to_regprocedure('public.phoenix_replenish_emergency_outlet(uuid,uuid,uuid,integer,text,text)') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (168): replenish RPC missing';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc
          WHERE oid = 'public.phoenix_replenish_emergency_outlet(uuid,uuid,uuid,integer,text,text)'::regprocedure) THEN
    RAISE EXCEPTION 'VERIFY FAILED (168): replenish RPC must be SECURITY DEFINER';
  END IF;
  IF NOT has_function_privilege('authenticated',
       'public.phoenix_replenish_emergency_outlet(uuid,uuid,uuid,integer,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (168): authenticated must EXECUTE the replenish RPC';
  END IF;

  v_rpc_def := pg_get_functiondef(
    'public.phoenix_replenish_emergency_outlet(uuid,uuid,uuid,integer,text,text)'::regprocedure
  );
  IF v_rpc_def NOT LIKE '%pg_advisory_xact_lock%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (168): advisory lock missing from RPC';
  END IF;
  IF v_rpc_def NOT LIKE '%FOR SHARE%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (168): FOR SHARE locks missing from RPC';
  END IF;
  IF v_rpc_def NOT LIKE '%FOR UPDATE%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (168): FOR UPDATE locks missing from RPC';
  END IF;
  IF v_rpc_def NOT LIKE '%outlet_stock.replenish%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (168): permission key check missing';
  END IF;
  IF v_rpc_def NOT LIKE '%cross_facility_route_forbidden%'
     OR v_rpc_def NOT LIKE '%health_center_route_requires_facility%'
     OR v_rpc_def NOT LIKE '%rescue_cart_requires_hospital%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (168): Addendum-F Shape H/I revalidation missing';
  END IF;
  -- Withdrawn warehouse-equality must NOT authorize movement (Addendum §F).
  IF v_rpc_def LIKE '%warehouse_id_equality%'
     OR v_rpc_def LIKE '%same_warehouse_required%'
     OR v_rpc_def LIKE '%source.warehouse_id = destination.warehouse_id%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (168): withdrawn warehouse-equality rule reintroduced';
  END IF;
  IF v_rpc_def NOT LIKE '%replenish_send%' OR v_rpc_def NOT LIKE '%replenish_receive%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (168): movement types missing from RPC body';
  END IF;
  IF v_rpc_def NOT LIKE '%outlet_replenishment%' OR v_rpc_def NOT LIKE '%transferred%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (168): reference_type/reason_code missing';
  END IF;
  -- No E-6 reverse RPC, no E-4 writes.
  IF to_regprocedure('public.phoenix_reverse_outlet_replenishment(uuid,uuid,uuid,integer,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (168): reverse RPC must not be created in E-5';
  END IF;
  IF v_rpc_def LIKE '%is_initial_provisioning%'
     OR v_rpc_def LIKE '%initial_provisioning_consumed_at%'
     OR v_rpc_def LIKE '%phoenix_create_initial_provisioning_dispatch%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (168): E-4 interference detected in E-5 RPC';
  END IF;

  -- 166/167 objects must remain untouched by this migration's DDL.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'warehouse_dispatches'
      AND column_name = 'is_initial_provisioning'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (168): E-4 column disappeared';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
        WHERE conname = 'warehouse_dispatch_lines_decision_chk')
     NOT LIKE '%(received_quantity IS NOT NULL) AND (received_quantity = 0)%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (168): Migration 167 decision CHECK was altered';
  END IF;

  RAISE NOTICE '168 VERIFY OK.';
END;
$verify$;

COMMIT;

-- ============================================================================
-- ROLLBACK (manual):
--   DROP FUNCTION public.phoenix_replenish_emergency_outlet(uuid, uuid, uuid, integer, text, text);
--   DROP FUNCTION public._phoenix_replenishment_fingerprint_v1(uuid, uuid, integer, text, text);
--   ALTER TABLE public.outlet_stock_movements
--     DROP CONSTRAINT osm_replenishment_fingerprint_chk;
--   DROP INDEX public.outlet_stock_movements_replenishment_once_uniq;
--   ALTER TABLE public.outlet_stock_movements
--     DROP CONSTRAINT outlet_stock_movements_type_chk;
--   ALTER TABLE public.outlet_stock_movements
--     ADD CONSTRAINT outlet_stock_movements_type_chk
--     CHECK (movement_type IN (
--       'set_exact', 'add', 'subtract', 'correction',
--       'reserve', 'release', 'dispatch_receive', 'dispense', 'return_send'
--     ));
-- ============================================================================
-- END OF MIGRATION 168
-- ============================================================================
