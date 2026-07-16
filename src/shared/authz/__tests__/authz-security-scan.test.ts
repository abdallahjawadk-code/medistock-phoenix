/**
 * PHASE-1-CONTROLLED-RBAC-ACTIVATION-SHADOW-MODE — security guardrails.
 *
 * Static scans over the real source tree. These do not test a mock; they assert
 * facts about what is actually committed, which is the only way to prove a
 * NEGATIVE ("no application code calls X") rather than a sample of positives.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join, extname, relative } from 'path';
import { TRIGGER_ONLY_FUNCTIONS, SCOPED_RBAC_RPCS } from '../scoped-permissions';

const SRC     = join(__dirname, '../../../');
const PHOENIX = join(__dirname, '../../../../');

/** Every .ts/.tsx file under src, tests included. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      walk(p, out);
    } else if (['.ts', '.tsx'].includes(extname(p))) {
      out.push(p);
    }
  }
  return out;
}

const SRC_FILES = walk(SRC);
const rel       = (p: string) => relative(PHOENIX, p).replace(/\\/g, '/');

/**
 * Read a file with its comments removed.
 *
 * This matters more than it looks. These scans must prove that no code INVOKES
 * a forbidden function — and a file that documents "we never call X" contains
 * the string X. Scanning raw text would either fail on honest documentation or,
 * far worse, be "fixed" by deleting the documentation. Stripping comments first
 * means the assertion is about what executes.
 */
function readCode(p: string): string {
  return readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')  // block comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1'); // line comments (not the // in a URL)
}

const readFile = (p: string) => readFileSync(p, 'utf8');

/** Application source = everything that ships. Tests and fixtures excluded. */
const APP_FILES = SRC_FILES.filter(p => !rel(p).includes('__tests__'));

describe('J. trigger-only functions are never invoked by the application', () => {
  it.each(TRIGGER_ONLY_FUNCTIONS)('no source code references %s', (fn) => {
    const offenders = SRC_FILES
      .filter(p => readCode(p).includes(fn))
      // This test and the catalog NAME the prohibited list in code, which is how
      // the prohibition is enforced. Naming is not invoking.
      .filter(p => !p.endsWith('authz-security-scan.test.ts'))
      .filter(p => !p.endsWith('scoped-permissions.ts'))
      .map(rel);

    expect(offenders).toEqual([]);
  });

  it('names all three trigger-only functions in the prohibition list', () => {
    expect([...TRIGGER_ONLY_FUNCTIONS]).toEqual([
      'phoenix_protect_last_super_admin',
      'phoenix_validate_ppo_scope',
      'phoenix_validate_profile_scope_assignment',
    ]);
  });

  it('no .rpc() call anywhere targets a trigger-only function', () => {
    for (const p of SRC_FILES) {
      const body = readFile(p);
      for (const fn of TRIGGER_ONLY_FUNCTIONS) {
        expect(body).not.toContain(`.rpc('${fn}'`);
        expect(body).not.toContain(`.rpc("${fn}"`);
      }
    }
  });
});

