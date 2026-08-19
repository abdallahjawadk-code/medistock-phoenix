-- ============================================================================
-- ALERT-CANONICAL-IDENTITY-189 — INTER-ORGANIZATION ALERT HARDENING
--
-- Forward replacement of the TWO independently-callable live inter-institution
-- alert RPCs, plus ONE shared canonical material-identity read bridge.
--
-- WHY TWO RPCs IN ONE TRANSACTION (this is the whole point of the migration)
--   public.phoenix_get_live_inter_institution_alerts            — last defined 037
--   public.phoenix_get_live_inter_institution_alerts_with_state — last defined 053
--   Each carries its OWN copy of the cross-organization matching logic; the
--   second does NOT call the first. Both are GRANTed to `authenticated` and are
--   therefore directly callable over PostgREST. Hardening only one leaves the
--   other as a complete bypass returning name-matched, class-unfiltered rows.
--   A single migration is a single transaction, so no committed state can ever
--   expose one hardened RPC beside one legacy RPC.
--
--   public.phoenix_get_live_inter_institution_alerts_with_state_page (148) is
--   NOT redefined here: it calls _with_state(500) at RUNTIME and holds no copy
--   of the matching logic, so it inherits this hardening automatically.
--
-- 1. CANONICAL MATERIAL IDENTITY (closes name-based matching)
--    Both RPCs matched supply to demand on
--      lower(btrim(scientific_name)) + concentration + dosage_form
--    — display labels reconstructing material identity, which is exactly the
--    defect the G3.2 search contract exists to refuse. Two different materials
--    sharing a label matched; one material spelled two ways did not.
--
--    Matching is now equality of Migration 150's canonical
--    `material_identity_key`. item_availability cannot carry that key as a
--    GENERATED column — the identity function needs `central_item_id` and
--    `unit`, and item_availability has NEITHER. Both are reachable through the
--    catalog hop that already exists, so this migration adds a single shared
--    READ bridge rather than denormalising catalog columns onto an availability
--    row. The bridge is derived and non-writable: item_availability remains
--    availability state, and warehouse_stock / outlet_stock remain the only
--    ordinary stock truths.
--
--    THE CATALOG HOP IS OPTIONAL, SO THE RESOLVER MUST BE TOTAL.
--      001 created item_availability.local_item_id NOT NULL.
--      019 DROPPED that NOT NULL and replaced it with
--          CHECK (local_item_id IS NOT NULL OR port_name IS NOT NULL),
--          so a port-name-only availability row — a legitimate, shipped writer
--          path, and precisely the shape 027/028/052/058/059 and 177 already
--          LEFT JOIN for — carries local_item_id = NULL. No later migration
--          restores the NOT NULL, and the preflight below re-proves that at
--          apply time instead of trusting this prose.
--      Only that FIRST hop is optional. Below it, 001 still declares
--          local_items.central_item_id  NOT NULL REFERENCES central_items(id)
--          central_items.unit           NOT NULL
--      so whenever local_item_id IS NOT NULL the chain resolves completely.
--    The resolver is therefore a SCALAR function over ONE availability row,
--    anchored on a single synthetic row and LEFT JOINing the optional catalog
--    from that anchor. There is no join between the resolver and the candidate
--    set at all, so no join can drop a row: totality stops being a property to
--    police and becomes a property of the shape. An INNER JOIN — or a bare
--    `FROM public.local_items WHERE id = p_local_item_id` with no anchor — would
--    return zero rows for a port-name-only row and yield NULL, and an alert
--    that never fires is indistinguishable from no shortage.
--
--    A NULL hop is ENCODED, never dropped. 150's
--    _phoenix_material_identity_component_v1 maps NULL/blank to the explicit
--    marker 'N', so an unresolved row still yields a deterministic key whose
--    `central` and `unit` components read N. Two port-name-only rows that agree
--    on every remaining canonical component therefore match each other, and a
--    port-name-only row NEVER matches a catalogued one: a missing component and
--    a present component are different identities. That asymmetry is
--    fail-closed and is the accepted owner decision, not an oversight.
--
--    FAIL CLOSED: there is NO fallback to scientific_name, national_code,
--    concentration, dosage form, trade name or any other display label, and no
--    fabricated local_item_id. Because the identity function concatenates six
--    components that are each always non-null, it cannot itself return NULL —
--    the residual `material_identity_key IS NOT NULL` filter below is defence
--    against a future identity contract, NOT the mechanism that fails closed.
--
-- 1b. PARTICIPATION PRE-FILTER (closes the L8 whole-population identity scan)
--    The supply/demand predicates live DOWNSTREAM of `candidates`, so the
--    previous revision resolved a canonical identity for every non-removed,
--    named availability row in an eligible organization and then discarded
--    almost all of them. On a 50k-row rig fixture that was ~50,007 identity
--    computations to produce 7 participating rows, spilling the CTE to disk.
--    Neither a set-returning bridge nor a view fixes that: a view was measured
--    SLOWER in the real RPC query shape because planner pushdown through an
--    opaque relation is a cost decision, not a guarantee.
--
--    So the participation test is now applied INSIDE `candidates`, before any
--    identity work. It is a strict SUPERSET of the downstream predicates, not a
--    redefinition of them — effective_status can only reach one of the four
--    participating values through exactly these three disjuncts:
--      'missing'     <- quantity <= 0            OR condition = 'missing'
--      'near_expiry' <- expiry <= +9 months      OR condition = 'near_expiry'
--      'low_stock'   <-                             condition = 'low_stock'
--      'surplus'     <-                             condition = 'surplus'
--    quantity and condition are both NOT NULL, so the test is two-valued and
--    no row is lost to NULL logic. The downstream supply/demand predicates are
--    deliberately KEPT: the pre-filter exists for performance and must not
--    become the place where eligibility is defined.
--
-- 2. TOP-LEVEL ORGANIZATION FILTER (closes the forbidden-class gap)
--    Neither RPC restricted the institution class or organization kind of
--    either endpoint, so a `pharmacy_department_authority` organization could
--    appear on either side of an alert. Both endpoints must now satisfy:
--      organization_kind = 'care_institution'
--      institution_class IN ('health_sector','hospital','specialized_center')
--    The allowlist is POSITIVE and never `NOT IN`: institution_class is
--    NULLable (164), and a negated predicate over NULL is neither true nor
--    false. An UNCLASSIFIED organization therefore fails closed. PDA is
--    excluded by organization_kind — NOT by institution_class, which does not
--    encode it (171).
--
--    Same-class pairs (hospital <-> hospital, health_sector <-> health_sector,
--    specialized_center <-> specialized_center) remain eligible whenever the
--    two organizations differ. That is existing shipped behaviour; this
--    migration hardens, it does not add a new restriction.
--
-- 3. ELIGIBILITY CONVERGENCE OF THE TWO RPCs
--    The base RPC was three generations stale and diverged from _with_state on
--    TWO eligibility rules, not one:
--      a. it never excluded rows marked removed (053's removed_at)
--      b. its near-expiry participation window was still 3 months, while 048
--         widened _with_state to 9 months
--    Both are eligibility, not payload, and both are aligned here so the two
--    RPCs answer the same question. The base RPC's PAYLOAD is deliberately
--    UNCHANGED: it still returns neither the 047 contact fields nor the 048
--    expiry-risk fields. Convergence of WHICH alerts exist is required;
--    convergence of WHICH COLUMNS they carry is not, and is not done.
--
-- 4. PRESERVED EXACTLY
--    source.organization_id <> target.organization_id (the distinct-org
--    invariant, unchanged and still asserted below); supply = surplus /
--    near_expiry; demand = missing / low_stock; severity; ordering; limit
--    sanitisation; the 047 contact resolution; the 039/047/048/053 lifecycle
--    upsert and 'opened' event; every returned field name and type in both
--    RPCs. No table schema is touched. No historical migration is edited.
--    Historical alert_key values keep their existing shape.
--
-- MANUAL APPLY ONLY. NEVER `supabase db push`.
-- ============================================================================

BEGIN;

-- ============================================================================
-- PREFLIGHT — every structure this migration depends on must already exist.
-- ============================================================================
DO $preflight$
BEGIN
  IF to_regprocedure('public._phoenix_material_identity_v1(uuid,text,text,text,text,text)') IS NULL THEN
    RAISE EXCEPTION '189_precondition_failed: _phoenix_material_identity_v1/6 (150) is absent';
  END IF;
  IF to_regprocedure('public.phoenix_get_live_inter_institution_alerts(integer)') IS NULL THEN
    RAISE EXCEPTION '189_precondition_failed: base alert RPC is absent';
  END IF;
  IF to_regprocedure('public.phoenix_get_live_inter_institution_alerts_with_state(integer)') IS NULL THEN
    RAISE EXCEPTION '189_precondition_failed: with_state alert RPC is absent';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='item_availability'
                   AND column_name='removed_at') THEN
    RAISE EXCEPTION '189_precondition_failed: item_availability.removed_at (053) is absent';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='item_availability'
                   AND column_name='national_code') THEN
    RAISE EXCEPTION '189_precondition_failed: item_availability.national_code (049) is absent';
  END IF;
  -- The FIRST catalog hop is OPTIONAL, and the LEFT JOINs in the bridge are
  -- only the correct shape because it is. Asserted POSITIVELY rather than
  -- assumed: 001 created local_item_id NOT NULL, and 019 dropped that in
  -- favour of CHECK (local_item_id IS NOT NULL OR port_name IS NOT NULL). If a
  -- future lineage restored the NOT NULL, the row-preservation contract this
  -- migration rests on would need re-deriving, not silently becoming a no-op.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='item_availability'
                   AND column_name='local_item_id' AND is_nullable='YES') THEN
    RAISE EXCEPTION '189_precondition_failed: item_availability.local_item_id is not nullable — the 019 lineage changed, re-derive the bridge';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                 WHERE c.conrelid = 'public.item_availability'::regclass
                   AND c.contype = 'c'
                   AND pg_get_constraintdef(c.oid) LIKE '%local_item_id IS NOT NULL%'
                   AND pg_get_constraintdef(c.oid) LIKE '%port_name IS NOT NULL%') THEN
    RAISE EXCEPTION '189_precondition_failed: the 019 (local_item_id OR port_name) check constraint is absent';
  END IF;
  -- The hops BELOW local_items are genuinely NOT NULL (001), so a RESOLVED
  -- local_item_id always yields both central_item_id and unit.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='local_items'
                   AND column_name='central_item_id' AND is_nullable='NO') THEN
    RAISE EXCEPTION '189_precondition_failed: local_items.central_item_id is absent or nullable';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='central_items'
                   AND column_name='unit' AND is_nullable='NO') THEN
    RAISE EXCEPTION '189_precondition_failed: central_items.unit is absent or nullable';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='organizations'
                   AND column_name='institution_class') THEN
    RAISE EXCEPTION '189_precondition_failed: organizations.institution_class (164) is absent';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='organizations'
                   AND column_name='organization_kind') THEN
    RAISE EXCEPTION '189_precondition_failed: organizations.organization_kind (171) is absent';
  END IF;
