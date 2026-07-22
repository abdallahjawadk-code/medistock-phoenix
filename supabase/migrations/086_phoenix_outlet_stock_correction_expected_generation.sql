-- ============================================================================
-- OUTLET-STOCK-CORRECTION-EXPECTED-GENERATION-086
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply AFTER 085's chain is present (needs only 066/067's outlet_stock +
-- phoenix_count_outlet_stock). Additive, backward-compatible by construction:
-- adds ONE column, ONE trigger, ONE NEW distinctly-named guarded RPC. Drops
-- nothing, revokes nothing. The legacy phoenix_count_outlet_stock stays callable.
--
-- VERIFICATION STATUS: EXECUTED on a disposable PostgreSQL 18.4 cluster with
-- 001→086 in order via tools/pg-rig. See docs/phoenix/migration-086-*.md.
-- Production is 17.6.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY
-- ─────────────────────────────────────────────────────────────────────────────
-- The canonical-stock cutover routes every OUTLET quantity correction to the
-- outlet_stock ledger (item_availability is now a read-only projection — 083).
-- 067's phoenix_count_outlet_stock is already the correct guarded lot-level
-- correction: idempotent on p_request_id, non-negative, reserved-aware, reason-
-- mandatory, batch/provenance-snapshotting, actor-attributed, append-only
-- 'correction' movement + audit, and scoped to outlet_stock.count on the LOCKED
-- row's outlet. It has ONE gap versus a stocktake's needs: no optimistic-
-- concurrency generation, so two independent counts of the same lot silently
-- last-write-win.
--
-- This migration closes that the exact way 078 closed it for warehouse_stock:
--   A. a server-owned movement_seq on outlet_stock, advanced by a BEFORE UPDATE
--      trigger for EVERY quantity change (count, dispense, receive, return),
--      never settable by a client;
--   B. a NEW guarded wrapper phoenix_count_outlet_stock_guarded that checks
--      p_expected_generation under the row lock and DELEGATES the write to the
--      unchanged phoenix_count_outlet_stock body — so the audited count logic is
--      reused verbatim, not copied.
--
-- A genuine lost-response retry replays the same request id and short-circuits
-- BEFORE the generation check (the caller's own committed count has since
-- advanced the generation), so idempotency and the generation guard never fight.
--
-- CONFLICT CODE: SQLSTATE 40001 'outlet_stock_generation_conflict' — the "retry
-- the whole operation" class, deliberately NOT 23505 (which the client maps to
-- "same request id, different arguments").
-- ============================================================================

BEGIN;

-- ── PRECONDITIONS (this transaction ABORTS if any fails) ────────────────────
DO $precond$
BEGIN
  IF to_regclass('public.outlet_stock') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: public.outlet_stock is missing (apply 066/067 first)';
  END IF;
  IF to_regclass('public.outlet_stock_movements') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: public.outlet_stock_movements is missing';
  END IF;
  IF to_regprocedure('public.phoenix_count_outlet_stock(uuid, uuid, integer, text, text)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: phoenix_count_outlet_stock missing (apply 067 first)';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'phoenix_count_outlet_stock') <> 1 THEN
    RAISE EXCEPTION 'precondition failed: expected exactly 1 phoenix_count_outlet_stock overload';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'outlet_stock'
                AND column_name = 'movement_seq') THEN
    RAISE EXCEPTION 'precondition failed: outlet_stock.movement_seq already exists (086 already applied?)';
  END IF;
END;
$precond$;

-- ── A. Server-owned generation on outlet_stock ──────────────────────────────
ALTER TABLE public.outlet_stock
  ADD COLUMN movement_seq bigint NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.outlet_stock.movement_seq IS
  'Server-owned optimistic-concurrency generation. Advanced by '
  'phoenix_outlet_stock_bump_movement_seq on every on_hand/reserved change, in '
  'the same statement. Clients may READ it and pass it as p_expected_generation; '
  'any client-supplied value is overwritten by the trigger.';

CREATE OR REPLACE FUNCTION public.phoenix_outlet_stock_bump_movement_seq()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $bump$
BEGIN
  IF NEW.on_hand_quantity   IS DISTINCT FROM OLD.on_hand_quantity
  OR NEW.reserved_quantity  IS DISTINCT FROM OLD.reserved_quantity THEN
    NEW.movement_seq := OLD.movement_seq + 1;
  ELSE
    -- A metadata-only update must not advance the generation, or an unrelated
    -- edit would invalidate a count the operator is in the middle of posting.
    NEW.movement_seq := OLD.movement_seq;
  END IF;
  RETURN NEW;
END;
$bump$;

REVOKE ALL ON FUNCTION public.phoenix_outlet_stock_bump_movement_seq() FROM PUBLIC;

