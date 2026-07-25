-- ============================================================================
-- CANONICAL-SUPPLY-PROVENANCE-088   ***PREPARED - DO NOT APPLY TO PRODUCTION***
--
-- MANUAL APPLY ONLY (SQL Editor), and ONLY after owner review. DO NOT use
-- `supabase db push` or any automated runner. Tested by replaying 001->088 on
-- the disposable PostgreSQL rig (tools/pg-rig).
--
-- WHAT THIS IS
-- Two-level canonical provenance for every stock lot:
--     supply_type      : aid | purchase | kimadia      (closed vocabulary)
--     purchase_origin  : central | supplementary       (NON-NULL iff purchase)
-- Provenance becomes part of LOT IDENTITY in every resolution, so the same
-- material/batch/expiry from two sources lives in two separate lots:
--   * physical stock ALWAYS equals the sum of its per-source lots by
--     construction (no parallel subledger to drift);
--   * nothing can auto-draw from the other source (a dispatch line references
--     ONE lot); a mixed-source issue is necessarily two explicit lines;
--   * provenance travels with the material through dispatch (070), outlet
--     returns (071), inter-warehouse transfer (068) and warehouse returns
--     (069) via the existing immutable line snapshots - a transfer NEVER
--     reclassifies the source;
--   * sub-purchases (087) are pinned server-side to purchase/supplementary;
--   * pharmacy-department warehouse intake choosing "purchase" defaults the
--     origin to 'central' server-side.
-- NULL supply_type remains legal (legacy/unspecified lots keep working and
-- display under their free-text label). No data is rewritten.
--
-- PRECONDITIONS: 065..087 applied (production verified 2026-07-22).
-- The legacy writers revoked by 080/085 STAY revoked: the replaced
-- phoenix_receive_warehouse_stock gets its 080 revoke re-applied below
-- (a changed signature is a NEW pg object with default PUBLIC execute).
-- ============================================================================

BEGIN;

DO $precond$
BEGIN
  IF to_regclass('public.procurement_orders') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 087 not applied';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='warehouse_stock'
                    AND column_name='movement_seq') THEN
    RAISE EXCEPTION 'precondition failed: 078 not applied';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='warehouse_stock'
                AND column_name='supply_type') THEN
    RAISE EXCEPTION 'precondition failed: 088 already applied';
  END IF;
END;
$precond$;

-- == A. Canonical provenance columns ==

ALTER TABLE public.warehouse_stock
  ADD COLUMN supply_type     text CHECK (supply_type IN ('aid','purchase','kimadia')),
  ADD COLUMN purchase_origin text CHECK (purchase_origin IN ('central','supplementary')),
  ADD CONSTRAINT warehouse_stock_purchase_origin_chk
    CHECK ((supply_type = 'purchase') = (purchase_origin IS NOT NULL));

ALTER TABLE public.outlet_stock
  ADD COLUMN supply_type     text CHECK (supply_type IN ('aid','purchase','kimadia')),
  ADD COLUMN purchase_origin text CHECK (purchase_origin IN ('central','supplementary')),
  ADD CONSTRAINT outlet_stock_purchase_origin_chk
    CHECK ((supply_type = 'purchase') = (purchase_origin IS NOT NULL));

ALTER TABLE public.warehouse_quarantine_stock
  ADD COLUMN supply_type     text CHECK (supply_type IN ('aid','purchase','kimadia')),
  ADD COLUMN purchase_origin text CHECK (purchase_origin IN ('central','supplementary')),
  ADD CONSTRAINT warehouse_quarantine_stock_purchase_origin_chk
    CHECK ((supply_type = 'purchase') = (purchase_origin IS NOT NULL));

-- Provenance is part of LOT IDENTITY: rebuild the identity uniqueness so the
-- same material/batch/expiry from two sources is TWO rows, never a merge.
DROP INDEX public.warehouse_stock_identity_uniq;
CREATE UNIQUE INDEX warehouse_stock_identity_uniq ON public.warehouse_stock
  (warehouse_id, scientific_name, COALESCE(concentration, ''), COALESCE(dosage_form, ''),
   COALESCE(national_code, ''), COALESCE(batch_number, ''),
   COALESCE(expiry_date, DATE '0001-01-01'), COALESCE(internal_batch_reference, ''),
   COALESCE(supply_type, ''), COALESCE(purchase_origin, ''));

DROP INDEX public.outlet_stock_identity_uniq;
CREATE UNIQUE INDEX outlet_stock_identity_uniq ON public.outlet_stock
  (distribution_point_id, scientific_name, COALESCE(concentration, ''), COALESCE(dosage_form, ''),
   COALESCE(national_code, ''), COALESCE(batch_number, ''),
   COALESCE(expiry_date, DATE '0001-01-01'), COALESCE(internal_batch_reference, ''),
   COALESCE(supply_type, ''), COALESCE(purchase_origin, ''));

DROP INDEX public.wqs_identity_uniq;
CREATE UNIQUE INDEX wqs_identity_uniq ON public.warehouse_quarantine_stock
  (warehouse_id, scientific_name, COALESCE(concentration, ''), COALESCE(dosage_form, ''),
   COALESCE(national_code, ''), COALESCE(batch_number, ''),
   COALESCE(expiry_date, DATE '0001-01-01'), COALESCE(internal_batch_reference, ''),
   quarantine_reason, COALESCE(supply_type, ''), COALESCE(purchase_origin, ''));

-- Immutable line snapshots carry provenance end-to-end.
ALTER TABLE public.warehouse_transfer_lines
  ADD COLUMN supply_type text, ADD COLUMN purchase_origin text;
ALTER TABLE public.warehouse_return_shipment_lines
  ADD COLUMN supply_type text, ADD COLUMN purchase_origin text;
ALTER TABLE public.warehouse_dispatch_lines
  ADD COLUMN supply_type text, ADD COLUMN purchase_origin text;
ALTER TABLE public.outlet_return_shipment_lines
  ADD COLUMN supply_type text, ADD COLUMN purchase_origin text;

-- == B. Provenance-aware writers (surgical re-issues of the LATEST bodies;
--       identity resolutions gain the two provenance conditions; inserts and
--       line snapshots carry the columns; 087 pins purchase/supplementary) ==

-- The two receipt entry points change signature: drop the old objects first.
DROP FUNCTION public.phoenix_receive_warehouse_stock(
  uuid, uuid, text, integer, boolean, boolean, uuid, text, text, text, text,
  text, text, date, numeric, text, text, text, text, text);
DROP FUNCTION public.phoenix_receive_warehouse_stock_guarded(
  uuid, uuid, text, integer, boolean, boolean, bigint, uuid, text, text, text,
  text, text, text, date, numeric, text, text, text, text, text);

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

  -- 088 canonical provenance: closed vocabulary; a purchase ALWAYS has an
  -- origin (defaults to 'central' — pharmacy-department warehouse intake);
  -- a non-purchase NEVER has one. NULL supply_type = legacy/unspecified.
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
  -- deterministic key ordering; SHA-256 is used only as a compact consistency
  -- checksum, never as authentication or password hashing.
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

  -- A receipt may fill an absent catalog link, but must never silently relink an
  -- established stock identity to a different central item. Such a correction
  -- requires a separately reviewed, explicitly audited correction path.
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

