-- ============================================================================
-- MOVEMENT-REASON-CODE-GROUP-B-WAREHOUSE-TRANSFER-127
--
-- Eighth slice of Unified Movements & Outlet Operations (PR #57, item A).
-- Second of eight domain slices wiring reason_code + server-owned
-- correlation_id/causation_id into the 20 audited ledger-writer RPCs.
--
-- GROUP B — warehouse transfer send/receive, the first genuinely CHAINED
-- pair in the audit:
--
--   * phoenix_send_warehouse_transfer_line (088) — reason_code hardcoded to
--     'transferred' (routine forward movement, no anomaly, no client
--     choice). correlation_id freshly generated: even when answering an
--     approved warehouse_transfer_request_line, that row is a REQUEST, not
--     a movement -- it has no correlation_id of its own to inherit, so this
--     send genuinely starts a new correlation chain. causation_id stays
--     NULL for the same reason (no preceding movement exists to point at).
--
--   * phoenix_receive_warehouse_transfer_line (088) — reason_code hardcoded
--     to 'received'. Unlike Group A, this function has a REAL preceding
--     movement to chain from: the send-side INSERT into
--     warehouse_stock_movements that created this same shipment. The audit
--     found no existing column linking a warehouse_transfer_lines row back
--     to that send movement's id, so this migration adds one
--     (source_movement_id, nullable, populated by the send function
--     immediately after its own movement INSERT). The receive function
--     already SELECTs...FOR UPDATE the transfer_line row for unrelated
--     reasons (status transition), so reading source_movement_id costs
--     nothing extra -- it becomes causation_id verbatim (a real,
--     organization-scoped, already-locked predecessor row id, never
--     client-supplied) and its correlation_id is looked up and reused
--     directly, so the send and receive events of the SAME shipment share
--     one correlation chain. A transfer_line created before this migration
--     has source_movement_id NULL (nothing to backfill it from -- the send
--     movement's own id was never persisted anywhere else); receiving such
--     a legacy line falls back to a freshly generated correlation_id and a
--     NULL causation_id, which is honest: no predecessor can be proven for
--     it, so instruction #6's "only from a PROVEN preceding event" rule is
--     upheld rather than guessed at.
--
-- The rejected-line branch (p_received_quantity = 0) writes NO movement row
-- at all today and is unchanged here -- there is nothing to tag.
--
-- PRECONDITIONS: 126 applied (Group A slice; reason_code/correlation_id/
--   causation_id columns live since 124/125).
-- ============================================================================

DO $precond$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname = 'phoenix_apply_warehouse_stock_movement'
       AND p.pronamespace = 'public'::regnamespace
       AND pg_get_function_arguments(p.oid) LIKE '%p_reason_code%'
  ) THEN
    RAISE EXCEPTION '127 PRECONDITION FAILED: 126 (Group A slice) missing — apply 126 first';
  END IF;
END;
$precond$;

-- ── Schema: a real, provable link from a transfer line to its send movement ──

ALTER TABLE public.warehouse_transfer_lines
  ADD COLUMN IF NOT EXISTS source_movement_id uuid
    REFERENCES public.warehouse_stock_movements(id) ON DELETE SET NULL;

-- ── B1. phoenix_send_warehouse_transfer_line — reason_code='transferred' ────

CREATE OR REPLACE FUNCTION public.phoenix_send_warehouse_transfer_line(
  p_request_id             uuid,
  p_route_id               uuid,
  p_warehouse_stock_id     uuid,
  p_quantity               integer,
  p_transfer_number        text,
  p_transfer_request_line_id uuid DEFAULT NULL,
  p_document_number        text DEFAULT NULL,
  p_notes                  text DEFAULT NULL
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
  v_route        public.warehouse_supply_routes%ROWTYPE;
  v_stock        public.warehouse_stock%ROWTYPE;
  v_dest_org     uuid;
  v_transfer     public.warehouse_transfers%ROWTYPE;
  v_existing     public.warehouse_stock_movements%ROWTYPE;
  v_reqline      public.warehouse_transfer_request_lines%ROWTYPE;
  v_number       text := NULLIF(btrim(p_transfer_number), '');
  v_doc          text := NULLIF(btrim(p_document_number), '');
  v_notes        text := NULLIF(btrim(p_notes), '');
  v_before       integer;
  v_after        integer;
  v_line_id      uuid;
  v_movement_id  uuid;
  v_fingerprint  text;
  v_correlation_id uuid := gen_random_uuid();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_route_id IS NULL OR p_warehouse_stock_id IS NULL THEN
    RAISE EXCEPTION 'route_and_stock_required' USING ERRCODE = '23514';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;
  IF v_number IS NULL THEN
    RAISE EXCEPTION 'transfer_number_required' USING ERRCODE = '23514';
  END IF;

  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'transfer_send',
    'route_id', p_route_id,
    'warehouse_stock_id', p_warehouse_stock_id,
    'quantity', p_quantity,
    'transfer_number', v_number,
    'transfer_request_line_id', p_transfer_request_line_id,
    'document_number', v_doc,
    'notes', v_notes
  )::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 68068));

  SELECT * INTO v_existing
  FROM public.warehouse_stock_movements m
  WHERE m.reference_type = 'warehouse_transfer_send' AND m.reference_id = p_request_id;

  IF FOUND THEN
    IF v_existing.warehouse_stock_id IS DISTINCT FROM p_warehouse_stock_id
       OR v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true,
      'warehouse_stock_id', v_existing.warehouse_stock_id,
      'movement_id', v_existing.id,
      'quantity_before', v_existing.on_hand_before,
      'quantity_delta', v_existing.on_hand_delta,
      'quantity_after', v_existing.on_hand_after
    );
  END IF;

  SELECT * INTO v_route
  FROM public.warehouse_supply_routes WHERE id = p_route_id FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'supply_route_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT v_route.is_active THEN
    RAISE EXCEPTION 'supply_route_inactive' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_stock
  FROM public.warehouse_stock WHERE id = p_warehouse_stock_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse_stock_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_stock.warehouse_id IS DISTINCT FROM v_route.source_warehouse_id THEN
    RAISE EXCEPTION 'stock_not_in_route_source_warehouse' USING ERRCODE = '42501';
  END IF;

  SELECT organization_id INTO v_dest_org
  FROM public.warehouses
  WHERE id = v_route.target_warehouse_id AND status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'destination_warehouse_not_found_or_inactive' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'warehouse_transfer.send', v_stock.organization_id,
    v_stock.warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_warehouse_transfer_send' USING ERRCODE = '42501';
  END IF;

  SELECT p.role, p.full_name INTO v_actor_role, v_actor_name
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  IF v_stock.expiry_date IS NOT NULL AND v_stock.expiry_date < current_date THEN
    RAISE EXCEPTION 'expired_batch_cannot_be_sent' USING ERRCODE = '23514';
  END IF;

  v_before := v_stock.on_hand_quantity;
  v_after  := v_before - p_quantity;

  IF v_after < 0 THEN
    RAISE EXCEPTION 'warehouse_quantity_cannot_go_negative' USING ERRCODE = '23514';
  END IF;
  IF v_after < v_stock.reserved_quantity THEN
    RAISE EXCEPTION 'warehouse_quantity_below_reserved' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_transfer
  FROM public.warehouse_transfers
  WHERE source_organization_id = v_stock.organization_id
    AND btrim(transfer_number) = v_number
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.warehouse_transfers (
      route_id, transfer_request_id,
      source_warehouse_id, source_organization_id,
      destination_warehouse_id, destination_organization_id,
      transfer_number, status, document_number, notes, sent_by, sent_at
    ) VALUES (
      p_route_id, NULL,
      v_route.source_warehouse_id, v_stock.organization_id,
      v_route.target_warehouse_id, v_dest_org,
      v_number, 'in_transit', v_doc, v_notes, v_actor, now()
    )
    RETURNING * INTO v_transfer;
  ELSE
    IF v_transfer.route_id IS DISTINCT FROM p_route_id THEN
      RAISE EXCEPTION 'transfer_number_route_conflict' USING ERRCODE = '23505';
    END IF;
    IF v_transfer.status <> 'in_transit' THEN
      RAISE EXCEPTION 'transfer_already_being_received' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF p_transfer_request_line_id IS NOT NULL THEN
    SELECT l.* INTO v_reqline
    FROM public.warehouse_transfer_request_lines l
    JOIN public.warehouse_transfer_requests r ON r.id = l.transfer_request_id
    WHERE l.id = p_transfer_request_line_id AND r.route_id = p_route_id
    FOR UPDATE OF l;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'request_line_not_found_for_route' USING ERRCODE = 'P0002';
    END IF;
    IF v_reqline.status NOT IN ('approved', 'partially_fulfilled') THEN
      RAISE EXCEPTION 'request_line_not_approved' USING ERRCODE = '23514';
    END IF;
    IF v_reqline.fulfilled_quantity + p_quantity > v_reqline.approved_quantity THEN
      RAISE EXCEPTION 'request_line_would_be_over_fulfilled' USING ERRCODE = '23514';
    END IF;

    UPDATE public.warehouse_transfer_request_lines
       SET fulfilled_quantity = fulfilled_quantity + p_quantity,
           status = CASE WHEN fulfilled_quantity + p_quantity >= approved_quantity
                         THEN 'fulfilled' ELSE 'partially_fulfilled' END
     WHERE id = v_reqline.id;

    UPDATE public.warehouse_transfer_requests
       SET status = CASE WHEN NOT EXISTS (
                           SELECT 1 FROM public.warehouse_transfer_request_lines x
                           WHERE x.transfer_request_id = v_reqline.transfer_request_id
                             AND x.status NOT IN ('fulfilled', 'rejected', 'cancelled'))
                         THEN 'fulfilled' ELSE 'partially_fulfilled' END
     WHERE id = v_reqline.transfer_request_id;

    UPDATE public.warehouse_transfers
       SET transfer_request_id = COALESCE(transfer_request_id, v_reqline.transfer_request_id)
     WHERE id = v_transfer.id;
  END IF;

  UPDATE public.warehouse_stock
     SET on_hand_quantity = v_after,
         updated_by       = v_actor
   WHERE id = v_stock.id;

  INSERT INTO public.warehouse_transfer_lines (
    transfer_id, source_organization_id, source_warehouse_stock_id,
    transfer_request_line_id, central_item_id,
    scientific_name, trade_name, concentration, dosage_form, unit,
    national_code, has_no_national_code,
    batch_number, has_no_batch_number, internal_batch_reference,
    expiry_date, unit_price, price_basis, currency, supply_type_text,
    supply_type, purchase_origin,
    sent_quantity, status
  ) VALUES (
    v_transfer.id, v_stock.organization_id, v_stock.id,
    p_transfer_request_line_id, v_stock.central_item_id,
    v_stock.scientific_name, v_stock.trade_name, v_stock.concentration,
    v_stock.dosage_form, v_stock.unit,
    v_stock.national_code, v_stock.has_no_national_code,
    v_stock.batch_number, v_stock.has_no_batch_number, v_stock.internal_batch_reference,
    v_stock.expiry_date, v_stock.unit_price, v_stock.price_basis,
    v_stock.currency, v_stock.supply_type_text,
    v_stock.supply_type, v_stock.purchase_origin,
    p_quantity, 'in_transit'
  )
  RETURNING id INTO v_line_id;

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
    v_before, -p_quantity, v_after,
    v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
    'warehouse_transfer_send', 'transferred', 'warehouse_transfer_send', p_request_id, v_fingerprint,
    v_doc, v_actor, v_actor_role, v_actor_name,
    v_stock.scientific_name, v_stock.concentration,
    v_stock.dosage_form, v_stock.batch_number,
    v_stock.internal_batch_reference,
    v_correlation_id
  )
  RETURNING id INTO v_movement_id;

  -- 127: persist the send movement's own id on the line so the receive side
  -- can chain correlation_id/causation_id from a real, proven predecessor.
  UPDATE public.warehouse_transfer_lines
     SET source_movement_id = v_movement_id
   WHERE id = v_line_id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role,
    action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_stock.organization_id, v_actor, v_actor_role,
    'warehouse_transfer.send', 'warehouse_transfer_lines', v_line_id,
    v_stock.scientific_name,
    jsonb_build_object(
      'request_id', p_request_id,
      'route_id', p_route_id,
      'transfer_id', v_transfer.id,
      'source_warehouse_id', v_route.source_warehouse_id,
      'destination_warehouse_id', v_route.target_warehouse_id,
      'movement_id', v_movement_id,
      'quantity_before', v_before,
      'quantity_delta', -p_quantity,
      'quantity_after', v_after
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'transfer_id', v_transfer.id,
    'transfer_line_id', v_line_id,
    'warehouse_stock_id', v_stock.id,
    'movement_id', v_movement_id,
    'in_transit_quantity', p_quantity,
    'quantity_before', v_before,
    'quantity_delta', -p_quantity,
    'quantity_after', v_after
  );
