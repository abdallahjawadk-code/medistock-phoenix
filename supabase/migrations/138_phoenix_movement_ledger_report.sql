-- ============================================================================
-- MOVEMENT-LEDGER-REPORT-138
--
-- Reporting Closure Final, Phase 3: replaces the Stock Movements report's
-- legacy `item_availability_movements` source (a dead table — its sole
-- writer has zero production call sites, see
-- src/features/inventory/__tests__/legacy-availability-writer-audit.test.ts)
-- with a single canonical, paginated, org-scoped read RPC over the three
-- LIVE quantity ledgers the Unified Movements contract (122-137) actually
-- populates: warehouse_stock_movements, outlet_stock_movements,
-- warehouse_quarantine_stock_movements.
--
-- WHY A NEW RPC INSTEAD OF phoenix_movement_timeline (081) OR
-- phoenix_movement_events (081/123/124) DIRECTLY
--   * phoenix_movement_timeline is scoped to ONE trace_id (a single
--     document's lifecycle) — it has no filter/pagination shape for a
--     broad "all movements in a date range" report. Wrong tool for this job.
--   * phoenix_movement_events (the envelope table) never had `reason_code`
--     threaded through phoenix_capture_movement_posted() — that trigger was
--     last touched in migration 124, before 125 introduced reason_code — so
--     it cannot supply reason_code today without altering the capture path
--     that Production already depends on. It also never carries
--     material/batch/location labels (081's derived-column path is for a
--     different, manual event kind).
--   * The three ledger tables themselves already carry every field this
--     report needs natively (scientific_name_snapshot, batch_number_snapshot,
--     reason_code, quantity_before/delta/after, correlation_id, causation_id,
--     actor_*, reference_type/reference_id, source_document_number) — reading
--     them directly through one UNIONing, org-scoped, paginated SECURITY
--     DEFINER RPC is the smallest correct fix, and touches nothing that
--     Production's existing writers/triggers depend on.
--
-- SECURITY POSTURE
--   * SECURITY DEFINER, search_path pinned, STABLE.
--   * Org isolation: super_admin sees any org explicitly requested; every
--     other role is hard-restricted to their own profile's organization_id
--     regardless of what p_organization_id claims — same convention as
--     phoenix_get_movement_dispense_context (136) and
--     phoenix_status_center_authorized (092).
--   * Gated by the EXISTING 'status_center.view' permission (010/012/092) —
--     the same permission that already gates Status Center and DIRC, both
--     of which already embed this exact report. No new permission key.
--   * No raw table is exposed to `authenticated` — only this RPC's shaped,
--     paginated output. No direct SELECT grant added on any ledger table.
--   * Bounded pagination: p_limit is clamped to [1, 200] server-side, never
--     trusts the client to self-limit. total_count is returned via a window
--     function so the client can show honest "N of M" pagination.
--   * Dispense context is NEVER exposed inline here — only a boolean
--     `has_dispense_context` flag (outlet rows only). The client must call
--     the existing masked phoenix_get_movement_dispense_context(movement_id)
--     for the actual beneficiary detail, preserving 134/136's masking
--     entirely unchanged.
--
-- PRECONDITIONS: 122-137 applied (the three ledgers carry reason_code,
--   correlation_id, causation_id, occurred_at; phoenix_movement_dispense_context
--   exists).
-- ============================================================================

BEGIN;

DO $precond$
BEGIN
  IF to_regclass('public.warehouse_stock_movements') IS NULL
     OR to_regclass('public.outlet_stock_movements') IS NULL
     OR to_regclass('public.warehouse_quarantine_stock_movements') IS NULL
     OR to_regclass('public.phoenix_movement_dispense_context') IS NULL THEN
    RAISE EXCEPTION '138 PRECONDITION FAILED: a source table is missing — apply 060/067/069/134 first';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'warehouse_stock_movements'
       AND column_name = 'reason_code'
  ) THEN
    RAISE EXCEPTION '138 PRECONDITION FAILED: reason_code missing on warehouse_stock_movements — apply 125 first';
  END IF;

  IF to_regprocedure('public.phoenix_status_center_authorized(uuid, text)') IS NULL THEN
    RAISE EXCEPTION '138 PRECONDITION FAILED: phoenix_status_center_authorized missing — apply 092 first';
  END IF;
END;
$precond$;

