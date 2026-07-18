import { useState, useMemo } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { formatStableDate } from '@/shared/lib/date';
import { getExpiryRiskTier, getExpiryRiskLabel } from '@/shared/lib/expiry-risk';
import {
  exportProfessionalXlsx,
  triggerProfessionalPrint,
  type ProfessionalReportColumn,
} from '@/shared/lib/professional-export';
import { getAvailabilityByOrg } from '@/shared/supabase/services/availability.service';
import { getPointsByOrg } from '@/shared/supabase/services/warehouses.service';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixOrgScope } from '@/shared/ui/PhoenixOrgScope';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixScreenHeader } from '@/shared/ui/PhoenixScreenHeader';
import { PhoenixToast } from '@/shared/ui/PhoenixToast';
import { ExpiryRiskBadge } from '@/shared/ui/ExpiryRiskBadge';
import { MobilePrintFallbackModal } from '@/shared/ui/MobilePrintFallbackModal';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';

interface PointRow { id: string; name: string; name_ar: string; }

interface OrgAvailRow {
  id: string;
  scientific_name: string | null;
  trade_name: string | null;
  dosage_form: string | null;
  concentration: string | null;
  price: number | null;
  quantity: number;
  condition: string | null;
  batch_number: string | null;
  expiry_date: string | null;
  notes: string | null;
  supply_type: string | null;
  updated_at: string;
  distribution_points: { id: string; name: string; name_ar: string } | null;
}

const CONDITION_OPTIONS = [
  'available', 'low_stock', 'missing', 'surplus', 'near_expiry', 'expired',
] as const;

