-- ============================================================================
-- 185 - PHOENIX RETURN / QUARANTINE / RECALL PARITY (R1.5)
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
--
-- NOT APPLIED BY THIS PR. Authored and replayed on a disposable PostgreSQL rig
-- only. Migrations 001-184 are immutable and are NOT edited here. There is
-- deliberately no 186.
--
-- WHAT WAS OPEN BEFORE THIS MIGRATION
-- ---------------------------------------------------------------------------
-- R1.5-A  EXACT LOT IDENTITY.
--   150 made material identity canonical: warehouse_stock, outlet_stock and
--   warehouse_quarantine_stock each carry a GENERATED material_identity_key
--   over (central_item_id, scientific_name, national_code, concentration,
--   dosage_form, unit), and the identity indexes were rebuilt on it:
--
--     warehouse_stock_identity_uniq
--       (warehouse_id, material_identity_key, batch_number, expiry_date,
--        internal_batch_reference, supply_type, purchase_origin)
--     wqs_identity_uniq
--       ... the same tuple + quarantine_reason
--
--   Four functions still resolved their destination row with a RAW SUBSET of
--   that identity. Every one of them performs
--
--     INSERT ... ON CONFLICT DO NOTHING;   -- conflict target = the unique index
--     SELECT ... FOR UPDATE;               -- ...then re-finds the row
--
--   and the SELECT did not resolve the identity the INSERT's conflict target
--   represents. Concretely, before this migration:
--
--     receive warehouse return   (128)  omitted unit, central_item_id
--     receive outlet return      (135)  omitted unit, central_item_id
--     resolve return exception   (162)  omitted unit, central_item_id
--       ...and all three ALSO omitted supply_type and purchase_origin on their
--       QUARANTINE branch, making it strictly weaker than both its own unique
--       index (which has carried them since 088) and their own restockable
--       branch.
--     release quarantine         (132)  compared scientific_name + batch +
--       expiry ONLY, so quarantined stock could be released into a merely
--       NAME-matching warehouse_stock row that differed in unit, central item
--       identity, national code, concentration, dosage form, internal batch
--       reference, supply type or purchase origin.
--
--   Two legitimately distinct lots differing only in, say, unit therefore both
--   matched the predicate, and `SELECT ... INTO` credited an arbitrary one.
--   Those lots are constructible precisely because the unique index separates
--   them on material_identity_key.
--
-- HOW THIS MIGRATION IS SHAPED
-- ---------------------------------------------------------------------------
-- The four bodies are reproduced from their current defining migrations with
-- ONE edit each: the destination-identity predicate. Nothing else in them is
-- touched, no public signature changes, and the identity is compared against
-- the GENERATED column rather than re-derived by a second hand-written
-- algorithm - so a lookup and its unique index cannot drift apart again.
--
-- 149 renamed 135's function to _phoenix_149_delegate_receive_outlet_return_
-- shipment_line and put a thin public wrapper in front of it. The DELEGATE is
-- what is forward-replaced here; the public wrapper is untouched.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 0. PREFLIGHT - fail closed before touching anything
-- ============================================================================
DO $preflight$
DECLARE
  v_sigs text[] := ARRAY[
    'public.phoenix_receive_warehouse_return_shipment_line(uuid,uuid,integer,text,text,text)',
    'public._phoenix_149_delegate_receive_outlet_return_shipment_line(uuid,uuid,integer,text,text,text)',
    'public.phoenix_resolve_outlet_return_exception(uuid,uuid,text,text,integer,text)',
    'public.phoenix_release_quarantine_stock(uuid,uuid,integer,text,uuid)',
    'public._phoenix_material_identity_v1(uuid,text,text,text,text,text)'
  ];
  v_sig text;
  v_cols text[];
BEGIN
  -- 184 must be the ceiling this migration is stacked on.
  IF to_regprocedure('public._phoenix_assert_external_corridor_institution_root_v1(uuid,text)') IS NULL THEN
    RAISE EXCEPTION '185_precondition_failed: 184 canonical supply-cycle capsule is absent - apply 184 first';
  END IF;

  FOREACH v_sig IN ARRAY v_sigs LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION '185_precondition_failed: % is absent', v_sig;
    END IF;
  END LOOP;

  -- material_identity_key must exist AND still be GENERATED on all three stock
  -- tables. A plain column could be written by a caller, which would turn the
  -- canonical identity into a caller-supplied claim.
  FOREACH v_sig IN ARRAY ARRAY['warehouse_stock','outlet_stock','warehouse_quarantine_stock'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = v_sig
        AND column_name = 'material_identity_key'
        AND is_generated = 'ALWAYS'
    ) THEN
      RAISE EXCEPTION
        '185_precondition_failed: %.material_identity_key is absent or no longer GENERATED', v_sig;
    END IF;
  END LOOP;

  -- The two identity indexes this migration's lookups mirror must still have
  -- the expected shape. Derived from the live index definition rather than
  -- string-matched against a pretty-printed form.
  SELECT array_agg(a ORDER BY a) INTO v_cols
  FROM (
    SELECT unnest(ARRAY['material_identity_key','warehouse_id','batch_number',
                        'expiry_date','internal_batch_reference','supply_type',
                        'purchase_origin']) AS a
  ) t
  WHERE pg_get_indexdef('public.warehouse_stock_identity_uniq'::regclass) LIKE '%' || t.a || '%';
  IF array_length(COALESCE(v_cols, ARRAY[]::text[]), 1) IS DISTINCT FROM 7 THEN
    RAISE EXCEPTION
      '185_precondition_failed: warehouse_stock_identity_uniq no longer carries the canonical identity tuple; found %',
      COALESCE(v_cols, ARRAY[]::text[]);
  END IF;

  IF pg_get_indexdef('public.wqs_identity_uniq'::regclass) NOT LIKE '%material_identity_key%'
     OR pg_get_indexdef('public.wqs_identity_uniq'::regclass) NOT LIKE '%quarantine_reason%'
     OR pg_get_indexdef('public.wqs_identity_uniq'::regclass) NOT LIKE '%supply_type%'
     OR pg_get_indexdef('public.wqs_identity_uniq'::regclass) NOT LIKE '%purchase_origin%' THEN
    RAISE EXCEPTION
      '185_precondition_failed: wqs_identity_uniq no longer carries the canonical identity tuple + quarantine_reason';
  END IF;

  RAISE NOTICE '185 preflight: canonical identity present, four target functions present, 184 ceiling confirmed';
END;
$preflight$;

