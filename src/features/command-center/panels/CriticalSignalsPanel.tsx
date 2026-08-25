import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import type { CriticalSignal } from '../command-center.model';

interface Props {
  signals: CriticalSignal[];
  /** Rendered only when the contract reported `alerts_view`. */
  onOpenAlerts?: () => void;
}

/**
 * RAC-3 — the urgent states, above the fold.
 *
 * These are derived from the SAME authorized payload the rest of the screen
 * uses: expired, missing, near-expiry and depleted counts that Migration 199
 * already returned. No query is widened and no second request is made to build
 * this panel.
 *
 * It is deliberately NOT the inter-organization alert inbox. That surface has
 * its own screen and its own authorization, so this panel links to it when the
 * contract reported `alerts_view` and never tries to summarise it here — a
 * count of alerts this screen cannot authorize is a count it must not display.
 *
 * Tone is carried by an icon and a text label as well as colour, so the
 * severity survives a monochrome display and colour-vision deficiency.
 */
export function CriticalSignalsPanel({ signals, onOpenAlerts }: Props) {
  const { lang } = useApp();
  const fmt = (n: number) => n.toLocaleString(lang === 'ar' ? 'ar-IQ' : 'en-US');

  return (
    <div className="rac3-signals">
      {signals.length === 0 ? (
        <p className="rac3-signals__clear">
          <span className="rac3-signals__clear-icon" aria-hidden="true">
            <PhoenixIcon name="check" size={16} />
          </span>
          {t('rac3_signals_none', lang)}
        </p>
      ) : (
        <ul className="rac3-signals__list">
          {signals.map(signal => (
            <li key={signal.id} className={`rac3-signal rac3-signal--${signal.tone}`}>
              <span className="rac3-signal__icon" aria-hidden="true">
                <PhoenixIcon name={signal.tone === 'err' ? 'warning' : 'clock'} size={15} />
              </span>
              <span className="rac3-signal__label">{t(signal.labelKey, lang)}</span>
              <span className="rac3-signal__value">{fmt(signal.value)}</span>
              {/* Text severity, so status is never colour-only. */}
              <span className="rac3-signal__tone">
                {t(signal.tone === 'err' ? 'rac3_tone_critical' : 'rac3_tone_watch', lang)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {onOpenAlerts && (
        <button
          type="button"
          onClick={onOpenAlerts}
          className="rac3-linkbtn premium-focus-ring"
        >
          <PhoenixIcon name="alerts" size={15} />
          <span>{t('rac3_open_alerts', lang)}</span>
        </button>
      )}
    </div>
  );
}