CREATE OR REPLACE FUNCTION public.phoenix_receive_warehouse_stock_guarded(
  p_request_id             uuid,
  p_warehouse_id           uuid,
  p_scientific_name        text,
  p_quantity               integer,
  p_has_no_national_code   boolean,
  p_has_no_batch_number    boolean,
  p_expected_generation    bigint  DEFAULT NULL,
  p_central_item_id        uuid    DEFAULT NULL,
  p_trade_name             text    DEFAULT NULL,
  p_concentration          text    DEFAULT NULL,
  p_dosage_form            text    DEFAULT NULL,
  p_unit                   text    DEFAULT NULL,
  p_national_code          text    DEFAULT NULL,
  p_batch_number           text    DEFAULT NULL,
  p_expiry_date            date    DEFAULT NULL,
  p_unit_price             numeric DEFAULT NULL,
  p_price_basis            text    DEFAULT NULL,
  p_currency               text    DEFAULT NULL,
  p_supply_type_text       text    DEFAULT NULL,
  p_source_document_number text    DEFAULT NULL,
  p_notes                  text    DEFAULT NULL,
  p_supply_type            text    DEFAULT NULL,
  p_purchase_origin        text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $guarded_receive$
DECLARE
  v_supply_type_k text := NULLIF(btrim(p_supply_type), '');
  v_origin_k      text := CASE WHEN NULLIF(btrim(p_supply_type), '') = 'purchase'
                               THEN COALESCE(NULLIF(btrim(p_purchase_origin), ''), 'central')
                               ELSE NULLIF(btrim(p_purchase_origin), '') END;
  v_scientific    text := NULLIF(btrim(p_scientific_name), '');
  v_concentration text := NULLIF(btrim(p_concentration), '');
  v_dosage        text := NULLIF(btrim(p_dosage_form), '');
  v_national      text := NULLIF(btrim(p_national_code), '');
  v_batch         text := NULLIF(btrim(p_batch_number), '');
  v_internal_ref  text;
  v_seq           bigint;
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514';
  END IF;

  -- 079: FAIL CLOSED. The parameter keeps its DEFAULT so the signature — and
  -- therefore the function identity — is unchanged, but omitting it is now an
  -- error rather than a silent bypass.
  IF p_expected_generation IS NULL THEN
    RAISE EXCEPTION 'expected_generation_required'
      USING ERRCODE = '23514',
            DETAIL  = 'the guarded receipt requires a canonical generation; '
                   || 'a caller that cannot prove one must not post';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 65065));

  -- REPLAY FIRST, so a lost-response retry stays idempotent. Its expected
  -- generation is necessarily stale by exactly its own committed post.
  IF EXISTS (
    SELECT 1 FROM public.warehouse_stock_movements m
     WHERE m.reference_type = 'warehouse_request'
       AND m.reference_id   = p_request_id
  ) THEN
    RETURN public.phoenix_receive_warehouse_stock(
      p_request_id, p_warehouse_id, p_scientific_name, p_quantity,
      p_has_no_national_code, p_has_no_batch_number, p_central_item_id,
      p_trade_name, p_concentration, p_dosage_form, p_unit, p_national_code,
      p_batch_number, p_expiry_date, p_unit_price, p_price_basis, p_currency,
      p_supply_type_text, p_source_document_number, p_notes,
      p_supply_type, p_purchase_origin
    );
  END IF;

  v_internal_ref := CASE
    WHEN p_has_no_batch_number THEN 'WSNB-' || replace(p_request_id::text, '-', '')
    ELSE NULL
  END;

  SELECT s.movement_seq
    INTO v_seq
    FROM public.warehouse_stock s
   WHERE s.warehouse_id = p_warehouse_id
     AND s.scientific_name = v_scientific
     AND COALESCE(s.concentration, '') = COALESCE(v_concentration, '')
     AND COALESCE(s.dosage_form, '')   = COALESCE(v_dosage, '')
     AND COALESCE(s.national_code, '') = COALESCE(v_national, '')
     AND COALESCE(s.batch_number, '')  = COALESCE(v_batch, '')
     AND COALESCE(s.expiry_date, DATE '0001-01-01')
         = COALESCE(p_expiry_date, DATE '0001-01-01')
     AND COALESCE(s.internal_batch_reference, '') = COALESCE(v_internal_ref, '')
     AND COALESCE(s.supply_type, '') = COALESCE(v_supply_type_k, '')
     AND COALESCE(s.purchase_origin, '') = COALESCE(v_origin_k, '')
     FOR UPDATE;

  -- Absence IS generation 0 — what a first receipt expects, and what the loser
  -- of a new-lot race no longer sees once the winner's row exists at 1.
  v_seq := COALESCE(v_seq, 0);

  IF v_seq IS DISTINCT FROM p_expected_generation THEN
    RAISE EXCEPTION 'warehouse_receipt_generation_conflict'
      USING ERRCODE = '40001',
            DETAIL  = format('expected generation %s, canonical generation %s',
                             p_expected_generation, v_seq);
  END IF;

  RETURN public.phoenix_receive_warehouse_stock(
    p_request_id, p_warehouse_id, p_scientific_name, p_quantity,
    p_has_no_national_code, p_has_no_batch_number, p_central_item_id,
    p_trade_name, p_concentration, p_dosage_form, p_unit, p_national_code,
    p_batch_number, p_expiry_date, p_unit_price, p_price_basis, p_currency,
    p_supply_type_text, p_source_document_number, p_notes,
    p_supply_type, p_purchase_origin
  );
