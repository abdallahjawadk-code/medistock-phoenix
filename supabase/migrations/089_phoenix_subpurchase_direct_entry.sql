-- ============================================================================
-- SUBPURCHASE-DIRECT-ENTRY-089   ***PREPARED - DO NOT APPLY TO PRODUCTION***
--
-- MANUAL APPLY ONLY (SQL Editor), after owner review, AFTER 088. Never via
-- `supabase db push`. Tested by replaying 001->089 on the disposable rig.
--
-- WHY
-- The institution's "المشتريات الفرعية" (supplementary purchases) surface must
-- let an authorized warehouse officer record materials the institution ALREADY
-- bought and physically holds — one human-confirmed act, not a visible
-- order -> approval -> receive cycle. 087's public RPCs deliberately enforce
-- approver-must-differ-from-submitter, which is correct for the ORDER cycle
-- but makes a one-operator direct entry impossible through them.
--
-- THE CONTRACT
-- phoenix_subpurchase_direct_entry composes, in ONE transaction, the SAME
-- canonical history 087 writes (order + line + receipt + receipt line +
-- events + audit) and posts stock through the SAME internal poster
-- (_phoenix_procurement_post_receipt_line — which, under 088, pins
-- supply_type='purchase', purchase_origin='supplementary' as lot identity):
--   * organization/warehouse resolved server-side from the warehouse row and
--     the caller's scope — never trusted from the client;
--   * requires BOTH scoped keys the cycle would require:
--     local_procurement.manage AND local_procurement.receive on THAT warehouse
--     (direct entry is never weaker than the cycle it replaces);
--   * the order row records the full provenance of the act: status flows
--     draft->approved->received inside one transaction with decision_notes
--     naming this contract — the separation-of-duty rule remains untouched
--     for the ordinary 087 cycle;
--   * order number is SERVER-generated (SP-YYYY-nnnnnn) — a client can never
--     invent an authoritative-looking number; receipt number reuses 087's
--     server-owned allocator;
--   * idempotent on p_request_id with a request fingerprint: a lost-response
--     retry replays the SAME receipt; a changed payload fails closed
--     (request_id_conflict);
--   * supplier is an OPTIONAL free-text name resolved to a per-org supplier
--     row (get-or-create), defaulting to the generic direct-purchase supplier.
--
-- PRECONDITIONS: 087 + 088 applied. FORWARD-ONLY.
-- ============================================================================

BEGIN;

DO $precond$
BEGIN
  IF to_regclass('public.procurement_orders') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 087 not applied';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='warehouse_stock'
                    AND column_name='supply_type') THEN
    RAISE EXCEPTION 'precondition failed: 088 not applied (provenance columns missing)';
  END IF;
  IF to_regprocedure('public.phoenix_subpurchase_direct_entry(uuid,uuid,text,integer,text,boolean,date,numeric,date,text,text,text,uuid,text,text,text,text,bigint)') IS NOT NULL THEN
    RAISE EXCEPTION 'precondition failed: 089 already applied';
  END IF;
END;
$precond$;

