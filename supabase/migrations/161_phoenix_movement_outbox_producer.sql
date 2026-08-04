-- ============================================================================
-- MOVEMENT-OUTBOX-PRODUCER-161
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply after 160.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SCOPE — D2-3, THE SECOND OUTBOX PRODUCER, MOVEMENT-POSTED ONLY
-- ─────────────────────────────────────────────────────────────────────────────
-- This migration redefines ONE existing function,
-- public.phoenix_capture_movement_posted() (123, extended 124), to
-- additionally append one outbox event per accepted movement-ledger INSERT,
-- via public.phoenix_append_outbox_event_internal() (158). It creates NO new
-- trigger, drops NO existing trigger, and touches NO business table, business
-- RPC, RLS policy, grant, or frontend code. The three tables already wired to
-- phoenix_capture_movement_posted keep the exact same trigger object,
-- unchanged: warehouse_stock_movements, outlet_stock_movements,
-- warehouse_quarantine_stock_movements (123) — confirmed by direct query
-- against the 001->160 replay before writing this file, and re-verified
-- in-transaction below.
--
-- public.phoenix_capture_movement_notification() (099) is NOT touched here.
-- A read-only audit against the live 001->160 replay proved it is not a
-- candidate canonical producer: it writes only to phoenix_notifications
-- (never to phoenix_movement_events — the only three writers into
-- phoenix_movement_events are phoenix_capture_movement_posted,
-- phoenix_capture_lifecycle_event (159), and phoenix_capture_stocktake_
-- recorded (out of D2-3 scope, D2-4's)), and two of its four trigger
-- attachments are ALLOWLIST-gated by TG_ARGV[0] to a narrow subset of
-- movement_type values (outlet_stock_movements: 'dispense,correction' only;
-- warehouse_stock_movements: 'correction' only) — wiring the outbox to it
-- would silently drop an outbox event for every other accepted movement type
-- on those two tables (every transfer/dispatch/receipt/return posting that
-- is not itself a correction), which is a real functional gap, not a
-- narrower-but-equivalent producer. phoenix_capture_movement_posted, by
-- contrast, fires unconditionally on all three tables for every accepted
-- INSERT, exactly matching the canonical, complete movement ledger.
--
-- Because phoenix_capture_movement_notification never writes to
-- phoenix_movement_events, and this migration wires only
-- phoenix_capture_movement_posted, there is no double-emission risk: no two
-- functions observe the same physical movement row and both attempt to
-- append an outbox event for it.
--
-- phoenix_capture_stocktake_recorded() (123) is NOT touched here — stocktake
-- and outlet-return-exception events are separate D2-4-scope producers, not
-- this migration's.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT "ACCEPTED MOVEMENT" MEANS HERE — UNCHANGED FROM 123
-- ─────────────────────────────────────────────────────────────────────────────
-- The function's own existing guard,
--   IF v_org IS NULL THEN RETURN NEW; END IF;
-- already decides, once, whether a row is eligible to own an RLS-scoped
-- ledger entry (never invent an owning organization). The new outbox
-- PERFORM call sits strictly AFTER that guard and after the existing sink
-- INSERT succeeds, so it inherits that exact same accept/reject decision for
-- free — there is no second, independently-maintained notion of "is this
-- movement eligible" to ever disagree with the first. Unlike 159's lifecycle
-- function, this trigger fires on INSERT only (movement rows are pure
-- append-only ledger facts, never updated in place), so there is no
-- same-value-UPDATE / no-op-transition case to guard against here: every
-- accepted INSERT is, by construction, a genuine new movement fact.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- EVENT IDENTITY — REUSING, NOT INVENTING
-- ─────────────────────────────────────────────────────────────────────────────
--   event_key       = 'movement:' || v_dedupe, where v_dedupe is the exact
--                      existing dedupe_key expression (NEW.id::text ||
--                      ':posted') already governing phoenix_movement_events
--                      for this function. The 'movement:' namespace prefix
--                      keeps this producer's keys textually distinct from
--                      159's 'lifecycle:' namespace and any future
--                      producer's own formula, even though
--                      phoenix_outbox_events.event_key is a single shared
--                      UNIQUE column across every producer.
--   event_type      = TG_TABLE_NAME || '.posted' — byte-identical to the
--                      existing event_type already written to
--                      phoenix_movement_events for this function.
--   event_version   = 1 (first version of this event shape).
--   aggregate_type  = TG_TABLE_NAME (the exact source movement table name).
--   aggregate_id    = NEW.id (the movement row's own id — the same value
--                      already written as trace_id/reference_id today).
--   organization_id = v_org — the exact same resolved owning organization
--                      the existing INSERT already uses.
--   actor_id        = v_actor — the exact same actor_id already resolved
--                      from the movement row itself.
--   correlation_id  = v_correlation — the exact same correlation_id already
--                      resolved from the movement row itself, reused only
--                      when genuinely present (NULL otherwise; never
--                      manufactured).
--   causation_id    = v_causation — the exact same causation_id already
--                      resolved from the movement row itself, reused only
--                      when genuinely present (NULL otherwise; never
--                      manufactured).
--   request_id      = NULL. The three movement tables carry a
--                      request_fingerprint TEXT column used for a different
--                      (upstream, RPC-level) idempotency layer — it is not a
--                      UUID-shaped request identity, so reusing it here
--                      would require inventing a value this function has
--                      never resolved, which the D2-3 contract requires
--                      against (same posture 159 already took for the exact
--                      same reason).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- PAYLOAD — MINIMAL, VERSION 1, NOTHING BEYOND WHAT THE FUNCTION ALREADY HAS
-- ─────────────────────────────────────────────────────────────────────────────
-- {source_table, movement_type, quantity_delta, trace_id, reference_id,
-- occurred_at} only, built from v_type/v_delta/NEW.id/v_occurred — values
-- the function has already resolved for the existing INSERT, nothing queried
-- afresh. quantity_delta can be genuinely NULL (a table whose row shape
-- lacks either on_hand_delta or quantity_delta), so jsonb_strip_nulls drops
-- that key rather than writing a JSON null. No actor name/role, no
-- organization name, no OLD/NEW row dump, no patient-sensitive data, no
-- secrets, no authorization claims — the organization and actor UUIDs
-- already exist at the outbox envelope level (organization_id, actor_id
-- columns), so 082/094/159's own "don't duplicate what's already at
-- envelope level" instinct for org/actor names applies here too. No source/
-- destination identifier is included: the audit confirmed the existing
-- function never resolves one today (phoenix_movement_events.source_label/
-- destination_label remain NULL for every posted-sourced row already), so
-- there is nothing "already resolved" for this payload to reuse there.
-- ============================================================================

BEGIN;

-- ── PRECONDITIONS ───────────────────────────────────────────────────────────

DO $precond$
DECLARE
  v_posted_trigger_count int;
  v_fn_src_before text;
BEGIN
  IF to_regclass('public.phoenix_outbox_events') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: phoenix_outbox_events is missing — apply 158 first';
  END IF;
  IF to_regprocedure('public.phoenix_append_outbox_event_internal(text,text,smallint,text,uuid,uuid,jsonb,uuid,uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: phoenix_append_outbox_event_internal is missing — apply 158 first';
  END IF;
  IF (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.relname = 'phoenix_outbox_events')
     IS DISTINCT FROM
     (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.proname = 'phoenix_append_outbox_event_internal') THEN
    RAISE EXCEPTION 'precondition failed: phoenix_outbox_events and phoenix_append_outbox_event_internal must share the same trusted owner';
  END IF;
  IF to_regprocedure('public.phoenix_capture_movement_posted()') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: phoenix_capture_movement_posted() is missing — apply 123/124 first';
  END IF;

  SELECT count(*) INTO v_posted_trigger_count
  FROM pg_trigger t
  JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE p.proname = 'phoenix_capture_movement_posted' AND NOT t.tgisinternal;
  IF v_posted_trigger_count <> 3 THEN
    RAISE EXCEPTION 'precondition failed: expected exactly 3 phoenix_capture_movement_posted attachments, found %', v_posted_trigger_count;
  END IF;

  SELECT pg_get_functiondef(oid) INTO v_fn_src_before
    FROM pg_proc WHERE proname = 'phoenix_capture_movement_posted';
  IF v_fn_src_before LIKE '%phoenix_outbox_events%' OR v_fn_src_before LIKE '%phoenix_append_outbox_event_internal%' THEN
    RAISE EXCEPTION 'precondition failed: phoenix_capture_movement_posted() already references the outbox (161 already applied?)';
  END IF;

  -- 159's lifecycle producer must be present and untouched by this migration.
  IF to_regprocedure('public.phoenix_capture_lifecycle_event()') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: phoenix_capture_lifecycle_event() is missing — apply 159 first';
  END IF;

  IF has_table_privilege('authenticated', 'public.phoenix_outbox_events', 'SELECT') THEN
    RAISE EXCEPTION 'precondition failed: 158''s privilege lockdown on phoenix_outbox_events no longer holds';
  END IF;
  IF has_function_privilege('authenticated', 'public.phoenix_append_outbox_event_internal(text,text,smallint,text,uuid,uuid,jsonb,uuid,uuid,uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'precondition failed: 158''s privilege lockdown on the append helper no longer holds';
  END IF;
END;
$precond$;

-- ── The movement-posted capture function — same signature, one additive call ─

CREATE OR REPLACE FUNCTION public.phoenix_capture_movement_posted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $capture$
DECLARE
  v_new     jsonb := to_jsonb(NEW);
  v_org     uuid  := NULLIF(v_new ->> 'organization_id', '')::uuid;
  v_before  integer := COALESCE(
                          NULLIF(v_new ->> 'on_hand_before', '')::integer,
                          NULLIF(v_new ->> 'quantity_before', '')::integer
                        );
  v_delta   integer := COALESCE(
                          NULLIF(v_new ->> 'on_hand_delta', '')::integer,
                          NULLIF(v_new ->> 'quantity_delta', '')::integer
                        );
  v_after   integer := COALESCE(
                          NULLIF(v_new ->> 'on_hand_after', '')::integer,
                          NULLIF(v_new ->> 'quantity_after', '')::integer
                        );
  v_actor   uuid  := NULLIF(v_new ->> 'actor_id', '')::uuid;
  v_role    text  := v_new ->> 'actor_role';
  v_name    text  := v_new ->> 'actor_name';
  v_type    text  := v_new ->> 'movement_type';
  v_doc     text  := v_new ->> 'source_document_number';
  v_occurred timestamptz := COALESCE(NEW.occurred_at, now());
  v_correlation uuid := NULLIF(v_new ->> 'correlation_id', '')::uuid;
  v_causation   uuid := NULLIF(v_new ->> 'causation_id', '')::uuid;
  v_dedupe  text;
BEGIN
  IF v_org IS NULL THEN
    RETURN NEW;  -- never emit an event with no RLS owner; fail closed, not loud
  END IF;

  v_dedupe := NEW.id::text || ':posted';

  INSERT INTO public.phoenix_movement_events (
    organization_id, trace_id, event_type, occurred_at,
    actor_id, actor_role, actor_name,
    quantity_delta, quantity_before, quantity_after, status_after,
    reference_type, reference_id, notes,
    correlation_id, causation_id,
    dedupe_key
  )
  VALUES (
    v_org,
    NEW.id,
    TG_TABLE_NAME || '.posted',
    v_occurred,
    v_actor, v_role, v_name,
    v_delta, v_before, v_after,
    v_type,
    TG_TABLE_NAME,
    NEW.id,
    v_doc,
    v_correlation, v_causation,
    v_dedupe
  )
  ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;

  -- ── 161: the second outbox producer ─────────────────────────────────────
  -- Fires only after the existing sink write above has succeeded, and
  -- reuses every value this function already resolved — no new lookup, no
  -- new decision about what counts as an accepted movement. If this call
  -- raises (e.g. outbox_event_key_conflict), the exception propagates out
  -- of this trigger exactly like any other unhandled exception here always
  -- has, rolling back this entire transaction — the movement-row INSERT,
  -- the sink INSERT above, and this call are one atomic unit by ordinary
  -- Postgres transaction semantics, not by any new mechanism introduced
  -- here.
  PERFORM public.phoenix_append_outbox_event_internal(
    'movement:' || v_dedupe,
    TG_TABLE_NAME || '.posted',
    1::smallint,
    TG_TABLE_NAME,
    NEW.id,
    v_org,
    jsonb_strip_nulls(jsonb_build_object(
      'source_table', TG_TABLE_NAME,
      'movement_type', v_type,
      'quantity_delta', v_delta,
      'trace_id', NEW.id,
      'reference_id', NEW.id,
      'occurred_at', v_occurred
    )),
    v_actor,
    v_correlation,
    v_causation,
    NULL::uuid
  );

  RETURN NEW;
END;
$capture$;

-- =============================================================================
-- VERIFY — inside the transaction; failure rolls back all of 161
-- =============================================================================

DO $$
DECLARE
  v_fn_src        text;
  v_call_count    int;
  v_trigger_count int;
  v_other_fn_src  text;
  v_lifecycle_call_count int;
BEGIN
  -- 1. Function still exists with the exact zero-argument signature.
  ASSERT to_regprocedure('public.phoenix_capture_movement_posted()') IS NOT NULL,
    'phoenix_capture_movement_posted() must still exist';

  SELECT pg_get_functiondef(oid) INTO v_fn_src
    FROM pg_proc WHERE proname = 'phoenix_capture_movement_posted';

  -- 2. Still SECURITY DEFINER.
  ASSERT (SELECT prosecdef FROM pg_proc WHERE proname = 'phoenix_capture_movement_posted'),
    'phoenix_capture_movement_posted must remain SECURITY DEFINER';

  -- 3. search_path remains pinned.
  ASSERT (
    SELECT proconfig @> ARRAY['search_path=public, pg_temp']::text[]
      FROM pg_proc WHERE proname = 'phoenix_capture_movement_posted'
  ), 'phoenix_capture_movement_posted must keep search_path pinned to public, pg_temp';

  -- 4. Exactly one semantic call site to the append helper.
  v_call_count := (LENGTH(v_fn_src) - LENGTH(REPLACE(v_fn_src, 'phoenix_append_outbox_event_internal', ''))) / LENGTH('phoenix_append_outbox_event_internal');
  ASSERT v_call_count = 1,
    format('expected exactly one reference to phoenix_append_outbox_event_internal in the function body, found %s', v_call_count);

  -- 5. No new trigger was created; the audited 3 attachments are unchanged.
  SELECT count(*) INTO v_trigger_count
  FROM pg_trigger t
  JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE p.proname = 'phoenix_capture_movement_posted' AND NOT t.tgisinternal;
  ASSERT v_trigger_count = 3,
    format('expected exactly 3 phoenix_capture_movement_posted attachments after 161, found %s', v_trigger_count);

  ASSERT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE t.tgname = 'phoenix_capture_movement_posted' AND c.relname = 'warehouse_stock_movements' AND NOT t.tgisinternal
  ), 'warehouse_stock_movements must still carry phoenix_capture_movement_posted';
  ASSERT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE t.tgname = 'phoenix_capture_movement_posted' AND c.relname = 'outlet_stock_movements' AND NOT t.tgisinternal
  ), 'outlet_stock_movements must still carry phoenix_capture_movement_posted';
  ASSERT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE t.tgname = 'phoenix_capture_movement_posted' AND c.relname = 'warehouse_quarantine_stock_movements' AND NOT t.tgisinternal
  ), 'warehouse_quarantine_stock_movements must still carry phoenix_capture_movement_posted';

  -- 6. The notification-only capture path remains completely unwired from
  --    the outbox (the audit proved it is not the canonical producer).
  SELECT pg_get_functiondef(oid) INTO v_other_fn_src
    FROM pg_proc WHERE proname = 'phoenix_capture_movement_notification';
  ASSERT v_other_fn_src NOT LIKE '%phoenix_outbox_events%' AND v_other_fn_src NOT LIKE '%phoenix_append_outbox_event_internal%',
    'phoenix_capture_movement_notification must remain unwired from the outbox in D2-3';

  -- 7. The stocktake producer remains unwired (D2-4 scope).
  SELECT pg_get_functiondef(oid) INTO v_other_fn_src
    FROM pg_proc WHERE proname = 'phoenix_capture_stocktake_recorded';
  ASSERT v_other_fn_src NOT LIKE '%phoenix_outbox_events%' AND v_other_fn_src NOT LIKE '%phoenix_append_outbox_event_internal%',
    'phoenix_capture_stocktake_recorded must remain unwired from the outbox in D2-3';

  -- 8. 159's lifecycle producer is completely unchanged by this migration:
  --    still exactly one call site, still exactly 11 attachments.
  SELECT pg_get_functiondef(oid) INTO v_other_fn_src
    FROM pg_proc WHERE proname = 'phoenix_capture_lifecycle_event';
  v_lifecycle_call_count := (LENGTH(v_other_fn_src) - LENGTH(REPLACE(v_other_fn_src, 'phoenix_append_outbox_event_internal', ''))) / LENGTH('phoenix_append_outbox_event_internal');
  ASSERT v_lifecycle_call_count = 1,
    format('phoenix_capture_lifecycle_event must still contain exactly one outbox-helper reference, found %s', v_lifecycle_call_count);
  ASSERT (
    SELECT count(*) FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE p.proname = 'phoenix_capture_lifecycle_event' AND NOT t.tgisinternal
  ) = 11, '159''s 11 lifecycle trigger attachments must remain unchanged';

  -- 9. No client role gained outbox access as a side effect of this migration.
  ASSERT NOT has_table_privilege('authenticated', 'public.phoenix_outbox_events', 'SELECT'),
    'authenticated must still lack SELECT on phoenix_outbox_events after 161';
  ASSERT NOT has_function_privilege('authenticated', 'public.phoenix_append_outbox_event_internal(text,text,smallint,text,uuid,uuid,jsonb,uuid,uuid,uuid,uuid)', 'EXECUTE'),
    'authenticated must still lack EXECUTE on the append helper after 161';
  ASSERT NOT has_table_privilege('anon', 'public.phoenix_outbox_events', 'SELECT'),
    'anon must still lack SELECT on phoenix_outbox_events after 161';

  -- 10. Applying 161 itself creates zero outbox rows (no movement is
  --     inserted by this migration).
  ASSERT (SELECT count(*) FROM public.phoenix_outbox_events) = 0,
    'applying 161 must not itself produce any outbox row';

  -- 11. No D3 consumer/processing state exists on the outbox table.
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'phoenix_outbox_events'
       AND column_name ~* 'process|claim|lease|retry|attempt|failure|dead.?letter|consum'
  ), 'phoenix_outbox_events must carry no D3 consumer/processing column';