END;
$preflight$;

-- ============================================================================
-- 1. SHARED CANONICAL MATERIAL IDENTITY BRIDGE
--
--    ONE object, called by BOTH RPCs. Deliberately not two inline copies: two
--    copies of the matching rule is precisely how the base RPC drifted three
--    generations behind _with_state in the first place.
--
--    It is SCALAR, not set-returning. The retired set-returning form had to be
--    joined to the candidate set on availability_id, which made it an opaque
--    whole-table Function Scan: it resolved an identity for every availability
--    row no matter how few could participate, and the caller's predicates could
--    not reach inside it. A scalar resolver is evaluated once per row that has
--    ALREADY survived the participation pre-filter, so identity work is
--    proportional to participating rows instead of to the table.
--
--    It is TOTAL by construction. Evaluation is anchored on `(SELECT 1)` and the
--    optional catalog is LEFT JOINed from that anchor, so exactly one row is
--    always produced and the function can never return NULL through absence.
--    A shape like `FROM public.local_items WHERE id = p_local_item_id` would
--    return no row — and therefore NULL — for a port-name-only availability
--    row, which is the B1 defect in a new costume.
--
--    SECURITY DEFINER is required, not stylistic: 150 revokes EXECUTE on
--    _phoenix_material_identity_v1 from PUBLIC, anon AND authenticated, so the
--    resolver must run as its owner. The only callers are the two SECURITY
--    DEFINER RPCs below, which apply their own permission gate and organization
--    scoping. The resolver returns identity only: no quantity, no status, no
--    organization, nothing that could widen what a caller can see. Its explicit
--    search_path is retained; it is NEVER dropped to court SQL inlining.
--
--    ACL contract, verified against the catalog in the verify block:
--      PUBLIC        — no direct execute
--      anon          — no direct execute
--      authenticated — no direct execute
--    service_role is deliberately absent from that list and is NOT asserted
--    either way: 109's ALTER DEFAULT PRIVILEGES already decides EXECUTE on
--    every new public function for it, so re-deciding it here would fight 109
--    rather than harden 189. It is a trusted server-side role reached only
--    through the service key, never an anonymous or client surface, and must
--    not be reported as one.
-- ============================================================================
-- The retired set-returning form is dropped so no caller can reach it and no
-- overload ambiguity survives. It was introduced by this migration and by no
-- other, so this drops nothing historical.
DROP FUNCTION IF EXISTS public._phoenix_availability_material_identity_v1();

