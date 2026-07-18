import type { ButtonHTMLAttributes, CSSProperties } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'warn';
type Size = 'sm' | 'md' | 'lg';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  fullWidth?: boolean;
  loading?: boolean;
}

const variantStyles: Record<Variant, CSSProperties> = {
  primary: { background: 'var(--p)', color: '#fff', border: '1px solid transparent', boxShadow: '0 8px 20px rgba(14,159,138,.22)' },
  secondary: { background: 'var(--p2)', color: 'var(--pd)', border: '1px solid color-mix(in srgb, var(--p) 38%, var(--brd))' },
  ghost: { background: 'transparent', color: 'var(--t2)', border: '1px solid var(--brd)' },
  danger: { background: 'var(--err)', color: '#fff', border: '1px solid transparent' },
  warn: { background: 'var(--warn2)', color: 'var(--warn)', border: '1px solid color-mix(in srgb, var(--warn) 48%, var(--brd))' },
};

const sizeStyles: Record<Size, CSSProperties> = {
  sm: { padding: '7px 12px', fontSize: '12px', borderRadius: 'var(--r2)' },
  md: { padding: '10px 16px', fontSize: '13px', borderRadius: 'var(--r3)' },
  lg: { padding: '14px 20px', fontSize: '15px', borderRadius: 'var(--r3)', fontWeight: 700 },
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
        ...variantStyles[variant],
        ...sizeStyles[size],
        fontWeight: 650,
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
