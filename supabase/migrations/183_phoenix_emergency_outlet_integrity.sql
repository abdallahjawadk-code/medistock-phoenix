-- ============================================================================
-- 183 · EMERGENCY OUTLET INTEGRITY (R1.2C)
-- ============================================================================
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
--
-- Production DDL is applied ONCE, after 182, by the authorized operator through
-- `Supabase.apply_migration`, following an exact-ceiling preflight, the
-- read-only active-outlet matrix preflight this migration performs for itself
-- (section 0), and independent approval. `supabase db push` remains forbidden
-- outright. (Historical migrations carry older apply wording in their own
-- headers and are NOT edited to match — they are immutable.)
--
-- NOT APPLIED BY THIS PR. Authored and replayed on a disposable PostgreSQL rig
-- only. Migrations 001-182 are immutable and are NOT edited here.
--
-- Migration 181 gave the health SECTOR a real write-time topology boundary. It
-- is correct for what it covers, and this migration does not touch it. But its
-- very first classification step is:
--
--     IF v_class IS DISTINCT FROM 'health_sector' THEN RETURN NEW;
--
-- so for a HOSPITAL or a SPECIALIZED CENTRE the distribution_points write
-- boundary enforces nothing at all. An active hospital rescue cart could be
-- created with a non_emergency clinical context, a hospital crash cabinet with
-- an emergency one, and a specialized centre could hold a rescue cart outright
-- — none of which can ever be replenished, because
-- phoenix_replenish_emergency_outlet (168/180) already refuses exactly those
-- shapes at run time. The row is born into a topology the rest of the system
-- will never serve: an outlet that exists, accepts no stock, and reports as
-- operational.
--
-- The same asymmetry exists for a PHARMACY DEPARTMENT AUTHORITY. Migration 171
-- forbids its warehouses from carrying outlets, but that guard is
-- WAREHOUSE-derived and distribution_points.warehouse_id is nullable — so an
-- active outlet owned directly by the authority, with warehouse_id IS NULL,
-- walks past it.
--
-- WHAT THIS MIGRATION DOES. It states the whole active-outlet matrix ONCE, in
-- one server-side validator, and calls it from every place the live topology
-- can change: the distribution_points write boundary, Migration 180's
-- initial-provisioning entry point, and the pre-existing-data preflight this
-- migration runs against itself. The matrix is not stored in a table and not
-- duplicated in a second trigger body — a second copy is how the creation rules
-- and the replenishment rules drift apart, which is the defect class this
-- migration exists to close.
--
-- The invariant is enforced from BOTH SIDES. 'an active emergency outlet has an
-- active owning warehouse' is a claim about two rows, so guarding only the
-- outlet leaves the warehouse free to be deactivated out from under it. 181's
-- warehouse shape guard already closed that for the health sector but behind
-- the very early return quoted above, so it never fired for a hospital or a
-- specialized centre. Section 2b forward-replaces that guard too.
--
--     ORGANIZATION KIND / INSTITUTION CLASS   pharmacy  crash_cabinet  rescue_cart
--     ------------------------------------------------------------------------
--     hospital                                 yes      non_emergency  emergency
--     specialized_center                       yes      non_emergency  FORBIDDEN
--     health_sector (health-centre facility)   yes      emergency      FORBIDDEN
--     pharmacy_department_authority            FORBIDDEN — no active outlets
--
-- The crash-cabinet context genuinely INVERTS between a hospital and a health
-- centre. That is not an inconsistency to normalise away: in a hospital the
-- crash cabinet is a ward cabinet and the rescue cart is the emergency-
-- department trolley, whereas a health centre has no emergency department, so
-- its crash cabinet IS its emergency location. Both readings already exist in
-- phoenix_replenish_emergency_outlet, and 183's dynamic suite proves the two
-- cannot disagree for all ten reachable combinations.
--
-- WHAT IT DOES NOT DO.
--   * It does not touch migrations 001..182, and creates no 184.
--   * It does not rewrite phoenix_replenish_emergency_outlet. That RPC already
--     enforces this matrix at run time and no contradiction was found; adding a
--     second author of the same rule is the risk, not the fix.
--   * It does not make distribution_points.warehouse_id NOT NULL. Migration 021
--     deliberately left that nullable and 181 deliberately preserved the freedom
--     for every non-health-sector class. A pharmacy keeps it. Only the two
--     EMERGENCY point types are newly required to name an owning warehouse, and
--     only because an emergency outlet is exactly the thing that cannot become
--     operational without initial provisioning, which needs a warehouse to
--     provision FROM.
--   * It repairs nothing. Historical and inactive rows are left exactly as they
--     are; existing rows are only ever READ, by the section 1b preflight, which
--     refuses to install over a violation rather than rewriting it.
--   * It does not change warehouse lifecycle semantics beyond refusing the one
--     transition that strands an active emergency outlet. Deactivating a
--     warehouse with no such outlet is exactly as free as it was before.
--
-- ROLLBACK (manual). 183 creates no table and writes no row, so rolling back
-- destroys no data. Restore, in this order:
--   1. _phoenix_health_sector_outlet_topology_guard_v1() — re-run Migration
--      181's own CREATE FUNCTION body verbatim. Its TRIGGER is never dropped by
--      183 and needs no attention.
--   2. _phoenix_health_sector_warehouse_shape_guard_v1() — likewise, re-run
--      Migration 181's own CREATE FUNCTION body verbatim. Its TRIGGER
--      (warehouses_health_sector_shape_guard_trg) is never dropped either.
--   3. phoenix_create_initial_provisioning_dispatch(uuid,uuid,text,text,text,text)
--      — re-run Migration 180's body verbatim.
--   4. DROP FUNCTION public.phoenix_assert_outlet_topology_for_point_v1(uuid);
--   5. DROP FUNCTION public.phoenix_assert_active_outlet_topology_v1(uuid,uuid,text,text);
-- That restores the pre-183 boundary exactly: health-sector enforcement returns
-- to 181's guards on both tables, and hospital/specialized/pharmacy-authority
-- return to being unvalidated at write time.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 0. PRECONDITIONS — fail closed if the chain this builds on has drifted
-- ============================================================================
DO $preflight$
DECLARE
  v_missing text;
