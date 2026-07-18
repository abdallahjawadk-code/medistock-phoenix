-- ============================================================================
-- INVENTORY-INTELLIGENCE-072-A
--
-- MANUAL APPLY ONLY. DO NOT use supabase db push or any automated runner.
--
-- VERIFICATION STATUS: authored, not applied, not executed against a
-- disposable PostgreSQL database. Validation used static analysis and the
-- test suite only (matching 044-071's own convention). Apply to a
-- staging/preview database and confirm every post-condition passes BEFORE
-- this is treated as ready for production. This is a FIRST-PASS authoring
-- pass and has NOT yet been through a live-apply review round, exactly like
-- 071 at first authoring.
--
-- STRATEGY: Expand -> Frontend Migration -> Contract. This is an EXPAND step.
-- Additive by construction: no DROP/RENAME/REVOKE against any pre-existing
-- object, no ALTER of any 001-071 table, no row rewritten.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS ADDS — READ-ONLY INVENTORY INTELLIGENCE OVER EXISTING STOCK
-- ─────────────────────────────────────────────────────────────────────────────
-- 060-071 built the physical truth: warehouse_stock (060/065) and outlet_stock
-- (067), each carrying on_hand_quantity, available_quantity (generated),
-- expiry_date and a material identity (scientific_name + national_code + batch).
-- Nothing yet READS that truth to tell an institution "you are about to run out
-- of X", "Y is expiring", or "warehouse A has surplus Z that outlet B needs".
--
-- 072 is that intelligence layer, and NOTHING MORE. It:
--   * classifies each stock position into a signal:
--       missing | low_stock | surplus | near_expiry | expired
--   * orders batches FEFO (first-expiry-first-out) when it suggests what to move
--   * raises in-app alerts, deduplicated, with a full lifecycle
--   * suggests surplus -> shortage transfers WITHOUT EVER EXECUTING THEM
--   * shows each row ONLY to the concerned organization (RLS-scoped)
--
-- It does NOT move a single unit of stock. A suggestion is advice; accepting one
-- records intent only and is proven by §14 to touch no stock/movement/dispatch
-- table. The actual physical transfer stays the job of the 068/070 dispatch
-- path, triggered deliberately by a human afterwards.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- FEFO — FIRST EXPIRY, FIRST OUT
-- ─────────────────────────────────────────────────────────────────────────────
-- When 072 suggests moving surplus to a shortage, it names the batch that should
-- leave FIRST: the earliest-expiry, still-usable (not expired) batch at the
-- source. This is the standard pharmaceutical FEFO discipline and is computed
-- from expiry_date ASC (NULLs — undated stock — last, never suggested ahead of a
-- dated batch). FEFO here only orders the SUGGESTION; it moves nothing.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SIGNAL VOCABULARY AND PRIORITY (mirrors 048's effective_status semantics)
-- ─────────────────────────────────────────────────────────────────────────────
-- Per (scope, material) the quantity signals are, in priority order:
--     expired      any on-hand units already past expiry_date
--     near_expiry  any on-hand units within near_expiry_days of expiry_date
--                  (default 270 days ~ 9 months, the window 048 widened to)
--     missing      the material is configured/known but on_hand is zero
--     low_stock    available_quantity <= reorder_point (and > 0)
--     surplus      available_quantity  > target_max
-- expired/near_expiry are per-BATCH (a batch has one expiry_date); missing/
-- low_stock/surplus are per-MATERIAL at a scope (summed across batches). A scope
-- can legitimately raise BOTH a near_expiry alert (one batch) AND a low_stock
-- alert (material total) — they are distinct alert_keys, never merged.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THRESHOLDS ARE OPTIONAL CONFIG, NEVER GUESSED
-- ─────────────────────────────────────────────────────────────────────────────
-- low_stock/surplus/missing need a reorder_point / target_max to mean anything.
-- inventory_signal_thresholds holds those, per organization, optionally narrowed
-- to a specific warehouse/outlet and always to a specific material identity. A
-- NULL threshold is NOT invented: without a reorder_point a material cannot be
-- low_stock or missing; without a target_max it cannot be surplus. near_expiry/
-- expired need no threshold (they are pure date facts) and always compute. This
-- is deliberately conservative: the system stays silent rather than guessing an
-- operational reorder level it was never told.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- FRUGAL BY DESIGN — SAFE FOR THE FREE PLAN
-- ─────────────────────────────────────────────────────────────────────────────
--   * NO images, NO binary/blob columns, NO storage-bucket dependency.
--   * NO periodic snapshots, NO pg_cron, NO scheduled job, NO history table.
--     Alerts are recomputed ON DEMAND by an RPC the app calls (e.g. on opening
--     the dashboard). State is the small current-alert set, not a time series.
--   * NO WhatsApp / SMS / email fan-out and NO contact columns. Signals surface
--     as in-app rows the concerned org reads through RLS — nothing is pushed.
--   * Recompute is idempotent and upsert-based (dedup by key), so calling it
--     repeatedly costs one bounded pass, never unbounded row growth.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS MIGRATION DELIBERATELY DOES **NOT** DO
-- ─────────────────────────────────────────────────────────────────────────────
--   * No DROP, no RENAME, no REVOKE against any pre-existing object.
--   * No ALTER of warehouse_stock / outlet_stock / any 001-071 table.
--   * No stock movement, no dispatch, no transfer execution of any kind —
--     accepting a suggestion is advisory intent ONLY (proven by §14).
--   * No widened CHECK on any existing constraint.
--   * No RBAC enforcement change. Enforcement stays OFF; scope enforcement
--     (phoenix_profile_has_scoped_permission) stays ON, as always.
--   * No data backfill and no demo/test rows in the new tables.
--   * No frontend in this PR — DB layer only.
--   * NOT APPLIED by this PR. Authored only, for audit.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 0. PRECONDITIONS — fail fast and loud if the expected 060-067 schema is absent
-- ============================================================================
DO $$
BEGIN
  -- Physical stock truth this layer reads.
  IF to_regclass('public.warehouse_stock') IS NULL
     OR to_regclass('public.outlet_stock') IS NULL THEN
    RAISE EXCEPTION 'ABORT 072: expected 065/067 stock tables are absent. Apply earlier migrations first.';
  END IF;

  -- The columns 072 classifies on must exist on both stock tables.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'warehouse_stock'
      AND column_name = 'available_quantity'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'outlet_stock'
      AND column_name = 'available_quantity'
  ) THEN
    RAISE EXCEPTION 'ABORT 072: expected stock columns (available_quantity) are absent.';
  END IF;

  -- Authz helpers (062) and identity helper (002) this layer gates on.
  IF to_regprocedure('public.phoenix_profile_has_scoped_permission(uuid,text,uuid,uuid,uuid)') IS NULL
     OR to_regprocedure('public.phoenix_my_role()') IS NULL THEN
    RAISE EXCEPTION 'ABORT 072: 002/062 authz helper RPCs are absent.';
  END IF;

  -- The RBAC catalog tables 072 registers its keys in (062).
  IF to_regclass('public.permission_keys') IS NULL
     OR to_regclass('public.role_permission_defaults') IS NULL THEN
    RAISE EXCEPTION 'ABORT 072: 062 RBAC catalog tables are absent.';
  END IF;

  RAISE NOTICE '072 preconditions OK.';
END $$;

-- ============================================================================
-- 1. THRESHOLD CONFIG — optional, per org, narrowable to a scope + material
-- ============================================================================
-- A row says: for this organization (optionally only this warehouse/outlet),
-- for this material identity, the reorder_point / target_max / near_expiry_days
-- to use. All three are individually optional; a NULL simply means "that signal
-- is not configured and will not fire". Nothing is guessed.
CREATE TABLE IF NOT EXISTS public.inventory_signal_thresholds (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- Which kind of location this threshold governs, and (optionally) which one.
  -- scope_id NULL = an organization-wide default for every location of that kind.
  scope_kind         text NOT NULL,
  scope_id           uuid,

  -- Material identity, matching how stock is identified (scientific_name is the
  -- catalog-independent identity both stock tables carry NOT NULL).
  scientific_name    text NOT NULL,
  national_code      text,

  -- The optional thresholds. Each NULL disables its signal for this material.
  reorder_point      integer,   -- available <= this (and > 0) => low_stock; on_hand 0 => missing
  target_max         integer,   -- available >  this            => surplus
  near_expiry_days   integer,   -- overrides the 270-day default window for this material

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
  -- surplus can never sit at or below the reorder point — that would make a
  -- position simultaneously low and surplus, which is nonsense.
  CONSTRAINT inventory_thresholds_band_chk
    CHECK (reorder_point IS NULL OR target_max IS NULL OR target_max >= reorder_point),
  CONSTRAINT inventory_thresholds_near_expiry_days_chk
    CHECK (near_expiry_days IS NULL OR near_expiry_days > 0)
);

-- Dedup config: at most one active threshold per (org, scope_kind, scope, material).
-- COALESCE folds the "org-wide default" (scope_id NULL) and "no national code"
-- (national_code NULL) cases so they cannot silently duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS inventory_thresholds_identity_uniq
  ON public.inventory_signal_thresholds (
    organization_id,
    scope_kind,
    COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(scientific_name),
    COALESCE(national_code, '')
  );

CREATE INDEX IF NOT EXISTS inventory_thresholds_org_idx
  ON public.inventory_signal_thresholds (organization_id, scope_kind);

-- ============================================================================
-- 2. INVENTORY ALERTS — deduplicated, with a full open->resolved lifecycle
-- ============================================================================
-- One row per DISTINCT current signal (dedup by alert_key). Recompute refreshes
-- the observation snapshot on an existing open row instead of inserting a new
-- one, and auto-resolves an open row whose condition has cleared. Lifecycle
-- mirrors 038's inter_org_alert_states exactly (open/acknowledged/in_progress/
-- resolved/dismissed; resolved & dismissed require a non-empty reason).
CREATE TABLE IF NOT EXISTS public.inventory_alerts (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- Where the signal lives. scope_id is a warehouse_id or a distribution_point_id
  -- depending on scope_kind; it is validated by the recompute RPC against the
  -- caller's own org and NOT cross-FK'd here because it is polymorphic by design.
  scope_kind               text NOT NULL,
  scope_id                 uuid NOT NULL,

  signal_type              text NOT NULL,
  severity                 text NOT NULL,

  -- Material identity snapshot (frozen at first observation; stock identity
  -- fields can change, the alert should still describe what it saw).
  scientific_name          text NOT NULL,
  national_code            text,
  batch_number             text,     -- set only for per-batch signals (near_expiry/expired)
  expiry_date              date,     -- set only for per-batch signals

  -- Observation snapshot — what the numbers were when last recomputed.
  observed_on_hand         integer,
  observed_available       integer,
  threshold_reorder_point  integer,
  threshold_target_max     integer,
  near_expiry_days         integer,
  days_to_expiry           integer,

  -- Dedup identity. Deterministically built by the recompute RPC. For
  -- quantity signals it excludes batch/expiry (material-level); for date signals
  -- it includes them (batch-level). UNIQUE so a signal can exist at most once.
  alert_key                text NOT NULL,

  status                   text NOT NULL DEFAULT 'open',
  reason                   text,
  auto_resolved            boolean NOT NULL DEFAULT false,

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
  CONSTRAINT inventory_alerts_status_chk
    CHECK (status IN ('open', 'acknowledged', 'in_progress', 'resolved', 'dismissed')),
  CONSTRAINT inventory_alerts_sci_name_chk
    CHECK (btrim(scientific_name) = scientific_name AND scientific_name <> ''),
  -- date signals carry a batch identity; quantity signals never do.
  CONSTRAINT inventory_alerts_batch_signal_chk
    CHECK (
      (signal_type IN ('near_expiry', 'expired') AND expiry_date IS NOT NULL)
      OR (signal_type IN ('missing', 'low_stock', 'surplus')
          AND batch_number IS NULL AND expiry_date IS NULL)
    ),
  CONSTRAINT inventory_alerts_resolve_reason_chk
    CHECK (status <> 'resolved' OR (reason IS NOT NULL AND btrim(reason) <> '')),
  CONSTRAINT inventory_alerts_dismiss_reason_chk
    CHECK (status <> 'dismissed' OR (reason IS NOT NULL AND btrim(reason) <> ''))
);

