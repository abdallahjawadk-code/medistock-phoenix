-- ============================================================================
-- MIGRATION 042 — clear_port_availability: movement-safe rewrite
-- ============================================================================
-- MANUAL APPLY ONLY — DO NOT use `npx supabase db push`.
-- Apply via Supabase Dashboard > SQL Editor after a verified backup.
--
-- Prerequisites: 001 (item_availability, audit_logs), 002 (phoenix_my_role/
-- phoenix_my_org — not used directly here, this function resolves role/org
-- itself exactly as migration 007 did), 007 (clear_port_availability
-- original definition, REPLACED by this migration), 033
-- (item_availability_movements, ON DELETE RESTRICT — the root cause), 038
-- (inter_org_alert_states, ON DELETE RESTRICT — see root cause below), 040
-- (inter_org_exchange_requests, ON DELETE RESTRICT — see root cause below).
--
-- Task: BUGFIX-CLEAR-PORT-AVAILABILITY-RPC-A
--
-- -----------------------------------------------------------------------------
-- Root cause (confirmed by the previous phase, BUGFIX-REPORTS-DATES-PORT-CLEAR-A):
-- -----------------------------------------------------------------------------
--   clear_port_availability (migration 007) hard-DELETEs every
--   item_availability row for a distribution point:
--
--     delete from item_availability where distribution_point_id = p_point_id;
--
--   item_availability_movements.item_availability_id REFERENCES
--   item_availability(id) ON DELETE RESTRICT (migration 033, added AFTER 007
--   shipped). So clearing a port that has ANY quantity-movement history (the
--   normal case once "Adjust Quantity" / phoenix_apply_availability_movement
--   has ever been used on that port) makes the DELETE fail with Postgres
--   23503 (foreign_key_violation). The single-item "إزالة من المنفذ" (remove
--   from outlet) action never hits this because it only UPDATEs
--   quantity/condition via upsertAvailability — it never deletes the row.
--
--   Investigating this migration's blast radius further surfaced TWO MORE
--   ON DELETE RESTRICT references into item_availability that migration 007
--   predates and never accounted for, which means "rows with no movement
--   history are safe to hard-delete" is NOT a safe assumption in general:
--
--     inter_org_alert_states.source_item_availability_id  REFERENCES item_availability(id) ON DELETE RESTRICT  (migration 038)
--     inter_org_alert_states.target_item_availability_id  REFERENCES item_availability(id) ON DELETE RESTRICT  (migration 038)
--     inter_org_exchange_requests.source_item_availability_id REFERENCES item_availability(id) ON DELETE RESTRICT (migration 040)
--     inter_org_exchange_requests.target_item_availability_id REFERENCES item_availability(id) ON DELETE RESTRICT (migration 040)
--
--   (Service-D's inter-org exchange UI is paused/stashed, but its SCHEMA —
--   040/041 — is already applied in this environment, so these constraints
--   are live regardless of frontend feature status.)
--
-- -----------------------------------------------------------------------------
-- Fix — what this migration does:
-- -----------------------------------------------------------------------------
--   Replaces clear_port_availability so it NEVER deletes item_availability
--   rows. Every row in scope for the port (with or without movement history)
--   is instead UPDATEd to quantity = 0, condition = 'missing' — the exact
--   same terminal state upsertAvailability already puts a row into for the
--   single-item "remove from outlet" action (InstitutionScreen.tsx
--   onConfirmRemove). This is a deliberate simplification over branching
--   "delete rows with no history, update rows with history": since
--   item_availability is now RESTRICT-referenced by three different tables
--   (033, 038, 040), "no movement history" does not imply "safe to delete" —
--   a row could still be referenced by an inter-org alert or exchange
--   request. Updating unconditionally sidesteps that whole class of FK risk,
--   today and for any future RESTRICT reference, with one code path instead
--   of two. The row's own id, and therefore every FK pointing at it, stays
--   valid.
--
--   The returned `cleared` count and the audit_logs `port_items_cleared`
--   entry are preserved from migration 007 (count of rows in scope for the
--   port). Two new informational fields are added to the JSONB payload —
--   `items_with_movement_history` (count only, for diagnostics) and `mode`
--   (always 'zeroed_not_deleted') — additive only; the frontend
--   (lifecycle.service.ts) only reads `.ok` / `.cleared` / `.error`, so this
--   is backward compatible.
--
--   NOT changed: RPC name, argument list/types, SECURITY DEFINER, search_path,
--   the NOT_AUTHENTICATED / INSUFFICIENT_ROLE / POINT_NOT_FOUND /
--   FORBIDDEN_ORG / CONFIRMATION_MISMATCH checks and error codes (byte-for-
--   byte identical logic/order to migration 007), the confirmation phrase
--   format ('CLEAR_PORT_ITEMS_' || p_point_id), the allowed-roles list
--   (super_admin, hospital_admin, warehouse_manager), the audit_logs action
--   name ('port_items_cleared'), or the grants (authenticated only, no anon).
--
-- What this migration does NOT do:
--   - Does NOT modify migrations 001-041 in any way.
--   - Does NOT delete from item_availability_movements, audit_logs, or any
--     other table.
--   - Does NOT add a frontend "delete movement history" button or RPC —
--     item_availability_movements remains an immutable SELECT-only ledger
--     (migration 033); this migration does not touch its grants or policies.
--   - Does NOT weaken any RLS policy — item_availability has no RLS policy
--     change here (SECURITY DEFINER function body change only).
--   - Does NOT change who can call this RPC or what confirmation it requires.
--   - Does NOT use any elevated/admin API key — this is a plain SQL migration.
--   - Does NOT touch inter_org_exchange_* or inter_org_alert_* RPCs/policies.
--
-- Safe diagnostics to run BEFORE applying (read-only; confirm current state):
--
--   SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname = 'clear_port_availability';
--
--   -- Rows that would currently block a DELETE-based clear for a given port:
--   SELECT ia.id, ia.quantity, ia.condition
--   FROM item_availability ia
--   WHERE ia.distribution_point_id = '<point_id>'
--     AND EXISTS (SELECT 1 FROM item_availability_movements m WHERE m.item_availability_id = ia.id);
--
-- Post-apply manual verification (run in Supabase SQL Editor):
--
--   1. Pick a port with existing movement history (or create one: adjust a
--      quantity via the UI, then note the item_availability_id).
--   2. SELECT clear_port_availability('<point_id>', 'CLEAR_PORT_ITEMS_<point_id>');
--      -- expect: { "ok": true, "cleared": N, "items_with_movement_history": M, "mode": "zeroed_not_deleted" }
--   3. SELECT quantity, condition FROM item_availability WHERE distribution_point_id = '<point_id>';
--      -- expect: quantity = 0, condition = 'missing' for every row — rows still exist.
--   4. SELECT count(*) FROM item_availability_movements WHERE item_availability_id IN
--      (SELECT id FROM item_availability WHERE distribution_point_id = '<point_id>');
--      -- expect: unchanged from before step 2 (no rows deleted, none added).
--   5. Re-run step 2 (same point). Expect the same success shape — idempotent.
--   6. Confirm a non-authorized role (e.g. viewer) still gets INSUFFICIENT_ROLE,
--      and a wrong confirmation phrase still gets CONFIRMATION_MISMATCH.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.clear_port_availability(
  p_point_id     uuid,
  p_confirmation text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor_id     uuid;
  v_role         text;
  v_org_id       uuid;
  v_point_org    uuid;
  v_total_count  int;
  v_with_history int;
  v_required     text;
BEGIN
  v_actor_id := auth.uid();
  IF v_actor_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED');
  END IF;

  SELECT role, organization_id INTO v_role, v_org_id
  FROM profiles WHERE id = v_actor_id;

  IF v_role NOT IN ('super_admin', 'hospital_admin', 'warehouse_manager') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_ROLE');
  END IF;

  SELECT organization_id INTO v_point_org
  FROM distribution_points WHERE id = p_point_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'POINT_NOT_FOUND');
  END IF;

  IF v_role != 'super_admin' AND v_point_org != v_org_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'FORBIDDEN_ORG');
  END IF;

  v_required := 'CLEAR_PORT_ITEMS_' || p_point_id::text;
  IF p_confirmation IS DISTINCT FROM v_required THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'CONFIRMATION_MISMATCH',
      'required', v_required
    );
  END IF;

  -- Counts are for the response/audit payload only — both groups below are
  -- handled identically (UPDATE, never DELETE). See the migration header for
  -- why "no movement history" does not imply "safe to hard-delete".
  SELECT count(*) INTO v_total_count
  FROM item_availability WHERE distribution_point_id = p_point_id;

  SELECT count(*) INTO v_with_history
  FROM item_availability ia
  WHERE ia.distribution_point_id = p_point_id
    AND EXISTS (
      SELECT 1 FROM item_availability_movements m
      WHERE m.item_availability_id = ia.id
    );

  -- BUGFIX-CLEAR-PORT-AVAILABILITY-RPC-A: zero the quantity and mark
  -- condition = 'missing' instead of deleting. The row's id — and therefore
  -- every FK pointing at it (item_availability_movements, 033;
  -- inter_org_alert_states, 038; inter_org_exchange_requests, 040) — stays
  -- valid. The WHERE clause's second line is a pure idempotency optimization
  -- (skip rows already at the target state on a repeat call); it does not
  -- change which rows are considered "cleared" for the returned count.
  UPDATE item_availability
     SET quantity        = 0,
         condition        = 'missing',
         last_updated_by  = v_actor_id
   WHERE distribution_point_id = p_point_id
     AND (quantity <> 0 OR condition IS DISTINCT FROM 'missing');

  INSERT INTO audit_logs (
    organization_id, actor_id, actor_role, action,
    entity_type, entity_id, payload
  ) VALUES (
    v_point_org, v_actor_id, v_role, 'port_items_cleared',
    'distribution_point', p_point_id,
    jsonb_build_object(
      'items_cleared', v_total_count,
      'items_with_movement_history', v_with_history,
      'mode', 'zeroed_not_deleted'
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'cleared', v_total_count,
    'items_with_movement_history', v_with_history,
    'mode', 'zeroed_not_deleted'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.clear_port_availability(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.clear_port_availability(uuid, text) TO authenticated;

-- Ask PostgREST to reload its schema cache so the corrected RPC is visible.
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- VERIFY
-- ============================================================================

DO $$
DECLARE
  v_fn_src text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_fn_src
  FROM pg_proc WHERE proname = 'clear_port_availability';

  ASSERT v_fn_src IS NOT NULL,
    'VERIFY FAILED: clear_port_availability function not found';

  -- A. Security properties preserved
  ASSERT v_fn_src LIKE '%SECURITY DEFINER%',
    'VERIFY FAILED: clear_port_availability lost SECURITY DEFINER';
  ASSERT v_fn_src LIKE '%SET search_path%',
    'VERIFY FAILED: clear_port_availability lost SET search_path';

  -- B. Role/permission/org/confirmation checks preserved
  ASSERT v_fn_src LIKE '%NOT_AUTHENTICATED%',
    'VERIFY FAILED: NOT_AUTHENTICATED check missing';
  ASSERT v_fn_src LIKE '%INSUFFICIENT_ROLE%'
     AND v_fn_src LIKE '%super_admin%'
     AND v_fn_src LIKE '%hospital_admin%'
     AND v_fn_src LIKE '%warehouse_manager%',
    'VERIFY FAILED: role allowlist check missing or changed';
  ASSERT v_fn_src LIKE '%POINT_NOT_FOUND%',
    'VERIFY FAILED: POINT_NOT_FOUND check missing';
  ASSERT v_fn_src LIKE '%FORBIDDEN_ORG%',
    'VERIFY FAILED: FORBIDDEN_ORG check missing';
  ASSERT v_fn_src LIKE '%CONFIRMATION_MISMATCH%'
     AND v_fn_src LIKE '%CLEAR_PORT_ITEMS_%',
    'VERIFY FAILED: confirmation-phrase check missing or changed';

  -- C. No DELETE against item_availability anywhere in the function body
  ASSERT v_fn_src NOT ILIKE '%DELETE FROM item_availability%'
     AND v_fn_src NOT ILIKE '%DELETE FROM public.item_availability%',
    'VERIFY FAILED: clear_port_availability still deletes from item_availability';

  -- D. No DELETE against the movement ledger or audit_logs
  ASSERT v_fn_src NOT ILIKE '%DELETE FROM item_availability_movements%'
     AND v_fn_src NOT ILIKE '%DELETE FROM public.item_availability_movements%',
    'VERIFY FAILED: clear_port_availability deletes from item_availability_movements';
  ASSERT v_fn_src NOT ILIKE '%DELETE FROM audit_logs%'
     AND v_fn_src NOT ILIKE '%DELETE FROM public.audit_logs%',
    'VERIFY FAILED: clear_port_availability deletes from audit_logs';

  -- E. Uses UPDATE ... quantity = 0 / condition = 'missing' instead
  ASSERT v_fn_src LIKE '%UPDATE item_availability%'
     AND v_fn_src LIKE '%quantity        = 0%'
     AND v_fn_src LIKE '%condition        = ''missing''%',
    'VERIFY FAILED: UPDATE-to-zero/missing logic not found as expected';

  -- F. Still writes the same audit_logs action name
  ASSERT v_fn_src LIKE '%port_items_cleared%',
    'VERIFY FAILED: port_items_cleared audit action missing';

  -- G. Grants: authenticated only, anon/PUBLIC excluded
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public'
      AND routine_name = 'clear_port_availability'
      AND grantee = 'authenticated'
      AND privilege_type = 'EXECUTE'
  ), 'VERIFY FAILED: authenticated does not have EXECUTE on clear_port_availability';

  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public'
      AND routine_name = 'clear_port_availability'
      AND grantee IN ('anon', 'PUBLIC')
  ), 'VERIFY FAILED: anon or PUBLIC has EXECUTE on clear_port_availability';

  -- H. item_availability_movements is untouched: still 0 write policies, ledger intact
  ASSERT (
    SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'item_availability_movements'
      AND cmd IN ('INSERT', 'UPDATE', 'DELETE')
  ) = 0,
    'VERIFY FAILED: item_availability_movements gained a write policy — should have none';

  -- I. phoenix_apply_availability_movement / phoenix_upsert_availability untouched by this migration
  ASSERT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'phoenix_apply_availability_movement'
  ), 'VERIFY FAILED: phoenix_apply_availability_movement is missing';
  ASSERT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'phoenix_upsert_availability'
  ), 'VERIFY FAILED: phoenix_upsert_availability is missing';

  RAISE NOTICE '042 OK: clear_port_availability no longer deletes item_availability rows; zeroes quantity/condition instead, preserving item_availability_movements/inter_org_alert_states/inter_org_exchange_requests FK validity. Role/org/confirmation checks, grants, and audit logging preserved.';
END $$;

-- ============================================================================
-- END OF MIGRATION 042
-- ============================================================================
