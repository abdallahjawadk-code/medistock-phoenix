/**
 * DECISION-INTELLIGENCE-REPORTS-119/120 / REPORTING-UNIFICATION — Screen 21,
 * «مركز التقارير والمواقف»: the single canonical reporting/status shell.
 *
 * Eleven tabs, each reusing the most complete existing component/service
 * rather than reimplementing it: Executive Overview (119, with a 120
 * per-lot supply-source drill-down), Institution Status, Materials &
 * Batches (the former Status Center's entire live-operations view, moved
 * here verbatim), Stock Movements, Custody Chain, Differences &
 * Corrections, Supplementary Purchases, Monthly Position (the former
 * screen 20's full prepare/classify/submit/approve+lock/amend cycle,
 * moved here verbatim), Audit & Sensitive Actions, the Official Report
 * Library, and (super_admin only) Global Material Search (the former
 * ReportsScreen's unique content).
 *
 * Screens 9 (Reports), 12 (Status Center) and 20 (Monthly Position) all
 * now redirect here via AuthenticatedApp.tsx's `initialTab` prop — see
 * docs/phoenix/proposals/unified-reporting-status-center-equivalence.md
 * for the full per-section equivalence matrix that justified each move.
 */
import { useEffect, useState, useMemo } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { formatStableDateTime, formatStableDate } from '@/shared/lib/date';
import { normalizeRole } from '@/shared/lib/roles';
import { useInventoryScopes } from '@/features/inventory/useInventoryScopes';
import { getDispenseContext, type DispenseContext } from '@/features/outlet/dispense-context.service';
import { DispenseContextViewer } from '@/features/outlet/DispenseContextViewer';
import { reasonCodeLabel } from '@/shared/lib/movement-labels';
import { PhoenixDialog } from '@/shared/ui/PhoenixDialog';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixSelect } from '@/shared/ui/PhoenixSelect';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';
import { PhoenixOrgScope } from '@/shared/ui/PhoenixOrgScope';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { PhoenixToast } from '@/shared/ui/PhoenixToast';
import { MobilePrintFallbackModal } from '@/shared/ui/MobilePrintFallbackModal';
import {
  exportProfessionalXlsx, exportProfessionalMultiSheetXlsx, triggerProfessionalPrint,
  exportAvailabilityXlsx, type AvailabilityExportRow,
  type ProfessionalReportColumn,
} from '@/shared/lib/professional-export';
import { getInstitutionOverviews, type InstitutionOverview } from '@/shared/supabase/services/dashboard.service';
import { getAvailabilityByOrg } from '@/shared/supabase/services/availability.service';
import { getExpiryRiskTier, getExpiryRiskLabel, getExpiryRiskTone } from '@/shared/lib/expiry-risk';
import { isLikelyMobilePrintContext } from '@/shared/lib/reportExport';
import { getOrganizations } from '@/shared/supabase/services/organizations.service';
import type { CanonicalStatus } from '@/shared/lib/status/canonical';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import { ExpiryRiskBadge } from '@/shared/ui/ExpiryRiskBadge';
import { AvailabilityStockCorrectionModal, type AvailabilityCorrectionRow } from '@/features/status/AvailabilityStockCorrectionModal';
import { ReactivateMaterialModal, REACTIVATE_PERMISSION_KEYS, type ReactivateRow } from '@/features/status/ReactivateMaterialModal';
import { MovementHistoryModal, type MovementHistoryRow } from '@/features/status/MovementHistoryModal';
import { computeInternalAlerts } from '@/features/status/internalAlerts';
import { InternalAlertsSection } from '@/features/status/InternalAlertsSection';
import { OutletMaterialGroups } from '@/features/status/OutletMaterialGroups';
import { OutletAvailabilityReportModal } from '@/features/status/OutletAvailabilityReportModal';
import { QuickActionGrid, type QuickAction } from '@/shared/ui/QuickActionGrid';
import { CommandCenterActivityFeed, type ActivityFeedEntry } from '@/shared/ui/CommandCenterActivityFeed';
import { SmartFilterChips, type SmartFilterChipItem } from '@/shared/ui/SmartFilterChips';
import { InventoryIntelligencePanel } from '@/features/inventory/InventoryIntelligencePanel';
import type { SuggestionDocumentTarget } from '@/features/inventory/suggestion-document-navigation';
import { MovementReportSection } from '@/features/status/MovementReportSection';
import { AuditLogSection } from './AuditLogSection';
import { GlobalMaterialSearchPanel } from './GlobalMaterialSearchPanel';
import { ReportsTabErrorBoundary } from './ReportsTabErrorBoundary';
import { listCorrectionHistory, type CorrectionHistoryRow } from './differences-corrections.service';
import {
  listCustodyDispatches, listCustodyReturnRequests, listCustodyReturnShipments,
  getMovementTimeline, type MovementTimelineResult,
} from './custody-chain.service';
import { listSupplementaryPurchaseOrders } from './supplementary-purchases.service';
import { getPaperReferencesFor } from '@/features/movement/paper-reference.service';
import { getSuppliers, getReceipts, getReceiptLines, type OrderRow, type ReceiptRow, type ReceiptLineRow } from '@/features/procurement/procurement.service';
import { StatusBadge } from '@/features/procurement/OrderComposerPanel';
import {
  getOpenMonthlyStatusReport, getLatestLockedMonthlyStatusReport, getMonthlyStatusLines,
  prepareMonthlyStatusReport, classifyMonthlyStatusLines, confirmSuspectedMissing,
  submitMonthlyStatusReport, returnMonthlyStatusReportForClarification,
  approveLockMonthlyStatusReport, createMonthlyStatusAmendment,
  recordStocktake, getStocktakeCountLines,
  type MonthlyStatusLine, type MaterialClassification, type StocktakeCountLine,
} from '@/shared/supabase/services/monthly-status.service';
import {
  getExecutiveOverview, createReportSnapshot, listReportSnapshots, newRequestId,
  getSupplySourcesDetail, checkSnapshotParity, isDemoOrganization,
  type ExecutiveOverview, type ReportSnapshotRow, type SupplySourceDetailRow, type SnapshotParityResult,
} from './decision-intelligence.service';

type Tab = 'overview' | 'institutions' | 'materials' | 'movements' | 'custody' | 'supplementary' | 'corrections' | 'audit' | 'monthly' | 'library' | 'global';

const CLASSIFICATION_KEYS = ['available', 'low_stock', 'missing', 'surplus', 'near_expiry', 'expired'] as const;
const SUPPLY_KEYS = ['kimadia', 'aid', 'purchase_central', 'purchase_supplementary', 'unclassified'] as const;

interface BucketRow { label: string; value: number; }
interface SupplyBucketRow extends BucketRow { key: string; }

/**
 * REPORTING-UNIFICATION: initialTab lets the old screen numbers (9, 12, 20)
 * redirect straight to the tab that now owns their content, instead of
 * always landing on Overview -- screen 12 (Status Center) opens on
 * 'materials', screen 20 (Monthly Position) opens on 'monthly'. Once here,
 * the tab bar behaves exactly as it always has; this only affects the
 * FIRST render for a given navigation.
 */
export function DecisionIntelligenceReportsScreen({ onNavigate, onOpenSuggestionDocument, initialTab }: {
  onNavigate: (screen: number) => void;
  onOpenSuggestionDocument?: (target: SuggestionDocumentTarget) => void;
  initialTab?: Tab;
}) {
  const { lang, dir, activeOrgId, role, myPermissions } = useApp();
  const [tab, setTab] = useState<Tab>(initialTab ?? 'overview');
  const [toast, setToast] = useState<string | null>(null);
  const [mobilePrint, setMobilePrint] = useState<{ html: string; title: string; fileNameBase: string } | null>(null);

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3000); };
  const openMobilePrint = (html: string, title: string, fileNameBase: string) => setMobilePrint({ html, title, fileNameBase });

  const header = (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap', marginBottom: '16px' }}>
      <div>
        <h2 style={{ fontSize: '22px', fontWeight: 700, letterSpacing: '-.3px' }}>{t('dir_screen_title', lang)}</h2>
        <p style={{ fontSize: '12.5px', color: 'var(--t2)', marginTop: '3px' }}>{t('dir_screen_sub', lang)}</p>
      </div>
      <PhoenixOrgScope />
    </div>
  );

  if (!activeOrgId) {
    return (
      <div dir={dir} className="nexus-command-center nexus-command-center--reports">
        {header}
        <PhoenixEmptyState icon="hospital" title={t('no_org_scope', lang)} description={t('empty_hint', lang)} />
      </div>
    );
  }

  const tabs: Array<{ id: Tab; labelKey: string }> = [
    { id: 'overview', labelKey: 'dir_tab_overview' },
    { id: 'institutions', labelKey: 'dir_tab_institutions' },
    { id: 'materials', labelKey: 'dir_tab_materials' },
    { id: 'movements', labelKey: 'dir_tab_movements' },
    { id: 'custody', labelKey: 'dir_tab_custody' },
    { id: 'supplementary', labelKey: 'dir_tab_supplementary' },
    { id: 'corrections', labelKey: 'dir_tab_corrections' },
    { id: 'audit', labelKey: 'dir_tab_audit' },
    { id: 'monthly', labelKey: 'dir_tab_monthly' },
    { id: 'library', labelKey: 'dir_tab_library' },
    // REPORTING-UNIFICATION: moved verbatim from ReportsScreen.tsx (screen
    // 9), which gated this tab identically -- role === 'super_admin' at the
    // tab-visibility level, with GlobalMaterialSearchPanel's own internal
    // check as defense-in-depth, unchanged.
    ...(role === 'super_admin' ? [{ id: 'global' as Tab, labelKey: 'dir_tab_global' }] : []),
  ];

  return (
    <div dir={dir} className="nexus-command-center nexus-command-center--reports">
      {header}
      <div role="tablist" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '16px' }}>
        {tabs.map(x => (
          <button
            key={x.id}
            role="tab"
            aria-selected={tab === x.id}
            onClick={() => setTab(x.id)}
            style={{
              padding: '8px 14px', minHeight: '44px', borderRadius: 'var(--r3)',
              border: '1px solid var(--brd)', cursor: 'pointer', fontSize: '12.5px', fontWeight: 600,
              background: tab === x.id ? 'var(--p2)' : 'var(--s)',
              color: tab === x.id ? 'var(--pd)' : 'var(--t2)',
            }}
          >
            {t(x.labelKey, lang)}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <ReportsTabErrorBoundary key={`overview:${activeOrgId}`} lang={lang}>
          <ExecutiveOverviewTab
            orgId={activeOrgId}
            lang={lang}
            onToast={showToast}
            onMobilePrint={html => openMobilePrint(html, t('dir_tab_overview', lang), 'medistock-executive-overview')}
          />
        </ReportsTabErrorBoundary>
      )}
      {tab === 'institutions' && (
        <ReportsTabErrorBoundary key={`institutions:${activeOrgId}`} lang={lang}>
          <InstitutionStatusTab
            lang={lang}
            onToast={showToast}
            onMobilePrint={html => openMobilePrint(html, t('dir_tab_institutions', lang), 'medistock-institution-status')}
            onOpenMaterials={() => setTab('materials')}
          />
        </ReportsTabErrorBoundary>
      )}
      {tab === 'materials' && (
        <ReportsTabErrorBoundary key={`materials:${activeOrgId}`} lang={lang}>
          <MaterialsAndBatchesTab
            orgId={activeOrgId}
            lang={lang}
            role={role}
            myPermissions={myPermissions}
            onToast={showToast}
            onMobilePrint={html => openMobilePrint(html, t('dir_tab_materials', lang), 'medistock-materials-batches')}
            onNavigate={onNavigate}
            onOpenSuggestionDocument={onOpenSuggestionDocument}
          />
        </ReportsTabErrorBoundary>
      )}
      {tab === 'movements' && (
        <ReportsTabErrorBoundary key={`movements:${activeOrgId}`} lang={lang}>
          <div data-testid="movements-tab"><MovementReportSection /></div>
        </ReportsTabErrorBoundary>
      )}
      {tab === 'custody' && (
        <ReportsTabErrorBoundary key={`custody:${activeOrgId}`} lang={lang}>
          <CustodyChainTab
            lang={lang}
            onToast={showToast}
            onMobilePrint={html => openMobilePrint(html, t('dir_tab_custody', lang), 'medistock-custody-chain')}
          />
        </ReportsTabErrorBoundary>
      )}
      {tab === 'supplementary' && (
        <ReportsTabErrorBoundary key={`supplementary:${activeOrgId}`} lang={lang}>
          <SupplementaryPurchasesTab
            orgId={activeOrgId}
            lang={lang}
            onToast={showToast}
            onMobilePrint={html => openMobilePrint(html, t('dir_tab_supplementary', lang), 'medistock-supplementary-purchases')}
          />
        </ReportsTabErrorBoundary>
      )}
      {tab === 'corrections' && (
        <ReportsTabErrorBoundary key={`corrections:${activeOrgId}`} lang={lang}>
          <CorrectionsHistoryTab
            lang={lang}
            onToast={showToast}
            onMobilePrint={html => openMobilePrint(html, t('dir_tab_corrections', lang), 'medistock-differences-corrections')}
          />
        </ReportsTabErrorBoundary>
      )}
      {tab === 'audit' && (
        <ReportsTabErrorBoundary key={`audit:${activeOrgId}`} lang={lang}>
          <div data-testid="audit-tab"><AuditLogSection /></div>
        </ReportsTabErrorBoundary>
      )}
      {tab === 'monthly' && (
        <ReportsTabErrorBoundary key={`monthly:${activeOrgId}`} lang={lang}>
          <MonthlyPositionTab orgId={activeOrgId} lang={lang} role={role} onToast={showToast} />
        </ReportsTabErrorBoundary>
      )}
      {tab === 'library' && (
        <ReportsTabErrorBoundary key={`library:${activeOrgId}`} lang={lang}>
          <ReportLibraryTab orgId={activeOrgId} lang={lang} />
        </ReportsTabErrorBoundary>
      )}
      {tab === 'global' && role === 'super_admin' && (
        <ReportsTabErrorBoundary key={`global:${activeOrgId}`} lang={lang}>
          <div data-testid="global-search-tab"><GlobalMaterialSearchPanel /></div>
        </ReportsTabErrorBoundary>
      )}

      {toast && <PhoenixToast message={toast} />}
      {mobilePrint !== null && (
        <MobilePrintFallbackModal
          open
          html={mobilePrint.html}
          title={mobilePrint.title}
          fileNameBase={mobilePrint.fileNameBase}
          lang={lang}
          onClose={() => setMobilePrint(null)}
        />
      )}
    </div>
  );
}

function classificationRows(o: ExecutiveOverview, lang: 'ar' | 'en'): BucketRow[] {
  return CLASSIFICATION_KEYS.map(k => ({ label: t('cond_' + k, lang), value: o.classification_counts[k] ?? 0 }));
}

function supplySourceRows(o: ExecutiveOverview, lang: 'ar' | 'en'): SupplyBucketRow[] {
  const combined: Record<string, number> = {};
  for (const k of SUPPLY_KEYS) {
    combined[k] = (o.supply_source_totals.warehouse[k] ?? 0) + (o.supply_source_totals.outlet[k] ?? 0);
  }
  return SUPPLY_KEYS.map(k => ({ key: k, label: t('dir_supply_' + k, lang), value: combined[k] ?? 0 }));
}