END;
$guarded_receive$;

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

  -- Advisory lock FIRST — same ordering as every other stock RPC, so the three
  -- inventory halves can never invert lock order against each other.
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

  -- The route must exist and be ACTIVE right now. Activity is checked here, not
  -- by FK: it is mutable, and deactivating a route later must not retroactively
  -- invalidate stock already sent. Fetch AND lock in the SAME statement (FOR
  -- SHARE, same reasoning as CREATE/SUBMIT/REVIEW) — closes the TOCTOU window
  -- between reading is_active and holding a lock on it.
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

  -- The stock must actually sit in the route's SOURCE warehouse. Without this a
  -- caller holding a valid route could drain an unrelated warehouse it happens
  -- to be assigned to — an IDOR through a legitimate identifier.
  IF v_stock.warehouse_id IS DISTINCT FROM v_route.source_warehouse_id THEN
    RAISE EXCEPTION 'stock_not_in_route_source_warehouse' USING ERRCODE = '42501';
  END IF;

  SELECT organization_id INTO v_dest_org
  FROM public.warehouses
  WHERE id = v_route.target_warehouse_id AND status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'destination_warehouse_not_found_or_inactive' USING ERRCODE = 'P0002';
  END IF;

  -- THE IDOR GATE. Authority is the actor's scoped assignment to the SOURCE
  -- warehouse — never a role literal, never the caller's claim.
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

  -- An expired batch must never be shipped onward.
  IF v_stock.expiry_date IS NOT NULL AND v_stock.expiry_date < current_date THEN
    RAISE EXCEPTION 'expired_batch_cannot_be_sent' USING ERRCODE = '23514';
  END IF;

  v_before := v_stock.on_hand_quantity;
  v_after  := v_before - p_quantity;

  IF v_after < 0 THEN
    RAISE EXCEPTION 'warehouse_quantity_cannot_go_negative' USING ERRCODE = '23514';
  END IF;
  -- Reserved stock is spoken for; a transfer may not ship it out from under it.
  IF v_after < v_stock.reserved_quantity THEN
    RAISE EXCEPTION 'warehouse_quantity_below_reserved' USING ERRCODE = '23514';
  END IF;

  -- One transfer header per (source org, transfer number). A second line for the
  -- same shipment joins the existing header rather than creating a duplicate.
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
    -- An existing shipment must not be re-pointed at a different route.
    IF v_transfer.route_id IS DISTINCT FROM p_route_id THEN
      RAISE EXCEPTION 'transfer_number_route_conflict' USING ERRCODE = '23505';
    END IF;
    IF v_transfer.status <> 'in_transit' THEN
      RAISE EXCEPTION 'transfer_already_being_received' USING ERRCODE = '23514';
    END IF;
  END IF;

  -- If this send answers a request line, the request must belong to the same
  -- route, the line must have been APPROVED by review (not merely requested),
  -- and it must not be over-fulfilled relative to what was approved — never
  -- relative to what was originally asked for.
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
    reason, reference_type, reference_id, request_fingerprint,
    source_document_number, actor_id, actor_role, actor_name,
    scientific_name_snapshot, concentration_snapshot,
    dosage_form_snapshot, batch_number_snapshot,
    internal_batch_reference_snapshot
  ) VALUES (
    v_stock.id, v_stock.organization_id, v_stock.warehouse_id, 'dispatch_send',
    v_before, -p_quantity, v_after,
    v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
    'warehouse_transfer_send', 'warehouse_transfer_send', p_request_id, v_fingerprint,
    v_doc, v_actor, v_actor_role, v_actor_name,
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

  -- A line leaves 'in_transit' exactly once. Combined with the row lock, this is
  -- what makes a double receipt impossible even under concurrent callers.
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

  -- THE IDOR GATE, and the separation of duty: authority is scoped to the
  -- DESTINATION warehouse, taken from the transfer, never from the caller. The
  -- sender cannot receive its own shipment.
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

  -- A rejected line moves no stock: it stops being in transit and nothing is
  -- added anywhere. The shortfall is a discrepancy the return path (069) owns.
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

  -- Resolve the DESTINATION stock identity from the line's immutable snapshots.
  -- A no-batch lot keeps its internal reference, so independently received
  -- shipments never merge — 060's rule, carried across the transfer intact.
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

  INSERT INTO public.warehouse_stock_movements (
    warehouse_stock_id, organization_id, warehouse_id, movement_type,
    on_hand_before, on_hand_delta, on_hand_after,
    reserved_before, reserved_delta, reserved_after,
    reason, reference_type, reference_id, request_fingerprint,
    source_document_number, actor_id, actor_role, actor_name,
    scientific_name_snapshot, concentration_snapshot,
    dosage_form_snapshot, batch_number_snapshot,
    internal_batch_reference_snapshot
  ) VALUES (
    v_stock.id, v_stock.organization_id, v_stock.warehouse_id, 'add',
    v_before, p_received_quantity, v_after,
    v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
    'warehouse_transfer_receive', 'warehouse_transfer_receive', p_request_id, v_fingerprint,
    v_transfer.document_number, v_actor, v_actor_role, v_actor_name,
    v_stock.scientific_name, v_stock.concentration,
    v_stock.dosage_form, v_stock.batch_number,
    v_stock.internal_batch_reference
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

CREATE OR REPLACE FUNCTION public.phoenix_send_warehouse_return_shipment_line(
  p_request_id              uuid,
  p_route_id                uuid,
  p_return_request_line_id  uuid,
  p_quantity                integer,
  p_shipment_number         text,
  p_document_number         text DEFAULT NULL,
  p_notes                   text DEFAULT NULL
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
  v_reqline      public.warehouse_return_request_lines%ROWTYPE;
  v_request      public.warehouse_return_requests%ROWTYPE;
  v_orig         public.warehouse_transfer_lines%ROWTYPE;
  v_stock        public.warehouse_stock%ROWTYPE;
  v_shipment     public.warehouse_return_shipments%ROWTYPE;
  v_existing     public.warehouse_stock_movements%ROWTYPE;
  v_number       text := NULLIF(btrim(p_shipment_number), '');
  v_doc          text := NULLIF(btrim(p_document_number), '');
  v_notes        text := NULLIF(btrim(p_notes), '');
  v_before       integer;
  v_after        integer;
  v_line_id      uuid;
  v_movement_id  uuid;
  v_fingerprint  text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_route_id IS NULL OR p_return_request_line_id IS NULL THEN
    RAISE EXCEPTION 'route_and_line_required' USING ERRCODE = '23514';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;
  IF v_number IS NULL THEN
    RAISE EXCEPTION 'shipment_number_required' USING ERRCODE = '23514';
  END IF;

  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'return_send',
    'route_id', p_route_id,
    'return_request_line_id', p_return_request_line_id,
    'quantity', p_quantity,
    'shipment_number', v_number,
    'document_number', v_doc,
    'notes', v_notes
  )::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 69069));

  SELECT * INTO v_existing
  FROM public.warehouse_stock_movements m
  WHERE m.reference_type = 'warehouse_return_send' AND m.reference_id = p_request_id;

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

  -- Locked (FOR SHARE), not gated on is_active — sending back material that
  -- was already legitimately delivered must not depend on the route's
  -- CURRENT activity. Deactivating a route stops NEW forward supply; it does
  -- not retroactively forbid returning what already moved along it.
  SELECT * INTO v_route
  FROM public.warehouse_supply_routes WHERE id = p_route_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'supply_route_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT l.* INTO v_reqline
  FROM public.warehouse_return_request_lines l
  JOIN public.warehouse_return_requests r ON r.id = l.return_request_id
  WHERE l.id = p_return_request_line_id AND r.route_id = p_route_id
  FOR UPDATE OF l;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_request_line_not_found_for_route' USING ERRCODE = 'P0002';
  END IF;
  IF v_reqline.status NOT IN ('approved', 'partially_fulfilled') THEN
    RAISE EXCEPTION 'return_request_line_not_approved' USING ERRCODE = '23514';
  END IF;
  IF v_reqline.fulfilled_quantity + p_quantity > v_reqline.approved_quantity THEN
    RAISE EXCEPTION 'return_line_would_be_over_fulfilled' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_request
  FROM public.warehouse_return_requests WHERE id = v_reqline.return_request_id FOR UPDATE;

  SELECT * INTO v_orig
  FROM public.warehouse_transfer_lines WHERE id = v_reqline.original_transfer_line_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'original_transfer_line_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_orig.returned_quantity + p_quantity > COALESCE(v_orig.received_quantity, 0) THEN
    RAISE EXCEPTION 'original_line_would_be_over_returned' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_stock
  FROM public.warehouse_stock WHERE id = v_orig.resulting_warehouse_stock_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse_stock_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- The stock must actually sit in the route's TARGET warehouse (the
  -- institution) — the same IDOR-prevention pattern as 068's forward SEND,
  -- reversed.
  IF v_stock.warehouse_id IS DISTINCT FROM v_route.target_warehouse_id THEN
    RAISE EXCEPTION 'stock_not_in_route_target_warehouse' USING ERRCODE = '42501';
  END IF;
  IF v_stock.organization_id IS DISTINCT FROM v_reqline.source_organization_id THEN
    RAISE EXCEPTION 'stock_organization_mismatch' USING ERRCODE = '42501';
  END IF;

  -- THE IDOR GATE. Authority is the actor's scoped assignment to the SOURCE
  -- (institution) warehouse — never a role literal, never the caller's claim.
  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'warehouse_transfer.return_send', v_stock.organization_id, v_stock.warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_warehouse_return_send' USING ERRCODE = '42501';
  END IF;

  SELECT p.role, p.full_name INTO v_actor_role, v_actor_name
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  -- Deliberately NO expiry-refusal here — see the file header. A return is
  -- frequently OF an expired batch, going back to the party equipped to
  -- dispose of or credit it.

  v_before := v_stock.on_hand_quantity;
  v_after  := v_before - p_quantity;

  IF v_after < 0 THEN
    RAISE EXCEPTION 'warehouse_quantity_cannot_go_negative' USING ERRCODE = '23514';
  END IF;
  IF v_after < v_stock.reserved_quantity THEN
    RAISE EXCEPTION 'warehouse_quantity_below_reserved' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_shipment
  FROM public.warehouse_return_shipments
  WHERE source_organization_id = v_stock.organization_id
    AND btrim(shipment_number) = v_number
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.warehouse_return_shipments (
      route_id, return_request_id,
      source_warehouse_id, source_organization_id,
      destination_warehouse_id, destination_organization_id,
      shipment_number, status, document_number, notes, sent_by, sent_at
    ) VALUES (
      p_route_id, v_reqline.return_request_id,
      v_route.target_warehouse_id, v_stock.organization_id,
      v_route.source_warehouse_id, v_request.destination_organization_id,
      v_number, 'in_transit', v_doc, v_notes, v_actor, now()
    )
    RETURNING * INTO v_shipment;
  ELSE
    IF v_shipment.route_id IS DISTINCT FROM p_route_id THEN
      RAISE EXCEPTION 'shipment_number_route_conflict' USING ERRCODE = '23505';
    END IF;
    IF v_shipment.status <> 'in_transit' THEN
      RAISE EXCEPTION 'shipment_already_being_received' USING ERRCODE = '23514';
    END IF;
  END IF;

  UPDATE public.warehouse_return_request_lines
     SET fulfilled_quantity = fulfilled_quantity + p_quantity,
         status = CASE WHEN fulfilled_quantity + p_quantity >= approved_quantity
                       THEN 'fulfilled' ELSE 'partially_fulfilled' END
   WHERE id = v_reqline.id;

  UPDATE public.warehouse_return_requests
     SET status = CASE WHEN NOT EXISTS (
                         SELECT 1 FROM public.warehouse_return_request_lines x
                         WHERE x.return_request_id = v_reqline.return_request_id
                           AND x.status NOT IN ('fulfilled', 'rejected', 'cancelled'))
                       THEN 'fulfilled' ELSE 'partially_fulfilled' END
   WHERE id = v_reqline.return_request_id;

  UPDATE public.warehouse_transfer_lines
     SET returned_quantity = returned_quantity + p_quantity
   WHERE id = v_orig.id;

  UPDATE public.warehouse_stock
     SET on_hand_quantity = v_after,
         updated_by       = v_actor
   WHERE id = v_stock.id;

  INSERT INTO public.warehouse_return_shipment_lines (
    shipment_id, source_organization_id, source_warehouse_stock_id,
    return_request_line_id, original_transfer_line_id, central_item_id,
    scientific_name, trade_name, concentration, dosage_form, unit,
    national_code, has_no_national_code,
    batch_number, has_no_batch_number, internal_batch_reference,
    expiry_date, unit_price, price_basis, currency, supply_type_text,
    supply_type, purchase_origin,
    sent_quantity, status
  ) VALUES (
    v_shipment.id, v_stock.organization_id, v_stock.id,
    v_reqline.id, v_orig.id, v_stock.central_item_id,
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
    reason, reference_type, reference_id, request_fingerprint,
    source_document_number, actor_id, actor_role, actor_name,
    scientific_name_snapshot, concentration_snapshot,
    dosage_form_snapshot, batch_number_snapshot,
    internal_batch_reference_snapshot
  ) VALUES (
    v_stock.id, v_stock.organization_id, v_stock.warehouse_id, 'dispatch_return',
    v_before, -p_quantity, v_after,
    v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
    'warehouse_transfer_return', 'warehouse_return_send', p_request_id, v_fingerprint,
    v_doc, v_actor, v_actor_role, v_actor_name,
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
    'warehouse_transfer.return_send', 'warehouse_return_shipment_lines', v_line_id,
    v_stock.scientific_name,
    jsonb_build_object(
      'request_id', p_request_id,
      'route_id', p_route_id,
      'shipment_id', v_shipment.id,
      'source_warehouse_id', v_route.target_warehouse_id,
      'destination_warehouse_id', v_route.source_warehouse_id,
      'movement_id', v_movement_id,
      'quantity_before', v_before,
      'quantity_delta', -p_quantity,
      'quantity_after', v_after
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'shipment_id', v_shipment.id,
    'shipment_line_id', v_line_id,
    'warehouse_stock_id', v_stock.id,
    'movement_id', v_movement_id,
    'in_transit_quantity', p_quantity,
    'quantity_before', v_before,
    'quantity_delta', -p_quantity,
    'quantity_after', v_after
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.phoenix_receive_warehouse_return_shipment_line(
  p_request_id             uuid,
  p_shipment_line_id       uuid,
  p_received_quantity      integer,
  p_difference_reason      text DEFAULT NULL,
  p_notes                  text DEFAULT NULL,
  -- Consulted ONLY when the line's return reason is 'near_expiry',
  -- 'excess' or 'shipment_error' and the batch is not (yet) objectively
  -- expired — every mandatory-quarantine reason is decided deterministically
  -- by the server and this parameter is ignored for them, so a client can
  -- never use it to talk a mandatory-quarantine reason into 'restockable'.
  -- Required (not optional) for the three reasons above: NULL there raises
  -- before any balance is touched — fail-closed, never a silent default.
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

  -- Idempotency replay can land in EITHER ledger depending on what the
  -- ORIGINAL call resolved to (restockable -> warehouse_stock_movements,
  -- quarantined -> warehouse_quarantine_stock_movements) — check both.
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

  -- THE IDOR GATE: authority is scoped to the DESTINATION (central)
  -- warehouse, taken from the shipment, never from the caller. No route/
  -- is_active check here — receiving stock already on a truck must not
  -- depend on the route's CURRENT state, same rule as 068's forward RECEIVE.
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

  -- Lock the ORIGINAL received line now — RECEIVE increments its
  -- return_received_quantity (a separate counter from returned_quantity,
  -- which SEND already owns) under the same row lock discipline as SEND.
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

  -- Looked up here, before EITHER outcome (rejection or classification), so
  -- the audit trail for a rejection also records what the return was FOR —
  -- an auditor should never have to guess why a batch was rejected.
  v_reason_code := (
    SELECT rl.reason_code FROM public.warehouse_return_request_lines rl
    WHERE rl.id = v_line.return_request_line_id
  );

  IF p_received_quantity = 0 THEN
    -- REJECTED: central refuses the shipment outright. No balance touched —
    -- not on_hand, not quarantine. The goods exist somewhere physically but
    -- are custody-tracked as exception_pending, never silently returned to
    -- the institution and never silently absorbed into either balance.
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

  -- DISPOSITION CLASSIFICATION — FAIL-CLOSED. A return is deliberately
  -- allowed to be OF an expired or unsound batch (see phoenix_send's own
  -- comment) — but crediting it into the SAME on_hand pool ordinary
  -- dispensable stock draws from would make it dispensable again, which must
  -- never happen silently, and must never happen by DEFAULT either. This is
  -- a structural classification, not an RPC-level suggestion:
  --   - objectively expired at receipt time (regardless of stated reason), OR
  --     reason_code IS NULL (the return-request line was deleted; an unknown
  --     reason is never presumed sound), OR reason_code IN ('expired',
  --     'damaged', 'recalled', 'quality_issue', 'temperature_excursion',
  --     'other') -> ALWAYS 'quarantined'. The client cannot override this via
  --     p_disposition_decision — it is not even consulted.
  --   - reason_code IN ('near_expiry', 'excess', 'shipment_error') (and not
  --     objectively expired) -> the AUTHORIZED receiver must explicitly
  --     decide via p_disposition_decision; there is NO default in either
  --     direction. Absent or invalid, the function raises here, BEFORE
  --     either credit branch below — no partial mutation, no stock touched.
  --   - every reason_code value the CHECK constraint allows is named in one
  --     of the two IN-lists above; the final ELSE is unreachable by
  --     construction and exists only as a fail-closed backstop, never a
  --     silent default.
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
    -- Unreachable: every allowed reason_code value is named above. A
    -- fail-closed backstop, not a fallback default — never credits either
    -- balance.
    RAISE EXCEPTION 'return_receive_unclassified_reason_code' USING ERRCODE = '23514';
  END IF;

  v_custody := CASE v_disposition WHEN 'restockable' THEN 'destination_stock' ELSE 'destination_quarantine' END;
  v_internal := v_line.internal_batch_reference;

  IF v_disposition = 'restockable' THEN
    -- ---- RESTOCKABLE: credit the ordinary, dispensable warehouse_stock ----
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
      reason, reference_type, reference_id, request_fingerprint,
      source_document_number, actor_id, actor_role, actor_name,
      scientific_name_snapshot, concentration_snapshot,
      dosage_form_snapshot, batch_number_snapshot,
      internal_batch_reference_snapshot
    ) VALUES (
      v_stock.id, v_stock.organization_id, v_stock.warehouse_id, 'add',
      v_before, p_received_quantity, v_after,
      v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
      'warehouse_transfer_return', 'warehouse_return_receive', p_request_id, v_fingerprint,
      v_shipment.document_number, v_actor, v_actor_role, v_actor_name,
      v_stock.scientific_name, v_stock.concentration,
      v_stock.dosage_form, v_stock.batch_number,
      v_stock.internal_batch_reference
    )
    RETURNING id INTO v_movement_id;
  ELSE
    -- ---- QUARANTINED: credit the non-dispensable warehouse_quarantine_stock ----
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
      CASE WHEN v_objectively_expired AND v_reason_code IS DISTINCT FROM 'expired'
           THEN 'expired' ELSE COALESCE(v_reason_code, 'other') END,
      0, v_actor, v_actor
    )
    ON CONFLICT DO NOTHING;

    SELECT * INTO v_quarantine
    FROM public.warehouse_quarantine_stock q
    WHERE q.warehouse_id = v_shipment.destination_warehouse_id
      AND q.scientific_name = v_line.scientific_name
      AND COALESCE(q.concentration, '') = COALESCE(v_line.concentration, '')
      AND COALESCE(q.dosage_form, '')   = COALESCE(v_line.dosage_form, '')
      AND COALESCE(q.national_code, '') = COALESCE(v_line.national_code, '')
      AND COALESCE(q.batch_number, '')  = COALESCE(v_line.batch_number, '')
      AND COALESCE(q.expiry_date, DATE '0001-01-01')
          = COALESCE(v_line.expiry_date, DATE '0001-01-01')
      AND COALESCE(q.internal_batch_reference, '') = COALESCE(v_internal, '')
      AND q.quarantine_reason = (
            CASE WHEN v_objectively_expired AND v_reason_code IS DISTINCT FROM 'expired'
                 THEN 'expired' ELSE COALESCE(v_reason_code, 'other') END)
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
      reason, reference_type, reference_id, request_fingerprint,
      source_document_number, actor_id, actor_role, actor_name,
      scientific_name_snapshot, concentration_snapshot,
      dosage_form_snapshot, batch_number_snapshot,
      internal_batch_reference_snapshot
    ) VALUES (
      v_quarantine.id, v_quarantine.organization_id, v_quarantine.warehouse_id, 'quarantine_receive',
      v_before, p_received_quantity, v_after,
      'warehouse_transfer_return', 'warehouse_return_quarantine_receive', p_request_id, v_fingerprint,
      v_shipment.document_number, v_actor, v_actor_role, v_actor_name,
      v_quarantine.scientific_name, v_quarantine.concentration,
      v_quarantine.dosage_form, v_quarantine.batch_number,
      v_quarantine.internal_batch_reference,
      v_line.supply_type, v_line.purchase_origin
    )
    RETURNING id INTO v_movement_id;
  END IF;

  -- Shared tail: both dispositions reach here having credited exactly one
  -- balance and set exactly one resulting_* pointer.
  UPDATE public.warehouse_return_shipments
     SET status = CASE WHEN NOT EXISTS (
                         SELECT 1 FROM public.warehouse_return_shipment_lines x
                         WHERE x.shipment_id = v_shipment.id AND x.status = 'in_transit')
                       THEN 'received' ELSE 'partially_received' END
   WHERE id = v_shipment.id;

  -- return_received_quantity is a SEPARATE counter from returned_quantity
  -- (which SEND owns) — counts what actually reached custody at central,
  -- whichever balance it landed in. Never exceeds returned_quantity
  -- (wtl_return_received_qty_chk), itself never exceeding received_quantity
  -- (wtl_returned_qty_chk) — the chain is transitively capped at the source.
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

