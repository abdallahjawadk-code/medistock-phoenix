/**
 * PHASE-1-CONTROLLED-RBAC-ACTIVATION-SHADOW-MODE — authorization matrix.
 *
 * Drives the central authorization service across the role matrix committed in
 * migration 062, through the fake-062 transport (see fake-062-database.ts for
 * exactly what that fixture does and does not prove).
 *
 * The load-bearing assertion in almost every case below is the SAME one:
 * `decision.allowed === decision.legacy`. That is shadow mode. A scoped denial
 * is recorded in `decision.scoped` and reported as a mismatch — and changes
 * nothing.
 */
import { describe, it, expect, vi } from 'vitest';
import { createAuthorizationService, type AuthzContext } from '../authorization';
import { createShadowReporter } from '../diagnostics';
import { createFakeDb, createFakeTransport, type FakeDbState } from './fake-062-database';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const WH_A1 = 'aaaaaaaa-0000-0000-0000-000000000001';
const WH_A2 = 'aaaaaaaa-0000-0000-0000-000000000002';
const WH_B1 = 'bbbbbbbb-0000-0000-0000-000000000001';
const PT_A1 = 'cccccccc-0000-0000-0000-000000000001';

/** Migration 062 section C2, transcribed for the roles under test. */
const ROLE_DEFAULTS: FakeDbState['roleDefaults'] = {
  super_admin: {
    'warehouse_stock.view': true, 'warehouse_stock.adjust': true,
    'warehouse_stock.correct': true, 'warehouse_stock.movements_view': true,
    'reports.view': true, 'reports.financial': true, 'reports.export': true,
    'audit.view': true, 'users.edit_scope': true, 'users.reset_permissions': true,
    'warehouse_dispatch.accept': true, 'warehouse_dispatch.reject': true,
  },
  warehouse_officer: {
    'warehouse_stock.view': true, 'warehouse_stock.adjust': true,
    'warehouse_stock.correct': true, 'warehouse_stock.movements_view': true,
    'reports.view': true, 'audit.view': true,
    'reports.financial': false, 'reports.export': false,
    'users.edit_scope': false, 'users.reset_permissions': false,
    'warehouse_dispatch.accept': false, 'warehouse_dispatch.reject': false,
    'warehouses.manage': false,
  },
  institution_admin: {
    'warehouse_stock.view': true, 'warehouse_stock.movements_view': true,
    'warehouse_stock.adjust': false, 'warehouse_stock.correct': false,
    'reports.view': true, 'reports.financial': true, 'reports.export': true,
    'audit.view': true, 'users.edit_scope': true, 'users.reset_permissions': true,
  },
  hospital_admin: {
    'warehouse_stock.view': true, 'warehouse_stock.movements_view': true,
    'warehouse_stock.adjust': false, 'warehouse_stock.correct': false,
    'reports.view': true, 'reports.financial': true, 'reports.export': true,
    'audit.view': true, 'users.edit_scope': true, 'users.reset_permissions': true,
  },
  viewer: {
    'warehouse_stock.view': true, 'warehouse_stock.movements_view': true,
    'reports.view': true, 'audit.view': true,
    'warehouse_stock.adjust': false, 'warehouse_stock.correct': false,
    'reports.financial': false, 'reports.export': false,
    'users.edit_scope': false, 'users.reset_permissions': false,
  },
  transfer_manager: {
    'warehouse_stock.view': false, 'warehouse_stock.adjust': false,
    'warehouse_stock.correct': false, 'warehouse_stock.movements_view': false,
    'reports.financial': false, 'reports.export': false,
    'users.edit_scope': false, 'users.reset_permissions': false,
  },
};

const PROFILES = {
  super:   { id: 'p-super',   role: 'super_admin',        status: 'active' as const, organization_id: ORG_A },
  officer: { id: 'p-officer', role: 'warehouse_officer',  status: 'active' as const, organization_id: ORG_A },
  instAdm: { id: 'p-inst',    role: 'institution_admin',  status: 'active' as const, organization_id: ORG_A },
  hospAdm: { id: 'p-hosp',    role: 'hospital_admin',     status: 'active' as const, organization_id: ORG_A },
  viewer:  { id: 'p-viewer',  role: 'viewer',             status: 'active' as const, organization_id: ORG_A },
  transfer:{ id: 'p-xfer',    role: 'transfer_manager',   status: 'active' as const, organization_id: ORG_A },
};

