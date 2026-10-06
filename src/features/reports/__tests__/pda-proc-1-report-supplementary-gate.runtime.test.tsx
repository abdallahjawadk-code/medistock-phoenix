/**
 * @vitest-environment jsdom
 *
 * PDA-PROC-1 — Screen 21's supplementary tab is a care-institution surface.
 *
 * Screen 21 itself stays available under its existing authorization; only the
 * 'supplementary' tab is restricted, and the restriction lives in the
 * CENTRALIZED report-tab-access.ts decision (not in JSX): the tab is allowed
 * only when its existing rule allows it AND the active organization's
 * canonical organization_kind is 'care_institution'. A pharmacy department
 * authority, a null/unknown kind and a kind still being read are all denied,
 * and super_admin is not an exception.
 *
 * Part 1 proves the pure decision. Part 2 mounts the real
 * DecisionIntelligenceReportsScreen (same mock set as all-tabs-mount /
 * dirc-tablist-keyboard) and proves the runtime consequence: for a PDA
 * organization SupplementaryPurchasesTab never mounts, its two data reads
 * (listSupplementaryPurchaseOrders, getSuppliers) are never issued with the
 * PDA organization id, and an active supplementary tab falls back through the
 * existing resolveAllowedReportTab fallback when the organization switches.
 */
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { DecisionIntelligenceReportsScreen } from '../DecisionIntelligenceReportsScreen';
import {
  REPORT_TAB_ACCESS,
  REPORT_TAB_ORDER,
  allowedReportTabs,
  resolveAllowedReportTab,
  type ReportTab,
} from '../report-tab-access';
import { OFFICIAL_ROLES, isFacilityScopedRole } from '@/shared/lib/roles';
import { roleDefaults } from '@/shared/lib/permissions';
import type { OrganizationKind } from '@/shared/lib/institution-hierarchy';
import type { InstitutionOverview } from '@/shared/supabase/services/dashboard.service';
import type { ExecutiveOverview } from '../decision-intelligence.service';
import type { MonthlyStatusLine } from '@/shared/supabase/services/monthly-status.service';

// ═════════════════════════════════════════════════════════════════════════════
// Part 1 — the centralized decision
// ═════════════════════════════════════════════════════════════════════════════

const perms = (role: string) => new Set(roleDefaults(role));
const KINDS: ReadonlyArray<OrganizationKind | null | undefined> = [
  'care_institution', 'pharmacy_department_authority', null, undefined,
];

/** The pre-PDA-PROC-1 decision, re-derived independently from REPORT_TAB_ACCESS. */
function preExistingTabs(permissions: ReadonlySet<string>, role: string): ReportTab[] {
  return REPORT_TAB_ORDER.filter(tab => {
    const rule = REPORT_TAB_ACCESS[tab];
    if (rule.kind === 'authenticated_rls') return !isFacilityScopedRole(role);
    if (rule.kind === 'permission') return permissions.has(rule.permission);
    return role === rule.role;
  });
}

