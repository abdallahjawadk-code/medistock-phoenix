import { useMemo } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';
import type { CanonicalStatus } from '@/shared/lib/status/canonical';

/**
 * AVAILABILITY-ALERTS-QR-POLISH-B
 *
 * Groups the SAME already-filtered rows StatusCenterScreen's table renders
 * into per-outlet (distribution point) cards — an additional display mode,
 * not a replacement. Filters/search/export/print/row-actions all continue
 * to operate on the existing flat table; this component is purely a
 * read-only alternate view of identical data. No distribution-point id is
 * ever rendered — only its display name.
 */

export interface OutletGroupRow {
  distribution_points: { id: string; name: string; name_ar: string } | null;
  scientific_name: string | null;
  trade_name: string | null;
  concentration: string | null;
  dosage_form: string | null;
  quantity: number;
  effective_status?: CanonicalStatus;
  condition?: string | null;
}

const CANON_VARIANT: Record<CanonicalStatus, 'ok' | 'warn' | 'err' | 'neutral'> = {
  available: 'ok', surplus: 'ok', low_stock: 'warn', near_expiry: 'warn', missing: 'err', expired: 'err',
};

function effOf(r: OutletGroupRow): CanonicalStatus {
  return (r.effective_status ?? (r.condition as CanonicalStatus | undefined) ?? 'available');
}

interface Props {
  rows: OutletGroupRow[];
}

export function OutletMaterialGroups({ rows }: Props) {
  const { lang } = useApp();

  const groups = useMemo(() => {
    const byPoint = new Map<string, { name: string; nameAr: string; rows: OutletGroupRow[] }>();
    for (const r of rows) {
      const dp = r.distribution_points;
      const key = dp?.id ?? '—';
      if (!byPoint.has(key)) byPoint.set(key, { name: dp?.name ?? '—', nameAr: dp?.name_ar ?? '—', rows: [] });
      byPoint.get(key)!.rows.push(r);
    }
    return Array.from(byPoint.values()).sort((a, b) => (lang === 'ar' ? a.nameAr : a.name).localeCompare(lang === 'ar' ? b.nameAr : b.name));
  }, [rows, lang]);

  if (groups.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '40px', color: 'var(--t2)', fontSize: '13px' }}>
        {t('sc_outlet_empty', lang)}
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '12px' }}>
      {groups.map(g => (
        <PhoenixCard key={lang === 'ar' ? g.nameAr : g.name} padding="14px">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '10px' }}>
            <span style={{ fontSize: '13.5px', fontWeight: 700 }} dir="auto">📦 {lang === 'ar' ? g.nameAr : g.name}</span>
            <span style={{ fontSize: '10.5px', color: 'var(--t2)' }}>{g.rows.length}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {g.rows.map((r, i) => {
              const eff = effOf(r);
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', paddingBottom: '8px', borderBottom: i < g.rows.length - 1 ? '1px solid var(--brd)' : 'none' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: '12px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} dir="auto">
                      {r.scientific_name || '—'}
                    </div>
                    <div style={{ fontSize: '10.5px', color: 'var(--t2)' }}>
                      {[r.concentration, r.dosage_form].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                    <span style={{ fontSize: '11.5px', color: 'var(--t2)' }}>{r.quantity}</span>
                    <PhoenixStatusBadge variant={CANON_VARIANT[eff] ?? 'neutral'} label={t('cond_' + eff, lang)} />
                  </div>
                </div>
              );
            })}
          </div>
        </PhoenixCard>
      ))}
    </div>
  );
}
