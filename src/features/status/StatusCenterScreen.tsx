import { useState, useMemo } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { getAvailabilityByOrg } from '@/shared/supabase/services/availability.service';
import { getOrganizations } from '@/shared/supabase/services/organizations.service';
import type { CanonicalStatus } from '@/shared/lib/status/canonical';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';
import { PhoenixOrgScope } from '@/shared/ui/PhoenixOrgScope';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { PhoenixToast } from '@/shared/ui/PhoenixToast';
import { AdjustQuantityModal, QUANTITY_MOVEMENT_PERMISSION_KEYS, type AdjustQuantityRow } from './AdjustQuantityModal';
import { MovementHistoryModal } from './MovementHistoryModal';
import { MovementReportSection } from './MovementReportSection';
import type { ApplyAvailabilityMovementResult } from '@/shared/supabase/services/availability.service';

// NOTE: Manual status reports (institution_item_status_reports) are intentionally
// NO LONGER part of this screen (LIVE-STATUS-CENTER-REPORTS-PRINT-EXPORT-A). The
// Status Center is now a live-availability reporting center driven entirely by
// item_availability via getAvailabilityByOrg. The manual status report service
// module and its DB table are NOT deleted — only the manual add/edit/resolve UI
// was removed to avoid confusion. Historical report rows remain untouched.

/** The 6 canonical statuses summarized/filtered in the live report. */
const CANONICAL_STATUSES: CanonicalStatus[] = [
  'available', 'low_stock', 'missing', 'surplus', 'near_expiry', 'expired',
];

/** Badge variant per canonical effective status (UI only). */
const CANON_VARIANT: Record<CanonicalStatus, 'ok' | 'warn' | 'err' | 'neutral'> = {
  available: 'ok', surplus: 'ok', low_stock: 'warn', near_expiry: 'warn', missing: 'err', expired: 'err',
};

type SupplyCategory = 'purchases' | 'kimadia' | 'donations' | 'aid';

const SUPPLY_CATEGORIES: { value: SupplyCategory; labelKey: string }[] = [
  { value: 'purchases', labelKey: 'sc_supply_purchases' },
  { value: 'kimadia',   labelKey: 'sc_supply_kimadia' },
  { value: 'donations', labelKey: 'sc_supply_donations' },
  { value: 'aid',       labelKey: 'sc_supply_aid' },
];

/**
 * Normalize a free-text supply_type value into a known display category WITHOUT
 * altering the stored value. Returns null when it doesn't match a known category
 * (the original value is still preserved and shown in tables/exports).
 */
function normalizeSupplyType(v?: string | null): SupplyCategory | null {
  if (!v) return null;
  const s = v.trim().toLowerCase();
  if (!s) return null;
  if (s.includes('kimadia') || s.includes('كيماديا') || s.includes('كماديا')) return 'kimadia';
  if (s.includes('purchase') || s.includes('مشتر') || s.includes('شراء')) return 'purchases';
  if (s.includes('donation') || s.includes('هب') || s.includes('تبرع') || s.includes('منح')) return 'donations';
  if (s.includes('aid') || s.includes('مساعد') || s.includes('إغاث') || s.includes('اغاث')) return 'aid';
  return null;
}

/** A live item_availability row enriched with derived fields by the service layer. */
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
  distribution_points: { id: string; name: string; name_ar: string } | null;
}

function effOf(r: LiveAvailRow): CanonicalStatus {
  return (r.effective_status ?? r.condition ?? 'available') as CanonicalStatus;
}

function dpNameOf(r: LiveAvailRow, lang: 'ar' | 'en'): string {
  const dp = r.distribution_points;
  if (!dp) return '—';
  return lang === 'ar' ? (dp.name_ar || dp.name) : dp.name;
}