CREATE OR REPLACE FUNCTION public._phoenix_availability_material_identity_v1(
  p_local_item_id   uuid,
  p_scientific_name text,
  p_national_code   text,
  p_concentration   text,
  p_dosage_form     text
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $bridge$
  SELECT public._phoenix_material_identity_v1(
    li.central_item_id,
    p_scientific_name,
    p_national_code,
    p_concentration,
    p_dosage_form,
    ci.unit
  )
  FROM (SELECT 1) AS anchor
  LEFT JOIN public.local_items   li ON li.id = p_local_item_id
  LEFT JOIN public.central_items ci ON ci.id = li.central_item_id
$bridge$;

COMMENT ON FUNCTION public._phoenix_availability_material_identity_v1(uuid,text,text,text,text) IS
  '189 internal SCALAR identity resolver: maps ONE item_availability row to '
  'Migration 150 canonical material_identity_key, reaching central_item_id and '
  'unit through local_items. TOTAL by construction — evaluation is anchored on '
  'a single synthetic row and the catalog is LEFT JOINed from it, so a '
  'port-name-only row (019 made local_item_id nullable) still yields a key '
  'whose central and unit components carry the explicit 150 NULL marker. Never '
  'dropped, never replaced by a display label, never fabricated. Scalar rather '
  'than set-returning so identity is computed only for rows that survived the '
  'participation pre-filter. Derived and non-writable — item_availability stays '
  'availability state, and warehouse_stock/outlet_stock remain the only '
  'ordinary stock truths. No client role may execute it; only the two live '
  'inter-institution alert RPCs call it.';

REVOKE ALL ON FUNCTION public._phoenix_availability_material_identity_v1(uuid,text,text,text,text)
  FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 2. BASE ALERT RPC — forward replacement (lineage 036/037)
--    Payload identical to 037. Eligibility now canonical, class-filtered,
--    removed-row-excluding, and on the same 9-month near-expiry window as
--    _with_state.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.phoenix_get_live_inter_institution_alerts(
  p_limit integer DEFAULT 200
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn_base$
DECLARE
  v_actor      uuid := auth.uid();
  v_role       text;
  v_org        uuid;
  v_is_super   boolean;
  v_can_view   boolean;
  v_limit      integer;
  v_computed_at timestamptz := now();
  v_alerts     jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED');
  END IF;

  SELECT role, organization_id INTO v_role, v_org
  FROM public.profiles WHERE id = v_actor;

  IF v_role IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ACTOR_PROFILE_NOT_FOUND');
  END IF;

  v_is_super := (v_role = 'super_admin');

  v_can_view := v_is_super
    OR phoenix_profile_has_permission(v_actor, 'inter_institution_alerts.view')
    OR phoenix_profile_has_permission(v_actor, 'exchange_alerts.view');

  IF NOT v_can_view THEN
    RETURN jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  END IF;

  v_limit := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);

  WITH candidates AS (
    SELECT
      ia.id                     AS availability_id,
      ia.organization_id,
      ia.distribution_point_id,
      ia.scientific_name,
      ia.trade_name,
      ia.concentration,
      ia.dosage_form,
      ia.quantity,
      ia.expiry_date,
      public._phoenix_availability_material_identity_v1(
        ia.local_item_id, ia.scientific_name, ia.national_code,
        ia.concentration, ia.dosage_form)  AS material_identity_key,
      CASE
        WHEN ia.expiry_date IS NOT NULL AND ia.expiry_date < current_date THEN 'expired'
        WHEN ia.condition = 'expired' THEN 'expired'
        WHEN ia.quantity <= 0 THEN 'missing'
        WHEN ia.condition = 'missing' THEN 'missing'
        WHEN ia.expiry_date IS NOT NULL
          AND ia.expiry_date <= (current_date + interval '9 months')::date THEN 'near_expiry'
        WHEN ia.condition = 'near_expiry' THEN 'near_expiry'
        WHEN ia.condition = 'low_stock' THEN 'low_stock'
        WHEN ia.condition = 'surplus' THEN 'surplus'
        ELSE 'available'
      END AS effective_status
    FROM public.item_availability ia
    -- Both endpoints of every alert descend from this one filtered set, so a
    -- forbidden organization class cannot reach either side.
    JOIN public.organizations o
      ON o.id = ia.organization_id
     AND o.organization_kind = 'care_institution'
     AND o.institution_class IN ('health_sector', 'hospital', 'specialized_center')
    WHERE ia.scientific_name IS NOT NULL
      AND btrim(ia.scientific_name) <> ''
      AND ia.removed_at IS NULL
      -- PARTICIPATION PRE-FILTER — performance only, never eligibility.
      -- A strict SUPERSET of the downstream supply/demand predicates: those are
      -- kept below and remain the definition of who participates. quantity and
      -- condition are NOT NULL, so this is two-valued and loses nothing.
      AND (
        ia.quantity <= 0
        OR ia.condition IN ('missing', 'low_stock', 'surplus', 'near_expiry')
        OR (ia.expiry_date IS NOT NULL
            AND ia.expiry_date <= (current_date + interval '9 months')::date)
      )
  ),
  -- The residual identity guard moves here, where the CTE column can be
  -- referenced without evaluating the resolver a second time. It is load-
  -- bearing under the scalar design: a resolver that lost its one-row anchor
  -- would return NULL, and these two filters are what makes that fail closed.
  supply AS (
    SELECT * FROM candidates WHERE effective_status IN ('surplus', 'near_expiry') AND material_identity_key IS NOT NULL
  ),
  demand AS (
    SELECT * FROM candidates WHERE effective_status IN ('missing', 'low_stock') AND material_identity_key IS NOT NULL
  ),
  matched AS (
    SELECT
      s.availability_id       AS src_availability_id,
      d.availability_id       AS tgt_availability_id,
      s.organization_id       AS src_org,
      d.organization_id       AS tgt_org,
      s.distribution_point_id AS src_point,
      d.distribution_point_id AS tgt_point,
      s.scientific_name,
      s.concentration,
      s.dosage_form,
      s.trade_name            AS src_trade_name,
      d.trade_name             AS tgt_trade_name,
      s.effective_status      AS src_status,
      d.effective_status      AS tgt_status,
      s.quantity              AS src_qty,
      d.quantity               AS tgt_qty,
      s.expiry_date            AS src_expiry,
      CASE WHEN s.effective_status = 'near_expiry'
        THEN 'near_expiry_to_shortage' ELSE 'surplus_to_shortage' END AS alert_type,
      CASE WHEN d.effective_status = 'missing'
        THEN 'high' ELSE 'medium' END AS severity
    FROM supply s
    JOIN demand d
      ON s.organization_id <> d.organization_id
     AND s.material_identity_key = d.material_identity_key
  ),
  scoped AS (
    SELECT m.*, so.name AS src_org_name, so.name_ar AS src_org_name_ar,
           to_.name AS tgt_org_name, to_.name_ar AS tgt_org_name_ar,
           sdp.name AS src_point_name, sdp.name_ar AS src_point_name_ar,
           tdp.name AS tgt_point_name, tdp.name_ar AS tgt_point_name_ar
    FROM matched m
    JOIN public.organizations so   ON so.id  = m.src_org
    JOIN public.organizations to_  ON to_.id = m.tgt_org
    LEFT JOIN public.distribution_points sdp ON sdp.id = m.src_point
    LEFT JOIN public.distribution_points tdp ON tdp.id = m.tgt_point
    WHERE v_is_super OR m.src_org = v_org OR m.tgt_org = v_org
    ORDER BY
      CASE m.severity WHEN 'high' THEN 2 ELSE 1 END DESC,
      CASE WHEN m.alert_type = 'near_expiry_to_shortage' THEN m.src_expiry END ASC NULLS LAST,
      m.scientific_name ASC
    LIMIT v_limit
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'alert_type',                      s.alert_type,
      'severity',                        s.severity,
      'source_item_availability_id',    s.src_availability_id,
      'target_item_availability_id',    s.tgt_availability_id,
      'source_organization_id',         s.src_org,
      'source_organization_name',       s.src_org_name,
      'source_organization_name_ar',    s.src_org_name_ar,
      'source_distribution_point_id',   s.src_point,
      'source_distribution_point_name', s.src_point_name,
      'source_distribution_point_name_ar', s.src_point_name_ar,
      'target_organization_id',         s.tgt_org,
      'target_organization_name',       s.tgt_org_name,
      'target_organization_name_ar',    s.tgt_org_name_ar,
      'target_distribution_point_id',   s.tgt_point,
      'target_distribution_point_name', s.tgt_point_name,
      'target_distribution_point_name_ar', s.tgt_point_name_ar,
      'scientific_name',                 s.scientific_name,
      'concentration',                   s.concentration,
      'dosage_form',                     s.dosage_form,
      'source_trade_name',               s.src_trade_name,
      'target_trade_name',               s.tgt_trade_name,
      'source_status',                   s.src_status,
      'target_status',                   s.tgt_status,
      'source_quantity',                 s.src_qty,
      'target_quantity',                 s.tgt_qty,
      'source_expiry_date',              s.src_expiry,
      'computed_at',                      v_computed_at
    )
    ORDER BY
      CASE s.severity WHEN 'high' THEN 2 ELSE 1 END DESC,
      CASE WHEN s.alert_type = 'near_expiry_to_shortage' THEN s.src_expiry END ASC NULLS LAST,
      s.scientific_name ASC
  )
  INTO v_alerts
  FROM scoped s;

  RETURN jsonb_build_object(
    'ok', true,
    'alerts', coalesce(v_alerts, '[]'::jsonb),
    'computed_at', v_computed_at
  );