describe('PDA-PROC-1 · allowedReportTabs: supplementary needs a care institution', () => {
  it('a pharmacy department authority never gets the supplementary tab — for any role, super_admin included', () => {
    for (const role of OFFICIAL_ROLES) {
      expect(allowedReportTabs(perms(role), role, 'pharmacy_department_authority'), role).not.toContain('supplementary');
    }
    expect(allowedReportTabs(new Set(['reports.view', 'status_center.view', 'audit.view']), 'super_admin', 'pharmacy_department_authority'))
      .not.toContain('supplementary');
  });

  it('a null, omitted or unknown kind is denied too (fail closed)', () => {
    for (const role of OFFICIAL_ROLES) {
      expect(allowedReportTabs(perms(role), role, null), role).not.toContain('supplementary');
      expect(allowedReportTabs(perms(role), role), role).not.toContain('supplementary');
      expect(
        allowedReportTabs(perms(role), role, 'institution' as unknown as OrganizationKind),
        role,
      ).not.toContain('supplementary');
    }
  });

  it('a care institution keeps EXACTLY the pre-existing tab set for every role (supplementary included where it was)', () => {
    for (const role of OFFICIAL_ROLES) {
      expect(allowedReportTabs(perms(role), role, 'care_institution'), role).toEqual(preExistingTabs(perms(role), role));
    }
    expect(allowedReportTabs(new Set(), 'viewer', 'care_institution')).toContain('supplementary');
    expect(allowedReportTabs(new Set(), 'super_admin', 'care_institution')).toContain('supplementary');
  });

  it('every OTHER tab is independent of the organization kind', () => {
    const others = (tabs: ReportTab[]) => tabs.filter(tab => tab !== 'supplementary');
    for (const role of OFFICIAL_ROLES) {
      const care = others(allowedReportTabs(perms(role), role, 'care_institution'));
      for (const kind of KINDS) {
        expect(others(allowedReportTabs(perms(role), role, kind)), `${role}/${String(kind)}`).toEqual(care);
      }
    }
  });

  it('the facility-scoped denial is unchanged: a facility-scoped role gets no authenticated_rls tab, care or not', () => {
    for (const role of OFFICIAL_ROLES.filter(r => isFacilityScopedRole(r))) {
      for (const kind of KINDS) {
        const tabs = allowedReportTabs(perms(role), role, kind);
        for (const tab of REPORT_TAB_ORDER.filter(t => REPORT_TAB_ACCESS[t].kind === 'authenticated_rls')) {
          expect(tabs, `${role}/${String(kind)}/${tab}`).not.toContain(tab);
        }
      }
    }
  });

  it('REPORT_TAB_ACCESS is unchanged (the denial is layered, not a rule rewrite), and a null role still gets nothing', () => {
    expect(REPORT_TAB_ACCESS.supplementary).toEqual({ kind: 'authenticated_rls' });
    expect(allowedReportTabs(new Set(['reports.view']), null, 'care_institution')).toEqual([]);
  });

  it('the existing fallback lands an active supplementary tab on the first allowed tab once it is withheld', () => {
    const allowed = allowedReportTabs(new Set(), 'viewer', 'pharmacy_department_authority');
    expect(resolveAllowedReportTab('supplementary', allowed)).toBe('overview');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Part 2 — DecisionIntelligenceReportsScreen at runtime
// ═════════════════════════════════════════════════════════════════════════════

const spies = vi.hoisted(() => ({
  listSupplementaryPurchaseOrders: vi.fn(async (_orgId: string) => [] as unknown[]),
  getSuppliers: vi.fn(async (_orgId: string) => [] as unknown[]),
}));

const getInstitutionOverviews = vi.fn<() => Promise<InstitutionOverview[]>>();
vi.mock('@/shared/supabase/services/dashboard.service', () => ({
  getInstitutionOverviews: () => getInstitutionOverviews(),
}));
vi.mock('@/shared/supabase/services/availability.service', () => ({
  getAvailabilityByOrg: async (_orgId: string) => [] as unknown[],
}));
vi.mock('@/shared/supabase/services/organizations.service', () => ({
  getOrganizations: async () => [{ id: 'care-org-1', name: 'Institution A', name_ar: 'مؤسسة أ' }],
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
vi.mock('../supplementary-purchases.service', () => ({
  listSupplementaryPurchaseOrders: (orgId: string) => spies.listSupplementaryPurchaseOrders(orgId),
}));
vi.mock('../differences-corrections.service', () => ({ listCorrectionHistory: async () => [] }));
vi.mock('@/features/movement/paper-reference.service', () => ({ getPaperReferencesFor: async () => new Map() }));
vi.mock('@/features/procurement/procurement.service', () => ({
  getSuppliers: (orgId: string) => spies.getSuppliers(orgId),
  getReceipts: async () => [],
  getReceiptLines: async () => [],
}));
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

const CARE_ORG = 'care-org-1';
const CARE_ORG_2 = 'care-org-2';
const PDA_ORG = 'pda-org-1';

let currentRole: string | null = 'institution_admin';
let permissions = new Set<string>(['reports.view', 'status_center.view', 'audit.view']);
let currentOrgId: string | null = CARE_ORG;
/** `undefined` models a context that does not carry the field at all. */
let currentKind: OrganizationKind | null | undefined = 'care_institution';
let currentPending = false;

vi.mock('@/app/AppContext', () => ({
  useApp: () => ({
    lang: 'en', dir: 'ltr', activeOrgId: currentOrgId, role: currentRole,
    activeOrganizationKind: currentKind, activeOrganizationKindPending: currentPending,
    myPermissions: permissions,
    authz: { getContext: () => ({ authenticated: false }) },
  }),
}));

const OVERVIEW: ExecutiveOverview = {
  organization_id: CARE_ORG, as_of: '2026-07-25T00:00:00Z', materials_tracked: 50,
  classification_counts: { available: 40, low_stock: 5, missing: 5 },
  supply_source_totals: { warehouse: { kimadia: 20 }, outlet: { purchase_central: 10 } },
};
const INSTITUTIONS: InstitutionOverview[] = [
  { id: 'inst1', name: 'Institution A', name_ar: 'مؤسسة أ', code: 'inst-a', status: 'active', city: 'بابل', available: 40, low: 5, missing: 2 },
];

const SUPPLEMENTARY_TAB = /Supplementary Purchases Traceability/;

function supplementaryReadOrgIds(): unknown[] {
  return [
    ...spies.listSupplementaryPurchaseOrders.mock.calls.map(call => call[0]),
    ...spies.getSuppliers.mock.calls.map(call => call[0]),
  ];
}

function expectNoSupplementarySurface() {
  expect(screen.queryByRole('tab', { name: SUPPLEMENTARY_TAB })).not.toBeInTheDocument();
  expect(document.getElementById('dirc-tabpanel-supplementary')).toBeNull();
  expect(screen.queryByTestId('supplementary-purchases-tab')).not.toBeInTheDocument();
}

/** Lets any wrongly-fired effect or pending read resolve before asserting "never". */
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function renderScreen(initialTab?: ReportTab) {
  return render(<DecisionIntelligenceReportsScreen onNavigate={vi.fn()} initialTab={initialTab} />);
}

describe('PDA-PROC-1 · DIRC renders the supplementary tab only for a care institution', () => {
  beforeEach(() => {
    currentRole = 'institution_admin';
    permissions = new Set(['reports.view', 'status_center.view', 'audit.view']);
    currentOrgId = CARE_ORG;
    currentKind = 'care_institution';
    currentPending = false;
    spies.listSupplementaryPurchaseOrders.mockClear();
    spies.getSuppliers.mockClear();
    getExecutiveOverview.mockResolvedValue(OVERVIEW);
    getInstitutionOverviews.mockResolvedValue(INSTITUTIONS);
    getOpenMonthlyStatusReport.mockResolvedValue(null);
    getLatestLockedMonthlyStatusReport.mockResolvedValue(null);
    getMonthlyStatusLines.mockResolvedValue([]);
  });
  afterEach(cleanup);

  it('care institution: the tab is offered, opens, and reads for the care organization', async () => {
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('executive-overview-tab')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('tab', { name: SUPPLEMENTARY_TAB }));
    await waitFor(() => expect(screen.getByTestId('supplementary-purchases-tab')).toBeInTheDocument());
    expect(spies.listSupplementaryPurchaseOrders).toHaveBeenCalledWith(CARE_ORG);
    expect(spies.getSuppliers).toHaveBeenCalledWith(CARE_ORG);
  });

  it.each([
    ['pharmacy department authority', 'pharmacy_department_authority' as const],
    ['settled null kind', null],
    ['context without the field', undefined],
  ])('%s: no supplementary tab, the rest of Screen 21 stays available', async (_label, kind) => {
    currentOrgId = PDA_ORG;
    currentKind = kind;
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('executive-overview-tab')).toBeInTheDocument());

    expectNoSupplementarySurface();
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual([
      'Executive Overview', 'Institution Status', 'Materials & Batches', 'Stock Movements',
      'Custody Chain', 'Differences & Corrections', 'Audit-Sensitive Actions',
      'Monthly Inventory Position', 'Official Report Library',
    ]);
    await flush();
    expect(supplementaryReadOrgIds()).toEqual([]);
  });

  it('super_admin on a pharmacy department authority: no supplementary tab, Global Search kept', async () => {
    currentRole = 'super_admin';
    currentOrgId = PDA_ORG;
    currentKind = 'pharmacy_department_authority';
    renderScreen();
    await waitFor(() => expect(screen.getByTestId('executive-overview-tab')).toBeInTheDocument());

    expectNoSupplementarySurface();
    expect(screen.getByRole('tab', { name: 'Global Material Search' })).toBeInTheDocument();
    await flush();
    expect(supplementaryReadOrgIds()).toEqual([]);
  });

  it('a requested supplementary tab on a PDA organization falls back to the first allowed tab and never reads', async () => {
    currentOrgId = PDA_ORG;
    currentKind = 'pharmacy_department_authority';
    renderScreen('supplementary');
    await waitFor(() => expect(screen.getByTestId('executive-overview-tab')).toBeInTheDocument());

    expect(screen.getByRole('tab', { name: 'Executive Overview' })).toHaveAttribute('aria-selected', 'true');
    expectNoSupplementarySurface();
    await flush();
    expect(supplementaryReadOrgIds()).toEqual([]);
  });

  it('while the kind is being read the tab is withheld (no read for an unverified organization)', async () => {
    currentOrgId = CARE_ORG;
    currentKind = null;
    currentPending = true;
    renderScreen('supplementary');
    await waitFor(() => expect(screen.getByTestId('executive-overview-tab')).toBeInTheDocument());

    expectNoSupplementarySurface();
    await flush();
    expect(supplementaryReadOrgIds()).toEqual([]);
  });
});

describe('PDA-PROC-1 · switching organization with the supplementary tab active', () => {
  beforeEach(() => {
    currentRole = 'super_admin';
    permissions = new Set(['reports.view', 'status_center.view', 'audit.view']);
    currentOrgId = CARE_ORG;
    currentKind = 'care_institution';
    currentPending = false;
    spies.listSupplementaryPurchaseOrders.mockClear();
    spies.getSuppliers.mockClear();
    getExecutiveOverview.mockResolvedValue(OVERVIEW);
    getInstitutionOverviews.mockResolvedValue(INSTITUTIONS);
    getOpenMonthlyStatusReport.mockResolvedValue(null);
    getLatestLockedMonthlyStatusReport.mockResolvedValue(null);
    getMonthlyStatusLines.mockResolvedValue([]);
  });
  afterEach(cleanup);

  it('care -> PDA: the tab disappears in the same render, falls back to Overview, and SupplementaryPurchasesTab never reads for the PDA org', async () => {
    const { rerender } = renderScreen('supplementary');
    await waitFor(() => expect(screen.getByTestId('supplementary-purchases-tab')).toBeInTheDocument());
    expect(screen.getByRole('tab', { name: SUPPLEMENTARY_TAB })).toHaveAttribute('aria-selected', 'true');
    expect(spies.listSupplementaryPurchaseOrders).toHaveBeenCalledWith(CARE_ORG);

    // The org changes; AppContext nulls the kind in the very same render.
    currentOrgId = PDA_ORG;
    currentKind = null;
    currentPending = true;
    rerender(<DecisionIntelligenceReportsScreen onNavigate={vi.fn()} initialTab="supplementary" />);
    // Synchronously after the switching render — no await in between.
    expectNoSupplementarySurface();
    expect(screen.getByRole('tab', { name: 'Executive Overview' })).toHaveAttribute('aria-selected', 'true');

    // The kind settles: the organization is a pharmacy department authority.
    currentKind = 'pharmacy_department_authority';
    currentPending = false;
    rerender(<DecisionIntelligenceReportsScreen onNavigate={vi.fn()} initialTab="supplementary" />);
    await waitFor(() => expect(screen.getByTestId('executive-overview-tab')).toBeInTheDocument());
    expectNoSupplementarySurface();
    expect(screen.getByRole('tab', { name: 'Executive Overview' })).toHaveAttribute('aria-selected', 'true');

    await flush();
    expect(supplementaryReadOrgIds()).not.toContain(PDA_ORG);
    expect(supplementaryReadOrgIds().every(orgId => orgId === CARE_ORG)).toBe(true);

    // The settled fallback was persisted: returning to a care organization
    // offers the tab again but does not silently reopen it.
    currentOrgId = CARE_ORG_2;
    currentKind = 'care_institution';
    rerender(<DecisionIntelligenceReportsScreen onNavigate={vi.fn()} initialTab="supplementary" />);
    await waitFor(() => expect(screen.getByRole('tab', { name: SUPPLEMENTARY_TAB })).toBeInTheDocument());
    expect(screen.getByRole('tab', { name: SUPPLEMENTARY_TAB })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: 'Executive Overview' })).toHaveAttribute('aria-selected', 'true');
  });

  it('care -> care: the supplementary choice survives the pending read and reopens for the new care organization', async () => {
    const { rerender } = renderScreen('supplementary');
    await waitFor(() => expect(screen.getByTestId('supplementary-purchases-tab')).toBeInTheDocument());

    currentOrgId = CARE_ORG_2;
    currentKind = null;
    currentPending = true;
    rerender(<DecisionIntelligenceReportsScreen onNavigate={vi.fn()} initialTab="supplementary" />);
    expectNoSupplementarySurface();
    await flush();

    currentKind = 'care_institution';
    currentPending = false;
    rerender(<DecisionIntelligenceReportsScreen onNavigate={vi.fn()} initialTab="supplementary" />);
    await waitFor(() => expect(screen.getByTestId('supplementary-purchases-tab')).toBeInTheDocument());
    expect(screen.getByRole('tab', { name: SUPPLEMENTARY_TAB })).toHaveAttribute('aria-selected', 'true');
    expect(spies.listSupplementaryPurchaseOrders).toHaveBeenLastCalledWith(CARE_ORG_2);
    expect(spies.getSuppliers).toHaveBeenLastCalledWith(CARE_ORG_2);
  });
});