BEGIN
  FOR v_missing IN
    SELECT t.what FROM (VALUES
      ('180 initial provisioning', 'phoenix_create_initial_provisioning_dispatch'),
      ('180 dispatch delegate',    '_phoenix_180_delegate_create_warehouse_dispatch'),
      ('168/180 replenishment',    'phoenix_replenish_emergency_outlet'),
      ('181 sector topology guard','_phoenix_health_sector_outlet_topology_guard_v1'),
      ('182 facility helper',      'phoenix_profile_has_facility_assignment')
    ) AS t(what, fn)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = t.fn)
  LOOP
    RAISE EXCEPTION 'PREREQUISITE FAILED (183): % is missing — 180/181/182 must be applied first', v_missing;
  END LOOP;

  -- The columns the matrix is expressed in must exist with the domains 183
  -- assumes; a drifted vocabulary would silently change what "emergency" means.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='distribution_points'
                   AND column_name='clinical_location_kind') THEN
    RAISE EXCEPTION 'PREREQUISITE FAILED (183): distribution_points.clinical_location_kind is missing (Migration 164)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='organizations'
                   AND column_name='organization_kind') THEN
    RAISE EXCEPTION 'PREREQUISITE FAILED (183): organizations.organization_kind is missing (Migration 171)';
  END IF;

  -- The PRE-EXISTING-DATA preflight deliberately does NOT live here.
  --
  -- It used to: a hand-written predicate in this block restated part of the
  -- matrix and scanned for it. That was a latent defect, not a style problem.
  -- A second hand-written copy of a rule always drifts from the first, and this
  -- one already had: it checked the pharmacy-department-authority, hospital and
  -- specialized-centre COMBINATIONS, but neither of the two invariants 183
  -- itself introduces (an emergency outlet with no owning warehouse, and one
  -- whose warehouse is not active). 183 could therefore have installed cleanly
  -- over rows its own validator calls illegal, while this block reported the
  -- database clean — and the operator's Production go/no-go is derived from it.
  --
  -- The scan now runs in section 1b, AFTER the canonical validator is created
  -- in this same transaction, and it asks THAT validator about every active row
  -- rather than re-deciding for itself. Ordering it after the CREATE is what
  -- makes a single authority possible; the migration is one transaction, so a
  -- failure there still rolls back every object created before it.
END
$preflight$;

