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
import { CentralNeedsError } from '../central-needs.service';
import { centralNeedsErrorText } from '../central-needs.i18n';
import * as realApi from './manual-needs.service';
import type { ManualCapabilities, ManualNeedEvent, ManualScope } from './manual-needs.service';
import { canEditManual, foldManualEvents, scopeKeyOf } from './manual-needs.view-model';
import { checkManualQuantityText, proposeAsciiDigits } from './manual-quantity';
import { mt, quantityReasonText, type ManualLang } from './manual-needs.i18n';

export interface ManualNeedsApi {
  getManualCapabilities: typeof realApi.getManualCapabilities;
  listManualNeedEvents: typeof realApi.listManualNeedEvents;
  addManualNeedLine: typeof realApi.addManualNeedLine;
  correctManualNeedLine: typeof realApi.correctManualNeedLine;
  voidManualNeedLine: typeof realApi.voidManualNeedLine;
  newManualIdempotencyKey: typeof realApi.newManualIdempotencyKey;
}

interface Option { id: string; name: string }
interface ItemOption extends Option { unit: string }

interface Props {
  lang: ManualLang;
  organizationId: string;
  planRevisionId: string;
  revisionStatus: string;
  sourceMode: string;
  beneficiaries: Option[];
  items: ItemOption[];
  api?: ManualNeedsApi;
}

type Pending =
  | { kind: 'add' }
  | { kind: 'correct'; scopeKey: string }
  | { kind: 'void'; scopeKey: string };