CREATE OR REPLACE FUNCTION public.phoenix_add_dispatch_line(
  p_dispatch_id       uuid,
  p_warehouse_stock_id uuid,
  p_quantity           integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_dispatch   public.warehouse_dispatches%ROWTYPE;
  v_stock      public.warehouse_stock%ROWTYPE;
  v_line       public.warehouse_dispatch_lines%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_dispatch_id IS NULL OR p_warehouse_stock_id IS NULL THEN
    RAISE EXCEPTION 'dispatch_id_and_stock_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_dispatch
  FROM public.warehouse_dispatches WHERE id = p_dispatch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dispatch_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_dispatch.status <> 'draft' THEN
    RAISE EXCEPTION 'dispatch_not_editable' USING ERRCODE = '23514';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'warehouse_dispatch.edit_draft', v_dispatch.organization_id, v_dispatch.warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_warehouse_dispatch_edit' USING ERRCODE = '42501';
  END IF;

  SELECT p.role INTO v_actor_role FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  -- Lock the EXACT lot the caller named. No search, no "closest match", no
  -- automatic substitution.
  SELECT * INTO v_stock
  FROM public.warehouse_stock WHERE id = p_warehouse_stock_id FOR UPDATE;
  IF NOT FOUND OR v_stock.organization_id <> v_dispatch.organization_id
     OR v_stock.warehouse_id <> v_dispatch.warehouse_id THEN
    RAISE EXCEPTION 'warehouse_stock_not_at_this_warehouse' USING ERRCODE = '23514';
  END IF;

  -- Explicit, not-expired lot. A batch already expired must never be added to
  -- a NEW draft dispatch — this is the earliest point the system can refuse
  -- it. (SEND re-checks live, since a lot can expire between draft and send.)
  IF v_stock.expiry_date IS NOT NULL AND v_stock.expiry_date < current_date THEN
    RAISE EXCEPTION 'expired_batch_cannot_be_dispatched' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.warehouse_dispatch_lines (
    organization_id, dispatch_id, warehouse_stock_id, central_item_id,
    scientific_name, trade_name, concentration, dosage_form, unit,
    national_code, has_no_national_code, batch_number, has_no_batch_number,
    internal_batch_reference, expiry_date, unit_price, price_basis, currency, supply_type_text,
    supply_type, purchase_origin,
    sent_quantity, status
  ) VALUES (
    v_dispatch.organization_id, v_dispatch.id, v_stock.id, v_stock.central_item_id,
    v_stock.scientific_name, v_stock.trade_name, v_stock.concentration, v_stock.dosage_form, v_stock.unit,
    v_stock.national_code, v_stock.has_no_national_code, v_stock.batch_number, v_stock.has_no_batch_number,
    v_stock.internal_batch_reference, v_stock.expiry_date, v_stock.unit_price, v_stock.price_basis,
    v_stock.currency, v_stock.supply_type_text,
    v_stock.supply_type, v_stock.purchase_origin,
    p_quantity, 'pending'
  )
  RETURNING * INTO v_line;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_dispatch.organization_id, v_actor, v_actor_role,
    'warehouse_dispatch.line_added', 'warehouse_dispatch_lines', v_line.id, v_stock.scientific_name,
    jsonb_build_object('dispatch_id', p_dispatch_id, 'warehouse_stock_id', p_warehouse_stock_id, 'quantity', p_quantity)
  );

  RETURN jsonb_build_object('ok', true, 'dispatch_line_id', v_line.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.phoenix_receive_outlet_dispatch_line(
  p_request_id        uuid,
  p_dispatch_line_id  uuid,
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
  v_dispatch_id uuid;
  v_line        public.warehouse_dispatch_lines%ROWTYPE;
  v_dispatch    public.warehouse_dispatches%ROWTYPE;
  v_point       public.distribution_points%ROWTYPE;
  v_stock       public.outlet_stock%ROWTYPE;
  v_existing    public.outlet_stock_movements%ROWTYPE;
  v_reason      text := NULLIF(btrim(p_difference_reason), '');
  v_notes       text := NULLIF(btrim(p_notes), '');
  v_before      integer;
  v_after       integer;
  v_movement_id uuid;
  v_avail_id    uuid;
  v_line_status text;
  v_fingerprint text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_dispatch_line_id IS NULL THEN
    RAISE EXCEPTION 'dispatch_line_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_received_quantity IS NULL OR p_received_quantity < 0 THEN
    RAISE EXCEPTION 'received_quantity_must_be_non_negative' USING ERRCODE = '23514';
  END IF;

  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'receive_dispatch_line',
    'dispatch_line_id', p_dispatch_line_id,
    'received_quantity', p_received_quantity,
    'difference_reason', v_reason,
    'notes', v_notes
  )::text, 'UTF8')), 'hex');

  -- Step 1: safe, unlocked extraction of the immutable parent dispatch_id.
  SELECT dispatch_id INTO v_dispatch_id
  FROM public.warehouse_dispatch_lines WHERE id = p_dispatch_line_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dispatch_line_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Step 2: per-DISPATCH advisory lock — serializes every RECEIVE against
  -- this dispatch, regardless of line or request id.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_dispatch_id::text, 70170));

  -- Advisory lock first, row locks second: identical ordering to 065/067's
  -- own original design — kept for the per-request idempotency check below.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 67067));

  -- Replay check BEFORE any authorization side effect, so a retry is cheap and
  -- cannot be turned into a probe that behaves differently from the first call.
  SELECT * INTO v_existing
  FROM public.outlet_stock_movements m
  WHERE m.reference_type = 'outlet_request' AND m.reference_id = p_request_id;

  IF FOUND THEN
    IF v_existing.dispatch_line_id IS DISTINCT FROM p_dispatch_line_id
       OR v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true,
      'outlet_stock_id', v_existing.outlet_stock_id,
      'movement_id', v_existing.id,
      'quantity_before', v_existing.on_hand_before,
      'quantity_delta', v_existing.on_hand_delta,
      'quantity_after', v_existing.on_hand_after
    );
  END IF;

  -- Step 3: HEADER first, then LINE — reordered from 067's original
  -- line-then-header sequence, matching 070's own SEND.
  SELECT * INTO v_dispatch
  FROM public.warehouse_dispatches
  WHERE id = v_dispatch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'dispatch_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_line
  FROM public.warehouse_dispatch_lines
  WHERE id = p_dispatch_line_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'dispatch_line_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Only a physically sent dispatch can be received.
  IF v_dispatch.status NOT IN ('sent', 'partially_accepted') THEN
    RAISE EXCEPTION 'dispatch_not_receivable' USING ERRCODE = '23514';
  END IF;
  IF v_line.status <> 'pending' THEN
    RAISE EXCEPTION 'dispatch_line_already_decided' USING ERRCODE = '23505';
  END IF;
  IF p_received_quantity > v_line.sent_quantity THEN
    RAISE EXCEPTION 'received_quantity_exceeds_sent' USING ERRCODE = '23514';
  END IF;
  -- A quantity that disagrees with the shipment must be explained, or the
  -- discrepancy becomes invisible the moment it matters.
  IF p_received_quantity <> v_line.sent_quantity AND v_reason IS NULL THEN
    RAISE EXCEPTION 'difference_reason_required' USING ERRCODE = '23514';
  END IF;

  -- THE IDOR GATE. Authority is the actor's scoped assignment to the
  -- DESTINATION OUTLET — never a role literal, never the client's word, never
  -- the dispatch's own claim about where it is going.
  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'outlet_stock.receive', v_dispatch.organization_id,
    NULL, v_dispatch.destination_distribution_point_id
  ) THEN
    RAISE EXCEPTION 'forbidden_outlet_stock_receive' USING ERRCODE = '42501';
  END IF;

  SELECT p.role, p.full_name INTO v_actor_role, v_actor_name
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  -- Resolve the destination outlet and prove it may hold stock AT ALL (its
  -- point_type is structurally required by outlet_stock's own CHECK). Its
  -- STATUS is deliberately NOT gated here (see file header, section 2c): a
  -- shipment already in_transit must always be settleable, even if the
  -- outlet has since been deactivated.
  SELECT * INTO v_point
  FROM public.distribution_points
  WHERE id = v_dispatch.destination_distribution_point_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'destination_outlet_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_point.point_type NOT IN ('pharmacy', 'crash_cabinet', 'rescue_cart') THEN
    RAISE EXCEPTION 'outlet_type_not_approved_for_stock: %', v_point.point_type
      USING ERRCODE = '23514';
  END IF;

  -- An expired batch must never enter an outlet. This is the last point at
  -- which the system can refuse it; after this it is dispensable stock.
  IF v_line.expiry_date IS NOT NULL AND v_line.expiry_date < current_date THEN
    RAISE EXCEPTION 'expired_batch_cannot_be_received' USING ERRCODE = '23514';
  END IF;

  v_line_status := CASE
    WHEN p_received_quantity = 0 THEN 'rejected'
    WHEN p_received_quantity = v_line.sent_quantity THEN 'accepted'
    ELSE 'accepted_with_difference'
  END;

  -- A fully rejected line moves no stock: record the decision and stop. There is
  -- no outlet_stock row to create, so there is no movement and no projection.
  IF p_received_quantity = 0 THEN
    UPDATE public.warehouse_dispatch_lines
       SET status = 'rejected', received_quantity = 0,
           rejection_reason = v_reason, rejected_by = v_actor, rejected_at = now()
     WHERE id = v_line.id;

    -- Step 4: recompute the header, still holding its FOR UPDATE lock.
    PERFORM public.phoenix_recompute_warehouse_dispatch_header_status(v_dispatch.id);

    INSERT INTO public.audit_logs (
      organization_id, actor_id, actor_role,
      action, entity_type, entity_id, entity_label, payload
    ) VALUES (
      v_dispatch.organization_id, v_actor, v_actor_role,
      'outlet_stock.dispatch_rejected', 'warehouse_dispatch_lines', v_line.id,
      v_line.scientific_name,
      jsonb_build_object(
        'request_id', p_request_id,
        'dispatch_id', v_dispatch.id,
        'distribution_point_id', v_dispatch.destination_distribution_point_id,
        'sent_quantity', v_line.sent_quantity,
        'received_quantity', 0,
        'reason', v_reason
      )
    );

    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', false,
      'line_status', 'rejected', 'outlet_stock_id', NULL, 'movement_id', NULL,
      'quantity_before', 0, 'quantity_delta', 0, 'quantity_after', 0
    );
  END IF;

  -- Resolve (or create) the outlet_stock identity from the line's IMMUTABLE
  -- snapshots — never from a client-supplied identity.
  INSERT INTO public.outlet_stock (
    organization_id, distribution_point_id, point_type, central_item_id,
    scientific_name, trade_name, concentration, dosage_form, unit,
    national_code, has_no_national_code,
    batch_number, has_no_batch_number, internal_batch_reference,
    expiry_date, on_hand_quantity, reserved_quantity,
    unit_price, price_basis, currency, supply_type_text,
    supply_type, purchase_origin,
    source_document_number, notes, created_by, updated_by
  ) VALUES (
    v_dispatch.organization_id, v_dispatch.destination_distribution_point_id,
    v_point.point_type, v_line.central_item_id,
    v_line.scientific_name, v_line.trade_name, v_line.concentration,
    v_line.dosage_form, v_line.unit,
    v_line.national_code, v_line.has_no_national_code,
    v_line.batch_number, v_line.has_no_batch_number, v_line.internal_batch_reference,
    v_line.expiry_date, 0, 0,
    v_line.unit_price, v_line.price_basis, v_line.currency, v_line.supply_type_text,
    v_line.supply_type, v_line.purchase_origin,
    v_dispatch.document_number, v_notes, v_actor, v_actor
  )
  ON CONFLICT DO NOTHING;

  SELECT * INTO v_stock
  FROM public.outlet_stock s
  WHERE s.distribution_point_id = v_dispatch.destination_distribution_point_id
    AND s.scientific_name = v_line.scientific_name
    AND COALESCE(s.concentration, '') = COALESCE(v_line.concentration, '')
    AND COALESCE(s.dosage_form, '')   = COALESCE(v_line.dosage_form, '')
    AND COALESCE(s.national_code, '') = COALESCE(v_line.national_code, '')
    AND COALESCE(s.batch_number, '')  = COALESCE(v_line.batch_number, '')
    AND COALESCE(s.expiry_date, DATE '0001-01-01')
        = COALESCE(v_line.expiry_date, DATE '0001-01-01')
    AND COALESCE(s.internal_batch_reference, '')
        = COALESCE(v_line.internal_batch_reference, '')
    AND COALESCE(s.supply_type, '') = COALESCE(v_line.supply_type, '')
    AND COALESCE(s.purchase_origin, '') = COALESCE(v_line.purchase_origin, '')
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'outlet_stock_identity_resolution_failed' USING ERRCODE = 'P0002';
  END IF;

  v_before := v_stock.on_hand_quantity;
  v_after  := v_before + p_received_quantity;

  UPDATE public.outlet_stock
     SET on_hand_quantity       = v_after,
         central_item_id        = COALESCE(v_stock.central_item_id, v_line.central_item_id),
         unit_price             = COALESCE(v_line.unit_price, unit_price),
         source_document_number = COALESCE(v_dispatch.document_number, source_document_number),
         notes                  = COALESCE(v_notes, notes),
         updated_by             = v_actor
   WHERE id = v_stock.id;

  INSERT INTO public.outlet_stock_movements (
    outlet_stock_id, organization_id, distribution_point_id,
    movement_type,
    on_hand_before, on_hand_delta, on_hand_after,
    reserved_before, reserved_delta, reserved_after,
    reason, reference_type, reference_id, dispatch_line_id, request_fingerprint,
    source_document_number, actor_id, actor_role, actor_name,
    scientific_name_snapshot, concentration_snapshot, dosage_form_snapshot,
    batch_number_snapshot, internal_batch_reference_snapshot, expiry_date_snapshot
  ) VALUES (
    v_stock.id, v_dispatch.organization_id, v_dispatch.destination_distribution_point_id,
    'dispatch_receive',
    v_before, p_received_quantity, v_after,
    v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
    v_reason, 'outlet_request', p_request_id, v_line.id, v_fingerprint,
    v_dispatch.document_number, v_actor, v_actor_role, v_actor_name,
    v_stock.scientific_name, v_stock.concentration, v_stock.dosage_form,
    v_stock.batch_number, v_stock.internal_batch_reference, v_stock.expiry_date
  )
  RETURNING id INTO v_movement_id;

  -- Transitional projection, in THIS transaction. The client never dual-writes.
  v_avail_id := public.phoenix_project_outlet_availability(v_stock.id);

  UPDATE public.warehouse_dispatch_lines
     SET status                         = v_line_status,
         received_quantity              = p_received_quantity,
         difference_reason              = v_reason,
         accepted_by                    = v_actor,
         accepted_at                    = now(),
         resulting_outlet_stock_id      = v_stock.id,
         -- Kept populated on purpose: 061's link must not break during expand.
         resulting_item_availability_id = v_avail_id
   WHERE id = v_line.id;

  -- Step 4: recompute the header, still holding its FOR UPDATE lock acquired
  -- in step 3 — guaranteed to see this line's own just-made update, and (by
  -- construction of the per-dispatch advisory lock) every sibling line's
  -- fully-committed prior state too.
  PERFORM public.phoenix_recompute_warehouse_dispatch_header_status(v_dispatch.id);

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role,
    action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_dispatch.organization_id, v_actor, v_actor_role,
    'outlet_stock.dispatch_receive', 'outlet_stock', v_stock.id,
    v_stock.scientific_name,
    jsonb_build_object(
      'request_id', p_request_id,
      'dispatch_id', v_dispatch.id,
      'dispatch_line_id', v_line.id,
      'distribution_point_id', v_dispatch.destination_distribution_point_id,
      'movement_id', v_movement_id,
      'line_status', v_line_status,
      'sent_quantity', v_line.sent_quantity,
      'quantity_before', v_before,
      'quantity_delta', p_received_quantity,
      'quantity_after', v_after,
      'reason', v_reason
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'line_status', v_line_status,
    'outlet_stock_id', v_stock.id,
    'movement_id', v_movement_id,
    'item_availability_id', v_avail_id,
    'quantity_before', v_before,
    'quantity_delta', p_received_quantity,
    'quantity_after', v_after
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.phoenix_send_outlet_return_shipment_line(
  p_request_id          uuid,
  p_return_request_line_id uuid,
  p_shipment_id           uuid,
  p_quantity              integer,
  p_shipment_number       text DEFAULT NULL,
  p_document_number       text DEFAULT NULL,
  p_notes                 text DEFAULT NULL
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
  v_line         public.outlet_return_request_lines%ROWTYPE;
  v_request      public.outlet_return_requests%ROWTYPE;
  v_stock        public.outlet_stock%ROWTYPE;
  v_shipment     public.outlet_return_shipments%ROWTYPE;
  v_existing     public.outlet_stock_movements%ROWTYPE;
  v_notes        text := NULLIF(btrim(p_notes), '');
  v_document     text := NULLIF(btrim(p_document_number), '');
  v_number       text := NULLIF(btrim(p_shipment_number), '');
  v_before       integer;
  v_after        integer;
  v_movement_id  uuid;
  v_shipment_line_id uuid;
  v_fingerprint  text;
  v_avail_id     uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL OR p_return_request_line_id IS NULL THEN
    RAISE EXCEPTION 'request_id_and_line_required' USING ERRCODE = '23514';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;

  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'outlet_return_send',
    'return_request_line_id', p_return_request_line_id,
    'shipment_id', p_shipment_id,
    'quantity', p_quantity,
    'shipment_number', v_number,
    'document_number', v_document,
    'notes', v_notes
  )::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 70070));

  SELECT * INTO v_existing
  FROM public.outlet_stock_movements m
  WHERE m.reference_type = 'outlet_return_send' AND m.reference_id = p_request_id;
  IF FOUND THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true,
      'movement_id', v_existing.id,
      'quantity_before', v_existing.on_hand_before,
      'quantity_delta', v_existing.on_hand_delta,
      'quantity_after', v_existing.on_hand_after
    );
  END IF;

  -- Lock the ORIGINAL request line — re-validated live, exactly as 069 does
  -- for warehouse_transfer_lines, so a second concurrent send cannot both
  -- pass the same cap.
  SELECT * INTO v_line
  FROM public.outlet_return_request_lines WHERE id = p_return_request_line_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_request_line_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_line.status NOT IN ('approved', 'partially_fulfilled') THEN
    RAISE EXCEPTION 'return_request_line_not_approved' USING ERRCODE = '23514';
  END IF;
  IF v_line.fulfilled_quantity + p_quantity > v_line.approved_quantity THEN
    RAISE EXCEPTION 'quantity_exceeds_approved_remainder' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_request
  FROM public.outlet_return_requests WHERE id = v_line.return_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_request_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Resolve the SOURCE outlet_stock row — the SINGLE row the line's proven
  -- provenance already pinned (source_outlet_stock_id). No XOR branch: the
  -- composite FKs guarantee this stock is the one both the dispatch line and its
  -- dispatch_receive movement refer to.
  SELECT s.* INTO v_stock FROM public.outlet_stock s
  WHERE s.id = v_line.source_outlet_stock_id
  FOR UPDATE OF s;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'source_outlet_stock_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- THE IDOR GATE: authority is scoped to the outlet the LOCKED stock row
  -- actually belongs to, never a caller-supplied point id.
  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'outlet_stock.return', v_stock.organization_id, NULL, v_stock.distribution_point_id
  ) THEN
    RAISE EXCEPTION 'forbidden_outlet_return_send' USING ERRCODE = '42501';
  END IF;

  SELECT p.role, p.full_name INTO v_actor_role, v_actor_name
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  IF v_stock.on_hand_quantity - v_stock.reserved_quantity < p_quantity THEN
    RAISE EXCEPTION 'insufficient_available_quantity' USING ERRCODE = '23514';
  END IF;

  -- Resolve or create the shipment header.
  IF p_shipment_id IS NOT NULL THEN
    SELECT * INTO v_shipment
    FROM public.outlet_return_shipments WHERE id = p_shipment_id FOR UPDATE;
    IF NOT FOUND OR v_shipment.status <> 'in_transit'
       OR v_shipment.distribution_point_id <> v_stock.distribution_point_id THEN
      RAISE EXCEPTION 'outlet_return_shipment_not_open' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF v_number IS NULL THEN
      RAISE EXCEPTION 'shipment_number_required' USING ERRCODE = '23514';
    END IF;
    INSERT INTO public.outlet_return_shipments (
      return_request_id, distribution_point_id, source_organization_id,
      destination_warehouse_id, destination_organization_id,
      shipment_number, document_number, notes, sent_by
    ) VALUES (
      v_request.id, v_stock.distribution_point_id, v_stock.organization_id,
      v_request.destination_warehouse_id, v_request.destination_organization_id,
      v_number, v_document, v_notes, v_actor
    )
    RETURNING * INTO v_shipment;
  END IF;

  v_before := v_stock.on_hand_quantity;
  v_after  := v_before - p_quantity;

  UPDATE public.outlet_stock
     SET on_hand_quantity = v_after, updated_by = v_actor
   WHERE id = v_stock.id;

  INSERT INTO public.outlet_stock_movements (
    outlet_stock_id, organization_id, distribution_point_id, movement_type,
    on_hand_before, on_hand_delta, on_hand_after,
    reserved_before, reserved_delta, reserved_after,
    reason, reference_type, reference_id, request_fingerprint,
    source_document_number, actor_id, actor_role, actor_name,
    scientific_name_snapshot, concentration_snapshot, dosage_form_snapshot,
    batch_number_snapshot, internal_batch_reference_snapshot, expiry_date_snapshot
  ) VALUES (
    v_stock.id, v_stock.organization_id, v_stock.distribution_point_id, 'return_send',
    v_before, -p_quantity, v_after,
    v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
    'outlet_return', 'outlet_return_send', p_request_id, v_fingerprint,
    v_shipment.document_number, v_actor, v_actor_role, v_actor_name,
    v_stock.scientific_name, v_stock.concentration, v_stock.dosage_form,
    v_stock.batch_number, v_stock.internal_batch_reference, v_stock.expiry_date
  )
  RETURNING id INTO v_movement_id;

  -- Keep the public availability projection in sync — the same call every
  -- other outlet-mutating RPC in 067 makes. Skipping this would leave
  -- item_availability showing STALE, too-high stock after a return leaves.
  v_avail_id := public.phoenix_project_outlet_availability(v_stock.id);

  INSERT INTO public.outlet_return_shipment_lines (
    shipment_id, source_organization_id, source_outlet_stock_id,
    return_request_line_id,
    original_dispatch_line_id, original_inbound_movement_id,
    central_item_id,
    scientific_name, trade_name, concentration, dosage_form, unit,
    national_code, has_no_national_code, batch_number, has_no_batch_number,
    internal_batch_reference, expiry_date, unit_price, price_basis, currency, supply_type_text,
    supply_type, purchase_origin,
    sent_quantity
  ) VALUES (
    v_shipment.id, v_stock.organization_id, v_stock.id,
    v_line.id,
    v_line.original_dispatch_line_id, v_line.original_inbound_movement_id,
    v_stock.central_item_id,
    v_stock.scientific_name, v_stock.trade_name, v_stock.concentration, v_stock.dosage_form, v_stock.unit,
    v_stock.national_code, v_stock.has_no_national_code, v_stock.batch_number, v_stock.has_no_batch_number,
    v_stock.internal_batch_reference, v_stock.expiry_date, v_stock.unit_price, v_stock.price_basis,
    v_stock.currency, v_stock.supply_type_text,
    v_stock.supply_type, v_stock.purchase_origin,
    p_quantity
  )
  RETURNING id INTO v_shipment_line_id;

  -- Consume the return cap on the dispatch line — the single authoritative
  -- source (received_quantity - returned_quantity). Locked FOR UPDATE above so
  -- two concurrent sends cannot both pass the same cap. wdl_returned_qty_chk
  -- (returned_quantity <= received_quantity) is the structural backstop.
  UPDATE public.warehouse_dispatch_lines
     SET returned_quantity = returned_quantity + p_quantity
   WHERE id = v_line.original_dispatch_line_id;

  UPDATE public.outlet_return_request_lines
     SET fulfilled_quantity = fulfilled_quantity + p_quantity,
         status = CASE WHEN fulfilled_quantity + p_quantity = approved_quantity
                        THEN 'fulfilled' ELSE 'partially_fulfilled' END
   WHERE id = v_line.id;

  UPDATE public.outlet_return_shipments
     SET status = 'in_transit'
   WHERE id = v_shipment.id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_stock.organization_id, v_actor, v_actor_role,
    'outlet_stock.return_sent', 'outlet_return_shipment_lines', v_shipment_line_id, v_stock.scientific_name,
    jsonb_build_object(
      'request_id', p_request_id, 'shipment_id', v_shipment.id,
      'movement_id', v_movement_id, 'quantity_before', v_before,
      'quantity_delta', -p_quantity, 'quantity_after', v_after
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'shipment_id', v_shipment.id, 'shipment_line_id', v_shipment_line_id,
    'movement_id', v_movement_id, 'item_availability_id', v_avail_id,
    'quantity_before', v_before, 'quantity_delta', -p_quantity, 'quantity_after', v_after
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.phoenix_receive_outlet_return_shipment_line(
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

  -- THE IDOR GATE: authority is scoped to the DESTINATION (institution)
  -- warehouse, taken from the shipment, never the caller.
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

  -- Lock the provenance dispatch line, mirroring SEND — the single source this
  -- return traces to. (Both original_* columns are NOT NULL and pinned to each
  -- other by composite FK, so there is no movement-only branch to handle.)
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

  -- Looked up before EITHER outcome, so a rejection's audit trail also
  -- records what the return was FOR.
  v_reason_code := (
    SELECT rl.reason_code FROM public.outlet_return_request_lines rl
    WHERE rl.id = v_line.return_request_line_id
  );

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

  -- DISPOSITION CLASSIFICATION — FAIL-CLOSED. Identical policy to 069.
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
      reason, reference_type, reference_id, request_fingerprint,
      source_document_number, actor_id, actor_role, actor_name,
      scientific_name_snapshot, concentration_snapshot,
      dosage_form_snapshot, batch_number_snapshot,
      internal_batch_reference_snapshot
    ) VALUES (
      v_stock.id, v_stock.organization_id, v_stock.warehouse_id, 'add',
      v_before, p_received_quantity, v_after,
      v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
      'outlet_return', 'outlet_return_receive', p_request_id, v_fingerprint,
      NULL, v_actor, v_actor_role, v_actor_name,
      v_stock.scientific_name, v_stock.concentration,
      v_stock.dosage_form, v_stock.batch_number,
      v_stock.internal_batch_reference
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
      CASE WHEN v_objectively_expired AND v_reason_code IS DISTINCT FROM 'expired'
           THEN 'expired' ELSE COALESCE(v_reason_code, 'other') END,
      0, v_actor, v_actor
    )
    ON CONFLICT DO NOTHING;

    SELECT * INTO v_quarantine
    FROM public.warehouse_quarantine_stock q
    WHERE q.warehouse_id = v_shipment.destination_warehouse_id
      AND q.scientific_name = v_line.scientific_name
      AND COALESCE(q.concentration, '') = COALESCE(v_line.concentration, '')
      AND COALESCE(q.dosage_form, '')   = COALESCE(v_line.dosage_form, '')
      AND COALESCE(q.national_code, '') = COALESCE(v_line.national_code, '')
      AND COALESCE(q.batch_number, '')  = COALESCE(v_line.batch_number, '')
      AND COALESCE(q.expiry_date, DATE '0001-01-01')
          = COALESCE(v_line.expiry_date, DATE '0001-01-01')
      AND COALESCE(q.internal_batch_reference, '') = COALESCE(v_internal, '')
      AND q.quarantine_reason = (
            CASE WHEN v_objectively_expired AND v_reason_code IS DISTINCT FROM 'expired'
                 THEN 'expired' ELSE COALESCE(v_reason_code, 'other') END)
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

    INSERT INTO public.warehouse_quarantine_stock_movements (
      quarantine_stock_id, organization_id, warehouse_id, movement_type,
      quantity_before, quantity_delta, quantity_after,
      reason, reference_type, reference_id, request_fingerprint,
      source_document_number, actor_id, actor_role, actor_name,
      scientific_name_snapshot, concentration_snapshot,
      dosage_form_snapshot, batch_number_snapshot,
      internal_batch_reference_snapshot
    ) VALUES (
      v_quarantine.id, v_quarantine.organization_id, v_quarantine.warehouse_id, 'quarantine_receive',
      v_before, p_received_quantity, v_after,
      'outlet_return', 'outlet_return_quarantine_receive', p_request_id, v_fingerprint,
      NULL, v_actor, v_actor_role, v_actor_name,
      v_quarantine.scientific_name, v_quarantine.concentration,
      v_quarantine.dosage_form, v_quarantine.batch_number,
      v_quarantine.internal_batch_reference
    )
    RETURNING id INTO v_movement_id;
  END IF;

  UPDATE public.outlet_return_shipments
     SET status = CASE WHEN NOT EXISTS (
                         SELECT 1 FROM public.outlet_return_shipment_lines x
                         WHERE x.shipment_id = v_shipment.id AND x.status = 'in_transit')
                       THEN 'received' ELSE 'partially_received' END
   WHERE id = v_shipment.id;

  -- Single provenance: always tick the dispatch line's destination-side
  -- "received back so far" counter. wdl_return_received_qty_chk
  -- (return_received_quantity <= returned_quantity) is the structural backstop.
  UPDATE public.warehouse_dispatch_lines
     SET return_received_quantity = return_received_quantity + p_received_quantity
   WHERE id = v_line.original_dispatch_line_id;

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
    ),
      v_line.supply_type, v_line.purchase_origin
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

