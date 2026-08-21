-- ═════════════════════════════════════════════════════════════════════════════
-- ALERT-COMMAND-SURFACE-193 — H UNIT 1: INTER-ORG ALERT COMMAND-SURFACE HARDENING
-- ═════════════════════════════════════════════════════════════════════════════
-- Purely a PRIVILEGE and SECURITY-MODE convergence. This migration creates no
-- table, no view, no function, no policy and no permission key; it alters no
-- policy, grants nothing to anyone, and changes no row of business data. It
-- closes the two client-reachable write-capable entry points into the inter-org
-- alert lifecycle and then proves the command path still works:
--
--   AUTHENTICATED_DIRECT_LIFECYCLE_WRITE_ENTRY_POINTS = { }
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 190 split the alert read/write hybrid into a CQRS pair: an explicit
-- COMMAND (phoenix_refresh_inter_org_alert_lifecycle) and pure QUERIES
-- (phoenix_query_live_inter_org_alerts_with_state_page,
-- phoenix_query_live_inter_org_alert_summary). The client was rewired and the
-- hybrid left the client READ path entirely.
--
-- What 190 did NOT do is close the hybrid's own door. Two routines still let an
-- authenticated caller reach the lifecycle writer directly:
--
--   1. public.phoenix_get_live_inter_institution_alerts_with_state(integer)
--      SECURITY DEFINER, VOLATILE, and the SOLE lifecycle writer: it INSERTs
--      into inter_org_alert_states and inter_org_alert_events. It is named like
--      a getter and still carries a direct authenticated EXECUTE grant.
--
--   2. public.phoenix_get_live_inter_institution_alerts_with_state_page(int,int)
--      a legacy paging wrapper that is ITSELF SECURITY DEFINER and calls the
--      hybrid at a hardcoded ceiling of 500. Because it is DEFINER it executes
--      the hybrid AS THE OWNER, so it does NOT need the caller to hold EXECUTE
--      on the hybrid. Revoking (1) alone would leave (2) as a fully working
--      replacement door and this migration would have accomplished nothing.
--
-- Neither is called by any production client file, and (2) has NO caller of any
-- kind - not in the client, not in the database.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY STEP 1 MUST COME FIRST — THE LOAD-BEARING GRANT
-- ─────────────────────────────────────────────────────────────────────────────
-- phoenix_refresh_inter_org_alert_lifecycle(integer) is currently SECURITY
-- INVOKER. An INVOKER function executes its body AS THE CALLING ROLE, so its one
-- statement -
--
--   v_full := public.phoenix_get_live_inter_institution_alerts_with_state(p_limit);
--
-- - is a call made BY authenticated. The command therefore DEPENDS on the very
-- grant this migration removes. Revoking the hybrid from authenticated without
-- first flipping the command to SECURITY DEFINER would break the only sanctioned
-- lifecycle refresh in the product with a bare permission denial.
--
-- Flipping the command to DEFINER is safe and changes NO authorization:
--
--   * The hybrid was ALREADY SECURITY DEFINER owned by postgres, so its body has
--     always executed as postgres regardless of who called it. The only thing
--     that changes is whether the CALLER must additionally hold EXECUTE.
--   * The hybrid authorizes on auth.uid() plus phoenix_profile_has_permission()
--     - never on the database role. auth.uid() is a plain STABLE sql function
--     reading only the request-scoped GUCs request.jwt.claim.sub /
--     request.jwt.claims. SECURITY DEFINER changes current_user; it does not
--     reset, re-scope or shadow a GUC. The JWT actor therefore survives the
--     extra DEFINER hop unchanged.
--   * A DEFINER wrapper calling the DEFINER hybrid is not a new shape here: the
--     legacy paging wrapper being revoked in STEP 3 is exactly that today.
--   * The command grows no capability of its own. It performs no DML, copies no
--     lifecycle statement, and still returns the hybrid's refusals verbatim, so
--     an unauthorized actor receives the identical FORBIDDEN / NOT_AUTHENTICATED
--     payload before and after.
--
-- The command is altered with ALTER FUNCTION ... SECURITY DEFINER rather than
-- CREATE OR REPLACE FUNCTION, so its body, its argument list, its default and
-- its pinned SET search_path = public, pg_temp are carried across untouched by
-- construction rather than by careful retyping. VERIFY block A proves it.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT IS DELIBERATELY NOT TOUCHED
-- ─────────────────────────────────────────────────────────────────────────────
-- public.phoenix_get_live_inter_institution_alerts(integer) - the pure BASE RPC.
--   It is LOAD-BEARING for the pure read chain
--       query_page -> _phoenix_live_inter_org_alert_read_projection_v1 -> base
--   and contains no INSERT, UPDATE, DELETE, MERGE or TRUNCATE. Revoking it for
--   name similarity alone would break the CQRS read path this stage exists to
--   protect. Its ACL, body and security mode are asserted UNCHANGED in VERIFY.
--
-- phoenix_query_live_inter_org_alerts_with_state_page(integer,integer) and
-- phoenix_query_live_inter_org_alert_summary(integer) - the pure QUERIES. They
--   keep authenticated EXECUTE; both are asserted unchanged and write-free.
--
-- No table GRANT, no REVOKE on any relation, no RLS or policy statement, no new
-- permission key, and no second lifecycle writer. service_role and postgres keep
-- every EXECUTE they already had.
--
-- PUBLIC is not revoked from because PUBLIC holds no EXECUTE on either target
-- today; VERIFY asserts that as a fact instead of issuing an unreviewed
-- statement, so a surviving PUBLIC grant fails the migration closed.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- FORWARD-ONLY · ATOMIC · MANUAL APPLY ONLY
-- ─────────────────────────────────────────────────────────────────────────────
-- Everything below runs inside ONE transaction. Every assertion is a RAISE that
-- rolls the whole migration back, so a partially hardened surface - the one
-- state genuinely worse than either endpoint - cannot be committed.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- PRECONDITIONS — refuse to install against a world other than the audited one.
-- ─────────────────────────────────────────────────────────────────────────────
DO $pre$
DECLARE
  v_oid_refresh oid;
  v_oid_hybrid  oid;
  v_oid_page    oid;
  v_cfg         text;
