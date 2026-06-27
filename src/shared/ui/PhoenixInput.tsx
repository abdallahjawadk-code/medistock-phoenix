import { InputHTMLAttributes, CSSProperties } from 'react';

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  style?: CSSProperties;
}

export function PhoenixInput({ label, error, style, id, ...props }: Props) {
  const inputId = id ?? label?.toLowerCase().replace(/\s+/g, '-');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {label && (
        <label htmlFor={inputId} style={{ fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', textTransform: 'uppercase', letterSpacing: '.4px' }}>
          {label}
        </label>
      )}
      <input
        id={inputId}
        {...props}
        style={{
          width: '100%',
          padding: '10px 12px',
          borderRadius: 'var(--r2)',
          border: error ? '1px solid var(--err)' : '1px solid var(--brd)',
          background: error ? 'var(--err2)' : 'var(--s)',
          color: 'var(--t)',
          fontSize: '13px',
          transition: 'all 120ms',
          outline: 'none',
          ...style,
        }}
        onFocus={e => {
          e.currentTarget.style.borderColor = error ? 'var(--err)' : 'var(--p)';
          e.currentTarget.style.boxShadow = error ? '0 0 0 3px var(--err2)' : '0 0 0 3px var(--p2)';
        }}
        onBlur={e => {
          e.currentTarget.style.borderColor = error ? 'var(--err)' : 'var(--brd)';
          e.currentTarget.style.boxShadow = 'none';
        }}
      />
      {error && <p style={{ fontSize: '11px', color: 'var(--err)', marginTop: '2px' }}>⚠ {error}</p>}
    </div>
  );
}
