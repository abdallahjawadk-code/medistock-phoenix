import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { PhoenixIcon } from '../PhoenixIcon';
import './prism-fonts.css';
import './prism-workspace.css';

interface Props extends Omit<ComponentPropsWithoutRef<'section'>, 'title' | 'lang'> {
  lang: 'ar' | 'en';
  title: string;
  headingId: string;
  description?: string;
  context?: ReactNode;
}

/** Presentation only. The caller owns scope, permissions and every operation. */
export function PrismWorkspace({ lang, title, headingId, description, context, className = '', children, ...props }: Props) {
  return (
    <section {...props} lang={lang} dir={lang === 'ar' ? 'rtl' : 'ltr'} aria-labelledby={headingId} className={`prism-workspace ${className}`}>
      <header className="prism-workspace__header">
        <div className="prism-workspace__heading">
          <span className="prism-workspace__mark" aria-hidden="true"><PhoenixIcon name="clipboard" size={26} /></span>
          <div>
            <p className="prism-workspace__eyebrow" lang="en" dir="ltr">MEDISTOCK / PHOENIX</p>
            <h2 id={headingId}>{title}</h2>
            {description && <p className="prism-workspace__description">{description}</p>}
          </div>
        </div>
        {context && <div className="prism-workspace__context">{context}</div>}
      </header>
      <div className="prism-workspace__body">{children}</div>
    </section>
  );
}