function world(overrides: Partial<FakeDbState> = {}) {
  return createFakeDb({
    profiles: Object.values(PROFILES),
    warehouses: [
      { id: WH_A1, organization_id: ORG_A, status: 'active' },
      { id: WH_A2, organization_id: ORG_A, status: 'active' },
      { id: WH_B1, organization_id: ORG_B, status: 'active' },
    ],
    points: [{ id: PT_A1, organization_id: ORG_A, status: 'active' }],
    // The officer is assigned to WH_A1 only. WH_A2 is the unassigned control.
    assignments: [
      { profile_id: PROFILES.officer.id, scope_type: 'warehouse', organization_id: ORG_A, warehouse_id: WH_A1, is_active: true },
    ],
    roleDefaults: ROLE_DEFAULTS,
    overrides: {},
    ...overrides,
  });
}

/** The legacy set = what get_effective_permissions returns today: UNSCOPED. */
function legacyPermissions(fake: ReturnType<typeof createFakeDb>, profileId: string): Set<string> {
  const keys = new Set<string>();
  for (const role of Object.values(ROLE_DEFAULTS)) for (const k of Object.keys(role)) keys.add(k);
  return new Set([...keys].filter(k => fake.hasGlobalPermission(profileId, k)));
}

function ctxFor(fake: ReturnType<typeof createFakeDb>, p: typeof PROFILES[keyof typeof PROFILES]): AuthzContext {
  return {
    authenticated: true,
    profileId: p.id,
    role: p.role,
    organizationId: p.organization_id,
    legacyPermissions: legacyPermissions(fake, p.id),
  };
}

function serviceFor(
  fake: ReturnType<typeof createFakeDb>,
  p: typeof PROFILES[keyof typeof PROFILES],
  opts: { mode?: 'off' | 'shadow' | 'enforce_super_admin'; failWith?: 'NETWORK_ERROR' } = {},
) {
  const svc = createAuthorizationService({
    mode: opts.mode ?? 'shadow',
    transport: createFakeTransport(fake, { failWith: opts.failWith }),
  });
  svc.setContext(ctxFor(fake, p));
  return svc;
}

/* ── A. super_admin ──────────────────────────────────────────────────────── */

