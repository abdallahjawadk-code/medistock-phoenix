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
import { useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixOrgScope } from '@/shared/ui/PhoenixOrgScope';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { PhoenixToast } from '@/shared/ui/PhoenixToast';
import { MobilePrintFallbackModal } from '@/shared/ui/MobilePrintFallbackModal';
import {
  exportProfessionalXlsx, triggerProfessionalPrint,
  type ProfessionalReportColumn,
} from '@/shared/lib/professional-export';
import { getInstitutionOverviews, type InstitutionOverview } from '@/shared/supabase/services/dashboard.service';
import { getAvailabilityByOrg } from '@/shared/supabase/services/availability.service';
import { getExpiryRiskTier, getExpiryRiskLabel } from '@/shared/lib/expiry-risk';
import { MovementReportSection } from '@/features/status/MovementReportSection';
import { AuditLogSection } from './AuditLogSection';
import { listCorrectionHistory, type CorrectionHistoryRow } from './differences-corrections.service';
import {
  listCustodyDispatches, listCustodyReturnRequests, listCustodyReturnShipments,
  getMovementTimeline, type MovementTimelineResult,
} from './custody-chain.service';
import { listSupplementaryPurchaseOrders } from './supplementary-purchases.service';
import { getSuppliers, getReceipts, getReceiptLines, type OrderRow, type ReceiptLineRow } from '@/features/procurement/procurement.service';
import { StatusBadge } from '@/features/procurement/OrderComposerPanel';
import {
  getExecutiveOverview, createReportSnapshot, listReportSnapshots, newRequestId,
  getSupplySourcesDetail,
  type ExecutiveOverview, type ReportSnapshotRow, type SupplySourceDetailRow,
} from './decision-intelligence.service';

type Tab = 'overview' | 'institutions' | 'materials' | 'movements' | 'custody' | 'supplementary' | 'corrections' | 'audit' | 'library';

const CLASSIFICATION_KEYS = ['available', 'low_stock', 'missing', 'surplus', 'near_expiry', 'expired'] as const;
const SUPPLY_KEYS = ['kimadia', 'aid', 'purchase_central', 'purchase_supplementary', 'unclassified'] as const;

interface BucketRow { label: string; value: number; }
interface SupplyBucketRow extends BucketRow { key: string; }

