/**
 * @vitest-environment jsdom
 *
 * PRB-1 · UAT-DEFECT-005 — THE INVENTORY SCOPE READ MUST ALWAYS CONVERGE.
 *
 * useInventoryScopes wraps useAsync and then RE-DERIVES `loading`:
 *
 *     loading: visible.loading || (Boolean(orgId) && data === null)
 *
 * The second clause is a deliberate fail-closed guard — while the catalog is
 * unresolved, no scope may render as a real (empty) answer. But `data === null`
 * is true for two different reasons, and the guard could not tell them apart:
 *
 *     the catalog has not arrived yet        → keep loading   (correct)
 *     the catalog read FAILED                → keep loading   (never settles)
 *
 * useAsync had already done the right thing — loading=false, error=<message> —
 * and this line put loading back to true, permanently. Every consumer renders
 * its error branch as `!loading && error`, so the two states were mutually
 * exclusive: the error existed and was unreachable, and the operator saw a
 * spinner that never stopped.
 *
 * THE INVARIANT PROVEN HERE — for every terminal outcome:
 *
 *     loading === false  AND  (error !== null  XOR  data !== null)
 *
 * plus the fail-closed half that must NOT regress: an errored read still
 * exposes no manageable scope, so making the machine terminate does not turn a
 * failure into an empty-but-usable catalog.
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScopeTopologyNode } from '@/shared/supabase/services/scope-topology.service';

const ROOT = join(__dirname, '../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const topology = vi.hoisted(() => ({ fn: vi.fn() }));

// organization_id is null so BOTH organizations below take the PRIMARY
// topology path. A profile pinned to org-1 would make org-2 a DELEGATED read
// (a different service entirely), and the org-switch proofs would then be
// exercising the delegated branch rather than the state machine under test.
vi.mock('@/app/AppContext', () => ({
  useApp: () => ({ profile: { id: 'p1', role: 'central_warehouse_manager', organization_id: null } }),
}));
vi.mock('@/shared/supabase/services/scope-topology.service', async (orig) => ({
  ...(await orig<typeof import('@/shared/supabase/services/scope-topology.service')>()),
  getOrganizationScopeTopology: (...a: unknown[]) => topology.fn(...a),
}));
vi.mock('@/shared/supabase/services/delegated-access.service', () => ({
  getMyOperationalResourceCatalog: () => Promise.resolve([]),
}));
vi.mock('@/shared/authz/rbac.service', () => ({
  supabaseRbacTransport: { hasScopedPermission: () => Promise.resolve({ ok: true, allowed: false }) },
}));

const warehouseNode = (id: string): ScopeTopologyNode => ({
  nodeKind: 'warehouse', organizationId: 'org-1', organizationKind: 'care_institution',
  institutionClass: 'hospital', facilityId: null, facilityClass: null, facilityStatus: null,
  facilityName: null, facilityNameAr: null,
  warehouseId: id, warehouseName: `WH ${id}`, warehouseNameAr: `م ${id}`,
  warehouseKind: 'central', warehouseStatus: 'active', warehouseIsMain: false,
  structuralRole: 'central_warehouse',
  distributionPointId: null, distributionPointName: null, distributionPointNameAr: null,
  distributionPointType: null, distributionPointStatus: null,
  inEffectiveScope: true,
});

const deferred = <T,>() => {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

async function mount(orgId: string | null = 'org-1') {
  const { useInventoryScopes } = await import('../useInventoryScopes');
  return renderHook(({ id }: { id: string | null }) => useInventoryScopes(id), {
    initialProps: { id: orgId },
  });
}

describe('UAT-DEFECT-005 · the scope catalog state machine always converges', () => {
  beforeEach(() => { topology.fn.mockReset(); });
  afterEach(() => cleanup());

  it('B1 · normal success: loading settles false, data present, error null', async () => {
    topology.fn.mockResolvedValue([warehouseNode('w1')]);
    const { result } = await mount();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.data).not.toBeNull();
    expect(result.current.data!.manageableWarehouses.map(w => w.id)).toEqual(['w1']);
  });

  it('B2 · delayed success: stays loading while in flight, then settles', async () => {
    const d = deferred<ScopeTopologyNode[]>();
    topology.fn.mockReturnValue(d.promise);
    const { result } = await mount();
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();
    await act(async () => { d.resolve([warehouseNode('w1')]); });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).not.toBeNull();
  });

  it('B3 · server failure: NO INFINITE SPINNER — loading false, error surfaced', async () => {
    topology.fn.mockRejectedValue(Object.assign(new Error('permission denied for function'), { code: '42501' }));
    const { result } = await mount();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).not.toBeNull();
    expect(result.current.data).toBeNull();
  });

  it('B4 · network failure: same terminal error state', async () => {
    topology.fn.mockRejectedValue(new TypeError('Failed to fetch'));
    const { result } = await mount();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).not.toBeNull();
  });

  it('B3b · FAIL CLOSED IS PRESERVED: an errored read grants no manageable scope', async () => {
    topology.fn.mockRejectedValue(new Error('boom'));
    const { result } = await mount();
    await waitFor(() => expect(result.current.loading).toBe(false));
    // Terminating the machine must not turn a failure into a usable catalog.
    expect(result.current.data).toBeNull();
  });

  it('B5 · retry succeeds: error → loading → populated, with no remount', async () => {
    topology.fn
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue([warehouseNode('w1')]);
    const { result } = await mount();
    await waitFor(() => expect(result.current.error).not.toBeNull());
    await act(async () => { result.current.reload(); });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.data!.manageableWarehouses.map(w => w.id)).toEqual(['w1']);
  });

  it('B6 · repeated failure stays terminal — it never reverts to a spinner', async () => {
    topology.fn.mockRejectedValue(new Error('still down'));
    const { result } = await mount();
    await waitFor(() => expect(result.current.error).not.toBeNull());
    await act(async () => { result.current.reload(); });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).not.toBeNull();
  });

  it('B7 · unmount during an in-flight request settles nothing and throws nothing', async () => {
    const d = deferred<ScopeTopologyNode[]>();
    topology.fn.mockReturnValue(d.promise);
    const { result, unmount } = await mount();
    expect(result.current.loading).toBe(true);
    unmount();
    await act(async () => { d.reject(new Error('late failure after unmount')); await Promise.resolve(); });
    // Nothing to assert on the unmounted hook beyond: this did not throw.
    expect(true).toBe(true);
  });

  it('B8 · organization change while a request is in flight: the new org still converges', async () => {
    const first = deferred<ScopeTopologyNode[]>();
    topology.fn.mockReturnValueOnce(first.promise).mockResolvedValue([warehouseNode('w2')]);
    const { useInventoryScopes } = await import('../useInventoryScopes');
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useInventoryScopes(id), {
      initialProps: { id: 'org-1' as string | null },
    });
    expect(result.current.loading).toBe(true);
    rerender({ id: 'org-2' });
    await act(async () => { first.resolve([warehouseNode('w1')]); });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    // The former organization's scope must never survive the switch.
    expect(result.current.data!.organizationId).toBe('org-2');
    expect(result.current.data!.manageableWarehouses.map(w => w.id)).toEqual(['w2']);
  });

  it('B8b · a failure on the NEW organization is terminal, not an eternal spinner', async () => {
    topology.fn.mockResolvedValueOnce([warehouseNode('w1')]).mockRejectedValue(new Error('org-2 read failed'));
    const { useInventoryScopes } = await import('../useInventoryScopes');
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useInventoryScopes(id), {
      initialProps: { id: 'org-1' as string | null },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender({ id: 'org-2' });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).not.toBeNull();
    expect(result.current.data).toBeNull();
  });

  it('no orgId: settles immediately with an empty catalog and no error', async () => {
    const { result } = await mount(null);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// CONSUMER CONTRACT — a screen that gates rendering on `loading` must also
// have somewhere for `error` to go. Without this, fixing the hook alone would
// leave the failure to be absorbed by a neighbouring empty/denied state.
// ───────────────────────────────────────────────────────────────────────────

describe('UAT-DEFECT-005 · every consumer that gates on scopes.loading handles scopes.error', () => {
  const CONSUMERS = [
    'src/features/inventory/InventoryCenterScreen.tsx',
    'src/features/inventory/InventoryThresholdModal.tsx',
    'src/features/outlet/OutletOperationsScreen.tsx',
  ];

  it('the hook itself no longer swallows the error into loading', () => {
    const hook = read('src/features/inventory/useInventoryScopes.ts');
    const line = hook.split('\n').find(l => l.trim().startsWith('loading: visible.loading'));
    expect(line, 'the derived loading expression must still exist').toBeDefined();
    expect(line).toContain('visible.error === null');
  });

  CONSUMERS.forEach(path => {
    it(`${path.split('/').pop()} renders an error state for a failed scope read`, () => {
      const src = read(path);
      expect(src, 'gates on scopes.loading').toContain('scopes.loading');
      expect(src, 'must have an error branch').toContain('scopes.error');
      expect(src, 'the error must be retryable').toContain('scopes.reload');
    });
  });

  it('InventoryCenterScreen checks the error BEFORE the "no warehouse permissions" state', () => {
    const src = read('src/features/inventory/InventoryCenterScreen.tsx');
    const errorAt = src.indexOf('if (scopes.error)');
    const deniedAt = src.indexOf("t('inv_center_denied', lang)");
    expect(errorAt).toBeGreaterThan(-1);
    expect(deniedAt).toBeGreaterThan(-1);
    expect(errorAt, 'a failed read must not be reported as a permission decision').toBeLessThan(deniedAt);
  });

  it('OutletOperationsScreen checks the error BEFORE the "no outlet scope" state', () => {
    const src = read('src/features/outlet/OutletOperationsScreen.tsx');
    const errorAt = src.indexOf('if (scopes.error');
    const emptyAt = src.indexOf("t('or_no_outlet_scope', lang)");
    expect(errorAt).toBeGreaterThan(-1);
    expect(errorAt).toBeLessThan(emptyAt);
  });
});
