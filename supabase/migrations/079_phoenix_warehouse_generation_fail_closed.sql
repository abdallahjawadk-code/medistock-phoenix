-- ============================================================================
-- WAREHOUSE-GENERATION-FAIL-CLOSED-079-A
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply via Supabase Dashboard -> SQL Editor, AFTER 078, and only after reading
-- this file in full.
--
-- VERIFICATION STATUS: unlike 078 at authoring time, this migration HAS been
-- executed. 001-078 were applied to a disposable PostgreSQL 18.4 cluster and
-- 079 was applied on top, with the concurrency suite re-run afterwards. See
-- docs/phoenix/migration-078-079-dynamic-validation.md. The production database
-- is PostgreSQL 17.6; the closest locally available major was 18.
--
-- STRATEGY: REPLACE IN PLACE, no signature change.
--   Both guarded functions keep their EXACT argument lists, so CREATE OR REPLACE
--   genuinely replaces them and NO overload is created. Verified by a
--   post-condition below.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS CHANGES AND WHY
-- ─────────────────────────────────────────────────────────────────────────────
-- 078 accepted p_expected_generation = NULL as "unguarded", so that it could be
-- applied while the pre-078 frontend was still live. That was correct for the
-- transition and is WRONG as a resting state: a guarded entry point that
-- silently accepts NULL is one client bug away from being no guard at all, and
-- the failure is invisible — the receipt succeeds.
--
-- From 079 the guarded RPCs FAIL CLOSED:
--
--   p_expected_generation IS NULL  ->  RAISE expected_generation_required (23514)
--
-- A caller that cannot prove a generation must not reach the guarded path at
-- all. The client enforces the same rule before it calls (see
-- warehouse-intake.service.ts: a generation read that fails yields an error
-- result, never a null that would post unguarded).
--
-- TRANSITION COMPATIBILITY IS PRESERVED, deliberately: the LEGACY
-- phoenix_receive_warehouse_stock / phoenix_apply_warehouse_stock_movement are
-- untouched and still callable. A client mid-deploy is never broken by 079. The
-- legacy callables are removed by the CUTOVER migration 080, which is applied
-- only after client parity is observed.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY "NO ROW" IS STILL GENERATION 0 AND NOT AN ERROR
-- ─────────────────────────────────────────────────────────────────────────────
-- A brand-new lot legitimately has no row, and a first receipt legitimately
-- expects 0. Making absence an error would make the FIRST receipt impossible.
-- Absence is therefore an explicit 0, exactly as in 078, and that is what makes
-- the two-device new-lot race resolve: the loser's expected 0 no longer matches
-- the winner's 1. This is asserted dynamically, not just by reading the code.
--
-- PRECONDITIONS: 078 applied (movement_seq + both guarded RPCs present).
-- ============================================================================

BEGIN;

DO $precond$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='warehouse_stock'
                    AND column_name='movement_seq') THEN
    RAISE EXCEPTION 'precondition failed: warehouse_stock.movement_seq missing — apply 078 first';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='phoenix_receive_warehouse_stock_guarded') <> 1 THEN
    RAISE EXCEPTION 'precondition failed: expected exactly 1 phoenix_receive_warehouse_stock_guarded';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='phoenix_apply_warehouse_stock_movement_guarded') <> 1 THEN
    RAISE EXCEPTION 'precondition failed: expected exactly 1 phoenix_apply_warehouse_stock_movement_guarded';
  END IF;
END;
$precond$;

-- ── A. Guarded receipt: reject a missing generation ─────────────────────────

