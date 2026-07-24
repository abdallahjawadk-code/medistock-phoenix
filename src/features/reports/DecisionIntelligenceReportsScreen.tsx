/**
 * DECISION-INTELLIGENCE-REPORTS-119 — Screen 21.
 *
 * First increment of the reporting center: a live Executive Overview
 * (aggregated ONLY from existing canonical sources — item_availability's
 * already-computed condition and warehouse_stock/outlet_stock's already-
 * computed supply provenance, migration 119) plus an Official Report
 * Library of immutable, server-numbered snapshots of it.
 *
 * The remaining report sections (institution status, materials/batches,
 * movements, custody chain, supplementary purchases, differences/
 * corrections, audit-sensitive actions) are NOT built here — they either
 * already exist on other screens (StatusCenterScreen, MonthlyStatusScreen,
 * ReportsScreen's AuditLogSection) or are follow-up work on top of this
 * same snapshot/numbering scaffolding. See the PR description for the full
 * gap list.
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
import {
  getExecutiveOverview, createReportSnapshot, listReportSnapshots, newRequestId,
  getSupplySourcesDetail,
  type ExecutiveOverview, type ReportSnapshotRow, type SupplySourceDetailRow,
} from './decision-intelligence.service';

type Tab = 'overview' | 'library';

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