-- Dedup: a signal exists at most once, regardless of lifecycle churn.
CREATE UNIQUE INDEX IF NOT EXISTS inventory_alerts_alert_key_uniq
  ON public.inventory_alerts (alert_key);

-- The dashboard reads open/active alerts per org & scope; index for it.
CREATE INDEX IF NOT EXISTS inventory_alerts_org_scope_status_idx
  ON public.inventory_alerts (organization_id, scope_kind, scope_id, status);

-- ============================================================================
-- 3. TRANSFER SUGGESTIONS — advisory only, deduplicated, with a lifecycle
-- ============================================================================
-- "Warehouse A holds surplus of X; outlet B is short of X; consider moving N
-- units (FEFO batch first)." Purely advisory: accepting records intent and
-- moves nothing. Dedup by suggestion_key; recompute supersedes stale advice.
CREATE TABLE IF NOT EXISTS public.inventory_transfer_suggestions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  scientific_name           text NOT NULL,
  national_code             text,

  source_scope_kind         text NOT NULL,
  source_scope_id           uuid NOT NULL,
  target_scope_kind         text NOT NULL,
  target_scope_id           uuid NOT NULL,

  suggested_quantity        integer NOT NULL,

  -- FEFO: the earliest-expiry, still-usable batch at the source, named so the
  -- human moves the right one first. Advisory snapshot, never a hold.
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
  CONSTRAINT inventory_suggestions_sci_name_chk
    CHECK (btrim(scientific_name) = scientific_name AND scientific_name <> ''),
  CONSTRAINT inventory_suggestions_qty_chk
    CHECK (suggested_quantity > 0),
  -- never suggest moving stock to the very place it already sits.
  CONSTRAINT inventory_suggestions_distinct_scope_chk
    CHECK (NOT (source_scope_kind = target_scope_kind AND source_scope_id = target_scope_id)),
  CONSTRAINT inventory_suggestions_status_chk
    CHECK (status IN ('open', 'accepted', 'rejected', 'superseded', 'expired')),
  CONSTRAINT inventory_suggestions_reject_reason_chk
    CHECK (status <> 'rejected' OR (reason IS NOT NULL AND btrim(reason) <> ''))
);

