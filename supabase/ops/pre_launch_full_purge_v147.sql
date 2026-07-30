-- ============================================================================
-- FULL PRE-LAUNCH PURGE — v147, OWNER OPTION A  (A3-3B0N-R7)
--
-- Brings a Production database at migration ceiling EXACTLY 147 to:
--     CANONICAL_PRELAUNCH_EMPTY_BASELINE_V147
--   = clean schema 147
--   - EVERY row seeded by migration 004_phoenix_seed_demo_data.sql
--   + exactly one verified keeper account
--   + required RBAC reference data (permission_keys 130, role_permission_defaults 415)
--
-- The end state is DELIBERATELY EMPTIER than a fresh 001->147 replay. Migration
-- 004 seeds demonstration rows (Babil General Hospital, Al-Hilla Teaching
-- Hospital, their warehouses / outlets / catalog / availability / QR rows) at
-- fixed UUIDs ...0001 / ...0002. The owner has classified all of it as test data
-- and authorised its removal. It is NOT re-seeded afterwards, by decision.
-- Verified: none of migrations 148-153 reference those demo UUIDs.
--
-- THIS IS NOT A MIGRATION. It lives under supabase/ops/ so the migration runner
-- and the disposable rig never apply it automatically. The historical
-- pre_launch_runtime_reset.sql and the R5 pre_launch_runtime_reset_v147.sql are
-- both superseded for Option A and are left untouched as records.
--
-- HARD SAFETY CONTRACT
--   • Valid ONLY at ceiling 147. Any other ceiling aborts before any DELETE.
--   • Keeper is chosen BY EMAIL, never by age. It must resolve to exactly one
--     auth.users row and exactly one profile, or the run aborts.
--   • Requires a verified restorable backup, proven OUTSIDE this file.
--   • Storage must ALREADY be empty: deleting storage.objects rows in SQL does
--     NOT delete the underlying files, so a zero row count here would be a false
--     zero-state. Storage is purged out-of-band through the official API first.
--   • ONE transaction, SERIALIZABLE, advisory-locked. No DROP. No TRUNCATE.
--     No session_replication_role. No DISABLE TRIGGER ALL. No unbounded CASCADE.
--   • The ONLY immutability exception is the six named application triggers
--     below, disabled inside this transaction and provably restored before
--     COMMIT. A rollback restores data and triggers together, atomically.
--   • Any failed assertion RAISES, which rolls everything back. No retry, and no
--     exception handler anywhere that could turn a failure into a success.
--
-- HOW TO RUN — see docs/phoenix/prelaunch-full-purge-v147-runbook.md
-- ============================================================================

BEGIN;
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '5min';
SELECT pg_advisory_xact_lock(4771470147);

