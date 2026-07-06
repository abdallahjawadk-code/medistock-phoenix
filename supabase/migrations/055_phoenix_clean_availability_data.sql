-- =============================================================================
-- MediStock Phoenix V2 — Migration 055: phoenix_clean_availability_data RPC
-- =============================================================================
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply via Supabase Dashboard → SQL Editor after reading this file in full,
-- and only after a verified export/backup of item_availability,
-- item_availability_movements, inter_org_alert_states/events, and
-- inter_org_exchange_requests/events has been taken.
--
-- Prerequisites: Migrations 001–054 must already be applied.
--
-- Task: PHASE3-DEEP-CLEAN-AVAILABILITY-DATA-A (physical-delete revision)
--
-- -----------------------------------------------------------------------------
-- GOAL
-- -----------------------------------------------------------------------------
--   A Super Admin-only, dry-run-first, single-typed-confirmation maintenance
--   RPC that PHYSICALLY DELETES every entered outlet availability material
--   (item_availability) together with its movement history
--   (item_availability_movements) and every operational inter-org
--   alert/exchange row that transitively references either table — while
--   leaving all system/structural data completely untouched.
--
--   This supersedes an earlier zero-reset-only design for this same
--   migration number: the user explicitly requires physical deletion of
--   item_availability rows, not merely zeroing quantity/condition. Reusing
--   migration number 055 is intentional (no other migration file exists at
--   this number; the earlier zero-reset draft was never applied to any
--   database).
--
-- -----------------------------------------------------------------------------
-- DELETE ORDER (FK-safe — verified against migrations 033/038/040)
-- -----------------------------------------------------------------------------
--   1. inter_org_exchange_events     — exchange_request_id REFERENCES
--                                       inter_org_exchange_requests(id)
--                                       ON DELETE RESTRICT (migration 040)
--   2. inter_org_exchange_requests   — source_item_availability_id /
--                                       target_item_availability_id REFERENCE
--                                       item_availability(id) ON DELETE
--                                       RESTRICT (migration 040)
--   3. inter_org_alert_events        — alert_state_id REFERENCES
--                                       inter_org_alert_states(id)
--                                       ON DELETE RESTRICT (migration 038)
--   4. inter_org_alert_states        — source_item_availability_id /
--                                       target_item_availability_id REFERENCE
--                                       item_availability(id) ON DELETE
--                                       RESTRICT (migration 038)
--   5. item_availability_movements   — item_availability_id REFERENCES
--                                       item_availability(id) ON DELETE
--                                       RESTRICT (migration 033)
--   6. item_availability              — the root operational table.
--
--   Each step's child rows are deleted before the table(s) they reference,
--   so no ON DELETE RESTRICT constraint is ever hit. Only plain DELETE
--   statements are used — never TRUNCATE (TRUNCATE would require elevated
--   table-level privileges this SECURITY DEFINER function does not need, and
--   would not let a future revision add a WHERE-scoped variant without a
--   full rewrite).
--
-- -----------------------------------------------------------------------------
-- TABLES NEVER TOUCHED
-- -----------------------------------------------------------------------------
--   organizations, warehouses, distribution_points, local_items,
--   central_items, profiles, permission_keys, role_permission_defaults,
--   profile_permission_overrides, qr_targets, qr_tokens,
--   organization_status_contacts, user_identity_history, auth.users,
--   audit_logs (only ever INSERTed into, never deleted from),
--   institution_item_status_reports (migration 006 — its only FK is
--   item_id → central_items(id) ON DELETE SET NULL; it has no reference to
--   item_availability at all, so it is neither a blocker nor in scope here).
--
--   Effect after execution: QR pages still resolve and open (qr_tokens/
--   qr_targets untouched) but list no available materials (item_availability
--   is empty). Status Center / dashboards / Movement History show empty/zero
--   states (their source tables are empty, not broken). Institutions,
--   outlets, users, and permissions are all fully intact.
--
-- -----------------------------------------------------------------------------
-- RPC CONTRACT
-- -----------------------------------------------------------------------------
--   public.phoenix_clean_availability_data(
--     p_dry_run      boolean DEFAULT true,
--     p_confirmation text    DEFAULT NULL
--   ) RETURNS jsonb
--
--   Auth: SECURITY DEFINER, SET search_path = public. GRANT EXECUTE is to
--   authenticated only (no anon/PUBLIC). The function ALSO performs its own
--   internal super_admin role check by reading profiles.role for auth.uid() —
--   the frontend gating (UI renders null for non-super users) is UX only and
--   is never the real security boundary.
--
--   Dry run (p_dry_run = true, the default): fully read-only. No UPDATE, no
--   DELETE, no audit_logs INSERT. Returns exact per-table counts + strategy +
--   confirmationRequired + a warning that availability materials and
--   movement/alert/exchange history will be permanently deleted.
--
--   Execute (p_dry_run = false): requires p_confirmation to exactly equal
--   'DEEP CLEAN AVAILABILITY' (case- and whitespace-sensitive, IS DISTINCT
--   FROM comparison). Any other value (including NULL) returns ok=false,
--   error='INVALID_CONFIRMATION' — no delete happens. On success: the six
--   DELETEs above run in order, then a single audit_logs row is inserted
--   (action='availability_data_deep_cleaned', entity_type='system') recording
--   before/after counts and rows deleted per table.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.phoenix_clean_availability_data(
  p_dry_run      boolean DEFAULT true,
  p_confirmation text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_role     text;
  v_required text := 'DEEP CLEAN AVAILABILITY';

  v_exchange_events_total   bigint;
  v_exchange_requests_total bigint;
  v_alert_events_total      bigint;
  v_alert_states_total      bigint;
  v_movements_total         bigint;
  v_availability_total      bigint;

  v_exchange_events_deleted   bigint;
  v_exchange_requests_deleted bigint;
  v_alert_events_deleted      bigint;
  v_alert_states_deleted      bigint;
  v_movements_deleted         bigint;
  v_availability_deleted      bigint;

  v_counts_before jsonb;
  v_counts_after  jsonb;
  v_rows_deleted  jsonb;
BEGIN
  -- 1. Auth required.
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED');
  END IF;

  -- 2. Explicit super_admin check — the real security boundary, independent
  --    of whatever the frontend chooses to render.
  SELECT role INTO v_role FROM public.profiles WHERE id = v_actor;

  IF v_role IS DISTINCT FROM 'super_admin' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_ROLE');
  END IF;

  -- 3. Compute exact counts (used by both the dry-run response and the
  --    execute response's countsBefore/audit payload).
  SELECT count(*) INTO v_exchange_events_total   FROM public.inter_org_exchange_events;
  SELECT count(*) INTO v_exchange_requests_total FROM public.inter_org_exchange_requests;
  SELECT count(*) INTO v_alert_events_total      FROM public.inter_org_alert_events;
  SELECT count(*) INTO v_alert_states_total      FROM public.inter_org_alert_states;
  SELECT count(*) INTO v_movements_total         FROM public.item_availability_movements;
  SELECT count(*) INTO v_availability_total      FROM public.item_availability;

  v_counts_before := jsonb_build_object(
    'inter_org_exchange_events',   v_exchange_events_total,
    'inter_org_exchange_requests', v_exchange_requests_total,
    'inter_org_alert_events',      v_alert_events_total,
    'inter_org_alert_states',      v_alert_states_total,
    'item_availability_movements', v_movements_total,
    'item_availability',           v_availability_total
  );

  -- 4. Dry run: read-only, returns exact counts and required confirmation
  --    phrase. No UPDATE, no DELETE, no audit_logs INSERT on this branch.
  IF p_dry_run THEN
    RETURN jsonb_build_object(
      'ok', true,
      'dryRun', true,
      'strategy', 'physical_delete_operational_availability',
      'confirmationRequired', v_required,
      'warning', 'Entered outlet availability materials, movement history, and any linked inter-org alert/exchange rows will be permanently and physically deleted and cannot be recovered. Institutions, outlets, QR links, users, permissions, and material master data (local_items/central_items) are never touched.',
      'counts', v_counts_before,
      'protectedTables', jsonb_build_array(
        'organizations', 'warehouses', 'distribution_points', 'local_items',
        'central_items', 'profiles', 'permission_keys', 'role_permission_defaults',
        'profile_permission_overrides', 'qr_targets', 'qr_tokens',
        'organization_status_contacts', 'user_identity_history', 'auth.users',
        'audit_logs', 'institution_item_status_reports'
      )
    );
  END IF;

  -- 5. Execute: require the exact confirmation phrase.
  IF p_confirmation IS DISTINCT FROM v_required THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_CONFIRMATION');
  END IF;

  -- 6. Physical DELETE in strict FK-safe order (child rows before the
  --    tables/rows they reference). DELETE only — never TRUNCATE. Never
  --    touches any protected table listed in the header.
  DELETE FROM public.inter_org_exchange_events;
  GET DIAGNOSTICS v_exchange_events_deleted = ROW_COUNT;

  DELETE FROM public.inter_org_exchange_requests;
  GET DIAGNOSTICS v_exchange_requests_deleted = ROW_COUNT;

  DELETE FROM public.inter_org_alert_events;
  GET DIAGNOSTICS v_alert_events_deleted = ROW_COUNT;

  DELETE FROM public.inter_org_alert_states;
  GET DIAGNOSTICS v_alert_states_deleted = ROW_COUNT;

  DELETE FROM public.item_availability_movements;
  GET DIAGNOSTICS v_movements_deleted = ROW_COUNT;

  DELETE FROM public.item_availability;
  GET DIAGNOSTICS v_availability_deleted = ROW_COUNT;

  v_rows_deleted := jsonb_build_object(
    'inter_org_exchange_events',   v_exchange_events_deleted,
    'inter_org_exchange_requests', v_exchange_requests_deleted,
    'inter_org_alert_events',      v_alert_events_deleted,
    'inter_org_alert_states',      v_alert_states_deleted,
    'item_availability_movements', v_movements_deleted,
    'item_availability',           v_availability_deleted
  );

  v_counts_after := jsonb_build_object(
    'inter_org_exchange_events',   0,
    'inter_org_exchange_requests', 0,
    'inter_org_alert_events',      0,
    'inter_org_alert_states',      0,
    'item_availability_movements', 0,
    'item_availability',           0
  );

  -- 7. Server-side audit log — the only write besides the six DELETEs above.
  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action,
    entity_type, entity_id, payload
  ) VALUES (
    NULL, v_actor, v_role, 'availability_data_deep_cleaned',
    'system', NULL,
    jsonb_build_object(
      'strategy', 'physical_delete_operational_availability',
      'dryRun', false,
      'counts_before', v_counts_before,
      'counts_after', v_counts_after,
      'rows_deleted_by_table', v_rows_deleted,
      'protected_tables_preserved', true,
      'confirmation_used', true,
      'executed_at', now()
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'dryRun', false,
    'strategy', 'physical_delete_operational_availability',
    'countsBefore', v_counts_before,
    'countsAfter', v_counts_after,
    'rowsDeletedByTable', v_rows_deleted
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_clean_availability_data(boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_clean_availability_data(boolean, text) TO authenticated;

-- Ask PostgREST to reload its schema cache so the new RPC is visible.
NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- VERIFY
-- =============================================================================

DO $$
DECLARE
  v_fn_src text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_fn_src
  FROM pg_proc WHERE proname = 'phoenix_clean_availability_data';

  ASSERT v_fn_src IS NOT NULL,
    'VERIFY FAILED: phoenix_clean_availability_data function not found';

  ASSERT v_fn_src LIKE '%SECURITY DEFINER%',
    'VERIFY FAILED: missing SECURITY DEFINER';
  ASSERT v_fn_src LIKE '%SET search_path%public%',
    'VERIFY FAILED: missing SET search_path = public';
  ASSERT v_fn_src LIKE '%INSUFFICIENT_ROLE%' AND v_fn_src LIKE '%super_admin%',
    'VERIFY FAILED: missing super_admin role check';
  ASSERT v_fn_src LIKE '%DEEP CLEAN AVAILABILITY%',
    'VERIFY FAILED: missing DEEP CLEAN AVAILABILITY confirmation phrase';
  ASSERT v_fn_src LIKE '%INVALID_CONFIRMATION%',
    'VERIFY FAILED: missing INVALID_CONFIRMATION error path';

  -- DELETE order: each table must appear, in the required sequence.
  ASSERT position('DELETE FROM public.inter_org_exchange_events' in v_fn_src)
       < position('DELETE FROM public.inter_org_exchange_requests' in v_fn_src)
     AND position('DELETE FROM public.inter_org_exchange_requests' in v_fn_src)
       < position('DELETE FROM public.inter_org_alert_events' in v_fn_src)
     AND position('DELETE FROM public.inter_org_alert_events' in v_fn_src)
       < position('DELETE FROM public.inter_org_alert_states' in v_fn_src)
     AND position('DELETE FROM public.inter_org_alert_states' in v_fn_src)
       < position('DELETE FROM public.item_availability_movements' in v_fn_src)
     AND position('DELETE FROM public.item_availability_movements' in v_fn_src)
       < position('DELETE FROM public.item_availability;' in v_fn_src),
    'VERIFY FAILED: DELETE order is not exactly exchange_events -> exchange_requests -> alert_events -> alert_states -> movements -> item_availability';

  ASSERT v_fn_src NOT ILIKE '%TRUNCATE%',
    'VERIFY FAILED: TRUNCATE must never be used, only DELETE';

  ASSERT v_fn_src NOT ILIKE '%DELETE FROM public.organizations%'
     AND v_fn_src NOT ILIKE '%DELETE FROM public.warehouses%'
     AND v_fn_src NOT ILIKE '%DELETE FROM public.distribution_points%'
     AND v_fn_src NOT ILIKE '%DELETE FROM public.local_items%'
     AND v_fn_src NOT ILIKE '%DELETE FROM public.central_items%'
     AND v_fn_src NOT ILIKE '%DELETE FROM public.profiles%'
     AND v_fn_src NOT ILIKE '%DELETE FROM public.permission_keys%'
     AND v_fn_src NOT ILIKE '%DELETE FROM public.role_permission_defaults%'
     AND v_fn_src NOT ILIKE '%DELETE FROM public.profile_permission_overrides%'
     AND v_fn_src NOT ILIKE '%DELETE FROM public.qr_targets%'
     AND v_fn_src NOT ILIKE '%DELETE FROM public.qr_tokens%'
     AND v_fn_src NOT ILIKE '%DELETE FROM public.organization_status_contacts%'
     AND v_fn_src NOT ILIKE '%DELETE FROM public.user_identity_history%'
     AND v_fn_src NOT ILIKE '%DELETE FROM auth.users%'
     AND v_fn_src NOT ILIKE '%DELETE FROM public.audit_logs%'
     AND v_fn_src NOT ILIKE '%DELETE FROM public.institution_item_status_reports%',
    'VERIFY FAILED: a protected table is deleted from';

  ASSERT v_fn_src LIKE '%INSERT INTO public.audit_logs%'
     AND v_fn_src LIKE '%availability_data_deep_cleaned%',
    'VERIFY FAILED: missing audit_logs INSERT for the execute path';

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public'
      AND routine_name = 'phoenix_clean_availability_data'
      AND grantee = 'authenticated'
      AND privilege_type = 'EXECUTE'
  ), 'VERIFY FAILED: authenticated does not have EXECUTE on phoenix_clean_availability_data';

  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public'
      AND routine_name = 'phoenix_clean_availability_data'
      AND grantee IN ('anon', 'PUBLIC')
  ), 'VERIFY FAILED: anon or PUBLIC has EXECUTE on phoenix_clean_availability_data';

  RAISE NOTICE '055 OK: phoenix_clean_availability_data — dry-run-first, super_admin-only, physically deletes item_availability + item_availability_movements + linked inter-org alert/exchange rows in FK-safe order, no protected table touched.';
END $$;

-- =============================================================================
-- END OF MIGRATION 055
-- =============================================================================