describe('the scoped-RBAC layer names only the committed helper functions', () => {
  it('uses the exact migration 062 function names', () => {
    expect(SCOPED_RBAC_RPCS.scopedPermission).toBe('phoenix_profile_has_scoped_permission');
    expect(SCOPED_RBAC_RPCS.warehouseAssignment).toBe('phoenix_profile_has_warehouse_assignment');
    expect(SCOPED_RBAC_RPCS.pointAssignment).toBe('phoenix_profile_has_point_assignment');
  });

  it('sends the exact committed argument names (PostgREST resolves by name)', () => {
    const src = readCode(join(SRC, 'shared/authz/rbac.service.ts'));
    for (const arg of [
      'p_profile_id', 'p_permission_key', 'p_organization_id',
      'p_warehouse_id', 'p_distribution_point_id',
    ]) {
      expect(src).toContain(arg);
    }
  });

  it('invents no alternate database function', () => {
    const src = readCode(join(SRC, 'shared/authz/rbac.service.ts'));
    // Every call site — as opposed to the helper's own declaration — must pass
    // a name from the committed constant, never a string literal.
    const callSites = [...src.matchAll(/(?<!function )callBooleanRpc\(\s*([A-Za-z_.]+)/g)]
      .map(m => m[1]);
    expect(callSites.length).toBe(3);
    for (const n of callSites) expect(n.startsWith('SCOPED_RBAC_RPCS.')).toBe(true);
  });

  it('is the only module in the authz layer that names a scoped RBAC function', () => {
    const helpers = Object.values(SCOPED_RBAC_RPCS);
    const offenders = APP_FILES
      .filter(p => rel(p).startsWith('src/shared/authz/'))
      .filter(p => !p.endsWith('rbac.service.ts') && !p.endsWith('scoped-permissions.ts'))
      .filter(p => helpers.some(h => readCode(p).includes(h)))
      .map(rel);

    expect(offenders).toEqual([]);
  });
});

describe('no service-role key reaches the frontend', () => {
  it('no shipped frontend file references a service-role key', () => {
    // APP_FILES, not SRC_FILES: several existing test files legitimately name
    // these tokens in order to assert this very guardrail (and the admin edge
    // function, which is Deno and does not ship to the browser, reads
    // SUPABASE_SERVICE_ROLE_KEY by design). What must hold is that no code the
    // browser downloads contains one.
    const forbidden = [
      'SERVICE_ROLE', 'service_role', 'serviceRoleKey',
      'SUPABASE_SERVICE_KEY', 'VITE_PHOENIX_SUPABASE_SERVICE', 'auth.admin',
    ];
    for (const p of APP_FILES) {
      const body = readFile(p);
      for (const token of forbidden) {
        expect(`${rel(p)}: ${body.includes(token)}`).toBe(`${rel(p)}: false`);
      }
    }
  });

  it('the authz layer uses the anon client only', () => {
    const src = readCode(join(SRC, 'shared/authz/rbac.service.ts'));
    expect(src).toContain("from '../supabase/client'");
    expect(src).not.toContain('createClient');
  });
});

describe('the scoped engine cannot become a grant on failure', () => {
  it('no failure branch in the transport returns allowed: true', () => {
    const src = readCode(join(SRC, 'shared/authz/rbac.service.ts'));
    // Every ok:false is an error result and carries no `allowed` at all.
    const failures = [...src.matchAll(/\{\s*ok:\s*false[^}]*\}/g)].map(m => m[0]);
    expect(failures.length).toBeGreaterThan(0);
    for (const f of failures) expect(f).not.toContain('allowed');
  });

  it('a non-boolean RPC response is not read as a grant', () => {
    const src = readCode(join(SRC, 'shared/authz/rbac.service.ts'));
    expect(src).toContain('return data === true;');
  });
});

