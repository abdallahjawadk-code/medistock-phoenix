import type { ReactNode } from 'react';
import { PhoenixIcon, type PhoenixIconName } from './PhoenixIcon';

type Tone = 'info' | 'success' | 'warning' | 'danger' | 'neutral';

const DEFAULT_ICON: Record<Tone, PhoenixIconName> = {
  info: 'info',
  success: 'check',
  warning: 'warning',
  danger: 'warning',
  neutral: 'shield',
};

interface Props {
  children: ReactNode;
  tone?: Tone;
  icon?: PhoenixIconName;
  title?: string;
  className?: string;
}

export function PhoenixNotice({ children, tone = 'info', icon, title, className = '' }: Props) {
  return (
    <div className={`nexus-notice ${className}`.trim()} data-tone={tone} role={tone === 'danger' ? 'alert' : 'note'}>
      <div className="nexus-notice__icon" aria-hidden="true">
        <PhoenixIcon name={icon ?? DEFAULT_ICON[tone]} size={19} />
      </div>
      <div className="nexus-notice__copy">
        {title && <strong>{title}</strong>}
        <div>{children}</div>
      </div>
    </div>
  );
}
