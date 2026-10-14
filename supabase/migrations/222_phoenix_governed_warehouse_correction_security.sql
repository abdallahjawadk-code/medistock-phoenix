-- ============================================================================
-- MEDISTOCK PHOENIX — OPS2-F1 — GOVERNED WAREHOUSE CORRECTION — CANDIDATE v2
-- PROPOSED NUMBERED SCRATCH ARTIFACT M222 — NOT APPROVED FOR APPLY.
-- M222 reservation tentatively reassigned under Owner Route A for this
-- specific OPS2-F1 v2 candidate only; M221 remains a separate prerequisite.
-- Supersedes candidate v1 (SHA-256 8f5f9b5d…, kept unchanged for comparison).
--
-- RELEASE STATUS: LOCAL CANDIDATE ONLY — NOT APPROVED FOR PRODUCTION APPLY.
-- FUTURE ROUTE, IF SEPARATELY OWNER-APPROVED: pinned single-migration governed executor on master.
-- Uncontrolled/direct db push, SQL Editor apply, and automatic deployment are NOT authorized.
--
-- INVARIANT (OPS2-F1): holding warehouse_stock.correct is never unilateral
-- approval. An authenticated caller can post a caller-chosen warehouse quantity
-- target (movement_type 'correction' or 'set_exact') ONLY through
--   (a) phoenix_request_warehouse_stock_correction, when the variance is within
--       the organization's phoenix_variance_approval_policy threshold
--       (absent row = 0), or
--   (b) phoenix_approve_warehouse_stock_correction, by a person other than the
--       proposer holding warehouse_stock.approve_correction (101/133, unchanged).
--
-- v2 REPLAY BINDING (Director G-REVIEW FIX REQUIRED): a request id is bound to
-- its original requester, organization, lot and approved payload. A replay is
-- answered ONLY after the caller's CURRENT identity and scoped authority on the
-- lot are re-proved, and ONLY to the original requester with the identical
-- payload. Any other caller or payload receives request_id_conflict with no
-- request data; an unauthorized caller receives the ordinary refusal first.
--
-- WHAT CHANGES
--   A. NEW owner-only internal applier _phoenix_apply_governed_warehouse_correction:
--      the within-threshold branch of (a); generation guard as in 186; a replay is
--      answered only to the original actor, on the same lot, for a correction.
--   B. phoenix_request_warehouse_stock_correction: the 101 contract, with
--      authorization BEFORE any replay, a payload- and requester-bound replay of a
--      queued/decided request, an applied within-threshold request always answered
--      as its own replay, and the within-threshold branch calling A.
--   C. phoenix_apply_warehouse_stock_movement_guarded: the 186 body plus the
--      refusal of 'correction' / 'set_exact' for every role and warehouse kind,
--      after a replay branch that never answers another actor's correction.
-- WHAT DOES NOT CHANGE
--   the canonical writer, the approve RPC, add/subtract (central) and their 103
--   refusals (institution), receipts, transfers, dispatch, returns, quarantine
--   release, outlet-return exception resolution, every grant other than A's,
--   RLS, role defaults, permission keys, threshold policy, ledger schema and
--   reference vocabulary.
-- ============================================================================

BEGIN;

DO $precond$
DECLARE
  v_count integer;
