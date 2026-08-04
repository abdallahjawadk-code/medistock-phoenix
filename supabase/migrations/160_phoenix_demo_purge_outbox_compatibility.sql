-- ============================================================================
-- DEMO-PURGE-OUTBOX-COMPATIBILITY-160
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply after 159.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THIS EXISTS — A PREREQUISITE COMPATIBILITY CORRECTION, NOT NEW SCOPE
-- ─────────────────────────────────────────────────────────────────────────────
-- 143's own title is "demo purge RESTRICT violation and ordering" — it exists
-- because phoenix_demo_purge() deletes every purgeable table in the exact,
-- hand-maintained, dependency-safe order returned by
-- phoenix_demo_purgeable_tables(), specifically to avoid ON DELETE RESTRICT
-- foreign-key violations when a still-referencing row survives past the
-- table it references.
--
-- phoenix_outbox_events (158) has organization_id REFERENCES
-- organizations(id) ON DELETE RESTRICT, but 143 predates 158 by 15
-- migrations — it could not have known about a table that did not exist yet.
-- Before 159, this never surfaced: the table was always empty (D2-1 wires no
-- producer), so no row ever blocked a purge. 159 is what changes that — it
-- is the first thing that writes real rows into phoenix_outbox_events during
-- ordinary operation, including the demo dataset's own seeding (which drives
-- real corridor transitions through the newly-wired trigger). The very next
-- purge attempt then hits exactly the RESTRICT violation 143 was written to
-- prevent, for the one table 143 never had a chance to include.
--
-- This migration closes that one gap: phoenix_outbox_events is added to
-- phoenix_demo_purgeable_tables()'s array, positioned immediately after its
-- closest sibling, phoenix_movement_events (both are append-only lifecycle-
-- event ledgers with the exact same "leaf, references organizations,
-- nothing else references it" shape) — well before organizations itself,
-- which every purgeable table must be able to reach a fully-deleted state
-- ahead of.
--
-- phoenix_demo_purge() itself needs no change to its LOGIC: it already reads
-- its deletion order dynamically from phoenix_demo_purgeable_tables() via
-- `FOREACH v_table IN ARRAY v_tables LOOP` (confirmed by direct inspection
-- of 143's own body before writing this file) rather than hardcoding its
-- own copy of the list.
--
-- A SECOND, NARROWER gap surfaced only when this migration was proved
-- dynamically against a real purge run (not assumed from static inspection):
-- phoenix_demo_purge() has executed as the dedicated 'phoenix_demo_purger'
-- role (SECURITY DEFINER, ALTER FUNCTION ... OWNER TO, migration 141) since
-- 141, not as the migration-applying superuser. 141's own grant step is a
-- ONE-TIME snapshot — `FOREACH t IN ARRAY public.phoenix_demo_purgeable_
-- tables() LOOP EXECUTE format('GRANT SELECT, DELETE ON public.%I TO
-- phoenix_demo_purger', t)` — evaluated once, at 141's own apply time,
-- against whatever phoenix_demo_purgeable_tables() returned THEN.
-- phoenix_outbox_events did not exist until 158, 17 migrations later, so it
-- was never a member of that one-time grant and phoenix_demo_purger holds no
-- privilege on it at all (158's own REVOKE ALL ... FROM PUBLIC, authenticated,
-- anon does not name phoenix_demo_purger, but no GRANT ever named it either —
-- confirmed directly against a live rig: only 'postgres' and 'service_role'
-- hold any grant on phoenix_outbox_events pre-160). Every later migration
-- that adds a new purgeable table has always had to grant phoenix_demo_purger
-- itself; this is not a new mechanism, and 154/156/157 added no new
-- purgeable table so this is the first time it has come up since 141.
--
-- Without this grant, adding 'phoenix_outbox_events' to the array alone
-- would make phoenix_demo_purge() attempt `DELETE FROM
-- public.phoenix_outbox_events ...` as phoenix_demo_purger and raise
-- insufficient_privilege (42501) — uncaught by the loop's `EXCEPTION WHEN
-- foreign_key_violation OR restrict_violation` handler (42501 is neither),
-- aborting the ENTIRE purge transaction. That is a strictly worse outcome
-- than the original RESTRICT-violation gap this migration exists to close:
-- the original bug left stale rows in one table; this one, unfixed, would
-- have made every purge attempt fail completely the moment any demo
-- lifecycle activity had produced a single outbox row. This was caught by
-- this migration's own dynamic test, not assumed.
--
-- A THIRD gap, of the exact same one-time-snapshot shape, surfaced once the
-- GRANT above was proved dynamically: phoenix_outbox_events (158) has RLS
-- ENABLED with ZERO policies (158's own deliberate design — no client role
-- was ever meant to see it directly). A GRANT alone is necessary but not
-- sufficient: for any non-owner role, zero RLS policies means zero visible
-- rows for every command, including DELETE — the DELETE statement succeeds
-- but matches nothing, so the row survives and the very next
-- 'organizations' DELETE in the same purge run hits the identical RESTRICT
-- violation this migration exists to close. 141's own dynamic
-- `DO $policies$ ... FOREACH t IN ARRAY public.phoenix_demo_purgeable_
-- tables() LOOP ... CREATE POLICY %I ON public.%I FOR SELECT/DELETE TO
-- phoenix_demo_purger USING (...)` loop (confirmed by direct inspection of
-- 141's own body) is the SAME one-time snapshot as its GRANT loop a few
-- lines above it, and phoenix_outbox_events is absent from its policy set
-- for the identical reason. This migration adds the same SELECT/DELETE
-- policy PAIR, scoped by the same manifest-membership predicate, using the
-- same %I-generated naming convention 141 already uses per table
-- (phoenix_outbox_events has no demo_dataset_id marker column, so no marker
-- clause applies, matching every other markerless table in that loop).
--
-- SCOPE: this migration touches phoenix_demo_purgeable_tables()'s returned
-- array (one table name inserted at one position — every other existing
-- table name, and their existing relative order, preserved byte-for-byte),
-- one GRANT statement, and one matching SELECT/DELETE RLS policy pair — all
-- three giving the pre-existing 'phoenix_demo_purger' role (141) the exact
-- same access to phoenix_outbox_events that every other purgeable table
-- already carries, by the exact same mechanisms 141 already uses per table,
-- extended here to the one table 141 could not have known about. No
-- trigger, no business table, no business RPC, no RBAC role-permission
-- mapping, no report, no frontend code, and no producer/consumer logic is
-- touched; no policy or privilege targets any role other than
-- phoenix_demo_purger (a NOLOGIN/NOINHERIT role unreachable by any
-- application user — 141's own contract, re-verified below); and no
-- privilege beyond SELECT, DELETE — the exact pre-existing pattern — is
-- granted to any role. This migration writes no application data and
-- creates no outbox rows.
-- ============================================================================

BEGIN;

-- ── PRECONDITIONS ───────────────────────────────────────────────────────────

DO $precond$
DECLARE
  v_current_tables text[];
BEGIN
  IF to_regclass('public.phoenix_outbox_events') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: phoenix_outbox_events is missing — apply 158 first';
  END IF;
  IF to_regprocedure('public.phoenix_demo_purgeable_tables()') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: phoenix_demo_purgeable_tables() is missing — apply 143 first';
  END IF;

  v_current_tables := public.phoenix_demo_purgeable_tables();
  IF 'phoenix_outbox_events' = ANY(v_current_tables) THEN
    RAISE EXCEPTION 'precondition failed: phoenix_outbox_events already present in phoenix_demo_purgeable_tables() (160 already applied?)';
  END IF;

  -- Audited baseline security/ownership contract must still hold.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.proname = 'phoenix_demo_purgeable_tables'
      AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'sql')
      AND p.provolatile = 'i'
  ) THEN
    RAISE EXCEPTION 'precondition failed: phoenix_demo_purgeable_tables() is not the audited LANGUAGE sql IMMUTABLE function';
  END IF;
  IF has_function_privilege('anon', 'public.phoenix_demo_purgeable_tables()', 'EXECUTE') THEN
    RAISE EXCEPTION 'precondition failed: anon must not be EXECUTE-granted on phoenix_demo_purgeable_tables()';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.phoenix_demo_purgeable_tables()', 'EXECUTE') THEN
    RAISE EXCEPTION 'precondition failed: authenticated''s existing EXECUTE grant on phoenix_demo_purgeable_tables() no longer holds';
  END IF;

  -- The 141 purge-role contract must still hold before this migration grants
  -- it one more table's worth of privilege.
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'phoenix_demo_purger' AND rolcanlogin = false AND rolinherit = false
  ) THEN
    RAISE EXCEPTION 'precondition failed: phoenix_demo_purger is missing or no longer NOLOGIN/NOINHERIT — apply 141 first';
  END IF;
  IF (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = to_regprocedure('public.phoenix_demo_purge(text, boolean)')) <> 'phoenix_demo_purger' THEN
    RAISE EXCEPTION 'precondition failed: phoenix_demo_purge(text, boolean) must still be owned by phoenix_demo_purger';
  END IF;
  IF has_table_privilege('phoenix_demo_purger', 'public.phoenix_outbox_events', 'SELECT') THEN
    RAISE EXCEPTION 'precondition failed: phoenix_demo_purger already holds a privilege on phoenix_outbox_events (160 already applied?)';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.phoenix_outbox_events'::regclass) THEN
    RAISE EXCEPTION 'precondition failed: phoenix_outbox_events must have RLS enabled (158''s baseline)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'phoenix_outbox_events'
  ) THEN
    RAISE EXCEPTION 'precondition failed: phoenix_outbox_events must have zero RLS policies before 160 (158''s baseline; 160 already applied?)';
  END IF;
END;
$precond$;

-- ── The purgeable-table list — every existing entry preserved, one insertion ──

CREATE OR REPLACE FUNCTION public.phoenix_demo_purgeable_tables()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $tables$
  SELECT ARRAY[
    -- 143: these five were previously positioned AFTER a RESTRICT-FK parent
    -- they reference (outlet_stock_movements / warehouse_stock_movements /
    -- warehouse_dispatch_lines / stocktake_count_lines) — moved ahead of
    -- everything they can reference. Their own mutual order is preserved:
    -- outlet_return_shipment_lines before outlet_return_request_lines
    -- (shipment_lines.return_request_line_id -> request_lines), and
    -- procurement_returns before procurement_receipt_lines
    -- (procurement_returns.receipt_line_id -> receipt_lines).
    'outlet_return_shipment_lines',
    'outlet_return_request_lines',
    'procurement_returns',
    'procurement_receipt_lines',
    'inventory_status_report_lines',
    -- Movement/context leaves.
    'phoenix_movement_dispense_context',
    'phoenix_movement_events',
    -- 160: phoenix_outbox_events (158) is the same "leaf, append-only,
    -- references organizations ON DELETE RESTRICT, nothing else references
    -- it" shape as phoenix_movement_events immediately above — 159 is what
    -- first makes it non-empty during ordinary operation (including demo
    -- seeding), so it must purge before organizations exactly like every
    -- other RESTRICT-FK leaf in this array already does.
    'phoenix_outbox_events',
    'warehouse_stock_movements',
    'outlet_stock_movements',
    'warehouse_quarantine_stock_movements',
    'item_availability_movements',
    'stocktake_count_lines',
    'stocktakes',
    -- Correction/approval documents.
    'phoenix_stock_correction_requests',
    'phoenix_warehouse_correction_requests',
    -- Corridor lines before their headers.
    'warehouse_transfer_lines',
    'warehouse_transfers',
    'warehouse_dispatch_lines',
    'warehouse_dispatches',
    'outlet_return_shipments',
    'outlet_return_requests',
    -- Procurement history is immutable by product design (087's
    -- `procurement_history_is_immutable`). Migration 141 adds a STRICTLY
    -- SCOPED exemption: a row is deletable only when it is demo-marked,
    -- manifest-owned, in a demo-created organization, and the delete
    -- originates from phoenix_demo_purge running under its dedicated owner
    -- role. Genuine procurement history remains permanently immutable.
    'procurement_order_events',
    'procurement_receipts',
    'procurement_order_lines',
    'procurement_orders',
    'inventory_status_reports',
    -- Reporting artefacts. phoenix_report_snapshots is immutable by design
    -- (119) and is reachable only through 141's scoped exemption, on the
    -- same six simultaneous conditions as procurement history.
    'phoenix_report_snapshots',
    'audit_logs',
    'phoenix_notifications',
    -- Balances after every movement that references them.
    'outlet_stock',
    'warehouse_quarantine_stock',
    'warehouse_stock',
    'item_availability',
    'warehouse_transfer_request_lines',
    'warehouse_transfer_requests',
    -- Master data last, still child-first.
    'procurement_suppliers',
    -- profile_scope_assignments references distribution_points AND warehouses
    -- with ON DELETE RESTRICT (psa_point_org_fk), so it MUST be cleared
    -- before either of them. The seed/purge lifecycle proof caught this
    -- ordering the hard way; the order below is the fixed one.
    'profile_scope_assignments',
    'distribution_points',
    'warehouses',
    'organizations'
  ];
$tables$;

REVOKE ALL ON FUNCTION public.phoenix_demo_purgeable_tables() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_demo_purgeable_tables() TO authenticated;

-- ── Extend 141's one-time per-table purge-role grant to the one table it ──
-- ── could not have known about (see WHY comment at the top of this file) ──

GRANT SELECT, DELETE ON public.phoenix_outbox_events TO phoenix_demo_purger;

-- ── Extend 141's one-time per-table purge-role RLS policy pair the same ──
-- ── way — a GRANT alone is not sufficient once RLS is enabled with zero ──
-- ── policies (158's deliberate design for this table) — same naming and ──
-- ── predicate convention as 141's own DO $policies$ loop, per table.    ──

DROP POLICY IF EXISTS phoenix_outbox_events_demo_purger_select ON public.phoenix_outbox_events;
CREATE POLICY phoenix_outbox_events_demo_purger_select
  ON public.phoenix_outbox_events
  FOR SELECT TO phoenix_demo_purger
  USING (EXISTS (
    SELECT 1 FROM public.phoenix_demo_manifest m
     WHERE m.dataset_key = 'PHOENIX_DEMO_V1'
       AND m.table_name = 'phoenix_outbox_events'
       AND m.row_id = phoenix_outbox_events.id
  ));

DROP POLICY IF EXISTS phoenix_outbox_events_demo_purger_delete ON public.phoenix_outbox_events;
CREATE POLICY phoenix_outbox_events_demo_purger_delete
  ON public.phoenix_outbox_events
  FOR DELETE TO phoenix_demo_purger
  USING (EXISTS (
    SELECT 1 FROM public.phoenix_demo_manifest m
     WHERE m.dataset_key = 'PHOENIX_DEMO_V1'
       AND m.table_name = 'phoenix_outbox_events'
       AND m.row_id = phoenix_outbox_events.id
  ));

-- =============================================================================
-- VERIFY — inside the transaction; failure rolls back all of 160
-- =============================================================================

DO $$
DECLARE
  v_tables text[];
  v_outbox_idx int;
  v_org_idx int;
  v_movement_idx int;
BEGIN
  -- 1. Function still exists with its exact zero-argument signature.
  ASSERT to_regprocedure('public.phoenix_demo_purgeable_tables()') IS NOT NULL,
    'phoenix_demo_purgeable_tables() must still exist';

  -- 2. Return type/language/volatility/search_path unchanged.
  ASSERT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.proname = 'phoenix_demo_purgeable_tables'
      AND p.prorettype = 'text[]'::regtype
      AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'sql')
      AND p.provolatile = 'i'
  ), 'phoenix_demo_purgeable_tables() must remain RETURNS text[] LANGUAGE sql IMMUTABLE';
  ASSERT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.proname = 'phoenix_demo_purgeable_tables'
      AND p.proconfig @> ARRAY['search_path=public, pg_temp']::text[]
  ), 'phoenix_demo_purgeable_tables() must keep search_path pinned to public, pg_temp';

  -- 3. Privileges unchanged: authenticated EXECUTE, anon/PUBLIC denied.
  ASSERT has_function_privilege('authenticated', 'public.phoenix_demo_purgeable_tables()', 'EXECUTE'),
    'authenticated must retain EXECUTE on phoenix_demo_purgeable_tables()';
  ASSERT NOT has_function_privilege('anon', 'public.phoenix_demo_purgeable_tables()', 'EXECUTE'),
    'anon must not gain EXECUTE on phoenix_demo_purgeable_tables()';

  v_tables := public.phoenix_demo_purgeable_tables();

  -- 4. phoenix_outbox_events appears exactly once.
  ASSERT (SELECT count(*) FROM unnest(v_tables) t WHERE t = 'phoenix_outbox_events') = 1,
    'phoenix_outbox_events must appear exactly once in phoenix_demo_purgeable_tables()';

  -- 5. Every previously-known table still appears exactly once (40 entries
  --    before this migration, one insertion, 41 after — and zero duplicates
  --    anywhere in the array).
  ASSERT array_length(v_tables, 1) = 41,
    format('expected exactly 41 purgeable tables after 160, found %s', array_length(v_tables, 1));
  ASSERT (SELECT count(*) FROM (SELECT DISTINCT unnest(v_tables)) d) = 41,
    'phoenix_demo_purgeable_tables() must contain no duplicate table name';

  -- 6. Ordered before organizations, and immediately after its sibling
  --    phoenix_movement_events.
  SELECT idx INTO v_outbox_idx FROM unnest(v_tables) WITH ORDINALITY AS u(t, idx) WHERE t = 'phoenix_outbox_events';
  SELECT idx INTO v_org_idx FROM unnest(v_tables) WITH ORDINALITY AS u(t, idx) WHERE t = 'organizations';
  SELECT idx INTO v_movement_idx FROM unnest(v_tables) WITH ORDINALITY AS u(t, idx) WHERE t = 'phoenix_movement_events';
  ASSERT v_outbox_idx < v_org_idx,
    'phoenix_outbox_events must be purged before organizations';
  ASSERT v_outbox_idx = v_movement_idx + 1,
    'phoenix_outbox_events must be positioned immediately after phoenix_movement_events';

  -- 7. phoenix_demo_purger holds exactly the same SELECT, DELETE privilege on
  --    phoenix_outbox_events that 141 already granted it on every other
  --    purgeable table — no more, no less — so a real purge run can delete
  --    through this table without an uncaught insufficient_privilege error.
  ASSERT has_table_privilege('phoenix_demo_purger', 'public.phoenix_outbox_events', 'SELECT'),
    'phoenix_demo_purger must hold SELECT on phoenix_outbox_events';
  ASSERT has_table_privilege('phoenix_demo_purger', 'public.phoenix_outbox_events', 'DELETE'),
    'phoenix_demo_purger must hold DELETE on phoenix_outbox_events';
  ASSERT NOT has_table_privilege('phoenix_demo_purger', 'public.phoenix_outbox_events', 'INSERT'),
    'phoenix_demo_purger must not gain INSERT on phoenix_outbox_events';
  ASSERT NOT has_table_privilege('phoenix_demo_purger', 'public.phoenix_outbox_events', 'UPDATE'),
    'phoenix_demo_purger must not gain UPDATE on phoenix_outbox_events';
  -- 158's authenticated/anon/PUBLIC lockdown is untouched by this grant.
  ASSERT NOT has_table_privilege('authenticated', 'public.phoenix_outbox_events', 'SELECT'),
    'authenticated must still hold no privilege on phoenix_outbox_events';
  ASSERT NOT has_table_privilege('anon', 'public.phoenix_outbox_events', 'SELECT'),
    'anon must still hold no privilege on phoenix_outbox_events';

  -- 8. RLS is still enabled, and exactly the two phoenix_demo_purger
  --    policies this migration adds exist — no policy for any other role.
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.phoenix_outbox_events'::regclass),
    'phoenix_outbox_events must keep RLS enabled';
  ASSERT (
    SELECT count(*) FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'phoenix_outbox_events'
  ) = 2, 'phoenix_outbox_events must carry exactly the two phoenix_demo_purger policies this migration adds';
  ASSERT (
    SELECT count(*) FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'phoenix_outbox_events'
       AND roles = ARRAY['phoenix_demo_purger']::name[]
  ) = 2, 'both phoenix_outbox_events policies must target phoenix_demo_purger only';
  ASSERT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'phoenix_outbox_events'
       AND policyname = 'phoenix_outbox_events_demo_purger_select' AND cmd = 'SELECT'
  ), 'phoenix_outbox_events_demo_purger_select must exist as a SELECT policy';
  ASSERT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'phoenix_outbox_events'
       AND policyname = 'phoenix_outbox_events_demo_purger_delete' AND cmd = 'DELETE'
  ), 'phoenix_outbox_events_demo_purger_delete must exist as a DELETE policy';
  ASSERT (
    SELECT qual FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'phoenix_outbox_events'
       AND policyname = 'phoenix_outbox_events_demo_purger_select'
  ) LIKE '%phoenix_demo_manifest%' , 'the select policy must scope by manifest membership';

  -- 9. Applying this migration alone touches zero application data: proven
  --    by construction (this file contains no INSERT/UPDATE/DELETE
  --    statement anywhere — a single function redefinition plus its own
  --    REVOKE/GRANT — and re-verified textually by the static test), not by
  --    an in-transaction row-count comparison this DO block has no "before"
  --    snapshot to compare against.
END $$;

COMMIT;

-- ============================================================================
-- POST-CONDITIONS
-- ============================================================================
-- 1. phoenix_demo_purgeable_tables(): same zero-arg signature, RETURNS
--    text[], LANGUAGE sql, IMMUTABLE, pinned search_path, same owner, same
--    authenticated-only EXECUTE grant — re-verified in-transaction above.
-- 2. Its returned array contains phoenix_outbox_events exactly once,
--    positioned immediately after phoenix_movement_events and strictly
--    before organizations; every one of the 40 previously-returned table
--    names is still present exactly once, in its previous relative order.
-- 3. phoenix_demo_purge()'s BODY is unchanged — it already reads this array
--    dynamically, so it now purges phoenix_outbox_events automatically
--    without any further modification to that function. Its ability to
--    execute that purge is what item 6 below provides.
-- 4. No trigger, business table, business RPC, or RBAC role-permission
--    mapping was touched. The only RLS policies touched are the two new
--    ones on phoenix_outbox_events, both scoped to phoenix_demo_purger only
--    (item 7 below) — no existing policy on any table was altered.
-- 5. RECONCILIATION: this migration writes no application data itself (one
--    function redefinition, one GRANT, two CREATE POLICY) — nothing to
--    reconcile.
-- 6. phoenix_demo_purger (141) holds SELECT, DELETE on phoenix_outbox_events
--    — the exact privilege pair it already holds on every other purgeable
--    table, granted by the exact same pattern — and nothing more; no other
--    role's privileges on phoenix_outbox_events changed (158's authenticated/
--    anon/PUBLIC lockdown is untouched) — re-verified in-transaction above.
-- 7. phoenix_outbox_events carries exactly two RLS policies, both scoped to
--    phoenix_demo_purger only, both predicated on
--    phoenix_demo_manifest-membership under dataset key 'PHOENIX_DEMO_V1' —
--    the same predicate shape 141's own per-table loop already uses for
--    every other purgeable table — re-verified in-transaction above.
-- ============================================================================
-- ROLLBACK: there is no legitimate reason to ever do this once any demo
-- purge has run under the new list (a purge that already deleted outbox
-- rows cannot un-delete them, and reverting the function afterward would
-- just reopen the same RESTRICT-violation gap this migration closes). If
-- genuinely required before any purge runs under it:
--   1. Re-apply 143's exact CREATE OR REPLACE FUNCTION body (without the
--      'phoenix_outbox_events' entry added here) to restore the pre-160
--      definition.
--   2. REVOKE SELECT, DELETE ON public.phoenix_outbox_events FROM
--      phoenix_demo_purger;
--   3. DROP POLICY phoenix_outbox_events_demo_purger_select ON
--      public.phoenix_outbox_events;
--      DROP POLICY phoenix_outbox_events_demo_purger_delete ON
--      public.phoenix_outbox_events;
-- ============================================================================
