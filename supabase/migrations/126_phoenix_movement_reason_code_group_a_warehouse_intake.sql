-- ============================================================================
-- MOVEMENT-REASON-CODE-GROUP-A-WAREHOUSE-INTAKE-126
--
-- Sixth slice of Unified Movements & Outlet Operations (PR #57, item A).
-- First of eight independently-verified domain slices wiring reason_code +
-- server-owned correlation_id/causation_id into the 20 audited ledger-writer
-- RPCs (125 added the column; this and following slices populate it,
-- function by function, never all at once).
--
-- GROUP A — warehouse receive/intake, the two TRUE ROOT operations (no
-- upstream canonical event exists to chain from):
--
--   * phoenix_receive_warehouse_stock (118) — central Pharmacy Department
--     manual intake. reason_code is fully server-derived: this function has
--     exactly one operation ('add' a fresh receipt), so reason_code is the
--     hardcoded literal 'received', never client input. correlation_id is
--     freshly generated (gen_random_uuid()) — this movement IS the start of
--     a new correlation chain (a future receive-side reconciliation slice
--     may thread it into phoenix_movement_events' trace_id). causation_id
--     stays NULL: there is no preceding canonical event, by design (this is
--     the entry point of supply into the central warehouse).
--
--   * phoenix_apply_warehouse_stock_movement (103) — manual central-only
--     add/subtract/set_exact, or an operator-invoked correction. This is
--     the ONE function in the whole 20-writer audit that accepts
--     UNRESTRICTED CLIENT FREE TEXT into the ledger's reason column today,
--     with zero vocabulary check. Signature gains exactly one new OPTIONAL,
--     trailing, DEFAULT-valued parameter (p_reason_code) — every existing
--     caller keeps working unchanged. p_reason_code is validated against a
--     CLOSED SUBSET of 125's vocabulary appropriate to a manual quantity
--     adjustment (the 9 pre-existing quality/loss values, plus the generic
--     'corrected', plus 'other' — NOT 'received'/'transferred'/'dispensed'/
--     'counted'/'released', which belong to other operations entirely).
--     Mandatory whenever the existing free-text p_reason already is
--     (set_exact/correction); defaults to 'corrected' when the operator
--     omits it for add/subtract. The value is never trusted as arbitrary
--     text -- it must be one of the CHECK-permitted set validated in
--     PL/pgSQL AND is re-enforced by 125's table-level CHECK constraint
--     regardless. correlation_id is freshly generated for every call: the
--     audit confirmed the second-person-approval correction flow (101) does
--     NOT delegate to this function (it inlines its own INSERT — see the
--     Group H slice), so every call this function itself makes is
--     genuinely root-like as coded today; causation_id stays NULL.
--
-- Both functions keep every existing validation, permission check,
-- idempotency mechanism (SELECT-then-short-circuit under
-- pg_advisory_xact_lock, unchanged lock keys), and audit_logs write
-- byte-for-byte identical to their current bodies -- the only change is the
-- reason_code/correlation_id values threaded into the movement INSERT (and,
-- for 103 only, the one new optional parameter).
--
-- PRECONDITIONS: 125 applied (reason_code column + CHECK vocabulary live on
--   all three ledgers).
-- ============================================================================

DO $precond$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'warehouse_stock_movements'
       AND column_name = 'reason_code'
  ) THEN
    RAISE EXCEPTION '126 PRECONDITION FAILED: 125 (reason_code column) missing — apply 125 first';
  END IF;
END;
$precond$;

-- ── A1. phoenix_receive_warehouse_stock — root, reason_code='received' ──────

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
  v_correlation_id uuid := gen_random_uuid();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514';
  END IF;

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
    reason, reason_code, reference_type, reference_id, request_fingerprint,
    source_document_number, actor_id, actor_role, actor_name,
    scientific_name_snapshot, concentration_snapshot,
    dosage_form_snapshot, batch_number_snapshot,
    internal_batch_reference_snapshot,
    correlation_id
  ) VALUES (
    v_stock.id, v_org, p_warehouse_id,
    'add',
    v_before, p_quantity, v_after,
    v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
    'warehouse_receipt', 'received', 'warehouse_request', p_request_id, v_request_fingerprint,
    v_source_doc, v_actor, v_actor_role, v_actor_name,
    v_stock.scientific_name, v_stock.concentration,
    v_stock.dosage_form, v_stock.batch_number,
    v_stock.internal_batch_reference,
    v_correlation_id
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

-- CREATE OR REPLACE FUNCTION preserves existing GRANT/REVOKE state in
-- Postgres -- this function's EXECUTE-revoked-from-authenticated ACL
-- (established when it was first created; verified below) is untouched by
-- this redefinition, no re-REVOKE needed or issued here.

-- ── A2. phoenix_apply_warehouse_stock_movement — root, validated reason_code ─
--
-- Postgres identifies a function by name + ARGUMENT TYPE LIST, not by name
-- alone. Adding a new trailing parameter changes that type list, so
-- CREATE OR REPLACE FUNCTION here would silently create a SECOND, separate
-- overload rather than replacing the existing one -- leaving the old
-- 7-argument version still present and still callable (with no reason_code
-- handling at all), a genuine correctness bug, not a cosmetic one. The old
-- overload is dropped explicitly first. DROP FUNCTION strips the function's
-- ACL entirely (unlike CREATE OR REPLACE, which preserves it), so the
-- internal-only access this function has had since migration 080
-- (EXECUTE revoked from authenticated; reachable only through
-- phoenix_apply_warehouse_stock_movement_guarded, 078) is explicitly
-- re-established below the new CREATE OR REPLACE.

DROP FUNCTION IF EXISTS public.phoenix_apply_warehouse_stock_movement(
  uuid, uuid, text, integer, text, text, text
);

CREATE OR REPLACE FUNCTION public.phoenix_apply_warehouse_stock_movement(
  p_request_id             uuid,
  p_warehouse_stock_id     uuid,
  p_movement_type          text,
  p_amount                 integer,
  p_reason                 text DEFAULT NULL,
  p_source_document_number text DEFAULT NULL,
  p_notes                  text DEFAULT NULL,
  p_reason_code            text DEFAULT NULL
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
  v_reason_code text := NULLIF(btrim(p_reason_code), '');
  v_source_doc  text := NULLIF(btrim(p_source_document_number), '');
  v_notes       text := NULLIF(btrim(p_notes), '');
  v_before      integer;
  v_after       integer;
  v_delta       integer;
  v_key         text;
  v_movement_id uuid;
  v_request_fingerprint text;
  v_correlation_id uuid := gen_random_uuid();
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

  -- 126: reason_code is a manual-adjustment/anomaly code, never the routine
  -- received/transferred/dispensed/counted/released vocabulary that belongs
  -- to other operations entirely. Mandatory in lockstep with the existing
  -- free-text reason requirement; defaults to the generic 'corrected' for
  -- add/subtract when the operator does not supply one. Always re-checked
  -- against 125's table-level CHECK regardless of this validation.
  IF v_reason_code IS NOT NULL AND v_reason_code NOT IN (
    'excess', 'shipment_error', 'near_expiry', 'expired', 'damaged',
    'recalled', 'quality_issue', 'temperature_excursion', 'corrected', 'other'
  ) THEN
    RAISE EXCEPTION 'invalid_warehouse_movement_reason_code' USING ERRCODE = '23514';
  END IF;
  IF p_movement_type IN ('set_exact', 'correction') AND v_reason_code IS NULL THEN
    RAISE EXCEPTION 'warehouse_correction_reason_code_required'
      USING ERRCODE = '23514';
  END IF;
  IF v_reason_code IS NULL THEN
    v_reason_code := 'corrected';
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
    reason, reason_code, reference_type, reference_id, request_fingerprint,
    source_document_number, actor_id, actor_role, actor_name,
    scientific_name_snapshot, concentration_snapshot,
    dosage_form_snapshot, batch_number_snapshot,
    internal_batch_reference_snapshot,
    correlation_id
  ) VALUES (
    v_stock.id, v_stock.organization_id, v_stock.warehouse_id,
    p_movement_type,
    v_before, v_delta, v_after,
    v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
    v_reason, v_reason_code, 'warehouse_request', p_request_id, v_request_fingerprint,
    v_source_doc, v_actor, v_actor_role, v_actor_name,
    v_stock.scientific_name, v_stock.concentration,
    v_stock.dosage_form, v_stock.batch_number,
    v_stock.internal_batch_reference,
    v_correlation_id
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
      'reason_code', v_reason_code,
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

-- Re-establish the internal-only ACL the DROP above erased: nobody but the
-- function owner may EXECUTE this directly, matching its state since 080.
REVOKE ALL ON FUNCTION public.phoenix_apply_warehouse_stock_movement(
  uuid, uuid, text, integer, text, text, text, text
) FROM PUBLIC, anon, authenticated;

DO $verify$
DECLARE
  v_receive_execute_authenticated boolean;
  v_apply_signature text;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
     WHERE routine_schema = 'public'
       AND routine_name = 'phoenix_receive_warehouse_stock'
       AND grantee = 'authenticated'
  ) INTO v_receive_execute_authenticated;
  IF v_receive_execute_authenticated THEN
    RAISE EXCEPTION '126 VERIFY FAILED: phoenix_receive_warehouse_stock must stay EXECUTE-revoked from authenticated (reachable only via its _guarded wrapper)';
  END IF;

  SELECT pg_get_function_arguments(p.oid) INTO v_apply_signature
  FROM pg_proc p
  WHERE p.proname = 'phoenix_apply_warehouse_stock_movement'
    AND p.pronamespace = 'public'::regnamespace;
  IF v_apply_signature IS NULL OR v_apply_signature NOT LIKE '%p_reason_code text DEFAULT NULL%' THEN
    RAISE EXCEPTION '126 VERIFY FAILED: phoenix_apply_warehouse_stock_movement missing the new optional p_reason_code parameter, got: %', v_apply_signature;
  END IF;

  RAISE NOTICE 'MOVEMENT-REASON-CODE-GROUP-A-WAREHOUSE-INTAKE-126: verified.';
END;
$verify$;
