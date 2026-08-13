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
  v_scopes integer;
BEGIN
  -- ── LEAVING the role: facility scope must be closed FIRST ─────────────────
  -- Every path that rewrites profiles.role passes through here, including
  -- phoenix_recycle_apply (which assigns role = p_new_role directly), so this is
  -- a database invariant rather than a patch applied to one RPC.
  --
  -- The read-time helpers already re-prove `p.role = 'health_center_manager'`,
  -- so an orphaned assignment authorizes nothing the instant the role changes.
  -- The reason to refuse anyway is the ROUND TRIP: recycle out, recycle back in,
  -- and the identity would silently regain centres nobody re-authorized. Closing
  -- the scopes explicitly — audited, with a mandatory reason, through
  -- phoenix_revoke_profile_scope — is the only way that trail stays honest.
  --
  -- No history is deleted to satisfy this: revoked rows are exactly what the
  -- operator is being asked to produce.
  IF TG_OP = 'UPDATE'
     AND OLD.role = 'health_center_manager'
     AND NEW.role IS DISTINCT FROM OLD.role THEN
    SELECT count(*) INTO v_scopes
    FROM public.profile_scope_assignments a
    WHERE a.profile_id = NEW.id AND a.scope_type = 'facility' AND a.is_active;

    IF v_scopes > 0 THEN
      RAISE EXCEPTION 'health_center_manager_role_change_blocked_by_active_facility_scope'
        USING ERRCODE = '23514',
        DETAIL = format(
          '%s active facility assignment(s) remain; revoke them through phoenix_revoke_profile_scope, with a reason, before changing this role',
          v_scopes);
    END IF;
  END IF;

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
-- 9c. FACILITY CONFIDENTIALITY — close the organization-wide READ surfaces
-- ============================================================================
-- R1.1-U SAFE ACTIVATION (U-B).
--
-- Sections 9a/9b narrowed the two surfaces the granted permission keys reach.
-- They are not sufficient on their own, because a large part of this schema
-- authorizes reads on ORGANIZATION MEMBERSHIP ALONE — no permission key, no
-- scope assignment. For every role that existed before 182 that was the whole
-- contract and remains correct. For a FACILITY-SCOPED role it is not: "same
-- organization" is precisely the boundary this role must not inherit, so an
-- org-only predicate hands one health centre's manager every other centre's
-- data, and the sector main's.
--
-- Two distinct bypasses are closed here.
--
-- (1) ORG-ONLY RLS. Seven SELECT policies authorize on organization alone. The
--     highest-severity is item_availability: 182 deliberately withholds every
--     availability.* key, but avail_select_org (002) never consults a permission
--     key at all, so withholding them changed nothing. qr_targets/qr_tokens,
--     the two route tables and the stocktake pair matter for the same reason
--     AND as ENUMERATION ORACLES: they hand out the distribution_point and
--     warehouse ids that 9b's dp_read_perm narrowing otherwise hides, which is
--     what makes the next class exploitable.
--
-- (2) SECURITY DEFINER READ MODELS. phoenix_outlet_availability_read_model (179)
--     and phoenix_available_stock (083) are granted to `authenticated` and gate
--     on `v_org = <point>_org`. Being SECURITY DEFINER they bypass RLS entirely,
--     so they defeat outlet_stock_select_scoped AND 9b's dp_read_perm: any
--     outlet id in the sector returns that outlet's full stock. Narrowing
--     policies without closing these would be security theatre.
--
-- THE PATTERN, everywhere: `phoenix_my_role() <> 'health_center_manager' OR
-- <scope test>`. That conjunct is TRUE for every pre-182 role, and no profile
-- could hold this role before this migration, so every existing role's
-- predicate is semantically identical to today's — non-regression by
-- construction rather than by assertion.
--
-- NOT closed here, and deliberately: dashboard condition counts (054),
-- get_entity_purge_impact (003), local_items / profiles / paper references /
-- inventory status reports. Each is org-only and each is recorded in the U-B
-- report as a U-C dependency. They are aggregate, reference or personnel
-- surfaces rather than per-centre clinical stock, none is reachable through a
-- permission this role holds, and closing them would reach well beyond safe
-- activation into surfaces this substage is not authorized to redesign. The
-- U-B rule applied instead is the brief's own: a surface that cannot be proven
-- facility-safe is DENIED to the role at the application boundary, and the
-- dependency is documented rather than hidden.

-- ── 9c-1. item_availability — the highest-severity leak ─────────────────────
-- distribution_point_id is NOT NULL, so every row resolves to an outlet and
-- therefore to a facility through its owning centre depot.
DROP POLICY avail_select_org ON public.item_availability;
CREATE POLICY avail_select_org ON public.item_availability
  FOR SELECT TO authenticated
  USING (
    (
      phoenix_my_role() = 'super_admin'
      OR organization_id = phoenix_my_org()
    )
    AND (
      phoenix_my_role() <> 'health_center_manager'
      OR phoenix_profile_has_point_assignment(auth.uid(), distribution_point_id)
    )
  );

-- ── 9c-2. QR enumeration ────────────────────────────────────────────────────
-- get_public_qr_payload is a PUBLIC contract (Stage G2) whose confidentiality
-- boundary is possession of the public_id — it is deliberately NOT changed
-- here. What is closed is the ENUMERATION that hands a manager every public_id
-- and target id in the sector, which is what converts a public-by-design
-- surface into a sector-wide stock read.
DROP POLICY qrt_select_org ON public.qr_targets;
CREATE POLICY qrt_select_org ON public.qr_targets
  FOR SELECT TO authenticated
  USING (
    (
      phoenix_my_role() = 'super_admin'
      OR organization_id = phoenix_my_org()
    )
    AND (
      phoenix_my_role() <> 'health_center_manager'
      OR (target_type = 'distribution_point'
          AND phoenix_profile_has_point_assignment(auth.uid(), target_id))
      OR (target_type = 'warehouse'
          AND phoenix_profile_has_warehouse_assignment(auth.uid(), target_id))
    )
  );

DROP POLICY qrtk_select_org ON public.qr_tokens;
CREATE POLICY qrtk_select_org ON public.qr_tokens
  FOR SELECT TO authenticated
  USING (
    (
      phoenix_my_role() = 'super_admin'
      OR organization_id = phoenix_my_org()
    )
    AND (
      phoenix_my_role() <> 'health_center_manager'
      -- A token is readable exactly when its target is.
      OR EXISTS (
        SELECT 1 FROM public.qr_targets t
        WHERE t.id = qr_tokens.qr_target_id
          AND ((t.target_type = 'distribution_point'
                AND phoenix_profile_has_point_assignment(auth.uid(), t.target_id))
            OR (t.target_type = 'warehouse'
                AND phoenix_profile_has_warehouse_assignment(auth.uid(), t.target_id)))
      )
    )
  );

