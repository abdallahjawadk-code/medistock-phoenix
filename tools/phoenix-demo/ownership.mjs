/**
 * PHOENIX_DEMO_V1 — manifest ownership capture.
 *
 * WHY DIFF-BASED CAPTURE RATHER THAN PER-RPC RETURN KEYS
 * A corridor RPC often writes several rows across several tables (a send
 * writes a shipment header, its lines, a ledger movement, a canonical event
 * and an audit row). Registering only what the RPC happens to RETURN would
 * leave the rest unowned — and an unowned row is exactly what blocks a purge
 * (a RESTRICT foreign key from a row the manifest does not know about) or,
 * worse, survives a purge as residue.
 *
 * So ownership is captured by DIFF: snapshot the ids a table holds for the
 * demo organizations before a workflow group, run the group through the real
 * corridors, then register every id that appeared. This is complete by
 * construction and cannot drift as RPC return shapes change.
 *
 * The org scope is what keeps it safe: only rows belonging to demo-owned
 * organizations are ever considered, so a concurrently-created REAL row can
 * never be captured into the demo manifest.
 */
import { DATASET_KEY } from './dataset.mjs';

/** Tables that carry organization_id directly and can be org-scoped. */
const ORG_SCOPED = new Set([
  'warehouse_stock', 'warehouse_stock_movements', 'outlet_stock', 'outlet_stock_movements',
  'warehouse_quarantine_stock', 'warehouse_quarantine_stock_movements',
  'warehouse_dispatches', 'outlet_return_requests', 'outlet_return_shipments',
  'procurement_orders', 'procurement_receipts', 'procurement_suppliers',
  'procurement_returns',
  'inventory_status_reports', 'stocktakes', 'phoenix_movement_events',
  // 158/159/160: same organization-scoped, RESTRICT-FK leaf shape as
  // phoenix_movement_events immediately above.
  'phoenix_outbox_events',
  'audit_logs', 'phoenix_notifications',
  'phoenix_stock_correction_requests', 'phoenix_warehouse_correction_requests',
  'item_availability', 'item_availability_movements',
  'phoenix_movement_dispense_context', 'warehouse_transfer_requests',
  // 119/141: official report snapshots. Without this the diff-capture would
  // never register a seeded snapshot, leaving it permanently unowned residue.
  'phoenix_report_snapshots',
]);

/**
 * The 141/142 write-once-marker tables. A row here can never be purged
 * (087/119's immutability triggers refuse it) unless it is also MARKED via
 * phoenix_demo_mark_row, which is a separate step from manifest registration.
 * Registering ownership alone is not enough for these seven tables.
 */
const MARKABLE_TABLES = new Set([
  'procurement_orders', 'procurement_order_lines', 'procurement_order_events',
  'procurement_receipts', 'procurement_receipt_lines', 'procurement_returns',
  'phoenix_report_snapshots',
]);

/**
 * Child tables reached through a parent, with the join that scopes them.
 * Keeping this explicit (rather than "everything in the table") is what stops
 * the capture from ever reaching a row outside the demo dataset.
 */
