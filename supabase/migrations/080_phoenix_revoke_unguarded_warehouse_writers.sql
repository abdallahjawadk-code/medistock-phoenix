-- ============================================================================
-- REVOKE-UNGUARDED-WAREHOUSE-WRITERS-080-A   ***CUTOVER — APPLY LAST***
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
--
-- *** DO NOT APPLY THIS UNTIL CLIENT PARITY IS PROVEN IN THE TARGET
-- *** ENVIRONMENT. Applying it while any client still calls the legacy names
-- *** will break manual warehouse intake for those clients immediately.
--
-- APPLY ORDER: 078 -> 079 -> (deploy guarded client, observe parity) -> 080.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THIS MIGRATION EXISTS
-- ─────────────────────────────────────────────────────────────────────────────
-- 078 added guarded RPCs and 079 made them fail closed, but BOTH deliberately
-- left the legacy unguarded RPCs callable so the migrations were safe to apply
-- under a live pre-078 frontend.
--
-- Pointing the client at the guarded names is NOT a security control. Any
-- authenticated session can still call the legacy name directly through
-- PostgREST and post an unguarded accumulating receipt — the exact
-- cross-device double-post 078 exists to prevent. The client choosing a safer
-- function is a convention; only a REVOKE is a boundary.
--
-- This migration closes that hole by removing EXECUTE from `authenticated` on
-- the two unguarded writers. After it, the only route to an accumulating
-- receipt is the guarded RPC, which requires a canonical generation.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY REVOKE AND NOT DROP
-- ─────────────────────────────────────────────────────────────────────────────
-- The guarded functions DELEGATE to these bodies. Dropping them would break the
-- guarded path itself. They must remain as SECURITY DEFINER internals, reachable
-- only from inside the guarded functions (which execute as their owner), never
-- from a client role. Revoking EXECUTE from `authenticated` achieves exactly
-- that and is instantly reversible.
--
-- service_role retains EXECUTE: it is a trusted server-side identity that is
-- never used by this application's frontend, and removing it would break
-- operator break-glass paths without improving the client boundary.
--
-- PRECONDITIONS: 078 and 079 applied; both guarded RPCs present.
-- ============================================================================

BEGIN;

DO $precond$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='warehouse_stock'
                    AND column_name='movement_seq') THEN
    RAISE EXCEPTION 'precondition failed: 078 not applied (movement_seq missing)';
  END IF;

  -- 079 must be in place, or revoking the legacy path would leave only a
  -- guarded path that still silently accepts a NULL generation.
  IF (SELECT count(*) FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = 'phoenix_receive_warehouse_stock_guarded'
         AND pg_get_functiondef(p.oid) LIKE '%expected_generation_required%') <> 1 THEN
    RAISE EXCEPTION 'precondition failed: 079 not applied (guarded receipt still tolerates a NULL generation)';
  END IF;

  IF (SELECT count(*) FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = 'phoenix_apply_warehouse_stock_movement_guarded'
         AND pg_get_functiondef(p.oid) LIKE '%expected_generation_required%') <> 1 THEN
    RAISE EXCEPTION 'precondition failed: 079 not applied (guarded adjustment still tolerates a NULL generation)';
  END IF;
END;
$precond$;

-- ── Remove the unguarded client route ───────────────────────────────────────

REVOKE EXECUTE ON FUNCTION public.phoenix_receive_warehouse_stock(
  uuid, uuid, text, integer, boolean, boolean, uuid, text, text, text, text,
  text, text, date, numeric, text, text, text, text, text
) FROM authenticated;

REVOKE EXECUTE ON FUNCTION public.phoenix_apply_warehouse_stock_movement(
  uuid, uuid, text, integer, text, text, text
) FROM authenticated;

COMMENT ON FUNCTION public.phoenix_receive_warehouse_stock(
  uuid, uuid, text, integer, boolean, boolean, uuid, text, text, text, text,
  text, text, date, numeric, text, text, text, text, text
) IS
  'INTERNAL as of migration 080. Unguarded accumulating receipt: no expected-'
  'generation precondition, so two independent submissions of the same physical '
  'receipt both post. EXECUTE revoked from authenticated — reachable only from '
  'phoenix_receive_warehouse_stock_guarded, which supplies the precondition.';

COMMENT ON FUNCTION public.phoenix_apply_warehouse_stock_movement(
  uuid, uuid, text, integer, text, text, text
) IS
  'INTERNAL as of migration 080. Unguarded stock movement. EXECUTE revoked from '
  'authenticated — reachable only from '
  'phoenix_apply_warehouse_stock_movement_guarded.';

COMMIT;

-- ============================================================================
-- POST-CONDITIONS — run AFTER apply. Read-only.
-- ============================================================================
-- 1. `authenticated` can no longer execute the unguarded writers, but CAN still
--    execute the guarded ones:
--
--    SELECT p.proname,
--           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec
--      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--     WHERE n.nspname = 'public'
--       AND p.proname IN ('phoenix_receive_warehouse_stock',
--                         'phoenix_receive_warehouse_stock_guarded',
--                         'phoenix_apply_warehouse_stock_movement',
--                         'phoenix_apply_warehouse_stock_movement_guarded')
--     ORDER BY 1;
--    -- expect: the two bare names FALSE, the two *_guarded names TRUE
--
-- 2. The guarded path still works end to end (staging only — this WRITES):
--
--    BEGIN;
--      SELECT public.phoenix_receive_warehouse_stock_guarded(
--        gen_random_uuid(), '<warehouse-uuid>', 'Probe', 1, true, true, 0);
--      -- expect success: delegation still reaches the revoked body, because the
--      -- guarded function is SECURITY DEFINER and runs as its owner.
--    ROLLBACK;
--
-- 3. Reconciliation — the ledger is untouched by a grant change:
--
--    SELECT count(*) AS lots, coalesce(sum(on_hand_quantity),0) AS on_hand
--      FROM public.warehouse_stock;
--
-- ============================================================================
-- ROLLBACK / CONTAINMENT
-- ============================================================================
-- Instant and lossless — this migration changes only privileges:
--
--    GRANT EXECUTE ON FUNCTION public.phoenix_receive_warehouse_stock(
--      uuid, uuid, text, integer, boolean, boolean, uuid, text, text, text,
--      text, text, text, date, numeric, text, text, text, text, text
--    ) TO authenticated;
--    GRANT EXECUTE ON FUNCTION public.phoenix_apply_warehouse_stock_movement(
--      uuid, uuid, text, integer, text, text, text) TO authenticated;
--
-- Run that if any client is found still calling the legacy names after cutover.
-- ============================================================================
