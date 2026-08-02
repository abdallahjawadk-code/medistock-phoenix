import { useMemo } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';
import type { CanonicalStatus } from '@/shared/lib/status/canonical';

/**
 * AVAILABILITY-ALERTS-QR-POLISH-B / -C
 *
 * Groups the SAME already-filtered rows StatusCenterScreen's table renders
 * into per-outlet (distribution point) cards — an additional display mode,
 * not a replacement. Filters/search/export/print/row-actions all continue
 * to operate on the existing flat table; this component is purely a
 * read-only alternate view of identical data. No distribution-point id is
 * ever rendered — only its display name.
 *
 * -C polish: a per-outlet "needs attention" count (missing/low_stock rows
 * within that outlet's own already-grouped rows — no new data source),
 * a clearer card header, and tighter row/badge alignment.
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

/**
 * BUGFIX-OUTLET-MATERIAL-NAME-NOT-SHOWN-A: scientific_name is the primary
 * identity field on item_availability (the current write path always sets
 * it), but fall back to trade_name and a translated placeholder rather than
 * a bare "—" for the rare row where even that is missing.
 */
function outletGroupRowTitle(r: OutletGroupRow, lang: 'ar' | 'en'): string {
  return r.scientific_name?.trim() || r.trade_name?.trim() || t('avail_unnamed_material', lang);
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
      <div className="nexus-outlet-groups-empty" style={{ textAlign: 'center', padding: '40px 12px', color: 'var(--t2)' }}>
        <div style={{ marginBottom: '6px', opacity: 0.6, color: 'var(--t3)' }}><PhoenixIcon name="package" size={26} /></div>
        <div style={{ fontSize: '13px' }}>{t('sc_outlet_empty', lang)}</div>
      </div>
    );
  }

  return (
    <div className="nexus-outlet-groups" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '12px' }}>
      {groups.map(g => {
        const attentionCount = g.rows.filter(r => {
          const eff = effOf(r);
          return eff === 'missing' || eff === 'low_stock';
        }).length;
        return (
          <PhoenixCard key={lang === 'ar' ? g.nameAr : g.name} className={`nexus-outlet-group-card${attentionCount > 0 ? ' nexus-outlet-group-card--attention' : ''}`} padding="14px" hover>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '10px', paddingBottom: '10px', borderBottom: '1px solid var(--brd)' }}>
              <span style={{ fontSize: '13.5px', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} dir="auto"><PhoenixIcon name="package" size={13} inline /> {lang === 'ar' ? g.nameAr : g.name}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                {attentionCount > 0 && (
                  <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--warn)', background: 'var(--warn2)', border: '1px solid var(--warn)', borderRadius: 'var(--rpill)', padding: '2px 8px' }}>
                    {t('sc_outlet_needs_attention', lang)}: {attentionCount}
                  </span>
                )}
                <span style={{ fontSize: '10.5px', color: 'var(--t2)' }}>{g.rows.length} {t('sc_outlet_items_count', lang)}</span>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {g.rows.map((r, i) => {
                const eff = effOf(r);
                return (
                  <div key={i} className="nexus-outlet-group-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', paddingBottom: '8px', borderBottom: i < g.rows.length - 1 ? '1px solid var(--brd)' : 'none' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: '12px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} dir="auto">
                        {outletGroupRowTitle(r, lang)}
                      </div>
                      <div style={{ fontSize: '10.5px', color: 'var(--t2)' }}>
                        {[r.concentration, r.dosage_form].filter(Boolean).join(' · ') || '—'}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                      <span style={{ fontSize: '11.5px', color: 'var(--t2)' }}>{r.quantity}</span>
                      <PhoenixStatusBadge variant={CANON_VARIANT[eff] ?? 'neutral'} label={t('cond_' + eff, lang)} />
                    </div>
                  </div>
                );
              })}
            </div>
          </PhoenixCard>
        );
      })}
    </div>
  );
}
