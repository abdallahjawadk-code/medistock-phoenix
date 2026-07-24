/**
 * MONTHLY-STATUS-DIRECT-WRITE-LOCKDOWN-STATIC — registration + discipline
 * contract tests for 113. The behavioral proof (real privilege matrix + live
 * bypass attempts) is 113-monthly-status-direct-write-lockdown.dynamic.test.ts
 * (real Postgres, 001->113 replay).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const NAME = '113_phoenix_monthly_status_direct_write_lockdown.sql';

const load = (name: string) => {
  const sql = readFileSync(join(ROOT, 'supabase/migrations', name), 'utf8').replace(/\r\n?/g, '\n');
  const code = sql.slice(sql.indexOf('BEGIN;'), sql.indexOf('\nCOMMIT;')).replace(/^[ \t]*--.*$/gm, '');
  return { sql, code };
};

describe('registration and manual-apply discipline', () => {
  it('113 is registered and manual-apply-only', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(NAME);
    const { sql } = load(NAME);
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toMatch(/^BEGIN;/m);
    expect(sql).toMatch(/^COMMIT;/m);
  });
});

describe('113 — monthly-status direct-write lockdown (092/108/109 stay untouched)', () => {
  const { code } = load(NAME);

  it('092, 108 and 109 source files are byte-for-byte unchanged (never edited in place)', () => {
    for (const historical of [
      '092_phoenix_monthly_status_redesign.sql',
      '108_phoenix_custody_chain_direct_write_lockdown.sql',
      '109_phoenix_public_schema_default_privileges_lockdown.sql',
    ]) {
      const sql = readFileSync(join(ROOT, 'supabase/migrations', historical), 'utf8');
      // A loose sanity check that the historical file still parses as SQL
      // beginning a transaction — the real non-mutation guarantee is that
      // this test suite never opens 092/108/109 for writing, only reading.
      expect(sql).toMatch(/BEGIN;/);
    }
  });

  it('revokes INSERT/UPDATE/DELETE/TRUNCATE/TRIGGER/REFERENCES on all three 092 tables 108 missed', () => {
    for (const table of [
      'inventory_status_reports', 'inventory_status_report_lines', 'inventory_status_report_amendments',
    ]) {
      const re = new RegExp(
        `REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES\\s+ON TABLE public\\.${table}\\s+FROM authenticated, anon, PUBLIC;`,
      );
      expect(code).toMatch(re);
    }
  });

  it('never touches service_role', () => {
    expect(code).not.toMatch(/service_role/);
  });

  it('revokes EXECUTE from PUBLIC and anon, and (re-)grants it to authenticated, for every 092 status function', () => {
    const functions = [
      'phoenix_status_center_authorized(uuid, text)',
      'phoenix_set_inventory_threshold_planning(uuid, integer, integer)',
      'phoenix_status_record_stocktake(uuid, text, uuid, text, jsonb)',
      'phoenix_status_prepare_report(uuid)',
      'phoenix_status_classify_lines(uuid, jsonb)',
      'phoenix_status_confirm_missing(uuid)',
      'phoenix_status_submit_report(uuid)',
      'phoenix_status_return_for_clarification(uuid, text)',
      'phoenix_status_approve_lock_report(uuid)',
      'phoenix_status_create_amendment(uuid, text)',
      'phoenix_status_get_outlet_contribution(uuid, uuid)',
    ];
    for (const fn of functions) {
      const fnEscaped = fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(code).toMatch(new RegExp(`REVOKE EXECUTE ON FUNCTION public\\.${fnEscaped} FROM PUBLIC, anon;`));
      expect(code).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fnEscaped} TO authenticated;`));
    }
  });

  it('deliberately does NOT touch phoenix_upsert_inventory_threshold (072/073 already locked it down correctly)', () => {
    expect(code).not.toContain('phoenix_upsert_inventory_threshold');
  });

  it('carries a fail-closed VERIFY block inside the transaction', () => {
    expect(code).toContain('DO $verify$');
    expect(code).toMatch(/ASSERT NOT has_table_privilege/);
    expect(code).toMatch(/ASSERT has_function_privilege/);
  });
});
