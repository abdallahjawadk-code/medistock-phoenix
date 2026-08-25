import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { usePrefersReducedMotion } from '../useReducedMotion';
import type { StockHealthSlice } from '../command-center.model';

const SIZE = 132;
const STROKE = 15;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

interface Props {
  slices: StockHealthSlice[];
}

/**
 * RAC-3 — stock-state distribution, drawn with plain SVG.
 *
 * No charting dependency: a stroke-dasharray ring plus a real legend is the
 * whole implementation. The ring is an ENHANCEMENT — it is `aria-hidden` and
 * every value is also present as text in the legend beside it, so the panel
 * carries its full meaning to a screen reader, in print, and if SVG fails to
 * paint. Percentages are computed against the sum of the slices actually
 * returned, never against a separately-reported total, so the segments always
 * add up to exactly what is drawn.
 *
 * Direction: the ring is deliberately drawn from the same starting angle and
 * in the same sweep for both text directions. It is a proportion, not a
 * timeline — mirroring it under RTL would change nothing semantically while
 * making the legend order disagree with the arc order.
 */
export function StockHealthPanel({ slices }: Props) {
  const { lang } = useApp();
  const reduced = usePrefersReducedMotion();

  const total = slices.reduce((sum, s) => sum + s.value, 0);

  if (slices.length === 0 || total <= 0) {
    return (
      <p className="rac3-panel__empty">{t('rac3_stock_health_empty', lang)}</p>
    );
  }

  let offset = 0;
  const segments = slices.map(slice => {
    const fraction = slice.value / total;
    const seg = {
      ...slice,
      fraction,
      dash: fraction * CIRCUMFERENCE,
      offset: offset * CIRCUMFERENCE,
    };
    offset += fraction;
    return seg;
  });

  const pct = (fraction: number) =>
    new Intl.NumberFormat(lang === 'ar' ? 'ar-IQ' : 'en-US', {
      style: 'percent',
      maximumFractionDigits: fraction < 0.01 ? 2 : 0,
    }).format(fraction);

  const fmt = (n: number) => n.toLocaleString(lang === 'ar' ? 'ar-IQ' : 'en-US');

  return (
    <div className="rac3-health">
      <div className="rac3-health__ring">
        <svg
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          aria-hidden="true"
          focusable="false"
          className={reduced ? undefined : 'rac3-health__svg'}
        >
          <circle
            cx={SIZE / 2} cy={SIZE / 2} r={RADIUS}
            fill="none" stroke="var(--brd)" strokeWidth={STROKE}
          />
          <g transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}>
            {segments.map(seg => (
              <circle
                key={seg.id}
                cx={SIZE / 2} cy={SIZE / 2} r={RADIUS}
                fill="none"
                stroke={seg.color}
                strokeWidth={STROKE}
                strokeDasharray={`${seg.dash} ${CIRCUMFERENCE - seg.dash}`}
                strokeDashoffset={-seg.offset}
              />
            ))}
          </g>
        </svg>
        <div className="rac3-health__center" aria-hidden="true">
          <span className="rac3-health__total">{fmt(total)}</span>
          <span className="rac3-health__total-label">{t('rac3_health_total', lang)}</span>
        </div>
      </div>

      {/* The information channel. Not decorative, not aria-hidden. */}
      <ul className="rac3-health__legend">
        {segments.map(seg => (
          <li key={seg.id} className="rac3-health__legend-item">
            <span className="rac3-health__swatch" style={{ background: seg.color }} aria-hidden="true" />
            <span className="rac3-health__legend-label">{t(seg.labelKey, lang)}</span>
            <span className="rac3-health__legend-value">
              {fmt(seg.value)}
              {/* The share is supplementary; the count above is the fact. */}
              <span className="rac3-health__legend-pct">{pct(seg.fraction)}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
