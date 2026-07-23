-- ============================================================================
-- CUSTODY-CHAIN-DIRECT-WRITE-LOCKDOWN-108-A
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply after 107.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE GAP THIS CLOSES
-- ─────────────────────────────────────────────────────────────────────────────
-- A prior bypass-audit report (see correction-bypass-audit-dynamic.test.ts)
-- queried information_schema.role_table_grants WHERE grantee='authenticated'
-- for outlet_stock/warehouse_stock and, seeing no INSERT/UPDATE/DELETE row,
-- concluded "no direct bypass". It never checked TRUNCATE. Live verification
-- against a fresh 001->107 disposable-rig replay (has_table_privilege(),
-- cross-checked against role_table_grants and an actual
-- BEGIN; SET ROLE authenticated; TRUNCATE ...; ROLLBACK; behavioral test)
-- confirms `authenticated` genuinely holds TRUNCATE, TRIGGER and REFERENCES
-- on EVERY custody-chain table:
--   item_availability_movements, warehouse_stock, warehouse_stock_movements,
--   warehouse_dispatches, warehouse_dispatch_lines, outlet_stock,
--   outlet_stock_movements, warehouse_quarantine_stock,
--   warehouse_quarantine_stock_movements, phoenix_movement_events,
--   phoenix_stock_correction_requests, phoenix_warehouse_correction_requests,
--   phoenix_dispatch_line_requests
-- — and, additionally, that `stocktakes` and `stocktake_count_lines` (092)
-- were NEVER revoked at all: `authenticated` holds INSERT, UPDATE, DELETE,
-- TRUNCATE, TRIGGER and REFERENCES on both.
--
-- ROOT CAUSE (verified, not guessed): the disposable rig's bootstrap models
-- Supabase's own project-provisioning script, which runs
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES
--     TO authenticated, service_role;
-- once, at project creation. "ALL" on a table means SELECT, INSERT, UPDATE,
-- DELETE, TRUNCATE, REFERENCES and TRIGGER together. Every REVOKE this
-- migration chain has ever written against a custody-chain table (025, 033,
-- 065, ...) explicitly listed only `INSERT, UPDATE, DELETE` — never
-- `TRUNCATE, TRIGGER, REFERENCES` — so those three privileges have stood
-- granted, unnoticed, since each table's creation. 092 added `stocktakes`/
-- `stocktake_count_lines` and wrote NO revoke clause at all for either.
-- `PUBLIC` and `anon` were never granted anything on these tables (bootstrap
-- only defaults `authenticated`/`service_role`) — confirmed false for both
-- via has_table_privilege AND absent from role_table_grants entirely.
--
-- IMPACT (proven live, not theoretical): as `authenticated` (a real,
-- non-superuser session, no special role), inside a rolled-back transaction:
--   TRUNCATE TABLE public.warehouse_quarantine_stock_movements;   -- succeeds directly
--   TRUNCATE TABLE public.phoenix_movement_events;                -- succeeds directly
--   TRUNCATE TABLE public.phoenix_stock_correction_requests;      -- succeeds directly
--   TRUNCATE TABLE public.phoenix_warehouse_correction_requests;  -- succeeds directly
--   TRUNCATE TABLE public.phoenix_dispatch_line_requests;         -- succeeds directly
-- and, for the tables that are FK-parents (a single-table TRUNCATE on those
-- errors with "cannot truncate a table referenced in a foreign key
-- constraint" — a referential-integrity block, NOT a permission denial, since
-- the permission check passes first):
--   TRUNCATE TABLE public.warehouse_stock CASCADE;                -- succeeds
--   TRUNCATE TABLE public.outlet_stock CASCADE;                   -- succeeds
--   TRUNCATE TABLE public.item_availability_movements CASCADE;    -- succeeds
--   TRUNCATE TABLE public.stocktakes CASCADE;                     -- succeeds
-- This is a genuine, severe, previously-unflagged bypass: TRUNCATE is not
-- RLS-checkable (RLS only gates SELECT/INSERT/UPDATE/DELETE), so no policy
-- on these tables was ever able to stop it. It requires no elevated role —
-- any authenticated session can reach it directly through PostgREST.
--
-- Every legitimate write to every one of these tables already goes through a
-- SECURITY DEFINER RPC that runs as the function owner, not as `authenticated`
-- — table-level grants to `authenticated` are not required for any of them
-- (062-107's own REVOKE statements already established this for
-- INSERT/UPDATE/DELETE; this migration completes that boundary for the three
-- privileges every prior pass missed, plus the two tables 092 never touched
-- at all). SELECT is preserved everywhere it was already granted, since
-- RLS-gated reads are the intended path for the UI.
-- ============================================================================