-- ── 9c-3. Routing tables — the id oracles ───────────────────────────────────
-- BOTH endpoints must be visible. Seeing one end of a route discloses the id at
-- the other, which is exactly the enumeration being closed.
DROP POLICY outlet_replenishment_routes_select_scoped ON public.outlet_replenishment_routes;
CREATE POLICY outlet_replenishment_routes_select_scoped ON public.outlet_replenishment_routes
  FOR SELECT TO authenticated
  USING (
    (
      organization_id = phoenix_my_org()
      OR phoenix_my_role() = 'super_admin'
    )
    AND (
      phoenix_my_role() <> 'health_center_manager'
      OR (phoenix_profile_has_point_assignment(auth.uid(), source_point_id)
          AND phoenix_profile_has_point_assignment(auth.uid(), destination_point_id))
    )
  );

-- Migration 181 makes same-sector supply ROUTE-FREE (Branch B) and 182's own
-- VERIFY asserts no warehouse_supply_route exists for a health sector, so for
-- this role the narrowed predicate is over a provably empty set. It is written
-- anyway so the invariant does not depend on that emptiness holding forever.
DROP POLICY warehouse_supply_routes_select_scoped ON public.warehouse_supply_routes;
CREATE POLICY warehouse_supply_routes_select_scoped ON public.warehouse_supply_routes
  FOR SELECT TO authenticated
  USING (
    (
      EXISTS (
        SELECT 1 FROM public.warehouses w
        WHERE w.id = ANY (ARRAY[warehouse_supply_routes.source_warehouse_id,
                                warehouse_supply_routes.target_warehouse_id])
          AND w.organization_id = phoenix_my_org()
      )
      OR phoenix_my_role() = 'super_admin'
    )
    AND (
      phoenix_my_role() <> 'health_center_manager'
      OR (phoenix_profile_has_warehouse_assignment(auth.uid(), source_warehouse_id)
          AND phoenix_profile_has_warehouse_assignment(auth.uid(), target_warehouse_id))
    )
  );

-- ── 9c-4. Stocktakes — counted quantities per warehouse/outlet ──────────────
DROP POLICY stocktakes_select_scoped ON public.stocktakes;
CREATE POLICY stocktakes_select_scoped ON public.stocktakes
  FOR SELECT TO authenticated
  USING (
    (
      phoenix_my_role() = 'super_admin'
      OR organization_id = phoenix_my_org()
    )
    AND (
      phoenix_my_role() <> 'health_center_manager'
      OR (scope_kind = 'warehouse'
          AND phoenix_profile_has_warehouse_assignment(auth.uid(), scope_id))
      OR (scope_kind = 'outlet'
          AND phoenix_profile_has_point_assignment(auth.uid(), scope_id))
    )
  );

-- The line policy already delegates to its parent stocktake, so narrowing the
-- parent narrows it — but it reads stocktakes with its OWN predicate rather
-- than through RLS, so the delegation is restated explicitly.
DROP POLICY stocktake_count_lines_select_scoped ON public.stocktake_count_lines;
CREATE POLICY stocktake_count_lines_select_scoped ON public.stocktake_count_lines
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.stocktakes s
      WHERE s.id = stocktake_count_lines.stocktake_id
        AND (
          phoenix_my_role() = 'super_admin'
          OR s.organization_id = phoenix_my_org()
        )
        AND (
          phoenix_my_role() <> 'health_center_manager'
          OR (s.scope_kind = 'warehouse'
              AND phoenix_profile_has_warehouse_assignment(auth.uid(), s.scope_id))
          OR (s.scope_kind = 'outlet'
              AND phoenix_profile_has_point_assignment(auth.uid(), s.scope_id))
        )
    )
  );