function ExecutiveOverviewTab({ orgId, lang, onToast, onMobilePrint }: {
  orgId: string; lang: 'ar' | 'en';
  onToast: (msg: string) => void;
  onMobilePrint: (html: string) => void;
}) {
  const overview = useAsync(() => getExecutiveOverview(orgId), [orgId]);
  const [snapBusy, setSnapBusy] = useState(false);
  const [xlsxBusy, setXlsxBusy] = useState(false);
  const [fullXlsxBusy, setFullXlsxBusy] = useState(false);
  const [lastSnapshot, setLastSnapshot] = useState<{ officialNumber: string; qr: string } | null>(null);
  const [requestId, setRequestId] = useState(() => newRequestId());

  if (overview.loading && !overview.data) return <PhoenixLoadingState />;
  if (overview.error) return <PhoenixErrorState message={overview.error} onRetry={overview.reload} />;
  const data = overview.data;
  if (!data) return null;

  const classRows = classificationRows(data, lang);
  const supplyRows = supplySourceRows(data, lang);
  const rows: BucketRow[] = [...classRows, ...supplyRows];

  function bucketsSheetConfig(moduleName: string) {
    const columns: ProfessionalReportColumn<BucketRow>[] = [
      { key: 'label', label: t('dir_col_indicator', lang), value: r => r.label },
      { key: 'value', label: t('dir_col_value', lang), value: r => String(r.value), numeric: true, excelValue: r => r.value },
    ];
    return {
      reportTitle: t('dir_tab_overview', lang),
      moduleName,
      generatedAt: new Date(),
      filtersSummary: t('sc_all', lang),
      columns,
      rows,
      lang,
      fileNameBase: 'medistock-executive-overview',
      footerText: t('report_footer_generated_by', lang),
      labels: {
        generatedAt: t('sc_generated_at', lang),
        filtersSummary: t('sc_selected_filters', lang),
        rowCount: t('sc_total_rows', lang),
      },
    };
  }

  function exportConfig() {
    return bucketsSheetConfig(t('dir_tab_overview', lang));
  }

  async function exportXlsx() {
    if (xlsxBusy) return;
    setXlsxBusy(true);
    try {
      const ok = await exportProfessionalXlsx(exportConfig());
      if (!ok) onToast(t('csv_export_failed', lang));
    } finally {
      setXlsxBusy(false);
    }
  }

  /**
   * Multi-sheet export: sheet 1 = the classification+supply-source bucket
   * totals (same as exportXlsx), sheet 2 = the per-lot detail behind EVERY
   * supply-source bucket, not just the one bucket a user happens to have
   * expanded — the same phoenix_supply_sources_detail data
   * SupplySourceDrilldown shows on expand, fetched here for all 5 buckets
   * so the export is never missing detail the screen can show.
   */
  async function exportFullXlsx() {
    if (fullXlsxBusy) return;
    setFullXlsxBusy(true);
    try {
      const perBucket = await Promise.all(
        supplyRows.map(async b => ({ bucket: b, detail: await getSupplySourcesDetail(orgId, b.key) })),
      );
      const detailRows: (SupplySourceDetailRow & { bucketLabel: string })[] = perBucket.flatMap(
        ({ bucket, detail }) => detail.map(d => ({ ...d, bucketLabel: bucket.label })),
      );
      const detailSheet = {
        reportTitle: t('dir_tab_overview', lang),
        moduleName: 'Supply Sources Detail',
        generatedAt: new Date(),
        filtersSummary: t('sc_all', lang),
        columns: [
          { key: 'bucket', label: t('dir_supply_sources_title', lang), value: (r: typeof detailRows[number]) => r.bucketLabel },
          { key: 'material', label: t('avail_scientific_name', lang), value: (r: typeof detailRows[number]) => r.scientific_name },
          { key: 'trade', label: t('inv_trade_name', lang), value: (r: typeof detailRows[number]) => r.trade_name ?? '—' },
          { key: 'location', label: t('dir_col_location', lang), value: (r: typeof detailRows[number]) => (lang === 'ar' ? r.location_name_ar || r.location_name : r.location_name) },
          { key: 'batch', label: t('batch_no', lang), value: (r: typeof detailRows[number]) => r.batch_number ?? '—', ltr: true },
          { key: 'expiry', label: t('expiry', lang), value: (r: typeof detailRows[number]) => r.expiry_date ?? '—', ltr: true, dateColumn: 'date', excelValue: (r: typeof detailRows[number]) => r.expiry_date },
          { key: 'qty', label: t('qty', lang), value: (r: typeof detailRows[number]) => String(r.on_hand_quantity), numeric: true, excelValue: (r: typeof detailRows[number]) => r.on_hand_quantity },
        ] as ProfessionalReportColumn<typeof detailRows[number]>[],
        rows: detailRows,
        lang,
        fileNameBase: 'medistock-executive-overview-detail',
        footerText: t('report_footer_generated_by', lang),
        labels: { generatedAt: t('sc_generated_at', lang), filtersSummary: t('sc_selected_filters', lang), rowCount: t('sc_total_rows', lang) },
      };
      const ok = await exportProfessionalMultiSheetXlsx(
        [bucketsSheetConfig('Overview'), detailSheet],
        'medistock-executive-overview-full',
      );
      if (!ok) onToast(t('csv_export_failed', lang));
    } finally {
      setFullXlsxBusy(false);
    }
  }

  function printReport() {
    const { ok, mobileHtml } = triggerProfessionalPrint(exportConfig());
    if (mobileHtml !== undefined) { onMobilePrint(mobileHtml); return; }
    if (!ok) onToast(t('print_popup_blocked', lang));
  }

  async function createSnapshot() {
    if (snapBusy) return;
    setSnapBusy(true);
    try {
      const result = await createReportSnapshot(requestId, orgId, 'executive_overview');
      setLastSnapshot({ officialNumber: result.official_number, qr: result.qr_payload });
      setRequestId(newRequestId());
      onToast(result.idempotent_replay ? t('dir_snapshot_replayed', lang) : t('dir_snapshot_created', lang));
    } catch (e) {
      onToast(e instanceof Error ? e.message : t('dir_snapshot_failed', lang));
    } finally {
      setSnapBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: '12px' }} data-testid="executive-overview-tab">
      <PhoenixCard>
        <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginBottom: '10px' }}>
          {t('dir_as_of', lang)}: {new Date(data.as_of).toLocaleString(lang === 'ar' ? 'ar' : 'en')} ·{' '}
          {t('dir_materials_tracked', lang)}: {data.materials_tracked}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '10px' }}>
          {classRows.map(r => (
            <div key={r.label} style={{ padding: '10px 12px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: 'var(--s2)' }}>
              <div style={{ fontSize: '11px', color: 'var(--t2)' }}>{r.label}</div>
              <div style={{ fontSize: '18px', fontWeight: 700 }}>{r.value}</div>
            </div>
          ))}
        </div>

        <div style={{ fontSize: '12px', fontWeight: 700, marginTop: '16px', marginBottom: '8px' }}>{t('dir_supply_sources_title', lang)}</div>
        <div style={{ display: 'grid', gap: '6px' }}>
          {supplyRows.map(r => (
            <SupplySourceDrilldown key={r.key} orgId={orgId} bucket={r} lang={lang} onToast={onToast} />
          ))}
        </div>

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '14px' }}>
          <PhoenixButton variant="ghost" size="sm" onClick={() => void exportXlsx()} loading={xlsxBusy}>
            {t('mv_export_xlsx', lang)}
          </PhoenixButton>
          <PhoenixButton variant="ghost" size="sm" onClick={() => void exportFullXlsx()} loading={fullXlsxBusy}>
            {t('dir_export_full_with_detail', lang)}
          </PhoenixButton>
          <PhoenixButton variant="ghost" size="sm" onClick={printReport}>
            {t('se_print', lang)}
          </PhoenixButton>
          <PhoenixButton size="sm" onClick={() => void createSnapshot()} loading={snapBusy}>
            {t('dir_create_snapshot', lang)}
          </PhoenixButton>
        </div>
        {lastSnapshot && (
          <div style={{ marginTop: '10px', fontSize: '12px', display: 'grid', gap: '2px' }} data-testid="dir-last-snapshot">
            <div dir="ltr">{t('sp_official_receipt_no', lang)}: <code>{lastSnapshot.officialNumber}</code></div>
            <div dir="ltr" style={{ color: 'var(--t2)' }}>{lastSnapshot.qr}</div>
          </div>
        )}
      </PhoenixCard>
    </div>
  );
}

/**
 * 120 — one supply-source bucket, expandable to its own per-lot detail
 * (indicator -> material drill-down). The bucket total shown here always
 * comes from the SAME 119 aggregate the parent card grid uses; this only
 * adds the underlying rows behind it, never a second computation of it.
 */
