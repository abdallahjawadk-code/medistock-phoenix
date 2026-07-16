/**
 * PHASE-1-CONTROLLED-RBAC-ACTIVATION-SHADOW-MODE — caching and session safety.
 *
 * An authorization cache is a security surface: every bug in it is a decision
 * answered for the wrong subject. These tests pin the five properties that make
 * it safe — complete-tuple keying, invalidation, no cross-session survival, no
 * failure-as-grant, bounded lifetime — plus concurrent dedup.
 */
import { describe, it, expect } from 'vitest';
import { createAuthorizationService, type AuthzContext } from '../authorization';
import { createFakeDb, createFakeTransport } from './fake-062-database';

const ORG_A = 'org-a';
const ORG_B = 'org-b';
const WH_1  = 'wh-1';
const WH_2  = 'wh-2';
const PT_1  = 'pt-1';

const ALICE = { id: 'p-alice', role: 'warehouse_officer', status: 'active' as const, organization_id: ORG_A };
const BOB   = { id: 'p-bob',   role: 'warehouse_officer', status: 'active' as const, organization_id: ORG_B };

function world() {
  return createFakeDb({
    profiles: [ALICE, BOB],
    warehouses: [
      { id: WH_1, organization_id: ORG_A, status: 'active' },
      { id: WH_2, organization_id: ORG_A, status: 'active' },
    ],
    points: [{ id: PT_1, organization_id: ORG_A, status: 'active' }],
    // Alice may work on WH_1. Bob is in another org entirely.
    assignments: [
      { profile_id: ALICE.id, scope_type: 'warehouse', organization_id: ORG_A, warehouse_id: WH_1, is_active: true },
    ],
    roleDefaults: { warehouse_officer: { 'warehouse_stock.view': true } },
    overrides: {},
  });
}

const ctx = (p: typeof ALICE): AuthzContext => ({
  authenticated: true,
  profileId: p.id,
  role: p.role,
  organizationId: p.organization_id,
  legacyPermissions: new Set(['warehouse_stock.view']),
});

function setup(opts: { now?: () => number; failWith?: 'NETWORK_ERROR' } = {}) {
  const fake = world();
  const calls: string[] = [];
  const svc = createAuthorizationService({
    mode: 'shadow',
    transport: createFakeTransport(fake, { failWith: opts.failWith, onCall: f => calls.push(f) }),
    now: opts.now,
  });
  return { fake, calls, svc };
}

describe('cache keying', () => {
  it('is keyed by the complete scope tuple — a warehouse answer never serves another', async () => {
    const { svc, calls } = setup();
    svc.setContext(ctx(ALICE));

    const assigned   = await svc.canForWarehouse('warehouse_stock.view', ORG_A, WH_1);
    const unassigned = await svc.canForWarehouse('warehouse_stock.view', ORG_A, WH_2);

    expect(assigned.scoped).toBe(true);
    expect(unassigned.scoped).toBe(false);
    expect(calls.filter(c => c === 'scoped')).toHaveLength(2);
  });

  it('distinguishes a warehouse target from an outlet target with the same key', async () => {
    const { svc, calls } = setup();
    svc.setContext(ctx(ALICE));

    await svc.canForWarehouse('warehouse_stock.view', ORG_A, WH_1);
    await svc.canForPoint('warehouse_stock.view', ORG_A, PT_1);
    expect(calls.filter(c => c === 'scoped')).toHaveLength(2);
  });

  it('distinguishes organizations', async () => {
    const { svc, calls } = setup();
    svc.setContext(ctx(ALICE));

    await svc.canForOrganization('warehouse_stock.view', ORG_A);
    await svc.canForOrganization('warehouse_stock.view', ORG_B);
    expect(calls.filter(c => c === 'scoped')).toHaveLength(2);
  });

  it('serves a repeated identical question from cache', async () => {
    const { svc, calls } = setup();
    svc.setContext(ctx(ALICE));

    await svc.canForWarehouse('warehouse_stock.view', ORG_A, WH_1);
    await svc.canForWarehouse('warehouse_stock.view', ORG_A, WH_1);
    await svc.canForWarehouse('warehouse_stock.view', ORG_A, WH_1);
    expect(calls.filter(c => c === 'scoped')).toHaveLength(1);
  });
});