-- ── 9c-5. The SECURITY DEFINER read models ─────────────────────────────────
-- Forward-replaced, generated from the live definitions so everything they
-- already prove stays byte-identical. Exactly ONE statement is added to each:
-- a facility-scope refusal for this role, placed immediately after the existing
-- organization gate and returning the SAME empty result, so an off-facility
-- outlet is indistinguishable from a nonexistent one.
--
-- Migrations 179 and 083 are NOT edited; this is a forward replacement.
CREATE OR REPLACE FUNCTION public.phoenix_outlet_availability_read_model(p_distribution_point_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_role text;
  v_point_org uuid;
  v_rows jsonb;
  v_empty jsonb := jsonb_build_object(
    'ok', true, 'scope', 'distribution_point', 'distribution_point_id', NULL,
    'source', 'canonical_outlet_stock', 'rows', '[]'::jsonb
  );
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE='28000'; END IF;
  SELECT p.organization_id,p.role INTO v_org,v_role FROM public.profiles p WHERE p.id=v_actor AND p.status='active';
  IF NOT FOUND OR p_distribution_point_id IS NULL THEN RETURN v_empty; END IF;
  SELECT d.organization_id INTO v_point_org FROM public.distribution_points d WHERE d.id=p_distribution_point_id;
  IF NOT FOUND OR NOT (v_role='super_admin' OR (v_org IS NOT NULL AND v_org=v_point_org)) THEN RETURN v_empty; END IF;
  -- R1.1-U: SECURITY DEFINER bypasses RLS, so the organization test above is the
  -- ONLY boundary this read model has. For a FACILITY-SCOPED role organization
  -- membership is not a boundary at all: without this line a health-centre
  -- manager reads any outlet in the sector, defeating both
  -- outlet_stock_select_scoped and Migration 182's dp_read_perm narrowing.
  IF v_role = 'health_center_manager'
     AND NOT public.phoenix_profile_has_point_assignment(v_actor, p_distribution_point_id) THEN
    RETURN v_empty;
  END IF;

  WITH canonical AS (
    -- Physical identity is material_identity_key (Migration 150, GENERATED
    -- ALWAYS), NOT a re-derivation from raw columns. unit, central_item_id,
    -- scientific_name, national_code, concentration and dosage_form are all
    -- COMPONENTS of that key, so each is constant inside a group and min() is
    -- an exact representative — the same technique Migration 177 uses. The lot
    -- dimensions below are exactly the ones Migration 176 already grouped on;
    -- supply_type and purchase_origin stay aggregated-over, as before.
    SELECT s.organization_id,s.distribution_point_id,
      s.material_identity_key,
      min(s.scientific_name) AS scientific_name,
      COALESCE(min(s.concentration),'') AS concentration_key,
      COALESCE(min(s.dosage_form),'') AS dosage_form_key,
      COALESCE(min(s.national_code),'') AS national_code_key,
      COALESCE(s.batch_number,'') AS batch_number_key,
      COALESCE(s.expiry_date,DATE '0001-01-01') AS expiry_date_key,
      COALESCE(s.internal_batch_reference,'') AS internal_batch_reference_key,
      -- Migration-150 normalized material components. Each is CONSTANT inside
      -- the group (they are the very components material_identity_key is built
      -- from), so applying the helper to the min() representative yields the
      -- group's shared value exactly. Used only to pair catalogue metadata.
      public._phoenix_material_identity_component_v1(min(s.scientific_name)) AS scientific_name_norm,
      public._phoenix_material_identity_component_v1(min(s.concentration))   AS concentration_norm,
      public._phoenix_material_identity_component_v1(min(s.dosage_form))     AS dosage_form_norm,
      public._phoenix_material_identity_component_v1(min(s.national_code))   AS national_code_norm,
      -- The physical row unit. Constant within the group because it is part of
      -- the identity; never a catalogue value.
      min(s.unit) AS unit,
      MAX(s.trade_name) AS trade_name,MAX(s.unit_price) AS unit_price,MAX(s.updated_at) AS updated_at,
      SUM(s.on_hand_quantity)::integer AS on_hand_quantity,
      SUM(s.available_quantity)::integer AS available_quantity,
      -- LOSSLESS canonical row identity — see this file's ENCODING header. Every
      -- element below is a GROUP BY key, so this is the group's own identity,
      -- and it is also what the catalogue match keys on further down.
      'stock:v1:'||encode(convert_to(jsonb_build_array(
        p_distribution_point_id::text,
        s.material_identity_key,
        COALESCE(s.batch_number,''),
        COALESCE(s.expiry_date,DATE '0001-01-01')::text,
        COALESCE(s.internal_batch_reference,''))::text,'UTF8'),'hex') AS row_key
    FROM public.outlet_stock s
    WHERE s.distribution_point_id=p_distribution_point_id
    -- central_item_id is a COMPONENT of material_identity_key, so grouping by
    -- it cannot split a canonical group.
    GROUP BY s.organization_id,s.distribution_point_id,s.material_identity_key,s.central_item_id,
      COALESCE(s.batch_number,''),COALESCE(s.expiry_date,DATE '0001-01-01'),
      COALESCE(s.internal_batch_reference,'')
  ), catalogue AS (
    SELECT ia.*,
      COALESCE(ia.concentration,'') AS concentration_key,
      COALESCE(ia.dosage_form,'') AS dosage_form_key,
      COALESCE(ia.national_code,'') AS national_code_key,
      COALESCE(ia.batch_number,'') AS batch_number_key,
      COALESCE(ia.expiry_date,DATE '0001-01-01') AS expiry_date_key,
      COALESCE(ia.internal_batch_reference,'') AS internal_batch_reference_key,
      public._phoenix_material_identity_component_v1(ia.scientific_name) AS scientific_name_norm,
      public._phoenix_material_identity_component_v1(ia.concentration)   AS concentration_norm,
      public._phoenix_material_identity_component_v1(ia.dosage_form)     AS dosage_form_norm,
      public._phoenix_material_identity_component_v1(ia.national_code)   AS national_code_norm
    FROM public.item_availability ia WHERE ia.distribution_point_id=p_distribution_point_id
  ), raw_match AS (
    -- STEP 1 — exact RAW pairing, byte-for-byte what Migration 176 did. At most
    -- ONE per canonical group (see this file's CATALOGUE METADATA MATCHING
    -- header for why the unique index makes that a proof, not a hope), so it
    -- can never multiply a physical row.
    SELECT c.row_key,ia.id AS catalogue_id
    FROM canonical c JOIN catalogue ia
      ON ia.scientific_name=c.scientific_name
     AND ia.concentration_key=c.concentration_key
     AND ia.dosage_form_key=c.dosage_form_key
     AND ia.national_code_key=c.national_code_key
     AND ia.batch_number_key=c.batch_number_key
     AND ia.expiry_date_key=c.expiry_date_key
     AND ia.internal_batch_reference_key=c.internal_batch_reference_key
  ), norm_match AS (
    -- STEP 2 — Migration-150-normalized pairing for the MATERIAL components
    -- only; the lot dimensions stay exact. HAVING count(*)=1 is the fail-safe:
    -- item_availability's uniqueness is RAW, so two case-variant catalogue rows
    -- can coexist at one point, and an ambiguous group takes NO metadata rather
    -- than an arbitrary one. array_agg()[1] (not min(uuid), which is not
    -- available on every supported server) reads the single surviving row.
    SELECT c.row_key,(array_agg(ia.id))[1] AS catalogue_id
    FROM canonical c JOIN catalogue ia
      ON ia.scientific_name_norm=c.scientific_name_norm
     AND ia.concentration_norm=c.concentration_norm
     AND ia.dosage_form_norm=c.dosage_form_norm
     AND ia.national_code_norm=c.national_code_norm
     AND ia.batch_number_key=c.batch_number_key
     AND ia.expiry_date_key=c.expiry_date_key
     AND ia.internal_batch_reference_key=c.internal_batch_reference_key
    GROUP BY c.row_key
    HAVING count(*)=1
  ), selected AS (
    -- Exactly one catalogue candidate per canonical group, or none. RAW wins,
    -- so a pairing that already worked keeps working unchanged.
    SELECT c.*,COALESCE(rm.catalogue_id,nm.catalogue_id) AS selected_catalogue_id
    FROM canonical c
    LEFT JOIN raw_match  rm ON rm.row_key=c.row_key
    LEFT JOIN norm_match nm ON nm.row_key=c.row_key
  ), joined AS (
    SELECT c.organization_id AS canonical_org_id,c.distribution_point_id AS canonical_point_id,
      c.material_identity_key AS canonical_material_identity_key,
      c.scientific_name AS canonical_scientific_name,c.concentration_key AS canonical_concentration_key,
      c.dosage_form_key AS canonical_dosage_form_key,c.national_code_key AS canonical_national_code_key,
      c.batch_number_key AS canonical_batch_number_key,c.expiry_date_key AS canonical_expiry_date_key,
      c.internal_batch_reference_key AS canonical_internal_ref_key,c.trade_name AS canonical_trade_name,
      c.row_key AS canonical_row_key,
      c.unit AS canonical_unit,
      c.unit_price AS canonical_unit_price,c.updated_at AS canonical_updated_at,c.on_hand_quantity,c.available_quantity,
      ia.id AS catalogue_id,ia.local_item_id,ia.organization_id AS catalogue_org_id,ia.port_name,
      ia.scientific_name AS catalogue_scientific_name,ia.trade_name AS catalogue_trade_name,
      ia.concentration AS catalogue_concentration,ia.dosage_form AS catalogue_dosage_form,
      ia.national_code AS catalogue_national_code,ia.batch_number AS catalogue_batch_number,
      ia.expiry_date AS catalogue_expiry_date,ia.internal_batch_reference AS catalogue_internal_ref,
      ia.notes,ia.supply_type,ia.price,ia.removed_at,ia.updated_at AS catalogue_updated_at
    -- The pairing decision was already made, deterministically and at most
    -- once, in `selected`. FULL OUTER preserves both open ends exactly as
    -- before: a canonical group with no catalogue candidate keeps its physical
    -- row, and a catalogue row NO group selected still surfaces on its own —
    -- including both members of an ambiguous pair, so nothing is dropped. One
    -- catalogue row may legitimately be selected by SEVERAL canonical groups
    -- (5 box and 3 strip share one unit-less catalogue row); that fans the
    -- catalogue metadata out to each physical row, which is correct, and is not
    -- row multiplication because each physical row still appears once.
    FROM selected c
    FULL OUTER JOIN catalogue ia ON ia.id=c.selected_catalogue_id
  ), shaped AS (
    SELECT j.catalogue_id AS id,j.catalogue_id AS catalogue_item_availability_id,
      -- Stock-backed rows are identified by their PHYSICAL identity, so two
      -- unit-distinct materials sharing one catalogue row stay distinct. Only a
      -- row with no physical stock at all falls back to the catalogue form. The
      -- value is the LOSSLESS encoding computed in `canonical` — carried
      -- through rather than recomputed, so the string the client keys on and
      -- the string the catalogue match keys on cannot drift apart.
      CASE WHEN j.canonical_row_key IS NOT NULL
        THEN j.canonical_row_key
        ELSE 'catalogue:'||j.catalogue_id::text END AS row_key,
      j.local_item_id,p_distribution_point_id AS distribution_point_id,
      COALESCE(j.canonical_org_id,j.catalogue_org_id) AS organization_id,
      COALESCE(j.available_quantity,0) AS quantity,
      -- The physical unit of THIS row's canonical identity. '' collapses to
      -- NULL exactly as Migration 177 projects its public row unit. There is no
      -- central_items.unit fallback in either direction: a catalogue unit
      -- describes the local item, not this physical stock identity.
      NULLIF(j.canonical_unit,'') AS unit,
      public.phoenix_derive_outlet_availability_condition(COALESCE(j.available_quantity,0),COALESCE(j.catalogue_expiry_date,NULLIF(j.canonical_expiry_date_key,DATE '0001-01-01'))) AS condition,
      COALESCE(j.catalogue_batch_number,NULLIF(j.canonical_batch_number_key,'')) AS batch_number,
      COALESCE(j.catalogue_national_code,NULLIF(j.canonical_national_code_key,'')) AS national_code,
      COALESCE(j.catalogue_expiry_date,NULLIF(j.canonical_expiry_date_key,DATE '0001-01-01')) AS expiry_date,
      j.notes,COALESCE(j.catalogue_updated_at,j.canonical_updated_at) AS updated_at,j.port_name,j.supply_type,j.removed_at,
      COALESCE(j.canonical_scientific_name,j.catalogue_scientific_name) AS scientific_name,
      COALESCE(j.catalogue_trade_name,j.canonical_trade_name) AS trade_name,
      COALESCE(j.catalogue_dosage_form,NULLIF(j.canonical_dosage_form_key,'')) AS dosage_form,
      COALESCE(j.catalogue_concentration,NULLIF(j.canonical_concentration_key,'')) AS concentration,
      COALESCE(j.price,j.canonical_unit_price) AS price,
      COALESCE(j.catalogue_internal_ref,NULLIF(j.canonical_internal_ref_key,'')) AS internal_batch_reference,
      COALESCE(j.on_hand_quantity,0) AS canonical_on_hand_quantity,
      COALESCE(j.available_quantity,0) AS canonical_available_quantity,
      CASE WHEN public.phoenix_derive_outlet_availability_condition(COALESCE(j.available_quantity,0),COALESCE(j.catalogue_expiry_date,NULLIF(j.canonical_expiry_date_key,DATE '0001-01-01'))) IN ('expired','missing') THEN 0 ELSE COALESCE(j.available_quantity,0) END AS canonical_usable_quantity,
      CASE WHEN li.id IS NULL THEN NULL ELSE jsonb_build_object('id',li.id,'local_code',li.local_code,
        'central_items',CASE WHEN ci.id IS NULL THEN NULL ELSE jsonb_build_object('id',ci.id,'name',ci.name,'name_ar',ci.name_ar,'unit',ci.unit,'barcode',ci.barcode) END) END AS local_items
    FROM joined j
    LEFT JOIN public.local_items li ON li.id=j.local_item_id
    LEFT JOIN public.central_items ci ON ci.id=li.central_item_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', s.id,
    'catalogue_item_availability_id', s.catalogue_item_availability_id,
    'row_key', s.row_key,
    'local_item_id', s.local_item_id,
    'distribution_point_id', s.distribution_point_id,
    'organization_id', s.organization_id,
    'quantity', s.quantity,
    'unit', s.unit,
    'condition', s.condition,
    'batch_number', s.batch_number,
    'national_code', s.national_code,
    'expiry_date', s.expiry_date,
    'notes', s.notes,
    'updated_at', s.updated_at,
    'port_name', s.port_name,
    'supply_type', s.supply_type,
    'removed_at', s.removed_at,
    'scientific_name', s.scientific_name,
    'trade_name', s.trade_name,
    'dosage_form', s.dosage_form,
    'concentration', s.concentration,
    'price', s.price,
    'internal_batch_reference', s.internal_batch_reference,
    'canonical_on_hand_quantity', s.canonical_on_hand_quantity,
    'canonical_available_quantity', s.canonical_available_quantity,
    'canonical_usable_quantity', s.canonical_usable_quantity,
    'local_items', s.local_items
  ) ORDER BY s.updated_at DESC NULLS LAST,s.row_key),'[]'::jsonb)
  INTO v_rows FROM shaped s;

  RETURN jsonb_build_object('ok',true,'scope','distribution_point','distribution_point_id',p_distribution_point_id,'source','canonical_outlet_stock','rows',v_rows);
