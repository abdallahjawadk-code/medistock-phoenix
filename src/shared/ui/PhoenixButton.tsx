import { ButtonHTMLAttributes, CSSProperties } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'warn';
type Size    = 'sm' | 'md' | 'lg';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  fullWidth?: boolean;
  loading?: boolean;
}

const variantStyles: Record<Variant, CSSProperties> = {
  primary:   { background: 'var(--p)',    color: '#fff',         border: 'none',                    boxShadow: '0 4px 16px rgba(13,148,136,.28)' },
  secondary: { background: 'var(--p2)',   color: 'var(--pd)',    border: '1px solid var(--p)' },
  ghost:     { background: 'transparent', color: 'var(--t2)',    border: '1px solid var(--brd)' },
  danger:    { background: 'var(--err)',   color: '#fff',         border: 'none' },
  warn:      { background: 'var(--warn2)', color: 'var(--warn)', border: '1px solid var(--warn)' },
};

const sizeStyles: Record<Size, CSSProperties> = {
  sm: { padding: '6px 12px',  fontSize: '12px', borderRadius: 'var(--r2)' },
  md: { padding: '10px 16px', fontSize: '13px', borderRadius: 'var(--r3)' },
  lg: { padding: '14px 20px', fontSize: '15px', borderRadius: 'var(--r3)', fontWeight: 700 },
};

export function PhoenixButton({
  variant = 'primary', size = 'md', fullWidth = false,
  loading = false, disabled, style, children, ...props
}: Props) {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      style={{
        ...variantStyles[variant],
        ...sizeStyles[size],
        fontWeight: 600,
        cursor: disabled || loading ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'all 150ms',
        width: fullWidth ? '100%' : undefined,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '6px',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {loading ? '⏳' : children}
    </button>
  );
}
