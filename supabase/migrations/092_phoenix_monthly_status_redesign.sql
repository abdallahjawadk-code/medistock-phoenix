-- ============================================================================
-- MONTHLY-STATUS-REDESIGN-092   ***PREPARED - DO NOT APPLY TO PRODUCTION***
--
-- MANUAL APPLY ONLY (SQL Editor), after owner review, AFTER 091. Never via
-- `supabase db push`. Replayed 001->092 on the disposable rig.
--
-- WHY
-- monthly_status_officer was removed (091) with NO successor mapping — the
-- capability it uniquely held (status_center.create/edit/resolve,
-- status_contacts.manage) was audited as unsafe to hand to any surviving
-- role by alias. This migration is the approved alternative: redesign the
-- capability as «الموقف المخزني الشهري», a scoped, closed-report workflow
-- owned by the five canonical roles instead of a role that no longer exists.
--
-- WHAT THIS ADDS (additive; no DROP/ALTER of any 001-091 table, no row
-- rewritten)
--   1. Seven new scoped permission keys (status_center.prepare_own /
--      classify_own / confirm_missing / review_submit_own / review_all /
--      return_for_clarification / approve_lock), granted per the approved
--      persona map — warehouse_officer prepares/classifies/confirms,
--      institution_admin submits, central_warehouse_manager reviews/returns/
--      approves+locks. status_contacts.manage is UNCHANGED (institution_admin
--      already holds it).
--   2. inventory.manage_thresholds NARROWED to central_warehouse_manager only
--      (was warehouse_officer + institution_admin + central_warehouse_manager
--      + outlet_officer under 072) — "Central Warehouse Manager ALONE sets
--      thresholds" per the approved contract. This REMOVES privilege from
--      three roles; it grants nothing new.
--   3. inventory_signal_thresholds gains safety_stock / lead_time_days
--      (nullable, CWM-configurable planning fields the 072 table did not
--      carry) via a new dedicated RPC — the existing 072 upsert RPC is left
--      untouched.
--   4. stocktakes / stocktake_count_lines — a minimal COMPLETED count-session
--      record (this phase does not build the full blind-count/session-
--      snapshot workflow that is Phase 2's job; it builds exactly the
--      evidence artefact suspected_missing classification requires: a real
--      counted-vs-expected comparison, attributable to one profile, at one
--      point in time).
--   5. inventory_status_reports / inventory_status_report_lines /
--      inventory_status_report_amendments — the report itself: one row per
--      institution per open cycle, prepared by warehouse_officer (server-
--      derived material list + suggested classification from balances vs
--      072 thresholds), classified per line (individual or bulk, always with
--      a server-validated preview before commit), submitted by
--      institution_admin, returned-for-clarification or approved+locked by
--      central_warehouse_manager. A locked report is immutable; any later
--      change is a NEW versioned report linked back via
--      inventory_status_report_amendments — never an edit to history.
--
-- SUSPECTED_MISSING CONTRACT (the one classification that can never be a
-- simple label): requires a real stocktakes/stocktake_count_lines row for
-- the SAME organization+material proving counted_qty < expected_qty (a
-- negative variance), plus a non-empty reason. warehouse_officer alone may
-- confirm suspected_missing -> confirmed (never institution_admin), and if
-- the SAME profile that performed the underlying count also tries to
-- confirm it, the confirmation is held PENDING until a SECOND, DIFFERENT
-- warehouse_officer profile confirms it (four-eyes on a self-counted
-- shortage). Confirming missing NEVER writes to warehouse_stock/outlet_stock
-- — it is a classification fact only; any balance correction is the
-- separate, already-guarded stock_corrections path (Phase 2).
--
-- NEAR-EXPIRY: this migration stores only the material's nearest batch
-- expiry_date per report line (a plain date, server-derived). The 5-tier
-- badge (<=9mo watch / 6-9 warning / 3-6 critical / <3 blocked / expired) is
-- computed client-side by the EXISTING src/shared/lib/expiry-risk.ts
-- getExpiryRiskTier — reused verbatim, not reimplemented server-side — so it
-- always agrees with every other near-expiry badge in the app and can
-- coexist with scarce/surplus/suspected_missing as the contract requires.
--
-- PRECONDITIONS: 001..091 applied.
-- ============================================================================

BEGIN;

DO $preconditions$
BEGIN
  IF to_regclass('public.inventory_signal_thresholds') IS NULL THEN
    RAISE EXCEPTION '092 PRECONDITION FAILED: migration 072 not applied.';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'profiles_role_check')
     LIKE '%monthly_status_officer%' THEN
    RAISE EXCEPTION '092 PRECONDITION FAILED: migration 091 not applied (profiles_role_check still accepts monthly_status_officer).';
  END IF;
END
$preconditions$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. New permission_keys
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO public.permission_keys (key, module, action, label_en, label_ar, is_dangerous)
VALUES
  ('status_center.prepare_own',          'status_center', 'prepare_own',          'Prepare own monthly status report',              'إعداد الموقف المخزني الشهري الخاص',            false),
  ('status_center.classify_own',         'status_center', 'classify_own',         'Classify materials on own report',               'تصنيف المواد في التقرير الخاص',                 false),
  ('status_center.confirm_missing',      'status_center', 'confirm_missing',      'Confirm a suspected-missing material',           'تأكيد مادة مشتبه بفقدانها',                     true ),
  ('status_center.review_submit_own',    'status_center', 'review_submit_own',    'Submit own institution report for review',       'تقديم تقرير المؤسسة للمراجعة',                  false),
  ('status_center.review_all',           'status_center', 'review_all',           'Review any institution report',                  'مراجعة تقرير أي مؤسسة',                         false),
  ('status_center.return_for_clarification','status_center','return_for_clarification','Return a report for clarification',         'إعادة تقرير للتوضيح',                           false),
  ('status_center.approve_lock',         'status_center', 'approve_lock',         'Approve and lock a report',                      'اعتماد التقرير وقفله',                          true )
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.role_permission_defaults (role, permission_key, allowed)
VALUES
  ('warehouse_officer',      'status_center.prepare_own',       true),
  ('warehouse_officer',      'status_center.classify_own',      true),
  ('warehouse_officer',      'status_center.confirm_missing',   true),
  ('institution_admin',      'status_center.review_submit_own', true),
  ('central_warehouse_manager','status_center.review_all',              true),
  ('central_warehouse_manager','status_center.return_for_clarification',true),
  ('central_warehouse_manager','status_center.approve_lock',            true)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = EXCLUDED.allowed;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1b. phoenix_status_center_authorized — the ORG-LEVEL authorization helper