-- Server-owned allocator for direct sub-purchase order numbers.
CREATE SEQUENCE public.procurement_direct_order_number_seq;
REVOKE ALL ON SEQUENCE public.procurement_direct_order_number_seq FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.phoenix_subpurchase_direct_entry(
  p_request_id       uuid,
  p_warehouse_id     uuid,
  p_scientific_name  text,
  p_quantity         integer,
  p_batch_number     text,
  p_has_no_batch     boolean,
  p_expiry_date      date,
  p_unit_price       numeric,
  p_purchase_date    date    DEFAULT NULL,
  p_invoice_number   text    DEFAULT NULL,
  p_supplier_name    text    DEFAULT NULL,
  p_notes            text    DEFAULT NULL,
  p_central_item_id  uuid    DEFAULT NULL,
  p_trade_name       text    DEFAULT NULL,
  p_concentration    text    DEFAULT NULL,
  p_dosage_form      text    DEFAULT NULL,
  p_unit             text    DEFAULT NULL,
  p_expected_generation bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $direct_entry$
DECLARE
  v_actor         uuid := auth.uid();
  v_actor_role    text;
  v_actor_name    text;
  v_wh            public.warehouses%ROWTYPE;
  v_supplier_id   uuid;
  v_supplier_name text := COALESCE(NULLIF(btrim(COALESCE(p_supplier_name, '')), ''), 'شراء مباشر');
  v_name          text := NULLIF(btrim(COALESCE(p_scientific_name, '')), '');
  v_batch         text := NULLIF(btrim(COALESCE(p_batch_number, '')), '');
  v_no_batch      boolean := COALESCE(p_has_no_batch, false);
  v_notes         text := NULLIF(btrim(COALESCE(p_notes, '')), '');
  v_number        text;
  v_order         public.procurement_orders%ROWTYPE;
  v_line          public.procurement_order_lines%ROWTYPE;
  v_receipt       public.procurement_receipts%ROWTYPE;
  v_receipt_line  public.procurement_receipt_lines%ROWTYPE;
  v_existing      public.procurement_receipts%ROWTYPE;
  v_stock_id      uuid;
  v_movement_id   uuid;
  v_fingerprint   text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514';
  END IF;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'scientific_name_required' USING ERRCODE = '23514';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;
  IF v_no_batch IS DISTINCT FROM (v_batch IS NULL) THEN
    RAISE EXCEPTION 'batch_number_flag_mismatch' USING ERRCODE = '23514';
  END IF;
  IF p_unit_price IS NOT NULL AND p_unit_price < 0 THEN
    RAISE EXCEPTION 'unit_price_must_be_non_negative' USING ERRCODE = '23514';
  END IF;

  -- 087 receipt fingerprints are sha256 hex (table CHECK ~ '^[0-9a-f]{64}$').
  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'warehouse', p_warehouse_id, 'name', v_name, 'qty', p_quantity,
    'batch', v_batch, 'no_batch', v_no_batch, 'expiry', p_expiry_date,
    'price', p_unit_price, 'invoice', NULLIF(btrim(COALESCE(p_invoice_number, '')), ''),
    'supplier', v_supplier_name)::text, 'UTF8')), 'hex');

  -- Serialize retries BEFORE any row lock (065/087 advisory-lock-first order).
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 89089));

  SELECT * INTO v_existing FROM public.procurement_receipts r
  WHERE r.request_id = p_request_id;
  IF FOUND THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505';
    END IF;
    SELECT * INTO v_order FROM public.procurement_orders WHERE id = v_existing.order_id;
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true,
      'order_id', v_order.id, 'order_number', v_order.order_number,
      'receipt_id', v_existing.id, 'receipt_number', v_existing.receipt_number,
      'order_status', v_order.status);
  END IF;

  SELECT * INTO v_wh FROM public.warehouses WHERE id = p_warehouse_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_wh.warehouse_kind <> 'institution' OR v_wh.status <> 'active' THEN
    RAISE EXCEPTION 'destination_must_be_active_institution_warehouse' USING ERRCODE = '23514';
  END IF;

  -- THE IDOR GATE: direct entry demands BOTH scoped authorities the ordinary
  -- cycle would demand, on the PURCHASING warehouse resolved server-side.
  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'local_procurement.manage', v_wh.organization_id, p_warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_local_procurement_manage' USING ERRCODE = '42501';
  END IF;
  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'local_procurement.receive', v_wh.organization_id, p_warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_local_procurement_receive' USING ERRCODE = '42501';
  END IF;

  SELECT o_role, o_name INTO v_actor_role, v_actor_name
  FROM public._phoenix_procurement_actor(v_actor);

  -- Supplier: get-or-create the per-org row for the (optional) free-text name.
  SELECT id INTO v_supplier_id FROM public.procurement_suppliers
   WHERE organization_id = v_wh.organization_id AND lower(name) = lower(v_supplier_name);
  IF v_supplier_id IS NULL THEN
    BEGIN
      INSERT INTO public.procurement_suppliers (organization_id, name, name_ar, status, created_by, updated_by)
      VALUES (v_wh.organization_id, v_supplier_name, v_supplier_name, 'active', v_actor, v_actor)
      RETURNING id INTO v_supplier_id;
    EXCEPTION WHEN unique_violation THEN
      SELECT id INTO v_supplier_id FROM public.procurement_suppliers
       WHERE organization_id = v_wh.organization_id AND lower(name) = lower(v_supplier_name);
    END;
  END IF;

  -- SERVER-generated official number: SP-YYYY-nnnnnn (never client-invented).
  v_number := 'SP-' || to_char(now(), 'YYYY') || '-' ||
              lpad(nextval('public.procurement_direct_order_number_seq')::text, 6, '0');

  -- The order records the WHOLE direct act. draft->approved happens inside
  -- this single reviewed transaction with an explicit decision note; the
  -- approver-must-differ rule of the interactive cycle is not weakened — this
  -- is a distinct, fully-audited contract requiring BOTH scoped authorities.
  INSERT INTO public.procurement_orders (
    organization_id, warehouse_id, supplier_id, order_number, status,
    invoice_number, invoice_date, external_reference, currency, notes,
    ocr_assisted, created_by,
    submitted_by, submitted_at, decided_by, decided_at, decision_notes
  ) VALUES (
    v_wh.organization_id, p_warehouse_id, v_supplier_id, v_number, 'approved',
    NULLIF(btrim(COALESCE(p_invoice_number, '')), ''), p_purchase_date,
    NULL, NULL, v_notes,
    false, v_actor,
    v_actor, now(), v_actor, now(),
    'direct sub-purchase entry (089): manage+receive scoped authorities verified'
  )
  RETURNING * INTO v_order;

  PERFORM public._phoenix_procurement_log_event(
    v_order, 'created', NULL, 'approved', v_actor, v_actor_role, v_actor_name, v_notes,
    jsonb_build_object('direct_entry', true, 'request_id', p_request_id));

  INSERT INTO public.procurement_order_lines (
    order_id, organization_id, central_item_id,
    scientific_name, trade_name, concentration, dosage_form, unit,
    national_code, batch_number, expiry_date,
    ordered_quantity, unit_price, currency, notes
  ) VALUES (
    v_order.id, v_order.organization_id, p_central_item_id,
    v_name, NULLIF(btrim(COALESCE(p_trade_name, '')), ''),
    NULLIF(btrim(COALESCE(p_concentration, '')), ''),
    NULLIF(btrim(COALESCE(p_dosage_form, '')), ''),
    NULLIF(btrim(COALESCE(p_unit, '')), ''),
    NULL, v_batch, p_expiry_date,
    p_quantity, p_unit_price, NULL, NULL
  )
  RETURNING * INTO v_line;

  INSERT INTO public.procurement_receipts (
    order_id, organization_id, warehouse_id, supplier_id,
    receipt_number, request_id, request_fingerprint,
    invoice_number, notes, received_by, received_by_role, received_by_name
  ) VALUES (
    v_order.id, v_order.organization_id, v_order.warehouse_id, v_order.supplier_id,
    'PR-' || to_char(now(), 'YYYY') || '-' ||
      lpad(nextval('public.procurement_receipt_number_seq')::text, 6, '0'),
    p_request_id, v_fingerprint,
    v_order.invoice_number, v_notes, v_actor, v_actor_role, v_actor_name
  )
  RETURNING * INTO v_receipt;

  INSERT INTO public.procurement_receipt_lines (
    receipt_id, order_line_id, organization_id, quantity,
    batch_number, has_no_batch_number,
    national_code, has_no_national_code,
    expiry_date, unit_price
  ) VALUES (
    v_receipt.id, v_line.id, v_order.organization_id, p_quantity,
    v_batch, v_no_batch,
    v_line.national_code, v_line.national_code IS NULL,
    COALESCE(p_expiry_date, v_line.expiry_date),
    COALESCE(p_unit_price, v_line.unit_price)
  )
  RETURNING * INTO v_receipt_line;

  -- Stock lands through the SAME internal poster the 087 cycle uses — under
  -- 088 it pins supply_type='purchase', purchase_origin='supplementary' as
  -- part of lot identity, so a sub-purchase can never merge with a central lot.
  SELECT o_warehouse_stock_id, o_movement_id
    INTO v_stock_id, v_movement_id
  FROM public._phoenix_procurement_post_receipt_line(
    v_receipt_line, v_order, v_line, v_actor, v_actor_role, v_actor_name);

  UPDATE public.procurement_receipt_lines
     SET warehouse_stock_id = v_stock_id, movement_id = v_movement_id
   WHERE id = v_receipt_line.id;

  UPDATE public.procurement_order_lines
     SET received_quantity = received_quantity + p_quantity, updated_at = now()
   WHERE id = v_line.id;

  PERFORM public._phoenix_procurement_log_event(
    v_order, 'receipt_posted', 'approved', 'received',
    v_actor, v_actor_role, v_actor_name, v_notes,
    jsonb_build_object('receipt_id', v_receipt.id, 'receipt_number', v_receipt.receipt_number,
                       'direct_entry', true));

  UPDATE public.procurement_orders SET status = 'received', updated_at = now()
  WHERE id = v_order.id
  RETURNING * INTO v_order;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_order.organization_id, v_actor, v_actor_role,
    'local_procurement.direct_entry', 'procurement_receipts', v_receipt.id,
    v_receipt.receipt_number,
    jsonb_build_object('order_id', v_order.id, 'order_number', v_order.order_number,
                       'warehouse_id', p_warehouse_id, 'request_id', p_request_id,
                       'warehouse_stock_id', v_stock_id, 'movement_id', v_movement_id)
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'order_id', v_order.id, 'order_number', v_order.order_number,
    'receipt_id', v_receipt.id, 'receipt_number', v_receipt.receipt_number,
    'order_status', v_order.status,
    'warehouse_stock_id', v_stock_id, 'movement_id', v_movement_id);
