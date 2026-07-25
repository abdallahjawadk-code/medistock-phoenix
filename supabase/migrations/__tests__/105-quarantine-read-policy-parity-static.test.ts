/**
 * QUARANTINE-READ-POLICY-DISPOSITION-PARITY-STATIC — registration + discipline
 * contract tests for 105. The behavioral proof is the dynamic test (real
 * Postgres, 001->105 replay).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const NAME = '105_phoenix_quarantine_read_policy_disposition_parity.sql';

const load = (name: string) => {
  const sql = readFileSync(join(ROOT, 'supabase/migrations', name), 'utf8').replace(/\r\n?/g, '\n');
  const code = sql.slice(sql.indexOf('BEGIN;'), sql.indexOf('\nCOMMIT;')).replace(/^[ \t]*--.*$/gm, '');
  return { sql, code };
};

describe('registration and manual-apply discipline', () => {
  it('105 is registered and manual-apply-only', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(NAME);
    const { sql } = load(NAME);
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toMatch(/^BEGIN;/m);
    expect(sql).toMatch(/^COMMIT;/m);
  });
});

describe('105 — quarantine read-policy disposition parity', () => {
  const { code } = load(NAME);

  it('touches exactly the two SELECT policies, no RPC, no table', () => {
    expect(code).not.toMatch(/CREATE OR REPLACE FUNCTION/);
    expect(code).not.toMatch(/CREATE TABLE/);
    const policies = code.match(/CREATE POLICY (\w+)/g) ?? [];
    expect(policies).toEqual(['CREATE POLICY wqs_select_scoped', 'CREATE POLICY wqsm_select_scoped']);
  });

  it('adds warehouse_transfer.return_request as a third OR-branch on both policies, preserving the original two', () => {
    for (const marker of ['ON public.warehouse_quarantine_stock FOR SELECT', 'ON public.warehouse_quarantine_stock_movements FOR SELECT']) {
      const idx = code.indexOf(marker);
      const block = code.slice(idx, code.indexOf(');', idx));
      expect(block).toMatch(/'warehouse_transfer\.return_receive'/);
      expect(block).toMatch(/'warehouse_transfer\.review_return'/);
      expect(block).toMatch(/'warehouse_transfer\.return_request'/);
    }
  });
});
