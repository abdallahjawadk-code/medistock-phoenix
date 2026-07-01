-- =============================================================================
-- MediStock Phoenix V2 — Migration 037: Live Alert Stable Identifiers
-- =============================================================================
-- MANUAL APPLY ONLY — DO NOT use `npx supabase db push`.
-- Apply via Supabase Dashboard → SQL Editor after a verified backup.
--
-- Prerequisites: 036 (phoenix_get_live_inter_institution_alerts).
--
-- Task: LIVE-ALERTS-RPC-IDENTIFIERS-A
--
-- Purpose:
--   ALERT-LIFECYCLE-AUDIT-A concluded that a future persisted alert lifecycle
--   needs a durable key built from source_item_availability_id +
--   target_item_availability_id + alert_type. Migration 036 already computes
--   these two ids internally (src_availability_id / tgt_availability_id, both
--   aliased from item_availability.id in the "matched" CTE) but never
--   includes them in the returned jsonb payload. This migration is a purely
--   ADDITIVE redefinition of phoenix_get_live_inter_institution_alerts that
--   adds exactly two new payload keys:
--     source_item_availability_id
--     target_item_availability_id
--   No other behavior changes. This migration does NOT create any lifecycle
--   table, event log, or permission key — that remains a future, separately
--   reported phase per the audit's own phased plan.
--
-- Everything below is identical to migration 036 except:
--   1. The final jsonb_build_object(...) gains two new keys.
--   2. This header comment.
-- All auth/permission/scope/matching/status/sorting logic is byte-for-byte
-- the same as migration 036 — re-read that migration's header for the full
-- rationale (effective_status precedence, matching identity, demand/supply
-- sets, severity, scope isolation). This migration does not restate design
-- decisions that have not changed; it only documents the addition.
--
-- What this migration does NOT do:
--   - Does NOT modify migrations 001-036 in any way (036 is superseded via a
--     new CREATE OR REPLACE in this NEW file only, per standard Postgres
--     function versioning — the object itself is replaced, the old file is
--     left on disk untouched as history).
--   - Does NOT create inter_org_alert_states or inter_org_alert_events.
--   - Does NOT add any new permission_keys or role_permission_defaults row.
--   - Does NOT modify phoenix_apply_availability_movement or
--     phoenix_upsert_availability (quantity-movement RPCs untouched).
--   - Does NOT touch get_public_qr_payload, qr_tokens, qr_targets, or any
--     other QR-related object.
--   - Does NOT expose supply_type anywhere in the returned payload.
--   - Does NOT use service_role or any elevated/admin API key.
--   - Does NOT add Excel/XLSX import.
--
-- Security: unchanged from 036 — SECURITY DEFINER, SET search_path = public,
-- auth.uid() required, REVOKE ALL FROM PUBLIC, anon; GRANT EXECUTE TO
-- authenticated only.
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
      'source_item_availability_id',    s.src_availability_id,
      'target_item_availability_id',    s.tgt_availability_id,
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

  -- A. Security properties unchanged
  ASSERT v_fn_src LIKE '%SECURITY DEFINER%',
    'VERIFY FAILED: phoenix_get_live_inter_institution_alerts is not SECURITY DEFINER';
  ASSERT v_fn_src LIKE '%SET search_path%',
    'VERIFY FAILED: phoenix_get_live_inter_institution_alerts missing SET search_path';
  ASSERT v_fn_src LIKE '%NOT_AUTHENTICATED%',
    'VERIFY FAILED: auth.uid() NULL guard not found';

  -- B. New payload keys present
  ASSERT v_fn_src LIKE '%source_item_availability_id%',
    'VERIFY FAILED: source_item_availability_id missing from payload';
  ASSERT v_fn_src LIKE '%target_item_availability_id%',
    'VERIFY FAILED: target_item_availability_id missing from payload';

  -- C. supply_type still never appears
  ASSERT v_fn_src NOT LIKE '%supply_type%',
    'VERIFY FAILED: supply_type must never appear in this RPC';

  -- D. No dependency on the legacy manual status-report table
  ASSERT v_fn_src NOT LIKE '%institution_item_status_reports%',
    'VERIFY FAILED: must not reference institution_item_status_reports';

  -- E. Grants: authenticated only, anon/PUBLIC excluded
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

  -- F. search_path pinned
  ASSERT v_fn_src LIKE '%SET search_path=public%' OR v_fn_src LIKE '%SET search_path TO %public%',
    'VERIFY FAILED: search_path not pinned to public';

  -- G. No elevated/admin API key reference
  ASSERT v_fn_src NOT LIKE '%service_role%',
    'VERIFY FAILED: service_role reference found';

  -- H. Other RPCs untouched/still present (this migration must not remove them)
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'get_scoped_inter_institution_alerts'),
    'VERIFY FAILED: legacy get_scoped_inter_institution_alerts is missing (must not be touched)';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_apply_availability_movement'),
    'VERIFY FAILED: phoenix_apply_availability_movement is missing (must not be touched)';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_upsert_availability'),
    'VERIFY FAILED: phoenix_upsert_availability is missing (must not be touched)';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'get_public_qr_payload'),
    'VERIFY FAILED: get_public_qr_payload is missing (must not be touched)';

  RAISE NOTICE '037 OK: phoenix_get_live_inter_institution_alerts now returns source_item_availability_id and target_item_availability_id in addition to all prior fields — no other behavior changed, no lifecycle table created, no permission key added.';
END $$;

-- =============================================================================
-- END OF MIGRATION 037
--
-- Post-apply manual verification (run in Supabase SQL Editor):
--
-- 1. SELECT phoenix_get_live_inter_institution_alerts(50);
--    -- expect each alert object to now include
--    -- "source_item_availability_id" and "target_item_availability_id"
--    -- alongside every field already present in migration 036's payload.
--
-- 2. Confirm those two ids match the underlying item_availability.id values
--    for the matched supply/demand rows (spot-check a couple of alerts
--    against `select id, organization_id, scientific_name from
--    item_availability where id in (...)`).
--
-- 3. Re-run migration 036's own post-apply checks (grants, FORBIDDEN,
--    scope-by-org, expired exclusion, trade_name never blocks/matches) —
--    none of that behavior has changed in this migration.
-- =============================================================================
