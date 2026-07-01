-- =============================================================================
-- MediStock Phoenix V2 — Migration 036: Live Inter-Institution Alerts RPC
-- =============================================================================
-- MANUAL APPLY ONLY — DO NOT use `npx supabase db push`.
-- Apply via Supabase Dashboard → SQL Editor after a verified backup.
--
-- Prerequisites: 001 (item_availability, distribution_points, organizations,
-- profiles), 002 (phoenix_my_role/phoenix_my_org), 010/017
-- (phoenix_profile_has_permission), 019/020 (item_availability material
-- identity columns: scientific_name, trade_name, dosage_form, concentration).
--
-- Task: LIVE-INTER-INSTITUTION-ALERTS-RPC-A
--
-- Purpose:
--   LIVE-INTER-INSTITUTION-ALERTS-AUDIT-A found that today's inter-institution
--   alerts (exchange-alerts.ts, materialAlertEngine.ts, migration 009's
--   get_scoped_inter_institution_alerts) are computed entirely from the
--   MANUAL institution_item_status_reports table, matched on legacy item_id /
--   item_name — never on live item_availability, never on scientific_name +
--   concentration + dosage_form. This migration adds a NEW, read-only RPC
--   that computes alerts from live item_availability instead. It does NOT
--   modify, replace, or remove migration 009's RPC or any status_reports
--   code — that legacy path is left exactly as-is; a future UI phase decides
--   whether/when to retire it.
--
-- Why a new SECURITY DEFINER RPC is required (not a client-side computation):
--   avail_select_org RLS (migration 002) restricts a non-super authenticated
--   user's SELECT on item_availability to organization_id = phoenix_my_org().
--   A non-super user's browser therefore CANNOT read another organization's
--   item_availability rows at all — cross-org matching is structurally
--   impossible client-side for anyone but super_admin. This mirrors exactly
--   why migration 009 needed a SECURITY DEFINER RPC for the legacy path.
--
-- effective_status mirrors src/shared/lib/status/canonical.ts's
-- computeEffectiveStatus() precedence exactly (verified safe to reproduce in
-- SQL — the same date-only/quantity-only technique is already proven and
-- audited in migration 028's get_public_qr_payload):
--   1. expired     — expiry_date < current_date, OR condition = 'expired'
--   2. missing     — quantity <= 0, OR condition = 'missing'
--   3. near_expiry — expiry_date <= current_date + 3 months, OR
--                    condition = 'near_expiry'
--                    (3-month window only — matches canonical.ts's
--                    deriveExpiryStatus default; the 6/9-month sub-buckets
--                    are a UI-badge-only concept elsewhere, not part of
--                    effective_status itself)
--   4. low_stock   — condition = 'low_stock'
--   5. surplus     — condition = 'surplus'
--   6. available    — fallback
--   quantity is `integer not null default 0` (migration 001) — never null,
--   so no COALESCE is needed for the quantity <= 0 check.
--
-- Matching identity (owner decision — never trade_name):
--   lower(btrim(scientific_name))
--   lower(btrim(coalesce(concentration, '')))
--   lower(btrim(coalesce(dosage_form, '')))
--   Rows with a null/empty scientific_name are excluded from matching
--   entirely (an alert with no real material identity is meaningless).
--   trade_name is returned for DISPLAY ONLY on each side and never appears
--   in any join/match condition.
--
-- Demand set:  effective_status in ('missing', 'low_stock')
-- Supply set:  effective_status in ('surplus', 'near_expiry')
-- Excluded:    'available', 'expired' (never a supply/demand candidate —
--              expired stock is never treated as transferable), and the
--              same-organization pairing (no self-alerts).
--
-- Severity: depends only on the demand side's status —
--   missing   -> high    (surplus+missing = high, near_expiry+missing = high)
--   low_stock -> medium  (surplus+low_stock = medium, near_expiry+low_stock = medium)
--
-- Permission / scope (per owner decision for this phase):
--   - super_admin: bypass, sees every alert, any organizations.
--   - Otherwise: requires phoenix_profile_has_permission(auth.uid(),
--     'inter_institution_alerts.view') OR (backward-compat only)
--     'exchange_alerts.view' — NO new permission key is introduced in this
--     phase (alerts.inter_org.* is deferred to a later phase, per the
--     owner's explicit decision).
--   - Non-super callers only ever receive alerts where their OWN
--     organization is the source or the target — enforced inside this
--     SECURITY DEFINER function, mirroring migration 009's exact isolation
--     pattern (never handing another org's raw rows to the browser).
--
-- What this migration does NOT do:
--   - Does NOT modify migrations 001-035 in any way.
--   - Does NOT modify institution_item_status_reports, get_status_reports,
--     migration 009's get_scoped_inter_institution_alerts, or any
--     status-reports-based code path.
--   - Does NOT modify phoenix_upsert_availability or
--     phoenix_apply_availability_movement (quantity-movement RPCs untouched).
--   - Does NOT touch get_public_qr_payload, qr_tokens, qr_targets, or any
--     other QR-related object.
--   - Does NOT add any new permission_keys row or role_permission_defaults
--     row — uses only the two existing keys named above.
--   - Does NOT weaken any existing RLS policy — this RPC is a separate,
--     additive, read-only SECURITY DEFINER function; avail_select_org /
--     avail_select_anon on item_availability are untouched.
--   - Does NOT expose supply_type anywhere in the returned payload.
--   - Does NOT use service_role or any elevated/admin API key.
--   - Does NOT add Excel/XLSX import.
--   - Does NOT persist any alert lifecycle (open/acknowledged/resolved) —
--     this phase is read-only/computed-on-read only, per the prior audit
--     phase's design decision (LIVE-INTER-INSTITUTION-ALERTS-AUDIT-A).
--
-- Security: SECURITY DEFINER, SET search_path = public. auth.uid() required
-- (raises NOT_AUTHENTICATED otherwise, returned as jsonb — matches the
-- ok/error jsonb convention already used by phoenix_apply_availability_movement
-- and assign_profile_permissions). REVOKE ALL FROM PUBLIC, anon; GRANT
-- EXECUTE TO authenticated only.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.phoenix_get_live_inter_institution_alerts(
  p_limit integer DEFAULT 200
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_role       text;
  v_org        uuid;
  v_is_super   boolean;
  v_can_view   boolean;
  v_limit      integer;
  v_computed_at timestamptz := now();
  v_alerts     jsonb;
BEGIN
  -- 1. Auth required.
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED');
  END IF;

  SELECT role, organization_id INTO v_role, v_org
  FROM public.profiles WHERE id = v_actor;

  IF v_role IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ACTOR_PROFILE_NOT_FOUND');
  END IF;

  v_is_super := (v_role = 'super_admin');

  -- 2. Permission: super_admin bypass; otherwise require
  --    inter_institution_alerts.view (primary) or exchange_alerts.view
  --    (legacy, backward-compat only). No new permission key introduced.
  v_can_view := v_is_super
    OR phoenix_profile_has_permission(v_actor, 'inter_institution_alerts.view')
    OR phoenix_profile_has_permission(v_actor, 'exchange_alerts.view');

  IF NOT v_can_view THEN
    RETURN jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  END IF;

  -- 3. Sanitize p_limit: default 200, capped to a safe maximum of 500,
  --    floored at 1 (never 0/negative).
  v_limit := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);

  -- 4. Compute alerts.
  WITH candidates AS (
    SELECT
      ia.id                     AS availability_id,
      ia.organization_id,
      ia.distribution_point_id,
      ia.scientific_name,
      ia.trade_name,
      ia.concentration,
      ia.dosage_form,
      ia.quantity,
      ia.expiry_date,
      lower(btrim(ia.scientific_name))                    AS norm_sci,
      lower(btrim(coalesce(ia.concentration, '')))         AS norm_conc,
      lower(btrim(coalesce(ia.dosage_form, '')))           AS norm_dosage,
      -- effective_status: mirrors computeEffectiveStatus() precedence exactly.
      CASE
        WHEN ia.expiry_date IS NOT NULL AND ia.expiry_date < current_date THEN 'expired'
        WHEN ia.condition = 'expired' THEN 'expired'
        WHEN ia.quantity <= 0 THEN 'missing'
        WHEN ia.condition = 'missing' THEN 'missing'
        WHEN ia.expiry_date IS NOT NULL
          AND ia.expiry_date <= (current_date + interval '3 months')::date THEN 'near_expiry'
        WHEN ia.condition = 'near_expiry' THEN 'near_expiry'
        WHEN ia.condition = 'low_stock' THEN 'low_stock'
        WHEN ia.condition = 'surplus' THEN 'surplus'
        ELSE 'available'
      END AS effective_status
    FROM public.item_availability ia
    WHERE ia.scientific_name IS NOT NULL
      AND btrim(ia.scientific_name) <> ''
  ),
  supply AS (
    SELECT * FROM candidates WHERE effective_status IN ('surplus', 'near_expiry')
  ),
  demand AS (
    SELECT * FROM candidates WHERE effective_status IN ('missing', 'low_stock')
  ),
  matched AS (
    SELECT
      s.availability_id       AS src_availability_id,
      d.availability_id       AS tgt_availability_id,
      s.organization_id       AS src_org,
      d.organization_id       AS tgt_org,
      s.distribution_point_id AS src_point,
      d.distribution_point_id AS tgt_point,
      s.scientific_name,
      s.concentration,
      s.dosage_form,
      s.trade_name            AS src_trade_name,
      d.trade_name             AS tgt_trade_name,
      s.effective_status      AS src_status,
      d.effective_status      AS tgt_status,
      s.quantity              AS src_qty,
      d.quantity               AS tgt_qty,
      s.expiry_date            AS src_expiry,
      CASE WHEN s.effective_status = 'near_expiry'
        THEN 'near_expiry_to_shortage' ELSE 'surplus_to_shortage' END AS alert_type,
      CASE WHEN d.effective_status = 'missing'
        THEN 'high' ELSE 'medium' END AS severity
    FROM supply s
    JOIN demand d
      ON s.organization_id <> d.organization_id
     AND s.norm_sci    = d.norm_sci
     AND s.norm_conc   = d.norm_conc
     AND s.norm_dosage = d.norm_dosage
  )
  , scoped AS (
    SELECT m.*, so.name AS src_org_name, so.name_ar AS src_org_name_ar,
           to_.name AS tgt_org_name, to_.name_ar AS tgt_org_name_ar,
           sdp.name AS src_point_name, sdp.name_ar AS src_point_name_ar,
           tdp.name AS tgt_point_name, tdp.name_ar AS tgt_point_name_ar
    FROM matched m
    JOIN public.organizations so   ON so.id  = m.src_org
    JOIN public.organizations to_  ON to_.id = m.tgt_org
    LEFT JOIN public.distribution_points sdp ON sdp.id = m.src_point
    LEFT JOIN public.distribution_points tdp ON tdp.id = m.tgt_point
    WHERE v_is_super OR m.src_org = v_org OR m.tgt_org = v_org
    ORDER BY
      CASE m.severity WHEN 'high' THEN 2 ELSE 1 END DESC,
      CASE WHEN m.alert_type = 'near_expiry_to_shortage' THEN m.src_expiry END ASC NULLS LAST,
      m.scientific_name ASC
    LIMIT v_limit
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'alert_type',                      s.alert_type,
      'severity',                        s.severity,
      'source_organization_id',         s.src_org,
      'source_organization_name',       s.src_org_name,
      'source_organization_name_ar',    s.src_org_name_ar,
      'source_distribution_point_id',   s.src_point,
      'source_distribution_point_name', s.src_point_name,
      'source_distribution_point_name_ar', s.src_point_name_ar,
      'target_organization_id',         s.tgt_org,
      'target_organization_name',       s.tgt_org_name,
      'target_organization_name_ar',    s.tgt_org_name_ar,
      'target_distribution_point_id',   s.tgt_point,
      'target_distribution_point_name', s.tgt_point_name,
      'target_distribution_point_name_ar', s.tgt_point_name_ar,
      'scientific_name',                 s.scientific_name,
      'concentration',                   s.concentration,
      'dosage_form',                     s.dosage_form,
      'source_trade_name',               s.src_trade_name,
      'target_trade_name',               s.tgt_trade_name,
      'source_status',                   s.src_status,
      'target_status',                   s.tgt_status,
      'source_quantity',                 s.src_qty,
      'target_quantity',                 s.tgt_qty,
      'source_expiry_date',              s.src_expiry,
      'computed_at',                      v_computed_at
    )
    ORDER BY
      CASE s.severity WHEN 'high' THEN 2 ELSE 1 END DESC,
      CASE WHEN s.alert_type = 'near_expiry_to_shortage' THEN s.src_expiry END ASC NULLS LAST,
      s.scientific_name ASC
  )
  INTO v_alerts
  FROM scoped s;

  RETURN jsonb_build_object(
    'ok', true,
    'alerts', coalesce(v_alerts, '[]'::jsonb),
    'computed_at', v_computed_at
  );
END;
$$;

-- restrict execution to authenticated users only (permission gate happens inside)
REVOKE ALL ON FUNCTION public.phoenix_get_live_inter_institution_alerts(integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_get_live_inter_institution_alerts(integer)
  TO authenticated;

-- =============================================================================
-- VERIFY
-- =============================================================================

DO $$
DECLARE
  v_fn_src text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_fn_src
  FROM pg_proc WHERE proname = 'phoenix_get_live_inter_institution_alerts';

  ASSERT v_fn_src IS NOT NULL,
    'VERIFY FAILED: phoenix_get_live_inter_institution_alerts function not found';

  -- A. Security properties
  ASSERT v_fn_src LIKE '%SECURITY DEFINER%',
    'VERIFY FAILED: phoenix_get_live_inter_institution_alerts is not SECURITY DEFINER';
  ASSERT v_fn_src LIKE '%SET search_path%',
    'VERIFY FAILED: phoenix_get_live_inter_institution_alerts missing SET search_path';
  ASSERT v_fn_src LIKE '%NOT_AUTHENTICATED%',
    'VERIFY FAILED: auth.uid() NULL guard not found';

  -- B. Source table: item_availability only, never the manual reports table
  ASSERT v_fn_src LIKE '%public.item_availability%',
    'VERIFY FAILED: does not query item_availability';
  ASSERT v_fn_src NOT LIKE '%institution_item_status_reports%',
    'VERIFY FAILED: must not reference institution_item_status_reports';

  -- C. Matching identity: scientific_name/concentration/dosage_form, never trade_name
  ASSERT v_fn_src LIKE '%norm_sci%' AND v_fn_src LIKE '%norm_conc%' AND v_fn_src LIKE '%norm_dosage%',
    'VERIFY FAILED: normalized identity columns not found';
  ASSERT v_fn_src NOT LIKE '%s.trade_name = d.trade_name%'
     AND v_fn_src NOT LIKE '%trade_name = %.trade_name%',
    'VERIFY FAILED: trade_name must never be used as a join/match condition';

  -- D. Status inclusion/exclusion
  ASSERT v_fn_src LIKE '%''surplus'', ''near_expiry''%',
    'VERIFY FAILED: supply set (surplus, near_expiry) not found';
  ASSERT v_fn_src LIKE '%''missing'', ''low_stock''%',
    'VERIFY FAILED: demand set (missing, low_stock) not found';

  -- E. Payload never includes supply_type
  ASSERT v_fn_src NOT LIKE '%supply_type%',
    'VERIFY FAILED: supply_type must never appear in this RPC';

  -- F. Same-org exclusion
  ASSERT v_fn_src LIKE '%organization_id <> d.organization_id%',
    'VERIFY FAILED: same-organization exclusion not found';

  -- G. Grants: authenticated only, anon/PUBLIC excluded
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public'
      AND routine_name = 'phoenix_get_live_inter_institution_alerts'
      AND grantee = 'authenticated'
      AND privilege_type = 'EXECUTE'
  ), 'VERIFY FAILED: authenticated does not have EXECUTE on phoenix_get_live_inter_institution_alerts';

  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public'
      AND routine_name = 'phoenix_get_live_inter_institution_alerts'
      AND grantee IN ('anon', 'PUBLIC')
  ), 'VERIFY FAILED: anon or PUBLIC has EXECUTE on phoenix_get_live_inter_institution_alerts';

  -- H. No service_role reference
  ASSERT v_fn_src NOT LIKE '%service_role%',
    'VERIFY FAILED: service_role reference found';

  -- I. Untouched: migration 009's legacy RPC, quantity-movement RPCs, QR RPC still exist unmodified
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'get_scoped_inter_institution_alerts'),
    'VERIFY FAILED: legacy get_scoped_inter_institution_alerts is missing (must not be touched)';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_apply_availability_movement'),
    'VERIFY FAILED: phoenix_apply_availability_movement is missing (must not be touched)';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_upsert_availability'),
    'VERIFY FAILED: phoenix_upsert_availability is missing (must not be touched)';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'get_public_qr_payload'),
    'VERIFY FAILED: get_public_qr_payload is missing (must not be touched)';

  RAISE NOTICE '036 OK: phoenix_get_live_inter_institution_alerts created — reads item_availability only, matches on scientific_name+concentration+dosage_form (never trade_name), excludes available/expired, scopes non-super callers to their own org as source or target, no supply_type in payload, no service_role, legacy RPCs/tables untouched.';
