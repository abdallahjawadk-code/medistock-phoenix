/**
 * PHASE-B-NETWORK-CONTRACTS-SCOPE-ASSIGN-076-A — static SQL contract tests.
 * CRLF-normalized, whitespace-agnostic, DB-free. Focus: authority, the cross-org
 * IDOR guard, idempotency, mandatory revoke reason, and 062's audit contract.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../../../');
const NAME = '076_phoenix_profile_scope_assignment_rpcs.sql';
const sql = readFileSync(join(ROOT, 'supabase/migrations', NAME), 'utf8').replace(/\r\n?/g, '\n');
const norm = sql.replace(/\s+/g, ' ').trim();

function fn(name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  expect(start, `${name} must be defined`).toBeGreaterThan(-1);
  const end = sql.indexOf('\n$$;', start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end).replace(/\s+/g, ' ');
}

const ASSIGN = fn('phoenix_assign_profile_scope');
const REVOKE = fn('phoenix_revoke_profile_scope');

describe('076 identity, atomicity, additivity', () => {
  it('single transaction with begin/commit', () => {
    expect(norm.toLowerCase().includes('begin;')).toBe(true);
    expect(norm.toLowerCase().trimEnd().endsWith('commit;')).toBe(true);
  });
  it('fail-closed precondition guard referencing 062 objects', () => {
    expect(norm).toContain('ABORT 076');
    expect(norm).toMatch(/to_regclass\('public\.profile_scope_assignments'\)/);
    expect(norm).toContain('phoenix_validate_profile_scope_assignment');
  });
  it('never drops/truncates/deletes (revocation is a state change, not a DELETE)', () => {
    expect(norm).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(norm).not.toMatch(/\bTRUNCATE\b/i);
    expect(norm).not.toMatch(/\bDELETE\s+FROM\b/i);
  });
});

describe('076 both RPCs are SECURITY DEFINER with fixed search_path', () => {
  for (const [n, body] of [['assign', ASSIGN], ['revoke', REVOKE]] as const) {
    it(`${n} is hardened`, () => {
      expect(body).toContain('SECURITY DEFINER');
      expect(body).toMatch(/SET search_path = public, pg_temp/);
    });
  }
});

describe('076 authority + cross-org IDOR guard', () => {
  it('assign requires super_admin or users.edit_scope', () => {
    expect(ASSIGN).toMatch(/phoenix_profile_has_permission\(v_actor, 'users\.edit_scope'\)/);
    expect(ASSIGN).toContain('NOT_AUTHORIZED_SCOPE_ASSIGN');
  });
  it('assign blocks a non-super caller from acting across organizations', () => {
    expect(ASSIGN).toMatch(/NOT v_is_super AND public\.phoenix_my_org\(\) IS DISTINCT FROM v_profile_org/);
    expect(ASSIGN).toContain('NOT_AUTHORIZED_SCOPE_ASSIGN_CROSS_ORG');
  });
  it('assign derives organization_id from the profile (never from the caller input)', () => {
    expect(ASSIGN).toMatch(/organization_id[\s\S]*v_profile_org/);
    expect(ASSIGN).toContain('SELECT organization_id INTO v_profile_org FROM public.profiles');
  });
  it('revoke enforces the same authority and cross-org guard', () => {
    expect(REVOKE).toContain('NOT_AUTHORIZED_SCOPE_REVOKE');
    expect(REVOKE).toContain('NOT_AUTHORIZED_SCOPE_REVOKE_CROSS_ORG');
  });
  it('scope_type is validated to warehouse|distribution_point', () => {
    expect(ASSIGN).toMatch(/NOT IN \('warehouse', 'distribution_point'\)/);
  });
});

describe('076 idempotency + mandatory revoke reason', () => {
  it('assign is idempotent on an existing active assignment (no duplicate, no error)', () => {
    expect(ASSIGN).toContain('idempotent_replay');
    expect(ASSIGN).toContain('pg_advisory_xact_lock');
  });
  it('revoke requires a non-empty reason and is idempotent on already-revoked rows', () => {
    expect(REVOKE).toContain('SCOPE_REVOKE_REASON_REQUIRED');
    expect(REVOKE).toContain('idempotent_replay');
  });
  it('revoke is a state change: sets is_active false + revoked_by/at/reason', () => {
    expect(REVOKE).toMatch(/is_active = false, revoked_by = v_actor, revoked_at = now\(\), revoke_reason = v_reason/);
  });
});

describe('076 audit contract (062) + ACL', () => {
  it('assign writes audit action scope_assigned on profile_scope_assignment', () => {
    expect(ASSIGN).toContain("'scope_assigned', 'profile_scope_assignment'");
  });
  it('revoke writes audit action scope_revoked with the reason', () => {
    expect(REVOKE).toContain("'scope_revoked', 'profile_scope_assignment'");
    expect(REVOKE).toMatch(/jsonb_build_object\('reason', v_reason\)/);
  });
  it('both RPCs revoke PUBLIC/anon and grant only authenticated', () => {
    for (const f of ['phoenix_assign_profile_scope', 'phoenix_revoke_profile_scope']) {
      expect(norm).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${f}\\([^)]*\\) FROM PUBLIC, anon;`));
      expect(norm).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${f}\\([^)]*\\) TO authenticated;`));
    }
  });
  it('never grants anon, never references service_role', () => {
    expect(norm).not.toMatch(/GRANT[^;]*TO[^;]*anon/i);
    expect(norm).not.toMatch(/service_role/i);
  });
  it('has a postcondition VERIFY block', () => {
    expect(norm).toContain('VERIFY FAILED (076)');
  });
});
