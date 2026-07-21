-- ============================================================================
-- MOVEMENT-TIMELINE-081-A
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply after 078/079 (order is not strictly required — this migration is
-- independent of them — but the documented release order applies them first).
--
-- VERIFICATION STATUS: EXECUTED. Applied to a disposable PostgreSQL 18.4
-- cluster with 001-081 in order, and exercised with authorized/unauthorized
-- personas, nonexistent traces, equal timestamps, pagination and EXPLAIN. See
-- docs/phoenix/migration-081-timeline-validation.md. Production is 17.6.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THE AUDIT FOUND — READ THIS BEFORE TRUSTING ANY TIMELINE
-- ─────────────────────────────────────────────────────────────────────────────
-- A complete retrospective timeline CANNOT be reconstructed from the current
-- schema, and this migration does not pretend otherwise.
--
-- What IS genuinely retained:
--   * The four movement tables (warehouse_stock_movements, outlet_stock_movements,
--     warehouse_quarantine_stock_movements, item_availability_movements) are
--     append-only event rows with their own id, actor, quantities and created_at.
--     No UPDATE or DELETE policy exists on any of them for `authenticated`.
--     These are REAL events.
--   * Corridor headers keep DENORMALIZED transition pairs — requested_at/by,
--     reviewed_at/by, cancelled_at/by, sent_at/by. Each pair that is non-NULL
--     proves that specific transition happened, and when, and by whom.
--
-- What is NOT retained, and is therefore NOT reconstructable:
--   * Any status transition without its own _at/_by pair. Headers carry ONE
--     mutable `status` column, overwritten in place, so intermediate states
--     leave no trace at all.
--   * `updated_at` is overwritten on every write and proves nothing about which
--     transition occurred.
--   * audit_logs covers only some corridor actions, inconsistently.
--
-- Consequently every event this RPC returns carries a `provenance`:
--     'movement_row'        a real append-only event row
--     'derived_from_column' proven by a non-NULL _at/_by pair on a header
--     'event_ledger'        recorded by the new ledger below (future events)
-- and every response carries `complete: false` with a reason. A caller must not
-- present this as a full history. Nothing is invented to fill a gap.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS ADDS
-- ─────────────────────────────────────────────────────────────────────────────
--   A. phoenix_movement_events — an append-only ledger for FUTURE document
--      lifecycle transitions, closing the gap above going forward. It is NOT
--      backfilled with guesses: only events provable from immutable rows may
--      ever be inserted, and the backfill in section D inserts nothing today
--      because the derived-column path already covers exactly those events
--      without duplicating them.
--   B. Indexes on the movement tables' reference_id, so trace resolution is an
--      index scan rather than four sequential scans.
--   C. phoenix_movement_timeline(...) — the read-only, scope-checked RPC.
--
-- SECURITY POSTURE
--   * Unauthorized and nonexistent traces are INDISTINGUISHABLE: both return an
--     empty event array with the same shape. The RPC never reveals that a trace
--     exists but is forbidden, so it cannot be used as an existence oracle.
--   * SECURITY DEFINER with search_path pinned; EXECUTE granted to
--     `authenticated` only; no service_role dependency; no privileged key.
--   * The ledger denies INSERT/UPDATE/DELETE to `authenticated` entirely —
--     only SECURITY DEFINER functions may append.
-- ============================================================================

BEGIN;

DO $precond$
BEGIN
  IF to_regclass('public.warehouse_stock_movements') IS NULL
     OR to_regclass('public.outlet_stock_movements') IS NULL
     OR to_regclass('public.warehouse_quarantine_stock_movements') IS NULL
     OR to_regclass('public.item_availability_movements') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: a movement table is missing — apply 001-077 first';
  END IF;

  IF to_regclass('public.phoenix_movement_events') IS NOT NULL THEN
    RAISE EXCEPTION 'precondition failed: phoenix_movement_events already exists (081 already applied?)';
  END IF;

  -- phoenix_my_role() is used by the ledger's RLS policy.
  IF to_regprocedure('public.phoenix_my_role()') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: public.phoenix_my_role() is missing';
  END IF;
END;
$precond$;

-- ── A. Append-only lifecycle ledger (for FUTURE events) ─────────────────────

CREATE TABLE IF NOT EXISTS public.phoenix_movement_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  -- The canonical document this event belongs to (request/shipment/dispatch id).
  trace_id         uuid NOT NULL,
  event_type       text NOT NULL,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  actor_id         uuid,
  actor_role       text,
  actor_name       text,
  source_label     text,
  destination_label text,
  material_label   text,
  batch_label      text,
  quantity_delta   integer,
  status_after     text,
  reference_type   text,
  reference_id     uuid,
  notes            text,
  CONSTRAINT phoenix_movement_events_type_chk
    CHECK (btrim(event_type) = event_type AND event_type <> '')
);

