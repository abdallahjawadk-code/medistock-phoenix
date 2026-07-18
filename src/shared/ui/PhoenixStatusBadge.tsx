import { CSSProperties, type ReactNode } from 'react';

type BadgeVariant = 'ok' | 'warn' | 'err' | 'info' | 'neutral' | 'primary' | 'frozen';

interface Props {
  variant: BadgeVariant;
  label: string;
  dot?: boolean;
  icon?: ReactNode;
  style?: CSSProperties;
}

const badgeMap: Record<BadgeVariant, CSSProperties> = {
  ok:      { background: 'var(--ok2)',   color: 'var(--ok)' },
  warn:    { background: 'var(--warn2)', color: 'var(--warn)' },
  err:     { background: 'var(--err2)',  color: 'var(--err)' },
  info:    { background: 'var(--info2)', color: 'var(--info)' },
  neutral: { background: 'var(--skel)',  color: 'var(--t2)' },
  primary: { background: 'var(--p2)',    color: 'var(--pd)' },
  frozen:  { background: 'var(--skel)',  color: 'var(--t2)', opacity: 0.8 },
};

export function PhoenixStatusBadge({ variant, label, dot = false, icon, style }: Props) {
  return (
    <span className="premium-status-badge" style={{
      padding: '2px 8px',
      borderRadius: 'var(--rpill)',
      fontSize: '10px',
      fontWeight: 700,
      display: 'inline-flex',
      alignItems: 'center',
      gap: dot || icon ? '4px' : undefined,
      flexShrink: 0,
      whiteSpace: 'nowrap',
      ...badgeMap[variant],
      ...style,
    }}>
      {dot && (
        <span style={{
          width: '6px', height: '6px', borderRadius: '50%',
          background: 'currentColor', display: 'inline-block',
        }} />
      )}
      {icon}
      {label}
    </span>
  );
}
