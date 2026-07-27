-- ============================================================================
-- MOVEMENT-TIMELINE-CONTRACT-FIELDS-139
--
-- Reporting Closure Final, Phase 2/3: phoenix_movement_timeline (081) is the
-- per-document drill-down behind Custody Chain. Its event payload was written
-- BEFORE the Unified Movements contract existed (122-137), so it still emits
-- only quantity_delta and never surfaces the fields the contract added:
--   * reason_code                      (125, on all three live ledgers)
--   * quantity_before / quantity_after (present on the ledgers all along;
--                                       added to phoenix_movement_events by 124)
--   * correlation_id / causation_id    (124, on the ledgers AND the envelope)
-- It also read created_at rather than the contract's occurred_at (124).
--
-- This migration replaces the function body ONLY. Same name, same signature,
-- same return type, same security posture, same scope check, same pagination
-- and the same honest `complete: false` / completeness_note contract. Every
-- existing key in each event object is preserved with identical semantics —
-- this is purely ADDITIVE to the per-event payload, so no existing consumer
-- can break.
--
-- WHY NOT JUST READ THE LEDGERS FROM THE CLIENT
--   Custody Chain drills down by TRACE (one document's whole lifecycle across
--   four source tables plus derived header transitions plus the event ledger).
--   That union already lives here, correctly scope-checked. Duplicating it
--   client-side, or adding a second RPC that returns a subset, would create
--   exactly the competing implementation the reporting-closure parity matrix
--   exists to prevent. 138's phoenix_movement_ledger_report is the BROAD
--   filtered report; this stays the per-document trace. Two different
--   questions, two RPCs, no overlap.
--
-- DISPENSE CONTEXT
--   Emitted as a `has_dispense_context` BOOLEAN only, exactly as 138 does.
--   The beneficiary detail itself is never returned here — the client must
--   call the existing masked phoenix_get_movement_dispense_context(movement_id),
--   so 134/136's movement_context.view_sensitive masking stays the single
--   source of truth and is neither reimplemented nor bypassed.
--
-- PRECONDITIONS: 081 (the function), 124 (occurred_at/correlation/causation),
--   125 (reason_code), 134 (phoenix_movement_dispense_context).
-- ============================================================================

BEGIN;

DO $precond$
BEGIN
  IF to_regprocedure('public.phoenix_movement_timeline(uuid, integer, timestamptz, uuid)') IS NULL THEN
    RAISE EXCEPTION '139 PRECONDITION FAILED: phoenix_movement_timeline missing — apply 081 first';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'warehouse_stock_movements'
       AND column_name = 'reason_code'
  ) THEN
    RAISE EXCEPTION '139 PRECONDITION FAILED: reason_code missing — apply 125 first';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'phoenix_movement_events'
       AND column_name = 'correlation_id'
  ) THEN
    RAISE EXCEPTION '139 PRECONDITION FAILED: correlation_id missing on the envelope — apply 124 first';
  END IF;
  IF to_regclass('public.phoenix_movement_dispense_context') IS NULL THEN
    RAISE EXCEPTION '139 PRECONDITION FAILED: phoenix_movement_dispense_context missing — apply 134 first';
  END IF;
END;
$precond$;

