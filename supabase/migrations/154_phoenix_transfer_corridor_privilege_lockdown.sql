-- ============================================================================
-- TRANSFER-CORRIDOR-PRIVILEGE-LOCKDOWN-154
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply after 153.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE GAP THIS CLOSES
-- ─────────────────────────────────────────────────────────────────────────────
-- Phase D0's read-only audit flagged that 108 (CUSTODY-CHAIN-DIRECT-WRITE-
-- LOCKDOWN) revoked the excess TRUNCATE/TRIGGER/REFERENCES `authenticated`
-- silently held on 15 named custody-chain tables, but never touched the four
-- central-warehouse<->institution-warehouse transfer-corridor tables created
-- by 068 (CENTRAL-TO-INSTITUTION-SUPPLY):
--   warehouse_transfer_requests, warehouse_transfer_request_lines,
--   warehouse_transfers, warehouse_transfer_lines
-- This migration closes exactly that gap, for exactly these four tables.
--
-- VERIFIED (fresh 001->153 disposable-rig replay, has_table_privilege(),
-- cross-checked against a raw pg_class.relacl dump):
--   table                             | grantee       | select | insert | update | delete | truncate | trigger | references
--   warehouse_transfer_requests       | authenticated | t      | f      | f      | f      | t        | t       | t
--   warehouse_transfer_request_lines  | authenticated | t      | f      | f      | f      | t        | t       | t
--   warehouse_transfers               | authenticated | t      | f      | f      | f      | t        | t       | t
--   warehouse_transfer_lines          | authenticated | t      | f      | f      | f      | t        | t       | t
--   (all four)                        | anon          | f      | f      | f      | f      | f        | f       | f
--   (all four)                        | PUBLIC        | f      | f      | f      | f      | f        | f       | f
-- Raw relacl for every table above (identical shape): {postgres=arwdDxtm/postgres,
-- authenticated=rDxtm/postgres,service_role=arwdDxtm/postgres,
-- phoenix_demo_purger=rd/postgres} — `authenticated`'s `rDxtm` decodes to
-- SELECT(r) + TRUNCATE(D) + REFERENCES(x) + TRIGGER(t): SELECT is intentional,
-- the other three are the gap. `anon`/`PUBLIC` hold no ACL entry on these
-- tables at all — confirmed both via has_table_privilege and absent from
-- role_table_grants entirely, matching 108's own finding for its 15 tables.
--
-- ROOT CAUSE (verified, not guessed — matches 108's own root cause exactly):
-- the disposable rig's bootstrap models Supabase's own project-provisioning
-- script, which runs, once, at project creation:
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES
--     TO authenticated, service_role;
-- "ALL" on a table means SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES
-- and TRIGGER together. 068's own REVOKE statement for these four tables
-- (068_phoenix_central_to_institution_supply.sql, "REVOKE INSERT, UPDATE,
-- DELETE ... FROM authenticated" / "REVOKE ALL ... FROM anon") listed only
-- INSERT, UPDATE, DELETE — never TRUNCATE, TRIGGER, REFERENCES — so those
-- three privileges have stood granted, unnoticed, since each table's
-- creation in 068.
--
-- 109 (PUBLIC-SCHEMA-DEFAULT-PRIVILEGES-LOCKDOWN) already closed the
-- underlying ALTER DEFAULT PRIVILEGES mechanism for every table created FROM
-- 109 ONWARD — but 109 is explicitly, deliberately prospective-only (its own
-- header: "it does not retroactively change a single grant on any EXISTING
-- table"). These four tables were created by 068, which predates 109 in
-- migration order, so 109's fix does not and cannot reach them. This
-- migration is the targeted, per-table remediation 109 itself says any
-- pre-109 table still needs — the same remediation 108 already did for its
-- 15 tables, extended to the four this phase's own audit found were missed.
--
-- IMPACT (same class of bug as 108, same proof shape): as `authenticated` (a
-- real, non-superuser session, no special role, exactly what any signed-in
-- app user is), TRUNCATE is not RLS-checkable — RLS only gates SELECT/
-- INSERT/UPDATE/DELETE — so no policy on these four tables was ever able to
-- stop it:
--   TRUNCATE TABLE public.warehouse_transfer_lines;              -- would succeed
--   TRUNCATE TABLE public.warehouse_transfer_request_lines;      -- would succeed
--   TRUNCATE TABLE public.warehouse_transfer_requests CASCADE;   -- would succeed (FK-parent)
--   TRUNCATE TABLE public.warehouse_transfers CASCADE;           -- would succeed (FK-parent)
-- destroying the entire central<->institution transfer history with no
-- elevated role required — reachable directly through PostgREST.
--
-- Every legitimate write to every one of these four tables already goes
-- through a SECURITY DEFINER RPC that runs as the function owner, never as
-- `authenticated` (068/077/088/100/150's own REVOKE statements already
-- established this for INSERT/UPDATE/DELETE; confirmed live below that all
-- 14 canonical Route-1 RPCs remain SECURITY DEFINER and EXECUTE-granted only
-- to `authenticated`, never `anon`, unchanged by this migration) — table-
-- level INSERT/UPDATE/DELETE/TRUNCATE/TRIGGER/REFERENCES grants to
-- `authenticated` are not required for any of them. SELECT is preserved
-- exactly as it stands today, since RLS-gated reads (via the existing
-- `wtr_select_scoped`/`wtrl_select_scoped`/`wt_select_scoped`/
-- `wtl_select_scoped` policies) are the intended path for the UI.
--
-- SCOPE: this migration touches ONLY the four named tables' privileges. No
-- RLS policy, no RBAC permission/role default, no table/column/constraint,
-- no function body, no ownership, and no ALTER DEFAULT PRIVILEGES statement
-- is touched here — 109 already closed that mechanism correctly and does not
-- need to be revisited.
-- ============================================================================

BEGIN;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
  ON TABLE public.warehouse_transfer_requests
  FROM authenticated, anon, PUBLIC;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
  ON TABLE public.warehouse_transfer_request_lines
  FROM authenticated, anon, PUBLIC;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
  ON TABLE public.warehouse_transfers
  FROM authenticated, anon, PUBLIC;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
  ON TABLE public.warehouse_transfer_lines
  FROM authenticated, anon, PUBLIC;

-- =============================================================================
-- VERIFY — inside the transaction; failure rolls back all of 154
-- =============================================================================

DO $$
DECLARE
  v_tables text[] := ARRAY[
    'warehouse_transfer_requests', 'warehouse_transfer_request_lines',
    'warehouse_transfers', 'warehouse_transfer_lines'
  ];
  v_rpcs text[] := ARRAY[
    'phoenix_create_direct_warehouse_transfer_request',
    'phoenix_create_warehouse_transfer_request',
    'phoenix_add_warehouse_transfer_request_line',
    'phoenix_update_warehouse_transfer_request_line',
    'phoenix_delete_warehouse_transfer_request_line',
    'phoenix_submit_warehouse_transfer_request',
    'phoenix_cancel_warehouse_transfer_request',
    'phoenix_review_warehouse_transfer_request',
    'phoenix_send_direct_warehouse_transfer_line',
    'phoenix_send_direct_warehouse_transfer_line_fefo_guarded',
    'phoenix_send_warehouse_transfer_line',
    'phoenix_send_warehouse_transfer_line_fefo_guarded',
    'phoenix_receive_warehouse_transfer_line',
    'phoenix_receive_all_matching_transfer_lines'
  ];
  v_t text;
  v_fn text;
  v_fn_count int;
BEGIN
  -- 1. All four tables exist (a typo in the table list would otherwise make
  --    every REVOKE above and every assertion below silently vacuous).
  FOREACH v_t IN ARRAY v_tables LOOP
    ASSERT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = v_t
    ), 'expected table missing: ' || v_t;
  END LOOP;

  -- 2. authenticated/anon/PUBLIC hold none of the six dangerous privileges,
  --    and SELECT remains exactly as it was (unchanged, still granted to
  --    authenticated; anon/PUBLIC never held it and still don't).
  FOREACH v_t IN ARRAY v_tables LOOP
    ASSERT has_table_privilege('authenticated', 'public.' || v_t, 'SELECT'),
      'expected SELECT to remain granted to authenticated on ' || v_t;
    ASSERT NOT has_table_privilege('anon', 'public.' || v_t, 'SELECT'),
      'anon unexpectedly gained SELECT on ' || v_t;
    ASSERT NOT has_table_privilege('public', 'public.' || v_t, 'SELECT'),
      'PUBLIC unexpectedly gained SELECT on ' || v_t;

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
      'INSERT unexpectedly granted to anon on ' || v_t;
    ASSERT NOT has_table_privilege('anon', 'public.' || v_t, 'UPDATE'),
      'UPDATE unexpectedly granted to anon on ' || v_t;
    ASSERT NOT has_table_privilege('anon', 'public.' || v_t, 'DELETE'),
      'DELETE unexpectedly granted to anon on ' || v_t;
    ASSERT NOT has_table_privilege('anon', 'public.' || v_t, 'TRUNCATE'),
      'TRUNCATE unexpectedly granted to anon on ' || v_t;
    ASSERT NOT has_table_privilege('anon', 'public.' || v_t, 'TRIGGER'),
      'TRIGGER unexpectedly granted to anon on ' || v_t;
    ASSERT NOT has_table_privilege('anon', 'public.' || v_t, 'REFERENCES'),
      'REFERENCES unexpectedly granted to anon on ' || v_t;

    ASSERT NOT has_table_privilege('public', 'public.' || v_t, 'INSERT'),
      'INSERT unexpectedly granted to PUBLIC on ' || v_t;
    ASSERT NOT has_table_privilege('public', 'public.' || v_t, 'UPDATE'),
      'UPDATE unexpectedly granted to PUBLIC on ' || v_t;
    ASSERT NOT has_table_privilege('public', 'public.' || v_t, 'DELETE'),
      'DELETE unexpectedly granted to PUBLIC on ' || v_t;
    ASSERT NOT has_table_privilege('public', 'public.' || v_t, 'TRUNCATE'),
      'TRUNCATE unexpectedly granted to PUBLIC on ' || v_t;
    ASSERT NOT has_table_privilege('public', 'public.' || v_t, 'TRIGGER'),
      'TRIGGER unexpectedly granted to PUBLIC on ' || v_t;
    ASSERT NOT has_table_privilege('public', 'public.' || v_t, 'REFERENCES'),
      'REFERENCES unexpectedly granted to PUBLIC on ' || v_t;
  END LOOP;

  -- 3. RLS remains enabled, untouched, on all four tables, and no new
  --    mutation-shaped policy (INSERT/UPDATE/DELETE/ALL) was introduced by
  --    this migration — only the pre-existing SELECT (+ demo-purger SELECT/
  --    DELETE, a separate, unrelated role) policies may exist.
  FOREACH v_t IN ARRAY v_tables LOOP
    ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || v_t)::regclass),
      'RLS unexpectedly disabled on ' || v_t;
    ASSERT NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = v_t
        AND cmd IN ('INSERT', 'UPDATE', 'ALL')
        AND 'authenticated' = ANY(roles)
    ), 'an authenticated-facing INSERT/UPDATE/ALL policy exists on ' || v_t
       || ' — this migration must never add direct mutation access';
  END LOOP;

  -- 4. Every canonical Route-1 RPC still exists, is still SECURITY DEFINER,
  --    and its EXECUTE grant to authenticated/anon is unchanged by this
  --    migration (this migration touches table privileges only, never
  --    function privileges — this just proves that held).
  FOREACH v_fn IN ARRAY v_rpcs LOOP
    SELECT count(*) INTO v_fn_count FROM pg_proc WHERE proname = v_fn;
    ASSERT v_fn_count >= 1, 'expected canonical RPC missing: ' || v_fn;
    ASSERT (
      SELECT bool_and(p.prosecdef) FROM pg_proc p WHERE p.proname = v_fn
    ), 'expected RPC not SECURITY DEFINER: ' || v_fn;
    ASSERT (
      SELECT bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE'))
      FROM pg_proc p WHERE p.proname = v_fn
    ), 'expected RPC no longer EXECUTE-granted to authenticated: ' || v_fn;
    ASSERT NOT (
      SELECT bool_or(has_function_privilege('anon', p.oid, 'EXECUTE'))
      FROM pg_proc p WHERE p.proname = v_fn
    ), 'RPC unexpectedly EXECUTE-granted to anon: ' || v_fn;
  END LOOP;
