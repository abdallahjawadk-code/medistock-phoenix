/**
 * RBAC-PHASE-2 — Phase F: observation matrix over the REAL surfaces.
 *
 * The application has no warehouse, stock or dispatch screens, so this matrix
 * covers only what actually exists: Reports (`reports.view`), the Audit tab
 * (`audit.view`), User management (`users.edit_scope` / `users.reset_permissions`)
 * and the authenticated route shell. Inventing screens to test would produce a
 * green matrix about nothing.
 *
 * Every case asserts the same invariant — `effective === legacy` — plus the
 * scoped answer and whether a mismatch is EXPECTED by the committed role
 * defaults. The expectations are derived from migration 062 section C2, not from
 * what the code happens to do.
 *
 * See fake-062-database.ts for what this fixture proves (the engine) and what it
 * does not (the database, which 062's own 44/44 suite covers).
 */
import { describe, it, expect } from 'vitest';
import { createAuthorizationService, type AuthzContext, type AuthzDecision } from '../authorization';
import { createFakeDb, createFakeTransport, type FakeDbState } from './fake-062-database';
import { roleDefaults } from '@/shared/lib/permissions';

const ORG = '11111111-1111-1111-1111-111111111111';

/** Migration 062 C2 — reports.view / audit.view / users.* for every role tested.
 *  An ABSENT key is false, and that absence is load-bearing for transfer_manager:
 *  062 grants it neither reports.view nor audit.view, while granting both to
 *  monthly_status_officer. */
const ROLE_DEFAULTS: FakeDbState['roleDefaults'] = {
  super_admin:            { 'reports.view': true,  'audit.view': true,  'users.edit_scope': true,  'users.reset_permissions': true },
  warehouse_officer:      { 'reports.view': true,  'audit.view': true,  'users.edit_scope': false, 'users.reset_permissions': false },
  institution_admin:      { 'reports.view': true,  'audit.view': true,  'users.edit_scope': true,  'users.reset_permissions': true },
  hospital_admin:         { 'reports.view': true,  'audit.view': true,  'users.edit_scope': true,  'users.reset_permissions': true },
  viewer:                 { 'reports.view': true,  'audit.view': true,  'users.edit_scope': false, 'users.reset_permissions': false },
  monthly_status_officer: { 'reports.view': true,  'audit.view': true,  'users.edit_scope': false, 'users.reset_permissions': false },
  // transfer_manager: reports.view and audit.view deliberately absent = denied.
  transfer_manager:       { 'users.edit_scope': false, 'users.reset_permissions': false },
};

interface Subject {
  label: string;
  id: string;
  role: string;
  status: 'active' | 'suspended';
}

const SUBJECTS: Subject[] = [
  { label: '1. super_admin',            id: 'p-super',  role: 'super_admin',            status: 'active' },
  { label: '2. warehouse_officer',      id: 'p-wh',     role: 'warehouse_officer',      status: 'active' },
  { label: '3. institution_admin',      id: 'p-inst',   role: 'institution_admin',      status: 'active' },
  { label: '4. hospital_admin',         id: 'p-hosp',   role: 'hospital_admin',         status: 'active' },
  { label: '5. viewer',                 id: 'p-view',   role: 'viewer',                 status: 'active' },
  { label: '6. monthly_status_officer', id: 'p-mso',    role: 'monthly_status_officer', status: 'active' },
  { label: '7. transfer_manager',       id: 'p-xfer',   role: 'transfer_manager',       status: 'active' },
];

/** The org-wide compatibility list from 062 D2 — these answer org-only questions. */
const ORG_WIDE = ['institution_admin', 'hospital_admin', 'monthly_status_officer', 'viewer'];

function world() {
  return createFakeDb({
    profiles: SUBJECTS.map(s => ({
      id: s.id, role: s.role, status: s.status, organization_id: ORG,
    })),
    warehouses: [], points: [], assignments: [],
    roleDefaults: ROLE_DEFAULTS,
    overrides: {},
  });
}

