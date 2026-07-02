import { useMemo, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { getPointsByOrg } from '@/shared/supabase/services/warehouses.service';
import {
  getAvailabilityMovementsReport,
  type AvailabilityMovementReportRecord,
  type AvailabilityMovementType,
} from '@/shared/supabase/services/availability.service';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';

/**
 * AVAILABILITY-MOVEMENT-REPORTS-PRINT-A
 *
 * Read-only, filterable "Quantity Movement Report" section for Status Center.
 * Loads via getAvailabilityMovementsReport — a plain PostgREST SELECT against
 * item_availability_movements (migration 033). This component NEVER writes:
 * no supabase.rpc, no insert/update/delete. Visibility of the whole section
 * and of the Export CSV / Print actions is UX-only — avail_mvmt_select_perm
 * RLS independently re-enforces org scope + availability.movements.view on
 * every read regardless of what is shown here.
 */

const MOVEMENT_TYPE_OPTIONS: { value: AvailabilityMovementType; labelKey: string }[] = [
  { value: 'set_exact',  labelKey: 'mvmt_set_exact' },
  { value: 'add',        labelKey: 'mvmt_add' },
  { value: 'subtract',   labelKey: 'mvmt_subtract' },
  { value: 'correction', labelKey: 'mvmt_correction' },
];

const MOVEMENT_TYPE_LABEL_KEY: Record<AvailabilityMovementType, string> = {
  set_exact: 'mvmt_set_exact',
  add: 'mvmt_add',
  subtract: 'mvmt_subtract',
  correction: 'mvmt_correction',
};

function formatDelta(type: AvailabilityMovementType, delta: number): string {
  if (type === 'add') return `+${Math.abs(delta)}`;
  if (type === 'subtract') return `-${Math.abs(delta)}`;
  // set_exact / correction: display the stored signed delta as-is, never recomputed.
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
  padding: '8px 14px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)',
  background: 'var(--s)', color: 'var(--t)', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
} as const;

const th = { textAlign: 'start' as const, padding: '8px 8px', fontSize: '11px', fontWeight: 700, color: 'var(--t2)', borderBottom: '2px solid var(--brd)', whiteSpace: 'nowrap' as const };
const td = { padding: '7px 8px', fontSize: '11.5px', borderBottom: '1px solid var(--brd)', whiteSpace: 'nowrap' as const };

export function MovementReportSection() {
  const { lang, activeOrgId, myPermissions } = useApp();

  const canViewReport = myPermissions.has('availability.movements.view');
  const canExportCsv  = myPermissions.has('availability.movements.export');
  const canPrint      = myPermissions.has('availability.movements.print');

  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [movementType, setMovementType] = useState<AvailabilityMovementType | ''>('');
  const [pointId, setPointId] = useState('');
  const [materialSearch, setMaterialSearch] = useState('');
  const [actorSearch, setActorSearch] = useState('');

  const points = useAsync(
    () => (canViewReport && activeOrgId) ? getPointsByOrg(activeOrgId) : Promise.resolve([]),
    [canViewReport, activeOrgId],
  );

  const report = useAsync<AvailabilityMovementReportRecord[]>(
    () => (canViewReport && activeOrgId)
      ? getAvailabilityMovementsReport({
          organizationId: activeOrgId,
          dateFrom: dateFrom || undefined,
          dateTo: dateTo || undefined,
          movementType: movementType || undefined,
          distributionPointId: pointId || undefined,
          materialSearch: materialSearch || undefined,
          actorSearch: actorSearch || undefined,
          limit: 200,
        })
      : Promise.resolve([]),
    [canViewReport, activeOrgId, dateFrom, dateTo, movementType, pointId, materialSearch, actorSearch],
  );

  const rows = report.data ?? [];

  const summary = useMemo(() => {
    let totalAdd = 0, totalSubtract = 0, totalCorrection = 0, netDelta = 0;
    for (const m of rows) {
      if (m.movementType === 'add') totalAdd++;
      else if (m.movementType === 'subtract') totalSubtract++;
      else if (m.movementType === 'correction') totalCorrection++;
      netDelta += m.quantityDelta;
    }
    return { total: rows.length, totalAdd, totalSubtract, totalCorrection, netDelta };
  }, [rows]);

  const dpLabel = (r: AvailabilityMovementReportRecord) =>
    lang === 'ar' ? (r.distributionPointNameAr || r.distributionPointName || '—') : (r.distributionPointName || r.distributionPointNameAr || '—');

  const actorLabel = (r: AvailabilityMovementReportRecord) =>
    (r.actorNameSnapshot || r.actorEmailSnapshot || '—') + (r.actorRoleSnapshot ? ` (${r.actorRoleSnapshot})` : '');

  // Shared column definitions for table / print / CSV — mirrors the pattern
  // already used by StatusCenterScreen's live availability report.
  const columns: { key: string; label: string; value: (r: AvailabilityMovementReportRecord) => string }[] = [
    { key: 'datetime', label: t('mvmt_col_datetime', lang), value: r => new Date(r.createdAt).toLocaleString(lang === 'ar' ? 'ar' : 'en') },
    { key: 'point',    label: t('sc_lm_port', lang),        value: dpLabel },
    { key: 'sci',      label: t('avail_scientific_name', lang), value: r => r.scientificName || '—' },
    { key: 'trade',    label: t('avail_trade_name', lang), value: r => r.tradeName || '—' },
    { key: 'conc',     label: t('avail_concentration', lang), value: r => r.concentration || '—' },
    { key: 'dosage',   label: t('avail_dosage_form', lang), value: r => r.dosageForm || '—' },
    { key: 'type',     label: t('mvmt_col_type', lang),     value: r => t(MOVEMENT_TYPE_LABEL_KEY[r.movementType], lang) },
    { key: 'before',   label: t('mvmt_col_before', lang),   value: r => String(r.quantityBefore) },
    { key: 'delta',    label: t('mvmt_col_delta', lang),    value: r => formatDelta(r.movementType, r.quantityDelta) },
    { key: 'after',    label: t('mvmt_col_after', lang),    value: r => String(r.quantityAfter) },
    { key: 'actor',    label: t('mvmt_col_actor', lang),    value: actorLabel },
    { key: 'reason',   label: t('mvmt_col_reason', lang),   value: r => r.reason || '—' },
    { key: 'notes',    label: t('mvmt_col_notes', lang),    value: r => r.notes || '—' },
  ];

  const generatedAt = () => new Date().toLocaleString(lang === 'ar' ? 'ar' : 'en');

  const selectedFiltersText = useMemo(() => {
    const parts: string[] = [];
    if (dateFrom) parts.push(`${t('mvmt_report_date_from', lang)}: ${dateFrom}`);
    if (dateTo) parts.push(`${t('mvmt_report_date_to', lang)}: ${dateTo}`);
    if (movementType) parts.push(`${t('mvmt_type_label', lang)}: ${t(MOVEMENT_TYPE_LABEL_KEY[movementType], lang)}`);
    if (pointId) {
      const p = (points.data ?? []).find(x => x.id === pointId);
      if (p) parts.push(`${t('sc_lm_port', lang)}: ${lang === 'ar' ? p.name_ar : p.name}`);
    }
    if (materialSearch.trim()) parts.push(`${t('avail_scientific_name', lang)}: ${materialSearch.trim()}`);
    if (actorSearch.trim()) parts.push(`${t('mvmt_col_actor', lang)}: ${actorSearch.trim()}`);
    return parts.length ? parts.join(' · ') : t('sc_all', lang);
  }, [dateFrom, dateTo, movementType, pointId, materialSearch, actorSearch, points.data, lang]);

  function buildReportHtml(): string {
    const dir = lang === 'ar' ? 'rtl' : 'ltr';
    const headCells = columns.map(c => `<th>${escHtml(c.label)}</th>`).join('');
    const bodyRows = rows.map(r =>
      '<tr>' + columns.map(c => `<td>${escHtml(c.value(r))}</td>`).join('') + '</tr>'
    ).join('');
    return `<!doctype html><html dir="${dir}" lang="${lang}"><head><meta charset="utf-8">
<title>${escHtml(t('mvmt_report_title', lang))}</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  body { font-family: ${lang === 'ar' ? "'Segoe UI', Tahoma, Arial" : 'Arial, sans-serif'}; color: #111; direction: ${dir}; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .brand { font-size: 11px; color: #555; margin-bottom: 10px; }
  .meta { font-size: 11px; color: #333; margin: 2px 0; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 10px; }
  th, td { border: 1px solid #999; padding: 4px 6px; text-align: ${lang === 'ar' ? 'right' : 'left'}; white-space: nowrap; }
  th { background: #eee; }
</style></head><body>
  <h1>${escHtml(t('mvmt_report_title', lang))}</h1>
  <div class="brand">MediStock-Babil / MASAR Health Network</div>
  <div class="meta">${escHtml(t('sc_selected_filters', lang))}: ${escHtml(selectedFiltersText)}</div>
  <div class="meta">${escHtml(t('sc_generated_at', lang))}: ${escHtml(generatedAt())}</div>
  <div class="meta">${escHtml(t('sc_total_rows', lang))}: ${rows.length}</div>
  <table><thead><tr>${headCells}</tr></thead><tbody>${bodyRows}</tbody></table>
</body></html>`;
  }

  function printReport() {
    if (rows.length === 0) return;
    const win = window.open('', '_blank');
    if (!win) return;
    win.document.write(buildReportHtml());
    win.document.close();
    win.focus();
    win.print();
  }

  function exportCsv() {
    const bom = '﻿';
    const cell = (v: string) => `"${csvSafeCell(v).replace(/"/g, '""')}"`;
    const lines = [
      columns.map(c => cell(c.label)).join(','),
      ...rows.map(r => columns.map(c => cell(String(c.value(r)))).join(',')),
    ];
    const csv = bom + lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `medistock-movements-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!canViewReport) return null;

  return (
    <PhoenixCard padding="16px" style={{ marginTop: '20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px', marginBottom: '14px' }}>
        <div>
          <div style={{ fontSize: '15px', fontWeight: 800 }}>📊 {t('mvmt_report_title', lang)}</div>
          <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '3px' }}>{t('mvmt_report_sub', lang)}</div>
        </div>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {canExportCsv && (
            <button onClick={exportCsv} disabled={rows.length === 0} style={btnStyle}>📄 {t('mvmt_report_export_csv', lang)}</button>
          )}
          {canPrint && (
            <button onClick={printReport} disabled={rows.length === 0} style={btnStyle}>🖨 {t('sc_print_report', lang)}</button>
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
              <label htmlFor="mr-type" style={{ display: 'block', fontSize: '10.5px', color: 'var(--t2)', marginBottom: '4px' }}>{t('mvmt_type_label', lang)}</label>
              <select id="mr-type" value={movementType} onChange={e => setMovementType(e.target.value as AvailabilityMovementType | '')} style={{ ...fieldStyle, appearance: 'none', cursor: 'pointer', minWidth: '140px' }}>
                <option value="">{t('mvmt_report_all_types', lang)}</option>
                {MOVEMENT_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{t(o.labelKey, lang)}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="mr-point" style={{ display: 'block', fontSize: '10.5px', color: 'var(--t2)', marginBottom: '4px' }}>{t('sc_lm_port', lang)}</label>
              <select id="mr-point" value={pointId} onChange={e => setPointId(e.target.value)} style={{ ...fieldStyle, appearance: 'none', cursor: 'pointer', minWidth: '140px' }}>
                <option value="">{t('se_all_ports', lang)}</option>
                {(points.data ?? []).map(p => <option key={p.id} value={p.id}>{lang === 'ar' ? p.name_ar : p.name}</option>)}
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
                    <tr key={r.id}>
                      {columns.map(c => <td key={c.key} style={td} dir={c.key === 'datetime' || c.key === 'before' || c.key === 'delta' || c.key === 'after' ? 'ltr' : 'auto'}>{c.value(r)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </PhoenixCard>
  );
}