BEGIN
  -- The three routines must exist at EXACTLY these signatures. to_regprocedure
  -- returns NULL rather than raising when they do not.
  v_oid_refresh := to_regprocedure('public.phoenix_refresh_inter_org_alert_lifecycle(integer)');
  v_oid_hybrid  := to_regprocedure('public.phoenix_get_live_inter_institution_alerts_with_state(integer)');
  v_oid_page    := to_regprocedure('public.phoenix_get_live_inter_institution_alerts_with_state_page(integer,integer)');

  IF v_oid_refresh IS NULL THEN
    RAISE EXCEPTION '193_precondition_failed: phoenix_refresh_inter_org_alert_lifecycle(integer) is missing (190)';
  END IF;
  IF v_oid_hybrid IS NULL THEN
    RAISE EXCEPTION '193_precondition_failed: phoenix_get_live_inter_institution_alerts_with_state(integer) is missing (036/039)';
  END IF;
  IF v_oid_page IS NULL THEN
    RAISE EXCEPTION '193_precondition_failed: phoenix_get_live_inter_institution_alerts_with_state_page(integer,integer) is missing';
  END IF;

  -- The command must still be INVOKER. If it is already DEFINER the world has
  -- moved since the audit and STEP 1 is no longer the change that was reviewed.
  IF (SELECT prosecdef FROM pg_proc WHERE oid = v_oid_refresh) THEN
    RAISE EXCEPTION '193_precondition_failed: the refresh command is already SECURITY DEFINER - reconfirm the reviewed baseline before installing';
  END IF;

  -- Its pinned search_path is what makes flipping it to DEFINER safe at all.
  SELECT array_to_string(proconfig, ',') INTO v_cfg FROM pg_proc WHERE oid = v_oid_refresh;
  IF v_cfg IS DISTINCT FROM 'search_path=public, pg_temp' THEN
    RAISE EXCEPTION '193_precondition_failed: the refresh command has search_path %, not the required pinned "public, pg_temp"', coalesce(v_cfg, '<none>');
  END IF;

  -- Both revoke targets must be DEFINER, or the revoke is not closing what the
  -- audit described.
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid_hybrid) THEN
    RAISE EXCEPTION '193_precondition_failed: the hybrid is not SECURITY DEFINER';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid_page) THEN
    RAISE EXCEPTION '193_precondition_failed: the legacy paging wrapper is not SECURITY DEFINER';
  END IF;

  -- The grants being removed must actually be present. Revoking nothing would
  -- make this migration a silent no-op that still records itself as applied.
  IF NOT has_function_privilege('authenticated', v_oid_hybrid, 'EXECUTE') THEN
    RAISE EXCEPTION '193_precondition_failed: authenticated already lacks EXECUTE on the hybrid';
  END IF;
  IF NOT has_function_privilege('authenticated', v_oid_page, 'EXECUTE') THEN
    RAISE EXCEPTION '193_precondition_failed: authenticated already lacks EXECUTE on the legacy paging wrapper';
  END IF;

  -- The command must be reachable by the client before and after.
  IF NOT has_function_privilege('authenticated', v_oid_refresh, 'EXECUTE') THEN
    RAISE EXCEPTION '193_precondition_failed: authenticated cannot execute the refresh command even before hardening';
  END IF;

  -- The pure read chain this migration promises not to disturb must be intact.
  IF to_regprocedure('public.phoenix_get_live_inter_institution_alerts(integer)') IS NULL THEN
    RAISE EXCEPTION '193_precondition_failed: the pure base RPC is missing (036)';
  END IF;
  IF to_regprocedure('public._phoenix_live_inter_org_alert_read_projection_v1(integer)') IS NULL THEN
    RAISE EXCEPTION '193_precondition_failed: the pure read projection is missing (190)';
  END IF;
  IF to_regprocedure('public.phoenix_query_live_inter_org_alerts_with_state_page(integer,integer)') IS NULL THEN
    RAISE EXCEPTION '193_precondition_failed: the pure paged query is missing (190)';
  END IF;
  IF to_regprocedure('public.phoenix_query_live_inter_org_alert_summary(integer)') IS NULL THEN
    RAISE EXCEPTION '193_precondition_failed: the pure summary query is missing (190)';
  END IF;
