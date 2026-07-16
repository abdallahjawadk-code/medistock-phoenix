-- =============================================================================
-- MediStock Phoenix V2 — Migration 065: Warehouse truth boundary + stock RPCs
-- =============================================================================
-- MANUAL APPLY ONLY. DO NOT use supabase db push or any automated runner.
-- Do not apply to production until the protected-preview/staging validation,
-- reviewed SQL plan, backup/rollback plan, and explicit production approval.
--
-- Prerequisites: migrations 001–064 applied and healthy.
--
-- This migration is additive and does three things:
--   A. makes outlet availability provenance explicit (manual vs warehouse dispatch);
--   B. prevents manual quantity/editor paths from mutating warehouse-managed rows;
--   C. adds idempotent, scoped, audited warehouse receipt/adjustment RPCs.
--
-- It does NOT create dispatch lifecycle RPCs (066), scope administration RPCs
-- (067), UI, RBAC enforcement, data backfills, deletes, or public QR fields.
-- Historical migrations 001–064 remain untouched.
-- =============================================================================

begin;

-- =============================================================================
-- A. Explicit outlet provenance boundary
-- =============================================================================

ALTER TABLE public.item_availability
  ADD COLUMN IF NOT EXISTS source_kind text NOT NULL DEFAULT 'manual';

