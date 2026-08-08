-- ============================================================================
-- OUTLET-REPLENISHMENT-REVERSAL-169  (Stage E · subphase E-6)
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply after 168, via the Supabase SQL Editor, after reading this file in full.
--
-- NOT APPLIED BY THIS PR. Authored and replayed on a disposable PostgreSQL rig
-- only. Migrations 001-168 are immutable and are NOT edited here.
--
-- Stage E / E-6. Apply after 168.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE GAP THIS CLOSES (V4 §15, §16 rows 4-5, §17, §18, §20 E-6 bullet)
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 168 closed the FORWARD pharmacy → emergency-outlet corridor but has
-- no way back: once stock is routine-replenished onto a rescue cart or crash
-- cabinet, a mistaken quantity or a corrected decision has no atomic, ledgered
-- path to the original pharmacy. 071's outlet→institution return corridor
-- cannot be reused (§15-iii): `orrl_inbound_movement_type_chk` structurally
-- requires `original_inbound_movement_type = 'dispatch_receive'`, so a
-- `replenish_receive` leg can never enter it. This migration adds ONLY the E-6
-- runtime delta:
--   1. Reversal partial unique index (one send + one receive per reversal
--      reference, exact V4 §14/§18 predicate — the forward once-index is NOT
--      touched)
--   2. phoenix_outlet_replenishment_reversible_batches — read-only helper
--      listing reversible origin `replenish_receive` legs with remaining cap,
--      because `phoenix_inventory_fefo_batches` (150) INNER JOINs
--      `warehouse_dispatch_lines` and cannot see replenishment-origin stock
--   3. phoenix_reverse_outlet_replenishment — atomic debit(emergency
--      outlet)+credit(original pharmacy) under lock, reusing the existing
--      `returned_quantity` cap column (071) and the canonical
--      `material_identity_key` boundary (150), with the same
--      authorize-before-idempotent-replay discipline the PR #109 review
--      established for 168
--
-- Direction (forward vs reversal) is carried by `reference_type`
-- ('outlet_replenishment' vs 'outlet_replenishment_reversal'), never by a third
-- or fourth `movement_type` — `replenish_send`/`replenish_receive` are reused
-- exactly as declared in src/shared/lib/emergency-replenishment.ts (E-1).
--
-- E-5 FINGERPRINT HELPER IS NOT TOUCHED (Owner correction, this gate §4):
-- `_phoenix_replenishment_fingerprint_v1` is E-5-owned and its hardcoded
-- `'operation':'replenish_emergency_outlet'` payload is correct for E-5's own
-- purpose. E-6 computes its OWN fingerprint inline, with the canonical
-- jsonb_build_object → ::text → convert_to(UTF8) → sha256 → encode(hex) idiom
-- and operation label 'reverse_outlet_replenishment'. No CREATE OR REPLACE of
-- any E-5 object. No sibling helper. No fourth E-6 database object.
--
-- HISTORICAL ROUTE STATE: V4 §15's sequence lists `route FOR SHARE` and
-- `permission outlet_stock.replenish_reverse` but — unlike §14's forward
-- sequence, which explicitly gates fresh requests on `route.is_active` — never
-- gates reversal on the route's CURRENT is_active flag. This is deliberate, not
-- an omission: deactivating a route must not trap stock that was already sent
-- through it, mirroring 168's own "a route deactivated AFTER a request
-- completed must not break the authorized replay of that completed request"
-- principle, extended from replay to reversal. The route is still `FOR SHARE`
-- locked and must exist; its CURRENT `is_active` value is not a gate here.
--
-- SHAPE H/I ELIGIBILITY IS NOT RE-RUN: reversal settles the ledger back through
-- the SAME two points that already passed Addendum §F eligibility at forward
-- time; it is not a new corridor decision. Endpoint existence/organization
-- agreement is still asserted structurally via the route's own composite FKs.
--
-- Explicit non-goals: E-7 UI, E-8, Stage F, Availability vocabulary changes,
-- new tables/columns/permission keys/RLS widening, E-4 changes, 167/168 changes,
-- modifying `phoenix_inventory_fefo_batches` or `orrl_inbound_movement_type_chk`.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 0. PREFLIGHT
-- ============================================================================
DO $preflight$
BEGIN
  IF to_regclass('public.outlet_stock') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (169): public.outlet_stock is missing';
  END IF;
  IF to_regclass('public.outlet_stock_movements') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (169): public.outlet_stock_movements is missing';
  END IF;
  IF to_regclass('public.outlet_replenishment_routes') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (169): outlet_replenishment_routes (164) is missing';
  END IF;
  IF to_regprocedure('public.phoenix_replenish_emergency_outlet(uuid,uuid,uuid,integer,text,text)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (169): phoenix_replenish_emergency_outlet (168) is missing';
  END IF;
  IF to_regprocedure('public.phoenix_project_outlet_availability(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (169): phoenix_project_outlet_availability (067) is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.permission_keys WHERE key = 'outlet_stock.replenish_reverse') THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (169): outlet_stock.replenish_reverse permission key (164) is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'outlet_stock_movements_type_chk'
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (169): outlet_stock_movements_type_chk is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'osm_replenishment_fingerprint_chk'
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (169): osm_replenishment_fingerprint_chk (168) is missing';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'osm_replenishment_fingerprint_chk')
       NOT LIKE '%outlet_replenishment_reversal%' THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (169): fingerprint CHECK does not name the reversal namespace';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'osm_returned_qty_chk') THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (169): osm_returned_qty_chk (071) is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orrl_inbound_movement_type_chk') THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (169): orrl_inbound_movement_type_chk (071) is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'outlet_stock_movements_replenishment_once_uniq'
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (169): forward once-index (168) is missing';
  END IF;
  -- Idempotency: this migration is not re-runnable.
  IF to_regprocedure(
       'public.phoenix_reverse_outlet_replenishment(uuid,uuid,uuid,integer,text,text)'
     ) IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (169): phoenix_reverse_outlet_replenishment already exists';
  END IF;
  IF to_regprocedure(
       'public.phoenix_outlet_replenishment_reversible_batches(uuid,uuid)'
     ) IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (169): phoenix_outlet_replenishment_reversible_batches already exists';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'outlet_stock_movements_replenishment_reversal_once_uniq'
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (169): reversal_once_uniq already exists';
  END IF;
END;
$preflight$;

-- ============================================================================
-- 1. Reversal once-index — exact V4 §14/§18 predicate. Mirrors the forward
--    once-index shape; the forward index itself is untouched.
-- ============================================================================
CREATE UNIQUE INDEX outlet_stock_movements_replenishment_reversal_once_uniq
  ON public.outlet_stock_movements (reference_id, movement_type)
  WHERE reference_type = 'outlet_replenishment_reversal' AND reference_id IS NOT NULL;

-- ============================================================================
-- 2. Reversible-batches read helper (V4 §17/§18 — new read helper because
--    150's FEFO helper cannot see replenishment-origin stock).
--
--    Signature: phoenix_outlet_replenishment_reversible_batches(uuid,uuid)
--      = (p_organization_id, p_destination_point_id)
--
--    Lists every origin `replenish_receive` leg at the given emergency-outlet
--    distribution point with remaining reversible quantity > 0, oldest first.
--    Scoped, authenticated, revocable read API — supports the later E-7 UI but
--    grants no mutation capability of its own.
-- ============================================================================
CREATE FUNCTION public.phoenix_outlet_replenishment_reversible_batches(
  p_organization_id       uuid,
  p_destination_point_id  uuid
)
RETURNS TABLE (
  origin_receive_movement_id    uuid,
  origin_send_movement_id       uuid,
  origin_reference_id           uuid,
  destination_outlet_stock_id   uuid,
  source_outlet_stock_id        uuid,
  material_identity_key         text,
  scientific_name                text,
  batch_number                   text,
  expiry_date                    date,
  original_credited_quantity     integer,
  returned_quantity               integer,
  remaining_reversible_quantity  integer,
  origin_created_at              timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_destination_point_id IS NULL THEN
    RAISE EXCEPTION 'destination_point_id_required' USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active'
  ) THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'outlet_stock.replenish_reverse', p_organization_id,
    NULL, p_destination_point_id
  ) THEN
    RAISE EXCEPTION 'forbidden_outlet_stock_replenish_reverse' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    recv.id, send.id, recv.reference_id,
    recv.outlet_stock_id, send.outlet_stock_id,
    dst.material_identity_key, dst.scientific_name, dst.batch_number, dst.expiry_date,
    recv.on_hand_delta, recv.returned_quantity,
    recv.on_hand_delta - recv.returned_quantity,
    recv.created_at
  FROM public.outlet_stock_movements recv
  JOIN public.outlet_stock_movements send
    ON send.reference_type = recv.reference_type
   AND send.reference_id   = recv.reference_id
   AND send.movement_type  = 'replenish_send'
  JOIN public.outlet_stock dst ON dst.id = recv.outlet_stock_id
  WHERE recv.reference_type = 'outlet_replenishment'
    AND recv.movement_type = 'replenish_receive'
    AND recv.organization_id = p_organization_id
    AND recv.distribution_point_id = p_destination_point_id
    AND (recv.on_hand_delta - recv.returned_quantity) > 0
  ORDER BY recv.created_at ASC, recv.id ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_outlet_replenishment_reversible_batches(uuid, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_outlet_replenishment_reversible_batches(uuid, uuid)
  TO authenticated;

COMMENT ON FUNCTION public.phoenix_outlet_replenishment_reversible_batches(uuid, uuid) IS
  'E-6 read-only helper: lists reversible replenish_receive origins (remaining '
  'quantity > 0, oldest first) at one emergency-outlet distribution point. Does '
  'NOT use phoenix_inventory_fefo_batches (150) — that helper cannot see '
  'replenishment-origin stock (no warehouse_dispatch_lines row). Never a '
  'movement writer. Permission: outlet_stock.replenish_reverse.';

-- ============================================================================
-- 3. Atomic reversal corridor RPC
--    Signature: phoenix_reverse_outlet_replenishment(uuid,uuid,uuid,integer,text,text)
--      = (p_request_id, p_route_id, p_destination_outlet_stock_id, p_quantity,
--         p_reason, p_notes)
--
--    Parameter naming note (Owner-flagged interpretive choice, not silently
--    assumed — see this migration's header and the PR body): V4 §18 gives the
--    exact type signature `(uuid,uuid,uuid,integer,text,text)` but, unlike
--    §14's forward RPC, does not spell out each parameter's English name. By
--    structural symmetry with the forward RPC (which takes the SOURCE stock id
--    it debits) and V4 §15's explicit "origin movement is derived, never
--    client-supplied (oldest-first with remaining cap > 0)", this RPC takes
--    the DESTINATION (emergency-outlet) stock id being reversed FROM and
--    derives the specific origin `replenish_receive` leg itself — it does NOT
--    accept a caller-supplied movement id. `p_reason` is free-text business
--    justification (there is no FEFO-style override choice to justify here,
--    unlike the forward RPC's `p_fefo_override_reason`).
--
--    Lock order (binding, mirrors V4 §15 exactly):
--      1. advisory xact lock on request_id (salt 169169 — distinct from
--         067/106/156/168's 168168)
--      2. route row share-lock
--      3. authorization (active profile + outlet_stock.replenish_reverse,
--         scoped to the DESTINATION org/point) — BEFORE any replay return,
--         exactly the discipline PR #109 established for 168
--      4. idempotent replay probe
--      5. [fresh only] both distribution points share-lock
--      6. origin replenish_receive movement FOR UPDATE (oldest eligible,
--         remaining cap > 0) — the new E-6 serialization point
--      7. derive the paired original replenish_send via the SAME
--         (reference_type, reference_id)
--      8. both outlet_stock rows FOR UPDATE, ascending id
--      9. re-check cap + availability under lock
--     10. mutate, ledger, audit
-- ============================================================================
CREATE FUNCTION public.phoenix_reverse_outlet_replenishment(
  p_request_id                    uuid,
  p_route_id                      uuid,
  p_destination_outlet_stock_id   uuid,
  p_quantity                      integer,
  p_reason                        text DEFAULT NULL,
  p_notes                         text DEFAULT NULL
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
  v_reason         text := NULLIF(btrim(p_reason), '');
  v_notes          text := NULLIF(btrim(p_notes), '');
  v_fingerprint    text;
  v_route          public.outlet_replenishment_routes%ROWTYPE;
  v_dst_stock      public.outlet_stock%ROWTYPE;
  v_src_stock      public.outlet_stock%ROWTYPE;
  v_tmp_stock      public.outlet_stock%ROWTYPE;
  v_stock_first    uuid;
  v_stock_second   uuid;
  v_origin_recv    public.outlet_stock_movements%ROWTYPE;
  v_origin_send    public.outlet_stock_movements%ROWTYPE;
  v_send_existing  public.outlet_stock_movements%ROWTYPE;
  v_recv_existing  public.outlet_stock_movements%ROWTYPE;
  v_remaining_cap  integer;
  v_dst_before     integer;
  v_dst_after      integer;
  v_src_before     integer;
  v_src_after      integer;
  v_send_id        uuid;
  v_recv_id        uuid;
  v_correlation_id uuid := gen_random_uuid();
  v_avail_dst      uuid;
  v_avail_src      uuid;
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
  IF p_destination_outlet_stock_id IS NULL THEN
    RAISE EXCEPTION 'destination_outlet_stock_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;

  -- Inline canonical fingerprint (Owner correction, §4 of this gate): the
  -- E-5 forward-corridor fingerprint helper is intentionally not reused or
  -- modified here (see this migration's header). Same idiom
  -- (jsonb_build_object -> ::text -> convert_to(UTF8) -> sha256 ->
  -- encode(hex)), E-6-specific operation label.
  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'reverse_outlet_replenishment',
    'route_id', p_route_id,
    'destination_outlet_stock_id', p_destination_outlet_stock_id,
    'quantity', p_quantity,
    'reason', v_reason,
    'notes', v_notes
  )::text, 'UTF8')), 'hex');

  -- 1. Advisory lock FIRST (salt 169169 — distinct from 067/106/156/168168).
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 169169));

  -- 2. Route row share-lock BEFORE the replay probe (same discipline as 168's
  --    PR #109 correction). Authorization scope derives from the route row.
  SELECT * INTO v_route
  FROM public.outlet_replenishment_routes
  WHERE id = p_route_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'route_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- 3. Authorization — scoped to the route's DESTINATION (the emergency
  --    outlet losing stock back). Enforced BEFORE any replay return so an
  --    unauthorized caller can never obtain successful replay semantics or
  --    operation details for an existing request_id.
  SELECT p.role, p.full_name INTO v_actor_role, v_actor_name
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'outlet_stock.replenish_reverse', v_route.organization_id,
    NULL, v_route.destination_point_id
  ) THEN
    RAISE EXCEPTION 'forbidden_outlet_stock_replenish_reverse' USING ERRCODE = '42501';
  END IF;

  -- 4. Idempotent replay probe — no dedup table, same idiom as 168.
  --    Reached only by an authorized, active caller (above).
  SELECT * INTO v_send_existing
  FROM public.outlet_stock_movements m
  WHERE m.reference_type = 'outlet_replenishment_reversal'
    AND m.reference_id = p_request_id
    AND m.movement_type = 'replenish_send';

  SELECT * INTO v_recv_existing
  FROM public.outlet_stock_movements m
  WHERE m.reference_type = 'outlet_replenishment_reversal'
    AND m.reference_id = p_request_id
    AND m.movement_type = 'replenish_receive';

  IF FOUND OR v_send_existing.id IS NOT NULL THEN
    IF v_send_existing.id IS NULL OR v_recv_existing.id IS NULL THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505',
        DETAIL = 'partial reversal legs for this request_id — refresh and resubmit';
    END IF;
    IF v_send_existing.request_fingerprint IS DISTINCT FROM v_fingerprint
       OR v_recv_existing.request_fingerprint IS DISTINCT FROM v_fingerprint
       OR v_send_existing.outlet_stock_id IS DISTINCT FROM p_destination_outlet_stock_id THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505',
        DETAIL = 'same request_id previously submitted with a different payload';
    END IF;
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent_replay', true,
      'request_id', p_request_id,
      'route_id', p_route_id,
      'destination_outlet_stock_id', v_send_existing.outlet_stock_id,
      'source_outlet_stock_id', v_recv_existing.outlet_stock_id,
      'send_movement_id', v_send_existing.id,
      'receive_movement_id', v_recv_existing.id,
      'quantity', abs(v_send_existing.on_hand_delta),
      'destination_quantity_before', v_send_existing.on_hand_before,
      'destination_quantity_after', v_send_existing.on_hand_after,
      'source_quantity_before', v_recv_existing.on_hand_before,
      'source_quantity_after', v_recv_existing.on_hand_after,
      'request_fingerprint', v_fingerprint
    );
  END IF;

  -- Fresh execution from here on. Deliberately NO route.is_active gate (see
  -- this migration's header note) — deactivating a route must not trap stock
  -- already sent through it.

  -- 5. Distribution-point share-lock, ascending id (mirrors 168).
  IF v_route.source_point_id < v_route.destination_point_id THEN
    PERFORM 1 FROM public.distribution_points WHERE id = v_route.source_point_id FOR SHARE;
    PERFORM 1 FROM public.distribution_points WHERE id = v_route.destination_point_id FOR SHARE;
  ELSE
    PERFORM 1 FROM public.distribution_points WHERE id = v_route.destination_point_id FOR SHARE;
    PERFORM 1 FROM public.distribution_points WHERE id = v_route.source_point_id FOR SHARE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.distribution_points WHERE id = v_route.source_point_id) THEN
    RAISE EXCEPTION 'source_distribution_point_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.distribution_points WHERE id = v_route.destination_point_id) THEN
    RAISE EXCEPTION 'destination_distribution_point_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Destination stock must actually sit at this route's destination point.
  SELECT * INTO v_dst_stock
  FROM public.outlet_stock
  WHERE id = p_destination_outlet_stock_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'destination_outlet_stock_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_dst_stock.distribution_point_id IS DISTINCT FROM v_route.destination_point_id THEN
    RAISE EXCEPTION 'destination_stock_not_on_route' USING ERRCODE = '23514';
  END IF;
  IF v_dst_stock.organization_id IS DISTINCT FROM v_route.organization_id THEN
    RAISE EXCEPTION 'destination_stock_organization_mismatch' USING ERRCODE = '42501';
  END IF;

  -- 6. Origin replenish_receive movement FOR UPDATE — derived server-side,
  --    oldest eligible with remaining cap > 0. NEVER client-supplied
  --    (V4 §15). This is the new E-6 serialization point for competing
  --    reversals of the same origin.
  SELECT * INTO v_origin_recv
  FROM public.outlet_stock_movements
  WHERE reference_type = 'outlet_replenishment'
    AND movement_type = 'replenish_receive'
    AND outlet_stock_id = p_destination_outlet_stock_id
    AND organization_id = v_route.organization_id
    AND (on_hand_delta - returned_quantity) > 0
  ORDER BY created_at ASC, id ASC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no_reversible_origin_for_destination' USING ERRCODE = 'P0002';
  END IF;

  -- 7. Derive the EXACT paired original replenish_send via the SAME
  --    (reference_type, reference_id) — never by material name, route
  --    endpoint, or any client-supplied identity (V4 §15 / this gate §5).
  SELECT * INTO v_origin_send
  FROM public.outlet_stock_movements
  WHERE reference_type = v_origin_recv.reference_type
    AND reference_id = v_origin_recv.reference_id
    AND movement_type = 'replenish_send'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'paired_original_send_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- CORRECTION (independent review, PR #110): stock conservation alone is
  -- insufficient — the supplied route must be the EXACT historical route the
  -- original forward pair actually moved through, not merely a route that
  -- happens to share the same current destination. Without this, a caller
  -- could submit a currently-active route NEW (Pharmacy B -> Cart X) against
  -- a destination stock whose reversible origin was actually created through
  -- a DIFFERENT, since-deactivated route OLD (Pharmacy A -> Cart X): stock
  -- would still conserve and credit the correct Pharmacy A row (derived
  -- purely from the origin pair, untouched by this check), but the
  -- reversal would be fingerprinted, ledgered, and audited under the wrong
  -- route. The original paired movements remain the sole stock-provenance
  -- authority; this is an ADDITIONAL route-provenance invariant on top of
  -- that, not a replacement for it. Deliberately NOT a route.is_active gate
  -- (see this migration's header) — an inactive OLD route whose movements
  -- originated through it remains fully reversible.
  IF v_origin_recv.distribution_point_id IS DISTINCT FROM v_route.destination_point_id
     OR v_origin_send.distribution_point_id IS DISTINCT FROM v_route.source_point_id
     OR v_origin_recv.organization_id IS DISTINCT FROM v_route.organization_id
     OR v_origin_send.organization_id IS DISTINCT FROM v_route.organization_id THEN
    RAISE EXCEPTION 'origin_forward_route_mismatch' USING ERRCODE = '23514';
  END IF;

  v_remaining_cap := v_origin_recv.on_hand_delta - v_origin_recv.returned_quantity;
  IF p_quantity > v_remaining_cap THEN
    RAISE EXCEPTION 'reversal_quantity_exceeds_remaining_cap' USING ERRCODE = '23514';
  END IF;

  -- The exact original pharmacy stock row — resolved from the paired SEND
  -- leg's own outlet_stock_id, never re-derived from route/material lookup.
  SELECT * INTO v_src_stock
  FROM public.outlet_stock
  WHERE id = v_origin_send.outlet_stock_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'original_pharmacy_stock_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Identity assertion (071:1122-1134 pattern): the two original movement
  -- snapshots and the two CURRENT stock rows must all agree on canonical
  -- material identity. No partial-field comparison (PR #109 lesson).
  IF v_dst_stock.material_identity_key IS DISTINCT FROM v_src_stock.material_identity_key THEN
    RAISE EXCEPTION 'material_identity_drift_between_endpoints' USING ERRCODE = '23514';
  END IF;
  IF v_origin_recv.scientific_name_snapshot IS DISTINCT FROM v_dst_stock.scientific_name
     OR COALESCE(v_origin_recv.concentration_snapshot, '') IS DISTINCT FROM COALESCE(v_dst_stock.concentration, '')
     OR COALESCE(v_origin_recv.dosage_form_snapshot, '')   IS DISTINCT FROM COALESCE(v_dst_stock.dosage_form, '')
     OR COALESCE(v_origin_recv.batch_number_snapshot, '')  IS DISTINCT FROM COALESCE(v_dst_stock.batch_number, '')
     OR COALESCE(v_origin_recv.internal_batch_reference_snapshot, '')
          IS DISTINCT FROM COALESCE(v_dst_stock.internal_batch_reference, '')
     OR v_origin_recv.expiry_date_snapshot IS DISTINCT FROM v_dst_stock.expiry_date THEN
    RAISE EXCEPTION 'destination_snapshot_material_mismatch' USING ERRCODE = '23514';
  END IF;

  -- 8. Both outlet_stock rows FOR UPDATE, ascending id.
  IF v_dst_stock.id < v_src_stock.id THEN
    v_stock_first := v_dst_stock.id;
    v_stock_second := v_src_stock.id;
  ELSE
    v_stock_first := v_src_stock.id;
    v_stock_second := v_dst_stock.id;
  END IF;

  SELECT * INTO v_tmp_stock FROM public.outlet_stock WHERE id = v_stock_first FOR UPDATE;
  SELECT * INTO v_src_stock FROM public.outlet_stock WHERE id = v_stock_second FOR UPDATE;
  IF v_tmp_stock.id = v_dst_stock.id THEN
    v_dst_stock := v_tmp_stock;
  ELSE
    v_dst_stock := v_src_stock;
    v_src_stock := v_tmp_stock;
  END IF;

  -- 9. Availability re-check under the just-acquired stock lock. The cap
  --    check itself does not need to be repeated here: v_origin_recv was
  --    already read FOR UPDATE at step 6 and that lock is held for the rest
  --    of this transaction, so returned_quantity cannot have changed under
  --    us — re-selecting it again would be dead code, not a real guard.
  IF v_dst_stock.available_quantity < p_quantity THEN
    RAISE EXCEPTION 'insufficient_emergency_stock_to_reverse' USING ERRCODE = '23514';
  END IF;

  v_dst_before := v_dst_stock.on_hand_quantity;
  v_dst_after  := v_dst_before - p_quantity;
  IF v_dst_after < 0 THEN
    RAISE EXCEPTION 'outlet_quantity_cannot_go_negative' USING ERRCODE = '23514';
  END IF;
  IF v_dst_after < v_dst_stock.reserved_quantity THEN
    RAISE EXCEPTION 'outlet_quantity_below_reserved' USING ERRCODE = '23514';
  END IF;

  v_src_before := v_src_stock.on_hand_quantity;
  v_src_after  := v_src_before + p_quantity;

  -- 10. Mutate.
  UPDATE public.outlet_stock
     SET on_hand_quantity = v_dst_after,
         notes            = COALESCE(v_notes, notes),
         updated_by       = v_actor
   WHERE id = v_dst_stock.id;

  UPDATE public.outlet_stock
     SET on_hand_quantity = v_src_after,
         notes            = COALESCE(v_notes, notes),
         updated_by       = v_actor
   WHERE id = v_src_stock.id;

  -- Cap increment lives on the ORIGIN RECEIVE leg only (§8 of this gate) — the
  -- original send leg's returned_quantity is never touched.
  UPDATE public.outlet_stock_movements
     SET returned_quantity = returned_quantity + p_quantity
   WHERE id = v_origin_recv.id;

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
    'replenish_send',
    v_dst_before, -p_quantity, v_dst_after,
    v_dst_stock.reserved_quantity, 0, v_dst_stock.reserved_quantity,
    v_reason, 'transferred', 'outlet_replenishment_reversal', p_request_id, v_fingerprint,
    v_actor, v_actor_role, v_actor_name,
    v_dst_stock.scientific_name, v_dst_stock.concentration, v_dst_stock.dosage_form,
    v_dst_stock.batch_number, v_dst_stock.internal_batch_reference, v_dst_stock.expiry_date,
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
    v_src_stock.id, v_src_stock.organization_id, v_src_stock.distribution_point_id,
    'replenish_receive',
    v_src_before, p_quantity, v_src_after,
    v_src_stock.reserved_quantity, 0, v_src_stock.reserved_quantity,
    v_reason, 'transferred', 'outlet_replenishment_reversal', p_request_id, v_fingerprint,
    v_actor, v_actor_role, v_actor_name,
    v_src_stock.scientific_name, v_src_stock.concentration, v_src_stock.dosage_form,
    v_src_stock.batch_number, v_src_stock.internal_batch_reference, v_src_stock.expiry_date,
    v_correlation_id
  )
  RETURNING id INTO v_recv_id;

  v_avail_dst := public.phoenix_project_outlet_availability(v_dst_stock.id);
  v_avail_src := public.phoenix_project_outlet_availability(v_src_stock.id);

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role,
    action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_dst_stock.organization_id, v_actor, v_actor_role,
    'outlet_stock.replenish_reverse', 'outlet_replenishment_routes', p_route_id,
    v_dst_stock.scientific_name,
    jsonb_build_object(
      'request_id', p_request_id,
      'route_id', p_route_id,
      'destination_outlet_stock_id', v_dst_stock.id,
      'source_outlet_stock_id', v_src_stock.id,
      'destination_distribution_point_id', v_dst_stock.distribution_point_id,
      'source_distribution_point_id', v_src_stock.distribution_point_id,
      'original_forward_reference_id', v_origin_recv.reference_id,
      'original_receive_movement_id', v_origin_recv.id,
      'original_send_movement_id', v_origin_send.id,
      'send_movement_id', v_send_id,
      'receive_movement_id', v_recv_id,
      'quantity', p_quantity,
      'destination_quantity_before', v_dst_before,
      'destination_quantity_after', v_dst_after,
      'source_quantity_before', v_src_before,
      'source_quantity_after', v_src_after,
      'origin_returned_quantity_after', v_origin_recv.returned_quantity + p_quantity,
      'request_fingerprint', v_fingerprint,
      'correlation_id', v_correlation_id,
      'destination_availability_id', v_avail_dst,
      'source_availability_id', v_avail_src
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'idempotent_replay', false,
    'request_id', p_request_id,
    'route_id', p_route_id,
    'destination_outlet_stock_id', v_dst_stock.id,
    'source_outlet_stock_id', v_src_stock.id,
    'send_movement_id', v_send_id,
    'receive_movement_id', v_recv_id,
    'quantity', p_quantity,
    'destination_quantity_before', v_dst_before,
    'destination_quantity_after', v_dst_after,
    'source_quantity_before', v_src_before,
    'source_quantity_after', v_src_after,
    'request_fingerprint', v_fingerprint
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_reverse_outlet_replenishment(uuid, uuid, uuid, integer, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_reverse_outlet_replenishment(uuid, uuid, uuid, integer, text, text)
  TO authenticated;

COMMENT ON FUNCTION public.phoenix_reverse_outlet_replenishment(uuid, uuid, uuid, integer, text, text) IS
  'E-6 atomic emergency-outlet -> pharmacy replenishment reversal. Debits the '
  'destination outlet_stock and credits back the EXACT original pharmacy '
  'outlet_stock (resolved via the original forward reference_id pairing, '
  'never by material name or route lookup), capped by returned_quantity on '
  'the origin replenish_receive leg (071 idiom), with authorize-before-replay '
  'discipline and an inline canonical fingerprint. Permission: '
  'outlet_stock.replenish_reverse. Not a general return — 071''s inbound-'
  'provenance CHECK keeps this corridor structurally separate.';

-- ============================================================================
-- 4. VERIFY
-- ============================================================================
DO $verify$
DECLARE
  v_idx_def  text;
  v_rb_def   text;
  v_rpc_def  text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'outlet_stock_movements_replenishment_reversal_once_uniq'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (169): reversal_once_uniq missing';
  END IF;
  SELECT indexdef INTO v_idx_def FROM pg_indexes
  WHERE schemaname = 'public' AND indexname = 'outlet_stock_movements_replenishment_reversal_once_uniq';
  IF v_idx_def NOT LIKE '%UNIQUE%'
     OR v_idx_def NOT LIKE '%reference_id%'
     OR v_idx_def NOT LIKE '%movement_type%'
     OR v_idx_def NOT LIKE '%outlet_replenishment_reversal%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (169): reversal_once_uniq wrong shape';
  END IF;
  -- Forward once-index must be completely untouched.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'outlet_stock_movements_replenishment_once_uniq'
      AND indexdef LIKE '%outlet_replenishment%'
      AND indexdef NOT LIKE '%outlet_replenishment_reversal%'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (169): forward once-index was altered';
  END IF;

  IF to_regprocedure('public.phoenix_outlet_replenishment_reversible_batches(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (169): reversible-batches helper missing';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc
          WHERE oid = 'public.phoenix_outlet_replenishment_reversible_batches(uuid,uuid)'::regprocedure) THEN
    RAISE EXCEPTION 'VERIFY FAILED (169): reversible-batches helper must be SECURITY DEFINER';
  END IF;
  IF NOT has_function_privilege('authenticated',
       'public.phoenix_outlet_replenishment_reversible_batches(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (169): authenticated must EXECUTE the reversible-batches helper';
  END IF;
  v_rb_def := pg_get_functiondef('public.phoenix_outlet_replenishment_reversible_batches(uuid,uuid)'::regprocedure);
  IF v_rb_def LIKE '%warehouse_dispatch_lines%' OR v_rb_def LIKE '%dispatch_receive%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (169): reversible-batches helper must not depend on dispatch provenance';
  END IF;
  IF v_rb_def NOT LIKE '%phoenix_profile_has_scoped_permission%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (169): reversible-batches helper missing authorization gate';
  END IF;

  IF to_regprocedure('public.phoenix_reverse_outlet_replenishment(uuid,uuid,uuid,integer,text,text)') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (169): reversal RPC missing';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc
          WHERE oid = 'public.phoenix_reverse_outlet_replenishment(uuid,uuid,uuid,integer,text,text)'::regprocedure) THEN
    RAISE EXCEPTION 'VERIFY FAILED (169): reversal RPC must be SECURITY DEFINER';
  END IF;
  IF NOT has_function_privilege('authenticated',
       'public.phoenix_reverse_outlet_replenishment(uuid,uuid,uuid,integer,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (169): authenticated must EXECUTE the reversal RPC';
  END IF;

  v_rpc_def := pg_get_functiondef(
    'public.phoenix_reverse_outlet_replenishment(uuid,uuid,uuid,integer,text,text)'::regprocedure
  );
  IF v_rpc_def NOT LIKE '%pg_advisory_xact_lock%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (169): advisory lock missing from RPC';
  END IF;
  IF v_rpc_def NOT LIKE '%FOR SHARE%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (169): FOR SHARE locks missing from RPC';
  END IF;
  IF v_rpc_def NOT LIKE '%FOR UPDATE%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (169): FOR UPDATE locks missing from RPC';
  END IF;
  IF v_rpc_def NOT LIKE '%outlet_stock.replenish_reverse%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (169): permission key check missing';
  END IF;
  -- Authorize-before-replay: permission + active-profile gates precede the
  -- idempotent replay return (PR #109 discipline, repeated here).
  IF position('outlet_stock.replenish_reverse' in v_rpc_def)
       > position('idempotent_replay'', true' in v_rpc_def) THEN
    RAISE EXCEPTION 'VERIFY FAILED (169): permission gate does not precede idempotent replay return';
  END IF;
  IF position('active_profile_required' in v_rpc_def)
       > position('idempotent_replay'', true' in v_rpc_def) THEN
    RAISE EXCEPTION 'VERIFY FAILED (169): active-profile gate does not precede idempotent replay return';
  END IF;
  -- E-5 fingerprint helper must NOT be touched or reused by this RPC.
  IF v_rpc_def LIKE '%_phoenix_replenishment_fingerprint_v1%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (169): must not reuse the E-5 fingerprint helper';
  END IF;
  IF v_rpc_def NOT LIKE '%reverse_outlet_replenishment%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (169): inline fingerprint must use the reverse_outlet_replenishment operation label';
  END IF;
  -- Canonical material identity, never the withdrawn partial predicate.
  IF v_rpc_def NOT LIKE '%material_identity_key%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (169): material_identity_key assertion missing';
  END IF;
  IF v_rpc_def NOT LIKE '%returned_quantity%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (169): returned_quantity cap missing';
  END IF;
  -- CORRECTION (PR #110): the supplied route must be the exact historical
  -- route the original forward pair moved through — recv-side destination
  -- and send-side source must each be checked against the route, plus
  -- organization consistency on both legs.
  IF v_rpc_def NOT LIKE '%origin_forward_route_mismatch%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (169): cross-route historical provenance assertion missing';
  END IF;
  IF v_rpc_def NOT LIKE '%v_origin_recv.distribution_point_id%v_route.destination_point_id%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (169): origin receive destination-point assertion missing';
  END IF;
  IF v_rpc_def NOT LIKE '%v_origin_send.distribution_point_id%v_route.source_point_id%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (169): origin send source-point assertion missing';
  END IF;
  IF v_rpc_def NOT LIKE '%replenish_send%' OR v_rpc_def NOT LIKE '%replenish_receive%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (169): movement types missing from RPC body';
  END IF;
  IF v_rpc_def NOT LIKE '%outlet_replenishment_reversal%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (169): reversal reference_type missing from RPC body';
  END IF;
  -- No warehouse movement, no dispatch, no E-4 interaction.
  IF v_rpc_def LIKE '%warehouse_stock_movements%'
     OR v_rpc_def LIKE '%dispatch_line_id%'
     OR v_rpc_def LIKE '%is_initial_provisioning%'
     OR v_rpc_def LIKE '%initial_provisioning_consumed_at%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (169): unexpected warehouse/dispatch/E-4 interaction';
  END IF;

  -- 168/167/166 objects must remain untouched.
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
        WHERE conname = 'warehouse_dispatch_lines_decision_chk')
     NOT LIKE '%(received_quantity IS NOT NULL) AND (received_quantity = 0)%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (169): Migration 167 decision CHECK was altered';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'warehouse_dispatches'
      AND column_name = 'is_initial_provisioning'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (169): E-4 column disappeared';
  END IF;
  IF to_regprocedure('public.phoenix_replenish_emergency_outlet(uuid,uuid,uuid,integer,text,text)') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (169): E-5 forward RPC disappeared';
  END IF;
  -- orrl_inbound_movement_type_chk (071) must still reject replenish_receive.
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
        WHERE conname = 'orrl_inbound_movement_type_chk')
     NOT LIKE '%''dispatch_receive''%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (169): 071 generic-return provenance CHECK was altered';
  END IF;

  RAISE NOTICE '169 VERIFY OK.';
END;
$verify$;

COMMIT;

-- ============================================================================
-- ROLLBACK (manual):
--   DROP FUNCTION public.phoenix_reverse_outlet_replenishment(uuid, uuid, uuid, integer, text, text);
--   DROP FUNCTION public.phoenix_outlet_replenishment_reversible_batches(uuid, uuid);
--   DROP INDEX public.outlet_stock_movements_replenishment_reversal_once_uniq;
-- ============================================================================
-- END OF MIGRATION 169
-- ============================================================================
