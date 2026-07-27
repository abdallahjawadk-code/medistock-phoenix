-- ============================================================================
-- PHOENIX-DEMO-PURGE-RESTRICT-VIOLATION-AND-ORDERING-143
--
-- Forward-only correction to 140/141/142, found by running the full seeder
-- (all corridors, production scale) through seed -> purge on a disposable
-- rig. Two compounding defects, both in phoenix_demo_purge itself; no
-- application RPC, RLS policy or immutability guarantee is touched.
--
-- DEFECT 1 — the exception handler catches the wrong condition.
-- phoenix_demo_purge's per-table DELETE is wrapped in
--   EXCEPTION WHEN foreign_key_violation THEN ... (report blocked, continue)
-- so a genuinely blocked table is reported rather than aborting the whole
-- purge. That works for an ON DELETE NO ACTION-style violation raised at
-- INSERT/UPDATE time (SQLSTATE 23503, condition name foreign_key_violation).
-- It does NOT work for the case actually hit here: deleting the REFERENCED
-- (parent) side of an ON DELETE RESTRICT foreign key raises a DIFFERENT,
-- sibling condition — SQLSTATE 23001, condition name restrict_violation.
-- Both are children of integrity_constraint_violation, but PL/pgSQL's
-- `WHEN foreign_key_violation` does not catch a sibling condition. The
-- result: a restrict-violation blocked table crashed the ENTIRE purge
-- (uncaught exception, transaction rolled back) instead of being reported
-- as `<table>: blocked, executed=false` like every other blocked table.
--
-- DEFECT 2 — five child tables are ordered AFTER a table they reference.
-- phoenix_demo_purgeable_tables() is documented "exhaustive and ordered
-- CHILD-FIRST", but five tables were positioned after a RESTRICT-FK parent
-- they point to (found by a full pg_constraint sweep, see the verify block):
--   outlet_return_shipment_lines  -> warehouse_dispatch_lines, outlet_stock_movements
--   outlet_return_request_lines   -> warehouse_dispatch_lines, outlet_stock_movements
--   procurement_returns           -> warehouse_stock_movements
--   procurement_receipt_lines     -> warehouse_stock_movements
--   inventory_status_report_lines -> stocktake_count_lines
-- With defect 1 masking it, a genuinely full run of the corridors these
-- tables belong to (which the seeder previously never reached at scale)
-- would hit this ordering every time, not intermittently.
--
-- THE FIX
--   A. Broaden the exception handler to catch BOTH sibling conditions —
--      still narrowly scoped to referential blocks, nothing else.
--   B. Move the five tables ahead of everything they can reference, in an
--      order that preserves their own mutual dependency (shipment_lines
--      before request_lines; returns before receipt_lines — both already
--      correct relative to each other, only their ABSOLUTE position moves).
--   C. A permanent regression guard: the verify block below queries
--      pg_constraint directly for every RESTRICT/NO ACTION foreign key
--      between two tables that are BOTH on the allow-list, and asserts the
--      child is strictly earlier than the parent for every one of them —
--      so a future migration that adds a table or a new FK without updating
--      this order fails loudly here rather than crashing a purge in
--      Production.
--
-- Neither the marking mechanism (141), the ownership boundary (141), nor
-- the profile-detachment contract (142) changes here — only the table
-- ordering and the set of exceptions the purge treats as "blocked, not
-- fatal".
--
-- PRECONDITIONS: 140 (manifest + purgeable_tables), 141 (purger role +
-- purge), 142 (profile detach wired into purge).
-- ============================================================================

BEGIN;

DO $precond$
BEGIN
  IF to_regclass('public.phoenix_demo_manifest') IS NULL THEN
    RAISE EXCEPTION '143 PRECONDITION FAILED: 140 manifest missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'phoenix_demo_purger') THEN
    RAISE EXCEPTION '143 PRECONDITION FAILED: 141 purger role missing';
  END IF;
  IF to_regprocedure('public.phoenix_demo_detach_profiles(boolean)') IS NULL THEN
    RAISE EXCEPTION '143 PRECONDITION FAILED: 142 detach function missing';
  END IF;
END;
$precond$;

-- ── A. Corrected ordering: child-first, verified below ──────────────────────

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