function SupplySourceDrilldown({ orgId, bucket, lang, onToast }: {
  orgId: string; bucket: SupplyBucketRow; lang: 'ar' | 'en';
  onToast: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [xlsxBusy, setXlsxBusy] = useState(false);
  const detail = useAsync(
    () => (open ? getSupplySourcesDetail(orgId, bucket.key) : Promise.resolve<SupplySourceDetailRow[]>([])),
    [orgId, bucket.key, open],
  );

  function exportConfig() {
    const columns: ProfessionalReportColumn<SupplySourceDetailRow>[] = [
      { key: 'material', label: t('avail_scientific_name', lang), value: r => r.scientific_name },
      { key: 'trade', label: t('inv_trade_name', lang), value: r => r.trade_name ?? '—' },
      { key: 'location', label: t('dir_col_location', lang), value: r => (lang === 'ar' ? r.location_name_ar || r.location_name : r.location_name) },
      { key: 'batch', label: t('batch_no', lang), value: r => r.batch_number ?? '—', ltr: true },
      { key: 'expiry', label: t('expiry', lang), value: r => r.expiry_date ?? '—', ltr: true, dateColumn: 'date', excelValue: r => r.expiry_date },
      { key: 'qty', label: t('qty', lang), value: r => String(r.on_hand_quantity), numeric: true, excelValue: r => r.on_hand_quantity },
    ];
    return {
      reportTitle: `${t('dir_supply_sources_title', lang)} — ${bucket.label}`,
      generatedAt: new Date(),
      filtersSummary: bucket.label,
      columns,
      rows: detail.data ?? [],
      lang,
      fileNameBase: `medistock-supply-sources-${bucket.key}`,
      footerText: t('report_footer_generated_by', lang),
      labels: {
        generatedAt: t('sc_generated_at', lang),
        filtersSummary: t('sc_selected_filters', lang),
        rowCount: t('sc_total_rows', lang),
      },
    };
  }

  async function exportXlsx() {
    if (xlsxBusy) return;
    setXlsxBusy(true);
    try {
      const ok = await exportProfessionalXlsx(exportConfig());
      if (!ok) onToast(t('csv_export_failed', lang));
    } finally {
      setXlsxBusy(false);
    }
  }

  return (
    <div style={{ borderRadius: 'var(--r2)', border: '1px solid var(--brd)' }} data-testid={`dir-supply-bucket-${bucket.key}`}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: 'var(--s2)', border: 'none', cursor: 'pointer', fontSize: '12.5px', color: 'var(--t)' }}
        aria-expanded={open}
      >
        <span>{bucket.label}</span>
        <strong>{bucket.value}</strong>
      </button>
      {open && (
        <div style={{ padding: '10px 12px' }}>
          {detail.loading && !detail.data ? <PhoenixLoadingState /> : null}
          {detail.error ? <PhoenixErrorState message={detail.error} onRetry={detail.reload} /> : null}
          {detail.data && detail.data.length === 0 && <PhoenixEmptyState icon="package" title={t('dir_library_empty', lang)} />}
          {detail.data && detail.data.length > 0 && (
            <>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11.5px' }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'start', padding: '4px 6px' }}>{t('avail_scientific_name', lang)}</th>
                      <th style={{ textAlign: 'start', padding: '4px 6px' }}>{t('dir_col_location', lang)}</th>
                      <th style={{ textAlign: 'start', padding: '4px 6px' }}>{t('batch_no', lang)}</th>
                      <th style={{ textAlign: 'start', padding: '4px 6px' }}>{t('expiry', lang)}</th>
                      <th style={{ textAlign: 'end', padding: '4px 6px' }}>{t('qty', lang)}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.data.map(r => (
                      <tr key={r.lot_id} style={{ borderTop: '1px solid var(--brd)' }}>
                        <td style={{ padding: '4px 6px' }} dir="auto">{r.scientific_name}{r.trade_name ? ` (${r.trade_name})` : ''}</td>
                        <td style={{ padding: '4px 6px' }} dir="auto">{lang === 'ar' ? (r.location_name_ar || r.location_name) : r.location_name}</td>
                        <td style={{ padding: '4px 6px' }} dir="ltr">{r.batch_number ?? '—'}</td>
                        <td style={{ padding: '4px 6px' }} dir="ltr">{r.expiry_date ?? '—'}</td>
                        <td style={{ padding: '4px 6px', textAlign: 'end' }}>{r.on_hand_quantity}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ marginTop: '8px' }}>
                <PhoenixButton variant="ghost" size="sm" onClick={() => void exportXlsx()} loading={xlsxBusy}>
                  {t('mv_export_xlsx', lang)}
                </PhoenixButton>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Institution Status — pure reuse of ReportsScreen's existing
 * getInstitutionOverviews() (which delegates ALL counting to
 * phoenix_get_institution_condition_counts, migration 054). No new backend,
 * no new classification math, no new RBAC surface: the RPC already scopes a
 * non-super_admin caller to their own organization's row.
 */

/** The 6 canonical statuses summarized/filtered in the live report. */
const CANONICAL_STATUSES: CanonicalStatus[] = [
  'available', 'low_stock', 'missing', 'surplus', 'near_expiry', 'expired',
];

/** Badge variant per canonical effective status (UI only). */
const CANON_VARIANT: Record<CanonicalStatus, 'ok' | 'warn' | 'err' | 'neutral'> = {
  available: 'ok', surplus: 'ok', low_stock: 'warn', near_expiry: 'warn', missing: 'err', expired: 'err',
};

const LTR_COLUMN_KEYS = new Set(['expiry', 'updated']);
const RECENTLY_UPDATED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

type QuantityFilter = 'all' | 'has_quantity' | 'zero_quantity';
type PriceFilterMode =
  | 'all'
  | 'no_entered_price'
  | 'has_entered_price'
  | 'entered_price_less_than'
  | 'entered_price_greater_than'
  | 'entered_price_between';

function parsePriceInput(v: string): number | null {
  const trimmed = v.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

type SupplyCategory = 'purchases' | 'kimadia' | 'aid';

const SUPPLY_CATEGORIES: { value: SupplyCategory; labelKey: string }[] = [
  { value: 'aid',       labelKey: 'sc_supply_aid' },
  { value: 'purchases', labelKey: 'sc_supply_purchases' },
  { value: 'kimadia',   labelKey: 'sc_supply_kimadia' },
];

function normalizeSupplyType(v?: string | null): SupplyCategory | null {
  if (!v) return null;
  const s = v.trim().toLowerCase();
  if (!s) return null;
  if (s.includes('kimadia') || s.includes('كيماديا') || s.includes('كماديا')) return 'kimadia';
  if (s.includes('purchase') || s.includes('local_procurement') || s.includes('مشتر') || s.includes('شراء')) return 'purchases';
  if (s.includes('donation') || s.includes('تبرع') || s.includes('منح')) return 'aid';
  if (s.includes('aid') || s.includes('مساعد') || s.includes('إغاث') || s.includes('اغاث') || s.startsWith('هب')) return 'aid';
  return null;
}

const STOCK_CORRECTION_VISIBILITY_KEYS = [
  'availability.quantity.set',
  'availability.quantity.add',
  'availability.quantity.subtract',
  'availability.quantity.correct',
];

/**
 * A live item_availability row enriched with derived fields by the service
 * layer, matching StatusCenterScreen's own LiveAvailRow shape exactly.
 */
interface LiveAvailRow {
  id: string;
  scientific_name: string | null;
  trade_name: string | null;
  dosage_form: string | null;
  concentration: string | null;
  quantity: number;
  condition: string | null;
  expiry_date: string | null;
  supply_type: string | null;
  updated_at: string | null;
  raw_condition?: string;
  effective_status?: CanonicalStatus;
  expiry_bucket?: string | null;
  distribution_points: { id: string; name: string; name_ar: string; status?: string } | null;
  batch_number?: string | null;
  notes?: string | null;
  actor_name_snapshot?: string | null;
  removed_at?: string | null;
  removal_reason?: string | null;
  national_code?: string | null;
  price?: number | null;
}

function effOf(r: LiveAvailRow): CanonicalStatus {
  return (r.effective_status ?? r.condition ?? 'available') as CanonicalStatus;
}

function dpNameOf(r: LiveAvailRow, lang: 'ar' | 'en'): string {
  const dp = r.distribution_points;
  if (!dp) return '—';
  return lang === 'ar' ? (dp.name_ar || dp.name) : dp.name;
}

function removalReasonLabel(reason: string | null | undefined, lang: 'ar' | 'en'): string {
  if (reason === 'removed_from_outlet') return t('sc_removal_reason_removed_from_outlet', lang);
  if (reason === 'clear_port_availability') return t('sc_removal_reason_clear_port_availability', lang);
  return t('sc_removal_reason_unknown', lang);
}

function expiryDisplay(r: LiveAvailRow, lang: 'ar' | 'en'): string {
  if (r.expiry_date) return formatStableDate(r.expiry_date, lang);
  if (r.expiry_bucket) return t('cond_' + (r.expiry_bucket === 'expired' ? 'expired' : 'near_expiry'), lang);
  return '—';
}

function priceDisplay(price: number | null | undefined): string {
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return '—';
  return price.toFixed(2);
}

const materialsFieldStyle = {
  padding: '8px 12px', borderRadius: 'var(--r2)',
  border: '1px solid var(--brd)', background: 'var(--s)',
  color: 'var(--t)', fontSize: '13px',
} as const;

function escHtmlMaterials(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const AVAIL_EXPORT_CONDITION_LABELS: Record<CanonicalStatus, string> = {
  available:   'Available / متوفر',
  low_stock:   'Low Stock / منخفض',
  missing:     'Missing / مفقود',
  surplus:     'Surplus / فائض',
  near_expiry: 'Near Expiry / قريب الانتهاء',
  expired:     'Expired / منتهي الصلاحية',
};

function daysUntilExpiry(expiryDate: string | null, now: Date = new Date()): number | null {
  if (!expiryDate) return null;
  const d = new Date(expiryDate);
  if (isNaN(d.getTime())) return null;
  const dateOnly = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  return Math.round((dateOnly(d).getTime() - dateOnly(now).getTime()) / 86_400_000);
}

/**
 * REPORTING-UNIFICATION: real migration of screen 12 (Status Center)'s
 * entire live-operations view, moved verbatim from the former
 * StatusCenterScreen.tsx (not a reimplementation) -- every filter (status,
 * supply, search, quantity, recently-updated, entered-price), every row
 * action (correct stock, reactivate, movement history) and its modal, the
 * outlet-grouped view, quick actions, internal alerts, recent activity,
 * XLSX export, print, and the Inventory Intelligence panel are unchanged.
 * This supersedes the former, much simpler read-only Materials & Batches
 * tab (MaterialAvailRow-based) entirely -- that version was a strict
 * subset of this one.
 *
 * The <MovementReportSection /> embed that StatusCenterScreen.tsx also had
 * is deliberately NOT duplicated here -- it already has its own canonical
 * home in this shell's "movements" tab, and mounting it twice would just
 * show the same report in two tabs at once.
 */
function MaterialsAndBatchesTab({
  orgId,
  lang,
  role,
  myPermissions,
  onToast,
  onMobilePrint,
  onNavigate,
  onOpenSuggestionDocument,
}: {
  orgId: string; lang: 'ar' | 'en';
  role: string | null;
  myPermissions: Set<string>;
  onToast: (msg: string) => void;
  onMobilePrint: (html: string) => void;
  onNavigate: (screen: number) => void;
  onOpenSuggestionDocument?: (target: SuggestionDocumentTarget) => void;
}) {
  const [filterStatus, setFilterStatus] = useState<CanonicalStatus | ''>('');
  const [filterSupply, setFilterSupply] = useState<SupplyCategory | ''>('');
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<'table' | 'outlet'>('table');
  const [reportOutlet, setReportOutlet] = useState<{ id: string; name: string; nameAr: string } | null>(null);
  const [quantityFilter, setQuantityFilter] = useState<QuantityFilter>('all');
  const [recentOnly, setRecentOnly] = useState(false);
  const [priceFilterMode, setPriceFilterMode] = useState<PriceFilterMode>('all');
  const [priceValue, setPriceValue] = useState('');
  const [priceMin, setPriceMin] = useState('');
  const [priceMax, setPriceMax] = useState('');

  const canCorrectStock = STOCK_CORRECTION_VISIBILITY_KEYS.some(key => myPermissions.has(key));
  const [correctRow, setCorrectRow] = useState<AvailabilityCorrectionRow | null>(null);

  const canReactivate = REACTIVATE_PERMISSION_KEYS.every(key => myPermissions.has(key));
  const [reactivateRow, setReactivateRow] = useState<ReactivateRow | null>(null);

  const canViewMovementHistory = myPermissions.has('availability.movements.view');
  const [historyRow, setHistoryRow] = useState<MovementHistoryRow | null>(null);

  const [xlsxBusy, setXlsxBusy] = useState(false);

  const live = useAsync(() => getAvailabilityByOrg(orgId), [orgId]);
  const orgs = useAsync(() => getOrganizations(), []);

  const orgName = useMemo(() => {
    const o = (orgs.data ?? []).find(x => x.id === orgId);
    if (!o) return '';
    return lang === 'ar' ? (o.name_ar || o.name) : (o.name || o.name_ar);
  }, [orgs.data, orgId, lang]);

  const allRows = (live.data ?? []) as unknown as LiveAvailRow[];

  const rows = useMemo(() => {
    let list = allRows;
    if (filterStatus !== 'missing') {
      list = list.filter(r => !(r.quantity === 0 && r.condition === 'missing'));
    }
    list = list.filter(r => !r.distribution_points?.status || r.distribution_points.status === 'active');
    if (filterStatus) list = list.filter(r => effOf(r) === filterStatus);
    if (filterSupply) list = list.filter(r => normalizeSupplyType(r.supply_type) === filterSupply);
    if (quantityFilter === 'has_quantity') list = list.filter(r => r.quantity > 0);
    if (quantityFilter === 'zero_quantity') list = list.filter(r => r.quantity === 0);
    if (recentOnly) {
      const cutoff = Date.now() - RECENTLY_UPDATED_WINDOW_MS;
      list = list.filter(r => !!r.updated_at && new Date(r.updated_at).getTime() >= cutoff);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(r =>
        (r.scientific_name ?? '').toLowerCase().includes(q) ||
        (r.trade_name ?? '').toLowerCase().includes(q) ||
        (r.concentration ?? '').toLowerCase().includes(q) ||
        (r.dosage_form ?? '').toLowerCase().includes(q) ||
        (r.distribution_points?.name ?? '').toLowerCase().includes(q) ||
        (r.distribution_points?.name_ar ?? '').includes(search.trim())
      );
    }
    if (priceFilterMode === 'no_entered_price') {
      list = list.filter(r => !(typeof r.price === 'number' && r.price > 0));
    } else if (priceFilterMode === 'has_entered_price') {
      list = list.filter(r => typeof r.price === 'number' && r.price > 0);
    } else if (priceFilterMode === 'entered_price_less_than') {
      const threshold = parsePriceInput(priceValue);
      if (threshold !== null) list = list.filter(r => typeof r.price === 'number' && r.price < threshold);
    } else if (priceFilterMode === 'entered_price_greater_than') {
      const threshold = parsePriceInput(priceValue);
      if (threshold !== null) list = list.filter(r => typeof r.price === 'number' && r.price > threshold);
    } else if (priceFilterMode === 'entered_price_between') {
      const min = parsePriceInput(priceMin);
      const max = parsePriceInput(priceMax);
      if (min === null || max === null || min > max) {
        list = [];
      } else {
        list = list.filter(r => typeof r.price === 'number' && r.price >= min && r.price <= max);
      }
    }
    return list;
  }, [allRows, filterStatus, filterSupply, search, quantityFilter, recentOnly, priceFilterMode, priceValue, priceMin, priceMax]);

  const priceValueInvalid = useMemo(
    () => (priceFilterMode === 'entered_price_less_than' || priceFilterMode === 'entered_price_greater_than')
      && priceValue.trim() !== '' && parsePriceInput(priceValue) === null,
    [priceFilterMode, priceValue],
  );
  const priceRangeInvalid = useMemo(() => {
    if (priceFilterMode !== 'entered_price_between') return false;
    const min = parsePriceInput(priceMin);
    const max = parsePriceInput(priceMax);
    return min === null || max === null || min > max;
  }, [priceFilterMode, priceMin, priceMax]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const s of CANONICAL_STATUSES) c[s] = 0;
    for (const r of rows) { const s = effOf(r); c[s] = (c[s] ?? 0) + 1; }
    return c;
  }, [rows]);

  const outletOptions = useMemo(() => {
    const byPoint = new Map<string, { id: string; name: string; nameAr: string; count: number }>();
    for (const r of rows) {
      const dp = r.distribution_points;
      if (!dp) continue;
      if (!byPoint.has(dp.id)) byPoint.set(dp.id, { id: dp.id, name: dp.name, nameAr: dp.name_ar, count: 0 });
      byPoint.get(dp.id)!.count++;
    }
    return Array.from(byPoint.values()).sort((a, b) => (lang === 'ar' ? a.nameAr : a.name).localeCompare(lang === 'ar' ? b.nameAr : b.name));
  }, [rows, lang]);

  const internalAlerts = useMemo(() => computeInternalAlerts(allRows), [allRows]);

  const canSeeUsers = role === 'super_admin' || myPermissions.has('users.view');
  const quickActions: QuickAction[] = useMemo(() => {
    const actions: QuickAction[] = [
      { screen: 11, icon: 'institutions', labelKey: 'nav_institutions' },
      { screen: 13, icon: 'alerts', labelKey: 'nav_inter_alerts' },
      { screen: 6,  icon: 'qr', labelKey: 'nav_qr' },
      { screen: 15, icon: 'account', labelKey: 'nav_my_account' },
    ];
    if (canSeeUsers) actions.splice(1, 0, { screen: 14, icon: 'users', labelKey: 'nav_users' });
    return actions;
  }, [canSeeUsers]);

  const activityEntries: ActivityFeedEntry[] = useMemo(() => {
    return [...allRows]
      .filter(r => r.updated_at)
      .sort((a, b) => new Date(b.updated_at as string).getTime() - new Date(a.updated_at as string).getTime())
      .slice(0, 5)
      .map(r => ({
        id: r.id,
        title: (lang === 'ar' ? r.scientific_name : r.trade_name || r.scientific_name) || r.trade_name || r.scientific_name || '—',
        subtitle: `${dpNameOf(r, lang)} · ${t('cond_' + effOf(r), lang)}`,
        timestamp: formatStableDate(r.updated_at, lang),
      }));
  }, [allRows, lang]);

  const generatedAt = () => formatStableDateTime(new Date(), lang);

  const selectedFiltersText = useMemo(() => {
    const parts: string[] = [];
    if (filterStatus) parts.push(`${t('sc_effective_status', lang)}: ${t('cond_' + filterStatus, lang)}`);
    if (filterSupply) parts.push(`${t('avail_supply_type', lang)}: ${t('sc_supply_' + filterSupply, lang)}`);
    if (quantityFilter === 'has_quantity') parts.push(t('sf_has_quantity', lang));
    if (quantityFilter === 'zero_quantity') parts.push(t('sf_zero_quantity', lang));
    if (recentOnly) parts.push(t('sf_recently_updated', lang));
    if (search.trim()) parts.push(`${t('search', lang)}: ${search.trim()}`);
    if (priceFilterMode === 'no_entered_price') parts.push(t('sc_price_filter_no_entered', lang));
    else if (priceFilterMode === 'has_entered_price') parts.push(t('sc_price_filter_has_entered', lang));
    else if (priceFilterMode === 'entered_price_less_than') parts.push(`${t('sc_entered_price', lang)} ${t('sc_price_filter_less_than', lang)} ${priceValue.trim()}`);
    else if (priceFilterMode === 'entered_price_greater_than') parts.push(`${t('sc_entered_price', lang)} ${t('sc_price_filter_greater_than', lang)} ${priceValue.trim()}`);
    else if (priceFilterMode === 'entered_price_between') parts.push(`${t('sc_entered_price', lang)} ${t('sc_price_filter_between', lang)} ${priceMin.trim()}–${priceMax.trim()}`);
    return parts.length ? parts.join(' · ') : t('sc_all', lang);
  }, [filterStatus, filterSupply, quantityFilter, recentOnly, search, priceFilterMode, priceValue, priceMin, priceMax, lang]);

  const smartFilterChips: SmartFilterChipItem[] = [
    {
      key: 'all', labelKey: 'sc_all', icon: 'search',
      active: filterStatus === '' && quantityFilter === 'all' && !recentOnly,
      onClick: () => { setFilterStatus(''); setQuantityFilter('all'); setRecentOnly(false); },
    },
    {
      key: 'available', labelKey: 'cond_available', icon: 'check',
      active: filterStatus === 'available',
      onClick: () => setFilterStatus(prev => (prev === 'available' ? '' : 'available')),
    },
    {
      key: 'low_stock', labelKey: 'cond_low_stock', icon: 'warning',
      active: filterStatus === 'low_stock',
      onClick: () => setFilterStatus(prev => (prev === 'low_stock' ? '' : 'low_stock')),
    },
    {
      key: 'missing', labelKey: 'cond_missing', icon: 'close',
      active: filterStatus === 'missing',
      onClick: () => setFilterStatus(prev => (prev === 'missing' ? '' : 'missing')),
    },
    {
      key: 'near_expiry', labelKey: 'cond_near_expiry', icon: 'clock',
      active: filterStatus === 'near_expiry',
      onClick: () => setFilterStatus(prev => (prev === 'near_expiry' ? '' : 'near_expiry')),
    },
    {
      key: 'expired', labelKey: 'cond_expired', icon: 'ban',
      active: filterStatus === 'expired',
      onClick: () => setFilterStatus(prev => (prev === 'expired' ? '' : 'expired')),
    },
    {
      key: 'has_quantity', labelKey: 'sf_has_quantity', icon: 'package',
      active: quantityFilter === 'has_quantity',
      onClick: () => setQuantityFilter(prev => (prev === 'has_quantity' ? 'all' : 'has_quantity')),
    },
    {
      key: 'zero_quantity', labelKey: 'sf_zero_quantity', icon: 'info',
      active: quantityFilter === 'zero_quantity',
      onClick: () => setQuantityFilter(prev => (prev === 'zero_quantity' ? 'all' : 'zero_quantity')),
    },
    {
      key: 'recently_updated', labelKey: 'sf_recently_updated', icon: 'refresh',
      active: recentOnly,
      onClick: () => setRecentOnly(prev => !prev),
    },
  ];

  const columns: { key: string; label: string; value: (r: LiveAvailRow) => string }[] = [
    { key: 'org',     label: t('sc_lm_org', lang),          value: () => orgName || '—' },
    { key: 'port',    label: t('sc_lm_port', lang),         value: r => dpNameOf(r, lang) },
    { key: 'sci',     label: t('avail_scientific_name', lang), value: r => r.scientific_name || '—' },
    { key: 'trade',   label: t('avail_trade_name', lang),   value: r => r.trade_name || '—' },
    { key: 'conc',    label: t('avail_concentration', lang),value: r => r.concentration || '—' },
    { key: 'dosage',  label: t('avail_dosage_form', lang),  value: r => r.dosage_form || '—' },
    { key: 'qty',     label: t('qty', lang),                value: r => String(r.quantity ?? 0) },
    { key: 'price',   label: t('sc_entered_price', lang),   value: r => priceDisplay(r.price) },
    { key: 'supply',  label: t('avail_supply_type', lang),  value: r => r.supply_type || '—' },
    { key: 'raw',     label: t('sc_raw_condition', lang),   value: r => r.condition ? t('cond_' + r.condition, lang) : '—' },
    { key: 'eff',     label: t('sc_effective_status', lang),value: r => t('cond_' + effOf(r), lang) },
    { key: 'expiry',  label: t('expiry', lang),             value: r => expiryDisplay(r, lang) },
    { key: 'bucket',  label: t('sc_expiry_bucket', lang),   value: r => r.expiry_bucket || '—' },
    { key: 'updated', label: t('last_upd', lang),    value: r => formatStableDate(r.updated_at, lang) },
  ];

  function buildReportHtml(): string {
    const dir = lang === 'ar' ? 'rtl' : 'ltr';
    const countsLine = CANONICAL_STATUSES.map(s => `${t('cond_' + s, lang)}: ${counts[s]}`).join(' · ');
    const headCells = columns.map(c => `<th>${escHtmlMaterials(c.label)}</th>`).join('');
    const bodyRows = rows.map(r =>
      '<tr>' + columns.map(c => `<td${LTR_COLUMN_KEYS.has(c.key) ? ' dir="ltr"' : ''}>${escHtmlMaterials(c.value(r))}</td>`).join('') + '</tr>'
    ).join('');
    return `<!doctype html><html dir="${dir}" lang="${lang}"><head><meta charset="utf-8">
<title>${escHtmlMaterials(t('sc_report_title', lang))}</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  body { font-family: ${lang === 'ar' ? "'Segoe UI', Tahoma, Arial" : 'Arial, sans-serif'}; color: #111; direction: ${dir}; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .brand { font-size: 11px; color: #555; margin-bottom: 10px; }
  .meta { font-size: 11px; color: #333; margin: 2px 0; }
  .meta .val { unicode-bidi: isolate; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 10.5px; }
  th, td { border: 1px solid #999; padding: 4px 6px; text-align: ${lang === 'ar' ? 'right' : 'left'}; white-space: nowrap; }
  th { background: #eee; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
</style></head><body>
  <h1>${escHtmlMaterials(t('sc_report_title', lang))}</h1>
  <div class="brand">MediStock-Babil / MASAR Health Network</div>
  ${orgName ? `<div class="meta">${escHtmlMaterials(t('sc_lm_org', lang))}: ${escHtmlMaterials(orgName)}</div>` : ''}
  <div class="meta">${escHtmlMaterials(t('sc_selected_filters', lang))}: ${escHtmlMaterials(selectedFiltersText)}</div>
  <div class="meta">${escHtmlMaterials(t('sc_generated_at', lang))}: <span class="val" dir="ltr">${escHtmlMaterials(generatedAt())}</span></div>
  <div class="meta">${escHtmlMaterials(t('sc_total_rows', lang))}: ${rows.length}</div>
  <div class="meta">${escHtmlMaterials(countsLine)}</div>
  <div class="footer">${escHtmlMaterials(t('report_footer_generated_by', lang))}</div>
  <table><thead><tr>${headCells}</tr></thead><tbody>${bodyRows}</tbody></table>
</body></html>`;
  }

  function printReport() {
    if (rows.length === 0) return;
    if (isLikelyMobilePrintContext()) {
      onMobilePrint(buildReportHtml());
      return;
    }
    const win = window.open('', '_blank');
    if (!win) {
      onToast(t('print_popup_blocked', lang));
      return;
    }
    win.document.write(buildReportHtml());
    win.document.close();
    win.focus();
    win.print();
    win.close();
  }

  async function exportXlsx() {
    if (xlsxBusy) return;
    setXlsxBusy(true);
    try {
      const exportRows: AvailabilityExportRow[] = rows
        .filter(r => r.removed_at == null)
        .map((r, i) => {
          const status = effOf(r);
          const tier = getExpiryRiskTier(r.expiry_date);
          return {
            no: i + 1,
            institution: orgName || '—',
            outlet: dpNameOf(r, lang),
            scientificName: r.scientific_name || '—',
            tradeName: r.trade_name || '—',
            dosageForm: r.dosage_form || '—',
            concentration: r.concentration || '—',
            batchNumber: r.batch_number || '—',
            quantity: r.quantity ?? 0,
            enteredPrice: typeof r.price === 'number' ? r.price : null,
            conditionKey: status,
            conditionLabel: AVAIL_EXPORT_CONDITION_LABELS[status] ?? status,
            expiryDate: r.expiry_date ? new Date(r.expiry_date) : null,
            daysToExpiry: daysUntilExpiry(r.expiry_date),
            expiryRiskLabel: `${getExpiryRiskLabel(tier, 'en')} / ${getExpiryRiskLabel(tier, 'ar')}`,
            lastUpdatedBy: r.actor_name_snapshot || '—',
            lastUpdatedAt: r.updated_at ? new Date(r.updated_at) : null,
            notes: r.notes || '—',
          };
        });

      const safeOrg = orgName.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40);
      const ok = await exportAvailabilityXlsx({
        reportTitle: t('sc_report_title', lang),
        generatedAt: new Date(),
        lang,
        fileNameBase: `medistock-status${safeOrg ? '-' + safeOrg : ''}`,
        filtersSummary: selectedFiltersText,
        footerText: t('report_footer_generated_by', lang),
        emptyMessage: t('se_no_records', lang),
        conditionLabels: AVAIL_EXPORT_CONDITION_LABELS,
        rows: exportRows,
      });
      if (!ok) onToast(t('csv_export_failed', lang));
    } catch {
      onToast(t('csv_export_failed', lang));
    } finally {
      setXlsxBusy(false);
    }
  }

  function handleMovementSuccess() {
    onToast(t('mvmt_success', lang));
    live.reload();
  }

  function handleReactivateSuccess() {
    onToast(t('sc_reactivate_success', lang));
    live.reload();
  }

  const btnStyle = {
    padding: '9px 14px', minHeight: '38px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)',
    background: 'var(--s)', color: 'var(--t)', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
  } as const;

  const th = { textAlign: 'start' as const, padding: '8px 8px', fontSize: '11px', fontWeight: 700, color: 'var(--t2)', borderBottom: '2px solid var(--brd)', whiteSpace: 'nowrap' as const };
  const td = { padding: '7px 8px', fontSize: '11.5px', borderBottom: '1px solid var(--brd)', whiteSpace: 'nowrap' as const };

  return (
    <div data-testid="materials-batches-tab">
      <div style={{ marginBottom: '16px' }}>
        <h3 className="premium-section-header" style={{ fontSize: '13px', fontWeight: 700, marginBottom: '4px' }}>{t('quick', lang)}</h3>
        <p style={{ fontSize: '11px', color: 'var(--t2)', marginBottom: '10px' }}>{t('cc_quick_actions_sub', lang)}</p>
        <QuickActionGrid actions={quickActions} onNavigate={onNavigate} />
      </div>

      <div style={{ background: 'var(--info2)', border: '1px solid var(--info)', borderRadius: 'var(--r3)', padding: '10px 14px', marginBottom: '16px', fontSize: '12px', color: 'var(--info)', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <PhoenixIcon name="info" size={15} inline /> {t('sc_no_exchange', lang)}
      </div>

      <PhoenixCard padding="16px" style={{ marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '16px', fontWeight: 800, display: 'inline-flex', alignItems: 'center', gap: '6px' }}><PhoenixIcon name="clipboard" size={16} inline /> {t('sc_report_title', lang)}</span>
          <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--ok)', background: 'var(--ok2)', border: '1px solid var(--ok)', borderRadius: 'var(--rpill)', padding: '1px 8px' }}>LIVE</span>
        </div>
        <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '6px', display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
          {orgName && <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}><PhoenixIcon name="hospital" size={13} inline /> {orgName}</span>}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}><PhoenixIcon name="clock" size={13} inline /> {t('sc_generated_at', lang)}: {generatedAt()}</span>
          <span>Σ {t('sc_total_rows', lang)}: {rows.length}</span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '12px' }}>
          {CANONICAL_STATUSES.map(s => (
            <div key={s} style={{ flex: '1 1 90px', minWidth: '90px', background: 'var(--s2)', border: '1px solid var(--brd)', borderRadius: 'var(--r2)', padding: '8px 10px' }}>
              <div style={{ fontSize: '18px', fontWeight: 800, lineHeight: 1 }}>{counts[s]}</div>
              <div style={{ fontSize: '10.5px', color: 'var(--t2)', marginTop: '3px' }}>{t('cond_' + s, lang)}</div>
            </div>
          ))}
        </div>
      </PhoenixCard>

      {!live.loading && !live.error && <InternalAlertsSection matches={internalAlerts} />}

      <div style={{ marginBottom: '16px' }}>
        <h3 className="premium-section-header" style={{ fontSize: '13px', fontWeight: 700, marginBottom: '10px' }}>{t('cc_activity_title', lang)}</h3>
        {!live.loading && !live.error && <CommandCenterActivityFeed entries={activityEntries} />}
      </div>

      <PhoenixCard padding="14px" style={{ marginBottom: '16px' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value as CanonicalStatus | '')} style={{ ...materialsFieldStyle, minWidth: '150px', appearance: 'none', cursor: 'pointer' }} aria-label={t('sc_effective_status', lang)}>
            <option value="">{t('sc_all_statuses', lang)}</option>
            {CANONICAL_STATUSES.map(s => <option key={s} value={s}>{t('cond_' + s, lang)}</option>)}
          </select>

          <select value={filterSupply} onChange={e => setFilterSupply(e.target.value as SupplyCategory | '')} style={{ ...materialsFieldStyle, minWidth: '150px', appearance: 'none', cursor: 'pointer' }} aria-label={t('avail_supply_type', lang)}>
            <option value="">{t('sc_all_supply_types', lang)}</option>
            {SUPPLY_CATEGORIES.map(c => <option key={c.value} value={c.value}>{t(c.labelKey, lang)}</option>)}
          </select>

          <input type="search" dir="auto" value={search} onChange={e => setSearch(e.target.value)} placeholder={t('search', lang)} style={{ ...materialsFieldStyle, flex: 1, minWidth: '150px' }} aria-label={t('search', lang)} />

          <div className="premium-action-bar" style={{ display: 'flex', gap: '6px', marginInlineStart: 'auto', flexWrap: 'wrap' }}>
            <button onClick={() => void exportXlsx()} disabled={rows.length === 0 || xlsxBusy} aria-label={t('sc_export_excel', lang)} style={btnStyle}><PhoenixIcon name="reports" size={14} inline /> {t('sc_export_excel', lang)}</button>
            <button onClick={printReport} disabled={rows.length === 0} aria-label={t('sc_print_report', lang)} style={btnStyle}><PhoenixIcon name="print" size={14} inline /> {t('sc_print_report', lang)}</button>
            <button onClick={printReport} disabled={rows.length === 0} aria-label={t('sc_print_pdf', lang)} style={btnStyle}><PhoenixIcon name="file" size={14} inline /> {t('sc_print_pdf', lang)}</button>
          </div>
        </div>

        <div style={{ marginTop: '12px' }}>
          <SmartFilterChips items={smartFilterChips} ariaLabel={t('sf_group_label', lang)} />
        </div>

        <div style={{ display: 'flex', gap: '6px', marginTop: '10px' }}>
          <button
            onClick={() => setViewMode('table')}
            style={{ ...btnStyle, padding: '5px 12px', background: viewMode === 'table' ? 'var(--p2)' : 'var(--s)', color: viewMode === 'table' ? 'var(--pd)' : 'var(--t)' }}
          >
            <PhoenixIcon name="clipboard" size={14} inline /> {t('sc_view_table', lang)}
          </button>
          <button
            onClick={() => setViewMode('outlet')}
            style={{ ...btnStyle, padding: '5px 12px', background: viewMode === 'outlet' ? 'var(--p2)' : 'var(--s)', color: viewMode === 'outlet' ? 'var(--pd)' : 'var(--t)' }}
          >
            <PhoenixIcon name="outlet" size={14} inline /> {t('sc_view_outlet', lang)}
          </button>
        </div>

        {viewMode === 'outlet' && (
          <div style={{ marginTop: '10px' }}>
            <select
              value=""
              onChange={e => {
                const id = e.target.value;
                if (!id) return;
                const o = outletOptions.find(x => x.id === id);
                if (o) setReportOutlet({ id: o.id, name: o.name, nameAr: o.nameAr });
              }}
              style={{ ...materialsFieldStyle, minWidth: '220px', appearance: 'none', cursor: 'pointer' }}
              aria-label={t('sc_outlet_report_select', lang)}
            >
              <option value="">{t('sc_outlet_report_select', lang)}</option>
              {outletOptions.map(o => (
                <option key={o.id} value={o.id}>
                  {(lang === 'ar' ? o.nameAr : o.name) || '—'} ({o.count} {t('sc_outlet_items_count', lang)})
                </option>
              ))}
            </select>
          </div>
        )}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '10px' }}>
          <button onClick={() => setFilterSupply('')} style={{ ...btnStyle, padding: '5px 12px', background: filterSupply === '' ? 'var(--p2)' : 'var(--s)', color: filterSupply === '' ? 'var(--pd)' : 'var(--t)' }}>{t('sc_all_supply_types', lang)}</button>
          {SUPPLY_CATEGORIES.map(c => (
            <button key={c.value} onClick={() => setFilterSupply(c.value)} style={{ ...btnStyle, padding: '5px 12px', background: filterSupply === c.value ? 'var(--p2)' : 'var(--s)', color: filterSupply === c.value ? 'var(--pd)' : 'var(--t)' }}>
              {t(c.labelKey, lang)}
            </button>
          ))}
        </div>

        <div style={{ marginTop: '10px' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
            <select
              value={priceFilterMode}
              onChange={e => setPriceFilterMode(e.target.value as PriceFilterMode)}
              style={{ ...materialsFieldStyle, minWidth: '170px', appearance: 'none', cursor: 'pointer' }}
              aria-label={t('sc_price_filter_label', lang)}
            >
              <option value="all">{t('sc_price_filter_all', lang)}</option>
              <option value="no_entered_price">{t('sc_price_filter_no_entered', lang)}</option>
              <option value="has_entered_price">{t('sc_price_filter_has_entered', lang)}</option>
              <option value="entered_price_less_than">{t('sc_price_filter_less_than', lang)}</option>
              <option value="entered_price_greater_than">{t('sc_price_filter_greater_than', lang)}</option>
              <option value="entered_price_between">{t('sc_price_filter_between', lang)}</option>
            </select>

            {(priceFilterMode === 'entered_price_less_than' || priceFilterMode === 'entered_price_greater_than') && (
              <input
                type="number" min="0" step="0.01" dir="ltr"
                value={priceValue}
                onChange={e => setPriceValue(e.target.value)}
                placeholder={t('sc_price_value_ph', lang)}
                aria-label={t('sc_price_value_ph', lang)}
                style={{ ...materialsFieldStyle, minWidth: '120px' }}
              />
            )}

            {priceFilterMode === 'entered_price_between' && (
              <>
                <input
                  type="number" min="0" step="0.01" dir="ltr"
                  value={priceMin}
                  onChange={e => setPriceMin(e.target.value)}
                  placeholder={t('sc_price_min_ph', lang)}
                  aria-label={t('sc_price_min_ph', lang)}
                  style={{ ...materialsFieldStyle, minWidth: '100px' }}
                />
                <input
                  type="number" min="0" step="0.01" dir="ltr"
                  value={priceMax}
                  onChange={e => setPriceMax(e.target.value)}
                  placeholder={t('sc_price_max_ph', lang)}
                  aria-label={t('sc_price_max_ph', lang)}
                  style={{ ...materialsFieldStyle, minWidth: '100px' }}
                />
              </>
            )}
          </div>
          {priceValueInvalid && (
            <div style={{ fontSize: '11px', color: 'var(--err)', marginTop: '6px' }}>{t('sc_price_invalid', lang)}</div>
          )}
          {priceRangeInvalid && (
            <div style={{ fontSize: '11px', color: 'var(--err)', marginTop: '6px' }}>{t('sc_price_range_invalid', lang)}</div>
          )}
        </div>

        <div style={{ fontSize: '11px', color: 'var(--t2)', marginTop: '10px' }}>
          {t('sc_selected_filters', lang)}: {selectedFiltersText}
        </div>
      </PhoenixCard>

      {live.loading && <PhoenixLoadingState label={t('loading', lang)} />}
      {!live.loading && live.error && (
        <PhoenixErrorState title={t('load_error', lang)} message={live.error} onRetry={live.reload} />
      )}
      {!live.loading && !live.error && rows.length === 0 && (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--t2)', fontSize: '13px' }}>
          {allRows.length === 0 ? t('sc_live_empty', lang) : t('sc_no_match', lang)}
        </div>
      )}
      {!live.loading && !live.error && rows.length > 0 && viewMode === 'outlet' && (
        <OutletMaterialGroups rows={rows} />
      )}
      {!live.loading && !live.error && rows.length > 0 && viewMode === 'table' && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', background: 'var(--s)', borderRadius: 'var(--r2)' }}>
            <thead>
              <tr>
                <th style={th}>{t('sc_lm_port', lang)}</th>
                <th style={th}>{t('avail_scientific_name', lang)}</th>
                <th style={th}>{t('avail_trade_name', lang)}</th>
                <th style={th}>{t('avail_concentration', lang)}</th>
                <th style={th}>{t('avail_dosage_form', lang)}</th>
                <th style={th}>{t('qty', lang)}</th>
                <th style={th}>{t('sc_entered_price', lang)}</th>
                <th style={th}>{t('avail_supply_type', lang)}</th>
                <th style={th}>{t('sc_raw_condition', lang)}</th>
                <th style={th}>{t('sc_effective_status', lang)}</th>
                <th style={th}>{t('sc_removed_badge', lang)}</th>
                <th style={th}>{t('expiry', lang)}</th>
                <th style={th}>{t('last_upd', lang)}</th>
                {(canCorrectStock || canReactivate || canViewMovementHistory) && <th style={th}></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const eff = effOf(r);
                const isRemoved = r.removed_at != null;
                return (
                  <tr key={r.id}>
                    <td style={td} dir="auto">{dpNameOf(r, lang)}</td>
                    <td style={td} dir="auto">{r.scientific_name || '—'}</td>
                    <td style={td} dir="auto">{r.trade_name || '—'}</td>
                    <td style={td} dir="auto">{r.concentration || '—'}</td>
                    <td style={td} dir="auto">{r.dosage_form || '—'}</td>
                    <td style={td}>{r.quantity}</td>
                    <td style={td} dir="ltr">{priceDisplay(r.price)}</td>
                    <td style={td} dir="auto">{r.supply_type || '—'}</td>
                    <td style={td}>{r.condition ? t('cond_' + r.condition, lang) : '—'}</td>
                    <td style={td}><PhoenixStatusBadge variant={CANON_VARIANT[eff] ?? 'neutral'} label={t('cond_' + eff, lang)} /></td>
                    <td style={td}>
                      {isRemoved ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                          <PhoenixStatusBadge variant="err" icon="ban" label={t('sc_removed_badge', lang)} />
                          <span style={{ fontSize: '10px', color: 'var(--t2)' }} dir="auto">
                            {removalReasonLabel(r.removal_reason, lang)}
                          </span>
                          <span style={{ fontSize: '10px', color: 'var(--t2)' }} dir="ltr">
                            {t('sc_removed_at_label', lang)}: {formatStableDate(r.removed_at, lang)}
                          </span>
                          {r.actor_name_snapshot && (
                            <span style={{ fontSize: '10px', color: 'var(--t2)' }} dir="auto">
                              {t('sc_last_action_by', lang)}: {r.actor_name_snapshot}
                            </span>
                          )}
                        </div>
                      ) : '—'}
                    </td>
                    <td style={td} dir="ltr">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' }}>
                        <span>{expiryDisplay(r, lang)}</span>
                        <ExpiryRiskBadge expiryDate={r.expiry_date} lang={lang} />
                      </div>
                    </td>
                    <td style={td} dir="ltr">{formatStableDate(r.updated_at, lang)}</td>
                    {(canCorrectStock || canReactivate || canViewMovementHistory) && (
                      <td style={td}>
                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'nowrap' }}>
                          {isRemoved ? (
                            canReactivate && (
                              <button
                                onClick={() => setReactivateRow(r as unknown as ReactivateRow)}
                                aria-label={t('sc_reactivate_action', lang)}
                                style={{ padding: '5px 10px', borderRadius: 'var(--r1)', border: '1px solid var(--ok)', background: 'var(--s)', color: 'var(--ok)', fontSize: '11px', cursor: 'pointer', whiteSpace: 'nowrap' }}
                              >
                                ↩ {t('sc_reactivate_action', lang)}
                              </button>
                            )
                          ) : (
                            canCorrectStock && (
                              <button
                                onClick={() => setCorrectRow(r as unknown as AvailabilityCorrectionRow)}
                                aria-label={t('sc_correct_stock_action', lang)}
                                style={{ padding: '5px 10px', borderRadius: 'var(--r1)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t2)', fontSize: '11px', cursor: 'pointer', whiteSpace: 'nowrap' }}
                              >
                                <PhoenixIcon name="editor" size={12} inline /> {t('sc_correct_stock_action', lang)}
                              </button>
                            )
                          )}
                          {canViewMovementHistory && (
                            <button
                              onClick={() => setHistoryRow(r)}
                              aria-label={t('mvmt_history_action', lang)}
                              style={{ padding: '5px 10px', borderRadius: 'var(--r1)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t2)', fontSize: '11px', cursor: 'pointer', whiteSpace: 'nowrap' }}
                            >
                              <PhoenixIcon name="clock" size={12} inline /> {t('mvmt_history_action', lang)}
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <AvailabilityStockCorrectionModal
        open={correctRow !== null}
        row={correctRow}
        orgId={orgId}
        lang={lang}
        onClose={() => setCorrectRow(null)}
        onCorrected={handleMovementSuccess}
      />
      <ReactivateMaterialModal
        open={reactivateRow !== null}
        row={reactivateRow}
        lang={lang}
        myPermissions={myPermissions}
        onClose={() => setReactivateRow(null)}
        onSuccess={handleReactivateSuccess}
      />
      <MovementHistoryModal
        open={historyRow !== null}
        row={historyRow}
        lang={lang}
        onClose={() => setHistoryRow(null)}
      />
      <OutletAvailabilityReportModal
        open={reportOutlet !== null}
        onClose={() => setReportOutlet(null)}
        outletId={reportOutlet?.id ?? null}
        outletName={reportOutlet ? (lang === 'ar' ? (reportOutlet.nameAr || reportOutlet.name) : (reportOutlet.name || reportOutlet.nameAr)) : ''}
        institutionName={orgName}
        lang={lang}
        rows={rows}
      />

      <div style={{ marginTop: '28px' }}>
        <InventoryIntelligencePanel onOpenDocument={onOpenSuggestionDocument} />
      </div>

      <div style={{ marginTop: '28px', background: 'var(--p2)', border: '1px solid var(--p)', borderRadius: 'var(--r3)', padding: '18px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--pd)', display: 'flex', alignItems: 'center', gap: '6px' }}><PhoenixIcon name="refresh" size={15} inline /> {t('material_exchange_center', lang)}</div>
          <div style={{ fontSize: '12px', color: 'var(--pd)', marginTop: '3px', opacity: 0.85 }}>{t('duplicate_exchange_moved_notice', lang)}</div>
        </div>
        <button
          onClick={() => onNavigate(13)}
          style={{ padding: '8px 16px', borderRadius: 'var(--r2)', border: 'none', background: 'var(--p)', color: 'white', fontSize: '12px', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}
        >
          {t('open_exchange_center', lang)} →
        </button>
      </div>
    </div>
  );
}

/**
 * Differences & Corrections — reads the FULL history (any status) of the
 * existing second-person-approval tables (098 outlet, 101 warehouse). No
 * new table, no new RPC, no new classification: the "difference" (variance)
 * and the resulting balance are exactly what the approval RPCs already
 * computed and stored.
 */
export function CorrectionsHistoryTab({ lang, onToast, onMobilePrint }: {
  lang: 'ar' | 'en';
  onToast: (msg: string) => void;
  onMobilePrint: (html: string) => void;
}) {
  const history = useAsync(() => listCorrectionHistory(), []);
  const [xlsxBusy, setXlsxBusy] = useState(false);

  // `?? []` so `rows`/`outletIds` are stable on EVERY render (including the
  // initial loading render) — required so the paper-reference hook below is
  // called unconditionally, before any early return. Calling a hook after a
  // conditional early return violates React's fixed-hook-order rule and, in
  // the sibling Custody Chain tab, crashed the whole app shell on first load
  // the same way ("Rendered more hooks than during the previous render").
  const rows = history.data ?? [];

  /**
   * PAPER-REFERENCE-CONTRACT-110's 'stock_correction_request' document_type
   * maps ONLY to phoenix_stock_correction_requests (outlet scope) — see
   * PendingCorrectionsPanel.tsx's identical comment. Warehouse-scope
   * corrections have no covered document_type, so no paper reference is
   * fetched or shown for those rows.
   */
  const outletIds = rows.filter(r => r.scope === 'outlet').map(r => r.id);
  const paperRefs = useAsync(() => getPaperReferencesFor('stock_correction_request', outletIds), [outletIds.join(',')]);

  // Both hooks above are now invoked unconditionally on every render — safe
  // to early-return past this point.
  if (history.loading && !history.data) return <PhoenixLoadingState />;
  if (history.error) return <PhoenixErrorState message={history.error} onRetry={history.reload} />;
  // Wrapped in the same data-testid as the loaded-content return below —
  // an empty result is a legitimate, fully-rendered state, not a blank
  // page, and must be provable as such by anything keying off this tab's
  // root (see all-tabs-mount.runtime.test.tsx).
  if (rows.length === 0) return <div data-testid="corrections-history-tab"><PhoenixEmptyState icon="package" title={t('dir_library_empty', lang)} /></div>;

  function exportConfig() {
    const columns: ProfessionalReportColumn<CorrectionHistoryRow>[] = [
      { key: 'scope', label: t('dir_col_scope', lang), value: r => t('dir_scope_' + r.scope, lang) },
      { key: 'material', label: t('avail_scientific_name', lang), value: r => r.scientificName ?? '—' },
      { key: 'batch', label: t('batch_no', lang), value: r => r.batchNumber ?? '—', ltr: true },
      { key: 'before', label: t('dir_col_before', lang), value: r => String(r.onHandBefore), numeric: true, excelValue: r => r.onHandBefore },
      { key: 'after', label: t('dir_col_after', lang), value: r => String(r.afterOrProposed), numeric: true, excelValue: r => r.afterOrProposed },
      { key: 'variance', label: t('dir_col_variance', lang), value: r => String(r.variance), numeric: true, excelValue: r => r.variance },
      { key: 'status', label: t('dir_col_status', lang), value: r => t('dir_correction_status_' + r.status, lang) },
      { key: 'reason', label: t('lp_return_reason', lang), value: r => r.reason },
      { key: 'proposedBy', label: t('dir_col_proposed_by', lang), value: r => r.proposedByName ?? '—' },
      { key: 'proposedAt', label: t('dir_as_of', lang), value: r => r.proposedAt, ltr: true, dateColumn: 'datetime', excelValue: r => r.proposedAt },
      { key: 'linkedMovement', label: t('dir_col_linked_movement', lang), value: r => r.appliedMovementId ? t('mvmt_dispense_context_yes', lang) : t('mvmt_dispense_context_no', lang) },
    ];
    return {
      reportTitle: t('dir_tab_corrections', lang),
      generatedAt: new Date(),
      filtersSummary: t('sc_all', lang),
      columns,
      rows,
      lang,
      fileNameBase: 'medistock-differences-corrections',
      footerText: t('report_footer_generated_by', lang),
      labels: {
        generatedAt: t('sc_generated_at', lang),
        filtersSummary: t('sc_selected_filters', lang),
        rowCount: t('sc_total_rows', lang),
      },
    };
  }

  async function exportXlsx() {
    if (xlsxBusy) return;
    setXlsxBusy(true);
    try { await exportProfessionalXlsx(exportConfig()); } finally { setXlsxBusy(false); }
  }

  function printReport() {
    const { ok, mobileHtml } = triggerProfessionalPrint(exportConfig());
    if (mobileHtml !== undefined) { onMobilePrint(mobileHtml); return; }
    if (!ok) onToast(t('print_popup_blocked', lang));
  }

  return (
    <div style={{ display: 'grid', gap: '10px' }} data-testid="corrections-history-tab">
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11.5px' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'start', padding: '6px 8px' }}>{t('avail_scientific_name', lang)}</th>
              <th style={{ textAlign: 'start', padding: '6px 8px' }}>{t('batch_no', lang)}</th>
              <th style={{ textAlign: 'end', padding: '6px 8px' }}>{t('dir_col_before', lang)}</th>
              <th style={{ textAlign: 'end', padding: '6px 8px' }}>{t('dir_col_after', lang)}</th>
              <th style={{ textAlign: 'end', padding: '6px 8px' }}>{t('dir_col_variance', lang)}</th>
              <th style={{ textAlign: 'start', padding: '6px 8px' }}>{t('dir_col_status', lang)}</th>
              <th style={{ textAlign: 'start', padding: '6px 8px' }}>{t('lp_return_reason', lang)}</th>
              <th style={{ textAlign: 'start', padding: '6px 8px' }}>{t('dir_col_paper_reference', lang)}</th>
              <th style={{ textAlign: 'start', padding: '6px 8px' }}>{t('dir_col_linked_movement', lang)}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={`${r.scope}-${r.id}`} style={{ borderTop: '1px solid var(--brd)' }}>
                <td style={{ padding: '6px 8px' }} dir="auto">{r.scientificName ?? '—'}</td>
                <td style={{ padding: '6px 8px' }} dir="ltr">{r.batchNumber ?? '—'}</td>
                <td style={{ padding: '6px 8px', textAlign: 'end' }}>{r.onHandBefore}</td>
                <td style={{ padding: '6px 8px', textAlign: 'end' }}>{r.afterOrProposed}</td>
                <td style={{ padding: '6px 8px', textAlign: 'end' }}>{r.variance}</td>
                <td style={{ padding: '6px 8px' }}>{t('dir_correction_status_' + r.status, lang)}</td>
                <td style={{ padding: '6px 8px' }} dir="auto">{r.reason}</td>
                <td style={{ padding: '6px 8px' }} dir="ltr">{r.scope === 'outlet' ? (paperRefs.data?.get(r.id)?.paperReferenceNumber ?? '—') : '—'}</td>
                <td style={{ padding: '6px 8px' }}>
                  {r.appliedMovementId ? t('mvmt_dispense_context_yes', lang) : t('mvmt_dispense_context_no', lang)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <PhoenixButton variant="ghost" size="sm" onClick={() => void exportXlsx()} loading={xlsxBusy}>
          {t('mv_export_xlsx', lang)}
        </PhoenixButton>
        <PhoenixButton variant="ghost" size="sm" onClick={printReport}>
          {t('se_print', lang)}
        </PhoenixButton>
      </div>
    </div>
  );
}

/**
 * Custody Chain — request/review/approval/dispatch/in-transit/receipt for
 * institution-warehouse-to-outlet corridors, plus outlet-to-institution
 * returns. Reuses the exact header list functions the operational screens
 * already call (dispatch.service.ts/outlet-return.service.ts), called with
 * NO id filter so RLS returns every document in the caller's organization —
 * not a new list surface. Per-document drill-down reuses
 * phoenix_movement_timeline (081/082) verbatim, including its own honest
 * `complete: false` / completeness_note when the full history cannot be
 * reconstructed from what was actually persisted (surfaced as-is here,
 * never hidden or overstated).
 */
interface CustodyCombinedRow { id: string; kind: string; number: string; status: string; date: string | null; }
interface CustodyTraceEventRow {
  documentKind: string; documentNumber: string; eventType: string; status: string | null;
  occurredAt: string; actorName: string | null; material: string | null;
  // MOVEMENT-TIMELINE-CONTRACT-FIELDS-139 — exported in exact parity with
  // what the on-screen trace shows, from the same phoenix_movement_timeline
  // rowset. No beneficiary detail: only whether a context exists.
  reasonCode: string | null; quantityBefore: number | null; quantityDelta: number | null;
  quantityAfter: number | null; correlationId: string | null; causationId: string | null;
  reference: string | null; provenance: string; hasDispenseContext: boolean;
}

export function CustodyChainTab({ lang, onToast, onMobilePrint }: {
  lang: 'ar' | 'en';
  onToast: (msg: string) => void;
  onMobilePrint: (html: string) => void;
}) {
  const dispatches = useAsync(() => listCustodyDispatches(), []);
  const returnRequests = useAsync(() => listCustodyReturnRequests(), []);
  const returnShipments = useAsync(() => listCustodyReturnShipments(), []);
  const [traceOpenFor, setTraceOpenFor] = useState<string | null>(null);
  const [traceCache, setTraceCache] = useState<Record<string, MovementTimelineResult>>({});
  const [traceError, setTraceError] = useState<string | null>(null);
  const [xlsxBusy, setXlsxBusy] = useState(false);
  const [fullXlsxBusy, setFullXlsxBusy] = useState(false);
  // MOVEMENT-TIMELINE-CONTRACT-FIELDS-139: masked dispense-context drill-down.
  // The timeline only ever tells us WHETHER a context exists; the beneficiary
  // detail is fetched on demand through the existing masked RPC, so
  // movement_context.view_sensitive stays the single source of truth.
  const [contextForMovement, setContextForMovement] = useState<string | null>(null);
  const [dispenseContext, setDispenseContext] = useState<DispenseContext | null>(null);
  const [dispenseContextError, setDispenseContextError] = useState<string | null>(null);

  useEffect(() => {
    if (!contextForMovement) { setDispenseContext(null); setDispenseContextError(null); return; }
    let cancelled = false;
    getDispenseContext(contextForMovement)
      .then(ctx => { if (!cancelled) setDispenseContext(ctx); })
      .catch(e => { if (!cancelled) setDispenseContextError((e as Error)?.message ?? 'load_error'); });
    return () => { cancelled = true; };
  }, [contextForMovement]);

  // `?? []` so these are stable, safely-typed arrays on EVERY render (including
  // the initial loading render) — required so the two paper-reference hooks
  // below can be called unconditionally, before any early return. Calling
  // hooks after a conditional early return violates React's fixed-hook-order
  // rule and previously crashed the whole app shell on first load ("Rendered
  // more hooks than during the previous render").
  const dispatchRows = dispatches.data ?? [];
  const requestRows = returnRequests.data ?? [];
  const shipmentRows = returnShipments.data ?? [];

  /**
   * PAPER-REFERENCE-CONTRACT-110 is read-only here (no writer control — the
   * paper reference is set from the operational dispatch/return screens,
   * not from this reports screen). Only the two document types 110 actually
   * covers for these tables: 'warehouse_dispatch' and 'outlet_return_request'
   * (see OutletDispatchComposer.tsx/OutletReturnComposer.tsx for the same
   * mapping). Return SHIPMENTS have no covered document_type — 110 does not
   * extend to them, so no paper reference is fetched or shown for that list.
   */
  const dispatchPaperRefs = useAsync(
    () => getPaperReferencesFor('warehouse_dispatch', dispatchRows.map(d => d.id)),
    [dispatchRows.map(d => d.id).join(',')],
  );
  const requestPaperRefs = useAsync(
    () => getPaperReferencesFor('outlet_return_request', requestRows.map(r => r.id)),
    [requestRows.map(r => r.id).join(',')],
  );

  async function toggleTrace(id: string) {
    if (traceOpenFor === id) { setTraceOpenFor(null); return; }
    setTraceOpenFor(id);
    setTraceError(null);
    if (!traceCache[id]) {
      try {
        const result = await getMovementTimeline(id);
        setTraceCache(c => ({ ...c, [id]: result }));
      } catch (e) {
        setTraceError(e instanceof Error ? e.message : String(e));
      }
    }
  }

  // Every hook above is now invoked unconditionally on every render — safe to
  // early-return past this point. Loading/error is checked across all THREE
  // reads (dispatches, return requests, return shipments), not dispatches
  // alone, so a slow/failed return-requests or return-shipments fetch is
  // never silently ignored while dispatches happens to resolve first.
  const anyLoading = (dispatches.loading && !dispatches.data)
    || (returnRequests.loading && !returnRequests.data)
    || (returnShipments.loading && !returnShipments.data);
  if (anyLoading) return <PhoenixLoadingState />;

  const firstErrored = dispatches.error ? dispatches
    : returnRequests.error ? returnRequests
    : returnShipments.error ? returnShipments
    : null;
  if (firstErrored) return <PhoenixErrorState message={firstErrored.error!} onRetry={firstErrored.reload} />;

  const combined: CustodyCombinedRow[] = [
    ...dispatchRows.map((d): CustodyCombinedRow => ({ id: d.id, kind: t('dir_custody_dispatch', lang), number: d.dispatchNumber, status: d.status, date: d.sentAt ?? d.createdAt })),
    ...requestRows.map((r): CustodyCombinedRow => ({ id: r.id, kind: t('dir_custody_return_request', lang), number: r.returnNumber, status: r.status, date: r.createdAt })),
    ...shipmentRows.map((s): CustodyCombinedRow => ({ id: s.id, kind: t('dir_custody_return_shipment', lang), number: s.shipmentNumber, status: s.status, date: null })),
  ];

  function summarySheetConfig(moduleName: string) {
    const columns: ProfessionalReportColumn<CustodyCombinedRow>[] = [
      { key: 'kind', label: t('dir_col_document_type', lang), value: r => r.kind },
      { key: 'number', label: t('dir_col_document_number', lang), value: r => r.number, ltr: true },
      { key: 'status', label: t('dir_col_status', lang), value: r => r.status.replace(/_/g, ' ') },
      { key: 'date', label: t('dir_as_of', lang), value: r => r.date ?? '—', ltr: true },
    ];
    return {
      reportTitle: t('dir_tab_custody', lang),
      moduleName,
      generatedAt: new Date(),
      filtersSummary: t('sc_all', lang),
      columns,
      rows: combined,
      lang,
      fileNameBase: 'medistock-custody-chain',
      footerText: t('report_footer_generated_by', lang),
      labels: {
        generatedAt: t('sc_generated_at', lang),
        filtersSummary: t('sc_selected_filters', lang),
        rowCount: t('sc_total_rows', lang),
      },
    };
  }

  function exportConfig() {
    return summarySheetConfig(t('dir_tab_custody', lang));
  }

  async function exportXlsx() {
    if (xlsxBusy) return;
    setXlsxBusy(true);
    try { await exportProfessionalXlsx(exportConfig()); } finally { setXlsxBusy(false); }
  }

  function printReport() {
    const { ok, mobileHtml } = triggerProfessionalPrint(exportConfig());
    if (mobileHtml !== undefined) { onMobilePrint(mobileHtml); return; }
    if (!ok) onToast(t('print_popup_blocked', lang));
  }

  /**
   * Multi-sheet export: sheet 1 = the combined document summary (same as
   * exportXlsx), sheet 2 = the full movement-timeline trace for EVERY
   * document, not just the ones the user happened to expand — the same
   * phoenix_movement_timeline data toggleTrace shows on click, fetched here
   * for the whole list so the export is never missing detail the screen can
   * show.
   */
  async function exportFullXlsx() {
    if (fullXlsxBusy) return;
    setFullXlsxBusy(true);
    try {
      const traces = await Promise.all(combined.map(async row => {
        const cached = traceCache[row.id];
        const result = cached ?? await getMovementTimeline(row.id).catch(() => null);
        return { row, result };
      }));
      const eventRows: CustodyTraceEventRow[] = traces.flatMap(({ row, result }) =>
        (result?.events ?? []).map(ev => ({
          documentKind: row.kind,
          documentNumber: row.number,
          eventType: ev.event_type,
          status: ev.status,
          occurredAt: ev.occurred_at,
          actorName: ev.actor_name,
          material: ev.material,
          reasonCode: ev.reason_code,
          quantityBefore: ev.quantity_before,
          quantityDelta: ev.quantity_delta,
          quantityAfter: ev.quantity_after,
          correlationId: ev.correlation_id,
          causationId: ev.causation_id,
          reference: ev.reference,
          provenance: ev.provenance,
          hasDispenseContext: ev.has_dispense_context,
        })),
      );
      const traceSheet = {
        reportTitle: t('dir_tab_custody', lang),
        moduleName: 'Trace Events',
        generatedAt: new Date(),
        filtersSummary: t('sc_all', lang),
        columns: [
          { key: 'kind', label: t('dir_col_document_type', lang), value: (r: CustodyTraceEventRow) => r.documentKind },
          { key: 'number', label: t('dir_col_document_number', lang), value: (r: CustodyTraceEventRow) => r.documentNumber, ltr: true },
          { key: 'event', label: 'Event', value: (r: CustodyTraceEventRow) => r.eventType, ltr: true },
          { key: 'status', label: t('dir_col_status', lang), value: (r: CustodyTraceEventRow) => r.status ?? '—' },
          { key: 'occurredAt', label: t('dir_as_of', lang), value: (r: CustodyTraceEventRow) => r.occurredAt, ltr: true, dateColumn: 'datetime', excelValue: (r: CustodyTraceEventRow) => r.occurredAt },
          { key: 'actor', label: t('dir_col_proposed_by', lang), value: (r: CustodyTraceEventRow) => r.actorName ?? '—' },
          { key: 'material', label: 'Material', value: (r: CustodyTraceEventRow) => r.material ?? '—' },
          // 139 contract fields — same values, same rowset as the on-screen trace.
          { key: 'reasonCode', label: t('mvmt_col_reason_code', lang), value: (r: CustodyTraceEventRow) => reasonCodeLabel(r.reasonCode, lang) },
          { key: 'qtyBefore', label: t('dir_col_quantity_before', lang), value: (r: CustodyTraceEventRow) => r.quantityBefore === null ? '—' : String(r.quantityBefore), numeric: true, excelValue: (r: CustodyTraceEventRow) => r.quantityBefore ?? undefined },
          { key: 'qtyDelta', label: t('mvmt_col_delta', lang), value: (r: CustodyTraceEventRow) => r.quantityDelta === null ? '—' : String(r.quantityDelta), numeric: true, excelValue: (r: CustodyTraceEventRow) => r.quantityDelta ?? undefined },
          { key: 'qtyAfter', label: t('dir_col_quantity_after', lang), value: (r: CustodyTraceEventRow) => r.quantityAfter === null ? '—' : String(r.quantityAfter), numeric: true, excelValue: (r: CustodyTraceEventRow) => r.quantityAfter ?? undefined },
          { key: 'reference', label: t('mvmt_col_document_ref', lang), value: (r: CustodyTraceEventRow) => r.reference ?? '—', ltr: true },
          { key: 'dispenseContext', label: t('mvmt_col_dispense_context', lang), value: (r: CustodyTraceEventRow) => r.hasDispenseContext ? t('mvmt_dispense_context_yes', lang) : t('mvmt_dispense_context_no', lang) },
          { key: 'provenance', label: t('dir_col_provenance', lang), value: (r: CustodyTraceEventRow) => r.provenance, ltr: true },
        ] as ProfessionalReportColumn<CustodyTraceEventRow>[],
        rows: eventRows,
        lang,
        fileNameBase: 'medistock-custody-chain-trace',
        footerText: t('report_footer_generated_by', lang),
        labels: { generatedAt: t('sc_generated_at', lang), filtersSummary: t('sc_selected_filters', lang), rowCount: t('sc_total_rows', lang) },
      };
      await exportProfessionalMultiSheetXlsx(
        [summarySheetConfig('Documents'), traceSheet],
        'medistock-custody-chain-full',
      );
    } finally {
      setFullXlsxBusy(false);
    }
  }

  const traceBlock = (id: string) => traceOpenFor === id && (
    <div style={{ marginTop: '6px', padding: '8px 10px', background: 'var(--s2)', borderRadius: 'var(--r2)', fontSize: '11px' }}>
      {!traceCache[id] && !traceError && <PhoenixLoadingState />}
      {traceError && <div style={{ color: 'var(--err)' }}>{traceError}</div>}
      {traceCache[id] && (
        <>
          <div style={{ color: 'var(--t2)', marginBottom: '6px' }} dir="auto">{traceCache[id].completeness_note}</div>
          {traceCache[id].events.length === 0
            ? <div style={{ color: 'var(--t2)' }}>{t('dir_library_empty', lang)}</div>
            : traceCache[id].events.map(ev => (
              <div key={ev.event_id} style={{ borderTop: '1px solid var(--brd)', padding: '5px 0' }} data-testid="custody-trace-event">
                <div>
                  <strong>{ev.event_type}</strong>{ev.status ? ` → ${ev.status}` : ''}
                  {' · '}<span dir="ltr">{formatStableDateTime(ev.occurred_at, lang)}</span>
                  {ev.actor_name ? ` · ${ev.actor_name}` : ''}
                  {ev.material ? ` · ${ev.material}` : ''}
                </div>
                {/* MOVEMENT-TIMELINE-CONTRACT-FIELDS-139: the canonical
                    contract detail. Every value is rendered only when the
                    server actually returned it — a derived_from_column
                    header transition genuinely has no quantity or reason,
                    and that absence is shown honestly, never filled in. */}
                <div style={{ color: 'var(--t2)', marginTop: '2px', display: 'flex', flexWrap: 'wrap', gap: '4px 10px' }}>
                  {ev.reason_code && (
                    <span>{t('mvmt_col_reason_code', lang)}: {reasonCodeLabel(ev.reason_code, lang)}</span>
                  )}
                  {ev.quantity_before !== null && ev.quantity_after !== null && (
                    <span dir="ltr">
                      {ev.quantity_before} → {ev.quantity_after}
                      {ev.quantity_delta !== null ? ` (${ev.quantity_delta > 0 ? '+' : ''}${ev.quantity_delta})` : ''}
                    </span>
                  )}
                  {ev.reference && <span dir="ltr">{t('mvmt_col_document_ref', lang)}: {ev.reference}</span>}
                  {ev.has_dispense_context && (
                    <button
                      type="button"
                      onClick={() => setContextForMovement(ev.event_id)}
                      style={{ border: '1px solid var(--brd)', borderRadius: 'var(--r2)', background: 'var(--s)', color: 'var(--t)', cursor: 'pointer', fontSize: '10.5px', padding: '1px 6px' }}
                    >
                      {t('mvmt_col_dispense_context', lang)} · {t('mvmt_dispense_context_view', lang)}
                    </button>
                  )}
                  <span style={{ color: 'var(--t3)' }}>{ev.provenance}</span>
                </div>
              </div>
            ))}
        </>
      )}
    </div>
  );

  return (
    <div style={{ display: 'grid', gap: '14px' }} data-testid="custody-chain-tab">
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <PhoenixButton variant="ghost" size="sm" onClick={() => void exportXlsx()} loading={xlsxBusy}>
          {t('mv_export_xlsx', lang)}
        </PhoenixButton>
        <PhoenixButton variant="ghost" size="sm" onClick={() => void exportFullXlsx()} loading={fullXlsxBusy}>
          {t('dir_export_full_with_detail', lang)}
        </PhoenixButton>
        <PhoenixButton variant="ghost" size="sm" onClick={printReport}>
          {t('se_print', lang)}
        </PhoenixButton>
      </div>

      <PhoenixCard>
        <div style={{ fontSize: '12px', fontWeight: 700, marginBottom: '8px' }}>{t('dir_custody_dispatch', lang)}</div>
        {dispatchRows.length === 0 ? <PhoenixEmptyState icon="package" title={t('dir_library_empty', lang)} /> : (
          <div style={{ display: 'grid', gap: '6px' }}>
            {dispatchRows.map(d => {
              const paperRef = dispatchPaperRefs.data?.get(d.id);
              return (
                <div key={d.id} style={{ fontSize: '11.5px' }}>
                  <button type="button" onClick={() => void toggleTrace(d.id)} style={{ width: '100%', display: 'flex', justifyContent: 'space-between', padding: '6px 8px', border: '1px solid var(--brd)', borderRadius: 'var(--r2)', background: 'var(--s)', cursor: 'pointer', color: 'var(--t)' }}>
                    <span dir="ltr">{d.dispatchNumber}</span>
                    <span>{d.status.replace(/_/g, ' ')}</span>
                  </button>
                  {paperRef?.paperReferenceNumber && (
                    <div style={{ padding: '2px 8px', color: 'var(--t2)' }} dir="ltr">
                      {t('dir_col_paper_reference', lang)}: {paperRef.paperReferenceNumber}
                    </div>
                  )}
                  {traceBlock(d.id)}
                </div>
              );
            })}
          </div>
        )}
      </PhoenixCard>

      <PhoenixCard>
        <div style={{ fontSize: '12px', fontWeight: 700, marginBottom: '8px' }}>{t('dir_custody_return_request', lang)}</div>
        {requestRows.length === 0 ? <PhoenixEmptyState icon="package" title={t('dir_library_empty', lang)} /> : (
          <div style={{ display: 'grid', gap: '6px' }}>
            {requestRows.map(r => {
              const paperRef = requestPaperRefs.data?.get(r.id);
              return (
                <div key={r.id} style={{ fontSize: '11.5px' }}>
                  <button type="button" onClick={() => void toggleTrace(r.id)} style={{ width: '100%', display: 'flex', justifyContent: 'space-between', padding: '6px 8px', border: '1px solid var(--brd)', borderRadius: 'var(--r2)', background: 'var(--s)', cursor: 'pointer', color: 'var(--t)' }}>
                    <span dir="ltr">{r.returnNumber}</span>
                    <span>{r.status.replace(/_/g, ' ')}</span>
                  </button>
                  {paperRef?.paperReferenceNumber && (
                    <div style={{ padding: '2px 8px', color: 'var(--t2)' }} dir="ltr">
                      {t('dir_col_paper_reference', lang)}: {paperRef.paperReferenceNumber}
                    </div>
                  )}
                  {traceBlock(r.id)}
                </div>
              );
            })}
          </div>
        )}
      </PhoenixCard>

      <PhoenixCard>
        <div style={{ fontSize: '12px', fontWeight: 700, marginBottom: '8px' }}>{t('dir_custody_return_shipment', lang)}</div>
        {shipmentRows.length === 0 ? <PhoenixEmptyState icon="package" title={t('dir_library_empty', lang)} /> : (
          <div style={{ display: 'grid', gap: '6px' }}>
            {shipmentRows.map(s => (
              <div key={s.id} style={{ fontSize: '11.5px' }}>
                <button type="button" onClick={() => void toggleTrace(s.id)} style={{ width: '100%', display: 'flex', justifyContent: 'space-between', padding: '6px 8px', border: '1px solid var(--brd)', borderRadius: 'var(--r2)', background: 'var(--s)', cursor: 'pointer', color: 'var(--t)' }}>
                  <span dir="ltr">{s.shipmentNumber}</span>
                  <span>{s.status.replace(/_/g, ' ')}</span>
                </button>
                {traceBlock(s.id)}
              </div>
            ))}
          </div>
        )}
      </PhoenixCard>

      <PhoenixDialog
        open={contextForMovement !== null}
        onClose={() => setContextForMovement(null)}
        title={t('mvmt_col_dispense_context', lang)}
      >
        {dispenseContextError && <PhoenixErrorState title={t('load_error', lang)} message={dispenseContextError} />}
        {!dispenseContextError && !dispenseContext && <PhoenixLoadingState />}
        {!dispenseContextError && dispenseContext && <DispenseContextViewer context={dispenseContext} lang={lang} />}
      </PhoenixDialog>
    </div>
  );
}

/**
 * Supplementary Purchases — traceability. procurement_orders/receipts/lines
 * (087/089) ARE the supplementary-purchase corridor by construction; no new
 * table. Adds the ONE missing org-wide list (getOrders() in
 * procurement.service.ts requires a warehouseId — the operational screen's
 * own per-warehouse scope), still through the SAME RLS
 * (phoenix_can_read_local_procurement) every operational read already goes
 * through. Drill-down (order -> receipt -> line) reuses getReceipts/
 * getReceiptLines UNCHANGED. Full official-document print/XLSX/QR rendering
 * for a specific receipt remains on the existing LocalProcurementScreen
 * (screen 19) rather than being duplicated a second time here — this tab is
 * the traceability list + drill-down, not a second receipt-rendering UI.
 *
 * PAPER-REFERENCE-CONTRACT-110 does NOT cover procurement_orders or
 * procurement_receipts — PaperReferenceDocumentType is limited to
 * warehouse_dispatch / warehouse_return_request / outlet_return_request /
 * stock_correction_request / warehouse_stock_movement (paper-reference.
 * service.ts). No paper reference is surfaced here; extending 110 to this
 * table is a backend contract change out of scope for this reports screen.
 */
function SupplementaryPurchasesTab({ orgId, lang, onToast, onMobilePrint }: {
  orgId: string; lang: 'ar' | 'en';
  onToast: (msg: string) => void;
  onMobilePrint: (html: string) => void;
}) {
  const orders = useAsync(() => listSupplementaryPurchaseOrders(orgId), [orgId]);
  const suppliers = useAsync(() => getSuppliers(orgId), [orgId]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [xlsxBusy, setXlsxBusy] = useState(false);
  const [fullXlsxBusy, setFullXlsxBusy] = useState(false);

  if (orders.loading && !orders.data) return <PhoenixLoadingState />;
  if (orders.error) return <PhoenixErrorState message={orders.error} onRetry={orders.reload} />;
  const rows = orders.data ?? [];
  // Wrapped in the tab's own data-testid — see the corrections tab above
  // for why an empty result must still be provable as non-blank content.
  if (rows.length === 0) return <div data-testid="supplementary-purchases-tab"><PhoenixEmptyState icon="package" title={t('lp_history_none', lang)} /></div>;

  function ordersSheetConfig(moduleName: string) {
    const columns: ProfessionalReportColumn<OrderRow>[] = [
      { key: 'number', label: t('dir_col_document_number', lang), value: r => r.orderNumber, ltr: true },
      { key: 'status', label: t('dir_col_status', lang), value: r => r.status.replace(/_/g, ' ') },
      { key: 'invoice', label: t('sp_invoice_ref', lang), value: r => r.invoiceNumber ?? '—', ltr: true },
      { key: 'date', label: t('dir_as_of', lang), value: r => r.createdAt, ltr: true, dateColumn: 'datetime', excelValue: r => r.createdAt },
    ];
    return {
      reportTitle: t('dir_tab_supplementary', lang),
      moduleName,
      generatedAt: new Date(),
      filtersSummary: t('sc_all', lang),
      columns,
      rows,
      lang,
      fileNameBase: 'medistock-supplementary-purchases',
      footerText: t('report_footer_generated_by', lang),
      labels: {
        generatedAt: t('sc_generated_at', lang),
        filtersSummary: t('sc_selected_filters', lang),
        rowCount: t('sc_total_rows', lang),
      },
    };
  }

  function exportConfig() {
    return ordersSheetConfig(t('dir_tab_supplementary', lang));
  }

  async function exportXlsx() {
    if (xlsxBusy) return;
    setXlsxBusy(true);
    try { await exportProfessionalXlsx(exportConfig()); } finally { setXlsxBusy(false); }
  }

  function printReport() {
    const { ok, mobileHtml } = triggerProfessionalPrint(exportConfig());
    if (mobileHtml !== undefined) { onMobilePrint(mobileHtml); return; }
    if (!ok) onToast(t('print_popup_blocked', lang));
  }

  /**
   * Multi-sheet export: sheet 1 = orders (same as exportXlsx), sheet 2 =
   * every receipt across every order, sheet 3 = every receipt line across
   * every receipt — the same order->receipt->line drill-down the UI shows
   * on open, but fetched for ALL orders instead of only the one expanded,
   * so the export is never missing detail the screen can show.
   */
  async function exportFullXlsx() {
    if (fullXlsxBusy) return;
    setFullXlsxBusy(true);
    try {
      const perOrder = await Promise.all(rows.map(async o => ({ order: o, receipts: await getReceipts(o.id) })));
      const receiptRows: (ReceiptRow & { orderNumber: string })[] = perOrder.flatMap(
        ({ order, receipts }) => receipts.map(r => ({ ...r, orderNumber: order.orderNumber })),
      );
      const perReceiptLines = await Promise.all(
        receiptRows.map(async r => ({ receipt: r, lines: await getReceiptLines(r.id) })),
      );
      const lineRows: (ReceiptLineRow & { receiptNumber: string })[] = perReceiptLines.flatMap(
        ({ receipt, lines }) => lines.map(rl => ({ ...rl, receiptNumber: receipt.receiptNumber })),
      );

      const receiptsSheet = {
        reportTitle: t('dir_tab_supplementary', lang),
        moduleName: 'Receipts',
        generatedAt: new Date(),
        filtersSummary: t('sc_all', lang),
        columns: [
          { key: 'order', label: t('dir_col_document_number', lang), value: (r: typeof receiptRows[number]) => r.orderNumber, ltr: true },
          { key: 'receipt', label: t('dir_col_receipt_number', lang), value: (r: typeof receiptRows[number]) => r.receiptNumber, ltr: true },
          { key: 'invoice', label: t('sp_invoice_ref', lang), value: (r: typeof receiptRows[number]) => r.invoiceNumber ?? '—', ltr: true },
          { key: 'date', label: t('dir_as_of', lang), value: (r: typeof receiptRows[number]) => r.createdAt, ltr: true, dateColumn: 'datetime', excelValue: (r: typeof receiptRows[number]) => r.createdAt },
        ] as ProfessionalReportColumn<typeof receiptRows[number]>[],
        rows: receiptRows,
        lang,
        fileNameBase: 'medistock-supplementary-purchases-receipts',
        footerText: t('report_footer_generated_by', lang),
        labels: { generatedAt: t('sc_generated_at', lang), filtersSummary: t('sc_selected_filters', lang), rowCount: t('sc_total_rows', lang) },
      };

      const linesSheet = {
        reportTitle: t('dir_tab_supplementary', lang),
        moduleName: 'Receipt Lines',
        generatedAt: new Date(),
        filtersSummary: t('sc_all', lang),
        columns: [
          { key: 'receipt', label: t('dir_col_receipt_number', lang), value: (r: typeof lineRows[number]) => r.receiptNumber, ltr: true },
          { key: 'qty', label: t('lp_qty', lang), value: (r: typeof lineRows[number]) => String(r.quantity), numeric: true, excelValue: (r: typeof lineRows[number]) => r.quantity },
          { key: 'batch', label: t('mv_f_batch_number', lang), value: (r: typeof lineRows[number]) => r.batchNumber ?? '—', ltr: true },
          { key: 'expiry', label: t('mv_f_expiry_date', lang), value: (r: typeof lineRows[number]) => r.expiryDate ?? '—', ltr: true, dateColumn: 'date', excelValue: (r: typeof lineRows[number]) => r.expiryDate },
        ] as ProfessionalReportColumn<typeof lineRows[number]>[],
        rows: lineRows,
        lang,
        fileNameBase: 'medistock-supplementary-purchases-lines',
        footerText: t('report_footer_generated_by', lang),
        labels: { generatedAt: t('sc_generated_at', lang), filtersSummary: t('sc_selected_filters', lang), rowCount: t('sc_total_rows', lang) },
      };

      await exportProfessionalMultiSheetXlsx(
        [ordersSheetConfig('Orders'), receiptsSheet, linesSheet],
        'medistock-supplementary-purchases-full',
      );
    } finally {
      setFullXlsxBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: '10px' }} data-testid="supplementary-purchases-tab">
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <PhoenixButton variant="ghost" size="sm" onClick={() => void exportXlsx()} loading={xlsxBusy}>
          {t('mv_export_xlsx', lang)}
        </PhoenixButton>
        <PhoenixButton variant="ghost" size="sm" onClick={() => void exportFullXlsx()} loading={fullXlsxBusy}>
          {t('dir_export_full_with_detail', lang)}
        </PhoenixButton>
        <PhoenixButton variant="ghost" size="sm" onClick={printReport}>
          {t('se_print', lang)}
        </PhoenixButton>
      </div>
      {rows.map(o => {
        const supplier = suppliers.data?.find(s => s.id === o.supplierId) ?? null;
        return (
          <PhoenixCard key={o.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: '13px', fontWeight: 700, display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <span dir="ltr">{o.orderNumber}</span> <StatusBadge status={o.status} lang={lang} />
                </div>
                <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '3px' }}>
                  {t('lp_supplier', lang)}: {supplier ? (lang === 'ar' ? (supplier.nameAr || supplier.name) : supplier.name) : '—'} ·{' '}
                  {new Date(o.createdAt).toLocaleDateString(lang === 'ar' ? 'ar' : 'en')}
                </div>
              </div>
              <PhoenixButton variant="ghost" size="sm" onClick={() => setOpenId(openId === o.id ? null : o.id)}>
                {openId === o.id ? t('lp_close', lang) : t('lp_open', lang)}
              </PhoenixButton>
            </div>
            {openId === o.id && <SupplementaryPurchaseDrilldown orderId={o.id} lang={lang} />}
          </PhoenixCard>
        );
      })}
    </div>
  );
}

function SupplementaryPurchaseDrilldown({ orderId, lang }: { orderId: string; lang: 'ar' | 'en' }) {
  const detail = useAsync(async () => {
    const receipts = await getReceipts(orderId);
    const lines = new Map<string, ReceiptLineRow[]>();
    await Promise.all(receipts.map(async r => { lines.set(r.id, await getReceiptLines(r.id)); }));
    return { receipts, lines };
  }, [orderId]);

  if (detail.loading && !detail.data) return <PhoenixLoadingState />;
  if (detail.error) return <PhoenixErrorState message={detail.error} onRetry={detail.reload} />;
  const d = detail.data;
  if (!d) return null;

  return (
    <div style={{ marginTop: '10px', borderTop: '1px solid var(--brd)', paddingTop: '10px', fontSize: '11.5px' }}>
      {d.receipts.length === 0 && <div style={{ color: 'var(--t2)' }}>{t('lp_detail_no_receipts', lang)}</div>}
      {d.receipts.map(r => (
        <div key={r.id} style={{ marginBottom: '8px' }}>
          <div style={{ fontWeight: 700 }} dir="ltr">{r.receiptNumber}</div>
          {(d.lines.get(r.id) ?? []).map(rl => (
            <div key={rl.id} style={{ color: 'var(--t2)' }}>
              {t('lp_qty', lang)}: {rl.quantity} · {t('mv_f_batch_number', lang)}: {rl.batchNumber ?? '—'} · {t('mv_f_expiry_date', lang)}: {rl.expiryDate ?? '—'}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

const MST_CLASSIFICATION_LABEL_KEY: Record<MaterialClassification, string> = {
  available: 'mst_class_available',
  unavailable: 'mst_class_unavailable',
  scarce: 'mst_class_scarce',
  surplus: 'mst_class_surplus',
  suspected_missing: 'mst_class_suspected_missing',
};
const MST_CLASSIFICATION_VARIANT: Record<MaterialClassification, 'ok' | 'warn' | 'err' | 'neutral'> = {
  // 'unavailable' is a plain zero-balance fact, distinct from the ERROR-toned
  // suspected_missing (which requires stocktake evidence + confirmation) —
  // rendered as a warning, never conflated with the missing/error state.
  available: 'ok', unavailable: 'warn', scarce: 'warn', surplus: 'ok', suspected_missing: 'err',
};

/**
 * REPORTING-UNIFICATION: real migration of screen 20's full
 * prepare->classify/stocktake->submit->approve+lock/return->amend workflow,
 * moved verbatim from the former MonthlyStatusScreen.tsx (not a
 * reimplementation) — every RPC call, role gate, and UI state is unchanged.
 * Uses the shared onToast rather than its own toast state, since this now
 * lives inside a shell that already renders one toast for every tab.
 */
function MonthlyPositionTab({ orgId, lang, role, onToast }: {
  orgId: string;
  lang: 'ar' | 'en';
  role: string | null;
  onToast: (msg: string) => void;
}) {
  const normalizedRole = normalizeRole(role ?? '');

  const canPrepare  = normalizedRole === 'warehouse_officer' || normalizedRole === 'super_admin';
  const canClassify = canPrepare;
  const canSubmit   = normalizedRole === 'institution_admin' || normalizedRole === 'super_admin';
  const canReview   = normalizedRole === 'central_warehouse_manager' || normalizedRole === 'super_admin';

  const scopes = useInventoryScopes(orgId);
  const [busy, setBusy] = useState(false);

  const reportState = useAsync(() => getOpenMonthlyStatusReport(orgId), [orgId]);
  const report = reportState.data;

  const lockedState = useAsync(() => getLatestLockedMonthlyStatusReport(orgId), [orgId]);

  const linesState = useAsync(
    () => (report ? getMonthlyStatusLines(report.id) : Promise.resolve([])),
    [report?.id],
  );
  const lines = linesState.data ?? [];

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkClassification, setBulkClassification] = useState<MaterialClassification>('available');
  const [bulkReason, setBulkReason] = useState('');
  const [returnReason, setReturnReason] = useState('');
  const [amendReason, setAmendReason] = useState('');

  // Stocktake mini-form (WO records evidence before classifying suspected_missing).
  const [stkScopeKind, setStkScopeKind] = useState<'warehouse' | 'outlet'>('warehouse');
  const [stkScopeId, setStkScopeId] = useState('');
  const [stkCounts, setStkCounts] = useState<Record<string, string>>({}); // line.id -> counted qty text
  const [lastStocktakeId, setLastStocktakeId] = useState<string | null>(null);
  const stocktakeLinesState = useAsync(
    () => (lastStocktakeId ? getStocktakeCountLines(lastStocktakeId) : Promise.resolve<StocktakeCountLine[]>([])),
    [lastStocktakeId],
  );

  const scopeOptions = stkScopeKind === 'warehouse' ? scopes.data?.manageableWarehouses ?? [] : scopes.data?.manageableOutlets ?? [];

  async function onPrepare() {
    setBusy(true);
    try {
      await prepareMonthlyStatusReport(orgId);
      reportState.reload();
      linesState.reload();
      onToast(t('mst_prepared', lang));
    } catch (e) { onToast((e as Error).message); }
    finally { setBusy(false); }
  }

  async function onRecordStocktake() {
    if (!stkScopeId) return;
    const stkLines = lines
      .filter(l => selected.has(l.id) && stkCounts[l.id] !== undefined && stkCounts[l.id] !== '')
      .map(l => ({ scientific_name: l.scientific_name, national_code: l.national_code, counted_qty: Number(stkCounts[l.id]) }));
    if (stkLines.length === 0) { onToast(t('mst_stocktake_no_lines', lang)); return; }
    setBusy(true);
    try {
      const res = await recordStocktake({ organizationId: orgId, scopeKind: stkScopeKind, scopeId: stkScopeId, lines: stkLines });
      setLastStocktakeId(res.stocktake_id);
      onToast(t('mst_stocktake_recorded', lang));
    } catch (e) { onToast((e as Error).message); }
    finally { setBusy(false); }
  }

  function stocktakeLineFor(line: MonthlyStatusLine): StocktakeCountLine | undefined {
    return (stocktakeLinesState.data ?? []).find(
      s => s.scientific_name.toLowerCase() === line.scientific_name.toLowerCase()
        && (s.national_code ?? '') === (line.national_code ?? ''),
    );
  }

  async function onApplyBulkClassification() {
    if (!report || selected.size === 0) return;
    const payload = [...selected].map(lineId => {
      const line = lines.find(l => l.id === lineId)!;
      const evidence = bulkClassification === 'suspected_missing' ? stocktakeLineFor(line) : undefined;
      return {
        line_id: lineId,
        classification: bulkClassification,
        reason: bulkReason || null,
        stocktake_count_line_id: evidence?.id ?? null,
      };
    });
    setBusy(true);
    try {
      const res = await classifyMonthlyStatusLines(report.id, payload);
      onToast(t('mst_classified', lang).replace('{n}', String(res.classified)));
      setSelected(new Set());
      setBulkReason('');
      linesState.reload();
      reportState.reload();
    } catch (e) { onToast((e as Error).message); }
    finally { setBusy(false); }
  }

  async function onConfirmMissing(lineId: string) {
    setBusy(true);
    try {
      const res = await confirmSuspectedMissing(lineId);
      onToast(res.confirmed ? t('mst_confirmed', lang) : t('mst_confirm_pending_second', lang));
      linesState.reload();
    } catch (e) { onToast((e as Error).message); }
    finally { setBusy(false); }
  }

  async function onSubmit() {
    if (!report) return;
    setBusy(true);
    try {
      await submitMonthlyStatusReport(report.id);
      onToast(t('mst_submitted', lang));
      reportState.reload();
    } catch (e) { onToast((e as Error).message); }
    finally { setBusy(false); }
  }

  async function onReturn() {
    if (!report || !returnReason.trim()) return;
    setBusy(true);
    try {
      await returnMonthlyStatusReportForClarification(report.id, returnReason.trim());
      onToast(t('mst_returned', lang));
      setReturnReason('');
      reportState.reload();
    } catch (e) { onToast((e as Error).message); }
    finally { setBusy(false); }
  }

  async function onApproveLock() {
    if (!report) return;
    setBusy(true);
    try {
      await approveLockMonthlyStatusReport(report.id);
      onToast(t('mst_locked', lang));
      reportState.reload();
      lockedState.reload();
    } catch (e) { onToast((e as Error).message); }
    finally { setBusy(false); }
  }

  async function onAmend() {
    const locked = lockedState.data;
    if (!locked || !amendReason.trim()) return;
    setBusy(true);
    try {
      await createMonthlyStatusAmendment(locked.id, amendReason.trim());
      onToast(t('mst_amended', lang));
      setAmendReason('');
      reportState.reload();
    } catch (e) { onToast((e as Error).message); }
    finally { setBusy(false); }
  }

  const editable = report && (report.status === 'draft' || report.status === 'returned');
  const allClassified = lines.length > 0 && lines.every(l => l.classification !== null);
  const anyUnconfirmedMissing = lines.some(l => l.classification === 'suspected_missing' && !l.confirmed_missing);

  return (
    <div data-testid="monthly-position-tab" style={{ maxWidth: '1200px', animation: 'fs .3s ease' }}>
      {reportState.loading && <PhoenixLoadingState />}

      {!reportState.loading && !report && (
        <PhoenixCard padding="16px">
          <PhoenixEmptyState icon="clipboard" title={t('mst_no_open_report', lang)} description={t('mst_no_open_report_desc', lang)} />
          {canPrepare && (
            <div style={{ marginTop: '12px' }}>
              <PhoenixButton onClick={onPrepare} disabled={busy}>{t('mst_prepare_action', lang)}</PhoenixButton>
            </div>
          )}
        </PhoenixCard>
      )}

      {report && (
        <PhoenixCard padding="16px" style={{ marginBottom: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <PhoenixStatusBadge
                variant={report.status === 'locked' ? 'ok' : report.status === 'returned' ? 'warn' : 'neutral'}
                label={t(`mst_status_${report.status}`, lang)}
              />
              <span style={{ fontSize: '11.5px', color: 'var(--t2)' }} dir="ltr">v{report.version}</span>
            </div>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {canPrepare && editable && (
                <PhoenixButton variant="secondary" size="sm" onClick={onPrepare} disabled={busy}>{t('mst_refresh_action', lang)}</PhoenixButton>
              )}
              {canSubmit && editable && (
                <PhoenixButton size="sm" onClick={onSubmit} disabled={busy || !allClassified || anyUnconfirmedMissing}>
                  {t('mst_submit_action', lang)}
                </PhoenixButton>
              )}
              {canReview && report.status === 'submitted' && (
                <PhoenixButton size="sm" onClick={onApproveLock} disabled={busy}>{t('mst_approve_lock_action', lang)}</PhoenixButton>
              )}
            </div>
          </div>
          {report.status === 'returned' && report.return_reason && (
            <div style={{ marginTop: '10px', fontSize: '12px', color: 'var(--warn)' }}>
              {t('mst_return_reason_label', lang)}: {report.return_reason}
            </div>
          )}
          {canReview && report.status === 'submitted' && (
            <div style={{ marginTop: '12px', display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <PhoenixInput
                label={t('mst_return_reason_placeholder', lang)}
                value={returnReason}
                onChange={e => setReturnReason(e.target.value)}
                dir="auto"
              />
              <PhoenixButton variant="secondary" size="sm" onClick={onReturn} disabled={busy || !returnReason.trim()}>
                {t('mst_return_action', lang)}
              </PhoenixButton>
            </div>
          )}
          {!allClassified && lines.length > 0 && (
            <p style={{ marginTop: '8px', fontSize: '11.5px', color: 'var(--t2)' }}>{t('mst_unclassified_warning', lang)}</p>
          )}
          {anyUnconfirmedMissing && (
            <p style={{ marginTop: '4px', fontSize: '11.5px', color: 'var(--err)' }}>{t('mst_unconfirmed_missing_warning', lang)}</p>
          )}
        </PhoenixCard>
      )}

      {report && canPrepare && editable && (
        <PhoenixCard padding="16px" style={{ marginBottom: '16px' }}>
          <h3 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '8px' }}>{t('mst_stocktake_title', lang)}</h3>
          <p style={{ fontSize: '11.5px', color: 'var(--t2)', marginBottom: '10px' }}>{t('mst_stocktake_desc', lang)}</p>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' }}>
            <PhoenixSelect
              label={t('mst_scope_kind', lang)}
              value={stkScopeKind}
              onChange={e => { setStkScopeKind(e.target.value as 'warehouse' | 'outlet'); setStkScopeId(''); }}
              options={[
                { value: 'warehouse', label: t('mst_scope_warehouse', lang) },
                { value: 'outlet', label: t('mst_scope_outlet', lang) },
              ]}
            />
            <PhoenixSelect
              label={t('mst_scope_target', lang)}
              value={stkScopeId}
              onChange={e => setStkScopeId(e.target.value)}
              options={[{ value: '', label: '—' }, ...scopeOptions.map(o => ({ value: o.id, label: lang === 'ar' ? o.nameAr || o.name : o.name }))]}
            />
          </div>
          <p style={{ fontSize: '11px', color: 'var(--t2)', marginBottom: '6px' }}>{t('mst_stocktake_select_hint', lang)}</p>
          <PhoenixButton variant="secondary" size="sm" onClick={onRecordStocktake} disabled={busy || !stkScopeId}>
            {t('mst_stocktake_record_action', lang)}
          </PhoenixButton>
        </PhoenixCard>
      )}

      {report && lines.length > 0 && (
        <PhoenixCard padding="0" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--brd)' }}>
                {canClassify && editable && <th style={{ padding: '10px' }} />}
                <th style={{ padding: '10px', textAlign: 'start' }}>{t('mst_col_material', lang)}</th>
                <th style={{ padding: '10px', textAlign: 'end' }}>{t('mst_col_on_hand', lang)}</th>
                <th style={{ padding: '10px', textAlign: 'end' }}>{t('mst_col_central', lang)}</th>
                <th style={{ padding: '10px', textAlign: 'end' }}>{t('mst_col_supplementary', lang)}</th>
                <th style={{ padding: '10px', textAlign: 'center' }}>{t('mst_col_expiry', lang)}</th>
                <th style={{ padding: '10px', textAlign: 'center' }}>{t('mst_col_suggested', lang)}</th>
                <th style={{ padding: '10px', textAlign: 'center' }}>{t('mst_col_classification', lang)}</th>
                <th style={{ padding: '10px' }} />
              </tr>
            </thead>
            <tbody>
              {lines.map(line => {
                const tier = getExpiryRiskTier(line.nearest_expiry_date);
                const stk = stocktakeLineFor(line);
                return (
                  <tr key={line.id} style={{ borderBottom: '1px solid var(--brd)' }}>
                    {canClassify && editable && (
                      <td style={{ padding: '10px' }}>
                        <input
                          type="checkbox"
                          checked={selected.has(line.id)}
                          onChange={e => {
                            const next = new Set(selected);
                            if (e.target.checked) next.add(line.id); else next.delete(line.id);
                            setSelected(next);
                          }}
                        />
                      </td>
                    )}
                    <td style={{ padding: '10px' }} dir="auto">{line.scientific_name}</td>
                    <td style={{ padding: '10px', textAlign: 'end' }} dir="ltr">{line.on_hand_qty}</td>
                    <td style={{ padding: '10px', textAlign: 'end' }} dir="ltr">{line.central_qty}</td>
                    <td style={{ padding: '10px', textAlign: 'end' }} dir="ltr">{line.supplementary_qty}</td>
                    <td style={{ padding: '10px', textAlign: 'center' }}>
                      {line.nearest_expiry_date ? (
                        <PhoenixStatusBadge variant={getExpiryRiskTone(tier) as 'ok'|'warn'|'err'|'neutral'} label={getExpiryRiskLabel(tier, lang)} />
                      ) : '—'}
                    </td>
                    <td style={{ padding: '10px', textAlign: 'center' }}>
                      <PhoenixStatusBadge variant={MST_CLASSIFICATION_VARIANT[line.suggested_classification]} label={t(MST_CLASSIFICATION_LABEL_KEY[line.suggested_classification], lang)} />
                    </td>
                    <td style={{ padding: '10px', textAlign: 'center' }}>
                      {line.classification ? (
                        <PhoenixStatusBadge variant={MST_CLASSIFICATION_VARIANT[line.classification]} label={t(MST_CLASSIFICATION_LABEL_KEY[line.classification], lang)} />
                      ) : <span style={{ color: 'var(--t2)' }}>{t('mst_unclassified', lang)}</span>}
                      {line.classification === 'suspected_missing' && (
                        <div style={{ fontSize: '10.5px', marginTop: '4px', color: line.confirmed_missing ? 'var(--ok)' : 'var(--warn)' }}>
                          {line.confirmed_missing ? t('mst_confirmed_badge', lang) : t('mst_pending_confirmation_badge', lang)}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: '10px' }}>
                      {canClassify && editable && line.classification === 'suspected_missing' && !line.confirmed_missing && (
                        <PhoenixButton variant="secondary" size="sm" onClick={() => onConfirmMissing(line.id)} disabled={busy}>
                          {t('mst_confirm_action', lang)}
                        </PhoenixButton>
                      )}
                      {editable && (
                        <input
                          type="number"
                          placeholder={t('mst_counted_qty_placeholder', lang)}
                          value={stkCounts[line.id] ?? ''}
                          onChange={e => setStkCounts({ ...stkCounts, [line.id]: e.target.value })}
                          style={{ width: '70px', marginInlineStart: '6px' }}
                          dir="ltr"
                        />
                      )}
                      {stk && <div style={{ fontSize: '10px', color: 'var(--t2)' }} dir="ltr">Δ{stk.variance}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </PhoenixCard>
      )}

      {report && canClassify && editable && selected.size > 0 && (
        <PhoenixCard padding="16px" style={{ marginTop: '16px' }}>
          <h3 style={{ fontSize: '13px', fontWeight: 700, marginBottom: '8px' }}>
            {t('mst_bulk_title', lang).replace('{n}', String(selected.size))}
          </h3>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <PhoenixSelect
              label={t('mst_col_classification', lang)}
              value={bulkClassification}
              onChange={e => setBulkClassification(e.target.value as MaterialClassification)}
              options={(['available', 'unavailable', 'scarce', 'surplus', 'suspected_missing'] as MaterialClassification[])
                .map(c => ({ value: c, label: t(MST_CLASSIFICATION_LABEL_KEY[c], lang) }))}
            />
            <PhoenixInput label={t('mst_reason_placeholder', lang)} value={bulkReason} onChange={e => setBulkReason(e.target.value)} dir="auto" />
            <PhoenixButton onClick={onApplyBulkClassification} disabled={busy}>{t('mst_apply_action', lang)}</PhoenixButton>
          </div>
          {bulkClassification === 'suspected_missing' && (
            <p style={{ fontSize: '11px', color: 'var(--t2)', marginTop: '6px' }}>{t('mst_suspected_missing_hint', lang)}</p>
          )}
        </PhoenixCard>
      )}

      {canReview && lockedState.data && (
        <PhoenixCard padding="16px" style={{ marginTop: '16px' }}>
          <h3 style={{ fontSize: '13px', fontWeight: 700, marginBottom: '6px' }}>{t('mst_amend_title', lang)}</h3>
          <p style={{ fontSize: '11.5px', color: 'var(--t2)', marginBottom: '8px' }}>
            {t('mst_amend_desc', lang)} ({formatStableDate(lockedState.data.locked_at, lang)})
          </p>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <PhoenixInput label={t('mst_reason_placeholder', lang)} value={amendReason} onChange={e => setAmendReason(e.target.value)} dir="auto" />
            <PhoenixButton variant="secondary" size="sm" onClick={onAmend} disabled={busy || !amendReason.trim()}>
              {t('mst_amend_action', lang)}
            </PhoenixButton>
          </div>
        </PhoenixCard>
      )}
    </div>
  );
}

function InstitutionStatusTab({ lang, onToast, onMobilePrint, onOpenMaterials }: {
  lang: 'ar' | 'en';
  onToast: (msg: string) => void;
  onMobilePrint: (html: string) => void;
  onOpenMaterials: () => void;
}) {
  const overview = useAsync(() => getInstitutionOverviews(), []);
  const [xlsxBusy, setXlsxBusy] = useState(false);

  if (overview.loading && !overview.data) return <PhoenixLoadingState />;
  if (overview.error) return <PhoenixErrorState message={overview.error} onRetry={overview.reload} />;
  const rows = overview.data ?? [];
  // Wrapped in the tab's own data-testid — see the corrections tab above
  // for why an empty result must still be provable as non-blank content.
  if (rows.length === 0) return <div data-testid="institution-status-tab"><PhoenixEmptyState icon="hospital" title={t('empty_orgs', lang)} /></div>;

  function exportConfig() {
    const columns: ProfessionalReportColumn<InstitutionOverview>[] = [
      { key: 'name', label: t('nav_institutions', lang), value: r => (lang === 'ar' ? r.name_ar : r.name) },
      { key: 'available', label: t('cond_available', lang), value: r => String(r.available), numeric: true, excelValue: r => r.available },
      { key: 'low', label: t('cond_low_stock', lang), value: r => String(r.low), numeric: true, excelValue: r => r.low },
      { key: 'missing', label: t('cond_missing', lang), value: r => String(r.missing), numeric: true, excelValue: r => r.missing },
    ];
    return {
      reportTitle: t('dir_tab_institutions', lang),
      generatedAt: new Date(),
      filtersSummary: t('sc_all', lang),
      columns,
      rows,
      lang,
      fileNameBase: 'medistock-institution-status',
      footerText: t('report_footer_generated_by', lang),
      labels: {
        generatedAt: t('sc_generated_at', lang),
        filtersSummary: t('sc_selected_filters', lang),
        rowCount: t('sc_total_rows', lang),
      },
    };
  }

  async function exportXlsx() {
    if (xlsxBusy) return;
    setXlsxBusy(true);
    try {
      const ok = await exportProfessionalXlsx(exportConfig());
      if (!ok) return;
    } finally {
      setXlsxBusy(false);
    }
  }

  function printReport() {
    const { ok, mobileHtml } = triggerProfessionalPrint(exportConfig());
    if (mobileHtml !== undefined) { onMobilePrint(mobileHtml); return; }
    if (!ok) onToast(t('print_popup_blocked', lang));
  }

  return (
    <div style={{ display: 'grid', gap: '12px' }} data-testid="institution-status-tab">
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <PhoenixButton variant="ghost" onClick={onOpenMaterials}>
          {t('dir_open_materials_tab', lang)}
        </PhoenixButton>
      </div>
      <PhoenixCard>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {rows.map(o => {
            const total = o.available + o.low + o.missing;
            const pct = total > 0 ? Math.round((o.available / total) * 100) : 0;
            const c = pct >= 90 ? 'var(--p)' : pct >= 75 ? 'var(--ok)' : 'var(--warn)';
            return (
              <div key={o.id} style={{ fontSize: '12.5px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '6px' }}>
                  <span style={{ fontWeight: 600 }} dir="auto">{lang === 'ar' ? o.name_ar : o.name}</span>
                  <span style={{ fontSize: '11px', color: c }}>{pct}%</span>
                </div>
                <div style={{ height: '8px', background: 'var(--brd)', borderRadius: 'var(--rpill)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${pct}%`, background: c, borderRadius: 'var(--rpill)' }} />
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: '14px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <PhoenixButton variant="ghost" size="sm" onClick={() => void exportXlsx()} loading={xlsxBusy}>
            {t('mv_export_xlsx', lang)}
          </PhoenixButton>
          <PhoenixButton variant="ghost" size="sm" onClick={printReport}>
            {t('se_print', lang)}
          </PhoenixButton>
        </div>
      </PhoenixCard>
    </div>
  );
}

export function ReportLibraryTab({ orgId, lang }: { orgId: string; lang: 'ar' | 'en' }) {
  const snapshots = useAsync(() => listReportSnapshots(orgId), [orgId]);
  const demo = useAsync(() => isDemoOrganization(orgId), [orgId]);
  const [openId, setOpenId] = useState<string | null>(null);

  if (snapshots.loading && !snapshots.data) return <PhoenixLoadingState />;
  if (snapshots.error) return <PhoenixErrorState message={snapshots.error} onRetry={snapshots.reload} />;
  const rows = snapshots.data ?? [];
  const isDemo = demo.data === true;
  // Wrapped in the tab's own data-testid — see the corrections tab above
  // for why an empty result must still be provable as non-blank content.
  if (rows.length === 0) return <div data-testid="dir-report-library"><PhoenixEmptyState icon="package" title={t('dir_library_empty', lang)} /></div>;

  return (
    <div style={{ display: 'grid', gap: '10px' }} data-testid="dir-report-library">
      {isDemo && (
        <div
          data-testid="dir-report-library-demo-watermark"
          style={{
            padding: '10px 14px', borderRadius: 'var(--r2)',
            border: '1px solid var(--warn)', background: 'color-mix(in srgb, var(--warn) 12%, transparent)',
            display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: '12.5px', fontWeight: 800, color: 'var(--warn)' }}>{t('demo_report_watermark', lang)}</span>
          <span style={{ fontSize: '11px', color: 'var(--t2)' }}>{t('demo_report_watermark_note', lang)}</span>
        </div>
      )}
      {rows.map((s: ReportSnapshotRow) => (
        <PhoenixCard key={s.id}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: '13px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span dir="ltr">{s.official_number}</span>
                {isDemo && (
                  <span style={{ fontSize: '9.5px', fontWeight: 800, color: 'var(--warn)', border: '1px solid var(--warn)', borderRadius: '4px', padding: '1px 6px' }}>
                    {t('demo_report_watermark', lang)}
                  </span>
                )}
              </div>
              <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '3px' }}>
                {t('dir_tab_' + (s.report_type === 'executive_overview' ? 'overview' : 'library'), lang)} ·{' '}
                {dashName(s.created_by_name)} · {new Date(s.created_at).toLocaleString(lang === 'ar' ? 'ar' : 'en')}
              </div>
            </div>
            <PhoenixButton variant="ghost" size="sm" onClick={() => setOpenId(openId === s.id ? null : s.id)}>
              {openId === s.id ? t('lp_close', lang) : t('lp_open', lang)}
            </PhoenixButton>
          </div>
          {openId === s.id && (
            <div style={{ marginTop: '12px', borderTop: '1px solid var(--brd)', paddingTop: '12px', display: 'grid', gap: '10px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '10px' }}>
                {[...classificationRows(s.payload, lang), ...supplySourceRows(s.payload, lang)].map(r => (
                  <div key={r.label} style={{ padding: '8px 10px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: 'var(--s2)' }}>
                    <div style={{ fontSize: '10.5px', color: 'var(--t2)' }}>{r.label}</div>
                    <div style={{ fontSize: '15px', fontWeight: 700 }}>{r.value}</div>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--t2)' }} dir="ltr">{s.qr_payload}</div>
              {s.report_type === 'executive_overview' && <SnapshotParityCheck snapshot={s} lang={lang} />}
            </div>
          )}
        </PhoenixCard>
      ))}
    </div>
  );
}

/**
 * On-demand only (never auto-run): re-fetches phoenix_executive_overview
 * for the snapshot's org RIGHT NOW and reports every classification/supply
 * bucket that has drifted since the snapshot was frozen. Drift is the
 * expected, normal outcome once stock has moved since the snapshot was
 * taken — this is an audit tool, not an assertion that the two must match.
 * The instant-of-creation equality is already proven server-side (119's own
 * test); this is the complementary "how has live data moved since" check.
 */
function SnapshotParityCheck({ snapshot, lang }: { snapshot: ReportSnapshotRow; lang: 'ar' | 'en' }) {
  const [result, setResult] = useState<SnapshotParityResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await checkSnapshotParity(snapshot));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ borderTop: '1px solid var(--brd)', paddingTop: '10px', fontSize: '11.5px' }} data-testid="dir-snapshot-parity">
      <PhoenixButton variant="ghost" size="sm" onClick={() => void run()} loading={busy}>
        {t('dir_check_parity', lang)}
      </PhoenixButton>
      {error && <div style={{ color: 'var(--err)', marginTop: '6px' }}>{error}</div>}
      {result && (
        <div style={{ marginTop: '8px' }}>
          <div style={{ color: result.matches ? 'var(--ok)' : 'var(--warn)', fontWeight: 700 }}>
            {result.matches ? t('dir_parity_matches', lang) : t('dir_parity_drifted', lang)}
          </div>
          {!result.matches && (
            <div style={{ marginTop: '6px', display: 'grid', gap: '4px' }}>
              {result.materialsTrackedSnapshot !== result.materialsTrackedLive && (
                <div>{t('dir_materials_tracked', lang)}: {result.materialsTrackedSnapshot} → {result.materialsTrackedLive}</div>
              )}
              {Object.entries(result.classificationDiffs).map(([key, d]) => (
                <div key={key}>{t('cond_' + key, lang)}: {d.snapshot} → {d.live} ({d.delta > 0 ? '+' : ''}{d.delta})</div>
              ))}
              {(['warehouse', 'outlet'] as const).flatMap(loc =>
                Object.entries(result.supplySourceDiffs[loc]).map(([key, d]) => (
                  <div key={`${loc}-${key}`}>
                    {t('dir_supply_' + key, lang)} ({loc}): {d.snapshot} → {d.live} ({d.delta > 0 ? '+' : ''}{d.delta})
                  </div>
                )),
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function dashName(v: string | null): string {
  return v && v.trim() !== '' ? v : '—';
}
