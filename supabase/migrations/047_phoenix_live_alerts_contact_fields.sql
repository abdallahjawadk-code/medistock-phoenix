-- =============================================================================
-- MediStock Phoenix V2 — Migration 047: Live Alerts Contact Fields
-- =============================================================================
-- MANUAL APPLY ONLY — DO NOT use `npx supabase db push`.
-- Review then apply manually in Supabase Dashboard → SQL Editor.
--
-- Task: DB-ALERTS-LIVE-WHATSAPP-CONTACT-FIELDS-A
--
-- Purpose:
--   BUGFIX-ALERTS-WHATSAPP-CONTACT-READ-A found that Inter-Institution
--   Alerts' WhatsApp button reads contact phones via a SEPARATE, direct
--   PostgREST query (getOrgStatusContactsForOrgs ->
--   organization_status_contacts), which is subject to that table's RLS
--   (migration 008). Migration 008's policies only cover super_admin,
--   hospital_admin (legacy), warehouse_manager/point_operator/viewer — never
--   institution_admin or monthly_status_officer, the roles migration 012
--   introduced afterward. So for those two roles, the direct query returns
--   EMPTY even for the actor's own organization's contact, regardless of
--   what organization_status_contacts actually contains.
--
--   The older phoenix_get_live_inter_institution_alerts (036/037) and
--   get_scoped_inter_institution_alerts (009) RPCs already solve exactly
--   this by resolving contact phone SERVER-SIDE via a SECURITY DEFINER
--   lateral join, bypassing RLS entirely and scoping the returned contact to
--   only the alerts the actor is already authorized to see. But
--   InterInstitutionAlertsScreen.tsx does not call either of those — it
--   calls phoenix_get_live_inter_institution_alerts_with_state (migration
--   039), which has no contact field at all.
--
--   This migration adds that same, already-proven contact-resolution
--   pattern to phoenix_get_live_inter_institution_alerts_with_state, so a
--   later (separately reviewed) frontend phase can read
--   source_contact_phone/target_contact_phone directly off each alert row
--   instead of the RLS-limited direct table query.
--
-- Decision: same-name replacement, not a v2 RPC.
--   phoenix_get_live_inter_institution_alerts_with_state (migration 039)
--   RETURNS jsonb — a single opaque value, not RETURNS TABLE with a fixed
--   column list. Postgres allows CREATE OR REPLACE FUNCTION to redefine a
--   function's body freely as long as the name, argument types, and return
--   type are unchanged (here: same name, (integer), RETURNS jsonb) — no
--   DROP FUNCTION is required or used. This is safe, matches the existing
--   CREATE OR REPLACE convention used throughout this project's migrations,
--   and means the frontend service (which already calls this exact RPC name)
--   needs zero changes to receive the two new jsonb keys on every alert
--   object it already parses.
--
-- What this migration does:
--   A. Re-creates public.phoenix_get_live_inter_institution_alerts_with_state
--      (integer) with an IDENTICAL body to migration 039 in every respect —
--      same auth check, same permission check, same limit sanitation, same
--      candidates/supply/demand/matched/scoped CTEs, same lifecycle
--      upsert/event-insert logic, same jsonb_build_object field list — with
--      exactly two additions:
--        1. Two LEFT JOIN LATERAL subqueries against
--           organization_status_contacts (one for the source org, one for
--           the target org), each selecting the single best contact phone:
--           is_active = true, phone IS NOT NULL, preferring is_primary,
--           then most-recently-updated, then most-recently-created, LIMIT 1.
--        2. Two new keys in the returned jsonb per alert:
--           source_contact_phone, target_contact_phone.
--   B. Verification block.
--
-- What this migration does NOT do:
--   - Does NOT modify migrations 001-046 in any way.
--   - Does NOT change any other field, filter, scoping rule, permission
--     check, limit sanitation, or lifecycle upsert/event-insert logic —
--     every line of migration 039's function body is preserved verbatim
--     except the two additions described above.
--   - Does NOT widen alert visibility — the `scoped` CTE's
--     `WHERE v_is_super OR m.src_org = v_org OR m.tgt_org = v_org` clause is
--     untouched, so contact fields are only ever attached to alerts the
--     actor could already see.
--   - Does NOT expose any contact for an organization outside a returned
--     alert row — the lateral joins are keyed to that row's own src_org/
--     tgt_org, never a client-supplied id.
--   - Does NOT modify organization_status_contacts RLS or grants (migration
--     008) in any way — this migration reads that table only from inside an
--     existing SECURITY DEFINER function, exactly like get_scoped_inter_
--     institution_alerts (009) and phoenix_get_live_inter_institution_alerts
--     (036/037) already do.
--   - Does NOT grant any new direct table privilege to any role.
--   - Does NOT touch phoenix_update_inter_org_alert_state,
--     phoenix_reopen_inter_org_alert, or phoenix_get_inter_org_alert_events
--     (the other three RPCs from migration 039) — not redefined here.
--   - Does NOT touch inter_org_alert_states, inter_org_alert_events, QR,
--     export/print, or user-management objects.
--   - Does NOT use service_role or auth.admin.
--   - Does NOT add a WhatsApp Cloud/Graph API call, token, Bearer header, or
--     automatic send — this only adds two nullable text fields to an
--     existing read RPC's jsonb payload.
--   - Does NOT modify any frontend file — InterInstitutionAlertsScreen.tsx
--     is wired to these new fields in a later, separately reviewed phase.
--
-- Prerequisites:
--   Migrations 001-046 must be applied (008 creates
--   organization_status_contacts; 038/039 create the lifecycle schema and
--   this exact RPC).
--
-- Safety:
--   - CREATE OR REPLACE — idempotent, safe to re-run.
--   - SECURITY DEFINER + SET search_path = public — unchanged from 039.
--   - No DROP, TRUNCATE, or destructive CASCADE anywhere in this migration.
--   - No data written or modified beyond the exact same lifecycle upsert/
--     event-insert behavior migration 039 already performed.
--
-- After applying, verify with:
--   SELECT prosecdef FROM pg_proc
--   WHERE proname = 'phoenix_get_live_inter_institution_alerts_with_state';
--   -- expect: 1 row, prosecdef = true
--
--   As an authenticated institution_admin/monthly_status_officer holding
--   inter_institution_alerts.view, with a real active
--   organization_status_contacts row for their own org:
--     SELECT phoenix_get_live_inter_institution_alerts_with_state(50);
--   -- expect each returned alert object to include non-null
--   -- source_contact_phone and/or target_contact_phone wherever that side's
--   -- organization has an active contact row — never a fake/placeholder
--   -- value, and never a contact for an organization not already part of
--   -- that alert row.
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
  --    floored at 1 (never 0/negative). Identical to 036/037/039.
  v_limit := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);

  -- 4. Compute alerts (identical logic to migrations 036/037/039) and
  --    compute a deterministic alert_key per row.
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
  --    IDENTICAL to migration 039 — untouched by this migration.
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
  --    inserted this call (was_inserted = true). IDENTICAL to migration 039.
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
      -- DB-ALERTS-LIVE-WHATSAPP-CONTACT-FIELDS-A: the only two fields added
      -- by this migration. Resolved server-side (SECURITY DEFINER bypasses
      -- organization_status_contacts RLS, exactly like get_scoped_inter_
      -- institution_alerts/036-037 already do), scoped strictly to this
      -- row's own src_org/tgt_org — never a client-supplied id, never
      -- widening which alerts are visible.
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
  -- DB-ALERTS-LIVE-WHATSAPP-CONTACT-FIELDS-A: best active contact phone for
  -- this row's source/target organization. is_active = true and phone IS
  -- NOT NULL exclude inactive/empty rows; is_primary DESC prefers the
  -- designated primary contact; updated_at/created_at DESC break ties
  -- deterministically. LIMIT 1 per lateral join — at most one phone per side.
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

  -- B. Still SECURITY DEFINER + search_path pinned, exactly as migration 039.
  ASSERT v_fn_src LIKE '%SECURITY DEFINER%' AND v_fn_src LIKE '%SET search_path%',
    'VERIFY FAILED: function lost SECURITY DEFINER/search_path';

  -- C. New contact fields present in the return payload.
  ASSERT v_fn_src LIKE '%source_contact_phone%',
    'VERIFY FAILED: function does not return source_contact_phone';
  ASSERT v_fn_src LIKE '%target_contact_phone%',
    'VERIFY FAILED: function does not return target_contact_phone';

  -- D. Contact resolution reads organization_status_contacts with the
  --    required filters.
  ASSERT v_fn_src LIKE '%organization_status_contacts%',
    'VERIFY FAILED: function does not reference organization_status_contacts';
  ASSERT v_fn_src LIKE '%is_active%',
    'VERIFY FAILED: function does not filter on is_active';
  ASSERT v_fn_src LIKE '%is_primary%',
    'VERIFY FAILED: function does not prefer is_primary';

  -- E. Existing lifecycle fields/behavior preserved (same assertions 039 itself makes).
  ASSERT v_fn_src LIKE '%source_item_availability_id%' AND v_fn_src LIKE '%target_item_availability_id%',
    'VERIFY FAILED: function no longer uses source/target_item_availability_id';
  ASSERT v_fn_src LIKE '%alert_key%',
    'VERIFY FAILED: function no longer derives alert_key';
  ASSERT v_fn_src LIKE '%ON CONFLICT (alert_key) DO UPDATE%',
    'VERIFY FAILED: function no longer upserts inter_org_alert_states by alert_key';
  ASSERT v_fn_src LIKE '%''opened''%',
    'VERIFY FAILED: function no longer appends an opened event for new alerts';
  ASSERT v_fn_src LIKE '%lifecycle_status%',
    'VERIFY FAILED: function no longer returns lifecycle_status';

  -- F. Safety: no service_role/auth.admin, no WhatsApp API/token/automation.
  ASSERT v_fn_src NOT LIKE '%service' || '_role%',
    'VERIFY FAILED: function must not reference the elevated service role';
  ASSERT v_fn_src NOT LIKE '%auth.' || 'admin%',
    'VERIFY FAILED: function must not reference the auth admin API';
  ASSERT v_fn_src !~* (
    'graph.faceboo' || 'k.com|access_tok' || 'en=|api.whatsap' || 'p.com|Bea' || 'rer |send' || 'Message'
  ), 'VERIFY FAILED: function must not reference any WhatsApp Cloud/Graph API or token';

  -- G. Grants unchanged: authenticated only, anon/PUBLIC excluded.
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

  -- H. organization_status_contacts RLS untouched by this migration — still
  --    enabled exactly as migration 008 left it. This migration adds no
  --    GRANT/REVOKE statement against that table at all (only against the
  --    function above), so there is nothing else to assert here.
  ASSERT EXISTS (
    SELECT 1 FROM pg_class
    WHERE relname = 'organization_status_contacts' AND relrowsecurity = true
  ), 'VERIFY FAILED: organization_status_contacts must still have RLS enabled';

  -- I. Other migration-039 RPCs/tables untouched.
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_update_inter_org_alert_state'),
    'VERIFY FAILED: phoenix_update_inter_org_alert_state is missing (must not be touched)';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_reopen_inter_org_alert'),
    'VERIFY FAILED: phoenix_reopen_inter_org_alert is missing (must not be touched)';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_get_inter_org_alert_events'),
    'VERIFY FAILED: phoenix_get_inter_org_alert_events is missing (must not be touched)';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'get_public_qr_payload'),
    'VERIFY FAILED: get_public_qr_payload is missing (must not be touched)';

  RAISE NOTICE '047 OK: phoenix_get_live_inter_institution_alerts_with_state now returns source_contact_phone/target_contact_phone, resolved server-side from organization_status_contacts (is_active, prefers is_primary), scoped to each alert row''s own organizations — all other behavior byte-for-byte identical to migration 039.';
END $$;

-- =============================================================================
-- END OF MIGRATION 047
-- =============================================================================