describe('no anon access and no broad write grant is introduced', () => {
  it('the authz layer performs no database write of any kind', () => {
    for (const p of APP_FILES.filter(f => rel(f).startsWith('src/shared/authz/'))) {
      const code = readCode(p);
      // A supabase query-builder chain reaching a write verb. Matched as a
      // CHAIN rather than as a bare `.delete(` because the engine's cache is a
      // Map, and `inflight.delete(key)` is not a database write — a scan that
      // could not tell those apart would be noise, and noise gets suppressed.
      expect(`${rel(p)}: ${/\.from\([^)]*\)[\s\S]{0,300}?\.(insert|update|upsert|delete)\(/.test(code)}`)
        .toBe(`${rel(p)}: false`);
      // These have no non-database meaning here, so they are banned outright.
      for (const write of ['.insert(', '.upsert(']) {
        expect(`${rel(p)} ${write}: ${code.includes(write)}`).toBe(`${rel(p)} ${write}: false`);
      }
    }
  });

  it('the only table the authz layer reads is profile_scope_assignments', () => {
    const src = readCode(join(SRC, 'shared/authz/rbac.service.ts'));
    const tables = [...src.matchAll(/\.from\('([^']+)'\)/g)].map(m => m[1]);
    expect(tables).toEqual(['profile_scope_assignments']);
  });

  it('every scoped check requires an authenticated context first', () => {
    const src = readCode(join(SRC, 'shared/authz/authorization.ts'));
    // Both guards return before any RPC, and neither can yield a grant: `value`
    // is the scoped answer, and null means "unknown", which every caller treats
    // as not-allowed.
    expect(src).toMatch(/if \(!ctx\.authenticated\)\s+return \{ value: null, reason: 'NOT_AUTHENTICATED' \};/);
    expect(src).toMatch(/if \(!ctx\.profileId\)\s+return \{ value: null, reason: 'PROFILE_UNAVAILABLE' \};/);
    // The pilot opens only on an explicit true — never on unknown.
    expect(src).toContain('const allowed = enforcing ? scoped === true : legacy;');
  });
});

describe('no permission decision rests on hidden UI alone', () => {
  it('the gate obeys the service, and the service is the only decider', () => {
    const gate = readCode(join(SRC, 'shared/authz/PhoenixPermissionGate.tsx'));
    // No role literal branching, no local permission arithmetic.
    expect(gate).not.toMatch(/role\s*===\s*'super_admin'/);
    expect(gate).toContain('useAuthzDecision');
  });

  it('the route guard derives enforcement solely from scopedEngineEnforcesRole', () => {
    const guard = readCode(join(SRC, 'shared/authz/ScreenAuthzGuard.tsx'));
    expect(guard).toContain('scopedEngineEnforcesRole(scopedRbacMode, role)');
    // No hand-rolled second opinion about who is a super_admin.
    expect(guard).not.toMatch(/===\s*'super_admin'/);
  });

  it('no role is granted a permission merely for being a legacy role', () => {
    // The engine must never map a role to permissions locally. The DB decides.
    const engine = readCode(join(SRC, 'shared/authz/authorization.ts'));
    for (const role of [
      'transfer_manager', 'warehouse_manager', 'point_operator',
      'hospital_admin', 'institution_admin', 'warehouse_officer', 'viewer',
    ]) {
      expect(`${role}: ${engine.includes(`'${role}'`)}`).toBe(`${role}: false`);
    }
    // super_admin appears only as the pilot boundary, never as a grant.
    expect(engine).not.toContain("role === 'super_admin' ? true");
  });
});

describe('no SQL, migration or deployment surface is touched', () => {
  it('no authz source file writes SQL', () => {
    for (const p of APP_FILES.filter(f => rel(f).startsWith('src/shared/authz/'))) {
      const body = readCode(p);
      for (const sql of ['CREATE POLICY', 'CREATE FUNCTION', 'ALTER TABLE', 'GRANT ', 'DROP ']) {
        expect(`${rel(p)}: ${body.includes(sql)}`).toBe(`${rel(p)}: false`);
      }
    }
  });

  // PROFILE-IDENTITY-SNAPSHOT-RETURN-TYPE-064-A: the historical
  // `migration 064 does not exist` ceiling is removed. It asserted a property of
  // the NEXT free migration number rather than of this phase, so a legitimate,
  // separately-reviewed 064 broke an authz guard that 064 does not touch.
  //
  // This file's real security subject is unchanged and still fully enforced
  // above and below: authz source writes no SQL, authors no migration, never
  // widens a privilege, and never leaks service-role credentials. Whether a
  // migration is approved is decided by exact-filename membership in
  // REVIEWED_MIGRATION_FILES and asserted in reviewed-migration-manifest.test.ts,
  // plus that migration's own tests and the SQL safety guards.

  it('migrations 060-063 are present and are not authored by this phase', () => {
    const dir = join(PHOENIX, 'supabase/migrations');
    for (const n of ['060', '061', '062', '063']) {
      expect(readdirSync(dir).some(f => f.startsWith(n))).toBe(true);
    }
    // The protected untracked paths stay out of the authz layer's business.
    expect(existsSync(join(PHOENIX, 'premium-preview.html'))).toBe(true);
  });
});
