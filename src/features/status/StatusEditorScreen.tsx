import { useState, useMemo } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { getAvailabilityByOrg } from '@/shared/supabase/services/availability.service';
import { getPointsByOrg } from '@/shared/supabase/services/warehouses.service';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixOrgScope } from '@/shared/ui/PhoenixOrgScope';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';

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

  function exportCsv() {
    const isAr = lang === 'ar';
    const headers = [
      isAr ? 'المنفذ' : 'Port',
      isAr ? 'الاسم العلمي' : 'Scientific Name',
      isAr ? 'الاسم التجاري' : 'Trade Name',
      isAr ? 'الشكل الدوائي' : 'Dosage Form',
      isAr ? 'التركيز' : 'Concentration',
      isAr ? 'الكمية' : 'Quantity',
      isAr ? 'الموقف' : 'Status',
      isAr ? 'رقم الدفعة' : 'Batch No.',
      isAr ? 'تاريخ الانتهاء' : 'Expiry',
      isAr ? 'نوع التجهيز' : 'Supply Type',
      isAr ? 'السعر' : 'Price',
    ];

    const rows = filtered.map((r: OrgAvailRow) => [
      dpName(r),
      r.scientific_name ?? '',
      r.trade_name ?? '',
      r.dosage_form ?? '',
      r.concentration ?? '',
      r.quantity ?? 0,
      r.condition ? t('cond_' + r.condition, lang) : '',
      r.batch_number ?? '',
      r.expiry_date ?? '',
      r.supply_type ?? '',
      r.price ?? '',
    ]);

    const bom = '﻿';
    const csv = bom + [headers, ...rows].map(row => row.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `status_editor_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const fieldStyle = { padding: '8px 10px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', fontSize: '13px' } as const;

  const thStyle = { padding: '8px 10px', textAlign: 'start' as const, fontSize: '11px', fontWeight: 700, color: 'var(--t2)', borderBottom: '2px solid var(--brd)', whiteSpace: 'nowrap' as const };
  const tdStyle = { padding: '8px 10px', fontSize: '12.5px', borderBottom: '1px solid var(--brd)', verticalAlign: 'top' as const };

  return (
    <div style={{ maxWidth: '1200px', animation: 'fs .3s ease' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px', marginBottom: '20px' }}>
        <div>
          <h2 style={{ fontSize: '22px', fontWeight: 700, letterSpacing: '-.3px' }}>{t('nav_status_editor', lang)}</h2>
          <p style={{ fontSize: '12.5px', color: 'var(--t2)', marginTop: '3px' }}>{t('se_sub', lang)}</p>
        </div>
        <PhoenixOrgScope />
      </div>

      {!activeOrgId && <PhoenixEmptyState icon="📊" title={t('no_org_scope', lang)} description={t('empty_hint', lang)} />}

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

              <div style={{ display: 'flex', gap: '6px', marginInlineStart: 'auto' }}>
                <button onClick={exportCsv} style={{ padding: '7px 14px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', fontSize: '12px', cursor: 'pointer' }}>
                  {t('se_export_excel', lang)}
                </button>
                <button onClick={() => window.print()} style={{ padding: '7px 14px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', fontSize: '12px', cursor: 'pointer' }}>
                  {t('se_export_pdf', lang)}
                </button>
                <button onClick={() => window.print()} style={{ padding: '7px 14px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', fontSize: '12px', cursor: 'pointer' }}>
                  {t('se_print', lang)}
                </button>
              </div>
            </div>
          </PhoenixCard>

          {/* Data table */}
          {records.loading ? (
            <p style={{ textAlign: 'center', color: 'var(--t2)', padding: '40px 0' }}>{t('loading', lang)}</p>
          ) : filtered.length === 0 ? (
            <PhoenixEmptyState icon="📊" title={t('se_no_records', lang)} description={t('empty_hint', lang)} />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', background: 'var(--s)', borderRadius: 'var(--r2)' }}>
                <thead>
                  <tr>
                    <th style={thStyle}>{t('se_filter_port', lang)}</th>
                    <th style={thStyle}>{t('avail_scientific_name', lang)}</th>
                    <th style={thStyle}>{t('avail_trade_name', lang)}</th>
                    <th style={thStyle}>{t('avail_dosage_form', lang)}</th>
                    <th style={thStyle}>{t('avail_concentration', lang)}</th>
                    <th style={thStyle}>{t('qty', lang)}</th>
                    <th style={thStyle}>{t('avail_material_status', lang)}</th>
                    <th style={thStyle}>{t('batch_no', lang)}</th>
                    <th style={thStyle}>{t('expiry', lang)}</th>
                    <th style={thStyle}>{t('avail_supply_type', lang)}</th>
                    <th style={thStyle}>{t('avail_price', lang)}</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r: OrgAvailRow) => (
                    <tr key={r.id}>
                      <td style={tdStyle}>{dpName(r)}</td>
                      <td style={tdStyle} dir="auto">{r.scientific_name ?? '—'}</td>
                      <td style={tdStyle} dir="auto">{r.trade_name ?? '—'}</td>
                      <td style={tdStyle} dir="auto">{r.dosage_form ?? '—'}</td>
                      <td style={tdStyle} dir="auto">{r.concentration ?? '—'}</td>
                      <td style={tdStyle}>{r.quantity ?? 0}</td>
                      <td style={tdStyle}>{r.condition ? t('cond_' + r.condition, lang) : '—'}</td>
                      <td style={tdStyle} dir="ltr">{r.batch_number ?? '—'}</td>
                      <td style={tdStyle} dir="ltr">{r.expiry_date ?? '—'}</td>
                      <td style={tdStyle} dir="auto">{r.supply_type ?? '—'}</td>
                      <td style={tdStyle} dir="ltr">{r.price != null ? r.price : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