END $$;

-- =============================================================================
-- END OF MIGRATION 036
--
-- Post-apply manual verification (run in Supabase SQL Editor):
--
-- 1. Confirm grants:
--    SELECT grantee, privilege_type FROM information_schema.routine_privileges
--    WHERE routine_schema = 'public' AND routine_name = 'phoenix_get_live_inter_institution_alerts';
--    -- expect: authenticated | EXECUTE  (no anon, no PUBLIC row)
--
-- 2. Functional smoke test (as an authenticated user holding
--    inter_institution_alerts.view or exchange_alerts.view):
--    SELECT phoenix_get_live_inter_institution_alerts(50);
--    -- expect: {"ok": true, "alerts": [...], "computed_at": "..."}
--
-- 3. Confirm a surplus row in Org A and a missing row in Org B, same
--    scientific_name/concentration/dosage_form, produces exactly one
--    alert_type = "surplus_to_shortage", severity = "high".
--
-- 4. Confirm an expired row is NEVER used as a supply-side candidate, even
--    with condition = 'surplus' and a large quantity.
--
-- 5. Confirm two rows with the same trade_name but different
--    scientific_name/concentration/dosage_form do NOT produce an alert.
--
-- 6. Confirm two rows with the same scientific_name/concentration/dosage_form
--    but different trade_name DO produce an alert (trade_name never blocks).
--
-- 7. As a non-super user without inter_institution_alerts.view or
--    exchange_alerts.view: expect {"ok": false, "error": "FORBIDDEN"}.
--
-- 8. As a non-super user WITH the permission: every alert returned must have
--    source_organization_id = their org OR target_organization_id = their org.
--
-- 9. Confirm no permission_keys or role_permission_defaults rows were added:
--    SELECT count(*) FROM permission_keys;  -- compare to pre-migration snapshot
-- =============================================================================
