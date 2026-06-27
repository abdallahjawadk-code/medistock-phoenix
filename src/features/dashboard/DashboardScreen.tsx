import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixMetricCard } from '@/shared/ui/PhoenixMetricCard';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';

const INSTITUTIONS = [
  { code: 'marjan',  labelKey: 'marjan',  status: 'ok',   statusKey: 'healthy',  avail: 342, low: 8,  miss: 1,  pct: 94, border: undefined },
  { code: 'hilla',   labelKey: 'hilla',   status: 'warn', statusKey: 'safemode', avail: 291, low: 18, miss: 4,  pct: 71, border: '1px solid var(--warn)' },
  { code: 'babil',   labelKey: 'babil',   status: 'ok',   statusKey: 'healthy',  avail: 412, low: 7,  miss: 2,  pct: 97, border: undefined },
  { code: 'mahawil', labelKey: 'mahawil', status: 'ok',   statusKey: 'healthy',  avail: 203, low: 9,  miss: 1,  pct: 88, border: undefined },
];

const ALERTS = [
  { type: 'warn', text: 'Amoxicillin 500mg — ', typeKey: 'm_low', where: 'hilla', sub: '12 units' },
  { type: 'err',  text: 'Insulin Glargine — ',  typeKey: 'm_miss', where: 'hilla,mahawil', sub: '' },
  { type: 'warn', text: 'Ceftriaxone 1g — ',    typeKey: 'm_exp', where: 'marjan', sub: 'expires30' },
  { type: 'info', text: '', typeKey: 'safemode', where: 'hilla', sub: 'safemode_desc' },
];

interface Props { onNavigate: (screen: number) => void; }

export function DashboardScreen({ onNavigate }: Props) {
  const { lang } = useApp();
  const isMobile = window.innerWidth < 768;

  return (
    <div style={{ maxWidth: '1200px', animation: 'fs .3s ease' }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px', marginBottom: '22px' }}>
        <div>
          <h2 style={{ fontSize: isMobile ? '18px' : '22px', fontWeight: 700, letterSpacing: '-.3px' }}>{t('nav_dash', lang)}</h2>
          <p style={{ fontSize: '12.5px', color: 'var(--t2)', marginTop: '3px' }}>{t('dash_sub', lang)}</p>
        </div>
        <button
          onClick={() => onNavigate(3)}
          style={{ padding: '10px 16px', borderRadius: 'var(--r3)', border: 'none', background: 'var(--p)', color: '#fff', fontSize: '13px', fontWeight: 600, cursor: 'pointer', transition: 'all 120ms', whiteSpace: 'nowrap' }}
        >
          ✏️ {t('nav_editor', lang)}
        </button>
      </div>

      {/* Metric cards — 4-col desktop, 2-col mobile */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: isMobile ? '10px' : '14px', marginBottom: isMobile ? '20px' : '28px' }}>
        <PhoenixMetricCard icon="🏥" value={4}      label={t('m_inst', lang)}  badge="+1"   badgeVariant="ok"   iconBg="var(--p2)" />
        <PhoenixMetricCard icon="💊" value="1,248"  label={t('m_avail', lang)} badge="↑12%" badgeVariant="ok"   iconBg="var(--ok2)" />
        <PhoenixMetricCard icon="⚠️" value={42}     label={t('m_low', lang)}   badge="↑3"   badgeVariant="warn" iconBg="var(--warn2)" valueColor="var(--warn)" />
        <PhoenixMetricCard icon="❌" value={8}      label={t('m_miss', lang)}                                  iconBg="var(--err2)"  valueColor="var(--err)" />
        <PhoenixMetricCard icon="⏱️" value={15}     label={t('m_exp', lang)}                                   iconBg="var(--warn2)" valueColor="var(--warn)" />
        <PhoenixMetricCard icon="🌐" value="7/7"    label={t('m_bridge', lang)} badge="98%" badgeVariant="ok"  iconBg="var(--p2)"    valueColor="var(--p)" />
        <PhoenixMetricCard icon="🛡️" value={2}      label={t('m_safe', lang)}                                  iconBg="var(--warn2)" valueColor="var(--warn)" />
        <PhoenixMetricCard icon="🕐" value="14:32"  label={t('m_upd', lang)}                                   iconBg="var(--info2)" />
      </div>

      {/* Institution status cards */}
      <h3 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '12px' }}>{t('inst_status', lang)}</h3>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(2, 1fr)', gap: '12px', marginBottom: isMobile ? '20px' : '28px' }}>
        {INSTITUTIONS.map(inst => (
          <PhoenixCard
            key={inst.code}
            onClick={() => onNavigate(5)}
            hover
            padding="16px"
            border={inst.border ?? '1px solid var(--brd)'}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '11px' }}>
              <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: `var(--${inst.status})`, flexShrink: 0 }} />
              <span style={{ fontSize: '12.5px', fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {t(inst.labelKey, lang)}
              </span>
              <PhoenixStatusBadge
                variant={inst.status === 'ok' ? 'ok' : 'warn'}
                label={t(inst.statusKey, lang)}
              />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px', textAlign: 'center', marginBottom: '10px' }}>
              <div>
                <div style={{ fontSize: '15px', fontWeight: 700 }}>{inst.avail}</div>
                <div style={{ fontSize: '10px', color: 'var(--t2)' }}>{t('avail', lang)}</div>
              </div>
              <div>
                <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--warn)' }}>{inst.low}</div>
                <div style={{ fontSize: '10px', color: 'var(--t2)' }}>{t('low', lang)}</div>
              </div>
              <div>
                <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--err)' }}>{inst.miss}</div>
                <div style={{ fontSize: '10px', color: 'var(--t2)' }}>{t('miss', lang)}</div>
              </div>
            </div>
            <div style={{ height: '3px', background: 'var(--brd)', borderRadius: 'var(--rpill)', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${inst.pct}%`, background: inst.status === 'warn' ? 'var(--warn)' : 'var(--p)', borderRadius: 'var(--rpill)' }} />
            </div>
          </PhoenixCard>
        ))}
      </div>

      {/* Alerts + Quick Actions */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '16px' }}>
        {/* Alerts */}
        <div>
          <h3 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '12px' }}>{t('alerts', lang)}</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {ALERTS.map((a, i) => (
              <div key={i} style={{ background: 'var(--s)', borderRadius: 'var(--r3)', padding: '13px', border: '1px solid var(--brd)', borderInlineStart: `3px solid var(--${a.type === 'info' ? 'info' : a.type})` }}>
                <div style={{ fontSize: '12.5px', fontWeight: 600, marginBottom: '3px' }}>
                  {a.type === 'warn' ? '⚠️' : a.type === 'err' ? '❌' : a.type === 'info' ? '🛡️' : '⏱️'} {a.text}{t(a.typeKey, lang)}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--t2)' }}>
                  {t(a.where.split(',')[0], lang)}{a.where.includes(',') ? ` · ${t(a.where.split(',')[1], lang)}` : ''}{a.sub && a.sub !== 'safemode_desc' ? ` · ${a.sub}` : ''}{a.sub === 'safemode_desc' ? ` · ${t('safemode_desc', lang)}` : ''}{a.sub === 'expires30' ? ` · ${t('expires30', lang)}` : ''}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Quick actions */}
        <div>
          <h3 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '12px' }}>{t('quick', lang)}</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
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
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--s2)'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--p)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--s)'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--brd)'; }}
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
      </div>
    </div>
  );
}