END;
$$;

-- ── B2. phoenix_receive_warehouse_transfer_line — chains from source_movement_id ─

CREATE OR REPLACE FUNCTION public.phoenix_receive_warehouse_transfer_line(
  p_request_id        uuid,
  p_transfer_line_id  uuid,
  p_received_quantity integer,
  p_difference_reason text DEFAULT NULL,
  p_notes             text DEFAULT NULL
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
  v_line        public.warehouse_transfer_lines%ROWTYPE;
  v_transfer    public.warehouse_transfers%ROWTYPE;
  v_stock       public.warehouse_stock%ROWTYPE;
  v_existing    public.warehouse_stock_movements%ROWTYPE;
  v_reason      text := NULLIF(btrim(p_difference_reason), '');
  v_notes       text := NULLIF(btrim(p_notes), '');
  v_internal    text;
  v_before      integer;
  v_after       integer;
  v_movement_id uuid;
  v_status      text;
  v_fingerprint text;
  v_correlation_id uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL OR p_transfer_line_id IS NULL THEN
    RAISE EXCEPTION 'request_id_and_line_required' USING ERRCODE = '23514';
  END IF;
  IF p_received_quantity IS NULL OR p_received_quantity < 0 THEN
    RAISE EXCEPTION 'received_quantity_must_be_non_negative' USING ERRCODE = '23514';
  END IF;

  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'transfer_receive',
    'transfer_line_id', p_transfer_line_id,
    'received_quantity', p_received_quantity,
    'difference_reason', v_reason,
    'notes', v_notes
  )::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 68068));

  SELECT * INTO v_existing
  FROM public.warehouse_stock_movements m
  WHERE m.reference_type = 'warehouse_transfer_receive' AND m.reference_id = p_request_id;

  IF FOUND THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true,
      'warehouse_stock_id', v_existing.warehouse_stock_id,
      'movement_id', v_existing.id,
      'quantity_before', v_existing.on_hand_before,
      'quantity_delta', v_existing.on_hand_delta,
      'quantity_after', v_existing.on_hand_after
    );
  END IF;

  SELECT * INTO v_line
  FROM public.warehouse_transfer_lines WHERE id = p_transfer_line_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'transfer_line_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_line.status <> 'in_transit' THEN
    RAISE EXCEPTION 'transfer_line_already_received' USING ERRCODE = '23505';
  END IF;
  IF p_received_quantity > v_line.sent_quantity THEN
    RAISE EXCEPTION 'received_quantity_exceeds_sent' USING ERRCODE = '23514';
  END IF;
  IF p_received_quantity <> v_line.sent_quantity AND v_reason IS NULL THEN
    RAISE EXCEPTION 'difference_reason_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_transfer
  FROM public.warehouse_transfers WHERE id = v_line.transfer_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'transfer_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'warehouse_transfer.receive', v_transfer.destination_organization_id,
    v_transfer.destination_warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_warehouse_transfer_receive' USING ERRCODE = '42501';
  END IF;

  SELECT p.role, p.full_name INTO v_actor_role, v_actor_name
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  IF v_line.expiry_date IS NOT NULL AND v_line.expiry_date < current_date THEN
    RAISE EXCEPTION 'expired_batch_cannot_be_received' USING ERRCODE = '23514';
  END IF;

  v_status := CASE
    WHEN p_received_quantity = 0 THEN 'rejected'
    WHEN p_received_quantity = v_line.sent_quantity THEN 'received'
    ELSE 'received_with_difference'
  END;

  IF p_received_quantity = 0 THEN
    UPDATE public.warehouse_transfer_lines
       SET status = 'rejected', received_quantity = 0,
           difference_reason = v_reason, received_by = v_actor, received_at = now()
     WHERE id = v_line.id;

    UPDATE public.warehouse_transfers
       SET status = CASE WHEN NOT EXISTS (
                           SELECT 1 FROM public.warehouse_transfer_lines x
                           WHERE x.transfer_id = v_transfer.id AND x.status = 'in_transit')
                         THEN 'received' ELSE 'partially_received' END
     WHERE id = v_transfer.id;

    INSERT INTO public.audit_logs (
      organization_id, actor_id, actor_role,
      action, entity_type, entity_id, entity_label, payload
    ) VALUES (
      v_transfer.destination_organization_id, v_actor, v_actor_role,
      'warehouse_transfer.rejected', 'warehouse_transfer_lines', v_line.id,
      v_line.scientific_name,
      jsonb_build_object(
        'request_id', p_request_id, 'transfer_id', v_transfer.id,
        'sent_quantity', v_line.sent_quantity, 'received_quantity', 0,
        'reason', v_reason
      )
    );

    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', false, 'line_status', 'rejected',
      'warehouse_stock_id', NULL, 'movement_id', NULL,
      'quantity_before', 0, 'quantity_delta', 0, 'quantity_after', 0
    );
  END IF;

  v_internal := v_line.internal_batch_reference;

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
    v_transfer.destination_organization_id, v_transfer.destination_warehouse_id,
    v_line.central_item_id,
    v_line.scientific_name, v_line.trade_name, v_line.concentration,
    v_line.dosage_form, v_line.unit,
    v_line.national_code, v_line.has_no_national_code,
    v_line.batch_number, v_line.has_no_batch_number, v_internal,
    v_line.expiry_date, 0, 0,
    v_line.unit_price, v_line.price_basis, v_line.currency, v_line.supply_type_text,
    v_line.supply_type, v_line.purchase_origin,
    v_transfer.document_number, v_notes, v_actor, v_actor
  )
  ON CONFLICT DO NOTHING;

  SELECT * INTO v_stock
  FROM public.warehouse_stock s
  WHERE s.warehouse_id = v_transfer.destination_warehouse_id
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

  UPDATE public.warehouse_transfer_lines
     SET status = v_status,
         received_quantity = p_received_quantity,
         difference_reason = v_reason,
         received_by = v_actor,
         received_at = now(),
         resulting_warehouse_stock_id = v_stock.id
   WHERE id = v_line.id;

  UPDATE public.warehouse_transfers
     SET status = CASE WHEN NOT EXISTS (
                         SELECT 1 FROM public.warehouse_transfer_lines x
                         WHERE x.transfer_id = v_transfer.id AND x.status = 'in_transit')
                       THEN 'received' ELSE 'partially_received' END
   WHERE id = v_transfer.id;

  -- 127: chain correlation_id from the send movement when a real predecessor
  -- is known (source_movement_id, populated since this migration); a legacy
  -- transfer_line predating 127 has it NULL, so a fresh chain starts here
  -- instead of a guessed one.
  IF v_line.source_movement_id IS NOT NULL THEN
    SELECT correlation_id INTO v_correlation_id
    FROM public.warehouse_stock_movements
    WHERE id = v_line.source_movement_id;
  END IF;
  v_correlation_id := COALESCE(v_correlation_id, gen_random_uuid());

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
    'warehouse_transfer_receive', 'received', 'warehouse_transfer_receive', p_request_id, v_fingerprint,
    v_transfer.document_number, v_actor, v_actor_role, v_actor_name,
    v_stock.scientific_name, v_stock.concentration,
    v_stock.dosage_form, v_stock.batch_number,
    v_stock.internal_batch_reference,
    v_correlation_id, v_line.source_movement_id
  )
  RETURNING id INTO v_movement_id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role,
    action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_transfer.destination_organization_id, v_actor, v_actor_role,
    'warehouse_transfer.receive', 'warehouse_stock', v_stock.id,
    v_stock.scientific_name,
    jsonb_build_object(
      'request_id', p_request_id,
      'transfer_id', v_transfer.id,
      'transfer_line_id', v_line.id,
      'movement_id', v_movement_id,
      'line_status', v_status,
      'sent_quantity', v_line.sent_quantity,
      'quantity_before', v_before,
      'quantity_delta', p_received_quantity,
      'quantity_after', v_after,
      'reason', v_reason
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'line_status', v_status,
    'transfer_id', v_transfer.id,
    'warehouse_stock_id', v_stock.id,
    'movement_id', v_movement_id,
    'quantity_before', v_before,
    'quantity_delta', p_received_quantity,
    'quantity_after', v_after
  );
END;
$$;

DO $verify$
DECLARE
  v_count integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'warehouse_transfer_lines'
       AND column_name = 'source_movement_id'
  ) THEN
    RAISE EXCEPTION '127 VERIFY FAILED: warehouse_transfer_lines.source_movement_id missing';
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_proc p
  WHERE p.proname IN ('phoenix_send_warehouse_transfer_line', 'phoenix_receive_warehouse_transfer_line')
    AND p.pronamespace = 'public'::regnamespace;
  IF v_count <> 2 THEN
    RAISE EXCEPTION '127 VERIFY FAILED: expected exactly 2 Group B functions, found %', v_count;
  END IF;

  RAISE NOTICE 'MOVEMENT-REASON-CODE-GROUP-B-WAREHOUSE-TRANSFER-127: verified.';
END;
$verify$;
