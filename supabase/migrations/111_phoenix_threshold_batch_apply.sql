-- ============================================================================
-- THRESHOLD-BATCH-APPLY-111   ***PREPARED - DO NOT APPLY TO PRODUCTION***
--
-- MANUAL APPLY ONLY (SQL Editor), after owner review, AFTER 110. Never via
-- `supabase db push`. Replay 001->111 must be proven on the disposable rig
-- before this is considered ready.
--
-- WHY
-- Audited first (functional-closure Section 3): 092's phoenix_upsert_
-- inventory_threshold and phoenix_set_inventory_threshold_planning are
-- ALREADY the single, non-parallel threshold system this task must extend
-- ("ادمج ذلك مع migration 092 بدل إنشاء نظام موقف مخزني موازٍ") — per-
-- material scoping, an audit trail on every write, surplus>scarce validation
-- via target_max/reorder_point, org/warehouse/outlet scoping, and a
-- central_warehouse_manager-only org-default carve-out are all already
-- correct and are NOT rebuilt here. The one genuinely missing piece: setting
-- a threshold for MULTIPLE materials in one call. Today an operator must
-- call phoenix_upsert_inventory_threshold once per material — no batch path
-- exists.
--
-- CONTRACT
--   * ONE new RPC, phoenix_batch_upsert_inventory_threshold — a thin,
--     validate-then-loop wrapper that calls 092's UNCHANGED
--     phoenix_upsert_inventory_threshold once per array element, inside the
--     SAME transaction, so the whole batch is atomic (all-or-nothing): if
--     any one material fails authorization or validation, NOTHING in the
--     batch is applied. No new authorization logic, no new validation rule,
--     no new table — every per-material check is 092's existing function,
--     invoked directly, so a batch call and 100 individual calls with the
--     same arguments always produce byte-for-byte the same result and the
--     same audit_logs rows.
--   * Returns one JSON result per input item (id + organization_id +
--     scope_kind), in input order, so a caller can show a per-material
--     outcome even though the whole batch is atomic.
--
-- DEFERRED, NOT DONE HERE (reported honestly): the surplus/scarce boundary-
-- comparison semantics in 092's phoenix_status_prepare_report (`available >
-- target_max` for surplus, `available <= reorder_point` for scarce, no
-- distinct "unavailable" tier at available = 0) are AUDITED but NOT changed
-- by this migration — see the functional-closure task's Section 3 findings
-- for the exact discrepancy against the brief's stated boundary wording
-- (`available >= surplus_threshold`; a distinct "unavailable" state at
-- available = 0). Changing that is a product-semantics decision on
-- ALREADY-LIVE report logic, not a "genuinely missing, easy to add" gap —
-- left for an explicit, separate decision rather than silently altered
-- here.
--
-- PRECONDITIONS: 001..110 applied.
-- ============================================================================

BEGIN;

DO $precond$
BEGIN
  IF to_regprocedure(
    'public.phoenix_upsert_inventory_threshold(uuid,text,uuid,text,text,integer,integer,integer,boolean)'
  ) IS NULL THEN
    RAISE EXCEPTION '111 PRECONDITION FAILED: 092 phoenix_upsert_inventory_threshold is missing.';
  END IF;
  IF to_regprocedure('public.phoenix_batch_upsert_inventory_threshold(uuid,text,uuid,jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION '111 PRECONDITION FAILED: already applied.';
  END IF;
END
$precond$;

-- ─────────────────────────────────────────────────────────────────────────────
-- phoenix_batch_upsert_inventory_threshold — atomic multi-material apply.
--
-- p_items: jsonb array of
--   {scientific_name, national_code?, reorder_point?, target_max?,
--    near_expiry_days?, is_active?}
-- Every item shares the SAME organization_id/scope_kind/scope_id (a batch is
-- always "set these thresholds for these materials at THIS warehouse/outlet/
-- org-default") — exactly 092's own per-call scoping, just applied N times.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.phoenix_batch_upsert_inventory_threshold(
  p_organization_id uuid,
  p_scope_kind      text,
  p_scope_id        uuid,
  p_items           jsonb
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_item     jsonb;
  v_result   jsonb;
  v_results  jsonb := '[]'::jsonb;
  v_n        integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'items_required';
  END IF;
  -- A sane upper bound: this is an operator-driven batch action, not a bulk
  -- import path (which has its own dedicated corridors) — guards against a
  -- single call fanning out into an unbounded number of per-material writes
  -- and audit_logs rows.
  IF jsonb_array_length(p_items) > 200 THEN
    RAISE EXCEPTION 'batch_too_large' USING DETAIL = 'max 200 materials per batch call';
  END IF;

  -- Each element delegates to 092's UNCHANGED per-material RPC — same
  -- authorization, same validation, same audit row, same ON CONFLICT upsert.
  -- A failure on ANY element rolls back the WHOLE batch (plain plpgsql
  -- exception propagation inside one transaction — no explicit savepoint
  -- needed, and none is used, so partial application is impossible).
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_result := public.phoenix_upsert_inventory_threshold(
      p_organization_id,
      p_scope_kind,
      p_scope_id,
      v_item ->> 'scientific_name',
      v_item ->> 'national_code',
      NULLIF(v_item ->> 'reorder_point', '')::integer,
      NULLIF(v_item ->> 'target_max', '')::integer,
      NULLIF(v_item ->> 'near_expiry_days', '')::integer,
      COALESCE((v_item ->> 'is_active')::boolean, true)
    );
    v_results := v_results || jsonb_build_array(v_result);
    v_n := v_n + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'applied', v_n, 'results', v_results);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_batch_upsert_inventory_threshold(uuid, text, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_batch_upsert_inventory_threshold(uuid, text, uuid, jsonb) TO authenticated;

COMMENT ON FUNCTION public.phoenix_batch_upsert_inventory_threshold(uuid, text, uuid, jsonb) IS
  'Atomic multi-material extension of 092''s phoenix_upsert_inventory_threshold '
  '— NOT a parallel threshold system: every element is applied via a direct '
  'call to the unchanged 092 function (same authorization, same validation, '
  'same audit trail), inside one transaction, so a batch either fully '
  'applies or fully rolls back. Capped at 200 materials per call.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Verify
-- ─────────────────────────────────────────────────────────────────────────────
DO $verify$
BEGIN
  ASSERT to_regprocedure('public.phoenix_batch_upsert_inventory_threshold(uuid, text, uuid, jsonb)') IS NOT NULL,
    'VERIFY FAILED (111): phoenix_batch_upsert_inventory_threshold missing';
  -- No new table, no new column — this migration is RPC-only.
  RAISE NOTICE 'THRESHOLD-BATCH-APPLY-111: verified.';
END
$verify$;

COMMIT;

-- ============================================================================
-- POST-CONDITIONS (read-only, after apply):
--   SELECT pg_get_function_identity_arguments(oid) FROM pg_proc
--    WHERE proname = 'phoenix_batch_upsert_inventory_threshold'; -- 1 row
--   -- A batch call with one deliberately-unauthorized element rolls back
--   -- every element, including the ones that would otherwise have succeeded.
-- ROLLBACK (lossless; adds no table, no column):
--   DROP FUNCTION public.phoenix_batch_upsert_inventory_threshold(uuid, text, uuid, jsonb);
-- ============================================================================
