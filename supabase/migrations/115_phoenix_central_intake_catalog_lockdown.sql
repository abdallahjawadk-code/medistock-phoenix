-- ============================================================================
-- CENTRAL-INTAKE-CATALOG-LOCKDOWN-115   ***PREPARED - DO NOT APPLY TO PRODUCTION***
--
-- MANUAL APPLY ONLY (SQL Editor), after owner review, AFTER 114. Never via
-- `supabase db push`. Tested by replaying 001->115 on the disposable rig.
--
-- WHY
-- The supplementary-purchases redesign's contract: manual/free-text creation
-- of a NEW material identity is allowed ONLY inside supplementary purchases
-- (089/116/117). 103 already forbids `phoenix_receive_warehouse_stock` for
-- institution-kind warehouses, but for the remaining (central,
-- pharmacy-department) case it still accepted hand-typed
-- scientific_name/trade_name/concentration/dosage_form/national_code —
-- exactly the free-text identity path this redesign closes everywhere except
-- supplementary purchases. 114 gave `central_items` the columns needed to
-- carry that detail (trade_name/concentration/dosage_form; barcode already
-- serves as national code) so a central intake receipt can be built from a
-- catalog row alone.
--
-- FIX: full redefinition (same signature/name, no overload; the 078 guarded
-- wrapper and OCR-assisted flow both delegate straight into this body, so the
-- lock applies to every live entry point with zero additional edits):
--   - p_central_item_id becomes MANDATORY for the surviving (central-only,
--     post-103) case — raises `central_item_required` when absent.
--   - the catalog row (must be status='active') is loaded and its
--     name/trade_name/concentration/dosage_form/barcode become the receipt's
--     scientific_name/trade_name/concentration/dosage_form/national_code,
--     UNCONDITIONALLY — any client-sent free text for these five fields is
--     ignored, never trusted, never merged. `p_unit`, batch, expiry,
--     quantity, price, supply_type/kimadia-aid-purchase, source document
--     number and notes remain exactly what they always were: receipt data,
--     still hand-entered per receipt.
--   - the request fingerprint is built from the CATALOG-DERIVED identity
--     (not the now-ignored client text), so idempotency keys off what was
--     actually written.
-- Every other line of business logic (idempotent replay, lot-merge identity
-- resolution, movement/audit writes) is preserved verbatim from 103.
--
-- PRECONDITIONS: 103 + 114 applied. FORWARD-ONLY.
-- ============================================================================

BEGIN;

DO $precond$
BEGIN
  IF to_regprocedure(
    'public.phoenix_receive_warehouse_stock(uuid,uuid,text,integer,boolean,boolean,uuid,text,text,text,text,text,text,date,numeric,text,text,text,text,text,text,text)'
  ) IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 065/088/103 phoenix_receive_warehouse_stock is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'central_items'
       AND column_name = 'trade_name'
  ) THEN
    RAISE EXCEPTION 'precondition failed: 114 central_items catalog detail columns are missing';
  END IF;
END;
$precond$;

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
  v_catalog        public.central_items%ROWTYPE;
  -- 115: identity fields are CATALOG-DERIVED, never client free text.
  v_scientific     text;
  v_trade          text;
  v_concentration  text;
  v_dosage         text;
  v_national       text;
  v_has_no_national boolean;
  v_unit           text := NULLIF(btrim(p_unit), '');
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
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;
  IF p_has_no_batch_number IS NULL THEN
    RAISE EXCEPTION 'explicit_identity_flags_required' USING ERRCODE = '23514';
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

  -- 115: central intake selects a catalog row — free-typing a NEW material
  -- identity here is reserved for supplementary purchases (089/116) only.
  IF p_central_item_id IS NULL THEN
    RAISE EXCEPTION 'central_item_required' USING ERRCODE = '23514',
      DETAIL = 'central warehouse intake must select a unified drug catalog item; manual identity entry is only available in supplementary purchases';
  END IF;

  SELECT * INTO v_catalog
  FROM public.central_items
  WHERE id = p_central_item_id
    AND status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'central_item_not_found_or_inactive' USING ERRCODE = 'P0002';
  END IF;

  v_scientific      := v_catalog.name;
  v_trade           := NULLIF(btrim(v_catalog.trade_name), '');
  v_concentration   := NULLIF(btrim(v_catalog.concentration), '');
  v_dosage          := NULLIF(btrim(v_catalog.dosage_form), '');
  v_national        := NULLIF(btrim(v_catalog.barcode), '');
  v_has_no_national := (v_national IS NULL);

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
    'central_item_id', p_central_item_id,
    'scientific_name', v_scientific,
    'quantity', p_quantity,
    'has_no_national_code', v_has_no_national,
    'has_no_batch_number', p_has_no_batch_number,
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
    v_national, v_has_no_national,
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
     AND v_stock.central_item_id IS DISTINCT FROM p_central_item_id THEN
    RAISE EXCEPTION 'warehouse_stock_central_item_conflict'
      USING ERRCODE = '23514';
  END IF;

  v_before := v_stock.on_hand_quantity;
  v_after  := v_before + p_quantity;

  UPDATE public.warehouse_stock
     SET on_hand_quantity          = v_after,
         central_item_id           = p_central_item_id,
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
      'central_item_id', p_central_item_id,
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

COMMIT;

-- ============================================================================
-- POST-CONDITIONS (read-only, after apply):
--   SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--    WHERE n.nspname='public' AND p.proname='phoenix_receive_warehouse_stock'; -- 1
--   A call with p_central_item_id => NULL raises central_item_required.
--   A call with a valid catalog id ignores any client-sent
--   scientific_name/trade_name/concentration/dosage_form/national_code and
--   writes the catalog's values instead.
-- RECONCILIATION: pure function redefinition, no data written, no
-- schema/grant change (078's guarded wrapper delegates by name to this body,
-- so no wrapper edit is needed).
-- ROLLBACK: re-apply 103's body of phoenix_receive_warehouse_stock verbatim.
-- ============================================================================
