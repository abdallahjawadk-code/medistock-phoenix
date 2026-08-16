-- ============================================================================
-- MEDISTOCK PHOENIX — CORRECTION REASON-CODE WRAPPER PARITY — 186
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply after 185.
--
-- Migration 126/131 added a trailing reason_code argument to the canonical
-- warehouse/outlet correction writers. Their guarded public entry points kept
-- their historical signatures, but still delegated with the superseded arity.
-- This migration changes only those two wrapper bodies. Correction workflows
-- own the narrow canonical code `corrected`; add/subtract keep the canonical
-- writer's existing default behavior by receiving NULL.
-- ============================================================================

BEGIN;

DO $precond$
DECLARE
  v_count integer;
BEGIN
  IF to_regprocedure('public.phoenix_count_outlet_stock_guarded(uuid,uuid,integer,text,bigint,text)') IS NULL
     OR to_regprocedure('public.phoenix_apply_warehouse_stock_movement_guarded(uuid,uuid,text,integer,text,bigint,text,text)') IS NULL THEN
    RAISE EXCEPTION '186 PRECONDITION FAILED: guarded correction wrapper signature missing';
  END IF;

  IF to_regprocedure('public.phoenix_count_outlet_stock(uuid,uuid,integer,text,text,text)') IS NULL
     OR to_regprocedure('public.phoenix_apply_warehouse_stock_movement(uuid,uuid,text,integer,text,text,text,text)') IS NULL THEN
    RAISE EXCEPTION '186 PRECONDITION FAILED: current reason-code writer signature missing';
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN (
       'phoenix_count_outlet_stock_guarded',
       'phoenix_apply_warehouse_stock_movement_guarded',
       'phoenix_count_outlet_stock',
       'phoenix_apply_warehouse_stock_movement'
     );
  IF v_count <> 4 THEN
    RAISE EXCEPTION '186 PRECONDITION FAILED: unexpected correction writer overload count %', v_count;
  END IF;

  SELECT count(*) INTO v_count
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name IN ('warehouse_stock_movements', 'outlet_stock_movements')
     AND column_name = 'reason_code';
  IF v_count <> 2 THEN
    RAISE EXCEPTION '186 PRECONDITION FAILED: migration 125 reason-code ledger infrastructure missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.warehouse_stock_movements'::regclass
       AND conname = 'warehouse_stock_movements_reason_code_chk'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.outlet_stock_movements'::regclass
       AND conname = 'outlet_stock_movements_reason_code_chk'
  ) THEN
    RAISE EXCEPTION '186 PRECONDITION FAILED: migration 125 reason-code vocabulary constraints missing';
  END IF;

  IF to_regclass('public.phoenix_variance_approval_policy') IS NULL
     OR to_regclass('public.phoenix_stock_correction_requests') IS NULL
     OR to_regclass('public.phoenix_warehouse_correction_requests') IS NULL THEN
    RAISE EXCEPTION '186 PRECONDITION FAILED: correction approval infrastructure missing';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.phoenix_count_outlet_stock_guarded(uuid,uuid,integer,text,bigint,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.phoenix_apply_warehouse_stock_movement_guarded(uuid,uuid,text,integer,text,bigint,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.phoenix_count_outlet_stock_guarded(uuid,uuid,integer,text,bigint,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.phoenix_apply_warehouse_stock_movement_guarded(uuid,uuid,text,integer,text,bigint,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '186 PRECONDITION FAILED: guarded wrapper ACL differs from reviewed 185 tip';
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
   WHERE n.nspname = 'public'
     AND p.proname IN ('phoenix_count_outlet_stock_guarded', 'phoenix_apply_warehouse_stock_movement_guarded')
     AND acl.grantee = 0
     AND acl.privilege_type = 'EXECUTE';
  IF v_count <> 0 THEN
    RAISE EXCEPTION '186 PRECONDITION FAILED: guarded wrapper PUBLIC execute privilege present';
  END IF;
END;
$precond$;

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

  IF EXISTS (
    SELECT 1 FROM public.outlet_stock_movements m
     WHERE m.reference_type = 'outlet_request'
       AND m.reference_id   = p_request_id
  ) THEN
    RETURN public.phoenix_count_outlet_stock(
      p_request_id, p_outlet_stock_id, p_counted_quantity, p_reason, p_notes, 'corrected'
    );
  END IF;

  IF p_expected_generation IS NOT NULL THEN
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
    p_request_id, p_outlet_stock_id, p_counted_quantity, p_reason, p_notes, 'corrected'
  );
END;
$guarded_count$;

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

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 65065));

  IF EXISTS (
    SELECT 1 FROM public.warehouse_stock_movements m
     WHERE m.reference_type = 'warehouse_request'
       AND m.reference_id   = p_request_id
  ) THEN
    RETURN public.phoenix_apply_warehouse_stock_movement(
      p_request_id, p_warehouse_stock_id, p_movement_type, p_amount,
      p_reason, p_source_document_number, p_notes,
      CASE WHEN p_movement_type IN ('correction', 'set_exact') THEN 'corrected' ELSE NULL END
    );
  END IF;

  IF p_expected_generation IS NOT NULL THEN
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
  END IF;

  RETURN public.phoenix_apply_warehouse_stock_movement(
    p_request_id, p_warehouse_stock_id, p_movement_type, p_amount,
    p_reason, p_source_document_number, p_notes,
    CASE WHEN p_movement_type IN ('correction', 'set_exact') THEN 'corrected' ELSE NULL END
  );
END;
$guarded_movement$;

REVOKE ALL ON FUNCTION public.phoenix_count_outlet_stock_guarded(
  uuid, uuid, integer, text, bigint, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_count_outlet_stock_guarded(
  uuid, uuid, integer, text, bigint, text
) TO authenticated;

REVOKE ALL ON FUNCTION public.phoenix_apply_warehouse_stock_movement_guarded(
  uuid, uuid, text, integer, text, bigint, text, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_apply_warehouse_stock_movement_guarded(
  uuid, uuid, text, integer, text, bigint, text, text
) TO authenticated;

COMMENT ON FUNCTION public.phoenix_count_outlet_stock_guarded(
  uuid, uuid, integer, text, bigint, text
) IS 'Generation-guarded outlet count. Correction workflow owns reason_code=corrected.';
COMMENT ON FUNCTION public.phoenix_apply_warehouse_stock_movement_guarded(
  uuid, uuid, text, integer, text, bigint, text, text
) IS 'Generation-guarded warehouse movement. correction/set_exact own reason_code=corrected.';

DO $verify$
DECLARE
  v_definition text;
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('phoenix_count_outlet_stock_guarded', 'phoenix_apply_warehouse_stock_movement_guarded');
  IF v_count <> 2 THEN
    RAISE EXCEPTION '186 VERIFY FAILED: guarded wrapper overload count is %', v_count;
  END IF;

  SELECT pg_get_functiondef('public.phoenix_count_outlet_stock_guarded(uuid,uuid,integer,text,bigint,text)'::regprocedure)
    INTO v_definition;
  IF length(v_definition) - length(replace(v_definition, '''corrected''', '')) <> 22 THEN
    RAISE EXCEPTION '186 VERIFY FAILED: outlet wrapper does not own corrected on both delegates';
  END IF;

  SELECT pg_get_functiondef('public.phoenix_apply_warehouse_stock_movement_guarded(uuid,uuid,text,integer,text,bigint,text,text)'::regprocedure)
    INTO v_definition;
  IF length(v_definition) - length(replace(v_definition, 'CASE WHEN', '')) <> 18 THEN
    RAISE EXCEPTION '186 VERIFY FAILED: warehouse wrapper does not derive reason code on both delegates';
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('phoenix_count_outlet_stock_guarded', 'phoenix_apply_warehouse_stock_movement_guarded')
     AND p.proconfig @> ARRAY['search_path=public, pg_temp'];
  IF v_count <> 2 THEN
    RAISE EXCEPTION '186 VERIFY FAILED: guarded wrapper search_path mismatch';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.phoenix_count_outlet_stock_guarded(uuid,uuid,integer,text,bigint,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.phoenix_apply_warehouse_stock_movement_guarded(uuid,uuid,text,integer,text,bigint,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.phoenix_count_outlet_stock_guarded(uuid,uuid,integer,text,bigint,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.phoenix_apply_warehouse_stock_movement_guarded(uuid,uuid,text,integer,text,bigint,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '186 VERIFY FAILED: guarded wrapper ACL mismatch';
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
   WHERE n.nspname = 'public'
     AND p.proname IN ('phoenix_count_outlet_stock_guarded', 'phoenix_apply_warehouse_stock_movement_guarded')
     AND acl.grantee = 0
     AND acl.privilege_type = 'EXECUTE';
  IF v_count <> 0 THEN
    RAISE EXCEPTION '186 VERIFY FAILED: guarded wrapper PUBLIC execute privilege present';
  END IF;

  RAISE NOTICE 'CORRECTION-REASON-CODE-WRAPPER-PARITY-186: verified.';
END;
$verify$;

COMMIT;
