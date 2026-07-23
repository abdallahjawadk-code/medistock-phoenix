-- ============================================================================
-- BULK-RECEIVE-MATCHING-DISPATCH-LINES-096-A
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply after 095.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS ADDS — Phase 2 contract: "individual receipt + 'receive all
-- counted matching lines'"
-- ─────────────────────────────────────────────────────────────────────────────
-- 070's phoenix_receive_outlet_dispatch_line already does individual receipt
-- correctly (partial/full/reject/difference, idempotency, generation-safe row
-- locks). This migration adds the BULK counterpart for the one corridor the
-- Phase 2 contract's own e2e list names explicitly ("التوزيع للمنافذ" —
-- distribution to outlets): a warehouse officer physically counts an
-- inbound dispatch and wants every line whose counted quantity EXACTLY
-- MATCHES the sent quantity accepted in one call, while any line that does
-- NOT match is left untouched for individual review (070 already REQUIRES a
-- difference_reason for a mismatched quantity — that reasoning belongs to a
-- human decision per line, not a bulk default).
--
-- SCOPE: this migration covers outlet dispatch receiving (070) ONLY. The
-- same "counted matching only, mismatches go to individual review" shape
-- could be repeated for 068 (central->institution transfer receive), 069/071
-- (return shipment receive) and 087 (procurement receive) — each has a
-- DIFFERENT header/line shape and its own idempotency contract, so a
-- shallow copy-paste across all five without proportional dynamic-test
-- coverage would be worse than shipping one corridor correctly. Deferred,
-- not silently assumed done — see this file's own FOLLOW-UP section.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THIS DELEGATES TO 070's EXISTING RPC, LINE BY LINE, PER PL/PGSQL
-- EXCEPTION BLOCK (implicit SAVEPOINT) — "atomic قدر الإمكان... استمرار آمن
-- عند partial failure"
-- ─────────────────────────────────────────────────────────────────────────────
-- A single dispatch commonly has multiple lines; one line's row already
-- being decided by a concurrent caller, or one line's quantity no longer
-- matching after a concurrent correction, must not fail the WHOLE batch and
-- roll back lines that already succeeded. Each line's call to
-- phoenix_receive_outlet_dispatch_line is wrapped in its own BEGIN...
-- EXCEPTION block, which PL/pgSQL implements as an implicit SAVEPOINT: a
-- failure on one line rolls back ONLY that line's sub-transaction and is
-- reported in that line's own result entry; every other line's outcome is
-- unaffected and the overall call still COMMITs. This is "atomic per line,
-- best-effort across lines" — the strongest atomicity available without
-- either (a) aborting good lines because of one bad line, or (b) partially
-- applying a single line's own write (070's own RPC is already all-or-
-- nothing per line).
--
-- Idempotency of the BULK call itself: each line's underlying request id is
-- DERIVED deterministically from (p_bulk_request_id, dispatch_line_id) via
-- md5, never client-supplied per line and never random — so retrying the
-- exact same bulk call (lost response, duplicate device tap) re-derives the
-- SAME per-line request ids, and 070's own idempotency (a replay of an
-- already-committed request id short-circuits to the same result) makes the
-- retry a no-op for lines that already landed, while still processing any
-- line that did not.
-- ============================================================================

BEGIN;

DO $precond$
BEGIN
  IF to_regprocedure(
    'public.phoenix_receive_outlet_dispatch_line(uuid,uuid,integer,text,text)'
  ) IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 070 phoenix_receive_outlet_dispatch_line is missing';
  END IF;
END;
$precond$;

