-- ============================================================================
-- QUARANTINE-READ-POLICY-DISPOSITION-PARITY-105-A
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply after 104.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE GAP THIS CLOSES — found building the quarantine-disposition frontend
-- ─────────────────────────────────────────────────────────────────────────────
-- 069's warehouse_quarantine_stock/_movements SELECT RLS policies (wqs_select_
-- scoped / wqsm_select_scoped) allow a read to holders of
-- 'warehouse_transfer.return_receive' or 'warehouse_transfer.review_return' —
-- both CENTRAL-side keys (central_warehouse_manager holds both; warehouse_
-- officer holds neither). 099 later added phoenix_release_quarantine_stock
-- and phoenix_destroy_quarantine_stock, gated on 'warehouse_transfer.
-- return_request' — a key warehouse_officer DOES hold (institution side) —
-- but never touched the SELECT policy to match.
--
-- Net effect: a warehouse_officer at an institution warehouse (071's own
-- corridor — they are the one who receives outlet returns INTO quarantine)
-- can call the disposition RPCs successfully, but cannot read
-- warehouse_quarantine_stock via RLS to see what is even sitting there to
-- act on. The read and write gates never matched. Confirmed by reading both
-- migrations' actual role grants before writing this file.
--
-- FIX: both SELECT policies gain 'warehouse_transfer.return_request' as a
-- third OR-branch, identical scope shape to the two already there. No other
-- policy, table, or RPC is touched.
-- ============================================================================

BEGIN;

DO $precond$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'warehouse_quarantine_stock' AND policyname = 'wqs_select_scoped'
  ) THEN
    RAISE EXCEPTION 'precondition failed: 069 wqs_select_scoped policy is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'warehouse_quarantine_stock_movements' AND policyname = 'wqsm_select_scoped'
  ) THEN
    RAISE EXCEPTION 'precondition failed: 069 wqsm_select_scoped policy is missing';
  END IF;
  IF to_regprocedure('public.phoenix_release_quarantine_stock(uuid,uuid,integer,text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 099 phoenix_release_quarantine_stock is missing';
  END IF;
END;
$precond$;

DROP POLICY IF EXISTS wqs_select_scoped ON public.warehouse_quarantine_stock;
CREATE POLICY wqs_select_scoped
  ON public.warehouse_quarantine_stock FOR SELECT TO authenticated
  USING (
    auth.uid() IS NOT NULL AND (
      public.phoenix_my_role() = 'super_admin'
      OR public.phoenix_profile_has_scoped_permission(
           auth.uid(), 'warehouse_transfer.return_receive', organization_id, warehouse_id, NULL)
      OR public.phoenix_profile_has_scoped_permission(
           auth.uid(), 'warehouse_transfer.review_return', organization_id, warehouse_id, NULL)
      -- 105: matches 099's own disposition-RPC gate (release/destroy), which
      -- this policy never tracked.
      OR public.phoenix_profile_has_scoped_permission(
           auth.uid(), 'warehouse_transfer.return_request', organization_id, warehouse_id, NULL)
    )
  );

DROP POLICY IF EXISTS wqsm_select_scoped ON public.warehouse_quarantine_stock_movements;
CREATE POLICY wqsm_select_scoped
  ON public.warehouse_quarantine_stock_movements FOR SELECT TO authenticated
  USING (
    auth.uid() IS NOT NULL AND (
      public.phoenix_my_role() = 'super_admin'
      OR public.phoenix_profile_has_scoped_permission(
           auth.uid(), 'warehouse_transfer.return_receive', organization_id, warehouse_id, NULL)
      OR public.phoenix_profile_has_scoped_permission(
           auth.uid(), 'warehouse_transfer.review_return', organization_id, warehouse_id, NULL)
      OR public.phoenix_profile_has_scoped_permission(
           auth.uid(), 'warehouse_transfer.return_request', organization_id, warehouse_id, NULL)
    )
  );

COMMIT;

-- ============================================================================
-- POST-CONDITIONS
-- ============================================================================
-- 1. A warehouse_officer scoped to an institution warehouse can now SELECT
--    that warehouse's warehouse_quarantine_stock / _movements rows — the
--    exact scope phoenix_release_quarantine_stock/phoenix_destroy_
--    quarantine_stock already authorize them to act on.
-- 2. central_warehouse_manager's existing read access is unaffected (both
--    original OR-branches are untouched, only a third is added).
-- 3. RECONCILIATION: this migration writes no data itself (pure policy
--    redefinitions).
-- ============================================================================
-- ROLLBACK: re-apply 069's original two CREATE POLICY statements verbatim
-- (drop the third OR-branch). No schema change, no data written.
-- ============================================================================