const fieldStyle = {
  padding: '8px 12px', borderRadius: 'var(--r2)',
  border: '1px solid var(--brd)', background: 'var(--s)',
  color: 'var(--t)', fontSize: '13px',
} as const;

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function StatusCenterScreen({ onNavigate }: { onNavigate: (screen: number) => void }) {
  const { lang, activeOrgId, myPermissions } = useApp();
  const isMobile = window.innerWidth < 768;

  const effectiveOrgId = activeOrgId ?? undefined;

  const [filterStatus, setFilterStatus] = useState<CanonicalStatus | ''>('');
  const [filterSupply, setFilterSupply] = useState<SupplyCategory | ''>('');
  const [search, setSearch] = useState('');

  // AVAILABILITY-QUANTITY-MOVEMENT-UI-A: row-level "Adjust Quantity" action.
  // Visibility is UX-only — phoenix_apply_availability_movement (migration 034)
  // independently re-enforces the same permission matrix server-side.
  const canAdjustQuantity = QUANTITY_MOVEMENT_PERMISSION_KEYS.some(key => myPermissions.has(key));
  const [adjustRow, setAdjustRow] = useState<AdjustQuantityRow | null>(null);
  const [movementToast, setMovementToast] = useState<string | null>(null);

  // AVAILABILITY-MOVEMENT-HISTORY-VIEW-A: row-level "History" action.
  // Visibility is UX-only — avail_mvmt_select_perm RLS (migration 033)
  // independently re-enforces availability.movements.view + org scope on the
  // actual read; hiding the button here never substitutes for that.
  const canViewMovementHistory = myPermissions.has('availability.movements.view');
  const [historyRow, setHistoryRow] = useState<AdjustQuantityRow | null>(null);

  const live = useAsync(
    () => effectiveOrgId ? getAvailabilityByOrg(effectiveOrgId) : Promise.resolve([]),
    [effectiveOrgId],
  );
  const orgs = useAsync(() => getOrganizations(), []);

  const orgName = useMemo(() => {
    if (!effectiveOrgId) return '';
    const o = (orgs.data ?? []).find(x => x.id === effectiveOrgId);
    if (!o) return '';
    return lang === 'ar' ? (o.name_ar || o.name) : (o.name || o.name_ar);
  }, [orgs.data, effectiveOrgId, lang]);

  const allRows = (live.data ?? []) as unknown as LiveAvailRow[];

  const rows = useMemo(() => {
    let list = allRows;
    if (filterStatus) list = list.filter(r => effOf(r) === filterStatus);
    if (filterSupply) list = list.filter(r => normalizeSupplyType(r.supply_type) === filterSupply);
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
    return list;
  }, [allRows, filterStatus, filterSupply, search]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const s of CANONICAL_STATUSES) c[s] = 0;
    for (const r of rows) { const s = effOf(r); c[s] = (c[s] ?? 0) + 1; }
    return c;
  }, [rows]);

  const generatedAt = () => new Date().toLocaleString(lang === 'ar' ? 'ar' : 'en');

  const selectedFiltersText = useMemo(() => {
    const parts: string[] = [];
    if (filterStatus) parts.push(`${t('sc_effective_status', lang)}: ${t('cond_' + filterStatus, lang)}`);
    if (filterSupply) parts.push(`${t('avail_supply_type', lang)}: ${t('sc_supply_' + filterSupply, lang)}`);
    if (search.trim()) parts.push(`${t('search', lang)}: ${search.trim()}`);
    return parts.length ? parts.join(' · ') : t('sc_all', lang);
  }, [filterStatus, filterSupply, search, lang]);

  // ── Column definitions shared by table / print / CSV ──
  const columns: { key: string; label: string; value: (r: LiveAvailRow) => string }[] = [
    { key: 'org',     label: t('sc_lm_org', lang),          value: () => orgName || '—' },
    { key: 'port',    label: t('sc_lm_port', lang),         value: r => dpNameOf(r, lang) },
    { key: 'sci',     label: t('avail_scientific_name', lang), value: r => r.scientific_name || '—' },
    { key: 'trade',   label: t('avail_trade_name', lang),   value: r => r.trade_name || '—' },
    { key: 'conc',    label: t('avail_concentration', lang),value: r => r.concentration || '—' },
    { key: 'dosage',  label: t('avail_dosage_form', lang),  value: r => r.dosage_form || '—' },
    { key: 'qty',     label: t('qty', lang),                value: r => String(r.quantity ?? 0) },
    { key: 'supply',  label: t('avail_supply_type', lang),  value: r => r.supply_type || '—' },
    { key: 'raw',     label: t('sc_raw_condition', lang),   value: r => r.condition ? t('cond_' + r.condition, lang) : '—' },
    { key: 'eff',     label: t('sc_effective_status', lang),value: r => t('cond_' + effOf(r), lang) },
    { key: 'expiry',  label: t('expiry', lang),             value: r => r.expiry_date || '—' },
    { key: 'bucket',  label: t('sc_expiry_bucket', lang),   value: r => r.expiry_bucket || '—' },
    { key: 'updated', label: t('last_upd', lang),    value: r => r.updated_at ? new Date(r.updated_at).toLocaleDateString(lang === 'ar' ? 'ar' : 'en') : '—' },
  ];

  function buildReportHtml(): string {
    const dir = lang === 'ar' ? 'rtl' : 'ltr';
    const countsLine = CANONICAL_STATUSES.map(s => `${t('cond_' + s, lang)}: ${counts[s]}`).join(' · ');
    const headCells = columns.map(c => `<th>${escHtml(c.label)}</th>`).join('');
    const bodyRows = rows.map(r =>
      '<tr>' + columns.map(c => `<td>${escHtml(c.value(r))}</td>`).join('') + '</tr>'
    ).join('');
    return `<!doctype html><html dir="${dir}" lang="${lang}"><head><meta charset="utf-8">
<title>${escHtml(t('sc_report_title', lang))}</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  body { font-family: ${lang === 'ar' ? "'Segoe UI', Tahoma, Arial" : 'Arial, sans-serif'}; color: #111; direction: ${dir}; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .brand { font-size: 11px; color: #555; margin-bottom: 10px; }
  .meta { font-size: 11px; color: #333; margin: 2px 0; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 10.5px; }
  th, td { border: 1px solid #999; padding: 4px 6px; text-align: ${lang === 'ar' ? 'right' : 'left'}; white-space: nowrap; }
  th { background: #eee; }
</style></head><body>
  <h1>${escHtml(t('sc_report_title', lang))}</h1>
  <div class="brand">MediStock-Babil / MASAR Health Network</div>
  ${orgName ? `<div class="meta">${escHtml(t('sc_lm_org', lang))}: ${escHtml(orgName)}</div>` : ''}
  <div class="meta">${escHtml(t('sc_selected_filters', lang))}: ${escHtml(selectedFiltersText)}</div>
  <div class="meta">${escHtml(t('sc_generated_at', lang))}: ${escHtml(generatedAt())}</div>
  <div class="meta">${escHtml(t('sc_total_rows', lang))}: ${rows.length}</div>
  <div class="meta">${escHtml(countsLine)}</div>
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
    const lines = [
      columns.map(c => `"${c.label.replace(/"/g, '""')}"`).join(','),
      ...rows.map(r => columns.map(c => `"${String(c.value(r)).replace(/"/g, '""')}"`).join(',')),
    ];
    const csv = bom + lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const safeOrg = orgName.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40);
    const a = document.createElement('a');
    a.href = url;
    a.download = `live-availability-report${safeOrg ? '_' + safeOrg : ''}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleMovementSuccess(result: ApplyAvailabilityMovementResult) {
    setMovementToast(
      `${t('mvmt_success', lang)}: ${result.quantityBefore} → ${result.quantityAfter}`,
    );
    setTimeout(() => setMovementToast(null), 3000);
    live.reload();
  }

  const btnStyle = {
    padding: '8px 14px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)',
    background: 'var(--s)', color: 'var(--t)', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
  } as const;

  const th = { textAlign: 'start' as const, padding: '8px 8px', fontSize: '11px', fontWeight: 700, color: 'var(--t2)', borderBottom: '2px solid var(--brd)', whiteSpace: 'nowrap' as const };
  const td = { padding: '7px 8px', fontSize: '11.5px', borderBottom: '1px solid var(--brd)', whiteSpace: 'nowrap' as const };

  return (
    <div style={{ maxWidth: '1200px', animation: 'fs .3s ease' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px', marginBottom: '16px' }}>
        <div>
          <h2 style={{ fontSize: isMobile ? '18px' : '22px', fontWeight: 700, letterSpacing: '-.3px' }}>
            {t('nav_status_center', lang)}
          </h2>
          <p style={{ fontSize: '12.5px', color: 'var(--t2)', marginTop: '3px' }}>{t('sc_report_sub', lang)}</p>
        </div>
        <PhoenixOrgScope />
      </div>

      {/* Notice: reporting only — no auto-transfer (safety disclaimer) */}
      <div style={{ background: 'var(--info2)', border: '1px solid var(--info)', borderRadius: 'var(--r3)', padding: '10px 14px', marginBottom: '16px', fontSize: '12px', color: 'var(--info)', display: 'flex', alignItems: 'center', gap: '8px' }}>
        ℹ️ {t('sc_no_exchange', lang)}
      </div>

      {/* Report header card (printable info) */}
      <PhoenixCard padding="16px" style={{ marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '16px', fontWeight: 800 }}>📋 {t('sc_report_title', lang)}</span>
          <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--ok)', background: 'var(--ok2)', border: '1px solid var(--ok)', borderRadius: 'var(--rpill)', padding: '1px 8px' }}>LIVE</span>
        </div>
        <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '6px', display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
          {orgName && <span>🏥 {orgName}</span>}
          <span>🕒 {t('sc_generated_at', lang)}: {generatedAt()}</span>
          <span>Σ {t('sc_total_rows', lang)}: {rows.length}</span>
        </div>
        {/* Counts by status */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '12px' }}>
          {CANONICAL_STATUSES.map(s => (
            <div key={s} style={{ flex: '1 1 90px', minWidth: '90px', background: 'var(--s2)', border: '1px solid var(--brd)', borderRadius: 'var(--r2)', padding: '8px 10px' }}>
              <div style={{ fontSize: '18px', fontWeight: 800, lineHeight: 1 }}>{counts[s]}</div>
              <div style={{ fontSize: '10.5px', color: 'var(--t2)', marginTop: '3px' }}>{t('cond_' + s, lang)}</div>
            </div>
          ))}
        </div>
      </PhoenixCard>

      {/* Filters + export/print actions */}
      <PhoenixCard padding="14px" style={{ marginBottom: '16px' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value as CanonicalStatus | '')} style={{ ...fieldStyle, minWidth: '150px', appearance: 'none', cursor: 'pointer' }} aria-label={t('sc_effective_status', lang)}>
            <option value="">{t('sc_all_statuses', lang)}</option>
            {CANONICAL_STATUSES.map(s => <option key={s} value={s}>{t('cond_' + s, lang)}</option>)}
          </select>

          <select value={filterSupply} onChange={e => setFilterSupply(e.target.value as SupplyCategory | '')} style={{ ...fieldStyle, minWidth: '150px', appearance: 'none', cursor: 'pointer' }} aria-label={t('avail_supply_type', lang)}>
            <option value="">{t('sc_all_supply_types', lang)}</option>
            {SUPPLY_CATEGORIES.map(c => <option key={c.value} value={c.value}>{t(c.labelKey, lang)}</option>)}
          </select>

          <input type="search" dir="auto" value={search} onChange={e => setSearch(e.target.value)} placeholder={t('search', lang)} style={{ ...fieldStyle, flex: 1, minWidth: '150px' }} aria-label={t('search', lang)} />

          <div style={{ display: 'flex', gap: '6px', marginInlineStart: 'auto', flexWrap: 'wrap' }}>
            <button onClick={exportCsv} disabled={rows.length === 0} style={btnStyle}>📊 {t('sc_export_excel', lang)}</button>
            <button onClick={printReport} disabled={rows.length === 0} style={btnStyle}>🖨 {t('sc_print_report', lang)}</button>
            <button onClick={printReport} disabled={rows.length === 0} style={btnStyle}>📄 {t('sc_print_pdf', lang)}</button>
          </div>
        </div>

        {/* Supply-type quick chips */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '10px' }}>
          <button onClick={() => setFilterSupply('')} style={{ ...btnStyle, padding: '5px 12px', background: filterSupply === '' ? 'var(--p2)' : 'var(--s)', color: filterSupply === '' ? 'var(--pd)' : 'var(--t)' }}>{t('sc_all_supply_types', lang)}</button>
          {SUPPLY_CATEGORIES.map(c => (
            <button key={c.value} onClick={() => setFilterSupply(c.value)} style={{ ...btnStyle, padding: '5px 12px', background: filterSupply === c.value ? 'var(--p2)' : 'var(--s)', color: filterSupply === c.value ? 'var(--pd)' : 'var(--t)' }}>
              {t(c.labelKey, lang)}
            </button>
          ))}
        </div>

        <div style={{ fontSize: '11px', color: 'var(--t2)', marginTop: '10px' }}>
          {t('sc_selected_filters', lang)}: {selectedFiltersText}
        </div>
      </PhoenixCard>

      {/* Report table */}
      {live.loading && <PhoenixLoadingState label={t('loading', lang)} />}
      {!live.loading && live.error && (
        <PhoenixErrorState title={t('load_error', lang)} message={live.error} onRetry={live.reload} />
      )}
      {!live.loading && !live.error && rows.length === 0 && (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--t2)', fontSize: '13px' }}>
          {allRows.length === 0 ? t('sc_live_empty', lang) : t('sc_no_match', lang)}
        </div>
      )}
      {!live.loading && !live.error && rows.length > 0 && (
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
                <th style={th}>{t('avail_supply_type', lang)}</th>
                <th style={th}>{t('sc_raw_condition', lang)}</th>
                <th style={th}>{t('sc_effective_status', lang)}</th>
                <th style={th}>{t('expiry', lang)}</th>
                <th style={th}>{t('last_upd', lang)}</th>
                {(canAdjustQuantity || canViewMovementHistory) && <th style={th}></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const eff = effOf(r);
                return (
                  <tr key={r.id}>
                    <td style={td} dir="auto">{dpNameOf(r, lang)}</td>
                    <td style={td} dir="auto">{r.scientific_name || '—'}</td>
                    <td style={td} dir="auto">{r.trade_name || '—'}</td>
                    <td style={td} dir="auto">{r.concentration || '—'}</td>
                    <td style={td} dir="auto">{r.dosage_form || '—'}</td>
                    <td style={td}>{r.quantity}</td>
                    <td style={td} dir="auto">{r.supply_type || '—'}</td>
                    <td style={td}>{r.condition ? t('cond_' + r.condition, lang) : '—'}</td>
                    <td style={td}><PhoenixStatusBadge variant={CANON_VARIANT[eff] ?? 'neutral'} label={t('cond_' + eff, lang)} /></td>
                    <td style={td} dir="ltr">{r.expiry_date || (r.expiry_bucket ? t('cond_' + (r.expiry_bucket === 'expired' ? 'expired' : 'near_expiry'), lang) : '—')}</td>
                    <td style={td} dir="ltr">{r.updated_at ? new Date(r.updated_at).toLocaleDateString(lang === 'ar' ? 'ar' : 'en') : '—'}</td>
                    {(canAdjustQuantity || canViewMovementHistory) && (
                      <td style={td}>
                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'nowrap' }}>
                          {canAdjustQuantity && (
                            <button
                              onClick={() => setAdjustRow(r)}
                              aria-label={t('sc_adjust_qty', lang)}
                              style={{ padding: '5px 10px', borderRadius: 'var(--r1)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t2)', fontSize: '11px', cursor: 'pointer', whiteSpace: 'nowrap' }}
                            >
                              ✏️ {t('sc_adjust_qty', lang)}
                            </button>
                          )}
                          {canViewMovementHistory && (
                            <button
                              onClick={() => setHistoryRow(r)}
                              aria-label={t('mvmt_history_action', lang)}
                              style={{ padding: '5px 10px', borderRadius: 'var(--r1)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t2)', fontSize: '11px', cursor: 'pointer', whiteSpace: 'nowrap' }}
                            >
                              🕘 {t('mvmt_history_action', lang)}
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

      <AdjustQuantityModal
        open={adjustRow !== null}
        row={adjustRow}
        lang={lang}
        myPermissions={myPermissions}
        onClose={() => setAdjustRow(null)}
        onSuccess={handleMovementSuccess}
      />
      <MovementHistoryModal
        open={historyRow !== null}
        row={historyRow}
        lang={lang}
        onClose={() => setHistoryRow(null)}
      />
      {movementToast && <PhoenixToast message={movementToast} />}

      {/* AVAILABILITY-MOVEMENT-REPORTS-PRINT-A: read-only, filterable
          quantity-movement report — hides itself when the caller lacks
          availability.movements.view (RLS remains the real enforcement). */}
      <MovementReportSection />

      {/* Material Exchange Command Center CTA */}
      <div style={{ marginTop: '28px', background: 'var(--p2)', border: '1px solid var(--p)', borderRadius: 'var(--r3)', padding: '18px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--pd)' }}>🔄 {t('material_exchange_center', lang)}</div>
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