--     every status_center RPC below uses for its non-resource-scoped actions
--     (prepare/classify/confirm/submit/review/return/approve are all
--     organization-level, never tied to one warehouse or outlet).
--
--     phoenix_profile_has_scoped_permission(actor, key, org, NULL, NULL) is
--     the WRONG tool here: its "both resources NULL" branch (rule 8) answers
--     "does this role have ORG-WIDE READ compatibility for a
--     warehouse/outlet-scoped key", and only v_org_wide_roles (institution_
--     admin, post-091) ever satisfies it — a warehouse_officer or
--     central_warehouse_manager who genuinely holds status_center.prepare_own
--     / review_all would still be refused. This helper instead does the
--     simple, correct thing for a genuinely org-level key: active profile,
--     matching organization, holds the key (or is super_admin).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.phoenix_status_center_authorized(p_organization_id uuid, p_key text)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor  uuid := auth.uid();
  v_role   text;
  v_status text;
  v_org    uuid;
BEGIN
  IF v_actor IS NULL OR p_organization_id IS NULL THEN RETURN false; END IF;
  SELECT role, status, organization_id INTO v_role, v_status, v_org
  FROM public.profiles WHERE id = v_actor;
  IF NOT FOUND OR v_status IS DISTINCT FROM 'active' THEN RETURN false; END IF;
  IF v_role = 'super_admin' THEN RETURN true; END IF;
  IF v_org IS DISTINCT FROM p_organization_id THEN RETURN false; END IF;
  RETURN public.phoenix_profile_has_permission(v_actor, p_key);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_status_center_authorized FROM anon;
GRANT EXECUTE ON FUNCTION public.phoenix_status_center_authorized TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Narrow inventory.manage_thresholds to central_warehouse_manager only.
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE public.role_permission_defaults
SET allowed = false
WHERE permission_key = 'inventory.manage_thresholds'
  AND role IN ('warehouse_officer', 'institution_admin', 'outlet_officer');

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Threshold planning fields (additive columns; existing 072 upsert RPC
--    untouched — a dedicated RPC below writes only these two).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.inventory_signal_thresholds
  ADD COLUMN IF NOT EXISTS safety_stock  integer,
  ADD COLUMN IF NOT EXISTS lead_time_days integer;

ALTER TABLE public.inventory_signal_thresholds
  DROP CONSTRAINT IF EXISTS inventory_thresholds_safety_stock_chk;
ALTER TABLE public.inventory_signal_thresholds
  ADD CONSTRAINT inventory_thresholds_safety_stock_chk CHECK (safety_stock IS NULL OR safety_stock >= 0);
ALTER TABLE public.inventory_signal_thresholds
  DROP CONSTRAINT IF EXISTS inventory_thresholds_lead_time_chk;
ALTER TABLE public.inventory_signal_thresholds
  ADD CONSTRAINT inventory_thresholds_lead_time_chk CHECK (lead_time_days IS NULL OR lead_time_days >= 0);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. stocktakes / stocktake_count_lines — the evidence artefact.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.stocktakes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  scope_kind       text NOT NULL CHECK (scope_kind IN ('warehouse', 'outlet')),
  scope_id         uuid NOT NULL,
  notes            text,
  performed_by     uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  performed_at     timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stocktakes_org_idx ON public.stocktakes (organization_id);
CREATE INDEX IF NOT EXISTS stocktakes_scope_idx ON public.stocktakes (scope_kind, scope_id);

CREATE TABLE IF NOT EXISTS public.stocktake_count_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stocktake_id       uuid NOT NULL REFERENCES public.stocktakes(id) ON DELETE CASCADE,
  scientific_name    text NOT NULL,
  national_code      text,
  expected_qty       integer NOT NULL CHECK (expected_qty >= 0),
  counted_qty        integer NOT NULL CHECK (counted_qty >= 0),
  variance           integer GENERATED ALWAYS AS (counted_qty - expected_qty) STORED,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stocktake_count_lines_sci_name_chk CHECK (btrim(scientific_name) = scientific_name AND scientific_name <> '')
);
CREATE INDEX IF NOT EXISTS stocktake_count_lines_stocktake_idx ON public.stocktake_count_lines (stocktake_id);

ALTER TABLE public.stocktakes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stocktake_count_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "stocktakes_select_scoped" ON public.stocktakes
  FOR SELECT TO authenticated
  USING (
    phoenix_my_role() = 'super_admin'
    OR organization_id = phoenix_my_org()
  );

CREATE POLICY "stocktake_count_lines_select_scoped" ON public.stocktake_count_lines
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.stocktakes s
      WHERE s.id = stocktake_count_lines.stocktake_id
        AND (phoenix_my_role() = 'super_admin' OR s.organization_id = phoenix_my_org())
    )
  );