export function ManualNeedsWorkspace({ lang, organizationId, planRevisionId, revisionStatus, sourceMode, beneficiaries, items, api = realApi }: Props) {
  const [caps, setCaps] = useState<ManualCapabilities | null>(null);
  const [events, setEvents] = useState<ManualNeedEvent[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [beneficiary, setBeneficiary] = useState('');
  const [item, setItem] = useState('');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [quantityError, setQuantityError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  // One idempotency key per intent; reused only for a retry of the SAME unsent/unanswered intent.
  const intentKey = useRef<string | null>(null);
  // Responses of a previous organization/revision must never land in the current one.
  const epoch = useRef(0);

  const reset = useCallback(() => {
    setNotice(null); setErrorText(null); setQuantityError(null); setFieldError(null);
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
    } catch {
      if (epoch.current !== myEpoch) return;
      setLoadFailed(true);
    }
  }, [api, organizationId, planRevisionId]);

  useEffect(() => {
    epoch.current += 1;
    const mine = epoch.current;
    setCaps(null); setEvents(null); setLoadFailed(false); setBeneficiary(''); setItem('');
    reset();
    void load(mine);
    return () => { epoch.current += 1; };
  }, [organizationId, planRevisionId, load, reset]);

  const rows = useMemo(() => foldManualEvents(events ?? []), [events]);
  const editable = caps !== null && canEditManual({ status: revisionStatus, sourceMode, manualSet: caps.manualSet });
  const nameOf = (list: Option[], id: string) => list.find((o) => o.id === id)?.name ?? id;
  const unitOf = (id: string) => items.find((o) => o.id === id)?.unit ?? '';

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
      setNotice(r.idempotentReplay ? mt('replay', lang) : mt('saved', lang));
      setQuantity(''); setReason(''); setPending(null);
    } catch (e: unknown) {
      if (epoch.current !== mine) return;
      if (e instanceof CentralNeedsError) {
        setErrorText(centralNeedsErrorText(e, lang));
        // a definitive server answer ends the intent; a stale answer also refreshes the list
        intentKey.current = null;
        if (e.businessCode === 'manual_need_line_stale') { setNotice(mt('staleRefreshed', lang)); await load(mine); }
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
    if (!row) { setNotice(mt('staleRefreshed', lang)); setPending(null); return; }
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

  const dir = lang === 'ar' ? 'rtl' : 'ltr';

  if (loadFailed) {
    return <section dir={dir} aria-label={mt('title', lang)}><p role="alert">{mt('loadFailed', lang)}</p></section>;
  }
  if (caps === null || events === null) {
    return <section dir={dir} aria-label={mt('title', lang)} aria-busy="true"><p role="status">{mt('loading', lang)}</p></section>;
  }

  return (
    <section dir={dir} aria-labelledby="manual-needs-title" data-testid="manual-needs-workspace">
      <h2 id="manual-needs-title">{mt('title', lang)}</h2>
      {!caps.manualSet && <p role="note">{mt('notEnabled', lang)}</p>}
      {caps.manualSet && !editable && <p role="note">{mt('readOnlyRevision', lang)}</p>}

      <div role="status" aria-live="polite">{notice}</div>
      {errorText && <p role="alert">{errorText}</p>}

      <div className="pharma-table-scroll" role="region" aria-label={mt('title', lang)} tabIndex={0}>
      <table>
        <caption>{mt('title', lang)}</caption>
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
          {rows.length === 0 && <tr><td colSpan={editable ? 5 : 4}>{mt('empty', lang)}</td></tr>}
          {rows.map((r) => (
            <tr key={r.scopeKey} data-live={r.live ? 'true' : 'false'}>
              <td>{nameOf(beneficiaries, r.beneficiaryOrganizationId)}</td>
              <td>{nameOf(items, r.centralItemId)}</td>
              <td dir="ltr">{r.live ? r.quantityText : mt('voided', lang)}</td>
              <td>{r.live ? (r.approvedUnit ?? unitOf(r.centralItemId)) : ''}</td>
              {editable && (
                <td>
                  {r.live && (
                    <>
                      <button type="button" disabled={busy} onClick={() => startPending({ kind: 'correct', scopeKey: r.scopeKey })}>{mt('correct', lang)}</button>
                      <button type="button" disabled={busy} onClick={() => startPending({ kind: 'void', scopeKey: r.scopeKey })}>{mt('void', lang)}</button>
                    </>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      {editable && (
        <form
          onSubmit={(ev) => { ev.preventDefault(); if (pending && pending.kind !== 'add') submitPending(); else submitAdd(); }}
          aria-label={pending && pending.kind !== 'add' ? mt(pending.kind, lang) : mt('add', lang)}
        >
          {(!pending || pending.kind === 'add') && (
            <>
              <label>{mt('beneficiary', lang)}
                <select value={beneficiary} onChange={(e) => setBeneficiary(e.target.value)} disabled={busy}>
                  <option value="">{mt('choose', lang)}</option>
                  {beneficiaries.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </label>
              <label>{mt('item', lang)}
                <select value={item} onChange={(e) => setItem(e.target.value)} disabled={busy}>
                  <option value="">{mt('choose', lang)}</option>
                  {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                </select>
              </label>
            </>
          )}
          {pending && pending.kind !== 'add' && (() => {
            const cur = rows.find((r) => r.scopeKey === pending.scopeKey);
            return cur ? <p>{nameOf(beneficiaries, cur.beneficiaryOrganizationId)} — {nameOf(items, cur.centralItemId)}</p> : null;
          })()}
          {(!pending || pending.kind !== 'void') && (
            <label>{mt('quantity', lang)}
              <input
                dir="ltr" inputMode="decimal" autoComplete="off" value={quantity} disabled={busy}
                aria-invalid={quantityError !== null} aria-describedby="manual-qty-hint manual-qty-error"
                onChange={(e) => { setQuantity(e.target.value); if (quantityError) validateQuantity(e.target.value); }}
              />
            </label>
          )}
          <p id="manual-qty-hint">{mt('quantityHint', lang)}</p>
          <p id="manual-qty-error" role="alert">{quantityError}</p>
          <label>{mt('reason', lang)}
            <input value={reason} disabled={busy} onChange={(e) => setReason(e.target.value)} />
          </label>
          {fieldError && <p role="alert">{fieldError}</p>}
          <button type="submit" disabled={busy}>{pending && pending.kind !== 'add' ? mt('save', lang) : mt('add', lang)}</button>
          {pending && <button type="button" disabled={busy} onClick={() => { reset(); }}>{mt('cancel', lang)}</button>}
        </form>
      )}
    </section>
  );
}
