-- =============================================================================
-- 148_phoenix_secure_user_delete_history_guard.sql
-- MediStock Phoenix V2
--
-- WHY 148, NOT 147
-- -----------------
-- `master`'s reviewed ceiling is 146. Migration 147 is NOT free, however: the
-- separate, still-unmerged PR #68 (branch feat/phoenix-transfer-suggestions-
-- production) already has 147_phoenix_transfer_suggestion_draft_bridge.sql
-- committed on its own branch. Reusing 147 here would collide the moment both
-- PRs land. This migration is therefore numbered 148 and is append-only: it
-- does not edit 093 (or any other applied migration) — it lays a NEW
-- CREATE OR REPLACE on top of the one existing function whose behavior must
-- change (phoenix_lifecycle_reserve), exactly the same evolution pattern 146
-- already used for phoenix_provision_profile/phoenix_admin_provision_profile.
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- admin-user-lifecycle's hard-delete path (action='delete') calls
-- phoenix_lifecycle_reserve, which enforces authorization, self-action, the
-- last-active-super_admin invariant, and single-in-flight-reservation — but
-- has NO check for operational history. Actor/creator/approver columns across
-- the operational schema (warehouse & outlet movements, transfers, returns,
-- procurement, stocktakes/monthly-status approvals, corrections, custody-
-- chain events, availability edits, QR issuance) are declared
-- `REFERENCES auth.users(id)`, mostly `ON DELETE SET NULL` and a handful
-- `ON DELETE RESTRICT`/`NOT NULL`. Today, hard-deleting a profile with history
-- either silently orphans those actor references (SET NULL — losing the
-- ability to resolve "who" back to a live profile row, even though the
-- write-time actor_name/actor_role snapshot text survives) or aborts with a
-- raw, unfriendly Postgres foreign_key_violation (the RESTRICT columns) —
-- neither is a deliberate, application-level guarantee.
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
--   1. Adds phoenix_profile_operational_blockers(profile_id) — a STABLE
--      SECURITY DEFINER enumerator (same architecture as 141's
--      phoenix_demo_org_blockers, applied here to a profile instead of an
--      organization) listing every operational table row still referencing
--      the given profile id, across every actor/creator/approver/reviewer
--      column identified in the schema as of migration 146.
--
--      Deliberately EXCLUDED from the blocker list (so a genuinely unused,
--      freshly created account STAYS deletable, per explicit requirement):
--        - audit_logs                     (a byproduct of actions already
--                                           captured by the operational
--                                           tables themselves; creation/
--                                           lifecycle audit rows alone must
--                                           never block deleting an unused
--                                           account)
--        - phoenix_notifications /
--          phoenix_notification_reads     (passive/derivative, not an action
--                                           this profile performed)
--        - profile_permission_overrides,
--          profile_scope_assignments      (RBAC administration of the
--                                           account itself, not operational
--                                           activity performed by it)
--        - user_identity_history,
--          profile_lifecycle_reservations (identity/lifecycle bookkeeping,
--                                           not operational activity)
--
--   2. CREATE OR REPLACES phoenix_lifecycle_reserve (093) with the IDENTICAL
--      signature and IDENTICAL body, plus exactly one new block: when
--      p_action = 'delete', if phoenix_profile_operational_blockers finds any
--      row, deny with a distinct, non-oracle, user-facing code
--      USER_HAS_OPERATIONAL_HISTORY (not folded into the generic
--      REQUEST_DENIED bucket — "this account has activity" is not a sensitive
--      fact an attacker could use as an oracle; it is exactly the information
--      an admin needs to know to use disable/recycle instead).
--
--      This check lands INSIDE reserve(), under the SAME
--      pg_advisory_xact_lock(9314093001) 093 already uses to serialize every
--      super-admin-affecting transition, and BEFORE the profile is flipped to
--      'suspended' — so it is the authoritative, re-verified-at-delete-time
--      gate the Edge Function's confirmation-phrase UI check can never
--      bypass, exactly as required. It does not depend on, or duplicate, any
--      frontend check.
--
--      No CASCADE is introduced or widened anywhere in this migration; no
--      historical movement/audit row is read-write touched, only read.
--
-- SAFETY
-- ------
-- Transaction-wrapped. phoenix_profile_operational_blockers is SECURITY
-- DEFINER with a pinned search_path, REVOKEd from PUBLIC/anon/authenticated
-- (an internal helper only ever reached through the already-reviewed
-- SECURITY DEFINER phoenix_lifecycle_reserve, exactly like 093's own
-- _phoenix_lifecycle_deny helper — Postgres evaluates a SECURITY DEFINER
-- function's own internal privilege checks against its OWNER, so the nested
-- call needs no separate grant to `authenticated`). phoenix_lifecycle_reserve
-- keeps its exact prior grants (authenticated only, never anon/public).
-- Additive only: no existing function is dropped, no table/column is
-- altered, no CASCADE is added or changed. Not applied to Production by this
-- PR.
-- =============================================================================

