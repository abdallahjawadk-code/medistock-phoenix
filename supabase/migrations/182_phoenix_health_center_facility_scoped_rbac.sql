-- ============================================================================
-- R1.1-U — HEALTH-CENTER SCOPED USER MANAGEMENT / FACILITY-SCOPED RBAC (182)
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
--
-- Production DDL is applied ONCE, after 181, by the authorized operator through
-- `Supabase.apply_migration`, following an exact-ceiling preflight, the
-- read-only pre-apply evidence recorded in this PR, and independent approval.
-- `supabase db push` remains forbidden outright. (Historical migrations carry
-- older apply wording in their own headers and are NOT edited to match — they
-- are immutable.)
--
-- NOT APPLIED BY THIS PR. Authored and replayed on a disposable PostgreSQL rig
-- only. Migrations 001-181 are immutable and are NOT edited here.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE CONTRACT
-- ─────────────────────────────────────────────────────────────────────────────
--   Role defines WHAT.  Facility Scope defines WHERE.
--
--   Sector Institution Admin
--     └── creates/manages users inside THAT health sector
--          └── Health Center Manager
--               └── assigned to ONE OR MORE health-center facilities
--                    └── authorizes only resources of those facilities:
--                        center depot + center pharmacy + crash cabinets
--
-- A center manager must NEVER gain sector-main authority merely because it
-- belongs to the same organization.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THIS DOES NOT ADD A PARAMETER TO phoenix_profile_has_scoped_permission
-- ─────────────────────────────────────────────────────────────────────────────
-- That function (062/076) already resolves a NON-org-wide role by delegating:
--
--     warehouse request  -> phoenix_profile_has_warehouse_assignment(profile, wh)
--     outlet request     -> phoenix_profile_has_point_assignment(profile, dp)
--
-- and it answers FALSE for any role outside v_org_wide_roles when no resource is
-- named. So facility scope is introduced INSIDE those two assignment helpers
-- rather than as a sixth parameter. Every historical caller — policies and RPCs
-- alike — inherits facility scope with no call-site change and no signature
-- change, and `health_center_manager` is deliberately NOT added to
-- v_org_wide_roles, so a manager that names no resource still gets FALSE.
--
-- The facility branch in each helper is guarded by
-- `p.role = 'health_center_manager'`, a value no profile could hold before this
-- migration. No other organization class and no existing role can reach it, so
-- the widening is provably confined to the new role.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE SECTOR-MAIN EXCLUSION, STRUCTURALLY
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 181 makes the sector main the health sector's ONLY active warehouse
-- with facility_id IS NULL, and every center depot facility-bound. A facility
-- assignment can only ever match `w.facility_id = a.facility_id` where
-- a.facility_id is NOT NULL (enforced by psa_target_matches_scope_chk). NULL
-- never equals anything, so the sector main can never be matched by any facility
-- assignment. The exclusion is a consequence of 181's topology, not a blacklist.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- PERMISSION DEFAULTS ARE MINIMAL AND EACH ONE IS PROVEN SCOPE-AWARE
-- ─────────────────────────────────────────────────────────────────────────────
-- A permission is granted to health_center_manager ONLY where the data surface
-- behind it is facility-scoped. The live policy audit that decided this:
--
--   warehouses.view                -> warehouses.wh_select_scoped
--                                     calls phoenix_profile_has_warehouse_assignment  SCOPE-AWARE
--   warehouse_stock.view           -> warehouse_stock_select_scoped        SCOPE-AWARE
--   warehouse_stock.movements_view -> warehouse_stock_mov_select_scoped    SCOPE-AWARE
--   warehouse_dispatch.view        -> warehouse_dispatches/_lines          SCOPE-AWARE
--   outlet_stock.view              -> phoenix_can_read_outlet_stock ->
--                                     phoenix_profile_has_scoped_permission ->
--                                     phoenix_profile_has_point_assignment SCOPE-AWARE
--   ports.view                     -> distribution_points.dp_read_perm     ORG-WIDE (!)
--
-- ports.view was the one org-wide surface in the intended workflow, so section 9
-- narrows dp_read_perm for health_center_manager ONLY. Every other role keeps a
-- byte-identical predicate, which is provable rather than merely asserted: the
-- added conjunct is `phoenix_my_role() <> 'health_center_manager' OR ...`, and
-- no pre-182 profile can hold that role.
--
-- Permissions whose surfaces are org-wide and NOT narrowed here — reports.view
-- (phoenix_report_snapshots), users.view (profile_scope_assignments),
-- availability.* (item_availability.avail_select_org) — are deliberately NOT
-- granted. Write/mutation permissions are likewise NOT granted: each is backed
-- by an RPC whose own authority model needs its own audit, and this migration
-- fails closed rather than granting on resemblance to another manager role.
-- "No facility scope = no resource access", and "no proven scope-aware surface
-- = no permission".
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SCOPE — WHAT THIS MIGRATION DOES NOT DO
-- ─────────────────────────────────────────────────────────────────────────────
-- No third stock truth: warehouse_stock and outlet_stock remain the only two.
-- No unit domain. No change to Migration 181's topology contract, to Migration
-- 180's supply semantics, or to the Migration 146 nonce-bound provisioning
-- contract. No Production identifier, no organization-name matching. Facility
-- Scope is authorization metadata only.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 0. PRECONDITIONS — fail closed
-- ============================================================================
DO $preflight$
BEGIN
  IF to_regclass('public.profiles') IS NULL
     OR to_regclass('public.profile_scope_assignments') IS NULL
     OR to_regclass('public.organization_facilities') IS NULL
     OR to_regclass('public.organizations') IS NULL
     OR to_regclass('public.warehouses') IS NULL
     OR to_regclass('public.distribution_points') IS NULL
     OR to_regclass('public.role_permission_defaults') IS NULL
     OR to_regclass('public.permission_keys') IS NULL THEN
    RAISE EXCEPTION '182_precondition_failed: a core RBAC or topology table is absent';
  END IF;

  -- Migration 181 must own the topology this RBAC model rides on.
  IF to_regprocedure('public.phoenix_create_health_center_warehouse(uuid,uuid,text,text,text)') IS NULL THEN
    RAISE EXCEPTION '182_precondition_failed: Migration 181 is not applied';
  END IF;

  -- The five-role vocabulary this migration extends by exactly one.
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='profiles_role_check')
     NOT LIKE '%outlet_officer%' THEN
    RAISE EXCEPTION '182_precondition_failed: profiles_role_check is not the expected five-role vocabulary';
  END IF;
  IF EXISTS (SELECT 1 FROM public.profiles WHERE role = 'health_center_manager') THEN
    RAISE EXCEPTION '182_precondition_failed: a health_center_manager profile already exists';
  END IF;

  -- The assignment ledger this migration extends rather than duplicates.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='profile_scope_assignments' AND column_name='facility_id'
  ) THEN
    RAISE EXCEPTION '182_precondition_failed: profile_scope_assignments.facility_id already exists';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(ARRAY[
      'psa_scope_type_chk','psa_target_matches_scope_chk','psa_status_chk',
      'psa_warehouse_org_fk','psa_point_org_fk'
    ]) AS required(c)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = required.c AND conrelid='public.profile_scope_assignments'::regclass
    )
  ) THEN
    RAISE EXCEPTION '182_precondition_failed: a 062 scope-ledger constraint this migration extends is absent';
  END IF;

  -- The composite FK target this migration needs. 164 already provides it, so
  -- no new unique index is invented here.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='organization_facilities_id_org_uniq'
      AND conrelid='public.organization_facilities'::regclass AND contype='u'
  ) THEN
    RAISE EXCEPTION '182_precondition_failed: organization_facilities(id, organization_id) UNIQUE is absent';
  END IF;

  -- A facility can only ever belong to a health sector (164). The reject-cases
  -- for hospital/specialized facilities rest on this, so it is proved, not assumed.
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='of_parent_is_health_sector_chk')
     NOT LIKE '%health_sector%' THEN
    RAISE EXCEPTION '182_precondition_failed: of_parent_is_health_sector_chk changed';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='of_facility_class_chk')
     NOT LIKE '%subordinate_health_center%' THEN
    RAISE EXCEPTION '182_precondition_failed: the 164 facility-class vocabulary changed';
  END IF;

  -- The helpers this migration forward-replaces must exist with the exact
  -- signatures every historical caller already uses.
  IF to_regprocedure('public.phoenix_profile_has_warehouse_assignment(uuid,uuid)') IS NULL
     OR to_regprocedure('public.phoenix_profile_has_point_assignment(uuid,uuid)') IS NULL
     OR to_regprocedure('public.phoenix_profile_has_scoped_permission(uuid,text,uuid,uuid,uuid)') IS NULL
     OR to_regprocedure('public.phoenix_assign_profile_scope(uuid,text,uuid)') IS NULL
     OR to_regprocedure('public.phoenix_revoke_profile_scope(uuid,text)') IS NULL
     OR to_regprocedure('public.phoenix_validate_profile_scope_assignment()') IS NULL THEN
    RAISE EXCEPTION '182_precondition_failed: an RBAC function this migration extends is absent';
  END IF;

  -- The Migration 146 provisioning contract stays authoritative and untouched.
  IF to_regprocedure('public.phoenix_admin_provision_profile(uuid,uuid,uuid,uuid,text,text,text,text,text,uuid)') IS NULL THEN
    RAISE EXCEPTION '182_precondition_failed: the 146 provisioning contract is absent';
  END IF;

  -- Idempotency guard: this migration is not re-runnable.
  IF to_regprocedure('public.phoenix_profile_has_facility_assignment(uuid,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION '182_precondition_failed: the 182 facility helper already exists';
  END IF;
END;
$preflight$;

-- ============================================================================
-- 1. ROLE VOCABULARY — exactly one new official role
-- ============================================================================
-- health_center_manager / مسؤول المركز الصحي. An OPERATIONAL FACILITY-SCOPED
-- role: not organization-wide, and not an alias for institution_admin,
-- warehouse_officer, outlet_officer or central_warehouse_manager. The five
-- historical roles are preserved verbatim and none is remapped.
ALTER TABLE public.profiles DROP CONSTRAINT profiles_role_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check CHECK (
  role = ANY (ARRAY[
    'super_admin'::text,
    'central_warehouse_manager'::text,
    'institution_admin'::text,
    'warehouse_officer'::text,
    'outlet_officer'::text,
    'health_center_manager'::text
  ])
);

-- ============================================================================
-- 2. FACILITY SCOPE — extend the ONE assignment ledger, never a second table
-- ============================================================================
ALTER TABLE public.profile_scope_assignments ADD COLUMN facility_id uuid;

-- Both historical scope_type checks must admit the new value. 062 left two
-- overlapping constraints on this column; extending only one would leave the
-- other rejecting every facility row.
ALTER TABLE public.profile_scope_assignments
  DROP CONSTRAINT profile_scope_assignments_scope_type_check;
ALTER TABLE public.profile_scope_assignments
  ADD CONSTRAINT profile_scope_assignments_scope_type_check
  CHECK (scope_type = ANY (ARRAY['warehouse'::text, 'distribution_point'::text, 'outlet'::text, 'facility'::text]));

ALTER TABLE public.profile_scope_assignments DROP CONSTRAINT psa_scope_type_chk;
ALTER TABLE public.profile_scope_assignments
  ADD CONSTRAINT psa_scope_type_chk
  CHECK (scope_type = ANY (ARRAY['warehouse'::text, 'distribution_point'::text, 'facility'::text]));

-- Exactly one target column may be populated, per scope type. The warehouse and
-- distribution_point branches are byte-identical to 062's.
ALTER TABLE public.profile_scope_assignments DROP CONSTRAINT psa_target_matches_scope_chk;
ALTER TABLE public.profile_scope_assignments
  ADD CONSTRAINT psa_target_matches_scope_chk CHECK (
    CASE scope_type
      WHEN 'warehouse'::text          THEN warehouse_id IS NOT NULL AND distribution_point_id IS NULL AND facility_id IS NULL
      WHEN 'distribution_point'::text THEN distribution_point_id IS NOT NULL AND warehouse_id IS NULL AND facility_id IS NULL
      WHEN 'facility'::text           THEN facility_id IS NOT NULL AND warehouse_id IS NULL AND distribution_point_id IS NULL
      ELSE false
    END
  );

-- Structural ownership, matching psa_warehouse_org_fk / psa_point_org_fk
-- exactly: a facility assignment cannot name a facility of another organization,
-- and ON DELETE RESTRICT keeps assignment history from being silently orphaned.
-- This is the FIRST of the three independent cross-sector layers (FK, write-time
-- trigger, read-time helper).
ALTER TABLE public.profile_scope_assignments
  ADD CONSTRAINT psa_facility_org_fk
  FOREIGN KEY (facility_id, organization_id)
  REFERENCES public.organization_facilities (id, organization_id)
  ON DELETE RESTRICT;

-- ONE ACTIVE assignment per (profile, facility) — the direct analogue of
-- psa_active_warehouse_uniq / psa_active_point_uniq. Partial on is_active, so
-- revoked history never blocks a later reassignment, and deliberately NOT unique
-- on profile_id alone: one manager may hold many centers simultaneously, and one
-- center may have many managers.
CREATE UNIQUE INDEX psa_active_facility_uniq
  ON public.profile_scope_assignments (profile_id, facility_id)
  WHERE is_active = true AND scope_type = 'facility';

CREATE INDEX psa_facility_idx ON public.profile_scope_assignments (facility_id);

COMMENT ON COLUMN public.profile_scope_assignments.facility_id IS
  'R1.1-U: the health-center facility this assignment authorizes, for scope_type=''facility''. NULL for every warehouse/distribution_point assignment. Structurally owned through psa_facility_org_fk (facility_id, organization_id) so a cross-sector facility cannot be named even by a privileged writer.';

-- ============================================================================
-- 3. WRITE-TIME VALIDATION — the second cross-sector layer
-- ============================================================================
-- Forward-replaces 062's trigger function. The profile/organization agreement
-- and the warehouse and distribution_point branches are preserved verbatim; a
-- facility branch is added. Revoked rows stay exempt for the same reason 062
-- exempts them: a facility deactivated AFTER an assignment was revoked must not
-- make that historical row unwritable.
CREATE OR REPLACE FUNCTION public.phoenix_validate_profile_scope_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_profile_org    uuid;
  v_profile_found  boolean;
  v_profile_role   text;
  v_target_status  text;
  v_facility       public.organization_facilities%ROWTYPE;
  v_org_kind       text;
  v_org_class      text;
  v_org_status     text;
BEGIN
  SELECT p.organization_id, true, p.role INTO v_profile_org, v_profile_found, v_profile_role
  FROM public.profiles p
  WHERE p.id = NEW.profile_id;

  -- Defensive: the FK already guarantees the profile exists, but this trigger
  -- must not depend on constraint evaluation order to stay fail-closed.
  IF NOT COALESCE(v_profile_found, false) THEN
    RAISE EXCEPTION 'SCOPE_ASSIGNMENT_PROFILE_NOT_FOUND: profile % does not exist', NEW.profile_id
      USING ERRCODE = '23503';
  END IF;

  IF v_profile_org IS NULL THEN
    RAISE EXCEPTION 'SCOPE_ASSIGNMENT_ORG_MISMATCH: profile % has no organization and cannot hold a scope assignment', NEW.profile_id
      USING ERRCODE = '23514';
  END IF;

  IF v_profile_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'SCOPE_ASSIGNMENT_ORG_MISMATCH: assignment organization % does not match profile organization %', NEW.organization_id, v_profile_org
      USING ERRCODE = '23514';
  END IF;

  -- An ACTIVE assignment must name a live target. Revoked rows are history and
  -- are deliberately exempt: a warehouse archived AFTER an assignment was
  -- revoked must not make that historical row unwritable.
  IF NEW.is_active THEN
    IF NEW.scope_type = 'warehouse' THEN
      SELECT w.status INTO v_target_status
      FROM public.warehouses w
      WHERE w.id = NEW.warehouse_id AND w.organization_id = NEW.organization_id;

      IF v_target_status IS NULL THEN
        RAISE EXCEPTION 'SCOPE_ASSIGNMENT_TARGET_NOT_FOUND: warehouse % not found in organization %', NEW.warehouse_id, NEW.organization_id
          USING ERRCODE = '23503';
      END IF;

      IF v_target_status <> 'active' THEN
        RAISE EXCEPTION 'SCOPE_ASSIGNMENT_TARGET_INACTIVE: warehouse % is % — an active assignment requires an active warehouse', NEW.warehouse_id, v_target_status
          USING ERRCODE = '23514';
      END IF;

    ELSIF NEW.scope_type = 'distribution_point' THEN
      SELECT d.status INTO v_target_status
      FROM public.distribution_points d
      WHERE d.id = NEW.distribution_point_id AND d.organization_id = NEW.organization_id;

      IF v_target_status IS NULL THEN
        RAISE EXCEPTION 'SCOPE_ASSIGNMENT_TARGET_NOT_FOUND: distribution point % not found in organization %', NEW.distribution_point_id, NEW.organization_id
          USING ERRCODE = '23503';
      END IF;

      IF v_target_status <> 'active' THEN
        RAISE EXCEPTION 'SCOPE_ASSIGNMENT_TARGET_INACTIVE: distribution point % is % — an active assignment requires an active outlet', NEW.distribution_point_id, v_target_status
          USING ERRCODE = '23514';
      END IF;

    ELSIF NEW.scope_type = 'facility' THEN
      -- R1.1-U. Facility scope is meaningful for exactly one role.
      IF v_profile_role IS DISTINCT FROM 'health_center_manager' THEN
        RAISE EXCEPTION 'SCOPE_ASSIGNMENT_ROLE_INELIGIBLE: facility scope requires role health_center_manager, profile % is %', NEW.profile_id, v_profile_role
          USING ERRCODE = '23514';
      END IF;

      SELECT o.organization_kind, o.institution_class, o.status
        INTO v_org_kind, v_org_class, v_org_status
      FROM public.organizations o WHERE o.id = NEW.organization_id;

      IF v_org_status IS DISTINCT FROM 'active'
         OR v_org_kind IS DISTINCT FROM 'care_institution'
         OR v_org_class IS DISTINCT FROM 'health_sector' THEN
        RAISE EXCEPTION 'SCOPE_ASSIGNMENT_ORGANIZATION_NOT_HEALTH_SECTOR: organization % is not an active care_institution health sector', NEW.organization_id
          USING ERRCODE = '23514';
      END IF;

      -- psa_facility_org_fk already proves same-organization structurally; this
      -- adds the class and status rules a foreign key cannot express.
      SELECT * INTO v_facility
      FROM public.organization_facilities WHERE id = NEW.facility_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'SCOPE_ASSIGNMENT_TARGET_NOT_FOUND: facility % not found', NEW.facility_id
          USING ERRCODE = '23503';
      END IF;
      IF v_facility.organization_id IS DISTINCT FROM NEW.organization_id THEN
        RAISE EXCEPTION 'SCOPE_ASSIGNMENT_FACILITY_ORGANIZATION_MISMATCH: facility % does not belong to organization %', NEW.facility_id, NEW.organization_id
          USING ERRCODE = '42501';
      END IF;
      IF v_facility.facility_class NOT IN ('primary_health_center', 'subordinate_health_center') THEN
        RAISE EXCEPTION 'SCOPE_ASSIGNMENT_FACILITY_CLASS_INVALID: %', v_facility.facility_class
          USING ERRCODE = '23514';
      END IF;
      IF v_facility.status IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION 'SCOPE_ASSIGNMENT_TARGET_INACTIVE: facility % is % — an active assignment requires an active health center', NEW.facility_id, v_facility.status
          USING ERRCODE = '23514';
      END IF;

    ELSE
      -- Unreachable while psa_scope_type_chk holds; fail closed regardless
      -- rather than silently accepting an unknown scope type.
      RAISE EXCEPTION 'SCOPE_ASSIGNMENT_UNKNOWN_SCOPE_TYPE: %', NEW.scope_type
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- ============================================================================
-- 4. PROFILE ROLE INVARIANT — a manager cannot exist outside a health sector
-- ============================================================================
-- Deliberately does NOT require a facility assignment: legitimate provisioning
-- creates the profile first and inserts its assignment set immediately after, in
-- one transaction. Requiring scope here would make correct provisioning
-- impossible. It is safe precisely because "no facility scope = no resource
-- access" — an unscoped manager can reach nothing.
CREATE FUNCTION public._phoenix_profile_role_organization_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_kind   text;
  v_class  text;
  v_status text;
BEGIN
  IF NEW.role IS DISTINCT FROM 'health_center_manager' THEN
    RETURN NEW;
  END IF;
  -- Historical rows are not judged; only a live identity asserts authority.
  IF NEW.status IS DISTINCT FROM 'active' THEN
    RETURN NEW;
  END IF;

  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'health_center_manager_requires_organization'
      USING ERRCODE = '23514',
      DETAIL = 'an active health_center_manager is a facility-scoped role and cannot be a platform profile';
  END IF;

  SELECT o.organization_kind, o.institution_class, o.status
    INTO v_kind, v_class, v_status
  FROM public.organizations o WHERE o.id = NEW.organization_id;

  IF v_status IS DISTINCT FROM 'active'
     OR v_kind IS DISTINCT FROM 'care_institution'
     OR v_class IS DISTINCT FROM 'health_sector' THEN
    RAISE EXCEPTION 'health_center_manager_requires_active_health_sector'
      USING ERRCODE = '23514',
      DETAIL = 'organization must be an ACTIVE care_institution with institution_class=health_sector';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER profiles_health_center_manager_org_guard_trg
  BEFORE INSERT OR UPDATE OF role, organization_id, status
  ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public._phoenix_profile_role_organization_guard_v1();

REVOKE ALL ON FUNCTION public._phoenix_profile_role_organization_guard_v1()
  FROM PUBLIC, anon, authenticated, service_role;

-- ============================================================================
-- 5. READ-TIME HELPERS — the third cross-sector layer
-- ============================================================================
-- Every condition is re-proved at READ time rather than trusted from the
-- write-time trigger, matching 062's three-way agreement discipline: a drifted
-- row, a deactivated facility, a suspended profile or a re-classified
-- organization all take effect immediately, with no backfill.
CREATE FUNCTION public.phoenix_profile_has_facility_assignment(
  p_profile_id  uuid,
  p_facility_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profile_scope_assignments a
    JOIN public.profiles                p ON p.id = a.profile_id
    JOIN public.organization_facilities f ON f.id = a.facility_id
    JOIN public.organizations           o ON o.id = p.organization_id
    WHERE a.profile_id  = p_profile_id
      AND a.facility_id = p_facility_id
      AND a.scope_type  = 'facility'
      AND a.is_active   = true
      AND p.status = 'active'
      AND p.role   = 'health_center_manager'
      AND f.status = 'active'
      AND f.facility_class IN ('primary_health_center', 'subordinate_health_center')
      -- Three-way organization agreement: assignment, profile and facility.
      AND a.organization_id = p.organization_id
      AND a.organization_id = f.organization_id
      AND o.status            = 'active'
      AND o.organization_kind = 'care_institution'
      AND o.institution_class = 'health_sector'
  );
$$;

REVOKE ALL ON FUNCTION public.phoenix_profile_has_facility_assignment(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_profile_has_facility_assignment(uuid, uuid) TO authenticated, service_role;

-- ── 5b. WAREHOUSE ASSIGNMENT — direct, OR facility-derived for the new role ──
-- The first EXISTS is 062/076's body verbatim: a DIRECT warehouse assignment
-- behaves exactly as it does today for every role, including the new one. The
-- second is additive and reachable only by health_center_manager.
CREATE OR REPLACE FUNCTION public.phoenix_profile_has_warehouse_assignment(
  p_profile_id uuid, p_warehouse_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profile_scope_assignments a
    JOIN public.profiles   p ON p.id = a.profile_id
    JOIN public.warehouses w ON w.id = a.warehouse_id
    WHERE a.profile_id   = p_profile_id
      AND a.warehouse_id = p_warehouse_id
      AND a.scope_type   = 'warehouse'
      AND a.is_active    = true
      -- The assignment authorizes nothing once the person is disabled...
      AND p.status = 'active'
      -- ...nor once the warehouse is archived/inactive (re-proved at read time,
      -- so archiving a warehouse takes effect immediately, with no backfill).
      AND w.status = 'active'
      -- Organization agreement re-proved at read time rather than assumed from
      -- the write-time trigger: three-way, so no single drifted row authorizes.
      AND a.organization_id = p.organization_id
      AND a.organization_id = w.organization_id
  )
  -- R1.1-U: FACILITY-DERIVED. A health-center manager reaches the center depot
  -- of each center it is assigned to, and nothing else. The sector main has
  -- facility_id IS NULL (181), and NULL never equals a.facility_id, so it can
  -- never be matched here — that is the sector-main exclusion, structurally.
  OR EXISTS (
    SELECT 1
    FROM public.profiles                p
    JOIN public.warehouses              w ON w.id = p_warehouse_id
    JOIN public.profile_scope_assignments a
      ON a.profile_id = p.id
     AND a.scope_type = 'facility'
     AND a.is_active  = true
     AND a.facility_id = w.facility_id
    JOIN public.organization_facilities f ON f.id = a.facility_id
    JOIN public.organizations           o ON o.id = p.organization_id
    WHERE p.id     = p_profile_id
      AND p.status = 'active'
      AND p.role   = 'health_center_manager'
      AND w.status = 'active'
      AND w.facility_id IS NOT NULL
      AND w.organization_id = p.organization_id
      AND a.organization_id = p.organization_id
      AND f.organization_id = p.organization_id
      AND f.status = 'active'
      AND f.facility_class IN ('primary_health_center', 'subordinate_health_center')
      AND o.status            = 'active'
      AND o.organization_kind = 'care_institution'
      AND o.institution_class = 'health_sector'
  );
$$;

-- ── 5c. POINT ASSIGNMENT — direct, OR derived through the owning center depot ─
CREATE OR REPLACE FUNCTION public.phoenix_profile_has_point_assignment(
  p_profile_id uuid, p_distribution_point_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profile_scope_assignments a
    JOIN public.profiles            p ON p.id = a.profile_id
    JOIN public.distribution_points d ON d.id = a.distribution_point_id
    WHERE a.profile_id            = p_profile_id
      AND a.distribution_point_id = p_distribution_point_id
      AND a.scope_type            = 'distribution_point'
      AND a.is_active             = true
      AND p.status = 'active'
      AND d.status = 'active'
      AND a.organization_id = p.organization_id
      AND a.organization_id = d.organization_id
  )
  -- R1.1-U: the center pharmacy and crash cabinets of an assigned center, and
  -- nothing else. The outlet is resolved to its owning warehouse, and that
  -- warehouse must be a facility-bound center depot of an assigned center — so
  -- an outlet on another center's depot, or (per 181, impossible) on the sector
  -- main, never matches.
  OR EXISTS (
    SELECT 1
    FROM public.profiles                p
    JOIN public.distribution_points     d ON d.id = p_distribution_point_id
    JOIN public.warehouses              w ON w.id = d.warehouse_id
    JOIN public.profile_scope_assignments a
      ON a.profile_id = p.id
     AND a.scope_type = 'facility'
     AND a.is_active  = true
     AND a.facility_id = w.facility_id
    JOIN public.organization_facilities f ON f.id = a.facility_id
    JOIN public.organizations           o ON o.id = p.organization_id
    WHERE p.id     = p_profile_id
      AND p.status = 'active'
      AND p.role   = 'health_center_manager'
      AND d.status = 'active'
      AND w.status = 'active'
      AND w.facility_id IS NOT NULL
      AND d.organization_id = p.organization_id
      AND w.organization_id = p.organization_id
      AND a.organization_id = p.organization_id
      AND f.organization_id = p.organization_id
      AND f.status = 'active'
      AND f.facility_class IN ('primary_health_center', 'subordinate_health_center')
      AND o.status            = 'active'
      AND o.organization_kind = 'care_institution'
      AND o.institution_class = 'health_sector'
  );
$$;

-- ============================================================================
-- 6. ASSIGNMENT RPC — extend the canonical writer, do not fork it
-- ============================================================================
-- Signature and existing behaviour preserved exactly. p_target_id is read as
-- facility_id when p_scope_type='facility'. phoenix_revoke_profile_scope needs
-- NO change: it keys on assignment_id, never branches on scope_type, already
-- mandates a reason, already audits scope_revoked, and already preserves history
-- by UPDATE rather than DELETE.
CREATE OR REPLACE FUNCTION public.phoenix_assign_profile_scope(
  p_profile_id uuid, p_scope_type text, p_target_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role         text := public.phoenix_my_role();
  v_actor        uuid := auth.uid();
  v_is_super     boolean := (v_role = 'super_admin');
  v_profile_org  uuid;
  v_profile_role text;
  v_existing     uuid;
  v_id           uuid;
  v_org_kind     text;
  v_org_class    text;
  v_org_status   text;
BEGIN
  IF p_scope_type NOT IN ('warehouse', 'distribution_point', 'facility') THEN
    RAISE EXCEPTION 'SCOPE_TYPE_INVALID: % (expected warehouse|distribution_point|facility)', p_scope_type USING ERRCODE = '23514';
  END IF;

  -- Authority: super_admin, or users.edit_scope holder. Non-super callers are
  -- constrained to their own org below (the IDOR guard).
  IF NOT v_is_super AND NOT public.phoenix_profile_has_permission(v_actor, 'users.edit_scope') THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED_SCOPE_ASSIGN: requires super_admin or users.edit_scope' USING ERRCODE = '42501';
  END IF;

  SELECT organization_id, role INTO v_profile_org, v_profile_role
  FROM public.profiles WHERE id = p_profile_id;
  IF v_profile_org IS NULL THEN
    -- Either the profile does not exist, or it is a platform profile (super_admin)
    -- with no org; neither can hold a scope. The trigger would also reject this.
    RAISE EXCEPTION 'SCOPE_ASSIGN_PROFILE_INELIGIBLE: profile % has no organization', p_profile_id USING ERRCODE = '23514';
  END IF;

  -- IDOR / cross-org guard for non-super callers: you may only assign within
  -- your own organization. super_admin is exempt (platform role).
  IF NOT v_is_super AND public.phoenix_my_org() IS DISTINCT FROM v_profile_org THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED_SCOPE_ASSIGN_CROSS_ORG: caller may only assign within its own organization' USING ERRCODE = '42501';
  END IF;

  -- R1.1-U: a FACILITY assignment carries additional authority requirements.
  IF p_scope_type = 'facility' THEN
    IF v_profile_role IS DISTINCT FROM 'health_center_manager' THEN
      RAISE EXCEPTION 'SCOPE_ASSIGN_ROLE_INELIGIBLE: facility scope requires role health_center_manager' USING ERRCODE = '23514';
    END IF;

    SELECT o.organization_kind, o.institution_class, o.status
      INTO v_org_kind, v_org_class, v_org_status
    FROM public.organizations o WHERE o.id = v_profile_org;
    IF v_org_status IS DISTINCT FROM 'active'
       OR v_org_kind IS DISTINCT FROM 'care_institution'
       OR v_org_class IS DISTINCT FROM 'health_sector' THEN
      RAISE EXCEPTION 'SCOPE_ASSIGN_ORGANIZATION_NOT_HEALTH_SECTOR: organization % is not an active care_institution health sector', v_profile_org
        USING ERRCODE = '23514';
    END IF;

    -- A non-super caller assigning facility scope must be the sector's own
    -- institution_admin. users.edit_scope alone is not enough for this role.
    IF NOT v_is_super AND v_role IS DISTINCT FROM 'institution_admin' THEN
      RAISE EXCEPTION 'NOT_AUTHORIZED_FACILITY_SCOPE_ASSIGN: requires super_admin or the sector institution_admin' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Idempotent: an existing ACTIVE assignment for this (profile, target) is a
  -- no-op, not an error (double-submit / retry safe). Serialize per profile so a
  -- concurrent duplicate cannot slip past the check-then-insert.
  PERFORM pg_advisory_xact_lock(hashtext('phoenix_scope_assign:' || p_profile_id::text));

  IF p_scope_type = 'warehouse' THEN
    SELECT id INTO v_existing FROM public.profile_scope_assignments
    WHERE profile_id = p_profile_id AND scope_type = 'warehouse' AND warehouse_id = p_target_id AND is_active = true;
  ELSIF p_scope_type = 'distribution_point' THEN
    SELECT id INTO v_existing FROM public.profile_scope_assignments
    WHERE profile_id = p_profile_id AND scope_type = 'distribution_point' AND distribution_point_id = p_target_id AND is_active = true;
  ELSE
    SELECT id INTO v_existing FROM public.profile_scope_assignments
    WHERE profile_id = p_profile_id AND scope_type = 'facility' AND facility_id = p_target_id AND is_active = true;
  END IF;

  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'assignment_id', v_existing, 'idempotent_replay', true);
  END IF;

  -- Insert. organization_id is taken from the profile so it can never disagree
  -- with it; the 062/182 trigger re-proves org-match + target-active fail-closed.
  INSERT INTO public.profile_scope_assignments
    (profile_id, organization_id, scope_type, warehouse_id, distribution_point_id, facility_id, is_active, assigned_by)
  VALUES (
    p_profile_id, v_profile_org, p_scope_type,
    CASE WHEN p_scope_type = 'warehouse'          THEN p_target_id ELSE NULL END,
    CASE WHEN p_scope_type = 'distribution_point' THEN p_target_id ELSE NULL END,
    CASE WHEN p_scope_type = 'facility'           THEN p_target_id ELSE NULL END,
    true, v_actor
  )
  RETURNING id INTO v_id;

  INSERT INTO audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
  VALUES (v_profile_org, v_actor, v_role, 'scope_assigned', 'profile_scope_assignment', v_id, NULL,
          jsonb_build_object(
            'profile_id', p_profile_id, 'scope_type', p_scope_type, 'target_id', p_target_id,
            'facility_id', CASE WHEN p_scope_type = 'facility' THEN p_target_id ELSE NULL END,
            'organization_id', v_profile_org));

  RETURN jsonb_build_object('ok', true, 'assignment_id', v_id, 'idempotent_replay', false);
END;
$$;

-- ============================================================================
-- 7. SERVICE-ONLY PROVISIONING COMPANION — all-or-nothing facility scope
-- ============================================================================
-- Auth Admin createUser cannot join a PostgreSQL transaction, so the Edge
-- function's sequence is: create Auth user -> phoenix_admin_provision_profile ->
-- THIS -> (on any failure) Auth Admin deleteUser. This function is the single DB
-- statement that turns a set of facility ids into assignments, and it validates
-- EVERY id before writing ANY row, so a partial set can never be committed.
--
-- It takes the ACTOR explicitly because service_role has no auth.uid(); the
-- actor is re-verified here rather than trusted, exactly as Migration 146 does.
-- It is NOT a substitute for phoenix_assign_profile_scope in an authenticated
-- context — that remains the canonical writer for interactive scope editing.
CREATE FUNCTION public.phoenix_admin_assign_facility_scopes(
  p_actor_id      uuid,
  p_profile_id    uuid,
  p_facility_ids  uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor_role   text;
  v_actor_org    uuid;
  v_actor_status text;
  v_profile_org  uuid;
  v_profile_role text;
  v_org_kind     text;
  v_org_class    text;
  v_org_status   text;
  v_ids          uuid[];
  v_fid          uuid;
  v_facility     public.organization_facilities%ROWTYPE;
  v_created      uuid[] := ARRAY[]::uuid[];
  v_id           uuid;
BEGIN
  IF p_actor_id IS NULL OR p_profile_id IS NULL THEN
    RAISE EXCEPTION 'FACILITY_SCOPE_ARGUMENTS_REQUIRED' USING ERRCODE = '23514';
  END IF;

  -- De-duplicate and reject an empty set: a health_center_manager with no
  -- facility is unusable by design, and silently creating one hides the error.
  SELECT array_agg(DISTINCT x) INTO v_ids
  FROM unnest(coalesce(p_facility_ids, ARRAY[]::uuid[])) x WHERE x IS NOT NULL;

  IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'FACILITY_SCOPE_SET_EMPTY: at least one health-center facility is required'
      USING ERRCODE = '23514';
  END IF;
  IF array_length(v_ids, 1) > 64 THEN
    RAISE EXCEPTION 'FACILITY_SCOPE_SET_TOO_LARGE: % facilities requested', array_length(v_ids, 1)
      USING ERRCODE = '23514';
  END IF;

  -- ACTOR — re-verified, never trusted from the caller's claim.
  SELECT p.role, p.organization_id, p.status
    INTO v_actor_role, v_actor_org, v_actor_status
  FROM public.profiles p WHERE p.id = p_actor_id;
  IF NOT FOUND OR v_actor_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'FACILITY_SCOPE_ACTOR_INELIGIBLE' USING ERRCODE = '42501';
  END IF;

  -- TARGET.
  SELECT p.organization_id, p.role INTO v_profile_org, v_profile_role
  FROM public.profiles p WHERE p.id = p_profile_id;
  IF NOT FOUND OR v_profile_org IS NULL THEN
    RAISE EXCEPTION 'FACILITY_SCOPE_PROFILE_INELIGIBLE' USING ERRCODE = '23514';
  END IF;
  IF v_profile_role IS DISTINCT FROM 'health_center_manager' THEN
    RAISE EXCEPTION 'FACILITY_SCOPE_ROLE_INELIGIBLE: target role is %', v_profile_role USING ERRCODE = '23514';
  END IF;

  IF v_actor_role IS DISTINCT FROM 'super_admin' THEN
    IF v_actor_role IS DISTINCT FROM 'institution_admin' THEN
      RAISE EXCEPTION 'NOT_AUTHORIZED_FACILITY_SCOPE_ASSIGN' USING ERRCODE = '42501';
    END IF;
    IF v_actor_org IS DISTINCT FROM v_profile_org THEN
      RAISE EXCEPTION 'NOT_AUTHORIZED_FACILITY_SCOPE_CROSS_ORG' USING ERRCODE = '42501';
    END IF;
    IF NOT public.phoenix_profile_has_permission(p_actor_id, 'users.edit_scope') THEN
      RAISE EXCEPTION 'NOT_AUTHORIZED_FACILITY_SCOPE_ASSIGN: requires users.edit_scope' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT o.organization_kind, o.institution_class, o.status
    INTO v_org_kind, v_org_class, v_org_status
  FROM public.organizations o WHERE o.id = v_profile_org;
  IF v_org_status IS DISTINCT FROM 'active'
     OR v_org_kind IS DISTINCT FROM 'care_institution'
     OR v_org_class IS DISTINCT FROM 'health_sector' THEN
    RAISE EXCEPTION 'FACILITY_SCOPE_ORGANIZATION_NOT_HEALTH_SECTOR' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('phoenix_scope_assign:' || p_profile_id::text));

  -- VALIDATE EVERY id BEFORE writing ANY row.
  FOREACH v_fid IN ARRAY v_ids LOOP
    SELECT * INTO v_facility FROM public.organization_facilities WHERE id = v_fid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'FACILITY_SCOPE_FACILITY_NOT_FOUND: %', v_fid USING ERRCODE = '23503';
    END IF;
    IF v_facility.organization_id IS DISTINCT FROM v_profile_org THEN
      RAISE EXCEPTION 'FACILITY_SCOPE_FACILITY_FOREIGN: % does not belong to organization %', v_fid, v_profile_org
        USING ERRCODE = '42501';
    END IF;
    IF v_facility.status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'FACILITY_SCOPE_FACILITY_INACTIVE: %', v_fid USING ERRCODE = '23514';
    END IF;
    IF v_facility.facility_class NOT IN ('primary_health_center', 'subordinate_health_center') THEN
      RAISE EXCEPTION 'FACILITY_SCOPE_FACILITY_CLASS_INVALID: %', v_facility.facility_class USING ERRCODE = '23514';
    END IF;
  END LOOP;

  -- WRITE. Same transaction, so any failure above left zero rows behind.
  FOREACH v_fid IN ARRAY v_ids LOOP
    SELECT id INTO v_id FROM public.profile_scope_assignments
    WHERE profile_id = p_profile_id AND scope_type = 'facility'
      AND facility_id = v_fid AND is_active = true;

    IF v_id IS NULL THEN
      INSERT INTO public.profile_scope_assignments
        (profile_id, organization_id, scope_type, facility_id, is_active, assigned_by)
      VALUES (p_profile_id, v_profile_org, 'facility', v_fid, true, p_actor_id)
      RETURNING id INTO v_id;

      INSERT INTO audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload)
      VALUES (v_profile_org, p_actor_id, v_actor_role, 'scope_assigned', 'profile_scope_assignment', v_id, NULL,
              jsonb_build_object(
                'profile_id', p_profile_id, 'scope_type', 'facility', 'target_id', v_fid,
                'facility_id', v_fid, 'organization_id', v_profile_org, 'provisioning', true));
    END IF;

    v_created := v_created || v_id;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'profile_id', p_profile_id, 'assignment_ids', to_jsonb(v_created));
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_admin_assign_facility_scopes(uuid, uuid, uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_admin_assign_facility_scopes(uuid, uuid, uuid[])
  TO service_role;

-- ============================================================================
-- 7b. PROVISIONING CONTRACT — forward-replace, so the new role is creatable
-- ============================================================================
-- Migration 146 carries its OWN five-role whitelist and returns INVALID_ROLE for
-- anything outside it, so without this a health_center_manager could never be
-- provisioned at all. 146 itself is immutable and is NOT edited; this is a
-- forward replacement, generated from the live 146 definition so that
-- everything it already proves stays byte-identical: the advisory lock, the
-- Auth app-metadata nonce binding, the actor re-derivation, the
-- cross-organization guard, the privileged-role refusal, the fresh-placeholder
-- inspection, the UPDATE-only one-shot write and the audit row.
--
-- EXACTLY TWO semantic changes:
--   1. 'health_center_manager' joins the role whitelist;
--   2. that role additionally requires an ACTIVE care_institution health sector,
--      checked for EVERY caller — super_admin included — so a hospital or
--      specialized-centre institution_admin is refused by the database and not
--      merely hidden in the UI. The refusal reuses 146's own generic
--      _phoenix_lifecycle_deny path, so it is audited exactly like every other
--      denial and returns the same opaque REQUEST_DENIED to the caller.
CREATE OR REPLACE FUNCTION public.phoenix_admin_provision_profile(p_actor_id uuid, p_new_id uuid, p_provisioning_nonce uuid, p_organization_id uuid, p_full_name text, p_role text, p_login_mode text, p_username text DEFAULT NULL::text, p_contact_email text DEFAULT NULL::text, p_correlation_id uuid DEFAULT gen_random_uuid())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_correlation      uuid := coalesce(p_correlation_id, gen_random_uuid());
  v_actor_role       text;
  v_actor_org        uuid;
  v_actor_status     text;
  v_actor_auth_exists boolean := false;
  v_is_super         boolean := false;
  v_is_institution   boolean := false;
  v_org_status       text;
  v_auth_created_at  timestamptz;
  v_auth_email       text;
  v_auth_app_meta    jsonb;
  v_auth_user_meta   jsonb;
  v_target_org       uuid;
  v_target_name      text;
  v_target_role      text;
  v_target_status    text;
  v_target_login     text;
  v_target_username  text;
  v_target_contact   text;
  v_target_must_change boolean;
  v_username         text := nullif(lower(btrim(coalesce(p_username, ''))), '');
begin
  -- Shape checks are non-sensitive and may return actionable error codes.
  if p_actor_id is null or p_new_id is null or p_provisioning_nonce is null
     or p_organization_id is null then
    return jsonb_build_object(
      'ok', false, 'error', 'INVALID_INPUT', 'correlation_id', v_correlation
    );
  end if;

  if p_actor_id = p_new_id then
    return jsonb_build_object(
      'ok', false,
      'error', 'REQUEST_DENIED',
      'correlation_id', v_correlation
    );
  end if;

  if nullif(btrim(coalesce(p_full_name, '')), '') is null
     or length(btrim(p_full_name)) > 200 then
    return jsonb_build_object(
      'ok', false, 'error', 'INVALID_FULL_NAME', 'correlation_id', v_correlation
    );
  end if;

  if p_role not in (
    'super_admin',
    'institution_admin',
    'central_warehouse_manager',
    'warehouse_officer',
    'outlet_officer',
    'health_center_manager'
  ) then
    return jsonb_build_object(
      'ok', false, 'error', 'INVALID_ROLE', 'correlation_id', v_correlation
    );
  end if;

  if p_login_mode not in ('local', 'email') then
    return jsonb_build_object(
      'ok', false, 'error', 'INVALID_LOGIN_MODE', 'correlation_id', v_correlation
    );
  end if;

  if p_login_mode = 'local' then
    if v_username is null or v_username !~ '^[a-z0-9._-]{3,32}$' then
      return jsonb_build_object(
        'ok', false, 'error', 'INVALID_USERNAME', 'correlation_id', v_correlation
      );
    end if;
  elsif p_username is not null or p_contact_email is not null then
    return jsonb_build_object(
      'ok', false, 'error', 'INVALID_IDENTITY_FIELDS', 'correlation_id', v_correlation
    );
  end if;

  -- Serialize all attempts for this target. This makes duplicate/replayed
  -- provisioning deterministic even when two Edge invocations race.
  perform pg_advisory_xact_lock(
    hashtextextended('phoenix-user-provision:' || p_new_id::text, 146)
  );

  select exists(select 1 from auth.users where id = p_actor_id)
    into v_actor_auth_exists;

  select role, organization_id, status
    into v_actor_role, v_actor_org, v_actor_status
  from public.profiles
  where id = p_actor_id;

  v_is_super := (
    v_actor_role = 'super_admin'
    and v_actor_status = 'active'
  );
  v_is_institution := (
    v_actor_role = 'institution_admin'
    and v_actor_status = 'active'
  );

  if not (v_is_super or v_is_institution) then
    return public._phoenix_lifecycle_deny(
      case when v_actor_auth_exists then p_actor_id else null end,
      v_actor_role,
      v_actor_org,
      p_new_id,
      'actor_not_authorized',
      v_correlation
    );
  end if;

  if v_is_institution then
    if coalesce(
         public.phoenix_profile_has_permission(p_actor_id, 'users.create'),
         false
       ) is not true
       or coalesce(
         public.phoenix_profile_has_permission(p_actor_id, 'users.assign_role'),
         false
       ) is not true then
      return public._phoenix_lifecycle_deny(
        p_actor_id,
        v_actor_role,
        v_actor_org,
        p_new_id,
        'actor_missing_permission',
        v_correlation
      );
    end if;

    if p_organization_id is distinct from v_actor_org then
      return public._phoenix_lifecycle_deny(
        p_actor_id,
        v_actor_role,
        v_actor_org,
        p_new_id,
        'cross_org',
        v_correlation
      );
    end if;

    if p_role in (
      'super_admin',
      'institution_admin',
      'central_warehouse_manager'
    ) then
      return public._phoenix_lifecycle_deny(
        p_actor_id,
        v_actor_role,
        v_actor_org,
        p_new_id,
        'cannot_create_privileged_role',
        v_correlation
      );
    end if;
  end if;

  select status into v_org_status
  from public.organizations
  where id = p_organization_id;

  if v_org_status is distinct from 'active' then
    return public._phoenix_lifecycle_deny(
      p_actor_id,
      v_actor_role,
      v_actor_org,
      p_new_id,
      'organization_not_active',
      v_correlation
    );
  end if;

  -- R1.1-U: a facility-scoped role exists only inside a health sector. Applied
  -- to EVERY caller, super_admin included, so the identity can never be created
  -- somewhere its facility scope could not be granted. A hospital or
  -- specialized-centre institution_admin is refused here, not merely in the UI.
  if p_role = 'health_center_manager' then
    if not exists (
      select 1 from public.organizations o
      where o.id = p_organization_id
        and o.status = 'active'
        and o.organization_kind = 'care_institution'
        and o.institution_class = 'health_sector'
    ) then
      return public._phoenix_lifecycle_deny(
        p_actor_id,
        v_actor_role,
        v_actor_org,
        p_new_id,
        'health_center_manager_requires_health_sector',
        v_correlation
      );
    end if;
  end if;

  -- Auth Admin creates the user first. phoenix_handle_new_user then inserts a
  -- fail-closed outlet_officer placeholder. Lock and inspect that exact pair.
  select
    u.created_at,
    u.email,
    coalesce(u.raw_app_meta_data, '{}'::jsonb),
    coalesce(u.raw_user_meta_data, '{}'::jsonb),
    p.organization_id,
    p.full_name,
    p.role,
    p.status,
    p.login_mode,
    p.username,
    p.contact_email,
    p.must_change_password
  into
    v_auth_created_at,
    v_auth_email,
    v_auth_app_meta,
    v_auth_user_meta,
    v_target_org,
    v_target_name,
    v_target_role,
    v_target_status,
    v_target_login,
    v_target_username,
    v_target_contact,
    v_target_must_change
  from auth.users u
  join public.profiles p on p.id = u.id
  where u.id = p_new_id
  for update of p;

  if v_auth_created_at is null
     or v_auth_created_at < now() - interval '10 minutes'
     or v_auth_app_meta->>'phoenix_provisioning_nonce'
          is distinct from p_provisioning_nonce::text
     or v_auth_app_meta->>'phoenix_provisioning_actor_id'
          is distinct from p_actor_id::text
     or v_auth_user_meta->>'full_name'
          is distinct from btrim(p_full_name)
     or v_target_org is not null
     or v_target_name is distinct from btrim(p_full_name)
     or v_target_role is distinct from 'outlet_officer'
     or v_target_status is distinct from 'active'
     or v_target_login is distinct from 'email'
     or v_target_username is not null
     or v_target_contact is not null
     or v_target_must_change is distinct from false then
    return public._phoenix_lifecycle_deny(
      p_actor_id,
      v_actor_role,
      v_actor_org,
      p_new_id,
      'target_not_fresh_placeholder',
      v_correlation
    );
  end if;

  if p_login_mode = 'local'
     and lower(coalesce(v_auth_email, ''))
          is distinct from v_username || '@local.medistock.invalid' then
    return public._phoenix_lifecycle_deny(
      p_actor_id,
      v_actor_role,
      v_actor_org,
      p_new_id,
      'auth_identity_mismatch',
      v_correlation
    );
  end if;

  -- Deliberately UPDATE-only and one-shot. There is no ON CONFLICT branch:
  -- a pre-existing real profile can never be repurposed by this contract.
  update public.profiles
  set organization_id = p_organization_id,
      full_name = btrim(p_full_name),
      role = p_role,
      status = 'active',
      login_mode = p_login_mode,
      username = case when p_login_mode = 'local' then v_username else null end,
      contact_email = case
        when p_login_mode = 'local'
        then nullif(btrim(coalesce(p_contact_email, '')), '')
        else null
      end,
      must_change_password = (p_login_mode = 'local'),
      updated_at = now()
  where id = p_new_id;

  insert into public.audit_logs (
    organization_id,
    actor_id,
    actor_role,
    action,
    entity_type,
    entity_id,
    payload
  )
  values (
    p_organization_id,
    p_actor_id,
    v_actor_role,
    'user.created',
    'profile',
    p_new_id,
    jsonb_build_object(
      'role', p_role,
      'login_mode', p_login_mode,
      'provisioning_contract', 'service_only_v146',
      'correlation_id', v_correlation
    )
  );

  return jsonb_build_object(
    'ok', true,
    'user_id', p_new_id,
    'role', p_role,
    'correlation_id', v_correlation
  );
end;
$function$;

-- ============================================================================
-- 8. ROLE PERMISSION DEFAULTS — minimum necessary, never organization-wide
-- ============================================================================
-- Each key here was checked against the live policy that consumes it (see the
-- header). Nothing is granted because another manager role holds it.
INSERT INTO public.role_permission_defaults (role, permission_key, allowed) VALUES
  ('health_center_manager', 'warehouses.view',                true),
  ('health_center_manager', 'warehouse_stock.view',           true),
  ('health_center_manager', 'warehouse_stock.movements_view', true),
  ('health_center_manager', 'warehouse_dispatch.view',        true),
  ('health_center_manager', 'outlet_stock.view',              true),
  ('health_center_manager', 'ports.view',                     true);

-- ============================================================================
-- 9. RLS — narrow the two org-wide surfaces, for the NEW ROLE ONLY
-- ============================================================================
-- Both rewrites take the form `phoenix_my_role() <> 'health_center_manager' OR
-- <facility test>`. For every pre-182 role that conjunct is TRUE, so the
-- predicate is semantically identical to today's for them — non-regression by
-- construction, not by assertion.

-- 9a. organization_facilities: a manager sees ONLY its assigned centers.
DROP POLICY organization_facilities_select_scoped ON public.organization_facilities;
CREATE POLICY organization_facilities_select_scoped ON public.organization_facilities
  FOR SELECT TO authenticated
  USING (
    phoenix_my_role() = 'super_admin'
    OR (
      organization_id = phoenix_my_org()
      AND (
        phoenix_my_role() <> 'health_center_manager'
        OR phoenix_profile_has_facility_assignment(auth.uid(), id)
      )
    )
  );

-- 9b. distribution_points: ports.view is org-wide, so a facility-scoped role
--     must additionally prove per-outlet authorization. Without this, granting
--     ports.view would leak every other center's outlets.
DROP POLICY dp_read_perm ON public.distribution_points;
CREATE POLICY dp_read_perm ON public.distribution_points
  FOR SELECT TO authenticated
  USING (
    phoenix_my_role() = 'super_admin'
    OR (
      phoenix_profile_has_permission(auth.uid(), 'ports.view')
      AND organization_id = phoenix_my_org()
      AND (
        phoenix_my_role() <> 'health_center_manager'
        OR phoenix_profile_has_point_assignment(auth.uid(), id)
      )
    )
  );

-- ============================================================================
-- 10. COMMENTS
-- ============================================================================
COMMENT ON FUNCTION public.phoenix_profile_has_facility_assignment(uuid, uuid) IS
  'R1.1-U: TRUE only when an ACTIVE facility assignment authorizes this profile for this health-center facility. Every condition is re-proved at read time — profile active and role health_center_manager, facility active and of primary/subordinate health-centre class, three-way organization agreement between assignment, profile and facility, and the organization itself an ACTIVE care_institution health sector. Fails closed on NULL, missing rows and any drift.';

COMMENT ON FUNCTION public.phoenix_profile_has_warehouse_assignment(uuid, uuid) IS
  'RBAC: TRUE for a DIRECT active warehouse assignment (062/076 semantics, unchanged for every role), OR — for health_center_manager only — when the warehouse is the facility-bound center depot of a health centre the profile is actively assigned to. The sector main carries facility_id IS NULL (181) and therefore can never be matched by a facility assignment, so a center manager cannot inherit sector-main authority from organization membership.';

COMMENT ON FUNCTION public.phoenix_profile_has_point_assignment(uuid, uuid) IS
  'RBAC: TRUE for a DIRECT active outlet assignment (062/076 semantics, unchanged for every role), OR — for health_center_manager only — when the outlet hangs off the facility-bound center depot of an assigned health centre. Resolves outlet -> owning warehouse -> facility, so another centre''s pharmacy or crash cabinet never matches.';

COMMENT ON FUNCTION public.phoenix_admin_assign_facility_scopes(uuid, uuid, uuid[]) IS
  'R1.1-U: SERVICE-ONLY companion to the Migration 146 provisioning contract. Validates the actor, the target profile, the organization and EVERY facility id before writing ANY assignment, so a partial facility set can never be committed; the Edge function rolls the Auth user back if this fails. service_role only — authenticated scope editing goes through phoenix_assign_profile_scope.';

COMMENT ON FUNCTION public._phoenix_profile_role_organization_guard_v1() IS
  'R1.1-U: an ACTIVE health_center_manager must belong to an ACTIVE care_institution organization with institution_class=health_sector. Deliberately does NOT require a facility assignment — provisioning creates the profile before inserting its assignment set in the same transaction — which is safe because an unscoped manager can reach no resource at all.';

-- ============================================================================
-- 11. VERIFY — in-transaction, fails the whole migration
-- ============================================================================
DO $verify$
DECLARE
  v_bad integer;
  v_def text;
BEGIN
  -- 11a. Role vocabulary: six roles, the historical five intact.
  v_def := (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='profiles_role_check');
  IF v_def NOT LIKE '%health_center_manager%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (182): health_center_manager is not in profiles_role_check';
  END IF;
  FOR v_bad IN
    SELECT 1 FROM unnest(ARRAY['super_admin','central_warehouse_manager','institution_admin',
                               'warehouse_officer','outlet_officer']) r
    WHERE v_def NOT LIKE '%'||r||'%'
  LOOP
    RAISE EXCEPTION 'VERIFY FAILED (182): a historical role was dropped from profiles_role_check';
  END LOOP;

  -- 11b. Facility scope schema.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='profile_scope_assignments'
                   AND column_name='facility_id' AND data_type='uuid' AND is_nullable='YES') THEN
    RAISE EXCEPTION 'VERIFY FAILED (182): facility_id is absent or has the wrong shape';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='psa_facility_org_fk'
                   AND pg_get_constraintdef(oid) LIKE '%REFERENCES organization_facilities(id, organization_id)%'
                   AND pg_get_constraintdef(oid) LIKE '%ON DELETE RESTRICT%') THEN
    RAISE EXCEPTION 'VERIFY FAILED (182): the composite facility ownership FK is absent or wrong';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='psa_active_facility_uniq') THEN
    RAISE EXCEPTION 'VERIFY FAILED (182): psa_active_facility_uniq is absent';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='psa_scope_type_chk') NOT LIKE '%facility%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (182): psa_scope_type_chk does not admit facility';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='profile_scope_assignments_scope_type_check') NOT LIKE '%facility%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (182): the second scope_type check does not admit facility';
  END IF;

  -- 11c. Direct client DML on the ledger remains impossible.
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema='public' AND table_name='profile_scope_assignments'
      AND grantee='authenticated' AND privilege_type IN ('INSERT','UPDATE','DELETE')
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (182): authenticated gained direct DML on profile_scope_assignments';
  END IF;

  -- 11d. Helper security posture.
  FOR v_bad IN
    SELECT 1 FROM (VALUES
      ('phoenix_profile_has_facility_assignment'),
      ('phoenix_profile_has_warehouse_assignment'),
      ('phoenix_profile_has_point_assignment'),
      ('phoenix_admin_assign_facility_scopes'),
      ('_phoenix_profile_role_organization_guard_v1')
    ) AS t(fn)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname=t.fn AND p.prosecdef
        AND p.proconfig @> ARRAY['search_path=public, pg_temp']
    )
  LOOP
    RAISE EXCEPTION 'VERIFY FAILED (182): a helper is missing, not SECURITY DEFINER, or not search_path-pinned';
  END LOOP;

  IF has_function_privilege('authenticated', 'public.phoenix_admin_assign_facility_scopes(uuid,uuid,uuid[])'::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon', 'public.phoenix_admin_assign_facility_scopes(uuid,uuid,uuid[])'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (182): the service-only facility writer is reachable by a client role';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.phoenix_admin_assign_facility_scopes(uuid,uuid,uuid[])'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (182): service_role cannot reach the provisioning companion';
  END IF;
  IF has_function_privilege('anon', 'public.phoenix_profile_has_facility_assignment(uuid,uuid)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (182): anon can reach the facility helper';
  END IF;

  -- 11e. The scoped-permission contract is untouched, and the new role is NOT
  --      organization-wide.
  v_def := pg_get_functiondef('public.phoenix_profile_has_scoped_permission(uuid,text,uuid,uuid,uuid)'::regprocedure);
  IF v_def LIKE '%health_center_manager%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (182): health_center_manager leaked into the scoped-permission resolver';
  END IF;
  IF v_def NOT LIKE '%v_org_wide_roles text[] := ARRAY[''institution_admin'']%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (182): the organization-wide role set changed';
  END IF;

  -- 11f. The sector main can never be facility-derived: both helpers demand a
  --      non-null warehouse facility.
  IF pg_get_functiondef('public.phoenix_profile_has_warehouse_assignment(uuid,uuid)'::regprocedure)
     NOT LIKE '%w.facility_id IS NOT NULL%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (182): the warehouse helper lost the sector-main exclusion';
  END IF;
  IF pg_get_functiondef('public.phoenix_profile_has_point_assignment(uuid,uuid)'::regprocedure)
     NOT LIKE '%w.facility_id IS NOT NULL%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (182): the point helper lost the sector-main exclusion';
  END IF;

  -- 11g. Role defaults: exactly the audited minimum, and nothing administrative.
  SELECT count(*) INTO v_bad FROM public.role_permission_defaults
  WHERE role='health_center_manager'
    AND permission_key IN ('users.create','users.assign_role','users.edit_scope','users.disable',
                           'users.reset_permissions','users.view','organization_facilities.manage',
                           'warehouses.manage','central_warehouse.manage','inventory.purge','reports.view');
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (182): health_center_manager holds % administrative permission(s)', v_bad;
  END IF;
  SELECT count(*) INTO v_bad FROM public.role_permission_defaults WHERE role='health_center_manager';
  IF v_bad <> 6 THEN
    RAISE EXCEPTION 'VERIFY FAILED (182): expected 6 health_center_manager defaults, found %', v_bad;
  END IF;

  -- 11h. Historical role defaults are untouched.
  FOR v_bad IN
    SELECT 1 FROM (VALUES
      ('super_admin',124),('institution_admin',96),('warehouse_officer',102),
      ('outlet_officer',47),('central_warehouse_manager',55)
    ) AS t(r,n)
    WHERE (SELECT count(*) FROM public.role_permission_defaults d WHERE d.role=t.r) <> t.n
  LOOP
    RAISE EXCEPTION 'VERIFY FAILED (182): a historical role''s permission defaults changed';
  END LOOP;

  -- 11i. The two narrowed policies still exist and mention the new role only as
  --      an exclusion.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
                   AND tablename='organization_facilities' AND policyname='organization_facilities_select_scoped'
                   AND qual LIKE '%phoenix_profile_has_facility_assignment%') THEN
    RAISE EXCEPTION 'VERIFY FAILED (182): the facility SELECT policy was not narrowed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
                   AND tablename='distribution_points' AND policyname='dp_read_perm'
                   AND qual LIKE '%phoenix_profile_has_point_assignment%'
                   AND qual LIKE '%ports.view%') THEN
    RAISE EXCEPTION 'VERIFY FAILED (182): dp_read_perm was not narrowed, or lost ports.view';
  END IF;

  -- 11j. NON-REGRESSION — R1.1-U owns RBAC and nothing else.
  IF (SELECT count(*) FROM pg_class
      WHERE relname IN ('facility_stock','health_center_stock','manager_stock','unit_stock')) <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (182): a third stock truth was created';
  END IF;
  IF (SELECT count(*) FROM pg_class
      WHERE relname IN ('health_center_units','units','unit_routes','unit_scopes')) <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (182): a unit domain was created';
  END IF;
  IF (SELECT count(*) FROM pg_class WHERE relname IN ('warehouse_stock','outlet_stock')) <> 2 THEN
    RAISE EXCEPTION 'VERIFY FAILED (182): the two stock truths were disturbed';
  END IF;
  -- 181's topology contract is intact.
  IF pg_get_functiondef('public._phoenix_health_sector_outlet_topology_guard_v1()'::regprocedure)
     NOT LIKE '%health_sector_outlet_requires_health_center_depot%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (182): Migration 181''s outlet topology guard was disturbed';
  END IF;
  -- 180's supply boundary is intact.
  IF pg_get_functiondef('public.phoenix_replenish_emergency_outlet(uuid,uuid,uuid,integer,text,text)'::regprocedure)
     NOT LIKE '%initial_provisioning_required_before_replenishment%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (182): Migration 180''s replenishment gate was disturbed';
  END IF;
  -- 146's provisioning contract is intact.
  IF pg_get_functiondef('public.phoenix_admin_provision_profile(uuid,uuid,uuid,uuid,text,text,text,text,text,uuid)'::regprocedure)
     NOT LIKE '%nonce%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (182): the Migration 146 nonce contract was disturbed';
  END IF;
  -- The revoke contract still preserves history rather than deleting it.
  IF pg_get_functiondef('public.phoenix_revoke_profile_scope(uuid,text)'::regprocedure)
     LIKE '%DELETE FROM public.profile_scope_assignments%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (182): scope revocation now deletes history';
  END IF;

  RAISE NOTICE '182 VERIFY OK.';
