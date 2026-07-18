import { useId, type SelectHTMLAttributes } from 'react';
import { PhoenixIcon } from './PhoenixIcon';

interface Option {
  value: string;
  label: string;
}

interface Props extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  options: Option[];
  error?: string;
}

export function PhoenixSelect({ label, options, error, id, className = '', ...props }: Props) {
  const generatedId = useId();
  const selectId = id ?? label?.toLowerCase().replace(/\s+/g, '-') ?? generatedId;
  const errorId = `${selectId}-error`;

  return (
    <div className="nexus-field" data-error={Boolean(error)}>
      {label && <label htmlFor={selectId}>{label}</label>}
      <div className="nexus-select-wrap">
        <select
          id={selectId}
          {...props}
          className={`nexus-field__control nexus-select ${className}`}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
        >
          {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <span className="nexus-select__chevron" aria-hidden="true" />
      </div>
      {error && (
        <p id={errorId} className="nexus-field__error">
          <PhoenixIcon name="warning" size={13} />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
