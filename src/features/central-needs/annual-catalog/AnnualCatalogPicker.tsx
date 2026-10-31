import { useEffect, useId, useRef, useState } from 'react';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import { PrismMaterialIdentity } from '@/shared/ui/prism/PrismMaterialIdentity';
import { mt, manualUnitText, type ManualKey, type ManualLang } from '../manual/manual-needs.i18n';
import type { AnnualCatalogScope, AnnualIdentityField } from './annual-catalog.contract';
import type { AnnualCatalogCursor, AnnualCatalogItemResult } from './annual-catalog-server.contract';
import { getAnnualCatalogItem, searchAnnualCatalog } from './annual-catalog.service';

export interface AnnualCatalogPickerApi {
  searchAnnualCatalog: typeof searchAnnualCatalog;
  getAnnualCatalogItem: typeof getAnnualCatalogItem;
}

interface Props {
  lang: ManualLang;
  scope: AnnualCatalogScope;
  /** Includes the actor, revision and beneficiary; a change invalidates pending selection. */
  contextKey: string;
  selected: AnnualCatalogItemResult[];
  onPick: (item: AnnualCatalogItemResult) => void;
  onRemove: (annualItemId: string) => void;
  onRequestAddition?: () => void;
  onInspect?: (item: AnnualCatalogItemResult) => void;
  disabled?: boolean;
  api?: AnnualCatalogPickerApi;
}

const realApi: AnnualCatalogPickerApi = { searchAnnualCatalog, getAnnualCatalogItem };
const BLOCKERS: Record<string, ManualKey> = {
  year_inactive: 'annualBlockYear', member_preparing: 'annualBlockPreparing', member_retired: 'annualBlockRetired',
  historical_version: 'annualBlockHistorical', canonical_inactive: 'annualBlockInactive', canonical_drift: 'annualBlockDrift',
  scientificName: 'annualBlockName', nationalCode: 'annualBlockCode', unit: 'annualBlockUnit',
  receipt_replay_requires_refresh: 'annualBlockReceipt',
};

export function annualFieldText(item: AnnualCatalogItemResult, field: AnnualIdentityField): string | null {
  const value = item.fieldVersion.fields[field];
  return value.state === 'known' ? value.value : null;
}

export function annualItemName(item: AnnualCatalogItemResult, lang: ManualLang): string {
  return (lang === 'ar' ? annualFieldText(item, 'nameAr') : null)
    ?? annualFieldText(item, 'scientificName') ?? mt('annualUnnamed', lang);
}

