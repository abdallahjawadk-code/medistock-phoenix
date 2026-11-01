/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ receive: true, lang: 'en', dir: 'ltr' }));
vi.mock('@/app/AppContext', () => ({ useApp: () => ({ ...state, activeOrgId: 'synthetic-org',
  role: 'warehouse_officer', myPermissions: new Set(), profile: { id: 'synthetic-actor' } }) }));
vi.mock('@/shared/supabase/client', () => ({ supabase: {} }));
vi.mock('@/shared/lib/useAsync', () => ({ useAsync: () => ({ data: [], loading: false, error: null, reload: vi.fn() }) }));
vi.mock('@/shared/ui/PhoenixOrgScope', () => ({ PhoenixOrgScope: () => null }));
vi.mock('../useInventoryScopes', () => ({ useInventoryScopes: () => ({ loading: false, error: null,
  data: { manageableWarehouses: [{ id: 'synthetic-wh', name: 'Synthetic warehouse', nameAr: 'مخزن اصطناعي' }], manageableOutlets: [] } }) }));
vi.mock('../useWarehouseStockPermissions', () => ({ useWarehouseStockPermissions: () => ({ data: { canAdjust: false, canCorrect: false } }) }));
vi.mock('../useReturnReceivePermission', () => ({ useReturnReceivePermission: () => ({ data: state.receive }) }));
vi.mock('../useOutletReturnExceptionResolvePermission', () => ({ useOutletReturnExceptionResolvePermission: () => ({ data: false }) }));
vi.mock('../useQuarantinePermission', () => ({ useQuarantinePermission: () => ({ data: false, confirmed: true }), quarantinePermissionScopeKey: () => 'synthetic-scope' }));
vi.mock('../useInventoryReadAffordance', () => ({ useInventoryReadAffordance: () => false }));
vi.mock('../useMaterialDispensingSuspensionPermission', () => ({ useMaterialDispensingSuspensionPermission: () => ({ data: { canViewDetail: false } }) }));
vi.mock('../useApproveCorrectionPermission', () => ({ useApproveCorrectionPermission: () => ({ data: false }) }));
vi.mock('@/features/central-needs/manual/manual-needs-gate', () => ({ useManualNeedsTabGate: () => 'off' }));
vi.mock('@/features/guide/guide.surface', () => ({ useGuideSurface: vi.fn(), useGuideCapabilities: vi.fn(),
  useScopedGuideCapabilities: vi.fn(), useGuidePresence: vi.fn(), useGuideExampleRow: vi.fn() }));

import { InventoryCenterScreen } from '../InventoryCenterScreen';
afterEach(cleanup);
describe('real inventory screen when selected tab authority disappears', () => {
  it.each([['en', 'ltr'], ['ar', 'rtl']])('%s keeps a selected keyboard entry and correctly labelled panel', (lang, dir) => {
    Object.assign(state, { receive: true, lang, dir });
    const view = render(<InventoryCenterScreen />);
    const returns = document.getElementById('inventory-tab-returns')!;
    fireEvent.click(returns); expect(returns).toHaveAttribute('aria-selected', 'true');
    state.receive = false; view.rerender(<InventoryCenterScreen />);
    expect(document.getElementById('inventory-tab-returns')).toBeNull();
    const intake = document.getElementById('inventory-tab-intake')!;
    expect(intake).toHaveAttribute('aria-selected', 'true'); expect(intake).toHaveAttribute('tabindex', '0');
    expect(screen.getAllByRole('tab').filter(tab => tab.tabIndex === 0)).toEqual([intake]);
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', intake.id);
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName(intake.textContent!);
    // A later permission refresh must not reopen the removed tab implicitly.
    state.receive = true; view.rerender(<InventoryCenterScreen />); expect(intake).toHaveAttribute('aria-selected', 'true');
  });
});
