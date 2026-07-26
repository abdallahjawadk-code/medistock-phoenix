import { useEffect, useMemo, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import { useAsync } from '@/shared/lib/useAsync';
import { formatStableDateTime } from '@/shared/lib/date';
import { isLikelyMobilePrintContext } from '@/shared/lib/reportExport';
import { getPointsByOrg, getWarehouses } from '@/shared/supabase/services/warehouses.service';
import {
  getMovementLedgerReport,
  type MovementLedgerReportRow,
  type MovementLedgerSource,
} from '@/features/reports/movement-ledger-report.service';
import { getDispenseContext, type DispenseContext } from '@/features/outlet/dispense-context.service';
import {
  MOVEMENT_TYPE_LABEL_KEY, reasonCodeLabel, movementTypeLabel, ledgerSourceLabel,
} from '@/shared/lib/movement-labels';
import { DispenseContextViewer } from '@/features/outlet/DispenseContextViewer';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixDialog } from '@/shared/ui/PhoenixDialog';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { PhoenixToast } from '@/shared/ui/PhoenixToast';
import { MobilePrintFallbackModal } from '@/shared/ui/MobilePrintFallbackModal';

/**
 * MOVEMENT-LEDGER-REPORT-138
 *
 * Read-only, filterable "Quantity Movement Report" section for Status Center
 * (and embedded verbatim by the Decision Intelligence Reporting Center's
 * Stock Movements tab — this is the ONE shared implementation, not a
 * duplicate). Loads via getMovementLedgerReport(), which calls the canonical
 * phoenix_movement_ledger_report RPC over the three live Unified Movements
 * ledgers. This component NEVER writes: no insert/update/delete anywhere in
 * this file. Visibility of the whole section and of the Export CSV / Print
 * actions is UX-only — the RPC independently re-enforces org scope +
 * status_center.view on every read regardless of what is shown here.
 *
 * Supersedes the legacy getAvailabilityMovementsReport() path
 * (item_availability_movements, migration 033) — that table's sole writer
 * has zero production call sites (see
 * src/features/inventory/__tests__/legacy-availability-writer-audit.test.ts),
 * so nothing regresses by moving off it.
 */

// BUGFIX-REPORTS-DATES-PORT-CLEAR-A: columns whose values are digit/slash
// text (dates, quantities) — must render dir="ltr" in RTL layout (on-screen
// AND in the generated print HTML) or the bidi algorithm can visually
// reorder the separated groups.
const LTR_COLUMN_KEYS = new Set(['datetime', 'before', 'delta', 'after']);

