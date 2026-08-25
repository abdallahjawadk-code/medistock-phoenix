import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';

/**
 * RAC-3 — the deferred trend panel.
 *
 * Migration 199 returns `trend: null` with
 * `trend_status: 'deferred_pending_measurement'`, because no measured history
 * exists yet. This panel says exactly that.
 *
 * It deliberately draws NO line, NO axis and NO placeholder shape. A greyed-out
 * chart skeleton would read as "loading" or "broken"; a sample curve would be a
 * fabricated measurement. The honest rendering of "not measured yet" is a
 * sentence, so that is what this is — quiet, sized like the panels around it so
 * the grid stays balanced, and stated as a forthcoming capability rather than a
 * fault.
 *
 * When a measured trend read model exists, this component is where it lands.
 */
export function TrendPanel({ status }: { status: string }) {
  const { lang } = useApp();

  return (
    <div className="rac3-trend" data-trend-status={status}>
      <span className="rac3-trend__glyph" aria-hidden="true">
        <PhoenixIcon name="clock" size={20} />
      </span>
      <p className="rac3-trend__text">{t('rac3_trend_deferred', lang)}</p>
    </div>
  );
}