describe('invalidation', () => {
  it('a cached decision never survives into another user session', async () => {
    const { svc, calls } = setup();

    svc.setContext(ctx(ALICE));
    const alice = await svc.canForWarehouse('warehouse_stock.view', ORG_A, WH_1);
    expect(alice.scoped).toBe(true);

    // Bob logs in on the same client.
    svc.setContext(ctx(BOB));
    const bob = await svc.canForWarehouse('warehouse_stock.view', ORG_A, WH_1);

    // Bob is in ORG_B: rule 4 denies. Had Alice's entry survived, this would be true.
    expect(bob.scoped).toBe(false);
    expect(calls.filter(c => c === 'scoped')).toHaveLength(2);
  });

  it('logout clears the cache', async () => {
    const { svc } = setup();
    svc.setContext(ctx(ALICE));
    await svc.canForWarehouse('warehouse_stock.view', ORG_A, WH_1);

    svc.setContext({
      authenticated: false, profileId: null, role: null,
      organizationId: null, legacyPermissions: new Set(),
    });
    const after = await svc.canForWarehouse('warehouse_stock.view', ORG_A, WH_1);
    // Alice's cached `true` is gone: with no session the engine cannot answer
    // at all, which is not the same as answering false — but is equally not a grant.
    expect(after.scoped).toBeNull();
    expect(after.allowed).toBe(false);
    expect(after.reason).toBe('NOT_AUTHENTICATED');
  });

  it('invalidate() forces a re-check after a permission or scope administration change', async () => {
    const { svc, calls, fake } = setup();
    svc.setContext(ctx(ALICE));

    expect((await svc.canForWarehouse('warehouse_stock.view', ORG_A, WH_2)).scoped).toBe(false);

    // An administrator assigns Alice to WH_2.
    fake.db.assignments.push({
      profile_id: ALICE.id, scope_type: 'warehouse',
      organization_id: ORG_A, warehouse_id: WH_2, is_active: true,
    });

    // Without invalidation the stale denial would persist for the TTL...
    expect((await svc.canForWarehouse('warehouse_stock.view', ORG_A, WH_2)).scoped).toBe(false);
    // ...and with it, the new grant is visible immediately.
    svc.invalidate();
    expect((await svc.canForWarehouse('warehouse_stock.view', ORG_A, WH_2)).scoped).toBe(true);
    expect(calls.filter(c => c === 'scoped')).toHaveLength(2);
  });

  it('a revocation is visible after invalidation', async () => {
    const { svc, fake } = setup();
    svc.setContext(ctx(ALICE));

    expect((await svc.canForWarehouse('warehouse_stock.view', ORG_A, WH_1)).scoped).toBe(true);
    fake.db.assignments[0].is_active = false;
    svc.invalidate();
    expect((await svc.canForWarehouse('warehouse_stock.view', ORG_A, WH_1)).scoped).toBe(false);
  });
});

describe('bounded lifetime', () => {
  it('a cached remote decision expires', async () => {
    let t = 0;
    const { svc, calls } = setup({ now: () => t });
    svc.setContext(ctx(ALICE));

    await svc.canForWarehouse('warehouse_stock.view', ORG_A, WH_1);
    t = 29_000;
    await svc.canForWarehouse('warehouse_stock.view', ORG_A, WH_1);
    expect(calls.filter(c => c === 'scoped')).toHaveLength(1);

    t = 31_000; // past the 30s default TTL
    await svc.canForWarehouse('warehouse_stock.view', ORG_A, WH_1);
    expect(calls.filter(c => c === 'scoped')).toHaveLength(2);
  });
});

describe('failure handling', () => {
  it('an RPC failure is never cached as a grant, and never as anything', async () => {
    const { svc, calls } = setup({ failWith: 'NETWORK_ERROR' });
    svc.setContext(ctx(ALICE));

    const first = await svc.canForWarehouse('warehouse_stock.view', ORG_A, WH_1);
    expect(first.scoped).toBeNull();
    expect(first.scopedReason).toBe('TEMPORARY_FAILURE');
    await svc.canForWarehouse('warehouse_stock.view', ORG_A, WH_1);
    expect(calls.filter(c => c === 'scoped')).toHaveLength(2);
  });
});

describe('concurrent dedup', () => {
  it('identical concurrent checks share one round-trip', async () => {
    const { svc, calls } = setup();
    svc.setContext(ctx(ALICE));

    // The list-render case: 40 rows asking the same question in one tick.
    const results = await Promise.all(
      Array.from({ length: 40 }, () => svc.canForWarehouse('warehouse_stock.view', ORG_A, WH_1)),
    );

    expect(calls.filter(c => c === 'scoped')).toHaveLength(1);
    expect(results.every(r => r.scoped === true)).toBe(true);
  });

  it('concurrent checks for DIFFERENT scopes are not deduplicated together', async () => {
    const { svc, calls } = setup();
    svc.setContext(ctx(ALICE));

    const [a, b] = await Promise.all([
      svc.canForWarehouse('warehouse_stock.view', ORG_A, WH_1),
      svc.canForWarehouse('warehouse_stock.view', ORG_A, WH_2),
    ]);

    expect(a.scoped).toBe(true);
    expect(b.scoped).toBe(false);
    expect(calls.filter(c => c === 'scoped')).toHaveLength(2);
  });
});