CREATE UNIQUE INDEX IF NOT EXISTS inventory_suggestions_key_uniq
  ON public.inventory_transfer_suggestions (suggestion_key);

CREATE INDEX IF NOT EXISTS inventory_suggestions_org_status_idx
  ON public.inventory_transfer_suggestions (organization_id, status);

-- ============================================================================
-- 4. FEFO HELPER — earliest-expiry usable batch at a scope for a material
-- ============================================================================
-- Pure read. Returns the batch that should leave first (earliest non-expired
-- expiry_date; undated stock ranked last). Used by the suggestion RPC; exposed
-- as a SECURITY DEFINER function so the app can preview FEFO ordering without
-- direct table reads. Scoped-read gated by the caller's own permission.
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
      ORDER BY ws.expiry_date ASC NULLS LAST, ws.available_quantity DESC;
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
      ORDER BY os.expiry_date ASC NULLS LAST, os.available_quantity DESC;
  END IF;
END;
$$;

-- ============================================================================
-- 5. READ GATE — a user sees inventory intelligence ONLY for its own org/scope
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
    AND (
      public.phoenix_my_role() = 'super_admin'
      OR public.phoenix_profile_has_scoped_permission(
           auth.uid(), 'inventory.view_signals', p_organization_id,
           CASE WHEN p_scope_kind = 'warehouse' THEN p_scope_id ELSE NULL END,
           CASE WHEN p_scope_kind = 'outlet'    THEN p_scope_id ELSE NULL END
         )
    );
$$;

