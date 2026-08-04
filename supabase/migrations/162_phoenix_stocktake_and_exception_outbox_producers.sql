-- ============================================================================
-- STOCKTAKE-AND-EXCEPTION-OUTBOX-PRODUCERS-162
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply after 161.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SCOPE — D2-4, THE THIRD AND FOURTH OUTBOX PRODUCERS
-- ─────────────────────────────────────────────────────────────────────────────
-- This migration redefines exactly two existing functions:
--   1. public.phoenix_capture_stocktake_recorded() (123) — a trigger, extended
--      the same way 159/161 extended their own trigger functions: one
--      additive PERFORM after the existing phoenix_movement_events write
--      succeeds, before RETURN NEW. No new trigger.
--   2. public.phoenix_resolve_outlet_return_exception(...) (157) — the sole
--      SECURITY DEFINER writer into phoenix_outlet_return_exception_
--      resolutions. A read-only audit against the live 001->161 replay
--      confirmed zero triggers exist on that table and no other function
--      references it — there is no existing trigger to extend, and adding a
--      new one would be strictly more architectural surface than extending
--      the one confirmed-sole writer directly. Two additive PERFORM calls
--      (one per resolution_kind branch), each placed immediately after that
--      branch's existing resolution-row INSERT, before that branch's own
--      RETURN. No new trigger on phoenix_outlet_return_exception_resolutions.
--
-- Neither change touches a business RPC's validation, locking, permission
-- check, stock/quarantine mutation, compensating-movement creation,
-- dispatch-line update, audit logging, return value, exception text/SQLSTATE,
-- or transaction semantics. Neither touches RLS, RBAC, reports, frontend
-- code, or the Outbox table's own structure/RLS/grants (158, untouched).
-- Migrations 159 (lifecycle) and 161 (movement) are completely unchanged —
-- re-verified in-transaction below.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- STOCKTAKE — WHY THIS IS THE CANONICAL PRODUCER
-- ─────────────────────────────────────────────────────────────────────────────
-- phoenix_capture_stocktake_recorded() is the ONLY non-internal trigger
-- writing to phoenix_movement_events for stocktakes (confirmed: the only
-- three writers into phoenix_movement_events are phoenix_capture_movement_
-- posted, phoenix_capture_lifecycle_event, phoenix_capture_stocktake_
-- recorded). stocktakes also carries phoenix_capture_movement_notification,
-- unconditionally, but that function has never written to phoenix_movement_
-- events at all (159/161's own audit finding, re-confirmed here) — it writes
-- only to phoenix_notifications, so there is zero double-emission risk from
-- wiring only phoenix_capture_stocktake_recorded. phoenix_status_record_
-- stocktake is the sole writer RPC into stocktakes.
--
-- The existing sink's occurred_at has always used now() at INSERT time
-- (never NEW.performed_at, unlike 124's later refinement for the movement
-- tables) — this migration deliberately preserves that exact pre-existing
-- behavior rather than silently correcting it. One timestamp variable is
-- resolved once and reused for both the existing sink and the new Outbox
-- payload, so the two can never observe two different clock reads for the
-- same trigger firing.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- STOCKTAKE EVENT IDENTITY — REUSING, NOT INVENTING
-- ─────────────────────────────────────────────────────────────────────────────
--   event_key       = 'stocktake:' || NEW.id::text || ':recorded' — the
--                      'stocktake:' namespace prefix ahead of the exact
--                      pre-existing dedupe_key expression, distinct from
--                      159's 'lifecycle:' and 161's 'movement:'.
--   event_type      = 'stocktakes.recorded' — byte-identical to the existing
--                      literal event_type already written to phoenix_
--                      movement_events (this producer represents exactly one
--                      accepted state, unlike movement's dynamic '.posted').
--   event_version   = 1.
--   aggregate_type  = TG_TABLE_NAME ('stocktakes').
--   aggregate_id    = NEW.id.
--   organization_id = NEW.organization_id — the exact same value the
--                      existing INSERT already uses.
--   actor_id        = NEW.performed_by — the exact same value already used.
--   correlation_id  = NULL. stocktakes carries no correlation_id column at
--                      all — there is nothing already resolved to reuse.
--   causation_id    = NULL, for the identical reason.
--   request_id      = NULL, for the identical reason (no request-id-shaped
--                      column exists on stocktakes).
--
-- Payload — {source_table, scope_kind, scope_id, trace_id, reference_id,
-- occurred_at} only. scope_kind/scope_id are read directly off NEW, no new
-- query. No notes/free text (NEW.notes is never included).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- EXCEPTION RESOLUTION — WHY THIS IS THE CANONICAL PRODUCER, AND THE OWNER'S
-- DUAL-EVENT DECISION FOR corrected_receipt
-- ─────────────────────────────────────────────────────────────────────────────
-- phoenix_outlet_return_exception_resolutions carries a request_id UNIQUE
-- constraint and a return_shipment_line_id UNIQUE constraint, enforcing
-- at-most-one-resolution-per-line and idempotent replay via the RPC's own
-- pre-existing payload_fingerprint conflict check (advisory lock salt
-- 157157) — the authoritative fact is the resolution-ROW INSERT itself,
-- exactly once per accepted request_id.
--
-- For resolution_kind = 'corrected_receipt', this same RPC also INSERTs into
-- warehouse_stock_movements or warehouse_quarantine_stock_movements, which
-- ALREADY fires 161's phoenix_capture_movement_posted() today — independent
-- of this migration, already live. This migration adds a SECOND, DIFFERENT-
-- aggregate Outbox event for the resolution-decision fact itself
-- (aggregate_type = phoenix_outlet_return_exception_resolutions), never the
-- same aggregate_type/aggregate_id/event_key as the movement:-namespaced
-- event. Owner-approved: a single corrected_receipt action intentionally
-- produces two distinct committed-fact Outbox events, the same multi-
-- aggregate shape 159 (header transition) and 161 (ledger fact) already
-- coexist under elsewhere in this system — not duplicate emission of one
-- fact. For confirmed_no_stock, only this new event fires (no stock
-- movement is ever created on that path).
--
-- event_type is one FIXED literal, 'phoenix_outlet_return_exception_
-- resolutions.resolved', regardless of resolution_kind — resolution_kind is
-- carried in the payload instead, per owner decision.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- EXCEPTION RESOLUTION EVENT IDENTITY — REUSING, NOT INVENTING
-- ─────────────────────────────────────────────────────────────────────────────
--   event_key       = 'outlet-return-exception-resolution:' ||
--                      p_request_id::text — reuses the RPC's own genuine,
--                      already-unique, already-idempotency-governing
--                      request identity. Per owner decision, deliberately
--                      NOT the broader 'exception:' namespace.
--   event_type      = 'phoenix_outlet_return_exception_resolutions.resolved'
--                      (fixed, per owner decision).
--   event_version   = 1.
--   aggregate_type  = 'phoenix_outlet_return_exception_resolutions'.
--   aggregate_id    = the newly inserted resolution row's own id, captured
--                      via RETURNING id, resolved_at INTO ... added to both
--                      existing INSERT statements — no other column, value,
--                      lock, fingerprint, result, or business side effect in
--                      either statement is changed.
--   organization_id = v_shipment.destination_organization_id — the exact
--                      same value the existing INSERT already uses, resolved
--                      server-side from the line's parent shipment, never
--                      caller-supplied.
--   actor_id        = v_actor — the exact same auth.uid() already resolved.
--   correlation_id  = v_correlation_id — the RPC's own pre-existing fresh
--                      root correlation id (already generated for its own
--                      compensating-movement chain) reused here, never a
--                      second value manufactured for this call alone.
--   causation_id    = NULL, matching the RPC's own explicit no-causation
--                      posture.
--   request_id      = p_request_id — the first D2 outbox producer with a
--                      genuine, already-available, caller-supplied UUID
--                      request identity (159/161 both had none).
--
-- Payload — {resolution_kind, return_shipment_line_id, disposition,
-- corrected_quantity, trace_id, reference_id, occurred_at} only, null-
-- stripped. occurred_at is the RETURNING-captured resolved_at, not now().
-- reason (free text) is deliberately EXCLUDED, per owner decision, along
-- with organization name, actor name/role, patient data, authorization
-- claims, secrets, and any full row dump.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- IDEMPOTENCY — NO NEW MECHANISM REQUIRED
-- ─────────────────────────────────────────────────────────────────────────────
-- A replay with the same p_request_id and a matching existing fingerprint
-- returns early via the RPC's own pre-existing `RETURN v_existing.result;`
-- path, before either INSERT/PERFORM site is ever reached — no second
-- resolution row, no second Outbox event, by construction, not by any new
-- logic added here. A replay with the same p_request_id and a DIFFERENT
-- fingerprint raises the RPC's own pre-existing 'request_id_conflict'
-- (23505) at the same point, for the same reason, before either
-- INSERT/PERFORM site — no Outbox event either. The Outbox helper's own
-- independent event_key-fingerprint rule (158) is unchanged and still
-- applies underneath both of the above.
-- ============================================================================

BEGIN;

-- ── PRECONDITIONS ───────────────────────────────────────────────────────────

DO $precond$
DECLARE
  v_stocktake_trigger_count int;
  v_fn_src_before text;
BEGIN
  IF to_regclass('public.phoenix_outbox_events') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: phoenix_outbox_events is missing — apply 158 first';
  END IF;
  IF to_regprocedure('public.phoenix_append_outbox_event_internal(text,text,smallint,text,uuid,uuid,jsonb,uuid,uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: phoenix_append_outbox_event_internal is missing — apply 158 first';
  END IF;
  IF (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.relname = 'phoenix_outbox_events')
     IS DISTINCT FROM
     (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.proname = 'phoenix_append_outbox_event_internal') THEN
    RAISE EXCEPTION 'precondition failed: phoenix_outbox_events and phoenix_append_outbox_event_internal must share the same trusted owner';
  END IF;

  -- Stocktake producer.
  IF to_regprocedure('public.phoenix_capture_stocktake_recorded()') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: phoenix_capture_stocktake_recorded() is missing — apply 123 first';
  END IF;
  SELECT pg_get_functiondef(oid) INTO v_fn_src_before
    FROM pg_proc WHERE proname = 'phoenix_capture_stocktake_recorded';
  IF v_fn_src_before LIKE '%phoenix_outbox_events%' OR v_fn_src_before LIKE '%phoenix_append_outbox_event_internal%' THEN
    RAISE EXCEPTION 'precondition failed: phoenix_capture_stocktake_recorded() already references the outbox (162 already applied?)';
  END IF;
  SELECT count(*) INTO v_stocktake_trigger_count
  FROM pg_trigger t
  JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE p.proname = 'phoenix_capture_stocktake_recorded' AND NOT t.tgisinternal;
  IF v_stocktake_trigger_count <> 1 THEN
    RAISE EXCEPTION 'precondition failed: expected exactly 1 phoenix_capture_stocktake_recorded attachment, found %', v_stocktake_trigger_count;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE p.proname = 'phoenix_capture_stocktake_recorded' AND c.relname = 'stocktakes' AND NOT t.tgisinternal
      AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 0 AND (t.tgtype & 4) = 4
  ) THEN
    RAISE EXCEPTION 'precondition failed: phoenix_capture_stocktake_recorded must be a row-level AFTER INSERT trigger on stocktakes';
  END IF;

  -- Exception-resolution producer.
  IF to_regprocedure('public.phoenix_resolve_outlet_return_exception(uuid,uuid,text,text,integer,text)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: phoenix_resolve_outlet_return_exception(...) is missing — apply 157 first';
  END IF;
  SELECT pg_get_functiondef(oid) INTO v_fn_src_before
    FROM pg_proc WHERE proname = 'phoenix_resolve_outlet_return_exception';
  IF v_fn_src_before LIKE '%phoenix_outbox_events%' OR v_fn_src_before LIKE '%phoenix_append_outbox_event_internal%' THEN
    RAISE EXCEPTION 'precondition failed: phoenix_resolve_outlet_return_exception(...) already references the outbox (162 already applied?)';
  END IF;
  IF to_regclass('public.phoenix_outlet_return_exception_resolutions') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: phoenix_outlet_return_exception_resolutions is missing — apply 157 first';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'public.phoenix_outlet_return_exception_resolutions'::regclass
      AND contype = 'u' AND conname = 'phoenix_outlet_return_exception_resolutions_request_id_key'
  ) THEN
    RAISE EXCEPTION 'precondition failed: phoenix_outlet_return_exception_resolutions.request_id must remain UNIQUE';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'public.phoenix_outlet_return_exception_resolutions'::regclass
      AND contype = 'u' AND conname = 'phoenix_outlet_return_exception_res_return_shipment_line_id_key'
  ) THEN
    RAISE EXCEPTION 'precondition failed: phoenix_outlet_return_exception_resolutions.return_shipment_line_id must remain UNIQUE';
  END IF;
  IF has_table_privilege('authenticated', 'public.phoenix_outlet_return_exception_resolutions', 'INSERT') THEN
    RAISE EXCEPTION 'precondition failed: authenticated must not have direct INSERT on phoenix_outlet_return_exception_resolutions (the RPC must remain the sole writer)';
  END IF;
  IF has_table_privilege('anon', 'public.phoenix_outlet_return_exception_resolutions', 'INSERT') THEN
    RAISE EXCEPTION 'precondition failed: anon must not have direct INSERT on phoenix_outlet_return_exception_resolutions';
  END IF;

  -- 158's lockdown, and 159/161's presence, must still hold.
  IF has_table_privilege('authenticated', 'public.phoenix_outbox_events', 'SELECT') THEN
    RAISE EXCEPTION 'precondition failed: 158''s privilege lockdown on phoenix_outbox_events no longer holds';
  END IF;
  IF has_function_privilege('authenticated', 'public.phoenix_append_outbox_event_internal(text,text,smallint,text,uuid,uuid,jsonb,uuid,uuid,uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'precondition failed: 158''s privilege lockdown on the append helper no longer holds';
  END IF;
  IF to_regprocedure('public.phoenix_capture_lifecycle_event()') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: phoenix_capture_lifecycle_event() is missing — apply 159 first';
  END IF;
  IF to_regprocedure('public.phoenix_capture_movement_posted()') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: phoenix_capture_movement_posted() is missing — apply 161 first';
  END IF;
END;
$precond$;

-- ── Stocktake capture function — same signature, one additive call ─────────

CREATE OR REPLACE FUNCTION public.phoenix_capture_stocktake_recorded()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $capture$
DECLARE
  v_role text;
  v_name text;
  v_occurred timestamptz := now();
BEGIN
  IF NEW.performed_by IS NOT NULL THEN
    SELECT p.role, p.full_name INTO v_role, v_name
      FROM public.profiles p WHERE p.id = NEW.performed_by;
  END IF;

  INSERT INTO public.phoenix_movement_events (
    organization_id, trace_id, event_type, occurred_at,
    actor_id, actor_role, actor_name,
    status_after, reference_type, reference_id, notes,
    dedupe_key
  )
  VALUES (
    NEW.organization_id,
    NEW.id,
    'stocktakes.recorded',
    v_occurred,
    NEW.performed_by, v_role, v_name,
    'recorded',
    'stocktakes',
    NEW.id,
    NEW.notes,
    NEW.id::text || ':recorded'
  )
  ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;

  -- ── 162: the third outbox producer ──────────────────────────────────────
  -- Fires only after the existing sink write above has succeeded, reusing
  -- every value this function already resolves (v_occurred is now resolved
  -- once, above, and reused by both this call and the existing sink INSERT,
  -- rather than each computing its own independent now()). If this call
  -- raises, the exception propagates and rolls back this entire trigger's
  -- transaction, exactly like any other unhandled exception here always has.
  PERFORM public.phoenix_append_outbox_event_internal(
    'stocktake:' || NEW.id::text || ':recorded',
    'stocktakes.recorded',
    1::smallint,
    TG_TABLE_NAME,
    NEW.id,
    NEW.organization_id,
    jsonb_strip_nulls(jsonb_build_object(
      'source_table', TG_TABLE_NAME,
      'scope_kind', NEW.scope_kind,
      'scope_id', NEW.scope_id,
      'trace_id', NEW.id,
      'reference_id', NEW.id,
      'occurred_at', v_occurred
    )),
    NEW.performed_by,
    NULL::uuid,
    NULL::uuid,
    NULL::uuid
  );

  RETURN NEW;
END;
$capture$;

-- ── Exception-resolution RPC — same signature, same business logic, two ────
-- ── additive RETURNING captures and two additive PERFORM calls ─────────────

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
      AND q.scientific_name = v_line.scientific_name
      AND COALESCE(q.concentration, '') = COALESCE(v_line.concentration, '')
      AND COALESCE(q.dosage_form, '')   = COALESCE(v_line.dosage_form, '')
      AND COALESCE(q.national_code, '') = COALESCE(v_line.national_code, '')
      AND COALESCE(q.batch_number, '')  = COALESCE(v_line.batch_number, '')
      AND COALESCE(q.expiry_date, DATE '0001-01-01')
          = COALESCE(v_line.expiry_date, DATE '0001-01-01')
      AND COALESCE(q.internal_batch_reference, '') = COALESCE(v_internal, '')
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

-- =============================================================================
-- VERIFY — inside the transaction; failure rolls back all of 162
-- =============================================================================

DO $$
DECLARE
  v_fn_src        text;
  v_call_count    int;
  v_trigger_count int;
  v_other_fn_src  text;
  v_lifecycle_call_count int;
  v_movement_call_count  int;
BEGIN
  -- ── 1. STOCKTAKE ──────────────────────────────────────────────────────────
  ASSERT to_regprocedure('public.phoenix_capture_stocktake_recorded()') IS NOT NULL,
    'phoenix_capture_stocktake_recorded() must still exist';

  SELECT pg_get_functiondef(oid) INTO v_fn_src
    FROM pg_proc WHERE proname = 'phoenix_capture_stocktake_recorded';

  ASSERT (SELECT prosecdef FROM pg_proc WHERE proname = 'phoenix_capture_stocktake_recorded'),
    'phoenix_capture_stocktake_recorded must remain SECURITY DEFINER';
  ASSERT (
    SELECT proconfig @> ARRAY['search_path=public, pg_temp']::text[]
      FROM pg_proc WHERE proname = 'phoenix_capture_stocktake_recorded'
  ), 'phoenix_capture_stocktake_recorded must keep search_path pinned to public, pg_temp';

  v_call_count := (LENGTH(v_fn_src) - LENGTH(REPLACE(v_fn_src, 'phoenix_append_outbox_event_internal', ''))) / LENGTH('phoenix_append_outbox_event_internal');
  ASSERT v_call_count = 1,
    format('expected exactly one reference to phoenix_append_outbox_event_internal in phoenix_capture_stocktake_recorded, found %s', v_call_count);

  SELECT count(*) INTO v_trigger_count
  FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE p.proname = 'phoenix_capture_stocktake_recorded' AND NOT t.tgisinternal;
  ASSERT v_trigger_count = 1,
    format('expected exactly 1 phoenix_capture_stocktake_recorded attachment after 162, found %s', v_trigger_count);
  ASSERT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE p.proname = 'phoenix_capture_stocktake_recorded' AND c.relname = 'stocktakes' AND NOT t.tgisinternal
      AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 0 AND (t.tgtype & 4) = 4
  ), 'stocktakes must still carry a row-level AFTER INSERT phoenix_capture_stocktake_recorded trigger';

  ASSERT position('''stocktake:'' || NEW.id::text || '':recorded''' IN v_fn_src) > 0,
    'the exact stocktake event-key expression must be present';
  ASSERT position('''stocktakes.recorded''' IN v_fn_src) > 0,
    'the fixed stocktake event_type literal must be present';
  ASSERT (
    position('''source_table'', TG_TABLE_NAME' IN v_fn_src) > 0
    AND position('''scope_kind'', NEW.scope_kind' IN v_fn_src) > 0
    AND position('''scope_id'', NEW.scope_id' IN v_fn_src) > 0
    AND position('''trace_id'', NEW.id' IN v_fn_src) > 0
    AND position('''reference_id'', NEW.id' IN v_fn_src) > 0
    AND position('''occurred_at'', v_occurred' IN v_fn_src) > 0
  ), 'the exact six-field stocktake payload must be present';
  ASSERT lower(v_fn_src) !~ 'insert[[:space:]]+into[[:space:]]+(public[.])?phoenix_outbox_events',
    'phoenix_capture_stocktake_recorded must never INSERT into phoenix_outbox_events directly';

  -- ── 2. EXCEPTION RESOLUTION ───────────────────────────────────────────────
  ASSERT to_regprocedure('public.phoenix_resolve_outlet_return_exception(uuid,uuid,text,text,integer,text)') IS NOT NULL,
    'phoenix_resolve_outlet_return_exception(...) must still exist with its exact signature';

  SELECT pg_get_functiondef(oid) INTO v_fn_src
    FROM pg_proc WHERE proname = 'phoenix_resolve_outlet_return_exception';

  ASSERT (SELECT prosecdef FROM pg_proc WHERE proname = 'phoenix_resolve_outlet_return_exception'),
    'phoenix_resolve_outlet_return_exception must remain SECURITY DEFINER';
  ASSERT (
    SELECT proconfig @> ARRAY['search_path=public, pg_temp']::text[]
      FROM pg_proc WHERE proname = 'phoenix_resolve_outlet_return_exception'
  ), 'phoenix_resolve_outlet_return_exception must keep search_path pinned to public, pg_temp';

  v_call_count := (LENGTH(v_fn_src) - LENGTH(REPLACE(v_fn_src, 'phoenix_append_outbox_event_internal', ''))) / LENGTH('phoenix_append_outbox_event_internal');
  ASSERT v_call_count = 2,
    format('expected exactly two branch-local references to phoenix_append_outbox_event_internal in phoenix_resolve_outlet_return_exception, found %s', v_call_count);

  ASSERT (
    SELECT (LENGTH(v_fn_src) - LENGTH(REPLACE(v_fn_src, '''outlet-return-exception-resolution:'' || p_request_id::text', ''))) / LENGTH('''outlet-return-exception-resolution:'' || p_request_id::text')
  ) = 2, 'both call sites must use the exact outlet-return-exception-resolution: namespace with p_request_id';
  ASSERT (
    SELECT (LENGTH(v_fn_src) - LENGTH(REPLACE(v_fn_src, '''phoenix_outlet_return_exception_resolutions.resolved''', ''))) / LENGTH('''phoenix_outlet_return_exception_resolutions.resolved''')
  ) = 2, 'both call sites must use the exact fixed event_type literal';
  ASSERT (
    SELECT (LENGTH(v_fn_src) - LENGTH(REPLACE(v_fn_src, 'v_correlation_id,', ''))) / LENGTH('v_correlation_id,')
  ) >= 2, 'both call sites must pass v_correlation_id';
  ASSERT (
    SELECT (LENGTH(v_fn_src) - LENGTH(REPLACE(v_fn_src, 'NULL::uuid,', ''))) / LENGTH('NULL::uuid,')
  ) = 2, 'both call sites must pass a NULL::uuid causation_id argument (this function uses NULL::uuid nowhere else)';
  ASSERT (
    SELECT (LENGTH(v_fn_src) - LENGTH(REPLACE(v_fn_src, 'p_request_id' || chr(10), ''))) / LENGTH('p_request_id' || chr(10))
  ) >= 2, 'both call sites must pass p_request_id as the final (request_id) argument';
  -- These four fields also legitimately appear in pre-existing 157 code that
  -- this migration preserves verbatim (the request-fingerprint computation
  -- reuses 'resolution_kind'/'corrected_quantity'; the RPC's own caller-facing
  -- RETURN value reuses 'return_shipment_line_id'/'disposition'; one
  -- audit_logs payload also reuses 'disposition') — so the expected totals
  -- below are each (pre-existing baseline + 2 new outbox-payload sites), not
  -- a bare 2. Exact per-branch ordering is proven by the static test instead.
  ASSERT (
    SELECT (LENGTH(v_fn_src) - LENGTH(REPLACE(v_fn_src, '''resolution_kind'', p_resolution_kind', ''))) / LENGTH('''resolution_kind'', p_resolution_kind')
  ) = 3, 'both payloads must include resolution_kind (2 new + 1 pre-existing fingerprint reference)';
  ASSERT (
    SELECT (LENGTH(v_fn_src) - LENGTH(REPLACE(v_fn_src, '''return_shipment_line_id'', v_line.id,', ''))) / LENGTH('''return_shipment_line_id'', v_line.id,')
  ) = 4, 'both payloads must include return_shipment_line_id (2 new + 2 pre-existing RETURN-value references)';
  ASSERT (
    SELECT (LENGTH(v_fn_src) - LENGTH(REPLACE(v_fn_src, '''disposition'', p_disposition_decision,', ''))) / LENGTH('''disposition'', p_disposition_decision,')
  ) = 4, 'both payloads must include disposition (2 new + 2 pre-existing RETURN-value/audit_logs references)';
  ASSERT (
    SELECT (LENGTH(v_fn_src) - LENGTH(REPLACE(v_fn_src, '''corrected_quantity'', p_corrected_quantity,', ''))) / LENGTH('''corrected_quantity'', p_corrected_quantity,')
  ) = 3, 'both payloads must include corrected_quantity (2 new + 1 pre-existing fingerprint reference)';
  ASSERT (
    SELECT (LENGTH(v_fn_src) - LENGTH(REPLACE(v_fn_src, '''trace_id'', v_new_resolution_id,', ''))) / LENGTH('''trace_id'', v_new_resolution_id,')
  ) = 2, 'both payloads must include trace_id';
  ASSERT (
    SELECT (LENGTH(v_fn_src) - LENGTH(REPLACE(v_fn_src, '''reference_id'', v_new_resolution_id,', ''))) / LENGTH('''reference_id'', v_new_resolution_id,')
  ) = 2, 'both payloads must include reference_id';
  ASSERT (
    SELECT (LENGTH(v_fn_src) - LENGTH(REPLACE(v_fn_src, '''occurred_at'', v_new_resolved_at', ''))) / LENGTH('''occurred_at'', v_new_resolved_at')
  ) = 2, 'both payloads must include occurred_at';
  -- Exact byte-level ordering of each payload's 7 keys, and the explicit
  -- absence of a 'reason' key inside either payload object specifically
  -- (v_reason/p_reason legitimately appear many times elsewhere in this
  -- pre-existing RPC — fingerprint computation, audit_logs payloads — so a
  -- whole-function "reason never appears" assertion would be wrong; only
  -- the two NEW payload objects must exclude it), is proven by the
  -- accompanying static test against this migration's own source text via
  -- simple, reliable per-call-site string slicing, not fragile SQL regex
  -- spanning hundreds of unrelated lines.
  ASSERT lower(v_fn_src) !~ 'insert[[:space:]]+into[[:space:]]+(public[.])?phoenix_outbox_events',
    'phoenix_resolve_outlet_return_exception must never INSERT into phoenix_outbox_events directly';
  ASSERT (
    SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.phoenix_outlet_return_exception_resolutions'::regclass AND NOT tgisinternal
  ) = 0, 'phoenix_outlet_return_exception_resolutions must carry no trigger of any kind';

  -- ── 3. PRESERVATION ────────────────────────────────────────────────────────
  SELECT pg_get_functiondef(oid) INTO v_other_fn_src
    FROM pg_proc WHERE proname = 'phoenix_capture_movement_posted';
  v_movement_call_count := (LENGTH(v_other_fn_src) - LENGTH(REPLACE(v_other_fn_src, 'phoenix_append_outbox_event_internal', ''))) / LENGTH('phoenix_append_outbox_event_internal');
  ASSERT v_movement_call_count = 1,
    format('161''s movement producer must still contain exactly one outbox-helper reference, found %s', v_movement_call_count);
  ASSERT (
    SELECT count(*) FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE p.proname = 'phoenix_capture_movement_posted' AND NOT t.tgisinternal
  ) = 3, '161''s 3 movement-posted trigger attachments must remain unchanged';

  SELECT pg_get_functiondef(oid) INTO v_other_fn_src
    FROM pg_proc WHERE proname = 'phoenix_capture_lifecycle_event';
  v_lifecycle_call_count := (LENGTH(v_other_fn_src) - LENGTH(REPLACE(v_other_fn_src, 'phoenix_append_outbox_event_internal', ''))) / LENGTH('phoenix_append_outbox_event_internal');
  ASSERT v_lifecycle_call_count = 1,
    format('159''s lifecycle producer must still contain exactly one outbox-helper reference, found %s', v_lifecycle_call_count);
  ASSERT (
    SELECT count(*) FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE p.proname = 'phoenix_capture_lifecycle_event' AND NOT t.tgisinternal
  ) = 11, '159''s 11 lifecycle trigger attachments must remain unchanged';

  SELECT pg_get_functiondef(oid) INTO v_other_fn_src
    FROM pg_proc WHERE proname = 'phoenix_capture_movement_notification';
  ASSERT v_other_fn_src NOT LIKE '%phoenix_outbox_events%' AND v_other_fn_src NOT LIKE '%phoenix_append_outbox_event_internal%',
    'phoenix_capture_movement_notification must remain unwired from the outbox';

  ASSERT (
    SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.phoenix_outbox_events'::regclass AND NOT tgisinternal
  ) = 0, 'phoenix_outbox_events must carry no trigger of any kind';

  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'phoenix_outbox_events'
       AND column_name ~* 'process|claim|lease|retry|attempt|failure|dead.?letter|consum'
  ), 'phoenix_outbox_events must carry no D3 consumer/processing column';

  ASSERT NOT has_table_privilege('authenticated', 'public.phoenix_outbox_events', 'SELECT'),
    'authenticated must still lack SELECT on phoenix_outbox_events after 162';
  ASSERT NOT has_function_privilege('authenticated', 'public.phoenix_append_outbox_event_internal(text,text,smallint,text,uuid,uuid,jsonb,uuid,uuid,uuid,uuid)', 'EXECUTE'),
    'authenticated must still lack EXECUTE on the append helper after 162';
  ASSERT NOT has_table_privilege('anon', 'public.phoenix_outbox_events', 'SELECT'),
    'anon must still lack SELECT on phoenix_outbox_events after 162';

  ASSERT (SELECT count(*) FROM public.phoenix_outbox_events) = 0,
    'applying 162 must not itself produce any outbox row';
END $$;

COMMIT;

-- ============================================================================
-- POST-CONDITIONS
-- ============================================================================
-- 1. phoenix_capture_stocktake_recorded(): same zero-arg signature, SECURITY
--    DEFINER, pinned search_path, byte-identical business logic for every
--    pre-existing statement (one shared timestamp variable resolved once
--    replaces two independent now() calls, both still resolving to the same
--    value at the same instant), plus exactly one additive PERFORM call
--    after the existing sink INSERT succeeds and before RETURN NEW. Its one
--    existing AFTER INSERT trigger on stocktakes is completely unchanged.
-- 2. phoenix_resolve_outlet_return_exception(...): same six-argument
--    signature, SECURITY DEFINER, pinned search_path, byte-identical
--    validation/locking/permission/business-mutation logic, plus RETURNING
--    id, resolved_at added to both existing resolution-row INSERTs and
--    exactly one additive PERFORM call per branch, immediately after each
--    INSERT and before that branch's own RETURN. No trigger of any kind
--    exists or is created on phoenix_outlet_return_exception_resolutions.
-- 3. 159 (lifecycle) and 161 (movement) producers are completely unchanged:
--    same one/one call sites, same 11/3 trigger attachments respectively.
--    phoenix_capture_movement_notification remains unwired.
-- 4. A confirmed_no_stock resolution appends exactly one outbox event
--    (aggregate_type = phoenix_outlet_return_exception_resolutions). A
--    corrected_receipt resolution appends that SAME event alongside 161's
--    own pre-existing movement: event for the compensating stock/quarantine
--    movement — two distinct aggregates, owner-approved, never a collision
--    (distinct event_key, event_type, aggregate_type, aggregate_id).
-- 5. A replay with a matching existing request_id/fingerprint returns before
--    either INSERT/PERFORM site is reached — no second resolution row, no
--    second outbox event. A replay with a conflicting fingerprint raises the
--    RPC's own pre-existing request_id_conflict before either site — no
--    outbox event either. Both by construction, not by new logic.
-- 6. Zero outbox rows exist immediately after this migration commits.
-- 7. RECONCILIATION: this migration writes no application data itself (two
--    function redefinitions) — nothing to reconcile.
-- ============================================================================
-- ROLLBACK: there is no legitimate reason to ever do this once any real
-- stocktake or exception resolution has been captured by the new outbox
-- emissions (that would be destroying real captured event history). If
-- genuinely required before any real traffic:
--   Re-apply 123's exact phoenix_capture_stocktake_recorded() body (without
--   the PERFORM block and shared timestamp variable added here) and 157's
--   exact phoenix_resolve_outlet_return_exception(...) body (without the
--   RETURNING captures and PERFORM blocks added here) to restore the
--   pre-162 definitions.
-- ============================================================================