export function DecisionIntelligenceReportsScreen() {
  const { lang, dir, activeOrgId } = useApp();
  const [tab, setTab] = useState<Tab>('overview');
  const [toast, setToast] = useState<string | null>(null);
  const [mobilePrintHtml, setMobilePrintHtml] = useState<string | null>(null);

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3000); };

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
        <ExecutiveOverviewTab
          key={activeOrgId}
          orgId={activeOrgId}
          lang={lang}
          onToast={showToast}
          onMobilePrint={setMobilePrintHtml}
        />
      )}
      {tab === 'institutions' && (
        <InstitutionStatusTab key={activeOrgId} lang={lang} />
      )}
      {tab === 'materials' && (
        <MaterialsAndBatchesTab key={activeOrgId} orgId={activeOrgId} lang={lang} />
      )}
      {tab === 'movements' && (
        <div data-testid="movements-tab"><MovementReportSection /></div>
      )}
      {tab === 'custody' && (
        <CustodyChainTab key={activeOrgId} lang={lang} />
      )}
      {tab === 'supplementary' && (
        <SupplementaryPurchasesTab key={activeOrgId} orgId={activeOrgId} lang={lang} />
      )}
      {tab === 'corrections' && (
        <CorrectionsHistoryTab key={activeOrgId} lang={lang} />
      )}
      {tab === 'audit' && (
        <div data-testid="audit-tab"><AuditLogSection /></div>
      )}
      {tab === 'library' && (
        <ReportLibraryTab key={activeOrgId} orgId={activeOrgId} lang={lang} />
      )}

      {toast && <PhoenixToast message={toast} />}
      {mobilePrintHtml !== null && (
        <MobilePrintFallbackModal
          open
          html={mobilePrintHtml}
          title={t('dir_tab_overview', lang)}
          fileNameBase="medistock-executive-overview"
          lang={lang}
          onClose={() => setMobilePrintHtml(null)}
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
  const [lastSnapshot, setLastSnapshot] = useState<{ officialNumber: string; qr: string } | null>(null);
  const [requestId, setRequestId] = useState(() => newRequestId());

  if (overview.loading && !overview.data) return <PhoenixLoadingState />;
  if (overview.error) return <PhoenixErrorState message={overview.error} onRetry={overview.reload} />;
  const data = overview.data;
  if (!data) return null;

  const classRows = classificationRows(data, lang);
  const supplyRows = supplySourceRows(data, lang);
  const rows: BucketRow[] = [...classRows, ...supplyRows];

  function exportConfig() {
    const columns: ProfessionalReportColumn<BucketRow>[] = [
      { key: 'label', label: t('dir_col_indicator', lang), value: r => r.label },
      { key: 'value', label: t('dir_col_value', lang), value: r => String(r.value), numeric: true, excelValue: r => r.value },
    ];
    return {
      reportTitle: t('dir_tab_overview', lang),
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
function MaterialsAndBatchesTab({ orgId, lang }: { orgId: string; lang: 'ar' | 'en' }) {
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
function CorrectionsHistoryTab({ lang }: { lang: 'ar' | 'en' }) {
  const history = useAsync(() => listCorrectionHistory(), []);
  const [xlsxBusy, setXlsxBusy] = useState(false);

  if (history.loading && !history.data) return <PhoenixLoadingState />;
  if (history.error) return <PhoenixErrorState message={history.error} onRetry={history.reload} />;
  const rows = history.data ?? [];
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
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <PhoenixButton variant="ghost" size="sm" onClick={() => void exportXlsx()} loading={xlsxBusy}>
          {t('mv_export_xlsx', lang)}
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
function CustodyChainTab({ lang }: { lang: 'ar' | 'en' }) {
  const dispatches = useAsync(() => listCustodyDispatches(), []);
  const returnRequests = useAsync(() => listCustodyReturnRequests(), []);
  const returnShipments = useAsync(() => listCustodyReturnShipments(), []);
  const [traceOpenFor, setTraceOpenFor] = useState<string | null>(null);
  const [traceCache, setTraceCache] = useState<Record<string, MovementTimelineResult>>({});
  const [traceError, setTraceError] = useState<string | null>(null);
  const [xlsxBusy, setXlsxBusy] = useState(false);

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

  if (dispatches.loading && !dispatches.data) return <PhoenixLoadingState />;
  if (dispatches.error) return <PhoenixErrorState message={dispatches.error} onRetry={dispatches.reload} />;

  const dispatchRows = dispatches.data ?? [];
  const requestRows = returnRequests.data ?? [];
  const shipmentRows = returnShipments.data ?? [];

  function exportConfig() {
    interface CombinedRow { kind: string; number: string; status: string; date: string | null; }
    const combined: CombinedRow[] = [
      ...dispatchRows.map((d): CombinedRow => ({ kind: t('dir_custody_dispatch', lang), number: d.dispatchNumber, status: d.status, date: d.sentAt ?? d.createdAt })),
      ...requestRows.map((r): CombinedRow => ({ kind: t('dir_custody_return_request', lang), number: r.returnNumber, status: r.status, date: r.createdAt })),
      ...shipmentRows.map((s): CombinedRow => ({ kind: t('dir_custody_return_shipment', lang), number: s.shipmentNumber, status: s.status, date: null })),
    ];
    const columns: ProfessionalReportColumn<CombinedRow>[] = [
      { key: 'kind', label: t('dir_col_document_type', lang), value: r => r.kind },
      { key: 'number', label: t('dir_col_document_number', lang), value: r => r.number, ltr: true },
      { key: 'status', label: t('dir_col_status', lang), value: r => r.status.replace(/_/g, ' ') },
      { key: 'date', label: t('dir_as_of', lang), value: r => r.date ?? '—', ltr: true },
    ];
    return {
      reportTitle: t('dir_tab_custody', lang),
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

  async function exportXlsx() {
    if (xlsxBusy) return;
    setXlsxBusy(true);
    try { await exportProfessionalXlsx(exportConfig()); } finally { setXlsxBusy(false); }
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
              <div key={ev.event_id} style={{ borderTop: '1px solid var(--brd)', padding: '4px 0' }}>
                <strong>{ev.event_type}</strong>{ev.status ? ` → ${ev.status}` : ''}
                {' · '}{new Date(ev.occurred_at).toLocaleString(lang === 'ar' ? 'ar' : 'en')}
                {ev.actor_name ? ` · ${ev.actor_name}` : ''}
                {ev.material ? ` · ${ev.material}` : ''}
              </div>
            ))}
        </>
      )}
    </div>
  );

  return (
    <div style={{ display: 'grid', gap: '14px' }} data-testid="custody-chain-tab">
      <div>
        <PhoenixButton variant="ghost" size="sm" onClick={() => void exportXlsx()} loading={xlsxBusy}>
          {t('mv_export_xlsx', lang)}
        </PhoenixButton>
      </div>

      <PhoenixCard>
        <div style={{ fontSize: '12px', fontWeight: 700, marginBottom: '8px' }}>{t('dir_custody_dispatch', lang)}</div>
        {dispatchRows.length === 0 ? <PhoenixEmptyState icon="package" title={t('dir_library_empty', lang)} /> : (
          <div style={{ display: 'grid', gap: '6px' }}>
            {dispatchRows.map(d => (
              <div key={d.id} style={{ fontSize: '11.5px' }}>
                <button type="button" onClick={() => void toggleTrace(d.id)} style={{ width: '100%', display: 'flex', justifyContent: 'space-between', padding: '6px 8px', border: '1px solid var(--brd)', borderRadius: 'var(--r2)', background: 'var(--s)', cursor: 'pointer', color: 'var(--t)' }}>
                  <span dir="ltr">{d.dispatchNumber}</span>
                  <span>{d.status.replace(/_/g, ' ')}</span>
                </button>
                {traceBlock(d.id)}
              </div>
            ))}
          </div>
        )}
      </PhoenixCard>

      <PhoenixCard>
        <div style={{ fontSize: '12px', fontWeight: 700, marginBottom: '8px' }}>{t('dir_custody_return_request', lang)}</div>
        {requestRows.length === 0 ? <PhoenixEmptyState icon="package" title={t('dir_library_empty', lang)} /> : (
          <div style={{ display: 'grid', gap: '6px' }}>
            {requestRows.map(r => (
              <div key={r.id} style={{ fontSize: '11.5px' }}>
                <button type="button" onClick={() => void toggleTrace(r.id)} style={{ width: '100%', display: 'flex', justifyContent: 'space-between', padding: '6px 8px', border: '1px solid var(--brd)', borderRadius: 'var(--r2)', background: 'var(--s)', cursor: 'pointer', color: 'var(--t)' }}>
                  <span dir="ltr">{r.returnNumber}</span>
                  <span>{r.status.replace(/_/g, ' ')}</span>
                </button>
                {traceBlock(r.id)}
              </div>
            ))}
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
 */
function SupplementaryPurchasesTab({ orgId, lang }: { orgId: string; lang: 'ar' | 'en' }) {
  const orders = useAsync(() => listSupplementaryPurchaseOrders(orgId), [orgId]);
  const suppliers = useAsync(() => getSuppliers(orgId), [orgId]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [xlsxBusy, setXlsxBusy] = useState(false);

  if (orders.loading && !orders.data) return <PhoenixLoadingState />;
  if (orders.error) return <PhoenixErrorState message={orders.error} onRetry={orders.reload} />;
  const rows = orders.data ?? [];
  if (rows.length === 0) return <PhoenixEmptyState icon="package" title={t('lp_history_none', lang)} />;

  function exportConfig() {
    const columns: ProfessionalReportColumn<OrderRow>[] = [
      { key: 'number', label: t('dir_col_document_number', lang), value: r => r.orderNumber, ltr: true },
      { key: 'status', label: t('dir_col_status', lang), value: r => r.status.replace(/_/g, ' ') },
      { key: 'invoice', label: t('sp_invoice_ref', lang), value: r => r.invoiceNumber ?? '—', ltr: true },
      { key: 'date', label: t('dir_as_of', lang), value: r => r.createdAt, ltr: true, dateColumn: 'datetime', excelValue: r => r.createdAt },
    ];
    return {
      reportTitle: t('dir_tab_supplementary', lang),
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

  async function exportXlsx() {
    if (xlsxBusy) return;
    setXlsxBusy(true);
    try { await exportProfessionalXlsx(exportConfig()); } finally { setXlsxBusy(false); }
  }

  return (
    <div style={{ display: 'grid', gap: '10px' }} data-testid="supplementary-purchases-tab">
      <div>
        <PhoenixButton variant="ghost" size="sm" onClick={() => void exportXlsx()} loading={xlsxBusy}>
          {t('mv_export_xlsx', lang)}
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

function InstitutionStatusTab({ lang }: { lang: 'ar' | 'en' }) {
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

  return (
    <div style={{ display: 'grid', gap: '12px' }} data-testid="institution-status-tab">
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
        <div style={{ marginTop: '14px' }}>
          <PhoenixButton variant="ghost" size="sm" onClick={() => void exportXlsx()} loading={xlsxBusy}>
            {t('mv_export_xlsx', lang)}
          </PhoenixButton>
        </div>
      </PhoenixCard>
    </div>
  );
}

function ReportLibraryTab({ orgId, lang }: { orgId: string; lang: 'ar' | 'en' }) {
  const snapshots = useAsync(() => listReportSnapshots(orgId), [orgId]);
  const [openId, setOpenId] = useState<string | null>(null);

  if (snapshots.loading && !snapshots.data) return <PhoenixLoadingState />;
  if (snapshots.error) return <PhoenixErrorState message={snapshots.error} onRetry={snapshots.reload} />;
  const rows = snapshots.data ?? [];
  if (rows.length === 0) return <PhoenixEmptyState icon="package" title={t('dir_library_empty', lang)} />;

  return (
    <div style={{ display: 'grid', gap: '10px' }} data-testid="dir-report-library">
      {rows.map((s: ReportSnapshotRow) => (
        <PhoenixCard key={s.id}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: '13px', fontWeight: 700 }} dir="ltr">{s.official_number}</div>
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
            </div>
          )}
        </PhoenixCard>
      ))}
    </div>
  );
}

function dashName(v: string | null): string {
  return v && v.trim() !== '' ? v : '—';
}