CREATE OR REPLACE FUNCTION public.phoenix_receive_warehouse_stock_guarded(
  p_request_id             uuid,
  p_warehouse_id           uuid,
  p_scientific_name        text,
  p_quantity               integer,
  p_has_no_national_code   boolean,
  p_has_no_batch_number    boolean,
  p_expected_generation    bigint  DEFAULT NULL,
  p_central_item_id        uuid    DEFAULT NULL,
  p_trade_name             text    DEFAULT NULL,
  p_concentration          text    DEFAULT NULL,
  p_dosage_form            text    DEFAULT NULL,
  p_unit                   text    DEFAULT NULL,
  p_national_code          text    DEFAULT NULL,
  p_batch_number           text    DEFAULT NULL,
  p_expiry_date            date    DEFAULT NULL,
  p_unit_price             numeric DEFAULT NULL,
  p_price_basis            text    DEFAULT NULL,
  p_currency               text    DEFAULT NULL,
  p_supply_type_text       text    DEFAULT NULL,
  p_source_document_number text    DEFAULT NULL,
  p_notes                  text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $guarded_receive$
DECLARE
  v_scientific    text := NULLIF(btrim(p_scientific_name), '');
  v_concentration text := NULLIF(btrim(p_concentration), '');
  v_dosage        text := NULLIF(btrim(p_dosage_form), '');
  v_national      text := NULLIF(btrim(p_national_code), '');
  v_batch         text := NULLIF(btrim(p_batch_number), '');
  v_internal_ref  text;
  v_seq           bigint;
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514';
  END IF;

  -- 079: FAIL CLOSED. The parameter keeps its DEFAULT so the signature — and
  -- therefore the function identity — is unchanged, but omitting it is now an
  -- error rather than a silent bypass.
  IF p_expected_generation IS NULL THEN
    RAISE EXCEPTION 'expected_generation_required'
      USING ERRCODE = '23514',
            DETAIL  = 'the guarded receipt requires a canonical generation; '
                   || 'a caller that cannot prove one must not post';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 65065));

  -- REPLAY FIRST, so a lost-response retry stays idempotent. Its expected
  -- generation is necessarily stale by exactly its own committed post.
  IF EXISTS (
    SELECT 1 FROM public.warehouse_stock_movements m
     WHERE m.reference_type = 'warehouse_request'
       AND m.reference_id   = p_request_id
  ) THEN
    RETURN public.phoenix_receive_warehouse_stock(
      p_request_id, p_warehouse_id, p_scientific_name, p_quantity,
      p_has_no_national_code, p_has_no_batch_number, p_central_item_id,
      p_trade_name, p_concentration, p_dosage_form, p_unit, p_national_code,
      p_batch_number, p_expiry_date, p_unit_price, p_price_basis, p_currency,
      p_supply_type_text, p_source_document_number, p_notes
    );
  END IF;

  v_internal_ref := CASE
    WHEN p_has_no_batch_number THEN 'WSNB-' || replace(p_request_id::text, '-', '')
    ELSE NULL
  END;

  SELECT s.movement_seq
    INTO v_seq
    FROM public.warehouse_stock s
   WHERE s.warehouse_id = p_warehouse_id
     AND s.scientific_name = v_scientific
     AND COALESCE(s.concentration, '') = COALESCE(v_concentration, '')
     AND COALESCE(s.dosage_form, '')   = COALESCE(v_dosage, '')
     AND COALESCE(s.national_code, '') = COALESCE(v_national, '')
     AND COALESCE(s.batch_number, '')  = COALESCE(v_batch, '')
     AND COALESCE(s.expiry_date, DATE '0001-01-01')
         = COALESCE(p_expiry_date, DATE '0001-01-01')
     AND COALESCE(s.internal_batch_reference, '') = COALESCE(v_internal_ref, '')
     FOR UPDATE;

  -- Absence IS generation 0 — what a first receipt expects, and what the loser
  -- of a new-lot race no longer sees once the winner's row exists at 1.
  v_seq := COALESCE(v_seq, 0);

  IF v_seq IS DISTINCT FROM p_expected_generation THEN
    RAISE EXCEPTION 'warehouse_receipt_generation_conflict'
      USING ERRCODE = '40001',
            DETAIL  = format('expected generation %s, canonical generation %s',
                             p_expected_generation, v_seq);
  END IF;

  RETURN public.phoenix_receive_warehouse_stock(
    p_request_id, p_warehouse_id, p_scientific_name, p_quantity,
    p_has_no_national_code, p_has_no_batch_number, p_central_item_id,
    p_trade_name, p_concentration, p_dosage_form, p_unit, p_national_code,
    p_batch_number, p_expiry_date, p_unit_price, p_price_basis, p_currency,
    p_supply_type_text, p_source_document_number, p_notes
  );