END;
$pre$;

-- ─────────────────────────────────────────────────────────────────────────────
-- BEFORE-IMAGE — captured so body preservation is PROVEN, not asserted.
--
-- Because STEP 1 uses ALTER rather than CREATE OR REPLACE, prosrc cannot change;
-- this table is what turns "cannot" into evidence. It also pins the ACL and
-- definition of every routine this migration promises NOT to touch, so an
-- accidental collateral change fails the transaction instead of shipping.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE phoenix_193_routine_before AS
SELECT p.oid                                                            AS oid,
       p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig,
       md5(p.prosrc)                                                    AS prosrc_md5,
       p.prosecdef                                                      AS prosecdef,
       p.provolatile                                                    AS provolatile,
       coalesce(array_to_string(p.proconfig, ','), '<none>')            AS proconfig,
       pg_get_userbyid(p.proowner)                                      AS owner,
       coalesce(array_to_string(p.proacl::text[], ' ; '), '<default>')  AS acl,
       has_function_privilege('authenticated', p.oid, 'EXECUTE')        AS auth_x,
       has_function_privilege('anon',          p.oid, 'EXECUTE')        AS anon_x,
       has_function_privilege('service_role',  p.oid, 'EXECUTE')        AS svc_x
FROM pg_proc p
WHERE p.oid IN (
  to_regprocedure('public.phoenix_refresh_inter_org_alert_lifecycle(integer)'),
  to_regprocedure('public.phoenix_get_live_inter_institution_alerts_with_state(integer)'),
  to_regprocedure('public.phoenix_get_live_inter_institution_alerts_with_state_page(integer,integer)'),
  to_regprocedure('public.phoenix_get_live_inter_institution_alerts(integer)'),
  to_regprocedure('public._phoenix_live_inter_org_alert_read_projection_v1(integer)'),
  to_regprocedure('public.phoenix_query_live_inter_org_alerts_with_state_page(integer,integer)'),
  to_regprocedure('public.phoenix_query_live_inter_org_alert_summary(integer)')
);

-- The anon/authenticated relation-privilege surface must be identical after this
-- migration. 192 closed anon completely; 193 must not reopen a single tuple, and
-- must not widen authenticated either.
CREATE TABLE phoenix_193_relpriv_before AS
SELECT g.grantee AS grantee, c.relname AS relname, p.priv AS priv
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN (VALUES ('anon'), ('authenticated')) AS g(grantee)
CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),
                   ('TRUNCATE'),('REFERENCES'),('TRIGGER')) AS p(priv)
