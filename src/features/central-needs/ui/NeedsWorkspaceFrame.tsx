import { useId, type ReactNode } from 'react';
import '@/shared/ui/prism/prism-fonts.css';
import '@/shared/ui/prism/prism-workspace.css';
import './needs-workspace.css';

/** Display-only frame. No capability, contract, quantity or lifecycle inference. */
export function NeedsWorkspaceFrame({ lang, title, description, context, children, legacy = false }: {
  lang: 'ar' | 'en'; title: string; description: string; context?: ReactNode; children: ReactNode; legacy?: boolean;
}) {
  const id = useId();
  return <section className="prism-workspace needs-studio" lang={lang} dir={lang === 'ar' ? 'rtl' : 'ltr'} aria-labelledby={id}>
    <header className="needs-studio__header">
      <div><p className="needs-studio__eyebrow">PHOENIX PRISM <span aria-hidden="true">/</span> {legacy ? 'RECORDS' : 'PLANNING'}</p>
        <h1 id={id}>{title}</h1><p className="needs-studio__description">{description}</p></div>
      {context && <div className="needs-studio__context">{context}</div>}
    </header>
    <div className="needs-studio__body">{children}</div>
  </section>;
}

/** An orientation aid, not a computed progress/status indicator. */
export function NeedsPrinciples({ lang }: { lang: 'ar' | 'en' }) {
  const items = lang === 'ar'
    ? [['01', 'هوية موثقة', 'فهرس السنة والرمز الوطني والوحدة من المصدر.'], ['02', 'احتياج يدوي', 'المؤسسة المستفيدة مطلوبة؛ أدخل الكمية بنفسك.'], ['03', 'اعتماد مستقل', 'اعتماد الاحتياج لا يعتمد التحصيص الشهري.']]
    : [['01', 'Verified identity', 'Year catalog, text national code and source unit.'], ['02', 'Manual need', 'A beneficiary is required; enter the quantity yourself.'], ['03', 'Separate approval', 'Annual approval does not approve monthly allocations.']];
  return <ol className="needs-principles">{items.map(([n, title, body]) => <li key={n}><span aria-hidden="true">{n}</span><div><strong>{title}</strong><p>{body}</p></div></li>)}</ol>;
}