CREATE OR REPLACE FUNCTION public._phoenix_procurement_post_receipt_line(
  p_receipt_line public.procurement_receipt_lines,
  p_order        public.procurement_orders,
  p_line         public.procurement_order_lines,
  p_actor        uuid,
  p_actor_role   text,
  p_actor_name   text,
  OUT o_warehouse_stock_id uuid,
  OUT o_movement_id        uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_internal_ref text;
  v_source_doc   text := COALESCE(NULLIF(btrim(COALESCE(p_order.invoice_number, '')), ''), p_order.order_number);
  v_stock        public.warehouse_stock%ROWTYPE;
  v_before       integer;
  v_after        integer;
BEGIN
  -- A no-batch receipt line gets a stable private identity derived from the
  -- receipt line id, so independent no-batch receipts never merge (065's WSNB
  -- discipline, distinct PRNB namespace).
  v_internal_ref := CASE
    WHEN p_receipt_line.has_no_batch_number
      THEN 'PRNB-' || replace(p_receipt_line.id::text, '-', '')
    ELSE NULL
  END;

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
    p_order.organization_id, p_order.warehouse_id, p_line.central_item_id,
    p_line.scientific_name, p_line.trade_name, p_line.concentration, p_line.dosage_form, p_line.unit,
    p_receipt_line.national_code, p_receipt_line.has_no_national_code,
    p_receipt_line.batch_number, p_receipt_line.has_no_batch_number, v_internal_ref,
    p_receipt_line.expiry_date, 0, 0,
    p_receipt_line.unit_price, 'purchase', COALESCE(p_line.currency, p_order.currency), 'local_procurement',
    'purchase', 'supplementary',
    v_source_doc, NULL, p_actor, p_actor
  )
  ON CONFLICT DO NOTHING;

  SELECT *
    INTO v_stock
  FROM public.warehouse_stock s
  WHERE s.warehouse_id = p_order.warehouse_id
    AND s.scientific_name = p_line.scientific_name
    AND COALESCE(s.concentration, '') = COALESCE(p_line.concentration, '')
    AND COALESCE(s.dosage_form, '') = COALESCE(p_line.dosage_form, '')
    AND COALESCE(s.national_code, '') = COALESCE(p_receipt_line.national_code, '')
    AND COALESCE(s.batch_number, '') = COALESCE(p_receipt_line.batch_number, '')
    AND COALESCE(s.expiry_date, DATE '0001-01-01')
        = COALESCE(p_receipt_line.expiry_date, DATE '0001-01-01')
    AND COALESCE(s.internal_batch_reference, '') = COALESCE(v_internal_ref, '')
    AND COALESCE(s.supply_type, '') = COALESCE('purchase', '')
    AND COALESCE(s.purchase_origin, '') = COALESCE('supplementary', '')
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse_stock_identity_resolution_failed'
      USING ERRCODE = 'P0002';
  END IF;

  -- A receipt may fill an absent catalog link, never silently relink one (065).
  IF v_stock.central_item_id IS NOT NULL
     AND p_line.central_item_id IS NOT NULL
     AND v_stock.central_item_id IS DISTINCT FROM p_line.central_item_id THEN
    RAISE EXCEPTION 'warehouse_stock_central_item_conflict' USING ERRCODE = '23514';
  END IF;

  v_before := v_stock.on_hand_quantity;
  v_after  := v_before + p_receipt_line.quantity;

  UPDATE public.warehouse_stock
     SET on_hand_quantity       = v_after,
         central_item_id        = COALESCE(v_stock.central_item_id, p_line.central_item_id),
         trade_name             = COALESCE(p_line.trade_name, trade_name),
         unit                   = COALESCE(p_line.unit, unit),
         unit_price             = COALESCE(p_receipt_line.unit_price, unit_price),
         price_basis            = COALESCE(price_basis, 'purchase'),
         currency               = COALESCE(p_line.currency, p_order.currency, currency),
         supply_type_text       = COALESCE(supply_type_text, 'local_procurement'),
         source_document_number = COALESCE(v_source_doc, source_document_number),
         updated_by             = p_actor
   WHERE id = v_stock.id;

  INSERT INTO public.warehouse_stock_movements (
    warehouse_stock_id, organization_id, warehouse_id,
    movement_type,
    on_hand_before, on_hand_delta, on_hand_after,
    reserved_before, reserved_delta, reserved_after,
    reason, reference_type, reference_id,
    source_document_number, actor_id, actor_role, actor_name,
    scientific_name_snapshot, concentration_snapshot,
    dosage_form_snapshot, batch_number_snapshot,
    internal_batch_reference_snapshot
  ) VALUES (
    v_stock.id, p_order.organization_id, p_order.warehouse_id,
    'add',
    v_before, p_receipt_line.quantity, v_after,
    v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
    'local_procurement_receipt', 'procurement_receipt_line', p_receipt_line.id,
    v_source_doc, p_actor, p_actor_role, p_actor_name,
    v_stock.scientific_name, v_stock.concentration,
    v_stock.dosage_form, v_stock.batch_number,
    v_stock.internal_batch_reference
  )
  RETURNING id INTO o_movement_id;

  o_warehouse_stock_id := v_stock.id;