-- ── B. phoenix_demo_purge — identical to 142's body except the ONE
-- exception clause, which now also catches restrict_violation (23001). The
-- ownership boundary (owner = phoenix_demo_purger), the super_admin check,
-- the dry-run default, the per-organization preflight, the profile-detach
-- wiring and the manifest-forgetting rule are all byte-identical to 142.

CREATE OR REPLACE FUNCTION public.phoenix_demo_purge(
  p_dataset_key text,
  p_dry_run     boolean DEFAULT true
)
RETURNS TABLE (table_name text, affected bigint, executed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $purge$
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
$purge$;

ALTER FUNCTION public.phoenix_demo_purge(text, boolean) OWNER TO phoenix_demo_purger;
REVOKE ALL ON FUNCTION public.phoenix_demo_purge(text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_demo_purge(text, boolean) TO authenticated;

-- ── C. Permanent regression guard ────────────────────────────────────────────
DO $verify$
DECLARE
  v_tables text[] := public.phoenix_demo_purgeable_tables();
  v_n      integer;
  v_bad    text;
BEGIN
  IF array_length(v_tables, 1) IS DISTINCT FROM 40 THEN
    RAISE EXCEPTION '143 VERIFY FAILED: expected exactly 40 purgeable tables, found %',
      array_length(v_tables, 1);
  END IF;
  IF (SELECT count(DISTINCT t) FROM unnest(v_tables) t) <> array_length(v_tables, 1) THEN
    RAISE EXCEPTION '143 VERIFY FAILED: phoenix_demo_purgeable_tables() contains a duplicate';
  END IF;

  -- THE INVARIANT: for every RESTRICT or NO ACTION foreign key between two
  -- tables that are BOTH on the allow-list, the referencing (child) table
  -- must appear STRICTLY BEFORE the referenced (parent) table — otherwise
  -- deleting the parent first raises exactly the exception this migration
  -- exists to fix, and only the exception is now caught, not prevented.
  SELECT string_agg(format('%s (pos %s) references %s (pos %s) via %s',
                            child, child_pos, parent, parent_pos, conname), '; ')
    INTO v_bad
    FROM (
      SELECT c.conname,
             c.conrelid::regclass::text  AS child,
             ac.ordinality               AS child_pos,
             c.confrelid::regclass::text AS parent,
             ap.ordinality               AS parent_pos
        FROM pg_constraint c
        JOIN unnest(v_tables) WITH ORDINALITY AS ac(tbl, ordinality)
          ON ac.tbl = c.conrelid::regclass::text
        JOIN unnest(v_tables) WITH ORDINALITY AS ap(tbl, ordinality)
          ON ap.tbl = c.confrelid::regclass::text
       WHERE c.contype = 'f'
         AND c.confdeltype IN ('r', 'a')   -- RESTRICT, NO ACTION
         AND ac.ordinality > ap.ordinality
    ) violations;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '143 VERIFY FAILED: child ordered after a RESTRICT/NO ACTION parent it references — %', v_bad;
  END IF;

  SELECT pg_get_functiondef(to_regprocedure('public.phoenix_demo_purge(text, boolean)')) INTO v_bad;
  IF position('restrict_violation' IN v_bad) = 0 OR position('foreign_key_violation' IN v_bad) = 0 THEN
    RAISE EXCEPTION '143 VERIFY FAILED: purge no longer catches both referential-block conditions';
  END IF;

  IF (SELECT pg_get_userbyid(proowner) FROM pg_proc
       WHERE oid = to_regprocedure('public.phoenix_demo_purge(text, boolean)')) <> 'phoenix_demo_purger' THEN
    RAISE EXCEPTION '143 VERIFY FAILED: phoenix_demo_purge must remain owned by phoenix_demo_purger';
  END IF;

  SELECT count(*) INTO v_n FROM pg_roles WHERE rolname = 'phoenix_demo_purger' AND NOT rolcanlogin;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '143 VERIFY FAILED: phoenix_demo_purger ownership boundary disturbed';
  END IF;

  RAISE NOTICE 'PHOENIX-DEMO-PURGE-RESTRICT-VIOLATION-AND-ORDERING-143: verified, % tables, 0 ordering violations.',
    array_length(v_tables, 1);
END;
$verify$;

COMMIT;
