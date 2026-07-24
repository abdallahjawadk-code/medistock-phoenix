/**
 * @vitest-environment jsdom
 *
 * REPORTING_RECOVERY_UNBLOCK_AND_TWO_SURFACE_ACCEPTANCE — genuine runtime
 * coverage for ReportsScreen (the operational reporting surface), mirroring
 * the DecisionIntelligenceReportsScreen runtime tests. Unlike that screen,
 * ReportsScreen calls all three of its useAsync hooks unconditionally at the
 * top of the component body (no per-tab sub-components, no early returns
 * before a hook) — this test proves that structurally, and that it survives
 * the loading -> loaded transition, tab switching, and empty/error states
 * without ever unmounting the shell.
 */
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ReportsScreen } from '../ReportsScreen';
import type { DashboardMetrics, InstitutionOverview } from '@/shared/supabase/services/dashboard.service';

const getDashboardMetrics = vi.fn<() => Promise<DashboardMetrics>>();
const getInstitutionOverviews = vi.fn<() => Promise<InstitutionOverview[]>>();
vi.mock('@/shared/supabase/services/dashboard.service', () => ({
  getDashboardMetrics: () => getDashboardMetrics(),
  getInstitutionOverviews: () => getInstitutionOverviews(),
}));

const getLowStockItems = vi.fn(async (_orgId: string) => [] as unknown[]);
vi.mock('@/shared/supabase/services/availability.service', () => ({
  getLowStockItems: (orgId: string) => getLowStockItems(orgId),
}));

vi.mock('@/app/AppContext', () => ({
  useApp: () => ({
    lang: 'en', activeOrgId: 'org1', role: 'super_admin',
    authz: { getContext: () => ({ authenticated: false }) },
  }),
}));

// AuditLogSection and GlobalMaterialSearchPanel pull in their own data
// dependencies unrelated to this screen's own defects — stub them so this
// test targets ONLY ReportsScreen's own hook usage and tab-switch behavior.
vi.mock('../AuditLogSection', () => ({ AuditLogSection: () => <div data-testid="audit-log-stub" /> }));
vi.mock('../GlobalMaterialSearchPanel', () => ({ GlobalMaterialSearchPanel: () => <div data-testid="global-search-stub" /> }));

const METRICS: DashboardMetrics = {
  activeInstitutions: 3, activeWarehouses: 2, activePorts: 5, activeQrCodes: 10, disabledQrCodes: 1,
  availableItems: 100, lowStockCount: 4, missingCount: 2, nearExpiryCount: 1, surplusCount: 0,
  lastUpdated: '10:00',
} as DashboardMetrics;

const INSTITUTION: InstitutionOverview = {
  id: 'i1', name: 'Institution A', name_ar: 'مؤسسة أ', code: 'INST-A', status: 'active',
  city: 'Baghdad', available: 80, low: 15, missing: 5,
};

describe('ReportsScreen — loading to loaded transition, tab switching (runtime, not source-scan)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getLowStockItems.mockResolvedValue([]);
  });
  afterEach(cleanup);

  it('renders loading, then resolves the Summary tab, with no hook-order error and the shell intact', async () => {
    getDashboardMetrics.mockResolvedValue(METRICS);
    getInstitutionOverviews.mockResolvedValue([]);

    render(<ReportsScreen />);
    await waitFor(() => expect(screen.getByText('100')).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: /reports/i })).toBeInTheDocument();
  });

  it('switching tabs repeatedly never unmounts the screen and each tab loads its own data (no crash, no stale content)', async () => {
    getDashboardMetrics.mockResolvedValue(METRICS);
    getInstitutionOverviews.mockResolvedValue([INSTITUTION]);
    getLowStockItems.mockResolvedValue([
      { id: 'l1', quantity: 5, condition: 'low_stock', expiry_date: null, local_items: { central_items: { name: 'Paracetamol', name_ar: 'باراسيتامول', unit: 'box' } }, distribution_points: { name: 'Port A', name_ar: 'منفذ أ' } },
    ]);

    render(<ReportsScreen />);
    await waitFor(() => expect(screen.getByText('100')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /low/i }));
    await waitFor(() => expect(screen.getByText('Paracetamol')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /comparison/i }));
    await waitFor(() => expect(screen.getByText('Institution A')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^summary$/i }));
    await waitFor(() => expect(screen.getByText('100')).toBeInTheDocument());

    // The screen root never unmounts across any of these switches.
    expect(screen.getByRole('heading', { name: /reports/i })).toBeInTheDocument();
  });

  it('renders the empty state cleanly for the low-stock tab with a genuine zero-row result', async () => {
    getDashboardMetrics.mockResolvedValue(METRICS);
    getInstitutionOverviews.mockResolvedValue([]);
    getLowStockItems.mockResolvedValue([]);

    render(<ReportsScreen />);
    await waitFor(() => expect(screen.getByText('100')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /low/i }));

    await waitFor(() => expect(getLowStockItems).toHaveBeenCalledWith('org1'));
    // No crash, no infinite loading spinner left behind.
    expect(screen.queryByText('Loading')).not.toBeInTheDocument();
  });

  it('shows an error state (with retry) when the metrics load fails, and the shell survives', async () => {
    getDashboardMetrics.mockRejectedValue(new Error('metrics unavailable'));
    getInstitutionOverviews.mockResolvedValue([]);

    render(<ReportsScreen />);
    await waitFor(() => expect(screen.getByText('metrics unavailable')).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: /reports/i })).toBeInTheDocument();
  });

  it('the audit tab renders AuditLogSection without requiring org scope (extracted per PHASE2-HIDE-REPORTS-MOVE-AUDIT-TO-STATUS-CENTER-A)', async () => {
    getDashboardMetrics.mockResolvedValue(METRICS);
    getInstitutionOverviews.mockResolvedValue([]);

    render(<ReportsScreen />);
    await waitFor(() => expect(screen.getByText('100')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /audit/i }));
    expect(screen.getByTestId('audit-log-stub')).toBeInTheDocument();
  });

  it('confirms this screen has NO CSV/XLSX/Print action anywhere — a structural fact, not a defect (source-scan, since there is nothing to exercise at runtime)', () => {
    const source = readFileSync(join(__dirname, '../ReportsScreen.tsx'), 'utf8');
    expect(source).not.toMatch(/exportCsv|exportProfessionalXlsx|window\.print|triggerProfessionalPrint/);
  });
});