CREATE OR REPLACE FUNCTION public.phoenix_movement_ledger_report(
  p_organization_id uuid,
  p_from            timestamptz DEFAULT NULL,
  p_to              timestamptz DEFAULT NULL,
  p_ledger_source   text        DEFAULT NULL,  -- 'warehouse' | 'outlet' | 'quarantine' | NULL (all)
  p_movement_type   text        DEFAULT NULL,
  p_location_id     uuid        DEFAULT NULL,
  p_material_search text        DEFAULT NULL,
  p_actor_search    text        DEFAULT NULL,
  p_limit           integer     DEFAULT 50,
  p_offset          integer     DEFAULT 0
)
RETURNS TABLE (
  ledger_source          text,
  movement_id            uuid,
  occurred_at            timestamptz,
  movement_type          text,
  reason_code            text,
  quantity_before         integer,
  quantity_delta          integer,
  quantity_after          integer,
  scientific_name        text,
  concentration          text,
  dosage_form            text,
  batch_number           text,
  location_id            uuid,
  location_name          text,
  location_name_ar       text,
  actor_id               uuid,
  actor_role             text,
  actor_name             text,
  reference_type         text,
  reference_id           uuid,
  source_document_number text,
  correlation_id         uuid,
  causation_id           uuid,
  has_dispense_context   boolean,
  total_count            bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $report$
DECLARE
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_limit integer;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_from > p_to THEN
    RAISE EXCEPTION 'invalid_date_range' USING ERRCODE = '23514';
  END IF;
  IF p_ledger_source IS NOT NULL AND p_ledger_source NOT IN ('warehouse', 'outlet', 'quarantine') THEN
    RAISE EXCEPTION 'invalid_ledger_source' USING ERRCODE = '22023';
  END IF;

  -- Same hard org-isolation convention as 136's phoenix_get_movement_dispense_context:
  -- a non-super_admin caller can NEVER see another org's rows, no matter what
  -- p_organization_id claims.
  SELECT organization_id INTO v_org FROM public.profiles WHERE id = v_actor;
  IF public.phoenix_my_role() <> 'super_admin' AND v_org IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'forbidden_cross_org_access' USING ERRCODE = '42501';
  END IF;

  IF NOT public.phoenix_status_center_authorized(p_organization_id, 'status_center.view') THEN
    RAISE EXCEPTION 'forbidden_movement_report_access' USING ERRCODE = '42501';
  END IF;

  -- Bounded pagination: never trust the client's limit.
  v_limit := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);

  RETURN QUERY
  WITH unioned AS (
    SELECT
      'warehouse'::text                 AS ledger_source,
      m.id                               AS movement_id,
      m.occurred_at,
      m.movement_type,
      m.reason_code,
      m.on_hand_before                   AS quantity_before,
      m.on_hand_delta                    AS quantity_delta,
      m.on_hand_after                    AS quantity_after,
      m.scientific_name_snapshot         AS scientific_name,
      m.concentration_snapshot           AS concentration,
      m.dosage_form_snapshot             AS dosage_form,
      m.batch_number_snapshot            AS batch_number,
      m.warehouse_id                     AS location_id,
      w.name                             AS location_name,
      w.name_ar                          AS location_name_ar,
      m.actor_id, m.actor_role, m.actor_name,
      m.reference_type, m.reference_id, m.source_document_number,
      m.correlation_id, m.causation_id,
      false                              AS has_dispense_context
    FROM public.warehouse_stock_movements m
    JOIN public.warehouses w ON w.id = m.warehouse_id
    WHERE m.organization_id = p_organization_id
      AND (p_ledger_source IS NULL OR p_ledger_source = 'warehouse')

    UNION ALL

    SELECT
      'outlet'::text,
      m.id,
      m.occurred_at,
      m.movement_type,
      m.reason_code,
      m.on_hand_before,
      m.on_hand_delta,
      m.on_hand_after,
      m.scientific_name_snapshot,
      m.concentration_snapshot,
      m.dosage_form_snapshot,
      m.batch_number_snapshot,
      m.distribution_point_id,
      dp.name,
      dp.name_ar,
      m.actor_id, m.actor_role, m.actor_name,
      m.reference_type, m.reference_id, m.source_document_number,
      m.correlation_id, m.causation_id,
      EXISTS (
        SELECT 1 FROM public.phoenix_movement_dispense_context c
         WHERE c.movement_id = m.id
      )
    FROM public.outlet_stock_movements m
    JOIN public.distribution_points dp ON dp.id = m.distribution_point_id
    WHERE m.organization_id = p_organization_id
      AND (p_ledger_source IS NULL OR p_ledger_source = 'outlet')

    UNION ALL

    SELECT
      'quarantine'::text,
      m.id,
      m.occurred_at,
      m.movement_type,
      m.reason_code,
      m.quantity_before,
      m.quantity_delta,
      m.quantity_after,
      m.scientific_name_snapshot,
      m.concentration_snapshot,
      m.dosage_form_snapshot,
      m.batch_number_snapshot,
      m.warehouse_id,
      w.name,
      w.name_ar,
      m.actor_id, m.actor_role, m.actor_name,
      m.reference_type, m.reference_id, m.source_document_number,
      m.correlation_id, m.causation_id,
      false
    FROM public.warehouse_quarantine_stock_movements m
    JOIN public.warehouses w ON w.id = m.warehouse_id
    WHERE m.organization_id = p_organization_id
      AND (p_ledger_source IS NULL OR p_ledger_source = 'quarantine')
  ),
  filtered AS (
    SELECT *
    FROM unioned u
    WHERE (p_from IS NULL OR u.occurred_at >= p_from)
      AND (p_to IS NULL OR u.occurred_at <= p_to)
      AND (p_movement_type IS NULL OR u.movement_type = p_movement_type)
      AND (p_location_id IS NULL OR u.location_id = p_location_id)
      AND (p_material_search IS NULL OR u.scientific_name ILIKE '%' || p_material_search || '%')
      AND (p_actor_search IS NULL OR u.actor_name ILIKE '%' || p_actor_search || '%')
  ),
  counted AS (
    SELECT f.*, count(*) OVER () AS total_count
    FROM filtered f
  )
  SELECT
    c.ledger_source, c.movement_id, c.occurred_at, c.movement_type, c.reason_code,
    c.quantity_before, c.quantity_delta, c.quantity_after,
    c.scientific_name, c.concentration, c.dosage_form, c.batch_number,
    c.location_id, c.location_name, c.location_name_ar,
    c.actor_id, c.actor_role, c.actor_name,
    c.reference_type, c.reference_id, c.source_document_number,
    c.correlation_id, c.causation_id, c.has_dispense_context,
    COALESCE(c.total_count, 0)
  FROM counted c
  ORDER BY c.occurred_at DESC, c.movement_id DESC
  LIMIT v_limit OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END;