CREATE OR REPLACE FUNCTION public.phoenix_receive_all_matching_dispatch_lines(
  p_bulk_request_id uuid,
  p_dispatch_id      uuid,
  p_counted_lines    jsonb,   -- [{ "dispatch_line_id": uuid, "counted_quantity": integer }, ...]
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
  v_line        public.warehouse_dispatch_lines%ROWTYPE;
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
  IF p_bulk_request_id IS NULL THEN
    RAISE EXCEPTION 'bulk_request_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_dispatch_id IS NULL THEN
    RAISE EXCEPTION 'dispatch_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_counted_lines IS NULL OR jsonb_typeof(p_counted_lines) <> 'array'
     OR jsonb_array_length(p_counted_lines) = 0 THEN
    RAISE EXCEPTION 'counted_lines_must_be_a_nonempty_array' USING ERRCODE = '23514';
  END IF;

  -- Same per-dispatch advisory lock 070's own RECEIVE takes — re-entrant
  -- within this transaction, so each delegated call below re-taking it is a
  -- no-op, not a self-deadlock.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_dispatch_id::text, 70170));

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_counted_lines)
  LOOP
    v_line_id := NULLIF(v_item ->> 'dispatch_line_id', '')::uuid;
    v_counted := NULLIF(v_item ->> 'counted_quantity', '')::integer;

    IF v_line_id IS NULL OR v_counted IS NULL OR v_counted < 0 THEN
      v_results := v_results || jsonb_build_object(
        'dispatch_line_id', v_line_id, 'status', 'error',
        'message', 'malformed_line_entry');
      v_errored := v_errored + 1;
      CONTINUE;
    END IF;
    IF v_line_id = ANY(v_seen) THEN
      v_results := v_results || jsonb_build_object(
        'dispatch_line_id', v_line_id, 'status', 'error',
        'message', 'duplicate_line_in_request');
      v_errored := v_errored + 1;
      CONTINUE;
    END IF;
    v_seen := v_seen || v_line_id;

    -- Unlocked read: only to decide "does this line belong to THIS dispatch
    -- and does the count match", never to authorize. Authorization and the
    -- real row lock happen inside the delegated RPC below, exactly once.
    SELECT * INTO v_line FROM public.warehouse_dispatch_lines WHERE id = v_line_id;
    IF NOT FOUND OR v_line.dispatch_id <> p_dispatch_id THEN
      v_results := v_results || jsonb_build_object(
        'dispatch_line_id', v_line_id, 'status', 'error',
        'message', 'not_a_line_of_this_dispatch');
      v_errored := v_errored + 1;
      CONTINUE;
    END IF;
    IF v_line.status <> 'pending' THEN
      v_results := v_results || jsonb_build_object(
        'dispatch_line_id', v_line_id, 'status', 'skipped_already_decided');
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;
    IF v_counted <> v_line.sent_quantity THEN
      -- "Matching" only. A count that disagrees with what was sent is a
      -- discrepancy that needs a human-entered reason — route it back to
      -- the individual RPC, never silently receive it here.
      v_results := v_results || jsonb_build_object(
        'dispatch_line_id', v_line_id, 'status', 'skipped_mismatch_requires_individual_review',
        'sent_quantity', v_line.sent_quantity, 'counted_quantity', v_counted);
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    v_derived_req := md5(p_bulk_request_id::text || ':' || v_line_id::text)::uuid;

    BEGIN
      v_result := public.phoenix_receive_outlet_dispatch_line(
        v_derived_req, v_line_id, v_counted, NULL, p_notes
      );
      v_results := v_results || jsonb_build_object(
        'dispatch_line_id', v_line_id, 'status', 'received',
        'idempotent_replay', COALESCE((v_result ->> 'idempotent_replay')::boolean, false));
      v_received := v_received + 1;
    EXCEPTION WHEN OTHERS THEN
      -- Implicit SAVEPOINT: only THIS line's attempt rolls back. Every prior
      -- and subsequent line in this loop is unaffected.
      v_results := v_results || jsonb_build_object(
        'dispatch_line_id', v_line_id, 'status', 'error',
        'message', SQLERRM, 'sqlstate', SQLSTATE);
      v_errored := v_errored + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'dispatch_id', p_dispatch_id,
    'received_count', v_received,
    'skipped_count', v_skipped,
    'errored_count', v_errored,
    'lines', v_results
  );
END;
$bulk$;

REVOKE ALL ON FUNCTION public.phoenix_receive_all_matching_dispatch_lines(uuid, uuid, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_receive_all_matching_dispatch_lines(uuid, uuid, jsonb, text) TO authenticated;

COMMENT ON FUNCTION public.phoenix_receive_all_matching_dispatch_lines(uuid, uuid, jsonb, text) IS
  'Bulk-accepts every counted dispatch line whose counted_quantity exactly '
  'matches its sent_quantity, one delegated call to phoenix_receive_outlet_'
  'dispatch_line per line inside its own exception block (implicit '
  'SAVEPOINT) so one line''s failure cannot roll back another''s success. '
  'Mismatched or already-decided lines are reported, never silently forced.';

COMMIT;

-- ============================================================================
-- POST-CONDITIONS
-- ============================================================================
-- 1. Function exists exactly once, SECURITY DEFINER, pinned search_path,
--    authenticated-only:
--    SELECT prosecdef, proconfig FROM pg_proc
--     WHERE proname='phoenix_receive_all_matching_dispatch_lines';
-- 2. RECONCILIATION: this migration writes no data by itself (pure function
--    definition) — pre/post row counts on every table are identical.
-- ============================================================================
-- ROLLBACK: DROP FUNCTION public.phoenix_receive_all_matching_dispatch_lines(
--   uuid, uuid, jsonb, text); — the underlying 070 RPC is untouched, so
-- individual receipt keeps working exactly as before.
-- ============================================================================
-- FOLLOW-UP (NOT part of this migration)
-- ============================================================================
-- Same bulk-matching shape for 068 (transfer receive), 069/071 (return
-- shipment receive), and 087 (procurement receive) — each needs its own
-- dynamic-test proof before being trusted with the same claim.
-- ============================================================================