END;
$fn_base$;

REVOKE ALL ON FUNCTION public.phoenix_get_live_inter_institution_alerts(integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_get_live_inter_institution_alerts(integer)
  TO authenticated;

-- ============================================================================
-- 3. WITH_STATE ALERT RPC — forward replacement (lineage 039/047/048/053)
--    Payload, lifecycle upsert, 'opened' event and contact resolution all
--    preserved verbatim. Only the candidate filter and the match predicate
--    change, identically to the base RPC above.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.phoenix_get_live_inter_institution_alerts_with_state(
  p_limit integer DEFAULT 200
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn_state$
DECLARE
  v_actor      uuid := auth.uid();
  v_role       text;
  v_org        uuid;
  v_is_super   boolean;
  v_can_view   boolean;
  v_limit      integer;
  v_computed_at timestamptz := now();
  v_alerts     jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED');
  END IF;

  SELECT role, organization_id INTO v_role, v_org
  FROM public.profiles WHERE id = v_actor;

  IF v_role IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ACTOR_PROFILE_NOT_FOUND');
  END IF;

  v_is_super := (v_role = 'super_admin');

  v_can_view := v_is_super
    OR phoenix_profile_has_permission(v_actor, 'inter_institution_alerts.view')
    OR phoenix_profile_has_permission(v_actor, 'exchange_alerts.view');

  IF NOT v_can_view THEN
    RETURN jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  END IF;

  v_limit := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);

  WITH candidates AS (
    SELECT
      ia.id                     AS availability_id,
      ia.organization_id,
      ia.distribution_point_id,
      ia.scientific_name,
      ia.trade_name,
      ia.concentration,
      ia.dosage_form,
      ia.quantity,
      ia.expiry_date,
      public._phoenix_availability_material_identity_v1(
        ia.local_item_id, ia.scientific_name, ia.national_code,
        ia.concentration, ia.dosage_form)  AS material_identity_key,
      CASE
        WHEN ia.expiry_date IS NOT NULL AND ia.expiry_date < current_date THEN 'expired'
        WHEN ia.condition = 'expired' THEN 'expired'
        WHEN ia.quantity <= 0 THEN 'missing'
        WHEN ia.condition = 'missing' THEN 'missing'
        WHEN ia.expiry_date IS NOT NULL
          AND ia.expiry_date <= (current_date + interval '9 months')::date THEN 'near_expiry'
        WHEN ia.condition = 'near_expiry' THEN 'near_expiry'
        WHEN ia.condition = 'low_stock' THEN 'low_stock'
        WHEN ia.condition = 'surplus' THEN 'surplus'
        ELSE 'available'
      END AS effective_status
    FROM public.item_availability ia
    JOIN public.organizations o
      ON o.id = ia.organization_id
     AND o.organization_kind = 'care_institution'
     AND o.institution_class IN ('health_sector', 'hospital', 'specialized_center')
    WHERE ia.scientific_name IS NOT NULL
      AND btrim(ia.scientific_name) <> ''
      AND ia.removed_at IS NULL
      -- PARTICIPATION PRE-FILTER — performance only, never eligibility.
      -- A strict SUPERSET of the downstream supply/demand predicates: those are
      -- kept below and remain the definition of who participates. quantity and
      -- condition are NOT NULL, so this is two-valued and loses nothing.
      AND (
        ia.quantity <= 0
        OR ia.condition IN ('missing', 'low_stock', 'surplus', 'near_expiry')
        OR (ia.expiry_date IS NOT NULL
            AND ia.expiry_date <= (current_date + interval '9 months')::date)
      )
  ),
  -- The residual identity guard moves here, where the CTE column can be
  -- referenced without evaluating the resolver a second time. It is load-
  -- bearing under the scalar design: a resolver that lost its one-row anchor
  -- would return NULL, and these two filters are what makes that fail closed.
  supply AS (
    SELECT * FROM candidates WHERE effective_status IN ('surplus', 'near_expiry') AND material_identity_key IS NOT NULL
  ),
  demand AS (
    SELECT * FROM candidates WHERE effective_status IN ('missing', 'low_stock') AND material_identity_key IS NOT NULL
  ),
  matched AS (
    SELECT
      s.availability_id       AS src_availability_id,
      d.availability_id       AS tgt_availability_id,
      s.organization_id       AS src_org,
      d.organization_id       AS tgt_org,
      s.distribution_point_id AS src_point,
      d.distribution_point_id AS tgt_point,
      s.scientific_name,
      s.concentration,
      s.dosage_form,
      s.trade_name            AS src_trade_name,
      d.trade_name             AS tgt_trade_name,
      s.effective_status      AS src_status,
      d.effective_status      AS tgt_status,
      s.quantity              AS src_qty,
      d.quantity               AS tgt_qty,
      s.expiry_date            AS src_expiry,
      CASE WHEN s.effective_status = 'near_expiry'
        THEN 'near_expiry_to_shortage' ELSE 'surplus_to_shortage' END AS alert_type,
      CASE WHEN d.effective_status = 'missing'
        THEN 'high' ELSE 'medium' END AS severity,
      CASE
        WHEN s.expiry_date IS NULL THEN 'unknown'
        WHEN s.expiry_date < current_date THEN 'expired'
        WHEN s.expiry_date <= (current_date + interval '3 months')::date THEN 'critical_3m'
        WHEN s.expiry_date <= (current_date + interval '6 months')::date THEN 'warning_6m'
        WHEN s.expiry_date <= (current_date + interval '9 months')::date THEN 'watch_9m'
        ELSE 'normal'
      END AS src_expiry_risk_tier,
      CASE
        WHEN s.expiry_date IS NULL THEN NULL
        ELSE (s.expiry_date - current_date)
      END AS src_expiry_days_remaining
    FROM supply s
    JOIN demand d
      ON s.organization_id <> d.organization_id
     AND s.material_identity_key = d.material_identity_key
  ),
  scoped AS (
    SELECT m.*, so.name AS src_org_name, so.name_ar AS src_org_name_ar,
           to_.name AS tgt_org_name, to_.name_ar AS tgt_org_name_ar,
           sdp.name AS src_point_name, sdp.name_ar AS src_point_name_ar,
           tdp.name AS tgt_point_name, tdp.name_ar AS tgt_point_name_ar,
           (m.src_availability_id::text || ':' || m.tgt_availability_id::text || ':' || m.alert_type) AS alert_key
    FROM matched m
    JOIN public.organizations so   ON so.id  = m.src_org
    JOIN public.organizations to_  ON to_.id = m.tgt_org
    LEFT JOIN public.distribution_points sdp ON sdp.id = m.src_point
    LEFT JOIN public.distribution_points tdp ON tdp.id = m.tgt_point
    WHERE v_is_super OR m.src_org = v_org OR m.tgt_org = v_org
    ORDER BY
      CASE m.severity WHEN 'high' THEN 2 ELSE 1 END DESC,
      CASE WHEN m.alert_type = 'near_expiry_to_shortage' THEN m.src_expiry END ASC NULLS LAST,
      m.scientific_name ASC
    LIMIT v_limit
  ),
  upserted AS (
    INSERT INTO public.inter_org_alert_states (
      alert_key, alert_type,
      source_item_availability_id, target_item_availability_id,
      source_organization_id, target_organization_id,
      scientific_name, concentration, dosage_form,
      status, severity_snapshot,
      first_seen_at, last_seen_at, created_at, updated_at
    )
    SELECT
      s.alert_key, s.alert_type,
      s.src_availability_id, s.tgt_availability_id,
      s.src_org, s.tgt_org,
      s.scientific_name, s.concentration, s.dosage_form,
      'open', s.severity,
      v_computed_at, v_computed_at, v_computed_at, v_computed_at
    FROM scoped s
    ON CONFLICT (alert_key) DO UPDATE SET
      last_seen_at      = v_computed_at,
      severity_snapshot = excluded.severity_snapshot,
      scientific_name   = excluded.scientific_name,
      concentration     = excluded.concentration,
      dosage_form       = excluded.dosage_form,
      updated_at        = v_computed_at
    RETURNING
      id, alert_key, status,
      first_seen_at, last_seen_at,
      acknowledged_at, acknowledged_by,
      in_progress_at, in_progress_by,
      resolved_at, resolved_by,
      dismissed_at, dismissed_by,
      reason, notes,
      (xmax = 0) AS was_inserted
  ),
  events_inserted AS (
    INSERT INTO public.inter_org_alert_events (
      alert_state_id, event_type, actor_id,
      actor_name_snapshot, actor_email_snapshot, actor_role_snapshot,
      from_status, to_status, reason, notes
    )
    SELECT id, 'opened', NULL, NULL, NULL, NULL, NULL, 'open', NULL, NULL
    FROM upserted
    WHERE was_inserted
    RETURNING 1
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'alert_type',                      s.alert_type,
      'severity',                        s.severity,
      'source_item_availability_id',    s.src_availability_id,
      'target_item_availability_id',    s.tgt_availability_id,
      'source_organization_id',         s.src_org,
      'source_organization_name',       s.src_org_name,
      'source_organization_name_ar',    s.src_org_name_ar,
      'source_distribution_point_id',   s.src_point,
      'source_distribution_point_name', s.src_point_name,
      'source_distribution_point_name_ar', s.src_point_name_ar,
      'target_organization_id',         s.tgt_org,
      'target_organization_name',       s.tgt_org_name,
      'target_organization_name_ar',    s.tgt_org_name_ar,
      'target_distribution_point_id',   s.tgt_point,
      'target_distribution_point_name', s.tgt_point_name,
      'target_distribution_point_name_ar', s.tgt_point_name_ar,
      'scientific_name',                 s.scientific_name,
      'concentration',                   s.concentration,
      'dosage_form',                     s.dosage_form,
      'source_trade_name',               s.src_trade_name,
      'target_trade_name',               s.tgt_trade_name,
      'source_status',                   s.src_status,
      'target_status',                   s.tgt_status,
      'source_quantity',                 s.src_qty,
      'target_quantity',                 s.tgt_qty,
      'source_expiry_date',              s.src_expiry,
      'source_expiry_risk_tier',         s.src_expiry_risk_tier,
      'source_expiry_days_remaining',    s.src_expiry_days_remaining,
      'source_contact_phone',            src_contact.phone,
      'target_contact_phone',            tgt_contact.phone,
      'computed_at',                      v_computed_at,
      'alert_key',                        u.alert_key,
      'lifecycle_status',                 u.status,
      'first_seen_at',                    u.first_seen_at,
      'last_seen_at',                      u.last_seen_at,
      'acknowledged_at',                   u.acknowledged_at,
      'acknowledged_by',                   u.acknowledged_by,
      'in_progress_at',                    u.in_progress_at,
      'in_progress_by',                    u.in_progress_by,
      'resolved_at',                       u.resolved_at,
      'resolved_by',                       u.resolved_by,
      'dismissed_at',                      u.dismissed_at,
      'dismissed_by',                      u.dismissed_by,
      'lifecycle_reason',                  u.reason,
      'lifecycle_notes',                   u.notes
    )
    ORDER BY
      CASE s.severity WHEN 'high' THEN 2 ELSE 1 END DESC,
      CASE WHEN s.alert_type = 'near_expiry_to_shortage' THEN s.src_expiry END ASC NULLS LAST,
      s.scientific_name ASC
  )
  INTO v_alerts
  FROM scoped s
  JOIN upserted u ON u.alert_key = s.alert_key
  LEFT JOIN LATERAL (
    SELECT osc.phone
    FROM public.organization_status_contacts osc
    WHERE osc.organization_id = s.src_org
      AND osc.is_active = true
      AND osc.phone IS NOT NULL
    ORDER BY osc.is_primary DESC, osc.updated_at DESC NULLS LAST, osc.created_at DESC
    LIMIT 1
  ) src_contact ON true
  LEFT JOIN LATERAL (
    SELECT osc.phone
    FROM public.organization_status_contacts osc
    WHERE osc.organization_id = s.tgt_org
      AND osc.is_active = true
      AND osc.phone IS NOT NULL
    ORDER BY osc.is_primary DESC, osc.updated_at DESC NULLS LAST, osc.created_at DESC
    LIMIT 1
  ) tgt_contact ON true;

  RETURN jsonb_build_object(
    'ok', true,
    'alerts', coalesce(v_alerts, '[]'::jsonb),
    'computed_at', v_computed_at
  );
