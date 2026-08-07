-- ============================================================================
-- FACILITY-IDENTITY-AND-ROUTING-FOUNDATION-164  (Stage E · subphase E-2)
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply after 163, via the Supabase SQL Editor, after reading this file in full.
--
-- NOT APPLIED BY THIS PR. Authored and replayed on a disposable PostgreSQL rig
-- only. Migrations 001-163 are immutable and are NOT edited here.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SCOPE — E-2 ONLY
-- ─────────────────────────────────────────────────────────────────────────────
-- This migration is the METADATA FOUNDATION. After it, NO STOCK CAN MOVE by any
-- path that does not already exist today: it adds no movement type, no
-- reference type, no stock column, no corridor RPC, and touches no existing
-- movement/transfer/return/dispatch routine.
--
-- Delivered here:
--   1. organizations.institution_class            + (id, institution_class) key
--   2. organization_facilities                    subordinate facility identity
--   3. warehouses.facility_id                     facility <- warehouse linkage
--   4. distribution_points.clinical_location_kind clinical context category
--   5. _phoenix_outlet_facility_context_v1        single ownership resolver
--   6. phoenix_upsert_organization_facility       facility administration
--   7. outlet_replenishment_routes                route authority (metadata)
--   8. phoenix_upsert_outlet_replenishment_route  fail-closed eligibility
--   9. four permission keys + role defaults
--
-- Deliberately NOT here (later subphases own them):
--   * the sector -> health-centre supply branch and the health-centre -> sector
--     return branch (both are CREATE OR REPLACE of existing shared validators);
--   * warehouse_dispatches initial-provisioning columns;
--   * outlet_stock_movements movement/reference vocabulary widening;
--   * the pharmacy -> emergency-outlet corridor and its reversal;
--   * the crash_cart forward guards;
--   * every UI surface.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY A FACILITY TABLE, AND NOT A WAREHOUSE COLUMN
-- ─────────────────────────────────────────────────────────────────────────────
-- A health centre is an ADMINISTRATIVE/CLINICAL facility; a warehouse is an
-- INVENTORY NODE. Identifying a health centre by its warehouse row would assume
-- an invariant nobody authorised — that every centre always has exactly one
-- warehouse for its whole lifetime — and would destroy facility identity the
-- moment a depot were replaced or deactivated. The facility therefore gets its
-- own row, its own status, and a NULLABLE many-to-one link FROM warehouses:
-- a centre may own zero, one, or several warehouses.
--
-- warehouses.facility_kind is deliberately NOT introduced: it would persist the
-- same classification twice (organizations.institution_class + facility_id +
-- facility_class already express it) and create a drift surface.
--
-- warehouses.warehouse_kind is NOT widened. It stays exactly central|institution
-- because at least eight migrations test it by equality, and 116:136 requires
-- 'institution' for a supplementary/sub-purchase receipt — a health-centre depot
-- must keep passing that check.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- NO BACKFILL, BY DESIGN
-- ─────────────────────────────────────────────────────────────────────────────
-- Every column added here is NULLABLE and ships NULL; organization_facilities
-- ships empty. Classifying an existing organization, naming its health centres,
-- or mapping a warehouse to a facility is an OPERATIONAL decision, exactly as
-- 067:174-176 refused to guess whether a legacy 'dispensing' point was really a
-- pharmacy. NULL keeps today's behaviour precisely and grants NO new capability:
-- every new gate below fails closed on NULL. Nothing here infers classification
-- from a name, label, or title.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 0. PRECONDITIONS — fail closed (150:19-35 idiom)
-- ============================================================================
DO $preflight$
BEGIN
  IF to_regclass('public.organizations')        IS NULL
     OR to_regclass('public.warehouses')          IS NULL
     OR to_regclass('public.distribution_points') IS NULL
     OR to_regclass('public.permission_keys')     IS NULL
     OR to_regclass('public.role_permission_defaults') IS NULL THEN
    RAISE EXCEPTION '164_precondition_failed: expected 001/062/066 schema is absent';
  END IF;

  -- The composite-FK targets this migration pins against must already exist.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'warehouses_id_kind_uniq') THEN
    RAISE EXCEPTION '164_precondition_failed: warehouses_id_kind_uniq (066) is absent';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'distribution_points_id_org_uniq') THEN
    RAISE EXCEPTION '164_precondition_failed: distribution_points_id_org_uniq is absent';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'distribution_points_id_point_type_uniq') THEN
    RAISE EXCEPTION '164_precondition_failed: distribution_points_id_point_type_uniq (067) is absent';
  END IF;

  IF to_regprocedure('public.phoenix_profile_has_scoped_permission(uuid,text,uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION '164_precondition_failed: scoped permission helper is absent';
  END IF;
  IF to_regprocedure('public.phoenix_my_org()') IS NULL
     OR to_regprocedure('public.phoenix_my_role()') IS NULL THEN
    RAISE EXCEPTION '164_precondition_failed: RLS identity helpers are absent';
  END IF;
  IF to_regprocedure('public.phoenix_set_updated_at()') IS NULL THEN
    RAISE EXCEPTION '164_precondition_failed: phoenix_set_updated_at (001) is absent';
  END IF;

  -- Idempotence guard: this migration is forward-only and not re-runnable.
  IF to_regclass('public.organization_facilities') IS NOT NULL THEN
    RAISE EXCEPTION '164_precondition_failed: already_applied';
  END IF;

  -- warehouse_kind must still be exactly two values. If a prior change widened
  -- it, the facility model's assumptions no longer hold — fail rather than
  -- silently layer on top.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'warehouses_warehouse_kind_chk'
      AND pg_get_constraintdef(oid) LIKE '%central%'
      AND pg_get_constraintdef(oid) LIKE '%institution%'
  ) THEN
    RAISE EXCEPTION '164_precondition_failed: warehouses_warehouse_kind_chk missing or reshaped';
  END IF;

  RAISE NOTICE '164 preconditions OK.';
