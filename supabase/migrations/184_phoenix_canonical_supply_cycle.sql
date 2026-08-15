-- ============================================================================
-- 184 - PHOENIX CANONICAL SUPPLY CYCLE (R1.3)
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
--
-- Production DDL is applied ONCE, after 183, by the authorized operator through
-- `Supabase.apply_migration`, following an exact-ceiling preflight, the
-- read-only vocabulary and Branch-B preflight this migration performs for
-- itself (section 0), and independent approval. `supabase db push` remains
-- forbidden outright. (Historical migrations carry older apply wording in their
-- own headers and are NOT edited to match - they are immutable.)
--
-- NOT APPLIED BY THIS PR. Authored and replayed on a disposable PostgreSQL rig
-- only. Migrations 001-183 are immutable and are NOT edited here.
--
-- R1.3 closes the last server-side topology gaps in the supply cycle. Every
-- change here is FORWARD-ONLY: migrations 001-183 are immutable, so the narrow
-- set of canonical functions is replaced in place rather than edited upstream.
--
-- WHAT WAS OPEN BEFORE THIS MIGRATION
-- ---------------------------------------------------------------------------
-- 165 established the two direct-corridor validators with exactly two branches
-- each. Branch B (same-sector: sector main -> health-centre depot) is precise.
-- Branch A was NOT: it accepted any destination that was merely
--
--     warehouse_kind = 'institution' AND status = 'active'
--
-- Because Branch B's SHAPE test requires an INSTITUTION source, a CENTRAL
-- source can never select it and always falls through to Branch A. The result
-- is that `central warehouse -> facility-bound Health Center depot` was a legal
-- server-side write. The same hole exists symmetrically on the return side:
-- a facility-bound centre depot was treated as an ordinary institution root
-- returning straight to central.
--
-- 087's phoenix_procurement_create_order carried the identical weakness: any
-- active institution warehouse could be a local-procurement entry root, so a
-- health sector could open a purchase order directly into a Health Center
-- depot instead of its Sector Main.
--
-- WHAT R1.3 REQUIRES
-- ---------------------------------------------------------------------------
-- Canonical forward topology for EXTERNAL central supply:
--
--     central warehouse -> Hospital institution warehouse
--                       -> Specialized Center institution warehouse
--                       -> Health Sector MAIN warehouse (facility_id IS NULL)
--
--   FORBIDDEN: central warehouse -> Health Center facility-bound depot.
--
-- The Health Center depot is reached ONLY by Branch B, from its own Sector
-- Main. Branch B is preserved here byte-for-byte in behaviour.
--
-- HOW THIS MIGRATION IS SHAPED
-- ---------------------------------------------------------------------------
-- ONE canonical capsule answers ONE question, and every caller delegates to it
-- instead of re-deciding. There is deliberately no second trigger matrix and no
-- parallel copy of the rule:
--
--   _phoenix_assert_external_corridor_institution_root_v1
--       "is this warehouse a legal EXTERNAL-CORRIDOR institution root?"
--       -> used by supply Branch A (destination) and return Branch A (source)
--
--   _phoenix_assert_local_procurement_root_v1
--       "may local procurement enter this warehouse?"
--       -> used by phoenix_procurement_create_order
--
-- All EIGHT direct-corridor RPC paths already funnel through the two validators
-- (077: create_direct_warehouse_transfer_request,
-- _phoenix_authorize_transfer_request_write, review_warehouse_transfer_request,
-- send_direct_warehouse_transfer_line, request_direct_warehouse_return,
-- recall_direct_warehouse_transfer, submit_warehouse_return_request,
-- send_direct_warehouse_return_shipment_line), so replacing the two validators
-- closes every RPC path at once.
--
-- It does NOT, on its own, close a RAW write. _phoenix_authorize_transfer_request_
-- write is a plain function five RPCs PERFORM - not a trigger - so nothing
-- validates a row that arrives on the table without passing through an RPC.
-- That is why section 5d attaches the boundary to the TABLES and judges BOTH
-- corridors there: the routed one against the capsule, the direct one against
-- the very validator the RPCs use.
--
-- HISTORY IS PRESERVED
-- ---------------------------------------------------------------------------
-- This migration adds no data DML and rewrites no historical row. Existing
-- warehouse_transfers / warehouse_transfer_requests rows keep their exact
-- shape. The preflight COUNTS legacy rows that the new rule would forbid and
-- reports them as a NOTICE - it deliberately does NOT abort on them, because a
-- historical row is evidence about the past, not a live authorization. Only
-- NEW writes and activations must obey the narrowed topology.
--
-- LEGACY INTER-ORG EXCHANGE
-- ---------------------------------------------------------------------------
-- phoenix_update_inter_org_exchange_status still contains a direct
-- `UPDATE public.item_availability SET quantity = ...` at its completed
-- transition (041). Migration 153 already retired it by revoking every external
-- EXECUTE path, leaving owner-only execution, and no other function calls it -
-- so that third stock writer is already unreachable from anon, authenticated
-- and service_role. R1.3 does not resurrect it and does not invent a second
-- exchange workflow. It RE-ASSERTS the revoke so a future DROP+CREATE cannot
-- silently re-acquire EXECUTE through 109's ALTER DEFAULT PRIVILEGES, and
-- verifies the closure in the same transaction.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 0. PREFLIGHT - fail closed before touching anything
-- ============================================================================
DO $preflight$
DECLARE
  v_supply_sig constant text :=
    'public.phoenix_assert_direct_supply_endpoints(uuid,uuid,uuid)';
  v_return_sig constant text :=
    'public.phoenix_assert_direct_return_endpoints(uuid,uuid)';
  v_procurement_sig constant text :=
    'public.phoenix_procurement_create_order(uuid,uuid,text,text,date,text,text,text,boolean)';
  v_exchange_sig constant text :=
    'public.phoenix_update_inter_org_exchange_status(uuid,text,integer,integer,text,text)';
  v_route_sig constant text :=
    'public.phoenix_supply_route_assert_endpoints(uuid,uuid)';

  v_classes text[];
  v_kinds text[];
  v_legacy_forward bigint;
  v_legacy_return bigint;
  v_legacy_active_routes bigint;