/** Legacy = the unscoped effective set the app uses today. */
function legacyFor(fake: ReturnType<typeof createFakeDb>, id: string): Set<string> {
  const keys = new Set<string>();
  for (const r of Object.values(ROLE_DEFAULTS)) for (const k of Object.keys(r)) keys.add(k);
  return new Set([...keys].filter(k => fake.hasGlobalPermission(id, k)));
}

function ctxFor(fake: ReturnType<typeof createFakeDb>, s: Subject): AuthzContext {
  return {
    authenticated: true, profileId: s.id, role: s.role,
    organizationId: ORG, legacyPermissions: legacyFor(fake, s.id),
  };
}

function svcFor(fake: ReturnType<typeof createFakeDb>, s: Subject, failWith?: 'NETWORK_ERROR') {
  const svc = createAuthorizationService({
    mode: 'shadow', transport: createFakeTransport(fake, { failWith }),
  });
  svc.setContext(ctxFor(fake, s));
  return svc;
}

/**
 * The expected scoped answer for an ORG-ONLY question (which is all four real
 * surfaces ask), derived from 062's rules rather than restated per role:
 *   rule 3 — active super_admin: always true.
 *   rule 8 — org-only question: only the org-wide roles may answer true...
 *   rule 4 — ...and only if they hold the key.
 */
function expectedScoped(role: string, key: string, fake: ReturnType<typeof createFakeDb>, id: string): boolean {
  if (role === 'super_admin') return true;
  if (!ORG_WIDE.includes(role)) return false;
  return fake.hasGlobalPermission(id, key);
}

const SURFACES: { route: string; key: string }[] = [
  { route: 'Reports',            key: 'reports.view' },
  { route: 'Reports → Audit',    key: 'audit.view' },
  { route: 'Users (scope admin)', key: 'users.edit_scope' },
  { route: 'Users (reset perms)', key: 'users.reset_permissions' },
];

