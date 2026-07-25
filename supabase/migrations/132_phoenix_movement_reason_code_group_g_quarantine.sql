-- ============================================================================
-- MOVEMENT-REASON-CODE-GROUP-G-QUARANTINE-132
--
-- Eighteenth slice of Unified Movements & Outlet Operations (PR #57, item
-- A). Seventh of eight domain slices wiring reason_code + server-owned
-- correlation_id/causation_id into the 20 audited ledger-writer RPCs.
--
-- GROUP G — quarantine release and destroy, the two remaining confirmed
-- free-text-to-ledger gaps:
--
--   * phoenix_release_quarantine_stock (099) — writes BOTH ledgers: a debit
--     on warehouse_quarantine_stock_movements and a destination credit on
--     warehouse_stock_movements. Both currently take the SAME client free
--     text (p_reason) and write it two different ways (raw on the
--     quarantine side, prefixed 'quarantine_release: ' on the warehouse
--     side) -- the only function in the audit that does that. NEEDS NO NEW
--     PARAMETER: the already-locked v_q (warehouse_quarantine_stock) row
--     carries its own quarantine_reason (a 6-value CHECK subset of 125's
--     16-value union, set when the lot was first quarantined), which
--     becomes reason_code verbatim on BOTH ledger rows -- the same "wire
--     the already-resident value through" fix as Groups C/D/E. The
--     free-text p_reason keeps serving its existing reason-detail role on
--     both rows, unchanged.
--
--   * phoenix_destroy_quarantine_stock (099) — same fix, one ledger: writes
--     ONLY warehouse_quarantine_stock_movements (destroyed material has no
--     destination credit). reason_code = v_q.quarantine_reason verbatim,
--     same as the release function's quarantine-side row.
--
-- CORRELATION/CAUSATION: neither function is chained to a REQUEST row the
-- way Groups B/C/D/E's sends are -- there is no "quarantine release
-- request" table. The real predecessor is the MOST RECENT prior movement
-- against this exact quarantine_stock_id (queried before either function's
-- own INSERT), which is genuinely whatever event most recently changed
-- this lot's custody state -- typically the original quarantine-receive
-- event, or an earlier partial release/destroy against the same lot. Its
-- correlation_id is reused and its own id becomes causation_id -- a real,
-- queryable, always-correct predecessor, never a guess. For
-- phoenix_release_quarantine_stock's cross-ledger pair specifically, the
-- warehouse-side credit row additionally chains from the quarantine-side
-- debit row this same call just inserted (a real, same-transaction
-- predecessor) -- the insert order is swapped (quarantine row first,
-- warehouse row second) so that id is available.
--
-- PRECONDITIONS: 131 applied (Group F slice).
-- ============================================================================

DO $precond$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'phoenix_send_warehouse_dispatch'
       AND p.pronamespace = 'public'::regnamespace
       AND pg_get_function_arguments(p.oid) LIKE '%p_dispatch_id%'
  ) THEN
    RAISE EXCEPTION '132 PRECONDITION FAILED: 131 (Group F slice) missing — apply 131 first';
  END IF;
END;
$precond$;

-- ── G1. phoenix_release_quarantine_stock — reason_code=v_q.quarantine_reason ─