describe('A. super_admin', () => {
  it('global read permissions succeed, scoped agrees with legacy', async () => {
    const fake = world();
    const svc = serviceFor(fake, PROFILES.super);

    for (const key of ['warehouse_stock.view', 'reports.view', 'audit.view']) {
      const d = await svc.canForOrganization(key, ORG_A);
      expect(d.allowed).toBe(true);
      expect(d.scoped).toBe(true);
      expect(d.mismatch).toBe(false);
    }
  });

  it('retains global authority across organizations and unassigned warehouses (062 rule 3)', async () => {
    const fake = world();
    const svc = serviceFor(fake, PROFILES.super);

    // Another org's warehouse, and no assignment anywhere: still true.
    const foreign = await svc.canForWarehouse('warehouse_stock.view', ORG_B, WH_B1);
    expect(foreign.scoped).toBe(true);
    const unassigned = await svc.canForWarehouse('warehouse_stock.view', ORG_A, WH_A2);
    expect(unassigned.scoped).toBe(true);
  });

  it('a suspended super_admin authorizes nothing (rule 2 precedes rule 3)', async () => {
    const fake = world({
      profiles: [{ ...PROFILES.super, status: 'suspended' }],
    });
    const svc = createAuthorizationService({ mode: 'shadow', transport: createFakeTransport(fake) });
    svc.setContext({ ...ctxFor(fake, PROFILES.super), legacyPermissions: new Set(['reports.view']) });

    const d = await svc.canForOrganization('reports.view', ORG_A);
    expect(d.scoped).toBe(false);
    // Still shadow: the legacy answer is what the app obeys.
    expect(d.allowed).toBe(true);
    expect(d.mismatch).toBe(true);
  });

  it('enforce_super_admin routes the decision through the scoped engine', async () => {
    const fake = world();
    const svc = serviceFor(fake, PROFILES.super, { mode: 'enforce_super_admin' });

    const d = await svc.canForOrganization('reports.view', ORG_A);
    expect(d.source).toBe('scoped');
    expect(d.allowed).toBe(true);
  });

  it('missing session fails closed under the pilot, and never escalates', async () => {
    const fake = world();
    const svc = createAuthorizationService({
      mode: 'enforce_super_admin', transport: createFakeTransport(fake),
    });
    // Session gone, but a stale legacy permission set still in hand.
    svc.setContext({
      authenticated: false, profileId: null, role: null, organizationId: null,
      legacyPermissions: new Set(['reports.view']),
    });

    const d = await svc.explainDecision('reports.view', { organizationId: ORG_A });
    // The engine could not answer — and "could not answer" is not "false".
    expect(d.scoped).toBeNull();
    expect(d.scopedReason).toBe('NOT_AUTHENTICATED');
    // role is null → not the pilot role → nothing here invented a super_admin.
    expect(d.source).toBe('legacy');
    // ...and an unknown is never reported as a disagreement.
    expect(d.mismatch).toBe(false);
  });

  it('profile unavailable under the pilot is distinguishable and fails closed', async () => {
    const fake = world();
    const svc = createAuthorizationService({
      mode: 'enforce_super_admin', transport: createFakeTransport(fake),
    });
    svc.setContext({
      authenticated: true, profileId: null, role: 'super_admin',
      organizationId: ORG_A, legacyPermissions: new Set(['reports.view']),
    });

    const d = await svc.canForOrganization('reports.view', ORG_A);
    expect(d.source).toBe('scoped');
    expect(d.allowed).toBe(false);   // fail closed
    expect(d.scoped).toBeNull();
    expect(d.reason).toBe('PROFILE_UNAVAILABLE');
  });
});

/* ── B. warehouse_officer ────────────────────────────────────────────────── */

describe('B. warehouse_officer', () => {
  it('assigned warehouse stock view succeeds', async () => {
    const fake = world();
    const svc = serviceFor(fake, PROFILES.officer);

    const d = await svc.canForWarehouse('warehouse_stock.view', ORG_A, WH_A1);
    expect(d.scoped).toBe(true);
    expect(d.allowed).toBe(true);
    expect(d.mismatch).toBe(false);
  });

  it('unassigned warehouse stock view is scoped-denied but NOT blocked in shadow', async () => {
    const fake = world();
    const svc = serviceFor(fake, PROFILES.officer);

    const d = await svc.canForWarehouse('warehouse_stock.view', ORG_A, WH_A2);
    expect(d.scoped).toBe(false);
    expect(d.legacy).toBe(true);   // today's engine has no scope concept
    expect(d.allowed).toBe(true);  // ...and today's engine still decides
    expect(d.mismatch).toBe(true);
    expect(d.source).toBe('legacy');
  });

  it('explainDecision names the missing assignment', async () => {
    const fake = world();
    const svc = serviceFor(fake, PROFILES.officer);

    const d = await svc.explainDecision('warehouse_stock.view', { organizationId: ORG_A, warehouseId: WH_A2 });
    expect(d.scopedReason).toBe('ASSIGNMENT_MISSING');
    // Shadow: the EFFECTIVE reason still describes the legacy allow.
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('ALLOWED');
  });

  it('adjust and correct follow the committed defaults on the assigned warehouse', async () => {
    const fake = world();
    const svc = serviceFor(fake, PROFILES.officer);

    // 062 C2 grants warehouse_officer BOTH adjust and correct.
    expect((await svc.canForWarehouse('warehouse_stock.adjust', ORG_A, WH_A1)).scoped).toBe(true);
    expect((await svc.canForWarehouse('warehouse_stock.correct', ORG_A, WH_A1)).scoped).toBe(true);
    // ...and neither escapes the scope.
    expect((await svc.canForWarehouse('warehouse_stock.adjust', ORG_A, WH_A2)).scoped).toBe(false);
  });

  it('dispatch accept/reject remain denied — separation of duty', async () => {
    const fake = world();
    const svc = serviceFor(fake, PROFILES.officer);

    for (const key of ['warehouse_dispatch.accept', 'warehouse_dispatch.reject']) {
      const d = await svc.canForWarehouse(key, ORG_A, WH_A1);
      expect(d.scoped).toBe(false);
      expect(d.legacy).toBe(false);
      expect(d.allowed).toBe(false);
    }
  });

  it('omitting the warehouse target does not become a wildcard (062 rule 8)', async () => {
    const fake = world();
    const svc = serviceFor(fake, PROFILES.officer);

    // An operational role asking the org-only question fails closed.
    const d = await svc.canForOrganization('warehouse_stock.view', ORG_A);
    expect(d.scoped).toBe(false);
  });

  it('naming both targets at once fails closed (062 rule 7)', async () => {
    const fake = world();
    const svc = serviceFor(fake, PROFILES.officer);

    const d = await svc.explainDecision('warehouse_stock.view', {
      organizationId: ORG_A, warehouseId: WH_A1, distributionPointId: PT_A1,
    });
    expect(d.scoped).toBe(false);
  });

  it('does not hold the financial/export/scope-admin keys', async () => {
    const fake = world();
    const svc = serviceFor(fake, PROFILES.officer);

    for (const key of ['reports.financial', 'reports.export', 'users.edit_scope', 'users.reset_permissions']) {
      expect((await svc.canForOrganization(key, ORG_A)).legacy).toBe(false);
    }
  });
});

