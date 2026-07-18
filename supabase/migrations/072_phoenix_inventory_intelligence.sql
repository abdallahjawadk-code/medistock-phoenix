-- ============================================================================
-- INVENTORY-INTELLIGENCE-072-A  (Review Round 3)
--
-- MANUAL APPLY ONLY. DO NOT use supabase db push or any automated runner.
--
-- VERIFICATION STATUS: authored, not applied, not executed against a
-- disposable PostgreSQL database. Validation used static analysis and the
-- test suite only (matching 044-071's own convention). Apply to a
-- staging/preview database and confirm every post-condition passes BEFORE
-- this is treated as ready for production. Round 3 hardening below; still a
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
-- suggests FEASIBLE, NON-OVERSUBSCRIBING, BATCH-LEVEL surplus->shortage
-- transfers WITHOUT executing them. It moves no stock and is frugal (no
-- images, no snapshots, no cron, no WhatsApp).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ROUND-3 CORRECTNESS BOUNDARIES (why this file looks the way it does)
-- ─────────────────────────────────────────────────────────────────────────────
--  1. 036-041 INTEGRATION, NOT A PARALLEL ENGINE. Cross-organization movement
--     stays the job of the approved 036-041 inter-org alert/exchange system.
--     A cross-org suggestion here is a RECOMMENDATION ONLY: accepting it
--     REQUIRES a reference to a live inter_org_exchange_requests row (created
--     through the EXISTING 041 RPC contract, never by this file), stored in
--     inventory_transfer_suggestions.exchange_request_id and validated for
--     matching organizations + material. This migration NEVER writes to
--     inter_org_exchange_requests/events and never transitions their status.
--     KNOWN INTEGRATION GAP, stated honestly: the 036-041 engine models
--     exchanges at the item_availability (outlet projection) level; it has no
--     representation of warehouse-level stock. A warehouse-level cross-org
--     suggestion can therefore only be ACCEPTED once the two organizations
--     have opened a corresponding exchange request through the existing
--     engine. Until then it stays an open recommendation. That is the safe
--     boundary; writing warehouse rows into the exchange tables on unproven
--     assumptions is exactly what this round refuses to do.
--  2. DATA-DERIVED CROSS-ORG QUANTITIES. There is NO client-supplied quantity
--     anywhere in suggestion generation. Cross-org suggestions require a real
--     surplus alert at the source, a real missing/low_stock alert at the
--     target, an active warehouse_supply_route between the two warehouses,
--     and at least one eligible FEFO batch. Each minted suggestion is capped:
--       suggested_quantity <= remaining source surplus
--       suggested_quantity <= remaining target shortfall
--       suggested_quantity <= remaining batch availability
--     where "remaining" subtracts every other open/accepted suggestion drawing
--     on the same source, batch, or target. super_admin can RUN the
--     computation across organizations but cannot invent a quantity.
--  3. BATCH-LEVEL FEFO. Every suggestion names EXACTLY ONE stock row
--     (source_stock_id) and never exceeds that batch's availability. A target
--     needing more than one batch gets SEPARATE suggestions, one per batch,
--     ordered expiry_date ASC NULLS LAST then id ASC. suggestion_key embeds
--     the stock row (and provenance line) so batches never collide.
--     Conservation, enforced by the structural guard (§9) and the allocation:
--       Σ suggestions per batch  <= that batch's available_quantity
--       Σ suggestions per source <= that source's surplus headroom
--       Σ suggestions per target <= that target's shortfall
--  4. PROVEN outlet->warehouse RETURNABILITY (071). An outlet->warehouse
--     suggestion is minted ONLY from stock whose 071 provenance chain is
--     proven: a real accepted 070 dispatch line, its 'dispatch_receive'
--     movement, and the exact outlet_stock row — pinned by the SAME composite
--     FKs 071 itself uses — with
--       suggested_quantity <= received_quantity - returned_quantity
--     (the returnable cap 071's own ADD-LINE RPC enforces). No provable
--     chain => the corridor is NOT feasible and no suggestion exists.
--  5. ORG-WIDE THRESHOLD RLS. inventory_signal_thresholds rows with
--     scope_id=NULL (org-wide defaults) are readable by super_admin or a
--     holder of an org-level inventory.view_signals grant for THAT
--     organization — and by nobody else. Scoped rows keep the exact-scope
--     gate. A third organization can never read either shape.
--  6. national_code SEMANTICS. A threshold with a specific national_code
--     governs THAT code only. A threshold with national_code=NULL is a
--     WILDCARD for the material at the scope: its quantities aggregate every
--     code of the material EXCEPT codes that have their own coded threshold
--     (those are governed by the coded row — no double signal for one fact).
--     A wildcard 'missing' therefore cannot fire while the material exists
--     under any real code it covers. All matching is lower(scientific_name),
--     deterministic.
--  7. near_expiry_days IS IMPLEMENTED (option A). NULL = the 270-day default;
--     values are constrained to 1..270. The most specific active threshold
--     (scope+material+code beats scope+material beats org default) sets the
--     effective window. 'expired' ALWAYS surfaces; 'near_expiry' surfaces
--     only inside the effective window. Tier vocabulary and severities stay
--     exactly 048: expired/critical_3m/warning_6m/watch_9m with
--     high/high/medium/low.
--  8. REAL-SCOPE PERMISSIONS. No (organization_id, NULL, NULL) check remains
--     on any warehouse/outlet-bound operation. Suggestion generation
--     evaluates inventory.suggest_transfers against EVERY concrete scope and
--     only allocates over scopes the caller actually holds; accept/reject
--     evaluate inventory.act_on_suggestions against the suggestion's ACTUAL
--     source scope or target scope. SECURITY DEFINER never becomes an IDOR
--     bypass. Org-level (org, NULL, NULL) checks remain ONLY for genuinely
--     org-wide operations: org-wide recompute, org-default threshold rows,
--     and purge.
--  9. ACCEPT REVALIDATES. Before a suggestion flips to accepted, the route,
--     the scope ownership, the batch (existence, material, quantity), the 071
--     return provenance, and — for cross-org — the linked exchange request
--     are ALL re-verified against live data. A stale suggestion is not
--     accepted: it is atomically classified 'expired' with an audited reason.
--     Accept remains INTENT ONLY and never moves stock.
-- 10. STRUCTURAL GUARD. A fail-closed BEFORE trigger on each new table —
--     applying to EVERY writer including service_role — proves scope→org
--     ownership, route_kind↔scope-kind pairing, live route/pairing existence,
--     return provenance presence, batch-level non-oversubscription, and
--     exchange-request org/material agreement. Composite FKs carry the 071
--     provenance chain; the trigger covers what a CHECK/FK cannot express
--     (polymorphic scope + cross-table sums).
--
-- Carried over from Round 2 (all still hold): fail-closed scope resolution
-- (no ELSE->outlet), expectation-driven 'missing', episode-aware lifecycle
-- (occurrence_count/cleared_at), manual >=30-day purge that never touches
-- audit_logs, an audit_logs row for every human action, seven split
-- permission keys, and the 048 expiry tiers.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS MIGRATION DELIBERATELY DOES **NOT** DO
-- ─────────────────────────────────────────────────────────────────────────────
--   * No DROP/RENAME/REVOKE against any pre-existing object; no ALTER of any
--     001-071 table; no row rewritten; no widened CHECK on existing constraints.
--   * No stock movement / dispatch / transfer execution — accept is advisory
--     intent ONLY (proven by §18).
--   * No parallel cross-org exchange engine — 036-041 remains the inter-org
--     path; this file only stores a validated REFERENCE to it and never
--     inserts/updates inter_org_exchange_requests or inter_org_exchange_events.
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

  -- 070/071 return-provenance infrastructure (read-only feasibility source for
  -- outlet->warehouse suggestions; the composite-FK targets below must exist).
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'warehouse_dispatch_lines'
      AND column_name = 'resulting_outlet_stock_id'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'warehouse_dispatch_lines'
      AND column_name = 'returned_quantity'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'outlet_stock_movements'
      AND column_name = 'dispatch_line_id'
  ) THEN
    RAISE EXCEPTION 'ABORT 072: 070/071 return-provenance columns are absent.';
  END IF;

  -- 036-041 inter-org exchange engine (integration REFERENCE target; this file
  -- never writes it).
  IF to_regclass('public.inter_org_exchange_requests') IS NULL THEN
    RAISE EXCEPTION 'ABORT 072: 040 inter_org_exchange_requests is absent (cross-org integration target).';
  END IF;
  IF to_regprocedure('public.phoenix_create_inter_org_exchange_request(text,uuid,uuid,uuid,integer,text,text)') IS NULL THEN
    RAISE EXCEPTION 'ABORT 072: 041 phoenix_create_inter_org_exchange_request is absent (the existing engine''s create contract).';
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
  national_code      text,                       -- NULL = wildcard for the material at the scope (§6 of header)
  reorder_point      integer,                    -- available <= this (and > 0) => low_stock; expectation => missing
  target_max         integer,                    -- available >  this           => surplus
  near_expiry_days   integer,                    -- effective near-expiry window; NULL = 270-day default (option A)
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
  -- near_expiry_days is IMPLEMENTED (not a dead setting): 1..270, NULL = default 270.
  CONSTRAINT inventory_thresholds_near_expiry_days_chk
    CHECK (near_expiry_days IS NULL OR (near_expiry_days >= 1 AND near_expiry_days <= 270))
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
  near_expiry_days         integer,               -- the EFFECTIVE window used for this date signal
  days_to_expiry           integer,

  alert_key                text NOT NULL,
  status                   text NOT NULL DEFAULT 'open',
  reason                   text,
  auto_resolved            boolean NOT NULL DEFAULT false,

  -- Episode tracking.
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
-- 3. TRANSFER SUGGESTIONS — advisory, batch-level, feasible-route, cross-org aware
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

  -- BATCH-LEVEL: the exact stock row (warehouse_stock.id or outlet_stock.id,
  -- per source_scope_kind) this suggestion draws from. One suggestion = one
  -- batch. Polymorphic, so pinned by the §9 guard trigger (and, for outlet
  -- provenance, by the composite FKs below).
  source_stock_id           uuid NOT NULL,
  suggested_quantity        integer NOT NULL,
  fefo_batch_number         text,
  fefo_expiry_date          date,

  source_batch_available_snapshot integer,
  source_surplus_snapshot   integer,
  target_shortfall_snapshot integer,
  rationale                 text,

  -- 071 RETURN PROVENANCE (outlet->warehouse ONLY): the accepted 070 dispatch
  -- line and its 'dispatch_receive' movement this return would trace to —
  -- the SAME proven chain outlet_return_request_lines (071) requires, pinned
  -- by the same composite-FK targets.
  provenance_dispatch_line_id    uuid REFERENCES public.warehouse_dispatch_lines(id) ON DELETE RESTRICT,
  provenance_inbound_movement_id uuid REFERENCES public.outlet_stock_movements(id) ON DELETE RESTRICT,

  -- 036-041 INTEGRATION REFERENCE: the inter_org_exchange_requests row
  -- (created through the EXISTING 041 engine, never by this file) that a
  -- cross-org acceptance is anchored to. Required at accept for cross-org
  -- rows (inventory_suggestions_cross_org_accept_link_chk).
  exchange_request_id       uuid REFERENCES public.inter_org_exchange_requests(id) ON DELETE SET NULL,

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
  -- route_kind must MATCH the source/target scope kinds — structurally.
  CONSTRAINT inventory_suggestions_route_pairing_chk
    CHECK (
      (route_kind = 'warehouse_to_outlet'
         AND source_scope_kind = 'warehouse' AND target_scope_kind = 'outlet')
      OR (route_kind = 'outlet_to_warehouse'
         AND source_scope_kind = 'outlet' AND target_scope_kind = 'warehouse')
      OR (route_kind = 'central_to_institution'
         AND source_scope_kind = 'warehouse' AND target_scope_kind = 'warehouse')
    ),
  -- warehouse<->outlet corridors are same-organization by construction; only
  -- central_to_institution may span organizations.
  CONSTRAINT inventory_suggestions_cross_org_route_chk
    CHECK (source_organization_id = target_organization_id
           OR route_kind = 'central_to_institution'),
  -- outlet->warehouse rows MUST carry the 071 provenance pair; all other
  -- corridors must NOT.
  CONSTRAINT inventory_suggestions_return_provenance_chk
    CHECK (
      (route_kind = 'outlet_to_warehouse'
         AND provenance_dispatch_line_id IS NOT NULL
         AND provenance_inbound_movement_id IS NOT NULL)
      OR (route_kind <> 'outlet_to_warehouse'
         AND provenance_dispatch_line_id IS NULL
         AND provenance_inbound_movement_id IS NULL)
    ),
  -- A cross-org suggestion can only be ACCEPTED with a stored reference to the
  -- 036-041 engine's request (the integration boundary, structurally).
  CONSTRAINT inventory_suggestions_cross_org_accept_link_chk
    CHECK (
      status <> 'accepted'
      OR source_organization_id = target_organization_id
      OR exchange_request_id IS NOT NULL
    ),
  -- THE PROVEN 071 CHAIN, same composite-FK targets 071 uses (MATCH SIMPLE:
  -- enforced exactly when the provenance columns are present):
  -- (1) the dispatch line RESULTED IN this outlet_stock row.
  CONSTRAINT inventory_suggestions_prov_line_stock_fk
    FOREIGN KEY (provenance_dispatch_line_id, source_stock_id)
    REFERENCES public.warehouse_dispatch_lines (id, resulting_outlet_stock_id)
    ON DELETE RESTRICT,
  -- (2) the movement was produced BY this dispatch line's receive.
  CONSTRAINT inventory_suggestions_prov_movement_line_fk
    FOREIGN KEY (provenance_inbound_movement_id, provenance_dispatch_line_id)
    REFERENCES public.outlet_stock_movements (id, dispatch_line_id)
    ON DELETE RESTRICT,
  -- (3) the movement credited THIS outlet_stock row.
  CONSTRAINT inventory_suggestions_prov_movement_stock_fk
    FOREIGN KEY (provenance_inbound_movement_id, source_stock_id)
    REFERENCES public.outlet_stock_movements (id, outlet_stock_id)
    ON DELETE RESTRICT,

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
CREATE INDEX IF NOT EXISTS inventory_suggestions_source_stock_idx
  ON public.inventory_transfer_suggestions (source_stock_id, status);
CREATE INDEX IF NOT EXISTS inventory_suggestions_target_scope_idx
  ON public.inventory_transfer_suggestions (target_scope_kind, target_scope_id, status);

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
-- 6. FEFO — batch-level eligibility, excludes expired / unavailable / quarantine
-- ============================================================================
-- Quarantine stock lives in warehouse_quarantine_stock (069), a table the live
-- warehouse_stock/outlet_stock never include — so reading only those tables is
-- already quarantine-free.
--
-- phoenix_inventory_fefo_batches lists EVERY eligible batch, FEFO-ordered
-- (expiry_date ASC NULLS LAST, then id ASC — a total, deterministic order).
-- For OUTLET scopes, a batch is eligible ONLY when its 071 return-provenance
-- chain is provable (accepted 070 dispatch line + 'dispatch_receive' movement
-- + the exact outlet_stock row), and transferable_quantity is additionally
-- capped by the line's returnable quantity
-- (received_quantity - returned_quantity), exactly like 071's ADD-LINE RPC.
CREATE OR REPLACE FUNCTION public.phoenix_inventory_fefo_batches(
  p_organization_id uuid,
  p_scope_kind      text,
  p_scope_id        uuid,
  p_scientific_name text,
  p_national_code   text DEFAULT NULL
)
RETURNS TABLE (
  stock_id              uuid,
  batch_number          text,
  expiry_date           date,
  available_quantity    integer,
  transferable_quantity integer,
  dispatch_line_id      uuid,
  inbound_movement_id   uuid
)
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
      SELECT ws.id, ws.batch_number, ws.expiry_date, ws.available_quantity,
             ws.available_quantity, NULL::uuid, NULL::uuid
      FROM public.warehouse_stock ws
      WHERE ws.organization_id = p_organization_id
        AND ws.warehouse_id = p_scope_id
        AND lower(ws.scientific_name) = lower(p_scientific_name)
        AND (p_national_code IS NULL OR ws.national_code IS NOT DISTINCT FROM p_national_code)
        AND ws.available_quantity > 0
        AND (ws.expiry_date IS NULL OR ws.expiry_date >= current_date)
      ORDER BY ws.expiry_date ASC NULLS LAST, ws.id ASC;
  ELSE
    RETURN QUERY
      SELECT os.id, os.batch_number, os.expiry_date, os.available_quantity,
             LEAST(os.available_quantity,
                   COALESCE(wdl.received_quantity, 0) - wdl.returned_quantity),
             wdl.id, osm.id
      FROM public.outlet_stock os
      JOIN public.warehouse_dispatch_lines wdl
        ON wdl.resulting_outlet_stock_id = os.id
       AND wdl.organization_id = os.organization_id
       AND wdl.status IN ('accepted', 'accepted_with_difference')
      JOIN public.outlet_stock_movements osm
        ON osm.dispatch_line_id = wdl.id
       AND osm.movement_type = 'dispatch_receive'
       AND osm.outlet_stock_id = os.id
       AND osm.organization_id = os.organization_id
      WHERE os.organization_id = p_organization_id
        AND os.distribution_point_id = p_scope_id
        AND lower(os.scientific_name) = lower(p_scientific_name)
        AND (p_national_code IS NULL OR os.national_code IS NOT DISTINCT FROM p_national_code)
        AND os.available_quantity > 0
        AND (os.expiry_date IS NULL OR os.expiry_date >= current_date)
        AND (COALESCE(wdl.received_quantity, 0) - wdl.returned_quantity) > 0
      ORDER BY os.expiry_date ASC NULLS LAST, os.id ASC, wdl.id ASC;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_inventory_fefo_batches(uuid, text, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_inventory_fefo_batches(uuid, text, uuid, text, text) TO authenticated;

-- Single-batch convenience wrapper: the FIRST eligible FEFO batch.
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
  RETURN QUERY
    SELECT b.batch_number, b.expiry_date, b.available_quantity
    FROM public.phoenix_inventory_fefo_batches(
           p_organization_id, p_scope_kind, p_scope_id,
           p_scientific_name, p_national_code) b
    ORDER BY b.expiry_date ASC NULLS LAST, b.stock_id ASC
    LIMIT 1;
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_inventory_fefo_pick(uuid, text, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_inventory_fefo_pick(uuid, text, uuid, text, text) TO authenticated;

-- ============================================================================
-- 7. RECOMPUTE — expectation-driven, wildcard-aware, tiered, episode-aware
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
    -- org-wide recompute is a genuinely org-wide operation: org-level grant
    -- (or super_admin) — the one legitimate (org, NULL, NULL) use here.
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

  -- Aggregate per (scope, material, code) — CASE-INSENSITIVELY and
  -- deterministically on lower(scientific_name).
  CREATE TEMP TABLE _agg ON COMMIT DROP AS
    SELECT scope_kind, scope_id,
           lower(scientific_name) AS sci_lower,
           MAX(scientific_name)   AS sci_display,
           national_code,
           SUM(on_hand_quantity)   AS on_hand,
           SUM(available_quantity) AS available
    FROM _stock
    GROUP BY scope_kind, scope_id, lower(scientific_name), national_code;

  -- Active thresholds for this org; scope-specific rows are EXPECTATIONS.
  CREATE TEMP TABLE _thr ON COMMIT DROP AS
    SELECT t.scope_kind, t.scope_id, lower(t.scientific_name) AS sci_lower,
           MAX(t.scientific_name) AS sci_display,
           t.national_code, t.reorder_point, t.target_max, t.near_expiry_days
    FROM public.inventory_signal_thresholds t
    WHERE t.organization_id = p_organization_id
      AND t.is_active
      AND (p_scope_kind IS NULL OR t.scope_kind = p_scope_kind)
    GROUP BY t.scope_kind, t.scope_id, lower(t.scientific_name),
             t.national_code, t.reorder_point, t.target_max, t.near_expiry_days;

  -- POSITIONS (wildcard-aware, §6 of the header):
  --   * a CODED position exists per (scope, material, code) wherever a coded
  --     threshold applies (scope-specific row = expectation; org-default row
  --     = configuration only). It measures that exact code's stock.
  --   * a WILDCARD position (national_code NULL) exists per (scope, material)
  --     wherever a wildcard threshold applies. It measures the SUM of every
  --     code of the material EXCEPT codes covered by their own coded
  --     threshold — so a generic 'missing' can never fire while the material
  --     exists under a real covered code, and one fact never produces both a
  --     wildcard and a coded signal.
  CREATE TEMP TABLE _pos ON COMMIT DROP AS
  WITH scopes AS (
    SELECT DISTINCT scope_kind, scope_id FROM _agg
    UNION
    SELECT DISTINCT scope_kind, scope_id FROM _thr WHERE scope_id IS NOT NULL
  ),
  coded AS (
    SELECT s.scope_kind, s.scope_id, t.sci_lower,
           MAX(t.sci_display) AS sci_display,
           t.national_code,
           bool_or(t.scope_id IS NOT NULL) AS expected
    FROM scopes s
    JOIN _thr t
      ON t.scope_kind = s.scope_kind
     AND (t.scope_id = s.scope_id OR t.scope_id IS NULL)
     AND t.national_code IS NOT NULL
    GROUP BY s.scope_kind, s.scope_id, t.sci_lower, t.national_code
  ),
  wildcard AS (
    SELECT s.scope_kind, s.scope_id, t.sci_lower,
           MAX(t.sci_display) AS sci_display,
           NULL::text AS national_code,
           bool_or(t.scope_id IS NOT NULL) AS expected
    FROM scopes s
    JOIN _thr t
      ON t.scope_kind = s.scope_kind
     AND (t.scope_id = s.scope_id OR t.scope_id IS NULL)
     AND t.national_code IS NULL
    GROUP BY s.scope_kind, s.scope_id, t.sci_lower
  )
  SELECT * FROM coded
  UNION ALL
  SELECT * FROM wildcard;

  CREATE TEMP TABLE _now (
    alert_key   text PRIMARY KEY,
    scope_kind  text, scope_id uuid, signal_type text, severity text, expiry_tier text,
    sci_name text, national text, batch text, expiry date,
    on_hand integer, available integer, reorder integer, target_max integer, near_days integer, dte integer
  ) ON COMMIT DROP;

  -- ── Quantity signals ─────────────────────────────────────────────────────
  INSERT INTO _now
  SELECT
    p_organization_id::text || '|' || pos.scope_kind || '|' || pos.scope_id::text || '|'
      || q.signal_type || '|' || pos.sci_lower || '|' || COALESCE(pos.national_code, '') || '||',
    pos.scope_kind, pos.scope_id, q.signal_type, q.severity, NULL,
    COALESCE(tot.sci_display, pos.sci_display), pos.national_code, NULL, NULL,
    COALESCE(tot.on_hand, 0), COALESCE(tot.available, 0), cfg.reorder_point, cfg.target_max, NULL, NULL
  FROM _pos pos
  CROSS JOIN LATERAL (
    -- resolve the effective threshold: the scope-specific row beats the
    -- org default; the position's code key is matched EXACTLY (a coded
    -- position resolves only coded rows; a wildcard position only wildcards).
    SELECT thr.reorder_point, thr.target_max
    FROM _thr thr
    WHERE thr.scope_kind = pos.scope_kind
      AND (thr.scope_id = pos.scope_id OR thr.scope_id IS NULL)
      AND thr.sci_lower = pos.sci_lower
      AND thr.national_code IS NOT DISTINCT FROM pos.national_code
    ORDER BY (thr.scope_id IS NOT NULL) DESC
    LIMIT 1
  ) cfg
  CROSS JOIN LATERAL (
    -- the position's measured stock: exact code for coded positions; for the
    -- wildcard, every code NOT covered by its own applicable coded threshold.
    SELECT MAX(a.sci_display) AS sci_display,
           SUM(a.on_hand)     AS on_hand,
           SUM(a.available)   AS available
    FROM _agg a
    WHERE a.scope_kind = pos.scope_kind
      AND a.scope_id = pos.scope_id
      AND a.sci_lower = pos.sci_lower
      AND (
        (pos.national_code IS NOT NULL AND a.national_code IS NOT DISTINCT FROM pos.national_code)
        OR (pos.national_code IS NULL AND NOT EXISTS (
              SELECT 1 FROM _thr tc
              WHERE tc.scope_kind = pos.scope_kind
                AND (tc.scope_id = pos.scope_id OR tc.scope_id IS NULL)
                AND tc.sci_lower = pos.sci_lower
                AND tc.national_code IS NOT NULL
                AND tc.national_code = a.national_code
           ))
      )
  ) tot
  CROSS JOIN LATERAL (
    SELECT
      CASE
        WHEN pos.expected AND cfg.reorder_point IS NOT NULL AND cfg.reorder_point > 0
             AND COALESCE(tot.on_hand, 0) = 0 THEN 'missing'
        WHEN cfg.reorder_point IS NOT NULL AND COALESCE(tot.available, 0) > 0
             AND COALESCE(tot.available, 0) <= cfg.reorder_point THEN 'low_stock'
        WHEN cfg.target_max IS NOT NULL AND COALESCE(tot.available, 0) > cfg.target_max THEN 'surplus'
        ELSE NULL
      END AS signal_type,
      CASE
        WHEN pos.expected AND cfg.reorder_point IS NOT NULL AND cfg.reorder_point > 0
             AND COALESCE(tot.on_hand, 0) = 0 THEN 'high'
        WHEN cfg.reorder_point IS NOT NULL AND COALESCE(tot.available, 0) > 0
             AND COALESCE(tot.available, 0) <= cfg.reorder_point THEN 'medium'
        ELSE 'low'
      END AS severity
  ) q
  WHERE q.signal_type IS NOT NULL
  ON CONFLICT (alert_key) DO NOTHING;

  -- ── Date signals: per-batch, tiered by 048 windows, near_expiry_days-aware ─
  -- 'expired' ALWAYS surfaces. 'near_expiry' surfaces only inside the
  -- EFFECTIVE window: the most specific active near_expiry_days
  -- (scope+material+code > scope+material > org default), NULL => 270 days.
  INSERT INTO _now
  SELECT
    p_organization_id::text || '|' || s.scope_kind || '|' || s.scope_id::text || '|'
      || sig.signal_type || '|' || lower(s.scientific_name) || '|'
      || COALESCE(s.national_code, '') || '|' || COALESCE(s.batch_number, '') || '|'
      || COALESCE(s.expiry_date::text, ''),
    s.scope_kind, s.scope_id, sig.signal_type, sig.severity, sig.tier,
    s.scientific_name, s.national_code, s.batch_number, s.expiry_date,
    s.on_hand_quantity, s.available_quantity, NULL, NULL, win.eff_days, (s.expiry_date - current_date)
  FROM _stock s
  CROSS JOIN LATERAL (
    SELECT COALESCE((
      SELECT t.near_expiry_days
      FROM _thr t
      WHERE t.scope_kind = s.scope_kind
        AND (t.scope_id = s.scope_id OR t.scope_id IS NULL)
        AND t.sci_lower = lower(s.scientific_name)
        AND (t.national_code IS NULL OR t.national_code = s.national_code)
        AND t.near_expiry_days IS NOT NULL
      ORDER BY (t.scope_id IS NOT NULL) DESC, (t.national_code IS NOT NULL) DESC
      LIMIT 1
    ), 270) AS eff_days
  ) win
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
    AND (s.expiry_date < current_date                       -- expired: always
         OR s.expiry_date <= (current_date + win.eff_days)) -- near: inside window
  ON CONFLICT (alert_key) DO NOTHING;

  -- ── Upsert violations with EPISODE semantics ────────────────────────────
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
    near_expiry_days        = EXCLUDED.near_expiry_days,
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

  -- ── Clear detection ─────────────────────────────────────────────────────
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
-- 9. STRUCTURAL GUARDS — fail-closed BEFORE triggers on every new table.
--    They bind EVERY writer, including service_role and any SECURITY DEFINER
--    body in this file: RPC discipline is not the only line of defence.
-- ============================================================================

-- 9a. Thresholds: a named scope must exist, match its kind, and belong to the
--     row's organization. (scope_id NULL = org-wide default, allowed.)
CREATE OR REPLACE FUNCTION public.phoenix_inventory_threshold_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.scope_kind NOT IN ('warehouse', 'outlet') THEN
    RAISE EXCEPTION 'guard_072_invalid_scope_kind';
  END IF;
  IF NEW.scope_id IS NOT NULL
     AND public.phoenix_inventory_scope_org(NEW.scope_kind, NEW.scope_id)
         IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'guard_072_threshold_scope_not_in_organization';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_threshold_guard ON public.inventory_signal_thresholds;
CREATE TRIGGER inventory_threshold_guard
  BEFORE INSERT OR UPDATE ON public.inventory_signal_thresholds
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_inventory_threshold_guard();

-- 9b. Alerts: the scope must exist, match its kind, and belong to the org.
CREATE OR REPLACE FUNCTION public.phoenix_inventory_alert_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.scope_kind NOT IN ('warehouse', 'outlet') THEN
    RAISE EXCEPTION 'guard_072_invalid_scope_kind';
  END IF;
  IF public.phoenix_inventory_scope_org(NEW.scope_kind, NEW.scope_id)
     IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'guard_072_alert_scope_not_in_organization';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_alert_guard ON public.inventory_alerts;
CREATE TRIGGER inventory_alert_guard
  BEFORE INSERT OR UPDATE ON public.inventory_alerts
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_inventory_alert_guard();

-- 9c. Suggestions: the full structural contract —
--     * source scope belongs to source org; target scope to target org;
--     * route_kind's live pairing exists (dp.warehouse_id / active supply
--       route), re-proven whenever corridor-defining columns are written;
--     * the named batch (source_stock_id) exists in the right stock table, at
--       the right scope, with matching material/code;
--     * Σ open+accepted suggestions per batch never exceeds that batch's
--       available_quantity (checked on INSERT, quantity change, or reopen);
--     * outlet->warehouse rows respect the 071 returnable cap
--       (received_quantity - returned_quantity);
--     * a stored exchange_request_id must agree on organizations + material.
--     Lifecycle-only status updates (open->accepted/rejected/superseded/
--     expired) deliberately skip the LIVE-state re-checks: the accept RPC
--     revalidates and must remain able to classify a stale row 'expired'.
CREATE OR REPLACE FUNCTION public.phoenix_inventory_suggestion_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_corridor_write boolean;
  v_qty_write      boolean;
  v_reopen         boolean;
  v_available      integer;
  v_committed      integer;
  v_returnable     integer;
BEGIN
  v_corridor_write := (TG_OP = 'INSERT') OR (
       NEW.source_scope_kind IS DISTINCT FROM OLD.source_scope_kind
    OR NEW.source_scope_id   IS DISTINCT FROM OLD.source_scope_id
    OR NEW.target_scope_kind IS DISTINCT FROM OLD.target_scope_kind
    OR NEW.target_scope_id   IS DISTINCT FROM OLD.target_scope_id
    OR NEW.route_kind        IS DISTINCT FROM OLD.route_kind
    OR NEW.source_organization_id IS DISTINCT FROM OLD.source_organization_id
    OR NEW.target_organization_id IS DISTINCT FROM OLD.target_organization_id
    OR NEW.source_stock_id   IS DISTINCT FROM OLD.source_stock_id
    OR NEW.provenance_dispatch_line_id IS DISTINCT FROM OLD.provenance_dispatch_line_id
  );
  v_qty_write := (TG_OP = 'INSERT')
    OR (NEW.suggested_quantity IS DISTINCT FROM OLD.suggested_quantity);
  v_reopen := (TG_OP = 'UPDATE')
    AND NEW.status IN ('open', 'accepted')
    AND OLD.status IN ('superseded', 'expired', 'rejected');

  -- Scope→organization ownership: always cheap, always on.
  IF public.phoenix_inventory_scope_org(NEW.source_scope_kind, NEW.source_scope_id)
     IS DISTINCT FROM NEW.source_organization_id THEN
    RAISE EXCEPTION 'guard_072_source_scope_not_in_source_organization';
  END IF;
  IF public.phoenix_inventory_scope_org(NEW.target_scope_kind, NEW.target_scope_id)
     IS DISTINCT FROM NEW.target_organization_id THEN
    RAISE EXCEPTION 'guard_072_target_scope_not_in_target_organization';
  END IF;

  IF v_corridor_write THEN
    -- Live route/pairing per corridor.
    IF NEW.route_kind = 'warehouse_to_outlet' THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.distribution_points dp
        WHERE dp.id = NEW.target_scope_id
          AND dp.warehouse_id = NEW.source_scope_id
          AND dp.organization_id = NEW.source_organization_id
      ) THEN
        RAISE EXCEPTION 'guard_072_no_warehouse_outlet_pairing';
      END IF;
    ELSIF NEW.route_kind = 'outlet_to_warehouse' THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.distribution_points dp
        WHERE dp.id = NEW.source_scope_id
          AND dp.warehouse_id = NEW.target_scope_id
          AND dp.organization_id = NEW.source_organization_id
      ) THEN
        RAISE EXCEPTION 'guard_072_no_outlet_warehouse_pairing';
      END IF;
    ELSIF NEW.route_kind = 'central_to_institution' THEN
      IF NOT EXISTS (
        SELECT 1
        FROM public.warehouse_supply_routes r
        JOIN public.warehouses sw ON sw.id = r.source_warehouse_id
                                 AND sw.organization_id = NEW.source_organization_id
        JOIN public.warehouses tw ON tw.id = r.target_warehouse_id
                                 AND tw.organization_id = NEW.target_organization_id
        WHERE r.source_warehouse_id = NEW.source_scope_id
          AND r.target_warehouse_id = NEW.target_scope_id
          AND r.is_active
      ) THEN
        RAISE EXCEPTION 'guard_072_no_active_supply_route';
      END IF;
    ELSE
      RAISE EXCEPTION 'guard_072_invalid_route_kind';
    END IF;

    -- The named batch must exist in the RIGHT stock table, at the source
    -- scope, with matching material (and code, when the suggestion is coded).
    IF NEW.source_scope_kind = 'warehouse' THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.warehouse_stock ws
        WHERE ws.id = NEW.source_stock_id
          AND ws.warehouse_id = NEW.source_scope_id
          AND ws.organization_id = NEW.source_organization_id
          AND lower(ws.scientific_name) = lower(NEW.scientific_name)
          AND (NEW.national_code IS NULL OR ws.national_code = NEW.national_code)
      ) THEN
        RAISE EXCEPTION 'guard_072_source_stock_row_mismatch';
      END IF;
    ELSE
      IF NOT EXISTS (
        SELECT 1 FROM public.outlet_stock os
        WHERE os.id = NEW.source_stock_id
          AND os.distribution_point_id = NEW.source_scope_id
          AND os.organization_id = NEW.source_organization_id
          AND lower(os.scientific_name) = lower(NEW.scientific_name)
          AND (NEW.national_code IS NULL OR os.national_code = NEW.national_code)
      ) THEN
        RAISE EXCEPTION 'guard_072_source_stock_row_mismatch';
      END IF;
    END IF;
  END IF;

  IF v_qty_write OR v_reopen THEN
    -- Batch-level conservation: Σ open+accepted per source_stock_id (this row
    -- included) never exceeds the batch's live availability.
    IF NEW.status IN ('open', 'accepted') THEN
      IF NEW.source_scope_kind = 'warehouse' THEN
        SELECT ws.available_quantity INTO v_available
        FROM public.warehouse_stock ws WHERE ws.id = NEW.source_stock_id;
      ELSE
        SELECT os.available_quantity INTO v_available
        FROM public.outlet_stock os WHERE os.id = NEW.source_stock_id;
      END IF;
      IF v_available IS NULL THEN
        RAISE EXCEPTION 'guard_072_source_stock_row_missing';
      END IF;

      SELECT COALESCE(SUM(s.suggested_quantity), 0) INTO v_committed
      FROM public.inventory_transfer_suggestions s
      WHERE s.source_stock_id = NEW.source_stock_id
        AND s.status IN ('open', 'accepted')
        AND s.id <> NEW.id;

      IF v_committed + NEW.suggested_quantity > v_available THEN
        RAISE EXCEPTION 'guard_072_batch_oversubscribed';
      END IF;

      -- 071 returnable cap for outlet->warehouse rows.
      IF NEW.route_kind = 'outlet_to_warehouse' THEN
        SELECT COALESCE(wdl.received_quantity, 0) - wdl.returned_quantity
          INTO v_returnable
        FROM public.warehouse_dispatch_lines wdl
        WHERE wdl.id = NEW.provenance_dispatch_line_id
          AND wdl.status IN ('accepted', 'accepted_with_difference');
        IF v_returnable IS NULL OR NEW.suggested_quantity > v_returnable THEN
          RAISE EXCEPTION 'guard_072_exceeds_returnable_quantity';
        END IF;
      END IF;
    END IF;
  END IF;

  -- Stored 036-041 reference must agree on organizations + material.
  IF NEW.exchange_request_id IS NOT NULL
     AND (TG_OP = 'INSERT'
          OR NEW.exchange_request_id IS DISTINCT FROM OLD.exchange_request_id) THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.inter_org_exchange_requests x
      WHERE x.id = NEW.exchange_request_id
        AND x.source_organization_id = NEW.source_organization_id
        AND x.target_organization_id = NEW.target_organization_id
        AND lower(x.scientific_name) = lower(NEW.scientific_name)
    ) THEN
      RAISE EXCEPTION 'guard_072_exchange_request_mismatch';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_suggestion_guard ON public.inventory_transfer_suggestions;
