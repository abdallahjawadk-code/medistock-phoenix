/**
 * @vitest-environment jsdom
 *
 * REPORTING-CLOSURE-FINAL Phase 2 — navigation consolidation, proven at
 * runtime (not just source-scan): DIRC's Institution Status tab must link
 * to Status Center (screen 12) instead of duplicating its live matrix, and
 * DIRC must gain a Monthly Position tab that deep-links to screen 20
 * without reimplementing its prepare->approve->lock workflow. Both are
 * pure navigation — this test proves onNavigate is called with the exact
 * screen number, nothing more.
 */
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { DecisionIntelligenceReportsScreen } from '../DecisionIntelligenceReportsScreen';
import type { InstitutionOverview } from '@/shared/supabase/services/dashboard.service';
import type { ExecutiveOverview } from '../decision-intelligence.service';

const getInstitutionOverviews = vi.fn<() => Promise<InstitutionOverview[]>>();
vi.mock('@/shared/supabase/services/dashboard.service', () => ({
  getInstitutionOverviews: () => getInstitutionOverviews(),
}));
vi.mock('@/shared/supabase/services/availability.service', () => ({
  getAvailabilityByOrg: async (_orgId: string) => [] as unknown[],
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

vi.mock('@/app/AppContext', () => ({
  useApp: () => ({
    lang: 'en', dir: 'ltr', activeOrgId: 'org1', role: 'super_admin',
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

describe('DIRC navigation consolidation (Phase 2)', () => {
  afterEach(cleanup);

  it('Institution Status tab renders a link that navigates to Status Center (screen 12), not a second live matrix', async () => {
    getExecutiveOverview.mockResolvedValue(OVERVIEW);
    getInstitutionOverviews.mockResolvedValue(INSTITUTIONS);
    const onNavigate = vi.fn();
    render(<DecisionIntelligenceReportsScreen onNavigate={onNavigate} />);

    fireEvent.click(screen.getByRole('tab', { name: /institution status/i }));
    await waitFor(() => expect(screen.getByTestId('institution-status-tab')).toBeInTheDocument());

    const link = screen.getByRole('button', { name: /open live matrix in status center/i });
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledWith(12);
  });

  it('a Monthly Position tab exists and deep-links to screen 20 without duplicating its workflow', async () => {
    getExecutiveOverview.mockResolvedValue(OVERVIEW);
    getInstitutionOverviews.mockResolvedValue(INSTITUTIONS);
    const onNavigate = vi.fn();
    render(<DecisionIntelligenceReportsScreen onNavigate={onNavigate} />);

    fireEvent.click(screen.getByRole('tab', { name: /monthly inventory position/i }));
    const cta = await screen.findByRole('button', { name: /open monthly inventory position/i });
    fireEvent.click(cta);
    expect(onNavigate).toHaveBeenCalledWith(20);
  });

  it('the Monthly Position tab renders exactly one action control (the deep-link CTA), no interactive workflow controls of its own', async () => {
    getExecutiveOverview.mockResolvedValue(OVERVIEW);
    getInstitutionOverviews.mockResolvedValue(INSTITUTIONS);
    render(<DecisionIntelligenceReportsScreen onNavigate={() => {}} />);

    fireEvent.click(screen.getByRole('tab', { name: /monthly inventory position/i }));
    await screen.findByRole('button', { name: /open monthly inventory position/i });
    // Elements with role="tab" are excluded from the "button" accessible
    // role, so this only counts real action controls — no
    // prepare/classify/submit/approve buttons duplicated here.
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent(/open monthly inventory position/i);
  });
});
