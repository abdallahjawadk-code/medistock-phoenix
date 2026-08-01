import { useState, type FormEvent } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { resolveLoginIdentifier } from '@/shared/lib/username';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import { MediStockMark } from '@/shared/ui/MediStockMark';
import { AuthSupplyHero } from '@/shared/ui/AuthSupplyHero';

export function LoginScreen() {
  const { lang, theme, toggleLang, toggleTheme, signIn, requestPasswordReset, configured } = useApp();
  const [mode, setMode] = useState<'signin' | 'reset'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  // Local-username accounts have no deliverable email — show guidance instead
  // of calling the reset API (LOCAL-CREDENTIALS-MODE-A, Part G).
  const [localResetNote, setLocalResetNote] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (mode === 'reset') {
      if (!email.trim()) {
        setError(t('email_required', lang));
        return;
      }
      if (!email.includes('@')) {
        setLocalResetNote(true);
        return;
      }
      setBusy(true);
      const res = await requestPasswordReset(email);
      setBusy(false);
      if (!res.ok && res.error === 'NOT_CONFIGURED') {
        setError(t('config_missing', lang));
        return;
      }
      // Always show the same confirmation (avoid leaking which emails exist).
      setResetSent(true);
      return;
    }

    if (!email.trim() || !password) {
      setError(t('email_required', lang));
      return;
    }
    setBusy(true);
    // Bare usernames resolve to the synthetic internal auth email. Whether a
    // username exists is never revealed — same generic error either way.
    const res = await signIn(resolveLoginIdentifier(email), password);
    setBusy(false);
    if (!res.ok) {
      setError(res.error === 'NOT_CONFIGURED' ? t('config_missing', lang) : t('invalid_creds', lang));
    }
  }

  const backToLogin = () => {
    setMode('signin');
    setResetSent(false);
    setLocalResetNote(false);
    setError(null);
  };

  return (
    <div className="premium-login nexus-login">
      <div className="nexus-login__controls">
        <button onClick={toggleLang} className="nexus-control nexus-control--language">
          {lang === 'ar' ? 'EN' : 'عربي'}
        </button>
        <button
          onClick={toggleTheme}
          className="nexus-control"
          aria-label={theme === 'dark' ? 'Activate light theme' : 'Activate dark theme'}
        >
          <PhoenixIcon name={theme === 'dark' ? 'sun' : 'moon'} size={17} />
        </button>
      </div>

      {/* Two-column layout: the form panel stays on the LEFT; a light,
          institutional supply-network illustration (original SVG, no image
          asset, no Phoenix bird) dominates the RIGHT art panel — the "Premium
          Living Pharmaceutical Supply" identity from the approved reference
          board. Being the first in-flow child, this panel resolves to the
          inline-start (physical right) column under RTL. */}
      <section className="nexus-login__art" aria-label={lang === 'ar' ? 'شبكة الإمداد الدوائي المؤسسية' : 'Institutional medicine supply network'}>
        <AuthSupplyHero className="nexus-login__hero" priority />
        <div className="nexus-login__art-caption">
          <div className="nexus-login__kicker">MEDISTOCK PHOENIX</div>
          <h1>
            {lang === 'ar'
              ? 'منظومة الإمداد الدوائي — من قسم الصيدلة إلى منفذ الصرف.'
              : 'Medication Supply Network — From the Pharmacy Department to the Dispensing Point.'}
          </h1>
          <p className="nexus-login__art-lede" dir="auto">
            {lang === 'ar'
              ? 'متابعة مؤسسية واحدة لحركة الدواء عبر مخازن قسم الصيدلة والمستشفيات ومنافذ الصرف.'
              : 'One institutional view of medicine moving through pharmacy-department stores, hospitals and dispensing points.'}
          </p>
          <div className="nexus-login__trust-row">
            <span><PhoenixIcon name="lock" size={14} /> {lang === 'ar' ? 'تدفق آمن' : 'Secure flow'}</span>
            <span><PhoenixIcon name="network" size={14} /> {lang === 'ar' ? 'شبكة مترابطة' : 'Connected network'}</span>
            <span><PhoenixIcon name="status" size={14} /> {lang === 'ar' ? 'تتبع تشغيلي' : 'Operational tracking'}</span>
          </div>
        </div>
      </section>

      <main className="nexus-login__auth">
        <div className="nexus-login__brand">
          <div className="nexus-brand-mark nexus-login__brand-mark">
            <MediStockMark size={44} title="" />
          </div>
          <div>
            <div className="nexus-login__brand-name">MediStock-Babil Phoenix</div>
            <div className="nexus-login__brand-department" dir="auto">{t('login_department_subtitle', lang)}</div>
          </div>
        </div>

        <form className="nexus-login__card" onSubmit={onSubmit}>
          <div className="nexus-login__card-heading">
            <span className="nexus-login__secure-icon"><PhoenixIcon name="lock" size={18} /></span>
            <div>
              <h2>{mode === 'reset' ? t('reset_title', lang) : t('login_title', lang)}</h2>
              <p>{mode === 'reset' ? t('reset_sub', lang) : t('login_sub', lang)}</p>
            </div>
          </div>

          {!configured && (
            <div className="nexus-login__notice nexus-login__notice--warning" role="alert">
              <PhoenixIcon name="warning" size={17} />
              <span>{t('config_missing', lang)}</span>
            </div>
          )}

          {mode === 'reset' && localResetNote ? (
            <div className="nexus-login__state">
              <span className="nexus-login__state-icon"><PhoenixIcon name="key" size={28} /></span>
              <p dir="auto">{t('login_local_reset_note', lang)}</p>
              <button type="button" onClick={backToLogin} className="nexus-login__secondary">
                {t('back_to_login', lang)}
              </button>
            </div>
          ) : mode === 'reset' && resetSent ? (
            <div className="nexus-login__state">
              <span className="nexus-login__state-icon"><PhoenixIcon name="mail" size={28} /></span>
              <h3>{t('reset_sent', lang)}</h3>
              <p>{t('reset_sent_msg', lang)}</p>
              <button type="button" onClick={backToLogin} className="nexus-login__secondary">
                {t('back_to_login', lang)}
              </button>
            </div>
          ) : (
            <>
              <label htmlFor="login-email" className="nexus-login__label">
                {t('login_identifier', lang)}
              </label>
              <div className="nexus-login__field-wrap">
                <PhoenixIcon name="account" size={17} />
                <input
                  id="login-email"
                  type="text"
                  dir="ltr"
                  autoComplete="username"
                  className="premium-field nexus-login__field"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                />
              </div>

              {mode === 'signin' && (
                <>
                  <label htmlFor="login-password" className="nexus-login__label">
                    {t('password', lang)}
                  </label>
                  <div className="nexus-login__field-wrap">
                    <PhoenixIcon name="lock" size={17} />
                    <input
                      id="login-password"
                      type="password"
                      dir="ltr"
                      autoComplete="current-password"
                      className="premium-field nexus-login__field"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                    />
                  </div>
                  <div className="nexus-login__forgot">
                    <button type="button" onClick={() => { setMode('reset'); setError(null); }}>
                      {t('forgot_password', lang)}
                    </button>
                  </div>
                </>
              )}

              {error && (
                <div className="nexus-login__notice nexus-login__notice--error" role="alert">
                  <PhoenixIcon name="warning" size={17} />
                  <span>{error}</span>
                </div>
              )}

              <button type="submit" disabled={busy} className="nexus-login__submit premium-focus-ring">
                <span>
                  {mode === 'reset'
                    ? (busy ? t('sending', lang) : t('send_reset', lang))
                    : (busy ? t('signing_in', lang) : t('sign_in', lang))}
                </span>
                <PhoenixIcon name={mode === 'reset' ? 'mail' : 'lock'} size={17} />
              </button>

              {mode === 'reset' && (
                <button type="button" onClick={backToLogin} className="nexus-login__back">
                  {t('back_to_login', lang)}
                </button>
              )}
            </>
          )}

          {/* RIGHTS-SEAL-SCOPE: the MASAR seal is deliberately ABSENT from the
              login screen — the single seal lives in the authenticated shell
              footer.
              PHASE3-LIVING-INTERFACE-CREDIT-REMOVAL-A: the supervision-credit
              line naming the supervising pharmacist, and its rights block,
              have been intentionally removed from this screen — a later,
              explicit product decision that supersedes the prior "stays"
              note. */}
        </form>
      </main>
    </div>
  );
}
