/**
 * FULL PRE-LAUNCH PURGE MANIFEST — schema 147, OWNER OPTION A (A3-3B0N-R7).
 *
 * Single source of truth for supabase/ops/pre_launch_full_purge_v147.sql.
 *
 * TARGET STATE — CANONICAL_PRELAUNCH_EMPTY_BASELINE_V147:
 *     clean schema 147
 *   - EVERY row seeded by migration 004_phoenix_seed_demo_data.sql
 *   + exactly one verified keeper account (resolved BY EMAIL)
 *   + required RBAC reference data
 *
 * This is DELIBERATELY emptier than a fresh 001->147 replay. Migration 004 seeds
 * demonstration rows — Babil General Hospital, Al-Hilla Teaching Hospital, their
 * warehouses / outlets / catalog / availability / QR rows at fixed UUIDs
 * ...0001 / ...0002. The owner classified all of it as test data and authorised
 * removal, with no re-seed. The superseded term
 * CANONICAL_MIGRATION_SEEDED_BASELINE must not be used: it preserved exactly
 * those rows and is void by owner decision.
 *
 * PURGE_ORDER is topologically derived from the real 147 FK graph using only
 * ordering-FORCING constraints (RESTRICT / NO ACTION); CASCADE and SET NULL
 * edges do not constrain delete order.
 */

export const MANIFEST_MIGRATION_CEILING = 147;
export const KEEPER_EMAIL = 'abdallahjawad2015@gmail.com';

export const EXPECTED_PERMISSION_KEYS = 130;
export const EXPECTED_ROLE_PERMISSION_DEFAULTS = 415;

/** UUIDs migration 004 seeds. Nothing outside 004 may reference them. */
export const DEMO_SEED_ORG_UUIDS: readonly string[] = [
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000002',
];

/** Purged to zero, FK-safe child-first. */
export const PURGE_ORDER: readonly string[] = [
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
  'organizations',
];

/** Preserved outright — RBAC definitions only. */
export const PRESERVE: readonly string[] = [
  'permission_keys',
  'role_permission_defaults',
];

/** Everything except the keeper row is removed. */
export const KEEPER_SCOPED: readonly string[] = [
  'profiles',
  'auth.users',
];

/**
 * Storage cannot be emptied atomically in SQL — deleting storage.objects rows
 * does not delete the underlying files. Asserted already-zero as a PRECONDITION
 * and purged out-of-band through the official Storage API.
 */
export const EXTERNAL_OR_PRECONDITION: readonly string[] = [
  'storage.objects',
  'storage.buckets',
];

/** Every public table at 147, in exactly one category. */
export const ALL_CLASSIFIED_PUBLIC: readonly string[] = [
  ...PURGE_ORDER,
  ...PRESERVE,
  ...KEEPER_SCOPED.filter((t) => !t.includes('.')),
];
