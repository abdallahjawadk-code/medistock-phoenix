/**
 * TRANSFER-SEND-FEFO-GUARDED-STATIC — registration + discipline contract
 * tests for 102. The behavioral proof is
 * 102-transfer-send-fefo-guarded.dynamic.test.ts (real Postgres, 001->102 replay).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const NAME = '102_phoenix_transfer_send_fefo_guarded.sql';

const load = (name: string) => {
  const sql = readFileSync(join(ROOT, 'supabase/migrations', name), 'utf8').replace(/\r\n?/g, '\n');
  const code = sql.slice(sql.indexOf('BEGIN;'), sql.indexOf('\nCOMMIT;')).replace(/^[ \t]*--.*$/gm, '');
  return { sql, code };
};

describe('registration and manual-apply discipline', () => {
  it('102 is registered and manual-apply-only', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(NAME);
    const { sql } = load(NAME);
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toMatch(/^BEGIN;/m);
    expect(sql).toMatch(/^COMMIT;/m);
  });
});

describe('102 — transfer-send FEFO guard', () => {
  const { code } = load(NAME);

  it('delegates the actual send to 068/088s unmodified RPC (no reimplementation)', () => {
    const occurrences = code.match(/public\.phoenix_send_warehouse_transfer_line\(/g) ?? [];
    // The precondition's to_regprocedure signature string, the override
    // branch's call, and the plain-delegation branch's call.
    expect(occurrences.length).toBe(3);
    expect(code).not.toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_send_warehouse_transfer_line\(/);
  });

  it('reuses the SAME inventory.fefo_override permission key 097 created — no second key', () => {
    expect(code).toMatch(/inventory\.fefo_override/);
    expect(code).not.toMatch(/INSERT INTO public\.permission_keys/);
  });

  it('extends the grant to central_warehouse_manager without touching warehouse_officers existing grant', () => {
    expect(code).toMatch(/\('central_warehouse_manager', 'inventory\.fefo_override', true\)/);
    expect(code).not.toMatch(/'warehouse_officer', 'inventory\.fefo_override'/);
  });

  it('fails closed by default: a non-earliest batch requires explicit override', () => {
    expect(code).toMatch(/fefo_override_required/);
    expect(code).toMatch(/IF NOT p_fefo_override THEN/);
  });

  it('requires a mandatory reason for the override, checked before the permission gate', () => {
    const reasonIdx = code.indexOf('fefo_override_reason_required');
    const permIdx = code.indexOf('forbidden_fefo_override');
    expect(reasonIdx).toBeGreaterThan(-1);
    expect(permIdx).toBeGreaterThan(-1);
    expect(reasonIdx).toBeLessThan(permIdx);
  });

  it('writes an audit_logs row only on the override path, not the compliant path', () => {
    const overrideBranch = code.slice(code.indexOf('IF NOT p_fefo_override THEN'), code.indexOf('RETURN v_result'));
    expect(overrideBranch).toMatch(/INSERT INTO public\.audit_logs/);
    const compliantBranch = code.slice(code.lastIndexOf('-- FEFO-compliant'));
    expect(compliantBranch).not.toMatch(/INSERT INTO public\.audit_logs/);
  });

  it('picks the FEFO-earliest lot from the SAME source warehouse as the stock being sent', () => {
    expect(code).toMatch(/phoenix_inventory_fefo_batches\(\s*\n?\s*v_stock\.organization_id, 'warehouse', v_stock\.warehouse_id,/);
  });

  it('does not touch 069/071 (return) or 087 (procurement) — no reference to their send/receive RPCs', () => {
    expect(code).not.toMatch(/phoenix_send_warehouse_return_shipment_line/);
    expect(code).not.toMatch(/phoenix_send_outlet_return_shipment_line/);
    expect(code).not.toMatch(/phoenix_procurement_/);
  });
});
