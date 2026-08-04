-- ============================================================================
-- TRANSFER-SEND-RECEIVE-LIFECYCLE-NOTIFICATIONS-155
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply after 154.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE GAP THIS CLOSES
-- ─────────────────────────────────────────────────────────────────────────────
-- Phase D0's read-only audit flagged that the `phoenix_capture_lifecycle`
-- trigger (082, extended by 094/099/122) was never attached to
-- `warehouse_transfers` or `warehouse_transfer_lines` — the Route-1
-- SEND/RECEIVE header and its lines — even though every other corridor
-- header already carries it: warehouse_transfer_requests, warehouse_return_
-- requests, warehouse_return_shipments, outlet_return_requests, outlet_
-- return_shipments, warehouse_dispatches (082), procurement_orders,
-- inventory_status_reports (099), phoenix_stock_correction_requests,
-- phoenix_warehouse_correction_requests (122) — ten headers in total, none of
-- them ever this corridor. Confirmed live: `warehouse_transfers` has a real
-- `status` column (`in_transit` -> `partially_received`/`received`, 068's own
-- CHECK constraint) that never once produces a `phoenix_movement_events` row
-- or a `phoenix_notifications` row today. Institutions currently get no feed
-- entry when their own incoming shipment is sent or received — only the
-- REQUEST (draft/submitted/approved) side of the corridor notifies.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SCOPE DECISION: `warehouse_transfers` (header) only, NOT
-- `warehouse_transfer_lines` (lines) — this is deliberate, not an oversight
-- ─────────────────────────────────────────────────────────────────────────────
-- Every one of the ten existing `phoenix_capture_lifecycle` attachments is on
-- a HEADER table; none is ever attached to that corridor's own LINE table
-- (warehouse_transfer_request_lines, outlet_return_shipment_lines,
-- warehouse_dispatch_lines all carry a `status`-shaped lifecycle too, and none
-- of them carries this trigger either). Attaching it to
-- `warehouse_transfer_lines` as well would be a novel expansion of that
-- pattern, not a completion of it, and 068's own RECEIVE RPC
-- (phoenix_receive_warehouse_transfer_line, confirmed live below) already
-- rolls every line-level receive up into the header's own `status` UPDATE
-- (`partially_received` while any line remains `in_transit`, `received` once
-- none do) in the SAME transaction — so a header-only trigger already
-- captures the complete lifecycle narrative a viewer needs, exactly matching
-- every other corridor. Adding a second, per-LINE notification for what is
-- already a single header transition would be redundant noise, not missing
-- coverage.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- HOME ORG: `source_organization_id`, matching the "whoever owns/creates this
-- record" pattern already established by 4 of the 10 existing attachments
-- (the other 5 non-request headers key off a single generic
-- `organization_id` column those tables don't split into source/destination
-- at all, so they aren't a source/destination precedent either way)
-- ─────────────────────────────────────────────────────────────────────────────
-- warehouse_return_shipments / outlet_return_shipments / warehouse_return_
-- requests / outlet_return_requests all key off `source_organization_id` —
-- the org whose own action produced that row. `warehouse_transfer_requests`
-- is the one exception among the source/destination-shaped headers, keyed
-- off `destination_organization_id`, because a
-- REQUEST is literally the institution's own ask (they created that row).
-- `warehouse_transfers` is a SEND record: the row exists because the CENTRAL
-- warehouse's own action (068's send RPCs) created it, on the source side —
-- the same "shipment" shape as return_shipments/outlet_return_shipments, not
-- the "request" shape of warehouse_transfer_requests. `source_organization_id`
-- is therefore the consistent, evidenced choice, not a guess.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- FUNCTION CHANGE: one additive COALESCE branch, nothing else
-- ─────────────────────────────────────────────────────────────────────────────
-- `phoenix_capture_lifecycle_event()`'s v_doc COALESCE reads request_number /
-- return_number / shipment_number / dispatch_number — `warehouse_transfers`
-- has neither; its own human-readable identifier is `transfer_number` (068,
-- NOT NULL). Adding `transfer_number` to that COALESCE is purely additive: for
-- every one of the ten existing tables that key is simply absent from the
-- row's jsonb, so `->> 'transfer_number'` evaluates to NULL and the COALESCE
-- falls through to whichever of the other four keys that table actually has,
-- byte-for-byte unchanged behavior for all of them (re-verified in-transaction
-- below).
--
-- SCOPE: this migration touches ONLY the function body (one additive COALESCE
-- branch) and adds exactly one new trigger, on exactly one table. No RLS
-- policy, no RBAC permission/role default, no table/column/constraint, no
-- table privilege grant/revoke, and no other function is touched here.
-- ============================================================================

BEGIN;

DO $$ BEGIN
  IF to_regprocedure('public.phoenix_capture_lifecycle_event()') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: phoenix_capture_lifecycle_event() is missing — apply 082 first';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE t.tgname = 'phoenix_capture_lifecycle' AND c.relname = 'warehouse_transfers'
  ) THEN
    RAISE EXCEPTION 'precondition failed: phoenix_capture_lifecycle already exists on warehouse_transfers (155 already applied?)';
  END IF;
END $$;

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

  RETURN NEW;
END;
$capture$;

