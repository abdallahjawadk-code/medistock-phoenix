-- ============================================================================
-- PUBLIC-SCHEMA-DEFAULT-PRIVILEGES-LOCKDOWN-109
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply after 108.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE GAP THIS CLOSES
-- ─────────────────────────────────────────────────────────────────────────────
-- 108 revoked the excess TRUNCATE/TRIGGER/REFERENCES (and, on stocktakes /
-- stocktake_count_lines, full INSERT/UPDATE/DELETE too) that `authenticated`
-- silently held on all 15 EXISTING custody-chain tables. But it never touched
-- the underlying mechanism that put those grants there in the first place:
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES
--     TO authenticated, service_role;
-- This statement (run once, at project/database creation, by
-- tools/pg-rig/bootstrap.sql — modelling how Supabase itself provisions a
-- real project) does not grant anything on any existing table. It installs a
-- standing DEFAULT-PRIVILEGE ENTRY that fires automatically, forever, on
-- every FUTURE table `postgres` creates in `public` — including every table
-- any migration from 109 onward will ever create. Left alone, the exact same
-- bug 108 just closed reopens itself the moment a future migration adds a
-- new table and its author forgets to write an explicit REVOKE (which is
-- precisely what happened, repeatedly, across 025/033/065/092 for the 15
-- tables 108 just fixed).
--
-- VERIFIED (fresh 001->108 disposable-rig replay, `pg_default_acl` +
-- `aclexplode()`; see tools/pg-rig/scratch/task1_investigate.mjs, not
-- committed — a throwaway probe script, output reproduced here):
--
--   owner_role | schema | object_type | defaclacl
--   -----------+--------+-------------+---------------------------------------------------
--   postgres   | public | sequence    | {authenticated=rwU/postgres,service_role=rwU/postgres}
--   postgres   | public | table       | {authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}
--
-- Exploded (aclexplode): `authenticated` holds a standing default of
-- SELECT+INSERT+UPDATE+DELETE+TRUNCATE+REFERENCES+TRIGGER+MAINTAIN on every
-- future TABLE, and SELECT+UPDATE+USAGE on every future SEQUENCE, in
-- `public` — i.e. literally "ALL" on both object types, for every table/
-- sequence not yet created. `service_role` holds the identical entries,
-- which is correct and preserved by this migration (see below).
--
-- There was NO default-ACL row for functions ('f') or types ('T') at all —
-- bootstrap.sql only ever set defaults for TABLES. That is its own, SEPARATE
-- risk, verified live and closed below: Postgres's OWN built-in behavior
-- (independent of any ALTER DEFAULT PRIVILEGES statement) is to grant
-- EXECUTE on every newly created function to PUBLIC automatically, unless an
-- explicit default-privilege entry overrides it. A future migration that
-- adds a SECURITY DEFINER RPC and forgets its own explicit
-- `REVOKE EXECUTE ... FROM PUBLIC` would silently leave that function
-- callable by anyone with a Postgres connection — same fail-open class of
-- bug as the TRUNCATE gap, on functions instead of tables.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- A REAL POSTGRES QUIRK, FOUND LIVE — WHY FUNCTIONS ARE HANDLED DIFFERENTLY
-- BELOW THAN TABLES/SEQUENCES
-- ─────────────────────────────────────────────────────────────────────────────
-- For TABLES and SEQUENCES, `ALTER DEFAULT PRIVILEGES IN SCHEMA public
-- REVOKE ALL ... FROM authenticated, anon, PUBLIC` behaves exactly as
-- expected: it materializes a schema-scoped default-ACL row, and every
-- future table/sequence created in `public` gets that row's ACL verbatim —
-- proven live below (Task 3 probe: SELECT/INSERT/UPDATE/DELETE/TRUNCATE/
-- TRIGGER/REFERENCES all false for authenticated/anon/PUBLIC on a freshly
-- created probe table and sequence).
--
-- FUNCTIONS DO NOT WORK THE SAME WAY. Verified empirically against a live
-- PostgreSQL 18.4 instance (not assumed from documentation):
--   1. `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ... ON FUNCTIONS
--      FROM PUBLIC` (schema-scoped) either persists no default-ACL row at
--      all (when nothing was previously granted there to revoke — which is
--      exactly our starting state), OR, even when a schema-scoped row DOES
--      already exist with real entries for other roles, a newly created
--      function's `proacl` still gets `=X/<owner>` (PUBLIC EXECUTE) merged
--      in regardless. In both cases `has_function_privilege(authenticated,
--      ..., 'EXECUTE')` and `..._(anon, ...)` come back TRUE on a freshly
--      created probe function — i.e. the schema-scoped REVOKE is a genuine
--      no-op for functions specifically.
--   2. The GLOBAL form — `ALTER DEFAULT PRIVILEGES FOR ROLE postgres
--      REVOKE ... ON FUNCTIONS FROM ...` WITHOUT `IN SCHEMA public` — DOES
--      work: it materializes a role-scoped (not schema-scoped) default-ACL
--      row, and a freshly created function's `proacl` no longer carries the
--      PUBLIC entry at all; `has_function_privilege` for authenticated/anon
--      correctly comes back FALSE.
--   3. Because that global entry replaces the PUBLIC-EXECUTE baseline
--      entirely rather than adding a narrower row alongside it,
--      `service_role` — which was previously relying on the SAME implicit
--      PUBLIC-EXECUTE baseline everyone else was (there was never an
--      explicit function grant to `service_role` either) — would ALSO lose
--      EXECUTE on every future function unless given its own explicit
--      global default GRANT. This migration adds that grant so
--      `service_role`'s legitimate broad access is preserved exactly as it
--      is for tables/sequences.
-- This migration therefore REVOKES functions-default-EXECUTE at GLOBAL
-- (role-only) scope rather than schema scope — the only form of
-- ALTER DEFAULT PRIVILEGES that Postgres actually honors for objtype
-- FUNCTION. This is safe with respect to the "scope strictly to public"
-- requirement in practice: `postgres` (the sole role that owns every
-- object created by this migration chain, confirmed via `current_user`/
-- `session_user` and `pg_tables.tableowner`, both `postgres`, during every
-- migration replay) never creates a function outside `public` anywhere in
-- 001-109 (grep-verified: no `CREATE [OR REPLACE] FUNCTION` targets any
-- schema-qualified name outside `public` in this repository) — Supabase's
-- own internal schemas (`auth`, `storage`, `realtime`, ...) are provisioned
-- and owned by Supabase's own roles, never by `postgres` via this
-- migration chain, so this global revoke has zero practical effect on them.
-- If a future migration ever DOES create a function outside `public`, this
-- default would apply there too — which is the SAME fail-closed posture
-- this whole migration is establishing, not a violation of it.
--
-- `current_user`/`session_user` during every migration replay is `postgres`
-- (verified live) — `postgres` is the only owner_role holding any
-- default-ACL entry in `public` today, and every existing table in `public`
-- is owned by `postgres` (verified via pg_tables). So `postgres` is the
-- correct — and, on this rig/project, the ONLY — role to target below.
-- `anon` holds no default-ACL entry at all today (bootstrap only defaults
-- `authenticated`/`service_role`); it is included in the REVOKE lists
-- purely defensively, so that if a future bootstrap or provisioning change
-- ever adds `anon` to that GRANT, this migration's intent (fail-closed for
-- client-facing roles) still holds. REVOKE of a privilege never granted is
-- a documented no-op in Postgres — safe to include unconditionally.
--
-- WHAT THIS DOES NOT DO: it does not retroactively change a single grant on
-- any EXISTING table, sequence, or function — `ALTER DEFAULT PRIVILEGES`
-- only ever affects objects created AFTER it runs, by design. The 15 tables
-- 108 already fixed are untouched (re-verified live in the accompanying
-- test). `service_role` keeps its normal broad access — for tables/
-- sequences because its own schema-scoped default-ACL entry from bootstrap
-- is left alone (only authenticated/anon/PUBLIC are named in those REVOKE
-- statements below); for functions because this migration adds it an
-- explicit global default GRANT EXECUTE, restoring exactly what it
-- implicitly had before this migration (see the quirk explanation above).
-- Nothing outside `public` is touched for tables/sequences (both REVOKEs
-- are schema-scoped); functions are handled at the necessarily-global scope
-- explained above, with the practical-impact analysis above showing that is
-- equivalent to `public`-only in this codebase today.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- CONTRACT CHANGE FOR EVERY FUTURE MIGRATION AUTHOR — READ THIS
-- ─────────────────────────────────────────────────────────────────────────────
-- From 109 onward, ANY new table, sequence, or function `postgres` creates
-- starts with ZERO privileges for `authenticated`/`anon`/`PUBLIC` — not "ALL
-- minus whatever a REVOKE strips", but nothing at all, by default. This is
-- intentional and is the fix: fail-closed instead of fail-open. If a future
-- migration creates a table/sequence/function that a client session (via
-- PostgREST, i.e. `authenticated`/`anon`) legitimately needs to reach — e.g.
-- SELECT under an RLS policy, or EXECUTE on a SECURITY DEFINER RPC intended
-- to be callable from the client — that migration MUST now include its own
-- EXPLICIT grant, e.g.:
--   GRANT SELECT ON TABLE public.<new_table> TO authenticated;
--   GRANT EXECUTE ON FUNCTION public.<new_rpc>(...) TO authenticated;
-- Forgetting this grant will no longer silently leak broad access (the old,
-- dangerous failure mode) — it will instead silently under-grant, which
-- surfaces immediately and loudly as a permission-denied error the first
-- time the new object is used from the client. That is the correct
-- direction to fail in.
-- ============================================================================