CREATE OR REPLACE FUNCTION public.phoenix_release_quarantine_stock(
  p_request_id                   uuid,
  p_quarantine_stock_id          uuid,
  p_quantity                     integer,
  p_reason                       text,
  p_destination_warehouse_stock_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $release$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_actor_name text;
  v_q          public.warehouse_quarantine_stock%ROWTYPE;
  v_dest       public.warehouse_stock%ROWTYPE;
  v_existing   public.warehouse_quarantine_stock_movements%ROWTYPE;
  v_reason     text := NULLIF(btrim(p_reason), '');
  v_fp         text;
  v_predecessor_id uuid;
  v_correlation_id uuid;
  v_quarantine_movement_id uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'release_reason_required' USING ERRCODE = '23514';
  END IF;
  IF p_destination_warehouse_stock_id IS NULL THEN
    RAISE EXCEPTION 'destination_warehouse_stock_id_required' USING ERRCODE = '23514';
  END IF;

  v_fp := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'quarantine_release', 'quarantine_stock_id', p_quarantine_stock_id,
    'quantity', p_quantity, 'reason', v_reason,
    'destination', p_destination_warehouse_stock_id
  )::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 99099));

  SELECT * INTO v_existing
  FROM public.warehouse_quarantine_stock_movements m
  WHERE m.reference_type = 'quarantine_request' AND m.reference_id = p_request_id;
  IF FOUND THEN
    IF v_existing.quarantine_stock_id IS DISTINCT FROM p_quarantine_stock_id
       OR v_existing.request_fingerprint IS DISTINCT FROM v_fp THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('ok', true, 'idempotent_replay', true, 'movement_id', v_existing.id);
  END IF;

  SELECT * INTO v_q FROM public.warehouse_quarantine_stock WHERE id = p_quarantine_stock_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quarantine_stock_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF p_quantity > v_q.quantity THEN
    RAISE EXCEPTION 'release_quantity_exceeds_quarantined' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_dest FROM public.warehouse_stock WHERE id = p_destination_warehouse_stock_id FOR UPDATE;
  IF NOT FOUND OR v_dest.organization_id <> v_q.organization_id OR v_dest.warehouse_id <> v_q.warehouse_id THEN
    RAISE EXCEPTION 'destination_not_at_this_warehouse' USING ERRCODE = '23514';
  END IF;
  IF v_dest.scientific_name IS DISTINCT FROM v_q.scientific_name
     OR COALESCE(v_dest.batch_number,'') IS DISTINCT FROM COALESCE(v_q.batch_number,'')
     OR v_dest.expiry_date IS DISTINCT FROM v_q.expiry_date THEN
    RAISE EXCEPTION 'destination_material_batch_expiry_mismatch' USING ERRCODE = '23514';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'warehouse_transfer.return_request', v_q.organization_id, v_q.warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_quarantine_release' USING ERRCODE = '42501';
  END IF;

  SELECT p.role, p.full_name INTO v_actor_role, v_actor_name FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';

  -- 132: the real predecessor is whatever most recently touched this exact
  -- quarantine lot -- typically the original quarantine-receive movement.
  -- Queried BEFORE this call's own inserts, so it never finds itself.
  SELECT id, correlation_id INTO v_predecessor_id, v_correlation_id
  FROM public.warehouse_quarantine_stock_movements
  WHERE quarantine_stock_id = v_q.id
  ORDER BY created_at DESC
  LIMIT 1;
  v_correlation_id := COALESCE(v_correlation_id, gen_random_uuid());

  UPDATE public.warehouse_quarantine_stock SET quantity = quantity - p_quantity, updated_by = v_actor WHERE id = v_q.id;
  UPDATE public.warehouse_stock SET on_hand_quantity = on_hand_quantity + p_quantity WHERE id = v_dest.id;

  -- Quarantine-side row inserted FIRST (order swapped from the pre-132
  -- body) so its own id is available as the warehouse-side credit row's
  -- causation_id below -- a real, same-transaction predecessor.
  INSERT INTO public.warehouse_quarantine_stock_movements (
    quarantine_stock_id, organization_id, warehouse_id, movement_type,
    quantity_before, quantity_delta, quantity_after, reason, reason_code,
    reference_type, reference_id, request_fingerprint,
    actor_id, actor_role, actor_name,
    scientific_name_snapshot, batch_number_snapshot, internal_batch_reference_snapshot,
    correlation_id, causation_id
  ) VALUES (
    v_q.id, v_q.organization_id, v_q.warehouse_id, 'quarantine_release',
    v_q.quantity, -p_quantity, v_q.quantity - p_quantity, v_reason, v_q.quarantine_reason,
    'quarantine_request', p_request_id, v_fp,
    v_actor, v_actor_role, v_actor_name,
    v_q.scientific_name, v_q.batch_number, v_q.internal_batch_reference,
    v_correlation_id, v_predecessor_id
  )
  RETURNING id INTO v_quarantine_movement_id;

  INSERT INTO public.warehouse_stock_movements (
    warehouse_stock_id, organization_id, warehouse_id, movement_type,
    on_hand_before, on_hand_delta, on_hand_after,
    reserved_before, reserved_delta, reserved_after, reason, reason_code,
    reference_type, reference_id, request_fingerprint,
    actor_id, actor_role, actor_name,
    scientific_name_snapshot, batch_number_snapshot,
    correlation_id, causation_id
  ) VALUES (
    v_dest.id, v_dest.organization_id, v_dest.warehouse_id, 'correction',
    v_dest.on_hand_quantity, p_quantity, v_dest.on_hand_quantity + p_quantity,
    v_dest.reserved_quantity, 0, v_dest.reserved_quantity,
    'quarantine_release: ' || v_reason, v_q.quarantine_reason,
    'quarantine_request', p_request_id, v_fp,
    v_actor, v_actor_role, v_actor_name,
    v_dest.scientific_name, v_dest.batch_number,
    v_correlation_id, v_quarantine_movement_id
  );

  RETURN jsonb_build_object('ok', true, 'movement_id', v_quarantine_movement_id, 'destination_warehouse_stock_id', v_dest.id);