/* ── C/D. institution_admin & hospital_admin ─────────────────────────────── */

describe.each([
  ['C. institution_admin', PROFILES.instAdm],
  ['D. hospital_admin',    PROFILES.hospAdm],
])('%s — oversight, read-only for stock', (_label, prof) => {
  it('stock and movement oversight reads succeed org-wide without an assignment', async () => {
    const fake = world();
    const svc = serviceFor(fake, prof);

    // No assignment row exists for either admin — the org-wide compatibility
    // list is what carries them, exactly as 062 committed.
    for (const key of ['warehouse_stock.view', 'warehouse_stock.movements_view']) {
      expect((await svc.canForWarehouse(key, ORG_A, WH_A1)).scoped).toBe(true);
      expect((await svc.canForWarehouse(key, ORG_A, WH_A2)).scoped).toBe(true);
      expect((await svc.canForOrganization(key, ORG_A)).scoped).toBe(true);
    }
  });

  it('adjust and correct remain denied — oversight is not data entry', async () => {
    const fake = world();
    const svc = serviceFor(fake, prof);

    for (const key of ['warehouse_stock.adjust', 'warehouse_stock.correct']) {
      const d = await svc.canForWarehouse(key, ORG_A, WH_A1);
      expect(d.scoped).toBe(false);
      expect(d.legacy).toBe(false);
      expect(d.allowed).toBe(false);
    }
  });

  it('org-wide authority stops at the organization boundary', async () => {
    const fake = world();
    const svc = serviceFor(fake, prof);

    expect((await svc.canForWarehouse('warehouse_stock.view', ORG_B, WH_B1)).scoped).toBe(false);
  });
});

/* ── E. viewer ───────────────────────────────────────────────────────────── */

describe('E. viewer', () => {
  it('holds read permissions only', async () => {
    const fake = world();
    const svc = serviceFor(fake, PROFILES.viewer);

    for (const key of ['warehouse_stock.view', 'warehouse_stock.movements_view', 'reports.view', 'audit.view']) {
      expect((await svc.canForWarehouse(key, ORG_A, WH_A1)).scoped).toBe(true);
    }
  });

  it('holds no write permission and no privileged read', async () => {
    const fake = world();
    const svc = serviceFor(fake, PROFILES.viewer);

    for (const key of [
      'warehouse_stock.adjust', 'warehouse_stock.correct',
      'reports.financial', 'reports.export',
      'users.edit_scope', 'users.reset_permissions',
    ]) {
      const d = await svc.canForWarehouse(key, ORG_A, WH_A1);
      expect(d.scoped).toBe(false);
      expect(d.allowed).toBe(false);
    }
  });
});

