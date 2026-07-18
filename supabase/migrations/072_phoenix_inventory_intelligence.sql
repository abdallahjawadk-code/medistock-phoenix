-- ============================================================================
-- INVENTORY-INTELLIGENCE-072-A  (Review Round 2)
--
-- MANUAL APPLY ONLY. DO NOT use supabase db push or any automated runner.
--
-- VERIFICATION STATUS: authored, not applied, not executed against a
-- disposable PostgreSQL database. Validation used static analysis and the
-- test suite only (matching 044-071's own convention). Apply to a
-- staging/preview database and confirm every post-condition passes BEFORE
-- this is treated as ready for production. Round 2 hardening below; still a
-- pre-live-apply authoring pass.
--
-- STRATEGY: Expand -> Frontend Migration -> Contract. This is an EXPAND step.
-- Additive by construction: no DROP/RENAME/REVOKE against any pre-existing
-- object, no ALTER of any 001-071 table, no row rewritten.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS ADDS — READ-ONLY INVENTORY INTELLIGENCE OVER EXISTING STOCK
-- ─────────────────────────────────────────────────────────────────────────────
-- A read-only intelligence layer over warehouse_stock (060/065) and
-- outlet_stock (067). It classifies stock into signals, orders batches FEFO,
-- raises deduplicated in-app alerts with an episode-aware lifecycle, and
-- suggests FEASIBLE, NON-OVERSUBSCRIBING surplus->shortage transfers WITHOUT
-- executing them. It moves no stock and is frugal (no images, no snapshots,
-- no cron, no WhatsApp).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ROUND-2 CORRECTNESS BOUNDARIES (why this file looks the way it does)
-- ─────────────────────────────────────────────────────────────────────────────
--  1. FAIL CLOSED. scope_kind is ONLY 'warehouse' or 'outlet' — there is no
--     ELSE branch that treats an unknown value as an outlet. Every scope_id is
--     validated to EXIST, MATCH its kind, and BELONG to organization_id, and
--     every permission check is made against that EXACT scope, never (org,
--     NULL, NULL).
--  2. EXPECTATION-DRIVEN 'missing'. A material is "missing" only where a
--     scope-specific threshold EXPECTS it (reorder_point > 0) and stock is
--     absent/zero. A material with no threshold at a scope is NOT_STOCKED — it
--     never raises an alert. Signals join thresholds LEFT-to-stock, not the
--     reverse.
--  3. NO CARTESIAN OVERSUBSCRIPTION. Suggestions are produced by a
--     deterministic, priority + FEFO ordered allocation loop that tracks
--     remaining source headroom and remaining target deficit, so the sum of a
--     source's suggestions never exceeds its surplus and the sum arriving at a
--     target never exceeds its deficit. Only FEASIBLE routes are suggested:
--       warehouse<->outlet  ONLY via distribution_points.warehouse_id
--       central->institution ONLY via warehouse_supply_routes (066)
--     Cross-organization surplus/shortage handling REUSES the 036-041 inter-org
--     alert/exchange system rather than duplicating it (see below).
--  4. CROSS-ORG SUPPORT. A suggestion pins BOTH source_organization_id and
--     target_organization_id. RLS shows a suggestion only to the source org,
--     the target org, or super_admin — never a third organization. A
--     cross-organization suggestion (source_org <> target_org) can be generated
--     ONLY by super_admin; an ordinary user cannot mint suggestions off other
--     organizations' balances.
--  5. FEFO returns EXACTLY ONE batch: the earliest-expiry, still-usable batch,
--     excluding expired, zero-available, and quarantined stock (quarantine
--     lives in warehouse_quarantine_stock (069), a separate table the live
--     stock tables never include).
--  6. EPISODE-AWARE LIFECYCLE. Alerts carry occurrence_count + cleared_at. When
--     a condition clears it is marked cleared_at (and auto-resolved if it was
--     active). A later recurrence opens a NEW episode (occurrence_count++,
--     cleared_at reset) even if a human had dismissed/resolved the prior one —
--     a dismissal never hides a future, distinct recurrence forever.
--  7. MANUAL PURGE. phoenix_purge_inventory_terminal deletes only TERMINAL rows
--     older than an explicit retention (>= 30 days), scoped + permissioned, no
--     cron, and NEVER deletes an audit_logs row.
--  8. AUDIT. Every HUMAN action (threshold upsert, acknowledge, resolve,
--     dismiss, accept, reject, purge) writes an audit_logs row.
--  9. SPLIT PERMISSIONS. Threshold writes need inventory.manage_thresholds;
--     generating suggestions needs inventory.suggest_transfers; acting on one
--     (accept/reject) needs inventory.act_on_suggestions; purge needs
--     inventory.purge. Alert triage keeps inventory.manage_alerts; reading
--     keeps inventory.view_signals; recompute keeps inventory.recompute.
-- 10. EXPIRY TIERS kept from 048: expired / critical_3m / warning_6m / watch_9m,
--     with DIFFERENT severities (high / high / medium / low) — not one flat
--     270-day bucket.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS MIGRATION DELIBERATELY DOES **NOT** DO
-- ─────────────────────────────────────────────────────────────────────────────
--   * No DROP/RENAME/REVOKE against any pre-existing object; no ALTER of any
--     001-071 table; no row rewritten; no widened CHECK on existing constraints.
--   * No stock movement / dispatch / transfer execution — accept is advisory
--     intent ONLY (proven by §15).
--   * No parallel cross-org exchange engine — 036-041 remains the inter-org path.
--   * No RBAC enforcement change. Enforcement stays OFF; scope enforcement
--     (phoenix_profile_has_scoped_permission) stays ON, as always.
--   * No cron / pg_cron / scheduled job; no images/blobs; no WhatsApp.
--   * No data backfill and no demo/test rows in the new tables.
--   * No frontend in this PR — DB layer only. NOT APPLIED. Authored for audit.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 0. PRECONDITIONS
-- ============================================================================
DO $$
BEGIN
  IF to_regclass('public.warehouse_stock') IS NULL
     OR to_regclass('public.outlet_stock') IS NULL THEN
    RAISE EXCEPTION 'ABORT 072: expected 065/067 stock tables are absent. Apply earlier migrations first.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'warehouse_stock' AND column_name = 'available_quantity'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'outlet_stock' AND column_name = 'available_quantity'
  ) THEN
    RAISE EXCEPTION 'ABORT 072: expected stock columns (available_quantity) are absent.';
  END IF;

  IF to_regprocedure('public.phoenix_profile_has_scoped_permission(uuid,text,uuid,uuid,uuid)') IS NULL
     OR to_regprocedure('public.phoenix_my_role()') IS NULL THEN
    RAISE EXCEPTION 'ABORT 072: 002/062 authz helper RPCs are absent.';
  END IF;

  -- Feasibility infrastructure this file reads (never writes).
  IF to_regclass('public.warehouse_supply_routes') IS NULL THEN
    RAISE EXCEPTION 'ABORT 072: 066 warehouse_supply_routes is absent (feasibility source).';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'distribution_points' AND column_name = 'warehouse_id'
  ) THEN
    RAISE EXCEPTION 'ABORT 072: distribution_points.warehouse_id (warehouse<->outlet link) is absent.';
  END IF;

  IF to_regclass('public.permission_keys') IS NULL
     OR to_regclass('public.role_permission_defaults') IS NULL
     OR to_regclass('public.audit_logs') IS NULL THEN
    RAISE EXCEPTION 'ABORT 072: 001/062 catalog/audit tables are absent.';
  END IF;

  RAISE NOTICE '072 preconditions OK.';
END $$;