-- ============================================================================
-- A. EXACT DESTINATION IDENTITY - forward-replace the four resolvers
-- ============================================================================
-- ---------------------------------------------------------------------------
-- phoenix_receive_warehouse_return_shipment_line (128 body)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phoenix_receive_warehouse_return_shipment_line(
  p_request_id             uuid,
  p_shipment_line_id       uuid,
  p_received_quantity      integer,
  p_difference_reason      text DEFAULT NULL,
  p_notes                  text DEFAULT NULL,
  p_disposition_decision   text DEFAULT NULL
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
  v_line         public.warehouse_return_shipment_lines%ROWTYPE;
  v_shipment     public.warehouse_return_shipments%ROWTYPE;
  v_orig         public.warehouse_transfer_lines%ROWTYPE;
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
    'operation', 'return_receive',
    'shipment_line_id', p_shipment_line_id,
    'received_quantity', p_received_quantity,
    'difference_reason', v_reason,
    'notes', v_notes,
    'disposition_decision', p_disposition_decision
  )::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 69069));

  SELECT * INTO v_existing
  FROM public.warehouse_stock_movements m
  WHERE m.reference_type = 'warehouse_return_receive' AND m.reference_id = p_request_id;

  IF FOUND THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true, 'disposition', 'restockable',
      'warehouse_stock_id', v_existing.warehouse_stock_id,
      'movement_id', v_existing.id,
      'quantity_before', v_existing.on_hand_before,
      'quantity_delta', v_existing.on_hand_delta,
      'quantity_after', v_existing.on_hand_after
    );
  END IF;

  SELECT * INTO v_existing_q
  FROM public.warehouse_quarantine_stock_movements m
  WHERE m.reference_type = 'warehouse_return_quarantine_receive' AND m.reference_id = p_request_id;

  IF FOUND THEN
    IF v_existing_q.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true, 'disposition', 'quarantined',
      'quarantine_stock_id', v_existing_q.quarantine_stock_id,
      'movement_id', v_existing_q.id,
      'quantity_before', v_existing_q.quantity_before,
      'quantity_delta', v_existing_q.quantity_delta,
      'quantity_after', v_existing_q.quantity_after
    );
  END IF;

  SELECT * INTO v_line
  FROM public.warehouse_return_shipment_lines WHERE id = p_shipment_line_id FOR UPDATE;
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
  FROM public.warehouse_return_shipments WHERE id = v_line.shipment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_shipment_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'warehouse_transfer.return_receive', v_shipment.destination_organization_id,
    v_shipment.destination_warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_warehouse_return_receive' USING ERRCODE = '42501';
  END IF;

  SELECT p.role, p.full_name INTO v_actor_role, v_actor_name
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_orig
  FROM public.warehouse_transfer_lines WHERE id = v_line.original_transfer_line_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'original_transfer_line_not_found' USING ERRCODE = 'P0002';
  END IF;

  v_status := CASE
    WHEN p_received_quantity = 0 THEN 'rejected'
    WHEN p_received_quantity = v_line.sent_quantity THEN 'received'
    ELSE 'received_with_difference'
  END;

  v_reason_code := (
    SELECT rl.reason_code FROM public.warehouse_return_request_lines rl
    WHERE rl.id = v_line.return_request_line_id
  );

  -- 128: chain correlation_id/causation_id from the send movement when a
  -- real predecessor is known, on BOTH disposition branches (the send event
  -- is the same regardless of where the receive side lands it).
  IF v_line.source_movement_id IS NOT NULL THEN
    SELECT correlation_id INTO v_correlation_id
    FROM public.warehouse_stock_movements
    WHERE id = v_line.source_movement_id;
  END IF;
  v_correlation_id := COALESCE(v_correlation_id, gen_random_uuid());

  IF p_received_quantity = 0 THEN
    UPDATE public.warehouse_return_shipment_lines
       SET status = 'rejected', received_quantity = 0,
           difference_reason = v_reason, received_by = v_actor, received_at = now(),
           disposition = NULL, custody_state = 'exception_pending'
     WHERE id = v_line.id;

    UPDATE public.warehouse_return_shipments
       SET status = CASE WHEN NOT EXISTS (
                           SELECT 1 FROM public.warehouse_return_shipment_lines x
                           WHERE x.shipment_id = v_shipment.id AND x.status = 'in_transit')
                         THEN 'received' ELSE 'partially_received' END
     WHERE id = v_shipment.id;

    INSERT INTO public.audit_logs (
      organization_id, actor_id, actor_role,
      action, entity_type, entity_id, entity_label, payload
    ) VALUES (
      v_shipment.destination_organization_id, v_actor, v_actor_role,
      'warehouse_transfer.return_rejected', 'warehouse_return_shipment_lines', v_line.id,
      v_line.scientific_name,
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
      v_shipment.document_number, v_notes, v_actor, v_actor
    )
    ON CONFLICT DO NOTHING;

    SELECT * INTO v_stock
    FROM public.warehouse_stock s
    WHERE s.warehouse_id = v_shipment.destination_warehouse_id
      -- R1.5-A: the CANONICAL material identity, not a raw subset. The former
      -- predicate omitted unit and central_item_id, so two legitimately
      -- distinct lots differing only in those components both matched and
      -- SELECT INTO credited an arbitrary one. Compared against the GENERATED
      -- column so the lookup and warehouse_stock_identity_uniq cannot diverge.
      AND s.material_identity_key = public._phoenix_material_identity_v1(
            v_line.central_item_id, v_line.scientific_name, v_line.national_code,
            v_line.concentration, v_line.dosage_form, v_line.unit)
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

    UPDATE public.warehouse_return_shipment_lines
       SET status = v_status,
           received_quantity = p_received_quantity,
           difference_reason = v_reason,
           received_by = v_actor,
           received_at = now(),
           disposition = 'restockable',
           custody_state = 'destination_stock',
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
      'warehouse_transfer_return', v_reason_code, 'warehouse_return_receive', p_request_id, v_fingerprint,
      v_shipment.document_number, v_actor, v_actor_role, v_actor_name,
      v_stock.scientific_name, v_stock.concentration,
      v_stock.dosage_form, v_stock.batch_number,
      v_stock.internal_batch_reference,
      v_correlation_id, v_line.source_movement_id
    )
    RETURNING id INTO v_movement_id;
  ELSE
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
      -- R1.5-A: canonical identity, exactly as the restockable branch.
      AND q.material_identity_key = public._phoenix_material_identity_v1(
            v_line.central_item_id, v_line.scientific_name, v_line.national_code,
            v_line.concentration, v_line.dosage_form, v_line.unit)
      AND COALESCE(q.batch_number, '')  = COALESCE(v_line.batch_number, '')
      AND COALESCE(q.expiry_date, DATE '0001-01-01')
          = COALESCE(v_line.expiry_date, DATE '0001-01-01')
      AND COALESCE(q.internal_batch_reference, '') = COALESCE(v_internal, '')
      -- R1.5-A: the INSERT above has always supplied these two, and
      -- wqs_identity_uniq has carried them since 088 - only this lookup
      -- omitted them, so the SELECT could not resolve the row the INSERT
      -- conflict target represents.
      AND COALESCE(q.supply_type, '') = COALESCE(v_line.supply_type, '')
      AND COALESCE(q.purchase_origin, '') = COALESCE(v_line.purchase_origin, '')
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

    UPDATE public.warehouse_return_shipment_lines
       SET status = v_status,
           received_quantity = p_received_quantity,
           difference_reason = v_reason,
           received_by = v_actor,
           received_at = now(),
           disposition = 'quarantined',
           custody_state = 'destination_quarantine',
           resulting_quarantine_stock_id = v_quarantine.id
     WHERE id = v_line.id;

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
      'warehouse_transfer_return',
      CASE
        WHEN v_objectively_expired AND v_reason_code IS DISTINCT FROM 'expired' THEN 'expired'
        WHEN v_reason_code IN ('expired', 'damaged', 'recalled', 'quality_issue', 'temperature_excursion', 'other')
          THEN v_reason_code
        ELSE 'other'
      END,
      'warehouse_return_quarantine_receive', p_request_id, v_fingerprint,
      v_shipment.document_number, v_actor, v_actor_role, v_actor_name,
      v_quarantine.scientific_name, v_quarantine.concentration,
      v_quarantine.dosage_form, v_quarantine.batch_number,
      v_quarantine.internal_batch_reference,
      v_correlation_id, v_line.source_movement_id
    )
    RETURNING id INTO v_movement_id;
  END IF;

  UPDATE public.warehouse_return_shipments
     SET status = CASE WHEN NOT EXISTS (
                         SELECT 1 FROM public.warehouse_return_shipment_lines x
                         WHERE x.shipment_id = v_shipment.id AND x.status = 'in_transit')
                       THEN 'received' ELSE 'partially_received' END
   WHERE id = v_shipment.id;

  UPDATE public.warehouse_transfer_lines
     SET return_received_quantity = return_received_quantity + p_received_quantity
   WHERE id = v_orig.id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role,
    action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_shipment.destination_organization_id, v_actor, v_actor_role,
    'warehouse_transfer.return_receive',
    CASE WHEN v_disposition = 'restockable' THEN 'warehouse_stock' ELSE 'warehouse_quarantine_stock' END,
    COALESCE(v_stock.id, v_quarantine.id),
    v_line.scientific_name,
    jsonb_build_object(
      'request_id', p_request_id,
      'shipment_id', v_shipment.id,
      'shipment_line_id', v_line.id,
      'movement_id', v_movement_id,
      'line_status', v_status,
      'reason_code', v_reason_code,
      'disposition', v_disposition,
      'disposition_decision', p_disposition_decision,
      'custody_state', v_custody,
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
    'disposition', v_disposition,
    'custody_state', v_custody,
    'shipment_id', v_shipment.id,
    'warehouse_stock_id', v_stock.id,
    'quarantine_stock_id', v_quarantine.id,
    'movement_id', v_movement_id,
    'quantity_before', v_before,
    'quantity_delta', p_received_quantity,
    'quantity_after', v_after
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- _phoenix_149_delegate_receive_outlet_return_shipment_line (135 body)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._phoenix_149_delegate_receive_outlet_return_shipment_line(
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
      -- R1.5-A: the CANONICAL material identity, not a raw subset. The former
      -- predicate omitted unit and central_item_id, so two legitimately
      -- distinct lots differing only in those components both matched and
      -- SELECT INTO credited an arbitrary one. Compared against the GENERATED
      -- column so the lookup and warehouse_stock_identity_uniq cannot diverge.
      AND s.material_identity_key = public._phoenix_material_identity_v1(
            v_line.central_item_id, v_line.scientific_name, v_line.national_code,
            v_line.concentration, v_line.dosage_form, v_line.unit)
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
      -- R1.5-A: canonical identity, exactly as the restockable branch.
      AND q.material_identity_key = public._phoenix_material_identity_v1(
            v_line.central_item_id, v_line.scientific_name, v_line.national_code,
            v_line.concentration, v_line.dosage_form, v_line.unit)
      AND COALESCE(q.batch_number, '')  = COALESCE(v_line.batch_number, '')
      AND COALESCE(q.expiry_date, DATE '0001-01-01')
          = COALESCE(v_line.expiry_date, DATE '0001-01-01')
      AND COALESCE(q.internal_batch_reference, '') = COALESCE(v_internal, '')
      -- R1.5-A: the INSERT above has always supplied these two, and
      -- wqs_identity_uniq has carried them since 088 - only this lookup
      -- omitted them, so the SELECT could not resolve the row the INSERT
      -- conflict target represents.
      AND COALESCE(q.supply_type, '') = COALESCE(v_line.supply_type, '')
      AND COALESCE(q.purchase_origin, '') = COALESCE(v_line.purchase_origin, '')
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

-- ---------------------------------------------------------------------------
-- phoenix_resolve_outlet_return_exception (162 body)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phoenix_resolve_outlet_return_exception(
  p_request_id                uuid,
  p_return_shipment_line_id     uuid,
  p_resolution_kind               text,
  p_reason                          text,
  p_corrected_quantity                integer DEFAULT NULL,
  p_disposition_decision                text    DEFAULT NULL
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
  v_reason       text := NULLIF(btrim(p_reason), '');
  v_reason_code  text;
  v_objectively_expired boolean;
  v_internal     text;
  v_fp           text;
  v_existing     public.phoenix_outlet_return_exception_resolutions%ROWTYPE;
  v_already      uuid;
  v_stock        public.warehouse_stock%ROWTYPE;
  v_quarantine   public.warehouse_quarantine_stock%ROWTYPE;
  -- R1.5-B: the canonical provenance row whose return ledger this resolution
  -- credits. LOCKED, not merely read - see the cap block below.
  v_orig_dispatch public.warehouse_dispatch_lines%ROWTYPE;
  v_before       integer;
  v_after        integer;
  v_wh_movement_id uuid;
  v_q_movement_id  uuid;
  -- A genuinely NEW, out-of-band correction — deliberately NOT chained to
  -- the original send/receive causal thread (that thread's own row is never
  -- updated by this RPC). Root operation: fresh correlation_id, no
  -- causation_id, same shape as 126's phoenix_receive_warehouse_stock.
  v_correlation_id uuid := gen_random_uuid();
  v_result       jsonb;
  -- 162: captured from the resolution-row INSERT's own RETURNING clause —
  -- the exact aggregate identity and occurred_at the new outbox event below
  -- reuses. No other column, value, lock, fingerprint, result, or business
  -- side effect in either INSERT is changed by this addition.
  v_new_resolution_id uuid;
  v_new_resolved_at   timestamptz;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_return_shipment_line_id IS NULL THEN
    RAISE EXCEPTION 'return_shipment_line_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_resolution_kind IS NULL OR p_resolution_kind NOT IN ('corrected_receipt', 'confirmed_no_stock') THEN
    RAISE EXCEPTION 'invalid_resolution_kind' USING ERRCODE = '23514';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'reason_required' USING ERRCODE = '23514';
  END IF;
  IF p_resolution_kind = 'corrected_receipt' THEN
    IF p_corrected_quantity IS NULL OR p_corrected_quantity <= 0 THEN
      RAISE EXCEPTION 'corrected_quantity_must_be_positive' USING ERRCODE = '23514';
    END IF;
    IF p_disposition_decision IS NULL OR p_disposition_decision NOT IN ('restockable', 'quarantined') THEN
      RAISE EXCEPTION 'invalid_disposition_decision' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF p_corrected_quantity IS NOT NULL OR p_disposition_decision IS NOT NULL THEN
      RAISE EXCEPTION 'confirmed_no_stock_takes_no_quantity_or_disposition' USING ERRCODE = '23514';
    END IF;
  END IF;

  v_fp := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'resolve_outlet_return_exception',
    'return_shipment_line_id', p_return_shipment_line_id,
    'resolution_kind', p_resolution_kind,
    'reason', v_reason,
    'corrected_quantity', p_corrected_quantity,
    'disposition_decision', p_disposition_decision,
    'actor', v_actor
  )::text, 'UTF8')), 'hex');

  -- Distinct salt from 106 (106106) and 156 (156156).
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 157157));

  SELECT * INTO v_existing
  FROM public.phoenix_outlet_return_exception_resolutions
  WHERE request_id = p_request_id;

  IF FOUND THEN
    IF v_existing.payload_fingerprint IS DISTINCT FROM v_fp THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505',
        DETAIL = 'same request_id previously submitted with a different payload — refresh and resubmit as a new request';
    END IF;
    RETURN v_existing.result;
  END IF;

  SELECT * INTO v_line
  FROM public.outlet_return_shipment_lines WHERE id = p_return_shipment_line_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_shipment_line_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_line.custody_state <> 'exception_pending' THEN
    RAISE EXCEPTION 'line_not_exception_pending' USING ERRCODE = '23514';
  END IF;

  -- Already resolved by a DIFFERENT request_id (this request_id's own row
  -- was already ruled out above) — a raw 23505 off the UNIQUE(return_
  -- shipment_line_id) index would be technically correct but opaque; this
  -- gives the caller an unambiguous, actionable error instead.
  SELECT id INTO v_already
  FROM public.phoenix_outlet_return_exception_resolutions
  WHERE return_shipment_line_id = p_return_shipment_line_id;
  IF FOUND THEN
    RAISE EXCEPTION 'exception_already_resolved' USING ERRCODE = '23505';
  END IF;

  SELECT * INTO v_shipment
  FROM public.outlet_return_shipments WHERE id = v_line.shipment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_shipment_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Same-organization enforcement: the permission check and every row this
  -- RPC writes are scoped to the line's OWN organization, read from its
  -- parent shipment — never a caller-supplied value.
  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'outlet_stock.resolve_return_exception', v_shipment.destination_organization_id,
    v_shipment.destination_warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_outlet_return_exception_resolve' USING ERRCODE = '42501';
  END IF;

  SELECT p.role, p.full_name INTO v_actor_role, v_actor_name
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  -- ==========================================================================
  -- R1.5-B: TWO CAPS ON A CORRECTED RECEIPT, BOTH EXPLICIT AND BOTH BEFORE
  -- ANY CUSTODY CREDIT.
  --
  -- Before R1.5 the only bound was `corrected_quantity > 0`. Two distinct
  -- over-credits were therefore expressible:
  --
  --   1. LINE-LOCAL. A correction larger than what this shipment line actually
  --      carried. Nothing caught this: several return lines can descend from
  --      one dispatch line, so a per-line excess can still sit under the
  --      aggregate ledger's ceiling.
  --
  --   2. AGGREGATE. A correction that pushes the dispatch line's credited
  --      returns past what was physically returned through it. This one WAS
  --      ultimately refused - but only by wdl_return_received_qty_chk firing
  --      on the UPDATE far below, i.e. an opaque raw CHECK violation after the
  --      stock credit had already been attempted in the same transaction.
  --
  -- Both are now named refusals raised here, before the first write. The CHECK
  -- constraint is deliberately left in place as a database backstop; normal
  -- operation must never reach it.
  --
  -- LOCK ORDER is the ordinary receive path's, unchanged:
  --   advisory(request_id) -> outlet_return_shipment_lines -> outlet_return_
  --   shipments -> warehouse_dispatch_lines -> warehouse_stock/quarantine.
  -- Taking the dispatch line here - after the shipment, before any stock -
  -- puts this RPC on exactly that sequence rather than inventing a second one.
  IF p_resolution_kind = 'corrected_receipt' THEN
    IF p_corrected_quantity > v_line.sent_quantity THEN
      RAISE EXCEPTION 'corrected_quantity_exceeds_return_shipment_line'
        USING ERRCODE = '23514';
    END IF;

    IF v_line.original_dispatch_line_id IS NOT NULL THEN
      SELECT * INTO v_orig_dispatch
      FROM public.warehouse_dispatch_lines
      WHERE id = v_line.original_dispatch_line_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'original_dispatch_line_not_found' USING ERRCODE = 'P0002';
      END IF;

      -- Evaluated while HOLDING the row lock, and the increment below runs in
      -- the same transaction, so no concurrent resolution can interleave
      -- between this proof and the write it authorizes.
      IF v_orig_dispatch.return_received_quantity + p_corrected_quantity
         > v_orig_dispatch.returned_quantity THEN
        RAISE EXCEPTION 'corrected_quantity_exceeds_returned_quantity'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  IF p_resolution_kind = 'confirmed_no_stock' THEN
    v_result := jsonb_build_object(
      'ok', true, 'resolution_kind', 'confirmed_no_stock',
      'return_shipment_line_id', v_line.id,
      'warehouse_stock_id', NULL, 'quarantine_stock_id', NULL, 'movement_id', NULL
    );

    INSERT INTO public.audit_logs (
      organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
    ) VALUES (
      v_shipment.destination_organization_id, v_actor, v_actor_role,
      'outlet_stock.return_exception_resolved', 'outlet_return_shipment_lines', v_line.id, v_line.scientific_name,
      jsonb_build_object(
        'request_id', p_request_id, 'shipment_id', v_shipment.id, 'resolution_kind', 'confirmed_no_stock',
        'reason', v_reason
      )
    );

    INSERT INTO public.phoenix_outlet_return_exception_resolutions (
      request_id, return_shipment_line_id, organization_id, resolution_kind, reason,
      payload_fingerprint, result, actor_id, actor_role
    ) VALUES (
      p_request_id, v_line.id, v_shipment.destination_organization_id, 'confirmed_no_stock', v_reason,
      v_fp, v_result, v_actor, v_actor_role
    )
    RETURNING id, resolved_at INTO v_new_resolution_id, v_new_resolved_at;

    -- ── 162: the fourth outbox producer (confirmed_no_stock branch) ───────
    PERFORM public.phoenix_append_outbox_event_internal(
      'outlet-return-exception-resolution:' || p_request_id::text,
      'phoenix_outlet_return_exception_resolutions.resolved',
      1::smallint,
      'phoenix_outlet_return_exception_resolutions',
      v_new_resolution_id,
      v_shipment.destination_organization_id,
      jsonb_strip_nulls(jsonb_build_object(
        'resolution_kind', p_resolution_kind,
        'return_shipment_line_id', v_line.id,
        'disposition', p_disposition_decision,
        'corrected_quantity', p_corrected_quantity,
        'trace_id', v_new_resolution_id,
        'reference_id', v_new_resolution_id,
        'occurred_at', v_new_resolved_at
      )),
      v_actor,
      v_correlation_id,
      NULL::uuid,
      p_request_id
    );

    RETURN v_result;
  END IF;

  -- ── corrected_receipt: mirrors 135's own restockable/quarantined ────────
  -- mechanics exactly, under a DISTINCT movement_type/reference_type so a
  -- compensating correction is never confused with an ordinary receive.
  v_reason_code := (
    SELECT rl.reason_code FROM public.outlet_return_request_lines rl
    WHERE rl.id = v_line.return_request_line_id
  );
  v_objectively_expired := v_line.expiry_date IS NOT NULL AND v_line.expiry_date < current_date;
  v_internal := v_line.internal_batch_reference;

  IF p_disposition_decision = 'restockable' THEN
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
      NULL, v_reason, v_actor, v_actor
    )
    ON CONFLICT DO NOTHING;

    SELECT * INTO v_stock
    FROM public.warehouse_stock s
    WHERE s.warehouse_id = v_shipment.destination_warehouse_id
      -- R1.5-A: the CANONICAL material identity, not a raw subset. The former
      -- predicate omitted unit and central_item_id, so two legitimately
      -- distinct lots differing only in those components both matched and
      -- SELECT INTO credited an arbitrary one. Compared against the GENERATED
      -- column so the lookup and warehouse_stock_identity_uniq cannot diverge.
      AND s.material_identity_key = public._phoenix_material_identity_v1(
            v_line.central_item_id, v_line.scientific_name, v_line.national_code,
            v_line.concentration, v_line.dosage_form, v_line.unit)
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
    v_after  := v_before + p_corrected_quantity;

    UPDATE public.warehouse_stock
       SET on_hand_quantity = v_after,
           central_item_id  = COALESCE(v_stock.central_item_id, v_line.central_item_id),
           updated_by       = v_actor
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
      v_stock.id, v_stock.organization_id, v_stock.warehouse_id, 'correction',
      v_before, p_corrected_quantity, v_after,
      v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
      'outlet_return_exception_correction', v_reason_code, 'outlet_return_exception_resolve', p_request_id, v_fp,
      NULL, v_actor, v_actor_role, v_actor_name,
      v_stock.scientific_name, v_stock.concentration,
      v_stock.dosage_form, v_stock.batch_number,
      v_stock.internal_batch_reference,
      v_correlation_id
    )
    RETURNING id INTO v_wh_movement_id;
  ELSE
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
      -- R1.5-A: canonical identity, exactly as the restockable branch.
      AND q.material_identity_key = public._phoenix_material_identity_v1(
            v_line.central_item_id, v_line.scientific_name, v_line.national_code,
            v_line.concentration, v_line.dosage_form, v_line.unit)
      AND COALESCE(q.batch_number, '')  = COALESCE(v_line.batch_number, '')
      AND COALESCE(q.expiry_date, DATE '0001-01-01')
          = COALESCE(v_line.expiry_date, DATE '0001-01-01')
      AND COALESCE(q.internal_batch_reference, '') = COALESCE(v_internal, '')
      -- R1.5-A: the INSERT above has always supplied these two, and
      -- wqs_identity_uniq has carried them since 088 - only this lookup
      -- omitted them, so the SELECT could not resolve the row the INSERT
      -- conflict target represents.
      AND COALESCE(q.supply_type, '') = COALESCE(v_line.supply_type, '')
      AND COALESCE(q.purchase_origin, '') = COALESCE(v_line.purchase_origin, '')
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
    v_after  := v_before + p_corrected_quantity;

    UPDATE public.warehouse_quarantine_stock
       SET quantity = v_after, updated_by = v_actor
     WHERE id = v_quarantine.id;

    INSERT INTO public.warehouse_quarantine_stock_movements (
      quarantine_stock_id, organization_id, warehouse_id, movement_type,
      quantity_before, quantity_delta, quantity_after,
      reason, reason_code, reference_type, reference_id, request_fingerprint,
      source_document_number, actor_id, actor_role, actor_name,
      scientific_name_snapshot, concentration_snapshot,
      dosage_form_snapshot, batch_number_snapshot,
      internal_batch_reference_snapshot,
      correlation_id
    ) VALUES (
      v_quarantine.id, v_quarantine.organization_id, v_quarantine.warehouse_id, 'quarantine_correction',
      v_before, p_corrected_quantity, v_after,
      'outlet_return_exception_correction', v_quarantine.quarantine_reason, 'outlet_return_exception_resolve', p_request_id, v_fp,
      NULL, v_actor, v_actor_role, v_actor_name,
      v_quarantine.scientific_name, v_quarantine.concentration,
      v_quarantine.dosage_form, v_quarantine.batch_number,
      v_quarantine.internal_batch_reference,
      v_correlation_id
    )
    RETURNING id INTO v_q_movement_id;
  END IF;

  -- Keeps 150's aggregate-cap accounting accurate: real stock now exists
  -- for this original dispatch line, exactly as if it had been received
  -- correctly the first time.
  UPDATE public.warehouse_dispatch_lines
     SET return_received_quantity = return_received_quantity + p_corrected_quantity
   WHERE id = v_line.original_dispatch_line_id;

  v_result := jsonb_build_object(
    'ok', true, 'resolution_kind', 'corrected_receipt',
    'return_shipment_line_id', v_line.id, 'disposition', p_disposition_decision,
    'warehouse_stock_id', v_stock.id, 'quarantine_stock_id', v_quarantine.id,
    'movement_id', COALESCE(v_wh_movement_id, v_q_movement_id),
    'quantity_before', v_before, 'quantity_delta', p_corrected_quantity, 'quantity_after', v_after
  );

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_shipment.destination_organization_id, v_actor, v_actor_role,
    'outlet_stock.return_exception_resolved',
    CASE WHEN p_disposition_decision = 'restockable' THEN 'warehouse_stock' ELSE 'warehouse_quarantine_stock' END,
    COALESCE(v_stock.id, v_quarantine.id), v_line.scientific_name,
    jsonb_build_object(
      'request_id', p_request_id, 'shipment_id', v_shipment.id, 'resolution_kind', 'corrected_receipt',
      'reason', v_reason, 'disposition', p_disposition_decision,
      'quantity_before', v_before, 'quantity_delta', p_corrected_quantity, 'quantity_after', v_after
    )
  );

  INSERT INTO public.phoenix_outlet_return_exception_resolutions (
    request_id, return_shipment_line_id, organization_id, resolution_kind, reason,
    corrected_quantity, disposition,
    resulting_warehouse_stock_id, resulting_quarantine_stock_id,
    resulting_warehouse_movement_id, resulting_quarantine_movement_id,
    payload_fingerprint, result, actor_id, actor_role
  ) VALUES (
    p_request_id, v_line.id, v_shipment.destination_organization_id, 'corrected_receipt', v_reason,
    p_corrected_quantity, p_disposition_decision,
    v_stock.id, v_quarantine.id,
    v_wh_movement_id, v_q_movement_id,
    v_fp, v_result, v_actor, v_actor_role
  )
  RETURNING id, resolved_at INTO v_new_resolution_id, v_new_resolved_at;

  -- ── 162: the fourth outbox producer (corrected_receipt branch) ─────────
  -- Fires alongside 161's OWN existing, already-live movement: event for the
  -- compensating warehouse_stock_movements/warehouse_quarantine_stock_
  -- movements row this same RPC inserted a few statements above — two
  -- distinct facts, two distinct aggregates, owner-approved (see WHY
  -- comment at the top of this file).
  PERFORM public.phoenix_append_outbox_event_internal(
    'outlet-return-exception-resolution:' || p_request_id::text,
    'phoenix_outlet_return_exception_resolutions.resolved',
    1::smallint,
    'phoenix_outlet_return_exception_resolutions',
    v_new_resolution_id,
    v_shipment.destination_organization_id,
    jsonb_strip_nulls(jsonb_build_object(
      'resolution_kind', p_resolution_kind,
      'return_shipment_line_id', v_line.id,
      'disposition', p_disposition_decision,
      'corrected_quantity', p_corrected_quantity,
      'trace_id', v_new_resolution_id,
      'reference_id', v_new_resolution_id,
      'occurred_at', v_new_resolved_at
    )),
    v_actor,
    v_correlation_id,
    NULL::uuid,
    p_request_id
  );

  RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- phoenix_review_warehouse_return_request (069 body)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phoenix_review_warehouse_return_request(
  p_return_request_id uuid,
  p_decisions          jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor          uuid := auth.uid();
  v_actor_role     text;
  v_request        public.warehouse_return_requests%ROWTYPE;
  v_decision       jsonb;
  v_line_id        uuid;
  v_approved_qty   integer;
  v_line           public.warehouse_return_request_lines%ROWTYPE;
  v_pending_ids    uuid[];
  v_decided_ids    uuid[] := ARRAY[]::uuid[];
  v_approved_count integer := 0;
  v_rejected_count integer := 0;
  v_full_count     integer := 0;
  v_header_status  text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_return_request_id IS NULL THEN
    RAISE EXCEPTION 'return_request_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_decisions IS NULL OR jsonb_typeof(p_decisions) <> 'array' OR jsonb_array_length(p_decisions) = 0 THEN
    RAISE EXCEPTION 'decisions_required' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_return_request_id::text, 69069));

  SELECT * INTO v_request
  FROM public.warehouse_return_requests WHERE id = p_return_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_request_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- THE IDOR GATE: authority is scoped to the DESTINATION (central)
  -- warehouse — the requester (whichever side) can never approve itself.
  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'warehouse_transfer.review_return',
    v_request.destination_organization_id, v_request.destination_warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_warehouse_review_return' USING ERRCODE = '42501';
  END IF;

  IF v_request.status <> 'submitted' THEN
    RAISE EXCEPTION 'return_request_not_submitted' USING ERRCODE = '23514';
  END IF;

  SELECT array_agg(id) INTO v_pending_ids
  FROM (
    SELECT id FROM public.warehouse_return_request_lines
    WHERE return_request_id = v_request.id AND status = 'pending'
    FOR UPDATE
  ) locked_lines;

  IF v_pending_ids IS NULL THEN
    RAISE EXCEPTION 'return_request_has_no_pending_lines' USING ERRCODE = '23514';
  END IF;

  -- R1.5-C: the aggregate commitment guard, evaluated ONCE for the whole
  -- normalized decision set before any line is decided - so a payload cannot
  -- be partially applied and then refused. All cap arithmetic and all
  -- deterministic locking live in the helper; nothing is restated here.
  PERFORM public._phoenix_validate_warehouse_return_review_caps_v1(
    p_return_request_id, p_decisions);

  FOR v_decision IN SELECT * FROM jsonb_array_elements(p_decisions)
  LOOP
    v_line_id      := NULLIF(v_decision->>'line_id', '')::uuid;
    v_approved_qty := NULLIF(v_decision->>'approved_quantity', '')::integer;

    IF v_line_id IS NULL OR v_approved_qty IS NULL OR v_approved_qty < 0 THEN
      RAISE EXCEPTION 'invalid_review_decision' USING ERRCODE = '23514';
    END IF;
    IF NOT (v_line_id = ANY (v_pending_ids)) THEN
      RAISE EXCEPTION 'decision_line_not_pending_for_request' USING ERRCODE = 'P0002';
    END IF;
    IF v_line_id = ANY (v_decided_ids) THEN
      RAISE EXCEPTION 'duplicate_decision_for_line' USING ERRCODE = '23505';
    END IF;

    SELECT * INTO v_line FROM public.warehouse_return_request_lines WHERE id = v_line_id;
    IF v_approved_qty > v_line.requested_quantity THEN
      RAISE EXCEPTION 'approved_quantity_exceeds_requested' USING ERRCODE = '23514';
    END IF;

    UPDATE public.warehouse_return_request_lines
       SET approved_quantity = v_approved_qty,
           status = CASE WHEN v_approved_qty = 0 THEN 'rejected' ELSE 'approved' END
     WHERE id = v_line_id;

    v_decided_ids := array_append(v_decided_ids, v_line_id);
    IF v_approved_qty = 0 THEN
      v_rejected_count := v_rejected_count + 1;
    ELSE
      v_approved_count := v_approved_count + 1;
      IF v_approved_qty = v_line.requested_quantity THEN
        v_full_count := v_full_count + 1;
      END IF;
    END IF;
  END LOOP;

  IF array_length(v_decided_ids, 1) IS DISTINCT FROM array_length(v_pending_ids, 1) THEN
    RAISE EXCEPTION 'all_pending_lines_must_be_decided' USING ERRCODE = '23514';
  END IF;

  v_header_status := CASE
    WHEN v_approved_count = 0 THEN 'rejected'
    WHEN v_rejected_count = 0 AND v_full_count = v_approved_count THEN 'approved'
    ELSE 'partially_approved'
  END;

  SELECT p.role INTO v_actor_role FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';

  UPDATE public.warehouse_return_requests
     SET status = v_header_status, reviewed_by = v_actor, reviewed_at = now()
   WHERE id = v_request.id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_request.destination_organization_id, v_actor, v_actor_role,
    'warehouse_transfer.return_reviewed', 'warehouse_return_requests', v_request.id,
    v_request.return_number, jsonb_build_object('decisions', p_decisions, 'result_status', v_header_status)
  );

  RETURN jsonb_build_object('ok', true, 'return_request_id', v_request.id, 'status', v_header_status);
END;
$$;

-- ---------------------------------------------------------------------------
-- phoenix_release_quarantine_stock (132 body)
-- ---------------------------------------------------------------------------
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
  -- R1.5-A: THE canonical lot comparison. The pre-R1.5 check compared
  -- scientific_name + batch + expiry only, so quarantined stock could be
  -- released into a merely NAME-matching warehouse_stock row that differed in
  -- unit, central item identity, national code, concentration, dosage form,
  -- internal batch reference, supply type or purchase origin. Both rows carry
  -- the GENERATED material_identity_key, so the material half is compared
  -- directly rather than re-derived; the lot half mirrors
  -- warehouse_stock_identity_uniq / wqs_identity_uniq component for component.
  IF v_dest.material_identity_key IS DISTINCT FROM v_q.material_identity_key
     OR COALESCE(v_dest.batch_number,'') IS DISTINCT FROM COALESCE(v_q.batch_number,'')
     OR COALESCE(v_dest.expiry_date, DATE '0001-01-01')
        IS DISTINCT FROM COALESCE(v_q.expiry_date, DATE '0001-01-01')
     OR COALESCE(v_dest.internal_batch_reference,'')
        IS DISTINCT FROM COALESCE(v_q.internal_batch_reference,'')
     OR COALESCE(v_dest.supply_type,'') IS DISTINCT FROM COALESCE(v_q.supply_type,'')
     OR COALESCE(v_dest.purchase_origin,'') IS DISTINCT FROM COALESCE(v_q.purchase_origin,'') THEN
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


-- ============================================================================
-- C. WAREHOUSE-RETURN REVIEW: AGGREGATE COMMITMENT CAPS
-- ============================================================================
-- SEND already prevents a physical over-return: it locks the original
-- warehouse_transfer_line and refuses `returned_quantity + send > received`.
-- REVIEW had no such guard, so several requests could each be APPROVED against
-- one provenance and only collide later, at send time, after operators had been
-- told their returns were authorized.
--
-- TWO INDEPENDENT RESOURCES ARE COMMITTED HERE, WITH TWO DIFFERENT GROUPING
-- KEYS. Conflating them would leave a real hole:
--
--   PROVENANCE, keyed by warehouse_transfer_lines.id
--     How much of THIS delivery may ever travel back.
--
--   PHYSICAL, keyed by warehouse_transfer_lines.resulting_warehouse_stock_id
--     How much stock is actually on the shelf. Several DISTINCT transfer lines
--     legally merge into ONE warehouse_stock row, so two requests with
--     different provenance anchors can still compete for one balance. Grouping
--     the physical check by transfer line would never see that collision.
--
-- LIVE COMMITMENT SET is ('approved', 'partially_fulfilled') and is filtered by
-- STATUS, never by arithmetic alone: wrrl_status_qty_consistency_chk leaves
-- approved_quantity NON-NULL on a 'cancelled' line (it only forces
-- fulfilled_quantity = 0), so `GREATEST(approved - fulfilled, 0)` would happily
-- count a cancelled approval as outstanding.
--
-- REVIEW IS NOT A RESERVATION. Nothing here writes warehouse_stock. SEND
-- remains the physical debit boundary and its own guards are untouched.

-- ---------------------------------------------------------------------------
-- R1.5-F1-C2. THE CANONICAL OUTSTANDING-COMMITMENT PREDICATE.
--
-- Recall sizing and review arbitration were each carrying their own hand-written
-- census of "what still consumes the shelf", and they disagreed. That produced a
-- real cross-workflow hole: F1 sized a recall against a lot counting PENDING
-- lines, then review approved a separate manual return that ignored the pending
-- recall entirely - custody 30, recall pending 30, manual approved 20, so 50
-- units of still-obligating quantity stood against a 30-unit shelf. Both callers
-- now derive from this ONE function, so the vocabulary cannot drift again.
--
-- ONE TERMINAL VOCABULARY, derived from the real lifecycle rather than assumed:
--   line     'rejected'  approved_quantity = 0 and fulfilled = 0  -> dead
--            'cancelled' fulfilled = 0                            -> dead
--            'fulfilled' fulfilled = approved                     -> nothing left
--   request  'rejected' / 'cancelled'                             -> dead
-- Everything else can still reach SEND and therefore still consumes the shelf.
--
-- ONE QUANTITY EXPRESSION: COALESCE(approved_quantity, requested_quantity)
--                          - fulfilled_quantity
--   pending             approved is NULL, so the whole request is at risk - it is
--                       the most that could still be approved (wrrl_approved_qty_chk
--                       caps approval at requested).
--   approved            the exact authorized amount.
--   partially_fulfilled only the unsent remainder.
--   A partly-approved line is NOT counted at its requested figure: review only ever
--   decides 'pending' lines, so the refused remainder can never be revived and
--   holding capacity against it would strand units no workflow can consume. This
--   is the measure Section C already used; F1 now adopts it.
--
-- TWO SCOPES, because the two callers ask different questions:
--   'all_actionable'      every live line. What RECALL SIZING must respect: an
--                         obligation the database generates and sizes ITSELF must
--                         be truthful the moment it is written, so any competing
--                         live request already reduces what a recall may claim.
--   'committed_or_recall' approved/partially_fulfilled of any reason, PLUS pending
--                         RECALLS. What REVIEW ARBITRATION must respect.
--
-- WHY REVIEW IS NOT SIMPLY 'all_actionable' - this was measured, not assumed. A
-- pending manual return is a REQUEST, not a commitment; several parties may
-- legitimately request more than exists and review is the gate that arbitrates
-- them first-come-first-served. Counting every pending line there would refuse the
-- FIRST of two competing 20-unit requests against a 30-unit shelf purely because
-- the second exists, and the two would then block each other with no tie-break.
-- A pending RECALL is different in kind: it is not a request but a machine-sized
-- instruction from the material's origin, already bounded to available custody by
-- _phoenix_warehouse_recall_exposure_v1, so recalls can never collectively
-- overdraw the lot and can never deadlock each other. Giving it precedence over a
-- routine holder-initiated return is the domain's own priority order.
CREATE OR REPLACE FUNCTION public._phoenix_warehouse_return_outstanding_v1(
  p_resulting_warehouse_stock_id uuid,
  p_original_transfer_line_id    uuid,
  p_exclude_line_ids             uuid[] DEFAULT NULL,
  p_scope                        text   DEFAULT 'all_actionable'
)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $outstanding$
DECLARE
  v_total integer;
