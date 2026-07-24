/**
 * @vitest-environment jsdom
 *
 * REPORTING_RECOVERY_UNBLOCK_AND_TWO_SURFACE_ACCEPTANCE — proves repeated
 * switching between the two reporting surfaces (ReportsScreen = screen 9,
 * DecisionIntelligenceReportsScreen = screen 21 in AuthenticatedApp.tsx's
 * own `switch (screen) { ... }` router) never crashes, never loses the
 * surrounding shell, and each screen re-runs its own async load cleanly
 * every time it remounts.
 *
 * This harness mirrors AuthenticatedApp's actual mechanism — a numeric
 * `screen` state driving a `switch` that returns one screen component at a
 * time — rather than importing AuthenticatedApp itself, which would pull in
 * ~20 unrelated screens and their own service dependencies. Both screens
 * under test already have their own dedicated hook-order/runtime test
 * suites (reports-screen.runtime.test.tsx, custody-chain-tab.runtime.test.tsx,
 * corrections-history-tab.runtime.test.tsx) — this file's only additional
 * concern is the MOUNT/UNMOUNT boundary between them.
 */
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { useState } from 'react';
import { ReportsScreen } from '../ReportsScreen';
import { DecisionIntelligenceReportsScreen } from '../DecisionIntelligenceReportsScreen';
import type { DashboardMetrics, InstitutionOverview } from '@/shared/supabase/services/dashboard.service';
import type { ExecutiveOverview } from '../decision-intelligence.service';

// ── ReportsScreen's own dependencies (screen 9) ─────────────────────────
const getDashboardMetrics = vi.fn<() => Promise<DashboardMetrics>>();
const getInstitutionOverviews = vi.fn<() => Promise<InstitutionOverview[]>>();
vi.mock('@/shared/supabase/services/dashboard.service', () => ({
  getDashboardMetrics: () => getDashboardMetrics(),
  getInstitutionOverviews: () => getInstitutionOverviews(),
}));
const getLowStockItems = vi.fn(async (_orgId: string) => [] as unknown[]);
vi.mock('@/shared/supabase/services/availability.service', () => ({
  getLowStockItems: (orgId: string) => getLowStockItems(orgId),
  getAvailabilityByOrg: async (_orgId: string) => [] as unknown[],
}));
vi.mock('../AuditLogSection', () => ({ AuditLogSection: () => <div data-testid="audit-log-stub" /> }));
vi.mock('../GlobalMaterialSearchPanel', () => ({ GlobalMaterialSearchPanel: () => <div data-testid="global-search-stub" /> }));