function formatDelta(delta: number): string {
  return delta > 0 ? `+${delta}` : String(delta);
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * PRODUCTION-READINESS-CLEANUP-B: CSV injection protection — same pattern
 * already used by StatusCenterScreen's exportCsv(). A cell value beginning
 * with =, +, -, or @ can be interpreted as a formula by Excel/Sheets; a
 * leading apostrophe forces plain-text treatment without altering the value.
 */
function csvSafeCell(v: string): string {
  return /^[=+\-@]/.test(v) ? `'${v}` : v;
}

const fieldStyle = {
  padding: '8px 12px', borderRadius: 'var(--r2)',
  border: '1px solid var(--brd)', background: 'var(--s)',
  color: 'var(--t)', fontSize: '13px',
} as const;

const btnStyle = {
  padding: '9px 14px', minHeight: '38px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)',
  background: 'var(--s)', color: 'var(--t)', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
} as const;

// R03-FIX: CSV/Print must stay enabled once loading completes, even for a
// genuine zero-row result — a filtered "no movements" result is still a
// real, exportable/printable report. Only loading (nothing to export yet)
// or a load error (nothing trustworthy to export) disable the actions.
const disabledBtnStyle = { ...btnStyle, opacity: 0.5, cursor: 'not-allowed' } as const;

const th = { textAlign: 'start' as const, padding: '8px 8px', fontSize: '11px', fontWeight: 700, color: 'var(--t2)', borderBottom: '2px solid var(--brd)', whiteSpace: 'nowrap' as const };
const td = { padding: '7px 8px', fontSize: '11.5px', borderBottom: '1px solid var(--brd)', whiteSpace: 'nowrap' as const };

export function MovementReportSection() {
  const { lang, activeOrgId, myPermissions } = useApp();

  const canViewReport = myPermissions.has('status_center.view');
  const canExportCsv  = myPermissions.has('availability.movements.export');
  const canPrint      = myPermissions.has('availability.movements.print');

  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [ledgerSource, setLedgerSource] = useState<MovementLedgerSource | ''>('');
  const [movementType, setMovementType] = useState('');
  const [locationId, setLocationId] = useState('');
  const [materialSearch, setMaterialSearch] = useState('');
  const [actorSearch, setActorSearch] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  // BUGFIX-MOBILE-PRINT-DOES-NOT-EXIT-APP-A: on mobile, printReport() routes
  // here instead of calling window.open/window.print directly.
  const [mobilePrintHtml, setMobilePrintHtml] = useState<string | null>(null);
  const [drillDownMovementId, setDrillDownMovementId] = useState<string | null>(null);
  const [drillDownContext, setDrillDownContext] = useState<DispenseContext | null>(null);
  const [drillDownError, setDrillDownError] = useState<string | null>(null);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  const points = useAsync(
    () => (canViewReport && activeOrgId) ? getPointsByOrg(activeOrgId) : Promise.resolve([]),
    [canViewReport, activeOrgId],
  );
  const warehouses = useAsync(
    () => (canViewReport && activeOrgId) ? getWarehouses(activeOrgId) : Promise.resolve([]),
    [canViewReport, activeOrgId],
  );

  const locationOptions = useMemo(() => {
    const wh = (warehouses.data ?? []).map(w => ({ id: w.id, name: w.name, name_ar: w.name_ar, kind: 'warehouse' as const }));
    const dp = (points.data ?? []).map(p => ({ id: p.id, name: p.name, name_ar: p.name_ar, kind: 'outlet' as const }));
    if (ledgerSource === 'warehouse' || ledgerSource === 'quarantine') return wh;
    if (ledgerSource === 'outlet') return dp;
    return [...wh, ...dp];
  }, [warehouses.data, points.data, ledgerSource]);

  const report = useAsync(
    () => (canViewReport && activeOrgId)
      ? getMovementLedgerReport({
          organizationId: activeOrgId,
          from: dateFrom ? new Date(`${dateFrom}T00:00:00`).toISOString() : undefined,
          to: dateTo ? new Date(`${dateTo}T23:59:59.999`).toISOString() : undefined,
          ledgerSource: ledgerSource || undefined,
          movementType: movementType || undefined,
          locationId: locationId || undefined,
          materialSearch: materialSearch || undefined,
          actorSearch: actorSearch || undefined,
          limit: 200,
        })
      : Promise.resolve({ rows: [], totalCount: 0 }),
    [canViewReport, activeOrgId, dateFrom, dateTo, ledgerSource, movementType, locationId, materialSearch, actorSearch],
  );

  const rows = report.data?.rows ?? [];
  // R03-FIX: disabled only while there's nothing loaded yet or the load
  // failed — NOT while rows is legitimately empty after a successful load.
  const reportActionsDisabled = report.loading || !!report.error;

  const summary = useMemo(() => {
    let totalAdd = 0, totalSubtract = 0, totalCorrection = 0, netDelta = 0;
    for (const m of rows) {
      if (m.quantityDelta > 0) totalAdd++;
      else if (m.quantityDelta < 0) totalSubtract++;
      if (m.movementType === 'correction' || m.movementType === 'quarantine_correction') totalCorrection++;
      netDelta += m.quantityDelta;
    }
    return { total: rows.length, totalAdd, totalSubtract, totalCorrection, netDelta };
  }, [rows]);

  const locationLabel = (r: MovementLedgerReportRow) =>
    lang === 'ar' ? (r.locationNameAr || r.locationName || '—') : (r.locationName || r.locationNameAr || '—');

  const actorLabel = (r: MovementLedgerReportRow) =>
    (r.actorName || '—') + (r.actorRole ? ` (${r.actorRole})` : '');

  const reasonLabel = (r: MovementLedgerReportRow) => reasonCodeLabel(r.reasonCode, lang);
  const typeLabel = (r: MovementLedgerReportRow) => movementTypeLabel(r.movementType, lang);
  const ledgerLabel = (r: MovementLedgerReportRow) => ledgerSourceLabel(r.ledgerSource, lang);

  // Shared column definitions for table / print / CSV — mirrors the pattern
  // already used by StatusCenterScreen's live availability report. The
  // dispense-context column is TEXT-ONLY here (Recorded/—) so CSV/print stay
  // in exact parity with the live table; the clickable "View" affordance is
  // rendered separately, only in the on-screen table.
  const columns: { key: string; label: string; value: (r: MovementLedgerReportRow) => string }[] = [
    { key: 'datetime', label: t('mvmt_col_datetime', lang), value: r => formatStableDateTime(r.occurredAt, lang) },
    { key: 'ledger',   label: t('mvmt_col_ledger_source', lang), value: ledgerLabel },
    { key: 'location', label: t('mvmt_col_location', lang), value: locationLabel },
    { key: 'sci',      label: t('avail_scientific_name', lang), value: r => r.scientificName || '—' },
    { key: 'conc',     label: t('avail_concentration', lang), value: r => r.concentration || '—' },
    { key: 'dosage',   label: t('avail_dosage_form', lang), value: r => r.dosageForm || '—' },
    { key: 'batch',    label: t('mv_f_batch_number', lang), value: r => r.batchNumber || '—' },
    { key: 'type',     label: t('mvmt_col_type', lang),     value: typeLabel },
    { key: 'reason',   label: t('mvmt_col_reason_code', lang), value: reasonLabel },
    { key: 'before',   label: t('mvmt_col_before', lang),   value: r => String(r.quantityBefore) },
    { key: 'delta',    label: t('mvmt_col_delta', lang),    value: r => formatDelta(r.quantityDelta) },
    { key: 'after',    label: t('mvmt_col_after', lang),    value: r => String(r.quantityAfter) },
    { key: 'actor',    label: t('mvmt_col_actor', lang),    value: actorLabel },
    { key: 'doc',      label: t('mvmt_col_document_ref', lang), value: r => r.sourceDocumentNumber || '—' },
    { key: 'correlation', label: t('mvmt_col_correlation', lang), value: r => r.correlationId || '—' },
    { key: 'causation',   label: t('mvmt_col_causation', lang),   value: r => r.causationId || '—' },
    { key: 'dispense',  label: t('mvmt_col_dispense_context', lang), value: r => r.hasDispenseContext ? t('mvmt_dispense_context_yes', lang) : t('mvmt_dispense_context_no', lang) },
  ];

  const generatedAt = () => formatStableDateTime(new Date(), lang);

  const selectedFiltersText = useMemo(() => {
    const parts: string[] = [];
    if (dateFrom) parts.push(`${t('mvmt_report_date_from', lang)}: ${dateFrom}`);
    if (dateTo) parts.push(`${t('mvmt_report_date_to', lang)}: ${dateTo}`);
    if (ledgerSource) parts.push(`${t('mvmt_col_ledger_source', lang)}: ${ledgerSourceLabel(ledgerSource, lang)}`);
    if (movementType) parts.push(`${t('mvmt_type_label', lang)}: ${movementTypeLabel(movementType, lang)}`);
    if (locationId) {
      const p = locationOptions.find(x => x.id === locationId);
      if (p) parts.push(`${t('mvmt_col_location', lang)}: ${lang === 'ar' ? p.name_ar : p.name}`);
    }
    if (materialSearch.trim()) parts.push(`${t('avail_scientific_name', lang)}: ${materialSearch.trim()}`);
    if (actorSearch.trim()) parts.push(`${t('mvmt_col_actor', lang)}: ${actorSearch.trim()}`);
    return parts.length ? parts.join(' · ') : t('sc_all', lang);
  }, [dateFrom, dateTo, ledgerSource, movementType, locationId, materialSearch, actorSearch, locationOptions, lang]);

  function buildReportHtml(): string {
    const dir = lang === 'ar' ? 'rtl' : 'ltr';
    const headCells = columns.map(c => `<th>${escHtml(c.label)}</th>`).join('');
    const bodyRows = rows.map(r =>
      '<tr>' + columns.map(c => `<td${LTR_COLUMN_KEYS.has(c.key) ? ' dir="ltr"' : ''}>${escHtml(c.value(r))}</td>`).join('') + '</tr>'
    ).join('');
    return `<!doctype html><html dir="${dir}" lang="${lang}"><head><meta charset="utf-8">
<title>${escHtml(t('mvmt_report_title', lang))}</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  body { font-family: ${lang === 'ar' ? "'Segoe UI', Tahoma, Arial" : 'Arial, sans-serif'}; color: #111; direction: ${dir}; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .brand { font-size: 11px; color: #555; margin-bottom: 10px; }
  .meta { font-size: 11px; color: #333; margin: 2px 0; }
  .meta .val { unicode-bidi: isolate; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 10px; }
  th, td { border: 1px solid #999; padding: 4px 6px; text-align: ${lang === 'ar' ? 'right' : 'left'}; white-space: nowrap; }
  th { background: #eee; }
</style></head><body>
  <h1>${escHtml(t('mvmt_report_title', lang))}</h1>
  <div class="brand">MediStock-Babil / MASAR Health Network</div>
  <div class="meta">${escHtml(t('sc_selected_filters', lang))}: ${escHtml(selectedFiltersText)}</div>
  <div class="meta">${escHtml(t('sc_generated_at', lang))}: <span class="val" dir="ltr">${escHtml(generatedAt())}</span></div>
  <div class="meta">${escHtml(t('sc_total_rows', lang))}: ${rows.length}</div>
  <div class="footer">${escHtml(t('report_footer_generated_by', lang))}</div>
  <table><thead><tr>${headCells}</tr></thead><tbody>${bodyRows}</tbody></table>
</body></html>`;
  }

  function printReport() {
    // R03-FIX: a filtered result of zero rows is an honest, real report state
    // (e.g. "no movements in this date range") — it must still print, showing
    // the same metadata block and an empty table, not silently do nothing.
    // BUGFIX-MOBILE-PRINT-DOES-NOT-EXIT-APP-A: mobile/PWA/webview contexts
    // route to the in-app fallback modal instead of window.open/window.print
    // — those can switch to a native print UI or open an external tab,
    // making the app appear to exit. Desktop keeps the original popup flow.
    if (isLikelyMobilePrintContext()) {
      setMobilePrintHtml(buildReportHtml());
      return;
    }
    const win = window.open('', '_blank');
    if (!win) {
      showToast(t('print_popup_blocked', lang));
      return;
    }
    win.document.write(buildReportHtml());
    win.document.close();
    win.focus();
    win.print();
    win.close();
  }

  function exportCsv() {
    try {
      const bom = '﻿';
      const cell = (v: string) => `"${csvSafeCell(v).replace(/"/g, '""')}"`;
      const metadataLines = [
        t('mvmt_report_title', lang),
        `${t('sc_selected_filters', lang)}: ${selectedFiltersText}`,
        `${t('sc_generated_at', lang)}: ${generatedAt()}`,
        `${t('sc_total_rows', lang)}: ${rows.length}`,
      ];
      const lines = [
        ...metadataLines.map(m => cell(m)),
        '',
        columns.map(c => cell(c.label)).join(','),
        ...rows.map(r => columns.map(c => cell(String(c.value(r)))).join(',')),
      ];
      const csv = bom + lines.join('\r\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const pad2 = (n: number) => String(n).padStart(2, '0');
      const now = new Date();
      const stamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}_${pad2(now.getHours())}-${pad2(now.getMinutes())}`;
      const a = document.createElement('a');
      a.href = url;
      a.download = `medistock-movements-${stamp}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      showToast(t('csv_export_failed', lang));
    }
  }

  useEffect(() => {
    if (!drillDownMovementId) { setDrillDownContext(null); setDrillDownError(null); return; }
    let cancelled = false;
    getDispenseContext(drillDownMovementId)
      .then(ctx => { if (!cancelled) setDrillDownContext(ctx); })
      .catch(e => { if (!cancelled) setDrillDownError((e as Error)?.message ?? 'load_error'); });
    return () => { cancelled = true; };
  }, [drillDownMovementId]);

  if (!canViewReport) return null;

  return (
    <PhoenixCard padding="16px" style={{ marginTop: '20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px', marginBottom: '14px' }}>
        <div>
          <div style={{ fontSize: '15px', fontWeight: 800 }}><PhoenixIcon name="reports" size={15} inline /> {t('mvmt_report_title', lang)}</div>
          <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '3px' }}>{t('mvmt_report_sub', lang)}</div>
          <div style={{ fontSize: '10.5px', color: 'var(--t3)', marginTop: '4px' }} dir="auto">
<PhoenixIcon name="lock" size={13} inline /> {t('mvmt_report_history_preserved_note', lang)}
          </div>
        </div>
        <div className="premium-action-bar" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {canExportCsv && (
            <button onClick={exportCsv} disabled={reportActionsDisabled} aria-disabled={reportActionsDisabled} aria-label={t('mvmt_report_export_csv', lang)} style={reportActionsDisabled ? disabledBtnStyle : btnStyle}><PhoenixIcon name="file" size={14} inline /> {t('mvmt_report_export_csv', lang)}</button>
          )}
          {canPrint && (
            <button onClick={printReport} disabled={reportActionsDisabled} aria-disabled={reportActionsDisabled} aria-label={t('sc_print_report', lang)} style={reportActionsDisabled ? disabledBtnStyle : btnStyle}><PhoenixIcon name="print" size={14} inline /> {t('sc_print_report', lang)}</button>
          )}
        </div>
      </div>

      {!activeOrgId ? (
        <div style={{ textAlign: 'center', padding: '24px', color: 'var(--t2)', fontSize: '12.5px' }}>
          {t('no_org_scope', lang)}
        </div>
      ) : (
        <>
          {/* Filters */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '14px' }}>
            <div>
              <label htmlFor="mr-date-from" style={{ display: 'block', fontSize: '10.5px', color: 'var(--t2)', marginBottom: '4px' }}>{t('mvmt_report_date_from', lang)}</label>
              <input id="mr-date-from" type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={fieldStyle} />
            </div>
            <div>
              <label htmlFor="mr-date-to" style={{ display: 'block', fontSize: '10.5px', color: 'var(--t2)', marginBottom: '4px' }}>{t('mvmt_report_date_to', lang)}</label>
              <input id="mr-date-to" type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={fieldStyle} />
            </div>
            <div>
              <label htmlFor="mr-ledger" style={{ display: 'block', fontSize: '10.5px', color: 'var(--t2)', marginBottom: '4px' }}>{t('mvmt_col_ledger_source', lang)}</label>
              <select id="mr-ledger" value={ledgerSource} onChange={e => { setLedgerSource(e.target.value as MovementLedgerSource | ''); setLocationId(''); }} style={{ ...fieldStyle, appearance: 'none', cursor: 'pointer', minWidth: '140px' }}>
                <option value="">{t('mvmt_ledger_all', lang)}</option>
                <option value="warehouse">{t('mvmt_ledger_warehouse', lang)}</option>
                <option value="outlet">{t('mvmt_ledger_outlet', lang)}</option>
                <option value="quarantine">{t('mvmt_ledger_quarantine', lang)}</option>
              </select>
            </div>
            <div>
              <label htmlFor="mr-type" style={{ display: 'block', fontSize: '10.5px', color: 'var(--t2)', marginBottom: '4px' }}>{t('mvmt_type_label', lang)}</label>
              <select id="mr-type" value={movementType} onChange={e => setMovementType(e.target.value)} style={{ ...fieldStyle, appearance: 'none', cursor: 'pointer', minWidth: '140px' }}>
                <option value="">{t('mvmt_report_all_types', lang)}</option>
                {Object.entries(MOVEMENT_TYPE_LABEL_KEY).map(([value, labelKey]) => <option key={value} value={value}>{t(labelKey, lang)}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="mr-location" style={{ display: 'block', fontSize: '10.5px', color: 'var(--t2)', marginBottom: '4px' }}>{t('mvmt_col_location', lang)}</label>
              <select id="mr-location" value={locationId} onChange={e => setLocationId(e.target.value)} style={{ ...fieldStyle, appearance: 'none', cursor: 'pointer', minWidth: '140px' }}>
                <option value="">{t('mvmt_report_all_locations', lang)}</option>
                {locationOptions.map(p => <option key={p.id} value={p.id}>{lang === 'ar' ? p.name_ar : p.name}</option>)}
              </select>
            </div>
            <div style={{ flex: 1, minWidth: '150px' }}>
              <label htmlFor="mr-material" style={{ display: 'block', fontSize: '10.5px', color: 'var(--t2)', marginBottom: '4px' }}>{t('avail_scientific_name', lang)}</label>
              <input id="mr-material" type="search" dir="auto" value={materialSearch} onChange={e => setMaterialSearch(e.target.value)} placeholder={t('mvmt_report_material_search_ph', lang)} style={{ ...fieldStyle, width: '100%' }} />
            </div>
            <div style={{ flex: 1, minWidth: '150px' }}>
              <label htmlFor="mr-actor" style={{ display: 'block', fontSize: '10.5px', color: 'var(--t2)', marginBottom: '4px' }}>{t('mvmt_col_actor', lang)}</label>
              <input id="mr-actor" type="search" dir="auto" value={actorSearch} onChange={e => setActorSearch(e.target.value)} placeholder={t('mvmt_report_actor_search_ph', lang)} style={{ ...fieldStyle, width: '100%' }} />
            </div>
          </div>

          {/* Summary cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '10px', marginBottom: '16px' }}>
            {[
              { val: summary.total,           k: 'mvmt_report_summary_total' },
              { val: summary.totalAdd,        k: 'mvmt_report_summary_add' },
              { val: summary.totalSubtract,   k: 'mvmt_report_summary_subtract' },
              { val: summary.totalCorrection, k: 'mvmt_report_summary_correction' },
              { val: summary.netDelta > 0 ? `+${summary.netDelta}` : summary.netDelta, k: 'mvmt_report_summary_net' },
            ].map(item => (
              <div key={item.k} style={{ background: 'var(--s2)', border: '1px solid var(--brd)', borderRadius: 'var(--r2)', padding: '10px 12px' }}>
                <div style={{ fontSize: '18px', fontWeight: 800, lineHeight: 1 }}>{item.val}</div>
                <div style={{ fontSize: '10.5px', color: 'var(--t2)', marginTop: '4px' }}>{t(item.k, lang)}</div>
              </div>
            ))}
          </div>

          {/* Table */}
          {report.loading && <PhoenixLoadingState label={t('loading', lang)} />}
          {!report.loading && report.error && (
            <PhoenixErrorState title={t('load_error', lang)} message={report.error} onRetry={report.reload} />
          )}
          {!report.loading && !report.error && rows.length === 0 && (
            <div style={{ textAlign: 'center', padding: '32px', color: 'var(--t2)', fontSize: '12.5px' }}>
              {t('mvmt_report_empty', lang)}
            </div>
          )}
          {!report.loading && !report.error && rows.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>{columns.map(c => <th key={c.key} style={th}>{c.label}</th>)}</tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.movementId}>
                      {columns.map(c => (
                        c.key === 'dispense' ? (
                          <td key={c.key} style={td}>
                            {r.hasDispenseContext ? (
                              <button
                                onClick={() => setDrillDownMovementId(r.movementId)}
                                style={{ ...btnStyle, padding: '4px 8px', minHeight: 'unset', fontSize: '10.5px' }}
                                aria-label={t('mvmt_dispense_context_view', lang)}
                              >
                                {t('mvmt_dispense_context_yes', lang)} · {t('mvmt_dispense_context_view', lang)}
                              </button>
                            ) : (
                              <span dir="auto">{t('mvmt_dispense_context_no', lang)}</span>
                            )}
                          </td>
                        ) : (
                          <td key={c.key} style={td} dir={LTR_COLUMN_KEYS.has(c.key) ? 'ltr' : 'auto'}>{c.value(r)}</td>
                        )
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
        title={t('mvmt_report_title', lang)}
        fileNameBase="medistock-movements"
        lang={lang}
        onClose={() => setMobilePrintHtml(null)}
      />
      <PhoenixDialog
        open={drillDownMovementId !== null}
        onClose={() => setDrillDownMovementId(null)}
        title={t('mvmt_col_dispense_context', lang)}
      >
        {drillDownError && <PhoenixErrorState title={t('load_error', lang)} message={drillDownError} />}
        {!drillDownError && !drillDownContext && <PhoenixLoadingState label={t('loading', lang)} />}
        {!drillDownError && drillDownContext && <DispenseContextViewer context={drillDownContext} lang={lang} />}
      </PhoenixDialog>
    </PhoenixCard>
  );
}