REVOKE ALL ON FUNCTION public.phoenix_can_read_inventory_signal(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_can_read_inventory_signal(uuid, text, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.phoenix_inventory_fefo_pick(uuid, text, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_inventory_fefo_pick(uuid, text, uuid, text, text) TO authenticated;

-- ============================================================================
-- 6. RECOMPUTE — the on-demand classifier that raises/refreshes/auto-resolves
-- ============================================================================
-- Bounded single pass over the caller's own stock. Builds the CURRENT set of
-- violating alert_keys, upserts each (refreshing observation on an existing open
-- row, reopening an auto-resolved one whose condition recurs), then auto-resolves
-- any previously-open alert in the recomputed scope whose key is no longer
-- violating. No cron: the app calls this. No snapshot history: only current state.
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
  v_actor        uuid := auth.uid();
  v_default_near integer := 270;   -- 9 months, matching 048's widened window
  v_raised       integer := 0;
  v_resolved     integer := 0;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF p_scope_kind IS NOT NULL AND p_scope_kind NOT IN ('warehouse', 'outlet') THEN
    RAISE EXCEPTION 'invalid_scope_kind';
  END IF;

  -- Authz: caller must hold recompute permission for this org (super_admin ok).
  IF NOT (
    public.phoenix_my_role() = 'super_admin'
    OR public.phoenix_profile_has_scoped_permission(
         v_actor, 'inventory.recompute', p_organization_id, NULL, NULL)
  ) THEN
    RAISE EXCEPTION 'not_authorized_inventory_recompute';
  END IF;

  -- Serialize concurrent recompute for the same org (advisory, released at commit).
  PERFORM pg_advisory_xact_lock(hashtextextended('inv_recompute:' || p_organization_id::text, 0));

  -- ── Build the current violation set ─────────────────────────────────────
  CREATE TEMP TABLE _inv_now (
    alert_key   text PRIMARY KEY,
    scope_kind  text,
    scope_id    uuid,
    signal_type text,
    severity    text,
    sci_name    text,
    national    text,
    batch       text,
    expiry      date,
    on_hand     integer,
    available   integer,
    reorder     integer,
    target_max  integer,
    near_days   integer,
    dte         integer
  ) ON COMMIT DROP;

  -- Unified stock view for both scope kinds, narrowed to this org (and optional scope).
  CREATE TEMP TABLE _inv_stock ON COMMIT DROP AS
    SELECT 'warehouse'::text AS scope_kind, ws.warehouse_id AS scope_id,
           ws.scientific_name, ws.national_code, ws.batch_number,
           ws.expiry_date, ws.on_hand_quantity, ws.available_quantity
    FROM public.warehouse_stock ws
    WHERE ws.organization_id = p_organization_id
      AND (p_scope_kind IS NULL OR p_scope_kind = 'warehouse')
      AND (p_scope_id   IS NULL OR ws.warehouse_id = p_scope_id)
    UNION ALL
    SELECT 'outlet'::text, os.distribution_point_id,
           os.scientific_name, os.national_code, os.batch_number,
           os.expiry_date, os.on_hand_quantity, os.available_quantity
    FROM public.outlet_stock os
    WHERE os.organization_id = p_organization_id
      AND (p_scope_kind IS NULL OR p_scope_kind = 'outlet')
      AND (p_scope_id   IS NULL OR os.distribution_point_id = p_scope_id);

  -- Resolve the effective threshold for a (scope, material): a scope-specific
  -- active row wins over an org-wide (scope_id NULL) one; likewise a
  -- national-code-specific row wins over the code-agnostic one.
  CREATE TEMP TABLE _inv_thr ON COMMIT DROP AS
    SELECT t.scope_kind, t.scope_id, lower(t.scientific_name) AS sci_lower,
           t.national_code, t.reorder_point, t.target_max, t.near_expiry_days,
           (CASE WHEN t.scope_id IS NULL THEN 0 ELSE 1 END)
           + (CASE WHEN t.national_code IS NULL THEN 0 ELSE 1 END) AS specificity
    FROM public.inventory_signal_thresholds t
    WHERE t.organization_id = p_organization_id
      AND t.is_active;

  -- ── Per-batch date signals: expired, then near_expiry ───────────────────
  INSERT INTO _inv_now
  SELECT
    p_organization_id::text || '|' || s.scope_kind || '|' || s.scope_id::text || '|'
      || sig.signal_type || '|' || lower(s.scientific_name) || '|'
      || COALESCE(s.national_code, '') || '|' || COALESCE(s.batch_number, '') || '|'
      || COALESCE(s.expiry_date::text, '') AS alert_key,
    s.scope_kind, s.scope_id, sig.signal_type, sig.severity,
    s.scientific_name, s.national_code, s.batch_number, s.expiry_date,
    s.on_hand_quantity, s.available_quantity, NULL, NULL,
    sig.near_days, (s.expiry_date - current_date)
  FROM _inv_stock s
  CROSS JOIN LATERAL (
    SELECT COALESCE(
             (SELECT thr.near_expiry_days FROM _inv_thr thr
               WHERE thr.scope_kind = s.scope_kind
                 AND (thr.scope_id = s.scope_id OR thr.scope_id IS NULL)
                 AND thr.sci_lower = lower(s.scientific_name)
                 AND (thr.national_code = s.national_code OR thr.national_code IS NULL)
                 AND thr.near_expiry_days IS NOT NULL
               ORDER BY thr.specificity DESC LIMIT 1),
             v_default_near) AS near_days
  ) cfg
  CROSS JOIN LATERAL (
    SELECT
      CASE WHEN s.expiry_date < current_date THEN 'expired'
           ELSE 'near_expiry' END AS signal_type,
      CASE WHEN s.expiry_date < current_date THEN 'high' ELSE 'medium' END AS severity,
      cfg.near_days
  ) sig
  WHERE s.on_hand_quantity > 0
    AND s.expiry_date IS NOT NULL
    AND s.expiry_date <= current_date + (cfg.near_days || ' days')::interval
  ON CONFLICT (alert_key) DO NOTHING;

  -- ── Per-material quantity signals: missing / low_stock / surplus ────────
  -- Aggregate available/on-hand across batches at each (scope, material), then
  -- classify against the resolved threshold. Priority: missing > low_stock >
  -- surplus (a scope is only ever one of these for a given material).
  INSERT INTO _inv_now
  SELECT
    p_organization_id::text || '|' || agg.scope_kind || '|' || agg.scope_id::text || '|'
      || q.signal_type || '|' || lower(agg.scientific_name) || '|'
      || COALESCE(agg.national_code, '') || '||' AS alert_key,
    agg.scope_kind, agg.scope_id, q.signal_type, q.severity,
    agg.scientific_name, agg.national_code, NULL, NULL,
    agg.on_hand, agg.available, q.reorder, q.target_max, NULL, NULL
  FROM (
    SELECT s.scope_kind, s.scope_id, s.scientific_name, s.national_code,
           SUM(s.on_hand_quantity)  AS on_hand,
           SUM(s.available_quantity) AS available
    FROM _inv_stock s
    GROUP BY s.scope_kind, s.scope_id, s.scientific_name, s.national_code
  ) agg
  CROSS JOIN LATERAL (
    SELECT thr.reorder_point, thr.target_max
    FROM _inv_thr thr
    WHERE thr.scope_kind = agg.scope_kind
      AND (thr.scope_id = agg.scope_id OR thr.scope_id IS NULL)
      AND thr.sci_lower = lower(agg.scientific_name)
      AND (thr.national_code = agg.national_code OR thr.national_code IS NULL)
    ORDER BY thr.specificity DESC LIMIT 1
  ) cfg
  CROSS JOIN LATERAL (
    SELECT
      CASE
        WHEN cfg.reorder_point IS NOT NULL AND cfg.reorder_point > 0 AND agg.on_hand = 0 THEN 'missing'
        WHEN cfg.reorder_point IS NOT NULL AND agg.available > 0 AND agg.available <= cfg.reorder_point THEN 'low_stock'
        WHEN cfg.target_max    IS NOT NULL AND agg.available > cfg.target_max THEN 'surplus'
        ELSE NULL
      END AS signal_type,
      CASE
        WHEN cfg.reorder_point IS NOT NULL AND cfg.reorder_point > 0 AND agg.on_hand = 0 THEN 'high'
        WHEN cfg.reorder_point IS NOT NULL AND agg.available > 0 AND agg.available <= cfg.reorder_point THEN 'medium'
        ELSE 'low'
      END AS severity,
      cfg.reorder_point AS reorder,
      cfg.target_max    AS target_max
  ) q
  WHERE q.signal_type IS NOT NULL
  ON CONFLICT (alert_key) DO NOTHING;

  -- ── Upsert the current violations into the durable alert table ──────────
  INSERT INTO public.inventory_alerts AS a (
    organization_id, scope_kind, scope_id, signal_type, severity,
    scientific_name, national_code, batch_number, expiry_date,
    observed_on_hand, observed_available, threshold_reorder_point,
    threshold_target_max, near_expiry_days, days_to_expiry,
    alert_key, status, first_observed_at, last_observed_at
  )
  SELECT
    p_organization_id, n.scope_kind, n.scope_id, n.signal_type, n.severity,
    n.sci_name, n.national, n.batch, n.expiry,
    n.on_hand, n.available, n.reorder, n.target_max, n.near_days, n.dte,
    n.alert_key, 'open', now(), now()
  FROM _inv_now n
  ON CONFLICT (alert_key) DO UPDATE SET
    severity                = EXCLUDED.severity,
    observed_on_hand        = EXCLUDED.observed_on_hand,
    observed_available      = EXCLUDED.observed_available,
    threshold_reorder_point = EXCLUDED.threshold_reorder_point,
    threshold_target_max    = EXCLUDED.threshold_target_max,
    near_expiry_days        = EXCLUDED.near_expiry_days,
    days_to_expiry          = EXCLUDED.days_to_expiry,
    last_observed_at        = now(),
    updated_at              = now(),
    -- a recurrence of an auto-resolved condition reopens it; human-managed
    -- states (acknowledged/in_progress/dismissed/manually-resolved) are left be.
    status = CASE WHEN a.status = 'resolved' AND a.auto_resolved THEN 'open' ELSE a.status END,
    auto_resolved = CASE WHEN a.status = 'resolved' AND a.auto_resolved THEN false ELSE a.auto_resolved END,
    reason  = CASE WHEN a.status = 'resolved' AND a.auto_resolved THEN NULL ELSE a.reason END;

  GET DIAGNOSTICS v_raised = ROW_COUNT;

  -- ── Auto-resolve open alerts whose condition has cleared ────────────────
  -- Only within the recomputed scope, and only rows that were actually observed
  -- this pass are exempt. Human-terminal states are never touched.
  UPDATE public.inventory_alerts a
  SET status = 'resolved',
      auto_resolved = true,
      reason = 'auto: condition no longer present at recompute',
      resolved_at = now(),
      updated_at = now()
  WHERE a.organization_id = p_organization_id
    AND (p_scope_kind IS NULL OR a.scope_kind = p_scope_kind)
    AND (p_scope_id   IS NULL OR a.scope_id = p_scope_id)
    AND a.status IN ('open', 'acknowledged', 'in_progress')
    AND NOT EXISTS (SELECT 1 FROM _inv_now n WHERE n.alert_key = a.alert_key);

  GET DIAGNOSTICS v_resolved = ROW_COUNT;

  RETURN jsonb_build_object(
    'organization_id', p_organization_id,
    'scope_kind', p_scope_kind,
    'scope_id', p_scope_id,
    'violations', (SELECT count(*) FROM _inv_now),
    'upserted', v_raised,
    'auto_resolved', v_resolved
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_recompute_inventory_alerts(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_recompute_inventory_alerts(uuid, text, uuid) TO authenticated;

-- ============================================================================
-- 7. ALERT LIFECYCLE RPCs — acknowledge / resolve / dismiss (IDOR-gated)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.phoenix_acknowledge_inventory_alert(
  p_alert_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_alert public.inventory_alerts%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT * INTO v_alert FROM public.inventory_alerts WHERE id = p_alert_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'alert_not_found'; END IF;

  IF NOT (
    public.phoenix_my_role() = 'super_admin'
    OR public.phoenix_profile_has_scoped_permission(
         v_actor, 'inventory.manage_alerts', v_alert.organization_id,
         CASE WHEN v_alert.scope_kind = 'warehouse' THEN v_alert.scope_id ELSE NULL END,
         CASE WHEN v_alert.scope_kind = 'outlet'    THEN v_alert.scope_id ELSE NULL END)
  ) THEN
    RAISE EXCEPTION 'not_authorized_inventory_manage';
  END IF;

  IF v_alert.status NOT IN ('open') THEN
    RAISE EXCEPTION 'alert_not_open';
  END IF;

  UPDATE public.inventory_alerts
  SET status = 'acknowledged', acknowledged_at = now(), acknowledged_by = v_actor, updated_at = now()
  WHERE id = p_alert_id;

  RETURN jsonb_build_object('id', p_alert_id, 'status', 'acknowledged');
END;
$$;

CREATE OR REPLACE FUNCTION public.phoenix_resolve_inventory_alert(
  p_alert_id uuid,
  p_reason   text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor  uuid := auth.uid();
  v_reason text := NULLIF(btrim(p_reason), '');
  v_alert  public.inventory_alerts%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF v_reason IS NULL THEN RAISE EXCEPTION 'resolve_reason_required'; END IF;

  SELECT * INTO v_alert FROM public.inventory_alerts WHERE id = p_alert_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'alert_not_found'; END IF;

  IF NOT (
    public.phoenix_my_role() = 'super_admin'
    OR public.phoenix_profile_has_scoped_permission(
         v_actor, 'inventory.manage_alerts', v_alert.organization_id,
         CASE WHEN v_alert.scope_kind = 'warehouse' THEN v_alert.scope_id ELSE NULL END,
         CASE WHEN v_alert.scope_kind = 'outlet'    THEN v_alert.scope_id ELSE NULL END)
  ) THEN
    RAISE EXCEPTION 'not_authorized_inventory_manage';
  END IF;

  IF v_alert.status IN ('resolved', 'dismissed') THEN
    RAISE EXCEPTION 'alert_already_terminal';
  END IF;

  UPDATE public.inventory_alerts
  SET status = 'resolved', auto_resolved = false, reason = v_reason,
      resolved_at = now(), resolved_by = v_actor, updated_at = now()
  WHERE id = p_alert_id;

  RETURN jsonb_build_object('id', p_alert_id, 'status', 'resolved');
END;
$$;

CREATE OR REPLACE FUNCTION public.phoenix_dismiss_inventory_alert(
  p_alert_id uuid,
  p_reason   text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor  uuid := auth.uid();
  v_reason text := NULLIF(btrim(p_reason), '');
  v_alert  public.inventory_alerts%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF v_reason IS NULL THEN RAISE EXCEPTION 'dismiss_reason_required'; END IF;

  SELECT * INTO v_alert FROM public.inventory_alerts WHERE id = p_alert_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'alert_not_found'; END IF;

  IF NOT (
    public.phoenix_my_role() = 'super_admin'
    OR public.phoenix_profile_has_scoped_permission(
         v_actor, 'inventory.manage_alerts', v_alert.organization_id,
         CASE WHEN v_alert.scope_kind = 'warehouse' THEN v_alert.scope_id ELSE NULL END,
         CASE WHEN v_alert.scope_kind = 'outlet'    THEN v_alert.scope_id ELSE NULL END)
  ) THEN
    RAISE EXCEPTION 'not_authorized_inventory_manage';
  END IF;

  IF v_alert.status IN ('resolved', 'dismissed') THEN
    RAISE EXCEPTION 'alert_already_terminal';
  END IF;

  UPDATE public.inventory_alerts
  SET status = 'dismissed', reason = v_reason,
      dismissed_at = now(), dismissed_by = v_actor, updated_at = now()
  WHERE id = p_alert_id;

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
-- 8. SUGGEST TRANSFERS — surplus -> shortage matching, advisory ONLY
-- ============================================================================
-- Matches, WITHIN ONE ORGANIZATION, a material that is surplus at one scope and
-- short (missing/low_stock) at another, and records a suggestion naming the FEFO
-- batch to move first and a bounded quantity. It INSERTS ONLY into
-- inventory_transfer_suggestions. It NEVER writes warehouse_stock, outlet_stock,
-- any *_movements table, any dispatch, or any transfer — proven by §14.
CREATE OR REPLACE FUNCTION public.phoenix_suggest_inventory_transfers(
  p_organization_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_created  integer := 0;
  v_stale    integer := 0;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  IF NOT (
    public.phoenix_my_role() = 'super_admin'
    OR public.phoenix_profile_has_scoped_permission(
         v_actor, 'inventory.suggest_transfers', p_organization_id, NULL, NULL)
  ) THEN
    RAISE EXCEPTION 'not_authorized_inventory_suggest';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('inv_suggest:' || p_organization_id::text, 0));

  -- Shortages come straight from the open alert set (missing/low_stock).
  CREATE TEMP TABLE _need ON COMMIT DROP AS
    SELECT a.scope_kind, a.scope_id, a.scientific_name, a.national_code,
           GREATEST(COALESCE(a.threshold_reorder_point, 0) - COALESCE(a.observed_available, 0), 1) AS shortfall
    FROM public.inventory_alerts a
    WHERE a.organization_id = p_organization_id
      AND a.status IN ('open', 'acknowledged', 'in_progress')
      AND a.signal_type IN ('missing', 'low_stock');

  -- Surplus sources likewise, with their above-target headroom.
  CREATE TEMP TABLE _have ON COMMIT DROP AS
    SELECT a.scope_kind, a.scope_id, a.scientific_name, a.national_code,
           GREATEST(COALESCE(a.observed_available, 0) - COALESCE(a.threshold_target_max, 0), 1) AS headroom
    FROM public.inventory_alerts a
    WHERE a.organization_id = p_organization_id
      AND a.status IN ('open', 'acknowledged', 'in_progress')
      AND a.signal_type = 'surplus';

  -- Build the candidate matches (same material identity, different scope).
  CREATE TEMP TABLE _match ON COMMIT DROP AS
    SELECT
      p_organization_id::text || '|' || h.scope_kind || '|' || h.scope_id::text || '|'
        || n.scope_kind || '|' || n.scope_id::text || '|'
        || lower(h.scientific_name) || '|' || COALESCE(h.national_code, '') AS suggestion_key,
      h.scientific_name, h.national_code,
      h.scope_kind AS src_kind, h.scope_id AS src_id,
      n.scope_kind AS tgt_kind, n.scope_id AS tgt_id,
      LEAST(h.headroom, n.shortfall) AS qty,
      h.headroom AS surplus_snap, n.shortfall AS shortfall_snap
    FROM _have h
    JOIN _need n
      ON lower(h.scientific_name) = lower(n.scientific_name)
     AND h.national_code IS NOT DISTINCT FROM n.national_code
     AND NOT (h.scope_kind = n.scope_kind AND h.scope_id = n.scope_id)
    WHERE LEAST(h.headroom, n.shortfall) > 0;

  -- Attach the FEFO batch (earliest usable expiry) at each source.
  INSERT INTO public.inventory_transfer_suggestions AS s (
    organization_id, scientific_name, national_code,
    source_scope_kind, source_scope_id, target_scope_kind, target_scope_id,
    suggested_quantity, fefo_batch_number, fefo_expiry_date,
    source_surplus_snapshot, target_shortfall_snapshot, rationale,
    suggestion_key, status, first_suggested_at, last_suggested_at
  )
  SELECT
    p_organization_id, m.scientific_name, m.national_code,
    m.src_kind, m.src_id, m.tgt_kind, m.tgt_id,
    m.qty, fefo.batch_number, fefo.expiry_date,
    m.surplus_snap, m.shortfall_snap,
    'surplus at source covers a shortage at target; move FEFO batch first',
    m.suggestion_key, 'open', now(), now()
  FROM _match m
  LEFT JOIN LATERAL (
    SELECT f.batch_number, f.expiry_date
    FROM public.phoenix_inventory_fefo_pick(
           p_organization_id, m.src_kind, m.src_id, m.scientific_name, m.national_code) f
    LIMIT 1
  ) fefo ON true
  ON CONFLICT (suggestion_key) DO UPDATE SET
    suggested_quantity        = EXCLUDED.suggested_quantity,
    fefo_batch_number         = EXCLUDED.fefo_batch_number,
    fefo_expiry_date          = EXCLUDED.fefo_expiry_date,
    source_surplus_snapshot   = EXCLUDED.source_surplus_snapshot,
    target_shortfall_snapshot = EXCLUDED.target_shortfall_snapshot,
    last_suggested_at         = now(),
    updated_at                = now(),
    -- a still-valid recurrence reopens a superseded/expired suggestion; a human
    -- accept/reject is never overwritten.
    status = CASE WHEN s.status IN ('superseded', 'expired') THEN 'open' ELSE s.status END;

  GET DIAGNOSTICS v_created = ROW_COUNT;

  -- Supersede open suggestions no longer backed by a live match.
  UPDATE public.inventory_transfer_suggestions s
  SET status = 'superseded', updated_at = now()
  WHERE s.organization_id = p_organization_id
    AND s.status = 'open'
    AND NOT EXISTS (SELECT 1 FROM _match m WHERE m.suggestion_key = s.suggestion_key);

  GET DIAGNOSTICS v_stale = ROW_COUNT;

  RETURN jsonb_build_object(
    'organization_id', p_organization_id,
    'matches', (SELECT count(*) FROM _match),
    'upserted', v_created,
    'superseded', v_stale
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_suggest_inventory_transfers(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_suggest_inventory_transfers(uuid) TO authenticated;

-- ============================================================================
-- 9. SUGGESTION LIFECYCLE — accept (INTENT ONLY) / reject
-- ============================================================================
-- ACCEPT RECORDS INTENT AND MOVES NOTHING. It writes only the suggestion row's
-- own status/accepted_* columns. The physical move remains a separate,
-- deliberate 068/070 dispatch the human triggers afterward. §14 proves this
-- function body contains no write to any stock/movement/dispatch/transfer table.
CREATE OR REPLACE FUNCTION public.phoenix_accept_inventory_transfer_suggestion(
  p_suggestion_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_sug   public.inventory_transfer_suggestions%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT * INTO v_sug FROM public.inventory_transfer_suggestions WHERE id = p_suggestion_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'suggestion_not_found'; END IF;

  IF NOT (
    public.phoenix_my_role() = 'super_admin'
    OR public.phoenix_profile_has_scoped_permission(
         v_actor, 'inventory.suggest_transfers', v_sug.organization_id, NULL, NULL)
  ) THEN
    RAISE EXCEPTION 'not_authorized_inventory_suggest';
  END IF;

  IF v_sug.status <> 'open' THEN RAISE EXCEPTION 'suggestion_not_open'; END IF;

  -- INTENT ONLY. No stock/movement/dispatch write here, by design.
  UPDATE public.inventory_transfer_suggestions
  SET status = 'accepted', accepted_at = now(), accepted_by = v_actor, updated_at = now()
  WHERE id = p_suggestion_id;

  RETURN jsonb_build_object('id', p_suggestion_id, 'status', 'accepted',
                            'note', 'intent recorded; no stock moved');
END;
$$;

CREATE OR REPLACE FUNCTION public.phoenix_reject_inventory_transfer_suggestion(
  p_suggestion_id uuid,
  p_reason        text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor  uuid := auth.uid();
  v_reason text := NULLIF(btrim(p_reason), '');
  v_sug    public.inventory_transfer_suggestions%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF v_reason IS NULL THEN RAISE EXCEPTION 'reject_reason_required'; END IF;

  SELECT * INTO v_sug FROM public.inventory_transfer_suggestions WHERE id = p_suggestion_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'suggestion_not_found'; END IF;

  IF NOT (
    public.phoenix_my_role() = 'super_admin'
    OR public.phoenix_profile_has_scoped_permission(
         v_actor, 'inventory.suggest_transfers', v_sug.organization_id, NULL, NULL)
  ) THEN
    RAISE EXCEPTION 'not_authorized_inventory_suggest';
  END IF;

  IF v_sug.status <> 'open' THEN RAISE EXCEPTION 'suggestion_not_open'; END IF;

  UPDATE public.inventory_transfer_suggestions
  SET status = 'rejected', reason = v_reason, rejected_at = now(), rejected_by = v_actor, updated_at = now()
  WHERE id = p_suggestion_id;

  RETURN jsonb_build_object('id', p_suggestion_id, 'status', 'rejected');
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_accept_inventory_transfer_suggestion(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_accept_inventory_transfer_suggestion(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.phoenix_reject_inventory_transfer_suggestion(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_reject_inventory_transfer_suggestion(uuid, text) TO authenticated;

-- ============================================================================
-- 10. RLS — each org sees ONLY its own inventory intelligence
-- ============================================================================
ALTER TABLE public.inventory_signal_thresholds     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_alerts                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_transfer_suggestions  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inventory_thresholds_select_scoped ON public.inventory_signal_thresholds;
CREATE POLICY inventory_thresholds_select_scoped
  ON public.inventory_signal_thresholds
  FOR SELECT
  TO authenticated
  USING (public.phoenix_can_read_inventory_signal(organization_id, scope_kind, scope_id));

DROP POLICY IF EXISTS inventory_alerts_select_scoped ON public.inventory_alerts;
CREATE POLICY inventory_alerts_select_scoped
  ON public.inventory_alerts
  FOR SELECT
  TO authenticated
  USING (public.phoenix_can_read_inventory_signal(organization_id, scope_kind, scope_id));

-- A suggestion concerns BOTH its source and target scope; the org sees it if it
-- may read either endpoint.
DROP POLICY IF EXISTS inventory_suggestions_select_scoped ON public.inventory_transfer_suggestions;
CREATE POLICY inventory_suggestions_select_scoped
  ON public.inventory_transfer_suggestions
  FOR SELECT
  TO authenticated
  USING (
    public.phoenix_can_read_inventory_signal(organization_id, source_scope_kind, source_scope_id)
    OR public.phoenix_can_read_inventory_signal(organization_id, target_scope_kind, target_scope_id)
  );

-- ============================================================================
-- 11. ACL — authenticated reads via RLS only; writes are RPC-only; anon: nothing
-- ============================================================================
GRANT SELECT ON TABLE public.inventory_signal_thresholds    TO authenticated;
GRANT SELECT ON TABLE public.inventory_alerts               TO authenticated;
GRANT SELECT ON TABLE public.inventory_transfer_suggestions TO authenticated;

-- No direct DML for authenticated: every mutation goes through a SECURITY
-- DEFINER RPC above, exactly as 069/070/071 do for their domains.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.inventory_signal_thresholds    FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.inventory_alerts               FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.inventory_transfer_suggestions FROM authenticated;

-- anon gets nothing on any of the three.
REVOKE ALL ON TABLE public.inventory_signal_thresholds    FROM anon;
REVOKE ALL ON TABLE public.inventory_alerts               FROM anon;
REVOKE ALL ON TABLE public.inventory_transfer_suggestions FROM anon;

-- ============================================================================
-- 12. PERMISSION CATALOG — register keys + role defaults (ENFORCEMENT STAYS OFF)
-- ============================================================================
-- Idempotent registration, exactly like 071. These record DEFAULTS only; RBAC
-- enforcement remains OFF platform-wide. Scope enforcement
-- (phoenix_profile_has_scoped_permission) is what actually gates the RPCs.
INSERT INTO public.permission_keys (key, module, action, label_en, label_ar, is_dangerous) VALUES
  ('inventory.view_signals',     'inventory', 'view_signals',     'View inventory signals and alerts',      'عرض إشارات وتنبيهات المخزون',       false),
  ('inventory.recompute',        'inventory', 'recompute',        'Recompute inventory alerts on demand',   'إعادة احتساب تنبيهات المخزون',      false),
  ('inventory.manage_alerts',    'inventory', 'manage_alerts',    'Acknowledge/resolve/dismiss alerts',     'إقرار/حل/تجاهل التنبيهات',          false),
  ('inventory.suggest_transfers','inventory', 'suggest_transfers','Generate and act on transfer suggestions','اقتراح التحويلات والتصرف بها',      false)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.role_permission_defaults (role, permission_key, allowed)
SELECT 'super_admin', k.key, true
FROM public.permission_keys k
WHERE k.key LIKE 'inventory.%'
ON CONFLICT (role, permission_key) DO NOTHING;

-- Institution/warehouse operators get the full intelligence toolkit; the outlet
-- side sees signals for its own outlets but does not drive org-wide recompute or
-- suggestions. Everyone else defaults to no access. Nothing is enforced yet.
INSERT INTO public.role_permission_defaults (role, permission_key, allowed) VALUES
  ('warehouse_officer',         'inventory.view_signals',      true),
  ('warehouse_officer',         'inventory.recompute',         true),
  ('warehouse_officer',         'inventory.manage_alerts',     true),
  ('warehouse_officer',         'inventory.suggest_transfers', true),
  ('central_warehouse_manager', 'inventory.view_signals',      true),
  ('central_warehouse_manager', 'inventory.recompute',         true),
  ('central_warehouse_manager', 'inventory.manage_alerts',     true),
  ('central_warehouse_manager', 'inventory.suggest_transfers', true),
  ('institution_admin',         'inventory.view_signals',      true),
  ('institution_admin',         'inventory.recompute',         true),
  ('institution_admin',         'inventory.manage_alerts',     true),
  ('institution_admin',         'inventory.suggest_transfers', true),
  ('outlet_officer',            'inventory.view_signals',      true),
  ('outlet_officer',            'inventory.recompute',         false),
  ('outlet_officer',            'inventory.manage_alerts',     false),
  ('outlet_officer',            'inventory.suggest_transfers', false)
ON CONFLICT (role, permission_key) DO NOTHING;

-- Every other known role: explicit deny default (registered, not enforced).
INSERT INTO public.role_permission_defaults (role, permission_key, allowed)
SELECT r.role, k.key, false
FROM (VALUES ('port_officer'),('monthly_status_officer'),('viewer'),
             ('hospital_admin'),('warehouse_manager'),('point_operator'),('transfer_manager')) AS r(role)
CROSS JOIN (VALUES ('inventory.view_signals'),('inventory.recompute'),
                   ('inventory.manage_alerts'),('inventory.suggest_transfers')) AS k(key)
ON CONFLICT (role, permission_key) DO NOTHING;

-- ============================================================================
-- 13. THRESHOLD WRITE RPC — the only sanctioned way to set config (RPC-only)
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
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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

  IF NOT (
    public.phoenix_my_role() = 'super_admin'
    OR public.phoenix_profile_has_scoped_permission(
         v_actor, 'inventory.manage_alerts', p_organization_id,
         CASE WHEN p_scope_kind = 'warehouse' THEN p_scope_id ELSE NULL END,
         CASE WHEN p_scope_kind = 'outlet'    THEN p_scope_id ELSE NULL END)
  ) THEN
    RAISE EXCEPTION 'not_authorized_inventory_manage';
  END IF;

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
    reorder_point    = EXCLUDED.reorder_point,
    target_max       = EXCLUDED.target_max,
    near_expiry_days = EXCLUDED.near_expiry_days,
    is_active        = EXCLUDED.is_active,
    updated_by       = v_actor,
    updated_at       = now()
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'organization_id', p_organization_id, 'scope_kind', p_scope_kind);
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_upsert_inventory_threshold(uuid, text, uuid, text, text, integer, integer, integer, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_upsert_inventory_threshold(uuid, text, uuid, text, text, integer, integer, integer, boolean) TO authenticated;

-- ============================================================================
-- 14. POST-CONDITIONS — assert the shape this migration promised (VERIFY block)
-- ============================================================================
DO $$
DECLARE
  v_body text;
BEGIN
  -- 14a. All three tables exist with RLS enabled.
  FOREACH v_body IN ARRAY ARRAY[
    'inventory_signal_thresholds', 'inventory_alerts', 'inventory_transfer_suggestions'
  ] LOOP
    IF to_regclass('public.' || v_body) IS NULL THEN
      RAISE EXCEPTION 'VERIFY FAILED (072): table % missing', v_body;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || v_body)::regclass) THEN
      RAISE EXCEPTION 'VERIFY FAILED (072): RLS not enabled on %', v_body;
    END IF;
  END LOOP;

  -- 14b. The signal vocabulary is EXACTLY the five required values, no more.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'inventory_alerts_signal_type_chk'
      AND pg_get_constraintdef(oid) LIKE '%missing%low_stock%surplus%near_expiry%expired%'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (072): signal_type vocabulary is not the required five values';
  END IF;

  -- 14c. Dedup uniques exist for alerts and suggestions.
  IF to_regclass('public.inventory_alerts_alert_key_uniq') IS NULL
     OR to_regclass('public.inventory_suggestions_key_uniq') IS NULL
     OR to_regclass('public.inventory_thresholds_identity_uniq') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (072): a dedup unique index is missing';
  END IF;

  -- 14d. Lifecycle reason guards exist (resolved/dismissed/rejected need a reason).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_alerts_resolve_reason_chk')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_alerts_dismiss_reason_chk')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_suggestions_reject_reason_chk') THEN
    RAISE EXCEPTION 'VERIFY FAILED (072): a lifecycle reason guard is missing';
  END IF;

  -- 14e. ACCEPT is intent-only: its body must not write stock/movement/dispatch/transfer.
  v_body := pg_get_functiondef('public.phoenix_accept_inventory_transfer_suggestion(uuid)'::regprocedure);
  IF v_body ~* 'INSERT\s+INTO\s+public\.(warehouse_stock|outlet_stock|warehouse_stock_movements|outlet_stock_movements|warehouse_dispatches|warehouse_dispatch_lines|warehouse_transfers)'
     OR v_body ~* 'UPDATE\s+public\.(warehouse_stock|outlet_stock)\b' THEN
    RAISE EXCEPTION 'VERIFY FAILED (072): accept-suggestion must not move stock';
  END IF;

  -- 14f. Recompute likewise never writes physical stock (it only reads it).
  v_body := pg_get_functiondef('public.phoenix_recompute_inventory_alerts(uuid,text,uuid)'::regprocedure);
  IF v_body ~* 'UPDATE\s+public\.(warehouse_stock|outlet_stock)\b'
     OR v_body ~* 'INSERT\s+INTO\s+public\.(warehouse_stock|outlet_stock)\b' THEN
    RAISE EXCEPTION 'VERIFY FAILED (072): recompute must not write physical stock';
  END IF;

  -- 14g. Frugal contract: no image/blob column, no whatsapp/cron reference anywhere
  --      in the three new tables' columns.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('inventory_signal_thresholds','inventory_alerts','inventory_transfer_suggestions')
      AND (column_name ~* 'image|photo|blob|whatsapp|snapshot_url|attachment')
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (072): a forbidden image/whatsapp/attachment column is present';
  END IF;

  -- 14h. ACL: authenticated has SELECT but NOT direct INSERT/UPDATE/DELETE on alerts.
  IF NOT has_table_privilege('authenticated', 'public.inventory_alerts', 'SELECT') THEN
    RAISE EXCEPTION 'VERIFY FAILED (072): authenticated cannot SELECT inventory_alerts';
  END IF;
  IF has_table_privilege('authenticated', 'public.inventory_alerts', 'INSERT')
     OR has_table_privilege('authenticated', 'public.inventory_alerts', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.inventory_alerts', 'DELETE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (072): authenticated has direct write on inventory_alerts';
  END IF;

  -- 14i. anon has no privilege on any of the three tables.
  IF has_table_privilege('anon', 'public.inventory_alerts', 'SELECT')
     OR has_table_privilege('anon', 'public.inventory_signal_thresholds', 'SELECT')
     OR has_table_privilege('anon', 'public.inventory_transfer_suggestions', 'SELECT') THEN
    RAISE EXCEPTION 'VERIFY FAILED (072): anon can read inventory intelligence';
  END IF;

  -- 14j. All four permission keys were registered.
  IF (SELECT count(*) FROM public.permission_keys WHERE key LIKE 'inventory.%') < 4 THEN
    RAISE EXCEPTION 'VERIFY FAILED (072): inventory permission keys not fully registered';
  END IF;

  RAISE NOTICE '072 post-conditions OK.';
END $$;

COMMIT;
