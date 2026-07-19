import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import { usePwaInstallPrompt } from './usePwaInstallPrompt';

/**
 * PWA-INSTALL-PROMPT-A
 *
 * Small, dismissible, non-blocking install banner. Renders nothing when the
 * app is already standalone/installed, when there is nothing actionable
 * (no native prompt and not likely iOS Safari), or when the user dismissed
 * it within the last 7 days (see usePwaInstallPrompt). Mounted only inside
 * the authenticated app shell (PhoenixAppShell) — never on the login screen
 * or the anonymous public QR view, since those are rendered before/without
 * the shell entirely.
 */

interface Props {
  isMobile: boolean;
}

export function PwaInstallPrompt({ isMobile }: Props) {
  const { lang } = useApp();
  const { canInstallNative, showIosInstructions, dismiss, promptInstall } = usePwaInstallPrompt();

  if (!canInstallNative && !showIosInstructions) return null;

  return (
    <div
      className="premium-pwa-install"
      data-placement={isMobile ? 'mobile' : 'desktop'}
      role="region"
      aria-label={t('pwa_install_eyebrow', lang)}
    >
      <div className="premium-pwa-install__icon" aria-hidden="true"><PhoenixIcon name="medical" size={22} /></div>
      <div className="premium-pwa-install__body">
        <div className="premium-pwa-install__title">{t('pwa_install_title', lang)}</div>
        <div className="premium-pwa-install__desc">
          {canInstallNative ? t('pwa_install_description', lang) : t('pwa_install_ios_instruction', lang)}
        </div>
      </div>
      <div className="premium-pwa-install__actions">
        {canInstallNative && (
          <button
            type="button"
            className="premium-pwa-install__install premium-focus-ring"
            onClick={() => { void promptInstall(); }}
          >
            {t('pwa_install_install', lang)}
          </button>
        )}
        <button
          type="button"
          className="premium-pwa-install__dismiss premium-focus-ring"
          onClick={dismiss}
          aria-label={t('pwa_install_dismiss_label', lang)}
        >
          {canInstallNative ? t('pwa_install_later', lang) : '✕'}
        </button>
      </div>
    </div>
  );
}
