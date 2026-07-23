-- ============================================================================
-- BULK-RECEIVE-REMAINING-CORRIDORS-100-A
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply after 099.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS ADDS — extends 096's "bulk-accept only exact counted matches"
-- pattern to the three remaining receive corridors with a real per-line
-- pending/decided gate: 068 (warehouse transfer), 069 (warehouse return
-- shipment), 071 (outlet return shipment). Each RPC below is a THIN
-- iterate-and-delegate wrapper, same shape as 096, over 088's redefinitions
-- of the underlying single-line RPCs (088 is the currently-effective body
-- for all three — verified by precondition below).
--
-- 087 (local procurement receive) is DELIBERATELY NOT touched here:
-- `phoenix_procurement_receive_order` already takes a `p_lines jsonb` array
-- and has no per-line pending/decided status gate or sent-vs-counted
-- comparison to preserve — every entry the caller includes is applied
-- unconditionally, capped only by the ordered quantity. "Accept only
-- counted-matching lines" for procurement is therefore a pure client-side
-- filter over which lines to include in that ONE existing call, not a new
-- SQL contract — writing a wrapper here would duplicate an RPC that adds no
-- behavior. Confirmed by reading its body before writing this file.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY NO HEADER-LEVEL ADVISORY LOCK (unlike 096, which reused 070's own)
-- ─────────────────────────────────────────────────────────────────────────────
-- 068/069/071's single-line receive RPCs (088's bodies) do NOT take a
-- header-scoped advisory lock the way 070 does — they lock only on their own
-- per-call p_request_id, and header-level serialization comes from
-- `SELECT ... FOR UPDATE` on the transfer/shipment row inside each call.
-- Fabricating a header-level lock with a salt these RPCs never use would add
-- false safety without matching their actual locking contract. Each line's
-- derived request id below is distinct, so each inner call's advisory lock
-- key differs — no self-deadlock, and Postgres row locks are re-entrant
-- within one transaction, so repeated `FOR UPDATE` on the same header row
-- across the loop is safe.
-- ============================================================================

BEGIN;