BEGIN
  -- Both keys NULL would silently total every return line in the database.
  IF p_resulting_warehouse_stock_id IS NULL AND p_original_transfer_line_id IS NULL THEN
    RAISE EXCEPTION 'warehouse_return_outstanding_requires_a_grouping_key' USING ERRCODE = '23514';
  END IF;
  IF p_scope IS NULL OR p_scope NOT IN ('all_actionable', 'committed_or_recall') THEN
    RAISE EXCEPTION 'warehouse_return_outstanding_unknown_scope' USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(sum(
           GREATEST(COALESCE(l.approved_quantity, l.requested_quantity) - l.fulfilled_quantity, 0)
         ), 0)::integer
    INTO v_total
  FROM public.warehouse_return_request_lines l
  JOIN public.warehouse_return_requests r ON r.id = l.return_request_id
  JOIN public.warehouse_transfer_lines otl ON otl.id = l.original_transfer_line_id
  WHERE l.status NOT IN ('rejected', 'cancelled', 'fulfilled')
    AND r.status NOT IN ('rejected', 'cancelled')
    AND (p_resulting_warehouse_stock_id IS NULL
         OR otl.resulting_warehouse_stock_id = p_resulting_warehouse_stock_id)
    AND (p_original_transfer_line_id IS NULL
         OR l.original_transfer_line_id = p_original_transfer_line_id)
    -- THE CURRENT-LINE EXCLUSION. Review passes the exact lines it is deciding;
    -- without this every review - and every recall review in particular, whose own
    -- line is a pending 'recalled' row - would count itself and self-block.
    AND (p_exclude_line_ids IS NULL OR NOT (l.id = ANY (p_exclude_line_ids)))
    AND (p_scope = 'all_actionable'
         OR l.status <> 'pending'
         OR l.reason_code = 'recalled');

  RETURN v_total;
END;
$outstanding$;

