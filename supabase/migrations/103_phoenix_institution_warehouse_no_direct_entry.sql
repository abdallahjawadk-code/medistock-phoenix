-- ============================================================================
-- INSTITUTION-WAREHOUSE-NO-DIRECT-ENTRY-103-A
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply after 102.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE GAP THIS CLOSES — Phase 2 acceptance item 2
-- ─────────────────────────────────────────────────────────────────────────────
-- An institution warehouse's stock must increase ONLY via a canonical
-- corridor: receiving a central-to-institution transfer (068/100), or
-- receiving an outlet return shipment back at the institution (071/100).
-- Local/sub-purchases (087) are a separate, independently-contracted inbound
-- path and remain unaffected by this migration.
--
-- Audit (fresh read of 065/078/088, confirmed no `warehouse_kind` predicate
-- anywhere in the chain) found that `phoenix_receive_warehouse_stock` —
-- the hand-typed AND OCR-assisted receipt RPC that InventoryCenterScreen's
-- Intake tab posts through (`warehouse-intake.service.ts`'s
-- `receiveWarehouseStock`, called identically by the manual form and by
-- `OcrIntakeFlow.confirmAndSubmit`) — is gated ONLY on the
-- `warehouse_stock.adjust` permission against the target `p_warehouse_id`,
-- with NO discrimination between a central (pharmacy-department) warehouse
-- and an institution warehouse. Any profile holding that permission and a
-- scope assignment on an institution warehouse could hand-type or OCR-scan a
-- receipt straight into it, bypassing 068/071 entirely. Migrations 080/085
-- did not close this: 080 only revoked the UNGUARDED legacy names (078's
-- guarded wrappers, which delegate to the exact same write body, remain
-- granted); 085 is a different table (`item_availability`) and is not even
-- applied.
--
-- The generic `phoenix_apply_warehouse_stock_movement` has the identical gap
-- for its 'add'/'subtract'/'set_exact' operations (arbitrary quantity
-- injection/removal on an EXISTING lot, no canonical corridor, no
-- second-person approval) — its 'correction' operation is EXCLUDED from this
-- migration's restriction because 101's phoenix_request_warehouse_stock_
-- correction legitimately delegates to the guarded wrapper for its
-- within-threshold auto-apply branch, and that whole request/threshold/
-- approval contract is the intended, audited path for adjusting an
-- institution warehouse's RECORDED count — a different concept from
-- inventing/erasing physical quantity with no corridor at all.
--
-- FIX: both functions are FULL redefinitions (same signature/name, no
-- overload), preserving every existing line of business logic verbatim,
-- with one new fail-closed check inserted before any write:
--   - phoenix_receive_warehouse_stock: refuse unless the target warehouse's
--     warehouse_kind = 'central'.
--   - phoenix_apply_warehouse_stock_movement: refuse 'add'/'subtract'/
--     'set_exact' unless the target lot's warehouse_kind = 'central'.
-- Both guarded wrappers (078's phoenix_receive_warehouse_stock_guarded /
-- phoenix_apply_warehouse_stock_movement_guarded) delegate directly to these
-- bodies for both the replay and non-replay paths, so the check applies to
-- every live entry point with zero additional edits.
-- ============================================================================

BEGIN;

DO $precond$
BEGIN
  IF to_regprocedure(
    'public.phoenix_receive_warehouse_stock(uuid,uuid,text,integer,boolean,boolean,uuid,text,text,text,text,text,text,date,numeric,text,text,text,text,text,text,text)'
  ) IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 065/088 phoenix_receive_warehouse_stock is missing';
  END IF;
  IF to_regprocedure(
    'public.phoenix_apply_warehouse_stock_movement(uuid,uuid,text,integer,text,text,text)'
  ) IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 065 phoenix_apply_warehouse_stock_movement is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'warehouses' AND column_name = 'warehouse_kind'
  ) THEN
    RAISE EXCEPTION 'precondition failed: 066 warehouses.warehouse_kind is missing';
  END IF;
END;
$precond$;

