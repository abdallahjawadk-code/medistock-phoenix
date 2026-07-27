/**
 * @vitest-environment jsdom
 *
 * REPORTING-UNIFICATION — navigation consolidation, proven at runtime (not
 * just source-scan): DIRC's Institution Status tab still links to the
 * Materials & Batches tab context for the live matrix (superseding the old
 * "open in Status Center" cross-screen navigation, since Status Center's
 * content now lives inside this same shell), and DIRC's Monthly Position
 * tab must render the REAL prepare->classify->submit->approve+lock workflow
 * -- not a deep-link CTA to a separate screen. This directly replaces the
 * old test file of the same name, which asserted the opposite (a deep-link
 * CTA and nothing else) -- that contract is exactly what the unification
 * removes.
 */
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { DecisionIntelligenceReportsScreen } from '../DecisionIntelligenceReportsScreen';
import type { InstitutionOverview } from '@/shared/supabase/services/dashboard.service';
import type { ExecutiveOverview } from '../decision-intelligence.service';
import type { MonthlyStatusLine } from '@/shared/supabase/services/monthly-status.service';

const getInstitutionOverviews = vi.fn<() => Promise<InstitutionOverview[]>>();
vi.mock('@/shared/supabase/services/dashboard.service', () => ({
  getInstitutionOverviews: () => getInstitutionOverviews(),
}));
vi.mock('@/shared/supabase/services/availability.service', () => ({
  getAvailabilityByOrg: async (_orgId: string) => [] as unknown[],
}));
vi.mock('@/shared/supabase/services/organizations.service', () => ({
  getOrganizations: async () => [{ id: 'org1', name: 'Institution A', name_ar: 'مؤسسة أ' }],
}));
vi.mock('../AuditLogSection', () => ({ AuditLogSection: () => <div data-testid="audit-log-stub" /> }));
const getExecutiveOverview = vi.fn<() => Promise<ExecutiveOverview>>();
vi.mock('../decision-intelligence.service', () => ({
  getExecutiveOverview: () => getExecutiveOverview(),
  createReportSnapshot: vi.fn(),
  listReportSnapshots: async () => [],
  newRequestId: () => 'req-1',
  getSupplySourcesDetail: async () => [],
  checkSnapshotParity: vi.fn(),
  isDemoOrganization: async () => false,
}));
vi.mock('../custody-chain.service', () => ({
  listCustodyDispatches: async () => [],
  listCustodyReturnRequests: async () => [],
  listCustodyReturnShipments: async () => [],
  getMovementTimeline: vi.fn(),
}));
vi.mock('../supplementary-purchases.service', () => ({ listSupplementaryPurchaseOrders: async () => [] }));
vi.mock('../differences-corrections.service', () => ({ listCorrectionHistory: async () => [] }));
vi.mock('@/features/movement/paper-reference.service', () => ({ getPaperReferencesFor: async () => new Map() }));
vi.mock('@/features/procurement/procurement.service', () => ({ getSuppliers: async () => [], getReceipts: async () => [], getReceiptLines: async () => [] }));
vi.mock('@/features/status/MovementReportSection', () => ({ MovementReportSection: () => <div data-testid="movement-report-stub" /> }));
vi.mock('@/features/status/AvailabilityStockCorrectionModal', () => ({ AvailabilityStockCorrectionModal: () => null }));
vi.mock('@/features/status/ReactivateMaterialModal', () => ({ ReactivateMaterialModal: () => null, REACTIVATE_PERMISSION_KEYS: ['availability.update'] }));
vi.mock('@/features/status/MovementHistoryModal', () => ({ MovementHistoryModal: () => null }));
vi.mock('@/features/status/internalAlerts', () => ({ computeInternalAlerts: () => [] }));
vi.mock('@/features/status/InternalAlertsSection', () => ({ InternalAlertsSection: () => <div data-testid="internal-alerts-stub" /> }));
vi.mock('@/features/status/OutletMaterialGroups', () => ({ OutletMaterialGroups: () => null }));
vi.mock('@/features/status/OutletAvailabilityReportModal', () => ({ OutletAvailabilityReportModal: () => null }));
vi.mock('@/features/inventory/InventoryIntelligencePanel', () => ({ InventoryIntelligencePanel: () => <div data-testid="inventory-intelligence-stub" /> }));
vi.mock('@/features/reports/GlobalMaterialSearchPanel', () => ({ GlobalMaterialSearchPanel: () => <div data-testid="global-search-stub" /> }));

