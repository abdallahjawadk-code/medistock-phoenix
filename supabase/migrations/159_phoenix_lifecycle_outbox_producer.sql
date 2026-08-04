-- ============================================================================
-- LIFECYCLE-OUTBOX-PRODUCER-159
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply after 158.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SCOPE — D2-2, THE FIRST OUTBOX PRODUCER, LIFECYCLE ONLY
-- ─────────────────────────────────────────────────────────────────────────────
-- This migration redefines ONE existing function,
-- public.phoenix_capture_lifecycle_event() (082, extended 094/099/122/155),
-- to additionally append one outbox event per accepted lifecycle transition,
-- via public.phoenix_append_outbox_event_internal() (158). It creates NO new
-- trigger, drops NO existing trigger, and touches NO business table, business
-- RPC, RLS policy, grant, or frontend code. The eleven tables already wired
-- to phoenix_capture_lifecycle keep the exact same trigger object, unchanged
-- (082: warehouse_transfer_requests, warehouse_return_requests,
-- warehouse_return_shipments, outlet_return_requests, outlet_return_shipments,
-- warehouse_dispatches; 099: procurement_orders, inventory_status_reports;
-- 122: phoenix_stock_correction_requests, phoenix_warehouse_correction_
-- requests; 155: warehouse_transfers) — confirmed by direct query against the
-- 001->158 replay before writing this file, and re-verified in-transaction
-- below.
--
-- phoenix_capture_movement_posted() (123), phoenix_capture_movement_
-- notification() (099), and phoenix_capture_stocktake_recorded() (123) are
-- NOT touched here — those are separate D2-3/D2-4-scope producers, not this
-- migration's.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT "ACCEPTED TRANSITION" MEANS HERE — UNCHANGED FROM 082
-- ─────────────────────────────────────────────────────────────────────────────
-- The function's own existing guard,
--   IF v_new_status IS NULL OR v_new_status IS NOT DISTINCT FROM v_old_status
--   THEN RETURN NEW; END IF;
-- already decides, once, what counts as a genuine transition (a same-value
-- UPDATE such as a metadata edit or a second partial send that leaves status
-- unchanged returns early and writes nothing to either existing sink table).
-- The new outbox PERFORM call sits strictly AFTER that guard and after both
-- existing INSERT statements succeed, so it inherits that exact same
-- accept/reject decision for free — there is no second, independently-
-- maintained notion of "is this a real transition" to ever disagree with the
-- first, which is precisely the reasoning 094's own header comment already
-- used to justify extending this function instead of adding a rival trigger.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- EVENT IDENTITY — REUSING, NOT INVENTING
-- ─────────────────────────────────────────────────────────────────────────────
--   event_key       = 'lifecycle:' || v_dedupe, where v_dedupe is the exact
--                      existing dedupe_key expression (NEW.id::text || ':' ||
--                      v_new_status) already governing phoenix_movement_events
--                      and phoenix_notifications. The 'lifecycle:' namespace
--                      prefix keeps this producer's keys textually distinct
--                      from any future producer's own event_key formula,
--                      even though phoenix_outbox_events.event_key is a
--                      single shared UNIQUE column across every future
--                      producer.
--   event_type      = TG_TABLE_NAME || '.' || v_new_status — byte-identical
--                      to the existing event_type already written to both
--                      current sink tables for the same transition.
--   event_version   = 1 (first version of this event shape).
--   aggregate_type  = TG_TABLE_NAME (the exact source table name).
--   aggregate_id    = NEW.id (the transitioned row's own id — the same value
--                      already written as trace_id/reference_id today).
--   organization_id = v_home_org — the exact same resolved owning
--                      organization the existing INSERTs already use. No
--                      dual-organization visibility is introduced; 082's own
--                      "deliberate future decision, not silently assumed
--                      here" posture on cross-org visibility is preserved
--                      unchanged.
--   actor_id        = v_actor — the exact same auth.uid() already resolved.
--   correlation_id  = NULL. The function resolves no distinct UUID
--                      correlation/trace value beyond NEW.id (already used as
--                      aggregate_id) — inventing one here would not reuse an
--                      existing resolved value, which the D2-2 contract
--                      requires against.
--   causation_id    = NULL (this producer never has a queued cause; the
--                      transition IS the cause, and 148's suggestion bridge
--                      is not represented here as a distinct causation_id
--                      yet — that is out of this slice's scope).
--   request_id      = NULL (no request-id-shaped idempotency key exists on
--                      any of the eleven lifecycle-attached header tables'
--                      write paths).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- PAYLOAD — MINIMAL, VERSION 1, NOTHING BEYOND WHAT THE FUNCTION ALREADY HAS
-- ─────────────────────────────────────────────────────────────────────────────
-- {source_table, old_status, new_status, trace_id, reference_id} only, built
-- from v_old_status/v_new_status/NEW.id — values the function has already
-- resolved for the existing INSERTs, nothing queried afresh. old_status can
-- be genuinely NULL (a fresh INSERT with no prior state), so
-- jsonb_strip_nulls drops that key rather than writing a JSON null. No actor
-- name/role, no organization name, no auth.users data, no OLD/NEW row dump —
-- the organization and actor UUIDs already exist at the outbox envelope
-- level (organization_id, actor_id columns), so 082/094's own "don't
-- duplicate what's already at envelope level" instinct for org/actor names
-- applies here too, even though it was never written down before because no
-- envelope existed until 158.
-- ============================================================================

BEGIN;

-- ── PRECONDITIONS ───────────────────────────────────────────────────────────

DO $precond$
DECLARE
  v_lifecycle_trigger_count int;
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
  IF to_regprocedure('public.phoenix_capture_lifecycle_event()') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: phoenix_capture_lifecycle_event() is missing — apply 082/094 first';
  END IF;

  SELECT count(*) INTO v_lifecycle_trigger_count
  FROM pg_trigger t
  JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE p.proname = 'phoenix_capture_lifecycle_event' AND NOT t.tgisinternal;
  IF v_lifecycle_trigger_count <> 11 THEN
    RAISE EXCEPTION 'precondition failed: expected exactly 11 phoenix_capture_lifecycle attachments, found %', v_lifecycle_trigger_count;
  END IF;

  SELECT pg_get_functiondef(oid) INTO v_fn_src_before
    FROM pg_proc WHERE proname = 'phoenix_capture_lifecycle_event';
  IF v_fn_src_before LIKE '%phoenix_outbox_events%' OR v_fn_src_before LIKE '%phoenix_append_outbox_event_internal%' THEN
    RAISE EXCEPTION 'precondition failed: phoenix_capture_lifecycle_event() already references the outbox (159 already applied?)';
  END IF;

  IF (SELECT count(*) FROM public.phoenix_outbox_events) <> 0 THEN
    RAISE EXCEPTION 'precondition failed: phoenix_outbox_events must be empty before the first producer activates';
  END IF;

  IF has_table_privilege('authenticated', 'public.phoenix_outbox_events', 'SELECT') THEN
    RAISE EXCEPTION 'precondition failed: 158''s privilege lockdown on phoenix_outbox_events no longer holds';
  END IF;
  IF has_function_privilege('authenticated', 'public.phoenix_append_outbox_event_internal(text,text,smallint,text,uuid,uuid,jsonb,uuid,uuid,uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'precondition failed: 158''s privilege lockdown on the append helper no longer holds';
  END IF;
END;
$precond$;

-- ── The lifecycle capture function — same signature, one additive call ─────

CREATE OR REPLACE FUNCTION public.phoenix_capture_lifecycle_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $capture$
DECLARE
  v_new        jsonb := to_jsonb(NEW);
  v_old        jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
  v_new_status text  := v_new ->> 'status';
  v_old_status text  := v_old ->> 'status';
  v_actor      uuid  := auth.uid();
  v_home_col   text  := TG_ARGV[0];
  v_home_org   uuid;
  v_src_org    uuid  := NULLIF(COALESCE(v_new ->> 'source_organization_id', v_new ->> 'organization_id'), '')::uuid;
  v_dst_org    uuid  := NULLIF(v_new ->> 'destination_organization_id', '')::uuid;
  v_role       text;
  v_name       text;
  -- 155: added transfer_number (warehouse_transfers, 068) to the COALESCE.
  -- Purely additive — every other table lacks this key in its own jsonb, so
  -- ->> 'transfer_number' is NULL there and the fallthrough is unchanged.
  v_doc        text  := COALESCE(v_new ->> 'request_number', v_new ->> 'return_number',
                                 v_new ->> 'shipment_number', v_new ->> 'dispatch_number',
                                 v_new ->> 'transfer_number');
  v_dedupe     text;
BEGIN
  -- Only real transitions. Same-value UPDATEs (metadata edits, second partial
  -- send that leaves status unchanged) never emit an event or a notification.
  IF v_new_status IS NULL OR v_new_status IS NOT DISTINCT FROM v_old_status THEN
    RETURN NEW;
  END IF;

  v_home_org := NULLIF(v_new ->> v_home_col, '')::uuid;
  IF v_home_org IS NULL THEN
    v_home_org := COALESCE(v_src_org, v_dst_org);  -- never leave RLS owner NULL
  END IF;

  IF v_actor IS NOT NULL THEN
    SELECT p.role, p.full_name INTO v_role, v_name
      FROM public.profiles p WHERE p.id = v_actor;
  END IF;

  v_dedupe := NEW.id::text || ':' || v_new_status;

  INSERT INTO public.phoenix_movement_events (
    organization_id, trace_id, event_type, occurred_at,
    actor_id, actor_role, actor_name,
    source_label, destination_label,
    status_after, reference_type, reference_id, notes, dedupe_key
  )
  VALUES (
    v_home_org,
    NEW.id,
    TG_TABLE_NAME || '.' || v_new_status,
    now(),
    v_actor, v_role, v_name,
    (SELECT o.name FROM public.organizations o WHERE o.id = v_src_org),
    (SELECT o.name FROM public.organizations o WHERE o.id = v_dst_org),
    v_new_status,
    TG_TABLE_NAME,
    NEW.id,
    v_doc,
    v_dedupe
  )
  ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;

  INSERT INTO public.phoenix_notifications (
    organization_id, event_type, occurred_at,
    actor_id, actor_role, actor_name,
    status_after, reference_type, reference_id, reference_label, dedupe_key
  )
  VALUES (
    v_home_org,
    TG_TABLE_NAME || '.' || v_new_status,
    now(),
    v_actor, v_role, v_name,
    v_new_status,
    TG_TABLE_NAME,
    NEW.id,
    v_doc,
    v_dedupe
  )
  ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;

  -- ── 159: the first outbox producer ──────────────────────────────────────
  -- Fires only after both existing sink writes above have succeeded, and
  -- reuses every value this function already resolved — no new lookup, no
  -- new decision about what counts as a transition. If this call raises
  -- (e.g. outbox_event_key_conflict), the exception propagates out of this
  -- trigger exactly like any other unhandled exception here always has,
  -- rolling back this entire transaction — the header UPDATE, both sink
  -- INSERTs above, and this call are one atomic unit by ordinary Postgres
  -- transaction semantics, not by any new mechanism introduced here.
  PERFORM public.phoenix_append_outbox_event_internal(
    'lifecycle:' || v_dedupe,
    TG_TABLE_NAME || '.' || v_new_status,
    1::smallint,
    TG_TABLE_NAME,
    NEW.id,
    v_home_org,
    jsonb_strip_nulls(jsonb_build_object(
      'source_table', TG_TABLE_NAME,
      'old_status', v_old_status,
      'new_status', v_new_status,
      'trace_id', NEW.id,
      'reference_id', NEW.id
    )),
    v_actor,
    NULL::uuid,
    NULL::uuid,
    NULL::uuid
  );

  RETURN NEW;
END;
$capture$;

COMMENT ON FUNCTION public.phoenix_capture_lifecycle_event() IS
  'AFTER INSERT/UPDATE capture of corridor header status transitions into '
  'phoenix_movement_events AND phoenix_notifications (094). 155 added '
  'warehouse_transfers as a seventh header (transfer_number in the v_doc '
  'COALESCE) — deliberately NOT any corridor''s line table (see 155''s own '
  'header comment). 159 additionally appends one phoenix_outbox_events row '
  'per accepted transition via phoenix_append_outbox_event_internal (158), '
  'event_key = ''lifecycle:'' || the same dedupe_key already governing the '
  'two existing sink tables — the first D2 outbox producer, lifecycle-'
  'transition events only. SECURITY DEFINER so only the trigger path can '
  'append any of the three. Idempotent via a shared dedupe_key text per '
  '(header, status), enforced by two separate unique indexes for the '
  'pre-existing sinks and by phoenix_outbox_events.event_key UNIQUE for the '
  'new one. TG_ARGV[0] = the initiating-org column that owns all three rows '
  'for RLS.';

-- =============================================================================
-- VERIFY — inside the transaction; failure rolls back all of 159
-- =============================================================================

DO $$
DECLARE
  v_fn_src        text;
  v_call_count    int;
  v_trigger_count int;
  v_other_fn_src  text;
BEGIN
  -- 1. Function still exists with the exact zero-argument signature.
  ASSERT to_regprocedure('public.phoenix_capture_lifecycle_event()') IS NOT NULL,
    'phoenix_capture_lifecycle_event() must still exist';

  SELECT pg_get_functiondef(oid) INTO v_fn_src
    FROM pg_proc WHERE proname = 'phoenix_capture_lifecycle_event';

  -- 2. Still SECURITY DEFINER.
  ASSERT (SELECT prosecdef FROM pg_proc WHERE proname = 'phoenix_capture_lifecycle_event'),
    'phoenix_capture_lifecycle_event must remain SECURITY DEFINER';

  -- 3. search_path remains pinned.
  ASSERT v_fn_src LIKE '%search_path%public%pg_temp%',
    'phoenix_capture_lifecycle_event must keep search_path pinned to public, pg_temp';

  -- 4. Exactly one semantic call site to the append helper.
  v_call_count := (LENGTH(v_fn_src) - LENGTH(REPLACE(v_fn_src, 'phoenix_append_outbox_event_internal', ''))) / LENGTH('phoenix_append_outbox_event_internal');
  ASSERT v_call_count = 1,
    format('expected exactly one reference to phoenix_append_outbox_event_internal in the function body, found %s', v_call_count);

  -- 5. No new trigger was created; the audited 11 attachments are unchanged.
  SELECT count(*) INTO v_trigger_count
  FROM pg_trigger t
  JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE p.proname = 'phoenix_capture_lifecycle_event' AND NOT t.tgisinternal;
  ASSERT v_trigger_count = 11,
    format('expected exactly 11 phoenix_capture_lifecycle attachments after 159, found %s', v_trigger_count);

  ASSERT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE t.tgname = 'phoenix_capture_lifecycle' AND c.relname = 'warehouse_transfer_requests' AND NOT t.tgisinternal
  ), 'warehouse_transfer_requests must still carry phoenix_capture_lifecycle';
  ASSERT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE t.tgname = 'phoenix_capture_lifecycle' AND c.relname = 'warehouse_return_requests' AND NOT t.tgisinternal
  ), 'warehouse_return_requests must still carry phoenix_capture_lifecycle';
  ASSERT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE t.tgname = 'phoenix_capture_lifecycle' AND c.relname = 'warehouse_return_shipments' AND NOT t.tgisinternal
  ), 'warehouse_return_shipments must still carry phoenix_capture_lifecycle';
  ASSERT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE t.tgname = 'phoenix_capture_lifecycle' AND c.relname = 'outlet_return_requests' AND NOT t.tgisinternal
  ), 'outlet_return_requests must still carry phoenix_capture_lifecycle';
  ASSERT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE t.tgname = 'phoenix_capture_lifecycle' AND c.relname = 'outlet_return_shipments' AND NOT t.tgisinternal
  ), 'outlet_return_shipments must still carry phoenix_capture_lifecycle';
  ASSERT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE t.tgname = 'phoenix_capture_lifecycle' AND c.relname = 'warehouse_dispatches' AND NOT t.tgisinternal
  ), 'warehouse_dispatches must still carry phoenix_capture_lifecycle';
  ASSERT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE t.tgname = 'phoenix_capture_lifecycle' AND c.relname = 'procurement_orders' AND NOT t.tgisinternal
  ), 'procurement_orders must still carry phoenix_capture_lifecycle';
  ASSERT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE t.tgname = 'phoenix_capture_lifecycle' AND c.relname = 'inventory_status_reports' AND NOT t.tgisinternal
  ), 'inventory_status_reports must still carry phoenix_capture_lifecycle';
  ASSERT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE t.tgname = 'phoenix_capture_lifecycle' AND c.relname = 'phoenix_stock_correction_requests' AND NOT t.tgisinternal
  ), 'phoenix_stock_correction_requests must still carry phoenix_capture_lifecycle';
  ASSERT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE t.tgname = 'phoenix_capture_lifecycle' AND c.relname = 'phoenix_warehouse_correction_requests' AND NOT t.tgisinternal
  ), 'phoenix_warehouse_correction_requests must still carry phoenix_capture_lifecycle';
  ASSERT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE t.tgname = 'phoenix_capture_lifecycle' AND c.relname = 'warehouse_transfers' AND NOT t.tgisinternal
  ), 'warehouse_transfers must still carry phoenix_capture_lifecycle';

  -- 6. The other three capture functions remain completely unwired from the outbox.
  FOR v_other_fn_src IN
    SELECT pg_get_functiondef(oid) FROM pg_proc
    WHERE proname IN ('phoenix_capture_movement_posted', 'phoenix_capture_movement_notification', 'phoenix_capture_stocktake_recorded')
  LOOP
    ASSERT v_other_fn_src NOT LIKE '%phoenix_outbox_events%' AND v_other_fn_src NOT LIKE '%phoenix_append_outbox_event_internal%',
      'phoenix_capture_movement_posted/notification/stocktake_recorded must remain unwired from the outbox in D2-2';
  END LOOP;

  -- 7. No client role gained outbox access as a side effect of this migration.
  ASSERT NOT has_table_privilege('authenticated', 'public.phoenix_outbox_events', 'SELECT'),
    'authenticated must still lack SELECT on phoenix_outbox_events after 159';
  ASSERT NOT has_function_privilege('authenticated', 'public.phoenix_append_outbox_event_internal(text,text,smallint,text,uuid,uuid,jsonb,uuid,uuid,uuid,uuid)', 'EXECUTE'),
    'authenticated must still lack EXECUTE on the append helper after 159';
  ASSERT NOT has_table_privilege('anon', 'public.phoenix_outbox_events', 'SELECT'),
    'anon must still lack SELECT on phoenix_outbox_events after 159';

  -- 8. Applying 159 itself creates zero outbox rows.
  ASSERT (SELECT count(*) FROM public.phoenix_outbox_events) = 0,
    'applying 159 must not itself produce any outbox row';
