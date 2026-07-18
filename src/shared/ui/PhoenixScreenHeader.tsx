import type { ReactNode } from 'react';
import { PhoenixIcon, type PhoenixIconName } from './PhoenixIcon';

interface Props {
  icon: PhoenixIconName;
  eyebrow: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  meta?: ReactNode;
  className?: string;
}

export function PhoenixScreenHeader({ icon, eyebrow, title, description, actions, meta, className = '' }: Props) {
  return (
    <header className={`nexus-screen-header premium-page-header ${className}`.trim()}>
      <div className="nexus-screen-header__identity">
        <div className="nexus-screen-header__mark" aria-hidden="true">
          <PhoenixIcon name={icon} size={24} />
        </div>
        <div className="nexus-screen-header__copy">
          <span className="nexus-screen-header__eyebrow">{eyebrow}</span>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
          {meta && <div className="nexus-screen-header__meta">{meta}</div>}
        </div>
      </div>
      {actions && <div className="nexus-screen-header__actions">{actions}</div>}
    </header>
  );
}