END;
$verify$;

COMMIT;

-- ============================================================================
-- ROLLBACK (manual):
--   DROP POLICY dp_read_perm ON public.distribution_points;                    -- then re-create 024's
--   DROP POLICY organization_facilities_select_scoped ON public.organization_facilities;
--   DELETE FROM public.role_permission_defaults WHERE role='health_center_manager';
--   DROP TRIGGER profiles_health_center_manager_org_guard_trg ON public.profiles;
--   DROP FUNCTION public._phoenix_profile_role_organization_guard_v1();
--   DROP FUNCTION public.phoenix_admin_assign_facility_scopes(uuid, uuid, uuid[]);
--   DROP FUNCTION public.phoenix_profile_has_facility_assignment(uuid, uuid);
--   DROP INDEX public.psa_active_facility_uniq;
--   DROP INDEX public.psa_facility_idx;
--   ALTER TABLE public.profile_scope_assignments DROP CONSTRAINT psa_facility_org_fk;
--   ALTER TABLE public.profile_scope_assignments DROP COLUMN facility_id;       -- see note
--   -- then restore 062's psa_scope_type_chk / psa_target_matches_scope_chk and
--   -- 076's phoenix_profile_has_warehouse_assignment / _point_assignment /
--   -- phoenix_assign_profile_scope / phoenix_validate_profile_scope_assignment,
--   -- and finally the five-role profiles_role_check.
--
--   NOTE: dropping facility_id destroys facility assignment HISTORY. A reversal
--   that must preserve it should revoke the assignments (audited, reason
--   recorded) and leave the column in place. Reversal is an operator decision on
--   live data, not a scripted step. This migration creates, alters and deletes
--   no stock, movement, dispatch or route row.
-- ============================================================================
-- END OF MIGRATION 182
-- ============================================================================