DO $purge$
DECLARE
  c_attestation constant text := 'I_ATTEST_PRODUCTION_FULL_PURGE_V147_OPTION_A';
  c_ceiling     constant int  := 147;
  c_keeper_email constant text := 'abdallahjawad2015@gmail.com';

  v_keeper   uuid;
  v_n        bigint;
  v_ceiling  int;
  v_tbl      text;
  v_missing  text;
  v_extra    text;
  v_email_after text;

  v_fn_before  text; v_fn_after  text;
  v_sig_before text; v_sig_after text;
  v_pol_before text; v_pol_after text;
  v_trg_before text; v_trg_after text;

  v_pk_before bigint; v_rpd_before bigint;
  v_pk_after  bigint; v_rpd_after  bigint;

  -- Every table purged to zero, FK-safe child-first. Derived topologically from
  -- the real 147 FK graph using ordering-FORCING constraints only
  -- (RESTRICT / NO ACTION); CASCADE and SET NULL edges do not constrain delete
  -- order, which is what makes the graph orderable at all.
  v_purge text[] := ARRAY[
    'audit_logs',
    'institution_item_status_reports',
    'inter_org_alert_events',
    'inter_org_alert_states',
    'inter_org_exchange_events',
    'inter_org_exchange_requests',
    'inventory_alerts',
    'inventory_signal_thresholds',
    'inventory_status_report_amendments',
    'inventory_status_report_lines',
    'inventory_status_reports',
    'inventory_transfer_suggestions',
    'item_availability_movements',
    'organization_status_contacts',
    'outlet_return_request_lines',
    'outlet_return_shipment_lines',
    'outlet_return_shipments',
    'outlet_stock_movements',
    'phoenix_demo_manifest',
    'phoenix_dispatch_line_requests',
    'phoenix_movement_dispense_context',
    'phoenix_movement_events',
    'phoenix_notification_reads',
    'phoenix_notifications',
    'phoenix_paper_references',
    'phoenix_report_snapshots',
    'phoenix_stock_correction_requests',
    'phoenix_variance_approval_policy',
    'phoenix_warehouse_correction_requests',
    'platform_broadcast_acknowledgements',
    'platform_broadcast_messages',
    'platform_broadcast_targets',
    'procurement_order_events',
    'procurement_returns',
    'profile_lifecycle_reservations',
    'profile_permission_overrides',
    'profile_scope_assignments',
    'qr_targets',
    'qr_tokens',
    'stocktake_count_lines',
    'stocktakes',
    'user_identity_history',
    'warehouse_dispatch_lines',
    'warehouse_dispatches',
    'warehouse_quarantine_stock_movements',
    'warehouse_return_request_lines',
    'warehouse_return_shipment_lines',
    'warehouse_return_shipments',
    'warehouse_transfer_lines',
    'warehouse_transfer_request_lines',
    'warehouse_transfers',
    'item_availability',
    'local_items',
    'outlet_return_requests',
    'outlet_stock',
    'procurement_receipt_lines',
    'procurement_receipts',
    'warehouse_quarantine_stock',
    'warehouse_return_requests',
    'warehouse_stock_movements',
    'warehouse_transfer_requests',
    'distribution_points',
    'procurement_order_lines',
    'procurement_orders',
    'procurement_suppliers',
    'warehouse_stock',
    'warehouse_supply_routes',
    'warehouses',
    'central_items',
    'organizations'
  ];

  -- Preserved outright (RBAC definitions).
  v_preserve text[] := ARRAY[
    'permission_keys',
    'role_permission_defaults'
  ];

  -- Every public table that must exist at 147.
  v_expected_public text[] := ARRAY[
    'audit_logs',
    'central_items',
    'distribution_points',
    'institution_item_status_reports',
    'inter_org_alert_events',
    'inter_org_alert_states',
    'inter_org_exchange_events',
    'inter_org_exchange_requests',
    'inventory_alerts',
    'inventory_signal_thresholds',
    'inventory_status_report_amendments',
    'inventory_status_report_lines',
    'inventory_status_reports',
    'inventory_transfer_suggestions',
    'item_availability',
    'item_availability_movements',
    'local_items',
    'organization_status_contacts',
    'organizations',
    'outlet_return_request_lines',
    'outlet_return_requests',
    'outlet_return_shipment_lines',
    'outlet_return_shipments',
    'outlet_stock',
    'outlet_stock_movements',
    'permission_keys',
    'phoenix_demo_manifest',
    'phoenix_dispatch_line_requests',
    'phoenix_movement_dispense_context',
    'phoenix_movement_events',
    'phoenix_notification_reads',
    'phoenix_notifications',
    'phoenix_paper_references',
    'phoenix_report_snapshots',
    'phoenix_stock_correction_requests',
    'phoenix_variance_approval_policy',
    'phoenix_warehouse_correction_requests',
    'platform_broadcast_acknowledgements',
    'platform_broadcast_messages',
    'platform_broadcast_targets',
    'procurement_order_events',
    'procurement_order_lines',
    'procurement_orders',
    'procurement_receipt_lines',
    'procurement_receipts',
    'procurement_returns',
    'procurement_suppliers',
    'profile_lifecycle_reservations',
    'profile_permission_overrides',
    'profile_scope_assignments',
    'profiles',
    'qr_targets',
    'qr_tokens',
    'role_permission_defaults',
    'stocktake_count_lines',
    'stocktakes',
    'user_identity_history',
    'warehouse_dispatch_lines',
    'warehouse_dispatches',
    'warehouse_quarantine_stock',
    'warehouse_quarantine_stock_movements',
    'warehouse_return_request_lines',
    'warehouse_return_requests',
    'warehouse_return_shipment_lines',
    'warehouse_return_shipments',
    'warehouse_stock',
    'warehouse_stock_movements',
    'warehouse_supply_routes',
    'warehouse_transfer_lines',
    'warehouse_transfer_request_lines',
    'warehouse_transfer_requests',
    'warehouse_transfers',
    'warehouses'
  ];
