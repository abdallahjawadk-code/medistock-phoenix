-- ============================================================================
-- SUBPURCHASE-DUPLICATE-CANDIDATES-117   ***PREPARED - DO NOT APPLY TO PRODUCTION***
--
-- MANUAL APPLY ONLY (SQL Editor), after owner review, AFTER 116. Never via
-- `supabase db push`. Tested by replaying 001->117 on the disposable rig.
--
-- WHY
-- Supplementary purchases is the one surface allowed to invent a brand-new
-- material identity (089/116). To keep that freedom from silently
-- multiplying near-duplicate identities, the entry screen shows a
-- non-blocking "did you mean...?" suggestion while the operator types —
-- ADVISORY ONLY: it never prevents creating a genuinely new material, it only
-- helps avoid an accidental duplicate. This RPC is the read-only lookup
-- behind that suggestion: fuzzy (pg_trgm) match against BOTH the unified
-- drug catalog (central_items, world-readable) and this organization's
-- already-recorded warehouse_stock identities (which — since 088 — includes
-- every previously-typed supplementary-purchase material), scoped to the
-- purchasing warehouse's organization.
--
-- SECURITY DEFINER so the authorization bar matches 089/116 exactly
-- (local_procurement.manage on the resolved warehouse) rather than depending
-- on whether the caller separately holds warehouse_stock.view — this is a
-- read used BY the direct-entry screen, not a general stock browser.
--
-- PRECONDITIONS: 088 + 116 applied. FORWARD-ONLY.
-- ============================================================================

BEGIN;

DO $precond$
BEGIN
  IF to_regclass('public.central_items') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 001 central_items is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'warehouse_stock'
       AND column_name = 'purchase_origin'
  ) THEN
    RAISE EXCEPTION 'precondition failed: 088 warehouse_stock.purchase_origin is missing';
  END IF;
END;
$precond$;

CREATE OR REPLACE FUNCTION public.phoenix_subpurchase_duplicate_candidates(
  p_warehouse_id     uuid,
  p_scientific_name  text,
  p_trade_name       text DEFAULT NULL,
  p_national_code    text DEFAULT NULL,
  p_limit            integer DEFAULT 5
)
RETURNS TABLE (
  source            text,
  source_id         uuid,
  scientific_name   text,
  trade_name        text,
  concentration     text,
  dosage_form       text,
  national_code     text,
  similarity_score  real
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor  uuid := auth.uid();
  v_org    uuid;
  v_term   text := NULLIF(btrim(COALESCE(p_scientific_name, '')), '');
  v_trade  text := NULLIF(btrim(COALESCE(p_trade_name, '')), '');
  v_code   text := NULLIF(btrim(COALESCE(p_national_code, '')), '');
  v_limit  integer := LEAST(GREATEST(COALESCE(p_limit, 5), 1), 20);
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'warehouse_id_required' USING ERRCODE = '23514';
  END IF;
  IF v_term IS NULL OR length(v_term) < 2 THEN
    RAISE EXCEPTION 'scientific_name_too_short' USING ERRCODE = '23514';
  END IF;

  SELECT w.organization_id INTO v_org
  FROM public.warehouses w
  WHERE w.id = p_warehouse_id AND w.status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse_not_found_or_inactive' USING ERRCODE = 'P0002';
  END IF;

  -- Advisory-only lookup, but still gated: same authority bar as the entry
  -- act itself (local_procurement.manage on this warehouse).
  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'local_procurement.manage', v_org, p_warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_local_procurement_manage' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  (
    SELECT
      'catalog'::text,
      ci.id,
      ci.name,
      ci.trade_name,
      ci.concentration,
      ci.dosage_form,
      ci.barcode,
      GREATEST(
        similarity(ci.name, v_term),
        similarity(ci.name_ar, v_term),
        CASE WHEN v_trade IS NOT NULL AND ci.trade_name IS NOT NULL
             THEN similarity(ci.trade_name, v_trade) ELSE 0 END,
        CASE WHEN v_code IS NOT NULL AND ci.barcode IS NOT NULL AND ci.barcode = v_code
             THEN 1.0 ELSE 0 END
      )::real AS score
    FROM public.central_items ci
    WHERE ci.status = 'active'
      AND (
        ci.name % v_term OR ci.name_ar % v_term
        OR (v_trade IS NOT NULL AND ci.trade_name IS NOT NULL AND ci.trade_name % v_trade)
        OR (v_code IS NOT NULL AND ci.barcode = v_code)
      )
    ORDER BY score DESC
    LIMIT v_limit
  )
  UNION ALL
  (
    SELECT
      'existing_lot'::text,
      ws.id,
      ws.scientific_name,
      ws.trade_name,
      ws.concentration,
      ws.dosage_form,
      ws.national_code,
      GREATEST(
        similarity(ws.scientific_name, v_term),
        CASE WHEN v_trade IS NOT NULL AND ws.trade_name IS NOT NULL
             THEN similarity(ws.trade_name, v_trade) ELSE 0 END,
        CASE WHEN v_code IS NOT NULL AND ws.national_code IS NOT NULL AND ws.national_code = v_code
             THEN 1.0 ELSE 0 END
      )::real AS score
    FROM public.warehouse_stock ws
    WHERE ws.organization_id = v_org
      AND ws.purchase_origin = 'supplementary'
      AND (
        ws.scientific_name % v_term
        OR (v_trade IS NOT NULL AND ws.trade_name IS NOT NULL AND ws.trade_name % v_trade)
        OR (v_code IS NOT NULL AND ws.national_code = v_code)
      )
    ORDER BY score DESC
    LIMIT v_limit
  )
  ORDER BY score DESC
  LIMIT v_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_subpurchase_duplicate_candidates(
  uuid, text, text, text, integer
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_subpurchase_duplicate_candidates(
  uuid, text, text, text, integer
) TO authenticated;

COMMENT ON FUNCTION public.phoenix_subpurchase_duplicate_candidates(
  uuid, text, text, text, integer
) IS
  'Advisory-only (never blocking) fuzzy duplicate lookup for the supplementary '
  'purchase entry screen: pg_trgm match against the unified drug catalog and '
  'this org''s already-recorded supplementary-purchase lots. Gated by '
  'local_procurement.manage on the resolved warehouse.';

COMMIT;

-- ============================================================================
-- POST-CONDITIONS (read-only, after apply):
--   SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--    WHERE n.nspname='public' AND p.proname='phoenix_subpurchase_duplicate_candidates'; -- 1
-- RECONCILIATION: new read-only function, no data written, no table/RLS
-- change.
-- ROLLBACK: DROP FUNCTION public.phoenix_subpurchase_duplicate_candidates(
--   uuid, text, text, text, integer);
-- ============================================================================
