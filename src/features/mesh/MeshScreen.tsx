import { useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { getInstitutionOverviews, type InstitutionOverview } from '@/shared/supabase/services/dashboard.service';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';

interface Props { onNavigate: (screen: number) => void; }

export function MeshScreen({ onNavigate }: Props) {
  const { lang } = useApp();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const isMobile = window.innerWidth < 768;

  const { data, loading, error, reload } = useAsync(() => getInstitutionOverviews(), []);
  const nodes = data ?? [];
  const selected = nodes.find(n => n.id === selectedId) ?? null;

  const warnOf = (n: InstitutionOverview) => n.missing > 0 || n.low > 5;
  const pctOf = (n: InstitutionOverview) => {
    const total = n.available + n.low + n.missing;
    return total > 0 ? Math.round((n.available / total) * 100) : 0;
  };

  return (
    <div style={{ maxWidth: '1100px', animation: 'fs .3s ease' }}>
      <div style={{ marginBottom: '20px' }}>
        <h2 style={{ fontSize: '22px', fontWeight: 700, letterSpacing: '-.3px' }}>{t('nav_mesh', lang)}</h2>
        <p style={{ fontSize: '12.5px', color: 'var(--t2)', marginTop: '3px' }}>{t('mesh_sub', lang)}</p>
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '20px' }}>
        {[{ c: 'ok', k: 'healthy' }, { c: 'warn', k: 'safemode' }].map(item => (
          <span key={item.k} style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11.5px' }}>
            <span style={{ width: '9px', height: '9px', borderRadius: '50%', background: `var(--${item.c})`, display: 'inline-block' }} />
            {t(item.k, lang)}
          </span>
        ))}
      </div>

      {loading && <PhoenixLoadingState label={t('loading', lang)} />}
      {!loading && error && <PhoenixErrorState title={t('load_error', lang)} message={error} onRetry={reload} />}
      {!loading && !error && nodes.length === 0 && <PhoenixEmptyState icon="🌐" title={t('empty_orgs', lang)} description={t('empty_hint', lang)} />}

      {!loading && !error && nodes.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : (selected ? '1fr 280px' : '1fr'), gap: '16px', alignItems: 'start' }}>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(min(100%, 220px), 1fr))', gap: '10px' }}>
            {nodes.map(n => {
              const warn = warnOf(n);
              const dot = warn ? 'var(--warn)' : 'var(--ok)';
              const isSel = selectedId === n.id;
              return (
                <PhoenixCard key={n.id} onClick={() => setSelectedId(s => s === n.id ? null : n.id)} hover padding="14px" border={isSel ? `2px solid ${dot}` : (warn ? '1px solid var(--warn)' : '1px solid var(--brd)')}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '8px' }}>
                    <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: dot, flexShrink: 0 }} />
                    <span style={{ fontSize: '12px', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{lang === 'ar' ? n.name_ar : n.name}</span>
                    {warn && <PhoenixStatusBadge variant="warn" label={t('safemode', lang)} />}
                  </div>
                  <div style={{ fontSize: '10.5px', color: 'var(--t2)' }}>{n.available} {t('avail', lang)} · {n.low} {t('low', lang)}</div>
                  <div style={{ marginTop: '7px', height: '3px', background: 'var(--brd)', borderRadius: 'var(--rpill)', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${pctOf(n)}%`, background: dot, borderRadius: 'var(--rpill)' }} />
                  </div>
                </PhoenixCard>
              );
            })}
          </div>

          {selected && (
            <PhoenixCard shadow="md" padding="18px" style={{ animation: 'fs .25s ease' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px' }}>
                <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: warnOf(selected) ? 'var(--warn)' : 'var(--ok)', flexShrink: 0 }} />
                <h3 style={{ fontSize: '14px', fontWeight: 700, flex: 1 }}>{lang === 'ar' ? selected.name_ar : selected.name}</h3>
                <PhoenixStatusBadge variant={warnOf(selected) ? 'warn' : 'ok'} label={t(warnOf(selected) ? 'safemode' : 'healthy', lang)} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '12.5px' }}>
                {[
                  { label: 'avail', val: selected.available, color: undefined },
                  { label: 'low',   val: selected.low,   color: 'var(--warn)' },
                  { label: 'miss',  val: selected.missing,  color: 'var(--err)' },
                ].map((row, i, arr) => (
                  <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: i < arr.length - 1 ? '1px solid var(--brd)' : undefined }}>
                    <span style={{ color: 'var(--t2)' }}>{t(row.label, lang)}</span>
                    <strong style={{ color: row.color }}>{row.val}</strong>
                  </div>
                ))}
              </div>
              <PhoenixButton variant="primary" size="md" fullWidth style={{ marginTop: '14px' }} onClick={() => onNavigate(3)}>
                ✏️ {t('nav_editor', lang)}
              </PhoenixButton>
            </PhoenixCard>
          )}
        </div>
      )}
    </div>
  );
}