END;
$guarded_receive$;

-- ── B. Guarded adjustment: reject a missing generation ──────────────────────

CREATE OR REPLACE FUNCTION public.phoenix_apply_warehouse_stock_movement_guarded(
  p_request_id             uuid,
  p_warehouse_stock_id     uuid,
  p_movement_type          text,
  p_amount                 integer,
  p_reason                 text,
  p_expected_generation    bigint DEFAULT NULL,
  p_source_document_number text   DEFAULT NULL,
  p_notes                  text   DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $guarded_movement$
DECLARE
  v_seq   bigint;
  v_found boolean;
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514';
  END IF;

  IF p_expected_generation IS NULL THEN
    RAISE EXCEPTION 'expected_generation_required'
      USING ERRCODE = '23514',
            DETAIL  = 'the guarded adjustment requires a canonical generation';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 65065));

  IF EXISTS (
    SELECT 1 FROM public.warehouse_stock_movements m
     WHERE m.reference_type = 'warehouse_request'
       AND m.reference_id   = p_request_id
  ) THEN
    RETURN public.phoenix_apply_warehouse_stock_movement(
      p_request_id, p_warehouse_stock_id, p_movement_type, p_amount,
      p_reason, p_source_document_number, p_notes
    );
  END IF;

  -- Addressed by id, so no identity reconstruction. A missing/invisible row is
  -- left to the legacy RPC to report, so this cannot become an existence oracle.
  SELECT s.movement_seq, true
    INTO v_seq, v_found
    FROM public.warehouse_stock s
   WHERE s.id = p_warehouse_stock_id
     FOR UPDATE;

  IF COALESCE(v_found, false) AND v_seq IS DISTINCT FROM p_expected_generation THEN
    RAISE EXCEPTION 'warehouse_receipt_generation_conflict'
      USING ERRCODE = '40001',
            DETAIL  = format('expected generation %s, canonical generation %s',
                             p_expected_generation, v_seq);
  END IF;

  RETURN public.phoenix_apply_warehouse_stock_movement(
    p_request_id, p_warehouse_stock_id, p_movement_type, p_amount,
    p_reason, p_source_document_number, p_notes
  );
END;
$guarded_movement$;

COMMIT;

-- ============================================================================
-- POST-CONDITIONS — run AFTER apply. Read-only.
-- ============================================================================
-- 1. Still exactly ONE of each function (CREATE OR REPLACE replaced, not
--    overloaded):
--
--    SELECT p.proname, count(*) FROM pg_proc p
--      JOIN pg_namespace n ON n.oid=p.pronamespace
--     WHERE n.nspname='public' AND p.proname LIKE '%_guarded'
--     GROUP BY p.proname;      -- expect 1 each
--
-- 2. Grants and search_path survived the replace:
--
--    SELECT proname, prosecdef, proconfig FROM pg_proc p
--      JOIN pg_namespace n ON n.oid=p.pronamespace
--     WHERE n.nspname='public' AND proname LIKE '%_guarded';
--    -- expect prosecdef=t and {search_path=public, pg_temp}
--
-- 3. A NULL generation is now refused (staging only — this WRITES on success,
--    so it must FAIL; run inside a transaction and roll back):
--
--    BEGIN;
--      SELECT public.phoenix_receive_warehouse_stock_guarded(
--        gen_random_uuid(), '<warehouse-uuid>', 'Probe', 1, true, true, NULL);
--      -- expect ERROR: expected_generation_required (23514)
--    ROLLBACK;
--
-- ============================================================================
-- ROLLBACK / CONTAINMENT
-- ============================================================================
-- Re-apply 078's section B and C bodies to restore NULL-tolerant behaviour.
-- Nothing structural changes here: no column, trigger, grant or signature is
-- touched, so there is no data to restore.
--
-- Containment without any migration: point the client back at the LEGACY RPC
-- names, which 079 does not modify.
-- ============================================================================
