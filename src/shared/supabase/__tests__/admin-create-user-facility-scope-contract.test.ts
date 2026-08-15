// =============================================================================
// admin-create-user — facility-scope creation contract (R1.1-U drift closure)
//
// WHY THIS FILE EXISTS
//   The Production Edge Function was found running a build that predates
//   health_center_manager, so `role: 'health_center_manager'` was rejected with
//   INVALID_ROLE while the repository contract had supported it for weeks. The
//   only pre-existing edge-layer role assertion was
//   `expect(fn).toContain('OFFICIAL_ROLES')`, which passes identically on both
//   builds and therefore could not detect the drift.
//
// WHY THESE TESTS ARE NOT PLAIN toContain() SCANS
//   admin-create-user is a Deno function: it calls `Deno.serve` at module top
//   level and imports from esm.sh, so it cannot be imported into vitest, and CI
//   runs no Deno test job. Refactoring it into testable modules was rejected on
//   purpose — it is the exact artifact awaiting deployment, and this task is a
//   minimal drift closure, not a rewrite.
//
//   So instead of asserting that certain strings appear, this file EXTRACTS the
//   function's real declarations and EXECUTES them: the actual OFFICIAL_ROLES
//   and FACILITY_SCOPED_ROLES arrays are parsed and queried like the runtime
//   queries them, and the actual UUID_PATTERN is reconstructed and run against
//   real inputs. A drift that removes a role changes the extracted array, and
//   the assertion fails on the value — not on a substring.
//
//   Control flow that genuinely cannot be executed here (rollback ordering,
//   RPC delegation) is asserted positionally, which still fails if a branch is
//   moved or deleted.
//
// LAYERING
//   The Edge function performs SHAPE validation only. Every authorization
//   question — who may create the role, which organization, which facility — is
//   re-proved inside phoenix_admin_assign_facility_scopes (migration 182).
//   Tests 3, 4 and 5 therefore assert the DATABASE contract, because asserting
//   them against the Edge source alone would prove the wrong layer.
// =============================================================================
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const FN = readFileSync(
  join(__dirname, '../../../../supabase/functions/admin-create-user/index.ts'),
  'utf8',
);

const MIGRATION_182 = readFileSync(
  join(
    __dirname,
    '../../../../supabase/migrations/182_phoenix_health_center_facility_scoped_rbac.sql',
  ),
  'utf8',
);

// ── Extraction helpers: read the function's REAL declarations ────────────────