END;
$fn_state$;

REVOKE ALL ON FUNCTION public.phoenix_get_live_inter_institution_alerts_with_state(integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_get_live_inter_institution_alerts_with_state(integer)
  TO authenticated;

-- ============================================================================
-- VERIFY — both RPCs must be hardened IDENTICALLY. A single hardened RPC beside
-- a legacy one is the exact failure this migration exists to prevent, so the
-- checks below run over BOTH definitions and this transaction aborts unless
-- both pass.
-- ============================================================================
DO $verify$
DECLARE
  v_base  text := pg_get_functiondef('public.phoenix_get_live_inter_institution_alerts(integer)'::regprocedure);
  v_state text := pg_get_functiondef('public.phoenix_get_live_inter_institution_alerts_with_state(integer)'::regprocedure);
  v_src   text;
  v_name  text;
  v_resolver_def    text;
  v_unresolved_key  text;
  v_resolved_key    text;
  v_catalogued_key  text;
  v_probe_local     uuid;
  v_service_exec    boolean;
BEGIN
  IF to_regprocedure('public._phoenix_availability_material_identity_v1(uuid,text,text,text,text)') IS NULL THEN
    RAISE EXCEPTION '189 verify failed: shared scalar identity resolver was not created';
  END IF;
  IF to_regprocedure('public._phoenix_availability_material_identity_v1()') IS NOT NULL THEN
    RAISE EXCEPTION '189 verify failed: the retired set-returning bridge still exists';
  END IF;

  -- --------------------------------------------------------------------
  -- V1. TOTALITY — DATA-INDEPENDENT, ALWAYS ARMED.
  --
  -- The retired set-returning bridge could only be checked by comparing its
  -- cardinality against item_availability, which proved nothing on a database
  -- that happened to contain no port-name-only row — exactly the situation on
  -- a clean 001->189 replay. A scalar resolver can be interrogated directly,
  -- so this assertion holds even against an empty table.
  -- --------------------------------------------------------------------
  v_unresolved_key := public._phoenix_availability_material_identity_v1(
    NULL, 'verify probe 189', NULL, '500 mg', 'tablet');
  IF v_unresolved_key IS NULL THEN
    RAISE EXCEPTION '189 verify failed: the identity resolver is NOT TOTAL — a NULL local_item_id yielded NULL instead of an encoded key';
  END IF;
  IF v_unresolved_key NOT LIKE '%|central=N|%' OR v_unresolved_key NOT LIKE '%|unit=N' THEN
    RAISE EXCEPTION '189 verify failed: unresolved catalog components are not encoded as the explicit N marker (got %)', v_unresolved_key;
  END IF;
  -- A NULL national_code is likewise encoded, never treated as a wildcard.
  IF v_unresolved_key NOT LIKE '%|national=N|%' THEN
    RAISE EXCEPTION '189 verify failed: a NULL national_code is not encoded as an explicit component';
  END IF;

  -- When the catalog hop DOES resolve, central and unit must be populated —
  -- otherwise the resolver would be silently ignoring its own join. Guarded on
  -- a catalogued row existing, so an empty catalog cannot fail the migration.
  SELECT li.id INTO v_probe_local
  FROM public.local_items li JOIN public.central_items ci ON ci.id = li.central_item_id LIMIT 1;
  IF v_probe_local IS NOT NULL THEN
    v_catalogued_key := public._phoenix_availability_material_identity_v1(
      v_probe_local, 'verify probe 189', NULL, '500 mg', 'tablet');
    IF v_catalogued_key IS NULL THEN
      RAISE EXCEPTION '189 verify failed: resolver returned NULL for a resolvable local_item_id';
    END IF;
    IF v_catalogued_key LIKE '%|central=N|%' OR v_catalogued_key LIKE '%|unit=N' THEN
      RAISE EXCEPTION '189 verify failed: resolver ignored a resolvable catalog hop';
    END IF;
    IF v_catalogued_key = v_unresolved_key THEN
      RAISE EXCEPTION '189 verify failed: catalogued and port-name-only identities collide';
    END IF;
  END IF;

  -- --------------------------------------------------------------------
  -- V2. BEHAVIOURAL, DATA-INDEPENDENT — 150's identity semantics, asserted by
  --     evaluation so they still hold against an empty item_availability.
  -- --------------------------------------------------------------------
  v_unresolved_key := public._phoenix_material_identity_v1(
    NULL, 'verify probe 189', 'NC-189-A', '500 mg', 'tablet', NULL);
  v_resolved_key := public._phoenix_material_identity_v1(
    '00000000-0000-0000-0000-000000000189'::uuid, 'verify probe 189', 'NC-189-A', '500 mg', 'tablet', 'box');

  -- The key never goes NULL. That is exactly why the residual
  -- material_identity_key IS NOT NULL filter is NOT the fail-closed mechanism.
  IF v_unresolved_key IS NULL THEN
    RAISE EXCEPTION '189 verify failed: identity contract changed — an unresolved tuple now yields NULL';
  END IF;
  IF v_unresolved_key NOT LIKE '%|central=N|%' OR v_unresolved_key NOT LIKE '%|unit=N' THEN
    RAISE EXCEPTION '189 verify failed: NULL identity components are no longer encoded as the explicit N marker';
  END IF;
  -- A missing component and a present component are DIFFERENT identities.
  IF v_unresolved_key = v_resolved_key THEN
    RAISE EXCEPTION '189 verify failed: an unresolved catalog tuple collides with a catalogued one';
  END IF;
  -- national_code and unit are canonical identity components, not decoration.
  IF public._phoenix_material_identity_v1(NULL, 'verify probe 189', 'NC-189-A', '500 mg', 'tablet', NULL)
   = public._phoenix_material_identity_v1(NULL, 'verify probe 189', 'NC-189-B', '500 mg', 'tablet', NULL) THEN
    RAISE EXCEPTION '189 verify failed: national_code is not a canonical identity component';
  END IF;
  IF public._phoenix_material_identity_v1(NULL, 'verify probe 189', 'NC-189-A', '500 mg', 'tablet', 'box')
   = public._phoenix_material_identity_v1(NULL, 'verify probe 189', 'NC-189-A', '500 mg', 'tablet', 'vial') THEN
    RAISE EXCEPTION '189 verify failed: unit is not a canonical identity component';
  END IF;

  -- --------------------------------------------------------------------
  -- V3. STRUCTURAL ANTI-REGRESSION on the resolver. V1 above is the primary,
  --     behavioural proof; these are the belt to its braces. The ANCHOR is the
  --     load-bearing one: without it, absence of a local_items row makes the
  --     function return no row and therefore NULL.
  -- --------------------------------------------------------------------
  v_resolver_def := pg_get_functiondef('public._phoenix_availability_material_identity_v1(uuid,text,text,text,text)'::regprocedure);
  IF v_resolver_def NOT LIKE '%FROM (SELECT 1) AS anchor%' THEN
    RAISE EXCEPTION '189 verify failed: the resolver lost its one-row anchor — absence of a catalog row could make it return NULL';
  END IF;
  -- Counted, not substring-matched: 'JOIN public.local_items' is itself a
  -- substring of 'LEFT JOIN public.local_items', so only an EQUAL occurrence
  -- count proves every join is the LEFT form.
  IF array_length(string_to_array(v_resolver_def, 'JOIN public.local_items'), 1)
     <> array_length(string_to_array(v_resolver_def, 'LEFT JOIN public.local_items'), 1) THEN
    RAISE EXCEPTION '189 verify failed: the resolver INNER JOINs local_items — port-name-only rows would resolve to NULL';
  END IF;
  IF array_length(string_to_array(v_resolver_def, 'JOIN public.central_items'), 1)
     <> array_length(string_to_array(v_resolver_def, 'LEFT JOIN public.central_items'), 1) THEN
    RAISE EXCEPTION '189 verify failed: the resolver INNER JOINs central_items — unresolved rows would resolve to NULL';
  END IF;
  IF v_resolver_def NOT LIKE '%SET search_path%' THEN
    RAISE EXCEPTION '189 verify failed: the resolver lost its explicit search_path';
  END IF;

  -- --------------------------------------------------------------------
  -- V4. ACL — read from the real catalog, not asserted in prose.
  --     PUBLIC / anon / authenticated must hold NO direct execute on the
  --     bridge. service_role is recorded, never asserted: 109 decides it.
  -- --------------------------------------------------------------------
  IF (SELECT proacl FROM pg_proc
       WHERE oid = 'public._phoenix_availability_material_identity_v1(uuid,text,text,text,text)'::regprocedure) IS NULL THEN
    RAISE EXCEPTION '189 verify failed: identity resolver still carries the default function ACL, under which PUBLIC holds EXECUTE';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(p.proacl) a
    WHERE p.oid = 'public._phoenix_availability_material_identity_v1(uuid,text,text,text,text)'::regprocedure
      AND a.privilege_type = 'EXECUTE'
      AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) IN ('anon', 'authenticated'))
  ) THEN
    RAISE EXCEPTION '189 verify failed: identity resolver is executable by PUBLIC, anon or authenticated';
  END IF;
  -- The resolver must never be directly callable by a client role.
  IF has_function_privilege('anon', 'public._phoenix_availability_material_identity_v1(uuid,text,text,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._phoenix_availability_material_identity_v1(uuid,text,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '189 verify failed: identity bridge is executable by a client role';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    SELECT has_function_privilege('service_role', 'public._phoenix_availability_material_identity_v1(uuid,text,text,text,text)', 'EXECUTE') INTO v_service_exec;
    RAISE NOTICE '189 verify: resolver ACL — PUBLIC/anon/authenticated denied; service_role EXECUTE = % (decided by 109 default privileges, not by 189)',
      v_service_exec;
  END IF;

  FOREACH v_name IN ARRAY ARRAY['base', 'with_state'] LOOP
    v_src := CASE v_name WHEN 'base' THEN v_base ELSE v_state END;

    -- A. canonical identity replaces label matching
    IF v_src NOT LIKE '%s.material_identity_key = d.material_identity_key%' THEN
      RAISE EXCEPTION '189 verify failed (%): canonical identity match predicate absent', v_name;
    END IF;
    IF v_src LIKE '%norm_sci%' OR v_src LIKE '%norm_conc%' OR v_src LIKE '%norm_dosage%' THEN
      RAISE EXCEPTION '189 verify failed (%): label-based matching still present', v_name;
    END IF;
    IF v_src NOT LIKE '%material_identity_key IS NOT NULL%' THEN
      RAISE EXCEPTION '189 verify failed (%): the residual unresolved-identity filter was removed', v_name;
    END IF;
    -- The retired whole-table bridge must not reappear in either body.
    IF v_src LIKE '%_phoenix_availability_material_identity_v1()%' THEN
      RAISE EXCEPTION '189 verify failed (%): the retired set-returning bridge is still referenced', v_name;
    END IF;
    -- The participation pre-filter must be present in BOTH bodies, ahead of any
    -- identity work, or the L8 whole-population scan returns.
    IF v_src NOT LIKE '%ia.condition IN (''missing'', ''low_stock'', ''surplus'', ''near_expiry'')%' THEN
      RAISE EXCEPTION '189 verify failed (%): participation pre-filter absent from candidates', v_name;
    END IF;
    IF v_src NOT LIKE '%ia.quantity <= 0%' THEN
      RAISE EXCEPTION '189 verify failed (%): participation pre-filter lost its zero-quantity arm', v_name;
    END IF;
    IF v_src NOT LIKE '%_phoenix_availability_material_identity_v1(%' THEN
      RAISE EXCEPTION '189 verify failed (%): does not use the shared identity resolver', v_name;
    END IF;
    IF v_src NOT LIKE '%ia.local_item_id, ia.scientific_name, ia.national_code%' THEN
      RAISE EXCEPTION '189 verify failed (%): resolver is not invoked per availability row', v_name;
    END IF;

    -- B. distinct-organization invariant preserved verbatim
    IF v_src NOT LIKE '%s.organization_id <> d.organization_id%' THEN
      RAISE EXCEPTION '189 verify failed (%): distinct-organization invariant lost', v_name;
    END IF;

    -- C. positive top-level allowlist on BOTH endpoints, via the shared
    --    candidate set. NOT IN would be unsafe over a NULLable class.
    IF v_src NOT LIKE '%o.organization_kind = ''care_institution''%' THEN
      RAISE EXCEPTION '189 verify failed (%): organization_kind filter absent', v_name;
    END IF;
    IF v_src NOT LIKE '%o.institution_class IN (''health_sector'', ''hospital'', ''specialized_center'')%' THEN
      RAISE EXCEPTION '189 verify failed (%): institution_class allowlist absent', v_name;
    END IF;
    IF v_src LIKE '%institution_class NOT IN%' OR v_src LIKE '%organization_kind <>%' THEN
      RAISE EXCEPTION '189 verify failed (%): negated class predicate is NULL-unsafe', v_name;
    END IF;

    -- D. converged eligibility: removed rows excluded, same near-expiry window
    IF v_src NOT LIKE '%ia.removed_at IS NULL%' THEN
      RAISE EXCEPTION '189 verify failed (%): removed rows are not excluded', v_name;
    END IF;
    IF v_src NOT LIKE '%interval ''9 months''%' THEN
      RAISE EXCEPTION '189 verify failed (%): near-expiry window did not converge', v_name;
    END IF;
    IF v_src LIKE '%<= (current_date + interval ''3 months'')::date THEN ''near_expiry''%' THEN
      RAISE EXCEPTION '189 verify failed (%): stale 3-month participation window still present', v_name;
    END IF;

    -- E. explicit search_path on every replaced function
    IF v_src NOT LIKE '%SET search_path%' THEN
      RAISE EXCEPTION '189 verify failed (%): explicit search_path absent', v_name;
    END IF;
  END LOOP;

  -- F. the base RPC payload was NOT widened with with_state-only fields
  IF v_base LIKE '%source_contact_phone%'
     OR v_base LIKE '%source_expiry_risk_tier%'
     OR v_base LIKE '%lifecycle_status%' THEN
    RAISE EXCEPTION '189 verify failed: base RPC payload was widened beyond its contract';
  END IF;

  -- G. with_state kept its own contract intact
  IF v_state NOT LIKE '%source_contact_phone%'
     OR v_state NOT LIKE '%source_expiry_risk_tier%'
     OR v_state NOT LIKE '%lifecycle_status%'
     OR v_state NOT LIKE '%inter_org_alert_states%'
     OR v_state NOT LIKE '%inter_org_alert_events%' THEN
    RAISE EXCEPTION '189 verify failed: with_state lost part of its existing contract';
  END IF;

  -- H. client grants unchanged: authenticated only, never anon/PUBLIC
  IF NOT has_function_privilege('authenticated', 'public.phoenix_get_live_inter_institution_alerts(integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.phoenix_get_live_inter_institution_alerts_with_state(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION '189 verify failed: authenticated lost legitimate alert access';
  END IF;
  IF has_function_privilege('anon', 'public.phoenix_get_live_inter_institution_alerts(integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.phoenix_get_live_inter_institution_alerts_with_state(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION '189 verify failed: anon can execute an alert RPC';
  END IF;

  -- I. the paged wrapper must still delegate rather than hold its own copy
  IF to_regprocedure('public.phoenix_get_live_inter_institution_alerts_with_state_page(integer,integer)') IS NOT NULL THEN
    IF pg_get_functiondef('public.phoenix_get_live_inter_institution_alerts_with_state_page(integer,integer)'::regprocedure)
       NOT LIKE '%phoenix_get_live_inter_institution_alerts_with_state(500)%' THEN
      RAISE EXCEPTION '189 verify failed: paged wrapper no longer delegates to with_state';
    END IF;
  END IF;
END;
$verify$;

COMMIT;
