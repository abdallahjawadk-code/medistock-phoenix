import { useEffect, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';

interface Props {
  lastLoadedAt: Date | null;
  refreshing: boolean;
  nearExpiryDays: number;
}

/**
 * RAC-3 — system status built only from state this client actually holds.
 *
 * There is no backend health telemetry in this platform, so this strip reports
 * none. It deliberately shows no uptime, no latency, no database health
 * percentage and no service-status lights: every one of those would be a
 * fabricated instrument reading, and a dashboard that invents green lights is
 * worse than one that shows nothing.
 *
 * What it does report is real and locally verifiable: browser connectivity from
 * `navigator.onLine`, the timestamp of the payload currently on screen, whether
 * a refresh is in flight, and the near-expiry policy window the contract itself
 * declared. Scope is deliberately NOT repeated here — the header states it
 * directly above, and saying it twice is noise, not reinforcement.
 */
export function SystemStatusStrip({ lastLoadedAt, refreshing, nearExpiryDays }: Props) {
  const { lang } = useApp();
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  const time = lastLoadedAt
    ? new Intl.DateTimeFormat(lang === 'ar' ? 'ar-IQ' : 'en-US', {
        hour: '2-digit',
        minute: '2-digit',
      }).format(lastLoadedAt)
    : null;

  return (
    <div className="rac3-status" role="status">
      <span className={`rac3-status__item rac3-status__item--${online ? 'ok' : 'warn'}`}>
        <span className="rac3-status__dot" aria-hidden="true" />
        {t(online ? 'rac3_status_online' : 'rac3_status_offline', lang)}
      </span>

      {refreshing ? (
        <span className="rac3-status__item">
          <PhoenixIcon name="refresh" size={13} />
          {t('rac3_status_refreshing', lang)}
        </span>
      ) : time ? (
        <span className="rac3-status__item">
          <PhoenixIcon name="clock" size={13} />
          {t('rac3_status_updated', lang)} <span dir="ltr">{time}</span>
        </span>
      ) : null}

      <span className="rac3-status__item rac3-status__item--muted">
        {t('rac3_status_near_expiry_policy', lang).replace('{days}', String(nearExpiryDays))}
      </span>
    </div>
  );
}
