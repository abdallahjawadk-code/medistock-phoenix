-- ============================================================================
-- CENTRAL-INTAKE-MANUAL-IDENTITY-118   ***PREPARED - DO NOT APPLY TO PRODUCTION***
--
-- FORWARD-ONLY correction after 115. Manual apply only after owner review and
-- after migrations 114-117. Never via an unattended production runner.
--
-- PRODUCT CONTRACT
-- Pharmacy Department central warehouses are a distinct intake authority:
-- they receive stock from their own main stores and therefore enter material
-- identity manually. This corridor is separate from supplementary purchases.
--
--   * p_central_item_id is forbidden: there is no optional catalog picker.
--   * scientific/trade name, concentration, dosage form and national code are
--     human-entered receipt identity fields, with the explicit absence flags
--     still enforced fail-closed.
--   * supply type is mandatory and closed to aid/purchase/kimadia.
--   * a purchase posted here is always purchase_origin='central', regardless
--     of a missing client origin; 'supplementary' is rejected.
--   * institution warehouses remain receive-only through canonical transfer
--     and return corridors (103); this function still rejects them.
--   * supply_type and purchase_origin participate in both lot identity and the
--     idempotency fingerprint, keeping central and supplementary balances
--     separate even for the same material/batch/expiry.
--
-- No table, sequence, document-number, or historical-row rewrite is performed.
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
  -- 118: identity is entered manually in the Pharmacy Department corridor.
  v_scientific     text := NULLIF(btrim(p_scientific_name), '');
  v_trade          text := NULLIF(btrim(p_trade_name), '');
  v_concentration  text := NULLIF(btrim(p_concentration), '');
  v_dosage         text := NULLIF(btrim(p_dosage_form), '');
  v_national       text := NULLIF(btrim(p_national_code), '');
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

  -- 118: the central Pharmacy Department intake surface is manual-only.
  IF p_central_item_id IS NOT NULL THEN
    RAISE EXCEPTION 'central_catalog_selection_forbidden' USING ERRCODE = '23514',
      DETAIL = 'Pharmacy Department warehouse intake accepts manual identity only; supplementary purchases remain a separate corridor';
  END IF;
  IF v_scientific IS NULL THEN
    RAISE EXCEPTION 'scientific_name_required' USING ERRCODE = '23514';
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
  IF v_supply_type IS NULL THEN
    RAISE EXCEPTION 'supply_type_required' USING ERRCODE = '23514';
  END IF;
  IF v_supply_type NOT IN ('aid', 'purchase', 'kimadia') THEN
    RAISE EXCEPTION 'invalid_supply_type' USING ERRCODE = '23514';
  END IF;
  IF v_supply_type = 'purchase' THEN
    IF v_origin IS NOT NULL AND v_origin <> 'central' THEN
      RAISE EXCEPTION 'central_intake_supplementary_origin_forbidden' USING ERRCODE = '23514',
        DETAIL = 'supplementary purchases must be posted through phoenix_subpurchase_direct_entry';
    END IF;
    v_origin := 'central';
  ELSIF v_origin IS NOT NULL THEN
    RAISE EXCEPTION 'purchase_origin_without_purchase' USING ERRCODE = '23514';
  END IF;
  IF p_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'warehouse_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity_must_be_positive' USING ERRCODE = '23514';
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

  -- 118: no catalog resolution occurs here. The operator-entered identity above
  -- is the identity posted to the central Pharmacy Department ledger. The
  -- institution-warehouse gate remains immediately above and fail-closed.

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
    'has_no_national_code', p_has_no_national_code,
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
    'notes', v_notes,
    'supply_type', v_supply_type,
    'purchase_origin', v_origin
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

  v_before := v_stock.on_hand_quantity;
  v_after  := v_before + p_quantity;

  UPDATE public.warehouse_stock
     SET on_hand_quantity          = v_after,
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

-- 080 discipline remains intact: the unguarded writer is an internal
-- SECURITY DEFINER implementation. Clients use the generation-guarded wrapper.
REVOKE ALL ON FUNCTION public.phoenix_receive_warehouse_stock(
  uuid, uuid, text, integer, boolean, boolean, uuid, text, text, text, text,
  text, text, date, numeric, text, text, text, text, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_receive_warehouse_stock(
  uuid, uuid, text, integer, boolean, boolean, uuid, text, text, text, text,
  text, text, date, numeric, text, text, text, text, text, text, text
) TO service_role;

DO $verify$
DECLARE
  v_raw regprocedure := to_regprocedure(
    'public.phoenix_receive_warehouse_stock(uuid,uuid,text,integer,boolean,boolean,uuid,text,text,text,text,text,text,date,numeric,text,text,text,text,text,text,text)'
  );
BEGIN
  IF v_raw IS NULL THEN
    RAISE EXCEPTION '118 verification failed: raw intake function missing';
  END IF;
  IF (
    SELECT count(*)
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'phoenix_receive_warehouse_stock'
  ) <> 1 THEN
    RAISE EXCEPTION '118 verification failed: raw intake overload count is not one';
  END IF;
  IF has_function_privilege('authenticated', v_raw, 'EXECUTE') THEN
    RAISE EXCEPTION '118 verification failed: authenticated can execute raw intake writer';
  END IF;
  IF NOT has_function_privilege(
    'authenticated',
    'public.phoenix_receive_warehouse_stock_guarded(uuid,uuid,text,integer,boolean,boolean,bigint,uuid,text,text,text,text,text,text,date,numeric,text,text,text,text,text,text,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION '118 verification failed: guarded intake writer unavailable';
  END IF;
END;
$verify$;

COMMIT;

-- ============================================================================
-- POST-CONDITIONS (read-only):
--   raw phoenix_receive_warehouse_stock overload count = 1;
--   authenticated raw EXECUTE = false; guarded EXECUTE = true;
--   p_central_item_id != NULL is rejected before any ledger mutation;
--   purchase receipts written here carry purchase_origin='central';
--   institution warehouses remain direct-entry forbidden.
-- ROLLBACK: re-apply migration 115's function body and ACL intentionally.
-- ============================================================================