/* ── F. revoked assignment ───────────────────────────────────────────────── */

describe('F. revoked assignment', () => {
  it('does not authorize', async () => {
    const fake = world({
      assignments: [{
        profile_id: PROFILES.officer.id, scope_type: 'warehouse',
        organization_id: ORG_A, warehouse_id: WH_A1, is_active: false,
      }],
    });
    const svc = serviceFor(fake, PROFILES.officer);

    const d = await svc.explainDecision('warehouse_stock.view', { organizationId: ORG_A, warehouseId: WH_A1 });
    expect(d.scoped).toBe(false);
    expect(d.scopedReason).toBe('ASSIGNMENT_MISSING');
  });

  it('an archived warehouse revokes access with no backfill', async () => {
    const fake = world({
      warehouses: [{ id: WH_A1, organization_id: ORG_A, status: 'archived' }],
    });
    const svc = serviceFor(fake, PROFILES.officer);

    expect((await svc.canForWarehouse('warehouse_stock.view', ORG_A, WH_A1)).scoped).toBe(false);
  });

  it('a suspended profile authorizes nothing even with a live assignment', async () => {
    const fake = world({
      profiles: [{ ...PROFILES.officer, status: 'suspended' }],
    });
    const svc = serviceFor(fake, PROFILES.officer);

    expect((await svc.canForWarehouse('warehouse_stock.view', ORG_A, WH_A1)).scoped).toBe(false);
  });
});

/* ── G. wrong organization ───────────────────────────────────────────────── */

describe('G. wrong organization', () => {
  it('a warehouse assignment cannot cross organizations', async () => {
    // The officer's own org is ORG_A; WH_B1 belongs to ORG_B.
    const fake = world();
    const svc = serviceFor(fake, PROFILES.officer);

    // Asking with the warehouse's real org: rule 4 rejects (org mismatch).
    expect((await svc.canForWarehouse('warehouse_stock.view', ORG_B, WH_B1)).scoped).toBe(false);
    // Asking with the officer's own org: rule 5 rejects (target not in org).
    expect((await svc.canForWarehouse('warehouse_stock.view', ORG_A, WH_B1)).scoped).toBe(false);
  });

  it('explainDecision reports a foreign organization as out of scope', async () => {
    const fake = world();
    const svc = serviceFor(fake, PROFILES.officer);

    const d = await svc.explainDecision('warehouse_stock.view', { organizationId: ORG_B, warehouseId: WH_B1 });
    expect(d.scopedReason).toBe('OUT_OF_SCOPE');
  });

  it('an assignment row naming a foreign org does not authorize', async () => {
    // A drifted row: the assignment claims ORG_B while the profile is ORG_A.
    const fake = world({
      assignments: [{
        profile_id: PROFILES.officer.id, scope_type: 'warehouse',
        organization_id: ORG_B, warehouse_id: WH_B1, is_active: true,
      }],
    });
    const svc = serviceFor(fake, PROFILES.officer);

    expect((await svc.canForWarehouse('warehouse_stock.view', ORG_B, WH_B1)).scoped).toBe(false);
  });
});

/* ── H. permission override (three-state) ────────────────────────────────── */

