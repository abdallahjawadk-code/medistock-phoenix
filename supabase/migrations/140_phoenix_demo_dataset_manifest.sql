-- ============================================================================
-- PHOENIX-DEMO-DATASET-MANIFEST-140
--
-- The ownership + reversibility contract for the labelled demo dataset
-- (`PHOENIX_DEMO_V1`). This migration deliberately contains NO demo data: it
-- only creates the mechanism that makes demo data provably reversible.
--
-- WHY A DATABASE MANIFEST RATHER THAN A SCRIPT-SIDE LIST
--   A purge that trusts a file, a naming convention, or a LIKE 'تجريبي%'
--   pattern can delete a real row that happens to match. The only defensible
--   contract is: a row may be purged if, and only if, this table says the
--   demo seeder created it. Ownership is recorded at creation time, in the
--   same transaction as the creation, and purge is a set-intersection against
--   that record — never a pattern match, never a heuristic.
--
-- SAFETY PROPERTIES THIS ENFORCES
--   * Purge NEVER deletes a row absent from the manifest, for any table.
--   * Purge NEVER touches profiles, auth.users, organizations it did not
--     create, permission_keys, role_permission_defaults, migrations, or any
--     configuration table — the allow-list below is exhaustive and every
--     entry is a table the seeder itself creates rows in.
--   * A super_admin whose own profile predates the dataset can never be
--     removed by it: profiles are not purgeable at all (the seeder creates
--     demo profiles, but they are deactivated rather than deleted, so the
--     last-super-admin guard and every actor snapshot stay intact and
--     historical audit rows keep resolving their actor).
--   * Dry-run is the DEFAULT at every layer: the RPC's p_dry_run defaults to
--     true, so an omitted argument can only ever report, never delete.
--
-- PRECONDITIONS: 001 (organizations/profiles), 092 (phoenix_status_center_
--   authorized is not used here — super_admin is required directly).
-- ============================================================================

BEGIN;

DO $precond$
BEGIN
  IF to_regclass('public.organizations') IS NULL OR to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION '140 PRECONDITION FAILED: core schema missing — apply 001 first';
  END IF;
  IF to_regprocedure('public.phoenix_my_role()') IS NULL THEN
    RAISE EXCEPTION '140 PRECONDITION FAILED: phoenix_my_role() missing';
  END IF;
END;
$precond$;

-- ── A. The manifest ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.phoenix_demo_manifest (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_key text NOT NULL,
  table_name  text NOT NULL,
  row_id      uuid NOT NULL,
  -- The deterministic seed key that produced this row. Lets a re-seed detect
  -- "already created" without re-deriving it from business columns.
  seed_key    text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT phoenix_demo_manifest_dataset_chk
    CHECK (btrim(dataset_key) = dataset_key AND dataset_key <> ''),
  CONSTRAINT phoenix_demo_manifest_table_chk
    CHECK (btrim(table_name) = table_name AND table_name <> '')
);

-- Idempotency: registering the same row twice is a no-op, so a second seed
-- run cannot double-register and cannot inflate purge counts.
CREATE UNIQUE INDEX IF NOT EXISTS phoenix_demo_manifest_unique_row
  ON public.phoenix_demo_manifest (dataset_key, table_name, row_id);
CREATE INDEX IF NOT EXISTS phoenix_demo_manifest_dataset_idx
  ON public.phoenix_demo_manifest (dataset_key, table_name);
CREATE INDEX IF NOT EXISTS phoenix_demo_manifest_seed_key_idx
  ON public.phoenix_demo_manifest (dataset_key, seed_key);

COMMENT ON TABLE public.phoenix_demo_manifest IS
  'PHOENIX-DEMO-DATASET-MANIFEST-140: ownership record for every row created '
  'by a labelled demo dataset. Purge is a set-intersection against this '
  'table -- never a name/pattern heuristic -- so a real row can never be '
  'deleted by the demo lifecycle.';

ALTER TABLE public.phoenix_demo_manifest ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS phoenix_demo_manifest_select_super_admin ON public.phoenix_demo_manifest;
CREATE POLICY phoenix_demo_manifest_select_super_admin
  ON public.phoenix_demo_manifest
  FOR SELECT TO authenticated
  USING (public.phoenix_my_role() = 'super_admin');

