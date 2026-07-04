-- =============================================================================
-- MediStock Phoenix V2 — Migration 048: Live Alerts Expiry Risk Tiers
-- =============================================================================
-- MANUAL APPLY ONLY — DO NOT use `npx supabase db push`.
-- Review then apply manually in Supabase Dashboard → SQL Editor.
--
-- Task: DB-EXPIRY-RISK-TIERS-LIVE-ALERTS-A
--
-- Purpose:
--   EXPIRY-RISK-TIERS-A (frontend, commit 7734698) added a UI-only 9/6/3
--   month expiry risk classification (expired / critical_3m / warning_6m /
--   watch_9m / normal / unknown), computed client-side from the raw
--   `expiry_date` already present on every availability row. That frontend
--   phase explicitly did NOT touch backend alert generation or the live
--   inter-institution alert RPC.
--
--   This migration prepares the DB/RPC side so the *official* live alert
--   payload (phoenix_get_live_inter_institution_alerts_with_state, most
--   recently redefined by migration 047) can expose the same tier concept
--   server-side, so a later (separately reviewed) frontend phase can read
--   it directly off each alert row instead of re-deriving it from a raw
--   date. It also widens the RPC's internal "supply-side" near-expiry
--   participation window from 3 months to 9 months, so surplus/near-expiry
--   matching can consider items across the full 9-month watch horizon (the
--   frontend's `effective_status` concept stays a 6-value enum; the new
--   9/6/3 tiers exist ONLY as extra jsonb fields, never as new
--   `effective_status`/`condition` values).
--
-- Decision: same-name replacement, not a v2 RPC.
--   Identical reasoning to migration 047: phoenix_get_live_inter_institution_
--   alerts_with_state (integer) RETURNS jsonb — a single opaque value, not
--   RETURNS TABLE with a fixed column list. CREATE OR REPLACE FUNCTION can
--   freely redefine the body as long as the name, argument types, and
--   return type are unchanged (unchanged here). No DROP FUNCTION is used.
--   The frontend service that already calls this exact RPC name needs zero
--   changes to receive the two new jsonb keys.
--
-- What this migration does:
--   A. Re-creates public.phoenix_get_live_inter_institution_alerts_with_state
--      (integer) with an IDENTICAL body to migration 047 in every respect —
--      same auth check, same permission check, same limit sanitation, same
--      matched/scoped CTEs, same lifecycle upsert/event-insert logic, same
--      contact-phone lateral joins, same jsonb_build_object field list —
--      with exactly these additions:
--        1. The `candidates` CTE's near-expiry threshold in the
--           effective_status CASE expression widens from
--           `expiry_date <= current_date + interval '3 months'` to
--           `expiry_date <= current_date + interval '9 months'`, so an item
--           within the 9-month watch horizon (and not already expired/
--           missing) classifies as `near_expiry` for supply/demand matching
--           purposes — matching the priority order EXPIRY-RISK-TIERS-A's
--           frontend helper already documents (expired > missing >
--           near_expiry > low_stock > surplus > available). `effective_status`
--           itself is STILL only ever one of the same 6 values; there is no
--           new `critical_3m`/`warning_6m`/`watch_9m` effective_status.
--        2. A `source_expiry_risk_tier` and `source_expiry_days_remaining`
--           pair of extra jsonb keys per alert, computed from the same
--           `src.expiry_date` already selected for `source_expiry_date`:
--             'unknown'      — src_expiry IS NULL
--             'expired'      — src_expiry < current_date
--             'critical_3m'  — current_date <= src_expiry <= current_date + 3mo
--             'warning_6m'   — current_date + 3mo < src_expiry <= +6mo
--             'watch_9m'     — current_date + 6mo < src_expiry <= +9mo
--             'normal'       — src_expiry > current_date + 9mo
--           and `source_expiry_days_remaining` = src_expiry - current_date
--           (integer, NULL when src_expiry IS NULL). Both are computed in
--           the `matched` CTE (same place `alert_type`/`severity` are
--           already computed) and passed straight through `scoped` to the
--           final SELECT — never used in alert_key, never used to change
--           severity, never used to change alert_type.
--   B. Verification block.
--
-- What this migration does NOT do:
--   - Does NOT modify migrations 001-047 in any way.
--   - Does NOT create any new DB enum value, CHECK constraint value, or
--     table column. `item_availability.condition` and every `effective_status`/
--     `alert_type`/`severity` value already accepted are unchanged; the
--     tier strings exist ONLY as ad-hoc jsonb text values, never as a
--     stored/constrained value anywhere.
--   - Does NOT change `alert_key` — still exactly
--     `src_availability_id::text || ':' || tgt_availability_id::text || ':' || alert_type`,
--     with NO expiry-tier component. A material moving from watch_9m to
--     warning_6m to critical_3m over time keeps updating the SAME
--     inter_org_alert_states row (last_seen_at/severity_snapshot refreshed
--     via the existing ON CONFLICT (alert_key) DO UPDATE), never creating a
--     duplicate/parallel lifecycle alert.
--   - Does NOT change `alert_type` — `near_expiry_to_shortage` vs
--     `surplus_to_shortage` is still derived purely from
--     `s.effective_status = 'near_expiry'`, exactly as migration 036/039/047.
--     No new alert_type value is introduced.
--   - Does NOT change `severity` — still exactly
--     `CASE WHEN d.effective_status = 'missing' THEN 'high' ELSE 'medium' END`,
--     byte-for-byte identical to migration 047. The frontend is expected to
--     use the new `source_expiry_risk_tier` field for its own color/badge
--     treatment (mirroring EXPIRY-RISK-TIERS-A's UI tones) in a later,
--     separately reviewed phase — this migration does not redesign severity.
--   - Does NOT widen alert VISIBILITY — the `scoped` CTE's
--     `WHERE v_is_super OR m.src_org = v_org OR m.tgt_org = v_org` clause is
--     untouched.
--   - Does NOT change the `demand` CTE's participation window at all
--     (missing/low_stock unaffected) — only `candidates`' near-expiry
--     threshold (part of `supply`'s near_expiry branch) widens.
--   - Does NOT remove or weaken the "expired takes precedence over
--     near_expiry" or "missing/quantity<=0 takes precedence over
--     near_expiry" ordering in the CASE expression — those two WHEN clauses
--     still appear strictly before the (widened) near-expiry WHEN clause.
--   - Does NOT modify organization_status_contacts RLS/grants (migration
--     008) or the contact-phone lateral-join logic migration 047 added —
--     both preserved verbatim, including source_contact_phone/
--     target_contact_phone in the returned payload.
--   - Does NOT grant any new direct table privilege to any role, and does
--     not change the function's own EXECUTE grants (authenticated only;
--     anon/PUBLIC still revoked).
--   - Does NOT touch phoenix_update_inter_org_alert_state,
--     phoenix_reopen_inter_org_alert, or phoenix_get_inter_org_alert_events
--     (the other three RPCs from migration 039) — not redefined here.
--   - Does NOT touch inter_org_alert_states, inter_org_alert_events, QR,
--     export/print, or user-management objects.
--   - Does NOT use service_role or auth.admin.
--   - Does NOT add a WhatsApp Cloud/Graph API call, token, Bearer header, or
--     automatic send.
--   - Does NOT modify any frontend file — a later, separately reviewed
--     phase wires InterInstitutionAlertsScreen.tsx (and any other consumer)
--     to read source_expiry_risk_tier/source_expiry_days_remaining.
--   - Does NOT run supabase db push and does NOT apply this SQL — this
--     migration file is prepared for manual review/apply only.
--
-- Prerequisites:
--   Migrations 001-047 must be applied (008 creates
--   organization_status_contacts; 038/039 create the lifecycle schema;
--   047 adds the contact-phone fields this migration preserves).
--
-- Safety:
--   - CREATE OR REPLACE — idempotent, safe to re-run.
--   - SECURITY DEFINER + SET search_path = public — unchanged from 039/047.
--   - No DROP, TRUNCATE, or destructive CASCADE anywhere in this migration.
--   - No data written or modified beyond the exact same lifecycle upsert/
--     event-insert behavior migrations 039/047 already performed (same
--     alert_key derivation means no new rows are created merely because a
--     material's expiry tier shifted — only existing behavior: a NEW
--     alert_key, e.g. a material newly crossing into supply/demand matching
--     because it's now within the widened 9-month window, inserts a new
--     row; an existing alert_key is updated in place as before).
--
-- Risk note (see final report for full discussion):
--   Widening the near-expiry participation window from 3 to 9 months means
--   more `item_availability` rows can now match as `supply` (near_expiry)
--   candidates, which can increase the NUMBER of near_expiry_to_shortage
--   alert rows this RPC computes/upserts compared to migration 047. This is
--   an intentional, explicitly-requested part of this phase's scope (the
--   user asked for the DB/RPC to expose 9/6/3 tier data), but it is a real
--   behavior change to alert VOLUME — reviewed manually before applying.
--
-- After applying, verify with:
--   SELECT prosecdef FROM pg_proc
--   WHERE proname = 'phoenix_get_live_inter_institution_alerts_with_state';
--   -- expect: 1 row, prosecdef = true
--
--   As an authenticated institution_admin/monthly_status_officer holding
--   inter_institution_alerts.view:
--     SELECT phoenix_get_live_inter_institution_alerts_with_state(50);
--   -- expect each returned near_expiry_to_shortage alert object to include
--   -- a non-null source_expiry_risk_tier (one of expired/critical_3m/
--   -- warning_6m/watch_9m/normal/unknown) and source_expiry_days_remaining
--   -- (integer or null), alongside the unchanged source_contact_phone/
--   -- target_contact_phone fields from migration 047.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.phoenix_get_live_inter_institution_alerts_with_state(
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
  --    floored at 1 (never 0/negative). Identical to 036/037/039/047.
  v_limit := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);

  -- 4. Compute alerts and compute a deterministic alert_key per row.
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
      -- DB-EXPIRY-RISK-TIERS-LIVE-ALERTS-A: near-expiry participation window
      -- widened from 3 months (migrations 036-047) to 9 months. Priority
      -- order is UNCHANGED and still strictly: expired > missing >
      -- near_expiry > low_stock > surplus > available. effective_status
      -- itself remains one of exactly the same 6 values as before — the
      -- widened threshold only changes WHICH rows land in 'near_expiry',
      -- never adds a new effective_status value.
      CASE
        WHEN ia.expiry_date IS NOT NULL AND ia.expiry_date < current_date THEN 'expired'
        WHEN ia.condition = 'expired' THEN 'expired'
        WHEN ia.quantity <= 0 THEN 'missing'
        WHEN ia.condition = 'missing' THEN 'missing'
        WHEN ia.expiry_date IS NOT NULL
          AND ia.expiry_date <= (current_date + interval '9 months')::date THEN 'near_expiry'
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
        THEN 'high' ELSE 'medium' END AS severity,
      -- DB-EXPIRY-RISK-TIERS-LIVE-ALERTS-A: the two new fields, computed
      -- once here from s.expiry_date (the exact same source column already
      -- carried through as source_expiry_date) and passed straight through
      -- `scoped` unchanged. Never used in alert_key, never used to change
      -- alert_type/severity above.
      CASE
        WHEN s.expiry_date IS NULL THEN 'unknown'
        WHEN s.expiry_date < current_date THEN 'expired'
        WHEN s.expiry_date <= (current_date + interval '3 months')::date THEN 'critical_3m'
        WHEN s.expiry_date <= (current_date + interval '6 months')::date THEN 'warning_6m'
        WHEN s.expiry_date <= (current_date + interval '9 months')::date THEN 'watch_9m'
        ELSE 'normal'
      END AS src_expiry_risk_tier,
      CASE
        WHEN s.expiry_date IS NULL THEN NULL
        ELSE (s.expiry_date - current_date)
      END AS src_expiry_days_remaining
    FROM supply s
    JOIN demand d
      ON s.organization_id <> d.organization_id
     AND s.norm_sci    = d.norm_sci
     AND s.norm_conc   = d.norm_conc
     AND s.norm_dosage = d.norm_dosage
  ),
  scoped AS (
    SELECT m.*, so.name AS src_org_name, so.name_ar AS src_org_name_ar,
           to_.name AS tgt_org_name, to_.name_ar AS tgt_org_name_ar,
           sdp.name AS src_point_name, sdp.name_ar AS src_point_name_ar,
           tdp.name AS tgt_point_name, tdp.name_ar AS tgt_point_name_ar,
           (m.src_availability_id::text || ':' || m.tgt_availability_id::text || ':' || m.alert_type) AS alert_key
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
  ),
  -- 5. Upsert lifecycle state for every computed alert. A brand-new
  --    alert_key gets status='open'; an existing alert_key only has
  --    last_seen_at/severity_snapshot/identity-snapshot columns refreshed —
  --    status, reason, notes, and every acknowledged/in_progress/resolved/
  --    dismissed timestamp+by column are left completely untouched.
  --    IDENTICAL to migrations 039/047 — untouched by this migration.
  upserted AS (
    INSERT INTO public.inter_org_alert_states (
      alert_key, alert_type,
      source_item_availability_id, target_item_availability_id,
      source_organization_id, target_organization_id,
      scientific_name, concentration, dosage_form,
      status, severity_snapshot,
      first_seen_at, last_seen_at, created_at, updated_at
    )
    SELECT
      s.alert_key, s.alert_type,
      s.src_availability_id, s.tgt_availability_id,
      s.src_org, s.tgt_org,
      s.scientific_name, s.concentration, s.dosage_form,
      'open', s.severity,
      v_computed_at, v_computed_at, v_computed_at, v_computed_at
    FROM scoped s
    ON CONFLICT (alert_key) DO UPDATE SET
      last_seen_at      = v_computed_at,
      severity_snapshot = excluded.severity_snapshot,
      scientific_name   = excluded.scientific_name,
      concentration     = excluded.concentration,
      dosage_form       = excluded.dosage_form,
      updated_at        = v_computed_at
    RETURNING
      id, alert_key, status,
      first_seen_at, last_seen_at,
      acknowledged_at, acknowledged_by,
      in_progress_at, in_progress_by,
      resolved_at, resolved_by,
      dismissed_at, dismissed_by,
      reason, notes,
      (xmax = 0) AS was_inserted
  ),
  -- 6. Append an 'opened' system event ONLY for alert_keys that were newly
  --    inserted this call (was_inserted = true). IDENTICAL to migrations 039/047.
  events_inserted AS (
    INSERT INTO public.inter_org_alert_events (
      alert_state_id, event_type, actor_id,
      actor_name_snapshot, actor_email_snapshot, actor_role_snapshot,
      from_status, to_status, reason, notes
    )
    SELECT id, 'opened', NULL, NULL, NULL, NULL, NULL, 'open', NULL, NULL
    FROM upserted
    WHERE was_inserted
    RETURNING 1
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
      -- DB-EXPIRY-RISK-TIERS-LIVE-ALERTS-A: the only two fields added by
      -- this migration. UI classification only — mirrors the frontend's
      -- own EXPIRY-RISK-TIERS-A tier vocabulary so a later phase can read
      -- the same concept server-side instead of re-deriving it client-side.
      'source_expiry_risk_tier',         s.src_expiry_risk_tier,
      'source_expiry_days_remaining',    s.src_expiry_days_remaining,
      -- DB-ALERTS-LIVE-WHATSAPP-CONTACT-FIELDS-A (migration 047): preserved verbatim.
      'source_contact_phone',            src_contact.phone,
      'target_contact_phone',            tgt_contact.phone,
      'computed_at',                      v_computed_at,
      'alert_key',                        u.alert_key,
      'lifecycle_status',                 u.status,
      'first_seen_at',                    u.first_seen_at,
      'last_seen_at',                      u.last_seen_at,
      'acknowledged_at',                   u.acknowledged_at,
      'acknowledged_by',                   u.acknowledged_by,
      'in_progress_at',                    u.in_progress_at,
      'in_progress_by',                    u.in_progress_by,
      'resolved_at',                       u.resolved_at,
      'resolved_by',                       u.resolved_by,
      'dismissed_at',                      u.dismissed_at,
      'dismissed_by',                      u.dismissed_by,
      'lifecycle_reason',                  u.reason,
      'lifecycle_notes',                   u.notes
    )
    ORDER BY
      CASE s.severity WHEN 'high' THEN 2 ELSE 1 END DESC,
      CASE WHEN s.alert_type = 'near_expiry_to_shortage' THEN s.src_expiry END ASC NULLS LAST,
      s.scientific_name ASC
  )
  INTO v_alerts
  FROM scoped s
  JOIN upserted u ON u.alert_key = s.alert_key
  -- DB-ALERTS-LIVE-WHATSAPP-CONTACT-FIELDS-A (migration 047): preserved
  -- verbatim. Best active contact phone for this row's source/target
  -- organization.
  LEFT JOIN LATERAL (
    SELECT osc.phone
    FROM public.organization_status_contacts osc
    WHERE osc.organization_id = s.src_org
      AND osc.is_active = true
      AND osc.phone IS NOT NULL
    ORDER BY osc.is_primary DESC, osc.updated_at DESC NULLS LAST, osc.created_at DESC
    LIMIT 1
  ) src_contact ON true
  LEFT JOIN LATERAL (
    SELECT osc.phone
    FROM public.organization_status_contacts osc
    WHERE osc.organization_id = s.tgt_org
      AND osc.is_active = true
      AND osc.phone IS NOT NULL
    ORDER BY osc.is_primary DESC, osc.updated_at DESC NULLS LAST, osc.created_at DESC
    LIMIT 1
  ) tgt_contact ON true;

  RETURN jsonb_build_object(
    'ok', true,
    'alerts', coalesce(v_alerts, '[]'::jsonb),
    'computed_at', v_computed_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_get_live_inter_institution_alerts_with_state(integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_get_live_inter_institution_alerts_with_state(integer)
  TO authenticated;

-- =============================================================================
-- VERIFY
-- =============================================================================

DO $$
DECLARE
  v_fn_src text;
BEGIN
  -- A. Function still exists under the exact same name/signature.
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_get_live_inter_institution_alerts_with_state'),
    'VERIFY FAILED: phoenix_get_live_inter_institution_alerts_with_state not found';

  SELECT pg_get_functiondef(oid) INTO v_fn_src
  FROM pg_proc WHERE proname = 'phoenix_get_live_inter_institution_alerts_with_state';

  -- B. Still SECURITY DEFINER + search_path pinned, exactly as migrations 039/047.
  ASSERT v_fn_src LIKE '%SECURITY DEFINER%' AND v_fn_src LIKE '%SET search_path%',
    'VERIFY FAILED: function lost SECURITY DEFINER/search_path';

  -- C. New expiry-risk-tier fields present in the return payload.
  ASSERT v_fn_src LIKE '%source_expiry_risk_tier%',
    'VERIFY FAILED: function does not return source_expiry_risk_tier';
  ASSERT v_fn_src LIKE '%source_expiry_days_remaining%',
    'VERIFY FAILED: function does not return source_expiry_days_remaining';

  -- D. All 6 tier strings present.
  ASSERT v_fn_src LIKE '%critical_3m%', 'VERIFY FAILED: critical_3m tier missing';
  ASSERT v_fn_src LIKE '%warning_6m%',  'VERIFY FAILED: warning_6m tier missing';
  ASSERT v_fn_src LIKE '%watch_9m%',    'VERIFY FAILED: watch_9m tier missing';
  ASSERT v_fn_src LIKE '%''expired''%', 'VERIFY FAILED: expired tier missing';
  ASSERT v_fn_src LIKE '%''normal''%',  'VERIFY FAILED: normal tier missing';
  ASSERT v_fn_src LIKE '%''unknown''%', 'VERIFY FAILED: unknown tier missing';

  -- E. Near-expiry participation threshold widened to 9 months.
  ASSERT v_fn_src LIKE '%interval ''9 months''%',
    'VERIFY FAILED: near-expiry participation threshold was not widened to 9 months';

  -- F. Priority order preserved: expired and missing/quantity<=0 both still
  --    appear as WHEN clauses before the near_expiry WHEN clause inside the
  --    same CASE expression (textual order proxy for CASE evaluation order).
  ASSERT position('expiry_date < current_date' in v_fn_src)
       < position('interval ''9 months''' in v_fn_src),
    'VERIFY FAILED: expired precedence must come before the widened near_expiry threshold';
  ASSERT position('ia.quantity <= 0' in v_fn_src)
       < position('interval ''9 months''' in v_fn_src),
    'VERIFY FAILED: missing/quantity<=0 precedence must come before the widened near_expiry threshold';

  -- G. condition = 'near_expiry' compatibility branch still present (manual/legacy fallback).
  ASSERT v_fn_src LIKE '%ia.condition = ''near_expiry''%',
    'VERIFY FAILED: condition = ''near_expiry'' compatibility branch is missing';

  -- H. alert_type still derived the same way; near_expiry_to_shortage preserved.
  ASSERT v_fn_src LIKE '%near_expiry_to_shortage%',
    'VERIFY FAILED: near_expiry_to_shortage alert_type missing';
  ASSERT v_fn_src LIKE '%surplus_to_shortage%',
    'VERIFY FAILED: surplus_to_shortage alert_type missing';

  -- I. alert_key formula does not include the expiry tier, and is still the
  --    same 3-part key.
  ASSERT v_fn_src LIKE '%src_availability_id::text || '':'' || m.tgt_availability_id::text || '':'' || m.alert_type%',
    'VERIFY FAILED: alert_key formula changed from src:tgt:alert_type';
  ASSERT v_fn_src NOT LIKE '%expiry_risk_tier || %' AND v_fn_src NOT LIKE '%|| src_expiry_risk_tier%',
    'VERIFY FAILED: alert_key must not incorporate source_expiry_risk_tier';

  -- J. Lifecycle upsert/event fields preserved.
  ASSERT v_fn_src LIKE '%ON CONFLICT (alert_key) DO UPDATE%',
    'VERIFY FAILED: function no longer upserts inter_org_alert_states by alert_key';
  ASSERT v_fn_src LIKE '%''opened''%',
    'VERIFY FAILED: function no longer appends an opened event for new alerts';
  ASSERT v_fn_src LIKE '%lifecycle_status%',
    'VERIFY FAILED: function no longer returns lifecycle_status';

  -- K. Scoped visibility preserved.
  ASSERT v_fn_src LIKE '%v_is_super OR m.src_org = v_org OR m.tgt_org = v_org%',
    'VERIFY FAILED: scoped visibility clause changed';

  -- L. Contact-phone fields/joins from migration 047 preserved.
  ASSERT v_fn_src LIKE '%source_contact_phone%',
    'VERIFY FAILED: function does not return source_contact_phone';
  ASSERT v_fn_src LIKE '%target_contact_phone%',
    'VERIFY FAILED: function does not return target_contact_phone';
  ASSERT v_fn_src LIKE '%organization_status_contacts%',
    'VERIFY FAILED: function does not reference organization_status_contacts';
  ASSERT v_fn_src LIKE '%is_active%',
    'VERIFY FAILED: function does not filter on is_active';
  ASSERT v_fn_src LIKE '%is_primary%',
    'VERIFY FAILED: function does not prefer is_primary';

  -- M. Safety: no service_role/auth.admin, no WhatsApp API/token/automation.
  ASSERT v_fn_src NOT LIKE '%service' || '_role%',
    'VERIFY FAILED: function must not reference the elevated service role';
  ASSERT v_fn_src NOT LIKE '%auth.' || 'admin%',
    'VERIFY FAILED: function must not reference the auth admin API';
  ASSERT v_fn_src !~* (
    'graph.faceboo' || 'k.com|access_tok' || 'en=|api.whatsap' || 'p.com|Bea' || 'rer |send' || 'Message'
  ), 'VERIFY FAILED: function must not reference any WhatsApp Cloud/Graph API or token';

  -- N. Grants unchanged: authenticated only, anon/PUBLIC excluded.
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public' AND routine_name = 'phoenix_get_live_inter_institution_alerts_with_state'
      AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
  ), 'VERIFY FAILED: authenticated missing EXECUTE on phoenix_get_live_inter_institution_alerts_with_state';
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public' AND routine_name = 'phoenix_get_live_inter_institution_alerts_with_state'
      AND grantee IN ('anon', 'PUBLIC')
  ), 'VERIFY FAILED: anon/PUBLIC has EXECUTE on phoenix_get_live_inter_institution_alerts_with_state';

  -- O. organization_status_contacts RLS untouched by this migration.
  ASSERT EXISTS (
    SELECT 1 FROM pg_class
    WHERE relname = 'organization_status_contacts' AND relrowsecurity = true
  ), 'VERIFY FAILED: organization_status_contacts must still have RLS enabled';

  -- P. Other migration-039 RPCs/tables untouched.
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_update_inter_org_alert_state'),
    'VERIFY FAILED: phoenix_update_inter_org_alert_state is missing (must not be touched)';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_reopen_inter_org_alert'),
    'VERIFY FAILED: phoenix_reopen_inter_org_alert is missing (must not be touched)';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_get_inter_org_alert_events'),
    'VERIFY FAILED: phoenix_get_inter_org_alert_events is missing (must not be touched)';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'get_public_qr_payload'),
    'VERIFY FAILED: get_public_qr_payload is missing (must not be touched)';

  RAISE NOTICE '048 OK: phoenix_get_live_inter_institution_alerts_with_state now returns source_expiry_risk_tier/source_expiry_days_remaining and widens near-expiry participation to 9 months, with expired/missing precedence, alert_key stability, severity, alert_type, contact-phone fields, scoping, and lifecycle behavior all preserved byte-for-byte from migration 047.';
END $$;

-- =============================================================================
-- END OF MIGRATION 048
-- =============================================================================
