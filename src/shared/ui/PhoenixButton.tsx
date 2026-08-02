import type { ButtonHTMLAttributes, CSSProperties } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'warn';
type Size = 'sm' | 'md' | 'lg';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  fullWidth?: boolean;
  loading?: boolean;
}

/* PHASE-A7-VISUAL-CONVERGENCE: the committing action is the institutional gold
   fill (--phoenix-gold, defined in phase-a-visual-convergence.css) with dark
   ink text at weight 700 — the reference board's primary action colour.
   Secondary is a --chip fill with a --line hairline and institutional teal
   text at 600; ghost drops the fill entirely and keeps the teal text. Danger
   and warn follow the secondary shape with their own semantic hue so status
   never reads by fill alone. Every colour here is a token — nothing is baked.
   (phase-a-visual-convergence.css also carries a scoped !important override
   for the primary variant, since the legacy .phoenix-button[data-variant=
   "primary"] class rule in phoenix-nexus.css still forces its own ember fill
   with !important — this inline value is the source of truth once that
   legacy rule is retired.) */
const variantStyles: Record<Variant, CSSProperties> = {
  primary: {
    background: 'linear-gradient(135deg, var(--phoenix-gold-2, var(--gold)), var(--phoenix-gold, var(--gold)))',
    color: 'var(--phoenix-gold-ink)',
    border: '1px solid transparent',
    boxShadow: '0 10px 24px color-mix(in srgb, var(--phoenix-gold, var(--gold)) 26%, transparent)',
    fontWeight: 700,
  },
  secondary: { background: 'var(--chip)', color: 'var(--teal)', border: '1px solid var(--line)' },
  ghost: { background: 'transparent', color: 'var(--teal)', border: '1px solid var(--line)' },
  danger: {
    background: 'var(--chipD)',
    color: 'var(--danger)',
    border: '1px solid color-mix(in srgb, var(--danger) 45%, var(--line))',
  },
  warn: {
    background: 'var(--chipW)',
    color: 'var(--warn)',
    border: '1px solid color-mix(in srgb, var(--warn) 45%, var(--line))',
  },
};

/* The design source draws every button at 44-46px tall, so the size scale sets
   padding and type only and lets .phoenix-button's min-height (--touch-target)
   own the hit area. */
const sizeStyles: Record<Size, CSSProperties> = {
  sm: { padding: '0 14px', fontSize: '12px', borderRadius: 'var(--r2)' },
  md: { padding: '0 18px', fontSize: '13px', borderRadius: 'var(--r2)' },
  lg: { padding: '0 22px', fontSize: '15px', borderRadius: 'var(--r2)', fontWeight: 700 },
};

export function PhoenixButton({
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  loading = false,
  disabled,
  style,
  className = '',
  children,
  ...props
}: Props) {
  return (
    <button
      {...props}
      className={`phoenix-button premium-focus-ring ${className}`}
      data-variant={variant}
      data-size={size}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      style={{
        fontWeight: 600,
        ...variantStyles[variant],
        ...sizeStyles[size],
        cursor: disabled || loading ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'all 160ms var(--nx-ease, ease)',
        width: fullWidth ? '100%' : undefined,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '7px',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {loading ? <span className="phoenix-button__spinner" aria-hidden="true" /> : children}
    </button>
  );
}
