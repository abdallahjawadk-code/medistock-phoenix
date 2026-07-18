import { useState, useEffect, FormEvent } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import {
  getSession,
  exchangeCodeForSession,
  setSessionFromTokens,
  updatePassword as authUpdatePassword,
  signOut as authSignOut,
} from '@/shared/supabase/services/auth.service';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';

type RecoveryState = 'loading' | 'ready' | 'no_session' | 'done';

/**
 * Standalone password-reset screen. Shown when user arrives from a Supabase
 * reset email. This component manages its own session establishment — it does
 * NOT depend on AppContext session/profile state for the password update.
 *
 * Flow:
 *   1. On mount, detect ?code= (PKCE) or #access_token (implicit) in URL.
 *   2. Exchange code/tokens for a session explicitly.
 *   3. Once session exists, show the password form.
 *   4. On submit, call supabase.auth.updateUser({ password }) directly.
 *   5. After success, sign out and redirect to login.
 *
 * No profile loading, no org loading, no dashboard data.
 */
export function ResetPasswordScreen() {
  const { lang, theme, toggleLang, toggleTheme, clearRecovery } = useApp();
  const [state, setState]     = useState<RecoveryState>('loading');
  const [pw, setPw]           = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError]     = useState<string | null>(null);
  const [busy, setBusy]       = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function establish() {
      // Try 1: PKCE code in query string
      const params = new URLSearchParams(window.location.search);
      const code = params.get('code');
      if (code) {
        const s = await exchangeCodeForSession(code);
        if (!cancelled) {
          // Clean URL after exchange attempt
          window.history.replaceState(null, '', window.location.pathname);
          setState(s ? 'ready' : 'no_session');
        }
        return;
      }

      // Try 2: implicit hash tokens
      const hash = window.location.hash;
      if (hash.includes('access_token')) {
        const hp = new URLSearchParams(hash.replace('#', ''));
        const at = hp.get('access_token');
        const rt = hp.get('refresh_token');
        if (at && rt) {
          const s = await setSessionFromTokens(at, rt);
          if (!cancelled) {
            window.history.replaceState(null, '', window.location.pathname);
            setState(s ? 'ready' : 'no_session');
          }
          return;
        }
      }

      // Try 3: session already exists (Supabase auto-detected earlier)
      const existing = await getSession();
      if (!cancelled) {
        setState(existing ? 'ready' : 'no_session');
      }
    }
    establish();
    return () => { cancelled = true; };
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    // Re-check session right before update — don't rely on stale state
    const s = await getSession();
    if (!s) { setError(t('recovery_no_session', lang)); return; }

    if (pw.length < 8) { setError(t('password_short', lang)); return; }
    if (pw !== confirm) { setError(t('password_mismatch', lang)); return; }

    setBusy(true);
    const res = await authUpdatePassword(pw);
    setBusy(false);
    if (!res.ok) {
      if (res.error === 'NOT_CONFIGURED') setError(t('config_missing', lang));
      else if (res.error?.includes('expired') || res.error?.includes('invalid'))
        setError(t('recovery_link_expired', lang));
      else setError(t('recovery_failed', lang));
      return;
    }
    setState('done');
  }

  async function onBackToLogin() {
    await authSignOut();
    void clearRecovery();
  }

  return (
    <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '24px', position: 'relative' }}>
      <div style={{ position: 'absolute', top: '18px', insetInlineEnd: '18px', display: 'flex', gap: '8px' }}>
        <button onClick={toggleLang} style={{ padding: '5px 13px', borderRadius: 'var(--rpill)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>
          {lang === 'ar' ? 'EN' : 'عربي'}
        </button>
        <button onClick={toggleTheme} aria-label="Toggle theme" style={{ width: '34px', height: '34px', borderRadius: 'var(--rpill)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <PhoenixIcon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
        </button>
      </div>

      <div style={{ textAlign: 'center', marginBottom: '22px' }}>
        <div style={{ width: '64px', height: '64px', borderRadius: 'var(--r4)', background: 'var(--p)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px', color: '#fff' }}><PhoenixIcon name="lock" size={30} /></div>
        <h1 style={{ fontSize: '22px', fontWeight: 700, letterSpacing: '-.4px' }}>MediStock-Babil</h1>
      </div>

      <div style={{ width: '100%', maxWidth: '375px', background: 'var(--s)', borderRadius: 'var(--r5)', boxShadow: 'var(--sh-xl)', padding: '26px', border: '1px solid var(--brd)' }}>
        {state === 'done' ? (
          <div style={{ textAlign: 'center' }}>
            <div style={{ marginBottom: '12px', color: 'var(--ok)', display: 'flex', justifyContent: 'center' }}><PhoenixIcon name="check" size={38} /></div>
            <h2 style={{ fontSize: '16px', fontWeight: 700, marginBottom: '6px' }}>{t('reset_success', lang)}</h2>
            <p style={{ fontSize: '12.5px', color: 'var(--t2)', marginBottom: '18px' }}>{t('reset_success_msg', lang)}</p>
            <button onClick={onBackToLogin} style={{ width: '100%', padding: '13px', borderRadius: 'var(--r3)', border: 'none', background: 'var(--p)', color: '#fff', fontSize: '14px', fontWeight: 700, cursor: 'pointer' }}>
              {t('back_to_login', lang)}
            </button>
          </div>

        ) : state === 'loading' ? (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <div style={{ marginBottom: '12px', color: 'var(--p)', display: 'flex', justifyContent: 'center', animation: 'fl 1.5s ease-in-out infinite' }}><PhoenixIcon name="lock" size={30} /></div>
            <p style={{ fontSize: '13px', color: 'var(--t2)' }}>{t('recovery_verifying', lang)}</p>
          </div>

        ) : state === 'no_session' ? (
          <div style={{ textAlign: 'center', padding: '12px 0' }}>
            <div style={{ marginBottom: '12px', color: 'var(--err)', display: 'flex', justifyContent: 'center' }}><PhoenixIcon name="warning" size={30} /></div>
            <p style={{ fontSize: '13px', color: 'var(--err)', marginBottom: '18px' }} dir="auto">{t('recovery_no_session', lang)}</p>
            <button onClick={onBackToLogin} style={{ width: '100%', padding: '13px', borderRadius: 'var(--r3)', border: 'none', background: 'var(--p)', color: '#fff', fontSize: '14px', fontWeight: 700, cursor: 'pointer' }}>
              {t('back_to_login', lang)}
            </button>
          </div>

        ) : (
          <form onSubmit={onSubmit}>
            <h2 style={{ fontSize: '16px', fontWeight: 700, marginBottom: '4px' }}>{t('recovery_title', lang)}</h2>
            <p style={{ fontSize: '11.5px', color: 'var(--t2)', marginBottom: '18px' }}>{t('recovery_sub', lang)}</p>

            <label htmlFor="rp-new" style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: 'var(--t2)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: '6px' }}>{t('new_password', lang)}</label>
            <input id="rp-new" type="password" dir="ltr" autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)}
              style={{ width: '100%', padding: '11px 12px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: 'var(--s2)', color: 'var(--t)', fontSize: '13px', marginBottom: '14px' }} />

            <label htmlFor="rp-confirm" style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: 'var(--t2)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: '6px' }}>{t('confirm_password', lang)}</label>
            <input id="rp-confirm" type="password" dir="ltr" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)}
              style={{ width: '100%', padding: '11px 12px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: 'var(--s2)', color: 'var(--t)', fontSize: '13px', marginBottom: error ? '12px' : '18px' }} />

            {error && (
              <div role="alert" style={{ marginBottom: '16px', padding: '9px 12px', borderRadius: 'var(--r2)', background: 'var(--err2)', border: '1px solid var(--err)', color: 'var(--err)', fontSize: '12px', fontWeight: 600 }}>{error}</div>
            )}

            <button type="submit" disabled={busy} style={{ width: '100%', padding: '14px', borderRadius: 'var(--r3)', border: 'none', background: 'var(--p)', color: '#fff', fontSize: '15px', fontWeight: 700, cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.7 : 1, boxShadow: '0 4px 16px rgba(13,148,136,.3)' }}>
              {busy ? t('saving', lang) : t('set_password', lang)}
            </button>
            <button type="button" onClick={onBackToLogin} style={{ width: '100%', marginTop: '10px', padding: '8px', borderRadius: 'var(--r2)', border: 'none', background: 'transparent', color: 'var(--t2)', fontSize: '12px', cursor: 'pointer' }}>
              {t('back_to_login', lang)}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
