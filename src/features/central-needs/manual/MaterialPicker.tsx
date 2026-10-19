/**
 * R1-A4 — picking a REGISTERED material through the existing PRE3-A resolver (injected `search`). It never creates a catalog row;
 * "not found" offers the registration request, and a failed search is reported as a failure, never as "no such material".
 */
import { useEffect, useRef, useState } from 'react';
import type { CatalogOption } from './manual-journey.service';
import { jt, type JourneyLang } from './manual-journey.i18n';

interface Props {
  lang: JourneyLang;
  scopeKey: string;                       // organization / revision: a change discards any in-flight search
  search: (query: string) => Promise<CatalogOption[]>;
  selected: CatalogOption[];
  onPick: (item: CatalogOption) => void;
  onRemove: (itemId: string) => void;
  onRequestRegistration: () => void;
}

export function MaterialPicker({ lang, scopeKey, search, selected, onPick, onRemove, onRequestRegistration }: Props) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<CatalogOption[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);

  useEffect(() => { epoch.current += 1; setHits(null); setFailed(false); setQuery(''); setBusy(false); }, [scopeKey]);

  const run = async () => {
    if (query.trim().length < 2) return;
    epoch.current += 1;
    const mine = epoch.current;
    setBusy(true); setFailed(false);
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
    <fieldset>
      <legend>{jt('material_search', lang)}</legend>
      <form onSubmit={(e) => { e.preventDefault(); void run(); }}>
        <label>{jt('material_search', lang)}
          <input value={query} onChange={(e) => setQuery(e.target.value)} disabled={busy} autoComplete="off" />
        </label>
        <button type="submit" disabled={busy || query.trim().length < 2}>{jt('material_search_btn', lang)}</button>
      </form>
      <div role="status" aria-live="polite">
        {failed && <span role="alert">{jt('material_search_failed', lang)}</span>}
        {hits !== null && hits.length === 0 && !failed && (
          <span>{jt('material_none', lang)} <button type="button" onClick={onRequestRegistration}>{jt('reg_title', lang)}</button></span>
        )}
      </div>
      {hits !== null && hits.length > 0 && (
        <ul>
          {hits.map((h) => (
            <li key={h.id}>
              <span>{lang === 'ar' && h.nameAr ? h.nameAr : h.name}</span>{' '}
              <span dir="ltr">{[h.concentration, h.dosageForm, h.unit].filter(Boolean).join(' · ')}</span>{' '}
              <button type="button" onClick={() => onPick(h)} disabled={selected.some((s) => s.id === h.id)}>{jt('material_use', lang)}</button>
            </li>
          ))}
        </ul>
      )}
      {selected.length > 0 && (
        <section aria-label={jt('material_working', lang)}>
          <h4>{jt('material_working', lang)}</h4>
          <ul>
            {selected.map((s) => (
              <li key={s.id}>
                {lang === 'ar' && s.nameAr ? s.nameAr : s.name}
                <button type="button" onClick={() => onRemove(s.id)} aria-label={`${jt('material_remove', lang)} ${s.name}`}>{jt('material_remove', lang)}</button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </fieldset>
  );
}
