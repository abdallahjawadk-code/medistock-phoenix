import { CSSProperties } from 'react';

interface Props {
  icon: string;
  value: string | number;
  label: string;
  badge?: string;
  badgeVariant?: 'ok' | 'warn' | 'err';
  valueColor?: string;
  iconBg?: string;
  onClick?: () => void;
}

const badgeColors: Record<string, CSSProperties> = {
  ok:   { background: 'var(--ok2)',   color: 'var(--ok)' },
  warn: { background: 'var(--warn2)', color: 'var(--warn)' },
  err:  { background: 'var(--err2)',  color: 'var(--err)' },
};

export function PhoenixMetricCard({ icon, value, label, badge, badgeVariant = 'ok', valueColor, iconBg, onClick }: Props) {
  return (
    <div
      className="premium-depth-card premium-3d-hover premium-kpi-card"
      onClick={onClick}
      style={{
        background: 'var(--s)',
        borderRadius: 'var(--r4)',
        padding: 'var(--cardPad, 18px)',
        boxShadow: 'var(--sh-sm)',
        border: '1px solid var(--brd)',
        transition: 'all 180ms',
        cursor: onClick ? 'pointer' : undefined,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '6px', marginBottom: '12px' }}>
        <div style={{
          width: '38px', height: '38px', borderRadius: 'var(--r2)',
          background: iconBg ?? 'var(--p2)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '17px', flexShrink: 0,
        }}>
          {icon}
        </div>
        {badge && (
          <span style={{
            padding: '2px 7px', borderRadius: 'var(--rpill)',
            fontSize: '10px', fontWeight: 700,
            ...badgeColors[badgeVariant],
          }}>
            {badge}
          </span>
        )}
      </div>
      <div style={{ fontSize: '26px', fontWeight: 700, lineHeight: 1, color: valueColor }}>{value}</div>
      <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '3px' }}>{label}</div>
    </div>
  );
}
