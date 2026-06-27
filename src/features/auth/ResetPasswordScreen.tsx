import { useState, FormEvent } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';

/**
 * Set-new-password screen, shown when the user arrives from a Supabase
 * password-reset email (recovery session active). Supabase Auth only —
 * no service key, no secrets, no password is logged or persisted by us.
 */
export function ResetPasswordScreen() {
  const { lang, theme, toggleLang, toggleTheme, updatePassword, clearRecovery } = useApp();
  const [pw, setPw]         = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError]   = useState<string | null>(null);
  const [busy, setBusy]     = useState(false);
  const [done, setDone]     = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (pw.length < 8) { setError(t('password_short', lang)); return; }
    if (pw !== confirm) { setError(t('password_mismatch', lang)); return; }

    setBusy(true);
    const res = await updatePassword(pw);
    setBusy(false);
    if (!res.ok) {
      setError(res.error === 'NOT_CONFIGURED' ? t('config_missing', lang) : t('load_error', lang));
      return;
    }
    setDone(true);
  }

  return (
    <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '24px', position: 'relative' }}>
      <div style={{ position: 'absolute', top: '18px', insetInlineEnd: '18px', display: 'flex', gap: '8px' }}>
        <button onClick={toggleLang} style={{ padding: '5px 13px', borderRadius: 'var(--rpill)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>
          {lang === 'ar' ? 'EN' : 'عربي'}
        </button>
        <button onClick={toggleTheme} aria-label="Toggle theme" style={{ width: '34px', height: '34px', borderRadius: 'var(--rpill)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', fontSize: '15px', cursor: 'pointer' }}>
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
      </div>

      <div style={{ textAlign: 'center', marginBottom: '22px' }}>
        <div style={{ width: '64px', height: '64px', borderRadius: 'var(--r4)', background: 'var(--p)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px', fontSize: '30px' }}>🔐</div>
        <h1 style={{ fontSize: '22px', fontWeight: 700, letterSpacing: '-.4px' }}>MediStock-Babil</h1>
      </div>

      <div style={{ width: '100%', maxWidth: '375px', background: 'var(--s)', borderRadius: 'var(--r5)', boxShadow: 'var(--sh-xl)', padding: '26px', border: '1px solid var(--brd)' }}>
        {done ? (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '36px', marginBottom: '12px' }}>✅</div>
            <h2 style={{ fontSize: '16px', fontWeight: 700, marginBottom: '6px' }}>{t('reset_success', lang)}</h2>
            <p style={{ fontSize: '12.5px', color: 'var(--t2)', marginBottom: '18px' }}>{t('reset_success_msg', lang)}</p>
            <button onClick={() => { void clearRecovery(); }} style={{ width: '100%', padding: '13px', borderRadius: 'var(--r3)', border: 'none', background: 'var(--p)', color: '#fff', fontSize: '14px', fontWeight: 700, cursor: 'pointer' }}>
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
            <button type="button" onClick={() => { void clearRecovery(); }} style={{ width: '100%', marginTop: '10px', padding: '8px', borderRadius: 'var(--r2)', border: 'none', background: 'transparent', color: 'var(--t2)', fontSize: '12px', cursor: 'pointer' }}>
              {t('back_to_login', lang)}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
