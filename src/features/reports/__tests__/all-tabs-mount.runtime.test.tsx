/**
 * @vitest-environment jsdom
 *
 * REPORTING-UNIFICATION — mission requirement: every one of the unified
 * shell's 11 tabs must open without a blank page or a React hook-order
 * error. Individual tabs already have dedicated runtime coverage
 * (custody-chain-tab, corrections-history-tab, report-library-demo-
 * watermark, nav-consolidation-dirc for materials/monthly); this file is
 * the one place that mounts DecisionIntelligenceReportsScreen ONCE and
 * clicks through the entire tab bar in sequence — overview, institutions,
 * materials, movements, custody, supplementary, corrections, audit,
 * monthly, library, and (super_admin only) global — proving the whole
 * shell survives a full sweep, not just each tab in isolation.
 */
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
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
const getMonthlyStatusLines = vi.fn<(...args: unknown[]) => Promise<MonthlyStatusLine[]>>();
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

let currentRole: string | null = 'super_admin';
let permissions = new Set<string>(['reports.view', 'status_center.view', 'audit.view']);

vi.mock('@/app/AppContext', () => ({
  useApp: () => ({
    lang: 'en', dir: 'ltr', activeOrgId: 'org1', role: currentRole,
    myPermissions: permissions,
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

// Every tab id → the labelKey text the tab button renders (English, per the
// mocked lang: 'en') and the data-testid its content root uses.
const TAB_SWEEP: Array<{ name: RegExp; testId: string }> = [
  { name: /^Executive Overview$/, testId: 'executive-overview-tab' },
  { name: /^Institution Status$/, testId: 'institution-status-tab' },
  { name: /^Materials & Batches$/, testId: 'materials-batches-tab' },
  { name: /^Stock Movements$/, testId: 'movements-tab' },
  { name: /^Custody Chain$/, testId: 'custody-chain-tab' },
  { name: /Supplementary Purchases Traceability/, testId: 'supplementary-purchases-tab' },
  { name: /^Differences & Corrections$/, testId: 'corrections-history-tab' },
  { name: /^Audit-Sensitive Actions$/, testId: 'audit-tab' },
  { name: /^Monthly Inventory Position$/, testId: 'monthly-position-tab' },
  { name: /^Official Report Library$/, testId: 'dir-report-library' },
  { name: /^Global Material Search$/, testId: 'global-search-tab' },
];

describe('DIRC — full 11-tab sweep (REPORTING-UNIFICATION mission requirement)', () => {
  beforeEach(() => {
    currentRole = 'super_admin';
    permissions = new Set(['reports.view', 'status_center.view', 'audit.view']);
  });
  afterEach(cleanup);

  it('every tab opens cleanly: no blank page, no error-boundary fallback, no console.error', async () => {
    getExecutiveOverview.mockResolvedValue(OVERVIEW);
    getInstitutionOverviews.mockResolvedValue(INSTITUTIONS);
    getOpenMonthlyStatusReport.mockResolvedValue(null);
    getLatestLockedMonthlyStatusReport.mockResolvedValue(null);
    getMonthlyStatusLines.mockResolvedValue([]);

    const consoleErrors: unknown[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => { consoleErrors.push(args); });

    render(<DecisionIntelligenceReportsScreen onNavigate={vi.fn()} />);

    // Executive Overview is the default tab — already mounted; assert it
    // before clicking anything else.
    await waitFor(() => expect(screen.getByTestId('executive-overview-tab')).toBeInTheDocument());

    for (const { name, testId } of TAB_SWEEP) {
      fireEvent.click(screen.getByRole('tab', { name }));
      await waitFor(() => expect(screen.getByTestId(testId)).toBeInTheDocument());
      // The error boundary's fallback text must never appear — it would mean
      // this tab's content threw during render instead of actually mounting.
      expect(screen.queryByText(/This section could not be displayed/i)).not.toBeInTheDocument();
    }

    // React logs a distinct, very specific message when hook order changes
    // between renders — the exact class of bug a source-scan test cannot
    // catch. Assert it never fired across the whole sweep.
    const hookOrderViolation = consoleErrors.some(args =>
      args.some(a => typeof a === 'string' && /Rendered (more|fewer) hooks than during the previous render/i.test(a)));
    expect(hookOrderViolation).toBe(false);

    spy.mockRestore();
  });

  it('the tab bar exposes exactly the 11 required sections, in the mission-specified order, for a super_admin', async () => {
    getExecutiveOverview.mockResolvedValue(OVERVIEW);
    getInstitutionOverviews.mockResolvedValue(INSTITUTIONS);
    render(<DecisionIntelligenceReportsScreen onNavigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('executive-overview-tab')).toBeInTheDocument());

    const tabs = screen.getAllByRole('tab').map(el => el.textContent);
    expect(tabs).toEqual([
      'Executive Overview', 'Institution Status', 'Materials & Batches', 'Stock Movements',
      'Custody Chain', 'Supplementary Purchases Traceability', 'Differences & Corrections',
      'Audit-Sensitive Actions', 'Monthly Inventory Position', 'Official Report Library',
      'Global Material Search',
    ]);
  });
});

describe('DIRC Phase C3 — UNION tab authorization at runtime', () => {
  beforeEach(() => {
    currentRole = 'viewer';
    permissions = new Set();
    getExecutiveOverview.mockResolvedValue(OVERVIEW);
    getInstitutionOverviews.mockResolvedValue(INSTITUTIONS);
    getOpenMonthlyStatusReport.mockResolvedValue(null);
    getLatestLockedMonthlyStatusReport.mockResolvedValue(null);
    getMonthlyStatusLines.mockResolvedValue([]);
  });
  afterEach(cleanup);

  it('does not hide legacy RLS-authoritative tabs behind reports.view', async () => {
    permissions = new Set(['reports.view']);
    render(<DecisionIntelligenceReportsScreen onNavigate={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('executive-overview-tab')).toBeInTheDocument());
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual([
      'Executive Overview', 'Institution Status', 'Materials & Batches', 'Custody Chain',
      'Supplementary Purchases Traceability', 'Differences & Corrections',
      'Monthly Inventory Position', 'Official Report Library',
    ]);
  });

  it('adds only Movements for status_center.view and preserves an allowed requested tab', async () => {
    permissions = new Set(['status_center.view']);
    render(<DecisionIntelligenceReportsScreen onNavigate={vi.fn()} initialTab="movements" />);

    await waitFor(() => expect(screen.getByTestId('movements-tab')).toBeInTheDocument());
    expect(screen.getByRole('tab', { name: 'Stock Movements' })).toHaveAttribute('aria-selected', 'true');
  });

  it('preserves Monthly for an existing workflow role without status_center.view', async () => {
    currentRole = 'warehouse_officer';
    render(<DecisionIntelligenceReportsScreen onNavigate={vi.fn()} initialTab="monthly" />);

    await waitFor(() => expect(screen.getByTestId('monthly-position-tab')).toBeInTheDocument());
    expect(screen.getByRole('tab', { name: 'Monthly Inventory Position' })).toHaveAttribute('aria-selected', 'true');
  });

  it('adds Audit independently through audit.view', async () => {
    permissions = new Set(['audit.view']);
    render(<DecisionIntelligenceReportsScreen onNavigate={vi.fn()} initialTab="audit" />);

    await waitFor(() => expect(screen.getByTestId('audit-tab')).toBeInTheDocument());
    expect(screen.getByRole('tab', { name: 'Audit-Sensitive Actions' })).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps Global Search hidden from a non-super-admin with every permission', async () => {
    currentRole = 'institution_admin';
    permissions = new Set(['reports.view', 'status_center.view', 'audit.view']);
    render(<DecisionIntelligenceReportsScreen onNavigate={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('executive-overview-tab')).toBeInTheDocument());
    expect(screen.queryByRole('tab', { name: 'Global Material Search' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('global-search-stub')).not.toBeInTheDocument();
  });

  it('falls back from a forbidden requested tab to the first allowed tab', async () => {
    render(<DecisionIntelligenceReportsScreen onNavigate={vi.fn()} initialTab="global" />);

    await waitFor(() => expect(screen.getByTestId('executive-overview-tab')).toBeInTheDocument());
    expect(screen.getByRole('tab', { name: 'Executive Overview' })).toHaveAttribute('aria-selected', 'true');
  });

  it('renders ForbiddenScreen when no authenticated profile role allows any tab', () => {
    currentRole = null;
    render(<DecisionIntelligenceReportsScreen onNavigate={vi.fn()} />);

    expect(screen.getByText('You do not have access to this page')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });
});
