-- ============================================================================
-- REVOKE-MANUAL-AVAILABILITY-WRITERS-085   ***CUTOVER — PREPARED, DO NOT APPLY***
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
--
-- *** THIS MIGRATION IS PREPARED IN THIS SPRINT AND MUST NOT BE APPLIED — not to
-- *** production and not to the disposable rig. It is fail-closed: without an
-- *** explicit parity attestation in the apply session it ABORTS, so an
-- *** accidental `apply.mjs` (default upTo=latest) stops here instead of silently
-- *** revoking. The disposable-rig proofs deliberately apply only 001→084.
--
-- APPLY ORDER (post-launch, once EVERY availability read is derived and NO
-- client reaches a manual quantity writer): prove parity in the target
-- environment, then in the SAME psql session:
--     SET phoenix.availability_cutover_attested = 'true';
--     \i 085_phoenix_revoke_manual_availability_writers.sql
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THIS MIGRATION EXISTS
-- ─────────────────────────────────────────────────────────────────────────────
-- 083 made physical availability a server-derived projection
-- (phoenix_available_stock) and 084 decoupled catalogue visibility from any
-- quantity write (phoenix_set_availability_visibility). Once the frontend reads
-- the projection everywhere and clears/sets the removed marker through 084, the
-- two legacy MANUAL quantity writers are no longer reached by any client:
--
--   • phoenix_upsert_availability            — hand-typed quantity + condition.
--   • phoenix_apply_availability_movement     — hand-entered set/add/subtract/correct.
--
-- Pointing the client away from them is a convention, not a boundary: any
-- authenticated session can still call either name directly through PostgREST
-- and reintroduce a second, hand-edited source of stock truth. Only a REVOKE is
-- a boundary. This migration removes EXECUTE from `authenticated` on both.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY REVOKE AND NOT DROP
-- ─────────────────────────────────────────────────────────────────────────────
-- The bodies are retained as SECURITY DEFINER internals (migration 053's
-- reactivation and removed-marker branches, the 034 movement ledger writer) and
-- may still be invoked by trusted server-side identities or future guarded
-- wrappers. Dropping them risks other migrations' `CREATE OR REPLACE` chains and
-- is not reversible; revoking EXECUTE from `authenticated` is the precise
-- boundary and is instantly reversible. service_role retains EXECUTE (trusted
-- server identity, never used by this frontend).
--
-- PRECONDITIONS: 083 + 084 applied; explicit in-session parity attestation.
-- ============================================================================

BEGIN;

DO $precond$
BEGIN
  -- Fail-closed parity gate. `true` (2nd arg) => missing setting yields NULL,
  -- not an error, so the abort message is what an operator sees.
  IF COALESCE(current_setting('phoenix.availability_cutover_attested', true), 'false') <> 'true' THEN
    RAISE EXCEPTION 'REFUSING TO APPLY 085: availability cutover not attested. This migration is PREPARED only. Prove derived-availability parity and that no client reaches a manual quantity writer, then SET phoenix.availability_cutover_attested = ''true'' in this session before applying.';
  END IF;

  -- The derived projection (083) and the visibility setter (084) must both be in
  -- place, or revoking the manual writers would remove capability with no
  -- replacement.
  IF to_regprocedure('public.phoenix_available_stock(uuid)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 083 phoenix_available_stock missing — apply 083 first';
  END IF;
  IF to_regprocedure('public.phoenix_set_availability_visibility(uuid, boolean, text)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 084 phoenix_set_availability_visibility missing — apply 084 first';
  END IF;
END;
$precond$;

-- ── Remove the manual quantity-writer client route ──────────────────────────

REVOKE EXECUTE ON FUNCTION public.phoenix_upsert_availability(
  uuid, text, text, text, text, integer, text, date, text, text, text, numeric, text
) FROM authenticated;

REVOKE EXECUTE ON FUNCTION public.phoenix_apply_availability_movement(
  uuid, text, integer, text, text
) FROM authenticated;

COMMENT ON FUNCTION public.phoenix_upsert_availability(
  uuid, text, text, text, text, integer, text, date, text, text, text, numeric, text
) IS
  'INTERNAL as of migration 085 (when applied). Manual availability quantity/'
  'condition writer — a second source of stock truth superseded by the derived '
  'projection (083). Catalogue visibility is handled by 084. EXECUTE revoked '
  'from authenticated.';

COMMENT ON FUNCTION public.phoenix_apply_availability_movement(
  uuid, text, integer, text, text
) IS
  'INTERNAL as of migration 085 (when applied). Manual availability quantity '
  'movement. EXECUTE revoked from authenticated — physical availability is '
  'derived from the canonical ledgers (083).';

COMMIT;

-- ============================================================================
-- POST-CONDITIONS — run AFTER apply (post-launch only). Read-only.
-- ============================================================================
-- 1. `authenticated` can no longer execute either manual writer:
--    SELECT p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec
--      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--     WHERE n.nspname='public'
--       AND p.proname IN ('phoenix_upsert_availability','phoenix_apply_availability_movement')
--     ORDER BY 1;   -- expect both FALSE
--
-- 2. The derived read still works for authenticated:
--    SELECT has_function_privilege('authenticated','public.phoenix_available_stock(uuid)','EXECUTE'); -- t
--    SELECT has_function_privilege('authenticated','public.phoenix_set_availability_visibility(uuid, boolean, text)','EXECUTE'); -- t
--
-- ============================================================================
-- ROLLBACK / CONTAINMENT — instant and lossless (privileges only):
--    GRANT EXECUTE ON FUNCTION public.phoenix_upsert_availability(
--      uuid, text, text, text, text, integer, text, date, text, text, text, numeric, text) TO authenticated;
--    GRANT EXECUTE ON FUNCTION public.phoenix_apply_availability_movement(
--      uuid, text, integer, text, text) TO authenticated;
-- ============================================================================
