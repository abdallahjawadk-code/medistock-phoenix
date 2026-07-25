-- ============================================================================
-- PRE-LAUNCH RUNTIME DATA RESET  (PHOENIX-FIVE-ROLE-CUTOVER §1a)
--
-- Purpose: bring a *pre-launch* Phoenix database to a single-super_admin, zero
-- runtime-data baseline BEFORE the five-role cutover (migration 091), WITHOUT
-- touching schema, migrations, functions, RLS, permission/role definitions, or
-- the approved organizations / warehouses / outlets / catalog configuration.
--
-- THIS IS NOT A MIGRATION. It lives under supabase/ops/ precisely so the
-- migration runner and the disposable rig NEVER apply it automatically. It is
-- run by hand, once, only after an explicit attestation.
--
-- HARD SAFETY CONTRACT
--   • Disposable rig ONLY for now. Do NOT run on production until a read-only
--     inventory report, a verified backup, and explicit final cutover approval
--     exist. (This file's own guard cannot see those — a human attests them.)
--   • One transaction. No broad TRUNCATE ... CASCADE. Explicit allowlist +
--     FK-safe (child → parent) delete order.
--   • Never edits schema_migrations. Never drops a schema object.
--   • Preserves: schema/DDL, functions, RLS, permission_keys,
--     role_permission_defaults, and organizations / warehouses /
--     distribution_points / central_items / local_items / warehouse_supply_routes.
--   • Keeps exactly the single OLDEST active super_admin (created_at, then id).
--   • Resets only operational-document sequences whose owning tables are proven
--     empty afterwards.
--
-- HOW TO RUN (rig / attested):
--   psql "$PHOENIX_RIG_PG_DB" \
--     -v ON_ERROR_STOP=1 \
--     -c "SET phoenix.reset_attestation = 'I_ATTEST_PRELAUNCH_RESET_DISPOSABLE';" \
--     -f supabase/ops/pre_launch_runtime_reset.sql
--   (the SET and the -f must share one session; see the rig test which wraps
--    both in a single connection.)
-- ============================================================================

BEGIN;

DO $reset$
DECLARE
  -- The one identity that survives.
  v_survivor        uuid;
  v_survivor_email  text;

  -- Config baselines proven unchanged at the end.
  v_org_before      bigint;
  v_wh_before       bigint;
  v_dp_before       bigint;
  v_ci_before       bigint;
  v_pk_before       bigint;
  v_rpd_before      bigint;

  v_org_after       bigint;
  v_wh_after        bigint;
  v_dp_after        bigint;
  v_ci_after        bigint;
  v_pk_after        bigint;
  v_rpd_after       bigint;

  -- The explicit runtime allowlist, in FK-safe child → parent order. Each entry
  -- is deleted only if the table exists (to_regclass), so this same file is
  -- valid at migration 090 today and after later migrations add e.g.
  -- notifications / stocktakes / corrections. THIS ARRAY *IS* THE ALLOWLIST:
  -- anything not listed here is preserved by construction.
  v_runtime_tables text[] := ARRAY[
    -- ── leaf children: lines / events / movements / joins ──────────────────
    'warehouse_transfer_lines',
    'warehouse_transfer_request_lines',
    'warehouse_dispatch_lines',
    'warehouse_return_request_lines',
    'warehouse_return_shipment_lines',
    'outlet_return_request_lines',
    'outlet_return_shipment_lines',
    'procurement_order_lines',
    'procurement_order_events',
    'procurement_receipt_lines',
    'warehouse_stock_movements',
    'warehouse_quarantine_stock_movements',
    'outlet_stock_movements',
    'item_availability_movements',
    'phoenix_movement_events',
    'inter_org_exchange_events',
    'inter_org_alert_events',
    'platform_broadcast_acknowledgements',
    'platform_broadcast_targets',
    'inventory_alerts',
    'inventory_transfer_suggestions',
    'institution_item_status_reports',
    -- future runtime tables (Phase 2) — guarded, harmless if absent:
    'notification_reads',
    'notifications',
    'stocktake_count_lines',
    'stocktake_counts',
    'stocktakes',
    'stock_corrections',
    'inventory_status_report_amendments',
    'inventory_status_report_lines',
    'inventory_status_reports',
    -- ── shipment / receipt / return headers (reference requests/orders) ────
    'warehouse_return_shipments',
    'outlet_return_shipments',
    'procurement_receipts',
    'procurement_returns',
    -- ── request / order / transfer / dispatch headers ─────────────────────
    'warehouse_transfers',
    'warehouse_transfer_requests',
    'warehouse_dispatches',
    'warehouse_return_requests',
    'outlet_return_requests',
    'procurement_orders',
    'inter_org_exchange_requests',
    'inter_org_alert_states',
    'platform_broadcast_messages',
    -- ── stock / availability / thresholds / contacts / suppliers / qr ─────
    'warehouse_stock',
    'warehouse_quarantine_stock',
    'outlet_stock',
    'item_availability',
    'inventory_signal_thresholds',
    'organization_status_contacts',
    'qr_tokens',
    'qr_targets',
    'procurement_suppliers',
    -- ── profile-linked runtime (NOT profiles/auth.users themselves) ───────
    'profile_scope_assignments',
    'profile_permission_overrides',
    'user_identity_history',
    'audit_logs'
  ];

  -- Operational-document sequences reset only when their owning table is empty.
  v_doc_sequences text[] := ARRAY[
    'warehouse_receipt_number_seq'
  ];

  v_tbl  text;
  v_seq  text;
  v_left bigint;
BEGIN
  -- 1. Attestation — refuse to run without an explicit, deliberate token.
  IF current_setting('phoenix.reset_attestation', true)
       IS DISTINCT FROM 'I_ATTEST_PRELAUNCH_RESET_DISPOSABLE' THEN
    RAISE EXCEPTION
      'PRE-LAUNCH RESET REFUSED: set phoenix.reset_attestation = '
      '''I_ATTEST_PRELAUNCH_RESET_DISPOSABLE'' in this session first.';
  END IF;

  -- 2. Pick the survivor: the OLDEST active super_admin (created_at, then id).
  SELECT p.id INTO v_survivor
  FROM public.profiles p
  WHERE p.role = 'super_admin' AND p.status = 'active'
  ORDER BY p.created_at ASC, p.id ASC
  LIMIT 1;

  IF v_survivor IS NULL THEN
    RAISE EXCEPTION 'PRE-LAUNCH RESET ABORTED: no active super_admin to keep.';
  END IF;

  -- 3. The survivor must have a usable auth identity. A real GoTrue login is an
  --    operational pre-step (documented above); here we assert the auth row
  --    exists so we never delete our way into an unreachable platform.
  SELECT u.email INTO v_survivor_email FROM auth.users u WHERE u.id = v_survivor;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'PRE-LAUNCH RESET ABORTED: survivor super_admin % has no auth.users row.', v_survivor;
  END IF;

  RAISE NOTICE 'Pre-launch reset: keeping super_admin % (%).', v_survivor, COALESCE(v_survivor_email, '<no-email>');

  -- 4. Config baselines (proven unchanged at the end).
  SELECT count(*) INTO v_org_before FROM public.organizations;
  SELECT count(*) INTO v_wh_before  FROM public.warehouses;
  SELECT count(*) INTO v_dp_before  FROM public.distribution_points;
  SELECT count(*) INTO v_ci_before  FROM public.central_items;
  SELECT count(*) INTO v_pk_before  FROM public.permission_keys;
  SELECT count(*) INTO v_rpd_before FROM public.role_permission_defaults;

  -- 5. Wipe every runtime table in FK-safe order (skip any that don't exist).
  FOREACH v_tbl IN ARRAY v_runtime_tables LOOP
    IF to_regclass('public.' || v_tbl) IS NOT NULL THEN
      EXECUTE format('DELETE FROM public.%I', v_tbl);
    END IF;
  END LOOP;

  -- 6. Profiles: keep only the survivor. (profiles.id → auth.users ON DELETE
  --    CASCADE, but we delete profiles explicitly first so the allowlist is
  --    honest and FK-safe rather than relying on cascade.)
  DELETE FROM public.profiles WHERE id <> v_survivor;

  -- 7. Auth sessions / refresh tokens / identities for everyone but the
  --    survivor — guarded, because the disposable rig's auth shim has only
  --    auth.users while production has the full GoTrue surface.
  IF to_regclass('auth.sessions')       IS NOT NULL THEN
    EXECUTE format('DELETE FROM auth.sessions       WHERE user_id <> %L', v_survivor);
  END IF;
  IF to_regclass('auth.refresh_tokens') IS NOT NULL THEN
    EXECUTE format('DELETE FROM auth.refresh_tokens WHERE user_id <> %L', v_survivor);
  END IF;
  IF to_regclass('auth.identities')     IS NOT NULL THEN
    EXECUTE format('DELETE FROM auth.identities     WHERE user_id <> %L', v_survivor);
  END IF;
  IF to_regclass('auth.mfa_factors')    IS NOT NULL THEN
    EXECUTE format('DELETE FROM auth.mfa_factors    WHERE user_id <> %L', v_survivor);
  END IF;
  IF to_regclass('auth.one_time_tokens') IS NOT NULL THEN
    EXECUTE format('DELETE FROM auth.one_time_tokens WHERE user_id <> %L', v_survivor);
  END IF;

  -- 8. Auth accounts: keep only the survivor. Config created_by/actor pointers
  --    are ON DELETE SET NULL, so preserved config rows survive (a stale
  --    creator pointer nulls out — the schema's own designed behavior).
  DELETE FROM auth.users WHERE id <> v_survivor;

  -- 9. Reset operational-document sequences ONLY where the owning table is now
  --    empty (proven), so numbering restarts cleanly at launch.
  FOREACH v_seq IN ARRAY v_doc_sequences LOOP
    IF to_regclass('public.' || v_seq) IS NOT NULL THEN
      -- warehouse_receipt_number_seq numbers warehouse_stock_movements.official_number
      IF to_regclass('public.warehouse_stock_movements') IS NOT NULL THEN
        EXECUTE 'SELECT count(*) FROM public.warehouse_stock_movements' INTO v_left;
        IF v_left = 0 THEN
          EXECUTE format('ALTER SEQUENCE public.%I RESTART', v_seq);
        END IF;
      END IF;
    END IF;
  END LOOP;

  -- 10. Postconditions — fail the whole transaction if any is not met.
  -- 10a. exactly one profile, and it is the survivor super_admin.
  PERFORM 1;
  IF (SELECT count(*) FROM public.profiles) <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected exactly 1 profile, found %.',
      (SELECT count(*) FROM public.profiles);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = v_survivor AND role = 'super_admin' AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the surviving profile is not an active super_admin.';
  END IF;

  -- 10b. exactly one auth account (the survivor).
  IF (SELECT count(*) FROM auth.users) <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected exactly 1 auth account, found %.',
      (SELECT count(*) FROM auth.users);
  END IF;

  -- 10c. zero legacy / removed roles or scopes remain.
  IF EXISTS (
    SELECT 1 FROM public.profiles
    WHERE role NOT IN ('super_admin','central_warehouse_manager',
                       'institution_admin','warehouse_officer','outlet_officer')
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: a non-canonical role remains in profiles.';
  END IF;
  IF to_regclass('public.profile_scope_assignments') IS NOT NULL
     AND (SELECT count(*) FROM public.profile_scope_assignments) <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: scope assignments remain.';
  END IF;

  -- 10d. every runtime table is empty.
  FOREACH v_tbl IN ARRAY v_runtime_tables LOOP
    IF to_regclass('public.' || v_tbl) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM public.%I', v_tbl) INTO v_left;
      IF v_left <> 0 THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED: runtime table % still has % row(s).', v_tbl, v_left;
      END IF;
    END IF;
  END LOOP;

  -- 10e. config/reference is unchanged (row counts identical).
  SELECT count(*) INTO v_org_after FROM public.organizations;
  SELECT count(*) INTO v_wh_after  FROM public.warehouses;
  SELECT count(*) INTO v_dp_after  FROM public.distribution_points;
  SELECT count(*) INTO v_ci_after  FROM public.central_items;
  SELECT count(*) INTO v_pk_after  FROM public.permission_keys;
  SELECT count(*) INTO v_rpd_after FROM public.role_permission_defaults;
  IF (v_org_before, v_wh_before, v_dp_before, v_ci_before, v_pk_before, v_rpd_before)
     IS DISTINCT FROM
     (v_org_after,  v_wh_after,  v_dp_after,  v_ci_after,  v_pk_after,  v_rpd_after) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: preserved config/reference row counts changed.';
  END IF;

  RAISE NOTICE 'Pre-launch reset complete: 1 super_admin, 0 runtime rows, config preserved (orgs=%, warehouses=%, outlets=%).',
    v_org_after, v_wh_after, v_dp_after;
END
$reset$;

COMMIT;