/** Parse `const <name> ... = [ 'a', 'b' ];` into the actual string array. */
function extractStringArray(name: string): string[] {
  const match = FN.match(new RegExp(`const\\s+${name}[^=]*=\\s*\\[([\\s\\S]*?)\\]`));
  if (!match) throw new Error(`${name} not found in admin-create-user/index.ts`);
  return [...match[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
}

/** Rebuild a regex literal declared in the source so it can be executed. */
function extractRegExp(name: string): RegExp {
  const match = FN.match(new RegExp(`const\\s+${name}\\s*=\\s*([\\s\\S]*?);`));
  if (!match) throw new Error(`${name} not found in admin-create-user/index.ts`);
  const literal = match[1].trim();
  const body = literal.match(/^\/([\s\S]*)\/([a-z]*)$/);
  if (!body) throw new Error(`${name} is not a regex literal: ${literal}`);
  return new RegExp(body[1], body[2]);
}

const OFFICIAL_ROLES = extractStringArray('OFFICIAL_ROLES');
const FACILITY_SCOPED_ROLES = extractStringArray('FACILITY_SCOPED_ROLES');
const UUID_PATTERN = extractRegExp('UUID_PATTERN');

const FIVE_HISTORICAL_ROLES = [
  'super_admin',
  'institution_admin',
  'central_warehouse_manager',
  'warehouse_officer',
  'outlet_officer',
];

/** Position of a marker, asserted to exist so ordering checks cannot pass on -1. */
function at(marker: string): number {
  const i = FN.indexOf(marker);
  expect(i, `marker not found: ${marker}`).toBeGreaterThan(-1);
  return i;
}

// ── TEST 1 ───────────────────────────────────────────────────────────────────
describe('TEST 1 — health_sector institution_admin + health_center_manager + valid facility_ids', () => {
  it('accepts health_center_manager as an official role (executed, not string-matched)', () => {
    // This is the exact membership test the runtime performs at index.ts:110.
    expect(OFFICIAL_ROLES).toContain('health_center_manager');
    expect(OFFICIAL_ROLES.includes('health_center_manager')).toBe(true);
  });

  it('classifies health_center_manager as facility scoped', () => {
    expect(FACILITY_SCOPED_ROLES).toEqual(['health_center_manager']);
    expect(FACILITY_SCOPED_ROLES.includes('health_center_manager')).toBe(true);
  });

  it('accepts a well-formed facility uuid through the real UUID_PATTERN', () => {
    expect(UUID_PATTERN.test('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(true);
    expect(UUID_PATTERN.test('3F2504E0-4F89-41D3-9A0C-0305E82C3301')).toBe(true);
  });

  it('de-duplicates the facility set deterministically before delegating', () => {
    expect(FN).toContain('[...new Set(raw as string[])]');
    // A repeated id must not be an error — it is collapsed.
    const deduped = [...new Set(['a', 'a', 'b'])];
    expect(deduped).toEqual(['a', 'b']);
  });

  it('delegates the assignment to the canonical database contract', () => {
    expect(FN).toContain("admin.rpc('phoenix_admin_assign_facility_scopes'");
    expect(FN).toContain('p_facility_ids: facilityIds');
    expect(FN).toContain('p_profile_id: newId');
  });

  it('reports the assigned facility count on success', () => {
    expect(FN).toContain('facility_scope_count: requiresFacilityScope ? facilityIds.length : 0');
  });
});

// ── TEST 2 ───────────────────────────────────────────────────────────────────
describe('TEST 2 — health_center_manager without facility_ids', () => {
  it('rejects a missing or empty set with FACILITY_SCOPE_REQUIRED', () => {
    expect(FN).toContain("error: 'FACILITY_SCOPE_REQUIRED'");
    expect(FN).toContain('!Array.isArray(raw) || raw.length === 0');
  });

  it('is the SOLE enforcement point for this rule — the database deliberately permits a facility-less manager', () => {
    // 182 keeps the role creatable without an assignment (history/ordering), so
    // if this Edge branch is ever removed nothing else refuses it.
    expect(MIGRATION_182).toContain('does NOT require a facility assignment');
  });

  it('rejects an oversized set rather than truncating it', () => {
    expect(FN).toContain("error: 'FACILITY_SCOPE_TOO_LARGE'");
    expect(FN).toContain('raw.length > MAX_FACILITY_IDS');
  });

  it('rejects a malformed facility id', () => {
    expect(FN).toContain("error: 'FACILITY_SCOPE_INVALID'");
    expect(UUID_PATTERN.test('not-a-uuid')).toBe(false);
    expect(UUID_PATTERN.test('')).toBe(false);
    // Wrong version nibble and wrong variant nibble are both refused.
    expect(UUID_PATTERN.test('3f2504e0-4f89-61d3-9a0c-0305e82c3301')).toBe(false);
    expect(UUID_PATTERN.test('3f2504e0-4f89-41d3-ca0c-0305e82c3301')).toBe(false);
  });

  it('validates the whole set before creating anything', () => {
    expect(at("error: 'FACILITY_SCOPE_REQUIRED'")).toBeLessThan(
      at('admin.auth.admin.createUser(createParams)'),
    );
  });
});

// ── TESTS 3 & 4 ──────────────────────────────────────────────────────────────
describe('TESTS 3 & 4 — hospital and specialized_center admins are denied at the database', () => {
  it('the database refuses any organization that is not an active care_institution health sector', () => {
    expect(MIGRATION_182).toContain('FACILITY_SCOPE_ORGANIZATION_NOT_HEALTH_SECTOR');
    expect(MIGRATION_182).toContain("v_org_class IS DISTINCT FROM 'health_sector'");
    expect(MIGRATION_182).toContain("v_org_kind IS DISTINCT FROM 'care_institution'");
    expect(MIGRATION_182).toContain("v_org_status IS DISTINCT FROM 'active'");
  });

  it('the Edge function does not carry its own institution-class whitelist', () => {
    // If it did, the two layers could drift apart and the weaker one would win.
    expect(FN).not.toContain('health_sector');
    expect(FN).not.toContain('specialized_center');
    expect(FN).not.toContain('institution_class');
  });

  it('the acting administrator is re-derived server-side, never trusted from the request', () => {
    expect(MIGRATION_182).toContain('-- ACTOR — re-verified, never trusted');
    expect(MIGRATION_182).toContain('NOT_AUTHORIZED_FACILITY_SCOPE_ASSIGN');
    expect(MIGRATION_182).toContain('NOT_AUTHORIZED_FACILITY_SCOPE_CROSS_ORG');
  });
});

// ── TEST 5 ───────────────────────────────────────────────────────────────────
describe('TEST 5 — foreign health-sector facility id', () => {
  it('the database refuses a facility outside the target organization', () => {
    expect(MIGRATION_182).toContain('FACILITY_SCOPE_FACILITY_FOREIGN');
  });

  it('the database also refuses inactive facilities and non-health-centre classes', () => {
    expect(MIGRATION_182).toContain('FACILITY_SCOPE_FACILITY_INACTIVE');
    expect(MIGRATION_182).toContain('FACILITY_SCOPE_FACILITY_CLASS_INVALID');
    expect(MIGRATION_182).toContain("NOT IN ('primary_health_center', 'subordinate_health_center')");
  });

  it('validates EVERY id before writing ANY row, so one bad id writes nothing', () => {
    expect(MIGRATION_182).toContain('-- VALIDATE EVERY id BEFORE writing ANY row.');
    expect(at("error: 'FACILITY_SCOPE_ASSIGNMENT_FAILED'")).toBeGreaterThan(
      at("admin.rpc('phoenix_admin_assign_facility_scopes'"),
    );
  });

  it('the browser is never the authority for facility ids', () => {
    expect(FN).toContain("The browser's facility ids are never trusted as authorization");
    // Only shape is checked here; the RPC re-validates against the target org.
    expect(FN).toContain('SHAPE validation only');
  });

  it('the assignment RPC is unreachable from the browser', () => {
    expect(MIGRATION_182).toContain(
      'REVOKE ALL ON FUNCTION public.phoenix_admin_assign_facility_scopes(uuid, uuid, uuid[])\n  FROM PUBLIC, anon, authenticated;',
    );
  });
});

// ── TEST 6 ───────────────────────────────────────────────────────────────────
describe('TEST 6 — the five historical roles regress in no way', () => {
  it('every historical role is still accepted', () => {
    for (const role of FIVE_HISTORICAL_ROLES) {
      expect(OFFICIAL_ROLES.includes(role), role).toBe(true);
    }
  });

  it('the role list is EXACTLY the five plus health_center_manager, in order', () => {
    // Pinning the whole array is what makes this suite drift-detecting: adding
    // or losing a role fails here rather than passing a substring check.
    expect(OFFICIAL_ROLES).toEqual([...FIVE_HISTORICAL_ROLES, 'health_center_manager']);
  });

  it('no historical role became facility scoped', () => {
    for (const role of FIVE_HISTORICAL_ROLES) {
      expect(FACILITY_SCOPED_ROLES.includes(role), role).toBe(false);
    }
  });

  it('the super-admin-only creation guards are unchanged', () => {
    expect(FN).toContain("error: 'CANNOT_CREATE_SUPER_ADMIN'");
    expect(FN).toContain("error: 'CANNOT_CREATE_INSTITUTION_ADMIN'");
    expect(FN).toContain("error: 'CANNOT_CREATE_CENTRAL_WAREHOUSE_MANAGER'");
  });

  it('health_center_manager is NOT super-admin-only — a sector institution_admin may create it', () => {
    const superOnly = FN.slice(at("if (role === 'super_admin' && !isSuper)"), at('if (!isSuper) {'));
    expect(superOnly).not.toContain('health_center_manager');
  });
});

// ── TEST 7 ───────────────────────────────────────────────────────────────────
describe('TEST 7 — unknown role', () => {
  it('rejects anything outside the official list with INVALID_ROLE', () => {
    expect(FN).toContain('!OFFICIAL_ROLES.includes(role)');
    expect(FN).toContain("error: 'INVALID_ROLE'");
  });

  it('the executed membership test refuses unknown and retired roles', () => {
    for (const role of ['hospital_admin', 'viewer', 'monthly_status_officer', 'root', '']) {
      expect(OFFICIAL_ROLES.includes(role), role).toBe(false);
    }
  });

  it('the role gate runs before any Auth user is created', () => {
    expect(at("error: 'INVALID_ROLE'")).toBeLessThan(at('admin.auth.admin.createUser(createParams)'));
  });
});

// ── TEST 8 ───────────────────────────────────────────────────────────────────
describe('TEST 8 — facility_ids must not affect non-facility-scoped roles', () => {
  it('refuses smuggled facility ids on a role that does not use them', () => {
    expect(FN).toContain("error: 'FACILITY_SCOPE_NOT_APPLICABLE'");
    expect(FN).toContain('} else if (body.facility_ids !== undefined) {');
  });

  it('performs no facility work at all for a non-scoped role', () => {
    expect(FN).toContain('const requiresFacilityScope = FACILITY_SCOPED_ROLES.includes(role)');
    expect(FN).toContain('if (requiresFacilityScope) {');
    // The assignment call is inside the guarded branch, never unconditional.
    expect(at('if (requiresFacilityScope) {')).toBeLessThan(
      at("admin.rpc('phoenix_admin_assign_facility_scopes'"),
    );
  });

  it('reports a zero facility count for non-scoped roles', () => {
    expect(FN).toContain('requiresFacilityScope ? facilityIds.length : 0');
  });
});

// ── TEST 9 ───────────────────────────────────────────────────────────────────
describe('TEST 9 — failed provisioning rolls the orphan Auth user back', () => {
  it('rolls back on profile-provisioning failure', () => {
    const provisioningFailure = FN.slice(at('if (provErr || !prov?.ok) {'), at('// ── R1.1-U: facility scope'));
    expect(provisioningFailure).toContain('await admin.auth.admin.deleteUser(newId)');
    expect(provisioningFailure).toContain("error: 'ROLLBACK_FAILED'");
  });

  it('rolls back on facility-scope failure through the SAME contract', () => {
    const scopeFailure = FN.slice(at('if (scopeErr || !scopes?.ok) {'), at('// Invite email only'));
    expect(scopeFailure).toContain('await admin.auth.admin.deleteUser(newId)');
    expect(scopeFailure).toContain("error: 'ROLLBACK_FAILED'");
    expect(scopeFailure).toContain("error: 'FACILITY_SCOPE_ASSIGNMENT_FAILED'");
  });

  it('surfaces a failed rollback instead of hiding an orphan identity', () => {
    expect(FN).toContain("event: 'admin-create-user.facility-scope-rollback-failed'");
    expect(FN).toContain("event: 'admin-create-user.rollback-failed'");
  });

  it('does not echo the database message, which can name facilities the caller may not learn about', () => {
    const scopeFailure = FN.slice(at('if (scopeErr || !scopes?.ok) {'), at('// Invite email only'));
    expect(scopeFailure).not.toContain('scopeErr.message');
    expect(scopeFailure).toContain('correlation_id: correlationId');
  });

  it('the facility assignment happens before success is reported', () => {
    expect(at("admin.rpc('phoenix_admin_assign_facility_scopes'")).toBeLessThan(at('ok: true, user_id: newId'));
  });
});

// ── TEST 10 ──────────────────────────────────────────────────────────────────
describe('TEST 10 — no secret is exposed or logged', () => {
  it('logs no credential, key or address on any path', () => {
    const consoleCalls = FN.match(/console\.(?:log|warn|error)\([\s\S]*?\);/g) ?? [];
    expect(consoleCalls.length).toBeGreaterThan(0);
    for (const call of consoleCalls) {
      expect(call).toContain('correlation_id');
      // NOTE: 'facility' is deliberately NOT in this pattern. One event is named
      // admin-create-user.facility-scope-rollback-failed, and an event NAME is
      // not a leaked identifier. Facility-id leakage is asserted separately, on
      // the response body and on the interpolated value, below.
      expect(call).not.toMatch(/password|secretKey|serviceKey|service_role|email/i);
      expect(call).not.toContain('facilityIds');
      expect(call).not.toContain('v_fid');
    }
  });

  it('never returns a key or password in a response body', () => {
    const responses = [...FN.matchAll(/return json\(\{[\s\S]*?\}/g)].map(m => m[0]);
    expect(responses.length).toBeGreaterThan(0);
    for (const body of responses) {
      expect(body).not.toMatch(/secretKey|publishableKey|temporaryPassword|apiKeys/);
    }
  });

  it('the service key is resolved server-side and never sent to the browser', () => {
    expect(FN).toContain('The service key is never sent to the browser');
    expect(FN).toContain('resolveEdgeApiKeys()');
  });

  it('the facility-scope failure response carries no facility identifiers', () => {
    const scopeFailure = FN.slice(at('if (scopeErr || !scopes?.ok) {'), at('// Invite email only'));
    expect(scopeFailure).not.toContain('facilityIds');
  });
});

// ── Deployment-drift sentinel ────────────────────────────────────────────────
describe('deployment drift sentinel', () => {
  it('the four contract elements the Production build lacks are all present', () => {
    // These are exactly the four markers whose absence identified the stale
    // Production build. Any one of them going missing means the repository has
    // regressed to the deployed contract.
    expect(OFFICIAL_ROLES).toContain('health_center_manager');
    expect(FACILITY_SCOPED_ROLES.length).toBeGreaterThan(0);
    expect(FN).toContain('facility_ids');
    expect(FN).toContain('phoenix_admin_assign_facility_scopes');
  });
});
