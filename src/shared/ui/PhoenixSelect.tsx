import { SelectHTMLAttributes } from 'react';

interface Option { value: string; label: string; }

interface Props extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  options: Option[];
  error?: string;
}

export function PhoenixSelect({ label, options, error, id, ...props }: Props) {
  const selectId = id ?? label?.toLowerCase().replace(/\s+/g, '-');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {label && (
        <label htmlFor={selectId} style={{ fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', textTransform: 'uppercase', letterSpacing: '.4px' }}>
          {label}
        </label>
      )}
      <select
        id={selectId}
        {...props}
        style={{
          width: '100%',
          padding: '10px 12px',
          borderRadius: 'var(--r2)',
          border: error ? '1px solid var(--err)' : '1px solid var(--brd)',
          background: 'var(--s)',
          color: 'var(--t)',
          fontSize: '13px',
          transition: 'all 120ms',
          appearance: 'none',
          cursor: 'pointer',
          outline: 'none',
        }}
        onFocus={e => { e.currentTarget.style.borderColor = 'var(--p)'; e.currentTarget.style.boxShadow = '0 0 0 3px var(--p2)'; }}
        onBlur={e =>  { e.currentTarget.style.borderColor = error ? 'var(--err)' : 'var(--brd)'; e.currentTarget.style.boxShadow = 'none'; }}
      >
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {error && <p style={{ fontSize: '11px', color: 'var(--err)' }}>⚠ {error}</p>}
    </div>
  );
}