describe('H. permission override', () => {
  it('allow (true) grants a key the role default denies — still narrowed by scope', async () => {
    const fake = world({
      overrides: { [PROFILES.officer.id]: { 'reports.export': true } },
    });
    const svc = serviceFor(fake, PROFILES.officer);

    // The override makes the GLOBAL key effective...
    expect(fake.hasGlobalPermission(PROFILES.officer.id, 'reports.export')).toBe(true);
    // ...and rule 8 still applies: an operational role gets no org-only wildcard.
    expect((await svc.canForOrganization('reports.export', ORG_A)).scoped).toBe(false);
    // Named against its assigned warehouse, the grant comes through.
    expect((await svc.canForWarehouse('reports.export', ORG_A, WH_A1)).scoped).toBe(true);
  });

  it('deny (false) removes a key the role default grants', async () => {
    const fake = world({
      overrides: { [PROFILES.officer.id]: { 'warehouse_stock.view': false } },
    });
    const svc = serviceFor(fake, PROFILES.officer);

    const d = await svc.canForWarehouse('warehouse_stock.view', ORG_A, WH_A1);
    expect(d.scoped).toBe(false);
    expect(d.legacy).toBe(false);
  });

  it('inherit (null) falls through to the role default', async () => {
    const fake = world({
      overrides: { [PROFILES.officer.id]: { 'warehouse_stock.view': null, 'warehouse_stock.adjust': null } },
    });
    const svc = serviceFor(fake, PROFILES.officer);

    expect((await svc.canForWarehouse('warehouse_stock.view', ORG_A, WH_A1)).scoped).toBe(true);
    expect((await svc.canForWarehouse('warehouse_stock.adjust', ORG_A, WH_A1)).scoped).toBe(true);
  });

  it('no override can constrain an active super_admin (rule 3 returns first)', async () => {
    const fake = world({
      overrides: { [PROFILES.super.id]: { 'reports.view': false } },
    });
    const svc = serviceFor(fake, PROFILES.super);

    expect((await svc.canForOrganization('reports.view', ORG_A)).scoped).toBe(true);
  });

  it('an override cannot authorize outside the profile organization (rule 4 precedes the key check)', async () => {
    const fake = world({
      overrides: { [PROFILES.officer.id]: { 'warehouse_stock.view': true } },
    });
    const svc = serviceFor(fake, PROFILES.officer);

    expect((await svc.canForWarehouse('warehouse_stock.view', ORG_B, WH_B1)).scoped).toBe(false);
  });
});

/* ── I. RPC error ────────────────────────────────────────────────────────── */

describe('I. RPC error', () => {
  it('never converts into an allow, and leaves legacy behavior active in shadow', async () => {
    const fake = world();
    const svc = serviceFor(fake, PROFILES.officer, { failWith: 'NETWORK_ERROR' });

    const d = await svc.canForWarehouse('warehouse_stock.view', ORG_A, WH_A1);
    expect(d.scoped).toBeNull();                       // no answer, not a denial
    expect(d.scopedReason).toBe('TEMPORARY_FAILURE');
    expect(d.allowed).toBe(true);                      // legacy still governs
    expect(d.allowed).toBe(d.legacy);
    // A network blip is not an RBAC disagreement and must not be reported as one.
    expect(d.mismatch).toBe(false);
  });

  it('fails closed under the super_admin pilot rather than falling back to legacy', async () => {
    const fake = world();
    const svc = serviceFor(fake, PROFILES.super, { mode: 'enforce_super_admin', failWith: 'NETWORK_ERROR' });

    const d = await svc.canForOrganization('reports.view', ORG_A);
    expect(d.legacy).toBe(true);
    expect(d.allowed).toBe(false);
    expect(d.scoped).toBeNull();
    expect(d.reason).toBe('TEMPORARY_FAILURE');
  });

  it('a transient failure is never cached', async () => {
    const fake = world();
    const calls: string[] = [];
    const svc = createAuthorizationService({
      mode: 'shadow',
      transport: createFakeTransport(fake, { failWith: 'NETWORK_ERROR', onCall: f => calls.push(f) }),
    });
    svc.setContext(ctxFor(fake, PROFILES.officer));

    await svc.canForWarehouse('warehouse_stock.view', ORG_A, WH_A1);
    await svc.canForWarehouse('warehouse_stock.view', ORG_A, WH_A1);
    // A blip must not pin the answer for the cache lifetime.
    expect(calls.length).toBe(2);
  });
});

/* ── Legacy roles gain nothing ───────────────────────────────────────────── */