DO $precond$
BEGIN
  IF to_regprocedure('public.phoenix_receive_warehouse_transfer_line(uuid,uuid,integer,text,text)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: phoenix_receive_warehouse_transfer_line missing — apply 068/088 first';
  END IF;
  IF to_regprocedure('public.phoenix_receive_warehouse_return_shipment_line(uuid,uuid,integer,text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: phoenix_receive_warehouse_return_shipment_line missing — apply 069/088 first';
  END IF;
  IF to_regprocedure('public.phoenix_receive_outlet_return_shipment_line(uuid,uuid,integer,text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: phoenix_receive_outlet_return_shipment_line missing — apply 071/088 first';
  END IF;
END;
$precond$;

-- ── A. 068 — warehouse transfer receive ─────────────────────────────────────

CREATE OR REPLACE FUNCTION public.phoenix_receive_all_matching_transfer_lines(
  p_bulk_request_id uuid,
  p_transfer_id      uuid,
  p_counted_lines    jsonb,  -- [{ "transfer_line_id": uuid, "counted_quantity": integer }, ...]
  p_notes            text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $bulk$
DECLARE
  v_actor       uuid := auth.uid();
  v_item        jsonb;
  v_line_id     uuid;
  v_counted     integer;
  v_line        public.warehouse_transfer_lines%ROWTYPE;
  v_derived_req uuid;
  v_result      jsonb;
  v_results     jsonb := '[]'::jsonb;
  v_received    integer := 0;
  v_skipped     integer := 0;
  v_errored     integer := 0;
  v_seen        uuid[] := '{}';
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_bulk_request_id IS NULL OR p_transfer_id IS NULL THEN
    RAISE EXCEPTION 'bulk_request_id_and_transfer_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_counted_lines IS NULL OR jsonb_typeof(p_counted_lines) <> 'array'
     OR jsonb_array_length(p_counted_lines) = 0 THEN
    RAISE EXCEPTION 'counted_lines_must_be_a_nonempty_array' USING ERRCODE = '23514';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_counted_lines)
  LOOP
    v_line_id := NULLIF(v_item ->> 'transfer_line_id', '')::uuid;
    v_counted := NULLIF(v_item ->> 'counted_quantity', '')::integer;

    IF v_line_id IS NULL OR v_counted IS NULL OR v_counted < 0 THEN
      v_results := v_results || jsonb_build_object('transfer_line_id', v_line_id, 'status', 'error', 'message', 'malformed_line_entry');
      v_errored := v_errored + 1; CONTINUE;
    END IF;
    IF v_line_id = ANY(v_seen) THEN
      v_results := v_results || jsonb_build_object('transfer_line_id', v_line_id, 'status', 'error', 'message', 'duplicate_line_in_request');
      v_errored := v_errored + 1; CONTINUE;
    END IF;
    v_seen := v_seen || v_line_id;

    SELECT * INTO v_line FROM public.warehouse_transfer_lines WHERE id = v_line_id;
    IF NOT FOUND OR v_line.transfer_id <> p_transfer_id THEN
      v_results := v_results || jsonb_build_object('transfer_line_id', v_line_id, 'status', 'error', 'message', 'not_a_line_of_this_transfer');
      v_errored := v_errored + 1; CONTINUE;
    END IF;
    IF v_line.status <> 'in_transit' THEN
      v_results := v_results || jsonb_build_object('transfer_line_id', v_line_id, 'status', 'skipped_already_decided');
      v_skipped := v_skipped + 1; CONTINUE;
    END IF;
    IF v_counted <> v_line.sent_quantity THEN
      v_results := v_results || jsonb_build_object(
        'transfer_line_id', v_line_id, 'status', 'skipped_mismatch_requires_individual_review',
        'sent_quantity', v_line.sent_quantity, 'counted_quantity', v_counted);
      v_skipped := v_skipped + 1; CONTINUE;
    END IF;

    v_derived_req := md5(p_bulk_request_id::text || ':' || v_line_id::text)::uuid;
    BEGIN
      v_result := public.phoenix_receive_warehouse_transfer_line(v_derived_req, v_line_id, v_counted, NULL, p_notes);
      v_results := v_results || jsonb_build_object(
        'transfer_line_id', v_line_id, 'status', 'received',
        'idempotent_replay', COALESCE((v_result ->> 'idempotent_replay')::boolean, false));
      v_received := v_received + 1;
    EXCEPTION WHEN OTHERS THEN
      v_results := v_results || jsonb_build_object('transfer_line_id', v_line_id, 'status', 'error', 'message', SQLERRM, 'sqlstate', SQLSTATE);
      v_errored := v_errored + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'transfer_id', p_transfer_id,
    'received_count', v_received, 'skipped_count', v_skipped, 'errored_count', v_errored, 'lines', v_results);
END;
$bulk$;

REVOKE ALL ON FUNCTION public.phoenix_receive_all_matching_transfer_lines(uuid, uuid, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_receive_all_matching_transfer_lines(uuid, uuid, jsonb, text) TO authenticated;

-- ── B. 069 — warehouse return shipment receive (at central) ────────────────

CREATE OR REPLACE FUNCTION public.phoenix_receive_all_matching_warehouse_return_lines(
  p_bulk_request_id uuid,
  p_shipment_id      uuid,
  p_counted_lines    jsonb,  -- [{ "shipment_line_id": uuid, "counted_quantity": integer }, ...]
  p_notes            text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $bulk$
DECLARE
  v_actor       uuid := auth.uid();
  v_item        jsonb;
  v_line_id     uuid;
  v_counted     integer;
  v_line        public.warehouse_return_shipment_lines%ROWTYPE;
  v_reason_code text;
  v_derived_req uuid;
  v_result      jsonb;
  v_results     jsonb := '[]'::jsonb;
  v_received    integer := 0;
  v_skipped     integer := 0;
  v_errored     integer := 0;
  v_seen        uuid[] := '{}';
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_bulk_request_id IS NULL OR p_shipment_id IS NULL THEN
    RAISE EXCEPTION 'bulk_request_id_and_shipment_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_counted_lines IS NULL OR jsonb_typeof(p_counted_lines) <> 'array'
     OR jsonb_array_length(p_counted_lines) = 0 THEN
    RAISE EXCEPTION 'counted_lines_must_be_a_nonempty_array' USING ERRCODE = '23514';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_counted_lines)
  LOOP
    v_line_id := NULLIF(v_item ->> 'shipment_line_id', '')::uuid;
    v_counted := NULLIF(v_item ->> 'counted_quantity', '')::integer;

    IF v_line_id IS NULL OR v_counted IS NULL OR v_counted < 0 THEN
      v_results := v_results || jsonb_build_object('shipment_line_id', v_line_id, 'status', 'error', 'message', 'malformed_line_entry');
      v_errored := v_errored + 1; CONTINUE;
    END IF;
    IF v_line_id = ANY(v_seen) THEN
      v_results := v_results || jsonb_build_object('shipment_line_id', v_line_id, 'status', 'error', 'message', 'duplicate_line_in_request');
      v_errored := v_errored + 1; CONTINUE;
    END IF;
    v_seen := v_seen || v_line_id;

    SELECT * INTO v_line FROM public.warehouse_return_shipment_lines WHERE id = v_line_id;
    IF NOT FOUND OR v_line.shipment_id <> p_shipment_id THEN
      v_results := v_results || jsonb_build_object('shipment_line_id', v_line_id, 'status', 'error', 'message', 'not_a_line_of_this_shipment');
      v_errored := v_errored + 1; CONTINUE;
    END IF;
    IF v_line.status <> 'in_transit' THEN
      v_results := v_results || jsonb_build_object('shipment_line_id', v_line_id, 'status', 'skipped_already_decided');
      v_skipped := v_skipped + 1; CONTINUE;
    END IF;
    IF v_counted <> v_line.sent_quantity THEN
      v_results := v_results || jsonb_build_object(
        'shipment_line_id', v_line_id, 'status', 'skipped_mismatch_requires_individual_review',
        'sent_quantity', v_line.sent_quantity, 'counted_quantity', v_counted);
      v_skipped := v_skipped + 1; CONTINUE;
    END IF;

    -- 100-A-FIX: an exact quantity match does NOT imply no disposition
    -- decision is needed — reason_code (why the return was requested) is
    -- independent of whether the count matches. 088's receive RPC requires
    -- an EXPLICIT p_disposition_decision whenever reason_code IN
    -- ('near_expiry','excess','shipment_error'), regardless of match. That
    -- is a human judgment call (restock vs quarantine) this bulk path must
    -- never auto-decide — so such a line is skipped for individual review,
    -- exactly like a mismatch, rather than attempted and erroring.
    SELECT rl.reason_code INTO v_reason_code
      FROM public.warehouse_return_request_lines rl WHERE rl.id = v_line.return_request_line_id;
    IF v_reason_code IN ('near_expiry', 'excess', 'shipment_error') THEN
      v_results := v_results || jsonb_build_object(
        'shipment_line_id', v_line_id, 'status', 'skipped_requires_disposition_decision', 'reason_code', v_reason_code);
      v_skipped := v_skipped + 1; CONTINUE;
    END IF;

    v_derived_req := md5(p_bulk_request_id::text || ':' || v_line_id::text)::uuid;
    BEGIN
      v_result := public.phoenix_receive_warehouse_return_shipment_line(v_derived_req, v_line_id, v_counted, NULL, p_notes, NULL);
      v_results := v_results || jsonb_build_object(
        'shipment_line_id', v_line_id, 'status', 'received',
        'idempotent_replay', COALESCE((v_result ->> 'idempotent_replay')::boolean, false));
      v_received := v_received + 1;
    EXCEPTION WHEN OTHERS THEN
      v_results := v_results || jsonb_build_object('shipment_line_id', v_line_id, 'status', 'error', 'message', SQLERRM, 'sqlstate', SQLSTATE);
      v_errored := v_errored + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'shipment_id', p_shipment_id,
    'received_count', v_received, 'skipped_count', v_skipped, 'errored_count', v_errored, 'lines', v_results);
END;
$bulk$;

REVOKE ALL ON FUNCTION public.phoenix_receive_all_matching_warehouse_return_lines(uuid, uuid, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_receive_all_matching_warehouse_return_lines(uuid, uuid, jsonb, text) TO authenticated;

-- ── C. 071 — outlet return shipment receive (at institution warehouse) ─────

CREATE OR REPLACE FUNCTION public.phoenix_receive_all_matching_outlet_return_lines(
  p_bulk_request_id uuid,
  p_shipment_id      uuid,
  p_counted_lines    jsonb,  -- [{ "shipment_line_id": uuid, "counted_quantity": integer }, ...]
  p_notes            text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $bulk$
DECLARE
  v_actor       uuid := auth.uid();
  v_item        jsonb;
  v_line_id     uuid;
  v_counted     integer;
  v_line        public.outlet_return_shipment_lines%ROWTYPE;
  v_reason_code text;
  v_derived_req uuid;
  v_result      jsonb;
  v_results     jsonb := '[]'::jsonb;
  v_received    integer := 0;
  v_skipped     integer := 0;
  v_errored     integer := 0;
  v_seen        uuid[] := '{}';
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_bulk_request_id IS NULL OR p_shipment_id IS NULL THEN
    RAISE EXCEPTION 'bulk_request_id_and_shipment_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_counted_lines IS NULL OR jsonb_typeof(p_counted_lines) <> 'array'
     OR jsonb_array_length(p_counted_lines) = 0 THEN
    RAISE EXCEPTION 'counted_lines_must_be_a_nonempty_array' USING ERRCODE = '23514';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_counted_lines)
  LOOP
    v_line_id := NULLIF(v_item ->> 'shipment_line_id', '')::uuid;
    v_counted := NULLIF(v_item ->> 'counted_quantity', '')::integer;

    IF v_line_id IS NULL OR v_counted IS NULL OR v_counted < 0 THEN
      v_results := v_results || jsonb_build_object('shipment_line_id', v_line_id, 'status', 'error', 'message', 'malformed_line_entry');
      v_errored := v_errored + 1; CONTINUE;
    END IF;
    IF v_line_id = ANY(v_seen) THEN
      v_results := v_results || jsonb_build_object('shipment_line_id', v_line_id, 'status', 'error', 'message', 'duplicate_line_in_request');
      v_errored := v_errored + 1; CONTINUE;
    END IF;
    v_seen := v_seen || v_line_id;

    SELECT * INTO v_line FROM public.outlet_return_shipment_lines WHERE id = v_line_id;
    IF NOT FOUND OR v_line.shipment_id <> p_shipment_id THEN
      v_results := v_results || jsonb_build_object('shipment_line_id', v_line_id, 'status', 'error', 'message', 'not_a_line_of_this_shipment');
      v_errored := v_errored + 1; CONTINUE;
    END IF;
    IF v_line.status <> 'in_transit' THEN
      v_results := v_results || jsonb_build_object('shipment_line_id', v_line_id, 'status', 'skipped_already_decided');
      v_skipped := v_skipped + 1; CONTINUE;
    END IF;
    IF v_counted <> v_line.sent_quantity THEN
      v_results := v_results || jsonb_build_object(
        'shipment_line_id', v_line_id, 'status', 'skipped_mismatch_requires_individual_review',
        'sent_quantity', v_line.sent_quantity, 'counted_quantity', v_counted);
      v_skipped := v_skipped + 1; CONTINUE;
    END IF;

    -- 100-A-FIX: see the identical fix + rationale in section B above — an
    -- exact match does not exempt a near_expiry/excess/shipment_error reason
    -- from needing an explicit human disposition decision.
    SELECT rl.reason_code INTO v_reason_code
      FROM public.outlet_return_request_lines rl WHERE rl.id = v_line.return_request_line_id;
    IF v_reason_code IN ('near_expiry', 'excess', 'shipment_error') THEN
      v_results := v_results || jsonb_build_object(
        'shipment_line_id', v_line_id, 'status', 'skipped_requires_disposition_decision', 'reason_code', v_reason_code);
      v_skipped := v_skipped + 1; CONTINUE;
    END IF;

    v_derived_req := md5(p_bulk_request_id::text || ':' || v_line_id::text)::uuid;
    BEGIN
      v_result := public.phoenix_receive_outlet_return_shipment_line(v_derived_req, v_line_id, v_counted, NULL, p_notes, NULL);
      v_results := v_results || jsonb_build_object(
        'shipment_line_id', v_line_id, 'status', 'received',
        'idempotent_replay', COALESCE((v_result ->> 'idempotent_replay')::boolean, false));
      v_received := v_received + 1;
    EXCEPTION WHEN OTHERS THEN
      v_results := v_results || jsonb_build_object('shipment_line_id', v_line_id, 'status', 'error', 'message', SQLERRM, 'sqlstate', SQLSTATE);
      v_errored := v_errored + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'shipment_id', p_shipment_id,
    'received_count', v_received, 'skipped_count', v_skipped, 'errored_count', v_errored, 'lines', v_results);
END;
$bulk$;

REVOKE ALL ON FUNCTION public.phoenix_receive_all_matching_outlet_return_lines(uuid, uuid, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_receive_all_matching_outlet_return_lines(uuid, uuid, jsonb, text) TO authenticated;

COMMIT;

-- ============================================================================
-- POST-CONDITIONS
-- ============================================================================
-- 1. All three RPCs exist exactly once, SECURITY DEFINER, pinned search_path,
--    authenticated-only.
-- 2. RECONCILIATION: this migration writes no data itself (pure function
--    definitions).
-- ============================================================================
-- ROLLBACK: DROP the three functions. The single-line RPCs they delegate to
-- (068/069/071/088) are untouched, so individual receipt is unaffected.
-- ============================================================================