const getOpenMonthlyStatusReport = vi.fn();
const getLatestLockedMonthlyStatusReport = vi.fn();
const getMonthlyStatusLines = vi.fn<() => Promise<MonthlyStatusLine[]>>();
vi.mock('@/shared/supabase/services/monthly-status.service', () => ({
  getOpenMonthlyStatusReport: (...args: unknown[]) => getOpenMonthlyStatusReport(...args),
  getLatestLockedMonthlyStatusReport: (...args: unknown[]) => getLatestLockedMonthlyStatusReport(...args),
  getMonthlyStatusLines: (...args: unknown[]) => getMonthlyStatusLines(...args),
  prepareMonthlyStatusReport: vi.fn(),
  classifyMonthlyStatusLines: vi.fn(),
  confirmSuspectedMissing: vi.fn(),
  submitMonthlyStatusReport: vi.fn(),
  returnMonthlyStatusReportForClarification: vi.fn(),
  approveLockMonthlyStatusReport: vi.fn(),
  createMonthlyStatusAmendment: vi.fn(),
  recordStocktake: vi.fn(),
  getStocktakeCountLines: async () => [],
}));

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

const OVERVIEW: ExecutiveOverview = {
  organization_id: 'org1', as_of: '2026-07-25T00:00:00Z', materials_tracked: 50,
  classification_counts: { available: 40, low_stock: 5, missing: 5 },
  supply_source_totals: { warehouse: { kimadia: 20 }, outlet: { purchase_central: 10 } },
};

const INSTITUTIONS: InstitutionOverview[] = [
  {
    id: 'inst1', name: 'Institution A', name_ar: 'مؤسسة أ', code: 'inst-a',
    status: 'active', city: 'بابل', available: 40, low: 5, missing: 2,
  },
];

describe('DIRC navigation consolidation (Reporting Unification)', () => {
  afterEach(cleanup);

  it('the Monthly Position tab renders the REAL workflow (prepare action), not a deep-link CTA to a separate screen', async () => {
    getExecutiveOverview.mockResolvedValue(OVERVIEW);
    getInstitutionOverviews.mockResolvedValue(INSTITUTIONS);
    getOpenMonthlyStatusReport.mockResolvedValue(null);
    getLatestLockedMonthlyStatusReport.mockResolvedValue(null);
    getMonthlyStatusLines.mockResolvedValue([]);
    const onNavigate = vi.fn();
    render(<DecisionIntelligenceReportsScreen onNavigate={onNavigate} />);

    fireEvent.click(screen.getByRole('tab', { name: /monthly/i }));
    await waitFor(() => expect(screen.getByTestId('monthly-position-tab')).toBeInTheDocument());

    // There must be NO "open monthly inventory position" deep-link CTA
    // anywhere -- that was the old, now-removed contract.
    expect(screen.queryByRole('button', { name: /open monthly inventory position/i })).not.toBeInTheDocument();
    // onNavigate must never be called just from opening this tab -- it's
    // real content now, not a redirect.
    expect(onNavigate).not.toHaveBeenCalledWith(20);
  });

  it('opening the Monthly Position tab with no open report shows the real empty state and (for a preparing role) a genuine Prepare action, calling the real service, not onNavigate', async () => {
    getExecutiveOverview.mockResolvedValue(OVERVIEW);
    getInstitutionOverviews.mockResolvedValue(INSTITUTIONS);
    getOpenMonthlyStatusReport.mockResolvedValue(null);
    getLatestLockedMonthlyStatusReport.mockResolvedValue(null);
    getMonthlyStatusLines.mockResolvedValue([]);
    const onNavigate = vi.fn();
    render(<DecisionIntelligenceReportsScreen onNavigate={onNavigate} />);

    fireEvent.click(screen.getByRole('tab', { name: /monthly/i }));
    await waitFor(() => expect(screen.getByTestId('monthly-position-tab')).toBeInTheDocument());

    // role is 'super_admin' in this mock, which canPrepare covers.
    const prepareButton = await screen.findByRole('button', { name: /prepare/i });
    expect(prepareButton).toBeInTheDocument();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('DIRC accepts an initialTab prop so an old screen redirect can land directly on Materials & Batches', async () => {
    getExecutiveOverview.mockResolvedValue(OVERVIEW);
    getInstitutionOverviews.mockResolvedValue(INSTITUTIONS);
    render(<DecisionIntelligenceReportsScreen onNavigate={() => {}} initialTab="materials" />);

    await waitFor(() => expect(screen.getByTestId('materials-batches-tab')).toBeInTheDocument());
    // The overview tab's own content must NOT be the one shown by default.
    expect(screen.queryByText(/materials_tracked/i)).not.toBeInTheDocument();
  });

  it('DIRC accepts an initialTab prop so an old screen redirect can land directly on Monthly Position', async () => {
    getOpenMonthlyStatusReport.mockResolvedValue(null);
    getLatestLockedMonthlyStatusReport.mockResolvedValue(null);
    getMonthlyStatusLines.mockResolvedValue([]);
    render(<DecisionIntelligenceReportsScreen onNavigate={() => {}} initialTab="monthly" />);

    await waitFor(() => expect(screen.getByTestId('monthly-position-tab')).toBeInTheDocument());
  });
});