REVOKE ALL ON FUNCTION public._phoenix_warehouse_return_outstanding_v1(uuid, uuid, uuid[], text)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public._phoenix_warehouse_return_outstanding_v1(uuid, uuid, uuid[], text) IS
  'RETURN-QUARANTINE-RECALL-PARITY-185 (F1/C2): the SINGLE definition of an '
  'outstanding warehouse-return commitment. One terminal vocabulary (line '
  'rejected/cancelled/fulfilled, request rejected/cancelled), one quantity '
  'expression (COALESCE(approved, requested) - fulfilled), two grouping keys '
  '(provenance by transfer line, physical by resulting_warehouse_stock_id) and an '
  'explicit exclusion set for the lines a review is currently deciding. Scope '
  '''all_actionable'' is what recall SIZING respects; ''committed_or_recall'' is '
  'what review ARBITRATION respects - a pending manual return is a request that '
  'review exists to arbitrate, while a pending recall is an origin-issued, '
  'already-custody-bounded instruction that outranks it. Internal only.';

CREATE OR REPLACE FUNCTION public._phoenix_validate_warehouse_return_review_caps_v1(
  p_return_request_id uuid,
  p_decisions         jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $caps$
DECLARE
  v_id uuid;
  r    record;
BEGIN
  -- ---------------------------------------------------------------------
  -- 1. DETERMINISTIC LOCKING, in the direction SEND already uses:
  --       warehouse_transfer_lines  ->  warehouse_stock
  --    Ordered by id and taken one at a time, so two concurrent reviews can
  --    never acquire the same pair in opposite order. Never payload order.
  -- ---------------------------------------------------------------------
  FOR v_id IN
    SELECT DISTINCT l.original_transfer_line_id
    FROM jsonb_array_elements(p_decisions) d
    JOIN public.warehouse_return_request_lines l
      ON l.id = NULLIF(d->>'line_id', '')::uuid
    WHERE l.return_request_id = p_return_request_id
      AND l.original_transfer_line_id IS NOT NULL
      AND COALESCE(NULLIF(d->>'approved_quantity', '')::integer, 0) > 0
    ORDER BY 1
  LOOP
    PERFORM 1 FROM public.warehouse_transfer_lines WHERE id = v_id FOR UPDATE;
  END LOOP;

  -- The SHARED stock-row lock is what serializes reviews whose provenance
  -- differs but whose physical balance is the same. Without it two reviews
  -- both read available=10 and both approve 6.
  FOR v_id IN
    SELECT DISTINCT tl.resulting_warehouse_stock_id
    FROM jsonb_array_elements(p_decisions) d
    JOIN public.warehouse_return_request_lines l
      ON l.id = NULLIF(d->>'line_id', '')::uuid
    JOIN public.warehouse_transfer_lines tl
      ON tl.id = l.original_transfer_line_id
    WHERE l.return_request_id = p_return_request_id
      AND tl.resulting_warehouse_stock_id IS NOT NULL
      AND COALESCE(NULLIF(d->>'approved_quantity', '')::integer, 0) > 0
    ORDER BY 1
  LOOP
    PERFORM 1 FROM public.warehouse_stock WHERE id = v_id FOR UPDATE;
  END LOOP;

  -- ---------------------------------------------------------------------
  -- 2. PROVENANCE CAP, per original_transfer_line_id.
  --      already_sent + other_live_outstanding + proposed <= received
  -- ---------------------------------------------------------------------
  FOR r IN
    WITH proposal AS (
      SELECT l.original_transfer_line_id AS tl_id,
             l.id                        AS line_id,
             NULLIF(d->>'approved_quantity', '')::integer AS proposed
      FROM jsonb_array_elements(p_decisions) d
      JOIN public.warehouse_return_request_lines l
        ON l.id = NULLIF(d->>'line_id', '')::uuid
      WHERE l.return_request_id = p_return_request_id
        AND l.original_transfer_line_id IS NOT NULL
    ),
    grouped AS (
      SELECT tl_id, SUM(proposed) AS proposed
      FROM proposal WHERE proposed > 0 GROUP BY tl_id
    )
    SELECT g.tl_id,
           g.proposed,
           tl.received_quantity,
           tl.returned_quantity,
           -- R1.5-F1-C2: one shared census, and the lines under review are passed
           -- as the exclusion set so this review never counts itself.
           public._phoenix_warehouse_return_outstanding_v1(
             NULL, g.tl_id,
             (SELECT array_agg(line_id) FROM proposal),
             'committed_or_recall') AS other_outstanding
    FROM grouped g
    JOIN public.warehouse_transfer_lines tl ON tl.id = g.tl_id
  LOOP
    IF r.returned_quantity + r.other_outstanding + r.proposed
       > COALESCE(r.received_quantity, 0) THEN
      RAISE EXCEPTION
        'warehouse_return_aggregate_cap_exceeded: transfer line % received %, already returned %, other live commitments %, proposed %',
        r.tl_id, COALESCE(r.received_quantity, 0), r.returned_quantity,
        r.other_outstanding, r.proposed
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  -- ---------------------------------------------------------------------
  -- 3. PHYSICAL CAP, per resulting_warehouse_stock_id.
  --      other_live_outstanding + proposed_for_that_row <= on_hand - reserved
  --
  --    returned_quantity is deliberately NOT added here: SEND already debited
  --    those units out of warehouse_stock, so counting them again would refuse
  --    legal reviews. Only UNSENT commitments compete for the shelf.
  -- ---------------------------------------------------------------------
  FOR r IN
    WITH proposal AS (
      SELECT tl.resulting_warehouse_stock_id AS stock_id,
             l.id                            AS line_id,
             NULLIF(d->>'approved_quantity', '')::integer AS proposed
      FROM jsonb_array_elements(p_decisions) d
      JOIN public.warehouse_return_request_lines l
        ON l.id = NULLIF(d->>'line_id', '')::uuid
      JOIN public.warehouse_transfer_lines tl
        ON tl.id = l.original_transfer_line_id
      WHERE l.return_request_id = p_return_request_id
        AND tl.resulting_warehouse_stock_id IS NOT NULL
    ),
    -- Grouped by STOCK ROW, so two proposals in this same review that resolve
    -- to one balance are judged together rather than each against the full
    -- amount.
    grouped AS (
      SELECT stock_id, SUM(proposed) AS proposed
      FROM proposal WHERE proposed > 0 GROUP BY stock_id
    )
    SELECT g.stock_id,
           g.proposed,
           ws.on_hand_quantity - ws.reserved_quantity AS available,
           -- R1.5-F1-C2: the SAME shared census as the provenance cap above and as
           -- recall sizing, so a pending recall can no longer be spent twice.
           public._phoenix_warehouse_return_outstanding_v1(
             g.stock_id, NULL,
             (SELECT array_agg(line_id) FROM proposal),
             'committed_or_recall') AS other_outstanding
    FROM grouped g
    JOIN public.warehouse_stock ws ON ws.id = g.stock_id
  LOOP
    IF r.other_outstanding + r.proposed > r.available THEN
      RAISE EXCEPTION
        'warehouse_return_physical_cap_exceeded: stock row % has % available, other live commitments %, proposed %',
        r.stock_id, r.available, r.other_outstanding, r.proposed
        USING ERRCODE = '23514';
    END IF;
  END LOOP;
END;
$caps$;

-- INTERNAL. Reached only from inside the review RPC; it is SECURITY DEFINER
-- over warehouse_transfer_lines and warehouse_stock, so an EXECUTE grant would
-- turn it into a cross-tenant probe for provenance and balances. Revoked from
-- service_role too, but note the reachability INVARIANT asserted in VERIFY is
-- scoped to the browser principals - that is the actual client boundary.
REVOKE ALL ON FUNCTION public._phoenix_validate_warehouse_return_review_caps_v1(uuid, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public._phoenix_validate_warehouse_return_review_caps_v1(uuid, jsonb) IS
  'RETURN-QUARANTINE-RECALL-PARITY-185: the single place warehouse-return review '
  'commitment arithmetic lives. TWO caps with TWO grouping keys - provenance by '
  'warehouse_transfer_lines.id, physical by resulting_warehouse_stock_id, because '
  'distinct transfer lines legally merge into one stock row. Live commitments are '
  'filtered by status (approved, partially_fulfilled), never by arithmetic, since '
  'a cancelled line keeps a non-NULL approved_quantity. Locks transfer lines then '
  'stock rows, each ordered by id, matching the direction SEND already uses. '
  'Writes nothing: review is a commitment guard, not a reservation.';

-- ============================================================================
-- D. FACILITY-AWARE READ PARITY FOR health_center_manager
-- ============================================================================
-- HCM gains SELECT visibility of its OWN assigned facility's returns,
-- quarantine, exception history and correction history. It gains NO mutation
-- authority whatsoever: not one permission default changes, and every branch
-- added below is reachable only from a SELECT policy or a read helper.
--
-- ORGANIZATION EQUALITY IS NEVER SUFFICIENT FOR HCM. Every Health Centre in a
-- sector shares ONE organization row, so `organization_id = phoenix_my_org()`
-- would hand HCM-A every sibling centre's history. Visibility is therefore
-- derived from 182's ASSIGNMENT helpers, which resolve an active facility
-- assignment down to concrete warehouses and points:
--
--     phoenix_profile_has_warehouse_assignment(uuid, uuid)
--     phoenix_profile_has_point_assignment(uuid, uuid)
--
-- (182 exposes no `phoenix_profile_has_facility_assignment`; these two ARE the
-- facility model's public surface, and they are what the policies below use.)
--
-- SECTOR MAIN IS EXCLUDED STRUCTURALLY, not by name: it carries no facility_id,
-- so no facility assignment can ever resolve to it. There is deliberately no
-- blacklist to keep in sync.

-- ---------------------------------------------------------------------------
-- D1. Outlet-return read helper - 071/157 branches preserved verbatim.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phoenix_can_read_outlet_return(
  p_source_organization_id uuid,
  p_distribution_point_id  uuid,
  p_destination_warehouse_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    public.phoenix_my_role() = 'super_admin'
    OR public.phoenix_profile_has_scoped_permission(
         auth.uid(), 'outlet_stock.return_request', p_source_organization_id, NULL, p_distribution_point_id)
    OR public.phoenix_profile_has_scoped_permission(
         auth.uid(), 'outlet_stock.review_return', p_source_organization_id, p_destination_warehouse_id, NULL)
    OR public.phoenix_profile_has_scoped_permission(
         auth.uid(), 'outlet_stock.resolve_return_exception', p_source_organization_id, p_destination_warehouse_id, NULL)
    -- R1.5-D: HCM READ parity. BOTH endpoints must be assigned, so a malformed
    -- or historical row pairing an assigned point with a sibling depot stays
    -- invisible. No permission key is consulted: this branch grants sight, not
    -- authority.
    OR (
      public.phoenix_my_role() = 'health_center_manager'
      AND public.phoenix_profile_has_point_assignment(auth.uid(), p_distribution_point_id)
      AND public.phoenix_profile_has_warehouse_assignment(auth.uid(), p_destination_warehouse_id)
    )
$$;

REVOKE ALL ON FUNCTION public.phoenix_can_read_outlet_return(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_can_read_outlet_return(uuid, uuid, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- D2. Warehouse-return read helper - 069 branches preserved verbatim.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phoenix_can_read_warehouse_return(
  p_source_organization_id      uuid,
  p_source_warehouse_id         uuid,
  p_destination_organization_id uuid,
  p_destination_warehouse_id    uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    auth.uid() IS NOT NULL
    AND (
      public.phoenix_my_role() = 'super_admin'
      OR public.phoenix_profile_has_scoped_permission(
           auth.uid(), 'warehouse_transfer.return_request',
           p_source_organization_id, p_source_warehouse_id, NULL)
      OR public.phoenix_profile_has_scoped_permission(
           auth.uid(), 'warehouse_transfer.return_send',
           p_source_organization_id, p_source_warehouse_id, NULL)
      OR public.phoenix_profile_has_scoped_permission(
           auth.uid(), 'warehouse_transfer.recall',
           p_destination_organization_id, p_destination_warehouse_id, NULL)
      OR public.phoenix_profile_has_scoped_permission(
           auth.uid(), 'warehouse_transfer.review_return',
           p_destination_organization_id, p_destination_warehouse_id, NULL)
      OR public.phoenix_profile_has_scoped_permission(
           auth.uid(), 'warehouse_transfer.return_receive',
           p_destination_organization_id, p_destination_warehouse_id, NULL)
      -- R1.5-D: HCM READ parity, anchored on the SOURCE depot ONLY.
      --
      -- A centre depot returns to its own Sector Main, so requiring the
      -- DESTINATION too would make the corridor permanently invisible: HCM must
      -- never hold a Sector Main assignment. Source-only is therefore the
      -- correct anchor AND is self-limiting - it authorizes exactly the rows
      -- whose source is a depot this actor is assigned to, and nothing that
      -- merely passes through or originates at Sector Main.
      OR (
        public.phoenix_my_role() = 'health_center_manager'
        AND public.phoenix_profile_has_warehouse_assignment(auth.uid(), p_source_warehouse_id)
      )
    );
$$;

REVOKE ALL ON FUNCTION public.phoenix_can_read_warehouse_return(uuid, uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_can_read_warehouse_return(uuid, uuid, uuid, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- D3. Quarantine SELECT parity. ADDITIVE policies: the historical ones are
--     left exactly as they are, so no existing reader can lose visibility.
--     PERMISSIVE policies OR together, and each new one is SELECT-only.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS wqs_select_health_center_facility ON public.warehouse_quarantine_stock;
CREATE POLICY wqs_select_health_center_facility
  ON public.warehouse_quarantine_stock
  FOR SELECT TO authenticated
  USING (
    public.phoenix_my_role() = 'health_center_manager'
    AND public.phoenix_profile_has_warehouse_assignment(auth.uid(), warehouse_id)
  );

DROP POLICY IF EXISTS wqsm_select_health_center_facility ON public.warehouse_quarantine_stock_movements;
CREATE POLICY wqsm_select_health_center_facility
  ON public.warehouse_quarantine_stock_movements
  FOR SELECT TO authenticated
  USING (
    public.phoenix_my_role() = 'health_center_manager'
    AND public.phoenix_profile_has_warehouse_assignment(auth.uid(), warehouse_id)
  );

-- ---------------------------------------------------------------------------
-- D4. Outlet-return exception resolution history. Derived through REAL custody
--     (resolution -> shipment line -> shipment), never through organization_id.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS porer_select_health_center_facility
  ON public.phoenix_outlet_return_exception_resolutions;
CREATE POLICY porer_select_health_center_facility
  ON public.phoenix_outlet_return_exception_resolutions
  FOR SELECT TO authenticated
  USING (
    public.phoenix_my_role() = 'health_center_manager'
    AND EXISTS (
      SELECT 1
      FROM public.outlet_return_shipment_lines l
      JOIN public.outlet_return_shipments s ON s.id = l.shipment_id
      WHERE l.id = phoenix_outlet_return_exception_resolutions.return_shipment_line_id
        AND public.phoenix_profile_has_point_assignment(auth.uid(), s.distribution_point_id)
        AND public.phoenix_profile_has_warehouse_assignment(auth.uid(), s.destination_warehouse_id)
    )
  );

-- ---------------------------------------------------------------------------
-- D5. Warehouse correction history. Resolved through the stock row's warehouse.
--     READ ONLY: no approval or apply authority is implied or granted.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS pwcr_select_health_center_facility
  ON public.phoenix_warehouse_correction_requests;
CREATE POLICY pwcr_select_health_center_facility
  ON public.phoenix_warehouse_correction_requests
  FOR SELECT TO authenticated
  USING (
    public.phoenix_my_role() = 'health_center_manager'
    AND EXISTS (
      SELECT 1 FROM public.warehouse_stock ws
      WHERE ws.id = phoenix_warehouse_correction_requests.warehouse_stock_id
        AND public.phoenix_profile_has_warehouse_assignment(auth.uid(), ws.warehouse_id)
    )
  );

-- The four bodies are replaced in place, so CREATE OR REPLACE preserves their
-- existing ACLs. The posture is re-asserted anyway: 109's ALTER DEFAULT
-- PRIVILEGES grants EXECUTE to service_role on every NEWLY created function,
-- so a future DROP+CREATE of any of these would silently re-open it.
REVOKE ALL ON FUNCTION public._phoenix_149_delegate_receive_outlet_return_shipment_line(uuid,uuid,integer,text,text,text)
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.phoenix_receive_warehouse_return_shipment_line(uuid,uuid,integer,text,text,text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_receive_warehouse_return_shipment_line(uuid,uuid,integer,text,text,text)
  TO authenticated;

REVOKE ALL ON FUNCTION public.phoenix_resolve_outlet_return_exception(uuid,uuid,text,text,integer,text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_resolve_outlet_return_exception(uuid,uuid,text,text,integer,text)
  TO authenticated;

REVOKE ALL ON FUNCTION public.phoenix_release_quarantine_stock(uuid,uuid,integer,text,uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_release_quarantine_stock(uuid,uuid,integer,text,uuid)
  TO authenticated;

-- ============================================================================
-- C. RECALL SELECTOR - PROVENANCE-FIRST, SAME-HOLDER MATERIALIZATION (F1)
-- ============================================================================
-- THE DEFECT THIS CLOSES
--   phoenix_recall_warehouse_transfer (069) and
--   phoenix_recall_direct_warehouse_transfer (077) each insert ONE draft
--   warehouse_return_requests header and nothing else. No line is created, so
--   nothing identifies WHICH material is recalled and no obligation exists.
--   That is not an omission in their bodies: their signatures carry no
--   material, lot, transfer, dispatch or quantity selector, so there is nothing
--   to materialize FROM. An empty draft header is indistinguishable from an
--   abandoned one.
--
-- THE SELECTOR
--   ONE warehouse_transfer_lines row is a complete, locked description of the
--   corridor, so it is the whole public input:
--     transfer_id -> warehouse_transfers    -> both warehouses, both orgs, and
--                                              route_id (NULL = direct, per 077)
--     resulting_warehouse_stock_id          -> the canonical lot at the holder
--     source_warehouse_stock_id             -> upstream provenance
--     received_quantity / returned_quantity -> the historical cap
--   Canonical material identity is read from warehouse_stock.material_identity_key
--   (150, GENERATED ALWAYS) on the resulting row. The caller therefore restates
--   NOTHING: no organization, no warehouse, no identity, no batch, no quantity.
--   One RPC serves both the routed and the direct corridor because the
--   difference is derived, not declared.
--
-- AUTHORITY IS ORIGIN-ANCHORED
--   warehouse_transfer.recall is checked on the ORIGINAL SENDER warehouse
--   (warehouse_transfers.source_warehouse_id) - the same anchor 069 and 077
--   already use, but derived from the locked transfer instead of accepted from
--   the caller. The obligation is created at the CURRENT HOLDER, which may sit
--   in another organization; that is the point of a recall and is authorized
--   backend-internal custody following, NOT a permission grant. The actor gains
--   no read access to the holder's rows: the response carries counts and the
--   actor's own return_number, never holder names, ids or quantities.
--
-- F1 SCOPE
--   SAME HOLDER ONLY - the immediate receiving warehouse of the selected line.
--   Onward warehouse legs and outlet descendants are F2/F3 and are deliberately
--   NOT partially implemented here.
-- ============================================================================

-- C0. CORRIDOR-AWARE RETURN REFERENCE (R1.5-F2 model correction M1)
-- ---------------------------------------------------------------------------
-- 069 keyed the external reference ORGANIZATION-WIDE:
--     wrr_src_org_number_uniq  UNIQUE (source_organization_id, btrim(return_number))
-- That silently assumed one organization can hold at most ONE return corridor
-- per reference. The canonical health-sector topology breaks the assumption:
--
--     W0 central (PDA)  --184 Branch A-->  W1 Sector Main  --Branch B-->  W2 Depot
--
-- 181 forces EVERY health-sector warehouse to warehouse_kind='institution', and
-- 184's Branch B requires src.organization_id = dst.organization_id, so W1 and
-- W2 are necessarily in the SAME organization. When a recall must reach stock
-- held at both, the two obligations need DIFFERENT corridors - W1->W0 and
-- W2->W1 - under ONE operator reference. The old index made the second header
-- structurally impossible (SQLSTATE 23505, reproduced on the rig).
--
-- A header IS one physical return corridor: it carries exactly one
-- (source_warehouse, destination_warehouse, route) triple and its lines all
-- travel together. So the reference must be unique PER CORRIDOR, not per
-- organization. The operator's return_number is never rewritten - no suffixes,
-- no generated child references.
--
-- CANONICAL_WAREHOUSE_RETURN_CORRIDOR_IDENTITY
--   source_warehouse_id
--   destination_warehouse_id
--   COALESCE(route_id, nil-uuid)
--
-- The ORGANIZATION columns are deliberately ABSENT: wrr_source_wh_org_fk and
-- wrr_dest_wh_org_fk point (warehouse_id, organization_id) at
-- warehouses(id, organization_id), so each organization column is FUNCTIONALLY
-- DETERMINED by its warehouse column. Adding them would constrain nothing and
-- would re-admit the organization as a disambiguator.
--
-- route_id IS included, because it is NOT functionally determined by the
-- warehouse pair and it is independently load-bearing:
--   * warehouse_supply_routes_active_pair_uniq is PARTIAL (WHERE is_active), so
--     one endpoint pair may own several route rows - verified on the rig.
--   * a pair may also be served with NO route at all (077 dropped route_id's
--     NOT NULL for the direct corridor).
--   * routed and direct returns SEND through different RPCs
--     (phoenix_send_warehouse_return_shipment_line vs
--      phoenix_send_direct_warehouse_return_shipment_line), so merging them into
--     one header would put two different physical channels on one document.
-- It is COALESCEd rather than used raw because a UNIQUE index treats NULLs as
-- DISTINCT: two identical DIRECT headers would otherwise both be insertable,
-- which is exactly the duplicate this index exists to stop. COALESCE keeps that
-- closed on every server version rather than depending on NULLS NOT DISTINCT.
--
-- THE NEW RULE IS STRICTLY WEAKER, so no stored row can fail it: two rows
-- sharing (source_wh, destination_wh, route, number) necessarily share
-- source_organization_id too, and would already have violated the old index.
-- Forward-replacing it can therefore never abort on legacy data.
--
-- MANUAL RETURNS ARE UNAFFECTED IN CONTRACT. Neither
-- phoenix_request_warehouse_return nor phoenix_request_direct_warehouse_return
-- pre-checks uniqueness or catches 23505 - the index was the only place the rule
-- lived - and no test, service, report or UI validation depends on its
-- organization-wide scope.
DO $corridor$
DECLARE
  v_n integer;
BEGIN
  -- Standalone UNIQUE INDEX, not a constraint-backed one: pg_constraint has no
  -- row whose conindid is this index, so DROP INDEX is the correct form and
  -- ALTER TABLE ... DROP CONSTRAINT would fail. Verified, not assumed.
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conindid = (SELECT oid FROM pg_class WHERE relname = 'wrr_src_org_number_uniq');
  IF v_n <> 0 THEN
    RAISE EXCEPTION
      '185 (M1): wrr_src_org_number_uniq is constraint-backed (% constraints); refusing to DROP INDEX blindly', v_n;
  END IF;

  -- The sentinel must not be able to collide with a real route.
  IF EXISTS (SELECT 1 FROM public.warehouse_supply_routes
              WHERE id = '00000000-0000-0000-0000-000000000000'::uuid) THEN
    RAISE EXCEPTION
      '185 (M1): the nil uuid is in use as a supply route id; the direct-corridor sentinel would collide';
  END IF;
END;
$corridor$;

DROP INDEX IF EXISTS public.wrr_src_org_number_uniq;

CREATE UNIQUE INDEX IF NOT EXISTS wrr_corridor_number_uniq
  ON public.warehouse_return_requests (
    source_warehouse_id,
    destination_warehouse_id,
    COALESCE(route_id, '00000000-0000-0000-0000-000000000000'::uuid),
    btrim(return_number)
  );

COMMENT ON INDEX public.wrr_corridor_number_uniq IS
  'RETURN-QUARANTINE-RECALL-PARITY-185 (F2/M1): one external return reference names '
  'ONE return corridor, not one organization. Forward-replaces 069''s '
  'wrr_src_org_number_uniq, which could not represent a health sector holding stock '
  'at both its Sector Main and a Health Centre Depot under one recall reference - '
  'both warehouses share an organization but need different corridors. Organization '
  'columns are omitted because the composite warehouse FKs already determine them; '
  'route_id is included and COALESCEd to the nil uuid because it is not determined '
  'by the warehouse pair, it selects the routed-vs-direct send channel, and a raw '
  'nullable column would let two identical direct headers both insert. Strictly '
  'weaker than the rule it replaces, so no stored row can fail it.';

-- C1. The shared cap invariant, private. Not granted to any client role.
--     Receives ALREADY-DERIVED trusted ids and answers one question: how much of
--     this receipt is still truthfully recallable RIGHT NOW.
--
-- TWO INDEPENDENT BUDGETS WITH TWO DIFFERENT GROUPING KEYS - the SAME shape
-- Section C already establishes for review, and for the same reason:
--
--   PROVENANCE, keyed by warehouse_transfer_lines.id
--     How much of THIS delivery may ever travel back.
--
--   PHYSICAL, keyed by warehouse_transfer_lines.resulting_warehouse_stock_id
--     How much stock is actually on the shelf. Several DISTINCT transfer lines
--     legally merge into ONE warehouse_stock row (150's canonical identity), so
--     obligations anchored to different provenance still compete for one
--     balance.
--
-- R1.5-F1-C1. BOTH budgets subtract the obligations already outstanding against
-- them. Deducting live commitments from the PROVENANCE side alone was a real
-- hole: `on_hand - reserved` re-offered the WHOLE shelf on every call, so the
-- same selector invoked under successive external document numbers walked the
-- historical remainder down in shelf-sized slices and materialized an obligation
-- the holder could never hand over. With received=100, returned=0 and 30 units
-- actually in custody, four recall documents took 30+30+30+10 = 100 against a
-- 30-unit shelf. Review would have refused the second APPROVAL, but by then
-- four operators have been told their recall is on the books - which is exactly
-- the "authorized now, collides later" defect Section C exists to remove. The
-- physical term therefore nets off other live obligations on the same stock row,
-- REGARDLESS of their return_number or provenance anchor.
--
-- NOTHING IS PERSISTED. There is no "recall consumed" counter, no new table and
-- no new column: capacity is derived from live obligations plus current stock
-- truth every time, so it is released the moment an obligation goes terminal and
-- it grows again if custody legitimately grows.
--
-- IDEMPOTENT REPLAY IS UNAFFECTED because it never reaches here: the public RPC
-- resolves an existing (selector, reference, corridor) obligation and returns
-- BEFORE sizing anything. This function is only ever asked "how much MORE may be
-- committed", so every live line - including any under the caller's own
-- reference - is correctly an OTHER obligation from that vantage point.
CREATE OR REPLACE FUNCTION public._phoenix_warehouse_recall_exposure_v1(
  p_original_transfer_line_id uuid,
  p_holder_organization_id    uuid
)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_orig       public.warehouse_transfer_lines%ROWTYPE;
  v_committed  integer;
  v_other_phys integer;
  v_available  integer;
  v_prov       integer;
  v_phys       integer;
BEGIN
  SELECT * INTO v_orig
  FROM public.warehouse_transfer_lines WHERE id = p_original_transfer_line_id;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  -- Never received => never returnable. Same refusal the public add-line path
  -- makes ('original_line_not_received'), expressed as zero exposure.
  IF v_orig.resulting_warehouse_stock_id IS NULL THEN
    RETURN 0;
  END IF;

  -- The resulting lot must belong to the holder we are about to bind. This is
  -- 069's 'original_line_not_at_this_institution' IDOR check, kept intact.
  IF NOT EXISTS (
    SELECT 1 FROM public.warehouse_stock s
    WHERE s.id = v_orig.resulting_warehouse_stock_id
      AND s.organization_id = p_holder_organization_id
  ) THEN
    RETURN 0;
  END IF;

  -- ── PROVENANCE BUDGET, keyed by warehouse_transfer_lines.id ───────────────
  -- Commitments already outstanding against THIS receipt, whether created by hand
  -- or by an earlier recall. R1.5-F1-C2: the census is no longer written here -
  -- it is the shared canonical predicate, so recall sizing and review arbitration
  -- can never drift apart again. Scope 'all_actionable' because an obligation the
  -- database SIZES ITSELF must be truthful the moment it is written.
  v_committed := public._phoenix_warehouse_return_outstanding_v1(
    NULL, p_original_transfer_line_id, NULL, 'all_actionable');

  v_prov := GREATEST(
    COALESCE(v_orig.received_quantity, 0) - v_orig.returned_quantity - v_committed, 0);

  -- ── PHYSICAL BUDGET, keyed by resulting_warehouse_stock_id ────────────────
  -- Every live obligation resolving to this canonical lot, across ALL provenance
  -- anchors and ALL return numbers, through the same shared predicate - so a line
  -- released on one side is released on both.
  v_other_phys := public._phoenix_warehouse_return_outstanding_v1(
    v_orig.resulting_warehouse_stock_id, NULL, NULL, 'all_actionable');

  -- History cannot oblige a holder to return more than it can actually hand
  -- over; reserved units are already promised elsewhere. SEND has already
  -- debited whatever left the shelf, so no fulfilled quantity is double-counted.
  SELECT GREATEST(COALESCE(s.on_hand_quantity, 0) - COALESCE(s.reserved_quantity, 0), 0)
    INTO v_available
  FROM public.warehouse_stock s WHERE s.id = v_orig.resulting_warehouse_stock_id;

  v_phys := GREATEST(COALESCE(v_available, 0) - v_other_phys, 0);

  -- BOTH must hold. The physical budget never replaces the provenance budget:
  -- a full shelf does not authorize returning more of a delivery than arrived.
  RETURN LEAST(v_prov, v_phys);
END;
$$;

REVOKE ALL ON FUNCTION public._phoenix_warehouse_recall_exposure_v1(uuid, uuid)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._phoenix_warehouse_recall_exposure_v1(uuid, uuid) IS
  'RETURN-QUARANTINE-RECALL-PARITY-185 (F1/C1): private truthful-exposure cap for a '
  'single prior warehouse receipt. TWO budgets with TWO grouping keys, matching '
  'Section C: PROVENANCE by warehouse_transfer_lines.id (received - returned - live '
  'commitments on that line) and PHYSICAL by resulting_warehouse_stock_id (on_hand - '
  'reserved - live obligations on that lot from ANY provenance and ANY return '
  'number). Returns their LEAST. Derived from live state only - no persisted '
  'counter - so capacity is released when an obligation goes terminal and grows '
  'again when custody legitimately grows. Not granted to any client role; callers '
  'must pass already-derived, already-locked ids.';

-- C2. ONE OBLIGATION AT ONE CURRENT HOLDER, private (R1.5-F2).
--
-- This is F1's materialization body, extracted verbatim so that the ROOT receipt
-- and every DOWNSTREAM receipt are created by exactly ONE piece of code. F2 must
-- not grow a parallel obligation writer: the corridor derivation, the M1 header
-- key, the cap helpers and the replay rule are the same for a Sector Main
-- returning to Central as for a Health Centre Depot returning to its Sector Main.
--
-- IT DOES NOT CHECK AUTHORITY. Authority is anchored ONCE at the root, in the
-- public RPC, on the ORIGINAL sender warehouse. Downstream obligations are the
-- internal consequence of that authorized safety recall - the caller is never
-- required to hold warehouse_transfer.return_request inside a downstream
-- organization, and is never granted anything there.
--
-- p_transfer_line_id is ALWAYS the REAL delivering line for the holder being
-- bound: the root line at the immediate receiver, and the ONWARD line at a
-- downstream holder. Pointing a downstream obligation at the ROOT line would
-- claim provenance that never delivered to that holder, and 165's
-- no_direct_forward_provenance_between_warehouses would refuse the header anyway.
CREATE OR REPLACE FUNCTION public._phoenix_materialize_warehouse_recall_obligation_v1(
  p_transfer_line_id       uuid,
  p_return_number          text,
  p_notes                  text,
  p_actor                  uuid,
  p_actor_role             text,
  p_audit_organization_id  uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $obligation$
DECLARE
  v_number     text := p_return_number;
  v_notes      text := p_notes;
  v_orig       public.warehouse_transfer_lines%ROWTYPE;
  v_transfer   public.warehouse_transfers%ROWTYPE;
  v_exposure   integer;
  v_request    public.warehouse_return_requests%ROWTYPE;
  v_line_id    uuid;
  v_existing   uuid;
  v_outlet     boolean;
BEGIN
  SELECT * INTO v_orig
  FROM public.warehouse_transfer_lines WHERE id = p_transfer_line_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden_warehouse_recall' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_transfer
  FROM public.warehouse_transfers WHERE id = v_orig.transfer_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden_warehouse_recall' USING ERRCODE = '42501';
  END IF;

  -- Provenance must be REAL before anything is written.
  IF v_orig.resulting_warehouse_stock_id IS NULL
     OR COALESCE(v_orig.received_quantity, 0) <= 0 THEN
    RAISE EXCEPTION 'original_line_not_received' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.warehouse_stock s
    WHERE s.id = v_orig.resulting_warehouse_stock_id
      AND s.material_identity_key IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'canonical_material_identity_unresolved' USING ERRCODE = '23514';
  END IF;

  -- REPLAY. An obligation is identified by its truthful provenance, its external
  -- reference AND its corridor - never by return_number alone, which is a
  -- free-text operator label with no uniqueness anywhere in this schema. Applied
  -- PER HOLDER, so a replayed root recall reuses the root obligation AND every
  -- downstream one independently.
  SELECT l.id INTO v_existing
  FROM public.warehouse_return_request_lines l
  JOIN public.warehouse_return_requests r ON r.id = l.return_request_id
  WHERE l.original_transfer_line_id = v_orig.id
    AND btrim(r.return_number) = v_number
    -- R1.5-F2-M1: the FULL canonical corridor identity, matching
    -- wrr_corridor_number_uniq exactly. route_id joins it because one warehouse
    -- pair may be served routed AND directly, and those are different channels.
    AND r.source_warehouse_id = v_transfer.destination_warehouse_id
    AND r.destination_warehouse_id = v_transfer.source_warehouse_id
    AND COALESCE(r.route_id, '00000000-0000-0000-0000-000000000000'::uuid)
        = COALESCE(v_transfer.route_id, '00000000-0000-0000-0000-000000000000'::uuid)
    AND l.reason_code = 'recalled'
    AND l.status NOT IN ('rejected', 'cancelled')
    AND r.status NOT IN ('rejected', 'cancelled')
  ORDER BY l.created_at
  LIMIT 1;

  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('created', 0, 'reused', 1);
  END IF;

  -- R1.5-F1-C1. THE SHARED STOCK-ROW LOCK. The advisory lock keys on
  -- (selector, reference) and the row lock above keys on the transfer line, so
  -- neither serializes two recalls of DIFFERENT transfer lines that merged into
  -- ONE canonical lot - and the physical budget below is exactly the resource
  -- they share. Without this both would read the same free balance and both
  -- would commit it. Taken in the direction Section C and SEND already use,
  -- warehouse_transfer_lines -> warehouse_stock, so the orders cannot invert.
  -- The public RPC has already taken every lock this transaction needs, in
  -- deterministic id order; re-acquiring one already held never blocks, and it
  -- keeps this helper correct on its own terms.
  PERFORM 1 FROM public.warehouse_stock
   WHERE id = v_orig.resulting_warehouse_stock_id FOR UPDATE;

  v_exposure := public._phoenix_warehouse_recall_exposure_v1(
    v_orig.id, v_transfer.destination_organization_id);

  -- Nothing left to recall is a legitimate, non-exceptional outcome: the stock
  -- may already be returned, already committed, or gone from custody - the last
  -- being exactly what happens at an intermediate holder once everything moved
  -- downstream. A zero-quantity line is forbidden by wrrl_requested_qty_chk
  -- anyway, and an empty header is the very defect this section removes.
  IF v_exposure <= 0 THEN
    RETURN jsonb_build_object('created', 0, 'reused', 0);
  END IF;

  -- ONE EXTERNAL REFERENCE, ONE HEADER PER CORRIDOR (R1.5-F2-M1).
  --   wrr_corridor_number_uniq is UNIQUE (source_warehouse_id,
  --   destination_warehouse_id, COALESCE(route_id, nil), btrim(return_number)).
  --   A single recall reference may therefore span different holder
  --   organizations AND several corridors inside ONE organization - which is
  --   exactly what a health sector holding stock at both its Sector Main and a
  --   Health Centre Depot requires. Within ONE corridor the reference still
  --   names ONE request, and a return request is a many-line document, so a
  --   second receipt on that same corridor APPENDS a line rather than
  --   attempting a second header. Blindly inserting would surface a raw unique
  --   violation and leak an index name to the caller.
  --
  --   HEADER-CREATION RACE. The advisory lock above keys on (selector,
  --   reference) and the row locks are on the transfer line and the lot, so
  --   NONE of them serializes two DIFFERENT selectors converging on the same
  --   corridor and reference - precisely the pair that competes for this index.
  --   This second advisory lock closes that, keyed on the same identity the
  --   index uses, so distinct corridors sharing one external reference never
  --   contend with each other.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    v_transfer.destination_warehouse_id::text || '|' ||
    v_transfer.source_warehouse_id::text || '|' ||
    COALESCE(v_transfer.route_id::text, '-') || '|' || v_number, 185002));

  SELECT * INTO v_request
  FROM public.warehouse_return_requests
  WHERE source_warehouse_id = v_transfer.destination_warehouse_id
    AND destination_warehouse_id = v_transfer.source_warehouse_id
    AND COALESCE(route_id, '00000000-0000-0000-0000-000000000000'::uuid)
        = COALESCE(v_transfer.route_id, '00000000-0000-0000-0000-000000000000'::uuid)
    AND btrim(return_number) = v_number
  FOR UPDATE;

  IF FOUND THEN
    -- Only a DRAFT may still accept lines; anything further along is a document
    -- already in review or flight and must not be silently reopened.
    IF v_request.status <> 'draft' THEN
      RAISE EXCEPTION 'return_request_not_draft' USING ERRCODE = '23514';
    END IF;
    -- DEFENCE IN DEPTH, not a routine rejection. Before M1 this token refused a
    -- legitimate shape - same organization, same reference, different corridor -
    -- because the lookup keyed on the organization. The lookup now pins the whole
    -- corridor, so a mismatch is unreachable by construction; the assertion stays
    -- as a backstop against a future loosening of the predicate above, and never
    -- fires for the case M1 legalized.
    IF v_request.source_warehouse_id IS DISTINCT FROM v_transfer.destination_warehouse_id
       OR v_request.destination_warehouse_id IS DISTINCT FROM v_transfer.source_warehouse_id
       OR COALESCE(v_request.route_id, '00000000-0000-0000-0000-000000000000'::uuid)
          IS DISTINCT FROM COALESCE(v_transfer.route_id, '00000000-0000-0000-0000-000000000000'::uuid) THEN
      RAISE EXCEPTION 'recall_reference_corridor_mismatch' USING ERRCODE = '23514';
    END IF;
  ELSE
    -- The corridor is the exact reverse of the delivering transfer: the CURRENT
    -- HOLDER returns to the ORIGINAL SENDER. wrr_route_endpoints_fk is satisfied
    -- structurally because it maps return(destination,source) onto
    -- route(source,target), and route_id is carried straight from the transfer -
    -- NULL for a direct corridor (077), which is why one RPC serves both.
    INSERT INTO public.warehouse_return_requests (
      route_id, source_warehouse_id, source_organization_id,
      destination_warehouse_id, destination_organization_id,
      return_number, status, requested_by_side, notes, created_by
    ) VALUES (
      v_transfer.route_id,
      v_transfer.destination_warehouse_id, v_transfer.destination_organization_id,
      v_transfer.source_warehouse_id, v_transfer.source_organization_id,
      v_number, 'draft', 'sender', v_notes, p_actor
    )
    RETURNING * INTO v_request;
  END IF;

  -- The line names the REAL receipt. Every descriptive column is copied from
  -- that locked row, exactly as the public add-line path copies them, so the
  -- snapshot cannot drift from the provenance it claims.
  INSERT INTO public.warehouse_return_request_lines (
    return_request_id, source_organization_id, original_transfer_line_id,
    scientific_name, concentration, dosage_form, unit,
    national_code, batch_number, internal_batch_reference, expiry_date,
    reason_code, reason_text, requested_quantity
  ) VALUES (
    v_request.id, v_request.source_organization_id, v_orig.id,
    v_orig.scientific_name, v_orig.concentration, v_orig.dosage_form, v_orig.unit,
    v_orig.national_code, v_orig.batch_number, v_orig.internal_batch_reference,
    v_orig.expiry_date,
    'recalled', v_notes, v_exposure
  )
  RETURNING id INTO v_line_id;

  -- F2-R BOUNDARY FACT, recorded and NOT acted on. If this lot has real outlet
  -- dispatch descendants, warehouse custody already fell by whatever left, and
  -- the exposure above is sized on what is actually still here. Creating a
  -- warehouse obligation for the dispatched remainder would be an obligation
  -- against stock the warehouse no longer holds. Outlet propagation is F3's.
  SELECT EXISTS (
    SELECT 1 FROM public.warehouse_dispatch_lines dl
    WHERE dl.warehouse_stock_id = v_orig.resulting_warehouse_stock_id
  ) INTO v_outlet;

  -- Audited against the ACTOR's own organization, not the holder's - so a
  -- downstream obligation still lands in the initiating authority's trail and
  -- never widens what the holder's organization can see.
  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id,
    entity_label, payload
  ) VALUES (
    p_audit_organization_id, p_actor, p_actor_role,
    'warehouse_transfer.recall_requested', 'warehouse_return_requests',
    v_request.id, v_number,
    jsonb_build_object(
      'original_transfer_line_id', v_orig.id,
      'selector', 'warehouse_transfer_line',
      'direct', v_transfer.route_id IS NULL,
      'outlet_descendant_detected', v_outlet)
  );

  RETURN jsonb_build_object('created', 1, 'reused', 0);
END;
$obligation$;

REVOKE ALL ON FUNCTION public._phoenix_materialize_warehouse_recall_obligation_v1(
  uuid, text, text, uuid, text, uuid) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public._phoenix_materialize_warehouse_recall_obligation_v1(
  uuid, text, text, uuid, text, uuid) IS
  'RETURN-QUARANTINE-RECALL-PARITY-185 (F2): creates or reuses ONE recall '
  'obligation at ONE current holder, from the REAL transfer line that delivered '
  'to that holder. The single obligation writer shared by the root receipt and '
  'every downstream receipt - corridor derivation, M1 header key, cap helpers and '
  'replay rule are identical for both. Checks NO authority: that is anchored once '
  'at the root by the public RPC, and downstream creation is the internal '
  'consequence of it. Internal only.';

-- C2b. The public recall entry point. Root provenance in, counts out.
--
-- R1.5-F2. One authorized root recall now reaches every CURRENT warehouse holder
-- of the recalled provenance, not just the immediate receiver.
--
-- THE LINEAGE EDGE IS REAL PROVENANCE, NOTHING ELSE:
--     root line -> resulting_warehouse_stock_id = S1
--     onward line WHERE source_warehouse_stock_id = S1  -> its own S2
-- Descendants are never discovered by scientific_name, batch, expiry or even
-- material_identity_key: identity is a VALIDATION invariant here, not the edge.
-- A lot that merely looks the same was never part of this delivery.
--
-- CURRENT CUSTODY, NEVER HISTORY. Each holder is sized by the closed C1/C2
-- helpers against its OWN canonical lot, so an intermediate warehouse that
-- forwarded everything downstream receives NO line - its historical
-- received_quantity is not custody - while the downstream holder that actually
-- has the stock receives one. A split delivery produces both, each bounded by
-- its own physical stock row.
--
-- DEPTH. 181 forces every health-sector warehouse to warehouse_kind
-- 'institution' and 184's endpoint guards let only central -> sector main ->
-- facility-bound depot exist, so a depot can never itself be a supply source and
-- the canonical warehouse graph is a strict 3-level DAG: exactly ONE downstream
-- warehouse hop. This walks that hop directly rather than carrying a general
-- recursive engine for a shape the schema cannot produce - but it does NOT
-- assume history is clean: a deeper received descendant that still holds custody
-- fails the whole recall closed rather than being silently truncated.
CREATE OR REPLACE FUNCTION public.phoenix_recall_warehouse_transfer_line(
  p_original_transfer_line_id uuid,
  p_return_number             text,
  p_notes                     text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_number     text := NULLIF(btrim(p_return_number), '');
  v_notes      text := NULLIF(btrim(p_notes), '');
  v_orig       public.warehouse_transfer_lines%ROWTYPE;
  v_transfer   public.warehouse_transfers%ROWTYPE;
  v_root_stock uuid;
  v_identity   text;
  v_lines      uuid[];
  v_moves      uuid[];
  v_id         uuid;
  v_res        jsonb;
  v_created    integer := 0;
  v_reused     integer := 0;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_original_transfer_line_id IS NULL THEN
    RAISE EXCEPTION 'original_transfer_line_id_required' USING ERRCODE = '23514';
  END IF;
  IF v_number IS NULL THEN
    RAISE EXCEPTION 'return_number_required' USING ERRCODE = '23514';
  END IF;

  -- Serialize on the exact obligation identity: selector + external reference.
  -- Two concurrent identical recalls therefore queue, and the second finds the
  -- first's rows inside the lock rather than racing it.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_original_transfer_line_id::text || '|' || v_number, 185001));

  SELECT * INTO v_orig
  FROM public.warehouse_transfer_lines WHERE id = p_original_transfer_line_id FOR UPDATE;
  IF NOT FOUND THEN
    -- Deliberately the SAME token the authority failure raises. A caller must
    -- not be able to tell "no such line" from "not yours" - that difference is
    -- a cross-tenant existence oracle over guessable uuids.
    RAISE EXCEPTION 'forbidden_warehouse_recall' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_transfer
  FROM public.warehouse_transfers WHERE id = v_orig.transfer_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden_warehouse_recall' USING ERRCODE = '42501';
  END IF;

  -- ORIGIN-ANCHORED AUTHORITY, CHECKED EXACTLY ONCE. The sender may recall what
  -- it sent. Both the organization and the warehouse come from the locked
  -- transfer, never from the caller, so there is no id to substitute. Downstream
  -- holders are NOT re-checked against this actor: propagation is the internal
  -- consequence of an authorized safety recall, and grants the actor nothing
  -- inside those organizations.
  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'warehouse_transfer.recall',
    v_transfer.source_organization_id, v_transfer.source_warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_warehouse_recall' USING ERRCODE = '42501';
  END IF;

  SELECT p.role INTO v_actor_role
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  IF v_orig.resulting_warehouse_stock_id IS NULL
     OR COALESCE(v_orig.received_quantity, 0) <= 0 THEN
    RAISE EXCEPTION 'original_line_not_received' USING ERRCODE = '23514';
  END IF;
  v_root_stock := v_orig.resulting_warehouse_stock_id;

  SELECT s.material_identity_key INTO v_identity
  FROM public.warehouse_stock s WHERE s.id = v_root_stock;
  IF v_identity IS NULL THEN
    RAISE EXCEPTION 'canonical_material_identity_unresolved' USING ERRCODE = '23514';
  END IF;

  -- THE OBLIGATION SET: the root receipt plus every REAL received onward
  -- delivery drawn from the root lot. A line only carries custody once its own
  -- lifecycle proves receipt - 'in_transit' has no resulting lot yet and
  -- 'rejected' received nothing, so neither may ever produce an obligation.
  SELECT array_agg(id ORDER BY id) INTO v_lines
  FROM (
    SELECT v_orig.id AS id
    UNION
    SELECT d.id
    FROM public.warehouse_transfer_lines d
    WHERE d.source_warehouse_stock_id = v_root_stock
      AND d.status IN ('received', 'received_with_difference')
      AND COALESCE(d.received_quantity, 0) > 0
      AND d.resulting_warehouse_stock_id IS NOT NULL
  ) s;

  -- INTEGRITY ASSERTIONS over the descendants, before a single row is written.
  FOR v_id IN
    SELECT d.id
    FROM public.warehouse_transfer_lines d
    WHERE d.id = ANY (v_lines) AND d.id <> v_orig.id
    ORDER BY d.id
  LOOP
    -- Canonical identity must survive the hop. A real lineage edge crossing to a
    -- different material is impossible under the movement contracts, so this is
    -- an integrity assertion, not an expected branch.
    IF (SELECT s.material_identity_key FROM public.warehouse_stock s
         JOIN public.warehouse_transfer_lines d ON d.resulting_warehouse_stock_id = s.id
        WHERE d.id = v_id) IS DISTINCT FROM v_identity THEN
      RAISE EXCEPTION 'recall_material_identity_lineage_mismatch' USING ERRCODE = '23514';
    END IF;

    -- HISTORICAL DEPTH SAFETY. The canonical graph cannot produce a third
    -- warehouse hop, but pre-184 history is not guaranteed to obey it. If one
    -- exists AND still holds custody, silently truncating would leave recalled
    -- stock sitting at an unnotified holder - so the whole recall fails closed.
    IF EXISTS (
      SELECT 1
      FROM public.warehouse_transfer_lines t3
      JOIN public.warehouse_transfer_lines d ON d.id = v_id
      JOIN public.warehouse_stock s3 ON s3.id = t3.resulting_warehouse_stock_id
      WHERE t3.source_warehouse_stock_id = d.resulting_warehouse_stock_id
        AND t3.status IN ('received', 'received_with_difference')
        AND COALESCE(t3.received_quantity, 0) > 0
        AND GREATEST(COALESCE(s3.on_hand_quantity, 0) - COALESCE(s3.reserved_quantity, 0), 0) > 0
    ) THEN
      RAISE EXCEPTION 'recall_unsupported_warehouse_lineage_depth' USING ERRCODE = '23514';
    END IF;
  END LOOP;

  -- DETERMINISTIC LOCKING, in the direction Section C and SEND already use:
  -- warehouse_transfer_lines -> warehouse_stock, each ordered by id and taken
  -- one at a time. Two recalls whose descendant sets overlap therefore acquire
  -- the shared rows in the same order and cannot invert. Distinct lots that
  -- merge into one downstream row are exactly the case this protects.
  FOR v_id IN SELECT unnest(v_lines) ORDER BY 1 LOOP
    PERFORM 1 FROM public.warehouse_transfer_lines WHERE id = v_id FOR UPDATE;
  END LOOP;
  FOR v_id IN
    SELECT DISTINCT d.resulting_warehouse_stock_id
    FROM public.warehouse_transfer_lines d
    WHERE d.id = ANY (v_lines) AND d.resulting_warehouse_stock_id IS NOT NULL
    ORDER BY 1
  LOOP
    PERFORM 1 FROM public.warehouse_stock WHERE id = v_id FOR UPDATE;
  END LOOP;

  -- MATERIALIZE. One writer, one holder at a time, in the same deterministic
  -- order. Each call sizes itself against live state, so two descendants that
  -- merged into ONE downstream lot see each other's obligation through the
  -- closed physical budget and cannot both claim the same units.
  FOREACH v_id IN ARRAY v_lines LOOP
    v_res := public._phoenix_materialize_warehouse_recall_obligation_v1(
      v_id, v_number, v_notes, v_actor, v_actor_role, v_transfer.source_organization_id);
    v_created := v_created + COALESCE((v_res->>'created')::integer, 0);
    v_reused  := v_reused  + COALESCE((v_res->>'reused')::integer, 0);
  END LOOP;

  -- ── R1.5-F3. OUTLET CUSTODY ───────────────────────────────────────────────
  -- F2 detected outlet descendants and deliberately did not act on them. F3
  -- follows the schema's OWN proven chain out of every exposed warehouse lot:
  --     lot -> warehouse_dispatch_lines.warehouse_stock_id
  --         -> outlet_stock_movements(movement_type='dispatch_receive')
  --         -> outlet_stock
  -- Identity is a VALIDATION invariant across the hop, never the edge: a lot
  -- that merely looks the same was never part of this delivery.
  SELECT array_agg(m.id ORDER BY m.id) INTO v_moves
  FROM public.outlet_stock_movements m
  JOIN public.warehouse_dispatch_lines dl ON dl.id = m.dispatch_line_id
  WHERE dl.warehouse_stock_id IN (
          SELECT d.resulting_warehouse_stock_id
          FROM public.warehouse_transfer_lines d
          WHERE d.id = ANY (v_lines) AND d.resulting_warehouse_stock_id IS NOT NULL)
    AND m.movement_type = 'dispatch_receive'
    AND dl.status IN ('accepted', 'accepted_with_difference')
    AND COALESCE(dl.received_quantity, 0) > 0
    AND dl.resulting_outlet_stock_id IS NOT NULL
    AND m.outlet_stock_id = dl.resulting_outlet_stock_id;

  IF v_moves IS NOT NULL THEN
    -- Canonical identity must survive the warehouse -> outlet hop. A real
    -- dispatch crossing to a different material is impossible under the movement
    -- contracts, so this is an integrity assertion, not an expected branch.
    IF EXISTS (
      SELECT 1
      FROM public.outlet_stock_movements m
      JOIN public.outlet_stock s ON s.id = m.outlet_stock_id
      WHERE m.id = ANY (v_moves)
        AND s.material_identity_key IS DISTINCT FROM v_identity
    ) THEN
      RAISE EXCEPTION 'recall_material_identity_lineage_mismatch' USING ERRCODE = '23514';
    END IF;

    -- DETERMINISTIC LOCKING, continuing the one direction this transaction has
    -- used throughout and adopting 148/156's canonical inventory ordering:
    --   warehouse_transfer_lines -> warehouse_stock
    --     -> inv_provline advisory -> warehouse_dispatch_lines -> outlet_stock
    -- Every set is ordered, so two recalls whose outlet descendant sets overlap
    -- acquire the shared rows in the same order and cannot invert.
    PERFORM public._phoenix_lock_inventory_resources(
      (SELECT array_agg(DISTINCT 'inv_provline:' || m.dispatch_line_id::text)
         FROM public.outlet_stock_movements m WHERE m.id = ANY (v_moves)));

    FOR v_id IN
      SELECT DISTINCT m.dispatch_line_id FROM public.outlet_stock_movements m
       WHERE m.id = ANY (v_moves) ORDER BY 1
    LOOP
      PERFORM 1 FROM public.warehouse_dispatch_lines WHERE id = v_id FOR UPDATE;
    END LOOP;
    FOR v_id IN
      SELECT DISTINCT m.outlet_stock_id FROM public.outlet_stock_movements m
       WHERE m.id = ANY (v_moves) ORDER BY 1
    LOOP
      PERFORM 1 FROM public.outlet_stock WHERE id = v_id FOR UPDATE;
    END LOOP;

    -- ONE writer, one outlet holder at a time, in the same deterministic order.
    -- Each call sizes itself against live state, so two dispatch receipts that
    -- merged into ONE outlet lot see each other's obligation through the closed
    -- physical budget and cannot both claim the same units.
    FOREACH v_id IN ARRAY v_moves LOOP
      v_res := public._phoenix_materialize_outlet_recall_obligation_v1(
        v_id, v_number, v_notes, v_actor, v_actor_role, v_transfer.source_organization_id);
      v_created := v_created + COALESCE((v_res->>'created')::integer, 0);
      v_reused  := v_reused  + COALESCE((v_res->>'reused')::integer, 0);
    END LOOP;
  END IF;

  -- MINIMAL RESPONSE, unchanged by F2. Counts and the caller's own reference
  -- only: no holder warehouse, organization, facility, stock row, transfer line
  -- or quantity crosses back, and nothing distinguishes a local obligation from
  -- a downstream one. Downstream custodians discover their own obligations
  -- through their existing RLS-scoped return screens.
  RETURN jsonb_build_object(
    'ok', true, 'return_number', v_number,
    'obligations_created', v_created, 'obligations_reused', v_reused);
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_recall_warehouse_transfer_line(uuid, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_recall_warehouse_transfer_line(uuid, text, text)
  TO authenticated;

COMMENT ON FUNCTION public.phoenix_recall_warehouse_transfer_line(uuid, text, text) IS
  'RETURN-QUARANTINE-RECALL-PARITY-185 (F1+F2): recall a prior warehouse receipt '
  'by its REAL transfer line. Authority is warehouse_transfer.recall on the '
  'original SENDER warehouse, checked ONCE, derived from the locked transfer. '
  'Creates the canonical return obligation at the immediate receiver AND at every '
  'CURRENT downstream warehouse holder reached through real transfer provenance, '
  'each returning to its own immediate upstream on its own real delivering line. '
  'Sized per holder from present custody by the closed cap helpers, so an '
  'emptied intermediate gets nothing. Moves no stock and replies with counts '
  'only. Outlet custody is F3.';

-- C3. The two legacy header-only entry points FAIL CLOSED.
--     Their signatures are preserved exactly - they are granted to authenticated
--     and dropping them would be a public surface change - but they can no
--     longer insert an empty draft. They are not redirected either: guessing
--     which material an operator meant is precisely the fabrication this
--     migration exists to prevent, so they name the selector RPC and stop.
CREATE OR REPLACE FUNCTION public.phoenix_recall_warehouse_transfer(
  p_route_id             uuid,
  p_source_warehouse_id  uuid,
  p_return_number        text,
  p_notes                text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'recall_selector_required' USING ERRCODE = '23514',
    DETAIL = 'a recall must name the receipt it recalls; use '
             'phoenix_recall_warehouse_transfer_line(original_transfer_line_id, return_number, notes)';
END;
$$;

CREATE OR REPLACE FUNCTION public.phoenix_recall_direct_warehouse_transfer(
  p_source_warehouse_id      uuid,
  p_destination_warehouse_id uuid,
  p_return_number            text,
  p_notes                    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'recall_selector_required' USING ERRCODE = '23514',
    DETAIL = 'a recall must name the receipt it recalls; use '
             'phoenix_recall_warehouse_transfer_line(original_transfer_line_id, return_number, notes)';
END;
$$;

-- ============================================================================
-- SECTION F3 — OUTLET CUSTODY PROPAGATION (R1.5-F3)
-- ============================================================================
-- F1 bound the immediate warehouse receiver, F2 every current DOWNSTREAM
-- warehouse holder. Neither reached stock that had already left warehouse
-- custody for an OUTLET, and F2 deliberately recorded that fact without acting
-- on it (outlet_descendant_detected). F3 closes it: one authorized root recall
-- now also reaches every CURRENT outlet holder, through the real dispatch
-- provenance and nothing else.
--
-- THE OUTLET EDGE IS THE SCHEMA'S OWN PROVEN CHAIN, not a lookalike:
--     exposed warehouse lot S
--       -> warehouse_dispatch_lines.warehouse_stock_id = S      (a real dispatch)
--       -> outlet_stock_movements WHERE movement_type='dispatch_receive'
--            AND dispatch_line_id = that line                   (a real receipt)
--       -> outlet_stock                                          (current custody)
-- 071's outlet_return_request_lines already REQUIRES exactly these three ids
-- (original_dispatch_line_id, original_inbound_movement_id, source_outlet_stock_id)
-- and pins them to each other with five composite FKs, so a fabricated or
-- mismatched chain cannot be inserted at all. F3 does not invent a graph — it
-- walks the one the schema already proves.

-- ---------------------------------------------------------------------------
-- F3-M2. CORRIDOR-AWARE OUTLET RETURN REFERENCE.
-- ---------------------------------------------------------------------------
-- 071 keyed the external outlet reference ORGANIZATION-WIDE:
--     orr_src_org_number_uniq  UNIQUE (source_organization_id, btrim(return_number))
-- That is the SAME defect M1 removed on the warehouse side, still live here.
-- orr_same_org_chk forces source_organization_id = destination_organization_id,
-- and every outlet of a sector sits in that one organization, so a recall that
-- must reach TWO outlets under ONE operator reference was structurally
-- impossible: the second header raised SQLSTATE 23505.
--
-- A header IS one physical outlet return corridor. 071 built it with no route
-- table at all: orr_point_warehouse_fk pins
--     (distribution_point_id, destination_warehouse_id)
--       -> distribution_points (id, warehouse_id)
-- so the destination warehouse is FUNCTIONALLY DETERMINED by the outlet, and
-- warehouse_dispatches carries the mirror FK — an outlet can only ever be
-- dispatched to from, and return to, that same warehouse. There is no route to
-- disambiguate and no second channel, so the canonical corridor identity is
-- the outlet alone.
--
-- CANONICAL_OUTLET_RETURN_CORRIDOR_IDENTITY
--   distribution_point_id
--
-- destination_warehouse_id and the organization columns are deliberately
-- ABSENT: each is functionally determined by distribution_point_id through an
-- existing FK, so including them would constrain nothing and would re-admit a
-- disambiguator the corridor does not have.
--
-- THE NEW RULE IS STRICTLY WEAKER, so no stored row can fail it: two rows
-- sharing (distribution_point_id, number) necessarily share
-- source_organization_id through orr_point_org_fk, and would already have
-- violated the old index. Forward-replacing it can never abort on legacy data.
--
-- NO MANUAL CONTRACT DEPENDS ON THE OLD SCOPE. phoenix_request_outlet_return
-- neither pre-checks uniqueness nor catches 23505 — the index was the only
-- place the rule lived — and no service, report, test or UI validation asserts
-- organization-global outlet reference uniqueness.
DO $outlet_corridor$
DECLARE
  v_n integer;
BEGIN
  -- Standalone UNIQUE INDEX, not a constraint-backed one: DROP INDEX is the
  -- correct form here and ALTER TABLE ... DROP CONSTRAINT would fail.
  -- Verified, not assumed.
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conindid = (SELECT oid FROM pg_class WHERE relname = 'orr_src_org_number_uniq');
  IF v_n <> 0 THEN
    RAISE EXCEPTION
      '185 (F3/M2): orr_src_org_number_uniq is constraint-backed (% constraints); refusing to DROP INDEX blindly', v_n;
  END IF;

  -- The functional dependency the new key RELIES ON must actually exist. If a
  -- future migration ever drops it, the outlet corridor stops being determined
  -- by the outlet and this key would silently under-constrain.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.outlet_return_requests'::regclass
       AND contype = 'f'
       AND conname = 'orr_point_warehouse_fk'
  ) THEN
    RAISE EXCEPTION
      '185 (F3/M2): orr_point_warehouse_fk is absent; destination_warehouse_id is no longer determined by the outlet and the corridor key would under-constrain';
  END IF;
END;
$outlet_corridor$;

DROP INDEX IF EXISTS public.orr_src_org_number_uniq;

CREATE UNIQUE INDEX IF NOT EXISTS orr_corridor_number_uniq
  ON public.outlet_return_requests (distribution_point_id, btrim(return_number));

COMMENT ON INDEX public.orr_corridor_number_uniq IS
  'RETURN-QUARANTINE-RECALL-PARITY-185 (F3/M2): one external return reference names '
  'ONE outlet return corridor, not one organization. Forward-replaces 071''s '
  'orr_src_org_number_uniq, which could not represent one recall reaching TWO outlets '
  'of the same institution - orr_same_org_chk puts every outlet of a sector in one '
  'organization. destination_warehouse_id and the organization columns are omitted '
  'because orr_point_warehouse_fk and orr_point_org_fk already determine them from '
  'the outlet, and 071 has no route table, so the outlet alone IS the corridor. '
  'Strictly weaker than the rule it replaces, so no stored row can fail it.';

-- ---------------------------------------------------------------------------
-- F3-C1. THE CANONICAL OUTLET OUTSTANDING-COMMITMENT PREDICATE, private.
-- ---------------------------------------------------------------------------
-- The exact counterpart of F1-C2's warehouse predicate, and it exists for the
-- same reason: recall SIZING and review ARBITRATION must never carry two
-- hand-written censuses of "what still consumes this outlet shelf".
--
-- TWO GROUPING KEYS, because two independent resources are committed:
--   PROVENANCE, keyed by original_dispatch_line_id
--     How much of THIS dispatch receipt may ever travel back.
--   PHYSICAL, keyed by source_outlet_stock_id
--     How much stock the outlet actually holds. 150's canonical identity legally
--     merges several DISTINCT dispatch receipts into ONE outlet_stock row, so
--     obligations anchored to different provenance still compete for one balance.
--
-- ONE TERMINAL VOCABULARY, taken from orrl_status_qty_consistency_chk rather
-- than assumed: 'rejected' (approved 0, fulfilled 0), 'cancelled' (fulfilled 0)
-- and 'fulfilled' (fulfilled = approved) are dead; everything else can still
-- reach SEND and therefore still consumes the shelf. Filtering by STATUS and
-- never by arithmetic alone matters here exactly as it does at 069: a cancelled
-- line keeps a non-NULL approved_quantity.
--
-- TWO SCOPES, mirroring F1-C2 for the same measured reason:
--   'all_actionable'      every live line. What RECALL SIZING must respect - an
--                         obligation the database sizes ITSELF must be truthful
--                         the moment it is written.
--   'committed_or_recall' approved/partially_fulfilled of any reason, PLUS
--                         pending RECALLS. What REVIEW ARBITRATION respects: a
--                         pending manual return is a REQUEST review exists to
--                         arbitrate first-come-first-served, and counting every
--                         pending line there would make two competing manual
--                         requests block each other with no tie-break. A pending
--                         RECALL is different in kind - an origin-issued,
--                         already-custody-bounded instruction - so it outranks a
--                         routine holder-initiated return.
CREATE OR REPLACE FUNCTION public._phoenix_outlet_return_outstanding_v1(
  p_source_outlet_stock_id    uuid,
  p_original_dispatch_line_id uuid,
  p_exclude_line_ids          uuid[] DEFAULT NULL,
  p_scope                     text   DEFAULT 'all_actionable'
)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $outlet_outstanding$
DECLARE
  v_total integer;
BEGIN
  -- Both keys NULL would silently total every outlet return line in the database.
  IF p_source_outlet_stock_id IS NULL AND p_original_dispatch_line_id IS NULL THEN
    RAISE EXCEPTION 'outlet_return_outstanding_requires_a_grouping_key' USING ERRCODE = '23514';
  END IF;
  IF p_scope IS NULL OR p_scope NOT IN ('all_actionable', 'committed_or_recall') THEN
    RAISE EXCEPTION 'outlet_return_outstanding_unknown_scope' USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(sum(
           GREATEST(COALESCE(l.approved_quantity, l.requested_quantity) - l.fulfilled_quantity, 0)
         ), 0)::integer
    INTO v_total
  FROM public.outlet_return_request_lines l
  JOIN public.outlet_return_requests r ON r.id = l.return_request_id
  WHERE l.status NOT IN ('rejected', 'cancelled', 'fulfilled')
    AND r.status NOT IN ('rejected', 'cancelled')
    AND (p_source_outlet_stock_id IS NULL
         OR l.source_outlet_stock_id = p_source_outlet_stock_id)
    AND (p_original_dispatch_line_id IS NULL
         OR l.original_dispatch_line_id = p_original_dispatch_line_id)
    -- THE CURRENT-LINE EXCLUSION. Review passes the exact lines it is deciding;
    -- without this every review would count itself and self-block.
    AND (p_exclude_line_ids IS NULL OR NOT (l.id = ANY (p_exclude_line_ids)))
    AND (p_scope = 'all_actionable'
         OR l.status <> 'pending'
         OR l.reason_code = 'recalled');

  RETURN v_total;
END;
$outlet_outstanding$;

REVOKE ALL ON FUNCTION public._phoenix_outlet_return_outstanding_v1(uuid, uuid, uuid[], text)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public._phoenix_outlet_return_outstanding_v1(uuid, uuid, uuid[], text) IS
  'RETURN-QUARANTINE-RECALL-PARITY-185 (F3/C1): the SINGLE definition of an '
  'outstanding OUTLET-return commitment - the exact counterpart of F1-C2''s '
  'warehouse predicate. One terminal vocabulary (line rejected/cancelled/fulfilled, '
  'request rejected/cancelled), one quantity expression (COALESCE(approved, '
  'requested) - fulfilled), two grouping keys (provenance by '
  'original_dispatch_line_id, physical by source_outlet_stock_id) and an explicit '
  'exclusion set for the lines a review is currently deciding. Internal only.';

-- ---------------------------------------------------------------------------
-- F3-H1. CANONICAL OUTLET SUGGESTION COMMITMENT, private.
-- ---------------------------------------------------------------------------
-- R1.5-H1. Migration 150's outlet review cap already subtracts live
-- inventory-suggestion commitments, but recall SIZING did not - so a recall could
-- be created asking for more than review could ever truthfully approve. This is
-- the ONE place the outlet-return domain reads the suggestion model, and every
-- quantity decision is delegated to 149's
-- phoenix_inventory_suggestion_commitments; none of its arithmetic is
-- reimplemented here.
--
-- WHY DE-DUPLICATION IS MANDATORY. For an ACCEPTED suggestion, 149 derives the
-- commitment FROM the linked outlet_return_request_lines row, and that same row
-- is ALREADY counted by _phoenix_outlet_return_outstanding_v1. Counting both
-- would double-subtract and under-size every recall. Only commitments carrying
-- no live line of their own are added here - open_fresh (no draft line exists at
-- all), lineage_missing and legacy_unresolved. That is precisely the set the
-- outstanding predicate is structurally blind to.
--
-- TWO KEYS, one per budget it serves:
--   PROVENANCE  p_dispatch_line_id -> s.provenance_dispatch_line_id, summing
--               c.provenance_commitment, exactly as the review cap does.
--   PHYSICAL    p_outlet_stock_id  -> s.source_stock_id, summing
--               c.source_commitment: the units still to LEAVE that shelf.
--               source_commitment deliberately excludes in-transit units, which
--               SEND has already debited from on_hand and which must therefore
--               never be subtracted from available_quantity a second time.
CREATE OR REPLACE FUNCTION public._phoenix_outlet_suggestion_commitment_v1(
  p_dispatch_line_id uuid   DEFAULT NULL,
  p_outlet_stock_id  uuid   DEFAULT NULL,
  p_exclude_line_ids uuid[] DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $outlet_suggestion_commitment$
DECLARE
  v_total integer;
BEGIN
  -- Both keys NULL would total every outlet suggestion in the database.
  IF p_dispatch_line_id IS NULL AND p_outlet_stock_id IS NULL THEN
    RAISE EXCEPTION 'outlet_suggestion_commitment_requires_a_grouping_key'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(sum(
           CASE WHEN p_dispatch_line_id IS NOT NULL
                THEN c.provenance_commitment
                ELSE c.source_commitment END
         ), 0)::integer
    INTO v_total
  FROM public.inventory_transfer_suggestions s
  CROSS JOIN LATERAL public.phoenix_inventory_suggestion_commitments(s.id) c
  WHERE s.route_kind = 'outlet_to_warehouse'
    AND c.is_active
    AND (p_dispatch_line_id IS NULL
         OR s.provenance_dispatch_line_id = p_dispatch_line_id)
    AND (p_outlet_stock_id IS NULL
         OR s.source_stock_id = p_outlet_stock_id)
    -- The lines a review is currently deciding replace, rather than add to,
    -- their own linked suggestion commitment.
    AND NOT COALESCE((
      s.draft_outlet_return_request_line_id
        = ANY (COALESCE(p_exclude_line_ids, ARRAY[]::uuid[]))
    ), false)
    -- DE-DUPLICATION, per the contract above.
    AND NOT EXISTS (
      SELECT 1
      FROM public.outlet_return_request_lines l
      JOIN public.outlet_return_requests h ON h.id = l.return_request_id
      WHERE l.id = s.draft_outlet_return_request_line_id
        AND l.status NOT IN ('rejected', 'cancelled', 'fulfilled')
        AND h.status NOT IN ('rejected', 'cancelled')
    );

  RETURN v_total;
END;
$outlet_suggestion_commitment$;

REVOKE ALL ON FUNCTION public._phoenix_outlet_suggestion_commitment_v1(uuid, uuid, uuid[])
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public._phoenix_outlet_suggestion_commitment_v1(uuid, uuid, uuid[]) IS
  'RETURN-QUARANTINE-RECALL-PARITY-185 (F3/H1): the SINGLE reader of the '
  'inventory-suggestion model for the outlet-return domain. Sums 149''s canonical '
  'phoenix_inventory_suggestion_commitments for live outlet_to_warehouse '
  'suggestions, keyed EITHER by provenance (provenance_dispatch_line_id -> '
  'provenance_commitment) OR by physical lot (source_stock_id -> '
  'source_commitment). Suggestions already visible as a live outlet return line '
  'are skipped, because _phoenix_outlet_return_outstanding_v1 counts those rows '
  'already and double-subtraction would under-size every recall. Reimplements no '
  'suggestion arithmetic. Internal only.';

-- ---------------------------------------------------------------------------
-- F3-C2. TRUTHFUL OUTLET EXPOSURE for ONE real inbound receipt, private.
-- ---------------------------------------------------------------------------
-- Receives an ALREADY-DERIVED, already-locked inbound movement id and answers
-- one question: how much of that receipt is still truthfully recallable RIGHT
-- NOW. Same two-budget shape as F1-C1, over the outlet's own resources.
--
-- CURRENT CUSTODY ONLY. outlet_stock.available_quantity is a GENERATED column
-- (on_hand_quantity - reserved_quantity), so quantity already dispensed to a
-- patient, already consumed, already reserved or already returned is simply not
-- in it. Patient dispensing is terminal physical consumption and leaves nothing
-- to recall - that falls out of the arithmetic rather than needing a special case.
CREATE OR REPLACE FUNCTION public._phoenix_outlet_recall_exposure_v1(
  p_original_inbound_movement_id uuid,
  p_holder_organization_id       uuid
)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $outlet_exposure$
DECLARE
  v_move       public.outlet_stock_movements%ROWTYPE;
  v_disp       public.warehouse_dispatch_lines%ROWTYPE;
  v_committed  integer;
  v_other_phys integer;
  v_available  integer;
  v_prov       integer;
  v_phys       integer;
  -- R1.5-H1 additions. Nothing above is altered; these only ADD subtractions.
  v_sugg_prov  integer;
  v_sugg_phys  integer;
BEGIN
  SELECT * INTO v_move
  FROM public.outlet_stock_movements WHERE id = p_original_inbound_movement_id;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  -- Only a genuine dispatch receipt carries returnable provenance. This is the
  -- same single credit type orrl_inbound_movement_type_fk pins the line to, so a
  -- movement of any other type can never become an obligation.
  IF v_move.movement_type <> 'dispatch_receive' OR v_move.dispatch_line_id IS NULL THEN
    RETURN 0;
  END IF;

  -- The lot must belong to the holder we are about to bind. 071's
  -- 'original_dispatch_line_not_at_this_outlet' IDOR check, kept intact.
  IF v_move.organization_id IS DISTINCT FROM p_holder_organization_id THEN
    RETURN 0;
  END IF;

  SELECT * INTO v_disp
  FROM public.warehouse_dispatch_lines WHERE id = v_move.dispatch_line_id;
  IF NOT FOUND
     OR v_disp.status NOT IN ('accepted', 'accepted_with_difference')
     OR v_disp.resulting_outlet_stock_id IS DISTINCT FROM v_move.outlet_stock_id
     OR COALESCE(v_disp.received_quantity, 0) <= 0 THEN
    RETURN 0;
  END IF;

  -- ── PROVENANCE BUDGET, keyed by warehouse_dispatch_lines.id ───────────────
  -- 156's returnable cap (received - returned), less every commitment already
  -- outstanding against this same receipt, through the shared predicate.
  v_committed := public._phoenix_outlet_return_outstanding_v1(
    NULL, v_disp.id, NULL, 'all_actionable');

  -- R1.5-H1. The review cap has always ALSO subtracted live inventory-suggestion
  -- commitments on this provenance. Sizing that ignored them manufactured an
  -- obligation already known to be unhonourable at the moment it was created.
  -- Only the commitments the outstanding predicate is blind to are added.
  v_sugg_prov := public._phoenix_outlet_suggestion_commitment_v1(
    v_disp.id, NULL, NULL);

  v_prov := GREATEST(
    COALESCE(v_disp.received_quantity, 0) - v_disp.returned_quantity
      - v_committed - v_sugg_prov, 0);

  -- ── PHYSICAL BUDGET, keyed by outlet_stock.id ─────────────────────────────
  -- Every live obligation resolving to this canonical outlet lot, across ALL
  -- provenance anchors and ALL return numbers. This is what makes the budget
  -- GLOBAL to the stock row when several dispatch receipts merged into it.
  v_other_phys := public._phoenix_outlet_return_outstanding_v1(
    v_move.outlet_stock_id, NULL, NULL, 'all_actionable');

  -- R1.5-H1. An outlet_to_warehouse suggestion is a promise to move units OFF
  -- THIS SHELF, so it consumes current physical custody exactly as a return line
  -- does - and 150's canonical identity can merge several dispatch receipts into
  -- one lot, so a suggestion anchored on a DIFFERENT provenance still draws on
  -- the same physical stock. Keyed by source_stock_id, it closes that.
  v_sugg_phys := public._phoenix_outlet_suggestion_commitment_v1(
    NULL, v_move.outlet_stock_id, NULL);

  SELECT GREATEST(COALESCE(s.available_quantity, 0), 0)
    INTO v_available
  FROM public.outlet_stock s WHERE s.id = v_move.outlet_stock_id;

  v_phys := GREATEST(COALESCE(v_available, 0) - v_other_phys - v_sugg_phys, 0);

  -- BOTH must hold. A full outlet shelf does not authorize returning more of a
  -- dispatch than was received on it.
  RETURN LEAST(v_prov, v_phys);
END;
$outlet_exposure$;

REVOKE ALL ON FUNCTION public._phoenix_outlet_recall_exposure_v1(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public._phoenix_outlet_recall_exposure_v1(uuid, uuid) IS
  'RETURN-QUARANTINE-RECALL-PARITY-185 (F3/C2): private truthful-exposure cap for a '
  'single prior OUTLET receipt, the counterpart of F1-C1. PROVENANCE by '
  'warehouse_dispatch_lines.id (received - returned - live commitments) and PHYSICAL '
  'by outlet_stock.id (available_quantity - live obligations on that lot from ANY '
  'provenance and ANY reference). Returns their LEAST. available_quantity is the '
  'GENERATED on_hand - reserved, so dispensed, consumed and reserved units are '
  'already excluded - patient dispensing is terminal and needs no special case. '
  'Not granted to any client role.';

-- ---------------------------------------------------------------------------
-- F3-C3. ONE OUTLET OBLIGATION AT ONE CURRENT HOLDER, private.
-- ---------------------------------------------------------------------------
-- The single outlet obligation writer, shared by root warehouse propagation and
-- by the standalone outlet selector RPC, exactly as F2's writer is shared by the
-- root receipt and every downstream warehouse holder. F3 must not grow a
-- parallel writer whose corridor, caps or replay rule can drift.
--
-- IT DOES NOT CHECK AUTHORITY. For root propagation, authority is anchored ONCE
-- at the ORIGINAL warehouse sender; the outlet obligation is the internal
-- consequence of that authorized safety recall, and the initiating actor is
-- never required to hold outlet permissions and is never granted any. The
-- standalone RPC does its own check before calling here.
CREATE OR REPLACE FUNCTION public._phoenix_materialize_outlet_recall_obligation_v1(
  p_inbound_movement_id    uuid,
  p_return_number          text,
  p_notes                  text,
  p_actor                  uuid,
  p_actor_role             text,
  p_audit_organization_id  uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $outlet_obligation$
DECLARE
  v_number   text := p_return_number;
  v_notes    text := p_notes;
  v_move     public.outlet_stock_movements%ROWTYPE;
  v_disp     public.warehouse_dispatch_lines%ROWTYPE;
  v_stock    public.outlet_stock%ROWTYPE;
  v_point    public.distribution_points%ROWTYPE;
  v_exposure integer;
  v_request  public.outlet_return_requests%ROWTYPE;
  v_line_id  uuid;
  v_existing uuid;
BEGIN
  SELECT * INTO v_move
  FROM public.outlet_stock_movements WHERE id = p_inbound_movement_id;
  IF NOT FOUND
     OR v_move.movement_type <> 'dispatch_receive'
     OR v_move.dispatch_line_id IS NULL THEN
    RAISE EXCEPTION 'forbidden_outlet_recall' USING ERRCODE = '42501';
  END IF;

  -- THE CANONICAL LOCK ORDER, taken exactly as 156's add-line path establishes
  -- it: the inv_provline advisory key first, then the dispatch line, then the
  -- outlet lot. Re-acquiring a lock this transaction already holds never blocks,
  -- and keeps this helper correct when called on its own.
  PERFORM public._phoenix_lock_inventory_resources(ARRAY[
    'inv_provline:' || v_move.dispatch_line_id::text
  ]);

  SELECT * INTO v_disp
  FROM public.warehouse_dispatch_lines WHERE id = v_move.dispatch_line_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden_outlet_recall' USING ERRCODE = '42501';
  END IF;

  -- Provenance must be REAL and RECEIVED before anything is written.
  IF v_disp.status NOT IN ('accepted', 'accepted_with_difference')
     OR v_disp.resulting_outlet_stock_id IS NULL
     OR COALESCE(v_disp.received_quantity, 0) <= 0 THEN
    RAISE EXCEPTION 'original_dispatch_line_not_a_completed_receipt' USING ERRCODE = '23514';
  END IF;
  IF v_disp.resulting_outlet_stock_id IS DISTINCT FROM v_move.outlet_stock_id THEN
    RAISE EXCEPTION 'outlet_recall_provenance_chain_mismatch' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_stock
  FROM public.outlet_stock WHERE id = v_move.outlet_stock_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden_outlet_recall' USING ERRCODE = '42501';
  END IF;
  IF v_stock.material_identity_key IS NULL THEN
    RAISE EXCEPTION 'canonical_material_identity_unresolved' USING ERRCODE = '23514';
  END IF;

  -- The corridor: this outlet returns to the warehouse its own row names. 071
  -- has no route table, and warehouse_dispatches carries the mirror FK, so the
  -- outlet that received the dispatch necessarily returns to the warehouse that
  -- sent it. Nothing is chosen here and nothing is invented.
  SELECT * INTO v_point
  FROM public.distribution_points WHERE id = v_stock.distribution_point_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden_outlet_recall' USING ERRCODE = '42501';
  END IF;
  IF v_point.warehouse_id IS NULL THEN
    RAISE EXCEPTION 'distribution_point_has_no_return_warehouse' USING ERRCODE = '23514';
  END IF;

  -- REPLAY. An obligation is identified by its truthful provenance, its external
  -- reference AND its corridor - never by return_number alone. Applied PER
  -- HOLDER, so a replayed root recall reuses every outlet obligation independently.
  SELECT l.id INTO v_existing
  FROM public.outlet_return_request_lines l
  JOIN public.outlet_return_requests r ON r.id = l.return_request_id
  WHERE l.original_inbound_movement_id = v_move.id
    AND btrim(r.return_number) = v_number
    -- F3-M2: the FULL canonical corridor identity, matching
    -- orr_corridor_number_uniq exactly.
    AND r.distribution_point_id = v_point.id
    AND l.reason_code = 'recalled'
    AND l.status NOT IN ('rejected', 'cancelled')
    AND r.status NOT IN ('rejected', 'cancelled')
  ORDER BY l.created_at
  LIMIT 1;

  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('created', 0, 'reused', 1);
  END IF;

  v_exposure := public._phoenix_outlet_recall_exposure_v1(v_move.id, v_stock.organization_id);

  -- Nothing left to recall is a legitimate, non-exceptional outcome: the stock
  -- may already be dispensed, returned, reserved or committed. A zero-quantity
  -- line is forbidden by orrl_requested_qty_chk anyway, and an empty header is
  -- the very defect this section removes.
  IF v_exposure <= 0 THEN
    RETURN jsonb_build_object('created', 0, 'reused', 0);
  END IF;

  -- ONE EXTERNAL REFERENCE, ONE HEADER PER OUTLET CORRIDOR (F3-M2).
  --   HEADER-CREATION RACE. The locks above are on the dispatch line and the
  --   outlet lot, so none of them serializes two DIFFERENT selectors converging
  --   on the same outlet and reference - precisely the pair that competes for
  --   orr_corridor_number_uniq. This advisory lock closes that, keyed on the
  --   same identity the index uses.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_point.id::text || '|' || v_number, 185004));

  SELECT * INTO v_request
  FROM public.outlet_return_requests
  WHERE distribution_point_id = v_point.id
    AND btrim(return_number) = v_number
  FOR UPDATE;

  IF FOUND THEN
    -- Only a DRAFT may still accept lines; anything further along is a document
    -- already in review or flight and must not be silently reopened.
    IF v_request.status <> 'draft' THEN
      RAISE EXCEPTION 'return_request_not_draft' USING ERRCODE = '23514';
    END IF;
    -- DEFENCE IN DEPTH. The lookup already pins the whole corridor, so a
    -- mismatch is unreachable by construction; the assertion stays as a backstop
    -- against a future loosening of the predicate above.
    IF v_request.destination_warehouse_id IS DISTINCT FROM v_point.warehouse_id THEN
      RAISE EXCEPTION 'recall_reference_corridor_mismatch' USING ERRCODE = '23514';
    END IF;
  ELSE
    INSERT INTO public.outlet_return_requests (
      distribution_point_id, source_organization_id,
      destination_warehouse_id, destination_organization_id,
      return_number, status, requested_by_side, notes, created_by
    ) VALUES (
      v_point.id, v_stock.organization_id,
      v_point.warehouse_id, v_stock.organization_id,
      v_number, 'draft', 'sender', v_notes, p_actor
    )
    RETURNING * INTO v_request;
  END IF;

  -- The line names the REAL receipt on all three legs. Every descriptive column
  -- is copied from the locked outlet lot, exactly as 156's add-line path copies
  -- them, so the snapshot cannot drift from the provenance it claims.
  INSERT INTO public.outlet_return_request_lines (
    return_request_id, source_organization_id,
    original_dispatch_line_id, original_inbound_movement_id,
    original_inbound_movement_type, source_outlet_stock_id,
    scientific_name, concentration, dosage_form, unit, national_code,
    batch_number, internal_batch_reference, expiry_date,
    reason_code, reason_text, requested_quantity
  ) VALUES (
    v_request.id, v_request.source_organization_id,
    v_disp.id, v_move.id,
    'dispatch_receive', v_stock.id,
    v_stock.scientific_name, v_stock.concentration, v_stock.dosage_form, v_stock.unit,
    v_stock.national_code, v_stock.batch_number, v_stock.internal_batch_reference,
    v_stock.expiry_date,
    'recalled', v_notes, v_exposure
  )
  RETURNING id INTO v_line_id;

  -- Audited against the ACTOR's own organization, not the holder's - so an
  -- outlet obligation still lands in the initiating authority's trail and never
  -- widens what the holder's organization can see.
  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id,
    entity_label, payload
  ) VALUES (
    p_audit_organization_id, p_actor, p_actor_role,
    'outlet_stock.recall_requested', 'outlet_return_requests',
    v_request.id, v_number,
    jsonb_build_object(
      'original_inbound_movement_id', v_move.id,
      'original_dispatch_line_id', v_disp.id,
      'selector', 'outlet_inbound_movement')
  );

  RETURN jsonb_build_object('created', 1, 'reused', 0);
END;
$outlet_obligation$;

REVOKE ALL ON FUNCTION public._phoenix_materialize_outlet_recall_obligation_v1(
  uuid, text, text, uuid, text, uuid) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public._phoenix_materialize_outlet_recall_obligation_v1(
  uuid, text, text, uuid, text, uuid) IS
  'RETURN-QUARANTINE-RECALL-PARITY-185 (F3/C3): creates or reuses ONE recall '
  'obligation at ONE current OUTLET holder, from the REAL dispatch_receive movement '
  'that delivered to it. The single outlet obligation writer shared by root '
  'warehouse propagation and by the standalone outlet selector RPC. The corridor is '
  'derived, never chosen: 071 has no route table and the outlet''s own warehouse_id '
  'is the destination. Checks NO authority - root propagation anchors it once at the '
  'original warehouse sender, and the standalone RPC checks before calling. Internal only.';

-- ---------------------------------------------------------------------------
-- F3-C4. The public OUTLET recall entry point. Real inbound receipt in, counts out.
-- ---------------------------------------------------------------------------
-- The strongest selector the schema offers: outlet_stock_movements.id of the
-- genuine 'dispatch_receive' credit. Every other id - organization, warehouse,
-- distribution point, outlet_stock, dispatch line, material, quantity - is
-- DERIVED from it server-side, so there is nothing for a caller to substitute.
CREATE OR REPLACE FUNCTION public.phoenix_recall_outlet_inbound_movement(
  p_original_inbound_movement_id uuid,
  p_return_number                text,
  p_notes                        text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_number     text := NULLIF(btrim(p_return_number), '');
  v_notes      text := NULLIF(btrim(p_notes), '');
  v_move       public.outlet_stock_movements%ROWTYPE;
  v_stock      public.outlet_stock%ROWTYPE;
  v_point      public.distribution_points%ROWTYPE;
  v_res        jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_original_inbound_movement_id IS NULL THEN
    RAISE EXCEPTION 'original_inbound_movement_id_required' USING ERRCODE = '23514';
  END IF;
  IF v_number IS NULL THEN
    RAISE EXCEPTION 'return_number_required' USING ERRCODE = '23514';
  END IF;

  -- Serialize on the exact obligation identity: selector + external reference.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_original_inbound_movement_id::text || '|' || v_number, 185003));

  SELECT * INTO v_move
  FROM public.outlet_stock_movements WHERE id = p_original_inbound_movement_id;
  IF NOT FOUND THEN
    -- Deliberately the SAME token the authority failure raises. A caller must
    -- not be able to tell "no such movement" from "not yours".
    RAISE EXCEPTION 'forbidden_outlet_recall' USING ERRCODE = '42501';
  END IF;
  IF v_move.movement_type <> 'dispatch_receive' OR v_move.dispatch_line_id IS NULL THEN
    RAISE EXCEPTION 'forbidden_outlet_recall' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_stock
  FROM public.outlet_stock WHERE id = v_move.outlet_stock_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden_outlet_recall' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_point
  FROM public.distribution_points WHERE id = v_stock.distribution_point_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden_outlet_recall' USING ERRCODE = '42501';
  END IF;
  -- R1.5-H1(B). AUTHORITY FIRST, BUSINESS STATE SECOND.
  --   The two 23514 branches below used to sit HERE, ahead of this check, which
  --   made them an oracle: an unauthorized caller who guessed a real foreign
  --   movement learned from 'distribution_point_inactive' that the movement
  --   existed, was a genuine dispatch_receive, and that its outlet was
  --   deactivated - detail a nonexistent id never produced. Every pre-authority
  --   failure must now be the SAME generic token.
  --
  --   Moving them is safe in both directions. This helper resolves scope against
  --   the WAREHOUSE (it requires warehouses.status = 'active'), never against the
  --   distribution point, so a deactivated point does not change the answer and a
  --   legitimately-scoped operator still reaches its specific business error
  --   below. It also compares p_organization_id against the caller's own
  --   organization before anything else, so a foreign actor is refused here
  --   regardless of the point's state - which is what closes the cross-tenant
  --   oracle. A NULL warehouse_id degenerates to the organization-wide branch
  --   rather than widening anything: an operational role that must name its
  --   resource is still refused.
  --
  -- THE EXISTING canonical outlet recall authority, unchanged from 071: the
  -- institution recalls from its own outlet, scoped at the warehouse that owns
  -- that outlet. Both ids come from the derived rows, never from the caller.
  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'outlet_stock.recall', v_point.organization_id, v_point.warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_outlet_recall' USING ERRCODE = '42501';
  END IF;

  SELECT p.role INTO v_actor_role
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  -- Only now, to a caller already proven to hold outlet_stock.recall on this
  -- outlet's own warehouse, are the specific integrity failures disclosed.
  -- Nothing is weakened for an authorized caller: both refusals still stand
  -- before any header, line, movement or audit row is written.
  IF v_point.status <> 'active' THEN
    RAISE EXCEPTION 'distribution_point_inactive' USING ERRCODE = '23514';
  END IF;
  IF v_point.warehouse_id IS NULL THEN
    RAISE EXCEPTION 'distribution_point_has_no_return_warehouse' USING ERRCODE = '23514';
  END IF;

  v_res := public._phoenix_materialize_outlet_recall_obligation_v1(
    v_move.id, v_number, v_notes, v_actor, v_actor_role, v_point.organization_id);

  -- MINIMAL RESPONSE, the same shape F1/F2 already use. Counts and the caller's
  -- own reference only: no outlet, warehouse, organization, stock, movement or
  -- dispatch id crosses back.
  RETURN jsonb_build_object(
    'ok', true, 'return_number', v_number,
    'obligations_created', COALESCE((v_res->>'created')::integer, 0),
    'obligations_reused',  COALESCE((v_res->>'reused')::integer, 0));
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_recall_outlet_inbound_movement(uuid, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_recall_outlet_inbound_movement(uuid, text, text)
  TO authenticated;

COMMENT ON FUNCTION public.phoenix_recall_outlet_inbound_movement(uuid, text, text) IS
  'RETURN-QUARANTINE-RECALL-PARITY-185 (F3): recall a prior OUTLET receipt by its '
  'REAL dispatch_receive movement. Authority is 071''s existing outlet_stock.recall '
  'on the warehouse that owns the outlet, derived from the selected movement and '
  'never supplied by the caller. Creates the canonical outlet return obligation '
  'sized to CURRENT outlet custody by the closed cap helpers, moves no stock and '
  'replies with counts only.';

-- ---------------------------------------------------------------------------
-- F3-C5. The legacy header-only outlet recall FAILS CLOSED.
--        Its signature is preserved exactly - it is granted to authenticated and
--        dropping it would be a public surface change - but it can no longer
--        insert an empty, unprovenanced draft. It is not redirected either:
--        guessing which receipt an operator meant is precisely the fabrication
--        this migration exists to prevent, so it names the selector RPC and stops
--        BEFORE any header, line, movement or audit row is written.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phoenix_recall_outlet_stock(
  p_distribution_point_id uuid,
  p_return_number         text,
  p_notes                 text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'recall_selector_required' USING ERRCODE = '23514',
    DETAIL = 'a recall must name the receipt it recalls; use '
             'phoenix_recall_outlet_inbound_movement(original_inbound_movement_id, return_number, notes)';
END;
$$;

COMMENT ON FUNCTION public.phoenix_recall_outlet_stock(uuid, text, text) IS
  'RETURN-QUARANTINE-RECALL-PARITY-185 (F3): FAILS CLOSED. 071''s header-only outlet '
  'recall created an empty draft with no provenance at all. The historical signature '
  'is preserved (it is granted to authenticated), but the body now raises '
  'recall_selector_required before ANY mutation - no header, no line, no movement, no '
  'audit row. Use phoenix_recall_outlet_inbound_movement.';

-- ---------------------------------------------------------------------------
-- F3-C6. THE OUTLET REVIEW CAP GAINS ITS PHYSICAL BUDGET AND RECALL PRECEDENCE.
-- ---------------------------------------------------------------------------
-- Forward-replacement of Migration 150's validator. EVERY line of 150's
-- arithmetic is preserved verbatim - the inv_suggest/inv_provline lock set, the
-- suggestion-commitment term from phoenix_inventory_suggestion_commitments, the
-- approved/partially_fulfilled line term with its suggestion de-duplication, the
-- proposed term and the dispatch-provenance remaining budget. F3 ADDS exactly
-- two things and removes nothing:
--   1. pending RECALL commitments consume provenance (warehouse C2's precedence,
--      applied to outlets);
--   2. a PHYSICAL budget grouped by outlet_stock, which 150 never had - without
--      it two approvals anchored to different dispatch receipts that merged into
--      one outlet lot could each pass and still overdraw the shelf.
-- Both are additional refusals, so nothing previously refused becomes allowed.
CREATE OR REPLACE FUNCTION public._phoenix_validate_outlet_return_review_cap_v1(
  p_return_request_id uuid,
  p_decisions jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_request public.outlet_return_requests%ROWTYPE;
  v_decision jsonb;
  v_line public.outlet_return_request_lines%ROWTYPE;
  v_line_ids uuid[];
  v_provenance_ids uuid[];
  v_suggestion_ids uuid[];
  v_keys text[];
  v_provenance_id uuid;
  v_approved integer;
  v_physical_remaining integer;
  v_suggestion_commitment integer;
  v_line_commitment integer;
  v_proposed_commitment integer;
  -- R1.5-F3-C6 additions. Nothing above is altered; these only ADD refusals.
  v_recall_commitment integer;
  v_stock_ids uuid[];
  v_stock_id uuid;
  v_phys_available integer;
  v_phys_other integer;
  v_phys_proposed integer;
  v_phys_suggestion integer;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE='28000';
  END IF;
  IF p_return_request_id IS NULL THEN
    RAISE EXCEPTION 'return_request_id_required' USING ERRCODE='23514';
  END IF;
  IF p_decisions IS NULL OR jsonb_typeof(p_decisions)<>'array' THEN
    RAISE EXCEPTION 'decisions_must_be_an_array' USING ERRCODE='23514';
  END IF;

  -- Optimistic discovery only. No row lock is taken before the complete,
  -- sorted canonical resource set is known.
  SELECT * INTO v_request
  FROM public.outlet_return_requests
  WHERE id=p_return_request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_request_not_found' USING ERRCODE='P0002';
  END IF;

  SELECT array_agg(DISTINCT x.line_id ORDER BY x.line_id)
  INTO v_line_ids
  FROM (
    SELECT (d.value->>'line_id')::uuid AS line_id
    FROM jsonb_array_elements(p_decisions) d(value)
  ) x;

  SELECT array_agg(DISTINCT l.original_dispatch_line_id
                   ORDER BY l.original_dispatch_line_id)
  INTO v_provenance_ids
  FROM public.outlet_return_request_lines l
  WHERE l.return_request_id=p_return_request_id
    AND l.id=ANY(COALESCE(v_line_ids,ARRAY[]::uuid[]));

  SELECT array_agg(k ORDER BY k) INTO v_keys
  FROM (
    SELECT 'inv_suggest:' || v_request.source_organization_id::text AS k
    UNION
    SELECT 'inv_suggest:' || v_request.destination_organization_id::text
    UNION
    SELECT 'inv_provline:' || p::text
    FROM unnest(COALESCE(v_provenance_ids,ARRAY[]::uuid[])) p
  ) resources;
  PERFORM public._phoenix_lock_inventory_resources(v_keys);

  -- Lock all potentially live suggestion rows only after every canonical key.
  -- Re-discovery happens after the canonical locks so a waiter never validates
  -- against a stale pre-wait suggestion set.
  SELECT array_agg(s.id ORDER BY s.id) INTO v_suggestion_ids
  FROM public.inventory_transfer_suggestions s
  WHERE s.status IN ('open','accepted')
    AND s.route_kind='outlet_to_warehouse'
    AND (
      s.draft_outlet_return_request_id=p_return_request_id
      OR s.provenance_dispatch_line_id=
         ANY(COALESCE(v_provenance_ids,ARRAY[]::uuid[]))
    );

  PERFORM 1
  FROM public.inventory_transfer_suggestions s
  WHERE s.id=ANY(COALESCE(v_suggestion_ids,ARRAY[]::uuid[]))
  ORDER BY s.id
  FOR UPDATE;

  -- Preserve the historical public contract while pre-locking all review
  -- rows in deterministic order. The private 149 delegate re-enters these
  -- locks and performs the established atomic status/audit update.
  SELECT * INTO v_request
  FROM public.outlet_return_requests
  WHERE id=p_return_request_id
  FOR UPDATE;
  IF v_request.status<>'submitted' THEN
    RAISE EXCEPTION 'return_request_not_reviewable' USING ERRCODE='23514';
  END IF;
  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor,'outlet_stock.review_return',
    v_request.destination_organization_id,
    v_request.destination_warehouse_id,NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_outlet_review_return' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id=v_actor AND p.status='active'
  ) THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE='42501';
  END IF;

  PERFORM 1
  FROM public.outlet_return_request_lines l
  WHERE l.return_request_id=p_return_request_id
    AND l.id=ANY(COALESCE(v_line_ids,ARRAY[]::uuid[]))
  ORDER BY l.id
  FOR UPDATE;

  -- Validate every decision before the delegate applies any decision. A
  -- malformed provenance in a multi-decision call therefore aborts the whole
  -- statement without a partial status or success audit.
  FOR v_decision IN SELECT value FROM jsonb_array_elements(p_decisions)
  LOOP
    SELECT * INTO v_line
    FROM public.outlet_return_request_lines
    WHERE id=(v_decision->>'line_id')::uuid
      AND return_request_id=p_return_request_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'return_request_line_not_found' USING ERRCODE='P0002';
    END IF;
    IF v_line.status<>'pending' THEN
      RAISE EXCEPTION 'return_request_line_not_pending' USING ERRCODE='23514';
    END IF;
    v_approved:=(v_decision->>'approved_quantity')::integer;
    IF v_approved IS NULL OR v_approved<0
       OR v_approved>v_line.requested_quantity THEN
      RAISE EXCEPTION 'invalid_approved_quantity' USING ERRCODE='23514';
    END IF;
  END LOOP;

  -- Row-level provenance follows document/line locks. The earlier advisory
  -- inv_provline lock is what serializes different request headers that refer
  -- to this same row without reversing the established 4B ordering.
  PERFORM 1
  FROM public.warehouse_dispatch_lines d
  WHERE d.id=ANY(COALESCE(v_provenance_ids,ARRAY[]::uuid[]))
  ORDER BY d.id
  FOR UPDATE;

  FOR v_provenance_id IN
    SELECT unnest(COALESCE(v_provenance_ids,ARRAY[]::uuid[]))
  LOOP
    SELECT COALESCE(d.received_quantity,0)-d.returned_quantity
    INTO v_physical_remaining
    FROM public.warehouse_dispatch_lines d
    WHERE d.id=v_provenance_id;

    -- Fresh open, accepted linked, and legacy_unresolved suggestion
    -- commitments remain conservative. The current review lines are excluded
    -- because their proposed decisions replace, rather than add to, their old
    -- linked-suggestion commitment.
    SELECT COALESCE(sum(c.provenance_commitment),0)::integer
    INTO v_suggestion_commitment
    FROM public.inventory_transfer_suggestions s
    CROSS JOIN LATERAL
      public.phoenix_inventory_suggestion_commitments(s.id) c
    WHERE s.route_kind='outlet_to_warehouse'
      AND s.provenance_dispatch_line_id=v_provenance_id
      AND c.is_active
      AND NOT COALESCE((
        s.draft_outlet_return_request_line_id=
          ANY(COALESCE(v_line_ids,ARRAY[]::uuid[]))
      ),false);

    -- Approved and partially fulfilled manual lines reserve only their unsent
    -- remainder. A line represented by a live suggestion is deliberately
    -- omitted here so the same commitment is never counted twice.
    SELECT COALESCE(sum(
      GREATEST(COALESCE(l.approved_quantity,0)-l.fulfilled_quantity,0)
    ),0)::integer
    INTO v_line_commitment
    FROM public.outlet_return_request_lines l
    JOIN public.outlet_return_requests h ON h.id=l.return_request_id
    WHERE l.original_dispatch_line_id=v_provenance_id
      AND l.status IN ('approved','partially_fulfilled')
      AND h.status NOT IN ('cancelled','rejected')
      AND NOT (
        l.id=ANY(COALESCE(v_line_ids,ARRAY[]::uuid[]))
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.inventory_transfer_suggestions s
        CROSS JOIN LATERAL
          public.phoenix_inventory_suggestion_commitments(s.id) c
        WHERE s.route_kind='outlet_to_warehouse'
          AND s.draft_outlet_return_request_line_id=l.id
          AND c.is_active
      );

    SELECT COALESCE(sum((d.value->>'approved_quantity')::integer),0)::integer
    INTO v_proposed_commitment
    FROM jsonb_array_elements(p_decisions) d(value)
    JOIN public.outlet_return_request_lines l
      ON l.id=(d.value->>'line_id')::uuid
     AND l.return_request_id=p_return_request_id
    WHERE l.original_dispatch_line_id=v_provenance_id;

    -- R1.5-F3-C6. RECALL PRECEDENCE, the outlet counterpart of warehouse C2.
    -- A PENDING recall is not a request review may arbitrate away: it is an
    -- origin-issued instruction already bounded to real custody by
    -- _phoenix_outlet_recall_exposure_v1, so it consumes provenance the moment
    -- it exists. Manual pending lines are deliberately NOT counted here - two
    -- competing manual requests must still be arbitrated first-come-first-served
    -- rather than blocking each other.
    SELECT COALESCE(sum(
      GREATEST(COALESCE(l.approved_quantity,l.requested_quantity)-l.fulfilled_quantity,0)
    ),0)::integer
    INTO v_recall_commitment
    FROM public.outlet_return_request_lines l
    JOIN public.outlet_return_requests h ON h.id=l.return_request_id
    WHERE l.original_dispatch_line_id=v_provenance_id
      AND l.reason_code='recalled'
      AND l.status='pending'
      AND h.status NOT IN ('cancelled','rejected')
      AND NOT (l.id=ANY(COALESCE(v_line_ids,ARRAY[]::uuid[])));

    IF v_suggestion_commitment+v_line_commitment+v_recall_commitment+v_proposed_commitment
       > v_physical_remaining THEN
      RAISE EXCEPTION 'outlet_return_aggregate_cap_exceeded'
        USING ERRCODE='23514';
    END IF;
  END LOOP;

  -- ── R1.5-F3-C6. THE MISSING PHYSICAL BUDGET ───────────────────────────────
  -- Everything above is 150's PROVENANCE cap, keyed by dispatch line and
  -- preserved exactly. It cannot see the second resource: 150's own canonical
  -- identity legally merges several DISTINCT dispatch receipts into ONE
  -- outlet_stock row, so two approvals with different provenance anchors could
  -- each pass the provenance cap and still overdraw one physical shelf. This
  -- loop closes that, grouped by the outlet_stock row and therefore GLOBAL to it.
  -- It only ever ADDS a refusal, so no previously-legal review becomes illegal
  -- for any reason other than a genuine physical overdraw.
  SELECT array_agg(DISTINCT l.source_outlet_stock_id ORDER BY l.source_outlet_stock_id)
  INTO v_stock_ids
  FROM public.outlet_return_request_lines l
  WHERE l.return_request_id=p_return_request_id
    AND l.id=ANY(COALESCE(v_line_ids,ARRAY[]::uuid[]));

  -- Deterministic order, and AFTER every provenance lock above, so the
  -- established dispatch_line -> outlet_stock direction is never inverted.
  PERFORM 1
  FROM public.outlet_stock s
  WHERE s.id=ANY(COALESCE(v_stock_ids,ARRAY[]::uuid[]))
  ORDER BY s.id
  FOR UPDATE;

  FOREACH v_stock_id IN ARRAY COALESCE(v_stock_ids,ARRAY[]::uuid[])
  LOOP
    -- available_quantity is GENERATED (on_hand - reserved), so dispensed,
    -- consumed and reserved units are already excluded.
    SELECT GREATEST(COALESCE(s.available_quantity,0),0)
    INTO v_phys_available
    FROM public.outlet_stock s WHERE s.id=v_stock_id;

    -- Live commitments on this lot from ANY provenance and ANY reference, with
    -- the lines under review excluded so review cannot self-block. Scope
    -- 'committed_or_recall' matches the arbitration vocabulary above.
    v_phys_other := public._phoenix_outlet_return_outstanding_v1(
      v_stock_id, NULL, v_line_ids, 'committed_or_recall');

    -- R1.5-H1. The provenance loop above has always counted suggestion
    -- commitments; this budget did not, so a suggestion anchored on ONE
    -- provenance and an approval anchored on ANOTHER could both pass while
    -- together overdrawing the single merged shelf they share. Keyed by
    -- source_stock_id, it is now global to the lot in the same sense the
    -- comment above claims.
    v_phys_suggestion := public._phoenix_outlet_suggestion_commitment_v1(
      NULL, v_stock_id, v_line_ids);

    SELECT COALESCE(sum((d.value->>'approved_quantity')::integer),0)::integer
    INTO v_phys_proposed
    FROM jsonb_array_elements(p_decisions) d(value)
    JOIN public.outlet_return_request_lines l
      ON l.id=(d.value->>'line_id')::uuid
     AND l.return_request_id=p_return_request_id
    WHERE l.source_outlet_stock_id=v_stock_id;

    IF v_phys_other+v_phys_suggestion+v_phys_proposed > v_phys_available THEN
      RAISE EXCEPTION 'outlet_return_aggregate_cap_exceeded'
        USING ERRCODE='23514',
        DETAIL=format('outlet stock %s: currently available %s, other live commitments %s, suggestion commitments %s, proposed %s',
                      v_stock_id, v_phys_available, v_phys_other, v_phys_suggestion, v_phys_proposed);
    END IF;
  END LOOP;
END;
$$;

-- ============================================================================
-- VERIFY - fail closed inside the same transaction
-- ============================================================================
DO $verify$
DECLARE
  v_defs text[];
  v_d    text;
  v_sig  text;
  v_n    integer;
BEGIN
  -- A1. Every hardened function still exists EXACTLY once at its original
  --     signature. A second overload would mean a caller could reach an
  --     un-hardened copy.
  FOREACH v_sig IN ARRAY ARRAY[
    'phoenix_receive_warehouse_return_shipment_line',
    '_phoenix_149_delegate_receive_outlet_return_shipment_line',
    'phoenix_resolve_outlet_return_exception',
    'phoenix_release_quarantine_stock'
  ] LOOP
    SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_sig;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'VERIFY FAILED (185): public.% exists % times, expected exactly 1', v_sig, v_n;
    END IF;
  END LOOP;

  -- A2. No public signature drift. Callers select these by name and arity.
  IF pg_get_function_arguments(
       'public.phoenix_receive_warehouse_return_shipment_line(uuid,uuid,integer,text,text,text)'::regprocedure)
     <> 'p_request_id uuid, p_shipment_line_id uuid, p_received_quantity integer, p_difference_reason text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_disposition_decision text DEFAULT NULL::text' THEN
    RAISE EXCEPTION 'VERIFY FAILED (185): warehouse return receive signature drifted';
  END IF;
  IF pg_get_function_arguments(
       'public.phoenix_release_quarantine_stock(uuid,uuid,integer,text,uuid)'::regprocedure)
     <> 'p_request_id uuid, p_quarantine_stock_id uuid, p_quantity integer, p_reason text, p_destination_warehouse_stock_id uuid' THEN
    RAISE EXCEPTION 'VERIFY FAILED (185): quarantine release signature drifted';
  END IF;

  -- A3. THE R1.5-A invariant: every destination resolver consults the canonical
  --     identity, and no resolver retains a raw-subset predicate.
  v_defs := ARRAY[
    pg_get_functiondef('public.phoenix_receive_warehouse_return_shipment_line(uuid,uuid,integer,text,text,text)'::regprocedure),
    pg_get_functiondef('public._phoenix_149_delegate_receive_outlet_return_shipment_line(uuid,uuid,integer,text,text,text)'::regprocedure),
    pg_get_functiondef('public.phoenix_resolve_outlet_return_exception(uuid,uuid,text,text,integer,text)'::regprocedure)
  ];
  FOREACH v_d IN ARRAY v_defs LOOP
    -- both branches must resolve through the canonical key
    IF (length(v_d) - length(replace(v_d, 'material_identity_key = public._phoenix_material_identity_v1', '')))
       / length('material_identity_key = public._phoenix_material_identity_v1') <> 2 THEN
      RAISE EXCEPTION
        'VERIFY FAILED (185): a receive resolver does not consult the canonical identity on BOTH its restockable and quarantine branch';
    END IF;
    -- the exact raw-subset predicate this migration removes must be gone
    IF v_d LIKE '%s.scientific_name = v_line.scientific_name%'
       OR v_d LIKE '%q.scientific_name = v_line.scientific_name%' THEN
      RAISE EXCEPTION
        'VERIFY FAILED (185): a receive resolver still matches its destination on scientific_name';
    END IF;
    -- the quarantine branch must carry the two components 088 added
    IF v_d NOT LIKE '%q.supply_type%' OR v_d NOT LIKE '%q.purchase_origin%' THEN
      RAISE EXCEPTION
        'VERIFY FAILED (185): a quarantine branch is still weaker than wqs_identity_uniq';
    END IF;
    -- fail-closed resolution is preserved: no silent fallback
    IF v_d NOT LIKE '%destination_stock_identity_resolution_failed%'
       OR v_d NOT LIKE '%destination_quarantine_identity_resolution_failed%' THEN
      RAISE EXCEPTION 'VERIFY FAILED (185): a resolver lost its fail-closed identity-resolution error';
    END IF;
  END LOOP;

  -- A4. Quarantine release compares the full canonical lot, and no longer
  --     accepts a merely name/batch/expiry-matching destination.
  v_d := pg_get_functiondef('public.phoenix_release_quarantine_stock(uuid,uuid,integer,text,uuid)'::regprocedure);
  IF v_d NOT LIKE '%v_dest.material_identity_key IS DISTINCT FROM v_q.material_identity_key%'
     OR v_d NOT LIKE '%v_dest.internal_batch_reference%'
     OR v_d NOT LIKE '%v_dest.supply_type%'
     OR v_d NOT LIKE '%v_dest.purchase_origin%' THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): quarantine release does not compare the full canonical lot identity';
  END IF;
  IF v_d LIKE '%v_dest.scientific_name IS DISTINCT FROM v_q.scientific_name%' THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): quarantine release still compares scientific_name as identity';
  END IF;
  -- 132's reference/lineage contract is deliberately preserved, not redesigned.
  IF v_d NOT LIKE '%quarantine_request%'
     OR v_d NOT LIKE '%correlation_id%'
     OR v_d NOT LIKE '%causation_id%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (185): 132 quarantine lineage contract was not preserved';
  END IF;

  -- A5. Client-principal reachability is unchanged. Scoped to anon and
  --     authenticated ONLY: service_role is a trusted server identity that 109
  --     deliberately grants broadly, and pinning it here is what made 184's
  --     Verify-K unappliable in real Supabase.
  IF NOT has_function_privilege('authenticated',
        'public.phoenix_receive_warehouse_return_shipment_line(uuid,uuid,integer,text,text,text)'::regprocedure::oid, 'EXECUTE')
     OR NOT has_function_privilege('authenticated',
        'public.phoenix_resolve_outlet_return_exception(uuid,uuid,text,text,integer,text)'::regprocedure::oid, 'EXECUTE')
     OR NOT has_function_privilege('authenticated',
        'public.phoenix_release_quarantine_stock(uuid,uuid,integer,text,uuid)'::regprocedure::oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (185): authenticated lost EXECUTE on a canonical entry point';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles r
    CROSS JOIN (VALUES
      ('public.phoenix_receive_warehouse_return_shipment_line(uuid,uuid,integer,text,text,text)'),
      ('public.phoenix_resolve_outlet_return_exception(uuid,uuid,text,text,integer,text)'),
      ('public.phoenix_release_quarantine_stock(uuid,uuid,integer,text,uuid)')
    ) AS g(sig)
    WHERE r.rolname = 'anon'
      AND has_function_privilege(r.oid, g.sig::regprocedure::oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (185): anon reaches a return/quarantine entry point';
  END IF;

  -- A6. The internal delegate and the identity helper stay closed to clients.
  IF EXISTS (
    SELECT 1 FROM pg_roles r
    CROSS JOIN (VALUES
      ('public._phoenix_149_delegate_receive_outlet_return_shipment_line(uuid,uuid,integer,text,text,text)'),
      ('public._phoenix_material_identity_v1(uuid,text,text,text,text,text)')
    ) AS g(sig)
    WHERE r.rolname IN ('anon', 'authenticated')
      AND has_function_privilege(r.oid, g.sig::regprocedure::oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (185): a client principal reaches an internal identity/delegate function';
  END IF;

  -- B1. Both corrected-receipt caps are present, NAMED, and evaluated while
  --     the provenance row is locked. Structural only: the behavioural proof
  --     (including that execution never reaches the CHECK constraint) is
  --     dynamic.
  v_d := pg_get_functiondef('public.phoenix_resolve_outlet_return_exception(uuid,uuid,text,text,integer,text)'::regprocedure);
  IF v_d NOT LIKE '%corrected_quantity_exceeds_return_shipment_line%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (185): the line-local corrected-receipt cap is missing';
  END IF;
  IF v_d NOT LIKE '%corrected_quantity_exceeds_returned_quantity%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (185): the aggregate corrected-receipt cap is missing';
  END IF;
  IF v_d NOT LIKE '%FROM public.warehouse_dispatch_lines%FOR UPDATE%' THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): the aggregate cap does not hold a row lock on the provenance line';
  END IF;
  -- The pre-R1.5 positivity check is kept, not replaced.
  IF v_d NOT LIKE '%corrected_quantity_must_be_positive%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (185): the positivity check was lost';
  END IF;

  -- B2. The historical CHECK constraint stays as the database backstop. R1.5
  --     adds a named refusal in front of it; it must never be relaxed.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.warehouse_dispatch_lines'::regclass
      AND conname = 'wdl_return_received_qty_chk'
      AND pg_get_constraintdef(oid) LIKE '%return_received_quantity <= returned_quantity%'
  ) THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): wdl_return_received_qty_chk is absent or no longer bounds return_received_quantity by returned_quantity';
  END IF;

  -- ── C. RECALL SELECTOR (F1) ────────────────────────────────────────────────
  -- C1. The selector RPC exists exactly once. A second overload would let a
  --     caller reach a build without the origin-anchored authority check.
  SELECT count(*) INTO v_n
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'phoenix_recall_warehouse_transfer_line';
  IF v_n <> 1 THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): phoenix_recall_warehouse_transfer_line must exist exactly once, found %', v_n;
  END IF;

  -- C2. The private cap helper is reachable by NO client role. If a client could
  --     call it directly it would become a cross-tenant quantity oracle.
  IF has_function_privilege('authenticated',
       'public._phoenix_warehouse_recall_exposure_v1(uuid,uuid)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon',
       'public._phoenix_warehouse_recall_exposure_v1(uuid,uuid)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): _phoenix_warehouse_recall_exposure_v1 must not be executable by anon/authenticated';
  END IF;

  -- C3. The public selector RPC IS reachable by authenticated and never by anon.
  IF NOT has_function_privilege('authenticated',
       'public.phoenix_recall_warehouse_transfer_line(uuid,text,text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): phoenix_recall_warehouse_transfer_line is not executable by authenticated';
  END IF;
  IF has_function_privilege('anon',
       'public.phoenix_recall_warehouse_transfer_line(uuid,text,text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): phoenix_recall_warehouse_transfer_line must not be executable by anon';
  END IF;

  -- C4. Both legacy header-only recalls are now inert: they must contain NO
  --     INSERT at all, and must raise the stable selector token. This is the
  --     assertion that actually proves the empty-header path is gone.
  FOREACH v_sig IN ARRAY ARRAY[
    'phoenix_recall_warehouse_transfer',
    'phoenix_recall_direct_warehouse_transfer'
  ] LOOP
    SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_sig;
    IF v_n <> 1 THEN
      RAISE EXCEPTION
        'VERIFY FAILED (185): % must exist exactly once (signature preserved, no overload), found %', v_sig, v_n;
    END IF;

    SELECT array_agg(pg_get_functiondef(p.oid)) INTO v_defs
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_sig;
    FOREACH v_d IN ARRAY v_defs LOOP
      IF v_d ILIKE '%insert into%' THEN
        RAISE EXCEPTION
          'VERIFY FAILED (185): % still contains an INSERT - the empty-header recall path is not closed', v_sig;
      END IF;
      IF v_d NOT LIKE '%recall_selector_required%' THEN
        RAISE EXCEPTION
          'VERIFY FAILED (185): % does not raise the stable recall_selector_required token', v_sig;
      END IF;
    END LOOP;
  END LOOP;

  -- C5. The selector RPC must never accept a caller-supplied organization,
  --     warehouse, identity or quantity: its whole IDOR posture is that topology
  --     is DERIVED from locked provenance. Pinning the identity arguments by
  --     NAME as well as type is what makes that structural - adding
  --     p_organization_id or p_quantity later fails here rather than silently
  --     widening the surface.
  SELECT count(*) INTO v_n
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'phoenix_recall_warehouse_transfer_line'
    AND pg_get_function_identity_arguments(p.oid)
        = 'p_original_transfer_line_id uuid, p_return_number text, p_notes text';
  IF v_n <> 1 THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): phoenix_recall_warehouse_transfer_line must take exactly '
      '(p_original_transfer_line_id uuid, p_return_number text, p_notes text)';
  END IF;

  -- C6 (R1.5-F1-C1). THE AGGREGATE PHYSICAL BUDGET. The exposure helper must net
  --     other live obligations off the SHELF, keyed by the canonical stock row -
  --     not off the provenance remainder alone. Without this the same selector
  --     under successive external document numbers, and two distinct transfer
  --     lines merged into one lot, both re-claim the same physical units.
  v_d := pg_get_functiondef('public._phoenix_warehouse_recall_exposure_v1(uuid,uuid)'::regprocedure);
  IF v_d NOT LIKE '%_phoenix_warehouse_return_outstanding_v1(%v_orig.resulting_warehouse_stock_id, NULL, NULL, ''all_actionable'')%' THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): the recall exposure helper does not take its physical budget from the canonical predicate keyed by resulting_warehouse_stock_id';
  END IF;
  IF v_d NOT LIKE '%COALESCE(v_available, 0) - v_other_phys%' THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): the recall exposure helper does not subtract other live obligations from present custody';
  END IF;
  -- The provenance budget must SURVIVE alongside it; a full shelf must never
  -- authorize returning more of a delivery than actually arrived.
  IF v_d NOT LIKE '%NULL, p_original_transfer_line_id, NULL, ''all_actionable''%'
     OR v_d NOT LIKE '%LEAST(v_prov, v_phys)%' THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): the recall exposure helper no longer enforces BOTH the provenance and the physical budget';
  END IF;
  -- R1.5-F1-C2. NO PRIVATE CENSUS. The helper must not re-implement the status
  -- vocabulary locally; that divergence is precisely what let a manual approval
  -- spend a pending recall's units.
  IF v_d LIKE '%warehouse_return_request_lines%' THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): the recall exposure helper reads warehouse_return_request_lines directly instead of the canonical outstanding predicate';
  END IF;

  -- C10 (R1.5-F2-M1). THE RETURN REFERENCE IS CORRIDOR-SCOPED, NOT
  --      ORGANIZATION-SCOPED. The old rule is gone and the new one exists once.
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'wrr_src_org_number_uniq') THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): the organization-wide return-reference rule wrr_src_org_number_uniq still exists';
  END IF;
  SELECT count(*) INTO v_n
  FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
  WHERE i.indrelid = 'public.warehouse_return_requests'::regclass
    AND i.indisunique
    AND pg_get_indexdef(c.oid) LIKE '%btrim(return_number)%';
  IF v_n <> 1 THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): expected exactly ONE unique return-reference index, found %', v_n;
  END IF;

  SELECT pg_get_indexdef(c.oid) INTO v_d
  FROM pg_class c WHERE c.relname = 'wrr_corridor_number_uniq';
  IF v_d IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (185): wrr_corridor_number_uniq is absent';
  END IF;
  -- The canonical corridor identity, verbatim.
  IF v_d NOT LIKE '%source_warehouse_id%'
     OR v_d NOT LIKE '%destination_warehouse_id%'
     OR v_d NOT LIKE '%COALESCE(route_id%'
     OR v_d NOT LIKE '%btrim(return_number)%' THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): wrr_corridor_number_uniq does not key on the canonical corridor identity + normalized reference';
  END IF;
  -- The organization must NOT be a disambiguator again.
  IF v_d LIKE '%organization_id%' THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): the return-reference index re-admits an organization column as a disambiguator';
  END IF;
  -- A raw nullable route_id would make two identical DIRECT headers insertable.
  -- Every mention of the column must be wrapped: strip the wrapped ones and any
  -- bare reference left over is the defect.
  IF replace(v_d, 'COALESCE(route_id', '') LIKE '%route_id%' THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): route_id is keyed RAW; NULLs would compare DISTINCT and duplicate direct headers';
  END IF;

  -- C11 (R1.5-F2-M1). The obligation writer must look the header up on the SAME
  --      identity the index enforces, or lookup and index drift apart and the
  --      insert races into a raw unique violation. C10 left the INDEX definition
  --      in v_d, so the writer is re-read here.
  v_d := pg_get_functiondef(
    'public._phoenix_materialize_warehouse_recall_obligation_v1(uuid,text,text,uuid,text,uuid)'::regprocedure);
  IF v_d LIKE '%WHERE source_organization_id = v_transfer.destination_organization_id%' THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): the obligation writer still resolves its header by organization + reference';
  END IF;
  IF v_d NOT LIKE '%WHERE source_warehouse_id = v_transfer.destination_warehouse_id%'
     OR v_d NOT LIKE '%AND destination_warehouse_id = v_transfer.source_warehouse_id%'
     OR v_d NOT LIKE '%COALESCE(route_id, ''00000000-0000-0000-0000-000000000000''::uuid)%'
     OR v_d NOT LIKE '%AND btrim(return_number) = v_number%' THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): the obligation writer does not resolve its header on the canonical corridor identity';
  END IF;
  -- The header-creation race across DIFFERENT selectors sharing one corridor.
  IF v_d NOT LIKE '%185002%' THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): the obligation writer does not take a corridor-scoped header lock';
  END IF;
  -- Replay must key on the same corridor too.
  IF v_d NOT LIKE '%COALESCE(r.route_id, ''00000000-0000-0000-0000-000000000000''::uuid)%' THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): the recall replay lookup ignores the route half of the corridor identity';
  END IF;

  -- C12 (R1.5-F2). DOWNSTREAM PROPAGATION.
  --      ONE obligation writer, reachable by no client, shared by the root and
  --      every downstream holder - so F2 cannot grow a parallel writer whose
  --      corridor, cap or replay rules drift from F1's.
  SELECT count(*) INTO v_n
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = '_phoenix_materialize_warehouse_recall_obligation_v1';
  IF v_n <> 1 THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): _phoenix_materialize_warehouse_recall_obligation_v1 must exist exactly once, found %', v_n;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles r
    WHERE r.rolname IN ('anon', 'authenticated')
      AND has_function_privilege(
            r.oid,
            'public._phoenix_materialize_warehouse_recall_obligation_v1(uuid,text,text,uuid,text,uuid)'::regprocedure::oid,
            'EXECUTE')
  ) THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): a client principal reaches the recall obligation writer directly';
  END IF;
  -- The writer must NOT check authority: re-checking downstream would demand the
  -- initiating actor hold permissions inside every holder organization.
  IF v_d LIKE '%phoenix_profile_has_scoped_permission%' THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): the obligation writer performs its own authority check; authority is root-anchored';
  END IF;

  v_d := pg_get_functiondef('public.phoenix_recall_warehouse_transfer_line(uuid,text,text)'::regprocedure);
  -- Authority stays in the public entry point, exactly once.
  IF (length(v_d) - length(replace(v_d, 'phoenix_profile_has_scoped_permission', '')))
     / length('phoenix_profile_has_scoped_permission') <> 1 THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): the recall entry point must check authority exactly once, at the root';
  END IF;
  -- The lineage edge is REAL provenance, never a material lookalike.
  IF v_d NOT LIKE '%d.source_warehouse_stock_id = v_root_stock%' THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): downstream descendants are not discovered through source_warehouse_stock_id provenance';
  END IF;
  IF v_d LIKE '%material_identity_key =%'
     AND v_d NOT LIKE '%IS DISTINCT FROM v_identity%' THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): the lineage walk appears to match descendants on material identity rather than validate with it';
  END IF;
  -- Only genuinely received descendants may bear custody.
  IF v_d NOT LIKE '%d.status IN (''received'', ''received_with_difference'')%'
     OR v_d NOT LIKE '%COALESCE(d.received_quantity, 0) > 0%'
     OR v_d NOT LIKE '%d.resulting_warehouse_stock_id IS NOT NULL%' THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): the descendant filter admits unreceived or zero-received transfer lines';
  END IF;
  -- Both integrity assertions must be present and fail closed.
  IF v_d NOT LIKE '%recall_material_identity_lineage_mismatch%' THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): the lineage walk does not assert canonical material identity across the hop';
  END IF;
  IF v_d NOT LIKE '%recall_unsupported_warehouse_lineage_depth%' THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): a deeper historical warehouse descendant would be silently truncated';
  END IF;
  -- Deterministic lock order: transfer lines then stock rows, each ORDERed.
  IF v_d NOT LIKE '%FROM public.warehouse_transfer_lines WHERE id = v_id FOR UPDATE%'
     OR v_d NOT LIKE '%FROM public.warehouse_stock WHERE id = v_id FOR UPDATE%'
     OR v_d NOT LIKE '%SELECT unnest(v_lines) ORDER BY 1%' THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): downstream propagation does not lock its shared rows in one deterministic order';
  END IF;
  -- The wire contract is unchanged: counts and the caller's own reference only.
  IF v_d NOT LIKE '%''obligations_created'', v_created, ''obligations_reused'', v_reused%' THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): the recall response shape changed';
  END IF;
  IF v_d LIKE '%''downstream%' OR v_d LIKE '%''holder%' OR v_d LIKE '%''warehouse_id%' THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): the recall response appears to leak downstream topology';
  END IF;

  -- C8 (R1.5-F1-C2). ONE canonical outstanding-commitment predicate, reached by
  --     BOTH recall sizing and review arbitration, and closed to every client.
  SELECT count(*) INTO v_n
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = '_phoenix_warehouse_return_outstanding_v1';
  IF v_n <> 1 THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): _phoenix_warehouse_return_outstanding_v1 must exist exactly once, found %', v_n;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles r
    WHERE r.rolname IN ('anon', 'authenticated')
      AND has_function_privilege(
            r.oid,
            'public._phoenix_warehouse_return_outstanding_v1(uuid,uuid,uuid[],text)'::regprocedure::oid,
            'EXECUTE')
  ) THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): a client principal reaches the canonical outstanding-commitment predicate';
  END IF;

  v_d := pg_get_functiondef('public._phoenix_warehouse_return_outstanding_v1(uuid,uuid,uuid[],text)'::regprocedure);
  -- One terminal vocabulary and one quantity expression, stated exactly once.
  IF v_d NOT LIKE '%l.status NOT IN (''rejected'', ''cancelled'', ''fulfilled'')%'
     OR v_d NOT LIKE '%r.status NOT IN (''rejected'', ''cancelled'')%'
     OR v_d NOT LIKE '%COALESCE(l.approved_quantity, l.requested_quantity) - l.fulfilled_quantity%' THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): the canonical outstanding predicate lost its terminal vocabulary or its quantity expression';
  END IF;
  -- The recall-priority term: a pending RECALL outranks a routine return at review.
  IF v_d NOT LIKE '%l.reason_code = ''recalled''%' THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): the canonical outstanding predicate lost the pending-recall precedence term';
  END IF;
  -- The current-line exclusion, without which every review self-blocks.
  IF v_d NOT LIKE '%p_exclude_line_ids IS NULL OR NOT (l.id = ANY (p_exclude_line_ids))%' THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): the canonical outstanding predicate cannot exclude the lines under review';
  END IF;
  -- Both grouping keys NULL would silently total the whole table.
  IF v_d NOT LIKE '%warehouse_return_outstanding_requires_a_grouping_key%' THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): the canonical outstanding predicate does not refuse an unkeyed total';
  END IF;

  -- C9 (R1.5-F1-C2). Review arbitration must consume the SAME predicate on BOTH
  --     of its caps, and must pass the deciding lines as the exclusion set.
  v_d := pg_get_functiondef('public._phoenix_validate_warehouse_return_review_caps_v1(uuid,jsonb)'::regprocedure);
  IF (length(v_d) - length(replace(v_d, '_phoenix_warehouse_return_outstanding_v1', '')))
     / length('_phoenix_warehouse_return_outstanding_v1') <> 2 THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): the review caps do not both derive from the canonical outstanding predicate';
  END IF;
  IF (length(v_d) - length(replace(v_d, '(SELECT array_agg(line_id) FROM proposal)', '')))
     / length('(SELECT array_agg(line_id) FROM proposal)') <> 2 THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): a review cap does not exclude the lines it is currently deciding - it would self-block';
  END IF;
  IF v_d LIKE '%o.status IN (''approved'', ''partially_fulfilled'')%' THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): the review caps still carry a private status census alongside the canonical predicate';
  END IF;

  -- C7 (R1.5-F1-C1). The selector RPC must hold the canonical lot while it sizes
  --     the obligation. Two recalls of DIFFERENT transfer lines that merged into
  --     ONE stock row share neither the advisory key nor the transfer-line lock,
  --     so this is the only thing serializing them against the shared balance.
  --     Pinned on the exact predicate, not on a loose 'warehouse_stock ... FOR
  --     UPDATE' window: the body already SELECTs warehouse_stock for the
  --     identity probe and already holds a FOR UPDATE on the request, so a
  --     wildcard between them would pass with no lot lock at all. R1.5-F2 moved
  --     this into the shared obligation writer.
  v_d := pg_get_functiondef(
    'public._phoenix_materialize_warehouse_recall_obligation_v1(uuid,text,text,uuid,text,uuid)'::regprocedure);
  IF v_d NOT LIKE '%WHERE id = v_orig.resulting_warehouse_stock_id FOR UPDATE%' THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185): the obligation writer does not lock the canonical stock row before sizing the obligation';
  END IF;

  -- ══ D. R1.5-H1 ════════════════════════════════════════════════════════════
  -- Deliberately catalog- and source-only. No role privilege is asserted here:
  -- pinning a client principal in VERIFY is precisely what made 184's Verify-K
  -- unappliable, and the browser boundary is proven by the dynamic suite instead.

  -- D1. The suggestion-commitment reader must EXIST with its exact signature.
  --     The regprocedure cast itself raises if it does not.
  PERFORM 'public._phoenix_outlet_suggestion_commitment_v1(uuid,uuid,uuid[])'::regprocedure;

  -- D2. Recall SIZING must spend the same suggestion commitments the review cap
  --     spends, on BOTH budgets. Without either subtraction an obligation is
  --     born larger than review could ever truthfully approve - the exact defect
  --     H1 exists to remove.
  v_d := pg_get_functiondef(
    'public._phoenix_outlet_recall_exposure_v1(uuid,uuid)'::regprocedure);
  IF position('- v_committed - v_sugg_prov' in v_d) = 0 THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185/H1): outlet recall sizing does not subtract suggestion commitments from the PROVENANCE budget';
  END IF;
  IF position('- v_other_phys - v_sugg_phys' in v_d) = 0 THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185/H1): outlet recall sizing does not subtract suggestion commitments from the PHYSICAL budget';
  END IF;

  -- D3. The review cap's PHYSICAL budget must carry the same term, or a
  --     suggestion on one provenance and an approval on another could together
  --     overdraw the single merged shelf they share.
  v_d := pg_get_functiondef(
    'public._phoenix_validate_outlet_return_review_cap_v1(uuid,jsonb)'::regprocedure);
  IF position('v_phys_other+v_phys_suggestion+v_phys_proposed' in v_d) = 0 THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185/H1): the outlet review physical budget ignores suggestion commitments';
  END IF;

  -- D4. AUTHORITY BEFORE BUSINESS STATE in the public selector. If either 23514
  --     branch drifts back ahead of the scoped-permission check it becomes an
  --     existence/status oracle on a foreign selector.
  v_d := pg_get_functiondef(
    'public.phoenix_recall_outlet_inbound_movement(uuid,text,text)'::regprocedure);
  --     Pinned on the CALL SITE and the RAISE STATEMENT, never on the bare
  --     tokens: the rationale comment above the check necessarily quotes the
  --     error name, and matching that would compare a comment against code.
  IF position('IF NOT public.phoenix_profile_has_scoped_permission(' in v_d) = 0
     OR position('RAISE EXCEPTION ''distribution_point_inactive''' in v_d) = 0
     OR position('IF NOT public.phoenix_profile_has_scoped_permission(' in v_d)
        > position('RAISE EXCEPTION ''distribution_point_inactive''' in v_d) THEN
    RAISE EXCEPTION
      'VERIFY FAILED (185/H1): the outlet selector discloses distribution-point state before checking authority';
  END IF;

  RAISE NOTICE '185 verified (sections A+B+C+H1): canonical destination identity in four resolvers; two named corrected-receipt caps ahead of the CHECK backstop; provenance-first recall selector whose private cap helper bounds BOTH the provenance remainder and the shared canonical-lot shelf; both legacy empty-header paths closed; recall sizing and the review cap spend the SAME canonical suggestion commitments on both budgets; and the selector checks authority before disclosing any distribution-point state';
END;
$verify$;

COMMIT;