-- No INSERT/UPDATE/DELETE policy: with RLS on, those are denied to
-- `authenticated` outright. Only the SECURITY DEFINER functions below may
-- write, and each re-checks super_admin itself.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.phoenix_demo_manifest FROM authenticated;
GRANT SELECT ON TABLE public.phoenix_demo_manifest TO authenticated;
REVOKE ALL ON TABLE public.phoenix_demo_manifest FROM anon;

-- ── B. The purgeable-table allow-list ───────────────────────────────────────
-- Exhaustive and ordered CHILD-FIRST. A table absent from this list can be
-- REGISTERED (so the manifest stays a complete record of what was created)
-- but can never be deleted by phoenix_demo_purge — the purge reports it as
-- `not_purgeable` instead of silently skipping it.

CREATE OR REPLACE FUNCTION public.phoenix_demo_purgeable_tables()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $tables$
  SELECT ARRAY[
    -- Movement/context leaves first.
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
    'warehouse_dispatch_lines',
    'warehouse_dispatches',
    'outlet_return_shipment_lines',
    'outlet_return_shipments',
    'outlet_return_request_lines',
    'outlet_return_requests',
    'procurement_receipt_lines',
    'procurement_receipts',
    'procurement_order_lines',
    'procurement_orders',
    'inventory_status_report_lines',
    'inventory_status_reports',
    -- Reporting artefacts.
    'phoenix_report_snapshots',
    'audit_logs',
    'notifications',
    -- Balances after every movement that references them.
    'outlet_stock',
    'warehouse_quarantine_stock',
    'warehouse_stock',
    'item_availability',
    -- Master data last, still child-first.
    'suppliers',
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

-- ── C. Register — the only writer ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.phoenix_demo_register(
  p_dataset_key text,
  p_table_name  text,
  p_row_id      uuid,
  p_seed_key    text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $register$
DECLARE
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF public.phoenix_my_role() <> 'super_admin' THEN
    RAISE EXCEPTION 'forbidden_demo_manifest_write' USING ERRCODE = '42501';
  END IF;
  IF p_dataset_key IS NULL OR btrim(p_dataset_key) = ''
     OR p_table_name IS NULL OR btrim(p_table_name) = ''
     OR p_row_id IS NULL THEN
    RAISE EXCEPTION 'dataset_key_table_and_row_required' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.phoenix_demo_manifest (dataset_key, table_name, row_id, seed_key)
  VALUES (p_dataset_key, p_table_name, p_row_id, p_seed_key)
  ON CONFLICT (dataset_key, table_name, row_id) DO UPDATE
    SET seed_key = COALESCE(EXCLUDED.seed_key, public.phoenix_demo_manifest.seed_key)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$register$;

REVOKE ALL ON FUNCTION public.phoenix_demo_register(text, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_demo_register(text, text, uuid, text) TO authenticated;

-- ── D. Summary — what the dataset owns, by table ────────────────────────────

CREATE OR REPLACE FUNCTION public.phoenix_demo_manifest_summary(p_dataset_key text)
RETURNS TABLE (table_name text, row_count bigint, purgeable boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $summary$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF public.phoenix_my_role() <> 'super_admin' THEN
    RAISE EXCEPTION 'forbidden_demo_manifest_read' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT m.table_name,
         count(*)::bigint,
         m.table_name = ANY (public.phoenix_demo_purgeable_tables())
    FROM public.phoenix_demo_manifest m
   WHERE m.dataset_key = p_dataset_key
   GROUP BY m.table_name
   ORDER BY m.table_name;
END;
$summary$;

REVOKE ALL ON FUNCTION public.phoenix_demo_manifest_summary(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_demo_manifest_summary(text) TO authenticated;

-- ── E. Purge — dry-run by DEFAULT, manifest-owned rows only ─────────────────

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
  v_dry    boolean := COALESCE(p_dry_run, true);  -- NULL is treated as dry-run
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

  -- Anything the dataset owns in a NON-purgeable table is reported loudly
  -- rather than skipped, so a caller can never believe a purge was complete
  -- when it was not.
  RETURN QUERY
  SELECT m.table_name, count(*)::bigint, false
    FROM public.phoenix_demo_manifest m
   WHERE m.dataset_key = p_dataset_key
     AND NOT (m.table_name = ANY (v_tables))
   GROUP BY m.table_name;

  FOREACH v_table IN ARRAY v_tables LOOP
    IF to_regclass('public.' || quote_ident(v_table)) IS NULL THEN
      CONTINUE;  -- table not present in this schema version
    END IF;

    IF v_dry THEN
      EXECUTE format(
        'SELECT count(*)::bigint FROM public.%I t
          WHERE t.id IN (SELECT m.row_id FROM public.phoenix_demo_manifest m
                          WHERE m.dataset_key = $1 AND m.table_name = $2)',
        v_table
      ) INTO v_count USING p_dataset_key, v_table;
    ELSE
      -- The ONLY delete in this function. The subquery is the whole safety
      -- contract: a row absent from the manifest is unreachable here.
      EXECUTE format(
        'WITH deleted AS (
           DELETE FROM public.%I t
            WHERE t.id IN (SELECT m.row_id FROM public.phoenix_demo_manifest m
                            WHERE m.dataset_key = $1 AND m.table_name = $2)
           RETURNING 1)
         SELECT count(*)::bigint FROM deleted',
        v_table
      ) INTO v_count USING p_dataset_key, v_table;
    END IF;

    IF v_count > 0 THEN
      table_name := v_table;
      affected   := v_count;
      executed   := NOT v_dry;
      RETURN NEXT;
    END IF;
  END LOOP;

  -- Only once every owned row is gone does the manifest itself get cleared,
  -- so an interrupted purge stays resumable and never orphans ownership.
  IF NOT v_dry THEN
    DELETE FROM public.phoenix_demo_manifest m
     WHERE m.dataset_key = p_dataset_key
       AND m.table_name = ANY (v_tables);
  END IF;
END;
$purge$;

REVOKE ALL ON FUNCTION public.phoenix_demo_purge(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_demo_purge(text, boolean) TO authenticated;

DO $verify$
DECLARE
  v_count integer;
  v_src   text;
BEGIN
  IF to_regclass('public.phoenix_demo_manifest') IS NULL THEN
    RAISE EXCEPTION '140 VERIFY FAILED: phoenix_demo_manifest missing';
  END IF;

  FOR v_count IN SELECT 1 LOOP END LOOP;

  -- Dry-run must be the DEFAULT, not merely available.
  SELECT pg_get_functiondef(to_regprocedure('public.phoenix_demo_purge(text, boolean)')) INTO v_src;
  IF v_src IS NULL OR position('DEFAULT true' IN v_src) = 0 THEN
    RAISE EXCEPTION '140 VERIFY FAILED: phoenix_demo_purge must default p_dry_run to true';
  END IF;

  -- profiles / auth users / permission config must NOT be purgeable.
  IF 'profiles' = ANY (public.phoenix_demo_purgeable_tables())
     OR 'permission_keys' = ANY (public.phoenix_demo_purgeable_tables())
     OR 'role_permission_defaults' = ANY (public.phoenix_demo_purgeable_tables()) THEN
    RAISE EXCEPTION '140 VERIFY FAILED: a protected configuration table is listed as purgeable';
  END IF;

  -- authenticated must hold no direct write on the manifest.
  SELECT count(*) INTO v_count
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name = 'phoenix_demo_manifest'
     AND grantee = 'authenticated' AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE');
  IF v_count <> 0 THEN
    RAISE EXCEPTION '140 VERIFY FAILED: authenticated holds a direct write grant on the manifest';
  END IF;

  SELECT count(*) INTO v_count
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name = 'phoenix_demo_manifest' AND grantee = 'anon';
  IF v_count <> 0 THEN
    RAISE EXCEPTION '140 VERIFY FAILED: anon holds a grant on the manifest';
  END IF;

  RAISE NOTICE 'PHOENIX-DEMO-DATASET-MANIFEST-140: verified.';
END;
$verify$;

COMMIT;
