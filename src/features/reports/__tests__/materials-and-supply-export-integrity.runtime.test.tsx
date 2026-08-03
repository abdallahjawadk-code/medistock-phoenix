/**
 * @vitest-environment jsdom
 *
 * PHASE-C4-OUTPUT-INTEGRITY — genuine DOM runtime proof for the two real
 * stale-export gaps this phase found and fixed:
 *   1. MaterialsAndBatchesTab: the on-screen table already correctly hides
 *      behind PhoenixErrorState once `live.error` is set (pre-existing,
 *      untouched behavior) — but exportXlsx()/printReport() only checked
 *      `rows.length === 0`, never `live.error`. Since `rows` derives from
 *      the STALE `live.data` useAsync retains through a failed reload,
 *      `rows.length` stayed > 0, so Export/Print stayed clickable and would
 *      have exported/printed data no longer shown anywhere on screen.
 *   2. SupplySourceDrilldown (nested inside ExecutiveOverviewTab): the same
 *      root cause, one level deeper, but WITHOUT the table's own error-gate
 *      — a failed reload of the expanded bucket's detail rows left the
 *      stale table (and its own export button) rendered ALONGSIDE the
 *      error message instead of hidden by it.
 * Both are proven here the same way: render with a successful load, switch
 * `orgId` (the real trigger for both useAsync deps arrays), let the second
 * load REJECT, and assert the previous (now-stale) rows are no longer
 * exportable — for (1) the on-screen table and its data both vanish behind
 * the error state and Export/Print flip to disabled; for (2) the stale
 * table and its export button disappear together with no error-state gap.
 */
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MaterialsAndBatchesTab, ExecutiveOverviewTab } from '../DecisionIntelligenceReportsScreen';
import type { ExecutiveOverview, SupplySourceDetailRow } from '../decision-intelligence.service';

const exportProfessionalXlsx = vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true);
const exportProfessionalMultiSheetXlsx = vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true);
const triggerProfessionalPrint = vi.fn<(...args: unknown[]) => { ok: boolean; mobileHtml: string | undefined }>(() => ({ ok: true, mobileHtml: undefined }));
const exportAvailabilityXlsx = vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true);
vi.mock('@/shared/lib/professional-export', () => ({
  exportProfessionalXlsx: (...args: unknown[]) => exportProfessionalXlsx(...args),
  exportProfessionalMultiSheetXlsx: (...args: unknown[]) => exportProfessionalMultiSheetXlsx(...args),
  triggerProfessionalPrint: (...args: unknown[]) => triggerProfessionalPrint(...args),
  exportAvailabilityXlsx: (...args: unknown[]) => exportAvailabilityXlsx(...args),
}));

const getAvailabilityByOrg = vi.fn();
vi.mock('@/shared/supabase/services/availability.service', () => ({
  getAvailabilityByOrg: (orgId: string) => getAvailabilityByOrg(orgId),
}));
vi.mock('@/shared/supabase/services/organizations.service', () => ({
  getOrganizations: async () => [
    { id: 'org1', name: 'Institution A', name_ar: 'مؤسسة أ' },
    { id: 'org2', name: 'Institution B', name_ar: 'مؤسسة ب' },
  ],
}));

const getExecutiveOverview = vi.fn();
const getSupplySourcesDetail = vi.fn();
vi.mock('../decision-intelligence.service', () => ({
  getExecutiveOverview: (orgId: string) => getExecutiveOverview(orgId),
  getSupplySourcesDetail: (orgId: string, key: string) => getSupplySourcesDetail(orgId, key),
  createReportSnapshot: vi.fn(),
  listReportSnapshots: async () => [],
  newRequestId: () => 'req-1',
  checkSnapshotParity: vi.fn(),
  getOrganizationDataMode: async () => ({ status: 'official' as const }),
}));