export function AnnualCatalogPicker({ lang, scope, contextKey, selected, onPick, onRemove, onRequestAddition, onInspect,
  disabled = false, api = realApi }: Props) {
  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [items, setItems] = useState<AnnualCatalogItemResult[] | null>(null);
  const [cursor, setCursor] = useState<AnnualCatalogCursor | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [selectionFailed, setSelectionFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const epoch = useRef(0);
  const queryId = useId();
  const token = `${scope.ownerOrgId}:${scope.planningYear}:${contextKey}`;

  useEffect(() => {
    epoch.current += 1;
    setQuery(''); setAppliedQuery(''); setItems(null); setCursor(null); setBusy(false); setPicking(null);
    setFailed(false); setSelectionFailed(false); setNotice(null);
    return () => { epoch.current += 1; };
  }, [token]);

  const matchesScope = (item: AnnualCatalogItemResult) => item.scope.ownerOrgId === scope.ownerOrgId
    && item.scope.planningYear === scope.planningYear;
  const choices = selected.filter(matchesScope);

  const search = async (more = false) => {
    if (disabled || busy || picking) return;
    const mine = ++epoch.current;
    const term = more ? appliedQuery : query.trim();
    setBusy(true); setFailed(false); setSelectionFailed(false); setNotice(null);
    if (!more) { setItems(null); setCursor(null); }
    try {
      const page = await api.searchAnnualCatalog(scope, term, 25, more ? cursor : null);
      if (epoch.current !== mine) return;
      setItems((previous) => {
        const rows = more ? [...(previous ?? [])] : [];
        for (const item of page.items) {
          const index = rows.findIndex((row) => row.membership.annualItemId === item.membership.annualItemId);
          if (index < 0) rows.push(item); else rows[index] = item;
        }
        return rows;
      });
      setCursor(page.nextCursor); setAppliedQuery(term);
    } catch {
      if (epoch.current === mine) setFailed(true);
    } finally {
      if (epoch.current === mine) setBusy(false);
    }
  };

  const pick = async (item: AnnualCatalogItemResult) => {
    if (disabled || busy || picking || !item.selectable || !matchesScope(item)) return;
    const mine = epoch.current;
    setPicking(item.membership.annualItemId); setSelectionFailed(false); setNotice(null);
    try {
      // A search result or replay receipt cannot authorize a new selection: re-read the current version.
      const fresh = await api.getAnnualCatalogItem(scope, item.membership.annualItemId);
      if (epoch.current !== mine) return;
      setItems((rows) => rows?.map((row) => row.membership.annualItemId === fresh.membership.annualItemId ? fresh : row) ?? null);
      if (!fresh.selectable || !matchesScope(fresh)) { setNotice(mt('annualSelectionChanged', lang)); return; }
      onPick(fresh);
    } catch {
      if (epoch.current === mine) setSelectionFailed(true);
    } finally {
      if (epoch.current === mine) setPicking(null);
    }
  };

  return <fieldset className="prism-material-picker prism-annual-picker" lang={lang} dir={lang === 'ar' ? 'rtl' : 'ltr'}
    disabled={disabled} aria-label={mt('annualCatalogTitle', lang)}>
    <legend>{mt('annualCatalogTitle', lang)} <bdi dir="ltr">{scope.planningYear}</bdi></legend>
    <p id={`${queryId}-hint`} className="prism-search-hint">{mt('annualSearchHint', lang)}</p>
    <form className="prism-search-form" onSubmit={(event) => { event.preventDefault(); void search(); }}>
      <label htmlFor={queryId}>
        <span className="sr-only">{mt('annualSearch', lang)}</span>
        <span className="prism-search-control"><PhoenixIcon name="search" size={18} aria-hidden="true" />
          <input id={queryId} type="search" value={query} maxLength={200} autoComplete="off" disabled={busy || picking !== null}
            aria-describedby={`${queryId}-hint`} placeholder={mt('annualSearch', lang)} onChange={(event) => setQuery(event.target.value)} />
        </span>
      </label>
      <button type="submit" disabled={busy || picking !== null}>{mt('annualSearchButton', lang)}</button>
    </form>
    <div role="status" aria-live="polite" className="prism-live-region">
      {(busy || picking) && <p className="prism-loading">{mt(picking ? 'annualCheckingSelection' : 'loading', lang)}</p>}
      {notice && <p className="prism-notice prism-notice--warning">{notice}</p>}
      {items !== null && items.length === 0 && !failed && !busy && <p className="prism-search-state">{mt('annualNoResults', lang)}</p>}
    </div>
    {failed && <p role="alert" className="prism-notice prism-notice--error">{mt('annualSearchFailed', lang)}</p>}
    {selectionFailed && <p role="alert" className="prism-notice prism-notice--error">{mt('annualSelectionFailed', lang)}</p>}
    {items !== null && items.length > 0 && <ul className="prism-result-list" aria-label={mt('annualResults', lang)}>
      {items.map((item) => {
        const id = item.membership.annualItemId;
        const picked = choices.some((choice) => choice.membership.annualItemId === id);
        return <li key={id} className="prism-result-row prism-annual-result" data-selected={picked}>
          <div className="prism-annual-result__identity">
            <PrismMaterialIdentity name={annualItemName(item, lang)} nationalCode={annualFieldText(item, 'nationalCode')}
              dosageForm={annualFieldText(item, 'dosageForm')} concentration={annualFieldText(item, 'concentration')} unit={annualFieldText(item, 'unit') ? manualUnitText(annualFieldText(item, 'unit'), lang) : null} />
            {!item.selectable && <ul className="prism-annual-blockers" aria-label={mt('annualSelectionBlocked', lang)}>
              {(item.selectionBlockers.length ? item.selectionBlockers : ['unavailable']).map((reason) =>
                <li key={reason}>{BLOCKERS[reason] ? mt(BLOCKERS[reason], lang) : <><span>{mt('annualSelectionBlocked', lang)}</span> <bdi>{reason}</bdi></>}</li>)}
            </ul>}
          </div>
          <div className="prism-annual-result__actions">
            <button type="button" onClick={() => void pick(item)} disabled={picked || !item.selectable || busy || picking !== null}>
              {picked && <PhoenixIcon name="check" size={15} aria-hidden="true" />}{mt(picked ? 'annualSelected' : 'annualSelect', lang)}
            </button>
            {onInspect && <button type="button" disabled={busy || picking !== null} onClick={() => onInspect(item)}>{mt('annualMaterialDetails', lang)}</button>}
          </div>
        </li>;
      })}
    </ul>}
    {cursor && <button type="button" className="prism-annual-more" disabled={busy || picking !== null} onClick={() => void search(true)}>{mt('annualLoadMore', lang)}</button>}
    {onRequestAddition && <button type="button" className="prism-annual-add" disabled={busy || picking !== null} onClick={onRequestAddition}>
      <PhoenixIcon name="editor" size={16} aria-hidden="true" />{mt('annualAddMissing', lang)}
    </button>}
    {choices.length > 0 && <section className="prism-selection" aria-label={mt('annualSelections', lang)}>
      <div className="prism-selection__header"><h4>{mt('annualSelections', lang)}</h4><span className="prism-selection__count"><bdi>{choices.length}</bdi> {mt('annualSelected', lang)}</span></div>
      <p className="prism-search-hint">{mt('annualSelectionsHint', lang)}</p>
      <ul className="prism-selected-list">{choices.map((item) => <li key={item.membership.annualItemId} className="prism-selected-row">
        <bdi>{annualItemName(item, lang)}</bdi>
        <button type="button" className="prism-remove-button" disabled={busy || picking !== null} onClick={() => onRemove(item.membership.annualItemId)}
          aria-label={`${mt('annualRemoveSelection', lang)} ${annualItemName(item, lang)}`}><PhoenixIcon name="close" size={18} aria-hidden="true" /></button>
      </li>)}</ul>
    </section>}
  </fieldset>;
}
