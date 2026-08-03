/**
 * DECISION-INTELLIGENCE-REPORTS-119 — frontend contract.
 *
 * Static source scans, matching this repo's convention (no runtime
 * Supabase mock exists) — see inventory-center-invariants.test.ts for the
 * same pattern. checkSnapshotParity is the one exception: it's pure enough
 * (given a snapshot + one RPC call) to exercise behaviorally against a fake
 * PostgREST/RPC transport, following the same vi.mock pattern as
 * material-resolver.test.ts — a real reconciliation-logic test, not just a
 * source-guard grep.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { checkSnapshotParity, type ReportSnapshotRow, type ExecutiveOverview } from '../decision-intelligence.service';

const FEAT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(FEAT, rel), 'utf8');

const service = read('decision-intelligence.service.ts');
const screen = read('DecisionIntelligenceReportsScreen.tsx');

vi.mock('@/shared/supabase/client', () => ({
  get supabase() { return (globalThis as { __fakeSupabase?: unknown }).__fakeSupabase; },
  supabaseConfigured: true,
}));

function fakeExecutiveOverviewClient(overviewByOrg: Record<string, ExecutiveOverview>) {
  return {
    rpc(fn: string, args: Record<string, unknown>) {
      if (fn === 'phoenix_executive_overview') {
        const org = args.p_organization_id as string;
        const data = overviewByOrg[org];
        return Promise.resolve({ data: data ?? null, error: data ? null : { message: 'org not found' } });
      }
      return Promise.resolve({ data: null, error: { message: `unexpected rpc ${fn}` } });
    },
  };
}

function withFakeOverview<T>(overviewByOrg: Record<string, ExecutiveOverview>, fn: () => Promise<T>): Promise<T> {
  (globalThis as { __fakeSupabase?: unknown }).__fakeSupabase = fakeExecutiveOverviewClient(overviewByOrg);
  return fn();
}

function makeSnapshot(payload: ExecutiveOverview): ReportSnapshotRow {
  return {
    id: 'snap-1', organization_id: payload.organization_id, report_type: 'executive_overview',
    official_number: 'RP-2026-000001', filters: {}, reporting_period: null,
    source_as_of: payload.as_of, payload, qr_payload: 'x',
    created_by: 'u1', created_by_role: 'super_admin', created_by_name: null, created_at: payload.as_of,
  };
}

describe('checkSnapshotParity — reconciliation logic (behavioral, not just source-scan)', () => {
  const org = 'org-1';
  const basePayload: ExecutiveOverview = {
    organization_id: org, as_of: '2026-07-20T00:00:00Z', materials_tracked: 10,
    classification_counts: { available: 6, low_stock: 2, missing: 2 },
    supply_source_totals: { warehouse: { kimadia: 4, aid: 1 }, outlet: { purchase_central: 3 } },
  };

  it('reports an exact match when live data is identical to the snapshot', async () => {
    const result = await withFakeOverview({ [org]: { ...basePayload, as_of: '2026-07-21T00:00:00Z' } },
      () => checkSnapshotParity(makeSnapshot(basePayload)));
    expect(result.matches).toBe(true);
    expect(result.classificationDiffs).toEqual({});
    expect(result.supplySourceDiffs.warehouse).toEqual({});
    expect(result.supplySourceDiffs.outlet).toEqual({});
  });

  it('detects classification drift and reports snapshot/live/delta for exactly the buckets that changed', async () => {
    const live: ExecutiveOverview = {
      ...basePayload, as_of: '2026-07-22T00:00:00Z',
      classification_counts: { available: 5, low_stock: 2, missing: 3 }, // available -1, missing +1, low_stock unchanged
    };
    const result = await withFakeOverview({ [org]: live }, () => checkSnapshotParity(makeSnapshot(basePayload)));
    expect(result.matches).toBe(false);
    expect(result.classificationDiffs).toEqual({
      available: { snapshot: 6, live: 5, delta: -1 },
      missing: { snapshot: 2, live: 3, delta: 1 },
    });
    expect(result.classificationDiffs.low_stock).toBeUndefined();
  });

  it('detects supply-source drift independently per warehouse/outlet location', async () => {
    const live: ExecutiveOverview = {
      ...basePayload, as_of: '2026-07-22T00:00:00Z',
      supply_source_totals: { warehouse: { kimadia: 4, aid: 1 }, outlet: { purchase_central: 5 } },
    };
    const result = await withFakeOverview({ [org]: live }, () => checkSnapshotParity(makeSnapshot(basePayload)));
    expect(result.matches).toBe(false);
    expect(result.supplySourceDiffs.warehouse).toEqual({});
    expect(result.supplySourceDiffs.outlet).toEqual({ purchase_central: { snapshot: 3, live: 5, delta: 2 } });
  });

  it('detects materials_tracked drift', async () => {
    const live: ExecutiveOverview = { ...basePayload, as_of: '2026-07-22T00:00:00Z', materials_tracked: 12 };
    const result = await withFakeOverview({ [org]: live }, () => checkSnapshotParity(makeSnapshot(basePayload)));
    expect(result.matches).toBe(false);
    expect(result.materialsTrackedSnapshot).toBe(10);
    expect(result.materialsTrackedLive).toBe(12);
  });

  it('re-fetches the LIVE org right now via the same phoenix_executive_overview RPC — never a second computation', async () => {
    expect(service).toContain('const live = await getExecutiveOverview(snapshot.organization_id);');
  });
});

describe('119 frontend — service layer', () => {
  it('never computes classification or supply totals itself — both come straight from the RPC response', () => {
    expect(service).not.toMatch(/reorder_point|target_max|scarce|surplus.*=.*available/);
    expect(service).toContain("supabase.rpc('phoenix_executive_overview'");
    expect(service).toContain("supabase.rpc('phoenix_create_report_snapshot'");
  });

  it('snapshot creation carries a caller-generated idempotency key, minted fresh per attempt', () => {
    expect(service).toContain('export function newRequestId(): string {');
    expect(service).toContain('return crypto.randomUUID();');
  });

  it('the report library reads are organization-scoped', () => {
    expect(service).toContain(".eq('organization_id', organizationId)");
  });

  it('120: the supply-source drill-down never re-derives a bucket total client-side — it only lists lots', () => {
    expect(service).toContain("supabase.rpc('phoenix_supply_sources_detail'");
    expect(service).not.toMatch(/reduce\(.*on_hand_quantity/s);
  });
});

describe('differences & corrections — service layer', () => {
  const correctionsService = readFileSync(join(FEAT, 'differences-corrections.service.ts'), 'utf8');

  it('reads the SAME tables the second-person-approval workflow already writes — no new table, no new RPC', () => {
    expect(correctionsService).toContain("from('phoenix_warehouse_correction_requests')");
    expect(correctionsService).toContain("from('phoenix_stock_correction_requests')");
    expect(correctionsService).not.toMatch(/\.rpc\(/);
  });

  it('reads ALL statuses, not just pending — a report is a history, not an approval queue', () => {
    expect(correctionsService).not.toMatch(/\.eq\('status',\s*'pending'\)/);
  });

  it('PHASE-C2-ORG-SCOPE: orgId is a REQUIRED parameter, and BOTH correction-request tables are filtered by organization_id inside the query itself', () => {
    expect(correctionsService).toContain('export async function listCorrectionHistory(orgId: string): Promise<CorrectionHistoryRow[]>');
    expect(correctionsService.match(/\.eq\('organization_id', orgId\)/g)?.length).toBe(2);
  });
});

describe('custody chain — service layer', () => {
  const custodyService = readFileSync(join(FEAT, 'custody-chain.service.ts'), 'utf8');

  it('reuses the EXACT header list functions the operational screens already call — no new list surface', () => {
    expect(custodyService).toContain("from '@/features/outlet/dispatch.service'");
    expect(custodyService).toContain("from '@/features/outlet/outlet-return.service'");
    expect(custodyService).toContain('getWarehouseDispatches(undefined, orgId)');
    expect(custodyService).toContain('getOutletReturnRequests(undefined, orgId)');
    expect(custodyService).toContain('getOutletReturnShipments(undefined, orgId)');
  });

  it('per-document drill-down reuses phoenix_movement_timeline verbatim — no reimplemented timeline logic', () => {
    expect(custodyService).toContain("supabase.rpc('phoenix_movement_timeline'");
  });

  it('never overstates completeness — the RPC own completeness signal is passed through, not discarded', () => {
    expect(custodyService).toContain('MovementTimelineResult');
    expect(custodyService).not.toMatch(/complete:\s*true/);
  });

  it('PHASE-C2-ORG-SCOPE: orgId is a REQUIRED parameter on all three list functions, not an optional narrowing filter — RLS alone is not the reports-screen scope contract', () => {
    expect(custodyService).toContain('export async function listCustodyDispatches(orgId: string): Promise<WarehouseDispatch[]>');
    expect(custodyService).toContain('export async function listCustodyReturnRequests(orgId: string): Promise<OutletReturnRequest[]>');
    expect(custodyService).toContain('export function listCustodyReturnShipments(orgId: string): Promise<OutletReturnShipment[]>');
  });
});

describe('custody chain read services — PHASE C2 organization-scope filter applied INSIDE the query', () => {
  const dispatchService = readFileSync(join(FEAT, '../outlet/dispatch.service.ts'), 'utf8');
  const outletReturnService = readFileSync(join(FEAT, '../outlet/outlet-return.service.ts'), 'utf8');

  it('warehouse_dispatches is filtered by organization_id, the real column the table carries', () => {
    expect(dispatchService).toContain("if (organizationId) q = q.eq('organization_id', organizationId);");
  });

  it('outlet_return_requests/shipments match EITHER side (source or destination org) — the caller-selected org can legitimately be either', () => {
    expect(outletReturnService).toContain('q.or(`source_organization_id.eq.${organizationId},destination_organization_id.eq.${organizationId}`)');
    // Two call sites: getOutletReturnRequests and getOutletReturnShipments.
    expect(outletReturnService.match(/q\.or\(`source_organization_id\.eq\.\$\{organizationId\},destination_organization_id\.eq\.\$\{organizationId\}`\)/g)?.length).toBe(2);
  });

  it('the org filter is additive/optional on these shared functions — every pre-existing operational caller (no orgId arg) is unaffected', () => {
    expect(dispatchService).toContain('export async function getWarehouseDispatches(warehouseId?: string, organizationId?: string)');
    expect(outletReturnService).toContain('export async function getOutletReturnRequests(distributionPointId?: string, organizationId?: string)');
    expect(outletReturnService).toContain('export async function getOutletReturnShipments(destinationWarehouseId?: string, organizationId?: string)');
  });
});

describe('supplementary purchases traceability — service layer', () => {
  const supplementaryService = readFileSync(join(FEAT, 'supplementary-purchases.service.ts'), 'utf8');

  it('reads the EXACT procurement_orders table 087/089 already write — no new table, no purchase_origin filter invented', () => {
    expect(supplementaryService).toContain("from('procurement_orders')");
    expect(supplementaryService).not.toMatch(/\.eq\('purchase_origin'/);
  });

  it('reuses the shared mapOrder from procurement.service.ts — no duplicated row-mapping logic', () => {
    expect(supplementaryService).toContain("from '@/features/procurement/procurement.service'");
    expect(supplementaryService).toContain('mapOrder');
  });
});

describe('119 frontend — screen', () => {
  it('mints a fresh request id after every snapshot attempt (a retry never silently reuses a stale key across edits)', () => {
    expect(screen).toContain('setRequestId(newRequestId());');
  });

  it('the executive overview XLSX/print exports reuse the shared professional-export primitives, not a bespoke exporter', () => {
    expect(screen).toContain("from '@/shared/lib/professional-export'");
    expect(screen).toContain('exportProfessionalXlsx(exportConfig())');
    expect(screen).toContain('triggerProfessionalPrint(exportConfig())');
  });

  it('mobile print routes through the existing in-app fallback modal, never a raw window.open', () => {
    expect(screen).toContain("from '@/shared/ui/MobilePrintFallbackModal'");
    expect(screen).toContain('mobileHtml !== undefined');
  });

  it('renders all nine tabs', () => {
    for (const id of ['overview', 'institutions', 'materials', 'movements', 'custody', 'supplementary', 'corrections', 'audit', 'library']) {
      expect(screen).toContain(`id: '${id}'`);
    }
  });

  it('supplementary purchases drill-down reuses getReceipts/getReceiptLines UNCHANGED — no duplicated receipt read', () => {
    expect(screen).toContain("from '@/features/procurement/procurement.service'");
    expect(screen).toContain('getReceipts(orderId)');
    expect(screen).toContain('getReceiptLines(r.id)');
  });

  it('custody chain never hardcodes complete:true and surfaces the RPC completeness note as-is', () => {
    const custody = screen.slice(screen.indexOf('function CustodyChainTab'));
    expect(custody).toContain('completeness_note');
    expect(custody).not.toMatch(/'complete':\s*true|complete:\s*true/);
  });

  it('institution status is a PURE reuse of the existing getInstitutionOverviews — no new RPC, no reimplemented counting', () => {
    expect(screen).toContain("from '@/shared/supabase/services/dashboard.service'");
    expect(screen).toContain('getInstitutionOverviews()');
    expect(screen).not.toMatch(/supabase\.rpc\('phoenix_get_institution/);
  });

  it('materials & batches reuses getAvailabilityByOrg and expiry-risk.ts — no classification math inline', () => {
    expect(screen).toContain("from '@/shared/supabase/services/availability.service'");
    expect(screen).toContain("from '@/shared/lib/expiry-risk'");
    expect(screen).not.toMatch(/reorder_point|target_max/);
  });

  it('stock movements and audit-sensitive actions are PURE embeds of existing self-contained components', () => {
    expect(screen).toContain("from '@/features/status/MovementReportSection'");
    expect(screen).toContain("from './AuditLogSection'");
    expect(screen).toContain('<MovementReportSection />');
    expect(screen).toContain('<AuditLogSection />');
  });

  it('an org-less profile sees the shared empty-scope state, not a broken query', () => {
    expect(screen).toContain('if (!activeOrgId)');
    expect(screen).toContain("t('no_org_scope', lang)");
  });

  it('120: the drill-down only fetches once expanded, and drills into the SAME bucket key the overview card shows', () => {
    expect(screen).toContain("open ? getSupplySourcesDetail(orgId, bucket.key)");
    expect(screen).toContain('function SupplySourceDrilldown(');
  });

  it('120: the drill-down XLSX export reuses the shared professional-export primitive, not a bespoke exporter', () => {
    const drilldown = screen.slice(screen.indexOf('function SupplySourceDrilldown'));
    expect(drilldown).toContain('exportProfessionalXlsx(exportConfig())');
  });
});

describe('multi-sheet "export full (with detail)" — every drill-down tab includes its own detail rows', () => {
  it('Executive Overview: the full export fetches per-lot detail for EVERY supply bucket, not just the one the user expanded', () => {
    const overview = screen.slice(screen.indexOf('function ExecutiveOverviewTab'), screen.indexOf('function SupplySourceDrilldown'));
    expect(overview).toContain('async function exportFullXlsx()');
    expect(overview).toContain('supplyRows.map(async b => ({ bucket: b, detail: await getSupplySourcesDetail(orgId, b.key) }))');
    expect(overview).toContain('exportProfessionalMultiSheetXlsx(');
  });

  it('Custody Chain: the full export fetches the movement timeline for EVERY document, not just the ones toggled open', () => {
    const custody = screen.slice(screen.indexOf('function CustodyChainTab'), screen.indexOf('function SupplementaryPurchasesTab'));
    expect(custody).toContain('async function exportFullXlsx()');
    expect(custody).toContain('combined.map(async row => {');
    expect(custody).toContain('exportProfessionalMultiSheetXlsx(');
    // The export must reuse traceCache when already fetched (never re-fetch what the user already opened).
    expect(custody).toContain('const cached = traceCache[row.id];');
  });

  it('Supplementary Purchases: the full export fetches receipts+lines for EVERY order, not just the one opened', () => {
    const supplementary = screen.slice(screen.indexOf('function SupplementaryPurchasesTab'), screen.indexOf('function SupplementaryPurchaseDrilldown'));
    expect(supplementary).toContain('async function exportFullXlsx()');
    expect(supplementary).toContain('rows.map(async o => ({ order: o, receipts: await getReceipts(o.id) }))');
    expect(supplementary).toContain('exportProfessionalMultiSheetXlsx(');
  });

  it('all three full-export buttons are wired to the shared dir_export_full_with_detail i18n key, not ad-hoc strings', () => {
    const matches = screen.match(/exportFullXlsx\(\)\} loading={fullXlsxBusy}>/g) ?? [];
    expect(matches.length).toBe(3);
  });
});

describe('print coverage — every tab the reports screen owns directly (excluding the pure Movements/Audit embeds) offers print', () => {
  const tabsRequiringPrint = [
    'ExecutiveOverviewTab', 'InstitutionStatusTab', 'MaterialsAndBatchesTab',
    'CustodyChainTab', 'SupplementaryPurchasesTab', 'CorrectionsHistoryTab',
  ];

  it.each(tabsRequiringPrint)('%s calls triggerProfessionalPrint and routes mobile HTML through onMobilePrint, never a raw window.open', name => {
    const start = screen.indexOf(`function ${name}`);
    expect(start, `${name} not found`).toBeGreaterThan(-1);
    // Slice to the next top-level function declaration (or EOF) so each tab's own printReport is isolated.
    const nextFn = screen.indexOf('\nfunction ', start + 1);
    const body = screen.slice(start, nextFn === -1 ? screen.length : nextFn);
    expect(body).toContain('function printReport()');
    expect(body).toContain('triggerProfessionalPrint(exportConfig())');
    expect(body).toContain('onMobilePrint(mobileHtml)');
  });

  it('every tab prop-drills onToast/onMobilePrint from the SAME parent state — no per-tab duplicate print-modal state', () => {
    expect(screen).toContain('const [mobilePrint, setMobilePrint] = useState<{ html: string; title: string; fileNameBase: string } | null>(null);');
    expect(screen).toContain('const openMobilePrint = (html: string, title: string, fileNameBase: string) => setMobilePrint({ html, title, fileNameBase });');
    // Only ONE MobilePrintFallbackModal mount for the whole screen.
    expect((screen.match(/<MobilePrintFallbackModal/g) ?? []).length).toBe(1);
  });
});

describe('paper-reference wiring — only the document types PAPER-REFERENCE-CONTRACT-110 actually covers, no invented mapping', () => {
  it('Custody Chain dispatches use warehouse_dispatch, return requests use outlet_return_request — matching the SAME types the operational composers already write', () => {
    const custody = screen.slice(screen.indexOf('function CustodyChainTab'));
    expect(custody).toContain("getPaperReferencesFor('warehouse_dispatch', dispatchRows.map(d => d.id))");
    expect(custody).toContain("getPaperReferencesFor('outlet_return_request', requestRows.map(r => r.id))");
  });

  it('Custody Chain never invents a document type for return SHIPMENTS — 110 does not cover them', () => {
    const custody = screen.slice(screen.indexOf('function CustodyChainTab'), screen.indexOf('const traceBlock'));
    expect(custody).not.toMatch(/getPaperReferencesFor\([^)]*shipment/i);
  });

  it('Corrections: paper reference is fetched ONLY for scope==="outlet" rows — stock_correction_request does not cover warehouse-scope corrections', () => {
    const corrections = screen.slice(screen.indexOf('function CorrectionsHistoryTab'));
    expect(corrections).toContain("getPaperReferencesFor('stock_correction_request', outletIds)");
    expect(corrections).toContain("rows.filter(r => r.scope === 'outlet')");
    expect(corrections).toContain("r.scope === 'outlet' ? (paperRefs.data?.get(r.id)?.paperReferenceNumber ?? '—') : '—'");
  });

  it('Supplementary Purchases documents its 110 gap instead of silently omitting or faking a mapping', () => {
    const supplementary = screen.slice(screen.indexOf('function SupplementaryPurchasesTab') - 500, screen.indexOf('function SupplementaryPurchasesTab'));
    expect(supplementary).toContain('does NOT cover procurement_orders or');
    expect(screen.slice(screen.indexOf('function SupplementaryPurchasesTab'))).not.toMatch(/getPaperReferencesFor|getPaperReference\(/);
  });

  it('paper-reference reads use getPaperReferencesFor (the batched N-in-1-query form), never a getPaperReference-per-row loop', () => {
    expect(screen).not.toMatch(/\.map\([^)]*=>\s*getPaperReference\(/);
  });
});

describe('authorization/cross-org scoping — every new service call in this pass is org- or id-scoped, matching the existing 119/120 pattern', () => {
  it('the paper-reference client itself is RLS-scoped (organization_id via policy, not a client-side filter) — see paper-reference.service.ts', () => {
    const paperRefService = readFileSync(join(__dirname, '../../movement/paper-reference.service.ts'), 'utf8');
    expect(paperRefService).toContain("from('phoenix_paper_references')");
    expect(paperRefService).not.toMatch(/\.eq\('organization_id'/); // RLS does this — the client never re-implements the scope check.
  });

  it('checkSnapshotParity always re-derives the org from the snapshot row itself — never accepts a caller-supplied org id that could diverge', () => {
    expect(service).toContain('await getExecutiveOverview(snapshot.organization_id)');
    expect(service).not.toMatch(/checkSnapshotParity\([^)]*organizationId/);
  });

  it('the supplementary-purchases full-export fetch is scoped to orders already returned by the org-scoped list — it never fetches a receipt by an id from outside `rows`', () => {
    const supplementary = screen.slice(screen.indexOf('function SupplementaryPurchasesTab'), screen.indexOf('function SupplementaryPurchaseDrilldown'));
    expect(supplementary).toContain('rows.map(async o => ({ order: o, receipts: await getReceipts(o.id) }))');
  });

  it('PHASE-C2: DIRC passes the same shared activeOrgId to Custody Chain and Corrections History — no per-tab org selector, no unscoped call', () => {
    const custodyCallSite = screen.indexOf('<CustodyChainTab');
    expect(custodyCallSite).toBeGreaterThan(-1);
    expect(screen.slice(custodyCallSite, custodyCallSite + 200)).toContain('orgId={activeOrgId}');

    const correctionsCallSite = screen.indexOf('<CorrectionsHistoryTab');
    expect(correctionsCallSite).toBeGreaterThan(-1);
    expect(screen.slice(correctionsCallSite, correctionsCallSite + 200)).toContain('orgId={activeOrgId}');
  });

  it('PHASE-C2: Custody Chain reads are keyed on [orgId] — an org switch re-runs the loader instead of caching the previous org\'s rows forever', () => {
    const custody = screen.slice(screen.indexOf('function CustodyChainTab'), screen.indexOf('function SupplementaryPurchasesTab'));
    expect(custody).toContain('useAsync(() => listCustodyDispatches(orgId), [orgId])');
    expect(custody).toContain('useAsync(() => listCustodyReturnRequests(orgId), [orgId])');
    expect(custody).toContain('useAsync(() => listCustodyReturnShipments(orgId), [orgId])');
  });

  it('PHASE-C2: Corrections History read is keyed on [orgId]', () => {
    const corrections = screen.slice(screen.indexOf('function CorrectionsHistoryTab'), screen.indexOf('function CustodyChainTab'));
    expect(corrections).toContain('useAsync(() => listCorrectionHistory(orgId), [orgId])');
  });

  it('PHASE-C2: Custody Chain clears trace/timeline/dispense-context drill-down state on an orgId change, independent of the parent\'s own key-remount', () => {
    const custody = screen.slice(screen.indexOf('function CustodyChainTab'), screen.indexOf('function SupplementaryPurchasesTab'));
    expect(custody).toMatch(
      /setTraceOpenFor\(null\);\s*setTraceCache\(\{\}\);\s*setTraceError\(null\);\s*setContextForMovement\(null\);\s*\},\s*\[orgId\]\);/,
    );
  });
});