END;
$preflight$;

-- ============================================================================
-- 1. organizations.institution_class — the THREE top-level classes
-- ============================================================================
-- Primary/subordinate health centres are NOT institution classes. They are
-- subordinate FACILITIES (section 2). Putting them here would flatten the
-- hierarchy and make a centre a peer of the sector that owns it.
ALTER TABLE public.organizations
  ADD COLUMN institution_class text;

ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_institution_class_chk
  CHECK (institution_class IN ('hospital', 'specialized_center', 'health_sector'));

-- Composite FK TARGET for organization_facilities.of_parent_class_fk. REQUIRED,
-- not decorative: PostgreSQL demands a UNIQUE/PK on the exact referenced column
-- set, and PRIMARY KEY (id) alone does NOT satisfy (id, institution_class).
-- Trivially satisfiable because id is already the primary key.
ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_id_institution_class_uniq UNIQUE (id, institution_class);

COMMENT ON COLUMN public.organizations.institution_class IS
  'FACILITY-IDENTITY-164: the three TOP-LEVEL institution classes — hospital | '
  'specialized_center | health_sector. NULL = unclassified; NULL keeps existing '
  'behaviour and grants no new capability (every 164 gate fails closed on NULL). '
  'Health centres are NOT values here — they are subordinate facilities in '
  'organization_facilities. Never inferred from a name.';

-- ============================================================================
-- 2. organization_facilities — subordinate facility identity
-- ============================================================================
-- Identity is INDEPENDENT of warehouse lifecycle: a facility may exist with no
-- warehouse, may own several, and survives any warehouse being deactivated.
CREATE TABLE public.organization_facilities (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,

  -- Pinned discriminator. The parent organization MUST be a health sector, and
  -- that is a DATABASE guarantee, not an RPC convention: the CHECK pins the
  -- literal and the composite FK ties it to the referenced organization's own
  -- institution_class. Same technique as warehouse_supply_routes_source_is_central
  -- (066:178-187). A CHECK alone cannot do it — CHECKs may not query another
  -- table. Because institution_class is NULLABLE and the FK is MATCH SIMPLE, an
  -- UNCLASSIFIED organization can never be a parent: there is no row to match.
  parent_institution_class  text NOT NULL DEFAULT 'health_sector',

  facility_class            text NOT NULL,
  name                      text NOT NULL,
  name_ar                   text NOT NULL,
  code                      text,
  status                    text NOT NULL DEFAULT 'active',

  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Composite FK TARGET for warehouses_facility_org_fk. Required: PRIMARY KEY
  -- (id) alone does NOT satisfy (id, organization_id). Declared inline so it can
  -- never be ordered after the FK that needs it.
  CONSTRAINT organization_facilities_id_org_uniq UNIQUE (id, organization_id),

  CONSTRAINT of_parent_is_health_sector_chk
    CHECK (parent_institution_class = 'health_sector'),
  CONSTRAINT of_parent_class_fk
    FOREIGN KEY (organization_id, parent_institution_class)
    REFERENCES public.organizations (id, institution_class) ON DELETE RESTRICT,

  CONSTRAINT of_facility_class_chk
    CHECK (facility_class IN ('primary_health_center', 'subordinate_health_center')),
  CONSTRAINT of_status_chk
    CHECK (status IN ('active', 'inactive', 'archived')),

  CONSTRAINT of_name_chk    CHECK (btrim(name)    = name    AND name    <> ''),
  CONSTRAINT of_name_ar_chk CHECK (btrim(name_ar) = name_ar AND name_ar <> ''),
  CONSTRAINT of_code_chk    CHECK (code IS NULL OR (btrim(code) = code AND code <> ''))
);

CREATE UNIQUE INDEX organization_facilities_org_code_uniq
  ON public.organization_facilities (organization_id, btrim(code))
  WHERE code IS NOT NULL;

CREATE INDEX organization_facilities_org_status_idx
  ON public.organization_facilities (organization_id, status);

COMMENT ON TABLE public.organization_facilities IS
  'FACILITY-IDENTITY-164: subordinate facility identity (primary/subordinate '
  'health centre) inside ONE health_sector organization. NOT an organization and '
  'NOT a warehouse: identity is independent of warehouse lifecycle — a facility '
  'may own zero or many warehouses and survives any of them being deactivated. '
  'Rows are written ONLY by phoenix_upsert_organization_facility; there is no '
  'direct client INSERT/UPDATE/DELETE path, by design. Never a balance truth.';

