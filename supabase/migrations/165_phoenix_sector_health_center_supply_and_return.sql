-- ============================================================================
-- SECTOR-HEALTH-CENTER-SUPPLY-AND-RETURN-165  (Stage E · subphase E-3)
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply after 164, via the Supabase SQL Editor, after reading this file in full.
--
-- NOT APPLIED BY THIS PR. Authored and replayed on a disposable PostgreSQL rig
-- only. Migrations 001-164 are immutable and are NOT edited here.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SCOPE — E-3 ONLY
-- ─────────────────────────────────────────────────────────────────────────────
-- Exactly TWO `CREATE OR REPLACE` statements, and nothing else:
--
--   1. phoenix_assert_direct_supply_endpoints(uuid,uuid,uuid)
--   2. phoenix_assert_direct_return_endpoints(uuid,uuid)
--
-- No new table, no new column, no new index, no new constraint, no new RPC, no
-- new permission key, no new movement type, no new corridor. The entire
-- warehouse transfer/return machinery (068/069/077, and the 129/149/150
-- wrappers over it) is REUSED unchanged — only the two endpoint predicates that
-- decide which warehouse pairs are legal are widened, each by exactly one
-- narrow branch.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT BECOMES LEGAL, AND NOTHING MORE
-- ─────────────────────────────────────────────────────────────────────────────
-- FORWARD  sector-level institution warehouse -> warehouse of an ACTIVE
--          subordinate health-centre facility, inside ONE health_sector org.
-- RETURN   warehouse of an ACTIVE subordinate health-centre facility -> the
--          sector-level warehouse, inside ONE health_sector org, and ONLY where
--          a real prior direct forward transfer connected exactly those two
--          warehouses.
--
-- There is NO "institution -> institution if same organization" predicate
-- anywhere below. A sector source must have facility_id IS NULL and a
-- health-centre endpoint must have facility_id IS NOT NULL, so hospital and
-- specialized-centre warehouses — which can never own a facility, because a
-- facility may only exist under a health_sector parent (164's of_parent_class_fk)
-- — can never satisfy either new branch.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- HOW BRANCH A IS PRESERVED EXACTLY
-- ─────────────────────────────────────────────────────────────────────────────
-- Both functions evaluate the NEW branch FIRST, and only when it matches in
-- full. Everything else falls through to the ORIGINAL 077 logic, reproduced
-- verbatim — same order, same error identifiers, same ERRCODEs, same IDOR gate,
-- same provenance test, same OUT values.
--
-- The two branches are mutually exclusive by construction:
--   * forward — Branch A needs source.warehouse_kind='central'; Branch B needs
--     source.warehouse_kind='institution'.
--   * return  — Branch A needs destination.warehouse_kind='central'; Branch B
--     needs destination.warehouse_kind='institution'.
-- So no input that Branch A accepts today can be diverted into Branch B, and no
-- input Branch A rejects today changes its error UNLESS it matches the new
-- branch's shape — a shape that could not exist before 164 introduced
-- warehouses.facility_id.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SIGNATURES ARE NOT CHANGED — DELIBERATELY
-- ─────────────────────────────────────────────────────────────────────────────
-- `CREATE OR REPLACE FUNCTION` cannot rename input or output parameters, and
-- all four callers of each function select the OUT columns BY NAME. The return
-- validator therefore keeps its legacy parameter names
-- (p_institution_warehouse_id / p_central_warehouse_id) even though their
-- meaning generalises to "return source" / "return destination". Renaming would
-- require DROP FUNCTION, which would cascade to every caller. Only the COMMENT
-- is updated to record the generalised meaning.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 0. PRECONDITIONS — fail closed
-- ============================================================================
DO $preflight$
BEGIN
  -- Both validators must already exist, with the exact signatures we replace.
  IF to_regprocedure('public.phoenix_assert_direct_supply_endpoints(uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION '165_precondition_failed: phoenix_assert_direct_supply_endpoints (077) is absent';
  END IF;
  IF to_regprocedure('public.phoenix_assert_direct_return_endpoints(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION '165_precondition_failed: phoenix_assert_direct_return_endpoints (077) is absent';
  END IF;

  -- The E-2 foundation this branch depends on must be present.
  IF to_regclass('public.organization_facilities') IS NULL THEN
    RAISE EXCEPTION '165_precondition_failed: organization_facilities (164) is absent';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='warehouses' AND column_name='facility_id'
  ) THEN
    RAISE EXCEPTION '165_precondition_failed: warehouses.facility_id (164) is absent';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='organizations' AND column_name='institution_class'
  ) THEN
    RAISE EXCEPTION '165_precondition_failed: organizations.institution_class (164) is absent';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='warehouses_facility_org_fk') THEN
    RAISE EXCEPTION '165_precondition_failed: warehouses_facility_org_fk (164) is absent';
  END IF;

  -- The forward corridor this widens must still exist.
  IF to_regclass('public.warehouse_transfers') IS NULL THEN
    RAISE EXCEPTION '165_precondition_failed: warehouse_transfers (068) is absent';
  END IF;

  -- warehouse_kind must still be exactly two values: the new branches read it
  -- by equality and would silently mis-classify if it had been widened.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='warehouses_warehouse_kind_chk'
      AND pg_get_constraintdef(oid) LIKE '%central%'
      AND pg_get_constraintdef(oid) LIKE '%institution%'
  ) THEN
    RAISE EXCEPTION '165_precondition_failed: warehouses_warehouse_kind_chk missing or reshaped';
  END IF;

  RAISE NOTICE '165 preconditions OK.';
