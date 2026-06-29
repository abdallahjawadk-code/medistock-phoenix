-- ============================================================================
-- permission-42703-live-diagnostic.sql
-- MediStock Phoenix V2 — SUPABASE-LIVE-PERMISSION-42703-DIAG-C
--
-- Purpose:
--   A read-only / rollback-only diagnostic script to pinpoint the EXACT
--   missing column and the EXACT function or trigger causing the
--   persistent PostgreSQL 42703 (undefined_column) error on permission
--   save, even after migration 017 was applied.
--
-- How to use:
--   1. Open Supabase Dashboard → SQL Editor.
--   2. Run SECTION 1 (schema inspection) first — it is pure SELECT, fully
--      safe, no transaction needed.
--   3. Run SECTION 2 (function/trigger inspection) next — also pure
--      SELECT, fully safe.
--   4. ONLY THEN run SECTION 3 (the reproduction transaction) to capture
--      the exact error message/detail/hint Postgres raises. Replace the
--      three placeholders first (see SECTION 3 header).
--   5. Copy the FULL text of every result and every error message back —
--      do not summarize or paraphrase the error. The exact SQLSTATE,
--      message, detail, hint, and CONTEXT (which names the failing
--      function/trigger and line) are what make root-causing possible.
--
-- Safety:
--   - SECTION 1 and 2 are read-only catalog queries (information_schema /
--     pg_catalog) — they cannot modify any data or schema.
--   - SECTION 3 is wrapped in BEGIN ... ROLLBACK. It calls the REAL
--     assign_profile_permissions RPC exactly as the frontend does, so it
--     reproduces the exact error — but the explicit ROLLBACK at the end
--     guarantees nothing it does is ever persisted, even if the call
--     "succeeds" inside the transaction. Never replace ROLLBACK with
--     COMMIT.
--   - Never paste your database password, service_role key, a user JWT,
--     or a Vercel/Supabase access token anywhere in this file or in the
--     output you copy back. Only the SQL text and its plain-text result
--     rows/error messages are needed.
--   - ACTOR_SUPER_ADMIN_UUID and TARGET_USER_UUID must be two DIFFERENT
--     existing profile ids (self-edit is correctly blocked by design —
--     using the same id for both will only reproduce
--     CANNOT_EDIT_OWN_PERMISSIONS, not the real bug).
-- ============================================================================


-- ============================================================================
-- SECTION 1 — Exact live column lists
-- ============================================================================

-- 1a. profiles
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'profiles'
order by ordinal_position;

-- 1b. organizations
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'organizations'
order by ordinal_position;

-- 1c. permission_keys
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'permission_keys'
order by ordinal_position;

-- 1d. role_permission_defaults
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'role_permission_defaults'
order by ordinal_position;

-- 1e. profile_permission_overrides
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'profile_permission_overrides'
order by ordinal_position;

-- 1f. audit_logs
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'audit_logs'
order by ordinal_position;


-- ============================================================================
-- SECTION 2 — Functions, triggers, and dependencies
-- ============================================================================

-- 2a. Triggers attached to audit_logs
select tgname, pg_get_triggerdef(oid) as trigger_def
from pg_trigger
where tgrelid = 'public.audit_logs'::regclass
  and not tgisinternal
order by tgname;

-- 2b. Triggers attached to profile_permission_overrides
select tgname, pg_get_triggerdef(oid) as trigger_def
from pg_trigger
where tgrelid = 'public.profile_permission_overrides'::regclass
  and not tgisinternal
order by tgname;

-- 2c. All signatures for the functions involved in permission save —
--     surfaces duplicate/ambiguous overloads (e.g. a stale function with a
--     different argument type that PostgREST might dispatch to instead of
--     the one in migrations 010/017).
select p.oid::regprocedure as signature
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'phoenix_profile_has_permission',
    'phoenix_populate_actor_snapshot',
    'assign_profile_permissions',
    'reset_profile_permissions',
    'get_effective_permissions'
  )
order by signature::text;
-- Expect exactly ONE row per function name:
--   phoenix_profile_has_permission(uuid, text)
--   phoenix_populate_actor_snapshot()              <- trigger function, no args
--   assign_profile_permissions(uuid, jsonb)
--   reset_profile_permissions(uuid)
--   get_effective_permissions(uuid)
-- If any function name above appears MORE THAN ONCE, that is itself a
-- finding — paste all the rows back.

-- 2d. Full definitions — paste the FULL output of each back verbatim.
--     (Run each select individually; some SQL Editor clients only show one
--     result set per query.)
select pg_get_functiondef('public.phoenix_profile_has_permission(uuid,text)'::regprocedure);
select pg_get_functiondef('public.phoenix_populate_actor_snapshot()'::regprocedure);
select pg_get_functiondef('public.assign_profile_permissions(uuid,jsonb)'::regprocedure);
select pg_get_functiondef('public.reset_profile_permissions(uuid)'::regprocedure);
select pg_get_functiondef('public.get_effective_permissions(uuid)'::regprocedure);

-- 2e. Dependency check — confirms which trigger(s) actually invoke
--     phoenix_populate_actor_snapshot(), independent of what migration 014
--     claims to have attached. If a table is missing from this list that
--     you expected (or an extra one appears), that is a finding.
select
  dep_trigger.tgname        as trigger_name,
  dep_table.relname         as table_name,
  dep_function.proname      as function_name
from pg_trigger dep_trigger
join pg_class dep_table on dep_table.oid = dep_trigger.tgrelid
join pg_proc dep_function on dep_function.oid = dep_trigger.tgfoid
where dep_function.proname = 'phoenix_populate_actor_snapshot'
  and not dep_trigger.tgisinternal
order by table_name;


-- ============================================================================
-- SECTION 3 — Reproduction (transaction, ROLLBACK only — NEVER COMMIT)
--
-- Replace before running:
--   ACTOR_SUPER_ADMIN_UUID  -> profiles.id of a real super_admin account
--   TARGET_USER_UUID        -> profiles.id of a DIFFERENT real account
--                              (must not equal ACTOR_SUPER_ADMIN_UUID, or
--                              you will only reproduce
--                              CANNOT_EDIT_OWN_PERMISSIONS, not the bug)
--   TEST_PERMISSION_KEY     -> a simple, known-good key, e.g. users.view
--
-- set_config('request.jwt.claim.sub', ...) simulates auth.uid() for this
-- transaction only, the same way PostgREST does when called from the app
-- with a real session — no real JWT, password, or service key is needed or
-- used here.
-- ============================================================================

begin;

select set_config('request.jwt.claim.sub', 'ACTOR_SUPER_ADMIN_UUID', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

select public.assign_profile_permissions(
  'TARGET_USER_UUID'::uuid,
  '{"TEST_PERMISSION_KEY": true}'::jsonb
);

-- If SECTION 3's call raises an error, Postgres will show:
--   SQLSTATE, MESSAGE, DETAIL, HINT, and CONTEXT
-- CONTEXT is the most important part — it names the exact function and
-- line (e.g. "PL/pgSQL function assign_profile_permissions(uuid,jsonb)
-- line 23 at SQL statement") where the undefined column reference lives.
-- Copy that CONTEXT line back verbatim.

rollback;
-- ============================================================================
-- END OF DIAGNOSTIC SCRIPT — nothing above this line is ever committed.
-- ============================================================================
