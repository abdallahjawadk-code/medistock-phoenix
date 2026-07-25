-- ============================================================================
-- SUPPLY-SOURCES-DETAIL-120   ***PREPARED - DO NOT APPLY TO PRODUCTION***
--
-- MANUAL APPLY ONLY (SQL Editor), after owner review, after 119. Never via
-- `supabase db push`.
--
-- WHY
-- 119's phoenix_executive_overview intentionally returns ONLY per-bucket
-- TOTALS (kimadia/aid/purchase-central/purchase-supplementary) — enough for
-- the executive card row, but the Decision Intelligence Reports contract
-- requires "detailed source identity must never be lost" for the Supply
-- Sources report section. This migration adds the per-material drill-down
-- a report reader needs to go from a bucket total to the actual lots behind
-- it, still without introducing any new classification math: every row here
-- is a straight, organization-scoped read of warehouse_stock/outlet_stock's
-- own already-computed supply_type/purchase_origin columns (088).
--
-- THE CONTRACT
--   * phoenix_supply_sources_detail(org, supply_bucket) returns one row per
--     physical lot (warehouse_stock or outlet_stock row) matching that
--     bucket — never pre-aggregated, so a reader can still group/sort/filter
--     client-side without losing identity.
--   * supply_bucket is the SAME closed vocabulary phoenix_executive_overview
--     already emits as jsonb keys ('kimadia','aid','purchase_central',
--     'purchase_supplementary','unclassified') — one shared vocabulary,
--     never two.
--   * Every row's SUM, grouped by bucket, reconciles exactly against
--     phoenix_executive_overview's totals for the same organization at the
--     same moment — proven by a dynamic test, not merely asserted.
--   * reports.view, organization-scoped — the same authority as 119, no new
--     permission key.
--
-- PRECONDITIONS: 119 applied. FORWARD-ONLY.
-- ============================================================================

BEGIN;

DO $precond$
BEGIN
  IF to_regprocedure('public.phoenix_executive_overview(uuid)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 119 phoenix_executive_overview is missing';
  END IF;
  IF to_regprocedure('public.phoenix_supply_sources_detail(uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'precondition failed: 120 already applied';
  END IF;
END;
$precond$;

CREATE OR REPLACE FUNCTION public.phoenix_supply_sources_detail(
  p_organization_id uuid,
  p_supply_bucket    text DEFAULT NULL
)
RETURNS TABLE (
  source_table       text,
  lot_id             uuid,
  location_kind      text,
  location_id        uuid,
  location_name      text,
  location_name_ar   text,
  scientific_name    text,
  trade_name         text,
  batch_number       text,
  expiry_date        date,
  on_hand_quantity   integer,
  supply_bucket      text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_supply_bucket IS NOT NULL AND p_supply_bucket NOT IN (
    'kimadia', 'aid', 'purchase_central', 'purchase_supplementary', 'unclassified'
  ) THEN
    RAISE EXCEPTION 'invalid_supply_bucket' USING ERRCODE = '23514';
  END IF;
  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'reports.view', p_organization_id, NULL, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_reports_view' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    'warehouse_stock'::text,
    ws.id,
    'warehouse'::text,
    ws.warehouse_id,
    w.name,
    w.name_ar,
    ws.scientific_name,
    ws.trade_name,
    ws.batch_number,
    ws.expiry_date,
    ws.on_hand_quantity,
    CASE
      WHEN ws.supply_type = 'purchase' THEN 'purchase_' || ws.purchase_origin
      WHEN ws.supply_type IS NULL THEN 'unclassified'
      ELSE ws.supply_type
    END
  FROM public.warehouse_stock ws
  JOIN public.warehouses w ON w.id = ws.warehouse_id
  WHERE ws.organization_id = p_organization_id
    AND ws.on_hand_quantity > 0
    AND (
      p_supply_bucket IS NULL
      OR (
        CASE
          WHEN ws.supply_type = 'purchase' THEN 'purchase_' || ws.purchase_origin
          WHEN ws.supply_type IS NULL THEN 'unclassified'
          ELSE ws.supply_type
        END
      ) = p_supply_bucket
    )

  UNION ALL

  SELECT
    'outlet_stock'::text,
    os.id,
    'outlet'::text,
    os.distribution_point_id,
    dp.name,
    dp.name_ar,
    os.scientific_name,
    os.trade_name,
    os.batch_number,
    os.expiry_date,
    os.on_hand_quantity,
    CASE
      WHEN os.supply_type = 'purchase' THEN 'purchase_' || os.purchase_origin
      WHEN os.supply_type IS NULL THEN 'unclassified'
      ELSE os.supply_type
    END
  FROM public.outlet_stock os
  JOIN public.distribution_points dp ON dp.id = os.distribution_point_id
  WHERE os.organization_id = p_organization_id
    AND os.on_hand_quantity > 0
    AND (
      p_supply_bucket IS NULL
      OR (
        CASE
          WHEN os.supply_type = 'purchase' THEN 'purchase_' || os.purchase_origin
          WHEN os.supply_type IS NULL THEN 'unclassified'
          ELSE os.supply_type
        END
      ) = p_supply_bucket
    )

  -- Positional, not by name: UNION ALL branches carry no output column
  -- aliases of their own (the RETURNS TABLE names are the function's
  -- signature, not the query's), so ordering by name here would either be
  -- ambiguous or silently resolve to the wrong branch's expression.
  ORDER BY 7, 5;
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_supply_sources_detail(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_supply_sources_detail(uuid, text) TO authenticated;

COMMIT;

-- ============================================================================
-- POST-CONDITIONS (read-only, after apply):
--   phoenix_supply_sources_detail(org, NULL) grouped-and-summed by
--   supply_bucket, split by location_kind, equals
--   phoenix_executive_overview(org).supply_source_totals.{warehouse,outlet}
--   exactly, for the same organization at the same moment.
--   A caller lacking reports.view on that org raises forbidden_reports_view;
--   a foreign org's rows are never returned.
-- RECONCILIATION: one new read-only function. No table/RLS/existing-function
-- change.
-- ROLLBACK: DROP FUNCTION public.phoenix_supply_sources_detail(uuid, text);
-- ============================================================================
