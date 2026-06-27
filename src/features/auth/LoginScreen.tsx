import { CSSProperties } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import type { Role } from '@/shared/lib/types';

interface Props { onLogin: () => void; }

const ROLES: Array<{ id: Role; icon: string }> = [
  { id: 'super_admin',    icon: '🔑' },
  { id: 'hospital_admin', icon: '🏥' },
  { id: 'pharmacist',     icon: '💊' },
  { id: 'viewer',         icon: '👁' },
];

export function LoginScreen({ onLogin }: Props) {
  const { lang, theme, role, setRole, toggleLang, toggleTheme } = useApp();

  const rc = (r: Role): CSSProperties => ({
    borderColor: role === r ? 'var(--p)' : 'var(--brd)',
    background:  role === r ? 'var(--p2)' : 'var(--s2)',
  });

  return (
    <div style={{
      minHeight: '100dvh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      padding: '24px', position: 'relative', overflow: 'hidden',
    }}>
      {/* Animated background blobs */}
      <div aria-hidden="true" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', top: '7%', insetInlineStart: '9%', width: '150px', height: '150px', borderRadius: '50%', background: 'var(--p2)', opacity: .45, animation: 'fl 7s ease-in-out infinite' }} />
        <div style={{ position: 'absolute', top: '16%', insetInlineEnd: '7%', width: '95px', height: '95px', borderRadius: '50%', background: 'var(--sec2)', opacity: .4, animation: 'fl 9s ease-in-out infinite 2s' }} />
        <div style={{ position: 'absolute', bottom: '13%', insetInlineStart: '6%', width: '72px', height: '72px', borderRadius: '50%', background: 'var(--p2)', opacity: .35, animation: 'fl 8s ease-in-out infinite 1s' }} />
        <div style={{ position: 'absolute', bottom: '17%', insetInlineEnd: '10%', width: '115px', height: '115px', borderRadius: '50%', background: 'var(--ok2)', opacity: .3, animation: 'fl 10s ease-in-out infinite 3s' }} />
      </div>

      {/* Lang / Theme controls */}
      <div style={{ position: 'absolute', top: '18px', insetInlineEnd: '18px', display: 'flex', gap: '8px', zIndex: 10 }}>
        <button onClick={toggleLang} style={{ padding: '5px 13px', borderRadius: 'var(--rpill)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>
          {lang === 'ar' ? 'EN' : 'عربي'}
        </button>
        <button onClick={toggleTheme} style={{ width: '34px', height: '34px', borderRadius: 'var(--rpill)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', fontSize: '15px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
      </div>

      {/* Brand */}
      <div style={{ textAlign: 'center', marginBottom: '26px', animation: 'fs .5s ease' }}>
        <div style={{ width: '74px', height: '74px', borderRadius: 'var(--r4)', background: 'var(--p)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px', boxShadow: '0 8px 28px rgba(13,148,136,.35)', fontSize: '36px' }}>⚕</div>
        <h1 style={{ fontSize: '25px', fontWeight: 700, color: 'var(--t)', letterSpacing: '-.4px', marginBottom: '5px' }}>MediStock-Babil</h1>
        <p style={{ fontSize: '12.5px', color: 'var(--t2)' }}>{t('tagline', lang)}</p>
      </div>

      {/* Card */}
      <div style={{ width: '100%', maxWidth: '375px', background: 'var(--s)', borderRadius: 'var(--r5)', boxShadow: 'var(--sh-xl)', padding: '26px', border: '1px solid var(--brd)', animation: 'fs .6s ease .12s both' }}>

        {/* Role chips */}
        <p style={{ fontSize: '10.5px', fontWeight: 700, color: 'var(--t2)', textTransform: 'uppercase', letterSpacing: '.6px', marginBottom: '10px' }}>
          {t('selectRole', lang)}
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '18px' }}>
          {ROLES.map(r => (
            <button
              key={r.id}
              onClick={() => setRole(r.id)}
              style={{
                padding: '9px 6px', borderRadius: 'var(--r2)',
                border: `2px solid ${role === r.id ? 'var(--p)' : 'var(--brd)'}`,
                background: role === r.id ? 'var(--p2)' : 'var(--s2)',
                color: 'var(--t)', fontSize: '11px', fontWeight: 600,
                transition: 'all 120ms', lineHeight: 1.4, textAlign: 'center', cursor: 'pointer',
                ...rc(r.id),
              }}
            >
              {r.icon}<br />{r.id}
            </button>
          ))}
        </div>

        {/* Trust badges */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '20px' }}>
          <span style={{ padding: '3px 9px', borderRadius: 'var(--rpill)', background: 'var(--ok2)', color: 'var(--ok)', fontSize: '10.5px', fontWeight: 600 }}>🛡 RLS Protected</span>
          <span style={{ padding: '3px 9px', borderRadius: 'var(--rpill)', background: 'var(--p2)', color: 'var(--pd)', fontSize: '10.5px', fontWeight: 600 }}>📱 QR Public Safe</span>
          <span style={{ padding: '3px 9px', borderRadius: 'var(--rpill)', background: 'var(--warn2)', color: 'var(--warn)', fontSize: '10.5px', fontWeight: 600 }}>🔒 Intake Frozen</span>
        </div>

        {/* CTA */}
        <button
          onClick={onLogin}
          style={{
            width: '100%', padding: '14px', borderRadius: 'var(--r3)',
            border: 'none', background: 'var(--p)', color: '#fff',
            fontSize: '15px', fontWeight: 700, cursor: 'pointer',
            transition: 'all 150ms', boxShadow: '0 4px 16px rgba(13,148,136,.3)',
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLButtonElement).style.background = 'var(--pd)';
            (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-1px)';
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLButtonElement).style.background = 'var(--p)';
            (e.currentTarget as HTMLButtonElement).style.transform = '';
          }}
        >
          {t('demoLogin', lang)}
        </button>
        <p style={{ textAlign: 'center', fontSize: '11px', color: 'var(--t3)', marginTop: '11px' }}>
          {t('demoOnly', lang)}
        </p>
      </div>

      <div style={{ marginTop: '18px', padding: '5px 13px', borderRadius: 'var(--rpill)', background: 'var(--warn2)', border: '1px solid var(--warn)', color: 'var(--warn)', fontSize: '11px', fontWeight: 700 }}>
        ⚠ {t('demoData', lang)}
      </div>
    </div>
  );
}