BEGIN
  ------------------------------------------------------------------ 1. gates
  IF current_setting('phoenix.purge_attestation', true) IS DISTINCT FROM c_attestation THEN
    RAISE EXCEPTION 'PURGE REFUSED: set phoenix.purge_attestation = %L in this session first.', c_attestation;
  END IF;

  IF to_regclass('supabase_migrations.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'PURGE REFUSED: supabase_migrations.schema_migrations not found — cannot prove the migration ceiling.';
  END IF;
  EXECUTE 'SELECT max(version::int) FROM supabase_migrations.schema_migrations' INTO v_ceiling;
  IF v_ceiling IS DISTINCT FROM c_ceiling THEN
    RAISE EXCEPTION 'PURGE REFUSED: migration ceiling is %, expected %.', v_ceiling, c_ceiling;
  END IF;
  EXECUTE 'SELECT count(*) FROM (SELECT version FROM supabase_migrations.schema_migrations GROUP BY version HAVING count(*)>1) d' INTO v_n;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'PURGE REFUSED: % duplicated migration version(s).', v_n;
  END IF;

  ------------------------------------------------- 2. manifest covers reality
  SELECT string_agg(t, ', ' ORDER BY t) INTO v_missing
  FROM unnest(v_expected_public) t WHERE to_regclass('public.'||t) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'PURGE REFUSED: manifest table(s) absent: %', v_missing;
  END IF;

  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO v_extra
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relkind IN ('r','p') AND n.nspname='public'
    AND NOT (c.relname = ANY (v_expected_public));
  IF v_extra IS NOT NULL THEN
    RAISE EXCEPTION 'PURGE REFUSED: unclassified public table(s): % — update the manifest first.', v_extra;
  END IF;

  ------------------------------------------------------ 3. storage must be 0
  IF to_regclass('storage.objects') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM storage.objects' INTO v_n;
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'PURGE REFUSED: storage.objects has % row(s). Purge Storage through the official API first — this transaction cannot delete the underlying files and must not report a false zero-state.', v_n;
    END IF;
  END IF;

  ----------------------------------------------------------- 4. RBAC by value
  SELECT count(*) INTO v_pk_before  FROM public.permission_keys;
  SELECT count(*) INTO v_rpd_before FROM public.role_permission_defaults;
  IF v_pk_before  <> 130 THEN RAISE EXCEPTION 'PURGE REFUSED: permission_keys = %, expected 130.', v_pk_before; END IF;
  IF v_rpd_before <> 415 THEN RAISE EXCEPTION 'PURGE REFUSED: role_permission_defaults = %, expected 415.', v_rpd_before; END IF;

  --------------------------------------------------- 5. keeper, BY EMAIL only
  SELECT count(*) INTO v_n FROM auth.users WHERE lower(email) = lower(c_keeper_email);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'PURGE REFUSED: keeper email resolves to % auth.users row(s), expected exactly 1.', v_n;
  END IF;
  SELECT id INTO v_keeper FROM auth.users WHERE lower(email) = lower(c_keeper_email);

  SELECT count(*) INTO v_n FROM public.profiles WHERE id = v_keeper;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'PURGE REFUSED: keeper has % profile row(s), expected exactly 1.', v_n;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_keeper AND role='super_admin' AND status='active') THEN
    RAISE EXCEPTION 'PURGE REFUSED: keeper profile is not an active super_admin.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = v_keeper AND organization_id IS NOT NULL) THEN
    RAISE EXCEPTION 'PURGE REFUSED: keeper must be global (organization_id IS NULL) — it is scoped to an organization that this purge deletes.';
  END IF;

  RAISE NOTICE 'v147 Option-A purge: keeper resolved by email, profile verified global super_admin.';

  ------------------------------------------- 6. fingerprints (self-comparison)
  SELECT md5(coalesce(string_agg(d, E'\n' ORDER BY d),'')) INTO v_fn_before
  FROM (SELECT pg_get_functiondef(p.oid) d FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname IN ('public','auth') AND p.prokind='f') s;
  SELECT md5(coalesce(string_agg(d, E'\n' ORDER BY d),'')) INTO v_sig_before
  FROM (SELECT n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'||p.prosecdef::text d
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','auth')) s;
  SELECT md5(coalesce(string_agg(d, E'\n' ORDER BY d),'')) INTO v_pol_before
  FROM (SELECT schemaname||'.'||tablename||'.'||policyname||'.'||cmd||'.'||coalesce(qual,'')||'.'||coalesce(with_check,'') d
        FROM pg_policies WHERE schemaname IN ('public','auth')) s;
  SELECT md5(coalesce(string_agg(d, E'\n' ORDER BY d),'')) INTO v_trg_before
  FROM (SELECT n.nspname||'.'||c.relname||'.'||t.tgname||'.'||pg_get_triggerdef(t.oid) d
        FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE NOT t.tgisinternal AND n.nspname IN ('public','auth')) s;

  ------------------------------- 7. immutability exception — verify allowlist
  CREATE TEMP TABLE _purge_trg (tbl text, tgname text, fname text, def text, tgenabled "char") ON COMMIT DROP;
  INSERT INTO _purge_trg (tbl, tgname, fname)
  VALUES
      ('item_availability','trg_guard_availability_source_kind','phoenix_guard_availability_source_kind'),
      ('phoenix_report_snapshots','phoenix_report_snapshots_forbid_mutation','phoenix_forbid_report_snapshot_mutation'),
      ('procurement_order_events','procurement_order_events_immutable','phoenix_procurement_forbid_mutation'),
      ('procurement_receipt_lines','procurement_receipt_lines_immutable','phoenix_procurement_forbid_mutation'),
      ('procurement_receipts','procurement_receipts_immutable','phoenix_procurement_forbid_mutation'),
      ('procurement_returns','procurement_returns_immutable','phoenix_procurement_forbid_mutation');

  -- Each allowlisted trigger must exist, be a USER trigger (not internal, not
  -- FK/constraint-backed), and be backed by the exact function named.
  FOR v_tbl, v_missing IN SELECT tbl, tgname FROM _purge_trg LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE n.nspname='public' AND c.relname=v_tbl AND t.tgname=v_missing
        AND NOT t.tgisinternal AND t.tgconstraint = 0
        AND p.proname = (SELECT fname FROM _purge_trg WHERE tbl=v_tbl AND tgname=v_missing)
    ) THEN
      RAISE EXCEPTION 'PURGE REFUSED: allowlisted trigger %.% is missing, internal, FK-backed, or backed by an unexpected function.', v_tbl, v_missing;
    END IF;
  END LOOP;

  -- No OTHER user trigger may block DELETE on a purge table: an unknown guard
  -- would either abort mid-purge or silently alter behaviour.
  SELECT string_agg(c.relname||'.'||t.tgname, ', ' ORDER BY c.relname||'.'||t.tgname) INTO v_extra
  FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE NOT t.tgisinternal AND t.tgconstraint = 0 AND n.nspname='public'
    AND (t.tgtype & 8) <> 0 AND (t.tgtype & 2) <> 0          -- BEFORE ... DELETE
    AND c.relname = ANY (v_purge)
    AND NOT EXISTS (SELECT 1 FROM _purge_trg b WHERE b.tbl=c.relname AND b.tgname=t.tgname);
  IF v_extra IS NOT NULL THEN
    RAISE EXCEPTION 'PURGE REFUSED: unexpected BEFORE-DELETE trigger(s) outside the audited allowlist: %', v_extra;
  END IF;

  -- Capture definitions + enabled state so restoration is provable.
  UPDATE _purge_trg b
     SET def = pg_get_triggerdef(t.oid), tgenabled = t.tgenabled
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relname=b.tbl AND t.tgname=b.tgname;

  SELECT count(*) INTO v_n FROM _purge_trg WHERE def IS NULL;
  IF v_n <> 0 THEN RAISE EXCEPTION 'PURGE REFUSED: could not capture % trigger definition(s).', v_n; END IF;

  ALTER TABLE public.item_availability DISABLE TRIGGER trg_guard_availability_source_kind;
  ALTER TABLE public.phoenix_report_snapshots DISABLE TRIGGER phoenix_report_snapshots_forbid_mutation;
  ALTER TABLE public.procurement_order_events DISABLE TRIGGER procurement_order_events_immutable;
  ALTER TABLE public.procurement_receipt_lines DISABLE TRIGGER procurement_receipt_lines_immutable;
  ALTER TABLE public.procurement_receipts DISABLE TRIGGER procurement_receipts_immutable;
  ALTER TABLE public.procurement_returns DISABLE TRIGGER procurement_returns_immutable;

  ------------------------------------------------------- 8. purge, child-first
  FOREACH v_tbl IN ARRAY v_purge LOOP
    EXECUTE format('DELETE FROM public.%I', v_tbl);
  END LOOP;

  ------------------------------------------------- 9. identity, keeper-scoped
  DELETE FROM public.profiles WHERE id <> v_keeper;
  IF to_regclass('auth.sessions')        IS NOT NULL THEN EXECUTE format('DELETE FROM auth.sessions        WHERE user_id <> %L', v_keeper); END IF;
  IF to_regclass('auth.refresh_tokens')  IS NOT NULL THEN EXECUTE format('DELETE FROM auth.refresh_tokens  WHERE user_id <> %L', v_keeper); END IF;
  IF to_regclass('auth.identities')      IS NOT NULL THEN EXECUTE format('DELETE FROM auth.identities      WHERE user_id <> %L', v_keeper); END IF;
  IF to_regclass('auth.mfa_factors')     IS NOT NULL THEN EXECUTE format('DELETE FROM auth.mfa_factors     WHERE user_id <> %L', v_keeper); END IF;
  IF to_regclass('auth.one_time_tokens') IS NOT NULL THEN EXECUTE format('DELETE FROM auth.one_time_tokens WHERE user_id <> %L', v_keeper); END IF;
  DELETE FROM auth.users WHERE id <> v_keeper;

  ------------------------------------------------ 10. restore triggers FIRST
  -- Restored BEFORE postconditions so the fingerprint comparison below is a
  -- genuine proof of restoration rather than a check performed while disabled.
  ALTER TABLE public.item_availability ENABLE TRIGGER trg_guard_availability_source_kind;
  ALTER TABLE public.phoenix_report_snapshots ENABLE TRIGGER phoenix_report_snapshots_forbid_mutation;
  ALTER TABLE public.procurement_order_events ENABLE TRIGGER procurement_order_events_immutable;
  ALTER TABLE public.procurement_receipt_lines ENABLE TRIGGER procurement_receipt_lines_immutable;
  ALTER TABLE public.procurement_receipts ENABLE TRIGGER procurement_receipts_immutable;
  ALTER TABLE public.procurement_returns ENABLE TRIGGER procurement_returns_immutable;

  SELECT string_agg(b.tbl||'.'||b.tgname, ', ') INTO v_extra
  FROM _purge_trg b
  JOIN pg_trigger t ON t.tgname = b.tgname
  JOIN pg_class c ON c.oid = t.tgrelid AND c.relname = b.tbl
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname='public'
  WHERE pg_get_triggerdef(t.oid) IS DISTINCT FROM b.def
     OR t.tgenabled IS DISTINCT FROM b.tgenabled;
  IF v_extra IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: trigger(s) not restored to their exact prior definition/enabled state: %', v_extra;
  END IF;

  ------------------------------------------------------- 11. postconditions
  SELECT count(*) INTO v_n FROM auth.users;
  IF v_n <> 1 THEN RAISE EXCEPTION 'POSTCONDITION FAILED: expected exactly 1 auth account, found %.', v_n; END IF;
  SELECT count(*) INTO v_n FROM auth.users WHERE id = v_keeper;
  IF v_n <> 1 THEN RAISE EXCEPTION 'POSTCONDITION FAILED: the surviving auth account is not the keeper.'; END IF;

  SELECT email INTO v_email_after FROM auth.users WHERE id = v_keeper;
  IF lower(v_email_after) IS DISTINCT FROM lower(c_keeper_email) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: keeper email changed.';
  END IF;

  SELECT count(*) INTO v_n FROM public.profiles;
  IF v_n <> 1 THEN RAISE EXCEPTION 'POSTCONDITION FAILED: expected exactly 1 profile, found %.', v_n; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles
                  WHERE id=v_keeper AND role='super_admin' AND status='active' AND organization_id IS NULL) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: keeper profile is not an active, global super_admin.';
  END IF;
  SELECT count(*) INTO v_n FROM public.profiles WHERE role='super_admin' AND status='active';
  IF v_n <> 1 THEN RAISE EXCEPTION 'POSTCONDITION FAILED: expected exactly 1 active super_admin, found %.', v_n; END IF;

  -- Every purge table is empty — including the ten the 090-era plan missed and
  -- every row migration 004 seeded.
  FOREACH v_tbl IN ARRAY v_purge LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', v_tbl) INTO v_n;
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: purge table % still has % row(s).', v_tbl, v_n;
    END IF;
  END LOOP;

  IF to_regclass('storage.objects') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM storage.objects' INTO v_n;
    IF v_n <> 0 THEN RAISE EXCEPTION 'POSTCONDITION FAILED: storage.objects is not empty.'; END IF;
  END IF;

  SELECT count(*) INTO v_n
  FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE con.contype='f' AND NOT con.convalidated AND n.nspname IN ('public','auth');
  IF v_n <> 0 THEN RAISE EXCEPTION 'POSTCONDITION FAILED: % FK constraint(s) not validated.', v_n; END IF;

  SELECT count(*) INTO v_pk_after  FROM public.permission_keys;
  SELECT count(*) INTO v_rpd_after FROM public.role_permission_defaults;
  IF v_pk_after <> 130 OR v_rpd_after <> 415 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: RBAC drifted (permission_keys=%, role_permission_defaults=%).', v_pk_after, v_rpd_after;
  END IF;

  EXECUTE 'SELECT max(version::int) FROM supabase_migrations.schema_migrations' INTO v_ceiling;
  IF v_ceiling IS DISTINCT FROM c_ceiling THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: migration ceiling changed to %.', v_ceiling;
  END IF;

  SELECT md5(coalesce(string_agg(d, E'\n' ORDER BY d),'')) INTO v_fn_after
  FROM (SELECT pg_get_functiondef(p.oid) d FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname IN ('public','auth') AND p.prokind='f') s;
  SELECT md5(coalesce(string_agg(d, E'\n' ORDER BY d),'')) INTO v_sig_after
  FROM (SELECT n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'||p.prosecdef::text d
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','auth')) s;
  SELECT md5(coalesce(string_agg(d, E'\n' ORDER BY d),'')) INTO v_pol_after
  FROM (SELECT schemaname||'.'||tablename||'.'||policyname||'.'||cmd||'.'||coalesce(qual,'')||'.'||coalesce(with_check,'') d
        FROM pg_policies WHERE schemaname IN ('public','auth')) s;
  SELECT md5(coalesce(string_agg(d, E'\n' ORDER BY d),'')) INTO v_trg_after
  FROM (SELECT n.nspname||'.'||c.relname||'.'||t.tgname||'.'||pg_get_triggerdef(t.oid) d
        FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE NOT t.tgisinternal AND n.nspname IN ('public','auth')) s;

  IF v_fn_after  IS DISTINCT FROM v_fn_before  THEN RAISE EXCEPTION 'POSTCONDITION FAILED: function definitions changed.'; END IF;
  IF v_sig_after IS DISTINCT FROM v_sig_before THEN RAISE EXCEPTION 'POSTCONDITION FAILED: function signatures changed.'; END IF;
  IF v_pol_after IS DISTINCT FROM v_pol_before THEN RAISE EXCEPTION 'POSTCONDITION FAILED: RLS policies changed.'; END IF;
  IF v_trg_after IS DISTINCT FROM v_trg_before THEN RAISE EXCEPTION 'POSTCONDITION FAILED: trigger definitions changed.'; END IF;

  RAISE NOTICE 'CANONICAL_PRELAUNCH_EMPTY_BASELINE_V147 reached: % tables purged, 1 keeper, RBAC 130/415, ceiling 147.',
    array_length(v_purge, 1);
END
$purge$;

COMMIT;