CREATE TRIGGER inventory_suggestion_guard
  BEFORE INSERT OR UPDATE ON public.inventory_transfer_suggestions
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_inventory_suggestion_guard();

-- Guard trigger functions are internal: no direct EXECUTE for clients.
REVOKE ALL ON FUNCTION public.phoenix_inventory_threshold_guard() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.phoenix_inventory_alert_guard() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.phoenix_inventory_suggestion_guard() FROM PUBLIC, anon;

-- ============================================================================
-- 10. SUGGEST (INTRA-ORG) — batch-level FEFO, real-scope permissions,
--     deterministic non-oversubscribing allocation
-- ============================================================================
-- Cross-organization surplus/shortage stays the job of the 036-041 inter-org
-- alert/exchange system; §11 mints cross-org ADVISORY rows (super_admin only)
-- whose ACCEPTANCE must reference that engine.
--
-- Permission model (round-3 item 8): NO (org, NULL, NULL) check. The caller's
-- inventory.suggest_transfers is evaluated against EVERY concrete warehouse/
-- outlet of the organization; allocation (and the supersede pass) only cover
-- scopes the caller actually holds. super_admin covers all scopes.
--
-- Order of operations (deliberate): stale open rows inside the caller's scope
-- set are superseded FIRST, then the allocator re-mints what still holds —
-- so the §9 batch-conservation guard never counts a row that is about to be
-- replaced, and re-minted keys are simply reopened by ON CONFLICT.
CREATE OR REPLACE FUNCTION public.phoenix_suggest_inventory_transfers(p_organization_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_is_super boolean;
  v_need     record;
  v_src      record;
  v_batch    record;
  v_take     integer;
  v_need_remaining integer;
  v_src_remaining  integer;
  v_upserted integer := 0;
  v_superseded integer := 0;
  v_rows     integer;
  v_key      text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  v_is_super := (public.phoenix_my_role() = 'super_admin');

  PERFORM pg_advisory_xact_lock(hashtextextended('inv_suggest:' || p_organization_id::text, 0));

  -- The EXACT scopes this caller may allocate over — never (org, NULL, NULL).
  CREATE TEMP TABLE _scopes (scope_kind text, scope_id uuid, PRIMARY KEY (scope_kind, scope_id)) ON COMMIT DROP;
  INSERT INTO _scopes
    SELECT 'warehouse', w.id
    FROM public.warehouses w
    WHERE w.organization_id = p_organization_id
      AND (v_is_super OR public.phoenix_profile_has_scoped_permission(
             v_actor, 'inventory.suggest_transfers', p_organization_id, w.id, NULL))
    UNION ALL
    SELECT 'outlet', dp.id
    FROM public.distribution_points dp
    WHERE dp.organization_id = p_organization_id
      AND (v_is_super OR public.phoenix_profile_has_scoped_permission(
             v_actor, 'inventory.suggest_transfers', p_organization_id, NULL, dp.id));

  IF NOT EXISTS (SELECT 1 FROM _scopes) THEN
    RAISE EXCEPTION 'not_authorized_inventory_suggest';
  END IF;

  -- Supersede FIRST: open intra-org suggestions whose BOTH endpoints sit in
  -- the caller's scope set are about to be recomputed; anything still valid
  -- is re-opened by the allocator below. Rows with an endpoint outside the
  -- caller's authority are left untouched (and counted as consumed headroom).
  UPDATE public.inventory_transfer_suggestions s
  SET status = 'superseded', updated_at = now()
  WHERE s.source_organization_id = p_organization_id
    AND s.target_organization_id = p_organization_id
    AND s.status = 'open'
    AND EXISTS (SELECT 1 FROM _scopes sc
                WHERE sc.scope_kind = s.source_scope_kind AND sc.scope_id = s.source_scope_id)
    AND EXISTS (SELECT 1 FROM _scopes sc
                WHERE sc.scope_kind = s.target_scope_kind AND sc.scope_id = s.target_scope_id);
  GET DIAGNOSTICS v_superseded = ROW_COUNT;

  -- Needs: active missing/low_stock alerts at permitted scopes, with the
  -- remaining deficit reduced by every still-consuming inbound suggestion
  -- (accepted anywhere, or open rows this run cannot supersede).
  CREATE TEMP TABLE _need ON COMMIT DROP AS
    SELECT a.id AS alert_id, a.scope_kind, a.scope_id,
           a.scientific_name, lower(a.scientific_name) AS sci_lower, a.national_code,
           GREATEST(COALESCE(a.threshold_reorder_point, 0) - COALESCE(a.observed_available, 0), 1) AS deficit,
           GREATEST(COALESCE(a.threshold_reorder_point, 0) - COALESCE(a.observed_available, 0), 1)
             - COALESCE((
                 SELECT SUM(s.suggested_quantity)
                 FROM public.inventory_transfer_suggestions s
                 WHERE s.target_scope_kind = a.scope_kind
                   AND s.target_scope_id = a.scope_id
                   AND s.target_organization_id = a.organization_id
                   AND lower(s.scientific_name) = lower(a.scientific_name)
                   AND s.national_code IS NOT DISTINCT FROM a.national_code
                   AND s.status IN ('open', 'accepted')
               ), 0) AS remaining,
           CASE a.severity WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END AS prio
    FROM public.inventory_alerts a
    WHERE a.organization_id = p_organization_id
      AND a.status IN ('open', 'acknowledged', 'in_progress')
      AND a.signal_type IN ('missing', 'low_stock')
      AND EXISTS (SELECT 1 FROM _scopes sc
                  WHERE sc.scope_kind = a.scope_kind AND sc.scope_id = a.scope_id);

  -- Sources: active surplus alerts at permitted scopes, headroom reduced by
  -- every still-consuming outbound suggestion.
  CREATE TEMP TABLE _src ON COMMIT DROP AS
    SELECT a.id AS alert_id, a.scope_kind, a.scope_id,
           a.scientific_name, lower(a.scientific_name) AS sci_lower, a.national_code,
           GREATEST(COALESCE(a.observed_available, 0) - COALESCE(a.threshold_target_max, 0), 0) AS headroom,
           GREATEST(COALESCE(a.observed_available, 0) - COALESCE(a.threshold_target_max, 0), 0)
             - COALESCE((
                 SELECT SUM(s.suggested_quantity)
                 FROM public.inventory_transfer_suggestions s
                 WHERE s.source_scope_kind = a.scope_kind
                   AND s.source_scope_id = a.scope_id
                   AND s.source_organization_id = a.organization_id
                   AND lower(s.scientific_name) = lower(a.scientific_name)
                   AND s.national_code IS NOT DISTINCT FROM a.national_code
                   AND s.status IN ('open', 'accepted')
               ), 0) AS remaining
    FROM public.inventory_alerts a
    WHERE a.organization_id = p_organization_id
      AND a.status IN ('open', 'acknowledged', 'in_progress')
      AND a.signal_type = 'surplus'
      AND EXISTS (SELECT 1 FROM _scopes sc
                  WHERE sc.scope_kind = a.scope_kind AND sc.scope_id = a.scope_id);

  -- Eligible FEFO batches at every source scope: one row per (stock row,
  -- provenance line). Outlet batches REQUIRE the proven 071 chain and are
  -- capped by the returnable quantity. remaining is reduced by every
  -- still-consuming suggestion already drawing on the same batch.
  CREATE TEMP TABLE _batch ON COMMIT DROP AS
    SELECT b.scope_kind, b.scope_id, b.sci_lower, b.national_code,
           b.stock_id, b.batch_number, b.expiry_date, b.available_quantity,
           b.dispatch_line_id, b.inbound_movement_id,
           b.transferable_quantity
             - COALESCE((
                 SELECT SUM(s.suggested_quantity)
                 FROM public.inventory_transfer_suggestions s
                 WHERE s.source_stock_id = b.stock_id
                   AND s.provenance_dispatch_line_id IS NOT DISTINCT FROM b.dispatch_line_id
                   AND s.status IN ('open', 'accepted')
               ), 0) AS remaining
    FROM (
      SELECT 'warehouse'::text AS scope_kind, ws.warehouse_id AS scope_id,
             lower(ws.scientific_name) AS sci_lower, ws.national_code,
             ws.id AS stock_id, ws.batch_number, ws.expiry_date,
             ws.available_quantity, ws.available_quantity AS transferable_quantity,
             NULL::uuid AS dispatch_line_id, NULL::uuid AS inbound_movement_id
      FROM public.warehouse_stock ws
      WHERE ws.organization_id = p_organization_id
        AND ws.available_quantity > 0
        AND (ws.expiry_date IS NULL OR ws.expiry_date >= current_date)
        AND EXISTS (SELECT 1 FROM _scopes sc
                    WHERE sc.scope_kind = 'warehouse' AND sc.scope_id = ws.warehouse_id)
      UNION ALL
      SELECT 'outlet', os.distribution_point_id,
             lower(os.scientific_name), os.national_code,
             os.id, os.batch_number, os.expiry_date,
             os.available_quantity,
             LEAST(os.available_quantity,
                   COALESCE(wdl.received_quantity, 0) - wdl.returned_quantity),
             wdl.id, osm.id
      FROM public.outlet_stock os
      JOIN public.warehouse_dispatch_lines wdl
        ON wdl.resulting_outlet_stock_id = os.id
       AND wdl.organization_id = os.organization_id
       AND wdl.status IN ('accepted', 'accepted_with_difference')
      JOIN public.outlet_stock_movements osm
        ON osm.dispatch_line_id = wdl.id
       AND osm.movement_type = 'dispatch_receive'
       AND osm.outlet_stock_id = os.id
       AND osm.organization_id = os.organization_id
      WHERE os.organization_id = p_organization_id
        AND os.available_quantity > 0
        AND (os.expiry_date IS NULL OR os.expiry_date >= current_date)
        AND (COALESCE(wdl.received_quantity, 0) - wdl.returned_quantity) > 0
        AND EXISTS (SELECT 1 FROM _scopes sc
                    WHERE sc.scope_kind = 'outlet' AND sc.scope_id = os.distribution_point_id)
    ) b;

  -- Batch-shared conservation across positions: a stock row referenced by
  -- several provenance lines must never emit more than its availability.
  CREATE TEMP TABLE _stock_cap ON COMMIT DROP AS
    SELECT b.stock_id,
           MAX(b.available_quantity)
             - COALESCE((
                 SELECT SUM(s.suggested_quantity)
                 FROM public.inventory_transfer_suggestions s
                 WHERE s.source_stock_id = b.stock_id
                   AND s.status IN ('open', 'accepted')
               ), 0) AS remaining
    FROM _batch b
    GROUP BY b.stock_id;

  -- Deterministic allocation: needs by severity then material/scope/id;
  -- sources by remaining headroom then scope/id; batches FEFO
  -- (expiry_date ASC NULLS LAST, then stock id, then provenance line id).
  FOR v_need IN
    SELECT * FROM _need WHERE remaining > 0
    ORDER BY prio DESC, sci_lower, scope_id, alert_id
  LOOP
    v_need_remaining := v_need.remaining;

    FOR v_src IN
      SELECT s.*,
             CASE
               WHEN s.scope_kind = 'warehouse' AND v_need.scope_kind = 'outlet'
                    AND EXISTS (SELECT 1 FROM public.distribution_points dp
                                 WHERE dp.id = v_need.scope_id AND dp.warehouse_id = s.scope_id
                                   AND dp.organization_id = p_organization_id)
                 THEN 'warehouse_to_outlet'
               WHEN s.scope_kind = 'outlet' AND v_need.scope_kind = 'warehouse'
                    AND EXISTS (SELECT 1 FROM public.distribution_points dp
                                 WHERE dp.id = s.scope_id AND dp.warehouse_id = v_need.scope_id
                                   AND dp.organization_id = p_organization_id)
                 THEN 'outlet_to_warehouse'
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
        AND s.sci_lower = v_need.sci_lower
        AND s.national_code IS NOT DISTINCT FROM v_need.national_code
        AND NOT (s.scope_kind = v_need.scope_kind AND s.scope_id = v_need.scope_id)
      ORDER BY s.remaining DESC, s.scope_id, s.alert_id
    LOOP
      EXIT WHEN v_need_remaining <= 0;
      CONTINUE WHEN v_src.route_kind IS NULL;   -- infeasible corridor: never suggest it

      SELECT remaining INTO v_src_remaining FROM _src WHERE alert_id = v_src.alert_id;
      CONTINUE WHEN v_src_remaining <= 0;

      FOR v_batch IN
        SELECT b.*, sc.remaining AS stock_remaining
        FROM _batch b
        JOIN _stock_cap sc ON sc.stock_id = b.stock_id
        WHERE b.scope_kind = v_src.scope_kind
          AND b.scope_id = v_src.scope_id
          AND b.sci_lower = v_src.sci_lower
          AND (v_src.national_code IS NULL OR b.national_code IS NOT DISTINCT FROM v_src.national_code)
          AND b.remaining > 0
          AND sc.remaining > 0
        ORDER BY b.expiry_date ASC NULLS LAST, b.stock_id ASC,
                 COALESCE(b.dispatch_line_id, '00000000-0000-0000-0000-000000000000'::uuid) ASC
      LOOP
        EXIT WHEN v_need_remaining <= 0 OR v_src_remaining <= 0;

        -- outlet->warehouse rows MUST ride a proven 071 chain (outlet batches
        -- always carry one by construction; this is defence in depth).
        CONTINUE WHEN v_src.route_kind = 'outlet_to_warehouse' AND v_batch.dispatch_line_id IS NULL;

        v_take := LEAST(v_need_remaining, v_src_remaining, v_batch.remaining, v_batch.stock_remaining);
        CONTINUE WHEN v_take <= 0;

        v_key := p_organization_id::text
          || '|' || v_src.scope_kind  || '|' || v_src.scope_id::text
          || '|' || v_need.scope_kind || '|' || v_need.scope_id::text
          || '|' || v_need.sci_lower  || '|' || COALESCE(v_need.national_code, '')
          || '|' || v_batch.stock_id::text
          || '|' || COALESCE(v_batch.dispatch_line_id::text, '');

        INSERT INTO public.inventory_transfer_suggestions AS su (
          source_organization_id, target_organization_id, scientific_name, national_code,
          source_scope_kind, source_scope_id, target_scope_kind, target_scope_id, route_kind,
          source_stock_id, suggested_quantity, fefo_batch_number, fefo_expiry_date,
          source_batch_available_snapshot, source_surplus_snapshot, target_shortfall_snapshot,
          provenance_dispatch_line_id, provenance_inbound_movement_id,
          rationale, suggestion_key, status, first_suggested_at, last_suggested_at
        )
        VALUES (
          p_organization_id, p_organization_id, v_need.scientific_name, v_need.national_code,
          v_src.scope_kind, v_src.scope_id, v_need.scope_kind, v_need.scope_id, v_src.route_kind,
          v_batch.stock_id, v_take, v_batch.batch_number, v_batch.expiry_date,
          v_batch.available_quantity, v_src.headroom, v_need.deficit,
          CASE WHEN v_src.route_kind = 'outlet_to_warehouse' THEN v_batch.dispatch_line_id ELSE NULL END,
          CASE WHEN v_src.route_kind = 'outlet_to_warehouse' THEN v_batch.inbound_movement_id ELSE NULL END,
          'deterministic allocation: one FEFO batch of a surplus source covers part of a shortage over a feasible route',
          v_key, 'open', now(), now()
        )
        ON CONFLICT (suggestion_key) DO UPDATE SET
          suggested_quantity              = EXCLUDED.suggested_quantity,
          route_kind                      = EXCLUDED.route_kind,
          fefo_batch_number               = EXCLUDED.fefo_batch_number,
          fefo_expiry_date                = EXCLUDED.fefo_expiry_date,
          source_batch_available_snapshot = EXCLUDED.source_batch_available_snapshot,
          source_surplus_snapshot         = EXCLUDED.source_surplus_snapshot,
          target_shortfall_snapshot       = EXCLUDED.target_shortfall_snapshot,
          provenance_inbound_movement_id  = EXCLUDED.provenance_inbound_movement_id,
          last_suggested_at               = now(),
          updated_at                      = now(),
          status                          = 'open'
        WHERE su.status IN ('open', 'superseded', 'expired');

        GET DIAGNOSTICS v_rows = ROW_COUNT;
        -- An accepted/rejected row keeps its key: nothing was written, and its
        -- quantity was already counted as consumed headroom above.
        CONTINUE WHEN v_rows = 0;

        v_upserted := v_upserted + 1;
        v_need_remaining := v_need_remaining - v_take;
        v_src_remaining  := v_src_remaining - v_take;
        UPDATE _src SET remaining = remaining - v_take WHERE alert_id = v_src.alert_id;
        UPDATE _batch SET remaining = remaining - v_take
          WHERE stock_id = v_batch.stock_id
            AND dispatch_line_id IS NOT DISTINCT FROM v_batch.dispatch_line_id
            AND scope_kind = v_batch.scope_kind AND scope_id = v_batch.scope_id;
        UPDATE _stock_cap SET remaining = remaining - v_take WHERE stock_id = v_batch.stock_id;
      END LOOP;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'organization_id', p_organization_id,
    'suggestions', v_upserted,
    'superseded', v_superseded
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_suggest_inventory_transfers(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_suggest_inventory_transfers(uuid) TO authenticated;

-- ============================================================================
-- 11. CROSS-ORG SUGGESTION — super_admin path, FULLY DATA-DERIVED quantities
-- ============================================================================
-- Minting a suggestion off ANOTHER organization's balances is a privileged
-- act: only super_admin may run it, and even super_admin CANNOT invent a
-- quantity — there is no quantity parameter. Every minted row is derived:
--   * a REAL active 'surplus' alert at the source warehouse,
--   * a REAL active 'missing'/'low_stock' alert at the target warehouse,
--   * an ACTIVE central->institution supply route between the two warehouses
--     (ownership of both endpoints verified),
--   * at least one eligible FEFO batch at the source,
-- and each per-batch suggestion is capped by
--   LEAST(remaining surplus, remaining shortfall, remaining batch availability)
-- where "remaining" subtracts every other open/accepted suggestion. Both
-- organizations' allocator locks are taken in DETERMINISTIC (sorted) order so
-- concurrent runs cannot jointly oversubscribe a source.
-- Advisory intent only; acceptance additionally requires a 036-041 exchange
-- request reference (§12).
CREATE OR REPLACE FUNCTION public.phoenix_suggest_cross_org_inventory_transfer(
  p_source_organization_id uuid,
  p_source_warehouse_id    uuid,
  p_target_organization_id uuid,
  p_target_warehouse_id    uuid,
  p_scientific_name        text,
  p_national_code          text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_name  text := NULLIF(btrim(p_scientific_name), '');
  v_code  text := NULLIF(btrim(p_national_code), '');
  v_lock_a text;
  v_lock_b text;
  v_surplus integer;
  v_shortfall integer;
  v_deficit_snapshot integer;
  v_headroom_snapshot integer;
  v_batch record;
  v_take integer;
  v_batch_remaining integer;
  v_minted integer := 0;
  v_rows integer;
  v_key text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF public.phoenix_my_role() <> 'super_admin' THEN
    RAISE EXCEPTION 'cross_org_suggestion_requires_super_admin';
  END IF;
  IF v_name IS NULL THEN RAISE EXCEPTION 'scientific_name_required'; END IF;
  IF p_source_organization_id = p_target_organization_id THEN
    RAISE EXCEPTION 'use_intra_org_suggest_for_same_org';
  END IF;

  -- Deterministic dual-org lock order (sorted): concurrent suggest runs in
  -- either organization serialize against this computation.
  v_lock_a := LEAST(p_source_organization_id::text, p_target_organization_id::text);
  v_lock_b := GREATEST(p_source_organization_id::text, p_target_organization_id::text);
  PERFORM pg_advisory_xact_lock(hashtextextended('inv_suggest:' || v_lock_a, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('inv_suggest:' || v_lock_b, 0));

  -- Feasibility: a real active central->institution route between the
  -- warehouses, each owned by its claimed organization.
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

  -- REAL surplus at the source (an active surplus alert for this material).
  SELECT GREATEST(COALESCE(a.observed_available, 0) - COALESCE(a.threshold_target_max, 0), 0)
    INTO v_surplus
  FROM public.inventory_alerts a
  WHERE a.organization_id = p_source_organization_id
    AND a.scope_kind = 'warehouse' AND a.scope_id = p_source_warehouse_id
    AND a.signal_type = 'surplus'
    AND a.status IN ('open', 'acknowledged', 'in_progress')
    AND lower(a.scientific_name) = lower(v_name)
    AND a.national_code IS NOT DISTINCT FROM v_code
  ORDER BY a.last_observed_at DESC
  LIMIT 1;
  IF v_surplus IS NULL OR v_surplus <= 0 THEN
    RAISE EXCEPTION 'no_source_surplus';
  END IF;
  v_headroom_snapshot := v_surplus;

  -- REAL shortfall at the target (an active missing/low_stock alert).
  SELECT GREATEST(COALESCE(a.threshold_reorder_point, 0) - COALESCE(a.observed_available, 0), 1)
    INTO v_shortfall
  FROM public.inventory_alerts a
  WHERE a.organization_id = p_target_organization_id
    AND a.scope_kind = 'warehouse' AND a.scope_id = p_target_warehouse_id
    AND a.signal_type IN ('missing', 'low_stock')
    AND a.status IN ('open', 'acknowledged', 'in_progress')
    AND lower(a.scientific_name) = lower(v_name)
    AND a.national_code IS NOT DISTINCT FROM v_code
  ORDER BY a.last_observed_at DESC
  LIMIT 1;
  IF v_shortfall IS NULL OR v_shortfall <= 0 THEN
    RAISE EXCEPTION 'no_target_shortfall';
  END IF;
  v_deficit_snapshot := v_shortfall;

  -- Remaining = data minus every other still-consuming suggestion.
  v_surplus := v_surplus - COALESCE((
    SELECT SUM(s.suggested_quantity)
    FROM public.inventory_transfer_suggestions s
    WHERE s.source_scope_kind = 'warehouse'
      AND s.source_scope_id = p_source_warehouse_id
      AND s.source_organization_id = p_source_organization_id
      AND lower(s.scientific_name) = lower(v_name)
      AND s.national_code IS NOT DISTINCT FROM v_code
      AND s.status IN ('open', 'accepted')
  ), 0);
  IF v_surplus <= 0 THEN
    RAISE EXCEPTION 'source_surplus_already_committed';
  END IF;

  v_shortfall := v_shortfall - COALESCE((
    SELECT SUM(s.suggested_quantity)
    FROM public.inventory_transfer_suggestions s
    WHERE s.target_scope_kind = 'warehouse'
      AND s.target_scope_id = p_target_warehouse_id
      AND s.target_organization_id = p_target_organization_id
      AND lower(s.scientific_name) = lower(v_name)
      AND s.national_code IS NOT DISTINCT FROM v_code
      AND s.status IN ('open', 'accepted')
  ), 0);
  IF v_shortfall <= 0 THEN
    RAISE EXCEPTION 'target_shortfall_already_covered';
  END IF;

  -- One suggestion per eligible FEFO batch until surplus or shortfall runs
  -- out. No eligible batch at all => no suggestion, by exception.
  FOR v_batch IN
    SELECT ws.id AS stock_id, ws.batch_number, ws.expiry_date, ws.available_quantity
    FROM public.warehouse_stock ws
    WHERE ws.organization_id = p_source_organization_id
      AND ws.warehouse_id = p_source_warehouse_id
      AND lower(ws.scientific_name) = lower(v_name)
      AND (v_code IS NULL OR ws.national_code IS NOT DISTINCT FROM v_code)
      AND ws.available_quantity > 0
      AND (ws.expiry_date IS NULL OR ws.expiry_date >= current_date)
    ORDER BY ws.expiry_date ASC NULLS LAST, ws.id ASC
  LOOP
    EXIT WHEN v_surplus <= 0 OR v_shortfall <= 0;

    v_batch_remaining := v_batch.available_quantity - COALESCE((
      SELECT SUM(s.suggested_quantity)
      FROM public.inventory_transfer_suggestions s
      WHERE s.source_stock_id = v_batch.stock_id
        AND s.status IN ('open', 'accepted')
    ), 0);
    CONTINUE WHEN v_batch_remaining <= 0;

    v_take := LEAST(v_surplus, v_shortfall, v_batch_remaining);
    CONTINUE WHEN v_take <= 0;

    v_key := 'xorg|' || p_source_warehouse_id::text || '|' || p_target_warehouse_id::text
      || '|' || lower(v_name) || '|' || COALESCE(v_code, '')
      || '|' || v_batch.stock_id::text;

    INSERT INTO public.inventory_transfer_suggestions AS su (
      source_organization_id, target_organization_id, scientific_name, national_code,
      source_scope_kind, source_scope_id, target_scope_kind, target_scope_id, route_kind,
      source_stock_id, suggested_quantity, fefo_batch_number, fefo_expiry_date,
      source_batch_available_snapshot, source_surplus_snapshot, target_shortfall_snapshot,
      rationale, suggestion_key, status, first_suggested_at, last_suggested_at
    )
    VALUES (
      p_source_organization_id, p_target_organization_id, v_name, v_code,
      'warehouse', p_source_warehouse_id, 'warehouse', p_target_warehouse_id, 'central_to_institution',
      v_batch.stock_id, v_take, v_batch.batch_number, v_batch.expiry_date,
      v_batch.available_quantity, v_headroom_snapshot, v_deficit_snapshot,
      'cross-org advisory: derived from a real surplus alert, a real shortfall alert, an active supply route and one FEFO batch; acceptance requires a 036-041 exchange request reference',
      v_key, 'open', now(), now()
    )
    ON CONFLICT (suggestion_key) DO UPDATE SET
      suggested_quantity              = EXCLUDED.suggested_quantity,
      fefo_batch_number               = EXCLUDED.fefo_batch_number,
      fefo_expiry_date                = EXCLUDED.fefo_expiry_date,
      source_batch_available_snapshot = EXCLUDED.source_batch_available_snapshot,
      source_surplus_snapshot         = EXCLUDED.source_surplus_snapshot,
      target_shortfall_snapshot       = EXCLUDED.target_shortfall_snapshot,
      last_suggested_at               = now(),
      updated_at                      = now(),
      status                          = 'open'
    WHERE su.status IN ('open', 'superseded', 'expired');

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    CONTINUE WHEN v_rows = 0;

    v_minted := v_minted + 1;
    v_surplus := v_surplus - v_take;
    v_shortfall := v_shortfall - v_take;
  END LOOP;

  IF v_minted = 0 THEN
    RAISE EXCEPTION 'no_eligible_fefo_batch';
  END IF;

  RETURN jsonb_build_object(
    'route_kind', 'central_to_institution',
    'suggestions', v_minted
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_suggest_cross_org_inventory_transfer(uuid, uuid, uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_suggest_cross_org_inventory_transfer(uuid, uuid, uuid, uuid, text, text) TO authenticated;

-- ============================================================================
-- 12. SUGGESTION LIFECYCLE — accept (INTENT ONLY, revalidated) / reject
-- ============================================================================
-- accept re-verifies EVERYTHING against live data before flipping the status:
-- route, scope ownership, batch existence/material/quantity, 071 returnable
-- cap, and — for cross-org — the 036-041 exchange-request reference. A stale
-- suggestion is atomically classified 'expired' with an audited cause, never
-- accepted. Accept records intent ONLY: no stock, movement, dispatch or
-- transfer row is ever written.
CREATE OR REPLACE FUNCTION public.phoenix_accept_inventory_transfer_suggestion(
  p_suggestion_id       uuid,
  p_exchange_request_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_s public.inventory_transfer_suggestions%ROWTYPE;
  v_stale text := NULL;
  v_available integer;
  v_returnable integer;
  v_x public.inter_org_exchange_requests%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  SELECT * INTO v_s FROM public.inventory_transfer_suggestions WHERE id = p_suggestion_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'suggestion_not_found'; END IF;

  -- Permission on the suggestion's ACTUAL endpoints — never (org, NULL, NULL).
  IF NOT (
    public.phoenix_my_role() = 'super_admin'
    OR (v_s.source_scope_kind = 'warehouse' AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'inventory.act_on_suggestions', v_s.source_organization_id, v_s.source_scope_id, NULL))
    OR (v_s.source_scope_kind = 'outlet' AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'inventory.act_on_suggestions', v_s.source_organization_id, NULL, v_s.source_scope_id))
    OR (v_s.target_scope_kind = 'warehouse' AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'inventory.act_on_suggestions', v_s.target_organization_id, v_s.target_scope_id, NULL))
    OR (v_s.target_scope_kind = 'outlet' AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'inventory.act_on_suggestions', v_s.target_organization_id, NULL, v_s.target_scope_id))
  ) THEN RAISE EXCEPTION 'not_authorized_inventory_act'; END IF;
  IF v_s.status <> 'open' THEN RAISE EXCEPTION 'suggestion_not_open'; END IF;

  -- ── REVALIDATION against live data ──────────────────────────────────────
  -- 1. Scope ownership still holds.
  IF public.phoenix_inventory_scope_org(v_s.source_scope_kind, v_s.source_scope_id)
     IS DISTINCT FROM v_s.source_organization_id
     OR public.phoenix_inventory_scope_org(v_s.target_scope_kind, v_s.target_scope_id)
        IS DISTINCT FROM v_s.target_organization_id THEN
    v_stale := 'scope_ownership_changed';
  END IF;

  -- 2. The route/pairing is still live.
  IF v_stale IS NULL THEN
    IF v_s.route_kind = 'warehouse_to_outlet' THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.distribution_points dp
        WHERE dp.id = v_s.target_scope_id
          AND dp.warehouse_id = v_s.source_scope_id
          AND dp.organization_id = v_s.source_organization_id
      ) THEN v_stale := 'warehouse_outlet_pairing_gone'; END IF;
    ELSIF v_s.route_kind = 'outlet_to_warehouse' THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.distribution_points dp
        WHERE dp.id = v_s.source_scope_id
          AND dp.warehouse_id = v_s.target_scope_id
          AND dp.organization_id = v_s.source_organization_id
      ) THEN v_stale := 'outlet_warehouse_pairing_gone'; END IF;
    ELSIF v_s.route_kind = 'central_to_institution' THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.warehouse_supply_routes r
        JOIN public.warehouses sw ON sw.id = r.source_warehouse_id
                                 AND sw.organization_id = v_s.source_organization_id
        JOIN public.warehouses tw ON tw.id = r.target_warehouse_id
                                 AND tw.organization_id = v_s.target_organization_id
        WHERE r.source_warehouse_id = v_s.source_scope_id
          AND r.target_warehouse_id = v_s.target_scope_id
          AND r.is_active
      ) THEN v_stale := 'supply_route_inactive'; END IF;
    END IF;
  END IF;

  -- 3. The batch still exists, still matches, and still covers the quantity.
  IF v_stale IS NULL THEN
    IF v_s.source_scope_kind = 'warehouse' THEN
      SELECT ws.available_quantity INTO v_available
      FROM public.warehouse_stock ws
      WHERE ws.id = v_s.source_stock_id
        AND ws.warehouse_id = v_s.source_scope_id
        AND ws.organization_id = v_s.source_organization_id
        AND lower(ws.scientific_name) = lower(v_s.scientific_name)
        AND (ws.expiry_date IS NULL OR ws.expiry_date >= current_date);
    ELSE
      SELECT os.available_quantity INTO v_available
      FROM public.outlet_stock os
      WHERE os.id = v_s.source_stock_id
        AND os.distribution_point_id = v_s.source_scope_id
        AND os.organization_id = v_s.source_organization_id
        AND lower(os.scientific_name) = lower(v_s.scientific_name)
        AND (os.expiry_date IS NULL OR os.expiry_date >= current_date);
    END IF;
    IF v_available IS NULL THEN
      v_stale := 'source_batch_gone_or_expired';
    ELSIF v_available < v_s.suggested_quantity THEN
      v_stale := 'source_batch_quantity_insufficient';
    END IF;
  END IF;

  -- 4. outlet->warehouse: the 071 returnable cap still covers the quantity.
  IF v_stale IS NULL AND v_s.route_kind = 'outlet_to_warehouse' THEN
    SELECT COALESCE(wdl.received_quantity, 0) - wdl.returned_quantity
      INTO v_returnable
    FROM public.warehouse_dispatch_lines wdl
    WHERE wdl.id = v_s.provenance_dispatch_line_id
      AND wdl.status IN ('accepted', 'accepted_with_difference');
    IF v_returnable IS NULL OR v_returnable < v_s.suggested_quantity THEN
      v_stale := 'returnable_quantity_insufficient';
    END IF;
  END IF;

  -- A stale suggestion is NOT accepted: it expires, audited.
  IF v_stale IS NOT NULL THEN
    UPDATE public.inventory_transfer_suggestions
    SET status = 'expired', reason = v_stale, updated_at = now()
    WHERE id = p_suggestion_id;

    INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
    VALUES (v_s.target_organization_id, v_actor, public.phoenix_my_role(), 'update', 'inventory_transfer_suggestion',
            p_suggestion_id, v_s.route_kind || ':' || v_s.scientific_name,
            jsonb_build_object('lifecycle', 'expire_on_accept', 'cause', v_stale,
                               'source_org', v_s.source_organization_id));

    RETURN jsonb_build_object('id', p_suggestion_id, 'status', 'expired', 'cause', v_stale);
  END IF;

  -- 5. Cross-org acceptance is anchored to the 036-041 engine: a live
  --    exchange request (created through the EXISTING 041 RPC path) whose
  --    organizations and material match. This file never writes that table.
  IF v_s.source_organization_id <> v_s.target_organization_id THEN
    IF p_exchange_request_id IS NULL THEN
      RAISE EXCEPTION 'exchange_request_required_for_cross_org_accept';
    END IF;
    SELECT * INTO v_x FROM public.inter_org_exchange_requests WHERE id = p_exchange_request_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'exchange_request_not_found'; END IF;
    IF v_x.source_organization_id <> v_s.source_organization_id
       OR v_x.target_organization_id <> v_s.target_organization_id THEN
      RAISE EXCEPTION 'exchange_request_organization_mismatch';
    END IF;
    IF lower(v_x.scientific_name) <> lower(v_s.scientific_name) THEN
      RAISE EXCEPTION 'exchange_request_material_mismatch';
    END IF;
    IF v_x.status IN ('source_rejected', 'cancelled', 'completed') THEN
      RAISE EXCEPTION 'exchange_request_terminal';
    END IF;
  ELSIF p_exchange_request_id IS NOT NULL THEN
    RAISE EXCEPTION 'exchange_request_only_for_cross_org';
  END IF;

  -- INTENT ONLY. No stock/movement/dispatch/transfer write, by design.
  UPDATE public.inventory_transfer_suggestions
  SET status = 'accepted', accepted_at = now(), accepted_by = v_actor,
      exchange_request_id = CASE WHEN v_s.source_organization_id <> v_s.target_organization_id
                                 THEN p_exchange_request_id ELSE exchange_request_id END,
      updated_at = now()
  WHERE id = p_suggestion_id;

  INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (v_s.target_organization_id, v_actor, public.phoenix_my_role(), 'update', 'inventory_transfer_suggestion',
          p_suggestion_id, v_s.route_kind || ':' || v_s.scientific_name,
          jsonb_build_object('lifecycle', 'accept', 'intent_only', true,
                             'source_org', v_s.source_organization_id,
                             'exchange_request_id', p_exchange_request_id));

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
  -- Permission on the suggestion's ACTUAL endpoints — never (org, NULL, NULL).
  IF NOT (
    public.phoenix_my_role() = 'super_admin'
    OR (v_s.source_scope_kind = 'warehouse' AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'inventory.act_on_suggestions', v_s.source_organization_id, v_s.source_scope_id, NULL))
    OR (v_s.source_scope_kind = 'outlet' AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'inventory.act_on_suggestions', v_s.source_organization_id, NULL, v_s.source_scope_id))
    OR (v_s.target_scope_kind = 'warehouse' AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'inventory.act_on_suggestions', v_s.target_organization_id, v_s.target_scope_id, NULL))
    OR (v_s.target_scope_kind = 'outlet' AND public.phoenix_profile_has_scoped_permission(
          v_actor, 'inventory.act_on_suggestions', v_s.target_organization_id, NULL, v_s.target_scope_id))
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