-- ============================================================================
-- 1. THRESHOLD CONFIG (also the EXPECTATION source for 'missing')
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.inventory_signal_thresholds (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  scope_kind         text NOT NULL,
  scope_id           uuid,                       -- NULL = org-wide default values (never an expectation)
  scientific_name    text NOT NULL,
  national_code      text,
  reorder_point      integer,                    -- available <= this (and > 0) => low_stock; expectation => missing
  target_max         integer,                    -- available >  this           => surplus
  near_expiry_days   integer,                    -- reserved override; tiers (048) are the default
  is_active          boolean NOT NULL DEFAULT true,
  created_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT inventory_thresholds_scope_kind_chk
    CHECK (scope_kind IN ('warehouse', 'outlet')),
  CONSTRAINT inventory_thresholds_sci_name_chk
    CHECK (btrim(scientific_name) = scientific_name AND scientific_name <> ''),
  CONSTRAINT inventory_thresholds_national_code_chk
    CHECK (national_code IS NULL OR (btrim(national_code) = national_code AND national_code <> '')),
  CONSTRAINT inventory_thresholds_reorder_point_chk
    CHECK (reorder_point IS NULL OR reorder_point >= 0),
  CONSTRAINT inventory_thresholds_target_max_chk
    CHECK (target_max IS NULL OR target_max >= 0),
  CONSTRAINT inventory_thresholds_band_chk
    CHECK (reorder_point IS NULL OR target_max IS NULL OR target_max >= reorder_point),
  CONSTRAINT inventory_thresholds_near_expiry_days_chk
    CHECK (near_expiry_days IS NULL OR near_expiry_days > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS inventory_thresholds_identity_uniq
  ON public.inventory_signal_thresholds (
    organization_id, scope_kind,
    COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(scientific_name), COALESCE(national_code, '')
  );
CREATE INDEX IF NOT EXISTS inventory_thresholds_org_idx
  ON public.inventory_signal_thresholds (organization_id, scope_kind);

-- ============================================================================
-- 2. INVENTORY ALERTS — dedup + episode-aware lifecycle + expiry tiers
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.inventory_alerts (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  scope_kind               text NOT NULL,
  scope_id                 uuid NOT NULL,
  signal_type              text NOT NULL,
  severity                 text NOT NULL,
  expiry_tier              text,                  -- 048 vocabulary for date signals

  scientific_name          text NOT NULL,
  national_code            text,
  batch_number             text,
  expiry_date              date,

  observed_on_hand         integer,
  observed_available       integer,
  threshold_reorder_point  integer,
  threshold_target_max     integer,
  near_expiry_days         integer,
  days_to_expiry           integer,

  alert_key                text NOT NULL,
  status                   text NOT NULL DEFAULT 'open',
  reason                   text,
  auto_resolved            boolean NOT NULL DEFAULT false,

  -- Episode tracking (round-2 item 6).
  occurrence_count         integer NOT NULL DEFAULT 1,
  cleared_at               timestamptz,

  acknowledged_at          timestamptz,
  acknowledged_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at              timestamptz,
  resolved_by              uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  dismissed_at             timestamptz,
  dismissed_by             uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  first_observed_at        timestamptz NOT NULL DEFAULT now(),
  last_observed_at         timestamptz NOT NULL DEFAULT now(),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT inventory_alerts_scope_kind_chk
    CHECK (scope_kind IN ('warehouse', 'outlet')),
  CONSTRAINT inventory_alerts_signal_type_chk
    CHECK (signal_type IN ('missing', 'low_stock', 'surplus', 'near_expiry', 'expired')),
  CONSTRAINT inventory_alerts_severity_chk
    CHECK (severity IN ('high', 'medium', 'low')),
  CONSTRAINT inventory_alerts_expiry_tier_chk
    CHECK (expiry_tier IS NULL OR expiry_tier IN ('expired', 'critical_3m', 'warning_6m', 'watch_9m')),
  -- date signals carry a tier + expiry; quantity signals never do.
  CONSTRAINT inventory_alerts_tier_pairing_chk
    CHECK (
      (signal_type IN ('near_expiry', 'expired') AND expiry_tier IS NOT NULL AND expiry_date IS NOT NULL)
      OR (signal_type IN ('missing', 'low_stock', 'surplus')
          AND expiry_tier IS NULL AND batch_number IS NULL AND expiry_date IS NULL)
    ),
  CONSTRAINT inventory_alerts_status_chk
    CHECK (status IN ('open', 'acknowledged', 'in_progress', 'resolved', 'dismissed')),
  CONSTRAINT inventory_alerts_sci_name_chk
    CHECK (btrim(scientific_name) = scientific_name AND scientific_name <> ''),
  CONSTRAINT inventory_alerts_occurrence_chk
    CHECK (occurrence_count >= 1),
  CONSTRAINT inventory_alerts_resolve_reason_chk
    CHECK (status <> 'resolved' OR (reason IS NOT NULL AND btrim(reason) <> '')),
  CONSTRAINT inventory_alerts_dismiss_reason_chk
    CHECK (status <> 'dismissed' OR (reason IS NOT NULL AND btrim(reason) <> ''))
);

CREATE UNIQUE INDEX IF NOT EXISTS inventory_alerts_alert_key_uniq
  ON public.inventory_alerts (alert_key);
CREATE INDEX IF NOT EXISTS inventory_alerts_org_scope_status_idx
  ON public.inventory_alerts (organization_id, scope_kind, scope_id, status);

-- ============================================================================
-- 3. TRANSFER SUGGESTIONS — advisory, feasible-route, cross-org aware
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.inventory_transfer_suggestions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Both organizations are pinned. Equal for intra-org; different for cross-org.
  source_organization_id    uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  target_organization_id    uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  scientific_name           text NOT NULL,
  national_code             text,

  source_scope_kind         text NOT NULL,
  source_scope_id           uuid NOT NULL,
  target_scope_kind         text NOT NULL,
  target_scope_id           uuid NOT NULL,

  -- The only feasible physical corridors this file will ever suggest.
  route_kind                text NOT NULL,

  suggested_quantity        integer NOT NULL,
  fefo_batch_number         text,
  fefo_expiry_date          date,

  source_surplus_snapshot   integer,
  target_shortfall_snapshot integer,
  rationale                 text,

  suggestion_key            text NOT NULL,
  status                    text NOT NULL DEFAULT 'open',
  reason                    text,

  accepted_at               timestamptz,
  accepted_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  rejected_at               timestamptz,
  rejected_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  first_suggested_at        timestamptz NOT NULL DEFAULT now(),
  last_suggested_at         timestamptz NOT NULL DEFAULT now(),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT inventory_suggestions_source_kind_chk
    CHECK (source_scope_kind IN ('warehouse', 'outlet')),
  CONSTRAINT inventory_suggestions_target_kind_chk
    CHECK (target_scope_kind IN ('warehouse', 'outlet')),
  CONSTRAINT inventory_suggestions_route_kind_chk
    CHECK (route_kind IN ('warehouse_to_outlet', 'outlet_to_warehouse', 'central_to_institution')),
  CONSTRAINT inventory_suggestions_sci_name_chk
    CHECK (btrim(scientific_name) = scientific_name AND scientific_name <> ''),
  CONSTRAINT inventory_suggestions_qty_chk
    CHECK (suggested_quantity > 0),
  CONSTRAINT inventory_suggestions_distinct_scope_chk
    CHECK (NOT (source_scope_kind = target_scope_kind AND source_scope_id = target_scope_id)),
  CONSTRAINT inventory_suggestions_status_chk
    CHECK (status IN ('open', 'accepted', 'rejected', 'superseded', 'expired')),
  CONSTRAINT inventory_suggestions_reject_reason_chk
    CHECK (status <> 'rejected' OR (reason IS NOT NULL AND btrim(reason) <> ''))
);

CREATE UNIQUE INDEX IF NOT EXISTS inventory_suggestions_key_uniq
  ON public.inventory_transfer_suggestions (suggestion_key);
CREATE INDEX IF NOT EXISTS inventory_suggestions_orgs_status_idx
  ON public.inventory_transfer_suggestions (source_organization_id, target_organization_id, status);

-- ============================================================================
-- 4. SCOPE VALIDATION — resolve the org that owns a (kind, scope), fail closed
-- ============================================================================
-- Returns the organization_id that owns the scope, or NULL if the scope does
-- not exist / kind mismatches. Callers treat NULL as a hard failure. There is
-- no ELSE that assumes 'outlet'.
CREATE OR REPLACE FUNCTION public.phoenix_inventory_scope_org(
  p_scope_kind text,
  p_scope_id   uuid
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_scope_kind = 'warehouse' THEN
      (SELECT w.organization_id FROM public.warehouses w WHERE w.id = p_scope_id)
    WHEN p_scope_kind = 'outlet' THEN
      (SELECT dp.organization_id FROM public.distribution_points dp WHERE dp.id = p_scope_id)
    ELSE NULL
  END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_inventory_scope_org(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_inventory_scope_org(text, uuid) TO authenticated;

-- ============================================================================
-- 5. READ GATE — scoped to the EXACT scope, fail closed
-- ============================================================================
CREATE OR REPLACE FUNCTION public.phoenix_can_read_inventory_signal(
  p_organization_id uuid,
  p_scope_kind      text,
  p_scope_id        uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    auth.uid() IS NOT NULL
    AND p_scope_kind IN ('warehouse', 'outlet')
    -- the scope must actually belong to the claimed organization
    AND public.phoenix_inventory_scope_org(p_scope_kind, p_scope_id) = p_organization_id
    AND (
      public.phoenix_my_role() = 'super_admin'
      OR (p_scope_kind = 'warehouse' AND public.phoenix_profile_has_scoped_permission(
            auth.uid(), 'inventory.view_signals', p_organization_id, p_scope_id, NULL))
      OR (p_scope_kind = 'outlet' AND public.phoenix_profile_has_scoped_permission(
            auth.uid(), 'inventory.view_signals', p_organization_id, NULL, p_scope_id))
    );
$$;

REVOKE ALL ON FUNCTION public.phoenix_can_read_inventory_signal(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_can_read_inventory_signal(uuid, text, uuid) TO authenticated;

-- ============================================================================
-- 6. FEFO PICK — exactly one batch, excludes expired / unavailable / quarantine
-- ============================================================================
-- Quarantine stock lives in warehouse_quarantine_stock (069), a table the live
-- warehouse_stock/outlet_stock never include — so reading only those tables is
-- already quarantine-free. Returns at most one row (LIMIT 1).
CREATE OR REPLACE FUNCTION public.phoenix_inventory_fefo_pick(
  p_organization_id uuid,
  p_scope_kind      text,
  p_scope_id        uuid,
  p_scientific_name text,
  p_national_code   text DEFAULT NULL
)
RETURNS TABLE (batch_number text, expiry_date date, available_quantity integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Fail closed: valid kind, scope belongs to org, and caller may read it.
  IF p_scope_kind NOT IN ('warehouse', 'outlet') THEN
    RAISE EXCEPTION 'invalid_scope_kind';
  END IF;
  IF public.phoenix_inventory_scope_org(p_scope_kind, p_scope_id) IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'scope_not_in_organization';
  END IF;
  IF NOT public.phoenix_can_read_inventory_signal(p_organization_id, p_scope_kind, p_scope_id) THEN
    RAISE EXCEPTION 'not_authorized_inventory_read';
  END IF;

  IF p_scope_kind = 'warehouse' THEN
    RETURN QUERY
      SELECT ws.batch_number, ws.expiry_date, ws.available_quantity
      FROM public.warehouse_stock ws
      WHERE ws.organization_id = p_organization_id
        AND ws.warehouse_id = p_scope_id
        AND lower(ws.scientific_name) = lower(p_scientific_name)
        AND (p_national_code IS NULL OR ws.national_code IS NOT DISTINCT FROM p_national_code)
        AND ws.available_quantity > 0
        AND (ws.expiry_date IS NULL OR ws.expiry_date >= current_date)
      ORDER BY ws.expiry_date ASC NULLS LAST, ws.available_quantity DESC, ws.id ASC
      LIMIT 1;
  ELSE
    RETURN QUERY
      SELECT os.batch_number, os.expiry_date, os.available_quantity
      FROM public.outlet_stock os
      WHERE os.organization_id = p_organization_id
        AND os.distribution_point_id = p_scope_id
        AND lower(os.scientific_name) = lower(p_scientific_name)
        AND (p_national_code IS NULL OR os.national_code IS NOT DISTINCT FROM p_national_code)
        AND os.available_quantity > 0
        AND (os.expiry_date IS NULL OR os.expiry_date >= current_date)
      ORDER BY os.expiry_date ASC NULLS LAST, os.available_quantity DESC, os.id ASC
      LIMIT 1;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_inventory_fefo_pick(uuid, text, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_inventory_fefo_pick(uuid, text, uuid, text, text) TO authenticated;

-- ============================================================================
-- 7. RECOMPUTE — expectation-driven, tiered, episode-aware. Fail closed.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.phoenix_recompute_inventory_alerts(
  p_organization_id uuid,
  p_scope_kind      text DEFAULT NULL,
  p_scope_id        uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_upserted integer := 0;
  v_cleared  integer := 0;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  -- Fail closed on scope.
  IF p_scope_kind IS NOT NULL AND p_scope_kind NOT IN ('warehouse', 'outlet') THEN
    RAISE EXCEPTION 'invalid_scope_kind';
  END IF;
  IF p_scope_id IS NOT NULL THEN
    IF p_scope_kind IS NULL THEN
      RAISE EXCEPTION 'scope_id_requires_scope_kind';
    END IF;
    IF public.phoenix_inventory_scope_org(p_scope_kind, p_scope_id) IS DISTINCT FROM p_organization_id THEN
      RAISE EXCEPTION 'scope_not_in_organization';
    END IF;
    -- permission on the EXACT scope requested
    IF NOT (
      public.phoenix_my_role() = 'super_admin'
      OR (p_scope_kind = 'warehouse' AND public.phoenix_profile_has_scoped_permission(
            v_actor, 'inventory.recompute', p_organization_id, p_scope_id, NULL))
      OR (p_scope_kind = 'outlet' AND public.phoenix_profile_has_scoped_permission(
            v_actor, 'inventory.recompute', p_organization_id, NULL, p_scope_id))
    ) THEN
      RAISE EXCEPTION 'not_authorized_inventory_recompute';
    END IF;
  ELSE
    -- org-wide recompute needs an org-level grant (or super_admin)
    IF NOT (
      public.phoenix_my_role() = 'super_admin'
      OR public.phoenix_profile_has_scoped_permission(
           v_actor, 'inventory.recompute', p_organization_id, NULL, NULL)
    ) THEN
      RAISE EXCEPTION 'not_authorized_inventory_recompute';
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('inv_recompute:' || p_organization_id::text, 0));

  -- Unified live stock for this org (optionally one scope).
  CREATE TEMP TABLE _stock ON COMMIT DROP AS
    SELECT 'warehouse'::text AS scope_kind, ws.warehouse_id AS scope_id,
           ws.scientific_name, ws.national_code, ws.batch_number,
           ws.expiry_date, ws.on_hand_quantity, ws.available_quantity
    FROM public.warehouse_stock ws
    WHERE ws.organization_id = p_organization_id
      AND (p_scope_kind IS NULL OR p_scope_kind = 'warehouse')
      AND (p_scope_id IS NULL OR ws.warehouse_id = p_scope_id)
    UNION ALL
    SELECT 'outlet'::text, os.distribution_point_id,
           os.scientific_name, os.national_code, os.batch_number,
           os.expiry_date, os.on_hand_quantity, os.available_quantity
    FROM public.outlet_stock os
    WHERE os.organization_id = p_organization_id
      AND (p_scope_kind IS NULL OR p_scope_kind = 'outlet')
      AND (p_scope_id IS NULL OR os.distribution_point_id = p_scope_id);

  -- Aggregate per (scope, material).
  CREATE TEMP TABLE _agg ON COMMIT DROP AS
    SELECT scope_kind, scope_id, scientific_name, national_code,
           SUM(on_hand_quantity)  AS on_hand,
           SUM(available_quantity) AS available
    FROM _stock
    GROUP BY scope_kind, scope_id, scientific_name, national_code;

  -- Active thresholds for this org; scope-specific rows are EXPECTATIONS.
  CREATE TEMP TABLE _thr ON COMMIT DROP AS
    SELECT t.scope_kind, t.scope_id, lower(t.scientific_name) AS sci_lower,
           t.national_code, t.reorder_point, t.target_max, t.near_expiry_days,
           (CASE WHEN t.scope_id IS NULL THEN 0 ELSE 1 END)
           + (CASE WHEN t.national_code IS NULL THEN 0 ELSE 1 END) AS specificity
    FROM public.inventory_signal_thresholds t
    WHERE t.organization_id = p_organization_id
      AND t.is_active
      AND (p_scope_kind IS NULL OR t.scope_kind = p_scope_kind);

  CREATE TEMP TABLE _now (
    alert_key   text PRIMARY KEY,
    scope_kind  text, scope_id uuid, signal_type text, severity text, expiry_tier text,
    sci_name text, national text, batch text, expiry date,
    on_hand integer, available integer, reorder integer, target_max integer, near_days integer, dte integer
  ) ON COMMIT DROP;

  -- ── Quantity signals: expectation-driven positions ──────────────────────
  -- A position = a scope-specific expectation (drives 'missing'), OR a stock
  -- position that resolves to a threshold (drives low_stock/surplus). A stock
  -- position with NO resolvable threshold is NOT_STOCKED and produces no row.
  CREATE TEMP TABLE _pos ON COMMIT DROP AS
    SELECT scope_kind, scope_id, sci_lower, national,
           MAX(sci_name)   AS sci_name,
           bool_or(expected) AS expected
    FROM (
      -- scope-specific expectations
      SELECT t.scope_kind, t.scope_id, t.sci_lower AS sci_lower,
             t.national_code AS national, t.sci_lower AS sci_name, true AS expected
      FROM _thr t
      WHERE t.scope_id IS NOT NULL
      UNION ALL
      -- stock positions (real-case identity carried through for display)
      SELECT g.scope_kind, g.scope_id, lower(g.scientific_name),
             g.national_code, g.scientific_name, false
      FROM _agg g
    ) u
    GROUP BY scope_kind, scope_id, sci_lower, national;

  INSERT INTO _now
  SELECT
    p_organization_id::text || '|' || pos.scope_kind || '|' || pos.scope_id::text || '|'
      || q.signal_type || '|' || pos.sci_lower || '|' || COALESCE(pos.national, '') || '||',
    pos.scope_kind, pos.scope_id, q.signal_type, q.severity, NULL,
    pos.sci_name, pos.national, NULL, NULL,
    COALESCE(a.on_hand, 0), COALESCE(a.available, 0), cfg.reorder_point, cfg.target_max, NULL, NULL
  FROM _pos pos
  CROSS JOIN LATERAL (
    -- resolve the effective threshold: most specific active row wins
    SELECT thr.reorder_point, thr.target_max
    FROM _thr thr
    WHERE thr.scope_kind = pos.scope_kind
      AND (thr.scope_id = pos.scope_id OR thr.scope_id IS NULL)
      AND thr.sci_lower = pos.sci_lower
      AND (thr.national_code = pos.national OR thr.national_code IS NULL)
    ORDER BY thr.specificity DESC
    LIMIT 1
  ) cfg
  LEFT JOIN _agg a
    ON a.scope_kind = pos.scope_kind AND a.scope_id = pos.scope_id
   AND lower(a.scientific_name) = pos.sci_lower
   AND a.national_code IS NOT DISTINCT FROM pos.national
  CROSS JOIN LATERAL (
    SELECT
      CASE
        WHEN pos.expected AND cfg.reorder_point IS NOT NULL AND cfg.reorder_point > 0
             AND COALESCE(a.on_hand, 0) = 0 THEN 'missing'
        WHEN cfg.reorder_point IS NOT NULL AND COALESCE(a.available, 0) > 0
             AND COALESCE(a.available, 0) <= cfg.reorder_point THEN 'low_stock'
        WHEN cfg.target_max IS NOT NULL AND COALESCE(a.available, 0) > cfg.target_max THEN 'surplus'
        ELSE NULL
      END AS signal_type,
      CASE
        WHEN pos.expected AND cfg.reorder_point IS NOT NULL AND cfg.reorder_point > 0
             AND COALESCE(a.on_hand, 0) = 0 THEN 'high'
        WHEN cfg.reorder_point IS NOT NULL AND COALESCE(a.available, 0) > 0
             AND COALESCE(a.available, 0) <= cfg.reorder_point THEN 'medium'
        ELSE 'low'
      END AS severity
  ) q
  WHERE q.signal_type IS NOT NULL
  ON CONFLICT (alert_key) DO NOTHING;

  -- ── Date signals: per-batch, tiered by 048 windows (item 10) ────────────
  INSERT INTO _now
  SELECT
    p_organization_id::text || '|' || s.scope_kind || '|' || s.scope_id::text || '|'
      || sig.signal_type || '|' || lower(s.scientific_name) || '|'
      || COALESCE(s.national_code, '') || '|' || COALESCE(s.batch_number, '') || '|'
      || COALESCE(s.expiry_date::text, ''),
    s.scope_kind, s.scope_id, sig.signal_type, sig.severity, sig.tier,
    s.scientific_name, s.national_code, s.batch_number, s.expiry_date,
    s.on_hand_quantity, s.available_quantity, NULL, NULL, NULL, (s.expiry_date - current_date)
  FROM _stock s
  CROSS JOIN LATERAL (
    SELECT
      CASE WHEN s.expiry_date < current_date THEN 'expired' ELSE 'near_expiry' END AS signal_type,
      CASE
        WHEN s.expiry_date < current_date                                          THEN 'expired'
        WHEN s.expiry_date <= (current_date + interval '3 months')::date           THEN 'critical_3m'
        WHEN s.expiry_date <= (current_date + interval '6 months')::date           THEN 'warning_6m'
        ELSE 'watch_9m'
      END AS tier,
      CASE
        WHEN s.expiry_date < current_date                                          THEN 'high'
        WHEN s.expiry_date <= (current_date + interval '3 months')::date           THEN 'high'
        WHEN s.expiry_date <= (current_date + interval '6 months')::date           THEN 'medium'
        ELSE 'low'
      END AS severity
  ) sig
  WHERE s.on_hand_quantity > 0
    AND s.expiry_date IS NOT NULL
    AND s.expiry_date <= (current_date + interval '9 months')::date
  ON CONFLICT (alert_key) DO NOTHING;

  -- ── Upsert violations with EPISODE semantics ────────────────────────────
  -- A recurrence whose prior row had cleared (cleared_at set) opens a NEW
  -- episode (occurrence_count++, cleared_at reset, status back to open) — even
  -- if a human had dismissed/resolved it. A still-uncleared human decision is
  -- respected (its status/timestamps are left intact) but last_observed bumps.
  INSERT INTO public.inventory_alerts AS al (
    organization_id, scope_kind, scope_id, signal_type, severity, expiry_tier,
    scientific_name, national_code, batch_number, expiry_date,
    observed_on_hand, observed_available, threshold_reorder_point,
    threshold_target_max, near_expiry_days, days_to_expiry,
    alert_key, status, first_observed_at, last_observed_at
  )
  SELECT
    p_organization_id, n.scope_kind, n.scope_id, n.signal_type, n.severity, n.expiry_tier,
    n.sci_name, n.national, n.batch, n.expiry,
    n.on_hand, n.available, n.reorder, n.target_max, n.near_days, n.dte,
    n.alert_key, 'open', now(), now()
  FROM _now n
  ON CONFLICT (alert_key) DO UPDATE SET
    severity                = EXCLUDED.severity,
    expiry_tier             = EXCLUDED.expiry_tier,
    observed_on_hand        = EXCLUDED.observed_on_hand,
    observed_available      = EXCLUDED.observed_available,
    threshold_reorder_point = EXCLUDED.threshold_reorder_point,
    threshold_target_max    = EXCLUDED.threshold_target_max,
    days_to_expiry          = EXCLUDED.days_to_expiry,
    last_observed_at        = now(),
    updated_at              = now(),
    occurrence_count        = al.occurrence_count + (CASE WHEN al.cleared_at IS NOT NULL THEN 1 ELSE 0 END),
    status                  = CASE WHEN al.cleared_at IS NOT NULL THEN 'open' ELSE al.status END,
    auto_resolved           = CASE WHEN al.cleared_at IS NOT NULL THEN false ELSE al.auto_resolved END,
    reason                  = CASE WHEN al.cleared_at IS NOT NULL THEN NULL ELSE al.reason END,
    resolved_at             = CASE WHEN al.cleared_at IS NOT NULL THEN NULL ELSE al.resolved_at END,
    resolved_by             = CASE WHEN al.cleared_at IS NOT NULL THEN NULL ELSE al.resolved_by END,
    dismissed_at            = CASE WHEN al.cleared_at IS NOT NULL THEN NULL ELSE al.dismissed_at END,
    dismissed_by            = CASE WHEN al.cleared_at IS NOT NULL THEN NULL ELSE al.dismissed_by END,
    first_observed_at       = CASE WHEN al.cleared_at IS NOT NULL THEN now() ELSE al.first_observed_at END,
    cleared_at              = NULL;

  GET DIAGNOSTICS v_upserted = ROW_COUNT;

  -- ── Clear detection: mark cleared_at on any alert in scope not now violating ─
  -- Active ones auto-resolve; terminal (human) ones just get cleared_at set so
  -- a future recurrence can safely reopen a fresh episode. cleared_at is only
  -- set once per clear (guarded by cleared_at IS NULL).
  UPDATE public.inventory_alerts a
  SET status        = CASE WHEN a.status IN ('open','acknowledged','in_progress') THEN 'resolved' ELSE a.status END,
      auto_resolved = CASE WHEN a.status IN ('open','acknowledged','in_progress') THEN true ELSE a.auto_resolved END,
      reason        = CASE WHEN a.status IN ('open','acknowledged','in_progress')
                             THEN 'auto: condition no longer present at recompute' ELSE a.reason END,
      resolved_at   = CASE WHEN a.status IN ('open','acknowledged','in_progress') THEN now() ELSE a.resolved_at END,
      cleared_at    = now(),
      updated_at    = now()
  WHERE a.organization_id = p_organization_id
    AND (p_scope_kind IS NULL OR a.scope_kind = p_scope_kind)
    AND (p_scope_id IS NULL OR a.scope_id = p_scope_id)
    AND a.cleared_at IS NULL
    -- Every not-currently-violating alert in scope gets cleared_at stamped,
    -- INCLUDING dismissed/manually-resolved ones, so a future recurrence opens a
    -- fresh episode. Only active ones additionally flip to auto-resolved (above).
    AND NOT EXISTS (SELECT 1 FROM _now n WHERE n.alert_key = a.alert_key);

  GET DIAGNOSTICS v_cleared = ROW_COUNT;

  RETURN jsonb_build_object(
    'organization_id', p_organization_id,
    'scope_kind', p_scope_kind, 'scope_id', p_scope_id,
    'violations', (SELECT count(*) FROM _now),
    'upserted', v_upserted,
    'cleared', v_cleared
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_recompute_inventory_alerts(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_recompute_inventory_alerts(uuid, text, uuid) TO authenticated;

-- ============================================================================
-- 8. ALERT LIFECYCLE — acknowledge / resolve / dismiss (IDOR-gated + audited)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.phoenix_acknowledge_inventory_alert(p_alert_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_actor uuid := auth.uid(); v_a public.inventory_alerts%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  SELECT * INTO v_a FROM public.inventory_alerts WHERE id = p_alert_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'alert_not_found'; END IF;
  IF NOT (
    public.phoenix_my_role() = 'super_admin'
    OR (v_a.scope_kind = 'warehouse' AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'inventory.manage_alerts', v_a.organization_id, v_a.scope_id, NULL))
    OR (v_a.scope_kind = 'outlet' AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'inventory.manage_alerts', v_a.organization_id, NULL, v_a.scope_id))
  ) THEN RAISE EXCEPTION 'not_authorized_inventory_manage'; END IF;
  IF v_a.status <> 'open' THEN RAISE EXCEPTION 'alert_not_open'; END IF;

  UPDATE public.inventory_alerts
  SET status = 'acknowledged', acknowledged_at = now(), acknowledged_by = v_actor, updated_at = now()
  WHERE id = p_alert_id;

  INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (v_a.organization_id, v_actor, public.phoenix_my_role(), 'update', 'inventory_alert', p_alert_id,
          v_a.signal_type || ':' || v_a.scientific_name,
          jsonb_build_object('lifecycle', 'acknowledge', 'from', v_a.status));

  RETURN jsonb_build_object('id', p_alert_id, 'status', 'acknowledged');
END;
$$;

CREATE OR REPLACE FUNCTION public.phoenix_resolve_inventory_alert(p_alert_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_actor uuid := auth.uid(); v_reason text := NULLIF(btrim(p_reason), ''); v_a public.inventory_alerts%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF v_reason IS NULL THEN RAISE EXCEPTION 'resolve_reason_required'; END IF;
  SELECT * INTO v_a FROM public.inventory_alerts WHERE id = p_alert_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'alert_not_found'; END IF;
  IF NOT (
    public.phoenix_my_role() = 'super_admin'
    OR (v_a.scope_kind = 'warehouse' AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'inventory.manage_alerts', v_a.organization_id, v_a.scope_id, NULL))
    OR (v_a.scope_kind = 'outlet' AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'inventory.manage_alerts', v_a.organization_id, NULL, v_a.scope_id))
  ) THEN RAISE EXCEPTION 'not_authorized_inventory_manage'; END IF;
  IF v_a.status IN ('resolved', 'dismissed') THEN RAISE EXCEPTION 'alert_already_terminal'; END IF;

  UPDATE public.inventory_alerts
  SET status = 'resolved', auto_resolved = false, reason = v_reason,
      resolved_at = now(), resolved_by = v_actor, updated_at = now()
  WHERE id = p_alert_id;

  INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (v_a.organization_id, v_actor, public.phoenix_my_role(), 'update', 'inventory_alert', p_alert_id,
          v_a.signal_type || ':' || v_a.scientific_name,
          jsonb_build_object('lifecycle', 'resolve', 'reason', v_reason));

  RETURN jsonb_build_object('id', p_alert_id, 'status', 'resolved');
END;
$$;

CREATE OR REPLACE FUNCTION public.phoenix_dismiss_inventory_alert(p_alert_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_actor uuid := auth.uid(); v_reason text := NULLIF(btrim(p_reason), ''); v_a public.inventory_alerts%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF v_reason IS NULL THEN RAISE EXCEPTION 'dismiss_reason_required'; END IF;
  SELECT * INTO v_a FROM public.inventory_alerts WHERE id = p_alert_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'alert_not_found'; END IF;
  IF NOT (
    public.phoenix_my_role() = 'super_admin'
    OR (v_a.scope_kind = 'warehouse' AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'inventory.manage_alerts', v_a.organization_id, v_a.scope_id, NULL))
    OR (v_a.scope_kind = 'outlet' AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'inventory.manage_alerts', v_a.organization_id, NULL, v_a.scope_id))
  ) THEN RAISE EXCEPTION 'not_authorized_inventory_manage'; END IF;
  IF v_a.status IN ('resolved', 'dismissed') THEN RAISE EXCEPTION 'alert_already_terminal'; END IF;

  UPDATE public.inventory_alerts
  SET status = 'dismissed', reason = v_reason, dismissed_at = now(), dismissed_by = v_actor, updated_at = now()
  WHERE id = p_alert_id;

  INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (v_a.organization_id, v_actor, public.phoenix_my_role(), 'update', 'inventory_alert', p_alert_id,
          v_a.signal_type || ':' || v_a.scientific_name,
          jsonb_build_object('lifecycle', 'dismiss', 'reason', v_reason));

  RETURN jsonb_build_object('id', p_alert_id, 'status', 'dismissed');
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_acknowledge_inventory_alert(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_acknowledge_inventory_alert(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.phoenix_resolve_inventory_alert(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_resolve_inventory_alert(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.phoenix_dismiss_inventory_alert(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_dismiss_inventory_alert(uuid, text) TO authenticated;

-- ============================================================================
-- 9. SUGGEST — feasible routes, deterministic non-oversubscribing allocation
-- ============================================================================
-- INTRA-ORG ONLY here. Cross-organization surplus/shortage stays the job of the
-- 036-041 inter-org alert/exchange system; a separate super_admin server path
-- (phoenix_suggest_cross_org_inventory_transfer, §10) mints cross-org rows.
-- Allocation is a deterministic loop: needs and sources are ordered by severity
-- then FEFO/id; each need pulls from feasible sources, decrementing a running
-- source-headroom table, so no source is oversubscribed and no target receives
-- more than its deficit. INSERTS ONLY into inventory_transfer_suggestions.
CREATE OR REPLACE FUNCTION public.phoenix_suggest_inventory_transfers(p_organization_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_need     record;
  v_src      record;
  v_take     integer;
  v_remaining integer;
  v_upserted integer := 0;
  v_fefo_batch text;
  v_fefo_expiry date;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT (
    public.phoenix_my_role() = 'super_admin'
    OR public.phoenix_profile_has_scoped_permission(v_actor, 'inventory.suggest_transfers', p_organization_id, NULL, NULL)
  ) THEN RAISE EXCEPTION 'not_authorized_inventory_suggest'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('inv_suggest:' || p_organization_id::text, 0));

  -- Needs: open/active missing+low_stock alerts, with a positive deficit.
  CREATE TEMP TABLE _need ON COMMIT DROP AS
    SELECT a.id AS alert_id, a.scope_kind, a.scope_id, a.scientific_name, a.national_code,
           GREATEST(COALESCE(a.threshold_reorder_point, 0) - COALESCE(a.observed_available, 0), 1) AS deficit,
           GREATEST(COALESCE(a.threshold_reorder_point, 0) - COALESCE(a.observed_available, 0), 1) AS remaining,
           CASE a.severity WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END AS prio
    FROM public.inventory_alerts a
    WHERE a.organization_id = p_organization_id
      AND a.status IN ('open', 'acknowledged', 'in_progress')
      AND a.signal_type IN ('missing', 'low_stock');

  -- Sources: open/active surplus alerts, with positive headroom (mutable remaining).
  CREATE TEMP TABLE _src ON COMMIT DROP AS
    SELECT a.id AS alert_id, a.scope_kind, a.scope_id, a.scientific_name, a.national_code,
           GREATEST(COALESCE(a.observed_available, 0) - COALESCE(a.threshold_target_max, 0), 0) AS headroom,
           GREATEST(COALESCE(a.observed_available, 0) - COALESCE(a.threshold_target_max, 0), 0) AS remaining
    FROM public.inventory_alerts a
    WHERE a.organization_id = p_organization_id
      AND a.status IN ('open', 'acknowledged', 'in_progress')
      AND a.signal_type = 'surplus';

  CREATE TEMP TABLE _live_keys (suggestion_key text PRIMARY KEY) ON COMMIT DROP;

  -- Deterministic allocation loop.
  FOR v_need IN
    SELECT * FROM _need ORDER BY prio DESC, scientific_name, scope_id, alert_id
  LOOP
    v_remaining := v_need.remaining;

    FOR v_src IN
      SELECT s.*,
             CASE
               -- warehouse -> outlet: the outlet's parent warehouse is the source
               WHEN s.scope_kind = 'warehouse' AND v_need.scope_kind = 'outlet'
                    AND EXISTS (SELECT 1 FROM public.distribution_points dp
                                 WHERE dp.id = v_need.scope_id AND dp.warehouse_id = s.scope_id
                                   AND dp.organization_id = p_organization_id)
                 THEN 'warehouse_to_outlet'
               -- outlet -> warehouse: the outlet returns up to its own parent warehouse
               WHEN s.scope_kind = 'outlet' AND v_need.scope_kind = 'warehouse'
                    AND EXISTS (SELECT 1 FROM public.distribution_points dp
                                 WHERE dp.id = s.scope_id AND dp.warehouse_id = v_need.scope_id
                                   AND dp.organization_id = p_organization_id)
                 THEN 'outlet_to_warehouse'
               -- central -> institution: an active supply route links the warehouses
               WHEN s.scope_kind = 'warehouse' AND v_need.scope_kind = 'warehouse'
                    AND EXISTS (SELECT 1 FROM public.warehouse_supply_routes r
                                 WHERE r.source_warehouse_id = s.scope_id
                                   AND r.target_warehouse_id = v_need.scope_id
                                   AND r.is_active)
                 THEN 'central_to_institution'
               ELSE NULL
             END AS route_kind
      FROM _src s
      WHERE s.remaining > 0
        AND lower(s.scientific_name) = lower(v_need.scientific_name)
        AND s.national_code IS NOT DISTINCT FROM v_need.national_code
        AND NOT (s.scope_kind = v_need.scope_kind AND s.scope_id = v_need.scope_id)
      ORDER BY s.remaining DESC, s.scope_id, s.alert_id
    LOOP
      EXIT WHEN v_remaining <= 0;
      CONTINUE WHEN v_src.route_kind IS NULL;   -- infeasible corridor: never suggest it

      v_take := LEAST(v_remaining, v_src.remaining);
      CONTINUE WHEN v_take <= 0;

      -- FEFO batch at the source (single batch, excludes expired/unavailable/quarantine).
      v_fefo_batch := NULL; v_fefo_expiry := NULL;
      SELECT f.batch_number, f.expiry_date INTO v_fefo_batch, v_fefo_expiry
      FROM public.phoenix_inventory_fefo_pick(
             p_organization_id, v_src.scope_kind, v_src.scope_id,
             v_need.scientific_name, v_need.national_code) f;

      INSERT INTO public.inventory_transfer_suggestions AS su (
        source_organization_id, target_organization_id, scientific_name, national_code,
        source_scope_kind, source_scope_id, target_scope_kind, target_scope_id, route_kind,
        suggested_quantity, fefo_batch_number, fefo_expiry_date,
        source_surplus_snapshot, target_shortfall_snapshot, rationale,
        suggestion_key, status, first_suggested_at, last_suggested_at
      )
      VALUES (
        p_organization_id, p_organization_id, v_need.scientific_name, v_need.national_code,
        v_src.scope_kind, v_src.scope_id, v_need.scope_kind, v_need.scope_id, v_src.route_kind,
        v_take, v_fefo_batch, v_fefo_expiry,
        v_src.headroom, v_need.deficit,
        'deterministic allocation: surplus source covers a shortage over a feasible route; move FEFO batch first',
        p_organization_id::text || '|' || v_src.scope_kind || '|' || v_src.scope_id::text || '|'
          || v_need.scope_kind || '|' || v_need.scope_id::text || '|'
          || lower(v_need.scientific_name) || '|' || COALESCE(v_need.national_code, ''),
        'open', now(), now()
      )
      ON CONFLICT (suggestion_key) DO UPDATE SET
        suggested_quantity        = EXCLUDED.suggested_quantity,
        route_kind                = EXCLUDED.route_kind,
        fefo_batch_number         = EXCLUDED.fefo_batch_number,
        fefo_expiry_date          = EXCLUDED.fefo_expiry_date,
        source_surplus_snapshot   = EXCLUDED.source_surplus_snapshot,
        target_shortfall_snapshot = EXCLUDED.target_shortfall_snapshot,
        last_suggested_at         = now(),
        updated_at                = now(),
        status = CASE WHEN su.status IN ('superseded', 'expired') THEN 'open' ELSE su.status END;

      INSERT INTO _live_keys VALUES (
        p_organization_id::text || '|' || v_src.scope_kind || '|' || v_src.scope_id::text || '|'
          || v_need.scope_kind || '|' || v_need.scope_id::text || '|'
          || lower(v_need.scientific_name) || '|' || COALESCE(v_need.national_code, '')
      ) ON CONFLICT DO NOTHING;

      v_upserted := v_upserted + 1;
      v_remaining := v_remaining - v_take;
      UPDATE _src SET remaining = remaining - v_take WHERE alert_id = v_src.alert_id;
    END LOOP;
  END LOOP;

  -- Supersede intra-org open suggestions no longer backed by a live allocation.
  UPDATE public.inventory_transfer_suggestions s
  SET status = 'superseded', updated_at = now()
  WHERE s.source_organization_id = p_organization_id
    AND s.target_organization_id = p_organization_id
    AND s.status = 'open'
    AND NOT EXISTS (SELECT 1 FROM _live_keys k WHERE k.suggestion_key = s.suggestion_key);

  RETURN jsonb_build_object('organization_id', p_organization_id, 'suggestions', v_upserted);
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_suggest_inventory_transfers(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_suggest_inventory_transfers(uuid) TO authenticated;

-- ============================================================================
-- 10. CROSS-ORG SUGGESTION — super_admin / server path ONLY, feasible route
-- ============================================================================
-- Minting a suggestion off ANOTHER organization's balances is a privileged act.
-- Only super_admin may call this. It validates a real central->institution
-- supply route exists between the two organizations' warehouses; it does not
-- let an ordinary user read foreign balances. It records advisory intent only.
CREATE OR REPLACE FUNCTION public.phoenix_suggest_cross_org_inventory_transfer(
  p_source_organization_id uuid,
  p_source_warehouse_id    uuid,
  p_target_organization_id uuid,
  p_target_warehouse_id    uuid,
  p_scientific_name        text,
  p_national_code          text,
  p_quantity               integer
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_name  text := NULLIF(btrim(p_scientific_name), '');
  v_id    uuid;
  v_fefo_batch text; v_fefo_expiry date;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF public.phoenix_my_role() <> 'super_admin' THEN
    RAISE EXCEPTION 'cross_org_suggestion_requires_super_admin';
  END IF;
  IF v_name IS NULL THEN RAISE EXCEPTION 'scientific_name_required'; END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN RAISE EXCEPTION 'quantity_must_be_positive'; END IF;
  IF p_source_organization_id = p_target_organization_id THEN
    RAISE EXCEPTION 'use_intra_org_suggest_for_same_org';
  END IF;

  -- Feasibility: a real active central->institution route between the warehouses.
  IF NOT EXISTS (
    SELECT 1 FROM public.warehouse_supply_routes r
    JOIN public.warehouses sw ON sw.id = r.source_warehouse_id AND sw.organization_id = p_source_organization_id
    JOIN public.warehouses tw ON tw.id = r.target_warehouse_id AND tw.organization_id = p_target_organization_id
    WHERE r.source_warehouse_id = p_source_warehouse_id
      AND r.target_warehouse_id = p_target_warehouse_id
      AND r.is_active
  ) THEN
    RAISE EXCEPTION 'no_active_supply_route_between_warehouses';
  END IF;

  SELECT f.batch_number, f.expiry_date INTO v_fefo_batch, v_fefo_expiry
  FROM public.phoenix_inventory_fefo_pick(
         p_source_organization_id, 'warehouse', p_source_warehouse_id, v_name, p_national_code) f;

  INSERT INTO public.inventory_transfer_suggestions AS su (
    source_organization_id, target_organization_id, scientific_name, national_code,
    source_scope_kind, source_scope_id, target_scope_kind, target_scope_id, route_kind,
    suggested_quantity, fefo_batch_number, fefo_expiry_date, rationale,
    suggestion_key, status, first_suggested_at, last_suggested_at
  )
  VALUES (
    p_source_organization_id, p_target_organization_id, v_name, NULLIF(btrim(p_national_code), ''),
    'warehouse', p_source_warehouse_id, 'warehouse', p_target_warehouse_id, 'central_to_institution',
    p_quantity, v_fefo_batch, v_fefo_expiry, 'cross-org advisory over an active supply route (super_admin)',
    'xorg|' || p_source_warehouse_id::text || '|' || p_target_warehouse_id::text || '|'
      || lower(v_name) || '|' || COALESCE(NULLIF(btrim(p_national_code), ''), ''),
    'open', now(), now()
  )
  ON CONFLICT (suggestion_key) DO UPDATE SET
    suggested_quantity = EXCLUDED.suggested_quantity,
    fefo_batch_number  = EXCLUDED.fefo_batch_number,
    fefo_expiry_date   = EXCLUDED.fefo_expiry_date,
    last_suggested_at  = now(), updated_at = now(),
    status = CASE WHEN su.status IN ('superseded', 'expired') THEN 'open' ELSE su.status END
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'route_kind', 'central_to_institution');
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_suggest_cross_org_inventory_transfer(uuid, uuid, uuid, uuid, text, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_suggest_cross_org_inventory_transfer(uuid, uuid, uuid, uuid, text, text, integer) TO authenticated;

-- ============================================================================
-- 11. SUGGESTION LIFECYCLE — accept (INTENT ONLY) / reject (audited)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.phoenix_accept_inventory_transfer_suggestion(p_suggestion_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_actor uuid := auth.uid(); v_s public.inventory_transfer_suggestions%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  SELECT * INTO v_s FROM public.inventory_transfer_suggestions WHERE id = p_suggestion_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'suggestion_not_found'; END IF;
  -- either endpoint org may act on it
  IF NOT (
    public.phoenix_my_role() = 'super_admin'
    OR public.phoenix_profile_has_scoped_permission(v_actor, 'inventory.act_on_suggestions', v_s.source_organization_id, NULL, NULL)
    OR public.phoenix_profile_has_scoped_permission(v_actor, 'inventory.act_on_suggestions', v_s.target_organization_id, NULL, NULL)
  ) THEN RAISE EXCEPTION 'not_authorized_inventory_act'; END IF;
  IF v_s.status <> 'open' THEN RAISE EXCEPTION 'suggestion_not_open'; END IF;

  -- INTENT ONLY. No stock/movement/dispatch/transfer write, by design.
  UPDATE public.inventory_transfer_suggestions
  SET status = 'accepted', accepted_at = now(), accepted_by = v_actor, updated_at = now()
  WHERE id = p_suggestion_id;

  INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (v_s.target_organization_id, v_actor, public.phoenix_my_role(), 'update', 'inventory_transfer_suggestion',
          p_suggestion_id, v_s.route_kind || ':' || v_s.scientific_name,
          jsonb_build_object('lifecycle', 'accept', 'intent_only', true, 'source_org', v_s.source_organization_id));

  RETURN jsonb_build_object('id', p_suggestion_id, 'status', 'accepted', 'note', 'intent recorded; no stock moved');
END;
$$;

CREATE OR REPLACE FUNCTION public.phoenix_reject_inventory_transfer_suggestion(p_suggestion_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_actor uuid := auth.uid(); v_reason text := NULLIF(btrim(p_reason), ''); v_s public.inventory_transfer_suggestions%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF v_reason IS NULL THEN RAISE EXCEPTION 'reject_reason_required'; END IF;
  SELECT * INTO v_s FROM public.inventory_transfer_suggestions WHERE id = p_suggestion_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'suggestion_not_found'; END IF;
  IF NOT (
    public.phoenix_my_role() = 'super_admin'
    OR public.phoenix_profile_has_scoped_permission(v_actor, 'inventory.act_on_suggestions', v_s.source_organization_id, NULL, NULL)
    OR public.phoenix_profile_has_scoped_permission(v_actor, 'inventory.act_on_suggestions', v_s.target_organization_id, NULL, NULL)
  ) THEN RAISE EXCEPTION 'not_authorized_inventory_act'; END IF;
  IF v_s.status <> 'open' THEN RAISE EXCEPTION 'suggestion_not_open'; END IF;

  UPDATE public.inventory_transfer_suggestions
  SET status = 'rejected', reason = v_reason, rejected_at = now(), rejected_by = v_actor, updated_at = now()
  WHERE id = p_suggestion_id;

  INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (v_s.target_organization_id, v_actor, public.phoenix_my_role(), 'update', 'inventory_transfer_suggestion',
          p_suggestion_id, v_s.route_kind || ':' || v_s.scientific_name,
          jsonb_build_object('lifecycle', 'reject', 'reason', v_reason, 'source_org', v_s.source_organization_id));

  RETURN jsonb_build_object('id', p_suggestion_id, 'status', 'rejected');
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_accept_inventory_transfer_suggestion(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_accept_inventory_transfer_suggestion(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.phoenix_reject_inventory_transfer_suggestion(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_reject_inventory_transfer_suggestion(uuid, text) TO authenticated;

-- ============================================================================
-- 12. THRESHOLD WRITE — manage_thresholds permission + audit
-- ============================================================================
CREATE OR REPLACE FUNCTION public.phoenix_upsert_inventory_threshold(
  p_organization_id  uuid,
  p_scope_kind       text,
  p_scope_id         uuid,
  p_scientific_name  text,
  p_national_code    text DEFAULT NULL,
  p_reorder_point    integer DEFAULT NULL,
  p_target_max       integer DEFAULT NULL,
  p_near_expiry_days integer DEFAULT NULL,
  p_is_active        boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_name  text := NULLIF(btrim(p_scientific_name), '');
  v_code  text := NULLIF(btrim(p_national_code), '');
  v_id    uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_scope_kind NOT IN ('warehouse', 'outlet') THEN RAISE EXCEPTION 'invalid_scope_kind'; END IF;
  IF v_name IS NULL THEN RAISE EXCEPTION 'scientific_name_required'; END IF;
  -- If a specific scope is named, it must belong to the org.
  IF p_scope_id IS NOT NULL
     AND public.phoenix_inventory_scope_org(p_scope_kind, p_scope_id) IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'scope_not_in_organization';
  END IF;
  IF NOT (
    public.phoenix_my_role() = 'super_admin'
    OR (p_scope_id IS NOT NULL AND p_scope_kind = 'warehouse' AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'inventory.manage_thresholds', p_organization_id, p_scope_id, NULL))
    OR (p_scope_id IS NOT NULL AND p_scope_kind = 'outlet' AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'inventory.manage_thresholds', p_organization_id, NULL, p_scope_id))
    OR (p_scope_id IS NULL AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'inventory.manage_thresholds', p_organization_id, NULL, NULL))
  ) THEN RAISE EXCEPTION 'not_authorized_inventory_manage_thresholds'; END IF;

  INSERT INTO public.inventory_signal_thresholds AS t (
    organization_id, scope_kind, scope_id, scientific_name, national_code,
    reorder_point, target_max, near_expiry_days, is_active, created_by, updated_by
  ) VALUES (
    p_organization_id, p_scope_kind, p_scope_id, v_name, v_code,
    p_reorder_point, p_target_max, p_near_expiry_days, COALESCE(p_is_active, true), v_actor, v_actor
  )
  ON CONFLICT (organization_id, scope_kind,
               COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
               lower(scientific_name), COALESCE(national_code, ''))
  DO UPDATE SET
    reorder_point = EXCLUDED.reorder_point, target_max = EXCLUDED.target_max,
    near_expiry_days = EXCLUDED.near_expiry_days, is_active = EXCLUDED.is_active,
    updated_by = v_actor, updated_at = now()
  RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (p_organization_id, v_actor, public.phoenix_my_role(), 'update', 'inventory_signal_threshold', v_id,
          p_scope_kind || ':' || v_name,
          jsonb_build_object('reorder_point', p_reorder_point, 'target_max', p_target_max,
                             'near_expiry_days', p_near_expiry_days, 'is_active', COALESCE(p_is_active, true)));

  RETURN jsonb_build_object('id', v_id, 'organization_id', p_organization_id, 'scope_kind', p_scope_kind);
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_upsert_inventory_threshold(uuid, text, uuid, text, text, integer, integer, integer, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_upsert_inventory_threshold(uuid, text, uuid, text, text, integer, integer, integer, boolean) TO authenticated;

-- ============================================================================
-- 13. PURGE — manual, safe, retention-bounded, NEVER touches audit_logs
-- ============================================================================
-- Deletes only TERMINAL alerts/suggestions older than an explicit retention
-- (>= 30 days), scoped to the org, permissioned, and NEVER an audit_logs row.
-- No cron: an operator calls this deliberately. Writes its own audit entry.
CREATE OR REPLACE FUNCTION public.phoenix_purge_inventory_terminal(
  p_organization_id uuid,
  p_older_than_days integer
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_cut   timestamptz;
  v_alerts integer := 0;
  v_sugs   integer := 0;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_older_than_days IS NULL OR p_older_than_days < 30 THEN
    RAISE EXCEPTION 'retention_must_be_at_least_30_days';
  END IF;
  IF NOT (
    public.phoenix_my_role() = 'super_admin'
    OR public.phoenix_profile_has_scoped_permission(v_actor, 'inventory.purge', p_organization_id, NULL, NULL)
  ) THEN RAISE EXCEPTION 'not_authorized_inventory_purge'; END IF;

  v_cut := now() - (p_older_than_days || ' days')::interval;

  DELETE FROM public.inventory_alerts a
  WHERE a.organization_id = p_organization_id
    AND a.status IN ('resolved', 'dismissed')
    AND a.updated_at < v_cut;
  GET DIAGNOSTICS v_alerts = ROW_COUNT;

  DELETE FROM public.inventory_transfer_suggestions s
  WHERE (s.source_organization_id = p_organization_id OR s.target_organization_id = p_organization_id)
    AND s.status IN ('rejected', 'superseded', 'expired')
    AND s.updated_at < v_cut;
  GET DIAGNOSTICS v_sugs = ROW_COUNT;

  -- Audit the purge itself. (audit_logs is never a purge target.)
  INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (p_organization_id, v_actor, public.phoenix_my_role(), 'purge', 'inventory_intelligence', NULL,
          'retention_' || p_older_than_days || 'd',
          jsonb_build_object('alerts_purged', v_alerts, 'suggestions_purged', v_sugs, 'older_than', v_cut));

  RETURN jsonb_build_object('alerts_purged', v_alerts, 'suggestions_purged', v_sugs, 'older_than', v_cut);
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_purge_inventory_terminal(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_purge_inventory_terminal(uuid, integer) TO authenticated;

-- ============================================================================
-- 14. RLS — org-scoped; suggestions visible to source OR target OR super_admin
-- ============================================================================
ALTER TABLE public.inventory_signal_thresholds     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_alerts                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_transfer_suggestions  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inventory_thresholds_select_scoped ON public.inventory_signal_thresholds;
CREATE POLICY inventory_thresholds_select_scoped
  ON public.inventory_signal_thresholds FOR SELECT TO authenticated
  USING (public.phoenix_can_read_inventory_signal(organization_id, scope_kind, scope_id));

DROP POLICY IF EXISTS inventory_alerts_select_scoped ON public.inventory_alerts;
CREATE POLICY inventory_alerts_select_scoped
  ON public.inventory_alerts FOR SELECT TO authenticated
  USING (public.phoenix_can_read_inventory_signal(organization_id, scope_kind, scope_id));

-- A suggestion is visible ONLY to its source org, its target org, or super_admin —
-- never a third organization.
DROP POLICY IF EXISTS inventory_suggestions_select_scoped ON public.inventory_transfer_suggestions;
CREATE POLICY inventory_suggestions_select_scoped
  ON public.inventory_transfer_suggestions FOR SELECT TO authenticated
  USING (
    public.phoenix_my_role() = 'super_admin'
    OR public.phoenix_can_read_inventory_signal(source_organization_id, source_scope_kind, source_scope_id)
    OR public.phoenix_can_read_inventory_signal(target_organization_id, target_scope_kind, target_scope_id)
  );

-- ============================================================================
-- 15. ACL — authenticated reads via RLS only; writes RPC-only; anon nothing
-- ============================================================================
GRANT SELECT ON TABLE public.inventory_signal_thresholds    TO authenticated;
GRANT SELECT ON TABLE public.inventory_alerts               TO authenticated;
GRANT SELECT ON TABLE public.inventory_transfer_suggestions TO authenticated;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.inventory_signal_thresholds    FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.inventory_alerts               FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.inventory_transfer_suggestions FROM authenticated;

REVOKE ALL ON TABLE public.inventory_signal_thresholds    FROM anon;
REVOKE ALL ON TABLE public.inventory_alerts               FROM anon;
REVOKE ALL ON TABLE public.inventory_transfer_suggestions FROM anon;

-- ============================================================================
-- 16. PERMISSION CATALOG — seven keys, split by action. ENFORCEMENT STAYS OFF.
-- ============================================================================
INSERT INTO public.permission_keys (key, module, action, label_en, label_ar, is_dangerous) VALUES
  ('inventory.view_signals',      'inventory', 'view_signals',      'View inventory signals and alerts',       'عرض إشارات وتنبيهات المخزون',    false),
  ('inventory.recompute',         'inventory', 'recompute',         'Recompute inventory alerts on demand',    'إعادة احتساب تنبيهات المخزون',   false),
  ('inventory.manage_alerts',     'inventory', 'manage_alerts',     'Acknowledge/resolve/dismiss alerts',      'إقرار/حل/تجاهل التنبيهات',       false),
  ('inventory.manage_thresholds', 'inventory', 'manage_thresholds', 'Create/update inventory thresholds',      'إدارة حدود المخزون',             false),
  ('inventory.suggest_transfers', 'inventory', 'suggest_transfers', 'Generate transfer suggestions',           'توليد اقتراحات التحويل',         false),
  ('inventory.act_on_suggestions','inventory', 'act_on_suggestions','Accept or reject transfer suggestions',   'قبول أو رفض اقتراحات التحويل',   false),
  ('inventory.purge',             'inventory', 'purge',             'Purge old terminal inventory records',    'تنظيف سجلات المخزون النهائية',   true)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.role_permission_defaults (role, permission_key, allowed)
SELECT 'super_admin', k.key, true
FROM public.permission_keys k
WHERE k.key LIKE 'inventory.%'
ON CONFLICT (role, permission_key) DO NOTHING;

INSERT INTO public.role_permission_defaults (role, permission_key, allowed) VALUES
  ('warehouse_officer',         'inventory.view_signals',      true),
  ('warehouse_officer',         'inventory.recompute',         true),
  ('warehouse_officer',         'inventory.manage_alerts',     true),
  ('warehouse_officer',         'inventory.manage_thresholds', true),
  ('warehouse_officer',         'inventory.suggest_transfers', true),
  ('warehouse_officer',         'inventory.act_on_suggestions',true),
  ('warehouse_officer',         'inventory.purge',             false),
  ('central_warehouse_manager', 'inventory.view_signals',      true),
  ('central_warehouse_manager', 'inventory.recompute',         true),
  ('central_warehouse_manager', 'inventory.manage_alerts',     true),
  ('central_warehouse_manager', 'inventory.manage_thresholds', true),
  ('central_warehouse_manager', 'inventory.suggest_transfers', true),
  ('central_warehouse_manager', 'inventory.act_on_suggestions',true),
  ('central_warehouse_manager', 'inventory.purge',             true),
  ('institution_admin',         'inventory.view_signals',      true),
  ('institution_admin',         'inventory.recompute',         true),
  ('institution_admin',         'inventory.manage_alerts',     true),
  ('institution_admin',         'inventory.manage_thresholds', true),
  ('institution_admin',         'inventory.suggest_transfers', true),
  ('institution_admin',         'inventory.act_on_suggestions',true),
  ('institution_admin',         'inventory.purge',             true),
  ('outlet_officer',            'inventory.view_signals',      true),
  ('outlet_officer',            'inventory.recompute',         false),
  ('outlet_officer',            'inventory.manage_alerts',     false),
  ('outlet_officer',            'inventory.manage_thresholds', false),
  ('outlet_officer',            'inventory.suggest_transfers', false),
  ('outlet_officer',            'inventory.act_on_suggestions',false),
  ('outlet_officer',            'inventory.purge',             false)
ON CONFLICT (role, permission_key) DO NOTHING;

INSERT INTO public.role_permission_defaults (role, permission_key, allowed)
SELECT r.role, k.key, false
FROM (VALUES ('port_officer'),('monthly_status_officer'),('viewer'),
             ('hospital_admin'),('warehouse_manager'),('point_operator'),('transfer_manager')) AS r(role)
CROSS JOIN (VALUES ('inventory.view_signals'),('inventory.recompute'),('inventory.manage_alerts'),
                   ('inventory.manage_thresholds'),('inventory.suggest_transfers'),
                   ('inventory.act_on_suggestions'),('inventory.purge')) AS k(key)
ON CONFLICT (role, permission_key) DO NOTHING;

-- ============================================================================
-- 17. POST-CONDITIONS (§ VERIFY)
-- ============================================================================
DO $$
DECLARE v_t text; v_body text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['inventory_signal_thresholds','inventory_alerts','inventory_transfer_suggestions'] LOOP
    IF to_regclass('public.' || v_t) IS NULL THEN RAISE EXCEPTION 'VERIFY FAILED (072): table % missing', v_t; END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || v_t)::regclass) THEN
      RAISE EXCEPTION 'VERIFY FAILED (072): RLS not enabled on %', v_t;
    END IF;
  END LOOP;

  -- five signals, four expiry tiers.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_alerts_signal_type_chk'
                   AND pg_get_constraintdef(oid) LIKE '%missing%low_stock%surplus%near_expiry%expired%') THEN
    RAISE EXCEPTION 'VERIFY FAILED (072): signal_type vocabulary wrong';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_alerts_expiry_tier_chk'
                   AND pg_get_constraintdef(oid) LIKE '%critical_3m%warning_6m%watch_9m%') THEN
    RAISE EXCEPTION 'VERIFY FAILED (072): expiry tiers not the 048 vocabulary';
  END IF;

  -- episode + dedup + cross-org columns exist.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
                   AND table_name='inventory_alerts' AND column_name='occurrence_count')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
                   AND table_name='inventory_alerts' AND column_name='cleared_at')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
                   AND table_name='inventory_transfer_suggestions' AND column_name='source_organization_id')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
                   AND table_name='inventory_transfer_suggestions' AND column_name='target_organization_id') THEN
    RAISE EXCEPTION 'VERIFY FAILED (072): episode/cross-org columns missing';
  END IF;

  IF to_regclass('public.inventory_alerts_alert_key_uniq') IS NULL
     OR to_regclass('public.inventory_suggestions_key_uniq') IS NULL
     OR to_regclass('public.inventory_thresholds_identity_uniq') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (072): a dedup unique index is missing';
  END IF;

  -- accept is intent-only; recompute/suggest never write physical stock.
  FOREACH v_t IN ARRAY ARRAY[
    'public.phoenix_accept_inventory_transfer_suggestion(uuid)',
    'public.phoenix_recompute_inventory_alerts(uuid,text,uuid)',
    'public.phoenix_suggest_inventory_transfers(uuid)'
  ] LOOP
    v_body := pg_get_functiondef(v_t::regprocedure);
    IF v_body ~* 'INSERT\s+INTO\s+public\.(warehouse_stock|outlet_stock|warehouse_stock_movements|outlet_stock_movements|warehouse_dispatches|warehouse_dispatch_lines|warehouse_transfers)'
       OR v_body ~* 'UPDATE\s+public\.(warehouse_stock|outlet_stock)\b' THEN
      RAISE EXCEPTION 'VERIFY FAILED (072): % moves physical stock', v_t;
    END IF;
  END LOOP;

  -- purge never targets audit_logs.
  v_body := pg_get_functiondef('public.phoenix_purge_inventory_terminal(uuid,integer)'::regprocedure);
  IF v_body ~* 'DELETE\s+FROM\s+public\.audit_logs' THEN
    RAISE EXCEPTION 'VERIFY FAILED (072): purge must never delete audit_logs';
  END IF;

  -- frugal: no forbidden columns.
  IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public'
                 AND table_name IN ('inventory_signal_thresholds','inventory_alerts','inventory_transfer_suggestions')
                 AND (column_name ~* 'image|photo|blob|whatsapp|snapshot_url|attachment')) THEN
    RAISE EXCEPTION 'VERIFY FAILED (072): a forbidden image/whatsapp/attachment column is present';
  END IF;

  -- ACL posture.
  IF NOT has_table_privilege('authenticated', 'public.inventory_alerts', 'SELECT') THEN
    RAISE EXCEPTION 'VERIFY FAILED (072): authenticated cannot SELECT inventory_alerts';
  END IF;
  IF has_table_privilege('authenticated', 'public.inventory_alerts', 'INSERT')
     OR has_table_privilege('authenticated', 'public.inventory_alerts', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.inventory_alerts', 'DELETE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (072): authenticated has direct write on inventory_alerts';
  END IF;
  IF has_table_privilege('anon', 'public.inventory_alerts', 'SELECT')
     OR has_table_privilege('anon', 'public.inventory_signal_thresholds', 'SELECT')
     OR has_table_privilege('anon', 'public.inventory_transfer_suggestions', 'SELECT') THEN
    RAISE EXCEPTION 'VERIFY FAILED (072): anon can read inventory intelligence';
  END IF;

  -- all seven permission keys registered.
  IF (SELECT count(*) FROM public.permission_keys WHERE key LIKE 'inventory.%') < 7 THEN
    RAISE EXCEPTION 'VERIFY FAILED (072): inventory permission keys not fully registered';
  END IF;

  RAISE NOTICE '072 post-conditions OK.';
END $$;

COMMIT;