-- ── A. Receive — the hand-typed / OCR-assisted receipt RPC ─────────────────

CREATE OR REPLACE FUNCTION public.phoenix_receive_warehouse_stock(
  p_request_id             uuid,
  p_warehouse_id           uuid,
  p_scientific_name        text,
  p_quantity               integer,
  p_has_no_national_code   boolean,
  p_has_no_batch_number    boolean,
  p_central_item_id        uuid DEFAULT NULL,
  p_trade_name             text DEFAULT NULL,
  p_concentration          text DEFAULT NULL,
  p_dosage_form            text DEFAULT NULL,
  p_unit                   text DEFAULT NULL,
  p_national_code          text DEFAULT NULL,
  p_batch_number           text DEFAULT NULL,
  p_expiry_date            date DEFAULT NULL,
  p_unit_price             numeric DEFAULT NULL,
  p_price_basis            text DEFAULT NULL,
  p_currency               text DEFAULT NULL,
  p_supply_type_text       text DEFAULT NULL,
  p_source_document_number text DEFAULT NULL,
  p_notes                  text DEFAULT NULL,
  p_supply_type            text DEFAULT NULL,
  p_purchase_origin        text DEFAULT NULL
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
  v_org            uuid;
  v_warehouse_kind text;
  v_scientific     text := NULLIF(btrim(p_scientific_name), '');
  v_trade          text := NULLIF(btrim(p_trade_name), '');
  v_concentration  text := NULLIF(btrim(p_concentration), '');
  v_dosage         text := NULLIF(btrim(p_dosage_form), '');
  v_unit           text := NULLIF(btrim(p_unit), '');
  v_national       text := NULLIF(btrim(p_national_code), '');
  v_batch          text := NULLIF(btrim(p_batch_number), '');
  v_internal_ref   text;
  v_price_basis    text := NULLIF(btrim(p_price_basis), '');
  v_currency       text := NULLIF(btrim(p_currency), '');
  v_supply_type_label text := NULLIF(btrim(p_supply_type_text), '');
  v_source_doc     text := NULLIF(btrim(p_source_document_number), '');
  v_notes          text := NULLIF(btrim(p_notes), '');
  v_supply_type    text := NULLIF(btrim(p_supply_type), '');
  v_origin         text := NULLIF(btrim(p_purchase_origin), '');
  v_stock          public.warehouse_stock%ROWTYPE;
  v_before         integer;
  v_after          integer;
  v_movement_id    uuid;
  v_existing       public.warehouse_stock_movements%ROWTYPE;
  v_request_fingerprint text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514';
  END IF;

  IF v_supply_type IS NOT NULL AND v_supply_type NOT IN ('aid', 'purchase', 'kimadia') THEN
    RAISE EXCEPTION 'invalid_supply_type' USING ERRCODE = '23514';
  END IF;
  IF v_supply_type = 'purchase' THEN
    v_origin := COALESCE(v_origin, 'central');
    IF v_origin NOT IN ('central', 'supplementary') THEN
      RAISE EXCEPTION 'invalid_purchase_origin' USING ERRCODE = '23514';
    END IF;
  ELSIF v_origin IS NOT NULL THEN
    RAISE EXCEPTION 'purchase_origin_without_purchase' USING ERRCODE = '23514';
  END IF;
  IF p_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'warehouse_id_required' USING ERRCODE = '23514';
  END IF;
  IF v_scientific IS NULL THEN
    RAISE EXCEPTION 'scientific_name_required' USING ERRCODE = '23514';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;
  IF p_has_no_national_code IS NULL OR p_has_no_batch_number IS NULL THEN
    RAISE EXCEPTION 'explicit_identity_flags_required' USING ERRCODE = '23514';
  END IF;
  IF p_has_no_national_code IS DISTINCT FROM (v_national IS NULL) THEN
    RAISE EXCEPTION 'national_code_flag_mismatch' USING ERRCODE = '23514';
  END IF;
  IF p_has_no_batch_number IS DISTINCT FROM (v_batch IS NULL) THEN
    RAISE EXCEPTION 'batch_number_flag_mismatch' USING ERRCODE = '23514';
  END IF;
  IF p_unit_price IS NOT NULL AND p_unit_price < 0 THEN
    RAISE EXCEPTION 'unit_price_must_be_non_negative' USING ERRCODE = '23514';
  END IF;

  SELECT w.organization_id, w.warehouse_kind
    INTO v_org, v_warehouse_kind
  FROM public.warehouses w
  WHERE w.id = p_warehouse_id
    AND w.status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse_not_found_or_inactive' USING ERRCODE = 'P0002';
  END IF;

  -- 103: an institution warehouse never receives stock by hand or by OCR — only
  -- via 068/100 (transfer receive) or 071/100 (outlet-return receive). A
  -- central (pharmacy-department) warehouse is unaffected.
  IF v_warehouse_kind <> 'central' THEN
    RAISE EXCEPTION 'institution_warehouse_direct_receipt_forbidden' USING ERRCODE = '42501',
      DETAIL = 'institution warehouses receive only via the canonical transfer/outlet-return corridors';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'warehouse_stock.adjust', v_org, p_warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_warehouse_stock_adjust' USING ERRCODE = '42501';
  END IF;

  SELECT p.role, p.full_name
    INTO v_actor_role, v_actor_name
  FROM public.profiles p
  WHERE p.id = v_actor
    AND p.status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  v_internal_ref := CASE
    WHEN p_has_no_batch_number
      THEN 'WSNB-' || replace(p_request_id::text, '-', '')
    ELSE NULL
  END;

  v_request_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'receive',
    'warehouse_id', p_warehouse_id,
    'scientific_name', v_scientific,
    'quantity', p_quantity,
    'has_no_national_code', p_has_no_national_code,
    'has_no_batch_number', p_has_no_batch_number,
    'central_item_id', p_central_item_id,
    'trade_name', v_trade,
    'concentration', v_concentration,
    'dosage_form', v_dosage,
    'unit', v_unit,
    'national_code', v_national,
    'batch_number', v_batch,
    'expiry_date', p_expiry_date,
    'unit_price', p_unit_price,
    'price_basis', v_price_basis,
    'currency', v_currency,
    'supply_type_text', v_supply_type_label,
    'source_document_number', v_source_doc,
    'notes', v_notes
  )::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 65065));

  SELECT *
    INTO v_existing
  FROM public.warehouse_stock_movements m
  WHERE m.reference_type = 'warehouse_request'
    AND m.reference_id = p_request_id;

  IF FOUND THEN
    IF v_existing.organization_id IS DISTINCT FROM v_org
       OR v_existing.warehouse_id IS DISTINCT FROM p_warehouse_id
       OR v_existing.request_fingerprint IS DISTINCT FROM v_request_fingerprint THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent_replay', true,
      'warehouse_stock_id', v_existing.warehouse_stock_id,
      'movement_id', v_existing.id,
      'quantity_before', v_existing.on_hand_before,
      'quantity_delta', v_existing.on_hand_delta,
      'quantity_after', v_existing.on_hand_after
    );
  END IF;

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
    v_org, p_warehouse_id, p_central_item_id,
    v_scientific, v_trade, v_concentration, v_dosage, v_unit,
    v_national, p_has_no_national_code,
    v_batch, p_has_no_batch_number, v_internal_ref,
    p_expiry_date, 0, 0,
    p_unit_price, v_price_basis, v_currency, v_supply_type_label,
    v_supply_type, v_origin,
    v_source_doc, v_notes, v_actor, v_actor
  )
  ON CONFLICT DO NOTHING;

  SELECT *
    INTO v_stock
  FROM public.warehouse_stock s
  WHERE s.warehouse_id = p_warehouse_id
    AND s.scientific_name = v_scientific
    AND COALESCE(s.concentration, '') = COALESCE(v_concentration, '')
    AND COALESCE(s.dosage_form, '') = COALESCE(v_dosage, '')
    AND COALESCE(s.national_code, '') = COALESCE(v_national, '')
    AND COALESCE(s.batch_number, '') = COALESCE(v_batch, '')
    AND COALESCE(s.expiry_date, DATE '0001-01-01')
        = COALESCE(p_expiry_date, DATE '0001-01-01')
    AND COALESCE(s.internal_batch_reference, '') = COALESCE(v_internal_ref, '')
    AND COALESCE(s.supply_type, '') = COALESCE(v_supply_type, '')
    AND COALESCE(s.purchase_origin, '') = COALESCE(v_origin, '')
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse_stock_identity_resolution_failed'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_stock.central_item_id IS NOT NULL
     AND p_central_item_id IS NOT NULL
     AND v_stock.central_item_id IS DISTINCT FROM p_central_item_id THEN
    RAISE EXCEPTION 'warehouse_stock_central_item_conflict'
      USING ERRCODE = '23514';
  END IF;

  v_before := v_stock.on_hand_quantity;
  v_after  := v_before + p_quantity;

  UPDATE public.warehouse_stock
     SET on_hand_quantity          = v_after,
         central_item_id           = COALESCE(v_stock.central_item_id, p_central_item_id),
         trade_name                = COALESCE(v_trade, trade_name),
         unit                      = COALESCE(v_unit, unit),
         unit_price                = COALESCE(p_unit_price, unit_price),
         price_basis               = COALESCE(v_price_basis, price_basis),
         currency                  = COALESCE(v_currency, currency),
         supply_type_text          = COALESCE(v_supply_type_label, supply_type_text),
         source_document_number    = COALESCE(v_source_doc, source_document_number),
         notes                     = COALESCE(v_notes, notes),
         updated_by                = v_actor
   WHERE id = v_stock.id;

  INSERT INTO public.warehouse_stock_movements (
    warehouse_stock_id, organization_id, warehouse_id,
    movement_type,
    on_hand_before, on_hand_delta, on_hand_after,
    reserved_before, reserved_delta, reserved_after,
    reason, reference_type, reference_id, request_fingerprint,
    source_document_number, actor_id, actor_role, actor_name,
    scientific_name_snapshot, concentration_snapshot,
    dosage_form_snapshot, batch_number_snapshot,
    internal_batch_reference_snapshot
  ) VALUES (
    v_stock.id, v_org, p_warehouse_id,
    'add',
    v_before, p_quantity, v_after,
    v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
    'warehouse_receipt', 'warehouse_request', p_request_id, v_request_fingerprint,
    v_source_doc, v_actor, v_actor_role, v_actor_name,
    v_stock.scientific_name, v_stock.concentration,
    v_stock.dosage_form, v_stock.batch_number,
    v_stock.internal_batch_reference
  )
  RETURNING id INTO v_movement_id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role,
    action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_org, v_actor, v_actor_role,
    'warehouse_stock.receive', 'warehouse_stock', v_stock.id,
    v_stock.scientific_name,
    jsonb_build_object(
      'request_id', p_request_id,
      'warehouse_id', p_warehouse_id,
      'movement_id', v_movement_id,
      'quantity_before', v_before,
      'quantity_delta', p_quantity,
      'quantity_after', v_after,
      'source_document_number', v_source_doc
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'idempotent_replay', false,
    'warehouse_stock_id', v_stock.id,
    'movement_id', v_movement_id,
    'quantity_before', v_before,
    'quantity_delta', p_quantity,
    'quantity_after', v_after
  );