-- No direct INSERT/UPDATE/DELETE policy — writes go only through
-- phoenix_status_record_stocktake (SECURITY DEFINER) below.

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. inventory_status_reports / _lines / _amendments
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.inventory_status_reports (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  status            text NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft', 'submitted', 'returned', 'locked')),
  version           integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  amendment_of      uuid REFERENCES public.inventory_status_reports(id) ON DELETE RESTRICT,
  prepared_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  prepared_at       timestamptz,
  submitted_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  submitted_at      timestamptz,
  approved_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at       timestamptz,
  locked_at         timestamptz,
  returned_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  returned_at       timestamptz,
  return_reason     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inventory_status_reports_org_idx ON public.inventory_status_reports (organization_id, status);
-- At most one non-locked (open) report per organization at a time — the
-- "prepare" RPC reopens/reuses it instead of ever forking a second open cycle.
CREATE UNIQUE INDEX IF NOT EXISTS inventory_status_reports_one_open_per_org
  ON public.inventory_status_reports (organization_id)
  WHERE status <> 'locked';

CREATE TABLE IF NOT EXISTS public.inventory_status_report_lines (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id                uuid NOT NULL REFERENCES public.inventory_status_reports(id) ON DELETE CASCADE,
  scientific_name          text NOT NULL,
  national_code            text,
  -- Server-derived at prepare time; never client-supplied.
  on_hand_qty              integer NOT NULL DEFAULT 0,
  reserved_qty             integer NOT NULL DEFAULT 0,
  in_transit_qty           integer NOT NULL DEFAULT 0,
  quarantine_qty           integer NOT NULL DEFAULT 0,
  central_qty              integer NOT NULL DEFAULT 0,
  supplementary_qty        integer NOT NULL DEFAULT 0,
  nearest_expiry_date      date,
  suggested_classification text NOT NULL CHECK (suggested_classification IN ('available', 'scarce', 'surplus')),
  classification            text CHECK (classification IN ('available', 'scarce', 'surplus', 'suspected_missing')),
  classification_reason     text,
  classification_overridden boolean NOT NULL DEFAULT false,
  classified_by             uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  classified_at             timestamptz,
  -- suspected_missing evidence
  stocktake_count_line_id   uuid REFERENCES public.stocktake_count_lines(id) ON DELETE RESTRICT,
  first_confirmed_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  confirmed_missing         boolean NOT NULL DEFAULT false,
  confirmed_by              uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  confirmed_at              timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT isrl_sci_name_chk CHECK (btrim(scientific_name) = scientific_name AND scientific_name <> ''),
  -- suspected_missing must carry evidence + a reason.
  CONSTRAINT isrl_missing_evidence_chk CHECK (
    classification IS DISTINCT FROM 'suspected_missing'
    OR (stocktake_count_line_id IS NOT NULL AND classification_reason IS NOT NULL AND btrim(classification_reason) <> '')
  ),
  -- confirmed_missing can only ever be true alongside classification = suspected_missing.
  CONSTRAINT isrl_confirmed_requires_missing_chk CHECK (NOT confirmed_missing OR classification = 'suspected_missing')
);
CREATE INDEX IF NOT EXISTS inventory_status_report_lines_report_idx ON public.inventory_status_report_lines (report_id);

CREATE TABLE IF NOT EXISTS public.inventory_status_report_amendments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  original_report_id  uuid NOT NULL REFERENCES public.inventory_status_reports(id) ON DELETE RESTRICT,
  amendment_report_id uuid NOT NULL REFERENCES public.inventory_status_reports(id) ON DELETE RESTRICT,
  reason              text NOT NULL CHECK (btrim(reason) <> ''),
  created_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT isra_distinct_chk CHECK (original_report_id <> amendment_report_id)
);
CREATE INDEX IF NOT EXISTS inventory_status_report_amendments_original_idx ON public.inventory_status_report_amendments (original_report_id);

ALTER TABLE public.inventory_status_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_status_report_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_status_report_amendments ENABLE ROW LEVEL SECURITY;

-- SELECT: super_admin sees all; central_warehouse_manager sees all (its
-- oversight review spans every institution, per the approved contract);
-- everyone else is org-scoped (institution_admin / warehouse_officer /
-- outlet_officer all see their own organization's report — "Outlet Officer
-- views own contribution only" is enforced by the read RPC that projects just
-- that outlet's slice, not by a coarser table-level policy; the raw table
-- stays org-scoped as the outer boundary).
CREATE POLICY "isr2_select_scoped" ON public.inventory_status_reports
  FOR SELECT TO authenticated
  USING (
    phoenix_my_role() IN ('super_admin', 'central_warehouse_manager')
    OR organization_id = phoenix_my_org()
  );

CREATE POLICY "isr2_lines_select_scoped" ON public.inventory_status_report_lines
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.inventory_status_reports r
      WHERE r.id = inventory_status_report_lines.report_id
        AND (phoenix_my_role() IN ('super_admin', 'central_warehouse_manager') OR r.organization_id = phoenix_my_org())
    )
  );

CREATE POLICY "isr2_amendments_select_scoped" ON public.inventory_status_report_amendments
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.inventory_status_reports r
      WHERE r.id = inventory_status_report_amendments.original_report_id
        AND (phoenix_my_role() IN ('super_admin', 'central_warehouse_manager') OR r.organization_id = phoenix_my_org())
    )
  );
-- No direct INSERT/UPDATE/DELETE policy on any of the three tables — every
-- write goes through the SECURITY DEFINER RPCs below, which enforce the
-- workflow states, the four-eyes rule, and the scoped permission keys.

