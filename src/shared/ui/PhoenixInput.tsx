import { useId, type InputHTMLAttributes, type CSSProperties } from 'react';
import { PhoenixIcon } from './PhoenixIcon';
import { fieldId } from './field-id';

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  style?: CSSProperties;
}

export function PhoenixInput({ label, error, style, id, className = '', ...props }: Props) {
  const generatedId = useId();
  const inputId = id ?? fieldId(generatedId, label);

  return (
    <div className="nexus-field" data-error={Boolean(error)}>
      {label && <label htmlFor={inputId}>{label}</label>}
      <input
        id={inputId}
        {...props}
        className={`premium-field nexus-field__control ${className}`}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${inputId}-error` : undefined}
        style={style}
      />
      {error && (
        <p id={`${inputId}-error`} className="nexus-field__error">
          <PhoenixIcon name="warning" size={13} />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