vi.mock('@/features/status/AvailabilityStockCorrectionModal', () => ({ AvailabilityStockCorrectionModal: () => null }));
vi.mock('@/features/status/ReactivateMaterialModal', () => ({ ReactivateMaterialModal: () => null, REACTIVATE_PERMISSION_KEYS: ['availability.update'] }));
vi.mock('@/features/status/MovementHistoryModal', () => ({ MovementHistoryModal: () => null }));
vi.mock('@/features/status/internalAlerts', () => ({ computeInternalAlerts: () => [] }));
vi.mock('@/features/status/InternalAlertsSection', () => ({ InternalAlertsSection: () => <div data-testid="internal-alerts-stub" /> }));
vi.mock('@/features/status/OutletMaterialGroups', () => ({ OutletMaterialGroups: () => null }));
vi.mock('@/features/status/OutletAvailabilityReportModal', () => ({ OutletAvailabilityReportModal: () => null }));
vi.mock('@/features/inventory/InventoryIntelligencePanel', () => ({ InventoryIntelligencePanel: () => <div data-testid="inventory-intelligence-stub" /> }));
vi.mock('@/features/inventory/useInventoryScopes', () => ({
  useInventoryScopes: () => ({ data: { manageableWarehouses: [], manageableOutlets: [] } }),
}));
vi.mock('@/app/AppContext', () => ({
  useApp: () => ({
    lang: 'en', dir: 'ltr', activeOrgId: 'org1', role: 'super_admin',
    myPermissions: new Set<string>(),
    authz: { getContext: () => ({ authenticated: false }) },
  }),
}));

const ROWS_ORG1 = [
  {
    id: 'row-1', scientific_name: 'Paracetamol', trade_name: 'Panadol', dosage_form: 'tablet',
    concentration: '500mg', quantity: 40, condition: 'available', expiry_date: '2027-01-01',
    supply_type: 'kimadia', updated_at: '2026-07-01T00:00:00Z',
    distribution_points: { id: 'dp1', name: 'Outlet A', name_ar: 'منفذ أ', status: 'active' },
  },
];

const ROWS_ORG1_TWO_MATERIALS = [
  ...ROWS_ORG1,
  {
    id: 'row-2', scientific_name: 'Amoxicillin', trade_name: 'Amoxil', dosage_form: 'capsule',
    concentration: '250mg', quantity: 15, condition: 'available', expiry_date: '2027-03-01',
    supply_type: 'kimadia', updated_at: '2026-07-01T00:00:00Z',
    distribution_points: { id: 'dp1', name: 'Outlet A', name_ar: 'منفذ أ', status: 'active' },
  },
];

const ROWS_ORG2 = [
  {
    id: 'row-9', scientific_name: 'Ibuprofen', trade_name: 'Advil', dosage_form: 'tablet',
    concentration: '200mg', quantity: 25, condition: 'available', expiry_date: '2027-06-01',
    supply_type: 'purchases', updated_at: '2026-07-02T00:00:00Z',
    distribution_points: { id: 'dp2', name: 'Outlet B', name_ar: 'منفذ ب', status: 'active' },
  },
];

const OVERVIEW_BASE: Omit<ExecutiveOverview, 'organization_id'> = {
  as_of: '2026-07-25T00:00:00Z', materials_tracked: 50,
  classification_counts: { available: 40, low_stock: 5, missing: 5 },
  supply_source_totals: { warehouse: { kimadia: 20 }, outlet: {} },
};

const DETAIL_ORG1: SupplySourceDetailRow[] = [
  {
    lot_id: 'lot-1', scientific_name: 'Paracetamol', trade_name: 'Panadol',
    location_name: 'Outlet A', location_name_ar: 'منفذ أ',
    batch_number: 'B-100', expiry_date: '2027-01-01', on_hand_quantity: 40,
  } as SupplySourceDetailRow,
];

// This suite's vitest config has no clearMocks/resetMocks — every spy call
// count and .mock.calls[0] assertion below assumes a clean slate per test.
beforeEach(() => {
  exportProfessionalXlsx.mockClear();
  exportProfessionalMultiSheetXlsx.mockClear();
  triggerProfessionalPrint.mockClear();
  exportAvailabilityXlsx.mockClear();
  getAvailabilityByOrg.mockReset();
});

describe('MaterialsAndBatchesTab — export/print stay enabled through a clean load (baseline)', () => {
  afterEach(cleanup);

  it('a normal successful load leaves Export/Print enabled with the fetched rows on screen', async () => {
    getAvailabilityByOrg.mockResolvedValue(ROWS_ORG1);
    render(
      <MaterialsAndBatchesTab
        orgId="org1" lang="en" role="super_admin" myPermissions={new Set()}
        onToast={vi.fn()} onMobilePrint={vi.fn()} onNavigate={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText('Paracetamol', { exact: false })).toBeInTheDocument());

    const exportBtn = screen.getByRole('button', { name: /Excel/i });
    const printBtn = screen.getByRole('button', { name: 'Print report' });
    expect(exportBtn).not.toBeDisabled();
    expect(printBtn).not.toBeDisabled();
  });
});

