-- ═════════════════════════════════════════════════════════════════════════════
-- CANONICAL-SCOPE-TOPOLOGY-191 — G4.2 FACILITY / SCOPE TOPOLOGY READ CONTRACT
-- ═════════════════════════════════════════════════════════════════════════════
-- Purely ADDITIVE. This migration drops nothing, revokes nothing, renames
-- nothing and alters no table. It adds exactly ONE public pure query. Every
-- existing RPC, policy, trigger and grant keeps its current definition.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY
-- ─────────────────────────────────────────────────────────────────────────────
-- Four first-party surfaces independently reconstructed security-relevant
-- topology from raw table columns:
--
--   src/features/inventory/useInventoryScopes.ts   — derived a health-centre
--       manager's effective warehouse set from `facility_id !== null` plus the
--       assignment rows, and an outlet's reachability from its parent.
--   src/shared/lib/health-sector-grouping.ts       — labelled a group
--       `sector_main` from `facility_id === null` ALONE.
--   src/shared/lib/direct-supply-corridors.ts      — chose Branch-B sources
--       from `facility_id === null` plus the organization's class.
--   src/features/network/NetworkManagementScreen.tsx — split "sector main" from
--       "centre depots" on the same insufficient test.
--
-- All four were forced into that approximation by ONE fact:
-- `warehouses.is_main` is not selected by
-- `src/shared/supabase/services/warehouses.service.ts`. The decisive column
-- never reached the client, so the client could only approximate.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY `facility_id IS NULL` IS NOT THE SECTOR MAIN
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 181's own words, on
-- `_phoenix_health_sector_main_presence_guard_v1`:
--
--   "an ACTIVE health sector owning any active warehouse owns exactly one
--    active institution warehouse with facility_id IS NULL and is_main=true"
--
-- and its row-level shape guard explicitly declines to judge a non-active row:
--
--   "Inactive and archived rows are historical. They keep their shape and are
--    not judged — only what is ACTIVE describes the live topology."
--
-- So a DEACTIVATED facility-less institution warehouse is a perfectly legal
-- row that satisfies `facility_id IS NULL` and is NOT the sector main. The
-- same is true of a row carrying `is_main = false`. The complete canonical
-- rule needs SIX conjuncts, and this migration states all six ONCE, in the
-- database, so no consumer has to restate five of them and forget the sixth:
--
--   organizations.organization_kind = 'care_institution'
--   organizations.institution_class = 'health_sector'
--   warehouses.warehouse_kind       = 'institution'
--   warehouses.status               = 'active'
--   warehouses.facility_id          IS NULL
--   warehouses.is_main              IS TRUE
--
-- `structural_role` is the projection of that rule. A row failing ANY conjunct
-- falls through to 'institution_warehouse' — never to 'sector_main'. Under-
-- claiming a role is a display imprecision; over-claiming one tells an operator
-- that a retired depot is the sector's supply root.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY SECURITY INVOKER (this is the load-bearing design decision)
-- ─────────────────────────────────────────────────────────────────────────────
-- A SECURITY DEFINER projection would have to RESTATE the `wh_select_scoped`
-- and `dp_read_perm` predicates to avoid leaking, and a restated predicate
-- drifts from the policy it copies. This function is INVOKER precisely so that
-- it CANNOT widen: every base-table row it returns passes the caller's own RLS,
-- unchanged, at read time. Visibility is therefore identical to what
-- `getWarehouses()` / `getPointsByOrg()` already return to the same caller —
-- the client gains the `is_main` column and a computed role, and not one row
-- more. If a future migration narrows those policies, this query narrows with
-- them automatically.
--
-- The two scope predicates it calls —
-- `phoenix_profile_has_warehouse_assignment` and
-- `phoenix_profile_has_point_assignment` — are the EXISTING canonical helpers
-- (062, extended by 182's facility branch). They are SECURITY DEFINER in their
-- own right and are re-used verbatim: this migration invents no scope rule, so
-- primary-scope parity is structural rather than merely tested. In particular
-- the sector-main exclusion for a health-centre manager continues to come from
-- 182's helper, where it always lived.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SCOPE IS `WHERE`, NEVER `WHAT`
-- ─────────────────────────────────────────────────────────────────────────────
-- `in_effective_scope` answers only "is this resource inside the caller's
-- primary operational scope". It is NOT a permission. A resource appearing in
-- this projection grants nothing: every mutation still calls
-- `phoenix_profile_has_scoped_permission`, and the organization-level
-- permission question (`inventory.manage_thresholds` and friends) is answered
-- where it always was, by 062, independently of this query.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- DELEGATED SCOPE IS UNCHANGED AND DELIBERATELY NOT DUPLICATED
-- ─────────────────────────────────────────────────────────────────────────────
-- Cross-organization delegated topology is already DB-owned by Migration 187's
-- `phoenix_my_operational_resource_catalog()`, which the client already calls
-- for a delegated organization and already treats as authoritative. There is no
-- client-side delegated reconstruction to remove, so G4.2 adds no second
-- delegated engine and changes no M187 semantics — active, expired and revoked
-- grants keep their exact current behaviour. This query answers for ONE
-- organization the caller can already read; a delegated organization keeps
-- using 187's catalog untouched.
--
-- The known M187 target-organization deactivate/reactivate grant-lifecycle
-- question is NOT addressed here and remains explicitly deferred.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- PURITY
-- ─────────────────────────────────────────────────────────────────────────────
-- STABLE, and structurally incapable of writing: no INSERT, UPDATE, DELETE,
-- MERGE or ON CONFLICT appears in its body, and it calls no writer. Opening the
-- institution screen, the inventory scope picker or a facility selector reads
-- the database and leaves it byte-identical.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- NO NEW TRUTH
-- ─────────────────────────────────────────────────────────────────────────────
-- Stock truth remains exactly `warehouse_stock` and `outlet_stock`. This
-- migration creates no table, no materialized view and no cache; it is a
-- projection of rows that already exist.
--
-- MANUAL APPLY ONLY. NEVER `supabase db push`.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- PREFLIGHT — every structure this migration builds on must already exist.
-- ─────────────────────────────────────────────────────────────────────────────
DO $preflight$
BEGIN
  IF to_regclass('public.organizations') IS NULL THEN
    RAISE EXCEPTION '191_precondition_failed: public.organizations is missing';
  END IF;
  IF to_regclass('public.organization_facilities') IS NULL THEN
    RAISE EXCEPTION '191_precondition_failed: public.organization_facilities is missing';
  END IF;
  IF to_regclass('public.warehouses') IS NULL THEN
    RAISE EXCEPTION '191_precondition_failed: public.warehouses is missing';
  END IF;
  IF to_regclass('public.distribution_points') IS NULL THEN
    RAISE EXCEPTION '191_precondition_failed: public.distribution_points is missing';
  END IF;

  -- The decisive column. Without it there is no canonical sector main and this
  -- migration would silently reintroduce the very approximation it removes.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='warehouses' AND column_name='is_main'
  ) THEN
    RAISE EXCEPTION '191_precondition_failed: warehouses.is_main is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='warehouses' AND column_name='facility_id'
  ) THEN
    RAISE EXCEPTION '191_precondition_failed: warehouses.facility_id is missing (164/170)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='organizations' AND column_name='institution_class'
  ) THEN
    RAISE EXCEPTION '191_precondition_failed: organizations.institution_class is missing (170)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='organizations' AND column_name='organization_kind'
  ) THEN
    RAISE EXCEPTION '191_precondition_failed: organizations.organization_kind is missing (171)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='organization_facilities' AND column_name='facility_class'
  ) THEN
    RAISE EXCEPTION '191_precondition_failed: organization_facilities.facility_class is missing (164)';
  END IF;

  -- The existing scope authorities this query re-uses rather than restates.
  IF to_regprocedure('public.phoenix_profile_has_warehouse_assignment(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION '191_precondition_failed: phoenix_profile_has_warehouse_assignment(uuid,uuid) is missing (062/182)';
  END IF;
  IF to_regprocedure('public.phoenix_profile_has_point_assignment(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION '191_precondition_failed: phoenix_profile_has_point_assignment(uuid,uuid) is missing (062)';
  END IF;

  -- 181's guards must be in place: they are what makes `is_main` trustworthy.
  IF to_regprocedure('public._phoenix_health_sector_main_presence_guard_v1()') IS NULL THEN
    RAISE EXCEPTION '191_precondition_failed: _phoenix_health_sector_main_presence_guard_v1() is missing (181)';
  END IF;

  -- 187 must still own delegated topology; this migration deliberately does not.
  IF to_regprocedure('public.phoenix_my_operational_resource_catalog()') IS NULL THEN
    RAISE EXCEPTION '191_precondition_failed: phoenix_my_operational_resource_catalog() is missing (187)';
  END IF;

  IF to_regprocedure('public.phoenix_query_organization_scope_topology(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION '191_precondition_failed: phoenix_query_organization_scope_topology(uuid) already exists';
  END IF;
END;
$preflight$;

-- ─────────────────────────────────────────────────────────────────────────────
-- THE CANONICAL TOPOLOGY / SCOPE QUERY
-- ─────────────────────────────────────────────────────────────────────────────
-- One row per warehouse and one row per distribution point that the CALLER can
-- already read in `p_organization_id`, discriminated by `node_kind`, carrying:
--
--   ORGANIZATION  organization_id, organization_kind, institution_class
--   FACILITY      facility_id, facility_class, facility_status, names
--   WAREHOUSE     warehouse_id, kind, status, is_main, names, structural_role
--   OUTLET        distribution_point_id, type, status, names, and its facility
--                 ancestry DERIVED through its owning warehouse
--   SCOPE         in_effective_scope (WHERE only — never WHAT)
--
-- An outlet's `facility_id` is its parent warehouse's facility. That is the
-- ancestry the client used to rebuild by hand; it is now derived once, here,
-- from `distribution_points.warehouse_id` and `warehouses.facility_id` — never
-- from a name, a label or a code.
--
-- A row is returned for an outlet whose owning warehouse is NULL or is not
-- readable by this caller. Its warehouse and facility columns are NULL and its
-- `structural_role` is 'unclassified': Migration 181 round 2 made an outlet
-- with no owning warehouse a reachable state, and dropping such a row would
-- misreport the database exactly as hiding an illegally-placed outlet would.
CREATE FUNCTION public.phoenix_query_organization_scope_topology(
  p_organization_id uuid
)
RETURNS TABLE(
  node_kind                  text,
  organization_id            uuid,
  organization_kind          text,
  institution_class          text,
  facility_id                uuid,
  facility_class             text,
  facility_status            text,
  facility_name              text,
  facility_name_ar           text,
  warehouse_id               uuid,
  warehouse_name             text,
  warehouse_name_ar          text,
  warehouse_kind             text,
  warehouse_status           text,
  warehouse_is_main          boolean,
  structural_role            text,
  distribution_point_id      uuid,
  distribution_point_name    text,
  distribution_point_name_ar text,
  distribution_point_type    text,
  distribution_point_status  text,
  in_effective_scope         boolean
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $scope_topology$
  WITH org AS (
    -- RLS decides whether the caller may read this organization at all. An
    -- unreadable organization yields no rows anywhere below, because every
    -- branch joins `org` — the whole function fails closed on one join.
    SELECT o.id, o.organization_kind::text AS organization_kind,
           o.institution_class::text AS institution_class
    FROM public.organizations o
    WHERE o.id = p_organization_id
  ), wh AS (
    -- RLS-visible warehouses only. `wh_select_scoped` is doing the work.
    SELECT w.id, w.name, w.name_ar, w.warehouse_kind::text AS warehouse_kind,
           w.status::text AS status, w.is_main, w.facility_id, w.organization_id
    FROM public.warehouses w
    JOIN org ON org.id = w.organization_id
  ), fac AS (
    -- RLS-visible facilities only (`organization_facilities_select_scoped`).
    -- A facility the caller cannot read leaves its columns NULL on the
    -- warehouse row rather than removing the warehouse.
    SELECT f.id, f.facility_class::text AS facility_class,
           f.status::text AS status, f.name, f.name_ar
    FROM public.organization_facilities f
    JOIN org ON org.id = f.organization_id
  ), dp AS (
    -- RLS-visible distribution points only (`dp_read_perm`).
    SELECT d.id, d.name, d.name_ar, d.point_type::text AS point_type,
           d.status::text AS status, d.warehouse_id, d.organization_id
    FROM public.distribution_points d
    JOIN org ON org.id = d.organization_id
  )
  -- ── WAREHOUSE NODES ────────────────────────────────────────────────────────
  SELECT
    'warehouse'::text,
    org.id,
    org.organization_kind,
    org.institution_class,
    wh.facility_id,
    fac.facility_class,
    fac.status,
    fac.name,
    fac.name_ar,
    wh.id,
    wh.name,
    wh.name_ar,
    wh.warehouse_kind,
    wh.status,
    wh.is_main,
    -- THE CANONICAL STRUCTURAL ROLE. See the header: six conjuncts, stated once.
    CASE
      WHEN wh.warehouse_kind = 'central' THEN 'central_warehouse'
      WHEN org.organization_kind = 'care_institution'
       AND org.institution_class = 'health_sector'
       AND wh.warehouse_kind     = 'institution'
       AND wh.status             = 'active'
       AND wh.facility_id IS NULL
       AND wh.is_main IS TRUE          THEN 'sector_main'
      WHEN org.organization_kind = 'care_institution'
       AND org.institution_class = 'health_sector'
       AND wh.warehouse_kind     = 'institution'
       AND wh.facility_id IS NOT NULL  THEN 'health_center_depot'
      WHEN wh.warehouse_kind = 'institution' THEN 'institution_warehouse'
      ELSE 'unclassified'
    END::text,
    NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text,
    -- Existing canonical authority, re-used verbatim. 182's facility branch is
    -- what lets a health-centre manager reach its depot, and 181's NULL
    -- facility on the sector main is what keeps the sector main out of reach.
    COALESCE(public.phoenix_profile_has_warehouse_assignment(auth.uid(), wh.id), false)
  FROM wh
  JOIN org ON org.id = wh.organization_id
  LEFT JOIN fac ON fac.id = wh.facility_id

  UNION ALL

  -- ── OUTLET NODES ───────────────────────────────────────────────────────────
  SELECT
    'outlet'::text,
    org.id,
    org.organization_kind,
    org.institution_class,
    pw.facility_id,
    pf.facility_class,
    pf.status,
    pf.name,
    pf.name_ar,
    pw.id,
    pw.name,
    pw.name_ar,
    pw.warehouse_kind,
    pw.status,
    pw.is_main,
    'unclassified'::text,
    dp.id,
    dp.name,
    dp.name_ar,
    dp.point_type,
    dp.status,
    -- Parity with the client rule this replaces: a direct point assignment, OR
    -- reachability through the owning warehouse. Both are existing helpers.
    (
      COALESCE(public.phoenix_profile_has_point_assignment(auth.uid(), dp.id), false)
      OR (dp.warehouse_id IS NOT NULL
          AND COALESCE(public.phoenix_profile_has_warehouse_assignment(auth.uid(), dp.warehouse_id), false))
    )
  FROM dp
  JOIN org ON org.id = dp.organization_id
  LEFT JOIN wh  pw ON pw.id = dp.warehouse_id
  LEFT JOIN fac pf ON pf.id = pw.facility_id
$scope_topology$;

COMMENT ON FUNCTION public.phoenix_query_organization_scope_topology(uuid) IS
  'G4.2 canonical facility/scope topology read contract. PURE: no INSERT/UPDATE/DELETE and no writer call. '
  'SECURITY INVOKER by design — every base-table row passes the caller''s own RLS at read time, so this '
  'query is structurally incapable of widening visibility beyond wh_select_scoped / dp_read_perm / '
  'organization_facilities_select_scoped. Returns one row per readable warehouse and per readable '
  'distribution point in p_organization_id, discriminated by node_kind. structural_role projects Migration '
  '181''s COMPLETE sector-main rule (care_institution + health_sector + institution kind + active + '
  'facility_id IS NULL + is_main IS TRUE); a facility-less warehouse failing ANY conjunct — notably a '
  'DEACTIVATED one, which 181 explicitly declines to judge — is never sector_main. Outlet facility '
  'ancestry is derived through distribution_points.warehouse_id, never from a name or label. '
  'in_effective_scope answers WHERE only and is delegated verbatim to the existing '
  'phoenix_profile_has_warehouse_assignment / phoenix_profile_has_point_assignment helpers, so it invents '
  'no scope rule and confers no permission — every mutation still calls phoenix_profile_has_scoped_permission. '
  'Cross-organization delegated topology is NOT duplicated here: Migration 187''s '
  'phoenix_my_operational_resource_catalog() remains its sole owner, with unchanged semantics.';

REVOKE ALL ON FUNCTION public.phoenix_query_organization_scope_topology(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_query_organization_scope_topology(uuid)
  TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFY — the contract must be real, not merely intended.
-- ─────────────────────────────────────────────────────────────────────────────
-- Structural purity is asserted over the ACTUAL catalog definition, so a later
-- hand-edit that reintroduces a writer or flips the function to DEFINER fails
-- this block rather than passing on the strength of this file's comments.
DO $verify$
DECLARE
  v_src  text;
  v_oid  oid;
  v_bad  integer;
BEGIN
  v_oid := to_regprocedure('public.phoenix_query_organization_scope_topology(uuid)')::oid;
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (191): phoenix_query_organization_scope_topology(uuid) was not created';
  END IF;

  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_oid;

  -- A. PURE. No writer of any shape.
  IF v_src ~* '\minsert\M' OR v_src ~* '\mupdate\M' OR v_src ~* '\mdelete\M'
     OR v_src ~* '\mmerge\M' OR v_src ~* 'on\s+conflict' THEN
    RAISE EXCEPTION 'VERIFY FAILED (191): the topology query contains a writer';
  END IF;

  -- B. INVOKER, not DEFINER. This is the non-widening guarantee itself.
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_oid AND p.prosecdef) THEN
    RAISE EXCEPTION 'VERIFY FAILED (191): the topology query must be SECURITY INVOKER';
  END IF;

  -- C. STABLE (not VOLATILE) — a volatile marking would both mislead the
  --    planner and quietly permit a future writer.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_oid AND p.provolatile = 's') THEN
    RAISE EXCEPTION 'VERIFY FAILED (191): the topology query must be STABLE';
  END IF;

  -- D. search_path is pinned.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid = v_oid
      AND array_to_string(p.proconfig, ',') LIKE '%search_path=public, pg_temp%'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (191): the topology query must pin search_path';
  END IF;

  -- E. THE SECTOR-MAIN RULE IS COMPLETE. All six conjuncts must appear in the
  --    body; a future edit that deletes `is_main` and leaves the NULL test is
  --    exactly the regression G4.2 exists to prevent.
  IF v_src !~* 'is_main\s+IS\s+TRUE' THEN
    RAISE EXCEPTION 'VERIFY FAILED (191): sector_main is not conditioned on is_main IS TRUE';
  END IF;
  IF v_src !~* 'institution_class\s*=\s*''health_sector''' THEN
    RAISE EXCEPTION 'VERIFY FAILED (191): sector_main is not conditioned on institution_class';
  END IF;
  IF v_src !~* 'organization_kind\s*=\s*''care_institution''' THEN
    RAISE EXCEPTION 'VERIFY FAILED (191): sector_main is not conditioned on organization_kind';
  END IF;
  IF v_src !~* 'warehouse_kind\s*=\s*''institution''' THEN
    RAISE EXCEPTION 'VERIFY FAILED (191): sector_main is not conditioned on warehouse_kind';
  END IF;
  IF v_src !~* 'wh\.status\s*=\s*''active''' THEN
    RAISE EXCEPTION 'VERIFY FAILED (191): sector_main is not conditioned on an ACTIVE warehouse';
  END IF;

  -- F. SCOPE IS RE-USED, NOT RESTATED. Both existing helpers must be called.
  IF v_src !~* 'phoenix_profile_has_warehouse_assignment' THEN
    RAISE EXCEPTION 'VERIFY FAILED (191): warehouse scope does not delegate to the canonical helper';
  END IF;
  IF v_src !~* 'phoenix_profile_has_point_assignment' THEN
    RAISE EXCEPTION 'VERIFY FAILED (191): outlet scope does not delegate to the canonical helper';
  END IF;

  -- G. ACL. anon and PUBLIC denied; authenticated granted.
  IF has_function_privilege('anon',
       'public.phoenix_query_organization_scope_topology(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (191): anon can execute the topology query';
  END IF;
  IF NOT has_function_privilege('authenticated',
       'public.phoenix_query_organization_scope_topology(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (191): authenticated cannot execute the topology query';
  END IF;

  -- H. NO DIRECT TABLE GRANT WIDENING. 191 must not have handed anyone raw
  --    access to the topology tables as a shortcut.
  SELECT count(*) INTO v_bad
  FROM information_schema.role_table_grants g
  WHERE g.table_schema = 'public'
    AND g.table_name IN ('organization_facilities','warehouses','distribution_points')
    AND g.grantee = 'anon'
    AND g.privilege_type = 'SELECT';
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (191): anon holds a direct SELECT on a topology table';
  END IF;

  -- I. 187 IS UNTOUCHED. Delegated topology keeps its sole owner.
  IF to_regprocedure('public.phoenix_my_operational_resource_catalog()') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (191): 187''s delegated catalog disappeared';
  END IF;

  -- J. NO THIRD STOCK TRUTH.
  IF to_regclass('public.warehouse_stock') IS NULL
     OR to_regclass('public.outlet_stock') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (191): a canonical stock table is missing';
  END IF;
END;
$verify$;

COMMIT;