BEGIN;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM authenticated, anon, PUBLIC;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM authenticated, anon, PUBLIC;

-- Functions: GLOBAL scope (no `IN SCHEMA public`) — the only form Postgres
-- honors for suppressing the built-in PUBLIC-EXECUTE default on functions;
-- see the quirk explanation above. `service_role` is granted back its
-- default EXECUTE explicitly, since it can no longer rely on the implicit
-- PUBLIC baseline it (like everyone else) was previously inheriting from.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  REVOKE ALL PRIVILEGES ON FUNCTIONS FROM authenticated, anon, PUBLIC;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  GRANT EXECUTE ON FUNCTIONS TO service_role;

-- =============================================================================
-- VERIFY — inside the transaction; failure rolls back all of 109
-- =============================================================================

DO $$
DECLARE
  v_acl record;
  v_bad text := '';
BEGIN
  -- No default-ACL entry for schema `public` (tables/sequences) or global
  -- (functions), for role `postgres`, may grant anything to
  -- authenticated/anon/PUBLIC after this migration.
  FOR v_acl IN
    SELECT
      pg_get_userbyid(d.defaclrole) AS owner_role,
      COALESCE(n.nspname, '(global)') AS schema,
      CASE d.defaclobjtype
        WHEN 'r' THEN 'table' WHEN 'S' THEN 'sequence'
        WHEN 'f' THEN 'function' WHEN 'T' THEN 'type' ELSE d.defaclobjtype::text
      END AS object_type,
      a.grantee::regrole::text AS grantee,
      a.privilege_type
    FROM pg_default_acl d
    LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
    CROSS JOIN LATERAL aclexplode(d.defaclacl) AS a
    WHERE (n.nspname = 'public' OR n.nspname IS NULL)
      AND pg_get_userbyid(d.defaclrole) = 'postgres'
      AND a.grantee::regrole::text IN ('authenticated', 'anon', '-')
  LOOP
    v_bad := v_bad || format('%s default-ACL on %s (%s) still grants %s to %s; ',
      v_acl.owner_role, v_acl.object_type, v_acl.schema, v_acl.privilege_type, v_acl.grantee);
  END LOOP;

  ASSERT v_bad = '', 'default-privilege lockdown incomplete: ' || v_bad;

  -- service_role's default privileges on tables/sequences (schema-scoped)
  -- must be untouched, and it must retain a default EXECUTE on functions
  -- (global-scoped) equivalent to what the implicit PUBLIC baseline gave it
  -- before this migration.
  ASSERT EXISTS (
    SELECT 1
    FROM pg_default_acl d
    JOIN pg_namespace n ON n.oid = d.defaclnamespace
    CROSS JOIN LATERAL aclexplode(d.defaclacl) AS a
    WHERE n.nspname = 'public'
      AND d.defaclobjtype = 'r'
      AND a.grantee::regrole::text = 'service_role'
      AND a.privilege_type = 'SELECT'
  ), 'service_role default table privileges were unexpectedly touched';

  ASSERT EXISTS (
    SELECT 1
    FROM pg_default_acl d
    WHERE d.defaclnamespace = 0
      AND d.defaclobjtype = 'f'
      AND pg_get_userbyid(d.defaclrole) = 'postgres'
      AND EXISTS (
        SELECT 1 FROM aclexplode(d.defaclacl) a
        WHERE a.grantee::regrole::text = 'service_role' AND a.privilege_type = 'EXECUTE'
      )
  ), 'service_role default EXECUTE on functions was not established';