END;
$$;

-- ── B. Generic apply — restrict add/subtract/set_exact to central only ─────

CREATE OR REPLACE FUNCTION public.phoenix_apply_warehouse_stock_movement(
  p_request_id             uuid,
  p_warehouse_stock_id     uuid,
  p_movement_type          text,
  p_amount                 integer,
  p_reason                 text DEFAULT NULL,
  p_source_document_number text DEFAULT NULL,
  p_notes                  text DEFAULT NULL
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
  v_stock       public.warehouse_stock%ROWTYPE;
  v_warehouse_kind text;
  v_existing    public.warehouse_stock_movements%ROWTYPE;
  v_reason      text := NULLIF(btrim(p_reason), '');
  v_source_doc  text := NULLIF(btrim(p_source_document_number), '');
  v_notes       text := NULLIF(btrim(p_notes), '');
  v_before      integer;
  v_after       integer;
  v_delta       integer;
  v_key         text;
  v_movement_id uuid;
  v_request_fingerprint text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_warehouse_stock_id IS NULL THEN
    RAISE EXCEPTION 'warehouse_stock_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_movement_type IS NULL
     OR p_movement_type NOT IN ('set_exact', 'add', 'subtract', 'correction') THEN
    RAISE EXCEPTION 'invalid_warehouse_movement_type' USING ERRCODE = '23514';
  END IF;
  IF p_amount IS NULL THEN
    RAISE EXCEPTION 'amount_required' USING ERRCODE = '23514';
  END IF;
  IF p_movement_type IN ('add', 'subtract') AND p_amount <= 0 THEN
    RAISE EXCEPTION 'amount_must_be_positive' USING ERRCODE = '23514';
  END IF;
  IF p_movement_type IN ('set_exact', 'correction') AND p_amount < 0 THEN
    RAISE EXCEPTION 'amount_must_be_non_negative' USING ERRCODE = '23514';
  END IF;
  IF p_movement_type IN ('set_exact', 'correction') AND v_reason IS NULL THEN
    RAISE EXCEPTION 'warehouse_correction_reason_required'
      USING ERRCODE = '23514';
  END IF;

  v_request_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'adjust',
    'warehouse_stock_id', p_warehouse_stock_id,
    'movement_type', p_movement_type,
    'amount', p_amount,
    'reason', v_reason,
    'source_document_number', v_source_doc,
    'notes', v_notes
  )::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 65065));

  SELECT *
    INTO v_stock
  FROM public.warehouse_stock
  WHERE id = p_warehouse_stock_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse_stock_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- 103: 'add'/'subtract'/'set_exact' invent or erase quantity with no
  -- canonical corridor behind them — refuse for anything but a central
  -- (pharmacy-department) warehouse. 'correction' is UNCHANGED: it is the
  -- audited, second-person-approval-gated path (098/101) for adjusting an
  -- institution warehouse's recorded count, a distinct concept from inventing
  -- quantity outright.
  IF p_movement_type IN ('add', 'subtract', 'set_exact') THEN
    SELECT w.warehouse_kind INTO v_warehouse_kind
    FROM public.warehouses w WHERE w.id = v_stock.warehouse_id;

    IF v_warehouse_kind <> 'central' THEN
      RAISE EXCEPTION 'institution_warehouse_direct_adjustment_forbidden' USING ERRCODE = '42501',
        DETAIL = format('movement_type=%s is central-only; use the correction-request flow (101) instead', p_movement_type);
    END IF;
  END IF;

  v_key := CASE
    WHEN p_movement_type IN ('set_exact', 'correction')
      THEN 'warehouse_stock.correct'
    ELSE 'warehouse_stock.adjust'
  END;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, v_key, v_stock.organization_id, v_stock.warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_warehouse_stock_movement'
      USING ERRCODE = '42501';
  END IF;

  SELECT p.role, p.full_name
    INTO v_actor_role, v_actor_name
  FROM public.profiles p
  WHERE p.id = v_actor
    AND p.status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_existing
  FROM public.warehouse_stock_movements m
  WHERE m.reference_type = 'warehouse_request'
    AND m.reference_id = p_request_id;

  IF FOUND THEN
    IF v_existing.warehouse_stock_id IS DISTINCT FROM p_warehouse_stock_id
       OR v_existing.request_fingerprint IS DISTINCT FROM v_request_fingerprint THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent_replay', true,
      'warehouse_stock_id', v_existing.warehouse_stock_id,
      'movement_id', v_existing.id,
      'movement_type', v_existing.movement_type,
      'quantity_before', v_existing.on_hand_before,
      'quantity_delta', v_existing.on_hand_delta,
      'quantity_after', v_existing.on_hand_after
    );
  END IF;

  v_before := v_stock.on_hand_quantity;

  CASE p_movement_type
    WHEN 'set_exact' THEN
      v_after := p_amount;
      v_delta := p_amount - v_before;
    WHEN 'add' THEN
      v_after := v_before + p_amount;
      v_delta := p_amount;
    WHEN 'subtract' THEN
      v_after := v_before - p_amount;
      v_delta := -p_amount;
    WHEN 'correction' THEN
      v_after := p_amount;
      v_delta := p_amount - v_before;
  END CASE;

  IF v_after < 0 THEN
    RAISE EXCEPTION 'warehouse_quantity_cannot_go_negative'
      USING ERRCODE = '23514';
  END IF;
  IF v_after < v_stock.reserved_quantity THEN
    RAISE EXCEPTION 'warehouse_quantity_below_reserved'
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.warehouse_stock
     SET on_hand_quantity = v_after,
         source_document_number = COALESCE(v_source_doc, source_document_number),
         notes = COALESCE(v_notes, notes),
         updated_by = v_actor
   WHERE id = v_stock.id;

  INSERT INTO public.warehouse_stock_movements (
    warehouse_stock_id, organization_id, warehouse_id,
    movement_type,
    on_hand_before, on_hand_delta, on_hand_after,
    reserved_before, reserved_delta, reserved_after,
    reason, reference_type, reference_id, request_fingerprint,
    source_document_number, actor_id, actor_role, actor_name,
    scientific_name_snapshot, concentration_snapshot,
    dosage_form_snapshot, batch_number_snapshot,
    internal_batch_reference_snapshot
  ) VALUES (
    v_stock.id, v_stock.organization_id, v_stock.warehouse_id,
    p_movement_type,
    v_before, v_delta, v_after,
    v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
    v_reason, 'warehouse_request', p_request_id, v_request_fingerprint,
    v_source_doc, v_actor, v_actor_role, v_actor_name,
    v_stock.scientific_name, v_stock.concentration,
    v_stock.dosage_form, v_stock.batch_number,
    v_stock.internal_batch_reference
  )
  RETURNING id INTO v_movement_id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role,
    action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_stock.organization_id, v_actor, v_actor_role,
    'warehouse_stock.' || p_movement_type,
    'warehouse_stock', v_stock.id, v_stock.scientific_name,
    jsonb_build_object(
      'request_id', p_request_id,
      'warehouse_id', v_stock.warehouse_id,
      'movement_id', v_movement_id,
      'quantity_before', v_before,
      'quantity_delta', v_delta,
      'quantity_after', v_after,
      'reason', v_reason,
      'source_document_number', v_source_doc
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'idempotent_replay', false,
    'warehouse_stock_id', v_stock.id,
    'movement_id', v_movement_id,
    'movement_type', p_movement_type,
    'quantity_before', v_before,
    'quantity_delta', v_delta,
    'quantity_after', v_after
  );
END;
$$;

COMMIT;

-- ============================================================================
-- POST-CONDITIONS
-- ============================================================================
-- 1. phoenix_receive_warehouse_stock (and the 078 guarded wrapper, which
--    delegates to it for both replay and non-replay calls) refuses with
--    institution_warehouse_direct_receipt_forbidden for any p_warehouse_id
--    whose warehouse_kind <> 'central'.
-- 2. phoenix_apply_warehouse_stock_movement (and its 078 guarded wrapper)
--    refuses with institution_warehouse_direct_adjustment_forbidden for
--    movement_type IN ('add','subtract','set_exact') at an institution
--    warehouse; 'correction' is unaffected there, and central warehouses are
--    unaffected for every movement_type.
-- 3. RECONCILIATION: this migration writes no data itself (pure function
--    redefinitions) — both functions' bodies are otherwise byte-identical to
--    088's/065's, diffable outside the two new warehouse_kind checks.
-- ============================================================================
-- ROLLBACK: re-apply 088's (phoenix_receive_warehouse_stock) and 065's
-- (phoenix_apply_warehouse_stock_movement) bodies verbatim. No schema change,
-- no data written by this migration — pure behavior.
-- ============================================================================