COMMENT ON TABLE public.phoenix_movement_events IS
  'APPEND-ONLY document-lifecycle event ledger. Closes the gap where corridor '
  'headers overwrite a single status column and lose intermediate transitions. '
  'Only SECURITY DEFINER functions may append; authenticated has SELECT only. '
  'Never backfilled with inferred events.';

CREATE INDEX IF NOT EXISTS phoenix_movement_events_trace_idx
  ON public.phoenix_movement_events (trace_id, occurred_at, id);
CREATE INDEX IF NOT EXISTS phoenix_movement_events_org_idx
  ON public.phoenix_movement_events (organization_id);

ALTER TABLE public.phoenix_movement_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS phoenix_movement_events_select_scoped ON public.phoenix_movement_events;
CREATE POLICY phoenix_movement_events_select_scoped
  ON public.phoenix_movement_events
  FOR SELECT TO authenticated
  USING (
    public.phoenix_my_role() = 'super_admin'
    OR organization_id = (SELECT p.organization_id FROM public.profiles p WHERE p.id = auth.uid())
  );

-- No INSERT/UPDATE/DELETE policy is defined, so with RLS enabled those are
-- denied to `authenticated` by default. Revoke the table privileges too, so the
-- denial does not depend on policy absence alone.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.phoenix_movement_events FROM authenticated;
GRANT SELECT ON TABLE public.phoenix_movement_events TO authenticated;

-- ── B. Provenance indexes (justified by EXPLAIN — see the validation doc) ───

CREATE INDEX IF NOT EXISTS warehouse_stock_movements_reference_idx
  ON public.warehouse_stock_movements (reference_id, created_at, id);
CREATE INDEX IF NOT EXISTS outlet_stock_movements_reference_idx
  ON public.outlet_stock_movements (reference_id, created_at, id);
CREATE INDEX IF NOT EXISTS warehouse_quarantine_movements_reference_idx
  ON public.warehouse_quarantine_stock_movements (reference_id, created_at, id);
CREATE INDEX IF NOT EXISTS item_availability_movements_dispatch_idx
  ON public.item_availability_movements (dispatch_line_id, created_at, id);