begin;

-- ── phoenix_profile_operational_blockers: enumerate real operational history ──
create or replace function public.phoenix_profile_operational_blockers(p_profile_id uuid)
returns table (referencing_table text, reference_count bigint)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $blockers$
declare
  v_n bigint;
begin
  if p_profile_id is null then
    return;
  end if;

  -- Warehouse & outlet stock movements (the canonical ledger).
  if to_regclass('public.warehouse_stock_movements') is not null then
    execute 'select count(*)::bigint from public.warehouse_stock_movements where actor_id = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'warehouse_stock_movements'; reference_count := v_n; return next; end if;
  end if;
  if to_regclass('public.outlet_stock_movements') is not null then
    execute 'select count(*)::bigint from public.outlet_stock_movements where actor_id = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'outlet_stock_movements'; reference_count := v_n; return next; end if;
  end if;
  if to_regclass('public.warehouse_quarantine_stock_movements') is not null then
    execute 'select count(*)::bigint from public.warehouse_quarantine_stock_movements where actor_id = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'warehouse_quarantine_stock_movements'; reference_count := v_n; return next; end if;
  end if;
  if to_regclass('public.item_availability_movements') is not null then
    execute 'select count(*)::bigint from public.item_availability_movements where created_by = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'item_availability_movements'; reference_count := v_n; return next; end if;
  end if;
  if to_regclass('public.phoenix_movement_events') is not null then
    execute 'select count(*)::bigint from public.phoenix_movement_events where actor_id = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'phoenix_movement_events'; reference_count := v_n; return next; end if;
  end if;
  if to_regclass('public.phoenix_movement_dispense_context') is not null then
    execute 'select count(*)::bigint from public.phoenix_movement_dispense_context where recorded_by = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'phoenix_movement_dispense_context'; reference_count := v_n; return next; end if;
  end if;

  -- Warehouse dispatch (central -> institution).
  if to_regclass('public.warehouse_dispatches') is not null then
    execute 'select count(*)::bigint from public.warehouse_dispatches where created_by = $1 or sent_by = $1 or cancelled_by = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'warehouse_dispatches'; reference_count := v_n; return next; end if;
  end if;
  if to_regclass('public.warehouse_dispatch_lines') is not null then
    execute 'select count(*)::bigint from public.warehouse_dispatch_lines where accepted_by = $1 or rejected_by = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'warehouse_dispatch_lines'; reference_count := v_n; return next; end if;
  end if;
  if to_regclass('public.phoenix_dispatch_line_requests') is not null then
    execute 'select count(*)::bigint from public.phoenix_dispatch_line_requests where actor_id = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'phoenix_dispatch_line_requests'; reference_count := v_n; return next; end if;
  end if;

  -- Transfers (central -> institution).
  if to_regclass('public.warehouse_transfer_requests') is not null then
    execute 'select count(*)::bigint from public.warehouse_transfer_requests where requested_by = $1 or cancelled_by = $1 or reviewed_by = $1 or created_by = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'warehouse_transfer_requests'; reference_count := v_n; return next; end if;
  end if;
  if to_regclass('public.warehouse_transfers') is not null then
    execute 'select count(*)::bigint from public.warehouse_transfers where sent_by = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'warehouse_transfers'; reference_count := v_n; return next; end if;
  end if;
  if to_regclass('public.warehouse_transfer_lines') is not null then
    execute 'select count(*)::bigint from public.warehouse_transfer_lines where received_by = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'warehouse_transfer_lines'; reference_count := v_n; return next; end if;
  end if;

  -- Returns (institution -> central).
  if to_regclass('public.warehouse_quarantine_stock') is not null then
    execute 'select count(*)::bigint from public.warehouse_quarantine_stock where created_by = $1 or updated_by = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'warehouse_quarantine_stock'; reference_count := v_n; return next; end if;
  end if;
  if to_regclass('public.warehouse_return_requests') is not null then
    execute 'select count(*)::bigint from public.warehouse_return_requests where requested_by = $1 or reviewed_by = $1 or cancelled_by = $1 or created_by = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'warehouse_return_requests'; reference_count := v_n; return next; end if;
  end if;
  if to_regclass('public.warehouse_return_shipments') is not null then
    execute 'select count(*)::bigint from public.warehouse_return_shipments where sent_by = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'warehouse_return_shipments'; reference_count := v_n; return next; end if;
  end if;
  if to_regclass('public.warehouse_return_shipment_lines') is not null then
    execute 'select count(*)::bigint from public.warehouse_return_shipment_lines where received_by = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'warehouse_return_shipment_lines'; reference_count := v_n; return next; end if;
  end if;

  -- Returns (outlet -> institution).
  if to_regclass('public.outlet_return_requests') is not null then
    execute 'select count(*)::bigint from public.outlet_return_requests where requested_by = $1 or reviewed_by = $1 or cancelled_by = $1 or created_by = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'outlet_return_requests'; reference_count := v_n; return next; end if;
  end if;
  if to_regclass('public.outlet_return_shipments') is not null then
    execute 'select count(*)::bigint from public.outlet_return_shipments where sent_by = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'outlet_return_shipments'; reference_count := v_n; return next; end if;
  end if;
  if to_regclass('public.outlet_return_shipment_lines') is not null then
    execute 'select count(*)::bigint from public.outlet_return_shipment_lines where received_by = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'outlet_return_shipment_lines'; reference_count := v_n; return next; end if;
  end if;

  -- Supply routes / inventory intelligence.
  if to_regclass('public.warehouse_supply_routes') is not null then
    execute 'select count(*)::bigint from public.warehouse_supply_routes where created_by = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'warehouse_supply_routes'; reference_count := v_n; return next; end if;
  end if;
  if to_regclass('public.inventory_signal_thresholds') is not null then
    execute 'select count(*)::bigint from public.inventory_signal_thresholds where created_by = $1 or updated_by = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'inventory_signal_thresholds'; reference_count := v_n; return next; end if;
  end if;
  if to_regclass('public.inventory_alerts') is not null then
    execute 'select count(*)::bigint from public.inventory_alerts where acknowledged_by = $1 or resolved_by = $1 or dismissed_by = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'inventory_alerts'; reference_count := v_n; return next; end if;
  end if;

  -- Procurement.
  if to_regclass('public.procurement_suppliers') is not null then
    execute 'select count(*)::bigint from public.procurement_suppliers where created_by = $1 or updated_by = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'procurement_suppliers'; reference_count := v_n; return next; end if;
  end if;
  if to_regclass('public.procurement_orders') is not null then
    execute 'select count(*)::bigint from public.procurement_orders where submitted_by = $1 or decided_by = $1 or cancelled_by = $1 or created_by = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'procurement_orders'; reference_count := v_n; return next; end if;
  end if;
  if to_regclass('public.procurement_receipts') is not null then
    execute 'select count(*)::bigint from public.procurement_receipts where received_by = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'procurement_receipts'; reference_count := v_n; return next; end if;
  end if;
  if to_regclass('public.procurement_returns') is not null then
    execute 'select count(*)::bigint from public.procurement_returns where actor_id = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'procurement_returns'; reference_count := v_n; return next; end if;
  end if;
  if to_regclass('public.procurement_order_events') is not null then
    execute 'select count(*)::bigint from public.procurement_order_events where actor_id = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'procurement_order_events'; reference_count := v_n; return next; end if;
  end if;

  -- Stocktakes / monthly status (custody chain).
  if to_regclass('public.stocktakes') is not null then
    execute 'select count(*)::bigint from public.stocktakes where performed_by = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'stocktakes'; reference_count := v_n; return next; end if;
  end if;
  if to_regclass('public.inventory_status_reports') is not null then
    execute 'select count(*)::bigint from public.inventory_status_reports where prepared_by = $1 or submitted_by = $1 or approved_by = $1 or returned_by = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'inventory_status_reports'; reference_count := v_n; return next; end if;
  end if;
  if to_regclass('public.inventory_status_report_lines') is not null then
    execute 'select count(*)::bigint from public.inventory_status_report_lines where classified_by = $1 or first_confirmed_by = $1 or confirmed_by = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'inventory_status_report_lines'; reference_count := v_n; return next; end if;
  end if;
  if to_regclass('public.inventory_status_report_amendments') is not null then
    execute 'select count(*)::bigint from public.inventory_status_report_amendments where created_by = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'inventory_status_report_amendments'; reference_count := v_n; return next; end if;
  end if;

  -- Second-person correction approvals.
  if to_regclass('public.phoenix_stock_correction_requests') is not null then
    execute 'select count(*)::bigint from public.phoenix_stock_correction_requests where proposed_by = $1 or decided_by = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'phoenix_stock_correction_requests'; reference_count := v_n; return next; end if;
  end if;
  if to_regclass('public.phoenix_warehouse_correction_requests') is not null then
    execute 'select count(*)::bigint from public.phoenix_warehouse_correction_requests where proposed_by = $1 or decided_by = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'phoenix_warehouse_correction_requests'; reference_count := v_n; return next; end if;
  end if;
  if to_regclass('public.phoenix_variance_approval_policy') is not null then
    execute 'select count(*)::bigint from public.phoenix_variance_approval_policy where updated_by = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'phoenix_variance_approval_policy'; reference_count := v_n; return next; end if;
  end if;

  -- Paper references / report snapshots.
  if to_regclass('public.phoenix_paper_references') is not null then
    execute 'select count(*)::bigint from public.phoenix_paper_references where created_by = $1 or updated_by = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'phoenix_paper_references'; reference_count := v_n; return next; end if;
  end if;
  if to_regclass('public.phoenix_report_snapshots') is not null then
    execute 'select count(*)::bigint from public.phoenix_report_snapshots where created_by = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'phoenix_report_snapshots'; reference_count := v_n; return next; end if;
  end if;

  -- Inter-institution alerts / exchange.
  if to_regclass('public.inter_org_alert_states') is not null then
    execute 'select count(*)::bigint from public.inter_org_alert_states where acknowledged_by = $1 or in_progress_by = $1 or resolved_by = $1 or dismissed_by = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'inter_org_alert_states'; reference_count := v_n; return next; end if;
  end if;
  if to_regclass('public.inter_org_alert_events') is not null then
    execute 'select count(*)::bigint from public.inter_org_alert_events where actor_id = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'inter_org_alert_events'; reference_count := v_n; return next; end if;
  end if;
  if to_regclass('public.inter_org_exchange_events') is not null then
    execute 'select count(*)::bigint from public.inter_org_exchange_events where actor_id = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'inter_org_exchange_events'; reference_count := v_n; return next; end if;
  end if;

  -- Platform broadcast (administrative, still a real historical action).
  if to_regclass('public.platform_broadcast_messages') is not null then
    execute 'select count(*)::bigint from public.platform_broadcast_messages where created_by = $1 or updated_by = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'platform_broadcast_messages'; reference_count := v_n; return next; end if;
  end if;
  if to_regclass('public.platform_broadcast_acknowledgements') is not null then
    execute 'select count(*)::bigint from public.platform_broadcast_acknowledgements where acknowledged_by = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'platform_broadcast_acknowledgements'; reference_count := v_n; return next; end if;
  end if;

  -- Legacy status reports / availability edits / QR issuance / org contacts.
  if to_regclass('public.institution_item_status_reports') is not null then
    execute 'select count(*)::bigint from public.institution_item_status_reports where submitted_by = $1 or resolved_by = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'institution_item_status_reports'; reference_count := v_n; return next; end if;
  end if;
  if to_regclass('public.item_availability') is not null then
    execute 'select count(*)::bigint from public.item_availability where last_updated_by = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'item_availability'; reference_count := v_n; return next; end if;
  end if;
  if to_regclass('public.qr_tokens') is not null then
    execute 'select count(*)::bigint from public.qr_tokens where created_by = $1 or disabled_by = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'qr_tokens'; reference_count := v_n; return next; end if;
  end if;
  if to_regclass('public.organization_status_contacts') is not null then
    execute 'select count(*)::bigint from public.organization_status_contacts where created_by = $1' into v_n using p_profile_id;
    if v_n > 0 then referencing_table := 'organization_status_contacts'; reference_count := v_n; return next; end if;
  end if;

  return;