// ── DecisionIntelligenceReportsScreen's own dependencies (screen 21) ────
const getExecutiveOverview = vi.fn<() => Promise<ExecutiveOverview>>();
vi.mock('../decision-intelligence.service', () => ({
  getExecutiveOverview: () => getExecutiveOverview(),
  createReportSnapshot: vi.fn(),
  listReportSnapshots: async () => [],
  newRequestId: () => 'req-1',
  getSupplySourcesDetail: async () => [],
  checkSnapshotParity: vi.fn(),
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

// ── Shared AppContext mock (both screens read from it) ──────────────────
vi.mock('@/app/AppContext', () => ({
  useApp: () => ({
    lang: 'en', dir: 'ltr', activeOrgId: 'org1', role: 'super_admin',
    authz: { getContext: () => ({ authenticated: false }) },
  }),
}));

const METRICS: DashboardMetrics = {
  activeInstitutions: 3, activeWarehouses: 2, activePorts: 5, activeQrCodes: 10, disabledQrCodes: 1,
  availableItems: 100, lowStockCount: 4, missingCount: 2, nearExpiryCount: 1, surplusCount: 0,
  lastUpdated: '10:00',
} as DashboardMetrics;

const OVERVIEW: ExecutiveOverview = {
  organization_id: 'org1', as_of: '2026-07-25T00:00:00Z', materials_tracked: 50,
  classification_counts: { available: 40, low_stock: 5, missing: 5 },
  supply_source_totals: { warehouse: { kimadia: 20 }, outlet: { purchase_central: 10 } },
};

/** Mirrors AuthenticatedApp.tsx's own `switch (screen) { case 9: ...; case 21: ...; }` router. */
function TwoSurfaceHarness({ initial }: { initial: 9 | 21 }) {
  const [screenNum, setScreenNum] = useState<9 | 21>(initial);
  return (
    <div data-testid="app-shell">
      <div data-testid="nav">
        <button onClick={() => setScreenNum(9)}>Operational Reports</button>
        <button onClick={() => setScreenNum(21)}>Executive Reports</button>
      </div>
      {screenNum === 9 && <ReportsScreen />}
      {screenNum === 21 && <DecisionIntelligenceReportsScreen />}
    </div>
  );
}

describe('Two reporting surfaces — mount/unmount boundary (runtime, not source-scan)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getLowStockItems.mockResolvedValue([]);
  });
  afterEach(cleanup);

  it('opens ReportsScreen (screen 9) from a fresh session and loads real data', async () => {
    getDashboardMetrics.mockResolvedValue(METRICS);
    getInstitutionOverviews.mockResolvedValue([]);

    render(<TwoSurfaceHarness initial={9} />);
    await waitFor(() => expect(screen.getByText('100')).toBeInTheDocument());
    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
  });

  it('opens DecisionIntelligenceReportsScreen (screen 21) from a fresh session and loads real data', async () => {
    getExecutiveOverview.mockResolvedValue(OVERVIEW);

    render(<TwoSurfaceHarness initial={21} />);
    await waitFor(() => expect(screen.getByText('40')).toBeInTheDocument());
    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
  });

  it('switches from ReportsScreen to DecisionIntelligenceReportsScreen and back, repeatedly, without ever losing the shell or crashing', async () => {
    getDashboardMetrics.mockResolvedValue(METRICS);
    getInstitutionOverviews.mockResolvedValue([]);
    getExecutiveOverview.mockResolvedValue(OVERVIEW);

    render(<TwoSurfaceHarness initial={9} />);
    await waitFor(() => expect(screen.getByText('100')).toBeInTheDocument());

    for (let i = 0; i < 3; i++) {
      screen.getByRole('button', { name: 'Executive Reports' }).click();
      await waitFor(() => expect(screen.getByText('40')).toBeInTheDocument());
      expect(screen.getByTestId('app-shell')).toBeInTheDocument();
      expect(screen.getByTestId('nav')).toBeInTheDocument();

      screen.getByRole('button', { name: 'Operational Reports' }).click();
      await waitFor(() => expect(screen.getByText('100')).toBeInTheDocument());
      expect(screen.getByTestId('app-shell')).toBeInTheDocument();
      expect(screen.getByTestId('nav')).toBeInTheDocument();
    }

    // Neither screen's data-loading calls throw or leave the tree in a
    // half-mounted state after 3 full round trips.
    expect(getDashboardMetrics).toHaveBeenCalledTimes(4); // initial + 3 round trips back to screen 9
    expect(getExecutiveOverview).toHaveBeenCalledTimes(3);
  });

  it('Custody Chain (the previously-crashing R01 tab) survives being reached via a fresh remount after switching from ReportsScreen', async () => {
    getDashboardMetrics.mockResolvedValue(METRICS);
    getInstitutionOverviews.mockResolvedValue([]);
    getExecutiveOverview.mockResolvedValue(OVERVIEW);

    render(<TwoSurfaceHarness initial={9} />);
    await waitFor(() => expect(screen.getByText('100')).toBeInTheDocument());

    screen.getByRole('button', { name: 'Executive Reports' }).click();
    await waitFor(() => expect(screen.getByText('40')).toBeInTheDocument());

    screen.getByRole('tab', { name: /custody/i }).click();
    await waitFor(() => expect(screen.getByTestId('custody-chain-tab')).toBeInTheDocument());
    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
  });

  it('Differences & Corrections (the previously-defective R02 tab) survives being reached via a fresh remount after switching from ReportsScreen', async () => {
    getDashboardMetrics.mockResolvedValue(METRICS);
    getInstitutionOverviews.mockResolvedValue([]);
    getExecutiveOverview.mockResolvedValue(OVERVIEW);

    render(<TwoSurfaceHarness initial={9} />);
    await waitFor(() => expect(screen.getByText('100')).toBeInTheDocument());

    screen.getByRole('button', { name: 'Executive Reports' }).click();
    await waitFor(() => expect(screen.getByText('40')).toBeInTheDocument());

    screen.getByRole('tab', { name: /corrections/i }).click();
    // Empty-history is the expected state given the empty mock — the
    // assertion is simply that the screen shell is still there, not blank.
    await waitFor(() => expect(screen.getByTestId('app-shell')).toBeInTheDocument());
  });
});
