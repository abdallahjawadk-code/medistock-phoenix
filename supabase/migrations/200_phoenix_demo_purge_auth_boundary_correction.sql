-- ============================================================================
-- MEDISTOCK PHOENIX v2.1 — DEMO PURGE AUTH-BOUNDARY CORRECTION — 200
--
-- Fixes UAT-BUG-001: public.phoenix_demo_purge(text, boolean) cannot execute
-- on a real Supabase-shaped database, so the PHOENIX_DEMO_V1 dataset is
-- UNPURGEABLE in Production.
--
-- CONFIRMED PRODUCTION EVIDENCE (independent read-only verification):
--     auth schema owner                                    = supabase_admin
--     has_schema_privilege('phoenix_demo_purger','auth','USAGE') = FALSE
--     has_schema_privilege('postgres','auth','USAGE')            = TRUE
--     has_schema_privilege('authenticated','auth','USAGE')       = TRUE
--     has_schema_privilege('service_role','auth','USAGE')        = TRUE
--
-- ROOT CAUSE
--   phoenix_demo_purge is SECURITY DEFINER owned by phoenix_demo_purger, and
--   its body opens with a bare `auth.uid()`. SECURITY DEFINER makes
--   current_user = phoenix_demo_purger for that call, and that role cannot
--   traverse schema auth, so every invocation — dry-run included — aborts:
--
--     ERROR:  42501: permission denied for schema auth
--     QUERY:  auth.uid() IS NULL
--     CONTEXT: PL/pgSQL function phoenix_demo_purge(text,boolean) line 15 at IF
--
--   Migration 141 intended to prevent exactly this, with
--     GRANT USAGE ON SCHEMA auth TO phoenix_demo_purger;
--   but that statement is issued by the applying role (postgres), which holds
--   USAGE on auth WITHOUT grant option and is not a member of the owner
--   (supabase_admin). PostgreSQL answers such a GRANT with a WARNING —
--   "no privileges were granted for \"auth\"" — and NOT an error, so 141
--   reported success while granting nothing. GRANT is not fail-closed; that is
--   why this migration VERIFIES the privileges it depends on instead of
--   trusting a GRANT to have taken effect.
--
-- WHY NOT SIMPLY RE-ISSUE THE GRANT
--   It would fail the same silent way (same grantor, same missing grant
--   option), and "fix it by widening auth-schema access for a purge role" is
--   the wrong direction regardless: it would hand schema-auth traversal to a
--   role whose entire purpose is to bypass immutable-history triggers. This
--   migration therefore requires NO new privilege on schema auth at all —
--   after it, phoenix_demo_purger may keep auth USAGE = FALSE forever and the
--   purge still works. The accompanying dynamic test asserts precisely that,
--   so the fix can never silently regress into depending on the broken GRANT.
--
-- THE CORRECTION — separate CALLER AUTHORIZATION from PURGE EXECUTION
--   A. public.phoenix_demo_purge(text, boolean)   [unchanged signature]
--        SECURITY DEFINER, OWNER postgres, search_path public, pg_temp.
--        Does authorization ONLY: auth.uid(), super_admin, dataset key,
--        dry-run normalization. It runs as postgres, which genuinely holds
--        auth USAGE in a Supabase-shaped database (measured above), so the
--        identity check it must perform is one it can actually perform.
--
--   B. public._phoenix_200_demo_purge_execute(text, boolean)   [new, internal]
--        SECURITY DEFINER, OWNER phoenix_demo_purger, search_path public,
--        pg_temp. Carries the purge algorithm verbatim and contains NO
--        auth.uid() and NO caller-role check. Ownership is load-bearing, not
--        cosmetic: migrations 141/142/144 exempt the immutable-history and
--        profile-detach paths on `current_user = 'phoenix_demo_purger'`, and
--        that must remain true while the DELETEs run.
--
--   Naming follows the established internal-delegate convention already used
--   by migration 149 (public._phoenix_149_delegate_*).
--
-- WHY THE SPLIT IS SUFFICIENT — MEASURED, NOT ASSUMED
--   Every function the executor reaches was checked for schema-auth
--   dependence. None of phoenix_demo_purgeable_tables,
--   phoenix_demo_manifest_row_ids, phoenix_demo_org_blockers,
--   phoenix_demo_detach_profiles or phoenix_demo_row_is_purgeable references
--   auth at all. Every auth-referencing TRIGGER function that fires on a
--   purgeable table — phoenix_capture_lifecycle_event,
--   phoenix_populate_actor_snapshot, phoenix_guard_dp_archive_update,
--   _phoenix_warehouse_facility_assignment_guard_v1 — is SECURITY DEFINER
--   OWNED BY postgres, so it traverses auth as postgres regardless of the
--   current_user that fired it. The bare auth.uid() in the purge body was the
--   only offender, and it moves to the wrapper.
--
-- PUBLIC CONTRACT PRESERVED EXACTLY
--   Same signature, same RETURNS TABLE(table_name text, affected bigint,
--   executed boolean), same dry-run default of true, same NULL-dry-run
--   normalization, same table ordering, same 'profiles:detached',
--   'organizations:blocked' and non-purgeable reporting rows, same
--   restrict_violation / foreign_key_violation survival, same manifest
--   cleanup and resumability, same super_admin-only access and same SQLSTATEs
--   (28000 / 42501 / 23514 / 22023). No frontend or service change is needed.
--
-- SECURITY CONTRACT
--   * the internal executor is NOT reachable by PUBLIC, anon or authenticated
--   * it is reachable only from the wrapper's own definer context (postgres)
--   * obscurity is never the boundary — the ACL is asserted in VERIFY below
--   * no new privilege is granted on schema auth to any role
--   * phoenix_demo_purger gains nothing; it keeps exactly what 141 gave it
--   * both routines pin search_path to public, pg_temp (the M198 convergence)
--
-- This migration creates no table, index, policy, sequence, counter, document
-- number or generated identity, seeds no permission, and mutates no business
-- data. It replaces one function body, adds one internal routine, and moves
-- one ownership.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. PRECONDITIONS — fail closed rather than produce a differently-shaped fix.
-- ---------------------------------------------------------------------------
DO $precond$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'phoenix_demo_purger') THEN
    RAISE EXCEPTION '200 PRECONDITION FAILED: role phoenix_demo_purger is missing (migration 141 did not apply)';
  END IF;

  IF to_regprocedure('public.phoenix_demo_purge(text, boolean)') IS NULL THEN
    RAISE EXCEPTION '200 PRECONDITION FAILED: public.phoenix_demo_purge(text, boolean) does not exist';
  END IF;

  -- The wrapper's whole purpose is to run the identity check as a role that
  -- can actually traverse auth. If the applying role cannot either, this
  -- correction would move the failure rather than remove it.
  IF NOT has_schema_privilege(current_user, 'auth', 'USAGE') THEN
    RAISE EXCEPTION
      '200 PRECONDITION FAILED: applying role % lacks USAGE on schema auth; the wrapper could not resolve auth.uid()',
      current_user;
  END IF;

  -- Ownership of the executor must be transferable to phoenix_demo_purger,
  -- which requires membership. 141 established it; assert rather than assume.
  IF NOT pg_has_role(current_user, 'phoenix_demo_purger', 'USAGE') THEN
    RAISE EXCEPTION
      '200 PRECONDITION FAILED: applying role % is not a member of phoenix_demo_purger', current_user;
  END IF;