-- ============================================================================
-- 1. THE CANONICAL ACTIVE-OUTLET TOPOLOGY VALIDATOR
-- ============================================================================
-- ONE statement of the matrix. Every argument is a FACT ABOUT THE ROW being
-- validated, never a claim about the caller: the owning organization, its kind
-- and its institution class are re-resolved here from the catalogue, so a
-- caller cannot assert its own institution class, cannot assert ownership of a
-- warehouse, and cannot reach a branch by naming one.
--
-- Owner resolution deliberately mirrors 181: when a warehouse is named, the
-- OWNING ORGANIZATION IS THE WAREHOUSE'S, not the outlet's — that is what makes
-- a mismatched pair impossible to smuggle through by setting organization_id to
-- a friendlier class. With no warehouse, the outlet's own organization answers.
--
-- SECURITY DEFINER for the same reason 181's guard is: it reads organizations
-- and warehouses to decide, and must reach them regardless of the caller's RLS.
-- It returns void and raises — it discloses nothing to a caller that did not
-- already supply the ids, and it never returns a row.
--
-- LOCK ORDER is 181's, unchanged: warehouse FOR SHARE first (when there is
-- one), then the organization fence in deterministic UUID order. Taking the
-- same order as every warehouse mutation path is what keeps this from
-- deadlocking against them.
CREATE FUNCTION public.phoenix_assert_active_outlet_topology_v1(
  p_organization_id        uuid,
  p_warehouse_id           uuid,
  p_point_type             text,
  p_clinical_location_kind text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_wh        public.warehouses%ROWTYPE;
  v_owner_org uuid;
  v_kind      text;
  v_class     text;
BEGIN
  IF p_warehouse_id IS NOT NULL THEN
    SELECT * INTO v_wh FROM public.warehouses WHERE id = p_warehouse_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'outlet_warehouse_not_found' USING ERRCODE = 'P0002';
    END IF;
    v_owner_org := v_wh.organization_id;
  ELSE
    v_owner_org := p_organization_id;
  END IF;

  PERFORM 1 FROM public.organizations o
  WHERE o.id = ANY (ARRAY[p_organization_id, v_owner_org])
  ORDER BY o.id FOR SHARE;

  SELECT o.organization_kind, o.institution_class INTO v_kind, v_class
  FROM public.organizations o WHERE o.id = v_owner_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'outlet_owner_organization_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- ── A. PHARMACY DEPARTMENT AUTHORITY — no active outlets, ever ────────────
  -- 171 already forbids its WAREHOUSES from carrying outlets. That guard is
  -- warehouse-derived, and warehouse_id is nullable, so it never sees an outlet
  -- the authority owns directly. This is keyed on the ORGANISATION KIND, so the
  -- NULL-warehouse shape is covered by construction. The authority is a supply
  -- and oversight body; dispensing is what its member institutions do.
  IF v_kind = 'pharmacy_department_authority' THEN
    RAISE EXCEPTION 'pharmacy_department_authority_outlet_not_permitted'
      USING ERRCODE = '23514',
      DETAIL = 'a pharmacy department authority holds no dispensing outlets, with or without an owning warehouse';
  END IF;

  -- ── B. HEALTH SECTOR — 181's rules, restated here as the single source ────
  -- Error names and ERRCODEs are 181's, verbatim. 183's trigger sorts ahead of
  -- 181's by name, so THESE are the messages a health-sector caller now sees,
  -- and they are byte-identical to the ones 181's own suites already assert.
  IF v_class = 'health_sector' THEN
    IF p_warehouse_id IS NULL THEN
      RAISE EXCEPTION 'health_sector_outlet_requires_health_center_depot'
        USING ERRCODE = '23514',
        DETAIL = 'an active outlet must hang off a facility-bound centre depot; warehouse_id IS NULL leaves it owned by no health centre';
    END IF;
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
    IF p_point_type = 'rescue_cart' THEN
      RAISE EXCEPTION 'health_center_rescue_cart_not_permitted' USING ERRCODE = '23514';
    END IF;
    IF p_point_type NOT IN ('pharmacy', 'crash_cabinet') THEN
      RAISE EXCEPTION 'health_center_outlet_type_not_permitted: %', p_point_type
        USING ERRCODE = '23514';
    END IF;
    IF p_point_type = 'crash_cabinet'
       AND p_clinical_location_kind IS DISTINCT FROM 'emergency' THEN
      RAISE EXCEPTION 'health_center_crash_cabinet_requires_emergency_context'
        USING ERRCODE = '23514';
    END IF;
    RETURN;
  END IF;

  -- ── C. HOSPITAL and SPECIALIZED CENTRE — the boundary 181 returned early on ─
  IF v_class IN ('hospital', 'specialized_center') THEN
    IF p_point_type NOT IN ('pharmacy', 'crash_cabinet', 'rescue_cart') THEN
      RAISE EXCEPTION 'outlet_type_not_permitted_for_institution_class: % / %', v_class, p_point_type
        USING ERRCODE = '23514';
    END IF;

    -- A pharmacy is not an emergency destination and carries no clinical
    -- context requirement. 021's nullable-warehouse freedom is preserved for it
    -- exactly as 181 preserved it — this migration does not widen that.
    IF p_point_type = 'pharmacy' THEN
      RETURN;
    END IF;

    -- Both remaining types are EMERGENCY outlets. An emergency outlet cannot
    -- become operational without initial provisioning (180), and provisioning
    -- dispatches FROM a warehouse — so an active one that names no warehouse is
    -- a row that can never be served. This is the one place 183 narrows the
    -- nullable-warehouse contract, and it is narrowed for emergency types only.
    IF p_warehouse_id IS NULL THEN
      RAISE EXCEPTION 'emergency_outlet_requires_owning_warehouse'
        USING ERRCODE = '23514',
        DETAIL = 'a crash cabinet or rescue cart must name the warehouse that will provision it';
    END IF;
    IF v_wh.status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'emergency_outlet_requires_active_warehouse' USING ERRCODE = '23514';
    END IF;

    -- The crash cabinet is a WARD location here, so its context is
    -- non_emergency; the rescue cart is the emergency-department trolley. This
    -- is the inversion relative to a health centre, and it matches
    -- phoenix_replenish_emergency_outlet's runtime reading exactly.
    IF p_point_type = 'crash_cabinet'
       AND p_clinical_location_kind IS DISTINCT FROM 'non_emergency' THEN
      RAISE EXCEPTION 'crash_cabinet_requires_non_emergency_context' USING ERRCODE = '23514';
    END IF;

    IF p_point_type = 'rescue_cart' THEN
      -- A specialized centre runs no emergency department, so it has no rescue
      -- cart. 168 already refuses to replenish one; this stops it existing.
      IF v_class = 'specialized_center' THEN
        RAISE EXCEPTION 'specialized_center_rescue_cart_not_permitted' USING ERRCODE = '23514';
      END IF;
      IF p_clinical_location_kind IS DISTINCT FROM 'emergency' THEN
        RAISE EXCEPTION 'rescue_cart_requires_emergency_context' USING ERRCODE = '23514';
      END IF;
    END IF;

    RETURN;
  END IF;

  -- ── D. FAIL CLOSED ────────────────────────────────────────────────────────
  -- A care institution with no institution class, or a class added later
  -- without revisiting this matrix, has no proven-safe answer. Refusing is the
  -- only honest one: the alternative is 181's early return, which is precisely
  -- the shape that let hospitals through unvalidated for two releases.
  RAISE EXCEPTION 'outlet_owner_institution_class_unsupported: kind=% class=%',
    coalesce(v_kind, 'NULL'), coalesce(v_class, 'NULL')
    USING ERRCODE = '23514',
    DETAIL = 'an active outlet requires an owner whose institution class this matrix recognises';
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_assert_active_outlet_topology_v1(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;

-- Point-addressed entry point: re-resolves an EXISTING outlet's CURRENT
-- topology. Used by the initial-provisioning recheck, which must judge the
-- outlet as it is now, not as it was when created.
CREATE FUNCTION public.phoenix_assert_outlet_topology_for_point_v1(p_distribution_point_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dp public.distribution_points%ROWTYPE;
BEGIN
  SELECT * INTO v_dp FROM public.distribution_points WHERE id = p_distribution_point_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'distribution_point_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.phoenix_assert_active_outlet_topology_v1(
    v_dp.organization_id, v_dp.warehouse_id, v_dp.point_type, v_dp.clinical_location_kind);
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_assert_outlet_topology_for_point_v1(uuid)
  FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 1b. PRE-EXISTING ACTIVE STATE — judged by THE validator, never by a copy
-- ============================================================================
-- 183 does not repair data. If the live database already holds an ACTIVE outlet
-- the new matrix would refuse, this fails with identifying context rather than
-- rewriting somebody's operational outlet.
--
-- The rule this enforces is: WHATEVER THE VALIDATOR REFUSES TO CREATE, IT MUST
-- ALSO REFUSE TO INHERIT. The only way to guarantee that for every rule — the
-- ones inherited from 181 and the two 183 adds — is to ask the validator
-- itself, so that is what happens here. There is no second predicate to keep in
-- step, and a rule added to the validator later is covered by this scan on the
-- day it is added, with no edit here.
--
-- WHY THIS RUNS AFTER SECTION 1. The validator has to exist before it can be
-- called. That is safe precisely because 183 is ONE transaction: a failure
-- below rolls back the two functions created above it, every later object, and
-- any lock taken — nothing survives a PREREQUISITE FAILED. The alternative,
-- scanning before the CREATE, is what forced the hand-written copy that this
-- section exists to delete.
--
-- SCOPE: the three point types the modern outlet regime is expressed in — the
-- same set outlet_stock's own CHECK uses (067). That is the matrix's domain,
-- not a rule of it: every canonical rule still runs, unabridged, against every
-- row inside it, including the pharmacy-department-authority rule and the
-- unsupported-owner-class rule.
--
-- Legacy-vocabulary points (dispensing/storage/returns/emergency, kept
-- accepted by 066) are deliberately NOT judged here, because the repository has
-- decided this question twice already and both times the same way: 067:169-177
-- refuses to guess whether a legacy 'dispensing' point is really a pharmacy, a
-- crash cabinet or a rescue cart — 'that is an operational decision, not a data
-- migration' — and 164:62-66 repeats it for facility classification. Those rows
-- hold no outlet_stock and sit outside the emergency corridor entirely.
--
-- This concedes nothing. A legacy point cannot reach the modern regime without
-- being RECLASSIFIED, and reclassification is a write to point_type — one of
-- the five columns 181's trigger watches — so it is judged by the full matrix,
-- PDA rule included, at the moment it tries to enter. Refusing to INSTALL over
-- such a row would not protect anything; it would only make 183 unappliable to
-- every database carrying pre-067 history, this repository's own canonical
-- chain among them (004 seeds four active 'dispensing' points).
--
-- Every raise is transactional. The inner block traps the validator's own
-- exception only to attach the identifying row, then re-raises; it never
-- swallows one and never continues past a violation.
DO $preexisting$
DECLARE
  v_dp       public.distribution_points%ROWTYPE;
  v_reason   text;
BEGIN
  FOR v_dp IN
    SELECT * FROM public.distribution_points
    WHERE status = 'active'
      AND point_type IN ('pharmacy', 'crash_cabinet', 'rescue_cart')
    ORDER BY id
  LOOP
    BEGIN
      PERFORM public.phoenix_assert_active_outlet_topology_v1(
        v_dp.organization_id, v_dp.warehouse_id, v_dp.point_type, v_dp.clinical_location_kind);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_reason = MESSAGE_TEXT;
      RAISE EXCEPTION
        'PREREQUISITE FAILED (183): an ACTIVE outlet already violates the emergency topology matrix — distribution_point % (%) org=% warehouse=% type=% context=% rejected as: %',
        v_dp.id, coalesce(v_dp.name, 'unnamed'), v_dp.organization_id,
        coalesce(v_dp.warehouse_id::text, 'NULL'), v_dp.point_type,
        coalesce(v_dp.clinical_location_kind, 'NULL'), v_reason
        USING HINT = 'resolve the row operationally before applying 183; this migration never rewrites operational data';
    END;
  END LOOP;
END
$preexisting$;

-- ============================================================================
-- 2. THE distribution_points WRITE BOUNDARY — ONE trigger, widened in place
-- ============================================================================
-- Migration 181 already owns the exact write surface R1.2C needs:
--
--   distribution_points_health_sector_topology_trg
--   BEFORE INSERT OR UPDATE OF warehouse_id, organization_id, point_type,
--                              clinical_location_kind, status
--
-- so 183 adds NO second trigger. An earlier draft did, named to sort ahead of
-- 181's, and that was the wrong instinct: two overlapping BEFORE triggers make
-- correctness depend on trigger-name collation, leave two runtime authors of
-- one rule, and mean a future rename silently changes which error a caller
-- sees. The trigger OBJECT stays exactly as 181 created it — same name, same
-- events, same column list — and only the function BEHIND it is forward
-- replaced, so there is one hook and one matrix.
--
--   distribution_points  (181's trigger, untouched)
--        -> _phoenix_health_sector_outlet_topology_guard_v1()   [thin delegate]
--             -> phoenix_assert_active_outlet_topology_v1(...)  [THE matrix]
--
-- The function keeps its historical name even though its responsibility is now
-- every institution class, because renaming it would mean recreating 181's
-- trigger and losing the one-hook property this section exists to establish.
-- Migration 181's FILE is not edited; this is a forward replacement, the same
-- pattern 182 used for 017/062/092.
--
-- Health-sector callers are unaffected: the canonical validator restates 181's
-- health-sector rules with 181's error names and ERRCODEs verbatim, which
-- 181's own dynamic suites continue to assert against this same trigger.
--
-- Inactive and archived rows are history and are returned untouched, so a
-- legacy row whose combination is no longer legal keeps existing and keeps its
-- values — but the moment it is asked to become active, it is judged by the
-- current matrix like anything else.
CREATE OR REPLACE FUNCTION public._phoenix_health_sector_outlet_topology_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM 'active' THEN
    RETURN NEW;
  END IF;
  PERFORM public.phoenix_assert_active_outlet_topology_v1(
    NEW.organization_id, NEW.warehouse_id, NEW.point_type, NEW.clinical_location_kind);
  RETURN NEW;
END;
$$;

-- ============================================================================
-- 2b. THE WAREHOUSE LIFECYCLE BOUNDARY — the inverse mutation surface
-- ============================================================================
-- Section 2 judges the OUTLET row. That is only half an invariant.
--
-- 'an active emergency outlet has an active owning warehouse' is a statement
-- about TWO rows, so it can be broken from either side. Guarding only the child
-- leaves the parent free to be mutated out from under it:
--
--   1. create a legal hospital rescue cart on an active warehouse   -- allowed
--   2. UPDATE warehouses SET status = 'inactive'                    -- unguarded
--   => an ACTIVE emergency outlet owned by an INACTIVE warehouse
--
-- which is exactly the state phoenix_assert_active_outlet_topology_v1 refuses
-- to create. The outlet can then never be initially provisioned (180's delegate
-- requires an active warehouse) while continuing to report as operational —
-- the precise failure this migration was written to end.
--
-- Migration 181 already saw this shape and closed it FOR THE HEALTH SECTOR: its
-- warehouse shape guard blocks deactivating a centre depot that still carries
-- an active outlet. But that check sits BEHIND the same early return 183 exists
-- to remove:
--
--     IF v_class IS DISTINCT FROM 'health_sector' THEN RETURN NEW; END IF;
--
-- so it never runs for a hospital or a specialized centre. This is 181's gap,
-- one table over from the one section 2 closes.
--
-- WHAT CHANGES. 181's FILE is not edited and its TRIGGER OBJECT is not touched
-- — same name, same events, same column list. Only the function behind it is
-- forward replaced, the same pattern section 2 uses for the outlet guard and
-- 182 used for 017/062/092. The single edit is that the dependency check moves
-- AHEAD of the class early return and gains a non-health-sector branch:
--
--   health_sector       ANY active outlet blocks deactivation
--                       -> health_center_depot_deactivation_blocked_by_active_outlet
--                       (181's contract, verbatim, deliberately not narrowed:
--                        a centre depot is the only supply node its outlets
--                        have, so losing it strands a pharmacy too)
--
--   every other class   only an active EMERGENCY outlet blocks it
--                       -> emergency_outlet_warehouse_deactivation_blocked_by_active_outlet
--
-- The non-health-sector branch is deliberately keyed on the CONSEQUENCE rather
-- than on a list of classes: any class whose active emergency outlet would be
-- stranded is covered, including one added after this migration. A pharmacy
-- outlet never blocks deactivation outside the health sector, because a
-- pharmacy is legal with no owning warehouse at all (021/181), so deactivating
-- its warehouse strands nothing.
--
-- Everything else in 181's body — the organization lock fence, the FOR UPDATE
-- escalation that closes the write-skew window against a concurrent outlet
-- INSERT, rules A through D, and the historical-row pass-through — is 181's,
-- unchanged.
CREATE OR REPLACE FUNCTION public._phoenix_health_sector_warehouse_shape_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_class    text;
  v_facility public.organization_facilities%ROWTYPE;
BEGIN
  -- The organization row is the topology lock fence. Lock every affected
  -- owner in UUID order so activation cannot race a child mutation and
  -- cross-organization moves cannot invert lock order. (181, unchanged.)
  PERFORM 1
  FROM public.organizations o
  WHERE o.id = ANY(CASE TG_OP
    WHEN 'INSERT' THEN ARRAY[NEW.organization_id]
    ELSE ARRAY[OLD.organization_id, NEW.organization_id]
  END)
  ORDER BY o.id
  FOR SHARE;

  SELECT o.institution_class INTO v_class
  FROM public.organizations o WHERE o.id = NEW.organization_id;

  -- R1.2C (183): the deactivation dependency check runs BEFORE the class early
  -- return, because stranding an active emergency outlet is not a health-sector
  -- concern. The lock discipline is 181's: escalating this row to FOR UPDATE is
  -- what serializes a status downgrade against a concurrent outlet INSERT,
  -- whose FK takes FOR KEY SHARE on the same row.
  IF TG_OP = 'UPDATE' AND OLD.status = 'active' AND NEW.status IS DISTINCT FROM 'active' THEN
    PERFORM 1 FROM public.warehouses WHERE id = NEW.id FOR UPDATE;

    IF v_class = 'health_sector' THEN
      IF EXISTS (
        SELECT 1 FROM public.distribution_points dp
        WHERE dp.warehouse_id = NEW.id AND dp.status = 'active'
      ) THEN
        RAISE EXCEPTION 'health_center_depot_deactivation_blocked_by_active_outlet'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      -- The two EMERGENCY point types are the ones that cannot survive losing
      -- their warehouse: each requires an active owning warehouse to be legal
      -- at all, and neither can be commissioned without initial provisioning
      -- dispatched FROM it. Named here rather than re-derived so this guard
      -- states no context rule and no class rule — the matrix itself stays in
      -- phoenix_assert_active_outlet_topology_v1, which owns it alone.
      IF EXISTS (
        SELECT 1 FROM public.distribution_points dp
        WHERE dp.warehouse_id = NEW.id
          AND dp.status = 'active'
          AND dp.point_type IN ('crash_cabinet', 'rescue_cart')
      ) THEN
        RAISE EXCEPTION 'emergency_outlet_warehouse_deactivation_blocked_by_active_outlet'
          USING ERRCODE = '23514',
          DETAIL = 'an active crash cabinet or rescue cart still names this warehouse; an emergency outlet requires an active owning warehouse';
      END IF;
    END IF;
  END IF;

  -- Every other organization class keeps its existing freedom untouched.
  IF v_class IS DISTINCT FROM 'health_sector' THEN
    RETURN NEW;
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

-- ============================================================================
-- 3. INITIAL PROVISIONING RECHECK — defence in depth over Migration 180
-- ============================================================================
-- 180 is immutable, so this is a forward replacement. The ONLY change is the
-- topology assertion added as the first statement: everything below it is
-- 180's body unchanged, including the 'initial' literal, the one-shot
-- uniqueness rule, the flags-only update, the audit row and the return shape.
--
-- It runs BEFORE the delegate, so a denied request creates no dispatch, no
-- dispatch line, no stock movement and no success audit row — the whole call
-- raises and the transaction is gone. Relying on "replenishment will reject it
-- later" would leave a draft dispatch and an audit trail for an outlet that can
-- never be served.
--
-- It re-resolves the destination's CURRENT topology rather than trusting
-- creation-time validity, because a legally-created outlet can have been
-- rehomed or retyped since.
CREATE OR REPLACE FUNCTION public.phoenix_create_initial_provisioning_dispatch(
  p_warehouse_id uuid,
  p_destination_distribution_point_id uuid,
  p_dispatch_number text,
  p_document_number text DEFAULT NULL,
  p_default_currency text DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor       uuid := auth.uid();
  v_actor_role  text;
  v_created     jsonb;
  v_dispatch    public.warehouse_dispatches%ROWTYPE;
BEGIN
  -- R1.2C (183): the destination must be legal for its owner's institution
  -- class RIGHT NOW, before anything is written.
  PERFORM public.phoenix_assert_outlet_topology_for_point_v1(p_destination_distribution_point_id);

  -- Every authentication, pairing, organization and permission rule is the
  -- core's, unchanged. It raises not_authenticated / dispatch_number_required
  -- / warehouse_not_found_or_inactive / destination_outlet_not_found_or_inactive
  -- / outlet_type_not_approved_for_stock / destination_outlet_not_paired_with_
  -- this_warehouse / warehouse_and_destination_organization_mismatch /
  -- forbidden_warehouse_dispatch_create / active_profile_required for us, and
  -- takes pg_advisory_xact_lock(hashtextextended(p_warehouse_id::text, 70169)).
  --
  -- 'initial' is a literal chosen HERE. It is not derived from any argument, so
  -- no caller of this RPC can ask for a different authority, and no caller of
  -- the ordinary RPC can ask for this one.
  v_created := public._phoenix_180_delegate_create_warehouse_dispatch(
    p_warehouse_id,
    p_destination_distribution_point_id,
    p_dispatch_number,
    p_document_number,
    p_default_currency,
    p_notes,
    'initial'
  );

  SELECT * INTO v_dispatch
  FROM public.warehouse_dispatches
  WHERE id = (v_created ->> 'dispatch_id')::uuid;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'initial_provisioning_dispatch_not_created' USING ERRCODE = 'P0002';
  END IF;

  -- Named error instead of a raw constraint violation — the same courtesy 070
  -- extends for the outlet/warehouse pairing. This check is DETERMINISTIC, not
  -- racy: the core above already holds the per-warehouse advisory lock, and
  -- the destination outlet is required to be paired with that same warehouse,
  -- so every competing creation for one outlet serialises on one lock. The
  -- partial unique index remains the structural backstop regardless.
  IF EXISTS (
    SELECT 1
    FROM public.warehouse_dispatches d
    WHERE d.destination_distribution_point_id = p_destination_distribution_point_id
      AND d.id <> v_dispatch.id
      AND d.is_initial_provisioning
      AND (d.initial_provisioning_consumed_at IS NOT NULL
           OR d.status IN ('draft', 'sent', 'partially_accepted'))
  ) THEN
    RAISE EXCEPTION 'initial_provisioning_already_exists_for_outlet'
      USING ERRCODE = '23505';
  END IF;

  -- Flags only. Status is untouched, so phoenix_capture_lifecycle_event —
  -- which returns early unless status actually changed (159:182-184) — emits
  -- neither a movement event nor an outbox row.
  UPDATE public.warehouse_dispatches
     SET is_initial_provisioning = true
   WHERE id = v_dispatch.id;

  SELECT p.role INTO v_actor_role
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_dispatch.organization_id, v_actor, v_actor_role,
    'warehouse_dispatch.initial_provisioning_created', 'warehouse_dispatches',
    v_dispatch.id, v_dispatch.dispatch_number,
    jsonb_build_object(
      'warehouse_id', p_warehouse_id,
      'distribution_point_id', p_destination_distribution_point_id,
      'is_initial_provisioning', true
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'dispatch_id', v_dispatch.id,
    'status', v_dispatch.status,
    'is_initial_provisioning', true
  );
END;
$$;

-- ============================================================================
-- 4. COMMENTS
-- ============================================================================
COMMENT ON FUNCTION public.phoenix_assert_active_outlet_topology_v1(uuid, uuid, text, text) IS
  'R1.2C (183): THE canonical active-outlet topology matrix. Raises on any combination of owner institution class, point type and clinical context that cannot be operated. Owner, kind and class are re-resolved from the catalogue — when a warehouse is named its organization wins, exactly as Migration 181 resolves it — so a caller can assert neither its institution class nor ownership of a warehouse. Health-sector messages are Migration 181''s verbatim so no existing error contract moves. Returns void and raises; it discloses nothing a caller did not already supply.';

COMMENT ON FUNCTION public._phoenix_health_sector_warehouse_shape_guard_v1() IS
  'R1.2C (183): forward replacement of Migration 181''s warehouse shape guard. The trigger OBJECT is 181''s, unchanged. The single behavioural change is that the active-outlet dependency check now runs BEFORE the non-health-sector early return, so deactivating a warehouse can no longer strand an ACTIVE emergency outlet on a hospital or specialized centre — the inverse half of the invariant section 2 enforces on the outlet row. Health-sector behaviour and its error contract (health_center_depot_deactivation_blocked_by_active_outlet) are 181''s, deliberately not narrowed; every other class is blocked only by an active crash cabinet or rescue cart, via emergency_outlet_warehouse_deactivation_blocked_by_active_outlet.';

COMMENT ON FUNCTION public._phoenix_health_sector_outlet_topology_guard_v1() IS
  'R1.2C (183): forward replacement of Migration 181''s trigger function. The trigger OBJECT is 181''s, unchanged — 183 adds no second trigger, so no correctness depends on trigger-name ordering. This is now a THIN DELEGATE to phoenix_assert_active_outlet_topology_v1, which owns the whole matrix for every institution class; the historical name is kept so 181''s trigger need not be recreated. Inactive and archived rows are history and pass through untouched; every transition INTO an active state is judged by the current matrix, so a legacy illegal row can continue to exist but can never be reactivated.';

-- ============================================================================
-- 5. VERIFY — in-transaction, fails the whole migration
-- ============================================================================
DO $verify$
DECLARE
  v_bad integer;
  v_def text;
BEGIN
  -- 5a. The validator exists, is SECURITY DEFINER, search_path-pinned, and is
  --     NOT reachable by a client role: it is an internal invariant, not an API.
  FOR v_bad IN
    SELECT 1 FROM (VALUES
      ('phoenix_assert_active_outlet_topology_v1(uuid,uuid,text,text)'),
      ('phoenix_assert_outlet_topology_for_point_v1(uuid)'),
      ('_phoenix_health_sector_outlet_topology_guard_v1()')
    ) AS t(sig)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname='public' AND p.oid = ('public.' || t.sig)::regprocedure
        AND p.prosecdef
        AND p.proconfig @> ARRAY['search_path=public, pg_temp'])
  LOOP
    RAISE EXCEPTION 'VERIFY FAILED (183): a topology object is missing, not SECURITY DEFINER, or not search_path-pinned';
  END LOOP;

  FOR v_bad IN
    SELECT 1 FROM (VALUES
      ('phoenix_assert_active_outlet_topology_v1(uuid,uuid,text,text)'),
      ('phoenix_assert_outlet_topology_for_point_v1(uuid)')
    ) AS t(sig)
    WHERE has_function_privilege('authenticated', ('public.' || t.sig)::regprocedure, 'EXECUTE')
       OR has_function_privilege('anon', ('public.' || t.sig)::regprocedure, 'EXECUTE')
  LOOP
    RAISE EXCEPTION 'VERIFY FAILED (183): the topology validator is reachable by a client role';
  END LOOP;

  -- 5b. Migration 181's trigger OBJECT is intact and still watches every column
  --     that can move a row into an illegal active topology.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname='distribution_points'
      AND t.tgname='distribution_points_health_sector_topology_trg'
      AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'VERIFY FAILED (183): Migration 181''s distribution_points topology trigger is missing';
  END IF;
  SELECT count(*) INTO v_bad
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN unnest(t.tgattr) AS a(attnum) ON true
  JOIN pg_attribute att ON att.attrelid = c.oid AND att.attnum = a.attnum
  WHERE c.relname='distribution_points'
    AND t.tgname='distribution_points_health_sector_topology_trg'
    AND att.attname IN ('warehouse_id','organization_id','point_type','clinical_location_kind','status');
  IF v_bad <> 5 THEN
    RAISE EXCEPTION 'VERIFY FAILED (183): the topology trigger does not watch all five topology columns (saw %)', v_bad;
  END IF;

  -- 5c. EXACTLY ONE topology hook. Correctness must not depend on the collation
  --     order of two overlapping BEFORE triggers, so a second one is refused
  --     outright rather than ordered around — including any future re-addition.
  SELECT count(*) INTO v_bad
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
  WHERE c.relname='distribution_points' AND NOT t.tgisinternal
    AND pg_get_triggerdef(t.oid) ILIKE '%topology%';
  IF v_bad <> 1 THEN
    RAISE EXCEPTION 'VERIFY FAILED (183): expected exactly one distribution_points topology trigger, found % — two overlapping BEFORE triggers reintroduce order coupling', v_bad;
  END IF;

  -- 5c-2. That one trigger must run THE canonical matrix, not a private copy.
  v_def := pg_get_functiondef('public._phoenix_health_sector_outlet_topology_guard_v1()'::regprocedure);
  IF position('phoenix_assert_active_outlet_topology_v1' in v_def) = 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (183): the topology trigger function no longer delegates to the canonical validator';
  END IF;
  -- A delegate, not a second author: the matrix vocabulary must live in the
  -- validator alone, so the guard body may not restate any of it.
  IF v_def ILIKE '%rescue_cart%' OR v_def ILIKE '%crash_cabinet%'
     OR v_def ILIKE '%institution_class%' OR v_def ILIKE '%organization_kind%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (183): the topology trigger function restates matrix vocabulary — the matrix must have exactly one author';
  END IF;

  -- 5d. The initial-provisioning recheck is wired, and BEFORE the delegate.
  v_def := pg_get_functiondef('public.phoenix_create_initial_provisioning_dispatch(uuid,uuid,text,text,text,text)'::regprocedure);
  IF position('phoenix_assert_outlet_topology_for_point_v1' in v_def) = 0
     OR position('phoenix_assert_outlet_topology_for_point_v1' in v_def)
        > position('_phoenix_180_delegate_create_warehouse_dispatch' in v_def) THEN
    RAISE EXCEPTION 'VERIFY FAILED (183): initial provisioning does not re-validate topology before creating the dispatch';
  END IF;
  -- 180's own contract survives the forward replacement.
  FOR v_bad IN
    SELECT 1 FROM (VALUES
      ('''initial'''), ('is_initial_provisioning'),
      ('initial_provisioning_already_exists_for_outlet'),
      ('warehouse_dispatch.initial_provisioning_created')
    ) AS t(marker)
    WHERE position(t.marker in v_def) = 0
  LOOP
    RAISE EXCEPTION 'VERIFY FAILED (183): the initial-provisioning contract from Migration 180 was not preserved';
  END LOOP;

  -- 5d-2. THE WAREHOUSE SIDE. The guard is forward-replaced, still privileged
  --       and search_path-pinned, and 181's trigger object is intact — same
  --       name, still watching status, which is what makes a deactivation
  --       reach the guard at all.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public'
      AND p.oid = 'public._phoenix_health_sector_warehouse_shape_guard_v1()'::regprocedure
      AND p.prosecdef
      AND p.proconfig @> ARRAY['search_path=public, pg_temp']) THEN
    RAISE EXCEPTION 'VERIFY FAILED (183): the warehouse shape guard is missing, not SECURITY DEFINER, or not search_path-pinned';
  END IF;
  IF has_function_privilege('authenticated', 'public._phoenix_health_sector_warehouse_shape_guard_v1()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon', 'public._phoenix_health_sector_warehouse_shape_guard_v1()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (183): the warehouse shape guard is reachable by a client role';
  END IF;

  SELECT count(*) INTO v_bad
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN unnest(t.tgattr) AS a(attnum) ON true
  JOIN pg_attribute att ON att.attrelid = c.oid AND att.attnum = a.attnum
  WHERE c.relname='warehouses'
    AND t.tgname='warehouses_health_sector_shape_guard_trg'
    AND att.attname IN ('organization_id','warehouse_kind','facility_id','is_main','status');
  IF v_bad <> 5 THEN
    RAISE EXCEPTION 'VERIFY FAILED (183): Migration 181''s warehouse shape guard trigger does not watch all five columns (saw %)', v_bad;
  END IF;

  SELECT count(*) INTO v_bad
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
  WHERE c.relname='warehouses' AND NOT t.tgisinternal
    AND pg_get_triggerdef(t.oid) ILIKE '%shape_guard%';
  IF v_bad <> 1 THEN
    RAISE EXCEPTION 'VERIFY FAILED (183): expected exactly one warehouses shape-guard trigger, found % — 183 adds none', v_bad;
  END IF;

  -- 5d-3. Both halves of the two-row invariant are actually stated. The
  --       dependency check must precede the class early return, or the
  --       hospital/specialized branch is dead code again — which is precisely
  --       the defect this section closes.
  v_def := pg_get_functiondef('public._phoenix_health_sector_warehouse_shape_guard_v1()'::regprocedure);
  FOR v_bad IN
    SELECT 1 FROM (VALUES
      ('health_center_depot_deactivation_blocked_by_active_outlet'),
      ('emergency_outlet_warehouse_deactivation_blocked_by_active_outlet'),
      ('crash_cabinet'), ('rescue_cart')
    ) AS t(marker)
    WHERE position(t.marker in v_def) = 0
  LOOP
    RAISE EXCEPTION 'VERIFY FAILED (183): the warehouse guard does not state both deactivation contracts';
  END LOOP;
  IF position('emergency_outlet_warehouse_deactivation_blocked_by_active_outlet' in v_def)
     > position('IF v_class IS DISTINCT FROM ''health_sector'' THEN' in v_def) THEN
    RAISE EXCEPTION 'VERIFY FAILED (183): the warehouse dependency check still sits behind the health-sector early return';
  END IF;

  -- 5e. 181 is untouched and still installed.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname='distribution_points'
      AND t.tgname='distribution_points_health_sector_topology_trg') THEN
    RAISE EXCEPTION 'VERIFY FAILED (183): Migration 181''s health-sector trigger was removed';
  END IF;

  -- 5f. NO THIRD STOCK TRUTH, and no table created at all.
  IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r'
        AND c.relname IN ('outlet_topology_matrix','emergency_outlet_matrix',
                          'distribution_point_rules','outlet_stock_v2')) <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (183): a matrix or stock table was created — the matrix belongs in one function, not a table';
  END IF;

  RAISE NOTICE 'EMERGENCY-OUTLET-INTEGRITY-183: verified.';
END
$verify$;

COMMIT;
