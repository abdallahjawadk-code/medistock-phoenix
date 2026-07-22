-- ============================================================================
-- MOVEMENT-EVENT-CAPTURE-082-A
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply AFTER 081 (it extends the ledger and RPC that 081 created).
--
-- VERIFICATION STATUS: EXECUTED on a disposable PostgreSQL 18.4 cluster with
-- 001→082 applied in order via tools/pg-rig, and exercised by driving the real
-- lifecycle RPCs (create/submit/review/send/receive transfer; institution and
-- outlet returns; dispatch) then reading phoenix_movement_timeline. See
-- docs/phoenix/migration-082-event-capture-validation.md. Production is 17.6.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THIS EXISTS — THE 081 AUDIT FINDING
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 081 created public.phoenix_movement_events (an append-only lifecycle
-- ledger) and phoenix_movement_timeline (a read RPC that can surface ledger
-- rows). But 081 shipped NO writer: nothing anywhere INSERTs into the ledger, so
-- its 'event_ledger' provenance branch was dead, and the corridor status
-- transitions that leave no dedicated _at/_by column behind — above all a
-- transfer request reaching 'partially_fulfilled'/'fulfilled', and EVERY
-- transition on warehouse_transfer_requests and warehouse_return_requests, which
-- 081's derived-column branch never even queried — were still lost forever.
--
-- This migration makes the real lifecycle RPCs populate the ledger, WITHOUT
-- touching a single RPC body: the corridor headers are written only by SECURITY
-- DEFINER RPCs, so an AFTER INSERT/UPDATE trigger on each header captures every
-- status transition transactionally, inside the same commit as the stock
-- mutation, with no frontend involvement and no way for a client to suppress it.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- GUARANTEES
-- ─────────────────────────────────────────────────────────────────────────────
--   * Transactional: the trigger fires within the RPC's transaction. If the
--     stock mutation rolls back, so does its event. There is no second round-trip.
--   * Frontend-independent: capture is server-side on the table, not in app code.
--   * Idempotent / retry-safe: dedupe_key = header_id || ':' || new_status is
--     UNIQUE; ON CONFLICT DO NOTHING. A lost-response retry that re-runs an
--     already-applied transition cannot create a second event. Status columns are
--     monotonic (guarded by each header's own CHECK constraints), so a given
--     (header, status) is a single logical event.
--   * Authenticated actor: actor_id = auth.uid() — the real caller, resolved
--     inside the trigger (SECURITY DEFINER does not change auth.uid()). Role and
--     name are snapshotted from profiles at capture time.
--   * Scoped source/destination: both endpoint organizations are labelled on
--     every event; organization_id (the RLS owner) is the INITIATING org, passed
--     per-table as a trigger argument.
--   * Immutable provenance: the ledger already denies UPDATE/DELETE to
--     authenticated (081) and only SECURITY DEFINER functions may append. This
--     trigger function is SECURITY DEFINER and owned by the migration owner.
--
-- HONESTY: history retained BEFORE this migration is NOT backfilled. Events only
-- accrue for transitions that happen AFTER 082 is applied. phoenix_movement_
-- timeline therefore still reports complete=false. Nothing is invented.
--
-- CROSS-ORG VISIBILITY (owner-review point, documented in the validation doc):
-- a corridor spans two organizations but each ledger event is owned by ONE org
-- for RLS — the INITIATING org — consistent with 081's existing single-org
-- exposure of the same documents. The counterparty sees the physical outcome via
-- the append-only movement rows (which carry their own org), not via this
-- lifecycle event. Widening a corridor's full timeline to BOTH orgs is a
-- deliberate future decision, not silently assumed here.
-- ============================================================================

BEGIN;

DO $precond$
BEGIN
  IF to_regclass('public.phoenix_movement_events') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: phoenix_movement_events missing — apply 081 first';
  END IF;
  IF to_regprocedure('public.phoenix_movement_timeline(uuid, integer, timestamptz, uuid)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: phoenix_movement_timeline(...) missing — apply 081 first';
  END IF;
  IF to_regclass('public.warehouse_transfer_requests') IS NULL
     OR to_regclass('public.warehouse_return_requests') IS NULL
     OR to_regclass('public.warehouse_return_shipments') IS NULL
     OR to_regclass('public.outlet_return_requests') IS NULL
     OR to_regclass('public.outlet_return_shipments') IS NULL
     OR to_regclass('public.warehouse_dispatches') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: a corridor header table is missing — apply 061-077 first';
  END IF;
END;
$precond$;

-- ── A. Idempotency key on the ledger ────────────────────────────────────────
-- One transition per (header, status). Partial unique index: only trigger-written
-- rows carry a dedupe_key, so a future manual/other writer is unconstrained.

ALTER TABLE public.phoenix_movement_events
  ADD COLUMN IF NOT EXISTS dedupe_key text;

CREATE UNIQUE INDEX IF NOT EXISTS phoenix_movement_events_dedupe_uniq
  ON public.phoenix_movement_events (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

COMMENT ON COLUMN public.phoenix_movement_events.dedupe_key IS
  'Idempotency key for trigger-captured lifecycle events: header_id || '':'' || '
  'status. UNIQUE (partial). Makes lost-response retries of a lifecycle RPC '
  'unable to double-record a transition.';

-- ── B. The capture trigger function ─────────────────────────────────────────
-- Generic across every corridor header. TG_ARGV[0] names the INITIATING-org
-- column for that table (the RLS owner of the event). Fires only on a genuine
-- status transition; records auth.uid() as the actor.

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
  v_doc        text  := COALESCE(v_new ->> 'request_number', v_new ->> 'return_number',
                                 v_new ->> 'shipment_number', v_new ->> 'dispatch_number');
BEGIN
  -- Only real transitions. Same-value UPDATEs (metadata edits, second partial
  -- send that leaves status unchanged) never emit an event.
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
    NEW.id::text || ':' || v_new_status
  )
  ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;

  RETURN NEW;
END;
$capture$;

COMMENT ON FUNCTION public.phoenix_capture_lifecycle_event() IS
  'AFTER INSERT/UPDATE capture of corridor header status transitions into '
  'phoenix_movement_events. SECURITY DEFINER so only the trigger path (never a '
  'direct client write) can append. Idempotent via dedupe_key. TG_ARGV[0] = the '
  'initiating-org column that owns the event for RLS.';

REVOKE ALL ON FUNCTION public.phoenix_capture_lifecycle_event() FROM PUBLIC;

-- ── C. Attach to every corridor header ──────────────────────────────────────
-- TG_ARGV[0] = the INITIATING org for each corridor.

DROP TRIGGER IF EXISTS phoenix_capture_lifecycle ON public.warehouse_transfer_requests;
CREATE TRIGGER phoenix_capture_lifecycle
  AFTER INSERT OR UPDATE ON public.warehouse_transfer_requests
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_capture_lifecycle_event('destination_organization_id');

DROP TRIGGER IF EXISTS phoenix_capture_lifecycle ON public.warehouse_return_requests;
CREATE TRIGGER phoenix_capture_lifecycle
  AFTER INSERT OR UPDATE ON public.warehouse_return_requests
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_capture_lifecycle_event('source_organization_id');

DROP TRIGGER IF EXISTS phoenix_capture_lifecycle ON public.warehouse_return_shipments;
CREATE TRIGGER phoenix_capture_lifecycle
  AFTER INSERT OR UPDATE ON public.warehouse_return_shipments
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_capture_lifecycle_event('source_organization_id');

DROP TRIGGER IF EXISTS phoenix_capture_lifecycle ON public.outlet_return_requests;
CREATE TRIGGER phoenix_capture_lifecycle
  AFTER INSERT OR UPDATE ON public.outlet_return_requests
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_capture_lifecycle_event('source_organization_id');

DROP TRIGGER IF EXISTS phoenix_capture_lifecycle ON public.outlet_return_shipments;
CREATE TRIGGER phoenix_capture_lifecycle
  AFTER INSERT OR UPDATE ON public.outlet_return_shipments
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_capture_lifecycle_event('source_organization_id');

DROP TRIGGER IF EXISTS phoenix_capture_lifecycle ON public.warehouse_dispatches;
CREATE TRIGGER phoenix_capture_lifecycle
  AFTER INSERT OR UPDATE ON public.warehouse_dispatches
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_capture_lifecycle_event('organization_id');

-- ── D. Timeline: derived-column events become a HISTORICAL fallback ──────────
-- Once the ledger holds any event for a trace (i.e. the document transitioned
-- after 082), the derived-from-column branch is redundant for that trace and is
-- suppressed, so a transition never appears twice. For pre-082 documents the
-- ledger is empty and the derived branch still surfaces what the columns prove.
-- Everything else about 081's RPC — security posture, pagination, completeness
-- honesty, indistinguishability of forbidden vs nonexistent — is preserved.

CREATE OR REPLACE FUNCTION public.phoenix_movement_timeline(
  p_trace_id  uuid,
  p_limit     integer DEFAULT 50,
  p_after_at  timestamptz DEFAULT NULL,
  p_after_id  uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $timeline$
DECLARE
  v_actor  uuid := auth.uid();
  v_org    uuid;
  v_role   text;
  v_limit  integer;
  v_events jsonb;
  v_has_ledger boolean;
  v_empty  jsonb := jsonb_build_object(
    'ok', true, 'events', '[]'::jsonb, 'complete', false,
    'completeness_note',
      'Partial by construction: only append-only movement rows, explicit header '
      'transition columns and ledger events are returned. Status transitions '
      'without a dedicated timestamp column were never persisted and cannot be '
      'reconstructed.',
    'next_cursor', NULL);
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  v_limit := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);

  SELECT p.organization_id, p.role INTO v_org, v_role
    FROM public.profiles p
   WHERE p.id = v_actor AND p.status = 'active';

  IF NOT FOUND THEN
    RETURN v_empty;
  END IF;

  IF p_trace_id IS NULL THEN
    RETURN v_empty;
  END IF;

  -- Does the ledger already record this trace? If so, derived-column events are
  -- redundant and must be suppressed to avoid duplicating a transition.
  SELECT EXISTS (
    SELECT 1 FROM public.phoenix_movement_events e WHERE e.trace_id = p_trace_id
  ) INTO v_has_ledger;

  WITH
  movement_events AS (
    SELECT m.id                            AS event_id,
           'warehouse_stock_movement'      AS event_type,
           m.created_at                    AS occurred_at,
           m.organization_id,
           m.actor_id, m.actor_role, m.actor_name,
           m.movement_type                 AS status_after,
           m.scientific_name_snapshot      AS material_label,
           m.batch_number_snapshot         AS batch_label,
           m.on_hand_delta                 AS quantity_delta,
           m.reference_type, m.reference_id,
           m.source_document_number        AS reference_label,
           'movement_row'                  AS provenance
      FROM public.warehouse_stock_movements m
     WHERE m.reference_id = p_trace_id OR m.id = p_trace_id
    UNION ALL
    SELECT m.id, 'outlet_stock_movement', m.created_at, m.organization_id,
           m.actor_id, m.actor_role, m.actor_name, m.movement_type,
           m.scientific_name_snapshot, m.batch_number_snapshot, m.on_hand_delta,
           m.reference_type, m.reference_id, m.source_document_number, 'movement_row'
      FROM public.outlet_stock_movements m
     WHERE m.reference_id = p_trace_id OR m.id = p_trace_id
    UNION ALL
    SELECT m.id, 'quarantine_movement', m.created_at, m.organization_id,
           m.actor_id, m.actor_role, m.actor_name, m.movement_type,
           m.scientific_name_snapshot, m.batch_number_snapshot, m.quantity_delta,
           m.reference_type, m.reference_id, m.source_document_number, 'movement_row'
      FROM public.warehouse_quarantine_stock_movements m
     WHERE m.reference_id = p_trace_id OR m.id = p_trace_id
    UNION ALL
    SELECT m.id, 'availability_movement', m.created_at, m.organization_id,
           m.created_by, m.actor_role_snapshot, m.actor_name_snapshot, m.movement_type,
           m.scientific_name, NULL, m.quantity_delta,
           NULL, m.dispatch_line_id, NULL, 'movement_row'
      FROM public.item_availability_movements m
     WHERE m.dispatch_line_id = p_trace_id OR m.id = p_trace_id
  ),
  derived_events AS (
    SELECT r.id AS event_id, 'return_requested' AS event_type, r.requested_at AS occurred_at,
           r.source_organization_id AS organization_id,
           r.requested_by AS actor_id, NULL::text, NULL::text, r.status,
           NULL::text, NULL::text, NULL::integer,
           'outlet_return_request'::text, r.id, r.return_number, 'derived_from_column'::text
      FROM public.outlet_return_requests r
     WHERE r.id = p_trace_id AND r.requested_at IS NOT NULL AND NOT v_has_ledger
    UNION ALL
    SELECT r.id, 'return_reviewed', r.reviewed_at, r.source_organization_id,
           r.reviewed_by, NULL, NULL, r.status, NULL, NULL, NULL,
           'outlet_return_request', r.id, r.return_number, 'derived_from_column'
      FROM public.outlet_return_requests r
     WHERE r.id = p_trace_id AND r.reviewed_at IS NOT NULL AND NOT v_has_ledger
    UNION ALL
    SELECT r.id, 'return_cancelled', r.cancelled_at, r.source_organization_id,
           r.cancelled_by, NULL, NULL, r.status, NULL, NULL, NULL,
           'outlet_return_request', r.id, r.return_number, 'derived_from_column'
      FROM public.outlet_return_requests r
     WHERE r.id = p_trace_id AND r.cancelled_at IS NOT NULL AND NOT v_has_ledger
    UNION ALL
    SELECT s.id, 'return_shipment_sent', s.sent_at, s.source_organization_id,
           s.sent_by, NULL, NULL, s.status, NULL, NULL, NULL,
           'outlet_return_shipment', s.id, s.shipment_number, 'derived_from_column'
      FROM public.outlet_return_shipments s
     WHERE s.id = p_trace_id AND s.sent_at IS NOT NULL AND NOT v_has_ledger
    UNION ALL
    SELECT d.id, 'dispatch_sent', d.sent_at, d.organization_id,
           d.sent_by, NULL, NULL, d.status, NULL, NULL, NULL,
           'warehouse_dispatch', d.id, d.dispatch_number, 'derived_from_column'
      FROM public.warehouse_dispatches d
     WHERE d.id = p_trace_id AND d.sent_at IS NOT NULL AND NOT v_has_ledger
    UNION ALL
    SELECT d.id, 'dispatch_cancelled', d.cancelled_at, d.organization_id,
           d.cancelled_by, NULL, NULL, d.status, NULL, NULL, NULL,
           'warehouse_dispatch', d.id, d.dispatch_number, 'derived_from_column'
      FROM public.warehouse_dispatches d
     WHERE d.id = p_trace_id AND d.cancelled_at IS NOT NULL AND NOT v_has_ledger
  ),
  ledger_events AS (
    SELECT e.id, e.event_type, e.occurred_at, e.organization_id,
           e.actor_id, e.actor_role, e.actor_name, e.status_after,
           e.material_label, e.batch_label, e.quantity_delta,
           e.reference_type, e.reference_id, e.notes, 'event_ledger'
      FROM public.phoenix_movement_events e
     WHERE e.trace_id = p_trace_id
  ),
  all_events AS (
    SELECT * FROM movement_events
    UNION ALL SELECT * FROM derived_events
    UNION ALL SELECT * FROM ledger_events
  ),
  scoped AS (
    SELECT * FROM all_events a
     WHERE v_role = 'super_admin'
        OR (v_org IS NOT NULL AND a.organization_id = v_org)
  ),
  paged AS (
    SELECT * FROM scoped s
     WHERE p_after_at IS NULL
        OR (s.occurred_at, s.event_id) > (p_after_at, p_after_id)
     ORDER BY s.occurred_at ASC, s.event_id ASC
     LIMIT v_limit
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'event_id',       p.event_id,
           'event_type',     p.event_type,
           'occurred_at',    p.occurred_at,
           'actor_id',       p.actor_id,
           'actor_role',     p.actor_role,
           'actor_name',     p.actor_name,
           'status',         p.status_after,
           'material',       p.material_label,
           'batch',          p.batch_label,
           'quantity_delta', p.quantity_delta,
           'reference_type', p.reference_type,
           'reference_id',   p.reference_id,
           'reference',      p.reference_label,
           'provenance',     p.provenance
         ) ORDER BY p.occurred_at ASC, p.event_id ASC), '[]'::jsonb)
    INTO v_events
    FROM paged p;

  RETURN jsonb_build_object(
    'ok', true,
    'events', v_events,
    'complete', false,
    'completeness_note', v_empty -> 'completeness_note',
    'next_cursor',
      CASE WHEN jsonb_array_length(v_events) = v_limit
        THEN jsonb_build_object(
               'after_at', v_events -> (v_limit - 1) -> 'occurred_at',
               'after_id', v_events -> (v_limit - 1) -> 'event_id')
        ELSE NULL END
  );
