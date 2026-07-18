/**
 * PHASE-B-NETWORK-CONTRACTS-SUPPLY-ROUTES-075-A — static SQL contract tests.
 * CRLF-normalized, whitespace-agnostic, DB-free.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../../../');
const NAME = '075_phoenix_supply_route_rpcs.sql';
const sql = readFileSync(join(ROOT, 'supabase/migrations', NAME), 'utf8').replace(/\r\n?/g, '\n');
const norm = sql.replace(/\s+/g, ' ').trim();

function fn(name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  expect(start, `${name} must be defined`).toBeGreaterThan(-1);
  const end = sql.indexOf('\n$$;', start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end).replace(/\s+/g, ' ');
}

const ASSERT = fn('phoenix_supply_route_assert_endpoints');
const CREATE = fn('phoenix_create_supply_route');
const UPDATE = fn('phoenix_update_supply_route');
const ACTIVE = fn('phoenix_set_supply_route_active');

describe('075 identity, atomicity, additivity', () => {
  it('single transaction with begin/commit', () => {
    expect(norm.toLowerCase().includes('begin;')).toBe(true);
    expect(norm.toLowerCase().trimEnd().endsWith('commit;')).toBe(true);
  });
  it('fail-closed precondition guard', () => {
    expect(norm).toContain('ABORT 075');
    expect(norm).toMatch(/to_regclass\('public\.warehouse_supply_routes'\)/);
  });
  it('never drops/truncates/deletes', () => {
    expect(norm).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(norm).not.toMatch(/\bTRUNCATE\b/i);
    expect(norm).not.toMatch(/\bDELETE\s+FROM\b/i);
  });
});

describe('075 SECURITY DEFINER + fixed search_path on every function', () => {
  for (const [n, body] of [['assert', ASSERT], ['create', CREATE], ['update', UPDATE], ['active', ACTIVE]] as const) {
    it(`${n} is hardened`, () => {
      expect(body).toContain('SECURITY DEFINER');
      expect(body).toMatch(/SET search_path = public, pg_temp/);
    });
  }
});

describe('075 authority + route-shape invariants', () => {
  for (const [n, body] of [['create', CREATE], ['update', UPDATE], ['active', ACTIVE]] as const) {
    it(`${n} is super_admin only`, () => {
      expect(body).toMatch(/v_role IS DISTINCT FROM 'super_admin'/);
      expect(body).toContain('NOT_AUTHORIZED_SUPPLY_ROUTE');
    });
  }
  it('endpoints assert: source central, target institution, both active, no self-supply', () => {
    expect(ASSERT).toContain('SUPPLY_ROUTE_SELF');
    expect(ASSERT).toContain('SUPPLY_ROUTE_SOURCE_NOT_CENTRAL');
    expect(ASSERT).toContain('SUPPLY_ROUTE_TARGET_NOT_INSTITUTION');
    expect(ASSERT).toContain('SUPPLY_ROUTE_ENDPOINT_INACTIVE');
  });
  it('create verifies endpoints, priority >= 1, and one active primary per target', () => {
    expect(CREATE).toContain('phoenix_supply_route_assert_endpoints');
    expect(CREATE).toContain('SUPPLY_ROUTE_PRIORITY_INVALID');
    expect(CREATE).toContain('SUPPLY_ROUTE_PRIMARY_EXISTS');
    expect(CREATE).toContain('SUPPLY_ROUTE_EXISTS');
    expect(CREATE).toContain('pg_advisory_xact_lock');
  });
  it('reactivation re-verifies endpoints and primary/pair uniqueness', () => {
    expect(ACTIVE).toContain('phoenix_supply_route_assert_endpoints');
    expect(ACTIVE).toContain('SUPPLY_ROUTE_PRIMARY_EXISTS');
  });
});

describe('075 audit + ACL', () => {
  it('mutations write audit_logs with entity_type warehouse_supply_route', () => {
    for (const body of [CREATE, UPDATE, ACTIVE]) {
      expect(body).toContain('INSERT INTO audit_logs');
      expect(body).toContain("'warehouse_supply_route'");
    }
  });
  it('the internal endpoint assert is never granted to authenticated', () => {
    expect(norm).toMatch(/REVOKE ALL ON FUNCTION public\.phoenix_supply_route_assert_endpoints\(uuid, uuid\) FROM PUBLIC, anon;/);
    expect(norm).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.phoenix_supply_route_assert_endpoints/);
  });
  it('the three public RPCs revoke PUBLIC/anon and grant only authenticated', () => {
    for (const f of ['phoenix_create_supply_route', 'phoenix_update_supply_route', 'phoenix_set_supply_route_active']) {
      expect(norm).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${f}\\([^)]*\\) FROM PUBLIC, anon;`));
      expect(norm).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${f}\\([^)]*\\) TO authenticated;`));
    }
  });
  it('never grants anon, never references service_role', () => {
    expect(norm).not.toMatch(/GRANT[^;]*TO[^;]*anon/i);
    expect(norm).not.toMatch(/service_role/i);
  });
  it('has a postcondition VERIFY block', () => {
    expect(norm).toContain('VERIFY FAILED (075)');
  });
});