describe('F. observation matrix — real surfaces only', () => {
  describe.each(SUBJECTS.map(s => [s.label, s] as const))('%s', (_l, subject) => {
    it.each(SURFACES.map(s => [s.route, s.key] as const))(
      '%s (%s): shadow never changes the effective answer',
      async (_route, key) => {
        const fake = world();
        const svc  = svcFor(fake, subject);
        const d: AuthzDecision = await svc.explainDecision(key, { organizationId: ORG });

        const legacy = fake.hasGlobalPermission(subject.id, key);
        const scoped = expectedScoped(subject.role, key, fake, subject.id);

        expect(d.legacy).toBe(legacy);
        expect(d.scoped).toBe(scoped);
        // The invariant this whole phase rests on.
        expect(d.allowed).toBe(legacy);
        expect(d.source).toBe('legacy');
        expect(d.mismatch).toBe(scoped !== legacy);
      },
    );
  });

  it('transfer_manager is denied reports.view and audit.view by BOTH engines', async () => {
    // The Phase B fix, observed end to end: 062 grants it neither key, and the
    // frontend no longer hands it monthly_status_officer's grants by
    // normalization. Both engines agree on deny — so there is no mismatch, and
    // enforcement would change nothing for this role.
    const fake = world();
    const svc  = svcFor(fake, SUBJECTS[6]);

    for (const key of ['reports.view', 'audit.view']) {
      const d = await svc.canForOrganization(key, ORG);
      expect(d.legacy).toBe(false);
      expect(d.scoped).toBe(false);
      expect(d.allowed).toBe(false);
      expect(d.mismatch).toBe(false);
    }
  });

  it('monthly_status_officer DOES hold both keys — the roles are genuinely different', async () => {
    // The control for the test above: if this failed, the fixture would be
    // asserting a divergence that does not exist.
    const fake = world();
    const svc  = svcFor(fake, SUBJECTS[5]);

    for (const key of ['reports.view', 'audit.view']) {
      const d = await svc.canForOrganization(key, ORG);
      expect(d.legacy).toBe(true);
      expect(d.scoped).toBe(true);
      expect(d.mismatch).toBe(false);
    }
  });

  it('warehouse_officer is the role a mismatch is EXPECTED for', async () => {
    // 062 grants it reports.view/audit.view but excludes it from the org-wide
    // list, so rule 8 denies the org-only question the real screens ask. This is
    // the divergence staging telemetry exists to quantify, and the reason
    // warehouse_officer enforcement is not close.
    const fake = world();
    const svc  = svcFor(fake, SUBJECTS[1]);

    for (const key of ['reports.view', 'audit.view']) {
      const d = await svc.explainDecision(key, { organizationId: ORG });
      expect(d.legacy).toBe(true);
      expect(d.scoped).toBe(false);
      expect(d.mismatch).toBe(true);
      expect(d.allowed).toBe(true); // ...and it is still not blocked.
    }
  });

  it('8. missing profile: fails closed in the scoped engine, legacy still governs', async () => {
    const fake = world();
    const svc = createAuthorizationService({ mode: 'shadow', transport: createFakeTransport(fake) });
    svc.setContext({
      authenticated: true, profileId: null, role: 'super_admin',
      organizationId: ORG, legacyPermissions: new Set(['reports.view']),
    });

    const d = await svc.canForOrganization('reports.view', ORG);
    expect(d.scoped).toBeNull();
    expect(d.scopedReason).toBe('PROFILE_UNAVAILABLE');
    expect(d.allowed).toBe(true);
    expect(d.allowed).toBe(d.legacy);
    expect(d.mismatch).toBe(false);
  });

  it('9. expired session: no protected access, and no mismatch reported', async () => {
    const fake = world();
    const svc = createAuthorizationService({ mode: 'shadow', transport: createFakeTransport(fake) });
    svc.setContext({
      authenticated: false, profileId: null, role: null,
      organizationId: null, legacyPermissions: new Set(),
    });

    for (const { key } of SURFACES) {
      const d = await svc.canForOrganization(key, ORG);
      expect(d.allowed).toBe(false);
      expect(d.scoped).toBeNull();
      expect(d.reason).toBe('NOT_AUTHENTICATED');
      expect(d.mismatch).toBe(false);
    }
  });

  it('10. scoped helper RPC failure: unknown, never deny, never allow, never a mismatch', async () => {
    const fake = world();
    for (const subject of SUBJECTS) {
      const svc = svcFor(fake, subject, 'NETWORK_ERROR');
      for (const { key } of SURFACES) {
        const d = await svc.canForOrganization(key, ORG);
        expect(d.scoped).toBeNull();
        expect(d.scopedReason).toBe('TEMPORARY_FAILURE');
        // Legacy behavior remains active, unchanged, for every role.
        expect(d.allowed).toBe(d.legacy);
        expect(d.mismatch).toBe(false);
      }
    }
  });
});

describe('F2. the route shell is observe-only for every role', () => {
  it('no role is gated by the scoped engine in shadow mode', async () => {
    const fake = world();
    for (const subject of SUBJECTS) {
      const svc = svcFor(fake, subject);
      const d = await svc.canForOrganization('reports.view', ORG);
      expect(d.source).toBe('legacy');
    }
  });

  it('the pilot gates super_admin ONLY, and leaves every other role legacy', async () => {
    const fake = world();
    for (const subject of SUBJECTS) {
      const svc = createAuthorizationService({
        mode: 'enforce_super_admin', transport: createFakeTransport(fake),
      });
      svc.setContext(ctxFor(fake, subject));
      const d = await svc.canForOrganization('reports.view', ORG);
      expect(`${subject.role}: ${d.source}`).toBe(
        `${subject.role}: ${subject.role === 'super_admin' ? 'scoped' : 'legacy'}`,
      );
    }
  });
});

describe('F3. the frontend fallback agrees with the matrix', () => {
  it('transfer_manager gets no reports/audit key from the hardcoded fallback either', () => {
    // The RPC-unavailable path. If this regressed, a degraded staging session
    // would hand transfer_manager exactly the grants 062 denies it.
    const d = roleDefaults('transfer_manager');
    expect(d.has('reports.view')).toBe(false);
    expect(d.has('audit.view')).toBe(false);
  });
});
