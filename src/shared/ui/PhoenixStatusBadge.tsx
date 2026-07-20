import { CSSProperties } from 'react';
import { PhoenixIcon, type PhoenixIconName } from './PhoenixIcon';

type BadgeVariant = 'ok' | 'warn' | 'err' | 'info' | 'neutral' | 'primary' | 'frozen';

interface Props {
  variant: BadgeVariant;
  label: string;
  dot?: boolean;
  /** Optional leading Phoenix SVG icon (replaces the old emoji-in-label idiom). */
  icon?: PhoenixIconName;
  style?: CSSProperties;
}

/* The design source's status pills are a tinted fill plus a hairline in the
   same hue. The hairline matters for accessibility as much as for looks: it
   keeps the pill legible against --surface2 rows where the tint alone is nearly
   invisible, so status never depends on a fill colour being perceived. */
const badgeMap: Record<BadgeVariant, CSSProperties> = {
  ok:      { background: 'var(--chip)',    color: 'var(--ok)',      borderColor: 'color-mix(in srgb, var(--ok) 40%, transparent)' },
  warn:    { background: 'var(--chipW)',   color: 'var(--warn)',    borderColor: 'color-mix(in srgb, var(--warn) 40%, transparent)' },
  err:     { background: 'var(--chipD)',   color: 'var(--danger)',  borderColor: 'color-mix(in srgb, var(--danger) 40%, transparent)' },
  info:    { background: 'var(--chip)',    color: 'var(--teal)',    borderColor: 'color-mix(in srgb, var(--teal) 40%, transparent)' },
  neutral: { background: 'var(--surface2)', color: 'var(--muted)',  borderColor: 'var(--line)' },
  primary: { background: 'var(--chip)',    color: 'var(--cyanDim)', borderColor: 'var(--line)' },
  frozen:  { background: 'var(--surface2)', color: 'var(--muted)',  borderColor: 'var(--line)', opacity: 0.8 },
};

export function PhoenixStatusBadge({ variant, label, dot = false, icon, style }: Props) {
  return (
    <span className="premium-status-badge" style={{
      padding: '2px 8px',
      borderRadius: 'var(--rpill)',
      borderWidth: '1px',
      borderStyle: 'solid',
      fontSize: '10px',
      fontWeight: 700,
      display: 'inline-flex',
      alignItems: 'center',
      gap: (dot || icon) ? '4px' : undefined,
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
      {icon && <PhoenixIcon name={icon} size={11} inline aria-hidden />}
      {label}
    </span>
  );
}