REVOKE ALL ON FUNCTION public.phoenix_accept_inventory_transfer_suggestion(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_accept_inventory_transfer_suggestion(uuid, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.phoenix_reject_inventory_transfer_suggestion(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_reject_inventory_transfer_suggestion(uuid, text) TO authenticated;

-- ============================================================================
-- 13. THRESHOLD WRITE — manage_thresholds permission + audit
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
  -- near_expiry_days is a REAL setting (option A): 1..270, NULL = default 270.
  IF p_near_expiry_days IS NOT NULL AND (p_near_expiry_days < 1 OR p_near_expiry_days > 270) THEN
    RAISE EXCEPTION 'near_expiry_days_out_of_range';
  END IF;
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
    -- org-DEFAULT rows (scope_id NULL) are a genuinely org-wide setting: the
    -- one legitimate org-level check on this write path.
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
-- 14. PURGE — manual, safe, retention-bounded, NEVER touches audit_logs
-- ============================================================================
-- Deletes only TERMINAL alerts/suggestions older than an explicit retention
-- (>= 30 days), scoped to the org, permissioned, and NEVER an audit_logs row.
-- No cron: an operator calls this deliberately. Writes its own audit entry.
-- Purge is a genuinely org-wide operation (org-level grant or super_admin).
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
-- 15. RLS — org-scoped; org-wide threshold rows readable at org level;
--     suggestions visible to source OR target OR super_admin
-- ============================================================================
ALTER TABLE public.inventory_signal_thresholds     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_alerts                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_transfer_suggestions  ENABLE ROW LEVEL SECURITY;

-- Thresholds: scoped rows demand the exact-scope read gate; org-wide default
-- rows (scope_id IS NULL) demand super_admin or an org-level
-- inventory.view_signals grant FOR THAT ORGANIZATION. A third organization
-- fails the organization check in both branches; anon holds no grant and
-- auth.uid() is NULL.
DROP POLICY IF EXISTS inventory_thresholds_select_scoped ON public.inventory_signal_thresholds;
CREATE POLICY inventory_thresholds_select_scoped
  ON public.inventory_signal_thresholds FOR SELECT TO authenticated
  USING (
    (scope_id IS NOT NULL
       AND public.phoenix_can_read_inventory_signal(organization_id, scope_kind, scope_id))
    OR (scope_id IS NULL
       AND (public.phoenix_my_role() = 'super_admin'
            OR public.phoenix_profile_has_scoped_permission(
                 auth.uid(), 'inventory.view_signals', organization_id, NULL, NULL)))
  );

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
-- 16. ACL — authenticated reads via RLS only; writes RPC-only; anon nothing
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
-- 17. PERMISSION CATALOG — seven keys, split by action. ENFORCEMENT STAYS OFF.
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
-- 18. POST-CONDITIONS (§ VERIFY)
-- ============================================================================
DO $$
DECLARE v_t text; v_body text; v_qual text;
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

  -- near_expiry_days is implemented: bounded 1..270 and consumed by recompute.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_thresholds_near_expiry_days_chk'
                   AND pg_get_constraintdef(oid) LIKE '%270%') THEN
    RAISE EXCEPTION 'VERIFY FAILED (072): near_expiry_days is not bounded to 1..270';
  END IF;
  v_body := pg_get_functiondef('public.phoenix_recompute_inventory_alerts(uuid,text,uuid)'::regprocedure);
  IF v_body !~* 'near_expiry_days' OR v_body !~* 'eff_days' THEN
    RAISE EXCEPTION 'VERIFY FAILED (072): recompute does not consume near_expiry_days';
  END IF;

  -- episode + dedup + cross-org + batch + provenance + integration columns exist.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
                   AND table_name='inventory_alerts' AND column_name='occurrence_count')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
                   AND table_name='inventory_alerts' AND column_name='cleared_at')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
                   AND table_name='inventory_transfer_suggestions' AND column_name='source_organization_id')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
                   AND table_name='inventory_transfer_suggestions' AND column_name='target_organization_id')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
                   AND table_name='inventory_transfer_suggestions' AND column_name='source_stock_id')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
                   AND table_name='inventory_transfer_suggestions' AND column_name='provenance_dispatch_line_id')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
                   AND table_name='inventory_transfer_suggestions' AND column_name='exchange_request_id') THEN
    RAISE EXCEPTION 'VERIFY FAILED (072): episode/cross-org/batch/provenance/integration columns missing';
  END IF;

  -- the 036-041 integration reference is a REAL foreign key.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.inventory_transfer_suggestions'::regclass
      AND c.contype = 'f'
      AND c.confrelid = 'public.inter_org_exchange_requests'::regclass
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (072): exchange_request_id FK to inter_org_exchange_requests missing';
  END IF;

  -- the 071 provenance chain composite FKs exist.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_suggestions_prov_line_stock_fk' AND contype='f')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_suggestions_prov_movement_line_fk' AND contype='f')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_suggestions_prov_movement_stock_fk' AND contype='f') THEN
    RAISE EXCEPTION 'VERIFY FAILED (072): 071 provenance composite FKs missing';
  END IF;

  -- structural CHECKs: route pairing, same-org corridors, return provenance,
  -- cross-org accept linkage.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_suggestions_route_pairing_chk')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_suggestions_cross_org_route_chk')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_suggestions_return_provenance_chk')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_suggestions_cross_org_accept_link_chk') THEN
    RAISE EXCEPTION 'VERIFY FAILED (072): a structural suggestion CHECK is missing';
  END IF;

  -- structural guard triggers exist on all three tables.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'inventory_threshold_guard'
                   AND tgrelid = 'public.inventory_signal_thresholds'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'inventory_alert_guard'
                   AND tgrelid = 'public.inventory_alerts'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'inventory_suggestion_guard'
                   AND tgrelid = 'public.inventory_transfer_suggestions'::regclass) THEN
    RAISE EXCEPTION 'VERIFY FAILED (072): a structural guard trigger is missing';
  END IF;

  IF to_regclass('public.inventory_alerts_alert_key_uniq') IS NULL
     OR to_regclass('public.inventory_suggestions_key_uniq') IS NULL
     OR to_regclass('public.inventory_thresholds_identity_uniq') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (072): a dedup unique index is missing';
  END IF;

  -- org-wide threshold rows are readable: the policy carries an explicit
  -- scope_id IS NULL branch gated at org level.
  SELECT qual INTO v_qual FROM pg_policies
  WHERE schemaname='public' AND tablename='inventory_signal_thresholds'
    AND policyname='inventory_thresholds_select_scoped';
  IF v_qual IS NULL OR v_qual NOT LIKE '%scope_id IS NULL%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (072): thresholds policy lacks the org-wide (scope_id IS NULL) branch';
  END IF;

  -- accept is intent-only; recompute/suggest/cross-org never write physical
  -- stock, never write the 036-041 exchange tables, and accept/reject check
  -- the ACTUAL scopes (no (org, NULL, NULL) act_on shortcut).
  FOREACH v_t IN ARRAY ARRAY[
    'public.phoenix_accept_inventory_transfer_suggestion(uuid,uuid)',
    'public.phoenix_reject_inventory_transfer_suggestion(uuid,text)',
    'public.phoenix_recompute_inventory_alerts(uuid,text,uuid)',
    'public.phoenix_suggest_inventory_transfers(uuid)',
    'public.phoenix_suggest_cross_org_inventory_transfer(uuid,uuid,uuid,uuid,text,text)'
  ] LOOP
    v_body := pg_get_functiondef(v_t::regprocedure);
    IF v_body ~* 'INSERT\s+INTO\s+public\.(warehouse_stock|outlet_stock|warehouse_stock_movements|outlet_stock_movements|warehouse_dispatches|warehouse_dispatch_lines|warehouse_transfers)'
       OR v_body ~* 'UPDATE\s+public\.(warehouse_stock|outlet_stock)\b' THEN
      RAISE EXCEPTION 'VERIFY FAILED (072): % moves physical stock', v_t;
    END IF;
    IF v_body ~* '(INSERT\s+INTO|UPDATE)\s+public\.inter_org_exchange_(requests|events)' THEN
      RAISE EXCEPTION 'VERIFY FAILED (072): % writes the 036-041 exchange tables', v_t;
    END IF;
  END LOOP;
  FOREACH v_t IN ARRAY ARRAY[
    'public.phoenix_accept_inventory_transfer_suggestion(uuid,uuid)',
    'public.phoenix_reject_inventory_transfer_suggestion(uuid,text)'
  ] LOOP
    v_body := pg_get_functiondef(v_t::regprocedure);
    IF v_body ~* 'act_on_suggestions[^,]*,\s*v_s\.(source|target)_organization_id,\s*NULL,\s*NULL' THEN
      RAISE EXCEPTION 'VERIFY FAILED (072): % still uses an org-level act_on shortcut', v_t;
    END IF;
  END LOOP;

  -- the cross-org path takes NO client quantity: only the derived signature
  -- exists.
  IF to_regprocedure('public.phoenix_suggest_cross_org_inventory_transfer(uuid,uuid,uuid,uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (072): derived cross-org signature missing';
  END IF;
  IF to_regprocedure('public.phoenix_suggest_cross_org_inventory_transfer(uuid,uuid,uuid,uuid,text,text,integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (072): a client-quantity cross-org signature still exists';
  END IF;

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
  IF has_function_privilege('anon', 'public.phoenix_recompute_inventory_alerts(uuid,text,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.phoenix_suggest_inventory_transfers(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.phoenix_accept_inventory_transfer_suggestion(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.phoenix_suggest_cross_org_inventory_transfer(uuid,uuid,uuid,uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (072): anon can execute an inventory RPC';
  END IF;

  -- all seven permission keys registered.
  IF (SELECT count(*) FROM public.permission_keys WHERE key LIKE 'inventory.%') < 7 THEN
    RAISE EXCEPTION 'VERIFY FAILED (072): inventory permission keys not fully registered';
  END IF;

  RAISE NOTICE '072 post-conditions OK.';
END $$;

COMMIT;