describe('hidden legacy transfer_manager', () => {
  it('gains no new permission from migration 062', async () => {
    const fake = world();
    const svc = serviceFor(fake, PROFILES.transfer);

    for (const key of [
      'warehouse_stock.view', 'warehouse_stock.adjust', 'warehouse_stock.correct',
      'warehouse_stock.movements_view', 'reports.financial', 'reports.export',
      'users.edit_scope', 'users.reset_permissions',
    ]) {
      const d = await svc.canForWarehouse(key, ORG_A, WH_A1);
      expect(d.scoped).toBe(false);
      expect(d.allowed).toBe(false);
    }
  });

  it('is not carried by the org-wide compatibility list', async () => {
    const fake = world();
    const svc = serviceFor(fake, PROFILES.transfer);

    // Even for a key it were somehow granted, rule 8 gives it no org-only path.
    const fakeGranted = world({
      roleDefaults: { ...ROLE_DEFAULTS, transfer_manager: { 'reports.view': true } },
    });
    const svc2 = serviceFor(fakeGranted, PROFILES.transfer);
    expect((await svc2.canForOrganization('reports.view', ORG_A)).scoped).toBe(false);
    expect((await svc.canForOrganization('reports.view', ORG_A)).scoped).toBe(false);
  });
});

/* ── anon ────────────────────────────────────────────────────────────────── */

describe('anon', () => {
  it('receives no protected application access', async () => {
    const fake = world();
    const svc = createAuthorizationService({ mode: 'shadow', transport: createFakeTransport(fake) });
    svc.setContext({
      authenticated: false, profileId: null, role: null,
      organizationId: null, legacyPermissions: new Set(),
    });

    for (const key of ['warehouse_stock.view', 'reports.view', 'audit.view']) {
      const d = await svc.canForOrganization(key, ORG_A);
      expect(d.allowed).toBe(false);
      expect(d.scoped).toBeNull();
      expect(d.reason).toBe('NOT_AUTHENTICATED');
    }
  });

  it('is never enforced into the super_admin pilot', async () => {
    const fake = world();
    const svc = createAuthorizationService({ mode: 'enforce_super_admin', transport: createFakeTransport(fake) });
    svc.setContext({
      authenticated: false, profileId: null, role: null,
      organizationId: null, legacyPermissions: new Set(),
    });

    const d = await svc.canForOrganization('reports.view', ORG_A);
    expect(d.source).toBe('legacy');
    expect(d.allowed).toBe(false);
  });
});

/* ── Shadow-mode invariants ──────────────────────────────────────────────── */

describe('shadow-mode invariants', () => {
  it('mode=off never calls the scoped engine at all', async () => {
    const fake = world();
    const calls: string[] = [];
    const svc = createAuthorizationService({
      mode: 'off', transport: createFakeTransport(fake, { onCall: f => calls.push(f) }),
    });
    svc.setContext(ctxFor(fake, PROFILES.officer));

    const d = await svc.canForWarehouse('warehouse_stock.view', ORG_A, WH_A2);
    expect(calls).toEqual([]);
    expect(d.scoped).toBeNull();
    expect(d.allowed).toBe(d.legacy);
  });

  it('across the whole matrix, shadow mode never changes the effective answer', async () => {
    const fake = world();
    const keys = [
      'warehouse_stock.view', 'warehouse_stock.adjust', 'warehouse_stock.correct',
      'warehouse_stock.movements_view', 'reports.view', 'reports.financial',
      'reports.export', 'audit.view', 'users.edit_scope', 'users.reset_permissions',
    ];

    for (const prof of Object.values(PROFILES)) {
      const svc = serviceFor(fake, prof);
      for (const key of keys) {
        for (const scope of [
          { organizationId: ORG_A },
          { organizationId: ORG_A, warehouseId: WH_A1 },
          { organizationId: ORG_A, warehouseId: WH_A2 },
          { organizationId: ORG_B, warehouseId: WH_B1 },
        ]) {
          const d = await svc.explainDecision(key, scope);
          expect(d.allowed).toBe(d.legacy);
          expect(d.source).toBe('legacy');
        }
      }
    }
  });

  it('reports a mismatch with no name, email or token in the record', async () => {
    const fake = world();
    const emitted: Record<string, unknown>[] = [];
    const svc = createAuthorizationService({
      mode: 'shadow',
      transport: createFakeTransport(fake),
      reporter: createShadowReporter({ emit: r => emitted.push(r as unknown as Record<string, unknown>) }),
    });
    svc.setContext(ctxFor(fake, PROFILES.officer));

    await svc.canForWarehouse('warehouse_stock.view', ORG_A, WH_A2);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      role: 'warehouse_officer',
      permissionKey: 'warehouse_stock.view',
      organizationId: ORG_A,
      warehouseId: WH_A2,
      legacyDecision: true,
      scopedDecision: false,
    });
    // The profile reference is truncated, never the full identifier.
    expect(emitted[0].profileRef).toBe(PROFILES.officer.id.slice(0, 8));
    expect(Object.keys(emitted[0])).toEqual(expect.not.arrayContaining([
      'email', 'name', 'token', 'password', 'profileId', 'session',
    ]));
  });

  it('agreement is never reported', async () => {
    const fake = world();
    const emitted: unknown[] = [];
    const svc = createAuthorizationService({
      mode: 'shadow',
      transport: createFakeTransport(fake),
      reporter: createShadowReporter({ emit: r => emitted.push(r) }),
    });
    svc.setContext(ctxFor(fake, PROFILES.officer));

    await svc.canForWarehouse('warehouse_stock.view', ORG_A, WH_A1);
    expect(emitted).toEqual([]);
  });
});