END;
$timeline$;

REVOKE ALL ON FUNCTION public.phoenix_movement_timeline(uuid, integer, timestamptz, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_movement_timeline(uuid, integer, timestamptz, uuid) TO authenticated;

COMMIT;

-- ============================================================================
-- POST-CONDITIONS — run AFTER apply. Read-only.
-- ============================================================================
-- 1. The trigger exists on every corridor header:
--    SELECT c.relname, t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
--     WHERE t.tgname='phoenix_capture_lifecycle' ORDER BY c.relname;
--    -- expect 6 rows.
--
-- 2. The capture function is SECURITY DEFINER, pinned:
--    SELECT prosecdef, proconfig FROM pg_proc WHERE proname='phoenix_capture_lifecycle_event';
--    -- expect prosecdef=t, {search_path=public, pg_temp}
--
-- 3. dedupe_key is UNIQUE (partial):
--    SELECT indexname FROM pg_indexes WHERE tablename='phoenix_movement_events'
--     AND indexname='phoenix_movement_events_dedupe_uniq';
--
-- 4. authenticated still cannot write the ledger (unchanged from 081):
--    SELECT has_table_privilege('authenticated','public.phoenix_movement_events','INSERT'); -- f
--
-- ============================================================================
-- ROLLBACK / CONTAINMENT
-- ============================================================================
--   BEGIN;
--     DROP TRIGGER IF EXISTS phoenix_capture_lifecycle ON public.warehouse_transfer_requests;
--     DROP TRIGGER IF EXISTS phoenix_capture_lifecycle ON public.warehouse_return_requests;
--     DROP TRIGGER IF EXISTS phoenix_capture_lifecycle ON public.warehouse_return_shipments;
--     DROP TRIGGER IF EXISTS phoenix_capture_lifecycle ON public.outlet_return_requests;
--     DROP TRIGGER IF EXISTS phoenix_capture_lifecycle ON public.outlet_return_shipments;
--     DROP TRIGGER IF EXISTS phoenix_capture_lifecycle ON public.warehouse_dispatches;
--     DROP FUNCTION IF EXISTS public.phoenix_capture_lifecycle_event();
--     -- (the timeline reverts to 081's body; re-apply 081's function to fully revert)
--   COMMIT;
-- Containment without a schema change: the ledger simply stops accruing events;
-- the timeline continues to work from movement rows and derived columns.
-- ============================================================================