END;
$precond$;

-- ---------------------------------------------------------------------------
-- 1. INTERNAL EXECUTOR — the purge algorithm, unchanged.
--
-- Lifted verbatim from the post-160 body of phoenix_demo_purge, with ONLY the
-- four caller-authorization guards removed (they now live in the wrapper). The
-- dataset-key guard is deliberately RETAINED here as defence in depth: it
-- needs no auth traversal, and it means this routine cannot be coerced into
-- purging some other dataset key even if it were somehow reached directly.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._phoenix_200_demo_purge_execute(
  p_dataset_key text,
  p_dry_run     boolean
)
RETURNS TABLE(table_name text, affected bigint, executed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tables text[] := public.phoenix_demo_purgeable_tables();
  v_table  text;
  v_count  bigint;
  v_ids    uuid[];
  v_org           uuid;
  v_org_deleted   bigint;
  v_block_rows    bigint;
  v_block_tables  bigint;
  v_blocked_orgs  uuid[] := ARRAY[]::uuid[];
  v_detached      bigint;
  v_dry    boolean := COALESCE(p_dry_run, true);
BEGIN
  -- Defence in depth. Caller authorization is the wrapper's job and is NOT
  -- repeated here (it could not be: this routine deliberately cannot reach
  -- auth). The dataset key is not caller authority, so guarding it is free.
  IF p_dataset_key IS NULL OR btrim(p_dataset_key) = '' THEN
    RAISE EXCEPTION 'dataset_key_required' USING ERRCODE = '23514';
  END IF;
  IF p_dataset_key <> 'PHOENIX_DEMO_V1' THEN
    RAISE EXCEPTION 'invalid_demo_dataset_key' USING ERRCODE = '22023';
  END IF;

  -- Owned rows in a table that is not purgeable at all: reported, never hidden.
  RETURN QUERY
  SELECT m.table_name, count(*)::bigint, false
    FROM public.phoenix_demo_manifest m
   WHERE m.dataset_key = p_dataset_key
     AND NOT (m.table_name = ANY (v_tables))
     AND m.table_name <> 'profiles'
   GROUP BY m.table_name;

  FOREACH v_table IN ARRAY v_tables LOOP
    IF to_regclass('public.' || quote_ident(v_table)) IS NULL THEN
      CONTINUE;
    END IF;
    v_ids := public.phoenix_demo_manifest_row_ids(v_table);
    IF array_length(v_ids, 1) IS NULL THEN
      CONTINUE;
    END IF;

    IF v_table = 'organizations' THEN
      -- 142: detach demo profiles FIRST, so the preflight below can succeed.
      v_detached := public.phoenix_demo_detach_profiles(v_dry);
      IF v_detached > 0 THEN
        table_name := 'profiles:detached';
        affected   := v_detached;
        executed   := NOT v_dry;
        RETURN NEXT;
      END IF;

      v_org_deleted := 0;
      FOREACH v_org IN ARRAY v_ids LOOP
        -- Re-run the COMPLETE 40-FK preflight AFTER detachment.
        SELECT coalesce(sum(b.reference_count), 0), count(*)
          INTO v_block_rows, v_block_tables
          FROM public.phoenix_demo_org_blockers(v_org) b;

        IF v_block_tables > 0 THEN
          IF NOT v_dry THEN
            table_name := 'organizations:blocked';
            affected   := v_block_rows;
            executed   := false;
            RETURN NEXT;
          END IF;
          v_blocked_orgs := array_append(v_blocked_orgs, v_org);
          CONTINUE;
        END IF;

        IF NOT v_dry THEN
          DELETE FROM public.organizations o WHERE o.id = v_org;
        END IF;
        v_org_deleted := v_org_deleted + 1;
      END LOOP;

      IF v_org_deleted > 0 THEN
        table_name := 'organizations';
        affected   := v_org_deleted;
        executed   := NOT v_dry;
        RETURN NEXT;
      END IF;
      CONTINUE;
    END IF;

    IF v_dry THEN
      EXECUTE format('SELECT count(*)::bigint FROM public.%I t WHERE t.id = ANY($1)', v_table)
        INTO v_count USING v_ids;
    ELSE
      -- A parent the dataset owns can still be pinned by a child it does NOT
      -- own (a genuine row, or a demo row a previous partial run left
      -- behind). That refusal is correct and must be preserved — but it
      -- must be REPORTED, not allowed to abort the whole purge.
      --
      -- 143: a RESTRICT-action foreign key raises restrict_violation
      -- (23001), a SIBLING condition of foreign_key_violation (23503) —
      -- PL/pgSQL does not catch one under a WHEN clause naming the other.
      -- Catching only foreign_key_violation therefore missed exactly the
      -- shape of block this whole mechanism exists to survive; both are
      -- caught here, and nothing else is.
      BEGIN
        EXECUTE format(
          'WITH deleted AS (DELETE FROM public.%I t WHERE t.id = ANY($1) RETURNING 1)
           SELECT count(*)::bigint FROM deleted', v_table)
          INTO v_count USING v_ids;
      EXCEPTION
        WHEN foreign_key_violation OR restrict_violation THEN
          table_name := v_table;
          affected   := 0;
          executed   := false;
          RETURN NEXT;
          CONTINUE;
      END;
    END IF;

    IF v_count > 0 THEN
      table_name := v_table;
      affected   := v_count;
      executed   := NOT v_dry;
      RETURN NEXT;
    END IF;
  END LOOP;

  IF NOT v_dry THEN
    -- Forget ownership only of rows genuinely gone. Blocked organizations keep
    -- their entry so the purge stays resumable. Detached profiles keep theirs
    -- too: the tombstone still belongs to the dataset and must stay auditable.
    DELETE FROM public.phoenix_demo_manifest m
     WHERE m.dataset_key = p_dataset_key
       AND m.table_name = ANY (v_tables)
       AND NOT (m.table_name = 'organizations' AND m.row_id = ANY (v_blocked_orgs));
  END IF;
END;
$function$;

-- The immutable-history and profile-detach exemptions (141/142/144) all key on
-- current_user = 'phoenix_demo_purger', so the executor MUST run as that role.
ALTER FUNCTION public._phoenix_200_demo_purge_execute(text, boolean)
  OWNER TO phoenix_demo_purger;

-- Not client-callable. The boundary is the ACL, never the leading underscore.
--
-- service_role is revoked EXPLICITLY, and that is not redundant: the platform
-- baseline carries
--     ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO service_role;
-- so every newly created function in this schema is granted to service_role at
-- CREATE time whether or not anyone asked. Leaving it would expose the
-- authorization-free executor on PostgREST's /rest/v1/rpc surface to any
-- holder of the service key — a destructive purge reachable without the
-- super_admin check the wrapper exists to enforce. The wrapper keeps its own
-- service_role grant, exactly as 140/141/143 left it, so no existing caller
-- changes: a service-role caller still goes through the wrapper and still has
-- to present a super_admin identity.
REVOKE ALL ON FUNCTION public._phoenix_200_demo_purge_execute(text, boolean)
  FROM PUBLIC, anon, authenticated, service_role;

-- The wrapper's definer context is postgres; without this the wrapper cannot
-- reach the executor at all.
GRANT EXECUTE ON FUNCTION public._phoenix_200_demo_purge_execute(text, boolean)
  TO postgres;

-- ---------------------------------------------------------------------------
-- 2. PUBLIC WRAPPER — authorization only, then delegate.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phoenix_demo_purge(
  p_dataset_key text,
  p_dry_run     boolean DEFAULT true
)
RETURNS TABLE(table_name text, affected bigint, executed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Identity and authority, in the ORIGINAL order and with the ORIGINAL
  -- SQLSTATEs, so no caller observes a different refusal than before.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF public.phoenix_my_role() <> 'super_admin' THEN
    RAISE EXCEPTION 'forbidden_demo_purge' USING ERRCODE = '42501';
  END IF;
  IF p_dataset_key IS NULL OR btrim(p_dataset_key) = '' THEN
    RAISE EXCEPTION 'dataset_key_required' USING ERRCODE = '23514';
  END IF;
  IF p_dataset_key <> 'PHOENIX_DEMO_V1' THEN
    RAISE EXCEPTION 'invalid_demo_dataset_key' USING ERRCODE = '22023';
  END IF;

  -- Dry-run normalization stays HERE as well as in the executor, so the
  -- documented default survives however the executor is reached.
  RETURN QUERY
  SELECT e.table_name, e.affected, e.executed
    FROM public._phoenix_200_demo_purge_execute(
           p_dataset_key, COALESCE(p_dry_run, true)) e;
END;
$function$;

-- The wrapper must run as a role that can traverse schema auth. That is the
-- entire correction: 141's grant to phoenix_demo_purger never took effect, and
-- postgres already holds this privilege in Production (measured).
ALTER FUNCTION public.phoenix_demo_purge(text, boolean) OWNER TO postgres;

-- Unchanged from 140/141/143: authenticated may call it, PUBLIC and anon may not.
REVOKE ALL ON FUNCTION public.phoenix_demo_purge(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_demo_purge(text, boolean) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. VERIFY — prove the contract rather than trusting the statements above.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_wrapper_owner  text;
  v_exec_owner     text;
  v_wrapper_def    text;
  v_exec_def       text;
  v_wrapper_cfg    text;
  v_exec_cfg       text;
BEGIN
  IF to_regprocedure('public._phoenix_200_demo_purge_execute(text, boolean)') IS NULL THEN
    RAISE EXCEPTION '200 VERIFY FAILED: internal executor missing';
  END IF;

  SELECT pg_get_userbyid(proowner), coalesce(array_to_string(proconfig, ', '), '')
    INTO v_wrapper_owner, v_wrapper_cfg
    FROM pg_proc WHERE oid = to_regprocedure('public.phoenix_demo_purge(text, boolean)');
  SELECT pg_get_userbyid(proowner), coalesce(array_to_string(proconfig, ', '), '')
    INTO v_exec_owner, v_exec_cfg
    FROM pg_proc WHERE oid = to_regprocedure('public._phoenix_200_demo_purge_execute(text, boolean)');

  IF v_wrapper_owner <> 'postgres' THEN
    RAISE EXCEPTION '200 VERIFY FAILED: wrapper owner is %, expected postgres', v_wrapper_owner;
  END IF;
  IF v_exec_owner <> 'phoenix_demo_purger' THEN
    RAISE EXCEPTION '200 VERIFY FAILED: executor owner is %, expected phoenix_demo_purger', v_exec_owner;
  END IF;

  -- Both must remain SECURITY DEFINER; the whole design depends on it.
  IF NOT (SELECT prosecdef FROM pg_proc
           WHERE oid = to_regprocedure('public.phoenix_demo_purge(text, boolean)'))
     OR NOT (SELECT prosecdef FROM pg_proc
           WHERE oid = to_regprocedure('public._phoenix_200_demo_purge_execute(text, boolean)')) THEN
    RAISE EXCEPTION '200 VERIFY FAILED: both routines must be SECURITY DEFINER';
  END IF;

  -- M198's convergence must hold for anything added afterwards.
  IF v_wrapper_cfg <> 'search_path=public, pg_temp'
     OR v_exec_cfg <> 'search_path=public, pg_temp' THEN
    RAISE EXCEPTION '200 VERIFY FAILED: search_path must be "public, pg_temp" (wrapper=%, executor=%)',
      v_wrapper_cfg, v_exec_cfg;
  END IF;

  v_wrapper_def := pg_get_functiondef(to_regprocedure('public.phoenix_demo_purge(text, boolean)'));
  v_exec_def    := pg_get_functiondef(to_regprocedure('public._phoenix_200_demo_purge_execute(text, boolean)'));

  -- The wrapper keeps every caller-authorization clause, with its SQLSTATE.
  IF v_wrapper_def NOT LIKE '%auth.uid()%'
     OR v_wrapper_def NOT LIKE '%phoenix_my_role()%'
     OR v_wrapper_def NOT LIKE '%''28000''%'
     OR v_wrapper_def NOT LIKE '%''42501''%'
     OR v_wrapper_def NOT LIKE '%''23514''%'
     OR v_wrapper_def NOT LIKE '%''22023''%'
     OR v_wrapper_def NOT LIKE '%_phoenix_200_demo_purge_execute%' THEN
    RAISE EXCEPTION '200 VERIFY FAILED: wrapper lost an authorization clause or the delegation';
  END IF;

  -- THE POINT OF THE WHOLE MIGRATION: the executor must never reach auth.
  IF position('auth.' in v_exec_def) > 0 THEN
    RAISE EXCEPTION '200 VERIFY FAILED: executor references schema auth; it cannot, by design';
  END IF;

  -- ...and it must still carry the algorithm, not a stub.
  IF v_exec_def NOT LIKE '%phoenix_demo_detach_profiles%'
     OR v_exec_def NOT LIKE '%phoenix_demo_org_blockers%'
     OR v_exec_def NOT LIKE '%organizations:blocked%'
     OR v_exec_def NOT LIKE '%profiles:detached%'
     OR v_exec_def NOT LIKE '%restrict_violation%'
     OR v_exec_def NOT LIKE '%phoenix_demo_manifest%' THEN
    RAISE EXCEPTION '200 VERIFY FAILED: executor is missing part of the purge algorithm';
  END IF;

  -- The executor is unreachable by any client-facing role.
  IF has_function_privilege('anon',
       'public._phoenix_200_demo_purge_execute(text, boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public._phoenix_200_demo_purge_execute(text, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION '200 VERIFY FAILED: internal executor is reachable by anon/authenticated';
  END IF;
  -- Asserted separately because the platform's default privileges re-grant
  -- service_role at CREATE time: without this check the REVOKE above could
  -- silently stop working and expose the executor on the PostgREST RPC surface.
  IF has_function_privilege('service_role',
       'public._phoenix_200_demo_purge_execute(text, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION '200 VERIFY FAILED: internal executor is reachable by service_role';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_proc p, aclexplode(p.proacl) a
     WHERE p.oid = to_regprocedure('public._phoenix_200_demo_purge_execute(text, boolean)')
       AND a.grantee = 0                      -- 0 is PUBLIC
  ) THEN
    RAISE EXCEPTION '200 VERIFY FAILED: internal executor still carries a PUBLIC grant';
  END IF;

  -- The public entry point keeps exactly the reachability it always had.
  IF NOT has_function_privilege('authenticated',
       'public.phoenix_demo_purge(text, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION '200 VERIFY FAILED: authenticated lost EXECUTE on the public entry point';
  END IF;
  IF has_function_privilege('anon', 'public.phoenix_demo_purge(text, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION '200 VERIFY FAILED: anon gained EXECUTE on the public entry point';
  END IF;

  -- No new privilege on schema auth was granted to anyone by this migration.
  -- phoenix_demo_purger keeping FALSE here is the correction working, not a
  -- residual defect: assert it is not silently required.
  IF has_schema_privilege('phoenix_demo_purger', 'auth', 'USAGE') THEN
    RAISE NOTICE '200: phoenix_demo_purger holds auth USAGE in this environment; the correction does not require it';
  END IF;
END;
$verify$;

COMMIT;
