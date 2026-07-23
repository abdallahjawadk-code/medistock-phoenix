/**
 * INSTITUTION-WAREHOUSE-NO-DIRECT-ENTRY-STATIC — registration + discipline
 * contract tests for 103. The behavioral proof is
 * 103-institution-warehouse-no-direct-entry.dynamic.test.ts (real Postgres,
 * 001->103 replay, includes the RPC-bypass proof).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const NAME = '103_phoenix_institution_warehouse_no_direct_entry.sql';

const load = (name: string) => {
  const sql = readFileSync(join(ROOT, 'supabase/migrations', name), 'utf8').replace(/\r\n?/g, '\n');
  const code = sql.slice(sql.indexOf('BEGIN;'), sql.indexOf('\nCOMMIT;')).replace(/^[ \t]*--.*$/gm, '');
  return { sql, code };
};

describe('registration and manual-apply discipline', () => {
  it('103 is registered and manual-apply-only', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(NAME);
    const { sql } = load(NAME);
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toMatch(/^BEGIN;/m);
    expect(sql).toMatch(/^COMMIT;/m);
  });
});

describe('103 — institution warehouse no direct entry', () => {
  const { code } = load(NAME);

  it('redefines phoenix_receive_warehouse_stock and phoenix_apply_warehouse_stock_movement only — no new function, no new table', () => {
    const defs = code.match(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g) ?? [];
    expect(defs.length).toBe(2);
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_receive_warehouse_stock\(/);
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_apply_warehouse_stock_movement\(/);
    expect(code).not.toMatch(/CREATE TABLE/);
  });

  it('receive fails closed for anything but a central warehouse, checked before the permission gate', () => {
    const kindCheckIdx = code.indexOf('institution_warehouse_direct_receipt_forbidden');
    const permCheckIdx = code.indexOf('forbidden_warehouse_stock_adjust');
    expect(kindCheckIdx).toBeGreaterThan(-1);
    expect(permCheckIdx).toBeGreaterThan(-1);
    expect(kindCheckIdx).toBeLessThan(permCheckIdx);
  });

  it('apply restricts add/subtract/set_exact to central only, and explicitly excludes correction', () => {
    const guardIdx = code.indexOf("IF p_movement_type IN ('add', 'subtract', 'set_exact') THEN");
    expect(guardIdx).toBeGreaterThan(-1);
    const guardBlock = code.slice(guardIdx, code.indexOf('END IF;', guardIdx) + 'END IF;'.length);
    expect(guardBlock).toMatch(/institution_warehouse_direct_adjustment_forbidden/);
    expect(guardBlock).not.toMatch(/'correction'/);
  });

  it('does not touch the 078 guarded wrappers directly — they inherit the check by delegation', () => {
    expect(code).not.toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_receive_warehouse_stock_guarded/);
    expect(code).not.toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_apply_warehouse_stock_movement_guarded/);
  });

  it('does not touch 068/069/070/071/087/098/099/100/101/102 canonical corridor functions', () => {
    const untouched = [
      'phoenix_receive_warehouse_transfer_line',
      'phoenix_receive_warehouse_return_shipment_line',
      'phoenix_receive_outlet_dispatch_line',
      'phoenix_receive_outlet_return_shipment_line',
      'phoenix_procurement_receive_order',
      'phoenix_approve_outlet_stock_correction',
      'phoenix_approve_warehouse_stock_correction',
      'phoenix_release_quarantine_stock',
      'phoenix_receive_all_matching_dispatch_lines',
      'phoenix_send_warehouse_transfer_line_fefo_guarded',
    ];
    for (const fn of untouched) {
      expect(code).not.toMatch(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\b`));
    }
  });
});
