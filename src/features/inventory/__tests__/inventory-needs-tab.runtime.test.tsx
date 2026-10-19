/** @vitest-environment jsdom */
/**
 * R1-A4 — the protected "الاحتياجات والتحصيص" tab inside the REAL Screen 3 (InventoryCenterScreen).
 * Only the data hooks / services are replaced; the screen, its tab strip and its content switch are real.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const rpc = vi.fn(async () => ({ data: [], error: null }));
vi.mock('@/shared/supabase/client', () => ({ supabase: { rpc: (...a: unknown[]) => (rpc as never as (...x: unknown[]) => unknown)(...a), from: vi.fn() }, supabaseConfigured: true, __installQaSupabaseClient: () => undefined }));
vi.mock('@/shared/authz/rbac.service', () => ({ supabaseRbacTransport: { hasScopedPermission: async () => ({ ok: true, allowed: false }), hasWarehouseAssignment: async () => ({ ok: true, allowed: false }), hasPointAssignment: async () => ({ ok: true, allowed: false }) } }));

const appState = {
  lang: 'ar' as 'ar' | 'en', dir: 'rtl' as 'rtl' | 'ltr', role: 'central_warehouse_manager', activeOrgId: 'org-1' as string | null,
  myPermissions: new Set<string>(), profile: { id: 'u1', organization_id: 'org-1', role: 'central_warehouse_manager' },
  session: { user: { id: 'u1' } }, authStatus: 'authenticated', theme: 'light',
};
vi.mock('@/app/AppContext', () => ({ useApp: () => appState }));

const getOrganizations = vi.fn(async () => [{ id: 'org-1', name: 'PDA', name_ar: 'دائرة', code: 'p', status: 'active', city: '', contact_email: '', organizationKind: 'pharmacy_department_authority', institutionClass: null }]);
vi.mock('@/shared/supabase/services/organizations.service', () => ({ getOrganizations: () => getOrganizations() }));
vi.mock('@/shared/supabase/services/registry.service', () => ({ getAllCentralItems: async () => [] }));
vi.mock('@/features/network/network.service', () => ({ getWarehouseStock: async () => [] }));

const scopesState = { warehouses: [{ kind: 'warehouse', id: 'w1', name: 'Central WH', nameAr: 'المخزن المركزي', warehouseId: null, warehouseKind: 'central', pointType: null }] as unknown[] };
vi.mock('../useInventoryScopes', () => ({ useInventoryScopes: () => ({ data: { manageableWarehouses: scopesState.warehouses, manageableOutlets: [] }, loading: false, error: null, reload: () => undefined }) }));
vi.mock('../useWarehouseStockPermissions', () => ({ useWarehouseStockPermissions: () => ({ data: { canAdjust: false, canCorrect: false }, loading: false }) }));
vi.mock('../useReturnReceivePermission', () => ({ useReturnReceivePermission: () => ({ data: false }) }));
vi.mock('../useOutletReturnExceptionResolvePermission', () => ({ useOutletReturnExceptionResolvePermission: () => ({ data: false }) }));
vi.mock('../useQuarantinePermission', () => ({ useQuarantinePermission: () => ({ data: false, confirmed: false }), quarantinePermissionScopeKey: () => 'k' }));
vi.mock('../useMaterialDispensingSuspensionPermission', () => ({ useMaterialDispensingSuspensionPermission: () => ({ data: null }) }));
vi.mock('../useApproveCorrectionPermission', () => ({ useApproveCorrectionPermission: () => ({ data: false }) }));
vi.mock('../useInventoryReadAffordance', () => ({ useInventoryReadAffordance: () => false }));

// the lazily loaded tab body is a stub: this file proves WHERE and WHEN it mounts, the journey has its own suite
vi.mock('@/features/central-needs/manual/ManualNeedsTab', () => ({ ManualNeedsTab: () => <div data-testid="needs-tab-body">needs journey</div> }));

const gate = { mode: 'real' as 'real' | 'off' | 'on' | 'checking' };
vi.mock('@/features/central-needs/manual/manual-needs-gate', async (orig) => {
  const actual = await orig<typeof import('@/features/central-needs/manual/manual-needs-gate')>();
  return { ...actual, useManualNeedsTabGate: () => (gate.mode === 'real' ? actual.useManualNeedsTabGate() : gate.mode) };
});

const { InventoryCenterScreen } = await import('../InventoryCenterScreen');

const ONE_WAREHOUSE = [{ kind: 'warehouse', id: 'w1', name: 'Central WH', nameAr: 'المخزن المركزي', warehouseId: null, warehouseKind: 'central', pointType: null }];
beforeEach(() => { gate.mode = 'real'; scopesState.warehouses = ONE_WAREHOUSE; rpc.mockClear(); getOrganizations.mockClear(); });
afterEach(() => cleanup());

const NEEDS_TAB = 'الاحتياجات والتحصيص';

describe('Screen 3 — the needs tab', () => {
  it('DEFAULT BUILD (flag off): no tab, and the gate makes no capability request', async () => {
    render(<InventoryCenterScreen />);
    await screen.findAllByRole('tab');
    expect(screen.queryByRole('tab', { name: NEEDS_TAB })).toBeNull();
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(rpc.mock.calls.map((c) => (c as unknown[])[0])).not.toContain('phoenix_central_needs_my_capabilities');
  });

  it('gate OFF: no tab; the existing tabs are unchanged', async () => {
    gate.mode = 'off';
    render(<InventoryCenterScreen />);
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByRole('tab', { name: NEEDS_TAB })).toBeNull();
    expect(screen.queryByTestId('needs-tab-body')).toBeNull();
  });

  it('gate CHECKING: no tab yet (nothing is offered before the server has answered)', async () => {
    gate.mode = 'checking';
    render(<InventoryCenterScreen />);
    await screen.findAllByRole('tab');
    expect(screen.queryByRole('tab', { name: NEEDS_TAB })).toBeNull();
  });

  it('gate ON: the tab appears and opens its body with NO warehouse SELECTED (org-level scope, independent of the warehouse selection)', async () => {
    gate.mode = 'on';
    render(<InventoryCenterScreen />);
    const tab = await screen.findByRole('tab', { name: NEEDS_TAB });
    // every other tab needs a selected warehouse; the needs tab does not
    expect(screen.getByRole('combobox')).toHaveValue('');
    expect(screen.queryByTestId('needs-tab-body')).toBeNull();
    fireEvent.click(tab);
    expect(await screen.findByTestId('needs-tab-body')).toBeInTheDocument();
    expect(tab).toHaveAttribute('aria-selected', 'true');
  });

  it('English label; the tab is last in the strip', async () => {
    gate.mode = 'on'; appState.lang = 'en'; appState.dir = 'ltr';
    try {
      render(<InventoryCenterScreen />);
      const tab = await screen.findByRole('tab', { name: 'Needs & allocation' });
      const all = screen.getAllByRole('tab');
      expect(all[all.length - 1]).toBe(tab);
    } finally { appState.lang = 'ar'; appState.dir = 'rtl'; }
  });

  it('when the gate turns OFF while the tab is open (e.g. organization switch) the screen leaves the tab and never falls into another tab\'s content', async () => {
    gate.mode = 'on';
    const { rerender } = render(<InventoryCenterScreen />);
    fireEvent.click(await screen.findByRole('tab', { name: NEEDS_TAB }));
    await screen.findByTestId('needs-tab-body');
    gate.mode = 'off';
    rerender(<InventoryCenterScreen />);
    await waitFor(() => expect(screen.queryByTestId('needs-tab-body')).toBeNull());
    expect(screen.queryByRole('tab', { name: NEEDS_TAB })).toBeNull();
    const selected = screen.getAllByRole('tab').filter((t) => t.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
  });

  it('the screen itself writes nothing for the needs tab: no rpc at all from opening it', async () => {
    gate.mode = 'on';
    render(<InventoryCenterScreen />);
    rpc.mockClear();
    fireEvent.click(await screen.findByRole('tab', { name: NEEDS_TAB }));
    await screen.findByTestId('needs-tab-body');
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('Screen 3 — an actor with NO manageable warehouse', () => {
  it('gate OFF / default: the old denied state, unchanged, no tabs, nothing about needs', async () => {
    scopesState.warehouses = [];
    for (const mode of ['real', 'off', 'checking'] as const) {
      cleanup(); gate.mode = mode;
      render(<InventoryCenterScreen />);
      await waitFor(() => expect(screen.queryAllByRole('tab')).toHaveLength(0));
      expect(screen.queryByTestId('needs-tab-body')).toBeNull();
    }
  });
  it('gate ON: the org-level needs journey is still reachable (the only tab) - other tabs stay unavailable', async () => {
    scopesState.warehouses = []; gate.mode = 'on';
    render(<InventoryCenterScreen />);
    expect(await screen.findByTestId('needs-tab-body')).toBeInTheDocument();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toHaveTextContent(NEEDS_TAB);
  });
});
