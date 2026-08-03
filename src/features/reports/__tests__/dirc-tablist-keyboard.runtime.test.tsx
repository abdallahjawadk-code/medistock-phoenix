/**
 * @vitest-environment jsdom
 *
 * PHASE-C4-TAB-ACCESSIBILITY — genuine DOM/keyboard runtime proof for the
 * Screen 21 tablist's WAI-ARIA horizontal tab pattern: role/id/aria-controls/
 * aria-labelledby wiring, roving tabIndex, ArrowLeft/ArrowRight/Home/End
 * navigation (both LTR and RTL, with wrap-around), scoping strictly to the
 * currently-ALLOWED tabs (never Global for a non-super_admin, never a tab
 * hidden by C3's UNION contract), and focus safety when the active tab
 * disappears after a permission change. Mirrors all-tabs-mount.runtime.
 * test.tsx's mock setup (the one place already proven to mount the whole
 * screen cleanly) — this file adds real keyboard interaction on top of it,
 * not a source-scan.
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
  getOrganizationDataMode: async () => ({ status: 'official' as const }),
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
let currentDir: 'rtl' | 'ltr' = 'ltr';
let currentActiveOrgId: string | null = 'org1';

vi.mock('@/app/AppContext', () => ({
  useApp: () => ({
    lang: currentDir === 'rtl' ? 'ar' : 'en', dir: currentDir, activeOrgId: currentActiveOrgId, role: currentRole,
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
  { id: 'inst1', name: 'Institution A', name_ar: 'مؤسسة أ', code: 'inst-a', status: 'active', city: 'بابل', available: 40, low: 5, missing: 2 },
];

describe('DIRC tablist — WAI-ARIA structure (runtime, not source-scan)', () => {
  beforeEach(() => {
    currentRole = 'super_admin';
    permissions = new Set(['reports.view', 'status_center.view', 'audit.view']);
    currentDir = 'ltr';
    getExecutiveOverview.mockResolvedValue(OVERVIEW);
    getInstitutionOverviews.mockResolvedValue(INSTITUTIONS);
    getOpenMonthlyStatusReport.mockResolvedValue(null);
    getLatestLockedMonthlyStatusReport.mockResolvedValue(null);
    getMonthlyStatusLines.mockResolvedValue([]);
  });
  afterEach(cleanup);

  it('the container is a real tablist with an aria-label, and every tab has id/aria-controls/aria-selected wired to a matching tabpanel', async () => {
    render(<DecisionIntelligenceReportsScreen onNavigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('executive-overview-tab')).toBeInTheDocument());

    const tablist = screen.getByRole('tablist');
    expect(tablist).toHaveAttribute('aria-label');
    expect(tablist.getAttribute('aria-label')).not.toBe('');

    const tabs = screen.getAllByRole('tab');
    expect(tabs.length).toBeGreaterThan(0);
    for (const tabEl of tabs) {
      expect(tabEl.id).toMatch(/^dirc-tab-/);
      const controlsId = tabEl.getAttribute('aria-controls');
      expect(controlsId).toMatch(/^dirc-tabpanel-/);
      expect(tabEl).toHaveAttribute('aria-selected');
    }

    const activeTabEl = tabs.find(tabEl => tabEl.getAttribute('aria-selected') === 'true')!;
    expect(activeTabEl).toBeDefined();
    const panel = document.getElementById(activeTabEl.getAttribute('aria-controls')!);
    expect(panel).not.toBeNull();
    expect(panel).toHaveAttribute('role', 'tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', activeTabEl.id);
  });

  it('only the active tab has tabIndex 0 — every other visible tab has tabIndex -1 (roving tabindex)', async () => {
    render(<DecisionIntelligenceReportsScreen onNavigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('executive-overview-tab')).toBeInTheDocument());

    const tabs = screen.getAllByRole('tab');
    const active = tabs.filter(tabEl => tabEl.tabIndex === 0);
    const inactive = tabs.filter(tabEl => tabEl.tabIndex === -1);
    expect(active).toHaveLength(1);
    expect(inactive).toHaveLength(tabs.length - 1);
    expect(active[0].getAttribute('aria-selected')).toBe('true');
  });

  it('Global Material Search never appears in the tab order for a non-super_admin, even in the keyboard sequence', async () => {
    currentRole = 'institution_admin';
    permissions = new Set(['reports.view', 'status_center.view', 'audit.view']);
    render(<DecisionIntelligenceReportsScreen onNavigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('executive-overview-tab')).toBeInTheDocument());

    const tabs = screen.getAllByRole('tab');
    expect(tabs.some(tabEl => tabEl.textContent === 'Global Material Search')).toBe(false);
    expect(tabs.at(-1)!.textContent).not.toBe('Global Material Search');
  });
});

describe('DIRC tablist — keyboard navigation, LTR (runtime, not source-scan)', () => {
  beforeEach(() => {
    currentRole = 'super_admin';
    permissions = new Set(['reports.view', 'status_center.view', 'audit.view']);
    currentDir = 'ltr';
    getExecutiveOverview.mockResolvedValue(OVERVIEW);
    getInstitutionOverviews.mockResolvedValue(INSTITUTIONS);
    getOpenMonthlyStatusReport.mockResolvedValue(null);
    getLatestLockedMonthlyStatusReport.mockResolvedValue(null);
    getMonthlyStatusLines.mockResolvedValue([]);
  });
  afterEach(cleanup);

  it('ArrowRight moves focus AND activation to the NEXT tab; ArrowLeft moves to the PREVIOUS one', async () => {
    render(<DecisionIntelligenceReportsScreen onNavigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('executive-overview-tab')).toBeInTheDocument());

    const tabs = screen.getAllByRole('tab');
    const first = tabs[0];
    const second = tabs[1];
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });

    expect(document.activeElement).toBe(second);
    expect(second).toHaveAttribute('aria-selected', 'true');
    expect(first).toHaveAttribute('aria-selected', 'false');

    fireEvent.keyDown(second, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(first);
    expect(first).toHaveAttribute('aria-selected', 'true');
  });

  it('ArrowLeft on the FIRST tab wraps to the LAST allowed tab; ArrowRight on the LAST wraps to the FIRST', async () => {
    render(<DecisionIntelligenceReportsScreen onNavigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('executive-overview-tab')).toBeInTheDocument());

    const tabs = screen.getAllByRole('tab');
    const first = tabs[0];
    const last = tabs.at(-1)!;

    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(last);
    expect(last).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(last, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(first);
    expect(first).toHaveAttribute('aria-selected', 'true');
  });

  it('Home jumps to the first allowed tab, End jumps to the last allowed tab, from anywhere in the middle', async () => {
    render(<DecisionIntelligenceReportsScreen onNavigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('executive-overview-tab')).toBeInTheDocument());

    const tabs = screen.getAllByRole('tab');
    const middle = tabs[Math.floor(tabs.length / 2)];
    middle.focus();

    fireEvent.keyDown(middle, { key: 'End' });
    expect(document.activeElement).toBe(tabs.at(-1)!);
    expect(tabs.at(-1)!).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(tabs.at(-1)!, { key: 'Home' });
    expect(document.activeElement).toBe(tabs[0]);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('keyboard navigation is scoped to allowed tabs only — Home/End never reach a tab hidden by role/permissions', async () => {
    currentRole = 'warehouse_officer';
    permissions = new Set<string>();
    render(<DecisionIntelligenceReportsScreen onNavigate={vi.fn()} initialTab="monthly" />);
    await waitFor(() => expect(screen.getByTestId('monthly-position-tab')).toBeInTheDocument());

    const tabs = screen.getAllByRole('tab');
    // warehouse_officer with no extra permissions: only the authenticated_rls
    // tabs are allowed (movements/audit require explicit permissions this
    // role lacks) — Global is always excluded for a non-super_admin.
    expect(tabs.map(tabEl => tabEl.textContent)).not.toContain('Global Material Search');
    expect(tabs.map(tabEl => tabEl.textContent)).not.toContain('Stock Movements');
    expect(tabs.map(tabEl => tabEl.textContent)).not.toContain('Audit-Sensitive Actions');

    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: 'End' });
    expect(document.activeElement).toBe(tabs.at(-1)!);
    expect(tabs.at(-1)!.textContent).not.toBe('Global Material Search');
  });
});

describe('DIRC tablist — keyboard navigation, RTL (runtime, not source-scan)', () => {
  beforeEach(() => {
    currentRole = 'super_admin';
    permissions = new Set(['reports.view', 'status_center.view', 'audit.view']);
    currentDir = 'rtl';
    getExecutiveOverview.mockResolvedValue(OVERVIEW);
    getInstitutionOverviews.mockResolvedValue(INSTITUTIONS);
    getOpenMonthlyStatusReport.mockResolvedValue(null);
    getLatestLockedMonthlyStatusReport.mockResolvedValue(null);
    getMonthlyStatusLines.mockResolvedValue([]);
  });
  afterEach(cleanup);

  it('in RTL, ArrowRight moves to the PREVIOUS tab and ArrowLeft moves to the NEXT — matching visual order', async () => {
    render(<DecisionIntelligenceReportsScreen onNavigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('executive-overview-tab')).toBeInTheDocument());

    const tabs = screen.getAllByRole('tab');
    const first = tabs[0];
    const second = tabs[1];

    // ArrowLeft on the first tab (RTL "next" direction) should move to the
    // second tab, the mirror image of the LTR ArrowRight behavior.
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(second);
    expect(second).toHaveAttribute('aria-selected', 'true');

    // ArrowRight on the second tab (RTL "previous") returns to the first.
    fireEvent.keyDown(second, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(first);
    expect(first).toHaveAttribute('aria-selected', 'true');
  });

  it('RTL wrap-around: ArrowRight on the first tab wraps to the last; ArrowLeft on the last wraps to the first', async () => {
    render(<DecisionIntelligenceReportsScreen onNavigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('executive-overview-tab')).toBeInTheDocument());

    const tabs = screen.getAllByRole('tab');
    const first = tabs[0];
    const last = tabs.at(-1)!;

    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(last);

    fireEvent.keyDown(last, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(first);
  });

  it('Home/End are direction-agnostic — Home is still the first tab, End is still the last, even in RTL', async () => {
    render(<DecisionIntelligenceReportsScreen onNavigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('executive-overview-tab')).toBeInTheDocument());
    const tabs = screen.getAllByRole('tab');
    const middle = tabs[Math.floor(tabs.length / 2)];
    middle.focus();
    fireEvent.keyDown(middle, { key: 'Home' });
    expect(document.activeElement).toBe(tabs[0]);
    fireEvent.keyDown(tabs[0], { key: 'End' });
    expect(document.activeElement).toBe(tabs.at(-1)!);
  });
});

describe('DIRC tablist — focus safety after a permission change (runtime, not source-scan)', () => {
  beforeEach(() => {
    currentRole = 'super_admin';
    permissions = new Set(['reports.view', 'status_center.view', 'audit.view']);
    currentDir = 'ltr';
    getExecutiveOverview.mockResolvedValue(OVERVIEW);
    getInstitutionOverviews.mockResolvedValue(INSTITUTIONS);
    getOpenMonthlyStatusReport.mockResolvedValue(null);
    getLatestLockedMonthlyStatusReport.mockResolvedValue(null);
    getMonthlyStatusLines.mockResolvedValue([]);
  });
  afterEach(cleanup);

  it('losing access to the active tab falls back to the first allowed tab and does not strand focus on a removed element', async () => {
    const { rerender } = render(<DecisionIntelligenceReportsScreen onNavigate={vi.fn()} initialTab="audit" />);
    await waitFor(() => expect(screen.getByTestId('audit-tab')).toBeInTheDocument());

    const auditTabBtn = screen.getByRole('tab', { name: 'Audit-Sensitive Actions' });
    auditTabBtn.focus();
    expect(document.activeElement).toBe(auditTabBtn);

    // Simulate a permission change: audit.view revoked mid-session.
    permissions = new Set(['reports.view', 'status_center.view']);
    rerender(<DecisionIntelligenceReportsScreen onNavigate={vi.fn()} initialTab="audit" />);

    await waitFor(() => expect(screen.queryByTestId('audit-tab')).not.toBeInTheDocument());
    // The existing C3 fallback landed on the first allowed tab...
    await waitFor(() => expect(screen.getByTestId('executive-overview-tab')).toBeInTheDocument());
    // ...and focus was moved to ITS button, not left on the removed audit
    // tab (which no longer exists in the DOM) or dropped to document.body.
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Executive Overview' }));
  });

  it('losing access to every tab renders ForbiddenScreen, not a crash', async () => {
    currentRole = null;
    render(<DecisionIntelligenceReportsScreen onNavigate={vi.fn()} />);
    expect(screen.getByText('You do not have access to this page')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });
});

describe('DIRC — no activeOrgId must never trigger a broad (org-less) query (runtime, not source-scan)', () => {
  beforeEach(() => {
    currentRole = 'super_admin';
    permissions = new Set(['reports.view', 'status_center.view', 'audit.view']);
    currentDir = 'ltr';
    currentActiveOrgId = 'org1';
    getExecutiveOverview.mockClear();
    getInstitutionOverviews.mockClear();
  });
  afterEach(() => { currentActiveOrgId = 'org1'; cleanup(); });

  it('with no activeOrgId, shows the org-scope empty state instead of any tab, and never calls a single report data loader', async () => {
    currentActiveOrgId = null;
    render(<DecisionIntelligenceReportsScreen onNavigate={vi.fn()} />);

    expect(screen.getByText('Select an organization to view data')).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();

    // Give any wrongly-fired effect a turn to resolve before asserting.
    await new Promise(r => setTimeout(r, 0));
    expect(getExecutiveOverview).not.toHaveBeenCalled();
    expect(getInstitutionOverviews).not.toHaveBeenCalled();
  });
});