END;
$preflight$;

-- ============================================================================
-- 1. FORWARD — phoenix_assert_direct_supply_endpoints
-- ============================================================================
-- BRANCH A · EXISTING CENTRAL_SUPPLY   (reproduced verbatim from 077)
-- BRANCH B · NEW SAME_SECTOR_HEALTH_CENTER_SUPPLY
--
-- Branch B's ten conjuncts:
--    1. src.warehouse_kind        = 'institution'
--    2. src.status                = 'active'
--    3. dst.warehouse_kind        = 'institution'
--    4. dst.status                = 'active'
--    5. src.id                   <> dst.id
--    6. src.organization_id        = dst.organization_id
--    7. src_org.institution_class  = 'health_sector'
--    8. src.facility_id           IS NULL        (source is SECTOR-LEVEL)
--    9. dst.facility_id           IS NOT NULL    (destination belongs to a facility)
--   10. dst_facility.facility_class IN ('primary_health_center','subordinate_health_center')
--       AND dst_facility.status         = 'active'
--       AND dst_facility.organization_id = src.organization_id
CREATE OR REPLACE FUNCTION public.phoenix_assert_direct_supply_endpoints(
  p_source_warehouse_id         uuid,
  p_destination_warehouse_id    uuid,
  p_destination_organization_id uuid,
  OUT o_source_organization_id      uuid,
  OUT o_destination_organization_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_src public.warehouses%ROWTYPE;
  v_dst public.warehouses%ROWTYPE;
  v_src_class text;
  v_fac public.organization_facilities%ROWTYPE;
BEGIN
  IF p_source_warehouse_id IS NULL OR p_destination_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'source_and_destination_required' USING ERRCODE = '23514';
  END IF;
  IF p_source_warehouse_id = p_destination_warehouse_id THEN
    RAISE EXCEPTION 'source_and_destination_must_differ' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_src FROM public.warehouses WHERE id = p_source_warehouse_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'source_warehouse_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_dst FROM public.warehouses WHERE id = p_destination_warehouse_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'destination_warehouse_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- ── BRANCH B · SAME-SECTOR HEALTH-CENTRE SUPPLY ────────────────────────────
  -- The SHAPE test (conjuncts 1, 3, 6, 8, 9) selects this branch. It can only
  -- be satisfied by an institution source with no facility and an institution
  -- destination that belongs to one, inside a single organization — a shape
  -- that was structurally impossible before 164 added warehouses.facility_id,
  -- so no pre-existing caller behaviour can be diverted here.
  IF v_src.warehouse_kind = 'institution'
     AND v_dst.warehouse_kind = 'institution'
     AND v_src.facility_id IS NULL
     AND v_dst.facility_id IS NOT NULL
     AND v_src.organization_id = v_dst.organization_id
  THEN
    IF v_src.status <> 'active' THEN
      RAISE EXCEPTION 'sector_source_warehouse_not_active' USING ERRCODE = '23514';
    END IF;
    IF v_dst.status <> 'active' THEN
      RAISE EXCEPTION 'health_center_warehouse_not_active' USING ERRCODE = '23514';
    END IF;

    SELECT o.institution_class INTO v_src_class
    FROM public.organizations o WHERE o.id = v_src.organization_id FOR SHARE;
    IF v_src_class IS NULL THEN
      RAISE EXCEPTION 'organization_institution_class_required' USING ERRCODE = '23514';
    END IF;
    IF v_src_class <> 'health_sector' THEN
      RAISE EXCEPTION 'sector_supply_requires_health_sector' USING ERRCODE = '23514';
    END IF;

    SELECT * INTO v_fac
    FROM public.organization_facilities f WHERE f.id = v_dst.facility_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'destination_facility_not_found' USING ERRCODE = 'P0002';
    END IF;
    IF v_fac.organization_id IS DISTINCT FROM v_src.organization_id THEN
      RAISE EXCEPTION 'facility_not_in_source_organization' USING ERRCODE = '42501';
    END IF;
    IF v_fac.facility_class NOT IN ('primary_health_center', 'subordinate_health_center') THEN
      RAISE EXCEPTION 'invalid_facility_class_for_sector_supply' USING ERRCODE = '23514';
    END IF;
    IF v_fac.status <> 'active' THEN
      RAISE EXCEPTION 'health_center_facility_not_active' USING ERRCODE = '23514';
    END IF;

    -- Same IDOR gate Branch A applies: a caller naming a destination
    -- organization must name the right one.
    IF p_destination_organization_id IS NOT NULL
       AND v_dst.organization_id IS DISTINCT FROM p_destination_organization_id THEN
      RAISE EXCEPTION 'destination_warehouse_not_in_named_organization' USING ERRCODE = '42501';
    END IF;

    o_source_organization_id      := v_src.organization_id;
    o_destination_organization_id := v_dst.organization_id;
    RETURN;
  END IF;

  -- ── BRANCH A · EXISTING CENTRAL SUPPLY (verbatim 077 behaviour) ────────────
  IF v_src.warehouse_kind <> 'central' OR v_src.status <> 'active' THEN
    RAISE EXCEPTION 'source_must_be_active_central_warehouse' USING ERRCODE = '23514';
  END IF;
  IF v_dst.warehouse_kind <> 'institution' OR v_dst.status <> 'active' THEN
    RAISE EXCEPTION 'destination_must_be_active_institution_warehouse' USING ERRCODE = '23514';
  END IF;

  -- The destination warehouse must belong to the institution the caller named —
  -- closes the IDOR of pinning a warehouse to the wrong organization.
  IF p_destination_organization_id IS NOT NULL
     AND v_dst.organization_id IS DISTINCT FROM p_destination_organization_id THEN
    RAISE EXCEPTION 'destination_warehouse_not_in_named_organization' USING ERRCODE = '42501';
  END IF;

  o_source_organization_id      := v_src.organization_id;
  o_destination_organization_id := v_dst.organization_id;
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_assert_direct_supply_endpoints(uuid, uuid, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_assert_direct_supply_endpoints(uuid, uuid, uuid)
  TO authenticated;

COMMENT ON FUNCTION public.phoenix_assert_direct_supply_endpoints(uuid, uuid, uuid) IS
  'SECTOR-HEALTH-CENTER-SUPPLY-165: fail-closed direct-supply endpoint validator '
  'with exactly TWO legal branches and no generic third. A) the original '
  'central -> institution corridor, byte-semantic with 077 including its error '
  'identifiers and IDOR gate. B) sector-level institution warehouse '
  '(facility_id IS NULL) -> warehouse of an ACTIVE primary/subordinate '
  'health-centre facility (facility_id IS NOT NULL), inside ONE health_sector '
  'organization. There is no "institution -> institution if same organization" '
  'predicate. Both warehouse rows and the facility row are locked FOR SHARE so a '
  'concurrent deactivation cannot slip past.';

-- ============================================================================
-- 2. RETURN — phoenix_assert_direct_return_endpoints
-- ============================================================================
-- PARAMETER NAMES ARE LEGACY AND DELIBERATELY UNCHANGED. Read them as:
--   p_institution_warehouse_id -> the RETURN SOURCE      (holder of the stock)
--   p_central_warehouse_id     -> the RETURN DESTINATION (receives it back)
-- CREATE OR REPLACE cannot rename parameters, and all four callers select the
-- OUT columns by name.
--
-- BRANCH A · EXISTING_INSTITUTION_TO_CENTRAL_RETURN (verbatim from 077)
-- BRANCH B · NEW_HEALTH_CENTER_TO_PARENT_SECTOR_RETURN
--
-- Branch B's ten conjuncts:
--    1. src.warehouse_kind         = 'institution'
--    2. src.status                 = 'active'
--    3. src.facility_id           IS NOT NULL    (facility-owned source)
--    4. src_facility.status        = 'active'
--    5. src_facility.facility_class IN ('primary_health_center','subordinate_health_center')
--    6. src_facility.organization_id = src.organization_id
--    7. dst.warehouse_kind         = 'institution'
--    8. dst.status                 = 'active'
--    9. dst.facility_id           IS NULL        (sector-level destination)
--   10. dst_org.institution_class   = 'health_sector'
--       AND src.organization_id      = dst.organization_id
--       AND src.id                  <> dst.id
--
-- The PROVENANCE test is shared by both branches and is unchanged: a real
-- DIRECT (route_id IS NULL) forward transfer must already have gone
-- destination -> source. For Branch B that reads "the sector depot really did
-- supply this health-centre depot", which is exactly the required guarantee.
CREATE OR REPLACE FUNCTION public.phoenix_assert_direct_return_endpoints(
  p_institution_warehouse_id uuid,   -- return SOURCE
  p_central_warehouse_id     uuid,   -- return DESTINATION
  OUT o_institution_organization_id uuid,
  OUT o_central_organization_id     uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inst public.warehouses%ROWTYPE;
  v_cent public.warehouses%ROWTYPE;
  v_dst_class text;
  v_fac public.organization_facilities%ROWTYPE;
BEGIN
  IF p_institution_warehouse_id IS NULL OR p_central_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'source_and_destination_required' USING ERRCODE = '23514';
  END IF;
  IF p_institution_warehouse_id = p_central_warehouse_id THEN
    RAISE EXCEPTION 'source_and_destination_must_differ' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_inst FROM public.warehouses WHERE id = p_institution_warehouse_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'source_warehouse_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_cent FROM public.warehouses WHERE id = p_central_warehouse_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'destination_warehouse_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- ── BRANCH B · HEALTH-CENTRE -> PARENT SECTOR RETURN ───────────────────────
  -- Shape test (conjuncts 1, 3, 7, 9, and same-organization) selects this
  -- branch: a facility-owned institution source returning to a sector-level
  -- institution destination inside one organization. Impossible before 164.
  IF v_inst.warehouse_kind = 'institution'
     AND v_cent.warehouse_kind = 'institution'
     AND v_inst.facility_id IS NOT NULL
     AND v_cent.facility_id IS NULL
     AND v_inst.organization_id = v_cent.organization_id
  THEN
    IF v_inst.status <> 'active' THEN
      RAISE EXCEPTION 'health_center_warehouse_not_active' USING ERRCODE = '23514';
    END IF;
    IF v_cent.status <> 'active' THEN
      RAISE EXCEPTION 'sector_destination_warehouse_not_active' USING ERRCODE = '23514';
    END IF;

    SELECT o.institution_class INTO v_dst_class
    FROM public.organizations o WHERE o.id = v_cent.organization_id FOR SHARE;
    IF v_dst_class IS NULL THEN
      RAISE EXCEPTION 'organization_institution_class_required' USING ERRCODE = '23514';
    END IF;
    IF v_dst_class <> 'health_sector' THEN
      RAISE EXCEPTION 'sector_return_requires_health_sector' USING ERRCODE = '23514';
    END IF;

    SELECT * INTO v_fac
    FROM public.organization_facilities f WHERE f.id = v_inst.facility_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'source_facility_not_found' USING ERRCODE = 'P0002';
    END IF;
    IF v_fac.organization_id IS DISTINCT FROM v_inst.organization_id THEN
      RAISE EXCEPTION 'facility_not_in_source_organization' USING ERRCODE = '42501';
    END IF;
    IF v_fac.facility_class NOT IN ('primary_health_center', 'subordinate_health_center') THEN
      RAISE EXCEPTION 'invalid_facility_class_for_sector_return' USING ERRCODE = '23514';
    END IF;
    IF v_fac.status <> 'active' THEN
      RAISE EXCEPTION 'health_center_facility_not_active' USING ERRCODE = '23514';
    END IF;

    -- PROVENANCE, unchanged in shape: a real DIRECT forward transfer must have
    -- gone sector -> this health centre. Without it there is nothing to return.
    IF NOT EXISTS (
      SELECT 1 FROM public.warehouse_transfers tr
      WHERE tr.route_id IS NULL
        AND tr.source_warehouse_id = p_central_warehouse_id
        AND tr.destination_warehouse_id = p_institution_warehouse_id
    ) THEN
      RAISE EXCEPTION 'no_direct_forward_provenance_between_warehouses' USING ERRCODE = '42501';
    END IF;

    o_institution_organization_id := v_inst.organization_id;
    o_central_organization_id     := v_cent.organization_id;
    RETURN;
  END IF;

  -- ── BRANCH A · EXISTING INSTITUTION -> CENTRAL RETURN (verbatim 077) ───────
  IF v_inst.warehouse_kind <> 'institution' OR v_inst.status <> 'active' THEN
    RAISE EXCEPTION 'source_must_be_active_institution_warehouse' USING ERRCODE = '23514';
  END IF;
  IF v_cent.warehouse_kind <> 'central' OR v_cent.status <> 'active' THEN
    RAISE EXCEPTION 'destination_must_be_active_central_warehouse' USING ERRCODE = '23514';
  END IF;

  -- PROVENANCE: a real direct forward transfer must have connected these two
  -- warehouses. This is what the composite route FK gave the routed path, here
  -- derived from the movement history instead of a pre-approved route.
  IF NOT EXISTS (
    SELECT 1 FROM public.warehouse_transfers tr
    WHERE tr.route_id IS NULL
      AND tr.source_warehouse_id = p_central_warehouse_id
      AND tr.destination_warehouse_id = p_institution_warehouse_id
  ) THEN
    RAISE EXCEPTION 'no_direct_forward_provenance_between_warehouses' USING ERRCODE = '42501';
  END IF;

  o_institution_organization_id := v_inst.organization_id;
  o_central_organization_id     := v_cent.organization_id;
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_assert_direct_return_endpoints(uuid, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_assert_direct_return_endpoints(uuid, uuid)
  TO authenticated;

COMMENT ON FUNCTION public.phoenix_assert_direct_return_endpoints(uuid, uuid) IS
  'SECTOR-HEALTH-CENTER-RETURN-165: fail-closed direct-return endpoint validator '
  'with exactly TWO legal branches and no generic third. PARAMETER NAMES ARE '
  'LEGACY: p_institution_warehouse_id is the RETURN SOURCE and '
  'p_central_warehouse_id is the RETURN DESTINATION (CREATE OR REPLACE cannot '
  'rename parameters, and every caller selects the OUT columns by name). '
  'A) the original institution -> central return, byte-semantic with 077. '
  'B) warehouse of an ACTIVE primary/subordinate health-centre facility -> the '
  'sector-level warehouse (facility_id IS NULL) inside ONE health_sector '
  'organization. Both branches require the SAME unchanged provenance proof: a '
  'real direct (route_id IS NULL) forward transfer destination -> source.';

-- ============================================================================
-- 3. VERIFY — fail closed inside the same transaction
-- ============================================================================
DO $verify$
DECLARE
  v_fwd text;
  v_ret text;
BEGIN
  IF to_regprocedure('public.phoenix_assert_direct_supply_endpoints(uuid,uuid,uuid)') IS NULL
     OR to_regprocedure('public.phoenix_assert_direct_return_endpoints(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (165): a validator is missing after replacement';
  END IF;

  v_fwd := pg_get_functiondef('public.phoenix_assert_direct_supply_endpoints(uuid,uuid,uuid)'::regprocedure);
  v_ret := pg_get_functiondef('public.phoenix_assert_direct_return_endpoints(uuid,uuid)'::regprocedure);

  -- Signatures (including OUT parameter NAMES, which callers select by name)
  -- must be byte-identical to what 077 established.
  IF pg_get_function_arguments('public.phoenix_assert_direct_supply_endpoints(uuid,uuid,uuid)'::regprocedure)
     <> 'p_source_warehouse_id uuid, p_destination_warehouse_id uuid, p_destination_organization_id uuid, OUT o_source_organization_id uuid, OUT o_destination_organization_id uuid' THEN
    RAISE EXCEPTION 'VERIFY FAILED (165): forward validator signature changed';
  END IF;
  IF pg_get_function_arguments('public.phoenix_assert_direct_return_endpoints(uuid,uuid)'::regprocedure)
     <> 'p_institution_warehouse_id uuid, p_central_warehouse_id uuid, OUT o_institution_organization_id uuid, OUT o_central_organization_id uuid' THEN
    RAISE EXCEPTION 'VERIFY FAILED (165): return validator signature changed';
  END IF;

  -- Branch A error identifiers must all survive.
  IF v_fwd NOT LIKE '%source_must_be_active_central_warehouse%'
     OR v_fwd NOT LIKE '%destination_must_be_active_institution_warehouse%'
     OR v_fwd NOT LIKE '%destination_warehouse_not_in_named_organization%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (165): forward Branch A error identifiers lost';
  END IF;
  IF v_ret NOT LIKE '%source_must_be_active_institution_warehouse%'
     OR v_ret NOT LIKE '%destination_must_be_active_central_warehouse%'
     OR v_ret NOT LIKE '%no_direct_forward_provenance_between_warehouses%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (165): return Branch A error identifiers lost';
  END IF;

  -- Both must remain SECURITY DEFINER with a pinned search_path.
  IF v_fwd NOT LIKE '%SECURITY DEFINER%' OR v_ret NOT LIKE '%SECURITY DEFINER%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (165): a validator is no longer SECURITY DEFINER';
  END IF;

  -- NO generic same-organization shortcut may exist: every new branch must pin
  -- facility_id on BOTH endpoints.
  IF v_fwd NOT LIKE '%facility_id IS NULL%' OR v_fwd NOT LIKE '%facility_id IS NOT NULL%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (165): forward Branch B is not facility-pinned';
  END IF;
  IF v_ret NOT LIKE '%facility_id IS NULL%' OR v_ret NOT LIKE '%facility_id IS NOT NULL%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (165): return Branch B is not facility-pinned';
  END IF;

  -- NON-REGRESSION: 165 alters no schema at all.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='warehouses' AND column_name='facility_kind'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (165): warehouses.facility_kind must not exist';
  END IF;
  IF (SELECT count(*) FROM pg_class
      WHERE relname IN ('pharmacy_stock','rescue_cart_stock','crash_cabinet_stock','facility_stock')) <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (165): a second balance ledger exists';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='outlet_stock_movements_type_chk')
     LIKE '%replenish%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (165): outlet movement vocabulary changed in E-3';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='warehouses_warehouse_kind_chk')
     LIKE '%health_center%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (165): warehouse_kind was widened';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.item_availability'::regclass
      AND pg_get_constraintdef(oid) LIKE '%near_stockout%'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (165): Availability vocabulary changed';
  END IF;

  -- NOTE ON DATA: this migration performs NO INSERT/UPDATE/DELETE of any kind —
  -- it replaces two function bodies and nothing else. That is asserted
  -- STATICALLY against this file's own text, deliberately NOT by inspecting
  -- live rows here: classification of real organizations is a separately-gated
  -- rollout that may legitimately have happened before 165 is applied, and a
  -- global data-state assertion would then block a migration that changes no
  -- data at all.

  RAISE NOTICE '165 VERIFY OK.';
END;
$verify$;

COMMIT;

-- ============================================================================
-- ROLLBACK (manual): re-apply migration 077's section 2 and section 7a bodies
-- verbatim to restore the single-branch validators. 165 adds no schema object,
-- so there is nothing else to undo.
-- ============================================================================
-- END OF MIGRATION 165
-- ============================================================================
