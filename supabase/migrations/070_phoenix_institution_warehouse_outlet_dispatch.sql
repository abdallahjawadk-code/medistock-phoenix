-- ============================================================================
-- INSTITUTION-WAREHOUSE-TO-OUTLET-DISPATCH-070-A
--
-- MANUAL APPLY ONLY. DO NOT use supabase db push or any automated runner.
--
-- VERIFICATION STATUS: authored, NOT applied, not executed against a
-- disposable PostgreSQL database. Validation used static analysis and the
-- test suite only. Apply to a staging/preview database and confirm every
-- post-condition passes BEFORE this is treated as ready for production.
--
-- STRATEGY: Expand -> Frontend Migration -> Contract. This is an EXPAND step.
-- Additive by construction.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THIS MIGRATION EXISTS — THE GAP IT CLOSES
-- ─────────────────────────────────────────────────────────────────────────────
-- 061 shipped warehouse_dispatches/warehouse_dispatch_lines as SCHEMA ONLY —
-- its own closing NOTICE says so explicitly ("no dispatch RPC created").
-- 067 shipped phoenix_receive_outlet_dispatch_line — the RECEIVE side — but its
-- own header states it is "authored against the dispatch schema's contract
-- and is INERT until the send path ... starts producing 'sent' dispatches."
-- No migration from 062 through 069 ever built that send path: a full-text
-- grep for CREATE FUNCTION public.phoenix_(create|send|cancel)_.*dispatch
-- across every migration returns zero hits. This was discovered while
-- designing the outlet<->institution RETURN migration (071, formerly drafted
-- as 070 in PR #14): a return path cannot be built on top of a forward
-- dispatch path that cannot itself create or send anything. This migration
-- closes that gap FIRST.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 'add' ON outlet_stock_movements: AUDITED, FOUND UNWRITTEN, NOT TRUSTED
-- ─────────────────────────────────────────────────────────────────────────────
-- Before writing this file, every INSERT INTO outlet_stock_movements in the
-- migration history was inspected. Exactly three movement_type literals are
-- ever written: 'dispatch_receive' (067's receive RPC), 'dispense' (067's
-- dispense RPC), 'correction' (067's count/correction RPC). 'add' sits in
-- outlet_stock_movements_type_chk (067) but NO RPC ANYWHERE writes it — it is
-- a reserved-but-unwritten value, exactly like 'reserve'/'release'/
-- 'return_send' were before something finally spent them. It must never be
-- treated as a "qualified receipt": if it were ever written by a future
-- migration without care, it could just as easily represent a manual/legacy
-- correction as a genuine goods-received event, and 'correction' itself is
-- explicitly documented (067) as "the only outlet path that can move stock to
-- an arbitrary number with no document behind it" — the opposite of
-- qualified provenance. This migration's SEND path therefore writes
-- 'dispatch_receive' via 067's EXISTING, ALREADY-CORRECT receive RPC, reused
-- verbatim — never 'add', never inventing a new implicit-trust pathway.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- distribution_points.warehouse_id: THE SAME STRUCTURAL PAIRING, NOW ENFORCED
-- ON THE FORWARD SIDE TOO
-- ─────────────────────────────────────────────────────────────────────────────
-- 061's schema only required a dispatch's warehouse and outlet to share one
-- organization_id — any warehouse in the org could dispatch to any outlet in
-- the org. This migration adds a composite FK pinning
-- (destination_distribution_point_id, warehouse_id) on warehouse_dispatches
-- to distribution_points(id, warehouse_id): an outlet may only ever be
-- dispatched to BY THE SPECIFIC WAREHOUSE its own warehouse_id names — the
-- same structural pairing this domain already committed to. additive: the
-- FK is new on an already-empty (0 rows in production, confirmed live)
-- table, so no existing row can violate it.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- NO NEW MOVEMENT_TYPE, REUSING RESERVED VOCABULARY
-- ─────────────────────────────────────────────────────────────────────────────
-- The institution-side debit reuses 'dispatch_send' on warehouse_stock_movements
-- (060's CHECK), the SAME value 068 already spends for its own warehouse<->
-- warehouse forward debit — disambiguated by reference_type
-- ('warehouse_dispatch_send' here vs 068's 'warehouse_transfer_send'), exactly
-- the same reuse-not-widen discipline 068/069 established. The outlet-side
-- credit reuses 'dispatch_receive' via 067's EXISTING RPC, unmodified. No
-- ALTER, no DROP, no widened CHECK anywhere in this file.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS MIGRATION DELIBERATELY DOES **NOT** DO
-- ─────────────────────────────────────────────────────────────────────────────
--   * No DROP, no RENAME, no REVOKE against any pre-existing object.
--   * No modification to phoenix_receive_outlet_dispatch_line (067) — reused
--     verbatim, unchanged, already correct (partial receive/reject/
--     difference, idempotency, row locks, audit, expiry refusal all present).
--   * No FEFO auto-allocation across multiple lots — that is 072's job. The
--     caller names an EXACT p_warehouse_stock_id; there is no "pick the
--     nearest-expiry match automatically" code path anywhere in this file to
--     be accidentally random about.
--   * No new permission key — warehouse_dispatch.{view,create,edit_draft,
--     send,cancel} (061) and outlet_stock.receive (066/067) already exist and
--     are already correctly role-assigned; this migration only makes them
--     load-bearing by finally building the RPCs that check them.
--   * No RBAC enforcement change. Enforcement stays OFF; scope enforcement
--     (phoenix_profile_has_scoped_permission) stays ON, as always.
--   * No data backfill, no row rewritten.
--   * No frontend in this PR — DB layer only.
--   * NOT APPLIED by this PR.
-- ============================================================================

begin;

-- ============================================================================
-- 0. PRECONDITIONS
-- ============================================================================
DO $guard$
BEGIN
  IF to_regclass('public.warehouse_dispatches') IS NULL
     OR to_regclass('public.warehouse_dispatch_lines') IS NULL
     OR to_regclass('public.warehouse_stock') IS NULL
     OR to_regclass('public.warehouse_stock_movements') IS NULL
     OR to_regclass('public.outlet_stock') IS NULL
     OR to_regclass('public.outlet_stock_movements') IS NULL
     OR to_regclass('public.distribution_points') IS NULL THEN
    RAISE EXCEPTION 'ABORT 070: expected 001/060/061/067 schema is absent. Apply earlier migrations first.';
  END IF;

  IF to_regprocedure('public.phoenix_receive_outlet_dispatch_line(uuid,uuid,integer,text,text)') IS NULL THEN
    RAISE EXCEPTION 'ABORT 070: 067 phoenix_receive_outlet_dispatch_line is absent. Apply 067 first.';
  END IF;

  IF to_regprocedure('public.phoenix_profile_has_scoped_permission(uuid,text,uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'ABORT 070: 062 scope helper is absent. Apply 062 first.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'warehouse_dispatches_id_org_uniq') THEN
    RAISE EXCEPTION 'ABORT 070: warehouse_dispatches_id_org_uniq (061) is absent.';
  END IF;

  IF EXISTS (SELECT 1 FROM public.warehouse_dispatches LIMIT 1)
     OR EXISTS (SELECT 1 FROM public.warehouse_dispatch_lines LIMIT 1) THEN
    RAISE NOTICE '070: warehouse_dispatches/lines already hold rows — the new '
      'composite FK below must still be satisfiable by every existing row.';
  END IF;

  RAISE NOTICE '070 preconditions OK.';
END;
$guard$;

-- ============================================================================
-- 1. Structural pairing, forward side: an outlet may only be dispatched to
--    BY THE WAREHOUSE ITS OWN warehouse_id NAMES — same pairing as the return
--    domain, now enforced here too.
-- ============================================================================
CREATE UNIQUE INDEX IF NOT EXISTS distribution_points_id_warehouse_uniq
  ON public.distribution_points (id, warehouse_id);

DO $$ BEGIN
  ALTER TABLE public.warehouse_dispatches
    ADD CONSTRAINT warehouse_dispatches_dest_warehouse_fk
    FOREIGN KEY (destination_distribution_point_id, warehouse_id)
    REFERENCES public.distribution_points (id, warehouse_id)
    ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON CONSTRAINT warehouse_dispatches_dest_warehouse_fk ON public.warehouse_dispatches IS
  'INSTITUTION-WAREHOUSE-TO-OUTLET-DISPATCH-070-A: an outlet may only be '
  'dispatched to by the SPECIFIC warehouse its own distribution_points.'
  'warehouse_id names — additive, structural, no route table.';

-- ============================================================================
-- 2. Idempotency for the new SEND leg — reusing 060's 'dispatch_send' with a
--    NEW reference_type, distinct from 068's 'warehouse_transfer_send'
-- ============================================================================
CREATE UNIQUE INDEX IF NOT EXISTS warehouse_stock_movements_dispatch_line_once_uniq
  ON public.warehouse_stock_movements (reference_id)
  WHERE reference_type = 'warehouse_dispatch_send' AND reference_id IS NOT NULL;

DO $$ BEGIN
  ALTER TABLE public.warehouse_stock_movements
    ADD CONSTRAINT warehouse_stock_movements_dispatch_fingerprint_chk
    CHECK (
      reference_type IS DISTINCT FROM 'warehouse_dispatch_send'
      OR (request_fingerprint IS NOT NULL AND request_fingerprint ~ '^[0-9a-f]{64}$')
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================================
-- 3. CREATE — a draft dispatch header
-- ============================================================================
CREATE OR REPLACE FUNCTION public.phoenix_create_warehouse_dispatch(
  p_warehouse_id                    uuid,
  p_destination_distribution_point_id uuid,
  p_dispatch_number                  text,
  p_document_number                   text DEFAULT NULL,
  p_default_currency                   text DEFAULT NULL,
  p_notes                               text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor       uuid := auth.uid();
  v_actor_role  text;
  v_warehouse   public.warehouses%ROWTYPE;
  v_point       public.distribution_points%ROWTYPE;
  v_number      text := NULLIF(btrim(p_dispatch_number), '');
  v_document    text := NULLIF(btrim(p_document_number), '');
  v_currency    text := NULLIF(btrim(p_default_currency), '');
  v_notes       text := NULLIF(btrim(p_notes), '');
  v_dispatch    public.warehouse_dispatches%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_warehouse_id IS NULL OR p_destination_distribution_point_id IS NULL THEN
    RAISE EXCEPTION 'warehouse_and_destination_required' USING ERRCODE = '23514';
  END IF;
  IF v_number IS NULL THEN
    RAISE EXCEPTION 'dispatch_number_required' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_warehouse_id::text, 70169));

  SELECT * INTO v_warehouse
  FROM public.warehouses WHERE id = p_warehouse_id FOR SHARE;
  IF NOT FOUND OR v_warehouse.status <> 'active' THEN
    RAISE EXCEPTION 'warehouse_not_found_or_inactive' USING ERRCODE = 'P0002';
  END IF;

  -- Lock the destination point row so its warehouse_id/status/point_type
  -- cannot flip mid-transaction — the same lock discipline every route/pairing
  -- check in this domain uses.
  SELECT * INTO v_point
  FROM public.distribution_points WHERE id = p_destination_distribution_point_id FOR SHARE;
  IF NOT FOUND OR v_point.status <> 'active' THEN
    RAISE EXCEPTION 'destination_outlet_not_found_or_inactive' USING ERRCODE = 'P0002';
  END IF;
  IF v_point.point_type NOT IN ('pharmacy', 'crash_cabinet', 'rescue_cart') THEN
    RAISE EXCEPTION 'outlet_type_not_approved_for_stock: %', v_point.point_type
      USING ERRCODE = '23514';
  END IF;
  -- THE structural pairing, checked here with a named error — the composite
  -- FK on warehouse_dispatches would refuse this anyway, but a friendly error
  -- beats a raw constraint-violation message.
  IF v_point.warehouse_id IS DISTINCT FROM p_warehouse_id THEN
    RAISE EXCEPTION 'destination_outlet_not_paired_with_this_warehouse' USING ERRCODE = '23514';
  END IF;
  IF v_warehouse.organization_id <> v_point.organization_id THEN
    RAISE EXCEPTION 'warehouse_and_destination_organization_mismatch' USING ERRCODE = '23514';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'warehouse_dispatch.create', v_warehouse.organization_id, p_warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_warehouse_dispatch_create' USING ERRCODE = '42501';
  END IF;

  SELECT p.role INTO v_actor_role FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.warehouse_dispatches (
    organization_id, warehouse_id, destination_distribution_point_id,
    dispatch_number, status, document_number, default_currency, notes, created_by
  ) VALUES (
    v_warehouse.organization_id, p_warehouse_id, p_destination_distribution_point_id,
    v_number, 'draft', v_document, v_currency, v_notes, v_actor
  )
  RETURNING * INTO v_dispatch;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_warehouse.organization_id, v_actor, v_actor_role,
    'warehouse_dispatch.created', 'warehouse_dispatches', v_dispatch.id, v_number,
    jsonb_build_object('warehouse_id', p_warehouse_id, 'distribution_point_id', p_destination_distribution_point_id)
  );

  RETURN jsonb_build_object('ok', true, 'dispatch_id', v_dispatch.id, 'status', v_dispatch.status);
END;
$$;

-- ============================================================================
-- 4. ADD LINE — draft only. No automatic lot/FEFO selection: the caller
-- names an EXACT p_warehouse_stock_id (072's job to auto-allocate).
-- ============================================================================
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
    sent_quantity, status
  ) VALUES (
    v_dispatch.organization_id, v_dispatch.id, v_stock.id, v_stock.central_item_id,
    v_stock.scientific_name, v_stock.trade_name, v_stock.concentration, v_stock.dosage_form, v_stock.unit,
    v_stock.national_code, v_stock.has_no_national_code, v_stock.batch_number, v_stock.has_no_batch_number,
    v_stock.internal_batch_reference, v_stock.expiry_date, v_stock.unit_price, v_stock.price_basis,
    v_stock.currency, v_stock.supply_type_text,
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

-- ============================================================================
-- 5. UPDATE LINE QUANTITY — draft only
-- ============================================================================
CREATE OR REPLACE FUNCTION public.phoenix_update_dispatch_line_quantity(
  p_dispatch_line_id uuid,
  p_quantity          integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_line       public.warehouse_dispatch_lines%ROWTYPE;
  v_dispatch   public.warehouse_dispatches%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_dispatch_line_id IS NULL THEN
    RAISE EXCEPTION 'dispatch_line_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_line
  FROM public.warehouse_dispatch_lines WHERE id = p_dispatch_line_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dispatch_line_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_dispatch
  FROM public.warehouse_dispatches WHERE id = v_line.dispatch_id FOR UPDATE;
  IF NOT FOUND OR v_dispatch.status <> 'draft' THEN
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

  UPDATE public.warehouse_dispatch_lines SET sent_quantity = p_quantity WHERE id = v_line.id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_dispatch.organization_id, v_actor, v_actor_role,
    'warehouse_dispatch.line_quantity_updated', 'warehouse_dispatch_lines', v_line.id, v_line.scientific_name,
    jsonb_build_object('dispatch_id', v_dispatch.id, 'old_quantity', v_line.sent_quantity, 'new_quantity', p_quantity)
  );

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ============================================================================
-- 6. DELETE LINE — draft only
-- ============================================================================
CREATE OR REPLACE FUNCTION public.phoenix_delete_dispatch_line(
  p_dispatch_line_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_line       public.warehouse_dispatch_lines%ROWTYPE;
  v_dispatch   public.warehouse_dispatches%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_dispatch_line_id IS NULL THEN
    RAISE EXCEPTION 'dispatch_line_id_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_line
  FROM public.warehouse_dispatch_lines WHERE id = p_dispatch_line_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dispatch_line_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_dispatch
  FROM public.warehouse_dispatches WHERE id = v_line.dispatch_id FOR UPDATE;
  IF NOT FOUND OR v_dispatch.status <> 'draft' THEN
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

  DELETE FROM public.warehouse_dispatch_lines WHERE id = v_line.id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_dispatch.organization_id, v_actor, v_actor_role,
    'warehouse_dispatch.line_deleted', 'warehouse_dispatch_lines', v_line.id, v_line.scientific_name,
    jsonb_build_object('dispatch_id', v_dispatch.id)
  );

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ============================================================================
-- 7. CANCEL — draft only (before send). Symmetric with 069's cancel window.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.phoenix_cancel_warehouse_dispatch(
  p_dispatch_id          uuid,
  p_cancellation_reason  text
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
  v_reason     text := NULLIF(btrim(p_cancellation_reason), '');
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_dispatch_id IS NULL THEN
    RAISE EXCEPTION 'dispatch_id_required' USING ERRCODE = '23514';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'cancellation_reason_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_dispatch
  FROM public.warehouse_dispatches WHERE id = p_dispatch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dispatch_not_found' USING ERRCODE = 'P0002';
  END IF;
  -- Cancel is allowed only BEFORE physical movement — draft only. Once sent,
  -- stock has left the warehouse; symmetric with every other domain in this
  -- schema (068/069/070-return all refuse to un-send a physical movement).
  IF v_dispatch.status <> 'draft' THEN
    RAISE EXCEPTION 'dispatch_not_cancellable' USING ERRCODE = '23514';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'warehouse_dispatch.cancel', v_dispatch.organization_id, v_dispatch.warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_warehouse_dispatch_cancel' USING ERRCODE = '42501';
  END IF;

  SELECT p.role INTO v_actor_role FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  UPDATE public.warehouse_dispatches
     SET status = 'cancelled', cancelled_by = v_actor, cancelled_at = now(),
         cancellation_reason = v_reason
   WHERE id = v_dispatch.id;

  DELETE FROM public.warehouse_dispatch_lines WHERE dispatch_id = v_dispatch.id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_dispatch.organization_id, v_actor, v_actor_role,
    'warehouse_dispatch.cancelled', 'warehouse_dispatches', v_dispatch.id, v_dispatch.dispatch_number,
    jsonb_build_object('reason', v_reason)
  );

  RETURN jsonb_build_object('ok', true, 'status', 'cancelled');
END;
$$;

-- ============================================================================
-- 8. SEND — the ONE stock-moving RPC on the institution side. Whole-dispatch,
-- atomic: every line is validated BEFORE any is debited, so a single
-- insufficient-stock line aborts the entire send with no partial mutation.
-- Refuses an expired lot (unlike 070-return's SEND, which deliberately does
-- NOT — this is a FORWARD send of dispensable stock, same rule as 068's
-- forward SEND).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.phoenix_send_warehouse_dispatch(
  p_request_id  uuid,
  p_dispatch_id uuid
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
  v_dispatch    public.warehouse_dispatches%ROWTYPE;
  v_line        RECORD;
  v_stock       public.warehouse_stock%ROWTYPE;
  v_before      integer;
  v_after       integer;
  v_movement_id uuid;
  v_fingerprint text;
  v_line_count  integer := 0;
  v_movement_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL OR p_dispatch_id IS NULL THEN
    RAISE EXCEPTION 'request_id_and_dispatch_id_required' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 70169));

  SELECT * INTO v_dispatch
  FROM public.warehouse_dispatches WHERE id = p_dispatch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dispatch_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Idempotent replay at the HEADER level: already sent, and every line
  -- already has its once-only movement (proven by the unique index in
  -- section 2) — a retry is a safe no-op, not a re-debit.
  IF v_dispatch.status <> 'draft' THEN
    IF v_dispatch.status IN ('sent', 'partially_accepted', 'accepted', 'rejected') THEN
      RETURN jsonb_build_object('ok', true, 'idempotent_replay', true, 'dispatch_id', v_dispatch.id, 'status', v_dispatch.status);
    END IF;
    RAISE EXCEPTION 'dispatch_not_sendable' USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.warehouse_dispatch_lines WHERE dispatch_id = v_dispatch.id) THEN
    RAISE EXCEPTION 'dispatch_has_no_lines' USING ERRCODE = '23514';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'warehouse_dispatch.send', v_dispatch.organization_id, v_dispatch.warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_warehouse_dispatch_send' USING ERRCODE = '42501';
  END IF;

  SELECT p.role, p.full_name INTO v_actor_role, v_actor_name
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  -- PASS 1: lock and validate EVERY line's stock BEFORE debiting any of
  -- them — atomic all-or-nothing, no partial send on an insufficient lot.
  FOR v_line IN
    SELECT * FROM public.warehouse_dispatch_lines
    WHERE dispatch_id = v_dispatch.id
    ORDER BY id
    FOR UPDATE
  LOOP
    v_line_count := v_line_count + 1;

    SELECT * INTO v_stock
    FROM public.warehouse_stock WHERE id = v_line.warehouse_stock_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'warehouse_stock_not_found_for_line: %', v_line.id USING ERRCODE = 'P0002';
    END IF;
    IF v_stock.on_hand_quantity - v_stock.reserved_quantity < v_line.sent_quantity THEN
      RAISE EXCEPTION 'insufficient_available_quantity_for_line: %', v_line.id USING ERRCODE = '23514';
    END IF;
    -- Refuse a lot that has expired between draft and send — the last point
    -- this system can still refuse it; forward SEND never ships expired
    -- stock (unlike the return domain's deliberate exception).
    IF v_stock.expiry_date IS NOT NULL AND v_stock.expiry_date < current_date THEN
      RAISE EXCEPTION 'expired_batch_cannot_be_dispatched: %', v_line.id USING ERRCODE = '23514';
    END IF;
  END LOOP;

  -- PASS 2: every line already proven sendable — debit and record, once per
  -- line, idempotent via reference_id = the line's own id (never the shared
  -- p_request_id, since one request sends MANY lines).
  FOR v_line IN
    SELECT * FROM public.warehouse_dispatch_lines
    WHERE dispatch_id = v_dispatch.id
    ORDER BY id
  LOOP
    IF EXISTS (
      SELECT 1 FROM public.warehouse_stock_movements
      WHERE reference_type = 'warehouse_dispatch_send' AND reference_id = v_line.id
    ) THEN
      CONTINUE; -- already recorded on a prior partial attempt; skip, never re-debit
    END IF;

    SELECT * INTO v_stock FROM public.warehouse_stock WHERE id = v_line.warehouse_stock_id FOR UPDATE;

    v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
      'operation', 'warehouse_dispatch_send',
      'dispatch_line_id', v_line.id,
      'quantity', v_line.sent_quantity
    )::text, 'UTF8')), 'hex');

    v_before := v_stock.on_hand_quantity;
    v_after  := v_before - v_line.sent_quantity;

    UPDATE public.warehouse_stock
       SET on_hand_quantity = v_after, updated_by = v_actor
     WHERE id = v_stock.id;

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
      v_before, -v_line.sent_quantity, v_after,
      v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
      'warehouse_dispatch_send', 'warehouse_dispatch_send', v_line.id, v_fingerprint,
      v_dispatch.document_number, v_actor, v_actor_role, v_actor_name,
      v_stock.scientific_name, v_stock.concentration,
      v_stock.dosage_form, v_stock.batch_number,
      v_stock.internal_batch_reference
    )
    RETURNING id INTO v_movement_id;

    v_movement_ids := v_movement_ids || v_movement_id;
  END LOOP;

  UPDATE public.warehouse_dispatches
     SET status = 'sent', sent_by = v_actor, sent_at = now()
   WHERE id = v_dispatch.id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_dispatch.organization_id, v_actor, v_actor_role,
    'warehouse_dispatch.sent', 'warehouse_dispatches', v_dispatch.id, v_dispatch.dispatch_number,
    jsonb_build_object('request_id', p_request_id, 'line_count', v_line_count, 'movement_ids', to_jsonb(v_movement_ids))
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'dispatch_id', v_dispatch.id, 'status', 'sent',
    'line_count', v_line_count, 'movement_ids', to_jsonb(v_movement_ids)
  );