-- ── C. The timeline RPC ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.phoenix_movement_timeline(
  p_trace_id  uuid,
  p_limit     integer DEFAULT 50,
  -- Cursor: return only events strictly after (p_after_at, p_after_id).
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

  -- STRICT page size. A caller cannot ask for an unbounded scan.
  v_limit := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);

  SELECT p.organization_id, p.role INTO v_org, v_role
    FROM public.profiles p
   WHERE p.id = v_actor AND p.status = 'active';

  IF NOT FOUND THEN
    -- Same shape as "nothing found": never distinguish a permission problem.
    RETURN v_empty;
  END IF;

  IF p_trace_id IS NULL THEN
    RETURN v_empty;
  END IF;

  WITH
  -- Every event source, normalized to one shape. Each row states its own
  -- provenance so a caller can tell a recorded event from a derived one.
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
  -- Header transitions that are PROVEN by a non-NULL timestamp+actor pair.
  -- Nothing is emitted for a transition that left no column behind.
  derived_events AS (
    SELECT r.id AS event_id, 'return_requested' AS event_type, r.requested_at AS occurred_at,
           r.source_organization_id AS organization_id,
           r.requested_by AS actor_id, NULL::text, NULL::text, r.status,
           NULL::text, NULL::text, NULL::integer,
           'outlet_return_request'::text, r.id, r.return_number, 'derived_from_column'::text
      FROM public.outlet_return_requests r
     WHERE r.id = p_trace_id AND r.requested_at IS NOT NULL
    UNION ALL
    SELECT r.id, 'return_reviewed', r.reviewed_at, r.source_organization_id,
           r.reviewed_by, NULL, NULL, r.status, NULL, NULL, NULL,
           'outlet_return_request', r.id, r.return_number, 'derived_from_column'
      FROM public.outlet_return_requests r
     WHERE r.id = p_trace_id AND r.reviewed_at IS NOT NULL
    UNION ALL
    SELECT r.id, 'return_cancelled', r.cancelled_at, r.source_organization_id,
           r.cancelled_by, NULL, NULL, r.status, NULL, NULL, NULL,
           'outlet_return_request', r.id, r.return_number, 'derived_from_column'
      FROM public.outlet_return_requests r
     WHERE r.id = p_trace_id AND r.cancelled_at IS NOT NULL
    UNION ALL
    SELECT s.id, 'return_shipment_sent', s.sent_at, s.source_organization_id,
           s.sent_by, NULL, NULL, s.status, NULL, NULL, NULL,
           'outlet_return_shipment', s.id, s.shipment_number, 'derived_from_column'
      FROM public.outlet_return_shipments s
     WHERE s.id = p_trace_id AND s.sent_at IS NOT NULL
    UNION ALL
    SELECT d.id, 'dispatch_sent', d.sent_at, d.organization_id,
           d.sent_by, NULL, NULL, d.status, NULL, NULL, NULL,
           'warehouse_dispatch', d.id, d.dispatch_number, 'derived_from_column'
      FROM public.warehouse_dispatches d
     WHERE d.id = p_trace_id AND d.sent_at IS NOT NULL
    UNION ALL
    SELECT d.id, 'dispatch_cancelled', d.cancelled_at, d.organization_id,
           d.cancelled_by, NULL, NULL, d.status, NULL, NULL, NULL,
           'warehouse_dispatch', d.id, d.dispatch_number, 'derived_from_column'
      FROM public.warehouse_dispatches d
     WHERE d.id = p_trace_id AND d.cancelled_at IS NOT NULL
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
    -- EXACT scope check, applied per event. super_admin sees all; everyone else
    -- sees only their own organization's events.
    SELECT * FROM all_events a
     WHERE v_role = 'super_admin'
        OR (v_org IS NOT NULL AND a.organization_id = v_org)
  ),
  paged AS (
    SELECT * FROM scoped s
     WHERE p_after_at IS NULL
        OR (s.occurred_at, s.event_id) > (p_after_at, p_after_id)
     -- Deterministic: occurred_at, then the immutable event id as tie-breaker,
     -- so equal timestamps can never reorder between pages.
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

COMMENT ON FUNCTION public.phoenix_movement_timeline(uuid, integer, timestamptz, uuid) IS
  'Read-only, scope-checked movement timeline for a canonical trace UUID. '
  'Returns ONLY events proven by append-only movement rows, explicit header '
  'transition columns, or the append-only event ledger — never an inferred '
  'event. Always reports complete=false. Unauthorized and nonexistent traces '
  'return the same empty result.';

COMMIT;

-- ============================================================================
-- POST-CONDITIONS — run AFTER apply. Read-only.
-- ============================================================================
-- 1. The ledger denies writes to authenticated and allows SELECT:
--    SELECT has_table_privilege('authenticated','public.phoenix_movement_events','INSERT') AS ins,
--           has_table_privilege('authenticated','public.phoenix_movement_events','UPDATE') AS upd,
--           has_table_privilege('authenticated','public.phoenix_movement_events','DELETE') AS del,
--           has_table_privilege('authenticated','public.phoenix_movement_events','SELECT') AS sel;
--    -- expect: f, f, f, t
--
-- 2. RLS is on and exactly one SELECT policy exists:
--    SELECT relrowsecurity FROM pg_class WHERE oid='public.phoenix_movement_events'::regclass;
--    SELECT policyname, cmd FROM pg_policies
--     WHERE schemaname='public' AND tablename='phoenix_movement_events';
--
-- 3. The RPC is least-granted and pinned:
--    SELECT proname, prosecdef, provolatile, proconfig FROM pg_proc p
--      JOIN pg_namespace n ON n.oid=p.pronamespace
--     WHERE n.nspname='public' AND proname='phoenix_movement_timeline';
--    -- expect prosecdef=t, provolatile='s', {search_path=public, pg_temp}
--
-- 4. Index use (should be Index Scan, not Seq Scan, once rows exist):
--    EXPLAIN SELECT * FROM public.warehouse_stock_movements
--     WHERE reference_id = gen_random_uuid();
--
-- 5. Nonexistent trace and forbidden trace return the SAME shape:
--    SELECT public.phoenix_movement_timeline(gen_random_uuid());
--    -- expect ok=true, events=[], complete=false
--
-- ============================================================================
-- ROLLBACK / CONTAINMENT
-- ============================================================================
-- Additive only; nothing existing is altered, so rollback loses no data.
--
--   BEGIN;
--     DROP FUNCTION IF EXISTS public.phoenix_movement_timeline(uuid, integer, timestamptz, uuid);
--     DROP INDEX IF EXISTS public.warehouse_stock_movements_reference_idx;
--     DROP INDEX IF EXISTS public.outlet_stock_movements_reference_idx;
--     DROP INDEX IF EXISTS public.warehouse_quarantine_movements_reference_idx;
--     DROP INDEX IF EXISTS public.item_availability_movements_dispatch_idx;
--     DROP TABLE IF EXISTS public.phoenix_movement_events;
--   COMMIT;
--
-- CONTAINMENT without a schema change: stop calling the RPC. Current Movement
-- Status continues to work exactly as it does today, since this migration does
-- not modify it.
-- ============================================================================