end;
$blockers$;

comment on function public.phoenix_profile_operational_blockers(uuid) is
  'SECURE-USER-DELETE-HISTORY-GUARD-148: enumerates every operational table '
  'row still referencing a profile id, by actor/creator/approver/reviewer/etc. '
  'column. Internal helper for phoenix_lifecycle_reserve''s delete gate only — '
  'not directly callable by any client role.';

revoke all on function public.phoenix_profile_operational_blockers(uuid) from public;
revoke all on function public.phoenix_profile_operational_blockers(uuid) from anon;
revoke all on function public.phoenix_profile_operational_blockers(uuid) from authenticated;

-- ── phoenix_lifecycle_reserve: same signature/body as 093, plus one new gate ──
create or replace function public.phoenix_lifecycle_reserve(
  p_target_id     uuid,
  p_action        text,
  p_correlation_id uuid default gen_random_uuid()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor       uuid := auth.uid();
  v_arole       text;
  v_aorg        uuid;
  v_astatus     text;
  v_is_super    boolean;
  v_is_inst     boolean;
  v_trole       text;
  v_tstatus     text;
  v_torg        uuid;
  v_active_sa   integer;
begin
  if p_action not in ('disable', 'delete') then
    return jsonb_build_object('ok', false, 'error', 'INVALID_ACTION', 'correlation_id', p_correlation_id);
  end if;
  if v_actor is null then
    return jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED', 'correlation_id', p_correlation_id);
  end if;

  -- Serialize ALL super-admin-affecting transitions on one key.
  perform pg_advisory_xact_lock(9314093001);

  select role, organization_id, status into v_arole, v_aorg, v_astatus
  from public.profiles where id = v_actor;
  v_is_super := (v_arole = 'super_admin' and v_astatus = 'active');
  v_is_inst  := (v_arole = 'institution_admin' and v_astatus = 'active');

  -- Actor must be an active super_admin or institution_admin.
  if not (v_is_super or v_is_inst) then
    return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'actor_not_authorized', p_correlation_id);
  end if;
  -- institution_admin additionally needs the users.disable permission.
  if v_is_inst and coalesce(public.phoenix_profile_has_permission(v_actor, 'users.disable'), false) is not true then
    return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'actor_missing_permission', p_correlation_id);
  end if;

  -- Self-action is never allowed.
  if p_target_id = v_actor then
    return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'self_action', p_correlation_id);
  end if;

  select role, status, organization_id into v_trole, v_tstatus, v_torg
  from public.profiles where id = p_target_id;
  if v_trole is null then
    return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'target_not_found', p_correlation_id);
  end if;

  -- institution_admin scope: own org only, never a platform-managed role,
  -- never a hard-delete.
  if v_is_inst then
    if v_trole in ('super_admin', 'institution_admin', 'central_warehouse_manager') then
      return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'target_platform_managed', p_correlation_id);
    end if;
    if v_aorg is distinct from v_torg then
      return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'cross_org', p_correlation_id);
    end if;
    if p_action = 'delete' then
      return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'delete_forbidden_for_role', p_correlation_id);
    end if;
  end if;

  -- Invariant: never remove the last active super_admin.
  if v_trole = 'super_admin' and v_tstatus = 'active' then
    select count(*) into v_active_sa
    from public.profiles where role = 'super_admin' and status = 'active';
    if v_active_sa <= 1 then
      -- Distinct, non-oracle code: fires only for an authorized actor acting on
      -- a real active super_admin. Logged too, for completeness.
      perform public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'last_super_admin', p_correlation_id);
      return jsonb_build_object('ok', false, 'error', 'LAST_SUPER_ADMIN', 'correlation_id', p_correlation_id);
    end if;
  end if;

  -- SECURE-USER-DELETE-HISTORY-GUARD-148: hard-delete additionally requires
  -- zero operational history. This is the authoritative, re-verified-at-
  -- delete-time gate — it runs under the SAME advisory lock as every other
  -- check above and BEFORE the target is ever flipped to 'suspended', so no
  -- confirmation-phrase UI check or client-side gate can bypass it, and no
  -- race window exists between this check and the reservation it guards.
  if p_action = 'delete' then
    if exists (select 1 from public.phoenix_profile_operational_blockers(p_target_id)) then
      perform public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'user_has_operational_history', p_correlation_id);
      return jsonb_build_object('ok', false, 'error', 'USER_HAS_OPERATIONAL_HISTORY', 'correlation_id', p_correlation_id);
    end if;
  end if;

  -- One in-flight transition per target.
  if exists (select 1 from public.profile_lifecycle_reservations where profile_id = p_target_id) then
    return jsonb_build_object('ok', false, 'error', 'LIFECYCLE_IN_PROGRESS', 'correlation_id', p_correlation_id);
  end if;

  -- PERSIST the decision: record the reservation and flip the target out of
  -- 'active' in the same committed transaction. From here a concurrent reserve
  -- observes the target as non-active and cannot also drain the last super_admin.
  insert into public.profile_lifecycle_reservations
    (profile_id, action, prior_status, prior_role, actor_id, correlation_id)
  values (p_target_id, p_action, v_tstatus, v_trole, v_actor, p_correlation_id);

  if p_action = 'disable' then
    update public.profiles
       set status = 'suspended', disabled_at = now(), disabled_by = v_actor, updated_at = now()
     where id = p_target_id;
  else -- delete: reserve by suspending; the row is removed after the Auth delete.
    update public.profiles
       set status = 'suspended', updated_at = now()
     where id = p_target_id;
  end if;

  insert into public.audit_logs
    (organization_id, actor_id, actor_role, action, entity_type, entity_id, payload)
  values
    (coalesce(v_torg, v_aorg), v_actor, v_arole, 'user.lifecycle_reserved', 'profile', p_target_id,
     jsonb_build_object('action', p_action, 'target_role', v_trole, 'correlation_id', p_correlation_id));

  return jsonb_build_object('ok', true, 'action', p_action, 'target_role', v_trole,
                            'target_org', v_torg, 'correlation_id', p_correlation_id);