const CHILD_SCOPES = {
  warehouse_dispatch_lines:
    'SELECT l.id FROM warehouse_dispatch_lines l JOIN warehouse_dispatches h ON h.id=l.dispatch_id WHERE h.organization_id = ANY($1::uuid[])',
  outlet_return_request_lines:
    'SELECT l.id FROM outlet_return_request_lines l JOIN outlet_return_requests h ON h.id=l.return_request_id WHERE h.source_organization_id = ANY($1::uuid[])',
  outlet_return_shipment_lines:
    'SELECT l.id FROM outlet_return_shipment_lines l JOIN outlet_return_shipments h ON h.id=l.shipment_id WHERE h.source_organization_id = ANY($1::uuid[])',
  procurement_order_events:
    'SELECT e.id FROM procurement_order_events e JOIN procurement_orders h ON h.id=e.order_id WHERE h.organization_id = ANY($1::uuid[])',
  procurement_order_lines:
    'SELECT l.id FROM procurement_order_lines l JOIN procurement_orders h ON h.id=l.order_id WHERE h.organization_id = ANY($1::uuid[])',
  procurement_receipt_lines:
    'SELECT l.id FROM procurement_receipt_lines l JOIN procurement_receipts h ON h.id=l.receipt_id WHERE h.organization_id = ANY($1::uuid[])',
  inventory_status_report_lines:
    'SELECT l.id FROM inventory_status_report_lines l JOIN inventory_status_reports h ON h.id=l.report_id WHERE h.organization_id = ANY($1::uuid[])',
  stocktake_count_lines:
    'SELECT l.id FROM stocktake_count_lines l JOIN stocktakes h ON h.id=l.stocktake_id WHERE h.organization_id = ANY($1::uuid[])',
  warehouse_transfers:
    'SELECT t.id FROM warehouse_transfers t WHERE t.source_organization_id = ANY($1::uuid[]) OR t.destination_organization_id = ANY($1::uuid[])',
  warehouse_transfer_lines:
    'SELECT l.id FROM warehouse_transfer_lines l JOIN warehouse_transfers h ON h.id=l.transfer_id WHERE h.source_organization_id = ANY($1::uuid[]) OR h.destination_organization_id = ANY($1::uuid[])',
  warehouse_transfer_request_lines:
    'SELECT l.id FROM warehouse_transfer_request_lines l JOIN warehouse_transfer_requests h ON h.id=l.transfer_request_id WHERE h.source_organization_id = ANY($1::uuid[])',
};

/** Every table the capture understands, in no particular order. */
export const CAPTURED_TABLES = [...ORG_SCOPED, ...Object.keys(CHILD_SCOPES)];

function sqlFor(table) {
  if (CHILD_SCOPES[table]) return CHILD_SCOPES[table];
  if (table === 'outlet_return_requests' || table === 'outlet_return_shipments'
      || table === 'warehouse_transfer_requests') {
    return `SELECT id FROM ${table} WHERE source_organization_id = ANY($1::uuid[])`;
  }
  return `SELECT id FROM ${table} WHERE organization_id = ANY($1::uuid[])`;
}

/** Snapshot current ids per table, scoped to the demo organizations. */
export async function snapshotIds(io, orgIds, tables = CAPTURED_TABLES) {
  const snap = {};
  await io.asAdmin(async (c) => {
    for (const t of tables) {
      try {
        const r = await c.query(sqlFor(t), [orgIds]);
        snap[t] = new Set(r.rows.map(x => x.id));
      } catch {
        // Table absent in this schema version, or shaped differently — skip
        // rather than fail the seed; the lifecycle proof asserts residue is
        // zero, so a genuinely missed table would surface there loudly.
        snap[t] = new Set();
      }
    }
  });
  return snap;
}

/**
 * Register every id that appeared since `before`, as demo-owned.
 * Returns per-table counts of what was newly registered.
 */
export async function registerNewRows(io, superAdminId, orgIds, before, seedKey, tables = CAPTURED_TABLES) {
  const after = await snapshotIds(io, orgIds, tables);
  const added = {};
  for (const t of tables) {
    const prev = before[t] ?? new Set();
    const now = after[t] ?? new Set();
    const fresh = [...now].filter(id => !prev.has(id));
    if (fresh.length > 0) added[t] = fresh;
  }
  await io.asUser(superAdminId, async (c) => {
    for (const [table, ids] of Object.entries(added)) {
      for (const id of ids) {
        await c.query(`SELECT public.phoenix_demo_register($1,$2,$3,$4)`,
          [DATASET_KEY, table, id, seedKey]);
        // Registration alone leaves an immutable-family row permanently
        // unpurgeable (087/119's triggers gate DELETE on the write-once
        // marker, not on manifest membership). Mark it in the same
        // transaction so it converges to purgeable atomically with its
        // registration — never a state where it is owned but unmarked.
        if (MARKABLE_TABLES.has(table)) {
          await c.query(`SELECT public.phoenix_demo_mark_row($1,$2,$3)`,
            [DATASET_KEY, table, id]);
        }
      }
    }
  }, { commit: true });
  return Object.fromEntries(Object.entries(added).map(([t, ids]) => [t, ids.length]));
}
