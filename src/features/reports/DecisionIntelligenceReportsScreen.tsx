/**
 * DECISION-INTELLIGENCE-REPORTS-119/120 — Screen 21.
 *
 * Executive Overview (119) with a 120 per-lot supply-source drill-down, an
 * Institution Status tab, a Materials & Batches tab (item_availability's
 * already-computed condition + expiry-risk.ts's already-computed tier — no
 * new classification math), a Stock Movements tab and an Audit-Sensitive
 * Actions tab (both PURE embeds of StatusCenterScreen's/ReportsScreen's
 * existing self-contained components), a Differences & Corrections tab
 * (reads the existing second-person-approval tables' full history, RLS
 * already permits it), and an Official Report Library of immutable,
 * server-numbered snapshots.
 *
 * Custody-chain lifecycle reporting and supplementary-purchase traceability
 * are NOT built in this increment — see the PR description for the current
 * gap list and why (both need a dedicated org-wide read path this pass
 * didn't reach).
 */
import { useEffect, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { formatStableDateTime } from '@/shared/lib/date';
import { getDispenseContext, type DispenseContext } from '@/features/outlet/dispense-context.service';
import { DispenseContextViewer } from '@/features/outlet/DispenseContextViewer';
import { reasonCodeLabel } from '@/shared/lib/movement-labels';
import { PhoenixDialog } from '@/shared/ui/PhoenixDialog';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixOrgScope } from '@/shared/ui/PhoenixOrgScope';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { PhoenixToast } from '@/shared/ui/PhoenixToast';
import { MobilePrintFallbackModal } from '@/shared/ui/MobilePrintFallbackModal';
import {
  exportProfessionalXlsx, exportProfessionalMultiSheetXlsx, triggerProfessionalPrint,
  type ProfessionalReportColumn,
} from '@/shared/lib/professional-export';
import { getInstitutionOverviews, type InstitutionOverview } from '@/shared/supabase/services/dashboard.service';
import { getAvailabilityByOrg } from '@/shared/supabase/services/availability.service';
import { getExpiryRiskTier, getExpiryRiskLabel } from '@/shared/lib/expiry-risk';
import { MovementReportSection } from '@/features/status/MovementReportSection';
import { AuditLogSection } from './AuditLogSection';
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
  getExecutiveOverview, createReportSnapshot, listReportSnapshots, newRequestId,
  getSupplySourcesDetail, checkSnapshotParity, isDemoOrganization,
  type ExecutiveOverview, type ReportSnapshotRow, type SupplySourceDetailRow, type SnapshotParityResult,
} from './decision-intelligence.service';

type Tab = 'overview' | 'institutions' | 'materials' | 'movements' | 'custody' | 'supplementary' | 'corrections' | 'audit' | 'monthly' | 'library';

const CLASSIFICATION_KEYS = ['available', 'low_stock', 'missing', 'surplus', 'near_expiry', 'expired'] as const;
const SUPPLY_KEYS = ['kimadia', 'aid', 'purchase_central', 'purchase_supplementary', 'unclassified'] as const;

interface BucketRow { label: string; value: number; }
interface SupplyBucketRow extends BucketRow { key: string; }

/**
 * REPORTING-CLOSURE-FINAL Phase 2: navigation consolidation.
 *
 * onNavigate lets this screen deep-link into the two operational surfaces
 * the reuse-first parity matrix (docs/phoenix/reporting-closure-final-parity-matrix.md)
 * decided to KEEP standalone rather than fold in — screen 12 (Status
 * Center, the canonical live-operations matrix) and screen 20 (Monthly
 * Inventory Position, whose prepare->approve->lock workflow must not be
 * duplicated or weakened here). Neither screen is deleted or made
 * unreachable; this screen becomes the single coherent reporting entry
 * point by linking to them instead of re-implementing their data layer.
 */