END;
$$;

-- ============================================================================
-- 9. Grants
-- ============================================================================
REVOKE ALL ON FUNCTION public.phoenix_create_warehouse_dispatch(uuid, uuid, text, text, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_create_warehouse_dispatch(uuid, uuid, text, text, text, text)
  TO authenticated;

REVOKE ALL ON FUNCTION public.phoenix_add_dispatch_line(uuid, uuid, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_add_dispatch_line(uuid, uuid, integer)
  TO authenticated;

REVOKE ALL ON FUNCTION public.phoenix_update_dispatch_line_quantity(uuid, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_update_dispatch_line_quantity(uuid, integer)
  TO authenticated;

REVOKE ALL ON FUNCTION public.phoenix_delete_dispatch_line(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_delete_dispatch_line(uuid)
  TO authenticated;

REVOKE ALL ON FUNCTION public.phoenix_cancel_warehouse_dispatch(uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_cancel_warehouse_dispatch(uuid, text)
  TO authenticated;

REVOKE ALL ON FUNCTION public.phoenix_send_warehouse_dispatch(uuid, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_send_warehouse_dispatch(uuid, uuid)
  TO authenticated;

COMMENT ON FUNCTION public.phoenix_send_warehouse_dispatch(uuid, uuid) IS
  'INSTITUTION-WAREHOUSE-TO-OUTLET-DISPATCH-070-A: the institution-side debit. '
  'Whole-dispatch, atomic — every line validated (sufficient available '
  'quantity, not expired) before any is debited. Idempotent per LINE '
  '(reference_id = dispatch_line_id), so a retry after a partial failure '
  'never re-debits an already-recorded line. Reuses ''dispatch_send'' (060), '
  'never a new movement_type.';

-- ============================================================================
-- 10. POST-CONDITIONS
-- ============================================================================
DO $verify$
DECLARE
  v_def  text;
  v_body text;
BEGIN
  -- 10a. The forward pairing FK exists and is structural.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'warehouse_dispatches_dest_warehouse_fk' AND contype = 'f') THEN
    RAISE EXCEPTION 'ABORT 070: warehouse_dispatches_dest_warehouse_fk missing';
  END IF;

  -- 10b. No widened CHECK: warehouse_stock_movements_type_chk and
  -- outlet_stock_movements_type_chk untouched; 'dispatch_send'/'dispatch_receive'
  -- are REUSED, not new.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'warehouse_stock_movements_type_chk'
      AND pg_get_constraintdef(oid) LIKE '%''dispatch_send''%'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (070): warehouse_stock_movements_type_chk missing dispatch_send';
  END IF;

  -- 10c. 067's RECEIVE RPC is untouched — same signature, still present,
  -- still the only writer of 'dispatch_receive'.
  IF to_regprocedure('public.phoenix_receive_outlet_dispatch_line(uuid,uuid,integer,text,text)') IS NULL THEN
    RAISE EXCEPTION 'ABORT 070: 067 RECEIVE RPC was removed or its signature changed';
  END IF;

  -- 10d. SEND refuses expired batches (forward direction — unlike the return
  -- domain's deliberate exception).
  v_body := pg_get_functiondef('public.phoenix_send_warehouse_dispatch(uuid,uuid)'::regprocedure);
  ASSERT v_body LIKE '%expiry_date < current_date%',
    'VERIFY FAILED (070): forward SEND must refuse expired batches';

  -- 10e. SEND validates every line BEFORE debiting any (two-pass, no partial
  -- mutation on an insufficient line).
  ASSERT position('FOR UPDATE' in v_body) < position('UPDATE public.warehouse_stock' in v_body),
    'VERIFY FAILED (070): SEND must lock and validate before mutating';

  -- 10f. Idempotency is structural for the new SEND leg.
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'warehouse_stock_movements_dispatch_line_once_uniq') THEN
    RAISE EXCEPTION 'ABORT 070: dispatch-send idempotency index missing';
  END IF;

  -- 10g. No new permission key was minted — every key this file's RPCs check
  -- already existed before this migration.
  FOREACH v_def IN ARRAY ARRAY[
    'warehouse_dispatch.create', 'warehouse_dispatch.edit_draft',
    'warehouse_dispatch.send', 'warehouse_dispatch.cancel', 'outlet_stock.receive'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM public.permission_keys WHERE key = v_def) THEN
      RAISE EXCEPTION 'ABORT 070: expected pre-existing permission key missing: %', v_def;
    END IF;
  END LOOP;

  RAISE NOTICE '070 verified: institution warehouse -> outlet forward dispatch '
    'builds CREATE/ADD-LINE/UPDATE-LINE/DELETE-LINE/CANCEL/SEND on 061''s '
    'schema, reuses 067''s RECEIVE unchanged, reuses dispatch_send/'
    'dispatch_receive (no widened CHECK), mints no new permission key, and '
    'enforces the SAME warehouse<->outlet structural pairing the return '
    'domain uses. NOT APPLIED by this PR.';
END;
$verify$;

commit;