BEGIN
  IF to_regprocedure('public.phoenix_apply_warehouse_stock_movement_guarded(uuid,uuid,text,integer,text,bigint,text,text)') IS NULL
     OR to_regprocedure('public.phoenix_apply_warehouse_stock_movement(uuid,uuid,text,integer,text,text,text,text)') IS NULL
     OR to_regprocedure('public.phoenix_request_warehouse_stock_correction(uuid,uuid,integer,text,bigint,text,text)') IS NULL
     OR to_regprocedure('public.phoenix_approve_warehouse_stock_correction(uuid,bigint)') IS NULL THEN
    RAISE EXCEPTION 'OPS2F1 PRECONDITION FAILED: correction writer/workflow signature missing';
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('phoenix_apply_warehouse_stock_movement_guarded', 'phoenix_apply_warehouse_stock_movement',
                       'phoenix_request_warehouse_stock_correction', 'phoenix_approve_warehouse_stock_correction',
                       '_phoenix_apply_governed_warehouse_correction');
  IF v_count <> 4 THEN
    RAISE EXCEPTION 'OPS2F1 PRECONDITION FAILED: expected exactly the 4 existing functions and no applier, found %', v_count;
  END IF;

  IF has_function_privilege('authenticated', 'public.phoenix_apply_warehouse_stock_movement(uuid,uuid,text,integer,text,text,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.phoenix_apply_warehouse_stock_movement(uuid,uuid,text,integer,text,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'OPS2F1 PRECONDITION FAILED: the canonical writer is client-executable';
  END IF;
END;
$precond$;

-- ── A. Owner-only internal applier ──────────────────────────────────────────
CREATE FUNCTION public._phoenix_apply_governed_warehouse_correction(
  p_request_id             uuid,
  p_warehouse_stock_id     uuid,
  p_new_quantity           integer,
  p_reason                 text,
  p_expected_generation    bigint DEFAULT NULL,
  p_source_document_number text   DEFAULT NULL,
  p_notes                  text   DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $governed$
DECLARE
  v_seq          bigint;
  v_found        boolean;
  v_prior_found  boolean;
  v_prior_actor  uuid;
  v_prior_stock  uuid;
  v_prior_type   text;
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 65065));

  SELECT m.actor_id, m.warehouse_stock_id, m.movement_type
    INTO v_prior_actor, v_prior_stock, v_prior_type
    FROM public.warehouse_stock_movements m
   WHERE m.reference_type = 'warehouse_request'
     AND m.reference_id   = p_request_id
   LIMIT 1;
  v_prior_found := FOUND;

  -- v2: an already-posted id is answered only to its ORIGINAL actor, for the
  -- same lot, as a correction; the canonical writer then checks the payload
  -- fingerprint. Anything else is a conflict and returns no movement data.
  IF v_prior_found AND (v_prior_actor IS DISTINCT FROM auth.uid()
                        OR v_prior_stock IS DISTINCT FROM p_warehouse_stock_id
                        OR v_prior_type IS DISTINCT FROM 'correction') THEN
    RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505';
  END IF;

  -- Generation guard only for a NEW movement (same order as the 186 wrapper).
  IF NOT v_prior_found AND p_expected_generation IS NOT NULL THEN
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

  -- The canonical writer re-checks warehouse_stock.correct for auth.uid() (the
  -- requester), owns the request fingerprint and the replay answer.
  RETURN public.phoenix_apply_warehouse_stock_movement(
    p_request_id, p_warehouse_stock_id, 'correction', p_new_quantity,
    p_reason, p_source_document_number, p_notes, 'corrected'
  );
END;
$governed$;

REVOKE ALL ON FUNCTION public._phoenix_apply_governed_warehouse_correction(
  uuid, uuid, integer, text, bigint, text, text
) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public._phoenix_apply_governed_warehouse_correction(
  uuid, uuid, integer, text, bigint, text, text
) IS 'OPS2-F1 owner-only within-threshold correction applier; reachable only from phoenix_request_warehouse_stock_correction; replays only to the original actor.';