-- ─────────────────────────────────────────────────────────────────────────────
-- 5b. phoenix_upsert_inventory_threshold — targeted CREATE OR REPLACE of the
--     072 RPC's org-default (scope_id NULL) branch ONLY. "Central Warehouse
--     Manager ALONE sets thresholds" (the approved contract) means CWM must
--     be able to set an organization's DEFAULT threshold row too, not only
--     rows for warehouses/outlets it happens to be individually assigned to
--     — but phoenix_profile_has_scoped_permission's v_org_wide_roles is
--     ['institution_admin'] only (091), and institution_admin no longer
--     holds inventory.manage_thresholds (§2 above), so nobody but
--     super_admin could reach the NULL-scope branch without this. Rather
--     than widen v_org_wide_roles (which would also hand
--     central_warehouse_manager org-wide read access to warehouse_stock /
--     warehouse_dispatches — unrelated domains that function gates), this
--     adds ONE narrow OR-clause, scoped to exactly this RPC's org-default
--     write path. Every other branch (per-warehouse, per-outlet, the INSERT
--     body, the audit log) is byte-for-byte identical to 072's version.
-- ─────────────────────────────────────────────────────────────────────────────
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
  IF p_near_expiry_days IS NOT NULL AND (p_near_expiry_days < 1 OR p_near_expiry_days > 270) THEN
    RAISE EXCEPTION 'near_expiry_days_out_of_range';
  END IF;
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
    -- 092: central_warehouse_manager may also set the org-default row,
    -- scoped to its OWN organization and gated on the same permission key
    -- (still requires the key to be true — narrowing §2 above still applies
    -- to whether the actor holds it at all).
    OR (p_scope_id IS NULL AND public.phoenix_my_role() = 'central_warehouse_manager'
        AND public.phoenix_my_org() = p_organization_id
        AND public.phoenix_profile_has_permission(v_actor, 'inventory.manage_thresholds'))
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. phoenix_set_inventory_threshold_planning — CWM-only safety_stock/lead_time.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.phoenix_set_inventory_threshold_planning(
  p_threshold_id  uuid,
  p_safety_stock  integer DEFAULT NULL,
  p_lead_time_days integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_row   public.inventory_signal_thresholds%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_safety_stock IS NOT NULL AND p_safety_stock < 0 THEN RAISE EXCEPTION 'invalid_safety_stock'; END IF;
  IF p_lead_time_days IS NOT NULL AND p_lead_time_days < 0 THEN RAISE EXCEPTION 'invalid_lead_time_days'; END IF;

  SELECT * INTO v_row FROM public.inventory_signal_thresholds WHERE id = p_threshold_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'threshold_not_found'; END IF;

  IF NOT (
    public.phoenix_my_role() = 'super_admin'
    OR (v_row.scope_id IS NOT NULL AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'inventory.manage_thresholds', v_row.organization_id,
          CASE WHEN v_row.scope_kind = 'warehouse' THEN v_row.scope_id END,
          CASE WHEN v_row.scope_kind = 'outlet' THEN v_row.scope_id END))
    OR (v_row.scope_id IS NULL AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'inventory.manage_thresholds', v_row.organization_id, NULL, NULL))
    -- Same org-default carve-out as phoenix_upsert_inventory_threshold above.
    OR (v_row.scope_id IS NULL AND public.phoenix_my_role() = 'central_warehouse_manager'
        AND public.phoenix_my_org() = v_row.organization_id
        AND public.phoenix_profile_has_permission(v_actor, 'inventory.manage_thresholds'))
  ) THEN RAISE EXCEPTION 'not_authorized_inventory_manage_thresholds'; END IF;

  UPDATE public.inventory_signal_thresholds
  SET safety_stock = p_safety_stock, lead_time_days = p_lead_time_days,
      updated_by = v_actor, updated_at = now()
  WHERE id = p_threshold_id;

  RETURN jsonb_build_object('ok', true, 'threshold_id', p_threshold_id);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_set_inventory_threshold_planning FROM anon;