END $$;

COMMIT;

-- ============================================================================
-- POST-CONDITIONS
-- ============================================================================
-- 1. phoenix_capture_movement_posted(): same zero-arg signature, SECURITY
--    DEFINER, pinned search_path, byte-identical business logic for every
--    pre-existing statement, plus exactly one additive PERFORM call to
--    phoenix_append_outbox_event_internal after the existing sink INSERT
--    succeeds and before RETURN NEW.
-- 2. All three phoenix_capture_movement_posted trigger attachments (123) are
--    unchanged — same trigger name, same tables, no new trigger object
--    created, none dropped.
-- 3. phoenix_capture_movement_notification and phoenix_capture_stocktake_
--    recorded are completely untouched and remain unwired from the outbox.
-- 4. 159's lifecycle producer (phoenix_capture_lifecycle_event) is
--    completely untouched: same one call site, same 11 attachments.
-- 5. Every accepted movement-ledger INSERT on warehouse_stock_movements,
--    outlet_stock_movements, or warehouse_quarantine_stock_movements now
--    also appends exactly one phoenix_outbox_events row: event_key =
--    'movement:' || the same dedupe_key already governing the existing
--    sink; event_type byte-identical to the existing event_type;
--    aggregate_type/aggregate_id = TG_TABLE_NAME/NEW.id; organization_id/
--    actor_id/correlation_id/causation_id = the exact same resolved values
--    already used; payload = {source_table, movement_type, quantity_delta,
--    trace_id, reference_id, occurred_at} only.
-- 6. A rejected movement (no resolvable organization_id) still returns
--    before either sink write, exactly as before 161.
-- 7. An outbox conflict (mismatched fingerprint replay) rolls back the
--    entire transaction, including the movement-row INSERT and the
--    pre-existing sink write, by ordinary Postgres transaction semantics.
-- 8. Zero outbox rows exist immediately after this migration commits.
-- 9. RECONCILIATION: this migration writes no application data itself (one
--    function redefinition) — nothing to reconcile.
-- ============================================================================
-- ROLLBACK: there is no legitimate reason to ever do this once any real
-- movement has been captured by the new outbox emission (that would be
-- destroying real captured event history). If genuinely required before any
-- real traffic:
--   Re-apply 124's exact CREATE OR REPLACE FUNCTION body (without the
--   PERFORM block added here) to restore the pre-161 definition.
-- ============================================================================
