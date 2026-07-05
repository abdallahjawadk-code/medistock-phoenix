-- =============================================================================
-- MediStock Phoenix V2 — Migration 054: Dashboard Condition Count RPCs
-- =============================================================================
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply via Supabase Dashboard → SQL Editor after reading this file in full.
-- Apply ONLY after migration 053 is confirmed applied and healthy.
--
-- Prerequisites: Migrations 001–053 must already be applied.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- PROBLEM (PHASE2-DASHBOARD-PERFORMANCE-RPCS-054-A)
-- ─────────────────────────────────────────────────────────────────────────────
--   src/shared/supabase/services/dashboard.service.ts currently over-fetches
--   to compute condition-count badges:
--     • getDashboardMetrics(orgId?) selects `condition` for EVERY visible
--       item_availability row (optionally .match()'d to one org) and counts
--       available/low_stock/missing/near_expiry/surplus in JS.
--     • getInstitutionOverviews() selects `organization_id, condition` for
--       EVERY visible item_availability row across ALL organizations (no org
--       filter in the query itself) and groups into available/low/missing
--       per org in JS.
--   Both rely entirely on the `avail_select_org` RLS policy (migration 002)
--   to restrict which rows a non-super caller actually receives back over
--   the wire before any counting happens — the whole row set is still
--   fetched to the client just to be counted.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- GOAL
-- ─────────────────────────────────────────────────────────────────────────────
--   Add two DB-side counting RPCs so a future frontend phase can replace the
--   two full-row-fetch-then-count-in-JS paths above with a single grouped
--   aggregate query. This migration ONLY creates the RPCs — it does not
--   change dashboard.service.ts or any other frontend file (see "WHAT IS NOT
--   CHANGED" below).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SCOPING MODEL (DASHBOARD-CONDITION-COUNTS-054-A)
-- ─────────────────────────────────────────────────────────────────────────────
--   Both RPCs are SECURITY DEFINER, so the avail_select_org RLS policy that
--   currently does this filtering for the plain client-side .from() queries
--   does NOT apply inside them — the same org-scope decision is reproduced
--   explicitly using phoenix_my_role()/phoenix_my_org() (migration 002),
--   exactly mirroring avail_select_org's own condition
--   (`phoenix_my_role() = 'super_admin' OR organization_id = phoenix_my_org()`):
--
--     • phoenix_get_dashboard_condition_counts(p_org_id): for a super_admin
--       caller, p_org_id (if given) filters to that one org; if omitted,
--       counts span all organizations — identical to today's
--       getDashboardMetrics(orgId?) behavior for a super_admin, which relies
--       on avail_select_org's `phoenix_my_role() = 'super_admin'` branch to
--       see every org's rows regardless of the client-side .match() filter.
--       For a non-super caller, p_org_id is IGNORED and the effective scope
--       is always the caller's own organization (phoenix_my_org()) — this
--       matches today's behavior exactly, since avail_select_org only ever
--       lets a non-super caller see their own org's rows no matter what
--       client-side filter is applied, so passing another org's id today
--       silently returns zero rows for that org rather than leaking another
--       org's counts. Forcing the scope server-side removes any possibility
--       of a non-super caller supplying p_org_id to probe another org.
--
--     • phoenix_get_institution_condition_counts(): for a super_admin
--       caller, returns one row per active organization (matching today's
--       getInstitutionOverviews(), which fetches ALL active orgs plus ALL
--       item_availability rows for a super_admin). For a non-super caller,
--       returns only the caller's own organization's row — matching today's
--       effective behavior, since avail_select_org already restricts a
--       non-super caller to their own org's item_availability rows (other
--       orgs' rows are invisible, so their counts are effectively always
--       zero/absent from the caller's own view already).
--
--   HARDEN-MIGRATION-054-NULL-ORG-FAIL-CLOSED-A: both RPCs additionally
--   fail CLOSED — never all-organizations — for a non-super caller whose
--   profile has NO organization_id (a broken/incomplete profile state).
--   Without this explicit guard, phoenix_get_dashboard_condition_counts'
--   `v_effective_org IS NULL` branch (meant only for a super_admin's
--   deliberate "no org filter" request) would otherwise also catch a
--   non-super caller with a NULL phoenix_my_org(), returning every
--   organization's counts to a caller entitled to none of them.
--   phoenix_get_institution_condition_counts already failed closed
--   structurally (`o.id = v_my_org` is NULL, not TRUE, when v_my_org is
--   NULL) — its guard is added for explicitness/testability, not because
--   the prior behavior was wrong.
--
--   HARDEN-MIGRATION-054-NULL-ROLE-FAIL-CLOSED-A: both RPCs also treat a NULL
--   phoenix_my_role() (a broken/incomplete profile with no role assigned) as
--   NOT super_admin. `v_is_super := COALESCE(v_role = 'super_admin', false)`
--   replaces a bare `v_is_super := (v_role = 'super_admin')` — under SQL
--   three-valued logic, `NULL = 'super_admin'` evaluates to NULL, not false,
--   which would make `v_is_super` itself NULL. Since PL/pgSQL's `IF NOT
--   v_is_super AND v_my_org IS NULL THEN` only executes on a TRUE condition
--   (never on NULL), a NULL v_is_super would silently skip the NULL-org
--   fail-closed guard above instead of tripping it. COALESCing to false
--   guarantees `v_is_super` is always a real boolean, so the fail-closed
--   guard reliably fires for any caller who is not affirmatively confirmed
--   as super_admin.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT IS NOT CHANGED IN THIS PHASE
-- ─────────────────────────────────────────────────────────────────────────────
--   • No frontend/service (.ts/.tsx) file is touched by this migration.
--     dashboard.service.ts is NOT switched to call either new RPC yet — that
--     is an explicit, separate, later phase.
--   • No existing table, column, RLS policy, trigger, or function (other
--     than the two brand-new ones below) is modified.
--   • No data is backfilled or mutated — both RPCs are pure SELECTs.
--   • No row is ever deleted or truncated.
--   • QR behavior, alert lifecycle, movement history, auth/session/
--     permissions, and routing/navigation are entirely untouched.
-- =============================================================================

begin;

-- =============================================================================
-- RPC 1: phoenix_get_dashboard_condition_counts — global/org dashboard tiles
-- =============================================================================

CREATE OR REPLACE FUNCTION public.phoenix_get_dashboard_condition_counts(
  p_org_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor          uuid := auth.uid();
  v_role           text;
  v_my_org         uuid;
  v_is_super       boolean;
  v_effective_org  uuid;
  v_available      integer;
  v_low_stock      integer;
  v_missing        integer;
  v_near_expiry    integer;
  v_surplus        integer;
BEGIN
  -- 1. Auth required.
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  v_role     := phoenix_my_role();
  v_my_org   := phoenix_my_org();
  -- HARDEN-MIGRATION-054-NULL-ROLE-FAIL-CLOSED-A: COALESCE(..., false) instead
  -- of a bare boolean expression. A broken/incomplete profile with no role at
  -- all (phoenix_my_role() returns NULL) must be treated as NOT super_admin.
  -- Without the COALESCE, `v_role = 'super_admin'` on a NULL v_role evaluates
  -- to NULL (SQL three-valued logic), so v_is_super becomes NULL rather than
  -- false — and `NOT v_is_super` below is then also NULL, not TRUE, which
  -- would let a NULL-role caller silently skip the very next fail-closed
  -- guard (step 2) instead of tripping it.
  v_is_super := COALESCE(v_role = 'super_admin', false);

  -- 2. HARDEN-MIGRATION-054-NULL-ORG-FAIL-CLOSED-A: a non-super caller whose
  --    profile has no organization_id (a broken/incomplete profile state)
  --    must fail CLOSED — zero counts — never fall through to the
  --    "v_effective_org IS NULL -> all organizations" branch below, which is
  --    reserved for a super_admin's deliberate "no org filter" request. Without
  --    this explicit guard, a non-super caller with v_my_org IS NULL would
  --    silently collapse into the same NULL-effective-org codepath a
  --    super_admin uses to mean "span every organization," leaking every
  --    org's counts to a caller who is not entitled to see any of them.
  IF NOT v_is_super AND v_my_org IS NULL THEN
    RETURN jsonb_build_object(
      'available',   0,
      'low_stock',   0,
      'missing',     0,
      'near_expiry', 0,
      'surplus',     0
    );
  END IF;

  -- 3. DASHBOARD-CONDITION-COUNTS-054-A: reproduce avail_select_org's exact
  --    scope decision. A non-super caller's effective org is ALWAYS their own
  --    (phoenix_my_org()) — p_org_id is ignored for them, never trusted as a
  --    cross-org probe. A super_admin may optionally narrow to one org via
  --    p_org_id, or omit it to span every organization. NOT v_is_super
  --    callers reaching this line are guaranteed by step 2 above to have a
  --    non-NULL v_my_org, so v_effective_org can never be NULL for them here.
  v_effective_org := CASE WHEN v_is_super THEN p_org_id ELSE v_my_org END;

  -- 4. Count each condition bucket. removed_at IS NULL excludes rows an
  --    explicit removal operation (migration 053) has marked — an
  --    intentionally-removed material is not a real dashboard tile count.
  --    Genuine missing rows (condition = 'missing' AND removed_at IS NULL,
  --    i.e. an actual unresolved shortage) are counted normally, same as
  --    today's client-side filter.
  SELECT
    count(*) FILTER (WHERE condition = 'available'),
    count(*) FILTER (WHERE condition = 'low_stock'),
    count(*) FILTER (WHERE condition = 'missing'),
    count(*) FILTER (WHERE condition = 'near_expiry'),
    count(*) FILTER (WHERE condition = 'surplus')
  INTO v_available, v_low_stock, v_missing, v_near_expiry, v_surplus
  FROM public.item_availability
  WHERE removed_at IS NULL
    AND (v_effective_org IS NULL OR organization_id = v_effective_org);

  RETURN jsonb_build_object(
    'available',   COALESCE(v_available, 0),
    'low_stock',   COALESCE(v_low_stock, 0),
    'missing',     COALESCE(v_missing, 0),
    'near_expiry', COALESCE(v_near_expiry, 0),
    'surplus',     COALESCE(v_surplus, 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_get_dashboard_condition_counts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_get_dashboard_condition_counts(uuid) TO authenticated;

-- =============================================================================
-- RPC 2: phoenix_get_institution_condition_counts — per-org overview badges
-- =============================================================================

CREATE OR REPLACE FUNCTION public.phoenix_get_institution_condition_counts()
RETURNS TABLE(
  organization_id uuid,
  available       integer,
  low             integer,
  missing         integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_role     text;
  v_my_org   uuid;
  v_is_super boolean;
BEGIN
  -- 1. Auth required.
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  v_role     := phoenix_my_role();
  v_my_org   := phoenix_my_org();
  -- HARDEN-MIGRATION-054-NULL-ROLE-FAIL-CLOSED-A: COALESCE(..., false) instead
  -- of a bare boolean expression. A broken/incomplete profile with no role at
  -- all (phoenix_my_role() returns NULL) must be treated as NOT super_admin.
  -- Without the COALESCE, `v_role = 'super_admin'` on a NULL v_role evaluates
  -- to NULL (SQL three-valued logic), so v_is_super becomes NULL rather than
  -- false — and `NOT v_is_super` below is then also NULL, not TRUE, which
  -- would let a NULL-role caller silently skip the very next fail-closed
  -- guard (step 2) instead of tripping it.
  v_is_super := COALESCE(v_role = 'super_admin', false);

  -- 2. HARDEN-MIGRATION-054-NULL-ORG-FAIL-CLOSED-A: a non-super caller whose
  --    profile has no organization_id (a broken/incomplete profile state)
  --    must fail CLOSED — no rows — made EXPLICIT here for clarity and
  --    testability. The query below's own `o.id = v_my_org` comparison
  --    already evaluates to NULL (not TRUE) when v_my_org IS NULL, so it was
  --    already fail-closed structurally — this guard makes that guarantee an
  --    explicit, independently verifiable early-return rather than relying on
  --    SQL NULL-comparison semantics alone.
  IF NOT v_is_super AND v_my_org IS NULL THEN
    RETURN;
  END IF;

  -- 3. DASHBOARD-CONDITION-COUNTS-054-A: reproduce avail_select_org's exact
  --    scope decision. A super_admin caller gets one row per active
  --    organization; a non-super caller gets only their own organization's
  --    row — matching today's effective getInstitutionOverviews() behavior,
  --    since avail_select_org already hides every other org's
  --    item_availability rows from a non-super caller.
  --
  --    Bucket logic (mirrors getInstitutionOverviews()'s JS grouping exactly):
  --      available bucket: condition IN ('available', 'surplus')
  --      low bucket:        condition IN ('low_stock', 'near_expiry')
  --      missing bucket:    condition IN ('missing', 'expired')
  --    removed_at IS NULL excludes rows an explicit removal operation
  --    (migration 053) has marked — genuine missing rows (condition =
  --    'missing' AND removed_at IS NULL) are still counted normally. NOT
  --    v_is_super callers reaching this point are guaranteed by step 2 above
  --    to have a non-NULL v_my_org.
  RETURN QUERY
  SELECT
    o.id AS organization_id,
    COALESCE(SUM(CASE WHEN ia.condition IN ('available', 'surplus') THEN 1 ELSE 0 END), 0)::integer AS available,
    COALESCE(SUM(CASE WHEN ia.condition IN ('low_stock', 'near_expiry') THEN 1 ELSE 0 END), 0)::integer AS low,
    COALESCE(SUM(CASE WHEN ia.condition IN ('missing', 'expired') THEN 1 ELSE 0 END), 0)::integer AS missing
  FROM public.organizations o
  LEFT JOIN public.item_availability ia
    ON ia.organization_id = o.id
   AND ia.removed_at IS NULL
  WHERE o.status = 'active'
    AND (v_is_super OR o.id = v_my_org)
  GROUP BY o.id;
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_get_institution_condition_counts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_get_institution_condition_counts() TO authenticated;

-- =============================================================================
-- VERIFY
-- =============================================================================

DO $$
DECLARE
  v_fn_def    text;
  v_fn_active text;
BEGIN
  -- V1: both functions exist
  ASSERT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'phoenix_get_dashboard_condition_counts'
  ), 'VERIFY FAILED: phoenix_get_dashboard_condition_counts missing';

  ASSERT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'phoenix_get_institution_condition_counts'
  ), 'VERIFY FAILED: phoenix_get_institution_condition_counts missing';

  -- V2: both functions are SECURITY DEFINER with SET search_path = public
  ASSERT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'phoenix_get_dashboard_condition_counts'
      AND p.prosecdef = true
      AND EXISTS (
        SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg = 'search_path=public'
      )
  ), 'VERIFY FAILED: phoenix_get_dashboard_condition_counts is not SECURITY DEFINER with search_path=public';

  ASSERT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'phoenix_get_institution_condition_counts'
      AND p.prosecdef = true
      AND EXISTS (
        SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg = 'search_path=public'
      )
  ), 'VERIFY FAILED: phoenix_get_institution_condition_counts is not SECURITY DEFINER with search_path=public';

  -- V3: both function bodies apply removed_at IS NULL
  SELECT pg_get_functiondef(p.oid) INTO v_fn_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'phoenix_get_dashboard_condition_counts';
  ASSERT v_fn_def ~* 'removed_at\s+is\s+null',
    'VERIFY FAILED: phoenix_get_dashboard_condition_counts does not filter removed_at IS NULL';
  ASSERT v_fn_def ILIKE '%condition = ''missing''%',
    'VERIFY FAILED: phoenix_get_dashboard_condition_counts does not count genuine missing rows';

  SELECT pg_get_functiondef(p.oid) INTO v_fn_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'phoenix_get_institution_condition_counts';
  ASSERT v_fn_def ~* 'removed_at\s+is\s+null',
    'VERIFY FAILED: phoenix_get_institution_condition_counts does not filter removed_at IS NULL';
  ASSERT v_fn_def ILIKE '%''missing''%',
    'VERIFY FAILED: phoenix_get_institution_condition_counts does not count genuine missing rows';

  -- V3b: HARDEN-MIGRATION-054-NULL-ORG-FAIL-CLOSED-A — both functions must
  -- carry an explicit "NOT v_is_super AND v_my_org IS NULL" fail-closed guard
  -- that runs BEFORE any org-scoping logic that could otherwise interpret a
  -- NULL effective org as "show every organization." Regex uses \s+ instead
  -- of a brittle exact-whitespace match so reformatting the guard's own
  -- indentation does not break this check.
  SELECT pg_get_functiondef(p.oid) INTO v_fn_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'phoenix_get_dashboard_condition_counts';
  ASSERT v_fn_def ~* 'NOT\s+v_is_super\s+AND\s+v_my_org\s+IS\s+NULL',
    'VERIFY FAILED: phoenix_get_dashboard_condition_counts is missing the NOT v_is_super AND v_my_org IS NULL fail-closed guard';
  -- The guard's own RETURN must build a literal all-zero jsonb object — not
  -- the COALESCE(v_available, 0)-style final aggregate return further down,
  -- which never has a bare `0` immediately after the `'available',` key.
  ASSERT v_fn_def ~* '''available''\s*,\s*0'
     AND v_fn_def ~* '''low_stock''\s*,\s*0'
     AND v_fn_def ~* '''missing''\s*,\s*0'
     AND v_fn_def ~* '''near_expiry''\s*,\s*0'
     AND v_fn_def ~* '''surplus''\s*,\s*0',
    'VERIFY FAILED: phoenix_get_dashboard_condition_counts fail-closed guard does not return an all-zero-count jsonb object';
  ASSERT POSITION('NOT v_is_super AND v_my_org IS NULL' IN v_fn_def)
       < POSITION('v_effective_org := CASE WHEN v_is_super' IN v_fn_def),
    'VERIFY FAILED: phoenix_get_dashboard_condition_counts fail-closed guard does not run before the org-scoping assignment';

  SELECT pg_get_functiondef(p.oid) INTO v_fn_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'phoenix_get_institution_condition_counts';
  ASSERT v_fn_def ~* 'NOT\s+v_is_super\s+AND\s+v_my_org\s+IS\s+NULL',
    'VERIFY FAILED: phoenix_get_institution_condition_counts is missing the NOT v_is_super AND v_my_org IS NULL fail-closed guard';
  -- The guard's own early exit must be a bare RETURN (no rows) — distinct
  -- from the function's only other RETURN statement, RETURN QUERY, which
  -- actually produces the aggregated rows.
  ASSERT v_fn_def ~* 'IS\s+NULL\s+THEN\s+RETURN\s*;',
    'VERIFY FAILED: phoenix_get_institution_condition_counts fail-closed guard does not RETURN with no rows';
  ASSERT POSITION('NOT v_is_super AND v_my_org IS NULL' IN v_fn_def)
       < POSITION('RETURN QUERY' IN v_fn_def),
    'VERIFY FAILED: phoenix_get_institution_condition_counts fail-closed guard does not run before RETURN QUERY';

  -- V3c: HARDEN-MIGRATION-054-NULL-ROLE-FAIL-CLOSED-A — both functions must
  -- compute v_is_super via COALESCE(v_role = 'super_admin', false), not a
  -- bare boolean expression, so a NULL phoenix_my_role() (broken/incomplete
  -- profile) is coerced to false rather than propagating NULL through the
  -- three-valued-logic `NOT v_is_super` guard above. Regex uses \s* so
  -- reformatting whitespace inside the COALESCE call does not break this
  -- check.
  SELECT pg_get_functiondef(p.oid) INTO v_fn_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'phoenix_get_dashboard_condition_counts';
  ASSERT v_fn_def ~* 'COALESCE\s*\(\s*v_role\s*=\s*''super_admin''\s*,\s*false\s*\)',
    'VERIFY FAILED: phoenix_get_dashboard_condition_counts does not treat NULL role as non-super via COALESCE(v_role = ''super_admin'', false)';
  ASSERT POSITION('COALESCE(v_role = ''super_admin''' IN v_fn_def)
       < POSITION('NOT v_is_super AND v_my_org IS NULL' IN v_fn_def),
    'VERIFY FAILED: phoenix_get_dashboard_condition_counts COALESCE-hardened v_is_super assignment does not run before the NULL-org fail-closed guard';

  SELECT pg_get_functiondef(p.oid) INTO v_fn_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'phoenix_get_institution_condition_counts';
  ASSERT v_fn_def ~* 'COALESCE\s*\(\s*v_role\s*=\s*''super_admin''\s*,\s*false\s*\)',
    'VERIFY FAILED: phoenix_get_institution_condition_counts does not treat NULL role as non-super via COALESCE(v_role = ''super_admin'', false)';
  ASSERT POSITION('COALESCE(v_role = ''super_admin''' IN v_fn_def)
       < POSITION('NOT v_is_super AND v_my_org IS NULL' IN v_fn_def),
    'VERIFY FAILED: phoenix_get_institution_condition_counts COALESCE-hardened v_is_super assignment does not run before the NULL-org fail-closed guard';

  -- V4: functional smoke test — dashboard RPC returns all five keys with
  -- integer-ish (numeric jsonb) values, even against an empty/no-auth-safe
  -- default. Called directly (bypassing the auth.uid() check is not
  -- possible here since this DO block runs as the migration owner, not an
  -- authenticated app user) — so instead this only proves the function's
  -- shape/columns exist by inspecting its declared return type via a dummy
  -- structural check on the source: all five keys must be present as
  -- jsonb_build_object literals.
  ASSERT v_fn_def IS NOT NULL, 'VERIFY FAILED: could not load phoenix_get_institution_condition_counts source';

  SELECT pg_get_functiondef(p.oid) INTO v_fn_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'phoenix_get_dashboard_condition_counts';
  ASSERT v_fn_def ILIKE '%''available''%'
     AND v_fn_def ILIKE '%''low_stock''%'
     AND v_fn_def ILIKE '%''missing''%'
     AND v_fn_def ILIKE '%''near_expiry''%'
     AND v_fn_def ILIKE '%''surplus''%',
    'VERIFY FAILED: phoenix_get_dashboard_condition_counts is missing one of the five required dashboard keys';

  -- V5: institution RPC declares the required output columns
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.routines r
    WHERE r.routine_schema = 'public' AND r.routine_name = 'phoenix_get_institution_condition_counts'
      AND r.data_type = 'record'
  ) OR EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'phoenix_get_institution_condition_counts'
  ), 'VERIFY FAILED: phoenix_get_institution_condition_counts routine not found';

  ASSERT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL unnest(p.proargnames) WITH ORDINALITY AS a(name, ord)
    WHERE n.nspname = 'public' AND p.proname = 'phoenix_get_institution_condition_counts'
      AND a.name = 'organization_id'
  ), 'VERIFY FAILED: phoenix_get_institution_condition_counts missing organization_id output column';

  ASSERT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL unnest(p.proargnames) WITH ORDINALITY AS a(name, ord)
    WHERE n.nspname = 'public' AND p.proname = 'phoenix_get_institution_condition_counts'
      AND a.name = 'available'
  ), 'VERIFY FAILED: phoenix_get_institution_condition_counts missing available output column';

  ASSERT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL unnest(p.proargnames) WITH ORDINALITY AS a(name, ord)
    WHERE n.nspname = 'public' AND p.proname = 'phoenix_get_institution_condition_counts'
      AND a.name = 'low'
  ), 'VERIFY FAILED: phoenix_get_institution_condition_counts missing low output column';

  ASSERT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL unnest(p.proargnames) WITH ORDINALITY AS a(name, ord)
    WHERE n.nspname = 'public' AND p.proname = 'phoenix_get_institution_condition_counts'
      AND a.name = 'missing'
  ), 'VERIFY FAILED: phoenix_get_institution_condition_counts missing missing output column';

  -- V6: no grants to anon or PUBLIC on either function; authenticated has EXECUTE
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public' AND routine_name = 'phoenix_get_dashboard_condition_counts'
      AND grantee IN ('anon', 'PUBLIC')
  ), 'VERIFY FAILED: anon/PUBLIC gained EXECUTE on phoenix_get_dashboard_condition_counts';

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public' AND routine_name = 'phoenix_get_dashboard_condition_counts'
      AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
  ), 'VERIFY FAILED: authenticated missing EXECUTE on phoenix_get_dashboard_condition_counts';

  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public' AND routine_name = 'phoenix_get_institution_condition_counts'
      AND grantee IN ('anon', 'PUBLIC')
  ), 'VERIFY FAILED: anon/PUBLIC gained EXECUTE on phoenix_get_institution_condition_counts';

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public' AND routine_name = 'phoenix_get_institution_condition_counts'
      AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'
  ), 'VERIFY FAILED: authenticated missing EXECUTE on phoenix_get_institution_condition_counts';

  -- V7: security guardrails on both functions, using comment-stripped source
  -- to avoid the migration-053 false-positive class (a `--` comment
  -- containing ordinary prose colliding with a raw substring ban).
  FOR v_fn_def IN
    SELECT pg_get_functiondef(p.oid)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'phoenix_get_dashboard_condition_counts',
        'phoenix_get_institution_condition_counts'
      )
  LOOP
    v_fn_active := regexp_replace(v_fn_def, '--[^\r\n]*', '', 'g');

    ASSERT v_fn_active NOT ILIKE '%service_role%',
      'VERIFY FAILED: service_role reference found in a dashboard condition-count function';
    ASSERT v_fn_active NOT ILIKE '%auth.admin%',
      'VERIFY FAILED: auth.admin reference found in a dashboard condition-count function';
    ASSERT v_fn_active NOT ILIKE '%https://%'
       AND v_fn_active NOT ILIKE '%http://%'
       AND v_fn_active NOT ILIKE '%pg_net%'
       AND v_fn_active NOT ILIKE '%net.http%'
       AND v_fn_active NOT ILIKE '%bearer%'
       AND v_fn_active NOT ILIKE '%access_token%',
      'VERIFY FAILED: external API/token/network reference found in a dashboard condition-count function';
    ASSERT v_fn_active NOT ILIKE '%DROP TABLE%' AND v_fn_active NOT ILIKE '%TRUNCATE%',
      'VERIFY FAILED: DROP TABLE/TRUNCATE found in a dashboard condition-count function';
    ASSERT v_fn_active NOT ILIKE '%DELETE FROM item_availability%'
       AND v_fn_active NOT ILIKE '%delete from item_availability%',
      'VERIFY FAILED: DELETE FROM item_availability found in a dashboard condition-count function';
    ASSERT v_fn_active NOT ILIKE '%removed_by%'
       AND v_fn_active NOT ILIKE '%item_availability_id%'
       AND v_fn_active NOT ILIKE '%auth.uid()::text%',
      'VERIFY FAILED: a dashboard condition-count function exposes a disallowed field';
  END LOOP;

  -- V8: no schema/table change was introduced by this migration (no ALTER
  -- TABLE / CREATE TABLE / ADD COLUMN anywhere in this file's own text is
  -- checked at the test-file level via static source inspection; here we
  -- confirm item_availability's column set is unchanged from migration 053).
  ASSERT (
    SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'item_availability'
      AND column_name IN ('removed_at', 'removed_by', 'removal_reason')
  ) = 3, 'VERIFY FAILED: item_availability removed_at/removed_by/removal_reason columns missing (unexpected schema drift)';

  RAISE NOTICE 'Migration 054 verification passed: phoenix_get_dashboard_condition_counts and phoenix_get_institution_condition_counts created, both SECURITY DEFINER with search_path=public, both filter removed_at IS NULL while still counting genuine missing rows, both scoped to super_admin (all orgs) vs non-super (own org only) matching avail_select_org, both fail CLOSED (zero counts / no rows) for a non-super OR NULL-role caller with NULL organization_id (v_is_super computed via COALESCE(v_role = ''super_admin'', false)), no anon/PUBLIC grants, authenticated has EXECUTE, no schema change, no data mutation.';
END $$;

commit;

-- =============================================================================
-- POST-APPLY MANUAL VERIFICATION (run in Supabase SQL Editor)
-- =============================================================================
--
-- 1. As a super_admin, with no org filter:
--    SELECT phoenix_get_dashboard_condition_counts();
--    -- Expected: counts across ALL organizations' non-removed rows, matching
--    -- the sum of what getDashboardMetrics() currently returns with no orgId.
--
-- 2. As a super_admin, with an explicit org:
--    SELECT phoenix_get_dashboard_condition_counts('<some org uuid>');
--    -- Expected: counts scoped to only that org's non-removed rows.
--
-- 3. As a non-super caller (hospital_admin/warehouse_manager/point_operator/
--    viewer), with or without an org id argument:
--    SELECT phoenix_get_dashboard_condition_counts();
--    SELECT phoenix_get_dashboard_condition_counts('<some OTHER org uuid>');
--    -- Expected: both calls return IDENTICAL counts — the caller's own org
--    -- only. The second call must NOT leak the other org's counts.
--
-- 4. As a super_admin:
--    SELECT * FROM phoenix_get_institution_condition_counts();
--    -- Expected: one row per active organization, available/low/missing
--    -- matching what getInstitutionOverviews() currently computes in JS.
--
-- 5. As a non-super caller:
--    SELECT * FROM phoenix_get_institution_condition_counts();
--    -- Expected: exactly one row — the caller's own organization.
--
-- 6. HARDEN-MIGRATION-054-NULL-ORG-FAIL-CLOSED-A: as a non-super caller
--    whose profile's organization_id is NULL (temporarily UPDATE profiles
--    SET organization_id = NULL WHERE id = '<test user>' in a throwaway test
--    account, never in production data):
--    SELECT phoenix_get_dashboard_condition_counts();
--    -- Expected: {"available":0,"low_stock":0,"missing":0,"near_expiry":0,"surplus":0}
--    SELECT * FROM phoenix_get_institution_condition_counts();
--    -- Expected: zero rows.
--
-- 7. HARDEN-MIGRATION-054-NULL-ROLE-FAIL-CLOSED-A: as a caller whose profile
--    has BOTH role and organization_id set to NULL (temporarily UPDATE
--    profiles SET role = NULL, organization_id = NULL WHERE id = '<test
--    user>' in a throwaway test account, never in production data):
--    SELECT phoenix_get_dashboard_condition_counts();
--    -- Expected: {"available":0,"low_stock":0,"missing":0,"near_expiry":0,"surplus":0}
--    -- (NOT all-organization counts — proves v_is_super was coerced to
--    -- false rather than remaining NULL and short-circuiting the guard.)
--    SELECT * FROM phoenix_get_institution_condition_counts();
--    -- Expected: zero rows.
--
-- =============================================================================
-- END OF MIGRATION 054
-- PHASE2-DASHBOARD-PERFORMANCE-RPCS-054-A
-- =============================================================================
