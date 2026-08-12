-- ============================================================================
-- R1.1 — HEALTH-SECTOR TOPOLOGY RECONCILIATION + HARDENING (181)
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
--
-- Production DDL is applied ONCE, after 180, by the authorized operator through
-- `Supabase.apply_migration`, following an exact-ceiling preflight, the
-- network-wide health-sector classification read recorded in this PR, and
-- independent approval. `supabase db push` remains forbidden outright.
-- (Historical migrations carry older apply wording in their own headers and are
-- NOT edited to match — they are immutable.)
--
-- NOT APPLIED BY THIS PR. Authored and replayed on a disposable PostgreSQL rig
-- only. Migrations 001-180 are immutable and are NOT edited here.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE AUTHORITATIVE HEALTH-SECTOR SHAPE
-- ─────────────────────────────────────────────────────────────────────────────
--   health_sector                        (ONE care_institution organization)
--     ├── sector main depot              institution · facility_id NULL · main
--     ├── health centre A                organization_facilities row
--     │     └── centre depot A           institution · facility_id A · not main
--     │           ├── pharmacy
--     │           └── crash cabinet(s)   clinical_location_kind='emergency'
--     └── health centre B …
--
-- A health centre is a FACILITY, never a peer organization. There is no unit
-- domain: no health_center_units, no unit stock, no unit routes, no unit
-- scopes. The facility IS the subordinate topology boundary.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THE SECTOR MAIN IS `institution`, NOT `central`
-- ─────────────────────────────────────────────────────────────────────────────
-- phoenix_assert_direct_supply_endpoints already carries BRANCH B (165:180-192),
-- whose shape test is precisely:
--
--     src.warehouse_kind = 'institution' AND src.facility_id IS NULL
--     AND dst.warehouse_kind = 'institution' AND dst.facility_id IS NOT NULL
--     AND src.organization_id = dst.organization_id
--
-- followed by institution_class='health_sector' and an active destination
-- facility of class primary_health_center | subordinate_health_center. The
-- canonical same-sector corridor is therefore ALREADY route-free and already
-- expects an INSTITUTION source with no facility.
--
-- So this migration does NOT:
--   * model the sector main as warehouse_kind='central';
--   * reinterpret the legacy central -> institution meaning;
--   * create a warehouse_supply_routes row for sector -> centre;
--   * touch phoenix_supply_route_assert_endpoints.
--
-- The corridor is reused exactly as shipped. This file only makes the SHAPE it
-- already depends on a database invariant instead of a UI convention.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE DEFECT THIS RECONCILES
-- ─────────────────────────────────────────────────────────────────────────────
-- `warehouses.is_main` is constrained today only by
-- warehouses_main_requires_active_chk (main => active) and the partial unique
-- warehouses_one_active_main_per_org_uniq (one active main per organization).
-- NOTHING ties is_main to facility_id. A health sector can therefore have its
-- HEALTH-CENTRE DEPOT carrying the organization's main flag while no
-- sector-level warehouse exists at all — which is exactly the legacy shape
-- observed in the field:
--
--     health_sector
--       └── centre depot   institution · facility_id = centre · is_main = TRUE
--     (no facility_id IS NULL warehouse anywhere)
--
-- In that shape Branch B has no legal source, so the sector cannot supply its
-- own centres, and the organization's "main" points at a subordinate node.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ORDERING — WHY THE GUARDS ARE INSTALLED **BEFORE** RECONCILIATION
-- ─────────────────────────────────────────────────────────────────────────────
-- warehouses_one_active_main_per_org_uniq permits one active main per
-- organization, so the new sector main cannot be inserted while the legacy
-- centre depot still holds the flag: the legacy main must be demoted FIRST.
-- That leaves a transient "no main" moment between two statements.
--
-- The guards are nevertheless installed first, and that is provably safe:
--
--   * the ROW-LEVEL shape guard (section 2) only ever judges the row in front
--     of it. The demotion produces a valid centre depot (facility non-null,
--     is_main false) and the insert produces a valid sector main (institution,
--     facility NULL, is_main true), so both statements pass on their own terms;
--
--   * the ORGANIZATION-LEVEL invariant (section 3) — "an active health sector
--     that owns any active warehouse owns exactly one valid sector main" —
--     is a DEFERRABLE INITIALLY DEFERRED constraint trigger. It is evaluated at
--     COMMIT, never between statements, so the transient state is never judged
--     and, being inside one transaction, is never visible to any other session
--     either.
--
-- That is the whole reason the org-level rule is a deferred constraint trigger
-- rather than an immediate one: it lets a legitimate two-statement correction —
-- this migration's, or a future operator's — happen atomically, while still
-- making it impossible to COMMIT a health sector that has centre depots and no
-- sector main.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SCOPE — WHAT THIS MIGRATION DOES NOT DO
-- ─────────────────────────────────────────────────────────────────────────────
-- No Production UUID literal, no organization-name matching, no Production-only
-- identifier: health sectors are resolved structurally through
-- organizations.institution_class = 'health_sector'. No business data is
-- deleted, no Production reset is encoded, and no stock or movement row is
-- created, moved or altered — the reconciliation writes exactly one UPDATE of a
-- single boolean and one INSERT of a warehouse row per legacy sector.
--
-- Migration 180's supply semantics are untouched: centre depot -> pharmacy is
-- ordinary warehouse dispatch, centre depot -> crash cabinet is initial
-- provisioning only, pharmacy -> crash cabinet is routine replenishment only
-- after the initial lifecycle is consumed. R1.3 owns any further change there.
--
-- Exactly two stock truths remain: warehouse_stock and outlet_stock.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 0. PRECONDITIONS — fail closed
-- ============================================================================
DO $preflight$
BEGIN
  -- Tables and columns this migration reasons about.
  IF to_regclass('public.organizations') IS NULL
     OR to_regclass('public.organization_facilities') IS NULL
     OR to_regclass('public.warehouses') IS NULL
     OR to_regclass('public.distribution_points') IS NULL THEN
    RAISE EXCEPTION '181_precondition_failed: a core topology table is absent';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='organizations' AND column_name='institution_class'
  ) THEN
    RAISE EXCEPTION '181_precondition_failed: organizations.institution_class (164) is absent';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='warehouses' AND column_name='facility_id'
  ) THEN
    RAISE EXCEPTION '181_precondition_failed: warehouses.facility_id (164) is absent';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='distribution_points' AND column_name='clinical_location_kind'
  ) THEN
    RAISE EXCEPTION '181_precondition_failed: distribution_points.clinical_location_kind (164) is absent';
  END IF;

  -- The facility-class vocabulary the invariants key on.
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='of_facility_class_chk')
     NOT LIKE '%primary_health_center%' THEN
    RAISE EXCEPTION '181_precondition_failed: the 164 facility-class vocabulary changed';
  END IF;

  -- The main-warehouse invariant this migration must preserve and order around.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='warehouses_one_active_main_per_org_uniq'
  ) THEN
    RAISE EXCEPTION '181_precondition_failed: warehouses_one_active_main_per_org_uniq is absent';
  END IF;

  -- The composite FK that already guarantees a facility belongs to the same
  -- organization as its warehouse. The invariants below rely on it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='warehouses_facility_org_fk'
  ) THEN
    RAISE EXCEPTION '181_precondition_failed: warehouses_facility_org_fk (164) is absent';
  END IF;

  -- The canonical same-sector corridor this topology exists to serve. Branch B
  -- must still be present and must still expect an institution/NULL source.
  IF to_regprocedure('public.phoenix_assert_direct_supply_endpoints(uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION '181_precondition_failed: phoenix_assert_direct_supply_endpoints is absent';
  END IF;
  IF pg_get_functiondef('public.phoenix_assert_direct_supply_endpoints(uuid,uuid,uuid)'::regprocedure)
     NOT LIKE '%v_src.facility_id IS NULL%' THEN
    RAISE EXCEPTION '181_precondition_failed: Branch B no longer expects a facility-less institution source';
  END IF;

  -- The historical management authority this migration reuses unchanged.
  IF to_regprocedure('public.phoenix_create_warehouse(uuid,text,text,text,text,boolean)') IS NULL THEN
    RAISE EXCEPTION '181_precondition_failed: phoenix_create_warehouse (074) is absent';
  END IF;
  IF to_regprocedure('public.phoenix_assign_warehouse_facility(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION '181_precondition_failed: phoenix_assign_warehouse_facility (170) is absent';
  END IF;

  -- Migration 180 must still own the emergency corridor: R1.1 changes topology
  -- only and must not be applied to a chain where 180 is missing.
  IF to_regprocedure('public._phoenix_180_delegate_create_warehouse_dispatch(uuid,uuid,text,text,text,text,text)') IS NULL THEN
    RAISE EXCEPTION '181_precondition_failed: Migration 180 is not applied';
  END IF;

  -- Idempotency guard: this migration is not re-runnable.
  IF to_regprocedure('public.phoenix_create_health_center_warehouse(uuid,uuid,text,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION '181_precondition_failed: the 181 centre-depot writer already exists';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='warehouses_health_sector_shape_guard_trg') THEN
    RAISE EXCEPTION '181_precondition_failed: the 181 warehouse shape guard already exists';
  END IF;
END;
$preflight$;

-- ============================================================================
-- 1. ROW-LEVEL SHAPE GUARD — every health-sector warehouse, every write path
-- ============================================================================
-- The frontend writes warehouses through RPCs today, but RLS-protected direct
-- writes and future callers must hit the same wall, so the rule lives in a
-- trigger on the table rather than in any one writer.
--
-- COVERAGE. Health-sector warehouse validity can change through INSERT and
-- through UPDATE of organization_id (moving a warehouse into or out of a health
-- sector), warehouse_kind (institution -> central), facility_id (sector main
-- gaining a facility, centre depot losing one), is_main (a centre depot being
-- promoted) and status (reactivating an invalid archived shape). The trigger
-- therefore fires on all five, not on facility_id alone.
--
-- SECURITY DEFINER for the same reason Migration 178 had to add it to the
-- outlet guard: this function takes a locking read (FOR SHARE) on
-- organizations, which PostgreSQL only permits with UPDATE/DELETE privilege,
-- and `authenticated` holds SELECT only. Running as the definer also makes the
-- ownership test immune to caller RLS visibility.
CREATE FUNCTION public._phoenix_health_sector_warehouse_shape_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_class    text;
  v_facility public.organization_facilities%ROWTYPE;
BEGIN
  SELECT o.institution_class INTO v_class
  FROM public.organizations o WHERE o.id = NEW.organization_id FOR SHARE;

  -- Every other organization class keeps its existing freedom untouched.
  IF v_class IS DISTINCT FROM 'health_sector' THEN
    RETURN NEW;
  END IF;

  -- A status downgrade must serialize against a concurrent outlet INSERT (its
  -- FK takes FOR KEY SHARE). Escalating this row to FOR UPDATE closes the same
  -- write-skew window Migration 170 closes for facility reassignment.
  IF OLD.status = 'active' AND NEW.status IS DISTINCT FROM 'active' THEN
    PERFORM 1 FROM public.warehouses WHERE id = NEW.id FOR UPDATE;
    IF EXISTS (
      SELECT 1 FROM public.distribution_points dp
      WHERE dp.warehouse_id = NEW.id AND dp.status = 'active'
    ) THEN
      RAISE EXCEPTION 'health_center_depot_deactivation_blocked_by_active_outlet'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- A. A health sector has no central warehouses. Its own supply corridor
  --    (Branch B) is institution -> institution; a central node here would be
  --    unreachable by it and would silently divert to the legacy corridor.
  IF NEW.warehouse_kind IS DISTINCT FROM 'institution' THEN
    RAISE EXCEPTION 'health_sector_warehouse_must_be_institution: %', NEW.warehouse_kind
      USING ERRCODE = '23514';
  END IF;

  -- Inactive and archived rows are historical. They keep their shape and are
  -- not judged — only what is ACTIVE describes the live topology. Reactivating
  -- a row re-enters this guard (status is in the trigger's column list), so an
  -- invalid archived shape can never be revived.
  IF NEW.status IS DISTINCT FROM 'active' THEN
    RETURN NEW;
  END IF;

  IF NEW.facility_id IS NULL THEN
    -- B. The sector main: facility-less and, being the organization's root
    --    supply node, necessarily its main.
    IF NEW.is_main IS NOT TRUE THEN
      RAISE EXCEPTION 'health_sector_facility_less_warehouse_must_be_main'
        USING ERRCODE = '23514',
        DETAIL = 'an active health-sector warehouse with no facility is the sector main and must carry is_main=true';
    END IF;
  ELSE
    -- C. A centre depot is subordinate and must never hold the organization
    --    main flag.
    IF NEW.is_main IS NOT FALSE THEN
      RAISE EXCEPTION 'health_center_depot_must_not_be_main'
        USING ERRCODE = '23514',
        DETAIL = 'a facility-bound health-sector depot is subordinate to the sector main';
    END IF;

    -- D. The facility must be a live health centre. The composite FK
    --    warehouses_facility_org_fk already guarantees same-organization, so
    --    this adds the class and status rules the FK cannot express.
    SELECT * INTO v_facility
    FROM public.organization_facilities WHERE id = NEW.facility_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'health_center_facility_not_found' USING ERRCODE = 'P0002';
    END IF;
    IF v_facility.organization_id IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'health_center_facility_organization_mismatch' USING ERRCODE = '42501';
    END IF;
    IF v_facility.facility_class NOT IN ('primary_health_center', 'subordinate_health_center') THEN
      RAISE EXCEPTION 'invalid_health_center_facility_class: %', v_facility.facility_class
        USING ERRCODE = '23514';
    END IF;
    IF v_facility.status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'health_center_facility_not_active' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER warehouses_health_sector_shape_guard_trg
  BEFORE INSERT OR UPDATE OF organization_id, warehouse_kind, facility_id, is_main, status
  ON public.warehouses
  FOR EACH ROW
  EXECUTE FUNCTION public._phoenix_health_sector_warehouse_shape_guard_v1();

REVOKE ALL ON FUNCTION public._phoenix_health_sector_warehouse_shape_guard_v1()
  FROM PUBLIC, anon, authenticated, service_role;

-- ============================================================================
-- 3. FACILITY-SIDE INVARIANT — a live depot keeps a live health-centre parent
-- ============================================================================
-- The warehouse trigger validates the facility when a depot is written. The
-- inverse mutation surface matters too: changing organization_id, class or
-- status on the parent facility must not invalidate an already-active depot.
CREATE FUNCTION public._phoenix_health_center_facility_shape_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF (NEW.organization_id IS DISTINCT FROM OLD.organization_id
      OR NEW.facility_class IS DISTINCT FROM OLD.facility_class
      OR NEW.status IS DISTINCT FROM OLD.status)
     AND (NEW.status IS DISTINCT FROM 'active'
          OR NEW.facility_class NOT IN ('primary_health_center', 'subordinate_health_center')
          OR NEW.organization_id IS DISTINCT FROM OLD.organization_id) THEN
    -- A depot INSERT takes FOR KEY SHARE on this facility through its FK. The
    -- explicit upgrade makes it wait (or makes us wait for it), so the EXISTS
    -- check cannot miss a concurrently-created active depot.
    PERFORM 1 FROM public.organization_facilities WHERE id = OLD.id FOR UPDATE;
    IF EXISTS (
      SELECT 1 FROM public.warehouses w
      WHERE w.facility_id = OLD.id AND w.status = 'active'
    ) THEN
      RAISE EXCEPTION 'health_center_facility_change_blocked_by_active_depot'
        USING ERRCODE = '23514',
        DETAIL = 'retire or rehome the active centre depot before changing its facility ownership, class, or status';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER organization_facilities_health_center_shape_guard_trg
  BEFORE UPDATE OF organization_id, facility_class, status
  ON public.organization_facilities
  FOR EACH ROW
  EXECUTE FUNCTION public._phoenix_health_center_facility_shape_guard_v1();

REVOKE ALL ON FUNCTION public._phoenix_health_center_facility_shape_guard_v1()
  FROM PUBLIC, anon, authenticated, service_role;

-- ============================================================================
-- 4. ORGANIZATION-LEVEL INVARIANT — a sector never loses its only main
-- ============================================================================
-- Section 2 judges one row at a time and therefore cannot see "this sector now
-- has centre depots and no sector main". That is an organization-level fact,
-- and it must survive an ordinary deactivate / archive / demote path, not just
-- a deliberate one.
--
-- DEFERRABLE INITIALLY DEFERRED, evaluated at COMMIT. That is what makes a
-- legitimate two-statement correction possible — demote the old main, create
-- the new one — while making it impossible to COMMIT a sector left with
-- subordinate depots and no root. The transient state exists only inside the
-- transaction and is never visible to another session.
--
-- Fires on DELETE too: removing the sector main is the same loss by another
-- route.
CREATE FUNCTION public._phoenix_health_sector_main_presence_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org        uuid;
  v_orgs       uuid[];
  v_class      text;
  v_org_status text;
  v_active     integer;
  v_mains      integer;
BEGIN
  v_orgs := CASE TG_OP
    WHEN 'INSERT' THEN ARRAY[NEW.organization_id]
    WHEN 'DELETE' THEN ARRAY[OLD.organization_id]
    ELSE ARRAY[OLD.organization_id, NEW.organization_id]
  END;

  FOREACH v_org IN ARRAY v_orgs LOOP
  IF v_org IS NULL THEN CONTINUE; END IF;

  SELECT o.institution_class, o.status INTO v_class, v_org_status
  FROM public.organizations o WHERE o.id = v_org;

  IF v_class IS DISTINCT FROM 'health_sector' THEN
    CONTINUE;
  END IF;
  -- An organization that is not itself active is not asserting a live topology.
  IF v_org_status IS DISTINCT FROM 'active' THEN
    CONTINUE;
  END IF;

  SELECT
    count(*) FILTER (WHERE w.status = 'active'),
    count(*) FILTER (WHERE w.status = 'active'
                       AND w.facility_id IS NULL
                       AND w.is_main
                       AND w.warehouse_kind = 'institution')
  INTO v_active, v_mains
  FROM public.warehouses w
  WHERE w.organization_id = v_org;

  IF v_mains = 0 THEN
    RAISE EXCEPTION 'health_sector_must_retain_a_sector_main'
      USING ERRCODE = '23514',
      DETAIL = 'an active health sector owning active warehouses must own exactly one active institution warehouse with facility_id IS NULL and is_main=true';
  END IF;
  -- Belt and braces: warehouses_one_active_main_per_org_uniq already makes two
  -- impossible, so this can only fire if that index were ever dropped.
  IF v_mains > 1 THEN
    RAISE EXCEPTION 'health_sector_has_multiple_sector_mains' USING ERRCODE = '23505';
  END IF;
  END LOOP;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER warehouses_health_sector_main_presence_trg
  AFTER INSERT OR UPDATE OR DELETE ON public.warehouses
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public._phoenix_health_sector_main_presence_guard_v1();

REVOKE ALL ON FUNCTION public._phoenix_health_sector_main_presence_guard_v1()
  FROM PUBLIC, anon, authenticated, service_role;

-- ============================================================================
-- 5. ORGANIZATION ACTIVATION — no invalid topology may be revived
-- ============================================================================
CREATE FUNCTION public._phoenix_health_sector_organization_activation_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_active integer;
  v_mains  integer;
BEGIN
  IF NEW.status = 'active'
     AND OLD.status IS DISTINCT FROM 'active'
     AND NEW.institution_class = 'health_sector' THEN
    SELECT count(*) FILTER (WHERE w.status='active'),
           count(*) FILTER (WHERE w.status='active'
                              AND w.warehouse_kind='institution'
                              AND w.facility_id IS NULL AND w.is_main)
    INTO v_active, v_mains
    FROM public.warehouses w
    WHERE w.organization_id = NEW.id;

    IF v_active > 0 AND v_mains <> 1 THEN
      RAISE EXCEPTION 'health_sector_activation_requires_valid_topology'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER organizations_health_sector_activation_guard_trg
  BEFORE UPDATE OF status
  ON public.organizations
  FOR EACH ROW
  EXECUTE FUNCTION public._phoenix_health_sector_organization_activation_guard_v1();

REVOKE ALL ON FUNCTION public._phoenix_health_sector_organization_activation_guard_v1()
  FROM PUBLIC, anon, authenticated, service_role;

-- ============================================================================
-- 6. OUTLET TOPOLOGY GUARD — outlets belong to health CENTRES, never to the sector
-- ============================================================================
-- The frontend creates and edits distribution_points by direct RLS-protected
-- INSERT/UPDATE, so the database must be the topology authority here rather
-- than the screen.
--
-- COVERAGE. An outlet's legality can change through INSERT and through UPDATE
-- of warehouse_id (rehoming, including onto the sector main), organization_id,
-- point_type (pharmacy -> rescue_cart), clinical_location_kind (a crash cabinet
-- losing its emergency context) and status (reactivating an invalid outlet).
--
-- SECURITY DEFINER for Migration 178's reason: the FOR SHARE read on warehouses
-- is a locking read that `authenticated` may not take, and the definer context
-- also makes the ownership test immune to caller RLS visibility. That FOR SHARE
-- additionally conflicts with the section-2 guard's FOR UPDATE, giving the same
-- two-sided serialization Migrations 170/171 already rely on.
CREATE FUNCTION public._phoenix_health_sector_outlet_topology_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_wh    public.warehouses%ROWTYPE;
  v_class text;
BEGIN
  -- Inactive and archived outlets are historical rows, not live topology.
  IF NEW.status IS DISTINCT FROM 'active' THEN
    RETURN NEW;
  END IF;
  IF NEW.warehouse_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_wh FROM public.warehouses WHERE id = NEW.warehouse_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'outlet_warehouse_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT o.institution_class INTO v_class
  FROM public.organizations o WHERE o.id = v_wh.organization_id;

  IF v_class IS DISTINCT FROM 'health_sector' THEN
    RETURN NEW;
  END IF;

  -- A. An outlet lives under a health CENTRE. The sector main is a supply root,
  --    not a dispensing location — this single rule forbids every sector-level
  --    pharmacy, crash cabinet and rescue cart at once.
  IF v_wh.facility_id IS NULL THEN
    RAISE EXCEPTION 'health_sector_outlet_requires_health_center_depot'
      USING ERRCODE = '23514',
      DETAIL = 'an active outlet must hang off a facility-bound centre depot, never off the sector main';
  END IF;

  IF v_wh.status IS DISTINCT FROM 'active'
     OR v_wh.warehouse_kind IS DISTINCT FROM 'institution'
     OR v_wh.is_main IS NOT FALSE THEN
    RAISE EXCEPTION 'health_sector_outlet_requires_active_health_center_depot'
      USING ERRCODE = '23514',
      DETAIL = 'the owning warehouse must be an active institution, facility-bound, non-main centre depot';
  END IF;

  -- B. A health centre runs a pharmacy and crash cabinets. Rescue carts are a
  --    hospital emergency-department concept and have no health-centre
  --    counterpart — Migration 168 already refuses to replenish one here
  --    (health_center_rescue_cart_forbidden); this stops one existing at all.
  IF NEW.point_type = 'rescue_cart' THEN
    RAISE EXCEPTION 'health_center_rescue_cart_not_permitted' USING ERRCODE = '23514';
  END IF;
  IF NEW.point_type NOT IN ('pharmacy', 'crash_cabinet') THEN
    RAISE EXCEPTION 'health_center_outlet_type_not_permitted: %', NEW.point_type
      USING ERRCODE = '23514';
  END IF;

  -- C. A health-centre crash cabinet is an emergency location, and Migration
  --    168's Shape H requires exactly that to replenish it. Requiring it at
  --    creation stops an outlet being born into a shape that can never be
  --    supplied.
  --
  --    An ordinary centre PHARMACY deliberately carries no clinical-location
  --    requirement: NULL is valid and is the live shape today.
  IF NEW.point_type = 'crash_cabinet'
     AND NEW.clinical_location_kind IS DISTINCT FROM 'emergency' THEN
    RAISE EXCEPTION 'health_center_crash_cabinet_requires_emergency_context'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER distribution_points_health_sector_topology_trg
  BEFORE INSERT OR UPDATE OF warehouse_id, organization_id, point_type, clinical_location_kind, status
  ON public.distribution_points
  FOR EACH ROW
  EXECUTE FUNCTION public._phoenix_health_sector_outlet_topology_guard_v1();

REVOKE ALL ON FUNCTION public._phoenix_health_sector_outlet_topology_guard_v1()
  FROM PUBLIC, anon, authenticated, service_role;

-- ============================================================================
-- 7. CROSS-CENTRE REASSIGNMENT GUARD — setup-time only
-- ============================================================================
-- Moving an outlet from centre A's depot to centre B's depot re-parents every
-- movement, balance and route it already owns: the same stock would appear to
-- have always belonged to a different health centre. Migration 170 established
-- the answer for warehouses — a change of topology context is a SETUP-TIME
-- mutation, permitted only while the node has no operational history — and this
-- is the outlet-level counterpart.
--
-- The dependency list below was derived STRUCTURALLY from the live catalogue
-- (every foreign key whose referenced table is distribution_points, plus the
-- RBAC scope references), not written from memory, so it is complete by
-- construction rather than by recollection.
--
-- A point_type change is guarded for the same reason: reclassifying a pharmacy
-- that already dispensed, or a cabinet that already received an initial
-- provisioning, would reinterpret history that Migration 180's lifecycle and
-- Migration 168's corridor both key on.
--
-- This fires ONLY on a genuine semantic change: a warehouse_id move that
-- actually crosses facilities, or a point_type change. Moving an outlet between
-- two depots of the SAME facility, or any non-semantic edit, is untouched.
CREATE FUNCTION public._phoenix_health_sector_outlet_reassignment_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_old_facility uuid;
  v_new_facility uuid;
  v_old_class    text;
  v_new_class    text;
  v_cross_centre boolean := false;
  v_retyped      boolean := (NEW.point_type IS DISTINCT FROM OLD.point_type);
  v_blockers     text[] := ARRAY[]::text[];
BEGIN
  IF NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id THEN
    SELECT w.facility_id, o.institution_class INTO v_old_facility, v_old_class
    FROM public.warehouses w
    JOIN public.organizations o ON o.id = w.organization_id
    WHERE w.id = OLD.warehouse_id;

    SELECT w.facility_id, o.institution_class INTO v_new_facility, v_new_class
    FROM public.warehouses w
    JOIN public.organizations o ON o.id = w.organization_id
    WHERE w.id = NEW.warehouse_id;

    -- Only meaningful when a health sector is on either side of the move.
    IF (v_old_class = 'health_sector' OR v_new_class = 'health_sector')
       AND v_old_facility IS DISTINCT FROM v_new_facility THEN
      v_cross_centre := true;
    END IF;
  END IF;

  IF NOT v_cross_centre AND NOT v_retyped THEN
    RETURN NEW;
  END IF;

  -- Serialize against a concurrent dependency INSERT, exactly Migration 170's
  -- proven lock-upgrade technique (170:328-350): a plain UPDATE takes only
  -- FOR NO KEY UPDATE, which does not conflict with the FOR KEY SHARE that
  -- PostgreSQL's own FK enforcement takes when a dependency row is inserted
  -- against this point. Escalating here forces whichever side arrives first to
  -- make the other wait, so the checks below cannot observe a half-built view.
  PERFORM 1 FROM public.distribution_points WHERE id = NEW.id FOR UPDATE;

  IF EXISTS (SELECT 1 FROM public.outlet_stock WHERE distribution_point_id = NEW.id)
    THEN v_blockers := v_blockers || 'outlet_stock'::text; END IF;
  IF EXISTS (SELECT 1 FROM public.outlet_stock_movements WHERE distribution_point_id = NEW.id)
    THEN v_blockers := v_blockers || 'outlet_stock_movements'::text; END IF;
  IF EXISTS (SELECT 1 FROM public.warehouse_dispatches WHERE destination_distribution_point_id = NEW.id)
    THEN v_blockers := v_blockers || 'warehouse_dispatches'::text; END IF;
  IF EXISTS (SELECT 1 FROM public.outlet_replenishment_routes
               WHERE source_point_id = NEW.id OR destination_point_id = NEW.id)
    THEN v_blockers := v_blockers || 'outlet_replenishment_routes'::text; END IF;
  IF EXISTS (SELECT 1 FROM public.outlet_return_requests WHERE distribution_point_id = NEW.id)
    THEN v_blockers := v_blockers || 'outlet_return_requests'::text; END IF;
  IF EXISTS (SELECT 1 FROM public.outlet_return_shipments WHERE distribution_point_id = NEW.id)
    THEN v_blockers := v_blockers || 'outlet_return_shipments'::text; END IF;
  IF EXISTS (SELECT 1 FROM public.item_availability WHERE distribution_point_id = NEW.id)
    THEN v_blockers := v_blockers || 'item_availability'::text; END IF;
  IF EXISTS (SELECT 1 FROM public.item_availability_movements WHERE distribution_point_id = NEW.id)
    THEN v_blockers := v_blockers || 'item_availability_movements'::text; END IF;
  IF EXISTS (SELECT 1 FROM public.phoenix_movement_dispense_context WHERE distribution_point_id = NEW.id)
    THEN v_blockers := v_blockers || 'phoenix_movement_dispense_context'::text; END IF;
  IF EXISTS (SELECT 1 FROM public.inter_org_exchange_requests
               WHERE source_distribution_point_id = NEW.id OR target_distribution_point_id = NEW.id)
    THEN v_blockers := v_blockers || 'inter_org_exchange_requests'::text; END IF;
  -- RBAC scope is a semantic dependency: a grant naming this outlet under one
  -- health centre must not silently become a grant under another.
  IF EXISTS (SELECT 1 FROM public.profile_scope_assignments WHERE distribution_point_id = NEW.id)
    THEN v_blockers := v_blockers || 'profile_scope_assignments'::text; END IF;
  IF EXISTS (SELECT 1 FROM public.profile_permission_overrides WHERE scope_point_id = NEW.id)
    THEN v_blockers := v_blockers || 'profile_permission_overrides'::text; END IF;

  IF array_length(v_blockers, 1) IS NOT NULL THEN
    IF v_cross_centre THEN
      RAISE EXCEPTION 'outlet_cross_center_reassignment_blocked_operational_dependency'
        USING ERRCODE = '23514', DETAIL = array_to_string(v_blockers, ', ');
    ELSE
      RAISE EXCEPTION 'outlet_point_type_change_blocked_operational_dependency'
        USING ERRCODE = '23514', DETAIL = array_to_string(v_blockers, ', ');
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER distribution_points_reassignment_guard_trg
  BEFORE UPDATE OF warehouse_id, point_type ON public.distribution_points
  FOR EACH ROW
  EXECUTE FUNCTION public._phoenix_health_sector_outlet_reassignment_guard_v1();

REVOKE ALL ON FUNCTION public._phoenix_health_sector_outlet_reassignment_guard_v1()
  FROM PUBLIC, anon, authenticated, service_role;

-- ============================================================================
-- 8. RECONCILIATION — classify every active health sector, then correct the
--    ones that are provably safe
-- ============================================================================
-- Three outcomes, and only one of them writes:
--
--   TARGET_READY               already canonical           -> untouched
--   SAFE_LEGACY_RECONCILABLE   the known legacy shape      -> corrected
--   AMBIGUOUS_STOP             anything else               -> MIGRATION FAILS
--
-- The third case is the point. A topology whose intended meaning cannot be
-- proven is not normalised on a guess; the migration aborts and an operator
-- decides. Every condition below is structural — no organization name, no
-- Production identifier.
DO $reconcile$
DECLARE
  v_org               record;
  v_active            integer;
  v_central           integer;
  v_facility_less     integer;
  v_sector_main       integer;
  v_mains             integer;
  v_depots            integer;
  v_depot_mains       integer;
  v_bad_facility      integer;
  v_dup_facility      integer;
  v_sector_outlets    integer;
  v_rescue_carts      integer;
  v_bad_cabinets      integer;
  v_invalid_outlets   integer;
  v_operational       integer;
  v_legacy_main       uuid;
  v_new_main          uuid;
  v_reconciled        integer := 0;
  v_target_ready      integer := 0;
BEGIN
  FOR v_org IN
    SELECT o.id, o.name
    FROM public.organizations o
    WHERE o.institution_class = 'health_sector' AND o.status = 'active'
    ORDER BY o.id
  LOOP
    -- Deterministic lock order: organization, facilities, warehouses, outlets.
    PERFORM 1 FROM public.organizations WHERE id = v_org.id FOR SHARE;
    PERFORM 1 FROM public.organization_facilities WHERE organization_id = v_org.id ORDER BY id FOR SHARE;
    PERFORM 1 FROM public.warehouses WHERE organization_id = v_org.id ORDER BY id FOR UPDATE;
    PERFORM 1 FROM public.distribution_points WHERE organization_id = v_org.id ORDER BY id FOR UPDATE;

    SELECT
      count(*) FILTER (WHERE w.status='active'),
      count(*) FILTER (WHERE w.status='active' AND w.warehouse_kind <> 'institution'),
      count(*) FILTER (WHERE w.status='active' AND w.facility_id IS NULL),
      count(*) FILTER (WHERE w.status='active' AND w.facility_id IS NULL
                             AND w.is_main AND w.warehouse_kind='institution'),
      count(*) FILTER (WHERE w.status='active' AND w.is_main),
      count(*) FILTER (WHERE w.status='active' AND w.facility_id IS NOT NULL),
      count(*) FILTER (WHERE w.status='active' AND w.facility_id IS NOT NULL AND w.is_main)
    INTO v_active, v_central, v_facility_less, v_sector_main, v_mains, v_depots, v_depot_mains
    FROM public.warehouses w
    WHERE w.organization_id = v_org.id;

    -- Facility-bound depots whose facility is not a live health centre of this
    -- organization. (The composite FK already forbids a foreign organization,
    -- so this catches class and status.)
    SELECT count(*) INTO v_bad_facility
    FROM public.warehouses w
    LEFT JOIN public.organization_facilities f ON f.id = w.facility_id
    WHERE w.organization_id = v_org.id AND w.status='active' AND w.facility_id IS NOT NULL
      AND (f.id IS NULL
           OR f.status <> 'active'
           OR f.facility_class NOT IN ('primary_health_center','subordinate_health_center'));

    SELECT count(*) INTO v_dup_facility
    FROM (
      SELECT w.facility_id
      FROM public.warehouses w
      WHERE w.organization_id = v_org.id AND w.status='active' AND w.facility_id IS NOT NULL
      GROUP BY w.facility_id HAVING count(*) > 1
    ) d;

    SELECT
      count(*) FILTER (WHERE w.facility_id IS NULL),
      count(*) FILTER (WHERE dp.point_type = 'rescue_cart'),
      count(*) FILTER (WHERE dp.point_type = 'crash_cabinet'
                             AND dp.clinical_location_kind IS DISTINCT FROM 'emergency'),
      count(*) FILTER (WHERE dp.point_type NOT IN ('pharmacy','crash_cabinet'))
    INTO v_sector_outlets, v_rescue_carts, v_bad_cabinets, v_invalid_outlets
    FROM public.distribution_points dp
    JOIN public.warehouses w ON w.id = dp.warehouse_id
    WHERE w.organization_id = v_org.id AND dp.status = 'active';

    -- ── AMBIGUOUS_STOP — refuse to guess ───────────────────────────────────
    IF v_central > 0 THEN
      RAISE EXCEPTION '181_ambiguous_stop: health sector % owns % active central warehouse(s)', v_org.id, v_central;
    END IF;
    IF v_facility_less > 1 THEN
      RAISE EXCEPTION '181_ambiguous_stop: health sector % owns % active sector-level warehouses', v_org.id, v_facility_less;
    END IF;
    IF v_mains > 1 THEN
      RAISE EXCEPTION '181_ambiguous_stop: health sector % owns % active main warehouses', v_org.id, v_mains;
    END IF;
    IF v_dup_facility > 0 THEN
      RAISE EXCEPTION '181_ambiguous_stop: health sector % has % facility/facilities with more than one active depot', v_org.id, v_dup_facility;
    END IF;
    IF v_bad_facility > 0 THEN
      RAISE EXCEPTION '181_ambiguous_stop: health sector % has % depot(s) on an invalid or inactive facility', v_org.id, v_bad_facility;
    END IF;
    IF v_sector_outlets > 0 THEN
      RAISE EXCEPTION '181_ambiguous_stop: health sector % has % active sector-level outlet(s)', v_org.id, v_sector_outlets;
    END IF;
    IF v_rescue_carts > 0 THEN
      RAISE EXCEPTION '181_ambiguous_stop: health sector % has % active rescue cart(s)', v_org.id, v_rescue_carts;
    END IF;
    IF v_bad_cabinets > 0 THEN
      RAISE EXCEPTION '181_ambiguous_stop: health sector % has % crash cabinet(s) without an emergency clinical context', v_org.id, v_bad_cabinets;
    END IF;
    IF v_invalid_outlets > 0 THEN
      RAISE EXCEPTION '181_ambiguous_stop: health sector % has % active outlet(s) with an invalid type', v_org.id, v_invalid_outlets;
    END IF;

    -- ── Not set up yet — nothing to classify ───────────────────────────────
    IF v_active = 0 THEN
      CONTINUE;
    END IF;

    -- ── TARGET_READY ───────────────────────────────────────────────────────
    IF v_sector_main = 1 AND v_facility_less = 1 AND v_depot_mains = 0 THEN
      v_target_ready := v_target_ready + 1;
      CONTINUE;
    END IF;

    -- ── SAFE_LEGACY_RECONCILABLE ───────────────────────────────────────────
    -- No sector-level warehouse at all, and exactly one facility-bound depot
    -- carrying the organization main flag. Every other structural condition has
    -- already been proved clean above.
    IF v_facility_less = 0 AND v_depots >= 1 AND v_depot_mains = 1 AND v_mains = 1 THEN
      -- The boolean demotion does not move history, but a legacy topology with
      -- operational commitments still requires an operator to prove its
      -- meaning. The supplied Production fixture is empty; anything else stops.
      SELECT
        (SELECT count(*) FROM public.warehouse_stock ws JOIN public.warehouses w ON w.id=ws.warehouse_id WHERE w.organization_id=v_org.id)
        + (SELECT count(*) FROM public.warehouse_stock_movements m JOIN public.warehouses w ON w.id=m.warehouse_id WHERE w.organization_id=v_org.id)
        + (SELECT count(*) FROM public.warehouse_dispatches d WHERE d.organization_id=v_org.id)
        + (SELECT count(*) FROM public.warehouse_transfers t WHERE t.source_organization_id=v_org.id OR t.destination_organization_id=v_org.id)
        + (SELECT count(*) FROM public.warehouse_transfer_requests r WHERE r.source_organization_id=v_org.id OR r.destination_organization_id=v_org.id)
        + (SELECT count(*) FROM public.warehouse_supply_routes r
             JOIN public.warehouses sw ON sw.id=r.source_warehouse_id
             JOIN public.warehouses tw ON tw.id=r.target_warehouse_id
            WHERE sw.organization_id=v_org.id OR tw.organization_id=v_org.id)
        + (SELECT count(*) FROM public.outlet_stock s WHERE s.organization_id=v_org.id)
        + (SELECT count(*) FROM public.outlet_stock_movements m WHERE m.organization_id=v_org.id)
        + (SELECT count(*) FROM public.outlet_replenishment_routes r WHERE r.organization_id=v_org.id)
        + (SELECT count(*) FROM public.outlet_return_requests r WHERE r.source_organization_id=v_org.id OR r.destination_organization_id=v_org.id)
        + (SELECT count(*) FROM public.outlet_return_shipments s WHERE s.source_organization_id=v_org.id OR s.destination_organization_id=v_org.id)
        + (SELECT count(*) FROM public.item_availability a WHERE a.organization_id=v_org.id)
        + (SELECT count(*) FROM public.item_availability_movements m WHERE m.organization_id=v_org.id)
        + (SELECT count(*) FROM public.phoenix_movement_dispense_context c WHERE c.organization_id=v_org.id)
        + (SELECT count(*) FROM public.inter_org_exchange_requests e WHERE e.source_organization_id=v_org.id OR e.target_organization_id=v_org.id)
      INTO v_operational;

      IF v_operational > 0 THEN
        RAISE EXCEPTION '181_ambiguous_stop: health sector % has % operational-history row(s)', v_org.id, v_operational;
      END IF;

      SELECT w.id INTO v_legacy_main
      FROM public.warehouses w
      WHERE w.organization_id = v_org.id AND w.status='active'
        AND w.facility_id IS NOT NULL AND w.is_main;

      -- 1. Demote the legacy centre depot. This frees the
      --    warehouses_one_active_main_per_org_uniq slot. The row-level shape
      --    guard accepts it: facility-bound + not main is the canonical depot.
      UPDATE public.warehouses SET is_main = false WHERE id = v_legacy_main;

      -- 2. Create the sector main. No facility, institution kind, main, active.
      --    Generic canonical naming — no organization identifier is encoded in
      --    a business-visible field, and code stays NULL because this repo has
      --    no canonical code contract for warehouses.
      INSERT INTO public.warehouses (
        organization_id, name, name_ar, warehouse_kind, facility_id, is_main, status
      ) VALUES (
        v_org.id, 'Sector Main Depot', 'مذخر القطاع الرئيسي', 'institution', NULL, true, 'active'
      )
      RETURNING id INTO v_new_main;

      INSERT INTO public.audit_logs (
        organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
      ) VALUES (
        v_org.id, NULL, 'system',
        'health_sector_topology.reconciled', 'warehouse', v_new_main, 'Sector Main Depot',
        jsonb_build_object(
          'migration', 181,
          'classification', 'SAFE_LEGACY_RECONCILABLE',
          'demoted_center_depot_id', v_legacy_main,
          'created_sector_main_id', v_new_main
        )
      );

      v_reconciled := v_reconciled + 1;
      CONTINUE;
    END IF;

    -- ── Anything else ──────────────────────────────────────────────────────
    RAISE EXCEPTION
      '181_ambiguous_stop: health sector % has an unrecognised topology (active=%, facility_less=%, sector_main=%, depots=%, depot_mains=%, mains=%)',
      v_org.id, v_active, v_facility_less, v_sector_main, v_depots, v_depot_mains, v_mains;
  END LOOP;

  RAISE NOTICE '181 reconciliation: % already canonical, % legacy sector(s) corrected.', v_target_ready, v_reconciled;
END;
$reconcile$;

-- ============================================================================
-- 9. STRUCTURAL INVARIANT — at most ONE active depot per facility
-- ============================================================================
-- Installed after classification so a duplicate legacy shape receives the
-- deliberate AMBIGUOUS_STOP diagnosis instead of an early raw index error.
-- Flush this migration's deferred organization-level checks first: PostgreSQL
-- will not build an index on a table with pending trigger events.
SET CONSTRAINTS warehouses_health_sector_main_presence_trg IMMEDIATE;

CREATE UNIQUE INDEX warehouses_one_active_depot_per_facility_uniq
  ON public.warehouses (facility_id)
  WHERE facility_id IS NOT NULL AND status = 'active';

COMMENT ON INDEX public.warehouses_one_active_depot_per_facility_uniq IS
  'R1.1: a health centre (organization_facilities row) has at most ONE active depot. Partial on facility_id IS NOT NULL AND status=''active'', so retiring a depot frees the centre for a replacement, and non-health-sector organizations — which may never carry facility_id (170) — are unaffected.';

-- ============================================================================
-- 10. CENTRE-DEPOT CREATION — one atomic canonical writer
-- ============================================================================
-- phoenix_create_warehouse (074) takes no facility, so under section 2 it can
-- no longer produce a valid centre depot: the row would have to be created
-- facility-less and assigned afterwards, and the sector-main shape rule now
-- refuses a facility-less non-main warehouse. Rather than weaken the invariant
-- to preserve that limitation, R1.1 adds the writer the topology actually
-- needs — one call, one valid row, no intermediate illegal state.
--
-- Authority is deliberately identical to the historical warehouse-management
-- authority (074 / 170): active super_admin, re-proved here rather than
-- inherited. No privileged client table write is introduced.
CREATE FUNCTION public.phoenix_create_health_center_warehouse(
  p_organization_id uuid,
  p_facility_id     uuid,
  p_name            text,
  p_name_ar         text,
  p_code            text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_role     text;
  v_name     text := btrim(coalesce(p_name, ''));
  v_name_ar  text := btrim(coalesce(p_name_ar, ''));
  v_code     text := nullif(btrim(coalesce(p_code, '')), '');
  v_class    text;
  v_facility public.organization_facilities%ROWTYPE;
  v_id       uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT p.role INTO v_role
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;
  IF v_role IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED_WAREHOUSE_MANAGE: only super_admin may create warehouses'
      USING ERRCODE = '42501';
  END IF;

  IF p_organization_id IS NULL OR p_facility_id IS NULL THEN
    RAISE EXCEPTION 'organization_and_facility_required' USING ERRCODE = '23514';
  END IF;
  IF v_name = '' OR v_name_ar = '' THEN
    RAISE EXCEPTION 'WAREHOUSE_NAME_REQUIRED: name and name_ar must be non-empty'
      USING ERRCODE = '23514';
  END IF;

  -- Deterministic lock order — organization, then facility — matching the
  -- reconciliation above so the two can never deadlock against each other.
  SELECT o.institution_class INTO v_class
  FROM public.organizations o WHERE o.id = p_organization_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORGANIZATION_NOT_FOUND: %', p_organization_id USING ERRCODE = '23503';
  END IF;
  IF v_class IS DISTINCT FROM 'health_sector' THEN
    RAISE EXCEPTION 'center_depot_requires_health_sector' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_facility
  FROM public.organization_facilities WHERE id = p_facility_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'health_center_facility_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_facility.organization_id IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'health_center_facility_organization_mismatch' USING ERRCODE = '42501';
  END IF;
  IF v_facility.facility_class NOT IN ('primary_health_center', 'subordinate_health_center') THEN
    RAISE EXCEPTION 'invalid_health_center_facility_class: %', v_facility.facility_class
      USING ERRCODE = '23514';
  END IF;
  IF v_facility.status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'health_center_facility_not_active' USING ERRCODE = '23514';
  END IF;

  -- Named error ahead of the structural index, the courtesy every other writer
  -- in this schema extends. The index remains the real guarantee.
  IF EXISTS (
    SELECT 1 FROM public.warehouses
    WHERE facility_id = p_facility_id AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'health_center_already_has_an_active_depot' USING ERRCODE = '23505';
  END IF;

  IF v_code IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.warehouses w
    WHERE w.organization_id = p_organization_id AND btrim(w.code) = v_code
  ) THEN
    RAISE EXCEPTION 'WAREHOUSE_CODE_EXISTS: code % already used in organization %', v_code, p_organization_id
      USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.warehouses (
    organization_id, name, name_ar, warehouse_kind, facility_id, is_main, code, status, created_by
  ) VALUES (
    p_organization_id, v_name, v_name_ar, 'institution', p_facility_id, false, v_code, 'active', v_actor
  )
  RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    p_organization_id, v_actor, v_role, 'create', 'warehouse', v_id, v_name,
    jsonb_build_object(
      'warehouse_kind', 'institution',
      'facility_id', p_facility_id,
      'is_main', false,
      'code', v_code,
      'health_center_depot', true
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'warehouse_id', v_id,
    'organization_id', p_organization_id,
    'facility_id', p_facility_id,
    'warehouse_kind', 'institution',
    'is_main', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_create_health_center_warehouse(uuid, uuid, text, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_create_health_center_warehouse(uuid, uuid, text, text, text)
  TO authenticated;

-- ============================================================================
-- 11. COMMENTS
-- ============================================================================
COMMENT ON FUNCTION public._phoenix_health_sector_warehouse_shape_guard_v1() IS
  'R1.1: row-level health-sector warehouse shape. Inside institution_class=''health_sector'': warehouse_kind must be institution; an ACTIVE facility-less warehouse is the sector main (is_main=true); an ACTIVE facility-bound warehouse is a centre depot (is_main=false) whose facility must be an active primary/subordinate health centre of the same organization. Fires on INSERT and on UPDATE of organization_id, warehouse_kind, facility_id, is_main and status, so no mutation path can bypass it. Other organization classes are untouched.';

COMMENT ON FUNCTION public._phoenix_health_center_facility_shape_guard_v1() IS
  'R1.1: inverse parent-side topology guard. An organization_facilities row that owns an active centre depot cannot be moved, deactivated, or reclassified away from primary/subordinate health-centre shape underneath that depot.';

COMMENT ON FUNCTION public._phoenix_health_sector_main_presence_guard_v1() IS
  'R1.1: organization-level invariant — an ACTIVE health sector owning any active warehouse owns exactly one active institution warehouse with facility_id IS NULL and is_main=true. DEFERRABLE INITIALLY DEFERRED so a legitimate two-statement correction (demote the old main, create the new one) is atomic, while a COMMIT that would leave centre depots with no sector main is impossible. Fires on DELETE too.';

COMMENT ON FUNCTION public._phoenix_health_sector_organization_activation_guard_v1() IS
  'R1.1: blocks reactivation of a health-sector organization when it owns active warehouses but not exactly one canonical sector main.';

COMMENT ON FUNCTION public._phoenix_health_sector_outlet_topology_guard_v1() IS
  'R1.1: an ACTIVE outlet in a health sector must hang off a facility-bound centre depot — which forbids every sector-level pharmacy, crash cabinet and rescue cart — may only be a pharmacy or a crash cabinet, never a rescue cart, and if it is a crash cabinet must carry clinical_location_kind=''emergency''. An ordinary centre pharmacy has no clinical-location requirement. Fires on INSERT and on UPDATE of warehouse_id, organization_id, point_type, clinical_location_kind and status.';

COMMENT ON FUNCTION public._phoenix_health_sector_outlet_reassignment_guard_v1() IS
  'R1.1: setup-time-only mutation contract for an outlet, the distribution_points counterpart of Migration 170''s warehouse rule. A cross-CENTRE warehouse_id move, or any point_type change, is refused once the outlet owns operational history. The dependency set was derived structurally from every foreign key referencing distribution_points plus the RBAC scope references, so it is complete by construction; the offending tables are returned in DETAIL.';

COMMENT ON FUNCTION public.phoenix_create_health_center_warehouse(uuid, uuid, text, text, text) IS
  'R1.1: the atomic canonical writer for a health-centre depot — institution kind, bound to the given facility, never main, active. Requires an active super_admin, the same authority historical warehouse management already requires, and validates organization class, facility ownership, facility class, facility status and the one-active-depot-per-centre rule before inserting. Exists because phoenix_create_warehouse (074) has no facility parameter and therefore cannot produce a valid centre depot in one statement under the R1.1 invariants.';

-- ============================================================================
-- 12. VERIFY — in-transaction, fails the whole migration
-- ============================================================================
DO $verify$
DECLARE
  v_bad integer;
BEGIN
  -- 9a. Objects exist with the expected security posture.
  IF to_regprocedure('public.phoenix_create_health_center_warehouse(uuid,uuid,text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (181): the centre-depot writer is absent';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc
          WHERE oid='public.phoenix_create_health_center_warehouse(uuid,uuid,text,text,text)'::regprocedure) THEN
    RAISE EXCEPTION 'VERIFY FAILED (181): the centre-depot writer is not SECURITY DEFINER';
  END IF;
  IF NOT has_function_privilege('authenticated',
       'public.phoenix_create_health_center_warehouse(uuid,uuid,text,text,text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (181): authenticated cannot reach the centre-depot writer';
  END IF;
  IF has_function_privilege('anon',
       'public.phoenix_create_health_center_warehouse(uuid,uuid,text,text,text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (181): anon can reach the centre-depot writer';
  END IF;

  FOR v_bad IN
    SELECT 1 FROM (VALUES
      ('_phoenix_health_sector_warehouse_shape_guard_v1'),
      ('_phoenix_health_center_facility_shape_guard_v1'),
      ('_phoenix_health_sector_organization_activation_guard_v1'),
      ('_phoenix_health_sector_main_presence_guard_v1'),
      ('_phoenix_health_sector_outlet_topology_guard_v1'),
      ('_phoenix_health_sector_outlet_reassignment_guard_v1')
    ) AS t(fn)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname=t.fn AND p.prosecdef
        AND p.proconfig @> ARRAY['search_path=public, pg_temp']
    )
  LOOP
    RAISE EXCEPTION 'VERIFY FAILED (181): a topology guard is missing, not SECURITY DEFINER, or not search_path-pinned';
  END LOOP;

  -- 9b. Triggers are attached, and the org-level one is genuinely deferred.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='warehouses_health_sector_shape_guard_trg') THEN
    RAISE EXCEPTION 'VERIFY FAILED (181): the warehouse shape guard is not attached';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='distribution_points_health_sector_topology_trg') THEN
    RAISE EXCEPTION 'VERIFY FAILED (181): the outlet topology guard is not attached';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='distribution_points_reassignment_guard_trg') THEN
    RAISE EXCEPTION 'VERIFY FAILED (181): the outlet reassignment guard is not attached';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='organization_facilities_health_center_shape_guard_trg') THEN
    RAISE EXCEPTION 'VERIFY FAILED (181): the health-centre facility parent guard is not attached';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='organizations_health_sector_activation_guard_trg') THEN
    RAISE EXCEPTION 'VERIFY FAILED (181): the health-sector activation guard is not attached';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname='warehouses_health_sector_main_presence_trg'
      AND tgdeferrable AND tginitdeferred
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (181): the sector-main presence guard is not DEFERRABLE INITIALLY DEFERRED';
  END IF;

  -- 9c. The one-active-depot-per-facility index.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='warehouses_one_active_depot_per_facility_uniq'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (181): the one-active-depot-per-facility index is absent';
  END IF;

  -- 9d. The pre-existing main invariant is preserved, not replaced.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='warehouses_one_active_main_per_org_uniq'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (181): warehouses_one_active_main_per_org_uniq was dropped';
  END IF;

  -- 9e. THE OUTCOME. Every active health sector is now canonical.
  SELECT count(*) INTO v_bad
  FROM public.organizations o
  WHERE o.institution_class='health_sector' AND o.status='active'
    AND EXISTS (SELECT 1 FROM public.warehouses w WHERE w.organization_id=o.id AND w.status='active')
    AND (SELECT count(*) FROM public.warehouses w
          WHERE w.organization_id=o.id AND w.status='active'
            AND w.facility_id IS NULL AND w.is_main AND w.warehouse_kind='institution') <> 1;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (181): % active health sector(s) still lack exactly one sector main', v_bad;
  END IF;

  SELECT count(*) INTO v_bad
  FROM public.warehouses w
  JOIN public.organizations o ON o.id = w.organization_id
  WHERE o.institution_class='health_sector' AND w.status='active'
    AND (w.warehouse_kind <> 'institution'
         OR (w.facility_id IS NULL AND NOT w.is_main)
         OR (w.facility_id IS NOT NULL AND w.is_main));
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (181): % active health-sector warehouse(s) violate the canonical shape', v_bad;
  END IF;

  SELECT count(*) INTO v_bad
  FROM public.distribution_points dp
  JOIN public.warehouses w ON w.id = dp.warehouse_id
  JOIN public.organizations o ON o.id = w.organization_id
  WHERE o.institution_class='health_sector' AND dp.status='active'
    AND (w.facility_id IS NULL
         OR dp.point_type NOT IN ('pharmacy','crash_cabinet')
         OR (dp.point_type='crash_cabinet' AND dp.clinical_location_kind IS DISTINCT FROM 'emergency'));
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (181): % active health-sector outlet(s) violate the canonical shape', v_bad;
  END IF;

  -- 9f. NON-REGRESSION — R1.1 owns topology and nothing else.
  IF (SELECT count(*) FROM pg_class
      WHERE relname IN ('health_center_units','units','unit_stock','unit_routes','unit_scopes')) <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (181): a unit domain was created';
  END IF;
  IF (SELECT count(*) FROM pg_class
      WHERE relname IN ('pharmacy_stock','rescue_cart_stock','crash_cabinet_stock','facility_stock')) <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (181): a second balance ledger exists';
  END IF;
  -- Branch B untouched: same-sector supply stays route-free.
  IF pg_get_functiondef('public.phoenix_assert_direct_supply_endpoints(uuid,uuid,uuid)'::regprocedure)
     NOT LIKE '%v_src.facility_id IS NULL%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (181): Branch B was modified';
  END IF;
  -- Migration 180's boundary is intact.
  IF pg_get_functiondef('public._phoenix_180_delegate_create_warehouse_dispatch(uuid,uuid,text,text,text,text,text)'::regprocedure)
     NOT LIKE '%emergency_outlet_requires_initial_provisioning%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (181): Migration 180''s emergency boundary was disturbed';
  END IF;
  IF pg_get_functiondef('public.phoenix_replenish_emergency_outlet(uuid,uuid,uuid,integer,text,text)'::regprocedure)
     NOT LIKE '%initial_provisioning_required_before_replenishment%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (181): Migration 180''s initial-first replenishment gate was disturbed';
  END IF;
  -- No sector -> centre supply route was invented.
  IF EXISTS (
    SELECT 1 FROM public.warehouse_supply_routes r
    JOIN public.warehouses s ON s.id = r.source_warehouse_id
    JOIN public.organizations o ON o.id = s.organization_id
    WHERE o.institution_class = 'health_sector'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (181): a warehouse_supply_route was created for a health sector';
  END IF;

  RAISE NOTICE '181 VERIFY OK.';
END;
$verify$;

COMMIT;

-- ============================================================================
-- ROLLBACK (manual):
--   DROP TRIGGER warehouses_health_sector_shape_guard_trg ON public.warehouses;
--   DROP TRIGGER warehouses_health_sector_main_presence_trg ON public.warehouses;
--   DROP TRIGGER distribution_points_health_sector_topology_trg ON public.distribution_points;
--   DROP TRIGGER distribution_points_reassignment_guard_trg ON public.distribution_points;
--   DROP FUNCTION public._phoenix_health_sector_warehouse_shape_guard_v1();
--   DROP FUNCTION public._phoenix_health_sector_main_presence_guard_v1();
--   DROP FUNCTION public._phoenix_health_sector_outlet_topology_guard_v1();
--   DROP FUNCTION public._phoenix_health_sector_outlet_reassignment_guard_v1();
--   DROP FUNCTION public.phoenix_create_health_center_warehouse(uuid, uuid, text, text, text);
--   DROP INDEX public.warehouses_one_active_depot_per_facility_uniq;
--
--   The reconciliation itself is NOT auto-reversible: undoing it would mean
--   re-promoting a centre depot to organization main and deleting the sector
--   main, which re-creates the defect. Any reversal is an operator decision on
--   live data, not a scripted step. This migration creates, alters and deletes
--   no stock, movement, dispatch or route row.
-- ============================================================================
-- END OF MIGRATION 181
-- ============================================================================
