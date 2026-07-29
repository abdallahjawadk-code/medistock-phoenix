import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(__dirname, '../../../tools/pg-rig/phase9-reconciliation.sql'),
  'utf8',
);

describe('Phase 9 reconciliation is a local read-only diagnostic', () => {
  it('is parameterized by organization and contains no write or DDL statement', () => {
    expect(sql).toContain('$1');
    expect(sql).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|CREATE|DROP|GRANT|REVOKE|CALL|COPY)\b/i,
    );
  });

  it('reads only the three canonical movement ledgers', () => {
    for (const ledger of [
      'warehouse_stock_movements',
      'outlet_stock_movements',
      'warehouse_quarantine_stock_movements',
    ]) {
      expect(sql).toContain(`public.${ledger}`);
    }
    expect(sql).not.toContain('item_availability_movements');
    expect(sql).not.toContain('inventory_transfer_suggestions');
  });

  it('covers every requested anomaly class and all three corridors', () => {
    for (const anomaly of [
      'movement_without_expected_custody',
      'custody_without_reference_movement',
      'duplicate_movement_reference',
      'terminal_document_with_live_custody',
      'impossible_ledger_quantity',
      'impossible_custody_quantity',
    ]) {
      expect(sql).toContain(`'${anomaly}'`);
    }
    for (const corridor of [
      'central_to_institution',
      'warehouse_to_outlet',
      'outlet_to_warehouse',
    ]) {
      expect(sql).toContain(`'${corridor}'`);
    }
  });

  it('ties custody to real send movements, never to Draft or suggestion state', () => {
    expect(sql).toContain('l.source_movement_id = m.id');
    expect(sql).toContain("m.reference_type = 'warehouse_dispatch_send'");
    expect(sql).toContain("m.reference_type = 'outlet_return_send'");
    expect(sql).not.toMatch(/\bdraft_(?:warehouse|outlet)/);
    expect(sql).not.toMatch(/\bstatus\s*=\s*'accepted'/);
  });
});