END;
$function$;

CREATE OR REPLACE FUNCTION public.phoenix_available_stock(p_distribution_point_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_role  text;
  v_dp_org uuid;
  v_items jsonb;
  v_empty jsonb := jsonb_build_object(
    'ok', true, 'scope', 'distribution_point',
    'distribution_point_id', NULL, 'source', 'canonical_projection',
    'items', '[]'::jsonb);
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT p.organization_id, p.role INTO v_org, v_role
    FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RETURN v_empty;  -- same empty shape: no active profile
  END IF;

  IF p_distribution_point_id IS NULL THEN
    RETURN v_empty;
  END IF;

  SELECT d.organization_id INTO v_dp_org
    FROM public.distribution_points d WHERE d.id = p_distribution_point_id;

  -- Forbidden and nonexistent are INDISTINGUISHABLE: both fall through to the
  -- same empty result. The RPC never reveals that a point exists but is off-scope.
  IF NOT FOUND
     OR NOT (v_role = 'super_admin' OR (v_org IS NOT NULL AND v_dp_org = v_org)) THEN
    RETURN v_empty;
  END IF;

  -- R1.1-U: SECURITY DEFINER bypasses RLS, so the organization test above is the
  -- ONLY boundary this function has. Organization membership is not a boundary
  -- for a FACILITY-SCOPED role, and the same indistinguishability rule applies:
  -- an off-facility point returns the identical empty result as a nonexistent
  -- one, never disclosing that it exists.
  IF v_role = 'health_center_manager'
     AND NOT public.phoenix_profile_has_point_assignment(v_actor, p_distribution_point_id) THEN
    RETURN v_empty;
  END IF;

  -- Aggregate outlet_stock by BATCH-LEVEL identity (the granularity
  -- item_availability represents). Each row is one canonical lot; summing across
  -- rows sharing an 8-part identity cannot double count because outlet_stock's
  -- own unique index makes that identity singular. usable_quantity zeroes out
  -- anything the audited policy classifies expired or missing.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'scientific_name', t.scientific_name,
           'trade_name',      t.trade_name,
           'concentration',   t.concentration,
           'dosage_form',     t.dosage_form,
           'national_code',   t.national_code,
           'batch_number',    t.batch_number,
           'expiry_date',     t.expiry_date,
           'on_hand_quantity', t.on_hand_quantity,
           'available_quantity', t.available_quantity,
           'usable_quantity', CASE WHEN t.condition IN ('expired','missing') THEN 0
                                   ELSE t.available_quantity END,
           'condition',       t.condition,
           'is_usable',       t.condition NOT IN ('expired','missing')
         ) ORDER BY t.scientific_name, t.expiry_date NULLS LAST), '[]'::jsonb)
    INTO v_items
  FROM (
    SELECT s.scientific_name, s.trade_name, s.concentration, s.dosage_form,
           s.national_code, s.batch_number, s.expiry_date,
           sum(s.on_hand_quantity)   AS on_hand_quantity,
           sum(s.available_quantity) AS available_quantity,
           public.phoenix_derive_outlet_availability_condition(
             sum(s.available_quantity)::integer, s.expiry_date) AS condition
      FROM public.outlet_stock s
     WHERE s.distribution_point_id = p_distribution_point_id
     GROUP BY s.scientific_name, s.trade_name, s.concentration, s.dosage_form,
              s.national_code, s.batch_number, s.expiry_date,
              s.internal_batch_reference
  ) t;

  RETURN jsonb_build_object(
    'ok', true,
    'scope', 'distribution_point',
    'distribution_point_id', p_distribution_point_id,
    'source', 'canonical_projection',
    'items', v_items
  );