export function StatusEditorScreen() {
  const { lang, activeOrgId } = useApp();

  const records = useAsync(() => activeOrgId ? getAvailabilityByOrg(activeOrgId) : Promise.resolve([]), [activeOrgId]);
  const pointsAsync = useAsync<PointRow[]>(() => activeOrgId ? getPointsByOrg(activeOrgId) : Promise.resolve([]), [activeOrgId]);

  const [filterPort, setFilterPort] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [search, setSearch] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  // BUGFIX-MOBILE-PRINT-DOES-NOT-EXIT-APP-A: on mobile, printReport() routes
  // here instead of calling openPrintWindow (window.open/window.print) directly.
  const [mobilePrintHtml, setMobilePrintHtml] = useState<string | null>(null);
  // EXPORT-PROFESSIONAL-XLSX-PDF-B: workbook generation is async (ExcelJS
  // writeBuffer); guard against double-clicks while a download is in flight.
  const [xlsxBusy, setXlsxBusy] = useState(false);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  const filtered = useMemo(() => {
    let list = (records.data ?? []) as unknown as OrgAvailRow[];
    if (filterPort) list = list.filter(r => r.distribution_points?.id === filterPort);
    if (filterStatus) list = list.filter(r => r.condition === filterStatus);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(r =>
        (r.scientific_name ?? '').toLowerCase().includes(q) ||
        (r.trade_name ?? '').toLowerCase().includes(q) ||
        (r.batch_number ?? '').toLowerCase().includes(q)
      );
    }
    return list;
  }, [records.data, filterPort, filterStatus, search]);

  function dpName(rec: OrgAvailRow): string {
    const dp = rec.distribution_points;
    if (!dp) return '—';
    return lang === 'ar' ? (dp.name_ar || dp.name) : dp.name;
  }

  // Shared column definitions for table / CSV / print — single source of truth.
  const columns: ProfessionalReportColumn<OrgAvailRow>[] = [
    { key: 'port',   label: t('se_filter_port', lang),        value: dpName },
    { key: 'sci',    label: t('avail_scientific_name', lang), value: r => r.scientific_name ?? '—' },
    { key: 'trade',  label: t('avail_trade_name', lang),      value: r => r.trade_name ?? '—' },
    { key: 'dosage', label: t('avail_dosage_form', lang),     value: r => r.dosage_form ?? '—' },
    { key: 'conc',   label: t('avail_concentration', lang),   value: r => r.concentration ?? '—' },
    { key: 'qty',    label: t('qty', lang),                   value: r => String(r.quantity ?? 0), numeric: true, excelValue: r => r.quantity ?? 0 },
    { key: 'status', label: t('avail_material_status', lang), value: r => r.condition ? t('cond_' + r.condition, lang) : '—' },
    { key: 'batch',  label: t('batch_no', lang),               value: r => r.batch_number ?? '—', ltr: true },
    { key: 'expiry', label: t('expiry', lang),                 value: r => formatStableDate(r.expiry_date, lang), ltr: true, dateColumn: 'date', excelValue: r => r.expiry_date },
    // EXPIRY-RISK-TIERS-A: derived, read-only label from the shared expiry-risk
    // helper — UI/report classification only, never written back, never a new alert.
    { key: 'expiryRisk', label: t('expiry_risk_column', lang),  value: r => getExpiryRiskLabel(getExpiryRiskTier(r.expiry_date), lang) },
    { key: 'supply', label: t('avail_supply_type', lang),      value: r => r.supply_type ?? '—' },
    { key: 'price',  label: t('avail_price', lang),            value: r => r.price != null ? String(r.price) : '—', ltr: true, numeric: true, excelValue: r => r.price ?? undefined },
  ];

  const selectedFiltersText = useMemo(() => {
    const parts: string[] = [];
    if (filterPort) {
      const p = (pointsAsync.data ?? []).find(x => x.id === filterPort);
      if (p) parts.push(`${t('se_filter_port', lang)}: ${lang === 'ar' ? p.name_ar : p.name}`);
    }
    if (filterStatus) parts.push(`${t('avail_material_status', lang)}: ${t('cond_' + filterStatus, lang)}`);
    if (search.trim()) parts.push(`${t('search', lang)}: ${search.trim()}`);
    return parts.length ? parts.join(' · ') : t('sc_all', lang);
  }, [filterPort, filterStatus, search, pointsAsync.data, lang]);

  // Single source of truth for both CSV and print/PDF exports (EXPORT-PROFESSIONAL-XLSX-PDF-A).
  function exportConfig() {
    return {
      reportTitle: t('nav_status_editor', lang),
      generatedAt: new Date(),
      filtersSummary: selectedFiltersText,
      columns,
      rows: filtered,
      lang,
      fileNameBase: 'medistock-status-editor',
      emptyMessage: t('se_no_records', lang),
      footerText: t('report_footer_generated_by', lang),
      rowAccent: (r: OrgAvailRow) => (r.condition === 'missing' || r.condition === 'expired' ? 'err' as const
        : r.condition === 'low_stock' || r.condition === 'near_expiry' ? 'warn' as const
        : r.condition === 'available' || r.condition === 'surplus' ? 'ok' as const
        : undefined),
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
      if (!ok) showToast(t('csv_export_failed', lang));
    } finally {
      setXlsxBusy(false);
    }
  }

  function printReport() {
    // BUGFIX-MOBILE-PRINT-DOES-NOT-EXIT-APP-A: mobile/PWA/webview contexts
    // route to the in-app fallback modal instead of openPrintWindow — that
    // can switch to a native print UI or open an external tab, making the
    // app appear to exit. Desktop keeps the original popup flow.
    const { ok, mobileHtml } = triggerProfessionalPrint(exportConfig());
    if (mobileHtml !== undefined) {
      setMobilePrintHtml(mobileHtml);
      return;
    }
    if (!ok) showToast(t('print_popup_blocked', lang));
  }

  const fieldStyle = { padding: '8px 10px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', fontSize: '13px' } as const;

  const actionBtnStyle = {
    padding: '9px 14px', minHeight: '38px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)',
    background: 'var(--s)', color: 'var(--t)', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
  } as const;

  const thStyle = { padding: '8px 10px', textAlign: 'start' as const, fontSize: '11px', fontWeight: 700, color: 'var(--t2)', borderBottom: '2px solid var(--brd)', whiteSpace: 'nowrap' as const };
  const tdStyle = { padding: '8px 10px', fontSize: '12.5px', borderBottom: '1px solid var(--brd)', verticalAlign: 'top' as const };

  return (
    <div className="premium-page nexus-status-editor-page" style={{ maxWidth: '1200px', animation: 'fs .3s ease' }}>
      <PhoenixScreenHeader
        icon="table"
        eyebrow={lang === 'ar' ? 'PHOENIX STATUS · سجل تشغيلي' : 'PHOENIX STATUS · OPERATIONS LEDGER'}
        title={t('nav_status_editor', lang)}
        description={t('se_sub', lang)}
        actions={<PhoenixOrgScope />}
      />

      {!activeOrgId && <PhoenixEmptyState icon="reports" title={t('no_org_scope', lang)} description={t('empty_hint', lang)} />}

      {activeOrgId && (
        <>
          {/* Filter bar */}
          <PhoenixCard padding="14px" style={{ marginBottom: '16px' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
              <select value={filterPort} onChange={e => setFilterPort(e.target.value)} style={{ ...fieldStyle, minWidth: '160px', appearance: 'none', cursor: 'pointer' }}>
                <option value="">{t('se_all_ports', lang)}</option>
                {(pointsAsync.data ?? []).map(p => <option key={p.id} value={p.id}>{lang === 'ar' ? p.name_ar : p.name}</option>)}
              </select>

              <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={{ ...fieldStyle, minWidth: '140px', appearance: 'none', cursor: 'pointer' }}>
                <option value="">{t('se_all_statuses', lang)}</option>
                {CONDITION_OPTIONS.map(c => <option key={c} value={c}>{t('cond_' + c, lang)}</option>)}
              </select>

              <input type="text" dir="auto" value={search} onChange={e => setSearch(e.target.value)} placeholder={t('search', lang)} style={{ ...fieldStyle, flex: 1, minWidth: '140px' }} />

              {/* Mobile-friendly, wrapping action bar — export/print stay reachable
                  above the (potentially horizontally scrollable) table below. */}
              <div className="premium-action-bar" style={{ display: 'flex', gap: '6px', marginInlineStart: 'auto', flexWrap: 'wrap' }}>
                <button onClick={exportXlsx} disabled={filtered.length === 0 || xlsxBusy} aria-label={t('se_export_excel', lang)} style={actionBtnStyle}>
                  <PhoenixIcon name="download" size={14} /> {t('se_export_excel', lang)}
                </button>
                <button onClick={printReport} disabled={filtered.length === 0} aria-label={t('se_export_pdf', lang)} style={actionBtnStyle}>
                  <PhoenixIcon name="file" size={14} /> {t('se_export_pdf', lang)}
                </button>
                <button onClick={printReport} disabled={filtered.length === 0} aria-label={t('se_print', lang)} style={actionBtnStyle}>
                  <PhoenixIcon name="reports" size={14} /> {t('se_print', lang)}
                </button>
              </div>
            </div>
          </PhoenixCard>

          {/* Data table */}
          {records.loading ? (
            <p style={{ textAlign: 'center', color: 'var(--t2)', padding: '40px 0' }}>{t('loading', lang)}</p>
          ) : filtered.length === 0 ? (
            <PhoenixEmptyState icon="reports" title={t('se_no_records', lang)} description={t('empty_hint', lang)} />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', background: 'var(--s)', borderRadius: 'var(--r2)' }}>
                <thead>
                  <tr>
                    {columns.map(c => <th key={c.key} style={thStyle}>{c.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r: OrgAvailRow) => (
                    <tr key={r.id}>
                      {columns.map(c => (
                        <td key={c.key} style={tdStyle} dir={c.ltr ? 'ltr' : 'auto'}>
                          {c.key === 'expiry' ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' }}>
                              <span>{c.value(r)}</span>
                              <ExpiryRiskBadge expiryDate={r.expiry_date} lang={lang} />
                            </div>
                          ) : c.value(r)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {toast && <PhoenixToast message={toast} />}
      <MobilePrintFallbackModal
        open={mobilePrintHtml !== null}
        html={mobilePrintHtml ?? ''}
        title={t('nav_status_editor', lang)}
        fileNameBase="medistock-status-editor"
        lang={lang}
        onClose={() => setMobilePrintHtml(null)}
      />
    </div>
  );
}