export function DecisionIntelligenceReportsScreen({ onNavigate }: { onNavigate: (screen: number) => void }) {
  const { lang, dir, activeOrgId } = useApp();
  const [tab, setTab] = useState<Tab>('overview');
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
    return <div dir={dir}>{header}<PhoenixEmptyState icon="hospital" title={t('no_org_scope', lang)} description={t('empty_hint', lang)} /></div>;
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
  ];

  return (
    <div dir={dir}>
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
            onNavigate={onNavigate}
          />
        </ReportsTabErrorBoundary>
      )}
      {tab === 'materials' && (
        <ReportsTabErrorBoundary key={`materials:${activeOrgId}`} lang={lang}>
          <MaterialsAndBatchesTab
            orgId={activeOrgId}
            lang={lang}
            onToast={showToast}
            onMobilePrint={html => openMobilePrint(html, t('dir_tab_materials', lang), 'medistock-materials-batches')}
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
          <MonthlyPositionDeepLinkTab lang={lang} onNavigate={onNavigate} />
        </ReportsTabErrorBoundary>
      )}
      {tab === 'library' && (
        <ReportsTabErrorBoundary key={`library:${activeOrgId}`} lang={lang}>
          <ReportLibraryTab orgId={activeOrgId} lang={lang} />
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

interface MaterialAvailRow {
  id: string;
  scientific_name: string | null;
  trade_name: string | null;
  quantity: number;
  condition: string | null;
  batch_number: string | null;
  expiry_date: string | null;
  supply_type: string | null;
  distribution_points: { id: string; name: string; name_ar: string } | null;
}

/**
 * Materials & Batches — closes BOTH "materials_and_statuses" and
 * "batches_expiry_and_FEFO" from the SAME data source (item_availability
 * already carries condition, batch_number and expiry_date together — a
 * second query would just be a filtered view of the first). Reuses
 * getAvailabilityByOrg (StatusCenterScreen's own source) for the
 * already-computed condition and expiry-risk.ts's already-computed tier —
 * no classification math lives in this screen.
 */
function MaterialsAndBatchesTab({ orgId, lang, onToast, onMobilePrint }: {
  orgId: string; lang: 'ar' | 'en';
  onToast: (msg: string) => void;
  onMobilePrint: (html: string) => void;
}) {
  const records = useAsync(() => getAvailabilityByOrg(orgId), [orgId]);
  const [search, setSearch] = useState('');
  const [xlsxBusy, setXlsxBusy] = useState(false);

  if (records.loading && !records.data) return <PhoenixLoadingState />;
  if (records.error) return <PhoenixErrorState message={records.error} onRetry={records.reload} />;
  const all = (records.data ?? []) as unknown as MaterialAvailRow[];
  const rows = search.trim()
    ? all.filter(r => (r.scientific_name ?? '').toLowerCase().includes(search.trim().toLowerCase())
      || (r.trade_name ?? '').toLowerCase().includes(search.trim().toLowerCase())
      || (r.batch_number ?? '').toLowerCase().includes(search.trim().toLowerCase()))
    : all;

  function exportConfig() {
    const columns: ProfessionalReportColumn<MaterialAvailRow>[] = [
      { key: 'sci', label: t('avail_scientific_name', lang), value: r => r.scientific_name ?? '—' },
      { key: 'trade', label: t('inv_trade_name', lang), value: r => r.trade_name ?? '—' },
      { key: 'point', label: t('dir_col_location', lang), value: r => (r.distribution_points ? (lang === 'ar' ? r.distribution_points.name_ar : r.distribution_points.name) : '—') },
      { key: 'qty', label: t('qty', lang), value: r => String(r.quantity ?? 0), numeric: true, excelValue: r => r.quantity ?? 0 },
      { key: 'status', label: t('avail_material_status', lang), value: r => (r.condition ? t('cond_' + r.condition, lang) : '—') },
      { key: 'batch', label: t('batch_no', lang), value: r => r.batch_number ?? '—', ltr: true },
      { key: 'expiry', label: t('expiry', lang), value: r => r.expiry_date ?? '—', ltr: true, dateColumn: 'date', excelValue: r => r.expiry_date },
      { key: 'expiryRisk', label: t('expiry_risk_column', lang), value: r => getExpiryRiskLabel(getExpiryRiskTier(r.expiry_date), lang) },
      { key: 'supply', label: t('avail_supply_type', lang), value: r => r.supply_type ?? '—' },
    ];
    return {
      reportTitle: t('dir_tab_materials', lang),
      generatedAt: new Date(),
      filtersSummary: search.trim() ? `${t('search', lang)}: ${search.trim()}` : t('sc_all', lang),
      columns,
      rows,
      lang,
      fileNameBase: 'medistock-materials-batches',
      emptyMessage: t('se_no_records', lang),
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
    <div style={{ display: 'grid', gap: '10px' }} data-testid="materials-batches-tab">
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="search"
          placeholder={t('search', lang)}
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ padding: '8px 10px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', fontSize: '12.5px', minWidth: '200px' }}
        />
        <PhoenixButton variant="ghost" size="sm" onClick={() => void exportXlsx()} loading={xlsxBusy}>
          {t('mv_export_xlsx', lang)}
        </PhoenixButton>
        <PhoenixButton variant="ghost" size="sm" onClick={printReport}>
          {t('se_print', lang)}
        </PhoenixButton>
      </div>
      {rows.length === 0 ? (
        <PhoenixEmptyState icon="package" title={t('se_no_records', lang)} />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11.5px' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'start', padding: '6px 8px' }}>{t('avail_scientific_name', lang)}</th>
                <th style={{ textAlign: 'start', padding: '6px 8px' }}>{t('dir_col_location', lang)}</th>
                <th style={{ textAlign: 'end', padding: '6px 8px' }}>{t('qty', lang)}</th>
                <th style={{ textAlign: 'start', padding: '6px 8px' }}>{t('avail_material_status', lang)}</th>
                <th style={{ textAlign: 'start', padding: '6px 8px' }}>{t('batch_no', lang)}</th>
                <th style={{ textAlign: 'start', padding: '6px 8px' }}>{t('expiry', lang)}</th>
                <th style={{ textAlign: 'start', padding: '6px 8px' }}>{t('expiry_risk_column', lang)}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} style={{ borderTop: '1px solid var(--brd)' }}>
                  <td style={{ padding: '6px 8px' }} dir="auto">{r.scientific_name}{r.trade_name ? ` (${r.trade_name})` : ''}</td>
                  <td style={{ padding: '6px 8px' }} dir="auto">{r.distribution_points ? (lang === 'ar' ? r.distribution_points.name_ar : r.distribution_points.name) : '—'}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'end' }}>{r.quantity}</td>
                  <td style={{ padding: '6px 8px' }}>{r.condition ? t('cond_' + r.condition, lang) : '—'}</td>
                  <td style={{ padding: '6px 8px' }} dir="ltr">{r.batch_number ?? '—'}</td>
                  <td style={{ padding: '6px 8px' }} dir="ltr">{r.expiry_date ?? '—'}</td>
                  <td style={{ padding: '6px 8px' }}>{getExpiryRiskLabel(getExpiryRiskTier(r.expiry_date), lang)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
  if (rows.length === 0) return <PhoenixEmptyState icon="package" title={t('dir_library_empty', lang)} />;

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
      { key: 'linkedMovement', label: t('dir_col_linked_movement', lang), value: r => r.appliedMovementId ?? '—', ltr: true },
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
                <td style={{ padding: '6px 8px' }} dir="ltr" title={r.appliedMovementId ?? undefined}>
                  {r.appliedMovementId ? r.appliedMovementId.slice(0, 8) : '—'}
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
          { key: 'correlation', label: t('dir_col_correlation', lang), value: (r: CustodyTraceEventRow) => r.correlationId ?? '—', ltr: true },
          { key: 'causation', label: t('dir_col_causation', lang), value: (r: CustodyTraceEventRow) => r.causationId ?? '—', ltr: true },
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
                  {ev.correlation_id && (
                    <span dir="ltr" title={ev.correlation_id}>
                      {t('dir_col_correlation', lang)}: {ev.correlation_id.slice(0, 8)}
                    </span>
                  )}
                  {ev.causation_id && (
                    <span dir="ltr" title={ev.causation_id}>
                      {t('dir_col_causation', lang)}: {ev.causation_id.slice(0, 8)}
                    </span>
                  )}
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
  if (rows.length === 0) return <PhoenixEmptyState icon="package" title={t('lp_history_none', lang)} />;

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

/**
 * REPORTING-CLOSURE-FINAL Phase 2: deep-link only, never a second
 * implementation of screen 20's prepare->review->approve->lock workflow.
 * Monthly Inventory Position keeps its own official numbering, immutable
 * locked snapshots and controlled-correction path entirely in
 * MonthlyStatusScreen/monthly-status.service.ts — untouched by this tab.
 */
function MonthlyPositionDeepLinkTab({ lang, onNavigate }: {
  lang: 'ar' | 'en';
  onNavigate: (screen: number) => void;
}) {
  return (
    <PhoenixCard padding="20px">
      <div style={{ fontSize: '15px', fontWeight: 800, marginBottom: '8px' }}>{t('dir_tab_monthly', lang)}</div>
      <p style={{ fontSize: '12.5px', color: 'var(--t2)', marginBottom: '16px', maxWidth: '560px' }}>
        {t('dir_monthly_deeplink_desc', lang)}
      </p>
      <PhoenixButton onClick={() => onNavigate(20)}>
        {t('dir_monthly_deeplink_cta', lang)}
      </PhoenixButton>
    </PhoenixCard>
  );
}

function InstitutionStatusTab({ lang, onToast, onMobilePrint, onNavigate }: {
  lang: 'ar' | 'en';
  onToast: (msg: string) => void;
  onMobilePrint: (html: string) => void;
  onNavigate: (screen: number) => void;
}) {
  const overview = useAsync(() => getInstitutionOverviews(), []);
  const [xlsxBusy, setXlsxBusy] = useState(false);

  if (overview.loading && !overview.data) return <PhoenixLoadingState />;
  if (overview.error) return <PhoenixErrorState message={overview.error} onRetry={overview.reload} />;
  const rows = overview.data ?? [];
  if (rows.length === 0) return <PhoenixEmptyState icon="hospital" title={t('empty_orgs', lang)} />;

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
        <PhoenixButton variant="ghost" onClick={() => onNavigate(12)}>
          {t('dir_open_in_status_center', lang)}
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
  if (rows.length === 0) return <PhoenixEmptyState icon="package" title={t('dir_library_empty', lang)} />;

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