END;
$function$;

-- ============================================================================
-- 9d. FAIL CLOSED where facility scope is NOT EXPRESSIBLE
-- ============================================================================
-- Section 9c closed every org-only surface that CAN be resolved to a facility,
-- because it carries a warehouse, outlet or facility column. An independent
-- adversarial review of that work found a second group sharing the identical
-- root cause and reachable in exactly the same way — and the reason 9c missed
-- them is worth recording, because it is the mistake to avoid next time: 9c
-- enumerated the surfaces reachable THROUGH THE SIX GRANTED PERMISSION KEYS,
-- while these consult NO permission key at all. Organization membership alone
-- is the whole gate, which is precisely the argument 9c already applied to
-- item_availability and simply did not carry through.
--
-- These tables and functions cannot be narrowed the way 9c narrows: they carry
-- ONLY organization_id. phoenix_movement_events and phoenix_notifications have
-- no warehouse, outlet or facility column at all — their locations are free
-- text (source_label / destination_label) and a polymorphic reference_id — so
-- there is no facility to test against. Giving them one is a data-model change,
-- which is not authorized here and would reach far beyond safe activation.
--
-- The rule this substage applies, from its own brief, is therefore: a surface
-- that cannot be PROVEN facility-safe is DENIED to the role. Not filtered in
-- the client, not partially shown — denied at the database, so the refusal
-- holds for a direct PostgREST query exactly as it does for the UI.
--
-- The cost is honest and is recorded rather than hidden: a health-centre
-- manager receives no movement timeline and no notifications. U-C owns making
-- these facility-aware (each needs a real scope column or a scope-aware read
-- model); until then the role is safe rather than convenient.
--
-- The one exception is phoenix_stock_correction_requests, which DOES carry
-- outlet_stock_id and therefore resolves to an outlet and to a facility. It is
-- narrowed properly instead of denied.

-- ── 9d-1. Movement events — free-text locations, no scope column ────────────
DROP POLICY phoenix_movement_events_select_scoped ON public.phoenix_movement_events;
CREATE POLICY phoenix_movement_events_select_scoped ON public.phoenix_movement_events
  FOR SELECT TO authenticated
  USING (
    (
      phoenix_my_role() = 'super_admin'
      OR organization_id = (SELECT p.organization_id FROM public.profiles p WHERE p.id = auth.uid())
    )
    -- No facility can be derived from this row, so the role gets nothing.
    AND phoenix_my_role() <> 'health_center_manager'
  );

-- ── 9d-2. Notifications — rendered in the top bar for EVERY signed-in user ──
-- The severity here is reachability: this needs no crafted request at all, the
-- shell renders the whole sector's custody feed at login.
DROP POLICY phoenix_notifications_select_scoped ON public.phoenix_notifications;
CREATE POLICY phoenix_notifications_select_scoped ON public.phoenix_notifications
  FOR SELECT TO authenticated
  USING (
    (
      phoenix_my_role() = 'super_admin'
      OR organization_id = (SELECT p.organization_id FROM public.profiles p WHERE p.id = auth.uid())
    )
    AND phoenix_my_role() <> 'health_center_manager'
  );

-- ── 9d-3. Correction requests — one IS resolvable, three are not ────────────
-- outlet_stock_id resolves to a distribution point and therefore to a facility,
-- so this one is narrowed rather than denied.
DROP POLICY phoenix_stock_correction_requests_select_scoped ON public.phoenix_stock_correction_requests;
CREATE POLICY phoenix_stock_correction_requests_select_scoped ON public.phoenix_stock_correction_requests
  FOR SELECT TO authenticated
  USING (
    (
      phoenix_my_role() = 'super_admin'
      OR organization_id = (SELECT p.organization_id FROM public.profiles p WHERE p.id = auth.uid())
    )
    AND (
      phoenix_my_role() <> 'health_center_manager'
      OR EXISTS (
        SELECT 1 FROM public.outlet_stock s
        WHERE s.id = phoenix_stock_correction_requests.outlet_stock_id
          AND phoenix_profile_has_point_assignment(auth.uid(), s.distribution_point_id)
      )
    )
  );

DROP POLICY phoenix_warehouse_correction_requests_select_scoped ON public.phoenix_warehouse_correction_requests;
CREATE POLICY phoenix_warehouse_correction_requests_select_scoped ON public.phoenix_warehouse_correction_requests
  FOR SELECT TO authenticated
  USING (
    (
      phoenix_my_role() = 'super_admin'
      OR organization_id = (SELECT p.organization_id FROM public.profiles p WHERE p.id = auth.uid())
    )
    AND phoenix_my_role() <> 'health_center_manager'
  );

DROP POLICY phoenix_dispatch_line_requests_select_scoped ON public.phoenix_dispatch_line_requests;
CREATE POLICY phoenix_dispatch_line_requests_select_scoped ON public.phoenix_dispatch_line_requests
  FOR SELECT TO authenticated
  USING (
    (
      phoenix_my_role() = 'super_admin'
      OR organization_id = (SELECT p.organization_id FROM public.profiles p WHERE p.id = auth.uid())
    )
    AND phoenix_my_role() <> 'health_center_manager'
  );