BEGIN
  IF to_regprocedure(v_supply_sig) IS NULL THEN
    RAISE EXCEPTION '184_precondition_failed: % is absent', v_supply_sig;
  END IF;
  IF to_regprocedure(v_return_sig) IS NULL THEN
    RAISE EXCEPTION '184_precondition_failed: % is absent', v_return_sig;
  END IF;
  IF to_regprocedure(v_procurement_sig) IS NULL THEN
    RAISE EXCEPTION '184_precondition_failed: % is absent', v_procurement_sig;
  END IF;
  IF to_regprocedure(v_exchange_sig) IS NULL THEN
    RAISE EXCEPTION '184_precondition_failed: % is absent', v_exchange_sig;
  END IF;
  IF to_regprocedure(v_route_sig) IS NULL THEN
    RAISE EXCEPTION '184_precondition_failed: % is absent', v_route_sig;
  END IF;

  -- Every table whose write boundary this migration installs.
  IF to_regclass('public.procurement_orders') IS NULL
     OR to_regclass('public.warehouse_supply_routes') IS NULL
     OR to_regclass('public.warehouse_transfer_requests') IS NULL
     OR to_regclass('public.warehouse_transfers') IS NULL
     OR to_regclass('public.warehouse_return_requests') IS NULL
     OR to_regclass('public.warehouse_return_shipments') IS NULL THEN
    RAISE EXCEPTION
      '184_precondition_failed: a table this migration guards is absent';
  END IF;

  -- The MOVEMENT tables must still carry route_id, because the boundaries on
  -- them are scoped to routed rows exactly as the request-table ones are. This
  -- is the real invariant the guards depend on; the identity of whichever
  -- function currently performs the routed send is not (127 wrote it, 150
  -- forward-replaced it, and a later migration may again).
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'warehouse_transfers'
      AND column_name = 'route_id' AND is_nullable = 'YES'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'warehouse_return_shipments'
      AND column_name = 'route_id' AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION
      '184_precondition_failed: a movement table no longer carries a NULLABLE route_id, so routed and direct rows cannot be told apart';
  END IF;

  -- Both request tables must still distinguish routed from direct by route_id,
  -- because section 5d's boundaries are scoped to the ROUTED rows only and
  -- would otherwise silently judge (and refuse) Branch B.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'warehouse_transfer_requests'
      AND column_name = 'route_id' AND is_nullable = 'YES'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'warehouse_return_requests'
      AND column_name = 'route_id' AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION
      '184_precondition_failed: a request table no longer carries a NULLABLE route_id, so routed and direct rows cannot be told apart';
  END IF;

  -- The routed corridor really does skip the direct validator. If this branch
  -- ever disappears, section 5c is reasoning about a bypass that no longer
  -- exists and must be re-derived rather than left in place.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = '_phoenix_authorize_transfer_request_write'
      AND p.prosrc LIKE '%route_id IS NULL%'
  ) THEN
    RAISE EXCEPTION
      '184_precondition_failed: the transfer-request authorizer no longer branches on route_id';
  END IF;

  -- Branch B must still be the facility-less-institution-source shape this
  -- migration is about to preserve. If 165's Branch B has drifted, the
  -- replacement below would be reasoning about a corridor that no longer
  -- exists.
  IF pg_get_functiondef(v_supply_sig::regprocedure) NOT LIKE '%v_src.facility_id IS NULL%' THEN
    RAISE EXCEPTION
      '184_precondition_failed: supply Branch B no longer expects a facility-less institution source';
  END IF;
  IF pg_get_functiondef(v_return_sig::regprocedure) NOT LIKE '%v_cent.facility_id IS NULL%' THEN
    RAISE EXCEPTION
      '184_precondition_failed: return Branch B no longer expects a facility-less sector destination';
  END IF;

  -- warehouses.facility_id is what makes "facility-bound" expressible at all.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'warehouses' AND column_name = 'facility_id'
  ) THEN
    RAISE EXCEPTION '184_precondition_failed: warehouses.facility_id is absent (apply 164 first)';
  END IF;

  -- The two class VOCABULARIES this migration hard-codes must be exactly the
  -- reviewed ones: a widened CHECK would silently widen the corridor. The
  -- vocabulary is DERIVED from the live constraint rather than string-matched
  -- against a pretty-printed definition, because the pretty-printer's
  -- parenthesisation is a formatting detail, not a contract (153 derives its
  -- status vocabulary the same way, for the same reason).
  SELECT array_agg(DISTINCT captures[1] ORDER BY captures[1])
    INTO v_classes
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  CROSS JOIN LATERAL regexp_matches(
    pg_get_constraintdef(c.oid, true), '''([^'']+)''', 'g'
  ) AS matches(captures)
  WHERE n.nspname = 'public'
    AND t.relname = 'organizations'
    AND c.conname = 'organizations_institution_class_chk';

  IF v_classes IS DISTINCT FROM
     ARRAY['health_sector', 'hospital', 'specialized_center']::text[] THEN
    RAISE EXCEPTION
      '184_precondition_failed: institution_class vocabulary drift; expected %, found %',
      ARRAY['health_sector', 'hospital', 'specialized_center']::text[],
      COALESCE(v_classes, ARRAY[]::text[]);
  END IF;

  SELECT array_agg(DISTINCT captures[1] ORDER BY captures[1])
    INTO v_kinds
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  CROSS JOIN LATERAL regexp_matches(
    pg_get_constraintdef(c.oid, true), '''([^'']+)''', 'g'
  ) AS matches(captures)
  WHERE n.nspname = 'public'
    AND t.relname = 'organizations'
    AND c.conname = 'organizations_organization_kind_chk';

  IF v_kinds IS DISTINCT FROM
     ARRAY['care_institution', 'pharmacy_department_authority']::text[] THEN
    RAISE EXCEPTION
      '184_precondition_failed: organization_kind vocabulary drift; expected %, found %',
      ARRAY['care_institution', 'pharmacy_department_authority']::text[],
      COALESCE(v_kinds, ARRAY[]::text[]);
  END IF;

  -- HISTORY REPORT ONLY. Never an abort: a legacy row records what happened,
  -- and 184 narrows what may happen NEXT. Aborting here would make the
  -- migration chain unappliable against any environment that already carries
  -- a legacy shape, which is exactly the failure mode R1.2C hit.
  SELECT count(*) INTO v_legacy_forward
  FROM public.warehouse_transfers tr
  JOIN public.warehouses src ON src.id = tr.source_warehouse_id
  JOIN public.warehouses dst ON dst.id = tr.destination_warehouse_id
  WHERE tr.route_id IS NULL
    AND src.warehouse_kind = 'central'
    AND dst.facility_id IS NOT NULL;

  SELECT count(*) INTO v_legacy_return
  FROM public.warehouse_transfers tr
  JOIN public.warehouses src ON src.id = tr.source_warehouse_id
  JOIN public.warehouses dst ON dst.id = tr.destination_warehouse_id
  WHERE tr.route_id IS NULL
    AND src.facility_id IS NOT NULL
    AND dst.warehouse_kind = 'central';

  -- A legacy ACTIVE route is not history - it is a live standing authorization
  -- for a shape this migration forbids. It is NOT rewritten here (that would be
  -- rewriting stored state), but it IS reported, because the operator must know
  -- the routed corridor carried one. Section 5d makes such a route unusable at
  -- USE time in both directions.
  SELECT count(*) INTO v_legacy_active_routes
  FROM public.warehouse_supply_routes r
  JOIN public.warehouses w ON w.id = r.target_warehouse_id
  WHERE r.is_active
    AND w.facility_id IS NOT NULL;

  RAISE NOTICE
    '184 preflight: legacy central->facility direct transfers=%, facility->central direct transfers=%, ACTIVE routes targeting a facility-bound depot=% (all preserved, not rewritten; the routed corridor is closed at use time by section 5d)',
    v_legacy_forward, v_legacy_return, v_legacy_active_routes;
END;
$preflight$;