-- ── B. Request RPC (101 contract; authorization before replay; bound replay) ─
CREATE OR REPLACE FUNCTION public.phoenix_request_warehouse_stock_correction(
  p_request_id             uuid,
  p_warehouse_stock_id     uuid,
  p_new_quantity           integer,
  p_reason                 text,
  p_expected_generation    bigint DEFAULT NULL,
  p_source_document_number text   DEFAULT NULL,
  p_notes                  text   DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $request$
DECLARE
  v_actor      uuid := auth.uid();
  v_stock      public.warehouse_stock%ROWTYPE;
  v_existing   public.phoenix_warehouse_correction_requests%ROWTYPE;
  v_threshold  integer;
  v_variance   integer;
  v_reason     text := NULLIF(btrim(p_reason), '');
  v_source_doc text := NULLIF(btrim(p_source_document_number), '');
  v_notes      text := NULLIF(btrim(p_notes), '');
  v_req_id     uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_warehouse_stock_id IS NULL THEN
    RAISE EXCEPTION 'warehouse_stock_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_new_quantity IS NULL OR p_new_quantity < 0 THEN
    RAISE EXCEPTION 'quantity_must_be_non_negative' USING ERRCODE = '23514';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'warehouse_correction_reason_required' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 101101));

  -- v2: the caller's CURRENT identity and scoped authority on the lot are proved
  -- BEFORE anything about a prior request is read or returned. A suspended,
  -- missing or de-scoped profile is refused here exactly as for a new request.
  SELECT * INTO v_stock FROM public.warehouse_stock WHERE id = p_warehouse_stock_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse_stock_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'warehouse_stock.correct', v_stock.organization_id, v_stock.warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_warehouse_stock_movement' USING ERRCODE = '42501';
  END IF;

  -- v2: a queued or decided request replays ONLY to its original requester, for
  -- the same organization and lot, with the identical approved payload.
  SELECT * INTO v_existing
  FROM public.phoenix_warehouse_correction_requests WHERE underlying_request_id = p_request_id;
  IF FOUND THEN
    IF v_existing.proposed_by            IS DISTINCT FROM v_actor
       OR v_existing.organization_id        IS DISTINCT FROM v_stock.organization_id
       OR v_existing.warehouse_stock_id     IS DISTINCT FROM v_stock.id
       OR v_existing.new_quantity           IS DISTINCT FROM p_new_quantity
       OR v_existing.reason                 IS DISTINCT FROM v_reason
       OR v_existing.source_document_number IS DISTINCT FROM v_source_doc
       OR v_existing.notes                  IS DISTINCT FROM v_notes THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true,
      'correction_request_id', v_existing.id, 'status', v_existing.status, 'requires_approval', true
    );
  END IF;

  -- v2: an id that already posted a within-threshold movement is ALWAYS answered
  -- as that movement's replay (bound to its actor, lot and payload inside A),
  -- never re-evaluated against a stock level or threshold that moved since.
  IF EXISTS (
    SELECT 1 FROM public.warehouse_stock_movements m
     WHERE m.reference_type = 'warehouse_request'
       AND m.reference_id   = p_request_id
  ) THEN
    RETURN public._phoenix_apply_governed_warehouse_correction(
      p_request_id, p_warehouse_stock_id, p_new_quantity, v_reason,
      p_expected_generation, p_source_document_number, p_notes
    ) || jsonb_build_object('requires_approval', false);
  END IF;

  v_variance := abs(p_new_quantity - v_stock.on_hand_quantity);

  SELECT threshold_quantity INTO v_threshold
    FROM public.phoenix_variance_approval_policy WHERE organization_id = v_stock.organization_id;
  v_threshold := COALESCE(v_threshold, 0);

  IF v_variance <= v_threshold THEN
    RETURN public._phoenix_apply_governed_warehouse_correction(
      p_request_id, p_warehouse_stock_id, p_new_quantity, v_reason,
      p_expected_generation, p_source_document_number, p_notes
    ) || jsonb_build_object('requires_approval', false);
  END IF;

  INSERT INTO public.phoenix_warehouse_correction_requests (
    organization_id, warehouse_stock_id, on_hand_before, new_quantity, variance,
    reason, source_document_number, notes, proposed_by, underlying_request_id
  ) VALUES (
    v_stock.organization_id, v_stock.id, v_stock.on_hand_quantity, p_new_quantity, v_variance,
    v_reason, v_source_doc, v_notes, v_actor, p_request_id
  )
  RETURNING id INTO v_req_id;

  RETURN jsonb_build_object(
    'ok', true, 'correction_request_id', v_req_id, 'status', 'pending',
    'requires_approval', true, 'variance', v_variance, 'threshold', v_threshold
  );
END;
$request$;

-- Identical to 101:189-190 (CREATE OR REPLACE preserves the ACL; restated for review).
REVOKE ALL ON FUNCTION public.phoenix_request_warehouse_stock_correction(uuid, uuid, integer, text, bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_request_warehouse_stock_correction(uuid, uuid, integer, text, bigint, text, text) TO authenticated;

-- ── C. Generic guarded writer (186 body + bound replay + one refusal) ────────
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
  v_seq          bigint;
  v_found        boolean;
  v_prior_actor  uuid;
  v_prior_type   text;
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 65065));

  SELECT m.actor_id, m.movement_type
    INTO v_prior_actor, v_prior_type
    FROM public.warehouse_stock_movements m
   WHERE m.reference_type = 'warehouse_request'
     AND m.reference_id   = p_request_id
   LIMIT 1;
  IF FOUND THEN
    -- v2: an already-posted correction is never answered to another actor.
    IF v_prior_type IN ('correction', 'set_exact') AND v_prior_actor IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN public.phoenix_apply_warehouse_stock_movement(
      p_request_id, p_warehouse_stock_id, p_movement_type, p_amount,
      p_reason, p_source_document_number, p_notes,
      CASE WHEN p_movement_type IN ('correction', 'set_exact') THEN 'corrected' ELSE NULL END
    );
  END IF;

  -- OPS2-F1: a caller-chosen quantity target is never posted unilaterally.
  IF p_movement_type IN ('correction', 'set_exact') THEN
    RAISE EXCEPTION 'warehouse_correction_requires_governed_request' USING ERRCODE = '42501',
      DETAIL = 'use phoenix_request_warehouse_stock_correction (threshold / second-person approval)';
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
    p_reason, p_source_document_number, p_notes, NULL
  );
END;
$guarded_movement$;