end;
$$;

-- phoenix_lifecycle_reserve keeps its exact prior grants: authenticated only.
-- CREATE OR REPLACE preserves existing grants automatically, but this is
-- re-asserted explicitly (idempotent) so the migration is self-verifying and
-- does not depend on that Postgres behavior going unremarked.
revoke all on function public.phoenix_lifecycle_reserve(uuid,text,uuid) from public;
revoke all on function public.phoenix_lifecycle_reserve(uuid,text,uuid) from anon;
grant execute on function public.phoenix_lifecycle_reserve(uuid,text,uuid) to authenticated;

-- Migration-level structural verification.
do $$
declare
  v_blockers_oid regprocedure := 'public.phoenix_profile_operational_blockers(uuid)'::regprocedure;
  v_reserve_oid  regprocedure := 'public.phoenix_lifecycle_reserve(uuid,text,uuid)'::regprocedure;
  v_is_definer   boolean;
  v_config       text[];
begin
  select p.prosecdef, p.proconfig into v_is_definer, v_config
  from pg_proc p where p.oid = v_blockers_oid;
  assert v_is_definer,
    'VERIFY FAILED (148): phoenix_profile_operational_blockers must be SECURITY DEFINER';
  assert 'search_path=public, pg_temp' = any(v_config),
    'VERIFY FAILED (148): phoenix_profile_operational_blockers search_path is not pinned';
  assert not has_function_privilege('authenticated', v_blockers_oid, 'EXECUTE'),
    'VERIFY FAILED (148): authenticated can directly execute phoenix_profile_operational_blockers';
  assert not has_function_privilege('anon', v_blockers_oid, 'EXECUTE'),
    'VERIFY FAILED (148): anon can execute phoenix_profile_operational_blockers';
  assert not exists (
    select 1 from pg_proc p
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where p.oid = v_blockers_oid and a.grantee = 0 and a.privilege_type = 'EXECUTE'
  ), 'VERIFY FAILED (148): PUBLIC can execute phoenix_profile_operational_blockers';

  select p.prosecdef, p.proconfig into v_is_definer, v_config
  from pg_proc p where p.oid = v_reserve_oid;
  assert v_is_definer,
    'VERIFY FAILED (148): phoenix_lifecycle_reserve must remain SECURITY DEFINER';
  assert 'search_path=public, pg_temp' = any(v_config),
    'VERIFY FAILED (148): phoenix_lifecycle_reserve search_path is not pinned';
  assert has_function_privilege('authenticated', v_reserve_oid, 'EXECUTE'),
    'VERIFY FAILED (148): authenticated must still be able to execute phoenix_lifecycle_reserve';
  assert not has_function_privilege('anon', v_reserve_oid, 'EXECUTE'),
    'VERIFY FAILED (148): anon must not execute phoenix_lifecycle_reserve';

  raise notice
    'SECURE-USER-DELETE-HISTORY-GUARD-148 verified: operational-history gate active on hard delete.';
end;
$$;

commit;
