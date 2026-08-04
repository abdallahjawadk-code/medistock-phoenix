/**
 * TRANSFER-CORRIDOR-PRIVILEGE-LOCKDOWN-STATIC — registration + scope +
 * discipline contract tests for 154. The behavioral proof (real privilege
 * matrix, live bypass attempts, canonical-RPC-path proof) is
 * 154-transfer-corridor-privilege-lockdown.dynamic.test.ts (real Postgres,
 * 001->154 replay).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES, getMaximumReviewedMigrationNumber } from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const NAME = '154_phoenix_transfer_corridor_privilege_lockdown.sql';

const TARGET_TABLES = [
  'warehouse_transfer_requests',
  'warehouse_transfer_request_lines',
  'warehouse_transfers',
  'warehouse_transfer_lines',
] as const;

const load = (name: string) => {
  const sql = readFileSync(join(ROOT, 'supabase/migrations', name), 'utf8').replace(/\r\n?/g, '\n');
  const code = sql.slice(sql.indexOf('BEGIN;'), sql.indexOf('\nCOMMIT;')).replace(/^[ \t]*--.*$/gm, '');
  return { sql, code };
};

// ============================================================================
// Item 1: migration numbering/sequencing
// ============================================================================

describe('1. migration numbering and sequencing', () => {
  it('154 is registered', () => {
    // "is the current reviewed maximum" was dropped from this assertion:
    // TRANSFER-SEND-RECEIVE-LIFECYCLE-NOTIFICATIONS-155,
    // OUTLET-RETURN-LINE-IDEMPOTENCY-156, and
    // OUTLET-RETURN-EXCEPTION-RESOLUTION-157 (this branch) moved the ceiling
    // forward, and that ceiling is reviewed-migration-manifest.test.ts's own
    // claim to track (section 3), not a fact this file should duplicate and
    // inevitably go stale on again at the next migration.
    expect(REVIEWED_MIGRATION_FILES).toContain(NAME);
    expect(getMaximumReviewedMigrationNumber()).toBeGreaterThanOrEqual(154);
  });

  it('154 is manual-apply-only and wraps a single BEGIN;/COMMIT; transaction', () => {
    const { sql } = load(NAME);
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toMatch(/^BEGIN;/m);
    expect(sql).toMatch(/^COMMIT;/m);
    // Exactly one transaction — no nested/second BEGIN.
    expect(sql.match(/^BEGIN;/gm)?.length).toBe(1);
    expect(sql.match(/^COMMIT;/gm)?.length).toBe(1);
  });

  it('068, 108 and 109 (the migrations this gap analysis is built on) are still present and non-empty — 154 never edits a historical migration in place', () => {
    for (const historical of [
      '068_phoenix_central_to_institution_supply.sql',
      '108_phoenix_custody_chain_direct_write_lockdown.sql',
      '109_phoenix_public_schema_default_privileges_lockdown.sql',
    ]) {
      const sql = readFileSync(join(ROOT, 'supabase/migrations', historical), 'utf8');
      // A loose sanity check that each historical file still parses as SQL —
      // the real non-mutation guarantee is that this test suite (and 154
      // itself) never opens 068/108/109 for writing, only reading.
      expect(sql.length).toBeGreaterThan(1000);
      expect(sql).toMatch(/CREATE (OR REPLACE )?FUNCTION|REVOKE/);
    }
  });
});

// ============================================================================
// Items 2-7: scope and discipline of the migration's actual SQL body
// ============================================================================

describe('154 — transfer-corridor privilege lockdown scope and discipline', () => {
  const { code } = load(NAME);

  it('targets exactly the four named tables — one REVOKE statement per table, nothing else', () => {
    const revokeMatches = [
      ...code.matchAll(/REVOKE\s+INSERT,\s*UPDATE,\s*DELETE,\s*TRUNCATE,\s*TRIGGER,\s*REFERENCES\s+ON TABLE public\.(\w+)\s+FROM authenticated, anon, PUBLIC;/g),
    ].map(m => m[1]);
    expect(revokeMatches.sort()).toEqual([...TARGET_TABLES].sort());
  });

  it('every REVOKE statement names all six dangerous privileges together, from all three grantees together', () => {
    for (const table of TARGET_TABLES) {
      const re = new RegExp(
        `REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES\\s+ON TABLE public\\.${table}\\s+FROM authenticated, anon, PUBLIC;`,
      );
      expect(code, `expected exact REVOKE clause for ${table}`).toMatch(re);
    }
  });

  it('contains no risky GRANT statement anywhere (this migration is REVOKE-only)', () => {
    expect(code).not.toMatch(/\bGRANT\b/i);
  });

  it('contains no CASCADE anywhere', () => {
    expect(code).not.toMatch(/\bCASCADE\b/i);
  });

  it('touches no RLS policy (no CREATE/ALTER/DROP POLICY)', () => {
    expect(code).not.toMatch(/\b(CREATE|ALTER|DROP)\s+POLICY\b/i);
    expect(code).not.toMatch(/\bENABLE\s+ROW\s+LEVEL\s+SECURITY\b/i);
    expect(code).not.toMatch(/\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i);
  });

  it('touches no RBAC permission or role default (no role_permission_defaults / profile_permission_overrides / profile_scope_assignments / ALTER ROLE)', () => {
    expect(code).not.toMatch(/role_permission_defaults/);
    expect(code).not.toMatch(/profile_permission_overrides/);
    expect(code).not.toMatch(/profile_scope_assignments/);
    expect(code).not.toMatch(/\bALTER\s+ROLE\b/i);
    expect(code).not.toMatch(/\bCREATE\s+ROLE\b/i);
  });

  it('touches no ownership (no ALTER TABLE ... OWNER TO, no ALTER FUNCTION ... OWNER TO)', () => {
    expect(code).not.toMatch(/OWNER\s+TO/i);
  });

  it('touches no function body (no CREATE FUNCTION / CREATE OR REPLACE FUNCTION / DROP FUNCTION / ALTER FUNCTION)', () => {
    expect(code).not.toMatch(/\bCREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b/i);
    expect(code).not.toMatch(/\bDROP\s+FUNCTION\b/i);
    expect(code).not.toMatch(/\bALTER\s+FUNCTION\b/i);
  });

  it('touches no table/column/constraint/index schema (no CREATE TABLE, ALTER TABLE ADD/DROP/ALTER COLUMN, CREATE INDEX, ADD/DROP CONSTRAINT)', () => {
    expect(code).not.toMatch(/\bCREATE\s+TABLE\b/i);
    expect(code).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(code).not.toMatch(/\bALTER\s+TABLE\b.*\b(ADD|DROP|ALTER)\s+COLUMN\b/is);
    expect(code).not.toMatch(/\bADD\s+CONSTRAINT\b/i);
    expect(code).not.toMatch(/\bDROP\s+CONSTRAINT\b/i);
    expect(code).not.toMatch(/\bCREATE\s+(UNIQUE\s+)?INDEX\b/i);
  });

  it('touches no ALTER DEFAULT PRIVILEGES statement (109 already owns that mechanism)', () => {
    expect(code).not.toMatch(/ALTER\s+DEFAULT\s+PRIVILEGES/i);
  });

  it('never mentions service_role (this migration is about client-facing roles only)', () => {
    expect(code).not.toMatch(/service_role/);
  });

  it('writes no data (no INSERT/UPDATE/DELETE DML statement against application data)', () => {
    // The VERIFY block's own SELECT/ASSERT statements are read-only; this
    // checks there is no top-level data-mutating DML in the migration body.
    expect(code).not.toMatch(/^\s*INSERT\s+INTO\b/im);
    expect(code).not.toMatch(/^\s*UPDATE\s+public\./im);
    expect(code).not.toMatch(/^\s*DELETE\s+FROM\b/im);
  });

  it('carries a fail-closed VERIFY block inside the transaction, asserting the six dangerous privileges are false and SELECT is preserved', () => {
    expect(code).toMatch(/DO\s+\$\$/);
    expect(code).toMatch(/ASSERT\s+NOT\s+has_table_privilege/);
    expect(code).toMatch(/ASSERT\s+has_table_privilege\('authenticated',\s*'public\.'\s*\|\|\s*v_t,\s*'SELECT'\)/);
  });

  it('the VERIFY block also asserts every canonical Route-1 RPC remains present, SECURITY DEFINER, and EXECUTE-granted to authenticated only', () => {
    expect(code).toMatch(/ASSERT\s+v_fn_count\s*>=\s*1/);
    expect(code).toMatch(/prosecdef/);
    expect(code).toMatch(/has_function_privilege\('authenticated',\s*p\.oid,\s*'EXECUTE'\)/);
    expect(code).toMatch(/has_function_privilege\('anon',\s*p\.oid,\s*'EXECUTE'\)/);
  });

  it('the VERIFY block asserts no authenticated-facing INSERT/UPDATE/ALL policy was introduced (no new direct mutation policy)', () => {
    expect(code).toMatch(/cmd IN \('INSERT', 'UPDATE', 'ALL'\)/);
    expect(code).toMatch(/'authenticated' = ANY\(roles\)/);
  });
});