DROP POLICY phoenix_outlet_return_line_requests_select_scoped ON public.phoenix_outlet_return_line_requests;
CREATE POLICY phoenix_outlet_return_line_requests_select_scoped ON public.phoenix_outlet_return_line_requests
  FOR SELECT TO authenticated
  USING (
    (
      phoenix_my_role() = 'super_admin'
      OR organization_id = (SELECT p.organization_id FROM public.profiles p WHERE p.id = auth.uid())
    )
    AND phoenix_my_role() <> 'health_center_manager'
  );

DROP POLICY phoenix_outlet_return_exception_resolutions_select_scoped ON public.phoenix_outlet_return_exception_resolutions;
CREATE POLICY phoenix_outlet_return_exception_resolutions_select_scoped ON public.phoenix_outlet_return_exception_resolutions
  FOR SELECT TO authenticated
  USING (
    (
      phoenix_my_role() = 'super_admin'
      OR organization_id = (SELECT p.organization_id FROM public.profiles p WHERE p.id = auth.uid())
    )
    AND phoenix_my_role() <> 'health_center_manager'
  );

-- ── 9d-4. SELF-SERVICE ORGANIZATION CHANGE ─────────────────────────────────
-- profiles_update_own (002) pins `role` so a profile cannot self-promote, but
-- it does NOT pin organization_id, and no column-level REVOKE exists. The 182
-- guard as written only required the NEW organization to be an active health
-- sector — it never required the organization to be UNCHANGED, so it waved a
-- self-service move between sectors straight through for this very role.
--
-- The move is lateral rather than escalating (the attacker's own facility
-- assignments fail the three-way organization agreement in
-- phoenix_profile_has_facility_assignment and it loses its centres), and the
-- hole is pre-existing in 002 rather than introduced here. It is closed for
-- THIS ROLE anyway, at the narrowest point that works: an active
-- health_center_manager may not change its own organization. 002's policy is
-- deliberately left alone, so no other role's behaviour moves.
CREATE OR REPLACE FUNCTION public._phoenix_profile_role_organization_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_kind   text;
  v_class  text;
  v_status text;
  v_scopes integer;
BEGIN
  -- ── LEAVING the role: facility scope must be closed FIRST ─────────────────
  -- Every path that rewrites profiles.role passes through here, including
  -- phoenix_recycle_apply (which assigns role = p_new_role directly), so this is
  -- a database invariant rather than a patch applied to one RPC.
  --
  -- The read-time helpers already re-prove `p.role = 'health_center_manager'`,
  -- so an orphaned assignment authorizes nothing the instant the role changes.
  -- The reason to refuse anyway is the ROUND TRIP: recycle out, recycle back in,
  -- and the identity would silently regain centres nobody re-authorized. Closing
  -- the scopes explicitly — audited, with a mandatory reason, through
  -- phoenix_revoke_profile_scope — is the only way that trail stays honest.
  --
  -- No history is deleted to satisfy this: revoked rows are exactly what the
  -- operator is being asked to produce.
  IF TG_OP = 'UPDATE'
     AND OLD.role = 'health_center_manager'
     AND NEW.role IS DISTINCT FROM OLD.role THEN
    SELECT count(*) INTO v_scopes
    FROM public.profile_scope_assignments a
    WHERE a.profile_id = NEW.id AND a.scope_type = 'facility' AND a.is_active;

    IF v_scopes > 0 THEN
      RAISE EXCEPTION 'health_center_manager_role_change_blocked_by_active_facility_scope'
        USING ERRCODE = '23514',
        DETAIL = format(
          '%s active facility assignment(s) remain; revoke them through phoenix_revoke_profile_scope, with a reason, before changing this role',
          v_scopes);
    END IF;
  END IF;

  -- R1.1-U (U-B): an active manager may not be moved — or move itself, through
  -- 002's profiles_update_own — between organizations. Its facilities belong to
  -- one sector, so an organization change silently detaches every scope it
  -- holds and re-points phoenix_my_org() at another sector's org-wide surfaces.
  IF TG_OP = 'UPDATE'
     AND OLD.role = 'health_center_manager'
     AND NEW.role = 'health_center_manager'
     AND NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'health_center_manager_organization_change_forbidden'
      USING ERRCODE = '42501',
      DETAIL = 'a facility-scoped profile is bound to its health sector; move it by revoking its facility scope and changing the role first';
  END IF;

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