$report$;

REVOKE ALL ON FUNCTION public.phoenix_movement_ledger_report(
  uuid, timestamptz, timestamptz, text, text, uuid, text, text, integer, integer
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_movement_ledger_report(
  uuid, timestamptz, timestamptz, text, text, uuid, text, text, integer, integer
) TO authenticated;

DO $verify$
DECLARE
  v_count integer;
BEGIN
  IF to_regprocedure(
    'public.phoenix_movement_ledger_report(uuid, timestamptz, timestamptz, text, text, uuid, text, text, integer, integer)'
  ) IS NULL THEN
    RAISE EXCEPTION '138 VERIFY FAILED: phoenix_movement_ledger_report not found after creation';
  END IF;

  SELECT count(*) INTO v_count
    FROM information_schema.role_routine_grants
   WHERE routine_schema = 'public'
     AND routine_name = 'phoenix_movement_ledger_report'
     AND grantee = 'authenticated'
     AND privilege_type = 'EXECUTE';
  IF v_count = 0 THEN
    RAISE EXCEPTION '138 VERIFY FAILED: authenticated has no EXECUTE grant on phoenix_movement_ledger_report';
  END IF;

  SELECT count(*) INTO v_count
    FROM information_schema.role_routine_grants
   WHERE routine_schema = 'public'
     AND routine_name = 'phoenix_movement_ledger_report'
     AND grantee = 'anon';
  IF v_count <> 0 THEN
    RAISE EXCEPTION '138 VERIFY FAILED: anon must have zero grants on phoenix_movement_ledger_report, found %', v_count;
  END IF;

  RAISE NOTICE 'MOVEMENT-LEDGER-REPORT-138: verified.';
END;
$verify$;

COMMIT;
