-- ============================================================================
-- MONTHLY-STATUS-DIRECT-WRITE-LOCKDOWN-113   ***PREPARED - DO NOT APPLY TO
-- PRODUCTION***
--
-- MANUAL APPLY ONLY (SQL Editor), after owner review, AFTER 112. Never via
-- `supabase db push`. Replay 001->113 must be proven on the disposable rig
-- before this is considered ready.
--
-- THE GAP THIS CLOSES
-- ─────────────────────────────────────────────────────────────────────────────
-- 108 audited every custody-chain table for the bootstrap default-ACL bug
-- (`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO
-- authenticated, service_role`, applied once at project provisioning) and,
-- noticing 092 had written NO revoke clause at all for two of its five new
-- tables, fixed exactly `stocktakes` and `stocktake_count_lines`. It did NOT
-- audit 092's OTHER three tables — `inventory_status_reports`,
-- `inventory_status_report_lines`, `inventory_status_report_amendments` — and
-- 092 never revoked anything on them either. Verified live against the
-- disposable rig (001->112 replay): `authenticated` currently holds
-- INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER and REFERENCES on all three,
-- identical to the exact bug 108 fixed for `stocktakes`/`stocktake_count_lines`.
--
--   SELECT table_name, grantee, string_agg(privilege_type, ',' ORDER BY privilege_type)
--   FROM information_schema.table_privileges
--   WHERE table_schema='public' AND grantee IN ('authenticated','anon','PUBLIC')
--     AND table_name IN ('inventory_status_reports','inventory_status_report_lines',
--                         'inventory_status_report_amendments');
--   -- authenticated | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE  (all three, before this migration)
--
-- SEPARATELY, 092's own ~13 new RPC functions each wrote
-- `REVOKE ALL ON FUNCTION ... FROM anon;` but NEVER `... FROM PUBLIC` —
-- Postgres grants EXECUTE to PUBLIC automatically at CREATE FUNCTION time
-- unless something revokes it, and `REVOKE ALL FROM anon` only strips
-- `anon`'s own grant entry, leaving PUBLIC's separate blanket EXECUTE grant
-- untouched (every role, including anon, inherits through PUBLIC). Verified
-- live via information_schema.routine_privileges: 11 of 092's 13 functions
-- still grant EXECUTE to PUBLIC (the 12th, phoenix_upsert_inventory_threshold,
-- is unaffected — it was first defined in 072 and REVOKEd FROM PUBLIC, anon
-- there; CREATE OR REPLACE in 092 does not reset an existing function's ACL,
-- so that one function's correct grant survived intact. The 13th,
-- phoenix_status_get_outlet_contribution, is one of the 11 affected).
--
-- IMPACT: every legitimate write to these three tables already goes through
-- a SECURITY DEFINER RPC (phoenix_status_prepare_report,
-- phoenix_status_classify_lines, phoenix_status_confirm_missing,
-- phoenix_status_submit_report, phoenix_status_return_for_clarification,
-- phoenix_status_approve_lock_report, phoenix_status_create_amendment,
-- phoenix_status_record_stocktake, phoenix_set_inventory_threshold_planning)
-- that runs as the function owner, never as `authenticated` — table-level
-- write grants to `authenticated` were never required for any of them, and
-- grepping src/ confirms zero frontend call site ever performs a direct
-- .insert()/.update()/.delete()/.upsert() against any of the three (every
-- call site is a plain RLS-scoped .select(), matching the architecture).
-- SELECT is preserved on all three: 092 already wired real RLS SELECT
-- policies for them (verified: `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`
-- plus per-role SELECT policies in 092's own file), so direct read is both
-- intended and RLS-protected — nothing here narrows what a session can read.
-- PUBLIC EXECUTE on the 11 functions is closed the same way: TRUNCATE is not
-- RLS-checkable at all (108's own header explains this), and unrevoked
-- PUBLIC EXECUTE on a SECURITY DEFINER function is reachable by literally any
-- role — including anon — through PostgREST regardless of that function's own
-- internal auth.uid() guard, which is a defense-in-depth gap even where the
-- function's own body already raises for an unauthenticated caller.
--
-- service_role is untouched throughout (intentional — it legitimately
-- bypasses RLS by design, per 108/109's own established posture).
-- 092, 108 and 109 are not edited; this is an additive REVOKE/GRANT-only
-- migration, matching 108's own idiom exactly.
--
-- PRECONDITIONS: 001..112 applied.
-- ============================================================================

BEGIN;

DO $precond$
BEGIN
  IF to_regclass('public.inventory_status_reports') IS NULL
     OR to_regclass('public.inventory_status_report_lines') IS NULL
     OR to_regclass('public.inventory_status_report_amendments') IS NULL THEN
    RAISE EXCEPTION '113 PRECONDITION FAILED: one or more 092 monthly-status tables missing.';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.inventory_status_report_lines', 'INSERT') THEN
    RAISE EXCEPTION '113 PRECONDITION FAILED: already applied (INSERT already revoked).';
  END IF;
END
$precond$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Tables — close the same gap 108 closed for stocktakes/stocktake_count_lines.
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
  ON TABLE public.inventory_status_reports
  FROM authenticated, anon, PUBLIC;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
  ON TABLE public.inventory_status_report_lines
  FROM authenticated, anon, PUBLIC;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
  ON TABLE public.inventory_status_report_amendments
  FROM authenticated, anon, PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Functions — close PUBLIC's un-revoked default EXECUTE grant. anon is
--    re-stated for clarity/defense-in-depth even though 092 already revoked
--    it; authenticated is re-GRANTed for the same reason (idempotent — it
--    already held EXECUTE, this just makes the intended final state explicit
--    rather than relying on what 092 happened to leave standing).
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.phoenix_status_center_authorized(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_status_center_authorized(uuid, text) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.phoenix_set_inventory_threshold_planning(uuid, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_set_inventory_threshold_planning(uuid, integer, integer) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.phoenix_status_record_stocktake(uuid, text, uuid, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_status_record_stocktake(uuid, text, uuid, text, jsonb) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.phoenix_status_prepare_report(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_status_prepare_report(uuid) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.phoenix_status_classify_lines(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_status_classify_lines(uuid, jsonb) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.phoenix_status_confirm_missing(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_status_confirm_missing(uuid) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.phoenix_status_submit_report(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_status_submit_report(uuid) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.phoenix_status_return_for_clarification(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_status_return_for_clarification(uuid, text) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.phoenix_status_approve_lock_report(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_status_approve_lock_report(uuid) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.phoenix_status_create_amendment(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_status_create_amendment(uuid, text) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.phoenix_status_get_outlet_contribution(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_status_get_outlet_contribution(uuid, uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Verify — inside the transaction; any unintended grant fails closed and
--    rolls back all of 113.
-- ─────────────────────────────────────────────────────────────────────────────
DO $verify$
DECLARE
  v_tables text[] := ARRAY[
    'inventory_status_reports', 'inventory_status_report_lines',
    'inventory_status_report_amendments'
  ];
  v_funcs regprocedure[] := ARRAY[
    'public.phoenix_status_center_authorized(uuid, text)',
    'public.phoenix_set_inventory_threshold_planning(uuid, integer, integer)',
    'public.phoenix_status_record_stocktake(uuid, text, uuid, text, jsonb)',
    'public.phoenix_status_prepare_report(uuid)',
    'public.phoenix_status_classify_lines(uuid, jsonb)',
    'public.phoenix_status_confirm_missing(uuid)',
    'public.phoenix_status_submit_report(uuid)',
    'public.phoenix_status_return_for_clarification(uuid, text)',
    'public.phoenix_status_approve_lock_report(uuid)',
    'public.phoenix_status_create_amendment(uuid, text)',
    'public.phoenix_status_get_outlet_contribution(uuid, uuid)'
  ]::regprocedure[];
  v_t text;
  v_f regprocedure;
BEGIN
  FOREACH v_t IN ARRAY v_tables LOOP
    ASSERT has_table_privilege('authenticated', 'public.' || v_t, 'SELECT'),
      'expected SELECT to remain granted on ' || v_t;
    ASSERT NOT has_table_privilege('authenticated', 'public.' || v_t, 'INSERT'),
      'INSERT still granted to authenticated on ' || v_t;
    ASSERT NOT has_table_privilege('authenticated', 'public.' || v_t, 'UPDATE'),
      'UPDATE still granted to authenticated on ' || v_t;
    ASSERT NOT has_table_privilege('authenticated', 'public.' || v_t, 'DELETE'),
      'DELETE still granted to authenticated on ' || v_t;
    ASSERT NOT has_table_privilege('authenticated', 'public.' || v_t, 'TRUNCATE'),
      'TRUNCATE still granted to authenticated on ' || v_t;
    ASSERT NOT has_table_privilege('authenticated', 'public.' || v_t, 'TRIGGER'),
      'TRIGGER still granted to authenticated on ' || v_t;
    ASSERT NOT has_table_privilege('authenticated', 'public.' || v_t, 'REFERENCES'),
      'REFERENCES still granted to authenticated on ' || v_t;
    ASSERT NOT has_table_privilege('anon', 'public.' || v_t, 'INSERT'),
      'INSERT still granted to anon on ' || v_t;
  END LOOP;

  FOREACH v_f IN ARRAY v_funcs LOOP
    ASSERT has_function_privilege('authenticated', v_f, 'EXECUTE'),
      'expected EXECUTE to remain granted to authenticated on ' || v_f::text;
    -- Matched by OID (v_f resolves through its regprocedure literal, which is
    -- unambiguous even for an overloaded name elsewhere in the schema, e.g.
    -- pgcrypto's digest()) rather than by re-deriving a name from
    -- information_schema and casting it back through ::regproc, which throws
    -- "more than one function named ..." the instant ANY unrelated overloaded
    -- function exists anywhere in the schema.
    ASSERT NOT EXISTS (
      SELECT 1 FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS a
      WHERE p.oid = v_f::oid
        AND a.grantee::regrole::text IN ('anon', '-') -- '-' = regrole rendering of PUBLIC
        AND a.privilege_type = 'EXECUTE'
    ), 'EXECUTE still granted to PUBLIC or anon on ' || v_f::text;
  END LOOP;

  RAISE NOTICE 'MONTHLY-STATUS-DIRECT-WRITE-LOCKDOWN-113: verified.';
END
$verify$;

COMMIT;

-- ============================================================================
-- POST-CONDITIONS (read-only, after apply):
--   SELECT table_name, grantee, string_agg(privilege_type, ',' ORDER BY privilege_type)
--   FROM information_schema.table_privileges
--   WHERE table_schema='public' AND grantee IN ('authenticated','anon','PUBLIC')
--     AND table_name IN ('inventory_status_reports','inventory_status_report_lines',
--                         'inventory_status_report_amendments')
--   GROUP BY table_name, grantee;
--   -- every row reads: authenticated | SELECT   (anon/PUBLIC: no rows at all)
--
-- ROLLBACK (lossless — pure privilege metadata, no data touched):
--   GRANT INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
--     ON TABLE public.inventory_status_reports, public.inventory_status_report_lines,
--        public.inventory_status_report_amendments
--     TO authenticated;
--   GRANT EXECUTE ON FUNCTION <each function above> TO PUBLIC;
--   -- (restores exactly the pre-113 state; not recommended — this migration
--   -- closes a genuine bypass, matching 108's own precedent).
-- ============================================================================