/* ── Diagnostics dedup ───────────────────────────────────────────────────── */

describe('shadow diagnostics deduplication', () => {
  it('collapses repeated identical mismatches within the window', () => {
    let t = 0;
    const emitted: { suppressedCount: number }[] = [];
    const reporter = createShadowReporter({
      windowMs: 1000, now: () => t, emit: r => emitted.push(r),
    });
    const record = {
      profileRef: 'abcd1234', role: 'warehouse_officer',
      permissionKey: 'warehouse_stock.view',
      organizationId: ORG_A, warehouseId: WH_A2, distributionPointId: null,
      legacyDecision: true, scopedDecision: false,
      reasonCode: 'ASSIGNMENT_MISSING' as const, mode: 'shadow' as const,
    };

    // A list of rows re-rendering 50 times emits once.
    for (let i = 0; i < 50; i++) reporter.report(record);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].suppressedCount).toBe(0);

    // After the window, one more line — carrying what it suppressed.
    t = 1500;
    reporter.report(record);
    expect(emitted).toHaveLength(2);
    expect(emitted[1].suppressedCount).toBe(49);
  });

  it('distinguishes different resources rather than collapsing them', () => {
    const emitted: unknown[] = [];
    const reporter = createShadowReporter({ now: () => 0, emit: r => emitted.push(r) });
    const base = {
      profileRef: 'abcd1234', role: 'warehouse_officer',
      permissionKey: 'warehouse_stock.view',
      organizationId: ORG_A, distributionPointId: null,
      legacyDecision: true, scopedDecision: false,
      reasonCode: 'ASSIGNMENT_MISSING' as const, mode: 'shadow' as const,
    };
    reporter.report({ ...base, warehouseId: WH_A1 });
    reporter.report({ ...base, warehouseId: WH_A2 });
    expect(emitted).toHaveLength(2);
  });

  it('reset() clears dedup state on logout', () => {
    const emitted: unknown[] = [];
    const reporter = createShadowReporter({ now: () => 0, emit: r => emitted.push(r) });
    const record = {
      profileRef: 'abcd1234', role: 'viewer', permissionKey: 'reports.view',
      organizationId: ORG_A, warehouseId: null, distributionPointId: null,
      legacyDecision: true, scopedDecision: false,
      reasonCode: 'PERMISSION_DENIED' as const, mode: 'shadow' as const,
    };
    reporter.report(record);
    reporter.report(record);
    expect(emitted).toHaveLength(1);

    reporter.reset();
    reporter.report(record);
    expect(emitted).toHaveLength(2);
  });

  it('never emits from the null reporter', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The production default.
    const svc = createAuthorizationService({ mode: 'off' });
    expect(svc.mode()).toBe('off');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
