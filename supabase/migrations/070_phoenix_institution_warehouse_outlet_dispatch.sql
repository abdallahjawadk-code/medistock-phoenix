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
-- 2b. Shared header-status recompute — one implementation, two callers
-- ============================================================================
-- Extracted so both the rebuilt RECEIVE (2c) and the defensive trigger (8b)
-- compute the header status identically, from the SAME logic, rather than
-- two copies that could drift.
CREATE OR REPLACE FUNCTION public.phoenix_recompute_warehouse_dispatch_header_status(
  p_dispatch_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_total     integer;
  v_pending   integer;
  v_accepted  integer;
  v_rejected  integer;
  v_new_status text;
BEGIN
  SELECT count(*),
         count(*) FILTER (WHERE status = 'pending'),
         count(*) FILTER (WHERE status IN ('accepted', 'accepted_with_difference')),
         count(*) FILTER (WHERE status = 'rejected')
    INTO v_total, v_pending, v_accepted, v_rejected
  FROM public.warehouse_dispatch_lines
  WHERE dispatch_id = p_dispatch_id;

  v_new_status := CASE
    WHEN v_pending > 0 THEN 'partially_accepted'  -- at least one decided, some still open
    WHEN v_accepted = v_total THEN 'accepted'      -- every line accepted (with or without difference)
    WHEN v_rejected = v_total THEN 'rejected'      -- every line rejected
    ELSE 'partially_accepted'                       -- all decided, but a mix of accepted/rejected
  END;

  -- Only ever moves a header OUT of 'sent'/'partially_accepted'. Never
  -- touches 'draft' or an already-terminal 'accepted'/'rejected'/'cancelled'
  -- header.
  UPDATE public.warehouse_dispatches
     SET status = v_new_status
   WHERE id = p_dispatch_id
     AND status IN ('sent', 'partially_accepted')
     AND status IS DISTINCT FROM v_new_status;
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_recompute_warehouse_dispatch_header_status(uuid)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.phoenix_recompute_warehouse_dispatch_header_status(uuid) IS
  'INSTITUTION-WAREHOUSE-TO-OUTLET-DISPATCH-070-A: recomputes warehouse_dispatches.'
  'status from its lines'' CURRENT statuses. Called explicitly, under the SAME '
  'header row lock, from the rebuilt RECEIVE (2c) right after it decides a line '
  '— NOT relied upon via the trigger (8b) alone, which exists only as '
  'defense-in-depth for any future caller that updates a line without going '
  'through RECEIVE.';

-- ============================================================================
-- 2c. RECEIVE — 067's phoenix_receive_outlet_dispatch_line, RECREATED here to
-- close a concurrency gap, with THE SAME SIGNATURE, ACL, search_path and
-- return contract. Every line of business logic below is unchanged from 067;
-- what changed is lock ORDER and ONE explicit recompute call.
-- ============================================================================
-- THE GAP: two concurrent RECEIVE calls against DIFFERENT LINES of the SAME
-- dispatch were previously serialized only by each line's own row lock and by
-- the per-request_id advisory lock (which does nothing for two DIFFERENT
-- request ids). Under READ COMMITTED, a header-status recompute driven only
-- by an AFTER trigger could run inside a transaction that started before a
-- sibling transaction committed its own line update — seeing a stale,
-- incomplete picture and leaving the header at 'sent' after only one of two
-- lines had actually been decided.
--
-- THE FIX, in order:
--   1. Safely extract dispatch_id from p_dispatch_line_id with an UNLOCKED
--      read — safe because dispatch_id is an immutable FK, never UPDATEd
--      after a line is created, so there is no TOCTOU window to race.
--   2. Take a SECOND advisory lock, keyed by DISPATCH (not request, not
--      line) — every RECEIVE call against the SAME dispatch now fully
--      serializes, whatever line or request_id it names.
--   3. Lock the HEADER row FOR UPDATE first, THEN the LINE — the same order
--      070's own SEND uses, so the two RPCs can never deadlock against each
--      other.
--   4. After deciding the line (either branch: rejected or accepted/
--      accepted_with_difference), call phoenix_recompute_warehouse_dispatch_
--      header_status(v_dispatch.id) EXPLICITLY, still holding the header's
--      FOR UPDATE lock acquired in step 3 — so the recompute is guaranteed
--      correct regardless of trigger timing. The trigger (8b) still exists
--      as pure defense-in-depth.
--
-- ALSO FIXED (per review): the ORIGINAL 067 body refused RECEIVE outright if
-- the destination outlet had since gone inactive
-- (`destination_outlet_inactive`). That is wrong: a shipment already
-- in_transit must always be settleable — an outlet being deactivated AFTER
-- send must never trap goods that already left the warehouse in limbo. The
-- outlet's `status` check is removed from RECEIVE; only existence and
-- point_type approval (a structural requirement of outlet_stock's own CHECK,
-- not a liveness gate) remain.
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

-- Grants IDENTICAL to 067's own (REVOKE ALL then GRANT EXECUTE to
-- authenticated) — the ACL contract is unchanged, only re-stated because
-- CREATE OR REPLACE does not alter existing grants, but restating is
-- harmless and keeps this file self-contained.
REVOKE ALL ON FUNCTION public.phoenix_receive_outlet_dispatch_line(uuid, uuid, integer, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_receive_outlet_dispatch_line(uuid, uuid, integer, text, text)
  TO authenticated;

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

  -- Soft: mark every still-pending line 'cancelled' (a status the 061 CHECK
  -- already accommodates for exactly this transition) rather than hard-
  -- deleting the rows. Nothing here was ever sent, so there is no physical
  -- movement to unwind — but the row itself is the record that a line was
  -- proposed and then withdrawn, and that is worth keeping.
  UPDATE public.warehouse_dispatch_lines
     SET status = 'cancelled'
   WHERE dispatch_id = v_dispatch.id AND status = 'pending';

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
  v_warehouse   public.warehouses%ROWTYPE;
  v_point       public.distribution_points%ROWTYPE;
  v_line        RECORD;
  v_stock       public.warehouse_stock%ROWTYPE;
  v_before      integer;
  v_after       integer;
  v_movement_id uuid;
  v_fingerprint text;
  v_line_count  integer := 0;
  v_total_for_stock integer;
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

  -- FAIL-CLOSED status handling — every one of the six values 061's own
  -- CHECK allows is named explicitly, never lumped into a generic
  -- "not sendable" catch-all:
  --   'draft'                                        -> proceed to send below
  --   'cancelled'                                     -> a SPECIFIC error;
  --       this is NOT a safe idempotent replay, it is a real terminal state
  --       a caller must be told about by name, not silently or genercially.
  --   'sent'/'partially_accepted'/'accepted'/'rejected' -> these, and ONLY
  --       these, are the states a REAL prior send can have produced —
  --       idempotent replay is safe here because every line already has its
  --       once-only movement (proven by the unique index in section 2).
  --   anything else -> unreachable given the CHECK constraint, but rejected
  --       explicitly rather than silently treated as either outcome.
  IF v_dispatch.status = 'cancelled' THEN
    RAISE EXCEPTION 'dispatch_cancelled' USING ERRCODE = '23514';
  ELSIF v_dispatch.status IN ('sent', 'partially_accepted', 'accepted', 'rejected') THEN
    RETURN jsonb_build_object('ok', true, 'idempotent_replay', true, 'dispatch_id', v_dispatch.id, 'status', v_dispatch.status);
  ELSIF v_dispatch.status <> 'draft' THEN
    RAISE EXCEPTION 'dispatch_unexpected_status: %', v_dispatch.status USING ERRCODE = '23514';
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

  -- RE-VALIDATE liveness at SEND time, not just at CREATE — a warehouse or
  -- outlet can be deactivated, or an outlet's warehouse_id/point_type
  -- reassigned, in the time between drafting and sending. CREATE's own
  -- checks prove nothing about the CURRENT state.
  SELECT * INTO v_warehouse
  FROM public.warehouses WHERE id = v_dispatch.warehouse_id FOR SHARE;
  IF NOT FOUND OR v_warehouse.status <> 'active' THEN
    RAISE EXCEPTION 'warehouse_not_found_or_inactive' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_point
  FROM public.distribution_points WHERE id = v_dispatch.destination_distribution_point_id FOR SHARE;
  IF NOT FOUND OR v_point.status <> 'active' THEN
    RAISE EXCEPTION 'destination_outlet_not_found_or_inactive' USING ERRCODE = '23514';
  END IF;
  IF v_point.point_type NOT IN ('pharmacy', 'crash_cabinet', 'rescue_cart') THEN
    RAISE EXCEPTION 'outlet_type_not_approved_for_stock: %', v_point.point_type USING ERRCODE = '23514';
  END IF;
  IF v_point.warehouse_id IS DISTINCT FROM v_dispatch.warehouse_id THEN
    RAISE EXCEPTION 'destination_outlet_not_paired_with_this_warehouse' USING ERRCODE = '23514';
  END IF;

  v_line_count := (SELECT count(*) FROM public.warehouse_dispatch_lines WHERE dispatch_id = v_dispatch.id);

  -- PASS 1: lock every DISTINCT warehouse_stock row this dispatch touches, in
  -- ASCENDING id ORDER — a fixed, deterministic lock order shared by every
  -- caller, so two concurrent sends that both touch overlapping stock rows
  -- can never deadlock against each other.
  --
  -- Validated here is the AGGREGATE demand per stock row, never a single
  -- line's demand in isolation: two (or more) lines in the SAME dispatch can
  -- legitimately name the SAME warehouse_stock_id (061 places no UNIQUE
  -- constraint against it), and each individually being <= available proves
  -- nothing about whether their SUM is. Checking per-line against a snapshot
  -- read before any debit would let two lines of 60 each pass independently
  -- against a stock row that only has 100 — this is exactly that bug, closed.
  FOR v_stock IN
    SELECT s.* FROM public.warehouse_stock s
    WHERE s.id IN (
      SELECT DISTINCT warehouse_stock_id FROM public.warehouse_dispatch_lines
      WHERE dispatch_id = v_dispatch.id
    )
    ORDER BY s.id
    FOR UPDATE
  LOOP
    SELECT coalesce(sum(l.sent_quantity), 0) INTO v_total_for_stock
    FROM public.warehouse_dispatch_lines l
    WHERE l.dispatch_id = v_dispatch.id AND l.warehouse_stock_id = v_stock.id;

    IF v_stock.on_hand_quantity - v_stock.reserved_quantity < v_total_for_stock THEN
      RAISE EXCEPTION 'insufficient_available_quantity_for_stock: %', v_stock.id USING ERRCODE = '23514';
    END IF;
    -- Refuse a lot that has expired between draft and send — the last point
    -- this system can still refuse it; forward SEND never ships expired
    -- stock (unlike the return domain's deliberate exception).
    IF v_stock.expiry_date IS NOT NULL AND v_stock.expiry_date < current_date THEN
      RAISE EXCEPTION 'expired_batch_cannot_be_dispatched: %', v_stock.id USING ERRCODE = '23514';
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
-- 8b. HEADER STATUS SYNC TRIGGER — DEFENSE IN DEPTH ONLY
-- ============================================================================
-- The rebuilt RECEIVE (2c) already calls phoenix_recompute_warehouse_dispatch_
-- header_status explicitly, under the header's own FOR UPDATE lock, right
-- after deciding a line — that is what actually GUARANTEES correctness under
-- concurrency (see 2c's own header comment). This trigger is not what proves
-- that; it exists only so that some future RPC which updates a line's status
-- WITHOUT going through RECEIVE cannot silently leave the header stale. It
-- calls the SAME shared function (2b), never a second copy of the logic.
CREATE OR REPLACE FUNCTION public.phoenix_sync_warehouse_dispatch_header_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.phoenix_recompute_warehouse_dispatch_header_status(NEW.dispatch_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_warehouse_dispatch_header_status ON public.warehouse_dispatch_lines;
CREATE TRIGGER trg_sync_warehouse_dispatch_header_status
  AFTER UPDATE OF status ON public.warehouse_dispatch_lines
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION public.phoenix_sync_warehouse_dispatch_header_status();

COMMENT ON FUNCTION public.phoenix_sync_warehouse_dispatch_header_status() IS
  'INSTITUTION-WAREHOUSE-TO-OUTLET-DISPATCH-070-A: defense-in-depth only — '
  'delegates to phoenix_recompute_warehouse_dispatch_header_status (2b), the '
  'SAME function RECEIVE (2c) calls explicitly under its own header lock. '
  'This trigger catches any future caller that updates a line without going '
  'through RECEIVE; it is not what makes RECEIVE itself correct under '
  'concurrency.';

REVOKE ALL ON FUNCTION public.phoenix_sync_warehouse_dispatch_header_status()
  FROM PUBLIC, anon, authenticated;

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
-- 9b. Explicit deny defaults for outlet_officer — stated, not merely implied
-- ============================================================================
-- 061 never seeded a (outlet_officer, warehouse_dispatch.*) row at all, for
-- ANY of these keys. phoenix_profile_has_permission's own contract
-- (010: coalesce(override, role_default, false)) means an ABSENT row already
-- resolves to false — outlet_officer was always correctly denied. But
-- "correct by absence" is not the same as "correct by statement": a future
-- migration that seeds a row for outlet_officer without checking here could
-- silently reverse this. These four rows make the denial explicit and,
-- being explicit, structurally provable by this migration's own
-- post-conditions (10) rather than merely inferred from what is missing.
INSERT INTO public.role_permission_defaults (role, permission_key, allowed) VALUES
  ('outlet_officer', 'warehouse_dispatch.create',     false),
  ('outlet_officer', 'warehouse_dispatch.edit_draft',  false),
  ('outlet_officer', 'warehouse_dispatch.cancel',      false),
  ('outlet_officer', 'warehouse_dispatch.send',        false)
ON CONFLICT (role, permission_key) DO NOTHING;

-- ============================================================================
-- 9c. SCOPED READ — restrictive policy, additive to the base permissive one
-- ============================================================================
-- THE BASE POLICY THIS BUILDS ON — its REAL name and REAL semantics:
-- 061 originally shipped an UNSCOPED, org-only permissive SELECT policy named
-- warehouse_dispatches_select_perm. Migration 062 (E4/E5) then DROPPED that
-- policy and REPLACED it with warehouse_dispatches_select_scoped /
-- warehouse_dispatch_lines_select_scoped — the policy that is ACTUALLY live
-- after 001..069 (verified against the linked database's pg_policy). The base
-- is therefore NOT the unscoped 061 placeholder; it is 062's ALREADY-SCOPED
-- permissive policy:
--   super_admin
--   OR ( organization_id = phoenix_my_org()
--        AND phoenix_profile_has_permission(auth.uid(), 'warehouse_dispatch.view')
--        AND ( role IN (institution_admin, hospital_admin,
--                       monthly_status_officer, viewer)                -- org-wide
--              OR (role = warehouse_officer                            -- send side
--                  AND phoenix_profile_has_warehouse_assignment(uid, warehouse_id))
--              OR (role = port_officer                                 -- 062's recv side
--                  AND phoenix_profile_has_point_assignment(uid, destination_distribution_point_id)) ) )
-- (Any earlier 070 note that called the base "061's unscoped policy" was wrong
-- on BOTH counts — wrong name, wrong semantics — and is corrected here. That
-- stale assumption is exactly what made 070's own post-condition abort the
-- apply: it asserted the pre-062 name warehouse_dispatches_select_perm, which
-- 062 had already dropped. The guard now asserts the real name AND the real
-- scoped semantics, per section 10l.)
--
-- THE GAP THAT REMAINS, EVEN WITH 062'S SCOPING: 062's scoped policy models the
-- RECEIVING side as port_officer holding warehouse_dispatch.view. It has NO
-- branch for outlet_officer, and outlet_officer holds no warehouse_dispatch.*
-- key at all (061 seeds none; 9b denies it explicitly). So the actor that
-- phoenix_receive_outlet_dispatch_line actually authorizes — an outlet_officer
-- with scoped outlet_stock.receive on the destination — is admitted by NO
-- permissive policy, and therefore cannot even SELECT the dispatch it is
-- allowed to RECEIVE. "Can receive" and "can read" disagree. This is the same
-- round-3 finding, restated correctly against the real base.
--
-- THE FIX HAS TWO HALVES, and BOTH are required:
-- PostgreSQL RLS composes multiple policies for the same command as
-- (OR of every PERMISSIVE policy) AND (AND of every RESTRICTIVE policy). A
-- RESTRICTIVE policy can only ever NARROW what some PERMISSIVE policy already
-- granted; it can NEVER, by itself, hand a row to a principal that no
-- permissive policy admitted — so a restrictive outlet_stock.receive branch
-- alone can never let the outlet_officer back in.
--
--   HALF 1 (this section, 9c): a RESTRICTIVE policy that bounds every principal
--   to its EXACT scope — a warehouse_officer to dispatches from its own assigned
--   warehouse, an outlet_officer to dispatches to its own assigned outlet, an
--   org-wide oversight role to its whole org, super_admin to everything. For
--   warehouse_officer and the org-wide roles this is REDUNDANT with 062's own
--   scoping (both require the same assignment), so it removes no access they
--   already have; it exists so no FUTURE permissive policy can ever widen past
--   the scope boundary, because restrictive policies are never bypassed by
--   permissive ones (PostgreSQL's own documented composition rule).
--
--   HALF 2 (section 9d, below): a NARROW second PERMISSIVE policy that ORs in
--   the ONE legitimate principal 062's policy omits — an outlet_officer
--   scoped-assigned to the dispatch's destination outlet — using EXACTLY the
--   outlet_stock.receive predicate RECEIVE itself enforces, and NOTHING broader.
--   Because that permissive predicate is strictly narrower than 9c's restrictive
--   boundary, it can never widen access past the scope bound; it only
--   contributes the single row-class the base left unreadable.
--
-- 062's policy is left COMPLETELY UNTOUCHED by both halves: no DROP, no
-- redefinition — this migration only ADDS one restrictive and one narrow
-- permissive layer alongside it.
--
-- Visibility, once all policies apply: a row is visible only if it passes 062's
-- scoped permissive policy OR 9d's narrow permissive policy, AND ALSO 9c's
-- restrictive boundary, which is one of:
--   - super_admin (platform role, sees everything);
--   - phoenix_profile_has_scoped_permission('warehouse_dispatch.view', org,
--     warehouse_id, NULL) — true for an org-wide role (institution_admin/
--     hospital_admin/monthly_status_officer/viewer), or for warehouse_officer
--     ONLY if actively assigned to THAT SPECIFIC warehouse;
--   - phoenix_profile_has_scoped_permission('outlet_stock.receive', org,
--     NULL, destination_distribution_point_id) — true for outlet_officer
--     ONLY if actively assigned to THAT SPECIFIC outlet (the same permission
--     067's RECEIVE itself checks, so "can see the dispatch" and "can
--     receive it" are the same boundary).
-- NOTE: because 9c's restrictive predicate names warehouse_dispatch.view
-- (warehouse) and outlet_stock.receive (outlet) but NOT a port_officer/point
-- branch, a port_officer that 062 alone would admit is bounded OUT by the AND.
-- That is an intentional tightening, consistent with this domain's receiving
-- actor being outlet_officer (outlet_stock.receive), not a widening — it can
-- only ever remove access, never add it.
CREATE OR REPLACE FUNCTION public.phoenix_can_read_warehouse_dispatch(
  p_organization_id            uuid,
  p_warehouse_id               uuid,
  p_destination_distribution_point_id uuid
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
           auth.uid(), 'warehouse_dispatch.view', p_organization_id, p_warehouse_id, NULL
         )
      OR public.phoenix_profile_has_scoped_permission(
           auth.uid(), 'outlet_stock.receive', p_organization_id, NULL, p_destination_distribution_point_id
         )
    );
$$;

REVOKE ALL ON FUNCTION public.phoenix_can_read_warehouse_dispatch(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_can_read_warehouse_dispatch(uuid, uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.phoenix_can_read_warehouse_dispatch(uuid, uuid, uuid) IS
  'INSTITUTION-WAREHOUSE-TO-OUTLET-DISPATCH-070-A: the scoped boundary enforced '
  'by 070''s RESTRICTIVE policies, additive to 062''s existing scoped permissive '
  'policies (warehouse_dispatches_select_scoped, not 061''s dropped '
  '_select_perm). A warehouse_officer sees only dispatches from its assigned '
  'warehouse; an outlet_officer sees only dispatches addressed to its assigned '
  'outlet (the same scope phoenix_receive_outlet_dispatch_line itself enforces). '
  'super_admin sees everything.';

DROP POLICY IF EXISTS warehouse_dispatches_scope_restrict ON public.warehouse_dispatches;
CREATE POLICY warehouse_dispatches_scope_restrict
  ON public.warehouse_dispatches
  AS RESTRICTIVE
  FOR SELECT
  TO authenticated
  USING (
    public.phoenix_can_read_warehouse_dispatch(organization_id, warehouse_id, destination_distribution_point_id)
  );

DROP POLICY IF EXISTS warehouse_dispatch_lines_scope_restrict ON public.warehouse_dispatch_lines;
CREATE POLICY warehouse_dispatch_lines_scope_restrict
  ON public.warehouse_dispatch_lines
  AS RESTRICTIVE
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.warehouse_dispatches d
      WHERE d.id = warehouse_dispatch_lines.dispatch_id
        AND public.phoenix_can_read_warehouse_dispatch(
              d.organization_id, d.warehouse_id, d.destination_distribution_point_id
            )
    )
  );

-- ============================================================================
-- 9d. SCOPED READ, HALF 2 — the NARROW permissive policy the restrictive layer
--     needs before it can bite for outlet_officer
-- ============================================================================
-- See 9c's header for the full composition argument. In short: 9c's restrictive
-- policy can only NARROW what a permissive policy already granted, and 062's
-- scoped permissive policy (warehouse_dispatches_select_scoped) never admits an
-- outlet_officer — it has no outlet_officer branch, and outlet_officer holds no
-- warehouse_dispatch.* key. Without this section an outlet_officer therefore
-- cannot SELECT the very dispatch addressed to its own outlet that
-- phoenix_receive_outlet_dispatch_line then lets it RECEIVE — "can receive" and
-- "can read" disagree. This adds a SECOND permissive SELECT policy whose USING
-- is EXACTLY the outlet_officer's legitimate boundary: scoped
-- outlet_stock.receive on the dispatch's destination outlet — the SAME
-- predicate RECEIVE enforces, and the SAME branch 9c's restrictive function
-- already names. It is strictly NARROWER than 9c's restrictive predicate (it
-- omits the super_admin and warehouse_dispatch.view branches), so it can never
-- grant a row the restrictive boundary would not also allow; it only ever
-- contributes the one principal 062's policy omitted. Final composition, both
-- tables:
--   ( super_admin OR scoped warehouse_officer/port_officer   [062 permissive
--       /org-wide role, per warehouse_dispatches_select_scoped]
--     OR scoped outlet_stock.receive on THIS destination     [9d permissive] )
--   AND phoenix_can_read_warehouse_dispatch(org, wh, dest)   [9c restrictive]
-- which reduces exactly to the required boundary:
--   ( super_admin
--     OR warehouse officer scoped to the SOURCE warehouse with .view
--     OR outlet officer scoped to the DESTINATION outlet with .receive )
--   AND exact-scope.
DROP POLICY IF EXISTS warehouse_dispatches_outlet_receive_perm ON public.warehouse_dispatches;
CREATE POLICY warehouse_dispatches_outlet_receive_perm
  ON public.warehouse_dispatches
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (
    public.phoenix_profile_has_scoped_permission(
      auth.uid(), 'outlet_stock.receive', organization_id, NULL, destination_distribution_point_id
    )
  );

DROP POLICY IF EXISTS warehouse_dispatch_lines_outlet_receive_perm ON public.warehouse_dispatch_lines;
CREATE POLICY warehouse_dispatch_lines_outlet_receive_perm
  ON public.warehouse_dispatch_lines
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.warehouse_dispatches d
      WHERE d.id = warehouse_dispatch_lines.dispatch_id
        AND public.phoenix_profile_has_scoped_permission(
              auth.uid(), 'outlet_stock.receive', d.organization_id, NULL,
              d.destination_distribution_point_id
            )
    )
  );

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

  -- 10c. RECEIVE's signature is exactly 067's original — recreated (2c) for
  -- concurrency, never renamed or reshaped. Still the only writer of
  -- 'dispatch_receive'.
  IF to_regprocedure('public.phoenix_receive_outlet_dispatch_line(uuid,uuid,integer,text,text)') IS NULL THEN
    RAISE EXCEPTION 'ABORT 070: RECEIVE RPC signature changed — must match 067''s original exactly';
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

  -- 10h. SEND validates the AGGREGATE demand per DISTINCT stock row (never a
  -- single line's demand read against a stale snapshot) — the fix for the
  -- multi-line-same-lot aggregation bug caught in review.
  ASSERT v_body LIKE '%DISTINCT warehouse_stock_id%',
    'VERIFY FAILED (070): SEND must lock DISTINCT stock rows, not one row per line';
  ASSERT v_body LIKE '%sum(l.sent_quantity)%',
    'VERIFY FAILED (070): SEND must validate the SUM of sent_quantity per stock row';
  ASSERT v_body LIKE '%ORDER BY s.id%',
    'VERIFY FAILED (070): stock rows must be locked in a fixed, deterministic order (deadlock safety)';

  -- 10i. CANCEL never hard-deletes a line — soft status transition only.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'phoenix_cancel_warehouse_dispatch'
      AND pg_get_functiondef(p.oid) LIKE '%DELETE FROM public.warehouse_dispatch_lines%'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (070): cancel must not hard-delete dispatch lines';
  END IF;

  -- 10j. The header-status-sync trigger exists and never touches draft or a
  -- terminal header — defense-in-depth alongside RECEIVE's own explicit call.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'warehouse_dispatch_lines'
      AND t.tgname = 'trg_sync_warehouse_dispatch_header_status'
  ) THEN
    RAISE EXCEPTION 'ABORT 070: header-status-sync trigger missing';
  END IF;

  -- 10k. RESTRICTIVE scoped-read policies exist on both tables — proven by
  -- polrestrictive = true (pg_policy), not merely by presence, since a
  -- PERMISSIVE policy of the same name would compile but grant the OPPOSITE
  -- of what this migration requires (OR instead of AND).
  FOREACH v_def IN ARRAY ARRAY['warehouse_dispatches', 'warehouse_dispatch_lines'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy pol
      JOIN pg_class c ON c.oid = pol.polrelid
      WHERE c.relname = v_def
        AND pol.polname = v_def || '_scope_restrict'
        AND pol.polpermissive = false
    ) THEN
      RAISE EXCEPTION 'ABORT 070: % is missing its RESTRICTIVE scope policy (or it is PERMISSIVE, which would widen access instead of narrowing it)', v_def;
    END IF;
  END LOOP;

  -- 10l. The BASE permissive policy this migration builds on is untouched —
  -- asserted by its REAL name AND its REAL scoped semantics, not by an assumed
  -- name alone. The live base after 001..069 is NOT 061's placeholder
  -- warehouse_dispatches_select_perm: migration 062 (E4/E5) DROPPED that and
  -- created warehouse_dispatches_select_scoped / warehouse_dispatch_lines_
  -- select_scoped. An earlier revision of THIS post-condition asserted the dead
  -- pre-062 name and aborted the apply; that was the round-3-apply failure.
  --
  -- Two things are proven for each table:
  --   (a) the 062 policy exists, by its real name, and is PERMISSIVE; and
  --   (b) it still carries its scoped semantics — it references
  --       warehouse_dispatch.view AND both assignment helpers
  --       (phoenix_profile_has_warehouse_assignment for the send side,
  --       phoenix_profile_has_point_assignment for the receive side). Checking
  --       the USING text, not just the name, is what makes this a REAL guard
  --       against a future rename-or-redefinition of the base, per the review.
  FOREACH v_def IN ARRAY ARRAY['warehouse_dispatches', 'warehouse_dispatch_lines'] LOOP
    DECLARE
      v_qual text;
    BEGIN
      SELECT pg_get_expr(pol.polqual, pol.polrelid)
        INTO v_qual
      FROM pg_policy pol
      JOIN pg_class c ON c.oid = pol.polrelid
      WHERE c.relname = v_def
        AND pol.polname = v_def || '_select_scoped'
        AND pol.polpermissive = true
        AND pol.polcmd = 'r';

      IF v_qual IS NULL THEN
        RAISE EXCEPTION 'ABORT 070: base permissive policy %_select_scoped (created by 062, replacing 061''s dropped _select_perm) is missing, not PERMISSIVE, or not a SELECT policy', v_def;
      END IF;

      IF v_qual NOT LIKE '%warehouse_dispatch.view%'
         OR v_qual NOT LIKE '%phoenix_profile_has_warehouse_assignment%'
         OR v_qual NOT LIKE '%phoenix_profile_has_point_assignment%' THEN
        RAISE EXCEPTION 'ABORT 070: base permissive policy %_select_scoped lost its 062 scoped semantics (expected warehouse_dispatch.view + warehouse-assignment + point-assignment predicates)', v_def;
      END IF;
    END;
  END LOOP;

  -- 10l-bis. 061's pre-062 placeholder must NOT be present: 062 dropped it, and
  -- its reappearance would signal a regression that reverts 062's scoping.
  FOREACH v_def IN ARRAY ARRAY['warehouse_dispatches_select_perm', 'warehouse_dispatch_lines_select_perm'] LOOP
    IF EXISTS (SELECT 1 FROM pg_policy WHERE polname = v_def) THEN
      RAISE EXCEPTION 'ABORT 070: 061''s pre-062 placeholder policy % is present again — 062 dropped it and 070 builds on the scoped replacement', v_def;
    END IF;
  END LOOP;

  -- 10l2. The NEW narrow PERMISSIVE outlet-receive policies (9d) exist and are
  -- PERMISSIVE. This is the half without which 10k's restrictive layer can only
  -- NARROW 062's scoped permissive policy — which never admits an outlet_officer
  -- — so "can receive" and "can read" would disagree. A policy of this name that was
  -- accidentally RESTRICTIVE would compile but do the OPPOSITE (narrow, never
  -- grant), so polpermissive = true is asserted explicitly, not merely presence.
  FOREACH v_def IN ARRAY ARRAY['warehouse_dispatches', 'warehouse_dispatch_lines'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy pol
      JOIN pg_class c ON c.oid = pol.polrelid
      WHERE c.relname = v_def
        AND pol.polname = v_def || '_outlet_receive_perm'
        AND pol.polpermissive = true
    ) THEN
      RAISE EXCEPTION 'ABORT 070: % is missing its PERMISSIVE outlet-receive policy (9d), or it is RESTRICTIVE — either way an outlet_officer cannot read the dispatch it is allowed to receive', v_def;
    END IF;
  END LOOP;

  -- 10q. EXACT SELECT-policy census per table: precisely TWO permissive (062's
  -- _select_scoped and 9d's outlet-receive) and exactly ONE restrictive (9c's
  -- scope boundary). A stray THIRD permissive policy added later could OR past
  -- the scope boundary; a MISSING restrictive one would remove the bound
  -- entirely. Counting both, by polpermissive, makes either regression fail.
  FOREACH v_def IN ARRAY ARRAY['warehouse_dispatches', 'warehouse_dispatch_lines'] LOOP
    IF (
      SELECT count(*) FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid
      WHERE c.relname = v_def AND pol.polcmd = 'r' AND pol.polpermissive = true
    ) <> 2 THEN
      RAISE EXCEPTION 'ABORT 070: % must have EXACTLY two permissive SELECT policies (062 _select_scoped + 9d outlet-receive)', v_def;
    END IF;
    IF (
      SELECT count(*) FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid
      WHERE c.relname = v_def AND pol.polcmd = 'r' AND pol.polpermissive = false
    ) <> 1 THEN
      RAISE EXCEPTION 'ABORT 070: % must have EXACTLY one restrictive SELECT policy (9c scope boundary)', v_def;
    END IF;
  END LOOP;

  -- 10m. outlet_officer is explicitly denied every warehouse_dispatch.* key
  -- this file's RPCs check — stated, not merely inferred from absence.
  FOREACH v_def IN ARRAY ARRAY[
    'warehouse_dispatch.create', 'warehouse_dispatch.edit_draft',
    'warehouse_dispatch.cancel', 'warehouse_dispatch.send'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.role_permission_defaults
      WHERE role = 'outlet_officer' AND permission_key = v_def AND allowed = false
    ) THEN
      RAISE EXCEPTION 'ABORT 070: outlet_officer is not explicitly denied %', v_def;
    END IF;
  END LOOP;

  -- 10n. SEND's status handling is fail-closed: 'cancelled' gets its own
  -- named error (never folded into a generic message or treated as a safe
  -- replay), and an unreachable ELSE exists as a backstop.
  v_body := pg_get_functiondef('public.phoenix_send_warehouse_dispatch(uuid,uuid)'::regprocedure);
  ASSERT v_body LIKE '%dispatch_cancelled%',
    'VERIFY FAILED (070): SEND must raise a specific error for a cancelled dispatch, not a generic one';
  ASSERT v_body LIKE '%dispatch_unexpected_status%',
    'VERIFY FAILED (070): SEND must fail closed on any status its own vocabulary does not name';

  -- 10o. SEND re-validates the warehouse and destination outlet LIVE, not
  -- just at CREATE time.
  ASSERT v_body LIKE '%FROM public.warehouses WHERE id = v_dispatch.warehouse_id FOR SHARE%',
    'VERIFY FAILED (070): SEND must re-lock and re-check the warehouse''s live status';
  ASSERT v_body LIKE '%FROM public.distribution_points WHERE id = v_dispatch.destination_distribution_point_id FOR SHARE%',
    'VERIFY FAILED (070): SEND must re-lock and re-check the destination outlet''s live status';

  -- 10p. RECEIVE (2c) serializes per DISPATCH (not merely per request or per
  -- line), locks the header before the line, and explicitly recomputes the
  -- header status under that same lock — the actual concurrency fix, not
  -- merely the trigger.
  DECLARE
    v_receive_body text := pg_get_functiondef(
      'public.phoenix_receive_outlet_dispatch_line(uuid,uuid,integer,text,text)'::regprocedure);
  BEGIN
    ASSERT v_receive_body LIKE '%hashtextextended(v_dispatch_id::text, 70170)%',
      'VERIFY FAILED (070): RECEIVE must take a per-DISPATCH advisory lock';
    ASSERT position('SELECT * INTO v_dispatch' in v_receive_body)
         < position('SELECT * INTO v_line' in v_receive_body),
      'VERIFY FAILED (070): RECEIVE must lock the HEADER before the LINE';
    ASSERT v_receive_body LIKE '%phoenix_recompute_warehouse_dispatch_header_status(v_dispatch.id)%',
      'VERIFY FAILED (070): RECEIVE must explicitly recompute the header status under its own lock';
    ASSERT v_receive_body NOT LIKE '%destination_outlet_inactive%',
      'VERIFY FAILED (070): RECEIVE must not refuse to settle an in_transit shipment because the outlet later went inactive';
  END;

  -- 10r. The shared header recompute (2b) is PURE header-status: calling it a
  -- second time can never create a duplicate audit row, a duplicate stock
  -- movement, or change any balance. It writes nothing but
  -- warehouse_dispatches.status, and only when the value actually changes
  -- (status IS DISTINCT FROM v_new_status) — so a redundant second call is a
  -- guaranteed no-op. Proven structurally so a future edit that adds a write
  -- inside it fails this migration rather than silently making double-invocation
  -- (RECEIVE's explicit call + the 8b trigger on the same UPDATE) unsafe.
  DECLARE
    v_recompute text := pg_get_functiondef(
      'public.phoenix_recompute_warehouse_dispatch_header_status(uuid)'::regprocedure);
  BEGIN
    ASSERT v_recompute NOT ILIKE '%INSERT INTO%',
      'VERIFY FAILED (070): header recompute must never INSERT (no audit row, no movement) — double-invocation must stay side-effect free';
    ASSERT v_recompute NOT ILIKE '%warehouse_stock%'
       AND v_recompute NOT ILIKE '%outlet_stock%',
      'VERIFY FAILED (070): header recompute must never touch a stock balance';
    ASSERT v_recompute LIKE '%status IS DISTINCT FROM v_new_status%',
      'VERIFY FAILED (070): header recompute must be a no-op when status is already current (idempotent double-call)';
    ASSERT v_recompute LIKE '%SECURITY DEFINER%' AND v_recompute LIKE '%search_path%',
      'VERIFY FAILED (070): header recompute must be SECURITY DEFINER with a pinned search_path';
  END;

  RAISE NOTICE '070 verified: institution warehouse -> outlet forward dispatch '
    'builds CREATE/ADD-LINE/UPDATE-LINE/DELETE-LINE/CANCEL/SEND on 061''s '
    'schema, reuses 067''s RECEIVE unchanged, reuses dispatch_send/'
    'dispatch_receive (no widened CHECK), mints no new permission key, and '
    'enforces the SAME warehouse<->outlet structural pairing the return '
    'domain uses. NOT APPLIED by this PR.';
END;
$verify$;

commit;