DO $$ BEGIN
  ALTER TABLE public.item_availability
    ADD CONSTRAINT item_availability_source_kind_chk
    CHECK (source_kind IN ('manual', 'warehouse_dispatch'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN public.item_availability.source_kind IS
  'Inventory authority boundary. manual = legacy/manual outlet row; '
  'warehouse_dispatch = projection created only by reviewed dispatch acceptance. '
  'Existing rows default to manual. Never exposed through public QR.';

-- A warehouse-managed outlet row is server-owned. Migration 066 will set the
-- transaction-local phoenix.dispatch_write flag immediately before its atomic
-- acceptance write. No public/authenticated function exposes that flag.
CREATE OR REPLACE FUNCTION public.phoenix_guard_availability_source_kind()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dispatch_write boolean :=
    COALESCE(current_setting('phoenix.dispatch_write', true), '') = 'on';
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.source_kind = 'warehouse_dispatch' AND NOT v_dispatch_write THEN
      RAISE EXCEPTION 'warehouse_managed_availability_server_only'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.source_kind IS DISTINCT FROM OLD.source_kind AND NOT v_dispatch_write THEN
    RAISE EXCEPTION 'availability_source_kind_immutable'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.source_kind = 'warehouse_dispatch' AND NOT v_dispatch_write THEN
    RAISE EXCEPTION 'warehouse_managed_availability_read_only'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_guard_availability_source_kind()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_availability_source_kind
  ON public.item_availability;
CREATE TRIGGER trg_guard_availability_source_kind
  BEFORE INSERT OR UPDATE ON public.item_availability
  FOR EACH ROW
  EXECUTE FUNCTION public.phoenix_guard_availability_source_kind();

-- The existing manual movement RPC predates source_kind. Preserve its reviewed
-- implementation under a private name and put the provenance check at the
-- stable public signature. Re-application is safe: rename happens only once.
DO $$
BEGIN
  IF to_regprocedure(
       'public.phoenix_apply_manual_availability_movement_internal(uuid,text,integer,text,text)'
     ) IS NULL THEN
    ALTER FUNCTION public.phoenix_apply_availability_movement(
      uuid, text, integer, text, text
    ) RENAME TO phoenix_apply_manual_availability_movement_internal;
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.phoenix_apply_manual_availability_movement_internal(
  uuid, text, integer, text, text
) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.phoenix_apply_availability_movement(
  p_item_availability_id uuid,
  p_movement_type        text,
  p_amount               integer,
  p_reason               text DEFAULT NULL,
  p_notes                text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_source_kind text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT source_kind
    INTO v_source_kind
  FROM public.item_availability
  WHERE id = p_item_availability_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'availability_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_source_kind = 'warehouse_dispatch' THEN
    RAISE EXCEPTION 'warehouse_managed_availability_read_only'
      USING ERRCODE = '42501';
  END IF;

  RETURN public.phoenix_apply_manual_availability_movement_internal(
    p_item_availability_id,
    p_movement_type,
    p_amount,
    p_reason,
    p_notes
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_apply_availability_movement(
  uuid, text, integer, text, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_apply_availability_movement(
  uuid, text, integer, text, text
) TO authenticated;

COMMENT ON FUNCTION public.phoenix_apply_availability_movement(
  uuid, text, integer, text, text
) IS
  'Manual/legacy outlet movement boundary. Rejects source_kind=warehouse_dispatch '
  'before delegating to migration 034''s preserved implementation. Warehouse '
  'dispatch quantities are changed only by migration 066 acceptance.';

-- =============================================================================
-- B. Idempotency for warehouse writes
-- =============================================================================

-- One client request produces at most one warehouse movement. The request UUID
-- is not a document number; it is a caller-generated idempotency key. The
-- fingerprint is a consistency checksum, not an authentication primitive: a
-- replay with the same UUID but different normalized inputs fails closed.
ALTER TABLE public.warehouse_stock_movements
  ADD COLUMN IF NOT EXISTS request_fingerprint text;

DO $$ BEGIN
  ALTER TABLE public.warehouse_stock_movements
    ADD CONSTRAINT warehouse_stock_movements_request_fingerprint_chk
    CHECK (
      reference_type IS DISTINCT FROM 'warehouse_request'
      OR (
        request_fingerprint IS NOT NULL
        AND request_fingerprint ~ '^[0-9a-f]{32}$'
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN public.warehouse_stock_movements.request_fingerprint IS
  'MD5 consistency checksum of normalized warehouse mutation inputs. It binds '
  'a warehouse_request UUID to one semantic request and is not an authentication '
  'or secret-protection mechanism. Required when reference_type=warehouse_request.';

CREATE UNIQUE INDEX IF NOT EXISTS warehouse_stock_movements_request_once_uniq
  ON public.warehouse_stock_movements (reference_id)
  WHERE reference_type = 'warehouse_request'
    AND reference_id IS NOT NULL;

-- =============================================================================
-- C. Warehouse receipt RPC
-- =============================================================================

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
  p_notes                  text DEFAULT NULL
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
  v_supply_type    text := NULLIF(btrim(p_supply_type_text), '');
  v_source_doc     text := NULLIF(btrim(p_source_document_number), '');
  v_notes          text := NULLIF(btrim(p_notes), '');
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

  SELECT w.organization_id
    INTO v_org
  FROM public.warehouses w
  WHERE w.id = p_warehouse_id
    AND w.status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse_not_found_or_inactive' USING ERRCODE = 'P0002';
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

  -- A no-batch receipt gets a stable private identity derived from the request,
  -- so a retry finds the same row while independent receipts never merge.
  v_internal_ref := CASE
    WHEN p_has_no_batch_number
      THEN 'WSNB-' || replace(p_request_id::text, '-', '')
    ELSE NULL
  END;

  -- Bind the idempotency key to every normalized semantic input. jsonb text has
  -- deterministic key ordering; MD5 is used only as a compact consistency
  -- checksum, never as authentication or password hashing.
  v_request_fingerprint := md5(jsonb_build_object(
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
    'supply_type_text', v_supply_type,
    'source_document_number', v_source_doc,
    'notes', v_notes
  )::text);

  -- Serialize retries before taking any row lock. All 065 warehouse write RPCs
  -- use this advisory-lock-first order, preventing lock-order inversion.
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
    source_document_number, notes, created_by, updated_by
  ) VALUES (
    v_org, p_warehouse_id, p_central_item_id,
    v_scientific, v_trade, v_concentration, v_dosage, v_unit,
    v_national, p_has_no_national_code,
    v_batch, p_has_no_batch_number, v_internal_ref,
    p_expiry_date, 0, 0,
    p_unit_price, v_price_basis, v_currency, v_supply_type,
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
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse_stock_identity_resolution_failed'
      USING ERRCODE = 'P0002';
  END IF;

  v_before := v_stock.on_hand_quantity;
  v_after  := v_before + p_quantity;

  UPDATE public.warehouse_stock
     SET on_hand_quantity          = v_after,
         central_item_id           = COALESCE(p_central_item_id, central_item_id),
         trade_name                = COALESCE(v_trade, trade_name),
         unit                      = COALESCE(v_unit, unit),
         unit_price                = COALESCE(p_unit_price, unit_price),
         price_basis               = COALESCE(v_price_basis, price_basis),
         currency                  = COALESCE(v_currency, currency),
         supply_type_text          = COALESCE(v_supply_type, supply_type_text),
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

-- =============================================================================
-- D. Existing-stock adjustment RPC
-- =============================================================================

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

  v_request_fingerprint := md5(jsonb_build_object(
    'operation', 'adjust',
    'warehouse_stock_id', p_warehouse_stock_id,
    'movement_type', p_movement_type,
    'amount', p_amount,
    'reason', v_reason,
    'source_document_number', v_source_doc,
    'notes', v_notes
  )::text);

  -- Advisory lock first, row lock second: identical ordering to receipt.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 65065));

  SELECT *
    INTO v_stock
  FROM public.warehouse_stock
  WHERE id = p_warehouse_stock_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse_stock_not_found' USING ERRCODE = 'P0002';
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

-- =============================================================================
-- E. Function privileges
-- =============================================================================

REVOKE ALL ON FUNCTION public.phoenix_receive_warehouse_stock(
  uuid, uuid, text, integer, boolean, boolean,
  uuid, text, text, text, text, text, text, date, numeric,
  text, text, text, text, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_receive_warehouse_stock(
  uuid, uuid, text, integer, boolean, boolean,
  uuid, text, text, text, text, text, text, date, numeric,
  text, text, text, text, text
) TO authenticated;

REVOKE ALL ON FUNCTION public.phoenix_apply_warehouse_stock_movement(
  uuid, uuid, text, integer, text, text, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_apply_warehouse_stock_movement(
  uuid, uuid, text, integer, text, text, text
) TO authenticated;

COMMENT ON FUNCTION public.phoenix_receive_warehouse_stock(
  uuid, uuid, text, integer, boolean, boolean,
  uuid, text, text, text, text, text, text, date, numeric,
  text, text, text, text, text
) IS
  'Idempotent warehouse receipt. The request UUID is the replay key. Uses '
  'warehouse_stock.adjust plus active warehouse assignment, locks the exact '
  'batch identity, changes on-hand quantity, appends one immutable movement, '
  'and writes audit_logs. No direct table write is granted.';

COMMENT ON FUNCTION public.phoenix_apply_warehouse_stock_movement(
  uuid, uuid, text, integer, text, text, text
) IS
  'Idempotent existing-stock adjustment with row lock, scoped permission, '
  'reserved<=on_hand guard, immutable movement, and audit log. set_exact and '
  'correction require warehouse_stock.correct and a non-empty reason.';

-- Preserve the server-only table boundary.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.warehouse_stock
  FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.warehouse_stock_movements
  FROM authenticated;

-- =============================================================================
-- F. VERIFY — inside the transaction; failure rolls back all of 065
-- =============================================================================

DO $$
DECLARE
  v_def       text;
  v_count     integer;
  v_qr_def    text;
BEGIN
  ASSERT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'item_availability'
      AND column_name = 'source_kind'
      AND data_type = 'text'
      AND is_nullable = 'NO'
      AND column_default LIKE '%manual%'
  ), 'VERIFY FAILED (065): item_availability.source_kind missing/default/nullable';

  ASSERT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'item_availability_source_kind_chk'
      AND pg_get_constraintdef(oid) LIKE '%manual%'
      AND pg_get_constraintdef(oid) LIKE '%warehouse_dispatch%'
  ), 'VERIFY FAILED (065): source_kind CHECK missing or incomplete';

  ASSERT EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'item_availability'
      AND t.tgname = 'trg_guard_availability_source_kind'
      AND t.tgenabled = 'O'
      AND NOT t.tgisinternal
  ), 'VERIFY FAILED (065): source-kind guard trigger missing or disabled';

  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'warehouse_stock_movements_request_once_uniq'
      AND indexdef LIKE '%UNIQUE%'
      AND indexdef LIKE '%warehouse_request%'
  ), 'VERIFY FAILED (065): request idempotency index missing';

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'warehouse_stock_movements'
      AND column_name = 'request_fingerprint'
      AND data_type = 'text'
  ), 'VERIFY FAILED (065): request fingerprint column missing';

  ASSERT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'warehouse_stock_movements_request_fingerprint_chk'
      AND pg_get_constraintdef(oid) LIKE '%warehouse_request%'
      AND pg_get_constraintdef(oid) LIKE '%request_fingerprint%'
  ), 'VERIFY FAILED (065): request fingerprint constraint missing';

  -- Exact signatures: a different overload must never satisfy verification.
  FOREACH v_def IN ARRAY ARRAY[
    'public.phoenix_guard_availability_source_kind()',
    'public.phoenix_apply_availability_movement(uuid,text,integer,text,text)',
    'public.phoenix_receive_warehouse_stock(uuid,uuid,text,integer,boolean,boolean,uuid,text,text,text,text,text,text,date,numeric,text,text,text,text,text)',
    'public.phoenix_apply_warehouse_stock_movement(uuid,uuid,text,integer,text,text,text)'
  ] LOOP
    SELECT pg_get_functiondef(v_def::regprocedure)
      INTO v_qr_def;

    ASSERT v_qr_def IS NOT NULL,
      'VERIFY FAILED (065): function missing: ' || v_def;
    ASSERT v_qr_def LIKE '%SECURITY DEFINER%',
      'VERIFY FAILED (065): function is not SECURITY DEFINER: ' || v_def;
    ASSERT v_qr_def LIKE '%SET search_path%',
      'VERIFY FAILED (065): function has no pinned search_path: ' || v_def;
  END LOOP;

  SELECT pg_get_functiondef(
    'public.phoenix_receive_warehouse_stock(uuid,uuid,text,integer,boolean,boolean,uuid,text,text,text,text,text,text,date,numeric,text,text,text,text,text)'::regprocedure
  ) INTO v_def;
  ASSERT v_def LIKE '%FOR UPDATE%'
     AND v_def LIKE '%phoenix_profile_has_scoped_permission%'
     AND v_def LIKE '%warehouse_stock.adjust%'
     AND v_def LIKE '%pg_advisory_xact_lock%'
     AND v_def LIKE '%request_fingerprint%'
     AND v_def LIKE '%INSERT INTO public.warehouse_stock_movements%'
     AND v_def LIKE '%INSERT INTO public.audit_logs%',
    'VERIFY FAILED (065): receipt RPC lost lock/scope/idempotency/ledger/audit';

  SELECT pg_get_functiondef(
    'public.phoenix_apply_warehouse_stock_movement(uuid,uuid,text,integer,text,text,text)'::regprocedure
  ) INTO v_def;
  ASSERT v_def LIKE '%FOR UPDATE%'
     AND v_def LIKE '%warehouse_stock.adjust%'
     AND v_def LIKE '%warehouse_stock.correct%'
     AND v_def LIKE '%warehouse_quantity_below_reserved%'
     AND v_def LIKE '%pg_advisory_xact_lock%'
     AND v_def LIKE '%request_fingerprint%'
     AND v_def LIKE '%INSERT INTO public.warehouse_stock_movements%'
     AND v_def LIKE '%INSERT INTO public.audit_logs%',
    'VERIFY FAILED (065): adjustment RPC lost a required safety boundary';

  -- Raw ACL inspection includes the PUBLIC pseudo-role (OID 0); the
  -- information_schema.role_* views intentionally omit PUBLIC grants.
  SELECT count(*) INTO v_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN LATERAL aclexplode(
    COALESCE(p.proacl, acldefault('f', p.proowner))
  ) acl
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'phoenix_receive_warehouse_stock',
      'phoenix_apply_warehouse_stock_movement'
    )
    AND acl.privilege_type = 'EXECUTE'
    AND (
      acl.grantee = 0
      OR acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'anon')
    );
  ASSERT v_count = 0,
    'VERIFY FAILED (065): anon/PUBLIC can execute a warehouse mutation RPC';

  SELECT count(*) INTO v_count
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND table_name IN ('warehouse_stock', 'warehouse_stock_movements')
    AND grantee = 'authenticated'
    AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE');
  ASSERT v_count = 0,
    'VERIFY FAILED (065): authenticated retained direct warehouse table writes';

  SELECT pg_get_functiondef(p.oid)
    INTO v_qr_def
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'get_public_qr_payload'
  ORDER BY p.oid DESC
  LIMIT 1;

  ASSERT v_qr_def IS NOT NULL,
    'VERIFY FAILED (065): public QR function missing';
  ASSERT v_qr_def NOT ILIKE '%source_kind%'
     AND v_qr_def NOT ILIKE '%internal_batch_reference%',
    'VERIFY FAILED (065): private provenance leaked into public QR';

  RAISE NOTICE 'Migration 065 verification passed: explicit outlet source_kind '
    'boundary added; warehouse-managed availability is server-only and rejected '
    'by the manual movement RPC; warehouse request idempotency is structural; '
    'receipt/adjustment RPCs are scoped, locked, audited and ledger-backed; '
    'direct authenticated table writes remain revoked; anon has no mutation '
    'execute privilege; public QR remains free of private provenance.';
END;
$$;

commit;
