/**
 * PHASE-B-NETWORK-CONTRACTS-WAREHOUSE-074-A — static SQL contract tests.
 *
 * CRLF-normalized and whitespace-agnostic, so they run identically on every
 * platform/CI. No DB connection: they assert the migration's security shape.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../../../');
const NAME = '074_phoenix_warehouse_management_rpcs.sql';
const sql = readFileSync(join(ROOT, 'supabase/migrations', NAME), 'utf8').replace(/\r\n?/g, '\n');
const norm = sql.replace(/\s+/g, ' ').trim();

function fn(name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  expect(start, `${name} must be defined`).toBeGreaterThan(-1);
  const end = sql.indexOf('\n$$;', start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end).replace(/\s+/g, ' ');
}

const CREATE = fn('phoenix_create_warehouse');
const UPDATE = fn('phoenix_update_warehouse');
const ACTIVE = fn('phoenix_set_warehouse_active');

describe('074 identity, atomicity, additivity', () => {
  it('is a single transaction with begin/commit', () => {
    expect(norm.startsWith('begin;') || norm.includes(' begin; ') || norm.toLowerCase().includes('begin;')).toBe(true);
    expect(norm.toLowerCase().trimEnd().endsWith('commit;')).toBe(true);
  });
  it('has a fail-closed precondition guard that ABORTs', () => {
    expect(norm).toContain('ABORT 074');
    expect(norm).toMatch(/to_regclass\('public\.warehouses'\)/);
  });
  it('never drops or truncates anything', () => {
    expect(norm).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(norm).not.toMatch(/\bTRUNCATE\b/i);
    expect(norm).not.toMatch(/\bDELETE\s+FROM\b/i);
  });
});

describe('074 every RPC is SECURITY DEFINER with a fixed search_path', () => {
  for (const [n, body] of [['create', CREATE], ['update', UPDATE], ['active', ACTIVE]] as const) {
    it(`${n} is SECURITY DEFINER + search_path = public, pg_temp`, () => {
      expect(body).toContain('SECURITY DEFINER');
      expect(body).toMatch(/SET search_path = public, pg_temp/);
    });
  }
});

describe('074 authority is super_admin only', () => {
  for (const [n, body] of [['create', CREATE], ['update', UPDATE], ['active', ACTIVE]] as const) {
    it(`${n} rejects non super_admin`, () => {
      expect(body).toMatch(/v_role IS DISTINCT FROM 'super_admin'/);
      expect(body).toContain('NOT_AUTHORIZED_WAREHOUSE_MANAGE');
    });
  }
});

describe('074 correctness guards', () => {
  it('create validates warehouse_kind and requires both names', () => {
    expect(CREATE).toMatch(/NOT IN \('central', 'institution'\)/);
    expect(CREATE).toContain('WAREHOUSE_NAME_REQUIRED');
  });
  it('create serializes one-active-main-per-org under an advisory lock', () => {
    expect(CREATE).toContain('pg_advisory_xact_lock');
    expect(CREATE).toContain('WAREHOUSE_MAIN_EXISTS');
  });
  it('create enforces per-org code uniqueness with a clean error', () => {
    expect(CREATE).toContain('WAREHOUSE_CODE_EXISTS');
  });
  it('deactivate clears is_main and refuses archived warehouses', () => {
    expect(ACTIVE).toMatch(/is_main = CASE WHEN p_active THEN is_main ELSE false END/);
    expect(ACTIVE).toContain('WAREHOUSE_ARCHIVED');
  });
});

describe('074 audit + ACL', () => {
  it('every RPC writes audit_logs with entity_type warehouse', () => {
    for (const body of [CREATE, UPDATE, ACTIVE]) {
      expect(body).toContain('INSERT INTO audit_logs');
      expect(body).toContain("'warehouse'");
    }
  });
  it('revokes PUBLIC/anon and grants only authenticated for all three', () => {
    for (const f of ['phoenix_create_warehouse', 'phoenix_update_warehouse', 'phoenix_set_warehouse_active']) {
      expect(norm).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${f}\\([^)]*\\) FROM PUBLIC, anon;`));
      expect(norm).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${f}\\([^)]*\\) TO authenticated;`));
    }
  });
  it('never grants anon and never references service_role', () => {
    expect(norm).not.toMatch(/GRANT[^;]*TO[^;]*anon/i);
    expect(norm).not.toMatch(/service_role/i);
  });
  it('has a postcondition VERIFY block that fails on PUBLIC/anon executability', () => {
    expect(norm).toContain('VERIFY FAILED (074)');
  });
});