CREATE OR REPLACE FUNCTION public.phoenix_movement_timeline(
  p_trace_id uuid,
  p_limit    integer DEFAULT 50,
  p_after_at timestamptz DEFAULT NULL,
  p_after_id uuid DEFAULT NULL
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
  -- Unchanged from 081: unauthorized and nonexistent traces are
  -- INDISTINGUISHABLE — both return this exact shape, so the RPC can never
  -- be used as an existence oracle.
  v_empty  jsonb := jsonb_build_object(
    'ok', true,
    'events', '[]'::jsonb,
    'complete', false,
    'completeness_note',
      'A complete retrospective history cannot be reconstructed from the '
      'current schema. Events are reported with their provenance: '
      'movement_row (an append-only fact), derived_from_column (proven by a '
      'non-NULL timestamp+actor pair on a corridor header), or event_ledger '
      '(recorded by phoenix_movement_events). Status transitions that left no '
      'column behind are not retained and are therefore absent, never inferred.',
    'next_cursor', NULL
  );
BEGIN
  IF v_actor IS NULL THEN
    RETURN v_empty;
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

  WITH
  movement_events AS (
    SELECT m.id                            AS event_id,
           'warehouse_stock_movement'      AS event_type,
           -- 124's contract field; falls back to created_at defensively even
           -- though 124 backfilled and NOT NULL-ed it.
           COALESCE(m.occurred_at, m.created_at) AS occurred_at,
           m.organization_id,
           m.actor_id, m.actor_role, m.actor_name,
           m.movement_type                 AS status_after,
           m.scientific_name_snapshot      AS material_label,
           m.batch_number_snapshot         AS batch_label,
           m.on_hand_delta                 AS quantity_delta,
           m.reference_type, m.reference_id,
           m.source_document_number        AS reference_label,
           'movement_row'                  AS provenance,
           m.reason_code                   AS reason_code,
           m.on_hand_before                AS quantity_before,
           m.on_hand_after                 AS quantity_after,
           m.correlation_id, m.causation_id,
           false                           AS has_dispense_context
      FROM public.warehouse_stock_movements m
     WHERE m.reference_id = p_trace_id OR m.id = p_trace_id
    UNION ALL
    SELECT m.id, 'outlet_stock_movement', COALESCE(m.occurred_at, m.created_at), m.organization_id,
           m.actor_id, m.actor_role, m.actor_name, m.movement_type,
           m.scientific_name_snapshot, m.batch_number_snapshot, m.on_hand_delta,
           m.reference_type, m.reference_id, m.source_document_number, 'movement_row',
           m.reason_code, m.on_hand_before, m.on_hand_after,
           m.correlation_id, m.causation_id,
           EXISTS (SELECT 1 FROM public.phoenix_movement_dispense_context c WHERE c.movement_id = m.id)
      FROM public.outlet_stock_movements m
     WHERE m.reference_id = p_trace_id OR m.id = p_trace_id
    UNION ALL
    SELECT m.id, 'quarantine_movement', COALESCE(m.occurred_at, m.created_at), m.organization_id,
           m.actor_id, m.actor_role, m.actor_name, m.movement_type,
           m.scientific_name_snapshot, m.batch_number_snapshot, m.quantity_delta,
           m.reference_type, m.reference_id, m.source_document_number, 'movement_row',
           m.reason_code, m.quantity_before, m.quantity_after,
           m.correlation_id, m.causation_id,
           false
      FROM public.warehouse_quarantine_stock_movements m
     WHERE m.reference_id = p_trace_id OR m.id = p_trace_id
    UNION ALL
    -- item_availability_movements is the LEGACY table (033) whose sole writer
    -- has zero production call sites. Kept in the union unchanged for
    -- backward compatibility with any historical row, but it never carried
    -- the contract fields, so those are honestly NULL rather than invented.
    SELECT m.id, 'availability_movement', m.created_at, m.organization_id,
           m.created_by, m.actor_role_snapshot, m.actor_name_snapshot, m.movement_type,
           m.scientific_name, NULL, m.quantity_delta,
           NULL, m.dispatch_line_id, NULL, 'movement_row',
           NULL::text, m.quantity_before, m.quantity_after,
           NULL::uuid, NULL::uuid,
           false
      FROM public.item_availability_movements m
     WHERE m.dispatch_line_id = p_trace_id OR m.id = p_trace_id
  ),
  derived_events AS (
    SELECT r.id AS event_id, 'return_requested' AS event_type, r.requested_at AS occurred_at,
           r.source_organization_id AS organization_id,
           r.requested_by AS actor_id, NULL::text, NULL::text, r.status,
           NULL::text, NULL::text, NULL::integer,
           'outlet_return_request'::text, r.id, r.return_number, 'derived_from_column'::text,
           NULL::text, NULL::integer, NULL::integer, NULL::uuid, NULL::uuid, false
      FROM public.outlet_return_requests r
     WHERE r.id = p_trace_id AND r.requested_at IS NOT NULL
    UNION ALL
    SELECT r.id, 'return_reviewed', r.reviewed_at, r.source_organization_id,
           r.reviewed_by, NULL, NULL, r.status, NULL, NULL, NULL,
           'outlet_return_request', r.id, r.return_number, 'derived_from_column',
           NULL, NULL, NULL, NULL, NULL, false
      FROM public.outlet_return_requests r
     WHERE r.id = p_trace_id AND r.reviewed_at IS NOT NULL
    UNION ALL
    SELECT r.id, 'return_cancelled', r.cancelled_at, r.source_organization_id,
           r.cancelled_by, NULL, NULL, r.status, NULL, NULL, NULL,
           'outlet_return_request', r.id, r.return_number, 'derived_from_column',
           NULL, NULL, NULL, NULL, NULL, false
      FROM public.outlet_return_requests r
     WHERE r.id = p_trace_id AND r.cancelled_at IS NOT NULL
    UNION ALL
    SELECT s.id, 'return_shipment_sent', s.sent_at, s.source_organization_id,
           s.sent_by, NULL, NULL, s.status, NULL, NULL, NULL,
           'outlet_return_shipment', s.id, s.shipment_number, 'derived_from_column',
           NULL, NULL, NULL, NULL, NULL, false
      FROM public.outlet_return_shipments s
     WHERE s.id = p_trace_id AND s.sent_at IS NOT NULL
    UNION ALL
    SELECT d.id, 'dispatch_sent', d.sent_at, d.organization_id,
           d.sent_by, NULL, NULL, d.status, NULL, NULL, NULL,
           'warehouse_dispatch', d.id, d.dispatch_number, 'derived_from_column',
           NULL, NULL, NULL, NULL, NULL, false
      FROM public.warehouse_dispatches d
     WHERE d.id = p_trace_id AND d.sent_at IS NOT NULL
    UNION ALL
    SELECT d.id, 'dispatch_cancelled', d.cancelled_at, d.organization_id,
           d.cancelled_by, NULL, NULL, d.status, NULL, NULL, NULL,
           'warehouse_dispatch', d.id, d.dispatch_number, 'derived_from_column',
           NULL, NULL, NULL, NULL, NULL, false
      FROM public.warehouse_dispatches d
     WHERE d.id = p_trace_id AND d.cancelled_at IS NOT NULL
  ),
  ledger_events AS (
    SELECT e.id, e.event_type, e.occurred_at, e.organization_id,
           e.actor_id, e.actor_role, e.actor_name, e.status_after,
           e.material_label, e.batch_label, e.quantity_delta,
           e.reference_type, e.reference_id, e.notes, 'event_ledger',
           -- The envelope has no reason_code column (its 123/124 capture
           -- trigger predates 125), so it is honestly NULL here rather than
           -- guessed from the movement row.
           NULL::text, e.quantity_before, e.quantity_after,
           e.correlation_id, e.causation_id, false
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
           'provenance',     p.provenance,
           -- ── 139 additive contract fields ──────────────────────────────
           'reason_code',          p.reason_code,
           'quantity_before',      p.quantity_before,
           'quantity_after',       p.quantity_after,
           'correlation_id',       p.correlation_id,
           'causation_id',         p.causation_id,
           'has_dispense_context', p.has_dispense_context
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

REVOKE ALL ON FUNCTION public.phoenix_movement_timeline(uuid, integer, timestamptz, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_movement_timeline(uuid, integer, timestamptz, uuid) TO authenticated;

DO $verify$
DECLARE
  v_src text;
  v_count integer;
BEGIN
  SELECT pg_get_functiondef(
    to_regprocedure('public.phoenix_movement_timeline(uuid, integer, timestamptz, uuid)')
  ) INTO v_src;

  IF v_src IS NULL THEN
    RAISE EXCEPTION '139 VERIFY FAILED: phoenix_movement_timeline not found after replace';
  END IF;

  -- Every additive key must genuinely be emitted, not merely selected.
  IF position('''reason_code''' IN v_src) = 0
     OR position('''quantity_before''' IN v_src) = 0
     OR position('''quantity_after''' IN v_src) = 0
     OR position('''correlation_id''' IN v_src) = 0
     OR position('''causation_id''' IN v_src) = 0
     OR position('''has_dispense_context''' IN v_src) = 0 THEN
    RAISE EXCEPTION '139 VERIFY FAILED: an additive contract key is not emitted by the timeline payload';
  END IF;

  -- Every ORIGINAL key must survive — this is additive, never a replacement.
  IF position('''event_id''' IN v_src) = 0
     OR position('''provenance''' IN v_src) = 0
     OR position('''quantity_delta''' IN v_src) = 0
     OR position('''reference''' IN v_src) = 0 THEN
    RAISE EXCEPTION '139 VERIFY FAILED: an original timeline key was lost';
  END IF;

  -- Security posture unchanged.
  IF position('SECURITY DEFINER' IN v_src) = 0 OR position('search_path' IN v_src) = 0 THEN
    RAISE EXCEPTION '139 VERIFY FAILED: SECURITY DEFINER / pinned search_path lost';
  END IF;

  SELECT count(*) INTO v_count
    FROM information_schema.role_routine_grants
   WHERE routine_schema = 'public'
     AND routine_name = 'phoenix_movement_timeline'
     AND grantee = 'anon';
  IF v_count <> 0 THEN
    RAISE EXCEPTION '139 VERIFY FAILED: anon must hold zero grants, found %', v_count;
  END IF;

  RAISE NOTICE 'MOVEMENT-TIMELINE-CONTRACT-FIELDS-139: verified.';
END;
$verify$;

COMMIT;
