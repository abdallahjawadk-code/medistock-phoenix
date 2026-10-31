/**
 * R1-A4 — the manual annual-needs workspace for ONE plan revision.
 *
 * Contract: nothing here is optimistic. Every action calls a server routine, and the list shown is always
 * re-read from the server afterwards. A write carries the id of the last event the person saw for that
 * line (the stale fence) and one idempotency key per intent. A stale refusal refreshes the list and keeps
 * what the person typed. Switching organization or revision discards every response still in flight.
 * Rendering is gated by the server's own capability answer; the component never infers a permission.
 *
 * Not mounted in the Central Needs screen in R1-a (the routines are owner-only until R1-b).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import { PrismMaterialIdentity } from '@/shared/ui/prism/PrismMaterialIdentity';
import { CentralNeedsError } from '../central-needs.service';
import { centralNeedsErrorText } from '../central-needs.i18n';
import * as realApi from './manual-needs.service';
import { getManualCatalogLabels } from './manual-catalog.service';
import type { ManualCapabilities, ManualNeedEvent, ManualScope } from './manual-needs.service';
import { canEditManual, foldManualEvents, scopeKeyOf } from './manual-needs.view-model';
import { checkManualQuantityText, proposeAsciiDigits } from './manual-quantity';
import { mt, annualNeedsErrorText, manualUnitText, quantityReasonText, type ManualLang } from './manual-needs.i18n';
import { AnnualCatalogContractError, type AnnualCatalogItemResult } from '../annual-catalog/annual-catalog-server.contract';
import type { AnnualNeedBinding } from '../annual-catalog/annual-needs.contract';

export interface ManualNeedsApi {
  getManualCatalogLabels?: typeof getManualCatalogLabels;
  getManualCapabilities: typeof realApi.getManualCapabilities;
  listManualNeedEvents: typeof realApi.listManualNeedEvents;
  addManualNeedLine: typeof realApi.addManualNeedLine;
  correctManualNeedLine: typeof realApi.correctManualNeedLine;
  voidManualNeedLine: typeof realApi.voidManualNeedLine;
  newManualIdempotencyKey: typeof realApi.newManualIdempotencyKey;
}

interface Option { id: string; name: string }
interface ItemOption extends Option { nameAr?: string | null; unit: string; nationalCode?: string | null; concentration?: string | null; dosageForm?: string | null; annualItem?: AnnualCatalogItemResult }

interface Props {
  lang: ManualLang;
  organizationId: string;
  planRevisionId: string;
  revisionStatus: string;
  sourceMode: string;
  beneficiaries: Option[];
  items: ItemOption[];
  api?: ManualNeedsApi;
  onIdentityReady?: (ready: boolean) => void;
  onScopeLockChange?: (locked: boolean) => void;
  annualMode?: boolean;
  annualEntryEnabled?: boolean;
  beneficiaryId?: string;
  onBeneficiaryChange?: (id: string) => void;
}

const defaultApi: ManualNeedsApi = { ...realApi, getManualCatalogLabels };

type Pending =
  | { kind: 'add' }
  | { kind: 'correct'; scopeKey: string }
  | { kind: 'void'; scopeKey: string };

export function ManualNeedsWorkspace({ lang, organizationId, planRevisionId, revisionStatus, sourceMode, beneficiaries, items, api = defaultApi,
  onIdentityReady, onScopeLockChange, annualMode = false, annualEntryEnabled = true, beneficiaryId, onBeneficiaryChange }: Props) {
  const [caps, setCaps] = useState<ManualCapabilities | null>(null);
  const [events, setEvents] = useState<ManualNeedEvent[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retryingRead, setRetryingRead] = useState(false);
  const [persistedItems, setPersistedItems] = useState<ItemOption[]>([]);
  const [labelsFailed, setLabelsFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeKind, setNoticeKind] = useState<'info' | 'success' | 'warning'>('info');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [localBeneficiary, setBeneficiary] = useState('');
  const beneficiary = beneficiaryId ?? localBeneficiary;
  const [item, setItem] = useState('');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [quantityError, setQuantityError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const editorInput = useRef<HTMLInputElement | null>(null);

  // One idempotency key per intent; reused only for a retry of the SAME unsent/unanswered intent.
  const intentKey = useRef<string | null>(null);
  const scopeLocked = busy || intentKey.current !== null;
  const unresolvedIntent = !busy && intentKey.current !== null;
  // Responses of a previous organization/revision must never land in the current one.
  const epoch = useRef(0);

  const reset = useCallback(() => {
    setNotice(null); setNoticeKind('info'); setErrorText(null); setQuantityError(null); setFieldError(null);
    setQuantity(''); setReason(''); setPending(null); intentKey.current = null;
  }, []);

  const load = useCallback(async (myEpoch: number) => {
    try {
      const [c, e] = await Promise.all([
        api.getManualCapabilities(organizationId, planRevisionId),
        api.listManualNeedEvents(planRevisionId),
      ]);
      if (epoch.current !== myEpoch) return;
      setCaps(c); setEvents(e); setLoadFailed(false);
      if (annualMode) {
        // A bound event supplies its historical identity. A live canonical label cannot replace it.
        const rows = foldManualEvents(e);
        const unboundIds = [...new Set(e.filter((event) => !event.annualBinding).map((event) => event.centralItemId))];
        if (unboundIds.length > 0 && api.getManualCatalogLabels) {
          try {
            const labels = await api.getManualCatalogLabels(unboundIds);
            if (epoch.current !== myEpoch) return;
            setPersistedItems(labels); setLabelsFailed(false);
            // Existing submitted revisions remain reviewable. These labels are explicitly current, never fabricated snapshots.
            onIdentityReady?.(rows.filter((row) => row.live).every((row) => !!row.annualBinding || labels.some((label) => label.id === row.centralItemId)));
          } catch {
            if (epoch.current === myEpoch) { setLabelsFailed(true); onIdentityReady?.(rows.filter((row) => row.live).every((row) => !!row.annualBinding)); }
          }
        } else {
          setPersistedItems([]); setLabelsFailed(false);
          onIdentityReady?.(rows.filter((row) => row.live).every((row) => !!row.annualBinding));
        }
      } else if (api.getManualCatalogLabels && e.length > 0) {
        try {
          const labels = await api.getManualCatalogLabels(e.map((row) => row.centralItemId));
          if (epoch.current !== myEpoch) return;
          // Keep both raw labels: a language change must not restart scope loading
          // or erase an unsent quantity / unresolved write intent.
          setPersistedItems(labels);
          setLabelsFailed(false);
          onIdentityReady?.(e.every((row) => labels.some((label) => label.id === row.centralItemId)));
        } catch {
          if (epoch.current === myEpoch) { setLabelsFailed(true); onIdentityReady?.(false); }
        }
      } else onIdentityReady?.(true);
    } catch {
      if (epoch.current !== myEpoch) return;
      setLoadFailed(true);
    }
  }, [api, organizationId, planRevisionId, onIdentityReady, annualMode]);

  useEffect(() => {
    epoch.current += 1;
    const mine = epoch.current;
    setCaps(null); setEvents(null); setLoadFailed(false); setRetryingRead(false); setBeneficiary(''); setItem('');
    setPersistedItems([]); setLabelsFailed(false);
    onIdentityReady?.(false);
    reset();
    void load(mine);
    return () => { epoch.current += 1; };
  }, [organizationId, planRevisionId, load, reset]);

  useEffect(() => {
    onScopeLockChange?.(scopeLocked);
    return () => { onScopeLockChange?.(false); };
  }, [scopeLocked, onScopeLockChange]);

  // A removed temporary target must not carry its quantity into another target.
  // Do not discard an intent already sent; saved-line corrections are separate.
  useEffect(() => {
    if (scopeLocked || !item || items.some((candidate) => candidate.id === item)) return;
    setItem('');
    if (!pending || pending.kind === 'add') {
      reset(); setNotice(mt('removedChoice', lang));
    }
  }, [items, item, pending, scopeLocked, reset, lang]);

  const rows = useMemo(() => foldManualEvents(events ?? []), [events]);
  const displayItems = useMemo(() => {
    const persisted = persistedItems.map((row) => ({ ...row, name: lang === 'ar' && row.nameAr ? row.nameAr : row.name }));
    return annualMode ? [...items, ...persisted.filter((row) => !items.some((item) => item.id === row.id))]
      : [...persisted, ...items.filter((item) => !persisted.some((row) => row.id === item.id))];
  }, [items, persistedItems, lang, annualMode]);
  const editable = caps !== null && canEditManual({ status: revisionStatus, sourceMode, manualSet: caps.manualSet });
  const entryEnabled = editable && (!annualMode || annualEntryEnabled);
  const nameOf = (list: Option[], id: string) => list.find((o) => o.id === id)?.name ?? id;
  const unitOf = (id: string) => displayItems.find((o) => o.id === id)?.unit ?? '';
  const itemNameOf = (id: string) => displayItems.find((o) => o.id === id)?.name ?? (lang === 'ar' ? 'تعذر تحميل اسم المادة' : 'Material name unavailable');
  const currentCanonicalName = (id: string) => {
    const label = persistedItems.find((item) => item.id === id);
    return (lang === 'ar' ? label?.nameAr : null) ?? label?.name ?? (lang === 'ar' ? 'تعذر تحميل اسم المادة' : 'Material name unavailable');
  };
  const boundText = (binding: AnnualNeedBinding, field: keyof AnnualNeedBinding['fields']) => {
    const value = binding.fields[field];
    return value.state === 'known' ? value.value : null;
  };
  const boundName = (binding: AnnualNeedBinding) => (lang === 'ar' ? boundText(binding, 'nameAr') : null)
    ?? boundText(binding, 'scientificName') ?? mt('annualUnnamed', lang);

  const validateQuantity = (text: string): boolean => {
    const c = checkManualQuantityText(text);
    if (c.ok) { setQuantityError(null); return true; }
    let msg = quantityReasonText(c.reason, lang);
    const proposal = c.reason === 'non_ascii_digits' ? proposeAsciiDigits(text) : null;
    if (proposal) msg += ' ' + mt('q_proposal', lang).replace('__Q__', proposal);
    setQuantityError(msg);
    return false;
  };

  const run = async (action: () => Promise<{ idempotentReplay: boolean }>) => {
    const mine = epoch.current;
    setBusy(true); setErrorText(null); setNotice(null);
    try {
      const r = await action();
      if (epoch.current !== mine) return;
      intentKey.current = null;
      await load(mine);
      if (epoch.current !== mine) return;
      setNoticeKind('success'); setNotice(r.idempotentReplay ? mt('replay', lang) : mt('saved', lang));
      setQuantity(''); setReason(''); setPending(null);
    } catch (e: unknown) {
      if (epoch.current !== mine) return;
      if (e instanceof CentralNeedsError) {
        setErrorText((annualMode ? annualNeedsErrorText(e.businessCode, lang) : null) ?? centralNeedsErrorText(e, lang));
        // The service wraps fetch failures in this generic error without SQLSTATE.
        // It is not a definitive database refusal: retain the exact intent for replay.
        const unknownOutcome = e.businessCode === 'central_needs_request_failed' && e.sqlstate === null;
        if (!unknownOutcome) intentKey.current = null;
        if (e.businessCode === 'manual_need_line_stale') { setNoticeKind('warning'); setNotice(mt('staleRefreshed', lang)); await load(mine); }
      } else if (e instanceof AnnualCatalogContractError) {
        setErrorText(mt(e.outcomeUnknown ? 'annualNeedUnknown' : 'annualBindingRequired', lang));
        if (!e.outcomeUnknown) intentKey.current = null;
      } else {
        setErrorText(centralNeedsErrorText('load_failed', lang)); // transport failure: keep the SAME key for the retry
      }
    } finally {
      if (epoch.current === mine) setBusy(false);
    }
  };

  const key = () => (intentKey.current ??= api.newManualIdempotencyKey());

  const submitAdd = () => {
    if (!beneficiary || !item) { setFieldError(mt('scopeRequired', lang)); return; }
    if (!validateQuantity(quantity)) return;
    if (reason.trim() === '') { setFieldError(mt('reasonRequired', lang)); return; }
    setFieldError(null);
    const scope: ManualScope = { planRevisionId, beneficiaryOrganizationId: beneficiary, centralItemId: item, targetWarehouseId: null };
    const existing = rows.find((r) => r.scopeKey === scopeKeyOf({ beneficiaryOrganizationId: beneficiary, centralItemId: item, targetWarehouseId: null }));
    void run(() => api.addManualNeedLine(scope, quantity, reason, key(), existing ? existing.lastEventId : null));
  };

  const submitPending = () => {
    if (!pending || pending.kind === 'add') return;
    // the row is resolved from the CURRENT server list, so a refresh after a stale refusal advances the fence
    const row = rows.find((r) => r.scopeKey === pending.scopeKey && r.live);
    if (!row) { setNoticeKind('warning'); setNotice(mt('staleRefreshed', lang)); setPending(null); return; }
    const scope: ManualScope = { planRevisionId, beneficiaryOrganizationId: row.beneficiaryOrganizationId, centralItemId: row.centralItemId, targetWarehouseId: row.targetWarehouseId };
    if (reason.trim() === '') { setFieldError(mt('reasonRequired', lang)); return; }
    setFieldError(null);
    if (pending.kind === 'correct') {
      if (!validateQuantity(quantity)) return;
      void run(() => api.correctManualNeedLine(scope, quantity, reason, key(), row.lastEventId));
    } else {
      void run(() => api.voidManualNeedLine(scope, reason, key(), row.lastEventId));
    }
  };

  const startPending = (p: Pending) => { reset(); setPending(p); };

  const changeTarget = (field: 'beneficiary' | 'item', value: string) => {
    if (scopeLocked || value === (field === 'beneficiary' ? beneficiary : item)) return;
    const hadInput = quantity !== '' || reason !== '';
    reset();
    if (field === 'beneficiary') {
      if (onBeneficiaryChange) { onBeneficiaryChange(value); setItem(''); }
      else setBeneficiary(value);
    } else setItem(value);
    if (hadInput) setNotice(mt('changedTarget', lang));
  };

  useEffect(() => {
    if (pending) editorInput.current?.focus();
  }, [pending]);

  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const editingRow = pending && pending.kind !== 'add' ? rows.find((row) => row.scopeKey === pending.scopeKey) : undefined;
  const editorItemId = editingRow?.centralItemId ?? item;
  const editorItem = displayItems.find((candidate) => candidate.id === editorItemId);
  const selectedAnnualItem = items.find((candidate) => candidate.id === editorItemId)?.annualItem;
  const editorBinding = annualMode && editingRow && pending?.kind === 'correct' && selectedAnnualItem
    ? { ...selectedAnnualItem.fieldVersion, canonicalItemId: selectedAnnualItem.membership.canonicalItemId ?? '' }
    : editingRow?.annualBinding;
  const editorUnit = editorBinding ? boundText(editorBinding, 'unit') ?? '' : editingRow?.approvedUnit ?? editorItem?.unit ?? '';
  const visibleRows = annualMode && beneficiary ? rows.filter((row) => row.beneficiaryOrganizationId === beneficiary) : rows;

  if (loadFailed) {
    return <section className="prism-needs-workspace" lang={lang} dir={dir} aria-label={mt('title', lang)}>
      <p role="alert" className="prism-notice prism-notice--error">{mt('loadFailed', lang)}</p>
      <button type="button" disabled={busy} onClick={() => {
        const mine = epoch.current;
        setRetryingRead(true); setLoadFailed(false);
        void load(mine).finally(() => { if (epoch.current === mine) setRetryingRead(false); });
      }}><PhoenixIcon name="refresh" size={16} aria-hidden="true" />{mt('retryRead', lang)}</button>
    </section>;
  }
  if (caps === null || events === null || retryingRead) {
    return <section className="prism-needs-workspace" lang={lang} dir={dir} aria-label={mt('title', lang)} aria-busy="true"><p role="status" className="prism-loading"><span className="prism-loading__dot" aria-hidden="true" />{mt('loading', lang)}</p></section>;
  }

  return (
    <section className="prism-needs-workspace" lang={lang} dir={dir} aria-labelledby="manual-needs-title" data-testid="manual-needs-workspace">
      <header><h2 id="manual-needs-title">{mt('title', lang)}</h2></header>
      {!caps.manualSet && <p role="note" className="prism-notice">{mt('notEnabled', lang)}</p>}
      {caps.manualSet && !editable && <p role="note" className="prism-notice">{mt('readOnlyRevision', lang)}</p>}

      <div role="status" aria-live="polite" className={`prism-notice${noticeKind === 'info' ? '' : ` prism-notice--${noticeKind}`}`}>{notice}</div>
      {errorText && <p role="alert" className="prism-notice prism-notice--error">{errorText}</p>}
      {unresolvedIntent && <p role="note" className="prism-notice prism-notice--warning">{mt('unknownOutcome', lang)}</p>}
      {labelsFailed && <p role="alert" className="prism-notice prism-notice--error">{lang === 'ar' ? 'تعذر تحميل بعض أسماء المواد. لم تتغير البيانات المحفوظة.' : 'Some material names could not be loaded. Saved data is unchanged.'}</p>}

      {editable && (entryEnabled || pending?.kind === 'void') && (
        <form
          className="prism-line-form"
          onSubmit={(ev) => { ev.preventDefault(); if (pending && pending.kind !== 'add') submitPending(); else submitAdd(); }}
          aria-label={pending && pending.kind !== 'add' ? mt(pending.kind, lang) : mt('add', lang)}
          aria-busy={busy}
        >
          {(!pending || pending.kind === 'add') && (
            <div className="prism-line-form__fields">
              {beneficiaryId === undefined && <label>{mt('beneficiary', lang)}
                <select value={beneficiary} onChange={(e) => changeTarget('beneficiary', e.target.value)} disabled={scopeLocked}>
                  <option value="">{mt('choose', lang)}</option>
                  {beneficiaries.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </label>}
              {beneficiaryId !== undefined && <p className="prism-context-chip">{mt('beneficiary', lang)}: <bdi>{nameOf(beneficiaries, beneficiaryId) || mt('choose', lang)}</bdi></p>}
              <label>{mt('item', lang)}
                <select value={item} onChange={(e) => changeTarget('item', e.target.value)} disabled={scopeLocked}>
                  <option value="">{mt('choose', lang)}</option>
                  {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                </select>
              </label>
            </div>
          )}
          {editorItemId && (
            <div className="prism-line-form__identity">
              {editingRow && <p><bdi>{nameOf(beneficiaries, editingRow.beneficiaryOrganizationId)}</bdi></p>}
              <PrismMaterialIdentity name={editorBinding ? boundName(editorBinding) : itemNameOf(editorItemId)}
                nationalCode={editorBinding ? boundText(editorBinding, 'nationalCode') : editorItem?.nationalCode}
                concentration={editorBinding ? boundText(editorBinding, 'concentration') : editorItem?.concentration}
                dosageForm={editorBinding ? boundText(editorBinding, 'dosageForm') : editorItem?.dosageForm} unit={editorUnit ? manualUnitText(editorUnit, lang) : ''} />
              {annualMode && editingRow && !editingRow.annualBinding && <p className="prism-notice prism-notice--warning">{mt('annualHistoricalUnbound', lang)}</p>}
              {annualMode && editingRow && selectedAnnualItem && pending?.kind === 'correct'
                && selectedAnnualItem.fieldVersion.fieldVersionId !== editingRow.annualBinding?.fieldVersionId
                && <p className="prism-search-hint">{mt('annualCorrectionUsesSelection', lang)}</p>}
            </div>
          )}
          {(!pending || pending.kind !== 'void') && (
            <div className="prism-line-form__quantity">
            <label>{mt('quantity', lang)}
              <input
                ref={editorInput}
                className="prism-quantity-input" dir="ltr" inputMode="decimal" autoComplete="off" value={quantity} disabled={scopeLocked}
                aria-invalid={quantityError !== null} aria-describedby="manual-qty-hint manual-qty-error"
                onChange={(e) => { setQuantity(e.target.value); if (quantityError) validateQuantity(e.target.value); }}
              />
            </label>
            {editorUnit && <span className="prism-unit"><span className="sr-only">{mt('unit', lang)}: </span><bdi>{manualUnitText(editorUnit, lang)}</bdi></span>}
            </div>
          )}
          {(!pending || pending.kind !== 'void') && <p id="manual-qty-hint" className="prism-field-hint">{mt('quantityHint', lang)}</p>}
          <p id="manual-qty-error" role="alert" className="prism-field-error">{quantityError}</p>
          <label>{mt('reason', lang)}
            <input ref={pending?.kind === 'void' ? editorInput : undefined} value={reason} disabled={scopeLocked} onChange={(e) => setReason(e.target.value)} />
          </label>
          {fieldError && <p role="alert" className="prism-field-error">{fieldError}</p>}
          <div className="prism-form-actions">
            <button type="submit" disabled={busy}><PhoenixIcon name="save" size={17} aria-hidden="true" />{pending && pending.kind !== 'add' ? mt('save', lang) : mt('add', lang)}</button>
            {pending && <button type="button" disabled={scopeLocked} onClick={() => { reset(); }}>{mt('cancel', lang)}</button>}
          </div>
          {busy && <p role="status" className="prism-loading"><span className="prism-loading__dot" aria-hidden="true" />{mt('saving', lang)}</p>}
        </form>
      )}

      <div className="prism-saved-lines">
        {visibleRows.length === 0 ? (
          <section className="prism-empty-records" aria-label={mt('savedLines', lang)}>
            <h3>{mt('savedLines', lang)}</h3>
            <div className="prism-empty-lines">
              <PhoenixIcon name="clipboard" size={24} aria-hidden="true" />
              <p>{mt('empty', lang)}</p>
              {editable && <p>{mt('emptyHint', lang)}</p>}
            </div>
          </section>
        ) : <div className="prism-table-scroll" role="region" aria-label={mt('savedLines', lang)} tabIndex={0}>
          <table>
            <caption>{mt('savedLines', lang)}</caption>
            <thead>
              <tr>
                <th scope="col">{mt('beneficiary', lang)}</th>
                <th scope="col">{mt('item', lang)}</th>
                <th scope="col">{mt('quantity', lang)}</th>
                <th scope="col">{mt('unit', lang)}</th>
                {editable && <th scope="col"><span className="sr-only">{mt('correct', lang)}</span></th>}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((r) => (
                <tr key={r.scopeKey} data-live={r.live ? 'true' : 'false'}>
                  <td><bdi>{nameOf(beneficiaries, r.beneficiaryOrganizationId)}</bdi></td>
                  <td><bdi>{annualMode ? (r.annualBinding ? boundName(r.annualBinding) : currentCanonicalName(r.centralItemId)) : itemNameOf(r.centralItemId)}</bdi>
                    {annualMode && !r.annualBinding && <small className="prism-table-code">{mt('annualCurrentCanonicalLabel', lang)}</small>}
                    {(r.annualBinding ? boundText(r.annualBinding, 'nationalCode') : !annualMode && displayItems.find((i) => i.id === r.centralItemId)?.nationalCode) && <small className="prism-table-code"><bdi dir="ltr">{r.annualBinding ? boundText(r.annualBinding, 'nationalCode') : displayItems.find((i) => i.id === r.centralItemId)?.nationalCode}</bdi></small>}
                    {annualMode && <details className="prism-need-event-history"><summary>{mt('annualNeedHistory', lang)}</summary><ol>{r.history.map((event) => <li key={event.id}>
                      <p><strong>{event.fromTrustedProfile && event.actorName ? event.actorName : mt('annualHistoricalActorMissing', lang)}</strong>
                        {event.createdAt && <> · <time dateTime={event.createdAt}>{new Intl.DateTimeFormat(lang === 'ar' ? 'ar-IQ' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Baghdad' }).format(new Date(event.createdAt))} {mt('annualBaghdadTime', lang)}</time></>}</p>
                      <p>{event.reason}</p>
                      {event.annualBinding ? <PrismMaterialIdentity compact name={boundName(event.annualBinding)} nationalCode={boundText(event.annualBinding, 'nationalCode')}
                        dosageForm={boundText(event.annualBinding, 'dosageForm')} concentration={boundText(event.annualBinding, 'concentration')} unit={event.approvedUnit ? manualUnitText(event.approvedUnit, lang) : null} /> : <p>{mt('annualHistoricalUnbound', lang)}. {mt('annualCurrentCanonicalLabel', lang)}: <bdi>{currentCanonicalName(event.centralItemId)}</bdi></p>}
                      <p>{event.eventKind === 'void' ? mt('voided', lang) : <bdi dir="ltr">{event.quantityText}</bdi>}</p>
                    </li>)}</ol></details>}
                  </td>
                  <td dir="ltr">{r.live ? r.quantityText : mt('voided', lang)}</td>
                  <td>{r.live ? manualUnitText(r.approvedUnit ?? unitOf(r.centralItemId), lang) : ''}</td>
                  {editable && <td>{r.live && <div className="prism-row-actions">
                    <button type="button" disabled={scopeLocked || !entryEnabled || (annualMode && r.beneficiaryOrganizationId !== beneficiary)} onClick={() => startPending({ kind: 'correct', scopeKey: r.scopeKey })}>{mt('correct', lang)}</button>
                    <button type="button" className="prism-button--danger" disabled={scopeLocked || (annualMode && r.beneficiaryOrganizationId !== beneficiary)} onClick={() => startPending({ kind: 'void', scopeKey: r.scopeKey })}>{mt('void', lang)}</button>
                  </div>}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>}
      </div>
    </section>
  );
}