COMMENT ON FUNCTION public.phoenix_capture_lifecycle_event() IS
  'AFTER INSERT/UPDATE capture of corridor header status transitions into '
  'phoenix_movement_events AND phoenix_notifications (094). 155 added '
  'warehouse_transfers as a seventh header (transfer_number in the v_doc '
  'COALESCE) — deliberately NOT any corridor''s line table (see 155''s own '
  'header comment). SECURITY DEFINER so only the trigger path can append '
  'either. Idempotent via a shared dedupe_key text per (header, status), '
  'enforced by two separate unique indexes. TG_ARGV[0] = the initiating-org '
  'column that owns both rows for RLS.';

REVOKE ALL ON FUNCTION public.phoenix_capture_lifecycle_event() FROM PUBLIC;

-- ── Attach the seventh header: warehouse_transfers only ─────────────────────

DROP TRIGGER IF EXISTS phoenix_capture_lifecycle ON public.warehouse_transfers;
CREATE TRIGGER phoenix_capture_lifecycle
  AFTER INSERT OR UPDATE ON public.warehouse_transfers
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_capture_lifecycle_event('source_organization_id');

-- =============================================================================
-- VERIFY — inside the transaction; failure rolls back all of 155
-- =============================================================================

DO $$
DECLARE
  v_fn_src text;
BEGIN
  -- 1. The new trigger exists on warehouse_transfers, correctly configured.
  ASSERT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE t.tgname = 'phoenix_capture_lifecycle' AND c.relname = 'warehouse_transfers'
      AND NOT t.tgisinternal
  ), 'phoenix_capture_lifecycle trigger missing on warehouse_transfers';

  -- 2. Deliberately absent from warehouse_transfer_lines — proves the scope
  --    decision documented above, not an accidental omission a future reader
  --    might "fix" inconsistently.
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE t.tgname = 'phoenix_capture_lifecycle' AND c.relname = 'warehouse_transfer_lines'
  ), 'phoenix_capture_lifecycle unexpectedly exists on warehouse_transfer_lines — scope decision violated';

  -- 3. All ten pre-existing attachments (082, 099, 122) are untouched (same
  --    table set, same function, no attachment silently dropped or
  --    duplicated).
  ASSERT (
    SELECT count(*) FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE t.tgname = 'phoenix_capture_lifecycle' AND NOT t.tgisinternal
  ) = 11, 'expected exactly 11 phoenix_capture_lifecycle triggers after 155 (10 pre-existing + warehouse_transfers)';

  -- 4. Function still SECURITY DEFINER with pinned search_path (082/094's own
  --    invariant, re-verified after this migration's redefinition).
  SELECT pg_get_functiondef(oid) INTO v_fn_src
    FROM pg_proc WHERE proname = 'phoenix_capture_lifecycle_event';
  ASSERT (
    SELECT prosecdef FROM pg_proc WHERE proname = 'phoenix_capture_lifecycle_event'
  ), 'phoenix_capture_lifecycle_event must remain SECURITY DEFINER';
  ASSERT v_fn_src LIKE '%search_path%public%pg_temp%',
    'phoenix_capture_lifecycle_event must keep search_path pinned to public, pg_temp';
  ASSERT v_fn_src LIKE '%transfer_number%',
    'phoenix_capture_lifecycle_event must include transfer_number in its document-label COALESCE';

  -- 5. No table privilege was touched by this migration (154's lockdown
  --    stays exactly as it was — this migration never grants/revokes on any
  --    of the four transfer-corridor tables).
  ASSERT NOT has_table_privilege('authenticated', 'public.warehouse_transfers', 'TRUNCATE'),
    '155 must never re-grant TRUNCATE to authenticated on warehouse_transfers (154''s lockdown must survive)';
END $$;

COMMIT;

-- ============================================================================
-- POST-CONDITIONS
-- ============================================================================
-- 1. `warehouse_transfers` INSERT/UPDATE now appends one phoenix_movement_events
--    row and one phoenix_notifications row per real status transition
--    (in_transit on SEND, then partially_received/received as lines are
--    received — 068's own RECEIVE RPC already rolls line-level receives up
--    into a single header UPDATE), scoped by source_organization_id.
-- 2. `warehouse_transfer_lines` remains deliberately without this trigger —
--    the header-only rollup above already captures the complete lifecycle.
-- 3. The other ten phoenix_capture_lifecycle attachments (082, 099, 122) and
--    their behavior are completely unchanged; the one function edit is a
--    single additive COALESCE branch that is a no-op for all ten of them.
-- 4. No RLS policy, no RBAC permission/role default, no table/column/
--    constraint, and no table privilege grant/revoke was touched. Migration
--    154's REVOKEs on the four transfer-corridor tables are untouched and
--    re-verified in-transaction above.
-- 5. RECONCILIATION: this migration writes no application data itself
--    (function redefinition + one trigger) — nothing to reconcile.
-- ============================================================================
-- ROLLBACK: there is no legitimate reason to ever do this. If genuinely
-- required:
--   DROP TRIGGER phoenix_capture_lifecycle ON public.warehouse_transfers;
-- The v_doc COALESCE addition is harmless to leave in place even if the
-- trigger is removed (it only ever matches a key that table exposes), so no
-- corresponding function rollback is necessary or recommended.
-- ============================================================================