END;
$direct_entry$;

REVOKE ALL ON FUNCTION public.phoenix_subpurchase_direct_entry(
  uuid, uuid, text, integer, text, boolean, date, numeric, date, text, text,
  text, uuid, text, text, text, text, bigint
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_subpurchase_direct_entry(
  uuid, uuid, text, integer, text, boolean, date, numeric, date, text, text,
  text, uuid, text, text, text, text, bigint
) TO authenticated;

COMMENT ON FUNCTION public.phoenix_subpurchase_direct_entry(
  uuid, uuid, text, integer, text, boolean, date, numeric, date, text, text,
  text, uuid, text, text, text, text, bigint
) IS
  'One-act supplementary-purchase entry: composes the same canonical 087 '
  'history (order+line+receipt+events+audit) and posts stock through the same '
  'internal poster (088: pinned purchase/supplementary lot identity). '
  'Requires local_procurement.manage AND .receive on the warehouse; '
  'idempotent on request id; server-generated SP- order number.';

COMMIT;

-- ============================================================================
-- POST-CONDITIONS (read-only, after apply):
--   SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--    WHERE n.nspname='public' AND p.proname='phoenix_subpurchase_direct_entry';  -- 1
--   SELECT has_function_privilege('authenticated',
--     'public.phoenix_subpurchase_direct_entry(uuid,uuid,text,integer,text,boolean,date,numeric,date,text,text,text,uuid,text,text,text,text,bigint)','EXECUTE'); -- t
-- ROLLBACK (lossless for the contract): DROP FUNCTION + DROP SEQUENCE
--   public.procurement_direct_order_number_seq (history rows remain, immutable).
-- ============================================================================
