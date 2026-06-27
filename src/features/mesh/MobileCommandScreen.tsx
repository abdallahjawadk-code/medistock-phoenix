import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';

interface Props { onNavigate: (screen: number) => void; }

export function MobileCommandScreen({ onNavigate }: Props) {
  const { lang } = useApp();

  return (
    <div style={{ maxWidth: '420px', margin: '0 auto', animation: 'fs .3s ease' }}>
      <div style={{ marginBottom: '18px' }}>
        <h2 style={{ fontSize: '18px', fontWeight: 700, letterSpacing: '-.3px' }}>{t('nav_mobile', lang)}</h2>
        <p style={{ fontSize: '12.5px', color: 'var(--t2)', marginTop: '3px' }}>{t('mobile_sub', lang)}</p>
      </div>

      {/* Compact health ring + metrics */}
      <PhoenixCard shadow="md" padding="20px" style={{ marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '16px' }}>
        <svg width="72" height="72" viewBox="0 0 72 72" style={{ flexShrink: 0 }} aria-label="Health Score">
          <circle cx="36" cy="36" r="30" fill="none" stroke="var(--brd)" strokeWidth="6" />
          <circle cx="36" cy="36" r="30" fill="none" stroke="var(--p)" strokeWidth="6" strokeDasharray="188.5" strokeDashoffset="28" strokeLinecap="round" transform="rotate(-90 36 36)" />
          <text x="36" y="40" textAnchor="middle" fontSize="16" fontWeight="700" fill="var(--t)">85%</text>
        </svg>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '13px', fontWeight: 700, marginBottom: '8px' }}>{t('m_bridge', lang)}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', fontSize: '11.5px' }}>
            <div style={{ padding: '6px 8px', background: 'var(--ok2)',   borderRadius: 'var(--r1)', color: 'var(--ok)',   fontWeight: 600, textAlign: 'center' }}>1248 {t('avail', lang)}</div>
            <div style={{ padding: '6px 8px', background: 'var(--warn2)', borderRadius: 'var(--r1)', color: 'var(--warn)', fontWeight: 600, textAlign: 'center' }}>42 {t('low', lang)}</div>
            <div style={{ padding: '6px 8px', background: 'var(--err2)',  borderRadius: 'var(--r1)', color: 'var(--err)',  fontWeight: 600, textAlign: 'center' }}>8 {t('miss', lang)}</div>
            <div style={{ padding: '6px 8px', background: 'var(--s2)',    borderRadius: 'var(--r1)', color: 'var(--t2)',   fontWeight: 600, textAlign: 'center' }}>4 {t('m_inst', lang)}</div>
          </div>
        </div>
      </PhoenixCard>

      {/* Alert */}
      <PhoenixCard padding="14px" border="1px solid var(--warn)" style={{ borderInlineStart: '4px solid var(--warn)', marginBottom: '14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
          <span style={{ fontSize: '16px' }}>⚠️</span>
          <span style={{ fontSize: '13px', fontWeight: 700 }}>{t('safemode', lang)}: {t('hilla', lang)}</span>
        </div>
        <p style={{ fontSize: '12px', color: 'var(--t2)' }}>{t('safemode_desc', lang)}</p>
        <button
          onClick={() => onNavigate(7)}
          style={{ marginTop: '10px', padding: '7px 14px', borderRadius: 'var(--r2)', border: 'none', background: 'var(--warn2)', color: 'var(--warn)', fontSize: '12px', fontWeight: 600, cursor: 'pointer', transition: 'all 120ms' }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--warn)'; (e.currentTarget as HTMLButtonElement).style.color = '#fff'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--warn2)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--warn)'; }}
        >
          {t('view_health', lang)}
        </button>
      </PhoenixCard>

      {/* Quick entry */}
      <PhoenixCard padding="16px" style={{ marginBottom: '14px' }}>
        <h3 style={{ fontSize: '13px', fontWeight: 700, marginBottom: '12px' }}>{t('quick_entry', lang)}</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <select style={{ width: '100%', padding: '10px 12px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', fontSize: '13px' }} aria-label={t('m_inst', lang)}>
            {['marjan', 'babil', 'mahawil'].map(k => <option key={k}>{t(k, lang)}</option>)}
          </select>
          <input type="text" placeholder={t('search', lang)} style={{ width: '100%', padding: '10px 12px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', fontSize: '13px' }} aria-label={t('item', lang)} />
          <input type="number" placeholder={t('qty', lang)} style={{ width: '100%', padding: '10px 12px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', fontSize: '13px' }} aria-label={t('qty', lang)} />
        </div>
      </PhoenixCard>

      {/* QR status quick view */}
      <PhoenixCard padding="14px" style={{ marginBottom: '80px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
          <h3 style={{ fontSize: '13px', fontWeight: 700 }}>{t('nav_qr', lang)}</h3>
          <button onClick={() => onNavigate(6)} style={{ padding: '5px 10px', borderRadius: 'var(--r1)', border: '1px solid var(--brd)', background: 'transparent', color: 'var(--t2)', fontSize: '11px', cursor: 'pointer' }}>
            {t('view', lang)}
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px' }}>
          {[
            { k: 'marjan',  badge: '● Active', v: 'ok' },
            { k: 'hilla',   badge: '⚠ Limited', v: 'warn' },
            { k: 'babil',   badge: '● Active', v: 'ok' },
            { k: 'mahawil', badge: '● Active', v: 'ok' },
          ].map(item => (
            <div key={item.k} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span>{t(item.k, lang)}</span>
              <span style={{ padding: '2px 7px', borderRadius: 'var(--rpill)', background: `var(--${item.v}2)`, color: `var(--${item.v})`, fontWeight: 600, fontSize: '10.5px' }}>
                {item.badge}
              </span>
            </div>
          ))}
        </div>
      </PhoenixCard>

      {/* Sticky CTA */}
      <button
        onClick={() => onNavigate(3)}
        style={{
          position: 'fixed', bottom: 'calc(var(--bnh) + 12px)',
          insetInlineStart: '50%', transform: 'translateX(-50%)',
          padding: '13px 28px', borderRadius: 'var(--rpill)',
          border: 'none', background: 'var(--p)', color: '#fff',
          fontSize: '14px', fontWeight: 700, whiteSpace: 'nowrap',
          boxShadow: '0 4px 16px rgba(13,148,136,.4)',
          cursor: 'pointer', zIndex: 80,
        }}
      >
        ✏️ {t('nav_editor', lang)}
      </button>
    </div>
  );
}
