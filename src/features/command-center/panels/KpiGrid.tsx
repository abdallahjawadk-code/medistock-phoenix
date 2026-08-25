import { useEffect, useRef, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixIcon, type PhoenixIconName } from '@/shared/ui/PhoenixIcon';
import { usePrefersReducedMotion } from '../useReducedMotion';
import type { CommandCenterKpi } from '../command-center.model';

const TONE_COLOR: Record<CommandCenterKpi['tone'], string> = {
  neutral: 'var(--t)',
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  err: 'var(--err)',
};

const TONE_WASH: Record<CommandCenterKpi['tone'], string> = {
  neutral: 'var(--chip)',
  ok: 'var(--ok2)',
  warn: 'var(--warn2)',
  err: 'var(--err2)',
};

const COUNT_MS = 620;

/**
 * Count-up that is decoration only.
 *
 * The final value is committed synchronously when motion is reduced, and the
 * element carries the resolved number in `aria-label` at all times, so a
 * screen reader never observes a partial count and never has to wait for an
 * animation to learn the figure.
 */
function useCountUp(target: number | null, reduced: boolean): number | null {
  const [shown, setShown] = useState<number | null>(target);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    if (target === null) {
      setShown(null);
      return;
    }
    if (reduced || target === 0) {
      setShown(target);
      return;
    }
    const start = performance.now();
    const from = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / COUNT_MS);
      // easeOutCubic — fast arrival, quiet settle.
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(Math.round(from + (target - from) * eased));
      if (p < 1) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [target, reduced]);

  return shown;
}

function KpiCard({ kpi }: { kpi: CommandCenterKpi }) {
  const { lang } = useApp();
  const reduced = usePrefersReducedMotion();
  const shown = useCountUp(kpi.value, reduced);
  const label = t(kpi.labelKey, lang);

  // A figure the contract did not carry is shown as an explicit dash. It is
  // never coerced to 0 — that would assert a measurement the server never made.
  const value = kpi.value;
  const locale = lang === 'ar' ? 'ar-IQ' : 'en-US';
  const display = value !== null ? (shown ?? 0).toLocaleString(locale) : '—';
  const srValue = value !== null ? value.toLocaleString(locale) : t('rac3_not_reported', lang);

  return (
    <div
      className="rac3-kpi"
      // One node carries the whole fact, so assistive tech reads
      // "Expired: 12" rather than two orphaned fragments.
      role="group"
      aria-label={`${label}: ${srValue}`}
    >
      <div className="rac3-kpi__top">
        <span className="rac3-kpi__icon" style={{ background: TONE_WASH[kpi.tone], color: TONE_COLOR[kpi.tone] }} aria-hidden="true">
          <PhoenixIcon name={kpi.icon as PhoenixIconName} size={17} />
        </span>
      </div>
      <div
        className="rac3-kpi__value"
        style={{ color: value !== null ? TONE_COLOR[kpi.tone] : 'var(--t3)' }}
        aria-hidden="true"
      >
        {display}
      </div>
      <div className="rac3-kpi__label" aria-hidden="true">{label}</div>
    </div>
  );
}

/** Loading placeholder with the same geometry, so the grid does not reflow. */
export function KpiGridSkeleton({ count = 6 }: { count?: number }) {
  const { lang } = useApp();
  return (
    <div className="rac3-kpi-grid" role="status" aria-busy="true" aria-label={t('loading', lang)}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rac3-kpi rac3-kpi--skeleton" aria-hidden="true">
          <div className="rac3-kpi__top"><span className="rac3-kpi__icon rac3-skel" /></div>
          <div className="rac3-skel rac3-skel--value" />
          <div className="rac3-skel rac3-skel--label" />
        </div>
      ))}
    </div>
  );
}

export function KpiGrid({ kpis }: { kpis: CommandCenterKpi[] }) {
  if (kpis.length === 0) return null;
  return (
    <div className="rac3-kpi-grid">
      {kpis.map(kpi => <KpiCard key={kpi.id} kpi={kpi} />)}
    </div>
  );
}