describe('MaterialsAndBatchesTab — a failed refresh after an org switch must never leave stale rows exportable', () => {
  afterEach(cleanup);

  it('rows stay visible (stale) but Export/Print flip to disabled, and the export/print functions are never invoked while disabled', async () => {
    getAvailabilityByOrg.mockImplementation(async (orgId: string) => {
      if (orgId === 'org1') return ROWS_ORG1;
      throw new Error('network unreachable');
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { rerender } = render(
      <MaterialsAndBatchesTab
        orgId="org1" lang="en" role="super_admin" myPermissions={new Set()}
        onToast={vi.fn()} onMobilePrint={vi.fn()} onNavigate={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText('Paracetamol', { exact: false })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Excel/i })).not.toBeDisabled();

    rerender(
      <MaterialsAndBatchesTab
        orgId="org2" lang="en" role="super_admin" myPermissions={new Set()}
        onToast={vi.fn()} onMobilePrint={vi.fn()} onNavigate={vi.fn()}
      />,
    );

    // The materials TABLE is already correctly hidden behind the error state
    // (pre-existing behavior, unrelated to this phase's fix) — the bug this
    // phase fixed is one level up: `rows` (derived from the STALE retained
    // live.data) still had length > 0, so a gate based only on
    // `rows.length === 0` would have left Export/Print clickable even
    // though the screen itself shows nothing but an error.
    await waitFor(() => expect(screen.getByText('Could not load data')).toBeInTheDocument());
    expect(screen.queryByText('Paracetamol', { exact: false })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Excel/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Print report' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /Excel/i }));
    expect(exportAvailabilityXlsx).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});

describe('SupplySourceDrilldown (via ExecutiveOverviewTab) — a failed detail reload must never leave a stale table + export button on screen', () => {
  afterEach(cleanup);
  beforeEach(() => {
    getExecutiveOverview.mockReset();
    getSupplySourcesDetail.mockReset();
  });

  it('an org switch while a bucket is expanded: the stale detail table and its export button disappear once the reload errors', async () => {
    getExecutiveOverview.mockImplementation(async (orgId: string) => ({ ...OVERVIEW_BASE, organization_id: orgId }));
    getSupplySourcesDetail.mockImplementation(async (orgId: string) => {
      if (orgId === 'org1') return DETAIL_ORG1;
      throw new Error('network unreachable');
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { rerender } = render(
      <ExecutiveOverviewTab orgId="org1" lang="en" onToast={vi.fn()} onMobilePrint={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByTestId('executive-overview-tab')).toBeInTheDocument());

    const bucketToggle = screen.getByRole('button', { name: /kimadia/i });
    fireEvent.click(bucketToggle);
    await waitFor(() => expect(screen.getByText('Panadol', { exact: false })).toBeInTheDocument());
    // Two "Export Excel" buttons exist while the bucket is open and clean:
    // ExecutiveOverviewTab's own top-level one, plus this nested bucket's.
    const beforeCount = screen.getAllByRole('button', { name: /Excel/i }).length;
    expect(beforeCount).toBe(2);

    rerender(<ExecutiveOverviewTab orgId="org2" lang="en" onToast={vi.fn()} onMobilePrint={vi.fn()} />);

    // Once the org2 reload errors, the stale org1 detail table (and its own
    // nested export button) must be replaced by the error state — never
    // rendered alongside it. Only the unrelated top-level export button
    // (ExecutiveOverviewTab's own, whose OWN overview data never errored)
    // remains.
    await waitFor(() => expect(screen.queryByText('Panadol', { exact: false })).not.toBeInTheDocument());
    expect(screen.getAllByRole('button', { name: /Excel/i })).toHaveLength(1);

    consoleSpy.mockRestore();
  });
});

describe('MaterialsAndBatchesTab — an org switch that succeeds must never leak the previous organization\'s rows', () => {
  afterEach(cleanup);

  it('org A\'s row is fully replaced by org B\'s row once the second (successful) load resolves', async () => {
    getAvailabilityByOrg.mockImplementation(async (orgId: string) => (orgId === 'org1' ? ROWS_ORG1 : ROWS_ORG2));

    const { rerender } = render(
      <MaterialsAndBatchesTab
        orgId="org1" lang="en" role="super_admin" myPermissions={new Set()}
        onToast={vi.fn()} onMobilePrint={vi.fn()} onNavigate={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText('Paracetamol', { exact: false })).toBeInTheDocument());

    rerender(
      <MaterialsAndBatchesTab
        orgId="org2" lang="en" role="super_admin" myPermissions={new Set()}
        onToast={vi.fn()} onMobilePrint={vi.fn()} onNavigate={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText('Ibuprofen', { exact: false })).toBeInTheDocument());
    expect(screen.queryByText('Paracetamol', { exact: false })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Excel/i })).not.toBeDisabled();
  });
});

describe('MaterialsAndBatchesTab — the current UI filter, not a stale one, is what gets exported', () => {
  afterEach(cleanup);

  it('narrowing the search filter changes both what is on screen and what exportXlsx() would send, live — no stale filter carries over', async () => {
    getAvailabilityByOrg.mockResolvedValue(ROWS_ORG1_TWO_MATERIALS);
    render(
      <MaterialsAndBatchesTab
        orgId="org1" lang="en" role="super_admin" myPermissions={new Set()}
        onToast={vi.fn()} onMobilePrint={vi.fn()} onNavigate={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByRole('cell', { name: 'Paracetamol' })).toBeInTheDocument());
    expect(screen.getByRole('cell', { name: 'Amoxicillin' })).toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search...' }), { target: { value: 'Amoxicillin' } });

    // The "Selected filters" summary line now also contains the word
    // "Amoxicillin" (e.g. "Search...: Amoxicillin") — scope to the table
    // cell specifically to avoid ambiguity with that summary text.
    await waitFor(() => expect(screen.queryByRole('cell', { name: 'Paracetamol' })).not.toBeInTheDocument());
    expect(screen.getByRole('cell', { name: 'Amoxicillin' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Excel/i }));
    await waitFor(() => expect(exportAvailabilityXlsx).toHaveBeenCalledTimes(1));
    const call = exportAvailabilityXlsx.mock.calls[0][0] as { rows: Array<{ scientificName: string }> };
    expect(call.rows).toHaveLength(1);
    expect(call.rows[0].scientificName).toBe('Amoxicillin');
  });
});

describe('MaterialsAndBatchesTab — a genuine (successful) empty result must be visibly distinct from an error, and never export anything', () => {
  afterEach(cleanup);

  it('an empty-but-successful load shows the live-empty message (not the error state) and keeps Export/Print disabled', async () => {
    getAvailabilityByOrg.mockResolvedValue([]);
    render(
      <MaterialsAndBatchesTab
        orgId="org1" lang="en" role="super_admin" myPermissions={new Set()}
        onToast={vi.fn()} onMobilePrint={vi.fn()} onNavigate={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText('No live availability records yet.')).toBeInTheDocument());
    expect(screen.queryByText('Could not load data')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Excel/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Print report' })).toBeDisabled();
  });
});

describe('MaterialsAndBatchesTab — export metadata and filenames reflect the CURRENT organization and language, never undefined/null', () => {
  afterEach(cleanup);

  it('exportXlsx() is called with the current org name baked into the filename and current lang in the config, for whichever org is active', async () => {
    getAvailabilityByOrg.mockImplementation(async (orgId: string) => (orgId === 'org1' ? ROWS_ORG1 : ROWS_ORG2));

    render(
      <MaterialsAndBatchesTab
        orgId="org2" lang="en" role="super_admin" myPermissions={new Set()}
        onToast={vi.fn()} onMobilePrint={vi.fn()} onNavigate={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText('Ibuprofen', { exact: false })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Excel/i }));
    await waitFor(() => expect(exportAvailabilityXlsx).toHaveBeenCalledTimes(1));
    const call = exportAvailabilityXlsx.mock.calls[0][0] as { fileNameBase: string; lang: string; rows: Array<{ institution: string }> };

    expect(call.lang).toBe('en');
    expect(call.fileNameBase).not.toMatch(/undefined|null/i);
    expect(call.fileNameBase).toContain('Institution_B');
    expect(call.rows[0].institution).toBe('Institution B');
  });
});