END;
$$;


-- == C. Grants: the sealed writer STAYS sealed (080), the guarded entry stays
--       the only authenticated route ==

REVOKE ALL ON FUNCTION public.phoenix_receive_warehouse_stock(
  uuid, uuid, text, integer, boolean, boolean, uuid, text, text, text, text,
  text, text, date, numeric, text, text, text, text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.phoenix_receive_warehouse_stock(
  uuid, uuid, text, integer, boolean, boolean, uuid, text, text, text, text,
  text, text, date, numeric, text, text, text, text, text, text, text) FROM authenticated;
COMMENT ON FUNCTION public.phoenix_receive_warehouse_stock(
  uuid, uuid, text, integer, boolean, boolean, uuid, text, text, text, text,
  text, text, date, numeric, text, text, text, text, text, text, text) IS
  'INTERNAL (080 discipline carried through 088). Unguarded accumulating receipt; EXECUTE revoked from authenticated - reachable only from phoenix_receive_warehouse_stock_guarded.';

REVOKE ALL ON FUNCTION public.phoenix_receive_warehouse_stock_guarded(
  uuid, uuid, text, integer, boolean, boolean, bigint, uuid, text, text, text,
  text, text, text, date, numeric, text, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_receive_warehouse_stock_guarded(
  uuid, uuid, text, integer, boolean, boolean, bigint, uuid, text, text, text,
  text, text, text, date, numeric, text, text, text, text, text, text, text) TO authenticated;

-- == D. Per-source balance read + reconciliation (SECURITY INVOKER: the
--       caller own RLS scoping applies to every underlying row) ==

CREATE OR REPLACE FUNCTION public.phoenix_warehouse_source_balances(p_warehouse_id uuid)
RETURNS TABLE (
  supply_type text, purchase_origin text,
  lots bigint, on_hand bigint, reserved bigint, available bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $src_balances$
  SELECT s.supply_type, s.purchase_origin,
         count(*)::bigint,
         COALESCE(sum(s.on_hand_quantity), 0)::bigint,
         COALESCE(sum(s.reserved_quantity), 0)::bigint,
         COALESCE(sum(s.available_quantity), 0)::bigint
    FROM public.warehouse_stock s
   WHERE s.warehouse_id = p_warehouse_id
   GROUP BY s.supply_type, s.purchase_origin
$src_balances$;
GRANT EXECUTE ON FUNCTION public.phoenix_warehouse_source_balances(uuid) TO authenticated;

-- Reconciliation: every per-source lot balance MUST equal the sum of its
-- append-only ledger deltas (physical stock = sum of source balances holds by
-- construction because a lot IS single-source; the drift that CAN happen is a
-- lot diverging from its own ledger). Returns ZERO rows when healthy.
CREATE OR REPLACE FUNCTION public.phoenix_provenance_reconciliation()
RETURNS TABLE (warehouse_stock_id uuid, warehouse_id uuid, scientific_name text,
               batch_number text, supply_type text, purchase_origin text,
               physical_on_hand integer, ledger_sum bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $recon$
  SELECT s.id, s.warehouse_id, s.scientific_name, s.batch_number,
         s.supply_type, s.purchase_origin,
         s.on_hand_quantity, COALESCE(m.ledger_sum, 0)
    FROM public.warehouse_stock s
    LEFT JOIN (
      SELECT wm.warehouse_stock_id, sum(wm.on_hand_delta)::bigint AS ledger_sum
        FROM public.warehouse_stock_movements wm
       GROUP BY wm.warehouse_stock_id
    ) m ON m.warehouse_stock_id = s.id
   WHERE s.on_hand_quantity IS DISTINCT FROM COALESCE(m.ledger_sum, 0)::integer
$recon$;
GRANT EXECUTE ON FUNCTION public.phoenix_provenance_reconciliation() TO authenticated;


-- == E. Regulatory acknowledgement audit record ==
-- Creating or approving an inter-institution transfer requires the operator to
-- confirm they reviewed the applicable regulations. The confirmation is an
-- AUDIT FACT (who/when/what), never an automated ruling on permissibility.
CREATE OR REPLACE FUNCTION public.phoenix_record_regulatory_ack(
  p_entity_type text,
  p_entity_id   uuid,
  p_action      text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $reg_ack$
DECLARE
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_role  text;
  v_name  text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF COALESCE(btrim(p_entity_type), '') NOT IN ('warehouse_transfer_request') THEN
    RAISE EXCEPTION 'invalid_ack_entity' USING ERRCODE = '23514';
  END IF;
  IF COALESCE(btrim(p_action), '') NOT IN ('transfer.create_ack', 'transfer.review_ack') THEN
    RAISE EXCEPTION 'invalid_ack_action' USING ERRCODE = '23514';
  END IF;
  SELECT pr.organization_id, pr.role, pr.full_name INTO v_org, v_role, v_name
    FROM public.profiles pr WHERE pr.id = v_actor AND pr.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_org, v_actor, v_role, p_action, p_entity_type, p_entity_id, v_name,
    jsonb_build_object('acknowledged_at', now(),
      'statement', 'reviewed regulations and verified transfer permissibility')
  );
  RETURN jsonb_build_object('ok', true);
END;
$reg_ack$;
REVOKE ALL ON FUNCTION public.phoenix_record_regulatory_ack(text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_record_regulatory_ack(text, uuid, text) TO authenticated;

COMMIT;

-- ============================================================================
-- POST-CONDITIONS (read-only, run after apply):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name='warehouse_stock' AND column_name IN ('supply_type','purchase_origin');
--   SELECT has_function_privilege('authenticated',
--     'public.phoenix_receive_warehouse_stock(uuid,uuid,text,integer,boolean,boolean,uuid,text,text,text,text,text,text,date,numeric,text,text,text,text,text,text,text)','EXECUTE');
--     -- expect FALSE (080 discipline preserved)
--   SELECT count(*) FROM public.phoenix_provenance_reconciliation(); -- expect 0
-- ROLLBACK: additive columns + function re-issues; restore functions from
-- 065/068/069/070/071/079/087 definitions and drop the new columns.
-- ============================================================================