END $$;

COMMIT;

-- ============================================================================
-- POST-CONDITIONS
-- ============================================================================
-- 1. phoenix_capture_lifecycle_event(): same zero-arg signature, SECURITY
--    DEFINER, pinned search_path, byte-identical business logic for every
--    pre-existing statement, plus exactly one additive PERFORM call to
--    phoenix_append_outbox_event_internal after both existing sink INSERTs
--    succeed and before RETURN NEW.
-- 2. All eleven phoenix_capture_lifecycle trigger attachments (082/099/122/
--    155) are unchanged — same trigger name, same tables, no new trigger
--    object created, none dropped.
-- 3. phoenix_capture_movement_posted, phoenix_capture_movement_notification,
--    and phoenix_capture_stocktake_recorded are completely untouched.
-- 4. Every accepted lifecycle transition now also appends exactly one
--    phoenix_outbox_events row: event_key = 'lifecycle:' || the same
--    dedupe_key already governing the two existing sinks; event_type
--    byte-identical to the existing event_type; aggregate_type/aggregate_id
--    = TG_TABLE_NAME/NEW.id; organization_id/actor_id = the exact same
--    resolved values already used; payload = {source_table, old_status,
--    new_status, trace_id, reference_id} only.
-- 5. A rejected/no-op transition (status unchanged) still returns before
--    any of the three sink writes, exactly as before 159.
-- 6. An outbox conflict (mismatched fingerprint replay) rolls back the
--    entire transaction, including the header mutation and both pre-
--    existing sink writes, by ordinary Postgres transaction semantics.
-- 7. Zero outbox rows exist immediately after this migration commits.
-- 8. RECONCILIATION: this migration writes no application data itself
--    (one function redefinition) — nothing to reconcile.
-- ============================================================================
-- ROLLBACK: there is no legitimate reason to ever do this once any real
-- transition has been captured by the new outbox emission (that would be
-- destroying real captured event history). If genuinely required before any
-- real traffic:
--   Re-apply 155's exact CREATE OR REPLACE FUNCTION body (without the
--   PERFORM block added here) to restore the pre-159 definition.
-- ============================================================================