END $$;

COMMIT;

-- ============================================================================
-- POST-CONDITIONS
-- ============================================================================
-- 1. `authenticated`, `anon` and `PUBLIC` hold ONLY SELECT (authenticated
--    only — anon/PUBLIC hold nothing, exactly as before) on
--    warehouse_transfer_requests, warehouse_transfer_request_lines,
--    warehouse_transfers, warehouse_transfer_lines. INSERT/UPDATE/DELETE/
--    TRUNCATE/TRIGGER/REFERENCES are all revoked for all three grantees.
--    Verified in-transaction above via has_table_privilege(), which reflects
--    role-membership-inherited grants too, not just direct GRANT rows.
-- 2. Every canonical Route-1 write RPC (create/add-line/update-line/
--    delete-line/submit/cancel/review/send/send-fefo-guarded/receive/
--    receive-all-matching, both the routed and direct variants) is
--    SECURITY DEFINER and runs as its function owner — never as
--    `authenticated` — so this migration has ZERO effect on any of them, and
--    their EXECUTE grants are unchanged (re-verified in-transaction above).
-- 3. No RLS policy was added, removed, or modified. No RBAC permission or
--    role default was touched. No table/column/constraint/schema was
--    changed. No ownership was changed. No ALTER DEFAULT PRIVILEGES
--    statement was issued (109 already correctly owns that mechanism for
--    every table created from 109 onward; this migration only closes the
--    per-table gap 109 itself says a pre-109 table still needs).
-- 4. RECONCILIATION: this migration writes no data itself (pure privilege
--    revocation) — nothing to reconcile.
-- ============================================================================
-- ROLLBACK: there is no legitimate reason to ever do this. If genuinely
-- required, re-apply per table:
--   GRANT TRUNCATE, TRIGGER, REFERENCES ON TABLE public.<table> TO authenticated;
-- (INSERT/UPDATE/DELETE were already revoked by 068 before this migration
-- and are not restored by this rollback note — restoring them would require
-- reversing 068 itself, which is out of scope for undoing 154.)
-- ============================================================================