END;
$release$;

-- ── G2. phoenix_destroy_quarantine_stock — reason_code=v_q.quarantine_reason ─

CREATE OR REPLACE FUNCTION public.phoenix_destroy_quarantine_stock(
  p_request_id          uuid,
  p_quarantine_stock_id uuid,
  p_quantity            integer,
  p_reason              text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $destroy$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_actor_name text;
  v_q          public.warehouse_quarantine_stock%ROWTYPE;
  v_existing   public.warehouse_quarantine_stock_movements%ROWTYPE;
  v_reason     text := NULLIF(btrim(p_reason), '');
  v_fp         text;
  v_predecessor_id uuid;
  v_correlation_id uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'destroy_reason_required' USING ERRCODE = '23514';
  END IF;

  v_fp := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'quarantine_destroy', 'quarantine_stock_id', p_quarantine_stock_id,
    'quantity', p_quantity, 'reason', v_reason
  )::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 99098));

  SELECT * INTO v_existing
  FROM public.warehouse_quarantine_stock_movements m
  WHERE m.reference_type = 'quarantine_request' AND m.reference_id = p_request_id;
  IF FOUND THEN
    IF v_existing.quarantine_stock_id IS DISTINCT FROM p_quarantine_stock_id
       OR v_existing.request_fingerprint IS DISTINCT FROM v_fp THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('ok', true, 'idempotent_replay', true, 'movement_id', v_existing.id);
  END IF;

  SELECT * INTO v_q FROM public.warehouse_quarantine_stock WHERE id = p_quarantine_stock_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quarantine_stock_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF p_quantity > v_q.quantity THEN
    RAISE EXCEPTION 'destroy_quantity_exceeds_quarantined' USING ERRCODE = '23514';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'warehouse_transfer.return_request', v_q.organization_id, v_q.warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_quarantine_destroy' USING ERRCODE = '42501';
  END IF;

  SELECT p.role, p.full_name INTO v_actor_role, v_actor_name FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';

  SELECT id, correlation_id INTO v_predecessor_id, v_correlation_id
  FROM public.warehouse_quarantine_stock_movements
  WHERE quarantine_stock_id = v_q.id
  ORDER BY created_at DESC
  LIMIT 1;
  v_correlation_id := COALESCE(v_correlation_id, gen_random_uuid());

  UPDATE public.warehouse_quarantine_stock SET quantity = quantity - p_quantity, updated_by = v_actor WHERE id = v_q.id;

  INSERT INTO public.warehouse_quarantine_stock_movements (
    quarantine_stock_id, organization_id, warehouse_id, movement_type,
    quantity_before, quantity_delta, quantity_after, reason, reason_code,
    reference_type, reference_id, request_fingerprint,
    actor_id, actor_role, actor_name,
    scientific_name_snapshot, batch_number_snapshot, internal_batch_reference_snapshot,
    correlation_id, causation_id
  ) VALUES (
    v_q.id, v_q.organization_id, v_q.warehouse_id, 'quarantine_destroy',
    v_q.quantity, -p_quantity, v_q.quantity - p_quantity, v_reason, v_q.quarantine_reason,
    'quarantine_request', p_request_id, v_fp,
    v_actor, v_actor_role, v_actor_name,
    v_q.scientific_name, v_q.batch_number, v_q.internal_batch_reference,
    v_correlation_id, v_predecessor_id
  )
  RETURNING id INTO v_existing;

  RETURN jsonb_build_object('ok', true, 'movement_id', v_existing.id);
END;
$destroy$;

DO $verify$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc p
  WHERE p.proname IN ('phoenix_release_quarantine_stock', 'phoenix_destroy_quarantine_stock')
    AND p.pronamespace = 'public'::regnamespace;
  IF v_count <> 2 THEN
    RAISE EXCEPTION '132 VERIFY FAILED: expected exactly 2 Group G functions, found %', v_count;
  END IF;

  RAISE NOTICE 'MOVEMENT-REASON-CODE-GROUP-G-QUARANTINE-132: verified.';
END;
$verify$;