WHERE n.nspname = 'public'
  AND c.relkind IN ('r','p','v','m','f')
  AND has_table_privilege(g.grantee, c.oid, p.priv);

-- ═════════════════════════════════════════════════════════════════════════════
-- STEP 1 — FIRST, ALWAYS. Make the sanctioned COMMAND self-sufficient so that
--          STEP 2 cannot strand it. ALTER, never CREATE OR REPLACE: the body,
--          the p_limit integer DEFAULT 500 signature and the pinned
--          SET search_path = public, pg_temp all survive by construction.
-- ═════════════════════════════════════════════════════════════════════════════
ALTER FUNCTION public.phoenix_refresh_inter_org_alert_lifecycle(integer) SECURITY DEFINER;

-- ═════════════════════════════════════════════════════════════════════════════
-- STEP 2 — Close the direct door to the lifecycle writer.
-- ═════════════════════════════════════════════════════════════════════════════
REVOKE EXECUTE ON FUNCTION
  public.phoenix_get_live_inter_institution_alerts_with_state(integer)
FROM authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- STEP 3 — Close the DEFINER side door. Mandatory: this wrapper reaches the
--          hybrid as the OWNER, so STEP 2 alone would leave it fully working.
-- ═════════════════════════════════════════════════════════════════════════════
REVOKE EXECUTE ON FUNCTION
  public.phoenix_get_live_inter_institution_alerts_with_state_page(integer, integer)
FROM authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFY — the closed surface, the surviving command, and the untouched read
--          chain must all be real, not merely intended.
-- ─────────────────────────────────────────────────────────────────────────────
DO $verify$
DECLARE
  v_refresh oid := to_regprocedure('public.phoenix_refresh_inter_org_alert_lifecycle(integer)');
  v_hybrid  oid := to_regprocedure('public.phoenix_get_live_inter_institution_alerts_with_state(integer)');
  v_page    oid := to_regprocedure('public.phoenix_get_live_inter_institution_alerts_with_state_page(integer,integer)');
  v_base    oid := to_regprocedure('public.phoenix_get_live_inter_institution_alerts(integer)');
  v_qpage   oid := to_regprocedure('public.phoenix_query_live_inter_org_alerts_with_state_page(integer,integer)');
  v_qsum    oid := to_regprocedure('public.phoenix_query_live_inter_org_alert_summary(integer)');
  v_proj    oid := to_regprocedure('public._phoenix_live_inter_org_alert_read_projection_v1(integer)');
  v_bad     text;
  v_n       integer;
  v_src     text;