DO $$ BEGIN
  CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.organization_facilities
    FOR EACH ROW EXECUTE FUNCTION phoenix_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.organization_facilities ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON TABLE public.organization_facilities TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.organization_facilities FROM authenticated;
REVOKE ALL ON TABLE public.organization_facilities FROM anon;

DROP POLICY IF EXISTS organization_facilities_select_scoped ON public.organization_facilities;
CREATE POLICY organization_facilities_select_scoped
  ON public.organization_facilities
  FOR SELECT
  TO authenticated
  USING (
    organization_id = public.phoenix_my_org()
    OR public.phoenix_my_role() = 'super_admin'
  );

-- ============================================================================
-- 3. warehouses.facility_id — the warehouse -> facility link
-- ============================================================================
--   facility_id IS NULL     -> organization-level warehouse (sector depot,
--                              hospital depot, specialized-centre depot),
--                              disambiguated by organizations.institution_class
--   facility_id IS NOT NULL -> warehouse belonging to that health-centre facility
--
-- The composite FK makes a CROSS-ORGANIZATION link structurally impossible: a
-- warehouse may only reference a facility carrying the SAME organization_id.
-- ON DELETE RESTRICT: a facility with warehouses cannot be deleted under them.
ALTER TABLE public.warehouses
  ADD COLUMN facility_id uuid;

ALTER TABLE public.warehouses
  ADD CONSTRAINT warehouses_facility_org_fk
  FOREIGN KEY (facility_id, organization_id)
  REFERENCES public.organization_facilities (id, organization_id) ON DELETE RESTRICT;

CREATE INDEX warehouses_facility_idx
  ON public.warehouses (facility_id) WHERE facility_id IS NOT NULL;

COMMENT ON COLUMN public.warehouses.facility_id IS
  'FACILITY-IDENTITY-164: NULL = organization-level warehouse/depot; NOT NULL = '
  'warehouse belonging to that subordinate health-centre facility. Nullable and '
  'many-to-one: a facility may own several warehouses. warehouse_kind is '
  'UNCHANGED (still central|institution) so 116 supplementary procurement keeps '
  'accepting a health-centre depot.';

-- ============================================================================
-- 4. distribution_points.clinical_location_kind — clinical CONTEXT CATEGORY
-- ============================================================================
-- This is a CATEGORY, never a ward master record and never a facility or
-- organization identity. Facility membership is carried by the outlet's
-- warehouse (distribution_points.warehouse_id -> warehouses.facility_id), never
-- by this column. No ward subsystem is created.
ALTER TABLE public.distribution_points
  ADD COLUMN clinical_location_kind text;

ALTER TABLE public.distribution_points
  ADD CONSTRAINT distribution_points_clinical_location_kind_chk
  CHECK (clinical_location_kind IN ('emergency', 'non_emergency'));

COMMENT ON COLUMN public.distribution_points.clinical_location_kind IS
  'FACILITY-IDENTITY-164: clinical CONTEXT CATEGORY of this outlet — emergency | '
  'non_emergency. NOT a ward record, NOT facility identity, NOT organization '
  'identity. NULL = unclassified and FAILS CLOSED wherever eligibility depends '
  'on it. Never inferred from a name.';

