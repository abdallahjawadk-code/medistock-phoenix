import { useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { getLocalItems } from '@/shared/supabase/services/registry.service';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';
import { PhoenixOrgScope } from '@/shared/ui/PhoenixOrgScope';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixScreenHeader } from '@/shared/ui/PhoenixScreenHeader';
import { PhoenixNotice } from '@/shared/ui/PhoenixNotice';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';

interface CentralRef { name: string; name_ar: string; unit: string; barcode?: string; category?: string; }
interface LocalRow {
  id: string;
  local_code: string | null;
  local_name: string | null;
  status: string;
  central_items: CentralRef | CentralRef[] | null;
}

function central(row: LocalRow): CentralRef | null {
  const c = row.central_items;
  if (!c) return null;
  return Array.isArray(c) ? c[0] ?? null : c;
}

export function RegistryScreen() {
  const { lang, activeOrgId } = useApp();
  const [search, setSearch] = useState('');

  const { data, loading, error, reload } = useAsync(
    () => activeOrgId ? getLocalItems(activeOrgId) : Promise.resolve([]),
    [activeOrgId],
  );

  const rows = (data ?? []) as unknown as LocalRow[];
  const filtered = rows.filter(row => {
    const c = central(row);
    const q = search.toLowerCase();
    return !search ||
      (c?.name ?? '').toLowerCase().includes(q) ||
      (c?.name_ar ?? '').includes(search) ||
      (row.local_code ?? '').toLowerCase().includes(q);
  });

  return (
    <div className="premium-page nexus-registry-page" style={{ maxWidth: '1000px', animation: 'fs .3s ease' }}>
      <PhoenixScreenHeader
        icon="status"
        eyebrow={lang === 'ar' ? 'PHOENIX REGISTRY · سجل موحّد' : 'PHOENIX REGISTRY · UNIFIED CATALOG'}
        title={t('nav_reg', lang)}
        description={t('reg_sub', lang)}
        actions={<PhoenixOrgScope />}
      />

      {/* Scope notice */}
      <PhoenixNotice>{t('scope_note', lang)}</PhoenixNotice>

      {/* Search */}
      <div style={{ position: 'relative', marginBottom: '18px' }}>
        <span style={{ position: 'absolute', insetInlineStart: '12px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--t3)' }}><PhoenixIcon name="search" size={16} /></span>
        <input
          type="search"
          placeholder={t('search', lang)}
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ width: '100%', padding: '10px 12px', paddingInlineStart: '38px', borderRadius: 'var(--r3)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', fontSize: '13px' }}
          aria-label={t('search', lang)}
        />
      </div>

      {!activeOrgId && (
        <PhoenixEmptyState icon="institutions" title={t('no_org_scope', lang)} description={t('empty_hint', lang)} />
      )}
      {activeOrgId && loading && <PhoenixLoadingState label={t('loading', lang)} />}
      {activeOrgId && !loading && error && (
        <PhoenixErrorState title={t('load_error', lang)} message={error} onRetry={reload} />
      )}
      {activeOrgId && !loading && !error && filtered.length === 0 && (
        <PhoenixEmptyState icon="status" title={t('empty_items', lang)} description={t('empty_hint', lang)} />
      )}

      {activeOrgId && !loading && !error && filtered.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 280px), 1fr))', gap: '12px' }}>
          {filtered.map(row => {
            const c = central(row);
            const isActive = row.status === 'active';
            return (
              <PhoenixCard key={row.id} hover padding="16px" style={{ opacity: isActive ? 1 : 0.65 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px', marginBottom: '10px' }}>
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: 700 }}>{c?.name ?? row.local_name ?? '—'}</div>
                    <div style={{ fontSize: '11px', color: 'var(--t2)' }}>{c?.name_ar ?? ''}</div>
                  </div>
                  <PhoenixStatusBadge variant={isActive ? 'ok' : 'neutral'} label={t(isActive ? 'active' : 'inactive', lang)} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', fontSize: '11.5px' }}>
                  <div><span style={{ color: 'var(--t2)' }}>{t('lcode', lang)}:</span> <span dir="ltr" style={{ fontFamily: 'monospace', fontWeight: 600 }}>{row.local_code ?? '—'}</span></div>
                  <div><span style={{ color: 'var(--t2)' }}>{t('unit', lang)}:</span> {c?.unit ?? '—'}</div>
                  {c?.category && <div style={{ gridColumn: '1/-1' }}><span style={{ color: 'var(--t2)' }}>{t('cat', lang)}:</span> {c.category}</div>}
                  {c?.barcode && <div style={{ gridColumn: '1/-1' }}><span style={{ color: 'var(--t2)' }}>Barcode:</span> <span dir="ltr">{c.barcode}</span></div>}
                </div>
              </PhoenixCard>
            );
          })}
        </div>
      )}
    </div>
  );
}