BEGIN
  -- A. THE COMMAND. Definer now, body and search_path provably untouched, and it
  --    must still delegate to the hybrid rather than have grown a copy of the
  --    lifecycle DML.
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_refresh) THEN
    RAISE EXCEPTION 'VERIFY FAILED (193): the refresh command is not SECURITY DEFINER';
  END IF;

  SELECT string_agg(b.sig, ', ') INTO v_bad
  FROM phoenix_193_routine_before b
  JOIN pg_proc p ON p.oid = b.oid
  WHERE md5(p.prosrc) IS DISTINCT FROM b.prosrc_md5;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (193): a routine body changed, but this migration alters no body: %', v_bad;
  END IF;

  SELECT string_agg(b.sig, ', ') INTO v_bad
  FROM phoenix_193_routine_before b
  JOIN pg_proc p ON p.oid = b.oid
  WHERE coalesce(array_to_string(p.proconfig, ','), '<none>') IS DISTINCT FROM b.proconfig;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (193): a routine search_path changed: %', v_bad;
  END IF;

  SELECT string_agg(b.sig, ', ') INTO v_bad
  FROM phoenix_193_routine_before b
  JOIN pg_proc p ON p.oid = b.oid
  WHERE p.provolatile IS DISTINCT FROM b.provolatile
     OR pg_get_userbyid(p.proowner) IS DISTINCT FROM b.owner;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (193): a routine volatility or owner changed: %', v_bad;
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_refresh;
  IF v_src !~ 'phoenix_get_live_inter_institution_alerts_with_state\s*\(' THEN
    RAISE EXCEPTION 'VERIFY FAILED (193): the refresh command no longer delegates to the hybrid';
  END IF;
  IF v_src ~* '(^|[^a-z_])(insert\s+into|update\s+[a-z_.]+\s+set|delete\s+from|merge\s+into|truncate)\s' THEN
    RAISE EXCEPTION 'VERIFY FAILED (193): the refresh command has acquired its own lifecycle DML - the hybrid must remain the sole writer';
  END IF;

  IF NOT has_function_privilege('authenticated', v_refresh, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (193): authenticated lost EXECUTE on the refresh command - the sanctioned path is broken';
  END IF;
  IF has_function_privilege('anon', v_refresh, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (193): anon can execute the refresh command';
  END IF;

  -- service_role is asserted as a DELTA, never as an absolute. Production
  -- carries service_role=X/postgres on the hybrid, but a clean replay of the
  -- chain does NOT produce it: 039/047/048/053/189 each REVOKE ALL FROM PUBLIC,
  -- anon and then GRANT only TO authenticated, so on the disposable rig the
  -- hybrid's ACL is {postgres, authenticated} at every migration from 108 to
  -- 189. The Production entry is therefore environment drift with no source in
  -- this repository - the same class of finding 192 closed for anon, and NOT
  -- something 193 may either depend on or quietly codify. Asserting "unchanged"
  -- is true in both environments and still fails closed if this migration ever
  -- disturbs service_role anywhere.
  SELECT string_agg(b.sig, ', ') INTO v_bad
  FROM phoenix_193_routine_before b
  JOIN pg_proc p ON p.oid = b.oid
  WHERE has_function_privilege('service_role', p.oid, 'EXECUTE') IS DISTINCT FROM b.svc_x;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (193): service_role EXECUTE changed on: %', v_bad;
  END IF;

  -- B. THE HYBRID. Closed to every client role. has_function_privilege is the
  --    EFFECTIVE test, so a surviving PUBLIC grant would still fail here.
  IF has_function_privilege('authenticated', v_hybrid, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (193): authenticated can still execute the hybrid';
  END IF;
  IF has_function_privilege('anon', v_hybrid, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (193): anon can execute the hybrid';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
             WHERE p.oid = v_hybrid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (193): PUBLIC holds EXECUTE on the hybrid';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_hybrid) THEN
    RAISE EXCEPTION 'VERIFY FAILED (193): the hybrid is no longer SECURITY DEFINER';
  END IF;

  -- C. THE LEGACY PAGING WRAPPER. Same closure, and it must still be the inert
  --    DEFINER delegate it was - not quietly rewritten into something else.
  IF has_function_privilege('authenticated', v_page, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (193): authenticated can still execute the legacy paging wrapper';
  END IF;
  IF has_function_privilege('anon', v_page, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (193): anon can execute the legacy paging wrapper';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
             WHERE p.oid = v_page AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (193): PUBLIC holds EXECUTE on the legacy paging wrapper';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_page) THEN
    RAISE EXCEPTION 'VERIFY FAILED (193): the legacy paging wrapper is no longer SECURITY DEFINER';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_page;
  IF v_src !~ 'phoenix_get_live_inter_institution_alerts_with_state\s*\(' THEN
    RAISE EXCEPTION 'VERIFY FAILED (193): the legacy paging wrapper no longer delegates to the hybrid';
  END IF;

  -- D. THE HYBRID REMAINS THE SOLE LIFECYCLE WRITER. Exactly one read-named
  --    first-party routine may write inter_org_alert_states/_events as a side
  --    effect; the explicit transition RPCs (update/reopen) are command-named
  --    and are deliberately outside this pattern.
  SELECT count(*) INTO v_n
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prokind = 'f'
    AND p.proname ~ '^(get|query|read|list|fetch)_|_(get|query|read|list|fetch)_'
    AND p.prosrc ~* 'insert\s+into\s+(public\.)?inter_org_alert_(states|events)';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'VERIFY FAILED (193): expected exactly ONE read-named lifecycle writer (the hybrid), found %', v_n;
  END IF;

  -- E. THE PURE READ CHAIN IS UNTOUCHED. Same ACL, same body, same mode - and
  --    still reachable by the client, because a hardening that silently broke
  --    the screen would pass every assertion above.
  SELECT string_agg(b.sig, ', ') INTO v_bad
  FROM phoenix_193_routine_before b
  JOIN pg_proc p ON p.oid = b.oid
  WHERE b.oid IN (v_base, v_qpage, v_qsum, v_proj)
    AND ( coalesce(array_to_string(p.proacl::text[], ' ; '), '<default>') IS DISTINCT FROM b.acl
       OR p.prosecdef IS DISTINCT FROM b.prosecdef
       OR has_function_privilege('authenticated', p.oid, 'EXECUTE') IS DISTINCT FROM b.auth_x
       OR has_function_privilege('anon',          p.oid, 'EXECUTE') IS DISTINCT FROM b.anon_x );
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (193): a routine this migration must not touch changed: %', v_bad;
  END IF;

  IF NOT has_function_privilege('authenticated', v_qpage, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (193): authenticated lost EXECUTE on the pure paged query';
  END IF;
  IF NOT has_function_privilege('authenticated', v_qsum, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (193): authenticated lost EXECUTE on the pure summary query';
  END IF;
  IF NOT has_function_privilege('authenticated', v_base, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (193): the pure base RPC lost authenticated EXECUTE - it is load-bearing and must not be revoked here';
  END IF;
  IF has_function_privilege('authenticated', v_proj, 'EXECUTE')
     OR has_function_privilege('anon', v_proj, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (193): a client role gained EXECUTE on the internal read projection';
  END IF;

  -- The pure read routines must remain pure.
  SELECT string_agg(b.sig, ', ') INTO v_bad
  FROM phoenix_193_routine_before b
  JOIN pg_proc p ON p.oid = b.oid
  WHERE b.oid IN (v_base, v_qpage, v_qsum, v_proj)
    AND p.prosrc ~* '(^|[^a-z_])(insert\s+into|delete\s+from|merge\s+into|truncate)\s';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (193): a pure read routine contains write DML: %', v_bad;
  END IF;

  -- F. NO RELATION PRIVILEGE MOVED. Not one tuple, in either direction, for
  --    either client role. This is what proves "no table GRANT" as a fact about
  --    the database rather than a claim about the file. The two bookkeeping
  --    tables this migration creates and drops are excluded by name.
  SELECT string_agg(x.grantee || ':' || x.relname || ':' || x.priv, ', ') INTO v_bad
  FROM (
    SELECT grantee, relname, priv FROM phoenix_193_relpriv_before
    EXCEPT
    SELECT g.grantee, c.relname, p.priv
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN (VALUES ('anon'), ('authenticated')) AS g(grantee)
    CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),
                       ('TRUNCATE'),('REFERENCES'),('TRIGGER')) AS p(priv)
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
      AND has_table_privilege(g.grantee, c.oid, p.priv)
  ) x;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (193): relation privileges were REMOVED: %', v_bad;
  END IF;

  SELECT string_agg(x.grantee || ':' || x.relname || ':' || x.priv, ', ') INTO v_bad
  FROM (
    SELECT g.grantee, c.relname, p.priv
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN (VALUES ('anon'), ('authenticated')) AS g(grantee)
    CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),
                       ('TRUNCATE'),('REFERENCES'),('TRIGGER')) AS p(priv)
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
      AND has_table_privilege(g.grantee, c.oid, p.priv)
      AND c.relname NOT LIKE 'phoenix_193_%'
    EXCEPT
    SELECT grantee, relname, priv FROM phoenix_193_relpriv_before
  ) x;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (193): relation privileges were ADDED: %', v_bad;
  END IF;

  -- G. ANON GAINED NOTHING ANYWHERE. 192's closed surface must still be closed.
  SELECT string_agg(c.relname || ':' || p.priv, ', ') INTO v_bad
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),
                     ('TRUNCATE'),('REFERENCES'),('TRIGGER')) AS p(priv)
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
    AND c.relname NOT LIKE 'phoenix_193_%'
    AND has_table_privilege('anon', c.oid, p.priv);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (193): anon holds direct relation privileges: %', v_bad;
  END IF;

  -- H. NO M194+. Where migration bookkeeping exists (Production; the disposable
  --    rig has no such schema), no migration beyond this one may be recorded.
  IF to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
    EXECUTE $q$SELECT string_agg(name, ', ') FROM supabase_migrations.schema_migrations
               WHERE name ~ '^(19[4-9]|[2-9][0-9][0-9])_'$q$ INTO v_bad;
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'VERIFY FAILED (193): a migration beyond 193 is already recorded: %', v_bad;
    END IF;
  END IF;
END;
$verify$;

DROP TABLE phoenix_193_routine_before;
DROP TABLE phoenix_193_relpriv_before;

COMMIT;