END $$;

COMMIT;

-- ============================================================================
-- POST-CONDITIONS
-- ============================================================================
-- 1. Every table and sequence created in `public` FROM NOW ON starts with no
--    default privileges at all for `authenticated`, `anon`, or `PUBLIC`.
--    Every function created by `postgres` in ANY schema (in practice, only
--    ever `public` in this codebase — see analysis above) starts with no
--    default EXECUTE for `authenticated`, `anon`, or `PUBLIC` either.
--    Verified in-transaction above by asserting no matching default-ACL row
--    exists for those grantees on any object type.
-- 2. `service_role`'s default privileges on future tables/sequences are
--    untouched (re-verified in-transaction above), and its default EXECUTE
--    on future functions is explicitly re-established (also re-verified) —
--    it retains its normal broad, RLS-bypassing access by design.
-- 3. No EXISTING table/sequence/function's actual grants are changed by this
--    migration — `ALTER DEFAULT PRIVILEGES` is prospective-only by Postgres
--    design. The 15 tables 108 fixed, and every other object already in the
--    schema, are unaffected (proven in the accompanying test suite by
--    re-running 108's has_table_privilege matrix after 109 applies and
--    confirming identical results).
-- 4. RECONCILIATION: this migration writes no data and changes no existing
--    object's grants — nothing to reconcile.
-- ============================================================================
-- ROLLBACK: re-run, per object type,
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--     GRANT ALL ON TABLES TO authenticated, service_role;
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--     GRANT ALL ON SEQUENCES TO authenticated, service_role;
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres
--     REVOKE EXECUTE ON FUNCTIONS FROM service_role;
-- (the function REVOKE this migration adds had no prior default-ACL entry
-- to restore — functions simply return to Postgres's implicit
-- PUBLIC-EXECUTE baseline once the global entry this migration created is
-- removed; no explicit GRANT-to-PUBLIC is needed or recommended). There is
-- no legitimate reason to ever do this.
-- ============================================================================