-- ============================================================================
-- 1. CAPSULE - the EXTERNAL-CORRIDOR institution root
-- ============================================================================
-- ONE decision, shared by supply Branch A (as the destination) and return
-- Branch A (as the source). A warehouse is a legal external-corridor root only
-- when ALL of the following hold:
--
--   1. it is an institution warehouse
--   2. it is active
--   3. facility_id IS NULL          <- R1.3: never a Health Center depot
--   4. its organization is a CARE INSTITUTION (never the Pharmacy Department
--      Authority, which supplies the network and is not a destination in it)
--   5. its organization carries an institution_class
--   6. that class is hospital | specialized_center | health_sector
--
-- Conjuncts 1-2 keep 077/165's ORIGINAL error identifiers so every existing
-- caller, test and client-side error map continues to read the same strings.
-- Conjuncts 3-6 are the R1.3 narrowing and carry new, distinct identifiers.
--
-- The warehouse and organization rows are locked FOR SHARE, matching 165, so a
-- concurrent deactivation or reclassification cannot slip past between the
-- check and the write.
CREATE OR REPLACE FUNCTION public._phoenix_assert_external_corridor_institution_root_v1(
  p_warehouse_id   uuid,
  p_endpoint_role  text,
  OUT o_organization_id  uuid,
  OUT o_institution_class text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_wh  public.warehouses%ROWTYPE;
  v_org public.organizations%ROWTYPE;
  v_not_found_id      text;
  v_not_institution_id text;
  v_facility_bound_id  text;
BEGIN
  IF p_endpoint_role = 'supply_destination' THEN
    v_not_found_id       := 'destination_warehouse_not_found';
    v_not_institution_id := 'destination_must_be_active_institution_warehouse';
    v_facility_bound_id  := 'central_supply_destination_must_not_be_facility_bound';
  ELSIF p_endpoint_role = 'return_source' THEN
    v_not_found_id       := 'source_warehouse_not_found';
    v_not_institution_id := 'source_must_be_active_institution_warehouse';
    v_facility_bound_id  := 'central_return_source_must_not_be_facility_bound';
  ELSE
    RAISE EXCEPTION 'invalid_external_corridor_endpoint_role' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_wh FROM public.warehouses WHERE id = p_warehouse_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '%', v_not_found_id USING ERRCODE = 'P0002';
  END IF;

  -- ORIGINAL 077/165 identifier, deliberately unchanged.
  IF v_wh.warehouse_kind <> 'institution' OR v_wh.status <> 'active' THEN
    RAISE EXCEPTION '%', v_not_institution_id USING ERRCODE = '23514';
  END IF;

  -- R1.3: a facility-bound Health Center depot is reachable ONLY from its own
  -- Sector Main (Branch B), never from / to the external central corridor.
  IF v_wh.facility_id IS NOT NULL THEN
    RAISE EXCEPTION '%', v_facility_bound_id USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_org FROM public.organizations WHERE id = v_wh.organization_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'external_corridor_organization_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- The Pharmacy Department Authority supplies the network; it is never an
  -- endpoint inside it.
  IF v_org.organization_kind <> 'care_institution' THEN
    RAISE EXCEPTION 'external_corridor_requires_care_institution' USING ERRCODE = '23514';
  END IF;

  -- Reuses 165's identifier for the NULL case so the sector branch and the
  -- external branch report an unclassified organization identically.
  IF v_org.institution_class IS NULL THEN
    RAISE EXCEPTION 'organization_institution_class_required' USING ERRCODE = '23514';
  END IF;

  IF v_org.institution_class NOT IN ('hospital', 'specialized_center', 'health_sector') THEN
    RAISE EXCEPTION 'external_corridor_institution_class_not_permitted' USING ERRCODE = '23514';
  END IF;

  o_organization_id   := v_wh.organization_id;
  o_institution_class := v_org.institution_class;
END;
$$;

REVOKE ALL ON FUNCTION public._phoenix_assert_external_corridor_institution_root_v1(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public._phoenix_assert_external_corridor_institution_root_v1(uuid, text) IS
  'CANONICAL-SUPPLY-CYCLE-184: THE single decision for "is this warehouse a '
  'legal external-corridor institution root?". Shared by direct-supply Branch A '
  '(as supply_destination) and direct-return Branch A (as return_source) so the '
  'forward and reverse corridors can never disagree. Requires an ACTIVE '
  'institution warehouse with facility_id IS NULL, owned by a care_institution '
  'organization whose institution_class is hospital, specialized_center or '
  'health_sector. Conjuncts 1-2 preserve 077/165 error identifiers verbatim; '
  'the R1.3 narrowing carries its own distinct identifiers. Internal: no '
  'external EXECUTE - it is reached only through the two validators.';

-- ============================================================================
-- 2. CAPSULE - the LOCAL-PROCUREMENT root
-- ============================================================================
-- Local procurement is an INTERNAL institution capability, not a corridor, so
-- its rule is deliberately narrower than the external one and is scoped to the
-- single class that owns facilities:
--
--   institution_class = 'health_sector'  ->  entry ONLY at the Sector Main
--                                            (facility_id IS NULL)
--   every other class                    ->  unchanged 087 behaviour
--
-- Hospitals and specialized centers therefore keep their ordinary institution
-- warehouse procurement behaviour exactly as 087 defined it. A Health Center
-- depot is never a procurement entry root: stock reaches it from its Sector
-- Main through Branch B, which is what keeps sector purchasing accountable at
-- one place instead of fragmenting across centres.
CREATE OR REPLACE FUNCTION public._phoenix_assert_local_procurement_root_v1(
  p_warehouse_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_wh  public.warehouses%ROWTYPE;
  v_org public.organizations%ROWTYPE;
BEGIN
  SELECT * INTO v_wh FROM public.warehouses WHERE id = p_warehouse_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- ORIGINAL 087 identifier, deliberately unchanged.
  IF v_wh.warehouse_kind <> 'institution' OR v_wh.status <> 'active' THEN
    RAISE EXCEPTION 'destination_must_be_active_institution_warehouse' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_org FROM public.organizations WHERE id = v_wh.organization_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'procurement_organization_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_org.institution_class = 'health_sector' AND v_wh.facility_id IS NOT NULL THEN
    RAISE EXCEPTION 'local_procurement_root_must_be_sector_main' USING ERRCODE = '23514';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public._phoenix_assert_local_procurement_root_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public._phoenix_assert_local_procurement_root_v1(uuid) IS
  'CANONICAL-SUPPLY-CYCLE-184: THE single decision for "may local procurement '
  'enter this warehouse?". For a health_sector organization the entry root must '
  'be the Sector Main (facility_id IS NULL) - a facility-bound Health Center '
  'depot is refused with local_procurement_root_must_be_sector_main. Every '
  'other institution_class keeps 087 behaviour unchanged. Internal: no external '
  'EXECUTE - it is reached only through phoenix_procurement_create_order.';

-- ============================================================================
-- 3. FORWARD-REPLACE - phoenix_assert_direct_supply_endpoints
-- ============================================================================
-- Branch B is reproduced with its 165 behaviour intact, conjunct for conjunct.
-- Branch A now delegates its destination decision to the capsule.
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

  -- -- BRANCH B - SAME-SECTOR HEALTH-CENTRE SUPPLY (165, preserved) ----------
  -- The SHAPE test (institution source with no facility, institution
  -- destination that has one, inside one organization) selects this branch. A
  -- CENTRAL source can never satisfy it, which is precisely why Branch A had
  -- to be narrowed rather than relying on branch ordering.
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

    IF p_destination_organization_id IS NOT NULL
       AND v_dst.organization_id IS DISTINCT FROM p_destination_organization_id THEN
      RAISE EXCEPTION 'destination_warehouse_not_in_named_organization' USING ERRCODE = '42501';
    END IF;

    o_source_organization_id      := v_src.organization_id;
    o_destination_organization_id := v_dst.organization_id;
    RETURN;
  END IF;

  -- -- BRANCH A - EXTERNAL CENTRAL SUPPLY (R1.3-A narrowed) ------------------
  IF v_src.warehouse_kind <> 'central' OR v_src.status <> 'active' THEN
    RAISE EXCEPTION 'source_must_be_active_central_warehouse' USING ERRCODE = '23514';
  END IF;

  -- THE canonical destination decision. Raises with 077/165's original
  -- identifier when the destination is not an active institution warehouse,
  -- and with an R1.3 identifier when it is one but not a legal corridor root
  -- (facility-bound depot, PDA-owned, or unclassified).
  PERFORM public._phoenix_assert_external_corridor_institution_root_v1(
    p_destination_warehouse_id, 'supply_destination'
  );

  -- The destination warehouse must belong to the institution the caller named -
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
  'CANONICAL-SUPPLY-CYCLE-184: fail-closed direct-supply endpoint validator with '
  'exactly TWO legal branches and no generic third. A) EXTERNAL CENTRAL SUPPLY: '
  'active central source -> external-corridor institution root, delegated whole '
  'to _phoenix_assert_external_corridor_institution_root_v1, so a facility-bound '
  'Health Center depot, a Pharmacy Department Authority destination and an '
  'unclassified organization are all refused. B) SAME-SECTOR SUPPLY, preserved '
  'from 165: sector-level institution warehouse (facility_id IS NULL) -> '
  'warehouse of an ACTIVE primary/subordinate health-centre facility inside ONE '
  'health_sector organization. There is no "institution -> institution if same '
  'organization" predicate. The IDOR gate and FOR SHARE locking are unchanged.';

-- ============================================================================
-- 4. FORWARD-REPLACE - phoenix_assert_direct_return_endpoints
-- ============================================================================
-- PARAMETER NAMES ARE LEGACY AND DELIBERATELY UNCHANGED. Read them as:
--   p_institution_warehouse_id -> the RETURN SOURCE      (holder of the stock)
--   p_central_warehouse_id     -> the RETURN DESTINATION (receives it back)
-- CREATE OR REPLACE cannot rename parameters, and all four callers select the
-- OUT columns by name.
--
-- Branch B (centre depot -> its own Sector Main, with forward provenance) is
-- preserved from 165. Branch A is narrowed symmetrically with R1.3-A so that a
-- facility-bound centre depot is not treated as an ordinary institution root
-- returning to central: its only canonical return is to its own Sector Main.
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

  -- -- BRANCH B - HEALTH-CENTRE -> PARENT SECTOR RETURN (165, preserved) -----
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

  -- -- BRANCH A - EXTERNAL INSTITUTION -> CENTRAL RETURN (R1.3-D narrowed) ---
  -- THE canonical source decision, the exact mirror of supply Branch A: the
  -- same capsule, so the corridor a shipment may travel forward is the corridor
  -- it may travel back. A facility-bound centre depot is refused here and must
  -- use Branch B to its own Sector Main instead.
  PERFORM public._phoenix_assert_external_corridor_institution_root_v1(
    p_institution_warehouse_id, 'return_source'
  );

  IF v_cent.warehouse_kind <> 'central' OR v_cent.status <> 'active' THEN
    RAISE EXCEPTION 'destination_must_be_active_central_warehouse' USING ERRCODE = '23514';
  END IF;

  -- PROVENANCE, unchanged: a real direct forward transfer must have connected
  -- these two warehouses.
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
  'CANONICAL-SUPPLY-CYCLE-184: fail-closed direct-return endpoint validator with '
  'exactly TWO legal branches and no generic third. PARAMETER NAMES ARE LEGACY: '
  'p_institution_warehouse_id is the RETURN SOURCE and p_central_warehouse_id is '
  'the RETURN DESTINATION. A) EXTERNAL RETURN TO CENTRAL: the source must pass '
  '_phoenix_assert_external_corridor_institution_root_v1, the SAME capsule '
  'supply Branch A uses, so a facility-bound Health Center depot can no longer '
  'return directly to central. B) SAME-SECTOR RETURN, preserved from 165: '
  'health-centre depot -> its own Sector Main. BOTH branches keep the unchanged '
  'provenance proof: a real direct (route_id IS NULL) forward transfer '
  'destination -> source.';

-- ============================================================================
-- 5. FORWARD-REPLACE - phoenix_procurement_create_order
-- ============================================================================
-- Body reproduced from 087 with ONE addition: the canonical root capsule is
-- consulted immediately after the original kind/status check, before the IDOR
-- gate and before any write. Everything else - the scoped-permission gate, the
-- supplier resolution, the insert, the event log and the audit row - is
-- unchanged.
CREATE OR REPLACE FUNCTION public.phoenix_procurement_create_order(
  p_warehouse_id       uuid,
  p_supplier_id        uuid,
  p_order_number       text,
  p_invoice_number     text DEFAULT NULL,
  p_invoice_date       date DEFAULT NULL,
  p_external_reference text DEFAULT NULL,
  p_currency           text DEFAULT NULL,
  p_notes              text DEFAULT NULL,
  p_ocr_assisted       boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_actor_name text;
  v_wh         public.warehouses%ROWTYPE;
  v_supplier   public.procurement_suppliers%ROWTYPE;
  v_number     text := NULLIF(btrim(COALESCE(p_order_number, '')), '');
  v_order      public.procurement_orders%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_warehouse_id IS NULL OR p_supplier_id IS NULL THEN
    RAISE EXCEPTION 'warehouse_and_supplier_required' USING ERRCODE = '23514';
  END IF;
  IF v_number IS NULL THEN
    RAISE EXCEPTION 'order_number_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_wh FROM public.warehouses WHERE id = p_warehouse_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_wh.warehouse_kind <> 'institution' OR v_wh.status <> 'active' THEN
    RAISE EXCEPTION 'destination_must_be_active_institution_warehouse' USING ERRCODE = '23514';
  END IF;

  -- THE IDOR GATE: scoped authority on the PURCHASING warehouse.
  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'local_procurement.manage', v_wh.organization_id, p_warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_local_procurement_manage' USING ERRCODE = '42501';
  END IF;

  -- R1.3-C: THE canonical procurement-root decision. A health sector purchases
  -- into its Sector Main only; a Health Center depot is never an entry root.
  --
  -- Deliberately AFTER the IDOR gate: an actor with no scope on this warehouse
  -- must not be able to read its facility-boundness or organization class out
  -- of the refusal. Ordering costs nothing here because the procurement_orders
  -- write boundary (section 5b) enforces the same rule for every writer,
  -- including one that skipped this RPC entirely.
  PERFORM public._phoenix_assert_local_procurement_root_v1(p_warehouse_id);

  SELECT * INTO v_supplier
  FROM public.procurement_suppliers
  WHERE id = p_supplier_id AND organization_id = v_wh.organization_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'supplier_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_supplier.status <> 'active' THEN
    RAISE EXCEPTION 'supplier_inactive' USING ERRCODE = '23514';
  END IF;

  SELECT o_role, o_name INTO v_actor_role, v_actor_name
  FROM public._phoenix_procurement_actor(v_actor);

  BEGIN
    INSERT INTO public.procurement_orders (
      organization_id, warehouse_id, supplier_id, order_number, status,
      invoice_number, invoice_date, external_reference, currency, notes,
      ocr_assisted, created_by
    ) VALUES (
      v_wh.organization_id, p_warehouse_id, p_supplier_id, v_number, 'draft',
      NULLIF(btrim(COALESCE(p_invoice_number, '')), ''), p_invoice_date,
      NULLIF(btrim(COALESCE(p_external_reference, '')), ''),
      NULLIF(btrim(COALESCE(p_currency, '')), ''), NULLIF(btrim(COALESCE(p_notes, '')), ''),
      COALESCE(p_ocr_assisted, false), v_actor
    )
    RETURNING * INTO v_order;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'order_number_exists' USING ERRCODE = '23505';
  END;

  PERFORM public._phoenix_procurement_log_event(
    v_order, 'created', NULL, 'draft', v_actor, v_actor_role, v_actor_name, NULL,
    jsonb_build_object('ocr_assisted', COALESCE(p_ocr_assisted, false)));

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_order.organization_id, v_actor, v_actor_role,
    'local_procurement.order_created', 'procurement_orders', v_order.id, v_number,
    jsonb_build_object('warehouse_id', p_warehouse_id, 'supplier_id', p_supplier_id,
                       'ocr_assisted', COALESCE(p_ocr_assisted, false))
  );

  RETURN jsonb_build_object('ok', true, 'order_id', v_order.id, 'status', v_order.status,
                            'order_generation', v_order.order_generation);
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_procurement_create_order(
  uuid, uuid, text, text, date, text, text, text, boolean
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_procurement_create_order(
  uuid, uuid, text, text, date, text, text, text, boolean
) TO authenticated;

COMMENT ON FUNCTION public.phoenix_procurement_create_order(
  uuid, uuid, text, text, date, text, text, text, boolean
) IS
  'CANONICAL-SUPPLY-CYCLE-184: 087 order creation, unchanged except that the '
  'purchasing warehouse must now pass _phoenix_assert_local_procurement_root_v1 '
  'before the IDOR gate. A health_sector organization may open a local '
  'procurement order ONLY at its Sector Main (facility_id IS NULL); hospitals '
  'and specialized centers keep 087 behaviour exactly.';

-- ============================================================================
-- 5b. WRITE BOUNDARY - procurement_orders
-- ============================================================================
-- phoenix_procurement_create_order is NOT the only writer of procurement_orders.
-- phoenix_subpurchase_direct_entry (089, replaced in 116) is a second
-- authenticated-callable writer carrying the identical pre-R1.3 check
-- (warehouse_kind/status only), and it posts stock as well as an order. Adding
-- the capsule to one RPC would therefore have left the rule trivially
-- bypassable by a plain warehouse_officer scoped to a centre depot.
--
-- The boundary belongs on the TABLE, not on a list of writers: this covers both
-- RPCs, any future one, and a raw service_role INSERT, with ONE decision. This
-- is the same lesson R1.2C recorded - guard the table, not just the RPC that
-- happens to be in front of it today.
--
-- INSERT and RETARGET. An order is not inert history: phoenix_procurement_
-- receive_order posts stock into v_order.warehouse_id, so a pending order is a
-- standing authorization to put stock somewhere. service_role holds UPDATE on
-- this table, so judging only INSERT would let a retarget walk a legal order
-- into a centre depot and then receive against it. The route guard judges a
-- retarget for exactly this reason; this one must agree.
--
-- A row whose warehouse_id does NOT change is never re-judged, so genuine
-- history and ordinary status transitions are untouched.
CREATE OR REPLACE FUNCTION public._phoenix_procurement_order_root_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.warehouse_id = NEW.warehouse_id THEN
    RETURN NEW;
  END IF;
  PERFORM public._phoenix_assert_local_procurement_root_v1(NEW.warehouse_id);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public._phoenix_procurement_order_root_guard_v1()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS phoenix_procurement_order_root_guard ON public.procurement_orders;
CREATE TRIGGER phoenix_procurement_order_root_guard
  BEFORE INSERT OR UPDATE ON public.procurement_orders
  FOR EACH ROW EXECUTE FUNCTION public._phoenix_procurement_order_root_guard_v1();

COMMENT ON FUNCTION public._phoenix_procurement_order_root_guard_v1() IS
  'CANONICAL-SUPPLY-CYCLE-184: the procurement_orders write boundary. Delegates '
  'to _phoenix_assert_local_procurement_root_v1 so EVERY writer - '
  'phoenix_procurement_create_order, phoenix_subpurchase_direct_entry, any '
  'future RPC, and a raw service_role INSERT - obeys the same entry-root rule. '
  'INSERT and RETARGET: an UPDATE that leaves warehouse_id alone is never '
  're-judged, so genuine history and ordinary status transitions are untouched, '
  'but walking a legal order into a centre depot and receiving against it is '
  'refused.';

-- ============================================================================
-- 5c. FORWARD-REPLACE - phoenix_supply_route_assert_endpoints (+ route boundary)
-- ============================================================================
-- The ROUTED corridor was the other half of R1.3-A that a direct-path-only fix
-- would have missed. _phoenix_authorize_transfer_request_write branches on
-- `route_id IS NULL`, calling phoenix_assert_direct_supply_endpoints ONLY for
-- the direct path; a request carrying a non-NULL route_id skips it entirely.
-- 075's route validator checked kind + status and never facility_id, so
-- `central -> facility-bound depot` remained constructible as a ROUTE and then
-- reachable as a routed transfer - the forbidden shape, by another door.
--
-- Same capsule, same decision, so the direct and routed corridors cannot
-- disagree about what a legal destination is.
CREATE OR REPLACE FUNCTION public.phoenix_supply_route_assert_endpoints(
  p_source_warehouse_id uuid,
  p_target_warehouse_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_src_kind text; v_src_status text;
  v_tgt_kind text; v_tgt_status text;
BEGIN
  IF p_source_warehouse_id = p_target_warehouse_id THEN
    RAISE EXCEPTION 'SUPPLY_ROUTE_SELF: a warehouse cannot supply itself' USING ERRCODE = '23514';
  END IF;
  SELECT warehouse_kind, status INTO v_src_kind, v_src_status FROM public.warehouses WHERE id = p_source_warehouse_id;
  SELECT warehouse_kind, status INTO v_tgt_kind, v_tgt_status FROM public.warehouses WHERE id = p_target_warehouse_id;
  IF v_src_kind IS NULL THEN RAISE EXCEPTION 'SUPPLY_ROUTE_SOURCE_NOT_FOUND: %', p_source_warehouse_id USING ERRCODE = '23503'; END IF;
  IF v_tgt_kind IS NULL THEN RAISE EXCEPTION 'SUPPLY_ROUTE_TARGET_NOT_FOUND: %', p_target_warehouse_id USING ERRCODE = '23503'; END IF;
  IF v_src_kind <> 'central' THEN
    RAISE EXCEPTION 'SUPPLY_ROUTE_SOURCE_NOT_CENTRAL: source % is %', p_source_warehouse_id, v_src_kind USING ERRCODE = '23514';
  END IF;
  IF v_tgt_kind <> 'institution' THEN
    RAISE EXCEPTION 'SUPPLY_ROUTE_TARGET_NOT_INSTITUTION: target % is %', p_target_warehouse_id, v_tgt_kind USING ERRCODE = '23514';
  END IF;
  IF v_src_status <> 'active' OR v_tgt_status <> 'active' THEN
    RAISE EXCEPTION 'SUPPLY_ROUTE_ENDPOINT_INACTIVE: both endpoints must be active' USING ERRCODE = '23514';
  END IF;

  -- R1.3: the route target must be the SAME external-corridor root the direct
  -- path requires. Every 075 identifier above is preserved verbatim.
  PERFORM public._phoenix_assert_external_corridor_institution_root_v1(
    p_target_warehouse_id, 'supply_destination'
  );
END;
$$;

-- 075 was explicit that this is an INTERNAL helper with "no direct client
-- execution at all": it revoked from PUBLIC and anon and granted nobody. That
-- posture is preserved here. It must not gain an EXECUTE grant - the function
-- is SECURITY DEFINER and reads public.warehouses past RLS, so an authenticated
-- grant would turn it into a cross-tenant oracle for warehouse existence, kind,
-- status, facility-boundness and organization class.
REVOKE ALL ON FUNCTION public.phoenix_supply_route_assert_endpoints(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.phoenix_supply_route_assert_endpoints(uuid, uuid) IS
  'CANONICAL-SUPPLY-CYCLE-184: 075 route endpoint validation, every original '
  'identifier preserved, plus the R1.3 requirement that the TARGET pass '
  '_phoenix_assert_external_corridor_institution_root_v1 - the same capsule the '
  'direct corridor uses, so a facility-bound Health Center depot cannot be '
  'reached as a route target either.';

-- The route table's own boundary. phoenix_create_supply_route is super_admin
-- only, which tempers exploitability but does not make the invariant true:
-- warehouse_supply_routes carried ZERO triggers, so a raw write or a
-- REACTIVATION could reintroduce the forbidden shape without ever calling the
-- validator above. Judged only when the row IS or BECOMES active, so a dormant
-- legacy route keeps existing and keeps its values.
CREATE OR REPLACE FUNCTION public._phoenix_supply_route_topology_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT NEW.is_active THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.is_active
     AND OLD.target_warehouse_id = NEW.target_warehouse_id
     AND OLD.source_warehouse_id = NEW.source_warehouse_id THEN
    -- Already active between the same endpoints: this UPDATE is not an
    -- activation and not a retarget of either end, so it is not a transition
    -- this guard judges. BOTH endpoints are compared - keying on the target
    -- alone would let a source-only swap install an INACTIVE central behind an
    -- already-active route, which is precisely what the source check below
    -- exists to refuse.
    RETURN NEW;
  END IF;

  -- The SOURCE half. The composite FK already forces the source to be a
  -- `central` warehouse, but nothing forces it to be ACTIVE - and this guard
  -- exists precisely to cover the raw writes the RPC validator never sees, so
  -- it must not enforce half of the endpoint contract.
  IF NOT EXISTS (
    SELECT 1 FROM public.warehouses w
    WHERE w.id = NEW.source_warehouse_id
      AND w.warehouse_kind = 'central'
      AND w.status = 'active'
  ) THEN
    RAISE EXCEPTION 'SUPPLY_ROUTE_ENDPOINT_INACTIVE: both endpoints must be active'
      USING ERRCODE = '23514';
  END IF;

  PERFORM public._phoenix_assert_external_corridor_institution_root_v1(
    NEW.target_warehouse_id, 'supply_destination'
  );
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public._phoenix_supply_route_topology_guard_v1()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS phoenix_supply_route_topology_guard ON public.warehouse_supply_routes;
CREATE TRIGGER phoenix_supply_route_topology_guard
  BEFORE INSERT OR UPDATE ON public.warehouse_supply_routes
  FOR EACH ROW EXECUTE FUNCTION public._phoenix_supply_route_topology_guard_v1();

COMMENT ON FUNCTION public._phoenix_supply_route_topology_guard_v1() IS
  'CANONICAL-SUPPLY-CYCLE-184: the warehouse_supply_routes write boundary. A '
  'route may only be created, retargeted or ACTIVATED toward a warehouse that '
  'passes _phoenix_assert_external_corridor_institution_root_v1. Closes the raw '
  'write and the reactivation path that the RPC validator alone cannot reach. A '
  'row that stays inactive is never judged, so legacy routes survive unchanged.';

-- ============================================================================
-- 5d. WRITE BOUNDARY - the ROUTED corridor, enforced at USE time
-- ============================================================================
-- Guarding the ROUTE ROW (5c) is necessary but NOT sufficient. A route that was
-- already ACTIVE when this migration is applied is never re-judged by that
-- trigger - correctly, because a stored row is history and 184 rewrites no
-- history. But an active route is not merely a record of the past: it is a LIVE
-- STANDING AUTHORIZATION, and 075's validator accepted
-- `central -> facility-bound depot` on every chain from 164 to 183. So a legacy
-- active route would keep the forbidden corridor open.
--
-- The routed path performs NO topology validation of its own:
-- _phoenix_authorize_transfer_request_write (077) calls the direct validator
-- only in its `route_id IS NULL` branch, and the routed return RPCs deliberately
-- do not gate on is_active ("a route carries no expiry on the stock it already
-- delivered"), so deactivating a legacy route does not close the return half
-- either.
--
-- Therefore the rule is enforced where it is USED, on the tables themselves.
--
-- BOTH corridors are judged there, not just the routed one. It is tempting to
-- return early on `route_id IS NULL` and say the direct validator owns that
-- path, but it does not own it AT THE TABLE: phoenix_assert_direct_supply_
-- endpoints is reached only from inside an RPC body, and
-- _phoenix_authorize_transfer_request_write is a plain function five RPCs
-- PERFORM, not a trigger. Across 001-183 these four tables carry no
-- authorization trigger at all - only set_updated_at (068/069) and
-- phoenix_capture_lifecycle (082/155). A raw INSERT of
-- `route_id NULL, central -> facility-bound depot` would therefore land on the
-- very table that carries the stock, unjudged, and the composite route FK could
-- not catch it either because a NULL route_id switches that FK off.
--
-- So the direct branch DELEGATES to the same validator the RPCs use. That is
-- also what keeps Branch B (sector main -> its own facility-bound depot, always
-- route_id IS NULL) legal: Branch B is a branch OF that validator, so asking it
-- is precisely how the preserved corridor stays open while the forbidden one
-- closes.
-- FOUR tables, not two. The REQUEST table is NOT where a routed shipment
-- necessarily begins: phoenix_send_warehouse_transfer_line (127) takes the
-- route id DIRECTLY, treats the request line as optional, and INSERTs into
-- public.warehouse_transfers with transfer_request_id = NULL - reading both
-- endpoints straight off the route row. A boundary on the request table alone
-- would therefore never fire for the very path that moves the stock. The same
-- is true of the return half via warehouse_return_shipments.
--
-- ONE guard per DIRECTION, attached to both tables in that direction, so the
-- request and the shipment can never disagree about what a legal endpoint is.
CREATE OR REPLACE FUNCTION public._phoenix_routed_forward_topology_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- An UPDATE that moves NEITHER endpoint NOR the corridor the row travels is
  -- not a new authorization - it is the ordinary status lifecycle of a row that
  -- was already judged, or that predates 184. Judged route-agnostically and
  -- with IS NOT DISTINCT FROM so a LEGACY direct `central -> depot` row keeps
  -- its complete, reversible lifecycle: 184 rewrites no history and refuses no
  -- transition on stored state. Anything else - every INSERT, every endpoint
  -- retarget, and every move between the direct and routed corridors - IS a new
  -- authorization and is judged below.
  IF TG_OP = 'UPDATE'
     AND OLD.route_id IS NOT DISTINCT FROM NEW.route_id
     AND OLD.source_warehouse_id IS NOT DISTINCT FROM NEW.source_warehouse_id
     AND OLD.destination_warehouse_id IS NOT DISTINCT FROM NEW.destination_warehouse_id THEN
    RETURN NEW;
  END IF;

  IF NEW.route_id IS NULL THEN
    -- DIRECT corridor, judged by the validator the RPCs use - because nothing
    -- else judges it here. p_destination_organization_id is NULL on purpose:
    -- this boundary answers the TOPOLOGY question only, and the IDOR pairing
    -- stays exactly where 077 put it, in the callers' contract.
    PERFORM public.phoenix_assert_direct_supply_endpoints(
      NEW.source_warehouse_id, NEW.destination_warehouse_id, NULL
    );
    RETURN NEW;
  END IF;

  PERFORM public._phoenix_assert_external_corridor_institution_root_v1(
    NEW.destination_warehouse_id, 'supply_destination'
  );
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public._phoenix_routed_forward_topology_guard_v1()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS phoenix_routed_forward_topology_guard
  ON public.warehouse_transfer_requests;
CREATE TRIGGER phoenix_routed_forward_topology_guard
  BEFORE INSERT OR UPDATE ON public.warehouse_transfer_requests
  FOR EACH ROW EXECUTE FUNCTION public._phoenix_routed_forward_topology_guard_v1();

DROP TRIGGER IF EXISTS phoenix_routed_forward_topology_guard
  ON public.warehouse_transfers;
CREATE TRIGGER phoenix_routed_forward_topology_guard
  BEFORE INSERT OR UPDATE ON public.warehouse_transfers
  FOR EACH ROW EXECUTE FUNCTION public._phoenix_routed_forward_topology_guard_v1();

CREATE OR REPLACE FUNCTION public._phoenix_routed_return_topology_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Same transition rule as the forward guard, for the same reason.
  IF TG_OP = 'UPDATE'
     AND OLD.route_id IS NOT DISTINCT FROM NEW.route_id
     AND OLD.source_warehouse_id IS NOT DISTINCT FROM NEW.source_warehouse_id
     AND OLD.destination_warehouse_id IS NOT DISTINCT FROM NEW.destination_warehouse_id THEN
    RETURN NEW;
  END IF;

  IF NEW.route_id IS NULL THEN
    -- DIRECT corridor. 069 reads the route in reverse, so on a return the
    -- INSTITUTION endpoint is the SOURCE and central is the DESTINATION - which
    -- is exactly the legacy parameter order of the direct return validator.
    -- Asking it here also restores its PROVENANCE proof on the raw path: a
    -- return may not be invented for a corridor no forward transfer travelled.
    PERFORM public.phoenix_assert_direct_return_endpoints(
      NEW.source_warehouse_id, NEW.destination_warehouse_id
    );
    RETURN NEW;
  END IF;

  -- Routed: the same capsule, asked the return-side question.
  PERFORM public._phoenix_assert_external_corridor_institution_root_v1(
    NEW.source_warehouse_id, 'return_source'
  );
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public._phoenix_routed_return_topology_guard_v1()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS phoenix_routed_return_topology_guard
  ON public.warehouse_return_requests;
CREATE TRIGGER phoenix_routed_return_topology_guard
  BEFORE INSERT OR UPDATE ON public.warehouse_return_requests
  FOR EACH ROW EXECUTE FUNCTION public._phoenix_routed_return_topology_guard_v1();

DROP TRIGGER IF EXISTS phoenix_routed_return_topology_guard
  ON public.warehouse_return_shipments;
CREATE TRIGGER phoenix_routed_return_topology_guard
  BEFORE INSERT OR UPDATE ON public.warehouse_return_shipments
  FOR EACH ROW EXECUTE FUNCTION public._phoenix_routed_return_topology_guard_v1();

COMMENT ON FUNCTION public._phoenix_routed_forward_topology_guard_v1() IS
  'CANONICAL-SUPPLY-CYCLE-184: the forward corridor boundary, on BOTH '
  'warehouse_transfer_requests AND warehouse_transfers. 127 s routed send writes '
  'the transfer header with transfer_request_id = NULL, so guarding the request '
  'table alone would miss the path that actually moves stock. BOTH corridors are '
  'judged: routed rows against the external-corridor capsule, DIRECT rows against '
  'phoenix_assert_direct_supply_endpoints - because that validator is reached only '
  'from inside RPC bodies and these tables carry no other authorization trigger, '
  'so a raw direct INSERT would otherwise be unjudged. Delegating to the direct '
  'validator is also what leaves Branch B legal: Branch B is one of its branches. '
  'An UPDATE that changes neither endpoint nor route_id is never re-judged, so '
  'stored history keeps its full lifecycle.';

COMMENT ON FUNCTION public._phoenix_routed_return_topology_guard_v1() IS
  'CANONICAL-SUPPLY-CYCLE-184: the return corridor boundary, on BOTH '
  'warehouse_return_requests AND warehouse_return_shipments. The routed return '
  'RPCs deliberately do not gate on route.is_active, so deactivating a legacy '
  'route cannot close this half. The institution endpoint of a return is its '
  'SOURCE: routed rows are judged by the capsule, DIRECT rows by '
  'phoenix_assert_direct_return_endpoints, which also restores its provenance '
  'proof on the raw path. Same never-re-judge rule for unchanged rows.';

-- ============================================================================
-- 6. RE-ASSERT - the retired legacy exchange completion writer stays closed
-- ============================================================================
-- 153 revoked every external EXECUTE path on
-- phoenix_update_inter_org_exchange_status, whose completed transition still
-- carries the only remaining `UPDATE public.item_availability SET quantity`
-- in the RPC surface. This re-issues that revoke so the closure is continuously
-- enforced rather than merely historical: 109's ALTER DEFAULT PRIVILEGES grants
-- EXECUTE to service_role on every NEWLY created function, so a future
-- DROP+CREATE of this function would silently re-open it.
--
-- The function BODY is deliberately untouched. R1.3 does not resurrect the
-- legacy workflow and does not convert it into a second stock path.
REVOKE ALL PRIVILEGES ON FUNCTION public.phoenix_update_inter_org_exchange_status(
  uuid, text, integer, integer, text, text
) FROM PUBLIC, anon, authenticated, service_role;

-- ============================================================================
-- 7. VERIFY - fail closed inside the same transaction
-- ============================================================================
DO $verify$
DECLARE
  v_supply_sig constant text :=
    'public.phoenix_assert_direct_supply_endpoints(uuid,uuid,uuid)';
  v_return_sig constant text :=
    'public.phoenix_assert_direct_return_endpoints(uuid,uuid)';
  v_capsule_sig constant text :=
    'public._phoenix_assert_external_corridor_institution_root_v1(uuid,text)';
  v_proc_capsule_sig constant text :=
    'public._phoenix_assert_local_procurement_root_v1(uuid)';
  v_procurement_sig constant text :=
    'public.phoenix_procurement_create_order(uuid,uuid,text,text,date,text,text,text,boolean)';
  v_exchange_sig constant text :=
    'public.phoenix_update_inter_org_exchange_status(uuid,text,integer,integer,text,text)';

  v_fwd text;
  v_ret text;
  v_cap text;
  v_proc text;
  v_exchange_oid oid;
  v_exchange_owner oid;
  v_availability_writers text[];
BEGIN
  -- A. Every function this migration touches must still exist.
  IF to_regprocedure(v_supply_sig) IS NULL
     OR to_regprocedure(v_return_sig) IS NULL
     OR to_regprocedure(v_capsule_sig) IS NULL
     OR to_regprocedure(v_proc_capsule_sig) IS NULL
     OR to_regprocedure(v_procurement_sig) IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (184): a canonical function is missing after replacement';
  END IF;

  v_fwd  := pg_get_functiondef(v_supply_sig::regprocedure);
  v_ret  := pg_get_functiondef(v_return_sig::regprocedure);
  v_cap  := pg_get_functiondef(v_capsule_sig::regprocedure);
  v_proc := pg_get_functiondef(v_procurement_sig::regprocedure);

  -- B. Signatures, including OUT parameter NAMES that callers select by name,
  --    must be byte-identical to what 077 established and 165 preserved.
  IF pg_get_function_arguments(v_supply_sig::regprocedure)
     <> 'p_source_warehouse_id uuid, p_destination_warehouse_id uuid, p_destination_organization_id uuid, OUT o_source_organization_id uuid, OUT o_destination_organization_id uuid' THEN
    RAISE EXCEPTION 'VERIFY FAILED (184): forward validator signature changed';
  END IF;
  IF pg_get_function_arguments(v_return_sig::regprocedure)
     <> 'p_institution_warehouse_id uuid, p_central_warehouse_id uuid, OUT o_institution_organization_id uuid, OUT o_central_organization_id uuid' THEN
    RAISE EXCEPTION 'VERIFY FAILED (184): return validator signature changed';
  END IF;

  -- C. Both validators must DELEGATE to the capsule. This is what proves there
  --    is one decision rather than two drifting copies of it.
  IF v_fwd NOT LIKE '%_phoenix_assert_external_corridor_institution_root_v1%'
     OR v_fwd NOT LIKE '%supply_destination%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (184): supply Branch A does not delegate to the canonical capsule';
  END IF;
  IF v_ret NOT LIKE '%_phoenix_assert_external_corridor_institution_root_v1%'
     OR v_ret NOT LIKE '%return_source%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (184): return Branch A does not delegate to the canonical capsule';
  END IF;
  IF v_proc NOT LIKE '%_phoenix_assert_local_procurement_root_v1%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (184): procurement does not delegate to the canonical capsule';
  END IF;

  -- D. The R1.3 narrowing must actually be present in the capsule.
  IF v_cap NOT LIKE '%facility_id IS NOT NULL%'
     OR v_cap NOT LIKE '%central_supply_destination_must_not_be_facility_bound%'
     OR v_cap NOT LIKE '%central_return_source_must_not_be_facility_bound%'
     OR v_cap NOT LIKE '%external_corridor_requires_care_institution%'
     OR v_cap NOT LIKE '%external_corridor_institution_class_not_permitted%'
     OR v_cap NOT LIKE '%organization_institution_class_required%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (184): the external-corridor capsule lost an R1.3 conjunct';
  END IF;
  IF v_cap NOT LIKE '%''hospital''%'
     OR v_cap NOT LIKE '%''specialized_center''%'
     OR v_cap NOT LIKE '%''health_sector''%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (184): the capsule lost its institution_class allow-list';
  END IF;

  -- E. Branch A's ORIGINAL identifiers must survive, now raised by the capsule.
  IF v_fwd NOT LIKE '%source_must_be_active_central_warehouse%'
     OR v_cap NOT LIKE '%destination_must_be_active_institution_warehouse%'
     OR v_fwd NOT LIKE '%destination_warehouse_not_in_named_organization%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (184): forward Branch A error identifiers lost';
  END IF;
  IF v_cap NOT LIKE '%source_must_be_active_institution_warehouse%'
     OR v_ret NOT LIKE '%destination_must_be_active_central_warehouse%'
     OR v_ret NOT LIKE '%no_direct_forward_provenance_between_warehouses%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (184): return Branch A error identifiers lost';
  END IF;

  -- F. Branch B must be preserved in BOTH validators.
  IF v_fwd NOT LIKE '%sector_supply_requires_health_sector%'
     OR v_fwd NOT LIKE '%invalid_facility_class_for_sector_supply%'
     OR v_fwd NOT LIKE '%health_center_facility_not_active%'
     OR v_fwd NOT LIKE '%v_src.facility_id IS NULL%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (184): supply Branch B was not preserved';
  END IF;
  IF v_ret NOT LIKE '%sector_return_requires_health_sector%'
     OR v_ret NOT LIKE '%invalid_facility_class_for_sector_return%'
     OR v_ret NOT LIKE '%v_cent.facility_id IS NULL%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (184): return Branch B was not preserved';
  END IF;

  -- G. Security settings on every function this migration created or replaced.
  IF v_fwd NOT LIKE '%SECURITY DEFINER%' OR v_fwd NOT LIKE '%search_path%'
     OR v_ret NOT LIKE '%SECURITY DEFINER%' OR v_ret NOT LIKE '%search_path%'
     OR v_cap NOT LIKE '%SECURITY DEFINER%' OR v_cap NOT LIKE '%search_path%'
     OR v_proc NOT LIKE '%SECURITY DEFINER%' OR v_proc NOT LIKE '%search_path%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (184): SECURITY DEFINER/search_path contract lost';
  END IF;

  -- H. The two capsules are INTERNAL. No external principal may call them
  --    directly, or the narrowing could be probed and bypassed piecemeal.
  IF EXISTS (
    SELECT 1 FROM pg_roles r
    WHERE r.rolname IN ('anon', 'authenticated', 'service_role')
      AND has_function_privilege(r.oid, v_capsule_sig::regprocedure::oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (184): an external principal can call the external-corridor capsule';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles r
    WHERE r.rolname IN ('anon', 'authenticated', 'service_role')
      AND has_function_privilege(r.oid, v_proc_capsule_sig::regprocedure::oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (184): an external principal can call the procurement capsule';
  END IF;

  -- I. The two validators remain callable by authenticated and closed to anon.
  IF NOT has_function_privilege('authenticated', v_supply_sig::regprocedure::oid, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_return_sig::regprocedure::oid, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_procurement_sig::regprocedure::oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (184): authenticated lost EXECUTE on a canonical entry point';
  END IF;
  IF has_function_privilege('anon', v_supply_sig::regprocedure::oid, 'EXECUTE')
     OR has_function_privilege('anon', v_return_sig::regprocedure::oid, 'EXECUTE')
     OR has_function_privilege('anon', v_procurement_sig::regprocedure::oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (184): anon reaches a canonical entry point';
  END IF;

  -- J. The legacy exchange completion writer stays owner-only, and its body is
  --    still the retired one (we changed privileges, never the function).
  v_exchange_oid := to_regprocedure(v_exchange_sig)::oid;
  SELECT p.proowner INTO v_exchange_owner FROM pg_proc p WHERE p.oid = v_exchange_oid;

  IF EXISTS (
    SELECT 1 FROM pg_roles r
    WHERE r.rolname IN ('anon', 'authenticated', 'service_role')
      AND has_function_privilege(r.oid, v_exchange_oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION
      'VERIFY FAILED (184): an external principal still reaches the retired exchange completion writer';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
    WHERE p.oid = v_exchange_oid
      AND acl.privilege_type = 'EXECUTE'
      AND acl.grantee <> v_exchange_owner
  ) THEN
    RAISE EXCEPTION
      'VERIFY FAILED (184): a non-owner EXECUTE ACL remains on the retired exchange completion writer';
  END IF;

  -- K. The item_availability.quantity write surface must not GROW.
  --
  --    item_availability is a PROJECTION, not one of the two stock truths
  --    (warehouse_stock, outlet_stock). Three legacy functions predate those
  --    ledgers. Of those, the earlier hardening migrations already revoked
  --    external EXECUTE from phoenix_upsert_availability and
  --    phoenix_apply_availability_movement, so exactly ONE externally
  --    reachable writer remains: the legacy port-clearing RPC. R1.3 does not
  --    retire it - that is neither this stage's scope nor safe to do inside
  --    it - so this is a REGRESSION guard pinned to the exact observed set. A
  --    SECOND externally reachable writer appearing, in particular the retired
  --    exchange completion writer regaining EXECUTE, fails the migration.
  SELECT array_agg(DISTINCT p.proname ORDER BY p.proname)
    INTO v_availability_writers
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prokind = 'f'
    AND p.prosrc ~* 'UPDATE\s+(public\.)?item_availability\s+SET\s+quantity'
    AND EXISTS (
      SELECT 1 FROM pg_roles r
      WHERE r.rolname IN ('anon', 'authenticated', 'service_role')
        AND has_function_privilege(r.oid, p.oid, 'EXECUTE')
    );

  IF COALESCE(v_availability_writers, ARRAY[]::text[])
     IS DISTINCT FROM ARRAY['clear_port_availability']::text[] THEN
    RAISE EXCEPTION
      'VERIFY FAILED (184): the externally reachable item_availability.quantity writers changed; expected %, found %',
      ARRAY['clear_port_availability']::text[],
      COALESCE(v_availability_writers, ARRAY[]::text[]);
  END IF;

  -- L. The routed corridor and the two table boundaries.
  IF to_regprocedure('public.phoenix_supply_route_assert_endpoints(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (184): the route endpoint validator is missing';
  END IF;
  IF pg_get_functiondef('public.phoenix_supply_route_assert_endpoints(uuid,uuid)'::regprocedure)
     NOT LIKE '%_phoenix_assert_external_corridor_institution_root_v1%' THEN
    RAISE EXCEPTION
      'VERIFY FAILED (184): the route validator does not delegate to the canonical capsule';
  END IF;
  -- 075's own identifiers must survive the replacement.
  IF pg_get_functiondef('public.phoenix_supply_route_assert_endpoints(uuid,uuid)'::regprocedure)
       NOT LIKE '%SUPPLY_ROUTE_TARGET_NOT_INSTITUTION%'
     OR pg_get_functiondef('public.phoenix_supply_route_assert_endpoints(uuid,uuid)'::regprocedure)
       NOT LIKE '%SUPPLY_ROUTE_ENDPOINT_INACTIVE%'
     OR pg_get_functiondef('public.phoenix_supply_route_assert_endpoints(uuid,uuid)'::regprocedure)
       NOT LIKE '%SUPPLY_ROUTE_SOURCE_NOT_CENTRAL%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (184): 075 route identifiers lost';
  END IF;

  -- EXACTLY ONE trigger per guarded table, running the capsule. More than one
  -- would mean a second, order-dependent author of the same rule.
  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('procurement_orders',           'phoenix_procurement_order_root_guard'),
      ('warehouse_supply_routes',      'phoenix_supply_route_topology_guard'),
      ('warehouse_transfer_requests',  'phoenix_routed_forward_topology_guard'),
      ('warehouse_transfers',          'phoenix_routed_forward_topology_guard'),
      ('warehouse_return_requests',    'phoenix_routed_return_topology_guard'),
      ('warehouse_return_shipments',   'phoenix_routed_return_topology_guard')
    ) AS want(tbl, trg)
    WHERE (SELECT count(*) FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relname = want.tbl
             AND t.tgname = want.trg AND NOT t.tgisinternal) <> 1
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (184): a write boundary is missing';
  END IF;

  -- Every guard body must run a capsule rather than restate the rule.
  IF pg_get_functiondef('public._phoenix_procurement_order_root_guard_v1()'::regprocedure)
       NOT LIKE '%_phoenix_assert_local_procurement_root_v1%'
     OR pg_get_functiondef('public._phoenix_supply_route_topology_guard_v1()'::regprocedure)
       NOT LIKE '%_phoenix_assert_external_corridor_institution_root_v1%'
     OR pg_get_functiondef('public._phoenix_routed_forward_topology_guard_v1()'::regprocedure)
       NOT LIKE '%_phoenix_assert_external_corridor_institution_root_v1%'
     OR pg_get_functiondef('public._phoenix_routed_return_topology_guard_v1()'::regprocedure)
       NOT LIKE '%_phoenix_assert_external_corridor_institution_root_v1%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (184): a write boundary does not delegate to its capsule';
  END IF;

  -- The boundaries must judge the DIRECT corridor too, and judge it with the
  -- validator the RPCs use rather than the external-corridor capsule. Using the
  -- capsule there would refuse Branch B (sector main -> its own facility-bound
  -- depot, always route_id IS NULL); returning early would leave a raw direct
  -- write unjudged, which is the bypass this section exists to close.
  IF pg_get_functiondef('public._phoenix_routed_forward_topology_guard_v1()'::regprocedure)
       NOT LIKE '%NEW.route_id IS NULL%'
     OR pg_get_functiondef('public._phoenix_routed_forward_topology_guard_v1()'::regprocedure)
       NOT LIKE '%phoenix_assert_direct_supply_endpoints%'
     OR pg_get_functiondef('public._phoenix_routed_return_topology_guard_v1()'::regprocedure)
       NOT LIKE '%NEW.route_id IS NULL%'
     OR pg_get_functiondef('public._phoenix_routed_return_topology_guard_v1()'::regprocedure)
       NOT LIKE '%phoenix_assert_direct_return_endpoints%' THEN
    RAISE EXCEPTION
      'VERIFY FAILED (184): a corridor boundary does not judge both the routed and the direct path';
  END IF;

  -- A row already stored must never be re-judged for a change that moves
  -- nothing, or 184 would refuse ordinary status transitions on the very legacy
  -- rows its preflight promises to preserve.
  IF pg_get_functiondef('public._phoenix_routed_forward_topology_guard_v1()'::regprocedure)
       NOT LIKE '%IS NOT DISTINCT FROM NEW.destination_warehouse_id%'
     OR pg_get_functiondef('public._phoenix_routed_return_topology_guard_v1()'::regprocedure)
       NOT LIKE '%IS NOT DISTINCT FROM NEW.source_warehouse_id%' THEN
    RAISE EXCEPTION
      'VERIFY FAILED (184): a corridor boundary lost its unchanged-endpoint exemption';
  END IF;

  -- Every guard function, and the route endpoint validator, is INTERNAL.
  -- 075 established the validator as an internal helper with no client
  -- execution at all; it must not have gained a grant here.
  IF EXISTS (
    SELECT 1 FROM pg_roles r
    CROSS JOIN (VALUES
      ('public._phoenix_procurement_order_root_guard_v1()'),
      ('public._phoenix_supply_route_topology_guard_v1()'),
      ('public._phoenix_routed_forward_topology_guard_v1()'),
      ('public._phoenix_routed_return_topology_guard_v1()'),
      ('public.phoenix_supply_route_assert_endpoints(uuid,uuid)')
    ) AS g(sig)
    WHERE r.rolname IN ('anon', 'authenticated', 'service_role')
      AND has_function_privilege(r.oid, g.sig::regprocedure::oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION
      'VERIFY FAILED (184): an external principal can call a write-boundary guard or the route endpoint validator';
  END IF;

  RAISE NOTICE
    '184 verified: one external-corridor capsule shared by supply and return Branch A, '
    'one procurement-root capsule, Branch B preserved in both validators, '
    'legacy exchange completion writer owner-only';
END;
$verify$;

COMMIT;