-- ── 9d-5. The three remaining SECURITY DEFINER readers ────────────────
-- Same argument as 9c-5, applied to the readers that adversarial review
-- found afterwards. Forward-replaced from the live definitions; migrations
-- 094, 136 and 139 are NOT edited.
CREATE OR REPLACE FUNCTION public.phoenix_movement_timeline(p_trace_id uuid, p_limit integer DEFAULT 50, p_after_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_after_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor  uuid := auth.uid();
  v_org    uuid;
  v_role   text;
  v_limit  integer;
  v_events jsonb;
  -- Unchanged from 081: unauthorized and nonexistent traces are
  -- INDISTINGUISHABLE — both return this exact shape, so the RPC can never
  -- be used as an existence oracle.
  v_empty  jsonb := jsonb_build_object(
    'ok', true,
    'events', '[]'::jsonb,
    'complete', false,
    'completeness_note',
      'A complete retrospective history cannot be reconstructed from the '
      'current schema. Events are reported with their provenance: '
      'movement_row (an append-only fact), derived_from_column (proven by a '
      'non-NULL timestamp+actor pair on a corridor header), or event_ledger '
      '(recorded by phoenix_movement_events). Status transitions that left no '
      'column behind are not retained and are therefore absent, never inferred.',
    'next_cursor', NULL
  );
BEGIN
  IF v_actor IS NULL THEN
    RETURN v_empty;
  END IF;

  v_limit := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);

  SELECT p.organization_id, p.role INTO v_org, v_role
    FROM public.profiles p
   WHERE p.id = v_actor AND p.status = 'active';

  IF NOT FOUND THEN
    RETURN v_empty;
  END IF;

  IF p_trace_id IS NULL THEN
    RETURN v_empty;
  END IF;

  WITH
  movement_events AS (
    SELECT m.id                            AS event_id,
           'warehouse_stock_movement'      AS event_type,
           -- 124's contract field; falls back to created_at defensively even
           -- though 124 backfilled and NOT NULL-ed it.
           COALESCE(m.occurred_at, m.created_at) AS occurred_at,
           m.organization_id,
           m.actor_id, m.actor_role, m.actor_name,
           m.movement_type                 AS status_after,
           m.scientific_name_snapshot      AS material_label,
           m.batch_number_snapshot         AS batch_label,
           m.on_hand_delta                 AS quantity_delta,
           m.reference_type, m.reference_id,
           m.source_document_number        AS reference_label,
           'movement_row'                  AS provenance,
           m.reason_code                   AS reason_code,
           m.on_hand_before                AS quantity_before,
           m.on_hand_after                 AS quantity_after,
           m.correlation_id, m.causation_id,
           false                           AS has_dispense_context
      FROM public.warehouse_stock_movements m
     WHERE m.reference_id = p_trace_id OR m.id = p_trace_id
    UNION ALL
    SELECT m.id, 'outlet_stock_movement', COALESCE(m.occurred_at, m.created_at), m.organization_id,
           m.actor_id, m.actor_role, m.actor_name, m.movement_type,
           m.scientific_name_snapshot, m.batch_number_snapshot, m.on_hand_delta,
           m.reference_type, m.reference_id, m.source_document_number, 'movement_row',
           m.reason_code, m.on_hand_before, m.on_hand_after,
           m.correlation_id, m.causation_id,
           EXISTS (SELECT 1 FROM public.phoenix_movement_dispense_context c WHERE c.movement_id = m.id)
      FROM public.outlet_stock_movements m
     WHERE m.reference_id = p_trace_id OR m.id = p_trace_id
    UNION ALL
    SELECT m.id, 'quarantine_movement', COALESCE(m.occurred_at, m.created_at), m.organization_id,
           m.actor_id, m.actor_role, m.actor_name, m.movement_type,
           m.scientific_name_snapshot, m.batch_number_snapshot, m.quantity_delta,
           m.reference_type, m.reference_id, m.source_document_number, 'movement_row',
           m.reason_code, m.quantity_before, m.quantity_after,
           m.correlation_id, m.causation_id,
           false
      FROM public.warehouse_quarantine_stock_movements m
     WHERE m.reference_id = p_trace_id OR m.id = p_trace_id
    UNION ALL
    -- item_availability_movements is the LEGACY table (033) whose sole writer
    -- has zero production call sites. Kept in the union unchanged for
    -- backward compatibility with any historical row, but it never carried
    -- the contract fields, so those are honestly NULL rather than invented.
    SELECT m.id, 'availability_movement', m.created_at, m.organization_id,
           m.created_by, m.actor_role_snapshot, m.actor_name_snapshot, m.movement_type,
           m.scientific_name, NULL, m.quantity_delta,
           NULL, m.dispatch_line_id, NULL, 'movement_row',
           NULL::text, m.quantity_before, m.quantity_after,
           NULL::uuid, NULL::uuid,
           false
      FROM public.item_availability_movements m
     WHERE m.dispatch_line_id = p_trace_id OR m.id = p_trace_id
  ),
  derived_events AS (
    SELECT r.id AS event_id, 'return_requested' AS event_type, r.requested_at AS occurred_at,
           r.source_organization_id AS organization_id,
           r.requested_by AS actor_id, NULL::text, NULL::text, r.status,
           NULL::text, NULL::text, NULL::integer,
           'outlet_return_request'::text, r.id, r.return_number, 'derived_from_column'::text,
           NULL::text, NULL::integer, NULL::integer, NULL::uuid, NULL::uuid, false
      FROM public.outlet_return_requests r
     WHERE r.id = p_trace_id AND r.requested_at IS NOT NULL
    UNION ALL
    SELECT r.id, 'return_reviewed', r.reviewed_at, r.source_organization_id,
           r.reviewed_by, NULL, NULL, r.status, NULL, NULL, NULL,
           'outlet_return_request', r.id, r.return_number, 'derived_from_column',
           NULL, NULL, NULL, NULL, NULL, false
      FROM public.outlet_return_requests r
     WHERE r.id = p_trace_id AND r.reviewed_at IS NOT NULL
    UNION ALL
    SELECT r.id, 'return_cancelled', r.cancelled_at, r.source_organization_id,
           r.cancelled_by, NULL, NULL, r.status, NULL, NULL, NULL,
           'outlet_return_request', r.id, r.return_number, 'derived_from_column',
           NULL, NULL, NULL, NULL, NULL, false
      FROM public.outlet_return_requests r
     WHERE r.id = p_trace_id AND r.cancelled_at IS NOT NULL
    UNION ALL
    SELECT s.id, 'return_shipment_sent', s.sent_at, s.source_organization_id,
           s.sent_by, NULL, NULL, s.status, NULL, NULL, NULL,
           'outlet_return_shipment', s.id, s.shipment_number, 'derived_from_column',
           NULL, NULL, NULL, NULL, NULL, false
      FROM public.outlet_return_shipments s
     WHERE s.id = p_trace_id AND s.sent_at IS NOT NULL
    UNION ALL
    SELECT d.id, 'dispatch_sent', d.sent_at, d.organization_id,
           d.sent_by, NULL, NULL, d.status, NULL, NULL, NULL,
           'warehouse_dispatch', d.id, d.dispatch_number, 'derived_from_column',
           NULL, NULL, NULL, NULL, NULL, false
      FROM public.warehouse_dispatches d
     WHERE d.id = p_trace_id AND d.sent_at IS NOT NULL
    UNION ALL
    SELECT d.id, 'dispatch_cancelled', d.cancelled_at, d.organization_id,
           d.cancelled_by, NULL, NULL, d.status, NULL, NULL, NULL,
           'warehouse_dispatch', d.id, d.dispatch_number, 'derived_from_column',
           NULL, NULL, NULL, NULL, NULL, false
      FROM public.warehouse_dispatches d
     WHERE d.id = p_trace_id AND d.cancelled_at IS NOT NULL
  ),
  ledger_events AS (
    SELECT e.id, e.event_type, e.occurred_at, e.organization_id,
           e.actor_id, e.actor_role, e.actor_name, e.status_after,
           e.material_label, e.batch_label, e.quantity_delta,
           e.reference_type, e.reference_id, e.notes, 'event_ledger',
           -- The envelope has no reason_code column (its 123/124 capture
           -- trigger predates 125), so it is honestly NULL here rather than
           -- guessed from the movement row.
           NULL::text, e.quantity_before, e.quantity_after,
           e.correlation_id, e.causation_id, false
      FROM public.phoenix_movement_events e
     WHERE e.trace_id = p_trace_id
  ),
  all_events AS (
    SELECT * FROM movement_events
    UNION ALL SELECT * FROM derived_events
    UNION ALL SELECT * FROM ledger_events
  ),
  scoped AS (
    SELECT * FROM all_events a
     WHERE v_role = 'super_admin'
        -- R1.1-U (U-B): SECURITY DEFINER bypasses RLS, so this organization test
        -- is the ONLY boundary. A facility-scoped role cannot be resolved to a
        -- facility here — a movement event carries free-text location labels and
        -- a polymorphic reference, not a warehouse or outlet id — so it is
        -- DENIED rather than partially served. U-C owns making this scope-aware.
        OR (v_org IS NOT NULL AND a.organization_id = v_org
            AND v_role <> 'health_center_manager')
  ),
  paged AS (
    SELECT * FROM scoped s
     WHERE p_after_at IS NULL
        OR (s.occurred_at, s.event_id) > (p_after_at, p_after_id)
     ORDER BY s.occurred_at ASC, s.event_id ASC
     LIMIT v_limit
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'event_id',       p.event_id,
           'event_type',     p.event_type,
           'occurred_at',    p.occurred_at,
           'actor_id',       p.actor_id,
           'actor_role',     p.actor_role,
           'actor_name',     p.actor_name,
           'status',         p.status_after,
           'material',       p.material_label,
           'batch',          p.batch_label,
           'quantity_delta', p.quantity_delta,
           'reference_type', p.reference_type,
           'reference_id',   p.reference_id,
           'reference',      p.reference_label,
           'provenance',     p.provenance,
           -- ── 139 additive contract fields ──────────────────────────────
           'reason_code',          p.reason_code,
           'quantity_before',      p.quantity_before,
           'quantity_after',       p.quantity_after,
           'correlation_id',       p.correlation_id,
           'causation_id',         p.causation_id,
           'has_dispense_context', p.has_dispense_context
         ) ORDER BY p.occurred_at ASC, p.event_id ASC), '[]'::jsonb)
    INTO v_events
    FROM paged p;

  RETURN jsonb_build_object(
    'ok', true,
    'events', v_events,
    'complete', false,
    'completeness_note', v_empty -> 'completeness_note',
    'next_cursor',
      CASE WHEN jsonb_array_length(v_events) = v_limit
        THEN jsonb_build_object(
               'after_at', v_events -> (v_limit - 1) -> 'occurred_at',
               'after_id', v_events -> (v_limit - 1) -> 'event_id')
        ELSE NULL END
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.phoenix_notifications_list(p_limit integer DEFAULT 30, p_before_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_id uuid DEFAULT NULL::uuid, p_unread_only boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_role  text;
  v_limit integer;
  v_rows  jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  v_limit := LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);

  SELECT p.organization_id, p.role INTO v_org, v_role
    FROM public.profiles p
   WHERE p.id = v_actor AND p.status = 'active';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'notifications', '[]'::jsonb, 'next_cursor', NULL);
  END IF;

  WITH scoped AS (
    SELECT n.*, (r.notification_id IS NOT NULL) AS is_read
      FROM public.phoenix_notifications n
      LEFT JOIN public.phoenix_notification_reads r
        ON r.notification_id = n.id AND r.profile_id = v_actor
     -- R1.1-U (U-B): denied for a facility-scoped role — a notification
     -- carries no scope column, so it cannot be resolved to a facility.
     WHERE (v_role = 'super_admin'
            OR (n.organization_id = v_org AND v_role <> 'health_center_manager'))
       AND (p_before_at IS NULL OR (n.occurred_at, n.id) < (p_before_at, p_before_id))
       AND (NOT p_unread_only OR r.notification_id IS NULL)
     ORDER BY n.occurred_at DESC, n.id DESC
     LIMIT v_limit
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id',              s.id,
           'event_type',      s.event_type,
           'occurred_at',     s.occurred_at,
           'actor_id',        s.actor_id,
           'actor_role',      s.actor_role,
           'actor_name',      s.actor_name,
           'status',          s.status_after,
           'reference_type',  s.reference_type,
           'reference_id',    s.reference_id,
           'reference',       s.reference_label,
           'is_read',         s.is_read
         ) ORDER BY s.occurred_at DESC, s.id DESC), '[]'::jsonb)
    INTO v_rows
    FROM scoped s;

  RETURN jsonb_build_object(
    'ok', true,
    'notifications', v_rows,
    'next_cursor',
      CASE WHEN jsonb_array_length(v_rows) = v_limit
        THEN jsonb_build_object(
               'before_at', v_rows -> (v_limit - 1) -> 'occurred_at',
               'before_id', v_rows -> (v_limit - 1) -> 'id')
        ELSE NULL END
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.phoenix_get_movement_dispense_context(p_movement_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor  uuid := auth.uid();
  v_row    public.phoenix_movement_dispense_context%ROWTYPE;
  v_can_view_sensitive boolean;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_movement_id IS NULL THEN
    RAISE EXCEPTION 'movement_id_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_row FROM public.phoenix_movement_dispense_context WHERE movement_id = p_movement_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'movement_context_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT (
    public.phoenix_my_role() = 'super_admin'
    OR v_row.organization_id = (SELECT p.organization_id FROM public.profiles p WHERE p.id = v_actor)
  ) THEN
    RAISE EXCEPTION 'forbidden_cross_org_access' USING ERRCODE = '42501';
  END IF;

  -- R1.1-U (U-B): SECURITY DEFINER bypasses RLS, so the organization test above
  -- is the ONLY boundary. Reached by id from the movement timeline, this
  -- discloses another centre's dispense context — beneficiary type, references
  -- and free-text notes. The movement id cannot be resolved to a facility here,
  -- so a facility-scoped role is refused with the SAME error as any other
  -- cross-boundary caller, disclosing nothing about whether the row exists.
  IF public.phoenix_my_role() = 'health_center_manager' THEN
    RAISE EXCEPTION 'forbidden_cross_org_access' USING ERRCODE = '42501';
  END IF;

  v_can_view_sensitive := public.phoenix_status_center_authorized(v_row.organization_id, 'movement_context.view_sensitive');

  RETURN jsonb_build_object(
    'id', v_row.id,
    'movement_id', v_row.movement_id,
    'beneficiary_type', v_row.beneficiary_type,
    'patient_identifier', CASE WHEN v_can_view_sensitive THEN v_row.patient_identifier ELSE NULL END,
    'patient_name', CASE WHEN v_can_view_sensitive THEN v_row.patient_name ELSE NULL END,
    -- A document KIND is not an identity: never masked.
    'patient_reference_type', v_row.patient_reference_type,
    'patient_identity_masked', v_row.beneficiary_type = 'patient' AND NOT v_can_view_sensitive,
    'crash_cart_reference', v_row.crash_cart_reference,
    'internal_order_reference', v_row.internal_order_reference,
    'notes', v_row.notes,
    'recorded_by', v_row.recorded_by,
    'recorded_at', v_row.recorded_at
  );
END;
$function$;

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
  'R1.1-U: an ACTIVE health_center_manager must belong to an ACTIVE care_institution organization with institution_class=health_sector. Deliberately does NOT require a facility assignment — provisioning creates the profile before inserting its assignment set in the same transaction — which is safe because an unscoped manager can reach no resource at all. It ALSO refuses to move a profile OUT of the role while active facility assignments remain, so a recycle round-trip cannot silently restore centres nobody re-authorized; the operator must revoke them through phoenix_revoke_profile_scope, with a reason, and the revoked rows are retained as history. Recycling INTO the role is already refused by phoenix_recycle_apply''s own role whitelist, which R1.1-U deliberately does not widen — lifecycle support for this role is deferred rather than half-implemented.';

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
