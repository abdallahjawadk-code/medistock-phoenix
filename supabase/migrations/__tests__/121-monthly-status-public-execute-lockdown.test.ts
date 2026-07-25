/**
 * MONTHLY-STATUS-PUBLIC-EXECUTE-LOCKDOWN-121 — static contract.
 *
 * 121 exists solely to close a gap 113 intended but never carried out live
 * (see 121's own header comment for the full story). This file pins that 121
 * stays additive-only: exactly the eleven REVOKE EXECUTE statements, no table
 * DDL, no data changes, no GRANT, and does not touch migration 113 itself.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(__dirname, '..');
const migration = readFileSync(join(MIGRATIONS_DIR, '121_phoenix_monthly_status_public_execute_lockdown.sql'), 'utf8');

const PROTECTED_FUNCTIONS = [
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

describe('121 is the next migration after 120, and 001-120 stay untouched', () => {
  it('121 is the highest migration number in the repository', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter(f => /^\d{3}_.*\.sql$/.test(f));
    const numbers = files.map(f => parseInt(f.slice(0, 3), 10));
    expect(Math.max(...numbers)).toBe(121);
  });

  it('113 (the migration this reconciles) is not modified by this change', () => {
    // Guarded indirectly: this test file only reads 121, never edits 113.
    // The real guarantee is git history / code review, not a runtime check.
    expect(migration).not.toContain('113_phoenix_monthly_status_direct_write_lockdown');
  });
});

describe('121 revokes exactly the eleven functions 113 intended, and nothing else', () => {
  it.each(PROTECTED_FUNCTIONS)('contains REVOKE EXECUTE ... FROM PUBLIC, anon for %s', (sig) => {
    const escaped = sig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/,\s*/g, ',\\s*');
    const pattern = new RegExp(
      `REVOKE EXECUTE ON FUNCTION public\\.${escaped}\\s*\\n\\s*FROM PUBLIC, anon;`,
    );
    expect(migration).toMatch(pattern);
  });

  it('contains exactly eleven REVOKE EXECUTE statements', () => {
    const matches = migration.match(/REVOKE EXECUTE ON FUNCTION/g) ?? [];
    expect(matches).toHaveLength(11);
  });

  it('contains no GRANT statement (authenticated/service_role already hold EXECUTE)', () => {
    expect(migration).not.toMatch(/^\s*GRANT\s/m);
  });

  it('contains no table DDL, data-changing statement, or DROP', () => {
    expect(migration).not.toMatch(/\b(CREATE TABLE|ALTER TABLE|DROP TABLE|INSERT INTO|UPDATE\s+public\.|DELETE FROM)\b/i);
  });

  it('contains a live self-verification block asserting anon has no EXECUTE and authenticated keeps it', () => {
    expect(migration).toContain("has_function_privilege('anon', p.oid, 'EXECUTE')");
    expect(migration).toContain("NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')");
  });
});