DROP TRIGGER IF EXISTS outlet_stock_bump_movement_seq ON public.outlet_stock;
CREATE TRIGGER outlet_stock_bump_movement_seq
  BEFORE UPDATE ON public.outlet_stock
  FOR EACH ROW
  EXECUTE FUNCTION public.phoenix_outlet_stock_bump_movement_seq();

-- ── B. Guarded lot-level correction ─────────────────────────────────────────
-- Adds ONLY the expected-generation precondition, then delegates the write to
-- the unchanged, audited phoenix_count_outlet_stock. Same advisory-lock key
-- (67067) as the legacy body, so the re-entrant lock inside the delegate is a
-- no-op and no lock-order inversion is introduced.
CREATE OR REPLACE FUNCTION public.phoenix_count_outlet_stock_guarded(
  p_request_id          uuid,
  p_outlet_stock_id     uuid,
  p_counted_quantity    integer,
  p_reason              text,
  p_expected_generation bigint DEFAULT NULL,
  p_notes               text   DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $guarded_count$
DECLARE
  v_seq   bigint;
  v_found boolean;
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 67067));

  -- A genuine retry replays the same request id: delegate immediately and SKIP
  -- the generation check (the caller's own committed count already advanced it).
  IF EXISTS (
    SELECT 1 FROM public.outlet_stock_movements m
     WHERE m.reference_type = 'outlet_request'
       AND m.reference_id   = p_request_id
  ) THEN
    RETURN public.phoenix_count_outlet_stock(
      p_request_id, p_outlet_stock_id, p_counted_quantity, p_reason, p_notes
    );
  END IF;

  IF p_expected_generation IS NOT NULL THEN
    -- Addressed by id, so no identity reconstruction. A missing row is left to
    -- the legacy body to report, so this wrapper cannot become an existence
    -- oracle for an unauthorized id.
    SELECT s.movement_seq, true
      INTO v_seq, v_found
      FROM public.outlet_stock s
     WHERE s.id = p_outlet_stock_id
       FOR UPDATE;

    IF COALESCE(v_found, false) AND v_seq IS DISTINCT FROM p_expected_generation THEN
      RAISE EXCEPTION 'outlet_stock_generation_conflict'
        USING ERRCODE = '40001',
              DETAIL  = format('expected generation %s, canonical generation %s',
                               p_expected_generation, v_seq);
    END IF;
  END IF;

  RETURN public.phoenix_count_outlet_stock(
    p_request_id, p_outlet_stock_id, p_counted_quantity, p_reason, p_notes
  );
END;
$guarded_count$;

REVOKE ALL ON FUNCTION public.phoenix_count_outlet_stock_guarded(
  uuid, uuid, integer, text, bigint, text
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.phoenix_count_outlet_stock_guarded(
  uuid, uuid, integer, text, bigint, text
) TO authenticated;

COMMENT ON FUNCTION public.phoenix_count_outlet_stock_guarded(
  uuid, uuid, integer, text, bigint, text
) IS
  'OUTLET-STOCK-CORRECTION-086: lot-level outlet correction with a server-'
  'authoritative expected-generation precondition. Delegates the write to the '
  'unchanged phoenix_count_outlet_stock (idempotent, non-negative, reason-'
  'mandatory, outlet_stock.count-scoped, append-only movement + audit). Raises '
  '40001 outlet_stock_generation_conflict when the canonical generation moved.';

COMMIT;

-- ============================================================================
-- POST-CONDITIONS — run AFTER apply. Read-only.
-- ============================================================================
-- 1. Column present, NOT NULL, default 0, no null rows:
--    SELECT column_name, is_nullable, column_default FROM information_schema.columns
--     WHERE table_schema='public' AND table_name='outlet_stock' AND column_name='movement_seq';
--    -- expect: movement_seq | NO | 0
-- 2. Trigger attached:
--    SELECT tgname FROM pg_trigger WHERE tgrelid='public.outlet_stock'::regclass AND NOT tgisinternal;
--    -- expect outlet_stock_bump_movement_seq
-- 3. Guarded fn exists once, least-granted:
--    SELECT has_function_privilege('authenticated','public.phoenix_count_outlet_stock_guarded(uuid, uuid, integer, text, bigint, text)','EXECUTE'); -- t
--    SELECT has_function_privilege('anon','public.phoenix_count_outlet_stock_guarded(uuid, uuid, integer, text, bigint, text)','EXECUTE');          -- f
-- ============================================================================
-- ROLLBACK / CONTAINMENT
-- ============================================================================
--   DROP FUNCTION IF EXISTS public.phoenix_count_outlet_stock_guarded(uuid, uuid, integer, text, bigint, text);
--   DROP TRIGGER IF EXISTS outlet_stock_bump_movement_seq ON public.outlet_stock;
--   DROP FUNCTION IF EXISTS public.phoenix_outlet_stock_bump_movement_seq();
--   ALTER TABLE public.outlet_stock DROP COLUMN IF EXISTS movement_seq;
-- ============================================================================
