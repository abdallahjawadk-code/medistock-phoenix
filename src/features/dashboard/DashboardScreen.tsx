import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import {
  getDashboardMetrics,
  getInstitutionOverviews,
} from '@/shared/supabase/services/dashboard.service';
import { PhoenixMetricCard } from '@/shared/ui/PhoenixMetricCard';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';

interface Props { onNavigate: (screen: number) => void; }

export function DashboardScreen({ onNavigate }: Props) {
  const { lang, activeOrgId, configured } = useApp();
  const isMobile = window.innerWidth < 768;

  const metrics = useAsync(() => getDashboardMetrics(activeOrgId ?? undefined), [activeOrgId]);
  const insts   = useAsync(() => getInstitutionOverviews(), []);

  const m = metrics.data;

  return (
    <div style={{ maxWidth: '1200px', animation: 'fs .3s ease' }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px', marginBottom: '22px' }}>
        <div>
          <h2 style={{ fontSize: isMobile ? '18px' : '22px', fontWeight: 700, letterSpacing: '-.3px' }}>{t('nav_dash', lang)}</h2>
          <p style={{ fontSize: '12.5px', color: 'var(--t2)', marginTop: '3px' }}>
            {m ? `${t('m_upd', lang)}: ${m.lastUpdated}` : t('dash_sub', lang)}
          </p>
        </div>
        <button
          onClick={() => onNavigate(3)}
          style={{ padding: '10px 16px', borderRadius: 'var(--r3)', border: 'none', background: 'var(--p)', color: '#fff', fontSize: '13px', fontWeight: 600, cursor: 'pointer', transition: 'all 120ms', whiteSpace: 'nowrap' }}
        >
          ✏️ {t('nav_editor', lang)}
        </button>
      </div>

      {!configured && (
        <div role="status" style={{ marginBottom: '18px', padding: '10px 14px', borderRadius: 'var(--r3)', background: 'var(--warn2)', border: '1px solid var(--warn)', color: 'var(--warn)', fontSize: '12px', fontWeight: 600 }}>
          ⚠ {t('config_msg', lang)}
        </div>
      )}

      {/* Metric cards */}
      {metrics.loading && <PhoenixLoadingState label={t('loading', lang)} />}
      {!metrics.loading && metrics.error && (
        <PhoenixErrorState title={t('load_error', lang)} message={metrics.error} onRetry={metrics.reload} />
      )}
      {!metrics.loading && !metrics.error && m && (
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: isMobile ? '10px' : '14px', marginBottom: isMobile ? '20px' : '28px' }}>
          <PhoenixMetricCard icon="🏥" value={m.activeInstitutions} label={t('m_inst', lang)}  iconBg="var(--p2)" />
          <PhoenixMetricCard icon="💊" value={m.availableItems}     label={t('m_avail', lang)} iconBg="var(--ok2)" />
          <PhoenixMetricCard icon="⚠️" value={m.lowStockCount}      label={t('m_low', lang)}   iconBg="var(--warn2)" valueColor="var(--warn)" />
          <PhoenixMetricCard icon="❌" value={m.missingCount}       label={t('m_miss', lang)}  iconBg="var(--err2)"  valueColor="var(--err)" />
          <PhoenixMetricCard icon="⏱️" value={m.nearExpiryCount}    label={t('m_exp', lang)}   iconBg="var(--warn2)" valueColor="var(--warn)" />
          <PhoenixMetricCard icon="🌐" value={`${m.bridgeHealth.healthy}/${m.bridgeHealth.total}`} label={t('m_bridge', lang)} iconBg="var(--p2)" valueColor="var(--p)" />
          <PhoenixMetricCard icon="🛡️" value={m.safeModeModules}    label={t('m_safe', lang)}  iconBg="var(--warn2)" valueColor="var(--warn)" />
          <PhoenixMetricCard icon="🕐" value={m.lastUpdated}        label={t('m_upd', lang)}   iconBg="var(--info2)" />
        </div>
      )}

      {/* Institution status cards */}
      <h3 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '12px' }}>{t('inst_status', lang)}</h3>
      {insts.loading && <PhoenixLoadingState label={t('loading', lang)} />}
      {!insts.loading && insts.error && (
        <PhoenixErrorState title={t('load_error', lang)} message={insts.error} onRetry={insts.reload} />
      )}
      {!insts.loading && !insts.error && insts.data && insts.data.length === 0 && (
        <PhoenixEmptyState icon="🏥" title={t('empty_orgs', lang)} description={t('empty_hint', lang)} />
      )}
      {!insts.loading && !insts.error && insts.data && insts.data.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(2, 1fr)', gap: '12px', marginBottom: isMobile ? '20px' : '28px' }}>
          {insts.data.map(inst => {
            const warn = inst.missing > 0 || inst.low > 5;
            const total = inst.available + inst.low + inst.missing;
            const pct = total > 0 ? Math.round((inst.available / total) * 100) : 0;
            return (
              <PhoenixCard
                key={inst.id}
                onClick={() => onNavigate(5)}
                hover
                padding="16px"
                border={warn ? '1px solid var(--warn)' : '1px solid var(--brd)'}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '11px' }}>
                  <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: warn ? 'var(--warn)' : 'var(--ok)', flexShrink: 0 }} />
                  <span style={{ fontSize: '12.5px', fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {lang === 'ar' ? inst.name_ar : inst.name}
                  </span>
                  <PhoenixStatusBadge variant={warn ? 'warn' : 'ok'} label={t(warn ? 'safemode' : 'healthy', lang)} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px', textAlign: 'center', marginBottom: '10px' }}>
                  <div><div style={{ fontSize: '15px', fontWeight: 700 }}>{inst.available}</div><div style={{ fontSize: '10px', color: 'var(--t2)' }}>{t('avail', lang)}</div></div>
                  <div><div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--warn)' }}>{inst.low}</div><div style={{ fontSize: '10px', color: 'var(--t2)' }}>{t('low', lang)}</div></div>
                  <div><div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--err)' }}>{inst.missing}</div><div style={{ fontSize: '10px', color: 'var(--t2)' }}>{t('miss', lang)}</div></div>
                </div>
                <div style={{ height: '3px', background: 'var(--brd)', borderRadius: 'var(--rpill)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${pct}%`, background: warn ? 'var(--warn)' : 'var(--p)', borderRadius: 'var(--rpill)' }} />
                </div>
              </PhoenixCard>
            );
          })}
        </div>
      )}

      {/* Quick actions */}
      <h3 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '12px' }}>{t('quick', lang)}</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxWidth: isMobile ? undefined : '480px' }}>
        {[
          { screen: 3, icon: '✏️', labelKey: 'nav_editor', descKey: 'editor_desc' },
          { screen: 7, icon: '🏥', labelKey: 'nav_health', descKey: 'health_desc' },
          { screen: 9, icon: '📈', labelKey: 'nav_reports', descKey: 'reports_desc' },
        ].map(item => (
          <button
            key={item.screen}
            onClick={() => onNavigate(item.screen)}
            style={{
              display: 'flex', alignItems: 'center', gap: '12px',
              padding: '13px 14px', borderRadius: 'var(--r3)',
              border: '1px solid var(--brd)', background: 'var(--s)',
              color: 'var(--t)', textAlign: 'start', width: '100%',
              cursor: 'pointer', transition: 'all 120ms',
            }}
          >
            <span style={{ fontSize: '20px', flexShrink: 0 }}>{item.icon}</span>
            <div>
              <div style={{ fontSize: '12.5px', fontWeight: 600 }}>{t(item.labelKey, lang)}</div>
              <div style={{ fontSize: '11px', color: 'var(--t2)', marginTop: '2px' }}>{t(item.descKey, lang)}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
