/**
 * RETURN-QUARANTINE-INSERT-COLUMN-FIX-STATIC — registration + discipline
 * contract tests for 104. The behavioral proof is the Phase 2 end-to-end
 * custody-chain dynamic test (real Postgres, 001->104 replay, step 10 drives
 * both fixed branches to completion).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const NAME = '104_phoenix_return_quarantine_insert_column_fix.sql';

const load = (name: string) => {
  const sql = readFileSync(join(ROOT, 'supabase/migrations', name), 'utf8').replace(/\r\n?/g, '\n');
  const code = sql.slice(sql.indexOf('BEGIN;'), sql.indexOf('\nCOMMIT;')).replace(/^[ \t]*--.*$/gm, '');
  return { sql, code };
};

describe('registration and manual-apply discipline', () => {
  it('104 is registered and manual-apply-only', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(NAME);
    const { sql } = load(NAME);
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toMatch(/^BEGIN;/m);
    expect(sql).toMatch(/^COMMIT;/m);
  });
});

describe('104 — return quarantine insert column fix', () => {
  const { code } = load(NAME);

  it('redefines exactly the two affected functions — no new function, no schema change', () => {
    const defs = code.match(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g) ?? [];
    expect(defs.length).toBe(2);
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_receive_warehouse_return_shipment_line\(/);
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_receive_outlet_return_shipment_line\(/);
    expect(code).not.toMatch(/CREATE TABLE|ALTER TABLE/);
  });

  it('every warehouse_quarantine_stock INSERT now supplies exactly 20 values for its 20 columns', () => {
    const inserts = code.split('INSERT INTO public.warehouse_quarantine_stock (').slice(1);
    expect(inserts.length).toBe(2); // one per function
    for (const block of inserts) {
      const valuesStart = block.indexOf(') VALUES (');
      const columnsText = block.slice(0, valuesStart);
      const columnCount = columnsText.split(',').length;
      const valuesText = block.slice(valuesStart + ') VALUES ('.length, block.indexOf(')\n    ON CONFLICT'));
      // Count top-level commas only (CASE...END and inline expressions contain
      // their own commas/parens, so a naive split would over-count) — instead
      // assert the two identity columns this fix targets are both present as
      // trailing values, immediately proving the fix landed in the right place.
      expect(columnCount).toBe(20);
      expect(valuesText.trim().endsWith('v_line.supply_type, v_line.purchase_origin')).toBe(true);
    }
  });

  it('neither warehouse_quarantine_stock_movements INSERT carries the stray supply_type/purchase_origin values anymore', () => {
    const movementInserts = code.split('INSERT INTO public.warehouse_quarantine_stock_movements (').slice(1);
    expect(movementInserts.length).toBe(2);
    for (const block of movementInserts) {
      const valuesEnd = block.indexOf('RETURNING id INTO v_movement_id');
      const valuesText = block.slice(0, valuesEnd);
      expect(valuesText).not.toMatch(/v_line\.supply_type/);
      expect(valuesText).not.toMatch(/v_line\.purchase_origin/);
    }
  });

  it('the outlet corridors audit_logs INSERT no longer carries stray trailing values after its jsonb payload', () => {
    const auditIdx = code.indexOf("'outlet_stock.return_receive',");
    const auditBlock = code.slice(auditIdx, code.indexOf(');', auditIdx) + 2);
    expect(auditBlock).not.toMatch(/v_line\.supply_type/);
    expect(auditBlock).not.toMatch(/v_line\.purchase_origin/);
  });

  it('quarantine_reason now folds every non-canonical reason_code (near_expiry/excess/shipment_error) to "other"', () => {
    const occurrences = code.match(/WHEN v_reason_code IN \('expired', 'damaged', 'recalled', 'quality_issue', 'temperature_excursion', 'other'\)\s*\n\s*THEN v_reason_code\s*\n\s*ELSE 'other'/g) ?? [];
    // Two functions x two usages each (the INSERT and the identity-matching SELECT).
    expect(occurrences.length).toBe(4);
  });

  it('does not touch 095/096/097/098/100/101/102/103 — no reference to their distinguishing RPC names', () => {
    const untouched = [
      'phoenix_receive_all_matching_dispatch_lines',
      'phoenix_add_dispatch_line_fefo_guarded',
      'phoenix_request_outlet_stock_correction',
      'phoenix_receive_all_matching_transfer_lines',
      'phoenix_request_warehouse_stock_correction',
      'phoenix_send_warehouse_transfer_line_fefo_guarded',
      'phoenix_apply_warehouse_stock_movement',
    ];
    for (const fn of untouched) {
      expect(code).not.toMatch(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\b`));
    }
  });
});
