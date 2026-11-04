import { useId, useRef, useState, type ReactNode } from 'react';

/** Mounted panels preserve drafts and operation locks. Tab changes never call an API. */
export function NeedsWorkspaceTabs({ lang, tabs }: { lang: 'ar' | 'en'; tabs: Array<{ id: string; label: string; content: ReactNode }> }) {
  const prefix = useId(), [selected, setSelected] = useState(tabs[0].id);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const active = tabs.some(tab => tab.id === selected) ? selected : tabs[0].id;
  return <div className="needs-tabs">
    <div className="needs-tabs__list" role="tablist" aria-label={lang === 'ar' ? 'مساحة الاحتياج' : 'Needs workspace'}>
      {tabs.map((tab, index) => <button key={tab.id} type="button" role="tab" id={`${prefix}-${tab.id}-tab`}
        ref={node => { buttons.current[index] = node; }} aria-selected={active === tab.id}
        aria-controls={`${prefix}-${tab.id}-panel`} tabIndex={active === tab.id ? 0 : -1}
        onClick={() => setSelected(tab.id)} onKeyDown={event => {
          let next = index;
          if (event.key === 'Home') next = 0;
          else if (event.key === 'End') next = tabs.length - 1;
          else if (event.key === 'ArrowRight') next = (index + (lang === 'ar' ? -1 : 1) + tabs.length) % tabs.length;
          else if (event.key === 'ArrowLeft') next = (index + (lang === 'ar' ? 1 : -1) + tabs.length) % tabs.length;
          else return;
          event.preventDefault(); setSelected(tabs[next].id); buttons.current[next]?.focus();
        }}>{tab.label}</button>)}
    </div>
    {tabs.map(tab => <div key={tab.id} role="tabpanel" id={`${prefix}-${tab.id}-panel`}
      aria-labelledby={`${prefix}-${tab.id}-tab`} hidden={active !== tab.id} tabIndex={0}>{tab.content}</div>)}
  </div>;
}