GRANT EXECUTE ON FUNCTION public.phoenix_set_inventory_threshold_planning TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. phoenix_status_record_stocktake — the evidence-recording RPC.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.phoenix_status_record_stocktake(
  p_organization_id uuid,
  p_scope_kind      text,
  p_scope_id        uuid,
  p_notes           text,
  p_lines           jsonb  -- [{scientific_name, national_code, counted_qty}]
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor       uuid := auth.uid();
  v_stocktake_id uuid;
  v_line        jsonb;
  v_name        text;
  v_code        text;
  v_counted     integer;
  v_expected    integer;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_scope_kind NOT IN ('warehouse', 'outlet') THEN RAISE EXCEPTION 'invalid_scope_kind'; END IF;
  IF p_scope_id IS NULL THEN RAISE EXCEPTION 'scope_id_required'; END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'lines_required';
  END IF;

  IF NOT (
    public.phoenix_my_role() = 'super_admin'
    OR (p_scope_kind = 'warehouse' AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'status_center.confirm_missing', p_organization_id, p_scope_id, NULL))
    OR (p_scope_kind = 'outlet' AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'status_center.confirm_missing', p_organization_id, NULL, p_scope_id))
  ) THEN RAISE EXCEPTION 'not_authorized_status_center_confirm_missing'; END IF;

  INSERT INTO public.stocktakes (organization_id, scope_kind, scope_id, notes, performed_by)
  VALUES (p_organization_id, p_scope_kind, p_scope_id, NULLIF(btrim(coalesce(p_notes,'')), ''), v_actor)
  RETURNING id INTO v_stocktake_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_name    := NULLIF(btrim(v_line->>'scientific_name'), '');
    v_code    := NULLIF(btrim(coalesce(v_line->>'national_code', '')), '');
    v_counted := (v_line->>'counted_qty')::integer;
    IF v_name IS NULL THEN RAISE EXCEPTION 'scientific_name_required'; END IF;
    IF v_counted IS NULL OR v_counted < 0 THEN RAISE EXCEPTION 'invalid_counted_qty'; END IF;

    -- Server-computed expected quantity: current on-hand for that material at
    -- that scope, at count time — never client-supplied.
    IF p_scope_kind = 'warehouse' THEN
      SELECT COALESCE(SUM(on_hand_quantity), 0) INTO v_expected
      FROM public.warehouse_stock
      WHERE warehouse_id = p_scope_id AND organization_id = p_organization_id
        AND lower(scientific_name) = lower(v_name)
        AND coalesce(national_code, '') = coalesce(v_code, '');
    ELSE
      SELECT COALESCE(SUM(on_hand_quantity), 0) INTO v_expected
      FROM public.outlet_stock
      WHERE distribution_point_id = p_scope_id AND organization_id = p_organization_id
        AND lower(scientific_name) = lower(v_name)
        AND coalesce(national_code, '') = coalesce(v_code, '');
    END IF;

    INSERT INTO public.stocktake_count_lines (stocktake_id, scientific_name, national_code, expected_qty, counted_qty)
    VALUES (v_stocktake_id, v_name, v_code, v_expected, v_counted);
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'stocktake_id', v_stocktake_id);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_status_record_stocktake FROM anon;
GRANT EXECUTE ON FUNCTION public.phoenix_status_record_stocktake TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. phoenix_status_prepare_report — creates/reopens the org's open report and
--    (re)generates its lines from live stock. Idempotent on an existing
--    draft: re-running refreshes derived quantities without discarding
--    already-set classifications for materials still present.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.phoenix_status_prepare_report(p_organization_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor     uuid := auth.uid();
  v_report_id uuid;
  v_status    text;
  v_mat       record;
  v_line_id   uuid;
  v_existing  record;
  v_suggested text;
  v_thr_reorder_point integer;
  v_thr_target_max    integer;
  v_available integer;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public.phoenix_status_center_authorized(p_organization_id, 'status_center.prepare_own') THEN
    RAISE EXCEPTION 'not_authorized_status_center_prepare_own';
  END IF;

  SELECT id, status INTO v_report_id, v_status
  FROM public.inventory_status_reports
  WHERE organization_id = p_organization_id AND status <> 'locked'
  ORDER BY created_at DESC LIMIT 1;

  IF v_report_id IS NULL THEN
    INSERT INTO public.inventory_status_reports (organization_id, status, prepared_by, prepared_at)
    VALUES (p_organization_id, 'draft', v_actor, now())
    RETURNING id INTO v_report_id;
  ELSIF v_status = 'returned' THEN
    -- Re-opening a returned report for another prepare/classify pass.
    UPDATE public.inventory_status_reports SET status = 'draft', updated_at = now() WHERE id = v_report_id;
  ELSIF v_status = 'submitted' THEN
    RAISE EXCEPTION 'report_already_submitted';
  END IF;

  -- Materials present across warehouse_stock + outlet_stock for this org.
  FOR v_mat IN
    SELECT scientific_name, national_code FROM public.warehouse_stock
    WHERE organization_id = p_organization_id
    UNION
    SELECT scientific_name, national_code FROM public.outlet_stock
    WHERE organization_id = p_organization_id
  LOOP
    SELECT id INTO v_existing
    FROM public.inventory_status_report_lines
    WHERE report_id = v_report_id
      AND lower(scientific_name) = lower(v_mat.scientific_name)
      AND coalesce(national_code, '') = coalesce(v_mat.national_code, '');

    DECLARE
      v_on_hand   integer;
      v_reserved  integer;
      v_in_transit integer;
      v_quarantine integer;
      v_central   integer;
      v_supp      integer;
      v_nearest   date;
    BEGIN
      SELECT COALESCE(SUM(on_hand_quantity), 0), COALESCE(SUM(reserved_quantity), 0),
             COALESCE(SUM(on_hand_quantity) FILTER (WHERE purchase_origin = 'central' OR supply_type IN ('aid','kimadia')), 0),
             COALESCE(SUM(on_hand_quantity) FILTER (WHERE purchase_origin = 'supplementary'), 0),
             MIN(expiry_date)
        INTO v_on_hand, v_reserved, v_central, v_supp, v_nearest
      FROM public.warehouse_stock
      WHERE organization_id = p_organization_id
        AND lower(scientific_name) = lower(v_mat.scientific_name)
        AND coalesce(national_code, '') = coalesce(v_mat.national_code, '');

      SELECT v_on_hand + COALESCE(SUM(os.on_hand_quantity), 0),
             v_reserved + COALESCE(SUM(os.reserved_quantity), 0),
             LEAST(COALESCE(v_nearest, MIN(os.expiry_date)), COALESCE(MIN(os.expiry_date), v_nearest))
        INTO v_on_hand, v_reserved, v_nearest
      FROM public.outlet_stock os
      WHERE os.organization_id = p_organization_id
        AND lower(os.scientific_name) = lower(v_mat.scientific_name)
        AND coalesce(os.national_code, '') = coalesce(v_mat.national_code, '');

      SELECT COALESCE(SUM(quantity), 0) INTO v_quarantine
      FROM public.warehouse_quarantine_stock
      WHERE organization_id = p_organization_id
        AND lower(scientific_name) = lower(v_mat.scientific_name)
        AND coalesce(national_code, '') = coalesce(v_mat.national_code, '');

      SELECT COALESCE(SUM(sent_quantity - COALESCE(received_quantity, 0)), 0) INTO v_in_transit
      FROM public.warehouse_dispatch_lines
      WHERE organization_id = p_organization_id
        AND status IN ('pending', 'sent', 'partially_accepted')
        AND lower(scientific_name) = lower(v_mat.scientific_name)
        AND coalesce(national_code, '') = coalesce(v_mat.national_code, '');

      -- Suggested classification from balances vs 072 thresholds. The report
      -- is org-level, but a per-warehouse/per-outlet threshold is more
      -- specific than an org-wide default when both exist for this material
      -- (scope_id NULLS LAST prefers the scoped row). Reset both scalars each
      -- iteration — a zero-row SELECT INTO otherwise leaves the prior
      -- material's values in place.
      v_thr_reorder_point := NULL;
      v_thr_target_max := NULL;
      SELECT reorder_point, target_max INTO v_thr_reorder_point, v_thr_target_max
      FROM public.inventory_signal_thresholds
      WHERE organization_id = p_organization_id AND is_active
        AND lower(scientific_name) = lower(v_mat.scientific_name)
        AND coalesce(national_code, '') = coalesce(v_mat.national_code, '')
      ORDER BY scope_id NULLS LAST, national_code NULLS LAST LIMIT 1;

      v_available := v_on_hand - v_reserved;
      v_suggested := CASE
        WHEN v_thr_target_max IS NOT NULL AND v_available > v_thr_target_max THEN 'surplus'
        WHEN v_thr_reorder_point IS NOT NULL AND v_available <= v_thr_reorder_point THEN 'scarce'
        ELSE 'available'
      END;

      IF v_existing.id IS NULL THEN
        INSERT INTO public.inventory_status_report_lines (
          report_id, scientific_name, national_code,
          on_hand_qty, reserved_qty, in_transit_qty, quarantine_qty, central_qty, supplementary_qty,
          nearest_expiry_date, suggested_classification
        ) VALUES (
          v_report_id, v_mat.scientific_name, v_mat.national_code,
          v_on_hand, v_reserved, v_in_transit, v_quarantine, v_central, v_supp,
          v_nearest, v_suggested
        );
      ELSE
        UPDATE public.inventory_status_report_lines SET
          on_hand_qty = v_on_hand, reserved_qty = v_reserved, in_transit_qty = v_in_transit,
          quarantine_qty = v_quarantine, central_qty = v_central, supplementary_qty = v_supp,
          nearest_expiry_date = v_nearest, suggested_classification = v_suggested,
          updated_at = now()
        WHERE id = v_existing.id;
      END IF;
    END;
  END LOOP;

  UPDATE public.inventory_status_reports SET prepared_by = v_actor, prepared_at = now(), updated_at = now()
  WHERE id = v_report_id;

  RETURN jsonb_build_object('ok', true, 'report_id', v_report_id);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_status_prepare_report FROM anon;
GRANT EXECUTE ON FUNCTION public.phoenix_status_prepare_report TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. phoenix_status_classify_lines — individual OR bulk (array of one or many),
--    always validated as one atomic batch (all-or-nothing).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.phoenix_status_classify_lines(
  p_report_id uuid,
  p_lines     jsonb  -- [{line_id, classification, reason, stocktake_count_line_id}]
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor  uuid := auth.uid();
  v_report public.inventory_status_reports%ROWTYPE;
  v_item   jsonb;
  v_line   public.inventory_status_report_lines%ROWTYPE;
  v_class  text;
  v_reason text;
  v_stl_id uuid;
  v_stl    record;
  v_n      integer := 0;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'lines_required';
  END IF;

  SELECT * INTO v_report FROM public.inventory_status_reports WHERE id = p_report_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'report_not_found'; END IF;
  IF v_report.status NOT IN ('draft', 'returned') THEN RAISE EXCEPTION 'report_not_editable'; END IF;

  IF NOT public.phoenix_status_center_authorized(v_report.organization_id, 'status_center.classify_own') THEN
    RAISE EXCEPTION 'not_authorized_status_center_classify_own';
  END IF;

  IF v_report.status = 'returned' THEN
    UPDATE public.inventory_status_reports SET status = 'draft', updated_at = now() WHERE id = p_report_id;
  END IF;

  -- Validate the WHOLE batch before applying ANY of it.
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_class := v_item->>'classification';
    IF v_class NOT IN ('available', 'scarce', 'surplus', 'suspected_missing') THEN
      RAISE EXCEPTION 'invalid_classification: %', v_class;
    END IF;
    SELECT * INTO v_line FROM public.inventory_status_report_lines
      WHERE id = (v_item->>'line_id')::uuid AND report_id = p_report_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'line_not_found: %', v_item->>'line_id'; END IF;

    IF v_class = 'suspected_missing' THEN
      v_reason := NULLIF(btrim(coalesce(v_item->>'reason', '')), '');
      v_stl_id := NULLIF(v_item->>'stocktake_count_line_id', '')::uuid;
      IF v_reason IS NULL THEN RAISE EXCEPTION 'reason_required_for_suspected_missing'; END IF;
      IF v_stl_id IS NULL THEN RAISE EXCEPTION 'stocktake_evidence_required'; END IF;

      SELECT scl.variance, s.organization_id, scl.scientific_name, scl.national_code
        INTO v_stl
      FROM public.stocktake_count_lines scl
      JOIN public.stocktakes s ON s.id = scl.stocktake_id
      WHERE scl.id = v_stl_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'stocktake_evidence_not_found'; END IF;
      IF v_stl.organization_id <> v_report.organization_id THEN RAISE EXCEPTION 'stocktake_evidence_wrong_organization'; END IF;
      IF lower(v_stl.scientific_name) <> lower(v_line.scientific_name)
         OR coalesce(v_stl.national_code,'') <> coalesce(v_line.national_code,'') THEN
        RAISE EXCEPTION 'stocktake_evidence_material_mismatch';
      END IF;
      IF v_stl.variance >= 0 THEN RAISE EXCEPTION 'stocktake_evidence_not_a_shortage'; END IF;
    END IF;
    v_n := v_n + 1;
  END LOOP;

  -- Apply.
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_class := v_item->>'classification';
    SELECT * INTO v_line FROM public.inventory_status_report_lines WHERE id = (v_item->>'line_id')::uuid;
    v_reason := NULLIF(btrim(coalesce(v_item->>'reason', '')), '');
    v_stl_id := NULLIF(v_item->>'stocktake_count_line_id', '')::uuid;

    UPDATE public.inventory_status_report_lines SET
      classification = v_class,
      classification_reason = v_reason,
      classification_overridden = (v_class <> v_line.suggested_classification),
      stocktake_count_line_id = CASE WHEN v_class = 'suspected_missing' THEN v_stl_id ELSE NULL END,
      -- Reclassifying away from suspected_missing clears any prior confirmation.
      confirmed_missing = CASE WHEN v_class = 'suspected_missing' THEN v_line.confirmed_missing ELSE false END,
      confirmed_by = CASE WHEN v_class = 'suspected_missing' THEN v_line.confirmed_by ELSE NULL END,
      confirmed_at = CASE WHEN v_class = 'suspected_missing' THEN v_line.confirmed_at ELSE NULL END,
      first_confirmed_by = CASE WHEN v_class = 'suspected_missing' THEN v_line.first_confirmed_by ELSE NULL END,
      classified_by = v_actor, classified_at = now(), updated_at = now()
    WHERE id = v_line.id;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'classified', v_n);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_status_classify_lines FROM anon;
GRANT EXECUTE ON FUNCTION public.phoenix_status_classify_lines TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. phoenix_status_confirm_missing — four-eyes on a self-counted shortage.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.phoenix_status_confirm_missing(p_line_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_line     public.inventory_status_report_lines%ROWTYPE;
  v_report   public.inventory_status_reports%ROWTYPE;
  v_counter  uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT * INTO v_line FROM public.inventory_status_report_lines WHERE id = p_line_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'line_not_found'; END IF;
  SELECT * INTO v_report FROM public.inventory_status_reports WHERE id = v_line.report_id;
  IF v_report.status NOT IN ('draft', 'returned') THEN RAISE EXCEPTION 'report_not_editable'; END IF;
  IF v_line.classification IS DISTINCT FROM 'suspected_missing' THEN RAISE EXCEPTION 'not_suspected_missing'; END IF;
  IF v_line.stocktake_count_line_id IS NULL THEN RAISE EXCEPTION 'missing_stocktake_evidence'; END IF;
  IF v_line.confirmed_missing THEN RAISE EXCEPTION 'already_confirmed'; END IF;

  IF NOT public.phoenix_status_center_authorized(v_report.organization_id, 'status_center.confirm_missing') THEN
    RAISE EXCEPTION 'not_authorized_status_center_confirm_missing';
  END IF;

  SELECT s.performed_by INTO v_counter
  FROM public.stocktake_count_lines scl JOIN public.stocktakes s ON s.id = scl.stocktake_id
  WHERE scl.id = v_line.stocktake_count_line_id;

  IF v_counter = v_actor THEN
    -- The counting officer confirming their own count: hold pending a SECOND,
    -- different profile.
    IF v_line.first_confirmed_by IS NOT NULL AND v_line.first_confirmed_by <> v_actor THEN
      UPDATE public.inventory_status_report_lines
      SET confirmed_missing = true, confirmed_by = v_actor, confirmed_at = now(), updated_at = now()
      WHERE id = p_line_id;
      RETURN jsonb_build_object('ok', true, 'confirmed', true);
    END IF;
    UPDATE public.inventory_status_report_lines
    SET first_confirmed_by = v_actor, updated_at = now()
    WHERE id = p_line_id;
    RETURN jsonb_build_object('ok', true, 'confirmed', false, 'reason', 'PENDING_SECOND_CONFIRMATION_SELF_COUNTED');
  END IF;

  IF v_line.first_confirmed_by IS NOT NULL AND v_line.first_confirmed_by <> v_actor THEN
    UPDATE public.inventory_status_report_lines
    SET confirmed_missing = true, confirmed_by = v_actor, confirmed_at = now(), updated_at = now()
    WHERE id = p_line_id;
    RETURN jsonb_build_object('ok', true, 'confirmed', true);
  END IF;

  -- Someone else counted it: a single independent confirmation suffices.
  UPDATE public.inventory_status_report_lines
  SET confirmed_missing = true, confirmed_by = v_actor, confirmed_at = now(), updated_at = now()
  WHERE id = p_line_id;
  RETURN jsonb_build_object('ok', true, 'confirmed', true);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_status_confirm_missing FROM anon;
GRANT EXECUTE ON FUNCTION public.phoenix_status_confirm_missing TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. Submit / return / approve+lock / amendment.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.phoenix_status_submit_report(p_report_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor  uuid := auth.uid();
  v_report public.inventory_status_reports%ROWTYPE;
  v_unclassified integer;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  SELECT * INTO v_report FROM public.inventory_status_reports WHERE id = p_report_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'report_not_found'; END IF;
  IF v_report.status NOT IN ('draft', 'returned') THEN RAISE EXCEPTION 'report_not_submittable'; END IF;

  IF NOT public.phoenix_status_center_authorized(v_report.organization_id, 'status_center.review_submit_own') THEN
    RAISE EXCEPTION 'not_authorized_status_center_review_submit_own';
  END IF;

  SELECT count(*) INTO v_unclassified FROM public.inventory_status_report_lines
  WHERE report_id = p_report_id AND classification IS NULL;
  IF v_unclassified > 0 THEN RAISE EXCEPTION 'unclassified_lines_remain: %', v_unclassified; END IF;

  SELECT count(*) INTO v_unclassified FROM public.inventory_status_report_lines
  WHERE report_id = p_report_id AND classification = 'suspected_missing' AND NOT confirmed_missing;
  IF v_unclassified > 0 THEN RAISE EXCEPTION 'unconfirmed_suspected_missing_lines_remain: %', v_unclassified; END IF;

  UPDATE public.inventory_status_reports
  SET status = 'submitted', submitted_by = v_actor, submitted_at = now(), updated_at = now()
  WHERE id = p_report_id;

  RETURN jsonb_build_object('ok', true);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_status_submit_report FROM anon;
GRANT EXECUTE ON FUNCTION public.phoenix_status_submit_report TO authenticated;

CREATE OR REPLACE FUNCTION public.phoenix_status_return_for_clarification(p_report_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor  uuid := auth.uid();
  v_report public.inventory_status_reports%ROWTYPE;
  v_reason text := NULLIF(btrim(coalesce(p_reason,'')), '');
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF v_reason IS NULL THEN RAISE EXCEPTION 'reason_required'; END IF;
  SELECT * INTO v_report FROM public.inventory_status_reports WHERE id = p_report_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'report_not_found'; END IF;
  IF v_report.status <> 'submitted' THEN RAISE EXCEPTION 'report_not_submitted'; END IF;

  IF NOT public.phoenix_status_center_authorized(v_report.organization_id, 'status_center.return_for_clarification') THEN
    RAISE EXCEPTION 'not_authorized_status_center_return_for_clarification';
  END IF;

  UPDATE public.inventory_status_reports
  SET status = 'returned', returned_by = v_actor, returned_at = now(), return_reason = v_reason, updated_at = now()
  WHERE id = p_report_id;

  RETURN jsonb_build_object('ok', true);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_status_return_for_clarification FROM anon;
GRANT EXECUTE ON FUNCTION public.phoenix_status_return_for_clarification TO authenticated;

CREATE OR REPLACE FUNCTION public.phoenix_status_approve_lock_report(p_report_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor  uuid := auth.uid();
  v_report public.inventory_status_reports%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  SELECT * INTO v_report FROM public.inventory_status_reports WHERE id = p_report_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'report_not_found'; END IF;
  IF v_report.status <> 'submitted' THEN RAISE EXCEPTION 'report_not_submitted'; END IF;

  IF NOT public.phoenix_status_center_authorized(v_report.organization_id, 'status_center.approve_lock') THEN
    RAISE EXCEPTION 'not_authorized_status_center_approve_lock';
  END IF;

  UPDATE public.inventory_status_reports
  SET status = 'locked', approved_by = v_actor, approved_at = now(), locked_at = now(), updated_at = now()
  WHERE id = p_report_id;

  RETURN jsonb_build_object('ok', true);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_status_approve_lock_report FROM anon;
GRANT EXECUTE ON FUNCTION public.phoenix_status_approve_lock_report TO authenticated;

CREATE OR REPLACE FUNCTION public.phoenix_status_create_amendment(p_report_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_original   public.inventory_status_reports%ROWTYPE;
  v_new_id     uuid;
  v_reason     text := NULLIF(btrim(coalesce(p_reason,'')), '');
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF v_reason IS NULL THEN RAISE EXCEPTION 'reason_required'; END IF;
  SELECT * INTO v_original FROM public.inventory_status_reports WHERE id = p_report_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'report_not_found'; END IF;
  IF v_original.status <> 'locked' THEN RAISE EXCEPTION 'only_locked_reports_can_be_amended'; END IF;

  IF NOT public.phoenix_status_center_authorized(v_original.organization_id, 'status_center.approve_lock') THEN
    RAISE EXCEPTION 'not_authorized_status_center_approve_lock';
  END IF;

  -- A locked report is the org's ONLY open cycle exception: amending it opens
  -- a new one WITHOUT violating the one-open-report-per-org index (the
  -- original stays 'locked' — only the new row is 'draft').
  INSERT INTO public.inventory_status_reports (organization_id, status, version, amendment_of, prepared_by, prepared_at)
  VALUES (v_original.organization_id, 'draft', v_original.version + 1, v_original.id, v_actor, now())
  RETURNING id INTO v_new_id;

  INSERT INTO public.inventory_status_report_lines (
    report_id, scientific_name, national_code, on_hand_qty, reserved_qty, in_transit_qty,
    quarantine_qty, central_qty, supplementary_qty, nearest_expiry_date, suggested_classification
  )
  SELECT v_new_id, scientific_name, national_code, on_hand_qty, reserved_qty, in_transit_qty,
         quarantine_qty, central_qty, supplementary_qty, nearest_expiry_date, suggested_classification
  FROM public.inventory_status_report_lines WHERE report_id = p_report_id;

  INSERT INTO public.inventory_status_report_amendments (original_report_id, amendment_report_id, reason, created_by)
  VALUES (p_report_id, v_new_id, v_reason, v_actor);

  RETURN jsonb_build_object('ok', true, 'amendment_report_id', v_new_id);
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_status_create_amendment FROM anon;
GRANT EXECUTE ON FUNCTION public.phoenix_status_create_amendment TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 12. Outlet-officer read projection: "own contribution only" — a dedicated
--     RPC rather than a raw-table policy, so the redaction lives in ONE place.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.phoenix_status_get_outlet_contribution(p_report_id uuid, p_distribution_point_id uuid)
RETURNS TABLE (
  scientific_name text, national_code text, on_hand_qty integer, reserved_qty integer,
  classification text, nearest_expiry_date date
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor  uuid := auth.uid();
  v_report public.inventory_status_reports%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  SELECT * INTO v_report FROM public.inventory_status_reports WHERE id = p_report_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'report_not_found'; END IF;

  -- "Own contribution only": gated on the actor's real assignment to THIS
  -- outlet, not on a permission key — an outlet_officer's whole authority
  -- here comes from being the assigned officer, exactly like every other
  -- outlet-scoped read in the app (availability.view is intentionally NOT
  -- required: outlet_officer holds no permission keys by default at all).
  IF NOT (
    public.phoenix_my_role() = 'super_admin'
    OR (public.phoenix_my_org() = v_report.organization_id
        AND (public.phoenix_my_role() IN ('institution_admin', 'central_warehouse_manager')
             OR public.phoenix_profile_has_point_assignment(v_actor, p_distribution_point_id)))
  ) THEN RAISE EXCEPTION 'not_authorized'; END IF;

  RETURN QUERY
  SELECT l.scientific_name, l.national_code,
         COALESCE(os.on_hand_quantity, 0), COALESCE(os.reserved_quantity, 0),
         l.classification, l.nearest_expiry_date
  FROM public.inventory_status_report_lines l
  JOIN public.outlet_stock os
    ON os.distribution_point_id = p_distribution_point_id
   AND os.organization_id = v_report.organization_id
   AND lower(os.scientific_name) = lower(l.scientific_name)
   AND coalesce(os.national_code,'') = coalesce(l.national_code,'')
  WHERE l.report_id = p_report_id;
END;
$$;
REVOKE ALL ON FUNCTION public.phoenix_status_get_outlet_contribution FROM anon;
GRANT EXECUTE ON FUNCTION public.phoenix_status_get_outlet_contribution TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 13. Verify
-- ─────────────────────────────────────────────────────────────────────────────
DO $verify$
BEGIN
  ASSERT (SELECT count(*) FROM public.permission_keys WHERE key LIKE 'status_center.%' AND key NOT IN
    ('status_center.view','status_center.create','status_center.edit','status_center.resolve')) = 7,
    'VERIFY FAILED (092): expected 7 new status_center scoped keys';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.role_permission_defaults
    WHERE permission_key = 'inventory.manage_thresholds' AND allowed
      AND role IN ('warehouse_officer', 'institution_admin', 'outlet_officer')
  ), 'VERIFY FAILED (092): inventory.manage_thresholds still granted outside central_warehouse_manager';
  ASSERT to_regclass('public.inventory_status_reports') IS NOT NULL, 'VERIFY FAILED (092): inventory_status_reports missing';
  ASSERT to_regclass('public.inventory_status_report_lines') IS NOT NULL, 'VERIFY FAILED (092): inventory_status_report_lines missing';
  ASSERT to_regclass('public.inventory_status_report_amendments') IS NOT NULL, 'VERIFY FAILED (092): inventory_status_report_amendments missing';
  ASSERT to_regclass('public.stocktakes') IS NOT NULL, 'VERIFY FAILED (092): stocktakes missing';
  ASSERT to_regclass('public.stocktake_count_lines') IS NOT NULL, 'VERIFY FAILED (092): stocktake_count_lines missing';
  RAISE NOTICE 'MONTHLY-STATUS-REDESIGN-092: verified.';
END
$verify$;

COMMIT;
