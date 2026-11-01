/**
 * R1-A4 — picking a REGISTERED material through the existing PRE3-A resolver (injected `search`). It never creates a catalog row;
 * "not found" offers the registration request, and a failed search is reported as a failure, never as "no such material".
 */
import { useEffect, useId, useRef, useState } from 'react';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import { PrismMaterialIdentity } from '@/shared/ui/prism/PrismMaterialIdentity';
import type { CatalogOption } from './manual-journey.service';
import { jt, type JourneyLang } from './manual-journey.i18n';

interface Props {
  lang: JourneyLang;
  scopeKey: string;                       // organization / revision: a change discards any in-flight search
  search: (query: string) => Promise<CatalogOption[]>;
  selected: CatalogOption[];
  onPick: (item: CatalogOption) => void;
  onRemove: (itemId: string) => void;
  onRequestRegistration?: () => void;
}

export function MaterialPicker({ lang, scopeKey, search, selected, onPick, onRemove, onRequestRegistration }: Props) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<CatalogOption[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const searchId = useId();

  useEffect(() => {
    epoch.current += 1; setHits(null); setFailed(false); setQuery(''); setBusy(false);
    return () => { epoch.current += 1; };
  }, [scopeKey]);

  const run = async () => {
    if (query.trim().length < 2) return;
    epoch.current += 1;
    const mine = epoch.current;
    setBusy(true); setFailed(false); setHits(null);
    try {
      const r = await search(query.trim());
      if (epoch.current !== mine) return;
      setHits(r);
    } catch {
      if (epoch.current !== mine) return;
      setHits(null); setFailed(true);
    } finally {
      if (epoch.current === mine) setBusy(false);
    }
  };

  return (
    <fieldset className="prism-material-picker" lang={lang} dir={lang === 'ar' ? 'rtl' : 'ltr'}>
      <legend>{jt('material_search', lang)}</legend>
      <form className="prism-search-form" onSubmit={(e) => { e.preventDefault(); void run(); }}>
        <label htmlFor={searchId}>
          <span className="sr-only">{jt('material_search', lang)}</span>
          <span className="prism-search-control">
            <PhoenixIcon name="search" size={18} aria-hidden="true" />
            <input id={searchId} type="search" value={query} onChange={(e) => setQuery(e.target.value)} disabled={busy} autoComplete="off"
              placeholder={jt('material_search_placeholder', lang)} aria-describedby={`${searchId}-hint`} />
          </span>
        </label>
        <button type="submit" disabled={busy || query.trim().length < 2} aria-busy={busy}>{jt('material_search_btn', lang)}</button>
      </form>
      <p id={`${searchId}-hint`} className="prism-search-hint">{jt('material_search_hint', lang)}</p>
      <div role="status" aria-live="polite" className="prism-live-region">
        {busy && <p className="prism-search-state prism-loading"><span className="prism-loading__dot" aria-hidden="true" />{jt('material_search_loading', lang)}</p>}
        {hits !== null && hits.length === 0 && !failed && (
          <div className="prism-search-state">
            <p>{jt('material_none', lang)}</p>
            {onRequestRegistration && <button type="button" onClick={onRequestRegistration}><PhoenixIcon name="editor" size={16} aria-hidden="true" />{jt('reg_title', lang)}</button>}
          </div>
        )}
      </div>
      {failed && <p role="alert" className="prism-notice prism-notice--error">{jt('material_search_failed', lang)}</p>}
      {hits !== null && hits.length > 0 && (
        <ul className="prism-result-list" aria-label={jt('material_results', lang)}>
          {hits.map((h) => {
            const picked = selected.some((s) => s.id === h.id);
            return (
              <li key={h.id} className="prism-result-row" data-selected={picked}>
                <PrismMaterialIdentity name={lang === 'ar' && h.nameAr ? h.nameAr : h.name} nationalCode={h.nationalCode}
                  concentration={h.concentration} dosageForm={h.dosageForm} unit={h.unit} />
                <button type="button" onClick={() => onPick(h)} disabled={picked}>
                  {picked && <PhoenixIcon name="check" size={15} aria-hidden="true" />}
                  {jt(picked ? 'material_selected' : 'material_use', lang)}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {selected.length > 0 && (
        <section className="prism-selection" aria-label={jt('material_working', lang)}>
          <div className="prism-selection__header">
            <h4>{jt('material_working', lang)}</h4>
            <span className="prism-selection__count" role="status" aria-live="polite"><PhoenixIcon name="check" size={15} aria-hidden="true" /><bdi>{selected.length}</bdi> {jt('material_selected', lang)}</span>
          </div>
          <p className="prism-search-hint">{jt('material_selection_hint', lang)}</p>
          <ul className="prism-selected-list">
            {selected.map((s) => (
              <li key={s.id} className="prism-selected-row">
                <bdi>{lang === 'ar' && s.nameAr ? s.nameAr : s.name}</bdi>
                <button type="button" className="prism-remove-button" onClick={() => onRemove(s.id)} aria-label={`${jt('material_remove', lang)} ${lang === 'ar' && s.nameAr ? s.nameAr : s.name}`}>
                  <PhoenixIcon name="close" size={18} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </fieldset>
  );
}
