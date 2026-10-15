/**
 * @vitest-environment jsdom
 *
 * PDA-PROC-1 — Screen 19's organization eligibility gate, at runtime.
 *
 * Supplementary procurement belongs to care institutions only. The exported
 * LocalProcurementScreen mounts the procurement workspace (and with it every
 * procurement data hook) ONLY when AppContext's canonical
 * activeOrganizationKind is 'care_institution'. A pharmacy department
 * authority, an unknown or unreadable kind, and a kind still being read never
 * mount it — super_admin included — and the ineligible state is never the
 * "no warehouse in your scope" message.
 *
 * The two workspace hooks are module mocks wrapped in spies, so "never
 * mounted" is proven by "never called", not inferred from the DOM.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { LocalProcurementScreen } from '../LocalProcurementScreen';
import type { OrganizationKind } from '@/shared/lib/institution-hierarchy';

const hooks = vi.hoisted(() => ({
  useInventoryScopes: vi.fn(),
  useProcurementPermissions: vi.fn(),
}));

vi.mock('@/features/inventory/useInventoryScopes', () => ({
  useInventoryScopes: (...args: unknown[]) => hooks.useInventoryScopes(...args),
}));
vi.mock('../useProcurementPermissions', () => ({
  useProcurementPermissions: (...args: unknown[]) => hooks.useProcurementPermissions(...args),
}));
// The header's org picker and the workspace panels have their own coverage;
// stubbing them keeps this file about the gate alone (no service reads).
vi.mock('@/shared/ui/PhoenixOrgScope', () => ({ PhoenixOrgScope: () => <div data-testid="org-scope-stub" /> }));
vi.mock('../DirectEntryPanel', () => ({ DirectEntryPanel: () => <div data-testid="direct-entry-stub" /> }));
vi.mock('../PurchaseHistoryPanel', () => ({ PurchaseHistoryPanel: () => <div data-testid="purchase-history-stub" /> }));

const CARE_ORG = 'care-org-1';
const CARE_ORG_2 = 'care-org-2';
const PDA_ORG = 'pda-org-1';

interface AppMock {
  lang: 'ar' | 'en';
  dir: 'rtl' | 'ltr';
  role: string;
  activeOrgId: string | null;
  activeOrganizationKind: OrganizationKind | null;
  activeOrganizationKindPending: boolean;
  profile: { id: string; role: string; organization_id: string | null };
}

let app: AppMock;
vi.mock('@/app/AppContext', () => ({ useApp: () => app }));

function setApp(patch: Partial<AppMock>) {
  app = { ...app, ...patch };
}

const EN = {
  title: 'Supplementary Purchases',
  notApplicable: 'This organization type does not use supplementary procurement',
  notApplicableHint: 'Supplementary procurement is available to care institutions only',
  noWarehouse: 'No institution warehouse in your scope',
  noOrg: 'Select an organization to view data',
};
const AR = {
  title: 'المشتريات الفرعية',
  notApplicable: 'هذا النوع من المنظمات لا يستخدم المشتريات الفرعية',
  notApplicableHint: 'المشتريات الفرعية متاحة للمؤسسات الصحية فقط',
  noWarehouse: 'لا يوجد مخزن مؤسسة ضمن صلاحياتك',
};

function hookCallOrgIds(): unknown[] {
  return [
    ...hooks.useInventoryScopes.mock.calls.map(call => call[0]),
    ...hooks.useProcurementPermissions.mock.calls.map(call => call[0]),
  ];
}

function expectNoWorkspace() {
  expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  expect(screen.queryByTestId('direct-entry-stub')).not.toBeInTheDocument();
  expect(screen.queryByTestId('purchase-history-stub')).not.toBeInTheDocument();
  expect(screen.queryByText(EN.noWarehouse)).not.toBeInTheDocument();
  expect(screen.queryByText(AR.noWarehouse)).not.toBeInTheDocument();
}

beforeEach(() => {
  hooks.useInventoryScopes.mockReset();
  hooks.useProcurementPermissions.mockReset();
  hooks.useInventoryScopes.mockImplementation(() => ({
    data: {
      organizationId: CARE_ORG,
      warehouses: [],
      outlets: [],
      manageableWarehouses: [{
        kind: 'warehouse', id: 'wh-care-1', name: 'Care Store', nameAr: 'مخزن المؤسسة',
        warehouseId: null, warehouseKind: 'institution',
      }],
      manageableOutlets: [],
    },
    loading: false,
    error: null,
    reload: () => {},
  }));
  hooks.useProcurementPermissions.mockImplementation(() => ({
    data: { canView: true, canManage: true, canApprove: true, canReceive: true, canReturn: true },
    loading: false,
    error: null,
    reload: () => {},
  }));
  app = {
    lang: 'en',
    dir: 'ltr',
    role: 'institution_admin',
    activeOrgId: CARE_ORG,
    activeOrganizationKind: 'care_institution',
    activeOrganizationKindPending: false,
    profile: { id: 'profile-1', role: 'institution_admin', organization_id: CARE_ORG },
  };
});
afterEach(cleanup);

describe('PDA-PROC-1 · Screen 19 refuses a non-care organization without mounting the workspace', () => {
  it('a pharmacy department authority sees the not-applicable state, and no procurement hook ever runs', () => {
    setApp({ activeOrgId: PDA_ORG, activeOrganizationKind: 'pharmacy_department_authority' });
    render(<LocalProcurementScreen />);

    expect(screen.getByText(EN.notApplicable)).toBeInTheDocument();
    expect(screen.getByText(EN.notApplicableHint)).toBeInTheDocument();
    // The header still says where the user is: exactly one screen title.
    expect(screen.getAllByRole('heading', { name: EN.title })).toHaveLength(1);
    expectNoWorkspace();
    expect(hooks.useInventoryScopes).not.toHaveBeenCalled();
    expect(hooks.useProcurementPermissions).not.toHaveBeenCalled();
  });

  it('the same refusal in Arabic, right-to-left', () => {
    setApp({ lang: 'ar', dir: 'rtl', activeOrgId: PDA_ORG, activeOrganizationKind: 'pharmacy_department_authority' });
    const { container } = render(<LocalProcurementScreen />);

    expect(screen.getByText(AR.notApplicable)).toBeInTheDocument();
    expect(screen.getByText(AR.notApplicableHint)).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: AR.title })).toHaveLength(1);
    expect(container.firstElementChild).toHaveAttribute('dir', 'rtl');
    expectNoWorkspace();
    expect(hooks.useInventoryScopes).not.toHaveBeenCalled();
    expect(hooks.useProcurementPermissions).not.toHaveBeenCalled();
  });

  it('super_admin is NOT an exception: super_admin on a pharmacy department authority is refused too', () => {
    setApp({
      role: 'super_admin',
      profile: { id: 'profile-sa', role: 'super_admin', organization_id: null },
      activeOrgId: PDA_ORG,
      activeOrganizationKind: 'pharmacy_department_authority',
    });
    render(<LocalProcurementScreen />);

    expect(screen.getByText(EN.notApplicable)).toBeInTheDocument();
    expectNoWorkspace();
    expect(hooks.useInventoryScopes).not.toHaveBeenCalled();
    expect(hooks.useProcurementPermissions).not.toHaveBeenCalled();
  });

  it('a kind that settled to null (missing organization, unknown kind, failed read) is refused the same way', () => {
    setApp({ activeOrgId: CARE_ORG, activeOrganizationKind: null, activeOrganizationKindPending: false });
    render(<LocalProcurementScreen />);

    expect(screen.getByText(EN.notApplicable)).toBeInTheDocument();
    expectNoWorkspace();
    expect(hooks.useInventoryScopes).not.toHaveBeenCalled();
    expect(hooks.useProcurementPermissions).not.toHaveBeenCalled();
  });

  it('while the kind is still being read the screen waits (loading), mounts nothing and claims nothing', () => {
    setApp({ activeOrgId: CARE_ORG, activeOrganizationKind: null, activeOrganizationKindPending: true });
    render(<LocalProcurementScreen />);

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByText(EN.notApplicable)).not.toBeInTheDocument();
    expectNoWorkspace();
    expect(hooks.useInventoryScopes).not.toHaveBeenCalled();
    expect(hooks.useProcurementPermissions).not.toHaveBeenCalled();
  });

  it('with no active organization the existing organization-scope empty state is kept', () => {
    setApp({
      role: 'super_admin',
      profile: { id: 'profile-sa', role: 'super_admin', organization_id: null },
      activeOrgId: null,
      activeOrganizationKind: null,
      activeOrganizationKindPending: false,
    });
    render(<LocalProcurementScreen />);

    expect(screen.getByText(EN.noOrg)).toBeInTheDocument();
    expect(screen.queryByText(EN.notApplicable)).not.toBeInTheDocument();
    expectNoWorkspace();
    expect(hooks.useInventoryScopes).not.toHaveBeenCalled();
    expect(hooks.useProcurementPermissions).not.toHaveBeenCalled();
  });
});

describe('PDA-PROC-1 · a care institution keeps the workspace exactly as before', () => {
  it('mounts the workspace and its hooks for the care organization, with exactly one screen title', () => {
    render(<LocalProcurementScreen />);

    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(screen.getByTestId('direct-entry-stub')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: EN.title })).toHaveLength(1);
    expect(screen.getAllByTestId('org-scope-stub')).toHaveLength(1);
    expect(screen.queryByText(EN.notApplicable)).not.toBeInTheDocument();
    expect(hooks.useInventoryScopes).toHaveBeenCalledWith(CARE_ORG);
    expect(hooks.useProcurementPermissions).toHaveBeenCalledWith(CARE_ORG, 'wh-care-1');
  });

  it('super_admin on a care institution keeps the workspace', () => {
    setApp({ role: 'super_admin', profile: { id: 'profile-sa', role: 'super_admin', organization_id: null } });
    render(<LocalProcurementScreen />);

    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: EN.title })).toHaveLength(1);
    expect(hooks.useInventoryScopes).toHaveBeenCalledWith(CARE_ORG);
  });

  it('a care institution with no warehouse in scope still gets the existing no-warehouse message (unchanged)', () => {
    hooks.useInventoryScopes.mockImplementation(() => ({
      data: { organizationId: CARE_ORG, warehouses: [], outlets: [], manageableWarehouses: [], manageableOutlets: [] },
      loading: false,
      error: null,
      reload: () => {},
    }));
    render(<LocalProcurementScreen />);

    expect(screen.getByText(EN.noWarehouse)).toBeInTheDocument();
    expect(screen.queryByText(EN.notApplicable)).not.toBeInTheDocument();
  });
});

describe('PDA-PROC-1 · switching organizations', () => {
  it('care -> pharmacy department (pending, then settled): the workspace unmounts and no hook ever sees the PDA org', () => {
    const { rerender } = render(<LocalProcurementScreen />);
    expect(screen.getByRole('tablist')).toBeInTheDocument();

    // The org changes; AppContext nulls the kind in the same render.
    setApp({ activeOrgId: PDA_ORG, activeOrganizationKind: null, activeOrganizationKindPending: true });
    rerender(<LocalProcurementScreen />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expectNoWorkspace();

    setApp({ activeOrganizationKind: 'pharmacy_department_authority', activeOrganizationKindPending: false });
    rerender(<LocalProcurementScreen />);
    expect(screen.getByText(EN.notApplicable)).toBeInTheDocument();
    expectNoWorkspace();

    expect(hookCallOrgIds()).not.toContain(PDA_ORG);
    expect(hookCallOrgIds().length).toBeGreaterThan(0);
  });

  it('care -> care: the workspace returns for the new care organization once its kind settles', () => {
    const { rerender } = render(<LocalProcurementScreen />);
    expect(screen.getByRole('tablist')).toBeInTheDocument();

    setApp({ activeOrgId: CARE_ORG_2, activeOrganizationKind: null, activeOrganizationKindPending: true });
    rerender(<LocalProcurementScreen />);
    expectNoWorkspace();

    setApp({ activeOrganizationKind: 'care_institution', activeOrganizationKindPending: false });
    rerender(<LocalProcurementScreen />);
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: EN.title })).toHaveLength(1);
    expect(hooks.useInventoryScopes).toHaveBeenLastCalledWith(CARE_ORG_2);
  });
});