-- Identical to 186:213-218 (CREATE OR REPLACE preserves the ACL; restated for review).
REVOKE ALL ON FUNCTION public.phoenix_apply_warehouse_stock_movement_guarded(
  uuid, uuid, text, integer, text, bigint, text, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_apply_warehouse_stock_movement_guarded(
  uuid, uuid, text, integer, text, bigint, text, text
) TO authenticated;

COMMENT ON FUNCTION public.phoenix_apply_warehouse_stock_movement_guarded(
  uuid, uuid, text, integer, text, bigint, text, text
) IS 'Generation-guarded warehouse movement: add/subtract (central only, 103). correction/set_exact are refused (OPS2-F1): use phoenix_request_warehouse_stock_correction.';

-- ── D. Verification: catalog facts and BEHAVIOUR only — no source-text matching,
--       so neither comments nor formatting can make it pass or fail. ──────────
DO $verify$
DECLARE
  v_applier    oid := 'public._phoenix_apply_governed_warehouse_correction(uuid,uuid,integer,text,bigint,text,text)'::regprocedure;
  v_canonical  oid := 'public.phoenix_apply_warehouse_stock_movement(uuid,uuid,text,integer,text,text,text,text)'::regprocedure;
  v_guarded    oid := 'public.phoenix_apply_warehouse_stock_movement_guarded(uuid,uuid,text,integer,text,bigint,text,text)'::regprocedure;
  v_request    oid := 'public.phoenix_request_warehouse_stock_correction(uuid,uuid,integer,text,bigint,text,text)'::regprocedure;
  v_owner      oid;
  v_type       text;
  v_state      text;
  v_msg        text;
BEGIN
  -- 1. The applier: SECURITY DEFINER, pinned search_path, same owner as the
  --    canonical writer, and no EXECUTE for anyone but that owner.
  SELECT proowner INTO v_owner FROM pg_proc WHERE oid = v_canonical;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = v_applier AND p.prosecdef AND p.proowner = v_owner
                    AND p.proconfig = ARRAY['search_path=public, pg_temp']) THEN
    RAISE EXCEPTION 'VERIFY FAILED (OPS2F1): applier definer/owner/search_path contract broken';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
              WHERE p.oid = v_applier AND a.grantee <> p.proowner) THEN
    RAISE EXCEPTION 'VERIFY FAILED (OPS2F1): applier is executable by a role other than its owner';
  END IF;

  -- 2. The canonical writer stays closed to clients; the two client entry
  --    points keep exactly their reviewed client grant.
  IF has_function_privilege('authenticated', v_canonical, 'EXECUTE') OR has_function_privilege('anon', v_canonical, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (OPS2F1): canonical writer became client-executable';
  END IF;
  IF NOT has_function_privilege('authenticated', v_guarded, 'EXECUTE') OR has_function_privilege('anon', v_guarded, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_request, 'EXECUTE') OR has_function_privilege('anon', v_request, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (OPS2F1): client entry-point grants changed';
  END IF;

  -- 3. BEHAVIOUR: the generic writer refuses both caller-chosen-target types with
  --    the governed-request error, BEFORE any stock lookup or authorization —
  --    proven with fresh random ids, inside subtransactions that roll back.
  FOREACH v_type IN ARRAY ARRAY['correction', 'set_exact'] LOOP
    v_state := NULL;
    BEGIN
      PERFORM public.phoenix_apply_warehouse_stock_movement_guarded(
        gen_random_uuid(), gen_random_uuid(), v_type, 1, 'ops2f1 verify', NULL, NULL, NULL);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    IF v_state IS DISTINCT FROM '42501' OR v_msg IS DISTINCT FROM 'warehouse_correction_requires_governed_request' THEN
      RAISE EXCEPTION 'VERIFY FAILED (OPS2F1): guarded writer did not refuse % (state %, message %)', v_type, v_state, v_msg;
    END IF;
  END LOOP;

  -- 4. BEHAVIOUR: add/subtract are NOT caught by the new refusal.
  FOREACH v_type IN ARRAY ARRAY['add', 'subtract'] LOOP
    v_msg := NULL;
    BEGIN
      PERFORM public.phoenix_apply_warehouse_stock_movement_guarded(
        gen_random_uuid(), gen_random_uuid(), v_type, 1, 'ops2f1 verify', NULL, NULL, NULL);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    END;
    IF v_msg = 'warehouse_correction_requires_governed_request' THEN
      RAISE EXCEPTION 'VERIFY FAILED (OPS2F1): guarded writer refuses % (must remain on its 103 path)', v_type;
    END IF;
  END LOOP;
END;
$verify$;

COMMIT;