BEGIN;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
  ON TABLE public.item_availability_movements
  FROM authenticated, anon, PUBLIC;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
  ON TABLE public.warehouse_stock
  FROM authenticated, anon, PUBLIC;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
  ON TABLE public.warehouse_stock_movements
  FROM authenticated, anon, PUBLIC;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
  ON TABLE public.warehouse_dispatches
  FROM authenticated, anon, PUBLIC;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
  ON TABLE public.warehouse_dispatch_lines
  FROM authenticated, anon, PUBLIC;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
  ON TABLE public.outlet_stock
  FROM authenticated, anon, PUBLIC;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
  ON TABLE public.outlet_stock_movements
  FROM authenticated, anon, PUBLIC;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
  ON TABLE public.warehouse_quarantine_stock
  FROM authenticated, anon, PUBLIC;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
  ON TABLE public.warehouse_quarantine_stock_movements
  FROM authenticated, anon, PUBLIC;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
  ON TABLE public.phoenix_movement_events
  FROM authenticated, anon, PUBLIC;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
  ON TABLE public.phoenix_stock_correction_requests
  FROM authenticated, anon, PUBLIC;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
  ON TABLE public.phoenix_warehouse_correction_requests
  FROM authenticated, anon, PUBLIC;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
  ON TABLE public.phoenix_dispatch_line_requests
  FROM authenticated, anon, PUBLIC;

-- 092 never revoked anything on these two tables: authenticated held full
-- INSERT/UPDATE/DELETE/TRUNCATE/TRIGGER/REFERENCES, not just the three this
-- migration's title is about. Close both gaps together.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
  ON TABLE public.stocktakes
  FROM authenticated, anon, PUBLIC;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
  ON TABLE public.stocktake_count_lines
  FROM authenticated, anon, PUBLIC;

-- =============================================================================
-- VERIFY — inside the transaction; failure rolls back all of 108
-- =============================================================================

DO $$
DECLARE
  v_tables text[] := ARRAY[
    'item_availability_movements','warehouse_stock','warehouse_stock_movements',
    'warehouse_dispatches','warehouse_dispatch_lines','outlet_stock',
    'outlet_stock_movements','warehouse_quarantine_stock',
    'warehouse_quarantine_stock_movements','phoenix_movement_events',
    'phoenix_stock_correction_requests','phoenix_warehouse_correction_requests',
    'phoenix_dispatch_line_requests','stocktakes','stocktake_count_lines'
  ];
  v_t text;
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
  END LOOP;
END $$;

COMMIT;

-- ============================================================================
-- POST-CONDITIONS
-- ============================================================================
-- 1. `authenticated` (and `anon`, `PUBLIC`) hold ONLY SELECT on every
--    custody-chain table listed above; INSERT/UPDATE/DELETE/TRUNCATE/
--    TRIGGER/REFERENCES are all revoked. Verified in-transaction above via
--    has_table_privilege(), which reflects role-membership-inherited grants
--    too (not just direct GRANT rows), so this closes the gap regardless of
--    how a future role hierarchy change might otherwise reintroduce it.
-- 2. Every canonical write RPC (dispatch, transfer, receive, request/approve/
--    reject correction, quarantine disposition, stocktake recording, ...) is
--    SECURITY DEFINER and runs as its function owner — never as
--    `authenticated` — so this migration has ZERO effect on any of them.
-- 3. RECONCILIATION: this migration writes no data itself (pure privilege
--    revocation) — nothing to reconcile.
-- ============================================================================
-- ROLLBACK: re-run 092's original grants would need to be reconstructed from
-- the ALTER DEFAULT PRIVILEGES bootstrap (GRANT ALL ON TABLES was never
-- itself written as an explicit migration statement); for every other table
-- here, re-apply
--   GRANT TRUNCATE, TRIGGER, REFERENCES ON TABLE public.<table> TO authenticated;
-- per table. There is no legitimate reason to ever do this.
-- ============================================================================