-- ============================================================================
-- 5. _phoenix_outlet_facility_context_v1 — the single ownership resolver
-- ============================================================================
-- One implementation of the distribution_point -> warehouse -> [facility] ->
-- organization walk, so every eligibility rule reads the same chain. Internal:
-- revoked from authenticated. Returns NULLs for an unknown point rather than
-- raising, so callers decide (all of them fail closed on NULL).
CREATE FUNCTION public._phoenix_outlet_facility_context_v1(
  p_distribution_point_id uuid,
  OUT o_point_type             text,
  OUT o_point_status           text,
  OUT o_clinical_location_kind text,
  OUT o_warehouse_id           uuid,
  OUT o_organization_id        uuid,
  OUT o_institution_class      text,
  OUT o_facility_id            uuid,
  OUT o_facility_class         text,
  OUT o_facility_status        text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT dp.point_type, dp.status, dp.clinical_location_kind,
         w.id, w.organization_id, o.institution_class,
         w.facility_id, f.facility_class, f.status
  FROM public.distribution_points dp
  JOIN public.warehouses    w ON w.id = dp.warehouse_id
  JOIN public.organizations o ON o.id = w.organization_id
  LEFT JOIN public.organization_facilities f ON f.id = w.facility_id
  WHERE dp.id = p_distribution_point_id
$$;

REVOKE ALL ON FUNCTION public._phoenix_outlet_facility_context_v1(uuid)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._phoenix_outlet_facility_context_v1(uuid) IS
  'FACILITY-IDENTITY-164 internal: resolves an outlet to its warehouse, owning '
  'organization, institution_class and (optional) subordinate facility. The '
  'single implementation of the ownership chain — eligibility rules must not '
  're-derive it. Internal only.';

-- ============================================================================
-- 6. phoenix_upsert_organization_facility — facility administration
-- ============================================================================
-- p_facility_id NULL creates; non-NULL updates. Organization is IMMUTABLE after
-- creation: moving a facility between organizations would silently re-parent
-- every warehouse and outlet beneath it.
CREATE FUNCTION public.phoenix_upsert_organization_facility(
  p_facility_id     uuid,
  p_organization_id uuid,
  p_facility_class  text,
  p_name            text,
  p_name_ar         text,
  p_code            text DEFAULT NULL,
  p_is_active       boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_org        public.organizations%ROWTYPE;
  v_row        public.organization_facilities%ROWTYPE;
  v_name       text := NULLIF(btrim(p_name), '');
  v_name_ar    text := NULLIF(btrim(p_name_ar), '');
  v_code       text := NULLIF(btrim(p_code), '');
  v_status     text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_id_required' USING ERRCODE = '23514';
  END IF;
  IF v_name IS NULL OR v_name_ar IS NULL THEN
    RAISE EXCEPTION 'facility_name_required' USING ERRCODE = '23514';
  END IF;
  IF p_facility_class IS NULL
     OR p_facility_class NOT IN ('primary_health_center', 'subordinate_health_center') THEN
    RAISE EXCEPTION 'invalid_facility_class' USING ERRCODE = '23514';
  END IF;

  v_status := CASE WHEN p_is_active THEN 'active' ELSE 'inactive' END;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'organization_facilities.manage', p_organization_id, NULL, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_organization_facilities_manage' USING ERRCODE = '42501';
  END IF;

  SELECT p.role INTO v_actor_role
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  -- FAIL CLOSED on an unclassified or wrongly-classified parent. The composite
  -- FK would also refuse, but a named error beats a raw 23503 for the caller.
  SELECT * INTO v_org FROM public.organizations WHERE id = p_organization_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_org.institution_class IS NULL THEN
    RAISE EXCEPTION 'organization_institution_class_required' USING ERRCODE = '23514';
  END IF;
  IF v_org.institution_class <> 'health_sector' THEN
    RAISE EXCEPTION 'facility_parent_must_be_health_sector' USING ERRCODE = '23514';
  END IF;

  IF p_facility_id IS NULL THEN
    INSERT INTO public.organization_facilities (
      organization_id, facility_class, name, name_ar, code, status, created_by
    ) VALUES (
      p_organization_id, p_facility_class, v_name, v_name_ar, v_code, v_status, v_actor
    )
    RETURNING * INTO v_row;
  ELSE
    SELECT * INTO v_row
    FROM public.organization_facilities WHERE id = p_facility_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'facility_not_found' USING ERRCODE = 'P0002';
    END IF;
    -- Re-parenting is refused outright: it would move every warehouse and
    -- outlet beneath this facility into another organization.
    IF v_row.organization_id IS DISTINCT FROM p_organization_id THEN
      RAISE EXCEPTION 'facility_organization_immutable' USING ERRCODE = '42501';
    END IF;

    UPDATE public.organization_facilities
       SET facility_class = p_facility_class,
           name           = v_name,
           name_ar        = v_name_ar,
           code           = v_code,
           status         = v_status
     WHERE id = v_row.id
    RETURNING * INTO v_row;
  END IF;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    p_organization_id, v_actor, v_actor_role,
    'organization_facility.upserted', 'organization_facilities', v_row.id, v_row.name,
    jsonb_build_object(
      'facility_class', v_row.facility_class,
      'status', v_row.status,
      'created', (p_facility_id IS NULL)
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'facility_id', v_row.id,
    'facility_class', v_row.facility_class, 'status', v_row.status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_upsert_organization_facility(uuid, uuid, text, text, text, text, boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_upsert_organization_facility(uuid, uuid, text, text, text, text, boolean)
  TO authenticated;

-- ============================================================================
-- 7. outlet_replenishment_routes — the pharmacy -> emergency-outlet authority
-- ============================================================================
-- METADATA ONLY. This table moves nothing; it records which pharmacy is allowed
-- to replenish which emergency outlet. The corridor that consumes it is a later
-- subphase. Modelled on warehouse_supply_routes (066:159-228), reusing its
-- composite-FK-against-a-pinned-discriminator technique.
CREATE TABLE public.outlet_replenishment_routes (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid NOT NULL,
  source_point_id           uuid NOT NULL,
  destination_point_id      uuid NOT NULL,
  source_point_type         text NOT NULL DEFAULT 'pharmacy',
  destination_point_type    text NOT NULL,
  is_active                 boolean NOT NULL DEFAULT true,
  notes                     text,
  created_by                uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT orr_no_self_transfer
    CHECK (source_point_id <> destination_point_id),
  CONSTRAINT orr_source_is_pharmacy
    CHECK (source_point_type = 'pharmacy'),
  CONSTRAINT orr_destination_is_emergency_outlet
    CHECK (destination_point_type IN ('rescue_cart', 'crash_cabinet')),

  -- Type eligibility, structural: the referenced point's ACTUAL point_type must
  -- equal the pinned value, so no writer — including a SECURITY DEFINER RPC or
  -- service_role — can route from a non-pharmacy or into a non-emergency outlet.
  CONSTRAINT orr_source_type_fk
    FOREIGN KEY (source_point_id, source_point_type)
    REFERENCES public.distribution_points (id, point_type) ON DELETE RESTRICT,
  CONSTRAINT orr_destination_type_fk
    FOREIGN KEY (destination_point_id, destination_point_type)
    REFERENCES public.distribution_points (id, point_type) ON DELETE RESTRICT,

  -- Organization isolation on both legs, structural.
  CONSTRAINT orr_source_org_fk
    FOREIGN KEY (source_point_id, organization_id)
    REFERENCES public.distribution_points (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT orr_destination_org_fk
    FOREIGN KEY (destination_point_id, organization_id)
    REFERENCES public.distribution_points (id, organization_id) ON DELETE RESTRICT
);

-- One active route per (source, destination) pair.
CREATE UNIQUE INDEX outlet_replenishment_routes_active_pair_uniq
  ON public.outlet_replenishment_routes (source_point_id, destination_point_id)
  WHERE is_active;

-- An emergency outlet has AT MOST ONE active source pharmacy, so the reversal
-- destination is unambiguous later. Deliberately asymmetric: there is no
-- uniqueness on the source, because one Emergency Pharmacy legitimately serves
-- many Rescue Carts.
CREATE UNIQUE INDEX outlet_replenishment_routes_one_source_per_destination
  ON public.outlet_replenishment_routes (destination_point_id)
  WHERE is_active;

CREATE INDEX outlet_replenishment_routes_source_idx
  ON public.outlet_replenishment_routes (source_point_id) WHERE is_active;

COMMENT ON TABLE public.outlet_replenishment_routes IS
  'FACILITY-IDENTITY-164: explicit pharmacy -> emergency-outlet pairing '
  'authority. METADATA ONLY — never a balance truth and it moves no stock. '
  'Rows are written ONLY by phoenix_upsert_outlet_replenishment_route. One '
  'active source per destination; no uniqueness on source (one emergency '
  'pharmacy may serve many rescue carts).';

DO $$ BEGIN
  CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.outlet_replenishment_routes
    FOR EACH ROW EXECUTE FUNCTION phoenix_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.outlet_replenishment_routes ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON TABLE public.outlet_replenishment_routes TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.outlet_replenishment_routes FROM authenticated;
REVOKE ALL ON TABLE public.outlet_replenishment_routes FROM anon;

DROP POLICY IF EXISTS outlet_replenishment_routes_select_scoped ON public.outlet_replenishment_routes;
CREATE POLICY outlet_replenishment_routes_select_scoped
  ON public.outlet_replenishment_routes
  FOR SELECT
  TO authenticated
  USING (
    organization_id = public.phoenix_my_org()
    OR public.phoenix_my_role() = 'super_admin'
  );

-- ============================================================================
-- 8. phoenix_upsert_outlet_replenishment_route — fail-closed eligibility
-- ============================================================================
-- Placement eligibility correlates FOUR tables (distribution_points,
-- warehouses, organizations, organization_facilities), and a CHECK may not
-- query another table (067:130). It is therefore enforced here, at ROUTE
-- CREATION — the low-frequency administrative act — and the route row is the
-- movement-time authority for the later corridor.
--
-- TWO route shapes, selected by the owning organization's class:
--
--   SHAPE H · health_sector — SAME FACILITY REQUIRED.
--     One sector contains MANY health centres, so same-organization is NOT
--     sufficient: it would let Centre A's pharmacy restock Centre B's cabinet.
--     Both endpoints must resolve to the SAME active facility. Destination must
--     be a crash cabinet in an emergency context; a health centre never has a
--     rescue cart.
--
--   SHAPE I · hospital / specialized_center — ORGANIZATION-SCOPED.
--     These have no facility layer (a facility may only exist under a
--     health_sector parent), so organization scope is the containment.
--     Rescue cart: hospital + emergency only. Crash cabinet: non-emergency.
--
-- Anything matching neither shape is REJECTED. NULL institution_class, NULL
-- clinical_location_kind, NULL facility_id on a health-sector endpoint, and an
-- inactive facility all fail closed. No name is ever inspected.
CREATE FUNCTION public.phoenix_upsert_outlet_replenishment_route(
  p_route_id             uuid,
  p_source_point_id      uuid,
  p_destination_point_id uuid,
  p_is_active            boolean DEFAULT true,
  p_notes                text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_src        record;
  v_dst        record;
  v_row        public.outlet_replenishment_routes%ROWTYPE;
  v_notes      text := NULLIF(btrim(p_notes), '');
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_source_point_id IS NULL OR p_destination_point_id IS NULL THEN
    RAISE EXCEPTION 'source_and_destination_required' USING ERRCODE = '23514';
  END IF;
  IF p_source_point_id = p_destination_point_id THEN
    RAISE EXCEPTION 'source_and_destination_must_differ' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_src FROM public._phoenix_outlet_facility_context_v1(p_source_point_id);
  IF v_src.o_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'source_outlet_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_dst FROM public._phoenix_outlet_facility_context_v1(p_destination_point_id);
  IF v_dst.o_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'destination_outlet_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'replenishment_routes.manage', v_src.o_organization_id, NULL, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_replenishment_routes_manage' USING ERRCODE = '42501';
  END IF;

  SELECT p.role INTO v_actor_role
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  -- Both outlets must be live and correctly typed.
  IF v_src.o_point_status <> 'active' OR v_dst.o_point_status <> 'active' THEN
    RAISE EXCEPTION 'outlet_not_active' USING ERRCODE = '23514';
  END IF;
  IF v_src.o_point_type <> 'pharmacy' THEN
    RAISE EXCEPTION 'source_must_be_pharmacy' USING ERRCODE = '23514';
  END IF;
  IF v_dst.o_point_type NOT IN ('rescue_cart', 'crash_cabinet') THEN
    RAISE EXCEPTION 'destination_must_be_emergency_outlet' USING ERRCODE = '23514';
  END IF;

  -- Organization isolation (also structural via the table's composite FKs).
  IF v_src.o_organization_id IS DISTINCT FROM v_dst.o_organization_id THEN
    RAISE EXCEPTION 'cross_organization_route_forbidden' USING ERRCODE = '42501';
  END IF;

  IF v_src.o_institution_class IS NULL THEN
    RAISE EXCEPTION 'organization_institution_class_required' USING ERRCODE = '23514';
  END IF;
  IF v_dst.o_clinical_location_kind IS NULL THEN
    RAISE EXCEPTION 'destination_clinical_location_kind_required' USING ERRCODE = '23514';
  END IF;

  IF v_src.o_institution_class = 'health_sector' THEN
    -- ── SHAPE H · same subordinate facility required ────────────────────────
    IF v_src.o_facility_id IS NULL OR v_dst.o_facility_id IS NULL THEN
      RAISE EXCEPTION 'health_center_route_requires_facility' USING ERRCODE = '23514';
    END IF;
    IF v_src.o_facility_id IS DISTINCT FROM v_dst.o_facility_id THEN
      RAISE EXCEPTION 'cross_facility_route_forbidden' USING ERRCODE = '42501';
    END IF;
    IF v_dst.o_facility_class NOT IN ('primary_health_center', 'subordinate_health_center') THEN
      RAISE EXCEPTION 'invalid_facility_class_for_route' USING ERRCODE = '23514';
    END IF;
    IF v_dst.o_facility_status <> 'active' THEN
      RAISE EXCEPTION 'facility_not_active' USING ERRCODE = '23514';
    END IF;
    -- A health centre never has a rescue cart.
    IF v_dst.o_point_type <> 'crash_cabinet' THEN
      RAISE EXCEPTION 'health_center_rescue_cart_forbidden' USING ERRCODE = '23514';
    END IF;
    IF v_dst.o_clinical_location_kind <> 'emergency' THEN
      RAISE EXCEPTION 'health_center_crash_cabinet_requires_emergency' USING ERRCODE = '23514';
    END IF;

  ELSIF v_src.o_institution_class IN ('hospital', 'specialized_center') THEN
    -- ── SHAPE I · organization-scoped; no facility layer exists here ────────
    IF v_src.o_facility_id IS NOT NULL OR v_dst.o_facility_id IS NOT NULL THEN
      RAISE EXCEPTION 'facility_not_permitted_for_this_institution_class' USING ERRCODE = '23514';
    END IF;

    IF v_dst.o_point_type = 'rescue_cart' THEN
      IF v_src.o_institution_class <> 'hospital' THEN
        RAISE EXCEPTION 'rescue_cart_requires_hospital' USING ERRCODE = '23514';
      END IF;
      IF v_dst.o_clinical_location_kind <> 'emergency' THEN
        RAISE EXCEPTION 'rescue_cart_requires_emergency_context' USING ERRCODE = '23514';
      END IF;
    ELSE
      IF v_dst.o_clinical_location_kind <> 'non_emergency' THEN
        RAISE EXCEPTION 'crash_cabinet_requires_non_emergency_context' USING ERRCODE = '23514';
      END IF;
    END IF;

  ELSE
    RAISE EXCEPTION 'unsupported_institution_class_for_route' USING ERRCODE = '23514';
  END IF;

  IF p_route_id IS NULL THEN
    INSERT INTO public.outlet_replenishment_routes (
      organization_id, source_point_id, destination_point_id,
      source_point_type, destination_point_type, is_active, notes, created_by
    ) VALUES (
      v_src.o_organization_id, p_source_point_id, p_destination_point_id,
      v_src.o_point_type, v_dst.o_point_type, p_is_active, v_notes, v_actor
    )
    RETURNING * INTO v_row;
  ELSE
    SELECT * INTO v_row
    FROM public.outlet_replenishment_routes WHERE id = p_route_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'route_not_found' USING ERRCODE = 'P0002';
    END IF;
    -- Endpoints are immutable: re-pointing a route would silently retarget its
    -- whole history. Deactivate and create a new route instead.
    IF v_row.source_point_id      IS DISTINCT FROM p_source_point_id
       OR v_row.destination_point_id IS DISTINCT FROM p_destination_point_id THEN
      RAISE EXCEPTION 'route_endpoints_immutable' USING ERRCODE = '42501';
    END IF;

    UPDATE public.outlet_replenishment_routes
       SET is_active = p_is_active,
           notes     = v_notes
     WHERE id = v_row.id
    RETURNING * INTO v_row;
  END IF;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_src.o_organization_id, v_actor, v_actor_role,
    'replenishment_route.upserted', 'outlet_replenishment_routes', v_row.id, NULL,
    jsonb_build_object(
      'source_point_id', v_row.source_point_id,
      'destination_point_id', v_row.destination_point_id,
      'destination_point_type', v_row.destination_point_type,
      'is_active', v_row.is_active,
      'created', (p_route_id IS NULL)
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'route_id', v_row.id, 'is_active', v_row.is_active
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_upsert_outlet_replenishment_route(uuid, uuid, uuid, boolean, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_upsert_outlet_replenishment_route(uuid, uuid, uuid, boolean, text)
  TO authenticated;

-- ============================================================================
-- 9. Permission keys + role defaults
-- ============================================================================
-- Registering a key grants nothing by itself; role_permission_defaults describe
-- intent (066:294-299). No existing key is widened, and outlet_stock.dispense is
-- deliberately NOT reused for replenishment — replenishment is not dispensing,
-- and conflating them would silently grant cart-restocking to every dispenser.
INSERT INTO public.permission_keys (key, module, action, label_en, label_ar, is_dangerous) VALUES
  ('organization_facilities.manage', 'organization_facilities', 'manage',
   'Manage subordinate health-centre facilities', 'إدارة المراكز الصحية التابعة', true),
  ('replenishment_routes.manage',    'replenishment_routes',    'manage',
   'Manage emergency replenishment routes',       'إدارة مسارات تجهيز الطوارئ',   true),
  ('outlet_stock.replenish',         'outlet_stock',            'replenish',
   'Replenish an emergency outlet from a pharmacy', 'تجهيز منفذ طوارئ من الصيدلية', false),
  ('outlet_stock.replenish_reverse', 'outlet_stock',            'replenish_reverse',
   'Reverse an emergency replenishment',           'عكس تجهيز الطوارئ',            false)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.role_permission_defaults (role, permission_key, allowed)
SELECT 'super_admin', k.key, true
FROM public.permission_keys k
WHERE k.key IN ('organization_facilities.manage', 'replenishment_routes.manage',
                'outlet_stock.replenish', 'outlet_stock.replenish_reverse')
ON CONFLICT (role, permission_key) DO NOTHING;

-- institution_admin administers its own institution's facilities and routes and
-- may replenish; it does NOT gain any stock-movement capability here, because
-- no corridor exists yet.
INSERT INTO public.role_permission_defaults (role, permission_key, allowed) VALUES
  ('institution_admin', 'organization_facilities.manage', true),
  ('institution_admin', 'replenishment_routes.manage',    true),
  ('institution_admin', 'outlet_stock.replenish',         true),
  ('institution_admin', 'outlet_stock.replenish_reverse', true)
ON CONFLICT (role, permission_key) DO NOTHING;

-- ============================================================================
-- 10. VERIFY — fail closed inside the same transaction
-- ============================================================================
DO $verify$
DECLARE
  v_def text;
BEGIN
  -- New objects exist.
  IF to_regclass('public.organization_facilities') IS NULL
     OR to_regclass('public.outlet_replenishment_routes') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (164): a new table is missing';
  END IF;
  IF to_regprocedure('public._phoenix_outlet_facility_context_v1(uuid)') IS NULL
     OR to_regprocedure('public.phoenix_upsert_organization_facility(uuid,uuid,text,text,text,text,boolean)') IS NULL
     OR to_regprocedure('public.phoenix_upsert_outlet_replenishment_route(uuid,uuid,uuid,boolean,text)') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (164): an expected routine is missing';
  END IF;

  -- The parent-is-health-sector guarantee is STRUCTURAL, not conventional.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'of_parent_class_fk' AND contype = 'f'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (164): of_parent_class_fk is not a foreign key';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'warehouses_facility_org_fk' AND contype = 'f'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (164): warehouses_facility_org_fk is not a foreign key';
  END IF;

  -- Route type/organization pinning is structural on all four legs.
  IF (SELECT count(*) FROM pg_constraint
      WHERE conrelid = 'public.outlet_replenishment_routes'::regclass
        AND contype = 'f'
        AND conname IN ('orr_source_type_fk','orr_destination_type_fk',
                        'orr_source_org_fk','orr_destination_org_fk')) <> 4 THEN
    RAISE EXCEPTION 'VERIFY FAILED (164): route composite FKs incomplete';
  END IF;

  -- NON-REGRESSION: warehouse_kind must still be exactly two values, and no
  -- facility_kind column may exist (it would persist the same fact twice).
  SELECT pg_get_constraintdef(oid) INTO v_def
  FROM pg_constraint WHERE conname = 'warehouses_warehouse_kind_chk';
  IF v_def IS NULL OR v_def LIKE '%health_center%' OR v_def LIKE '%depot%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (164): warehouses_warehouse_kind_chk was widened';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'warehouses' AND column_name = 'facility_kind'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (164): warehouses.facility_kind must not exist';
  END IF;

  -- NON-REGRESSION: Availability vocabulary untouched (exactly six values).
  SELECT pg_get_constraintdef(oid) INTO v_def
  FROM pg_constraint
  WHERE conrelid = 'public.item_availability'::regclass
    AND pg_get_constraintdef(oid) LIKE '%near_expiry%'
  LIMIT 1;
  IF v_def IS NULL OR v_def LIKE '%near_stockout%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (164): item_availability condition vocabulary changed';
  END IF;

  -- NON-REGRESSION: no new balance table, and the outlet movement vocabulary is
  -- untouched (widening it belongs to a later subphase, not this one).
  IF to_regclass('public.pharmacy_stock')       IS NOT NULL
     OR to_regclass('public.rescue_cart_stock')   IS NOT NULL
     OR to_regclass('public.crash_cabinet_stock') IS NOT NULL
     OR to_regclass('public.facility_stock')      IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (164): a second balance ledger was created';
  END IF;
  SELECT pg_get_constraintdef(oid) INTO v_def
  FROM pg_constraint WHERE conname = 'outlet_stock_movements_type_chk';
  IF v_def IS NULL OR v_def LIKE '%replenish%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (164): outlet movement vocabulary changed in E-2';
  END IF;

  -- New tables must not be readable by anon.
  IF has_table_privilege('anon', 'public.organization_facilities', 'SELECT')
     OR has_table_privilege('anon', 'public.outlet_replenishment_routes', 'SELECT') THEN
    RAISE EXCEPTION 'VERIFY FAILED (164): anon can read a new table';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.organization_facilities'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.outlet_replenishment_routes'::regclass) THEN
    RAISE EXCEPTION 'VERIFY FAILED (164): RLS is not enabled on a new table';
  END IF;

  -- The ownership resolver is internal.
  IF has_function_privilege('authenticated',
       'public._phoenix_outlet_facility_context_v1(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (164): internal resolver is executable by authenticated';
  END IF;

  -- No backfill happened: every classification column ships NULL.
  IF EXISTS (SELECT 1 FROM public.organizations WHERE institution_class IS NOT NULL) THEN
    RAISE EXCEPTION 'VERIFY FAILED (164): institution_class was backfilled';
  END IF;
  IF EXISTS (SELECT 1 FROM public.warehouses WHERE facility_id IS NOT NULL) THEN
    RAISE EXCEPTION 'VERIFY FAILED (164): facility_id was backfilled';
  END IF;
  IF EXISTS (SELECT 1 FROM public.distribution_points WHERE clinical_location_kind IS NOT NULL) THEN
    RAISE EXCEPTION 'VERIFY FAILED (164): clinical_location_kind was backfilled';
  END IF;
  IF EXISTS (SELECT 1 FROM public.organization_facilities) THEN
    RAISE EXCEPTION 'VERIFY FAILED (164): organization_facilities was seeded';
  END IF;

  RAISE NOTICE '164 VERIFY OK.';
END;
$verify$;

COMMIT;

-- ============================================================================
-- ROLLBACK (manual, if ever needed BEFORE any facility/route row exists):
--   DROP FUNCTION IF EXISTS public.phoenix_upsert_outlet_replenishment_route(uuid,uuid,uuid,boolean,text);
--   DROP FUNCTION IF EXISTS public.phoenix_upsert_organization_facility(uuid,uuid,text,text,text,text,boolean);
--   DROP FUNCTION IF EXISTS public._phoenix_outlet_facility_context_v1(uuid);
--   DROP TABLE IF EXISTS public.outlet_replenishment_routes;
--   ALTER TABLE public.distribution_points DROP CONSTRAINT IF EXISTS distribution_points_clinical_location_kind_chk;
--   ALTER TABLE public.distribution_points DROP COLUMN IF EXISTS clinical_location_kind;
--   DROP INDEX IF EXISTS public.warehouses_facility_idx;
--   ALTER TABLE public.warehouses DROP CONSTRAINT IF EXISTS warehouses_facility_org_fk;
--   ALTER TABLE public.warehouses DROP COLUMN IF EXISTS facility_id;
--   DROP TABLE IF EXISTS public.organization_facilities;
--   ALTER TABLE public.organizations DROP CONSTRAINT IF EXISTS organizations_id_institution_class_uniq;
--   ALTER TABLE public.organizations DROP CONSTRAINT IF EXISTS organizations_institution_class_chk;
--   ALTER TABLE public.organizations DROP COLUMN IF EXISTS institution_class;
--   DELETE FROM public.role_permission_defaults WHERE permission_key IN
--     ('organization_facilities.manage','replenishment_routes.manage',
--      'outlet_stock.replenish','outlet_stock.replenish_reverse');
--   DELETE FROM public.permission_keys WHERE key IN
--     ('organization_facilities.manage','replenishment_routes.manage',
--      'outlet_stock.replenish','outlet_stock.replenish_reverse');
-- ============================================================================
-- END OF MIGRATION 164
-- ============================================================================
