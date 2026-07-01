import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { getDashboardMetrics, getInstitutionOverviews } from '@/shared/supabase/services/dashboard.service';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';

interface Props { onNavigate: (screen: number) => void; }

export function MobileCommandScreen({ onNavigate }: Props) {
  const { lang, activeOrgId } = useApp();
  const metrics = useAsync(() => getDashboardMetrics(activeOrgId ?? undefined), [activeOrgId]);
  const insts   = useAsync(() => getInstitutionOverviews(), []);
  const m = metrics.data;

  const totalForRing = m ? m.availableItems + m.lowStockCount + m.missingCount : 0;
  const pct = m && totalForRing > 0 ? Math.round((m.availableItems / totalForRing) * 100) : 0;
  const dash = 188.5;
  const offset = dash - (dash * pct) / 100;

  return (
    <div style={{ maxWidth: '420px', margin: '0 auto', animation: 'fs .3s ease' }}>
      <div style={{ marginBottom: '18px' }}>
        <h2 style={{ fontSize: '18px', fontWeight: 700, letterSpacing: '-.3px' }}>{t('nav_mobile', lang)}</h2>
        <p style={{ fontSize: '12.5px', color: 'var(--t2)', marginTop: '3px' }}>{t('mobile_sub', lang)}</p>
      </div>

      {metrics.loading && <PhoenixLoadingState label={t('loading', lang)} />}
      {!metrics.loading && metrics.error && <PhoenixErrorState title={t('load_error', lang)} message={metrics.error} onRetry={metrics.reload} />}

      {!metrics.loading && !metrics.error && m && (
        <PhoenixCard shadow="md" padding="20px" style={{ marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '16px' }}>
          <svg width="72" height="72" viewBox="0 0 72 72" style={{ flexShrink: 0 }} aria-label="Availability score">
            <circle cx="36" cy="36" r="30" fill="none" stroke="var(--brd)" strokeWidth="6" />
            <circle cx="36" cy="36" r="30" fill="none" stroke="var(--p)" strokeWidth="6" strokeDasharray={dash} strokeDashoffset={offset} strokeLinecap="round" transform="rotate(-90 36 36)" />
            <text x="36" y="40" textAnchor="middle" fontSize="16" fontWeight="700" fill="var(--t)">{pct}%</text>
          </svg>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '13px', fontWeight: 700, marginBottom: '8px' }}>{t('m_avail', lang)}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', fontSize: '11.5px' }}>
              <div style={{ padding: '6px 8px', background: 'var(--ok2)',   borderRadius: 'var(--r1)', color: 'var(--ok)',   fontWeight: 600, textAlign: 'center' }}>{m.availableItems} {t('avail', lang)}</div>
              <div style={{ padding: '6px 8px', background: 'var(--warn2)', borderRadius: 'var(--r1)', color: 'var(--warn)', fontWeight: 600, textAlign: 'center' }}>{m.lowStockCount} {t('low', lang)}</div>
              <div style={{ padding: '6px 8px', background: 'var(--err2)',  borderRadius: 'var(--r1)', color: 'var(--err)',  fontWeight: 600, textAlign: 'center' }}>{m.missingCount} {t('miss', lang)}</div>
              <div style={{ padding: '6px 8px', background: 'var(--s2)',    borderRadius: 'var(--r1)', color: 'var(--t2)',   fontWeight: 600, textAlign: 'center' }}>{m.activeInstitutions} {t('m_inst', lang)}</div>
            </div>
          </div>
        </PhoenixCard>
      )}

      {/* Institution QR/status quick view */}
      <PhoenixCard padding="14px" style={{ marginBottom: '80px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
          <h3 style={{ fontSize: '13px', fontWeight: 700 }}>{t('inst_status', lang)}</h3>
          <button onClick={() => onNavigate(6)} style={{ padding: '5px 10px', borderRadius: 'var(--r1)', border: '1px solid var(--brd)', background: 'transparent', color: 'var(--t2)', fontSize: '11px', cursor: 'pointer' }}>{t('view', lang)}</button>
        </div>
        {insts.loading && <PhoenixLoadingState label={t('loading', lang)} />}
        {!insts.loading && insts.error && <PhoenixErrorState title={t('load_error', lang)} message={insts.error} onRetry={insts.reload} />}
        {!insts.loading && !insts.error && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px' }}>
            {(insts.data ?? []).map(o => {
              const warn = o.missing > 0 || o.low > 5;
              return (
                <div key={o.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{lang === 'ar' ? o.name_ar : o.name}</span>
                  <span style={{ padding: '2px 7px', borderRadius: 'var(--rpill)', background: warn ? 'var(--warn2)' : 'var(--ok2)', color: warn ? 'var(--warn)' : 'var(--ok)', fontWeight: 600, fontSize: '10.5px' }}>
                    {warn ? `⚠ ${o.low + o.missing}` : `● ${t('healthy', lang)}`}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </PhoenixCard>

      {/* AVAILABILITY-EDITOR-VISIBLE-ENTRYPOINTS-HIDE-B: the sticky floating
          action button to the Availability Editor (screen 3, nav_editor) was
          removed — no visible entry point to manual input remains on this
          screen. Other mobile command features above are unchanged. */}
    </div>
  );
}
