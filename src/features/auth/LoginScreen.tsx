import { useState, FormEvent } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';

export function LoginScreen() {
  const { lang, theme, toggleLang, toggleTheme, signIn, requestPasswordReset, configured } = useApp();
  const [mode, setMode]         = useState<'signin' | 'reset'>('signin');
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState<string | null>(null);
  const [busy, setBusy]         = useState(false);
  const [resetSent, setResetSent] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (mode === 'reset') {
      if (!email.trim()) { setError(t('email_required', lang)); return; }
      setBusy(true);
      const res = await requestPasswordReset(email);
      setBusy(false);
      if (!res.ok && res.error === 'NOT_CONFIGURED') { setError(t('config_missing', lang)); return; }
      // Always show the same confirmation (avoid leaking which emails exist).
      setResetSent(true);
      return;
    }

    if (!email.trim() || !password) {
      setError(t('email_required', lang));
      return;
    }
    setBusy(true);
    const res = await signIn(email, password);
    setBusy(false);
    if (!res.ok) {
      setError(res.error === 'NOT_CONFIGURED' ? t('config_missing', lang) : t('invalid_creds', lang));
    }
    // On success, AppContext's auth subscription swaps to the app shell.
  }

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
        <button onClick={toggleTheme} aria-label="Toggle theme" style={{ width: '34px', height: '34px', borderRadius: 'var(--rpill)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', fontSize: '15px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
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
      <form onSubmit={onSubmit} style={{ width: '100%', maxWidth: '375px', background: 'var(--s)', borderRadius: 'var(--r5)', boxShadow: 'var(--sh-xl)', padding: '26px', border: '1px solid var(--brd)', animation: 'fs .6s ease .12s both' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 700, marginBottom: '4px' }}>
          {mode === 'reset' ? t('reset_title', lang) : t('login_title', lang)}
        </h2>
        <p style={{ fontSize: '11.5px', color: 'var(--t2)', marginBottom: '18px' }}>
          {mode === 'reset' ? t('reset_sub', lang) : t('login_sub', lang)}
        </p>

        {!configured && (
          <div role="alert" style={{ marginBottom: '16px', padding: '10px 12px', borderRadius: 'var(--r2)', background: 'var(--warn2)', border: '1px solid var(--warn)', color: 'var(--warn)', fontSize: '11.5px', fontWeight: 600 }}>
            ⚠ {t('config_missing', lang)}
          </div>
        )}

        {mode === 'reset' && resetSent ? (
          <div style={{ textAlign: 'center', padding: '8px 0' }}>
            <div style={{ fontSize: '34px', marginBottom: '10px' }}>📧</div>
            <div style={{ fontSize: '14px', fontWeight: 700, marginBottom: '6px' }}>{t('reset_sent', lang)}</div>
            <p style={{ fontSize: '12px', color: 'var(--t2)', marginBottom: '16px' }}>{t('reset_sent_msg', lang)}</p>
            <button type="button" onClick={() => { setMode('signin'); setResetSent(false); setError(null); }} style={{ width: '100%', padding: '12px', borderRadius: 'var(--r3)', border: '1px solid var(--brd)', background: 'transparent', color: 'var(--t2)', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>
              {t('back_to_login', lang)}
            </button>
          </div>
        ) : (
          <>
            <label htmlFor="login-email" style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: 'var(--t2)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: '6px' }}>
              {t('email', lang)}
            </label>
            <input
              id="login-email" type="email" dir="ltr" autoComplete="username"
              value={email} onChange={e => setEmail(e.target.value)}
              style={{ width: '100%', padding: '11px 12px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: 'var(--s2)', color: 'var(--t)', fontSize: '13px', marginBottom: '14px' }}
            />

            {mode === 'signin' && (
              <>
                <label htmlFor="login-password" style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: 'var(--t2)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: '6px' }}>
                  {t('password', lang)}
                </label>
                <input
                  id="login-password" type="password" dir="ltr" autoComplete="current-password"
                  value={password} onChange={e => setPassword(e.target.value)}
                  style={{ width: '100%', padding: '11px 12px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: 'var(--s2)', color: 'var(--t)', fontSize: '13px', marginBottom: '8px' }}
                />
                <div style={{ textAlign: 'end', marginBottom: error ? '12px' : '18px' }}>
                  <button type="button" onClick={() => { setMode('reset'); setError(null); }} style={{ background: 'none', border: 'none', color: 'var(--p)', fontSize: '12px', fontWeight: 600, cursor: 'pointer', padding: 0 }}>
                    {t('forgot_password', lang)}
                  </button>
                </div>
              </>
            )}

            {error && (
              <div role="alert" style={{ marginBottom: '16px', padding: '9px 12px', borderRadius: 'var(--r2)', background: 'var(--err2)', border: '1px solid var(--err)', color: 'var(--err)', fontSize: '12px', fontWeight: 600 }}>
                {error}
              </div>
            )}

            <button
              type="submit" disabled={busy}
              style={{
                width: '100%', padding: '14px', borderRadius: 'var(--r3)',
                border: 'none', background: 'var(--p)', color: '#fff',
                fontSize: '15px', fontWeight: 700, cursor: busy ? 'wait' : 'pointer',
                opacity: busy ? 0.7 : 1, transition: 'all 150ms', boxShadow: '0 4px 16px rgba(13,148,136,.3)',
              }}
            >
              {mode === 'reset'
                ? (busy ? t('sending', lang) : t('send_reset', lang))
                : (busy ? t('signing_in', lang) : t('sign_in', lang))}
            </button>

            {mode === 'reset' && (
              <button type="button" onClick={() => { setMode('signin'); setError(null); }} style={{ width: '100%', marginTop: '10px', padding: '8px', borderRadius: 'var(--r2)', border: 'none', background: 'transparent', color: 'var(--t2)', fontSize: '12px', cursor: 'pointer' }}>
                {t('back_to_login', lang)}
              </button>
            )}
          </>
        )}

        {/* Trust badges */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '18px', justifyContent: 'center' }}>
          <span style={{ padding: '3px 9px', borderRadius: 'var(--rpill)', background: 'var(--ok2)', color: 'var(--ok)', fontSize: '10.5px', fontWeight: 600 }}>🛡 RLS</span>
          <span style={{ padding: '3px 9px', borderRadius: 'var(--rpill)', background: 'var(--p2)', color: 'var(--pd)', fontSize: '10.5px', fontWeight: 600 }}>📱 QR Public Safe</span>
          <span style={{ padding: '3px 9px', borderRadius: 'var(--rpill)', background: 'var(--warn2)', color: 'var(--warn)', fontSize: '10.5px', fontWeight: 600 }}>🔒 Intake Frozen</span>
        </div>
      </form>
    </div>
  );
}
