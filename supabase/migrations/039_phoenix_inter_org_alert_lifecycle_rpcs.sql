-- =============================================================================
-- MediStock Phoenix V2 — Migration 039: Inter-Org Alert Lifecycle RPCs
-- =============================================================================
-- MANUAL APPLY ONLY — DO NOT use `npx supabase db push`.
-- Apply via Supabase Dashboard → SQL Editor after a verified backup.
--
-- Prerequisites: 001 (item_availability, organizations, profiles), 002
-- (phoenix_my_role/phoenix_my_org), 010/017 (phoenix_profile_has_permission),
-- 014 (actor-snapshot resolution pattern this migration mirrors), 019/020
-- (item_availability material identity columns), 034 (phoenix_apply_
-- availability_movement — the row-lock + actor-snapshot RPC pattern this
-- migration follows), 036/037 (phoenix_get_live_inter_institution_alerts +
-- source/target item_availability_id in its payload), 038 (inter_org_
-- alert_states + inter_org_alert_events tables, 4 lifecycle permission keys,
-- RLS/grants — REQUIRED, already manually applied by the owner).
--
-- Task: ALERT-LIFECYCLE-RPC-A
--
-- Purpose:
--   Migration 038 created the persisted lifecycle schema with zero write
--   access for any client role (by design — see 038's header). This
--   migration adds the four SECURITY DEFINER RPCs that are the ONLY way to
--   read/write that schema:
--     1. phoenix_get_live_inter_institution_alerts_with_state — computes the
--        live alert set (same logic as 037) AND upserts/refreshes persisted
--        lifecycle state for each computed alert, returning the merged
--        payload. This is the only RPC in this migration with a write side
--        effect on a READ call — documented explicitly below and in tests.
--     2. phoenix_update_inter_org_alert_state — the sole transition RPC
--        (open->acknowledged->in_progress->resolved, or ...->dismissed).
--     3. phoenix_reopen_inter_org_alert — manually reopens a resolved/
--        dismissed alert back to open.
--     4. phoenix_get_inter_org_alert_events — the sole controlled read path
--        for inter_org_alert_events (which has zero direct grants/policies
--        per migration 038's explicit decision).
--
-- What this migration does NOT do:
--   - Does NOT modify migrations 001-038 in any way.
--   - Does NOT modify phoenix_get_live_inter_institution_alerts (036/037) —
--     this migration duplicates its exact computation logic internally
--     rather than calling it, because RPC 1 below needs row-level access to
--     the intermediate source/target availability ids and computed
--     alert_key/severity to drive the upsert — parsing that back out of the
--     existing RPC's already-flattened jsonb payload would be strictly more
--     fragile than re-running the same, already-audited CTE chain once more
--     inside a second SECURITY DEFINER function. Every clause below
--     (candidates/supply/demand/matched/scoped) is byte-for-byte the same
--     computation as 037's phoenix_get_live_inter_institution_alerts.
--   - Does NOT create any new table, permission key, or RLS policy — all
--     four permission keys used below already exist as of migration 038.
--   - Does NOT touch get_public_qr_payload, qr_tokens, qr_targets, or any
--     other QR-related object.
--   - Does NOT touch phoenix_apply_availability_movement, phoenix_upsert_
--     availability, or item_availability_movements — no function here ever
--     writes to item_availability.quantity.
--   - Does NOT wire InterInstitutionAlertsScreen or DashboardScreen to these
--     RPCs — no frontend UI screen changes in this migration (a service
--     wrapper file is added separately, imported by nothing yet).
--   - Does NOT grant any new direct table privilege on inter_org_alert_states
--     or inter_org_alert_events — reads/writes happen exclusively inside
--     these SECURITY DEFINER functions, which bypass RLS internally exactly
--     like phoenix_apply_availability_movement already does for
--     item_availability_movements.
--   - Does NOT use service_role or any elevated/admin API key.
--   - Does NOT add Excel/XLSX import.
--
-- Actor snapshot columns (confirmed against migration 001/034, not assumed):
--   profiles has full_name (text, not null) and role (text, not null) but NO
--   email column — email lives on auth.users only. This migration resolves
--   the actor snapshot exactly like phoenix_apply_availability_movement
--   (migration 034) and phoenix_populate_actor_snapshot (migration 014):
--     SELECT p.full_name, u.email, p.role
--       FROM public.profiles p LEFT JOIN auth.users u ON u.id = p.id
--      WHERE p.id = <actor>
--   (LEFT JOIN because auth.users is only readable with SECURITY DEFINER
--   privilege, same documented reason as 034).
--
-- Error-reporting convention (two established, coexisting styles in this
-- codebase — both are followed here, matched to the closest existing
-- precedent for each RPC's shape):
--   - RPC 1 (read, computed) and RPC 4 (read, controlled event access)
--     return { ok: false, error: '...' } jsonb, mirroring
--     phoenix_get_live_inter_institution_alerts (036/037) and
--     get_effective_permissions (010) — the established convention for
--     read-oriented RPCs in this codebase.
--   - RPC 2 and RPC 3 (state-mutating transition RPCs, permission + org
--     scope + row-lock gated) RAISE EXCEPTION with a specific ERRCODE per
--     failure, mirroring phoenix_apply_availability_movement (034) exactly —
--     the established convention for write/transition RPCs. Both styles are
--     intentional, not inconsistent: they match the two families of RPC that
--     already coexist in this schema.
--
-- Concurrency:
--   - RPC 1 uses a single INSERT ... ON CONFLICT (alert_key) DO UPDATE ...
--     RETURNING per call (no PL/pgSQL loop, no explicit row lock needed —
--     the UNIQUE constraint on alert_key makes the upsert atomic per row by
--     construction, and RETURNING (xmax = 0) distinguishes a fresh insert
--     from a conflict-triggered update, so an 'opened' event is appended
--     exactly once per new alert_key, never on a refresh of an existing one).
--   - RPC 2 and RPC 3 both use SELECT ... FOR UPDATE on the target
--     inter_org_alert_states row before any transition check, exactly
--     mirroring phoenix_apply_availability_movement's row-locking pattern —
--     two concurrent transition attempts on the same alert_key cannot race.
--
-- Security: SECURITY DEFINER, SET search_path = public on all four
-- functions. REVOKE ALL FROM PUBLIC, anon; GRANT EXECUTE TO authenticated
-- only. No new direct table grant on either lifecycle table.
-- =============================================================================

-- =============================================================================
-- RPC 1: phoenix_get_live_inter_institution_alerts_with_state
-- =============================================================================
-- Computes the live alert set (identical logic to phoenix_get_live_inter_
-- institution_alerts, migrations 036/037) and additionally upserts/refreshes
-- persisted lifecycle state (public.inter_org_alert_states +
-- public.inter_org_alert_events) for each computed alert, then returns the
-- computed payload merged with the current lifecycle fields.
--
-- CONTROLLED WRITE SIDE EFFECT: unlike a typical read-only RPC, calling this
-- function creates a new inter_org_alert_states row (status='open') the
-- first time a given (source, target, alert_type) triple is observed, and
-- bumps last_seen_at/severity_snapshot on every subsequent call while that
-- triple remains computed as live. It NEVER overwrites status, reason,
-- notes, or any acknowledged_at/in_progress_at/resolved_at/dismissed_at/
-- *_by column on an existing row. This is documented here and asserted by
-- tests (039 test file) precisely because it is the one place in this
-- migration where a "get" function is not purely read-only.
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
  --    floored at 1 (never 0/negative). Identical to 036/037.
  v_limit := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);

  -- 4. Compute alerts (identical logic to migrations 036/037) and compute a
  --    deterministic alert_key per row.
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
  --    inserted this call (was_inserted = true). actor_id/snapshot columns
  --    are left NULL — this is a system-detected event (the alert existing
  --    is a computed fact, not an action any specific user took), so there
  --    is no meaningful actor identity to attach, consistent with there
  --    being no acting user in the request that "caused" the alert to exist.
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
  JOIN upserted u ON u.alert_key = s.alert_key;

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
-- RPC 2: phoenix_update_inter_org_alert_state
-- =============================================================================
-- The sole transition RPC. Allowed transitions:
--   open -> acknowledged   (requires inter_institution_alerts.acknowledge)
--   open -> dismissed      (requires inter_institution_alerts.dismiss)
--   acknowledged -> in_progress (requires inter_institution_alerts.manage)
--   acknowledged -> dismissed   (requires inter_institution_alerts.dismiss)
--   in_progress -> resolved    (requires inter_institution_alerts.resolve)
--   in_progress -> dismissed   (requires inter_institution_alerts.dismiss)
-- Every other (from_status, to_status) pair — including anything out of
-- resolved/dismissed, open->in_progress, open->resolved,
-- acknowledged->resolved, in_progress->acknowledged, or an unknown
-- to_status — raises invalid_transition / invalid_target_status.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.phoenix_update_inter_org_alert_state(
  p_alert_key text,
  p_to_status text,
  p_reason    text DEFAULT NULL,
  p_notes     text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor       uuid := auth.uid();
  v_role        text;
  v_my_org      uuid;
  v_is_super    boolean;
  v_row         public.inter_org_alert_states%ROWTYPE;
  v_allowed     boolean;
  v_event_type  text;
  v_actor_name  text;
  v_actor_email text;
  v_actor_role  text;
BEGIN
  -- 1. Auth required.
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  -- 2. Basic input validation.
  IF p_alert_key IS NULL OR btrim(p_alert_key) = '' THEN
    RAISE EXCEPTION 'alert_key_required' USING ERRCODE = '23514';
  END IF;

  IF p_to_status IS NULL OR p_to_status NOT IN ('acknowledged', 'in_progress', 'resolved', 'dismissed') THEN
    RAISE EXCEPTION 'invalid_target_status' USING ERRCODE = '23514';
  END IF;

  -- 3. Lock the target row before any authorization/transition check
  --    (prevents concurrent-transition races on the same alert_key).
  SELECT * INTO v_row
  FROM public.inter_org_alert_states
  WHERE alert_key = p_alert_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'alert_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- 4. Validate the transition itself (status read from the LOCKED row).
  v_allowed :=
       (v_row.status = 'open'         AND p_to_status = 'acknowledged')
    OR (v_row.status = 'open'         AND p_to_status = 'dismissed')
    OR (v_row.status = 'acknowledged' AND p_to_status = 'in_progress')
    OR (v_row.status = 'acknowledged' AND p_to_status = 'dismissed')
    OR (v_row.status = 'in_progress'  AND p_to_status = 'resolved')
    OR (v_row.status = 'in_progress'  AND p_to_status = 'dismissed');

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = '23514';
  END IF;

  -- 5. Reason requirement: dismissed and resolved both require a non-empty
  --    reason — resolved is required because migration 038's
  --    inter_org_alert_states_resolve_reason_chk CHECK constraint would
  --    reject the UPDATE anyway; this check gives a clearer error earlier.
  IF p_to_status IN ('dismissed', 'resolved') AND (p_reason IS NULL OR btrim(p_reason) = '') THEN
    RAISE EXCEPTION 'reason_required' USING ERRCODE = '23514';
  END IF;

  -- 6. Authorize: org scope (read from the LOCKED row, never trusted from
  --    client input) + permission per target status.
  v_role     := phoenix_my_role();
  v_my_org   := phoenix_my_org();
  v_is_super := (v_role = 'super_admin');

  IF NOT v_is_super
     AND v_row.source_organization_id <> v_my_org
     AND v_row.target_organization_id <> v_my_org THEN
    RAISE EXCEPTION 'forbidden_cross_org' USING ERRCODE = '42501';
  END IF;

  IF NOT v_is_super THEN
    IF p_to_status = 'acknowledged' AND NOT phoenix_profile_has_permission(v_actor, 'inter_institution_alerts.acknowledge') THEN
      RAISE EXCEPTION 'forbidden_inter_institution_alerts_acknowledge' USING ERRCODE = '42501';
    ELSIF p_to_status = 'in_progress' AND NOT phoenix_profile_has_permission(v_actor, 'inter_institution_alerts.manage') THEN
      RAISE EXCEPTION 'forbidden_inter_institution_alerts_manage' USING ERRCODE = '42501';
    ELSIF p_to_status = 'resolved' AND NOT phoenix_profile_has_permission(v_actor, 'inter_institution_alerts.resolve') THEN
      RAISE EXCEPTION 'forbidden_inter_institution_alerts_resolve' USING ERRCODE = '42501';
    ELSIF p_to_status = 'dismissed' AND NOT phoenix_profile_has_permission(v_actor, 'inter_institution_alerts.dismiss') THEN
      RAISE EXCEPTION 'forbidden_inter_institution_alerts_dismiss' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 7. Resolve actor identity snapshot — mirrors phoenix_apply_availability_
  --    movement (migration 034) / phoenix_populate_actor_snapshot (migration 014).
  SELECT p.full_name, u.email, p.role
    INTO v_actor_name, v_actor_email, v_actor_role
  FROM public.profiles p
  LEFT JOIN auth.users u ON u.id = p.id
  WHERE p.id = v_actor;

  v_event_type := p_to_status;

  -- 8. Atomic write: update the locked row, then append one immutable event.
  UPDATE public.inter_org_alert_states
     SET status =
           CASE p_to_status
             WHEN 'acknowledged' THEN 'acknowledged'
             WHEN 'in_progress'  THEN 'in_progress'
             WHEN 'resolved'     THEN 'resolved'
             WHEN 'dismissed'    THEN 'dismissed'
           END,
         acknowledged_at = CASE WHEN p_to_status = 'acknowledged' THEN now() ELSE acknowledged_at END,
         acknowledged_by = CASE WHEN p_to_status = 'acknowledged' THEN v_actor ELSE acknowledged_by END,
         in_progress_at  = CASE WHEN p_to_status = 'in_progress'  THEN now() ELSE in_progress_at  END,
         in_progress_by  = CASE WHEN p_to_status = 'in_progress'  THEN v_actor ELSE in_progress_by  END,
         resolved_at     = CASE WHEN p_to_status = 'resolved'     THEN now() ELSE resolved_at     END,
         resolved_by     = CASE WHEN p_to_status = 'resolved'     THEN v_actor ELSE resolved_by     END,
         dismissed_at    = CASE WHEN p_to_status = 'dismissed'    THEN now() ELSE dismissed_at    END,
         dismissed_by    = CASE WHEN p_to_status = 'dismissed'    THEN v_actor ELSE dismissed_by    END,
         reason     = p_reason,
         notes      = p_notes,
         updated_at = now()
   WHERE id = v_row.id;

  INSERT INTO public.inter_org_alert_events (
    alert_state_id, event_type, actor_id,
    actor_name_snapshot, actor_email_snapshot, actor_role_snapshot,
    from_status, to_status, reason, notes
  ) VALUES (
    v_row.id, v_event_type, v_actor,
    v_actor_name, v_actor_email, v_actor_role,
    v_row.status, p_to_status, p_reason, p_notes
  );

  RETURN jsonb_build_object(
    'ok', true,
    'alert_key', p_alert_key,
    'from_status', v_row.status,
    'to_status', p_to_status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_update_inter_org_alert_state(text, text, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_update_inter_org_alert_state(text, text, text, text)
  TO authenticated;

-- =============================================================================
-- RPC 3: phoenix_reopen_inter_org_alert
-- =============================================================================
-- Manually reopens a resolved or dismissed alert back to 'open'. Requires
-- inter_institution_alerts.manage (unless super_admin) and a non-empty
-- reason. Old resolved_at/resolved_by/dismissed_at/dismissed_by values are
-- preserved (never erased) — only status/reason/notes/updated_at change.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.phoenix_reopen_inter_org_alert(
  p_alert_key text,
  p_reason    text DEFAULT NULL,
  p_notes     text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor       uuid := auth.uid();
  v_role        text;
  v_my_org      uuid;
  v_is_super    boolean;
  v_row         public.inter_org_alert_states%ROWTYPE;
  v_actor_name  text;
  v_actor_email text;
  v_actor_role  text;
BEGIN
  -- 1. Auth required.
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  -- 2. Basic input validation.
  IF p_alert_key IS NULL OR btrim(p_alert_key) = '' THEN
    RAISE EXCEPTION 'alert_key_required' USING ERRCODE = '23514';
  END IF;

  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'reason_required' USING ERRCODE = '23514';
  END IF;

  -- 3. Lock the target row before any authorization/transition check.
  SELECT * INTO v_row
  FROM public.inter_org_alert_states
  WHERE alert_key = p_alert_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'alert_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- 4. Only resolved/dismissed may be reopened through this RPC.
  IF v_row.status NOT IN ('resolved', 'dismissed') THEN
    RAISE EXCEPTION 'cannot_reopen_active_alert' USING ERRCODE = '23514';
  END IF;

  -- 5. Authorize: org scope + inter_institution_alerts.manage.
  v_role     := phoenix_my_role();
  v_my_org   := phoenix_my_org();
  v_is_super := (v_role = 'super_admin');

  IF NOT v_is_super
     AND v_row.source_organization_id <> v_my_org
     AND v_row.target_organization_id <> v_my_org THEN
    RAISE EXCEPTION 'forbidden_cross_org' USING ERRCODE = '42501';
  END IF;

  IF NOT v_is_super AND NOT phoenix_profile_has_permission(v_actor, 'inter_institution_alerts.manage') THEN
    RAISE EXCEPTION 'forbidden_inter_institution_alerts_manage' USING ERRCODE = '42501';
  END IF;

  -- 6. Resolve actor identity snapshot.
  SELECT p.full_name, u.email, p.role
    INTO v_actor_name, v_actor_email, v_actor_role
  FROM public.profiles p
  LEFT JOIN auth.users u ON u.id = p.id
  WHERE p.id = v_actor;

  -- 7. Atomic write: reopen the locked row (old resolved/dismissed
  --    timestamp+by columns are intentionally NOT touched), then append
  --    one immutable 'reopened' event.
  UPDATE public.inter_org_alert_states
     SET status     = 'open',
         reason     = p_reason,
         notes      = p_notes,
         updated_at = now()
   WHERE id = v_row.id;

  INSERT INTO public.inter_org_alert_events (
    alert_state_id, event_type, actor_id,
    actor_name_snapshot, actor_email_snapshot, actor_role_snapshot,
    from_status, to_status, reason, notes
  ) VALUES (
    v_row.id, 'reopened', v_actor,
    v_actor_name, v_actor_email, v_actor_role,
    v_row.status, 'open', p_reason, p_notes
  );

  RETURN jsonb_build_object(
    'ok', true,
    'alert_key', p_alert_key,
    'from_status', v_row.status,
    'to_status', 'open'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_reopen_inter_org_alert(text, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_reopen_inter_org_alert(text, text, text)
  TO authenticated;

-- =============================================================================
-- RPC 4: phoenix_get_inter_org_alert_events
-- =============================================================================
-- The sole controlled read path for inter_org_alert_events, which (per
-- migration 038's explicit direct-SELECT decision) has zero direct table
-- grants/policies for any client role. Returns event history ordered
-- newest-first, projecting out actor_id and alert_state_id (no internal ids
-- returned — only the display-oriented actor snapshot + transition fields).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.phoenix_get_inter_org_alert_events(
  p_alert_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_role     text;
  v_org      uuid;
  v_is_super boolean;
  v_can_view boolean;
  v_state    public.inter_org_alert_states%ROWTYPE;
  v_events   jsonb;
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
  --    (legacy, backward-compat only).
  v_can_view := v_is_super
    OR phoenix_profile_has_permission(v_actor, 'inter_institution_alerts.view')
    OR phoenix_profile_has_permission(v_actor, 'exchange_alerts.view');

  IF NOT v_can_view THEN
    RETURN jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  END IF;

  IF p_alert_key IS NULL OR btrim(p_alert_key) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ALERT_KEY_REQUIRED');
  END IF;

  -- 3. Fetch the parent state row to determine org scope.
  SELECT * INTO v_state
  FROM public.inter_org_alert_states
  WHERE alert_key = p_alert_key;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ALERT_NOT_FOUND');
  END IF;

  -- 4. Org scope: super_admin sees all; otherwise actor org must be the
  --    source or target org of this specific alert.
  IF NOT v_is_super
     AND v_state.source_organization_id <> v_org
     AND v_state.target_organization_id <> v_org THEN
    RETURN jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  END IF;

  -- 5. Read events (no direct table grant exists — this SECURITY DEFINER
  --    function bypasses RLS/grants internally, the only sanctioned path).
  SELECT jsonb_agg(
    jsonb_build_object(
      'event_type', e.event_type,
      'actor_name_snapshot', e.actor_name_snapshot,
      'actor_email_snapshot', e.actor_email_snapshot,
      'actor_role_snapshot', e.actor_role_snapshot,
      'from_status', e.from_status,
      'to_status', e.to_status,
      'reason', e.reason,
      'notes', e.notes,
      'created_at', e.created_at
    )
    ORDER BY e.created_at DESC
  )
  INTO v_events
  FROM public.inter_org_alert_events e
  WHERE e.alert_state_id = v_state.id;

  RETURN jsonb_build_object(
    'ok', true,
    'alert_key', p_alert_key,
    'events', coalesce(v_events, '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_get_inter_org_alert_events(text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_get_inter_org_alert_events(text)
  TO authenticated;

-- =============================================================================
-- VERIFY
-- =============================================================================

DO $$
DECLARE
  v_fn_src text;
BEGIN
  -- A. All four functions exist.
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_get_live_inter_institution_alerts_with_state'),
    'VERIFY FAILED: phoenix_get_live_inter_institution_alerts_with_state not found';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_update_inter_org_alert_state'),
    'VERIFY FAILED: phoenix_update_inter_org_alert_state not found';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_reopen_inter_org_alert'),
    'VERIFY FAILED: phoenix_reopen_inter_org_alert not found';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_get_inter_org_alert_events'),
    'VERIFY FAILED: phoenix_get_inter_org_alert_events not found';

  -- B. SECURITY DEFINER + search_path on all four.
  SELECT pg_get_functiondef(oid) INTO v_fn_src FROM pg_proc WHERE proname = 'phoenix_get_live_inter_institution_alerts_with_state';
  ASSERT v_fn_src LIKE '%SECURITY DEFINER%' AND v_fn_src LIKE '%SET search_path%',
    'VERIFY FAILED: phoenix_get_live_inter_institution_alerts_with_state missing SECURITY DEFINER/search_path';
  ASSERT v_fn_src LIKE '%source_item_availability_id%' AND v_fn_src LIKE '%target_item_availability_id%',
    'VERIFY FAILED: get_with_state does not use source/target_item_availability_id';
  ASSERT v_fn_src LIKE '%alert_key%',
    'VERIFY FAILED: get_with_state does not derive alert_key';
  ASSERT v_fn_src LIKE '%ON CONFLICT (alert_key) DO UPDATE%',
    'VERIFY FAILED: get_with_state does not upsert inter_org_alert_states by alert_key';
  ASSERT v_fn_src LIKE '%''opened''%',
    'VERIFY FAILED: get_with_state does not append an opened event for new alerts';
  ASSERT v_fn_src NOT LIKE '%supply_type%',
    'VERIFY FAILED: supply_type must never appear in get_with_state';

  SELECT pg_get_functiondef(oid) INTO v_fn_src FROM pg_proc WHERE proname = 'phoenix_update_inter_org_alert_state';
  ASSERT v_fn_src LIKE '%SECURITY DEFINER%' AND v_fn_src LIKE '%SET search_path%',
    'VERIFY FAILED: phoenix_update_inter_org_alert_state missing SECURITY DEFINER/search_path';
  ASSERT v_fn_src LIKE '%FOR UPDATE%',
    'VERIFY FAILED: phoenix_update_inter_org_alert_state does not lock the row with FOR UPDATE';
  ASSERT v_fn_src LIKE '%invalid_transition%',
    'VERIFY FAILED: phoenix_update_inter_org_alert_state missing invalid_transition guard';
  ASSERT v_fn_src LIKE '%reason_required%',
    'VERIFY FAILED: phoenix_update_inter_org_alert_state missing reason_required guard';
  ASSERT v_fn_src LIKE '%inter_institution_alerts.acknowledge%'
     AND v_fn_src LIKE '%inter_institution_alerts.manage%'
     AND v_fn_src LIKE '%inter_institution_alerts.resolve%'
     AND v_fn_src LIKE '%inter_institution_alerts.dismiss%',
    'VERIFY FAILED: phoenix_update_inter_org_alert_state does not check all four permission keys';

  SELECT pg_get_functiondef(oid) INTO v_fn_src FROM pg_proc WHERE proname = 'phoenix_reopen_inter_org_alert';
  ASSERT v_fn_src LIKE '%SECURITY DEFINER%' AND v_fn_src LIKE '%SET search_path%',
    'VERIFY FAILED: phoenix_reopen_inter_org_alert missing SECURITY DEFINER/search_path';
  ASSERT v_fn_src LIKE '%FOR UPDATE%',
    'VERIFY FAILED: phoenix_reopen_inter_org_alert does not lock the row with FOR UPDATE';
  ASSERT v_fn_src LIKE '%cannot_reopen_active_alert%',
    'VERIFY FAILED: phoenix_reopen_inter_org_alert missing active-alert guard';
  ASSERT v_fn_src LIKE '%reason_required%',
    'VERIFY FAILED: phoenix_reopen_inter_org_alert missing reason_required guard';
  ASSERT v_fn_src LIKE '%inter_institution_alerts.manage%',
    'VERIFY FAILED: phoenix_reopen_inter_org_alert does not check inter_institution_alerts.manage';

  SELECT pg_get_functiondef(oid) INTO v_fn_src FROM pg_proc WHERE proname = 'phoenix_get_inter_org_alert_events';
  ASSERT v_fn_src LIKE '%SECURITY DEFINER%' AND v_fn_src LIKE '%SET search_path%',
    'VERIFY FAILED: phoenix_get_inter_org_alert_events missing SECURITY DEFINER/search_path';
  ASSERT v_fn_src LIKE '%inter_org_alert_events%',
    'VERIFY FAILED: phoenix_get_inter_org_alert_events does not read inter_org_alert_events';

  -- C. Grants: authenticated only, anon/PUBLIC excluded, on all four.
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

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public' AND routine_name = 'phoenix_update_inter_org_alert_state'
      AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
  ), 'VERIFY FAILED: authenticated missing EXECUTE on phoenix_update_inter_org_alert_state';
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public' AND routine_name = 'phoenix_update_inter_org_alert_state'
      AND grantee IN ('anon', 'PUBLIC')
  ), 'VERIFY FAILED: anon/PUBLIC has EXECUTE on phoenix_update_inter_org_alert_state';

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public' AND routine_name = 'phoenix_reopen_inter_org_alert'
      AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
  ), 'VERIFY FAILED: authenticated missing EXECUTE on phoenix_reopen_inter_org_alert';
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public' AND routine_name = 'phoenix_reopen_inter_org_alert'
      AND grantee IN ('anon', 'PUBLIC')
  ), 'VERIFY FAILED: anon/PUBLIC has EXECUTE on phoenix_reopen_inter_org_alert';

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public' AND routine_name = 'phoenix_get_inter_org_alert_events'
      AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
  ), 'VERIFY FAILED: authenticated missing EXECUTE on phoenix_get_inter_org_alert_events';
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public' AND routine_name = 'phoenix_get_inter_org_alert_events'
      AND grantee IN ('anon', 'PUBLIC')
  ), 'VERIFY FAILED: anon/PUBLIC has EXECUTE on phoenix_get_inter_org_alert_events';

  -- D. No new direct table grant was added on either lifecycle table beyond
  --    what migration 038 already established.
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'inter_org_alert_events'
      AND grantee = 'authenticated' AND privilege_type = 'SELECT'
  ), 'VERIFY FAILED: authenticated must still not have direct SELECT on inter_org_alert_events';
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name IN ('inter_org_alert_states','inter_org_alert_events')
      AND grantee = 'authenticated' AND privilege_type IN ('INSERT','UPDATE','DELETE')
  ), 'VERIFY FAILED: authenticated must still not have INSERT/UPDATE/DELETE on either lifecycle table';

  -- E. Untouched: existing RPCs/tables still present.
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_get_live_inter_institution_alerts'),
    'VERIFY FAILED: phoenix_get_live_inter_institution_alerts is missing (must not be touched)';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_apply_availability_movement'),
    'VERIFY FAILED: phoenix_apply_availability_movement is missing (must not be touched)';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_upsert_availability'),
    'VERIFY FAILED: phoenix_upsert_availability is missing (must not be touched)';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'get_public_qr_payload'),
    'VERIFY FAILED: get_public_qr_payload is missing (must not be touched)';
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'inter_org_alert_states'
  ), 'VERIFY FAILED: inter_org_alert_states is missing (must not be touched)';
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'inter_org_alert_events'
  ), 'VERIFY FAILED: inter_org_alert_events is missing (must not be touched)';

  RAISE NOTICE '039 OK: 4 inter-org alert lifecycle RPCs created (get_live_inter_institution_alerts_with_state, update_inter_org_alert_state, reopen_inter_org_alert, get_inter_org_alert_events) — SECURITY DEFINER, authenticated-only, no new table grants, no existing RPC/table touched.';
END $$;

-- =============================================================================
-- END OF MIGRATION 039
--
-- Post-apply manual verification (run in Supabase SQL Editor):
--
-- 1. As an authenticated user holding inter_institution_alerts.view:
--    SELECT phoenix_get_live_inter_institution_alerts_with_state(50);
--    -- expect { ok: true, alerts: [...], computed_at: ... }, each alert
--    -- object including alert_key + lifecycle_status='open' the first time.
--    -- Re-run the same call: lifecycle_status should remain 'open' and
--    -- last_seen_at should advance; no duplicate inter_org_alert_states row
--    -- is created (confirm via: SELECT count(*) FROM inter_org_alert_states
--    -- WHERE alert_key = '<key from step 1>'; -- expect 1).
--
-- 2. As a user holding inter_institution_alerts.acknowledge for the alert's
--    source or target org:
--    SELECT phoenix_update_inter_org_alert_state('<alert_key>', 'acknowledged', null, 'ack test');
--    -- expect { ok: true, alert_key, from_status: 'open', to_status: 'acknowledged' }
--
-- 3. Confirm an invalid transition is rejected:
--    SELECT phoenix_update_inter_org_alert_state('<alert_key>', 'resolved', 'x', null);
--    -- expect: ERROR invalid_transition (acknowledged -> resolved is not allowed)
--
-- 4. Confirm dismiss without a reason is rejected:
--    SELECT phoenix_update_inter_org_alert_state('<alert_key>', 'dismissed', null, null);
--    -- expect: ERROR reason_required
--
-- 5. Confirm cross-org denial (as a non-super user with neither org matching):
--    -- expect: ERROR forbidden_cross_org
--
-- 6. Reopen a resolved/dismissed alert:
--    SELECT phoenix_reopen_inter_org_alert('<alert_key>', 'issue recurred', null);
--    -- expect { ok: true, alert_key, from_status: 'dismissed'|'resolved', to_status: 'open' }
--
-- 7. Confirm event history:
--    SELECT phoenix_get_inter_org_alert_events('<alert_key>');
--    -- expect { ok: true, alert_key, events: [...] } newest-first, including
--    -- the 'opened', 'acknowledged', 'dismissed'/'resolved', 'reopened' rows
--    -- created by the steps above.
--
-- 8. Confirm no direct table access still works as expected (should still
--    fail/return zero rows, since only the RPCs above may read/write):
--    SELECT * FROM inter_org_alert_events LIMIT 1; -- as authenticated, expect 0 rows (no policy)
-- =============================================================================
