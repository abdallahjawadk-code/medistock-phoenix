/**
 * R1-A2/A4 — the governed material-registration surface: request a NEW material (never a catalog write from the client),
 * and - for an authorized reviewer - review it (same actor only after the M232 contract). Every action calls a server routine and the list is re-read afterwards (no
 * optimistic state). A stale answer refreshes and keeps what the person typed; a response of another organization is discarded.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { CentralNeedsError } from '../central-needs.service';
import * as realApi from './material-registration.service';
import type {
  ExcelAssistProvenance, MaterialCandidate, MaterialCapabilities, MaterialDescriptor, MaterialRequest, MaterialRequestEvent, MaterialUnit,
} from './material-registration.service';
import { MATERIAL_UNITS } from './material-registration.service';
import { jt, journeyErrorText, type JourneyKey, type JourneyLang } from './manual-journey.i18n';

export interface RegistrationApi {
  getMaterialCapabilities: typeof realApi.getMaterialCapabilities;
  listMaterialRequests: typeof realApi.listMaterialRequests;
  listMaterialRequestEvents: typeof realApi.listMaterialRequestEvents;
  listMaterialRequestCandidates: typeof realApi.listMaterialRequestCandidates;
  createMaterialRequestDraft: typeof realApi.createMaterialRequestDraft;
  updateMaterialRequestDraft: typeof realApi.updateMaterialRequestDraft;
  submitMaterialRequest: typeof realApi.submitMaterialRequest;
  startMaterialReview: typeof realApi.startMaterialReview;
  requestMaterialInfo: typeof realApi.requestMaterialInfo;
  resolveMaterialExisting: typeof realApi.resolveMaterialExisting;
  approveNewMaterial: typeof realApi.approveNewMaterial;
  rejectMaterialRequest: typeof realApi.rejectMaterialRequest;
  cancelMaterialRequest: typeof realApi.cancelMaterialRequest;
  linkMaterialRequestToDraft: typeof realApi.linkMaterialRequestToDraft;
  newMaterialIdempotencyKey: typeof realApi.newMaterialIdempotencyKey;
}

export interface RegistrationPrefill { descriptor: Partial<MaterialDescriptor>; pointer: ExcelAssistProvenance | null }
export interface ResolvedMaterialUse { id: string; name: string; nameAr: string | null; concentration: string | null; dosageForm: string | null; unit: string }

interface Props {
  lang: JourneyLang;
  organizationId: string;
  /** The signed-in user (to tell "my request" from someone else's). */
  actorId: string;
  /** The manual DRAFT revision being worked on, if any: the target of the explicit link. */
  planRevisionId: string | null;
  prefill: RegistrationPrefill | null;
  onUseItem: (item: ResolvedMaterialUse) => void;
  api?: RegistrationApi;
  nationalCodeEnabled?: boolean;
  sameActorEnabled?: boolean;
}

/** Mirrors the server's PROVISIONAL review cap (approve_new_material refuses above it). 50 is an engineering fail-closed value, NOT an owner-approved product
 *  policy (decision pending - see R1-A2-REVIEW-CAP-OWNER-DECISION-PENDING.md); the server remains the authority. */
const MAX_REVIEWABLE_ADVISORY = 50;
/** The unit has NO default: it must be chosen explicitly (a workbook-suggested unit that is not in the vocabulary is never guessed). */
type FormState = Omit<MaterialDescriptor, 'unit'> & { unit: MaterialUnit | '' };
const EMPTY: FormState = { scientificName: '', nameAr: null, tradeName: null, strength: null, dosageForm: null, unit: '', barcode: null, note: null };
const orNull = (s: string): string | null => (s.trim() === '' ? null : s);

export function MaterialRegistrationPanel({ lang, organizationId, actorId, planRevisionId, prefill, onUseItem, api = realApi, nationalCodeEnabled = false, sameActorEnabled = false }: Props) {
  const [caps, setCaps] = useState<MaterialCapabilities | null>(null);
  const [requests, setRequests] = useState<MaterialRequest[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [editing, setEditing] = useState<{ id: string; version: number } | null>(null);
  const [pointer, setPointer] = useState<ExcelAssistProvenance | null>(null);
  const [open, setOpen] = useState<string | null>(null);                 // expanded request id
  const [events, setEvents] = useState<MaterialRequestEvent[]>([]);
  const [candidates, setCandidates] = useState<MaterialCandidate[]>([]);
  const [acks, setAcks] = useState<Set<string>>(new Set());
  const [decisionNote, setDecisionNote] = useState('');
  const [assignCode, setAssignCode] = useState<Set<string>>(new Set());
  const intentKey = useRef<string | null>(null);
  const epoch = useRef(0);

  const load = useCallback(async (mine: number) => {
    try {
      const [c, r] = await Promise.all([api.getMaterialCapabilities(organizationId), api.listMaterialRequests(organizationId)]);
      if (epoch.current !== mine) return;
      setCaps(c); setRequests(r); setLoadFailed(false);
    } catch {
      if (epoch.current !== mine) return;
      setLoadFailed(true);
    }
  }, [api, organizationId]);

  useEffect(() => {
    epoch.current += 1;
    const mine = epoch.current;
    setCaps(null); setRequests(null); setLoadFailed(false); setForm(EMPTY); setEditing(null); setOpen(null); setNotice(null); setErrorText(null);
    intentKey.current = null;
    void load(mine);
    return () => { epoch.current += 1; };
  }, [organizationId, load]);

  useEffect(() => {
    if (!prefill) return;
    setForm({ ...EMPTY, ...prefill.descriptor, unit: (prefill.descriptor.unit ?? '') as MaterialUnit | '' });
    setPointer(prefill.pointer); setEditing(null); intentKey.current = null;
  }, [prefill]);

  const act = async (fn: () => Promise<unknown>, done?: () => void) => {
    const mine = epoch.current;
    setBusy(true); setErrorText(null); setNotice(null);
    try {
      await fn();
      if (epoch.current !== mine) return;
      intentKey.current = null;
      await load(mine);
      if (epoch.current !== mine) return;
      done?.();
      setNotice(jt('decided_ok', lang));
    } catch (e: unknown) {
      if (epoch.current !== mine) return;
      if (e instanceof CentralNeedsError) {
        setErrorText(journeyErrorText(e, lang));
        intentKey.current = null;
        if (e.businessCode === 'material_request_stale') { setNotice(jt('err_material_request_stale', lang)); await load(mine); }
      } else {
        setErrorText(jt('err_load_failed', lang));                      // transport failure: the SAME key is kept for the retry
      }
    } finally {
      if (epoch.current === mine) setBusy(false);
    }
  };

  const key = () => (intentKey.current ??= api.newMaterialIdempotencyKey());
  const descriptor = (): MaterialDescriptor => ({
    ...form, unit: form.unit as MaterialUnit, scientificName: form.scientificName.trim(), nameAr: orNull(form.nameAr ?? ''), tradeName: orNull(form.tradeName ?? ''),
    strength: orNull(form.strength ?? ''), dosageForm: orNull(form.dosageForm ?? ''), barcode: orNull(form.barcode ?? ''), ...(nationalCodeEnabled ? { nationalCode: orNull(form.nationalCode ?? '') } : {}), note: orNull(form.note ?? ''),
  });
  const resolveExisting = (r: MaterialRequest, c: MaterialCandidate) => act(() =>
    nationalCodeEnabled && r.nationalCode
      ? api.resolveMaterialExisting(r.id,r.version,c.centralItemId,decisionNote || jt('reg_resolve_existing',lang),{expected:c.nationalCode ?? null})
      : api.resolveMaterialExisting(r.id,r.version,c.centralItemId,decisionNote || jt('reg_resolve_existing',lang)));
  const approveMaterial = (r: MaterialRequest) => act(() =>
    nationalCodeEnabled
      ? api.approveNewMaterial(r.id,r.version,[...acks],decisionNote || jt('reg_approve_new',lang),r.nationalCode ?? null)
      : api.approveNewMaterial(r.id,r.version,[...acks],decisionNote || jt('reg_approve_new',lang)));

  const canSave = form.scientificName.trim() !== '' && form.unit !== '' && !busy;

  const save = () => {
    const d = descriptor();
    if (editing) return act(() => api.updateMaterialRequestDraft(editing.id, editing.version, d), () => { setEditing(null); setForm(EMPTY); });
    return act(
      () => api.createMaterialRequestDraft(organizationId, d, key(), pointer ? { kind: 'excel_assist', pointer } : { kind: 'manual_typed' }, planRevisionId),
      () => { setForm(EMPTY); setPointer(null); },
    );
  };

  const expand = async (r: MaterialRequest) => {
    if (open === r.id) { setOpen(null); return; }
    const mine = epoch.current;
    setAssignCode(new Set()); setOpen(r.id); setEvents([]); setCandidates([]); setAcks(new Set()); setDecisionNote('');
    try {
      const [ev, cand] = await Promise.all([
        api.listMaterialRequestEvents(r.id),
        caps?.canReview && r.status === 'under_review' && r.reviewerId === actorId && (sameActorEnabled || r.requesterId !== actorId)
          ? (nationalCodeEnabled ? api.listMaterialRequestCandidates(r.id, true) : api.listMaterialRequestCandidates(r.id)) : Promise.resolve([] as MaterialCandidate[]),
      ]);
      if (epoch.current !== mine) return;
      setEvents(ev); setCandidates(cand);
    } catch { if (epoch.current === mine) setErrorText(jt('failed', lang)); }
  };

  if (loadFailed) return <section aria-label={jt('reg_title', lang)}><p role="alert">{jt('failed', lang)}</p></section>;
  if (!caps || !requests) return <section aria-label={jt('reg_title', lang)} aria-busy="true"><p role="status">{jt('loading', lang)}</p></section>;

  const statusText = (s: string) => jt(`reg_status_${s}` as JourneyKey, lang);
  const strong = candidates.filter((c) => c.grade === 'strong');
  const advisory = candidates.filter((c) => c.grade === 'advisory');
  const allAcked = advisory.every((c) => acks.has(c.centralItemId));
  const tooMany = advisory.length > MAX_REVIEWABLE_ADVISORY;

  return (
    <section aria-labelledby="reg-title" data-testid="material-registration-panel">
      <h3 id="reg-title">{jt('reg_title', lang)}</h3>
      <div role="status" aria-live="polite">{notice}</div>
      {errorText && <p role="alert">{errorText}</p>}

      {caps.canRequest && (
        <form onSubmit={(e) => { e.preventDefault(); if (canSave) void save(); }} aria-label={jt('reg_title', lang)}>
          {pointer && <p>{jt('reg_from_workbook', lang)}</p>}
          <label>{jt('reg_scientific', lang)}
            <input dir="ltr" value={form.scientificName} disabled={busy} onChange={(e) => setForm({ ...form, scientificName: e.target.value })} />
          </label>
          <label>{jt('reg_name_ar', lang)}
            <input value={form.nameAr ?? ''} disabled={busy} onChange={(e) => setForm({ ...form, nameAr: e.target.value })} />
          </label>
          <label>{jt('reg_trade', lang)}
            <input dir="ltr" value={form.tradeName ?? ''} disabled={busy} onChange={(e) => setForm({ ...form, tradeName: e.target.value })} />
          </label>
          <label>{jt('reg_strength', lang)}
            <input dir="ltr" value={form.strength ?? ''} disabled={busy} onChange={(e) => setForm({ ...form, strength: e.target.value })} />
          </label>
          <label>{jt('reg_form', lang)}
            <input dir="ltr" value={form.dosageForm ?? ''} disabled={busy} onChange={(e) => setForm({ ...form, dosageForm: e.target.value })} />
          </label>
          <label>{jt('reg_unit', lang)}
            <select value={form.unit} disabled={busy} onChange={(e) => setForm({ ...form, unit: e.target.value as MaterialUnit | '' })}>
              <option value="">{jt('choose', lang)}</option>
              {MATERIAL_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </label>
          {nationalCodeEnabled && <label>{lang === 'ar' ? 'الرمز الوطني' : 'National code'}
            <input dir="ltr" value={form.nationalCode ?? ''} disabled={busy} maxLength={64} onChange={(e) => setForm({ ...form, nationalCode: e.target.value })} />
          </label>}
          <label>{jt('reg_barcode', lang)}
            <input dir="ltr" value={form.barcode ?? ''} disabled={busy} onChange={(e) => setForm({ ...form, barcode: e.target.value })} />
          </label>
          <label>{jt('reg_note', lang)}
            <input value={form.note ?? ''} disabled={busy} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </label>
          <button type="submit" disabled={!canSave}>{jt('reg_save_draft', lang)}</button>
          {(editing || pointer || form.scientificName) && (
            <button type="button" disabled={busy} onClick={() => { setEditing(null); setForm(EMPTY); setPointer(null); intentKey.current = null; }}>{jt('cancel', lang)}</button>
          )}
        </form>
      )}

      <h4>{jt('reg_requests', lang)}</h4>
      {requests.length === 0 && <p>{jt('reg_none', lang)}</p>}
      <ul>
        {requests.map((r) => {
          const mine = r.requesterId === actorId;
          const isMyReview = caps.canReview && (sameActorEnabled || !mine) && r.status === 'under_review' && r.reviewerId === actorId;
          return (
            <li key={r.id} data-status={r.status}>
              <button type="button" aria-expanded={open === r.id} onClick={() => void expand(r)}>
                <span dir="ltr">{r.scientificName}</span>{r.nationalCode && <small dir="ltr"> · {r.nationalCode}</small>} — {statusText(r.status)}
              </button>
              {mine && (r.status === 'draft' || r.status === 'needs_info') && (
                <>
                  <button type="button" disabled={busy} onClick={() => { setEditing({ id: r.id, version: r.version });
                    setForm({ scientificName: r.scientificName, nameAr: r.nameAr, tradeName: r.tradeName, strength: r.strength, dosageForm: r.dosageForm, unit: r.unit, barcode: r.barcode, nationalCode: r.nationalCode, note: r.note }); }}>
                    {jt('reg_edit', lang)}</button>
                  <button type="button" disabled={busy} onClick={() => void act(() => api.submitMaterialRequest(r.id, r.version))}>{jt('reg_submit', lang)}</button>
                </>
              )}
              {mine && (r.status === 'draft' || r.status === 'submitted' || r.status === 'needs_info') && (
                <button type="button" disabled={busy} onClick={() => void act(() => api.cancelMaterialRequest(r.id, r.version, jt('reg_cancel_request', lang)))}>{jt('reg_cancel_request', lang)}</button>
              )}
              {!sameActorEnabled && caps.canReview && mine && r.status !== 'draft' && r.status !== 'cancelled' && <small>{jt('reg_independent', lang)}</small>}
              {caps.canReview && (sameActorEnabled || !mine) && r.status === 'submitted' && (
                <button type="button" disabled={busy} onClick={() => void act(() => api.startMaterialReview(r.id, r.version))}>{jt('reg_start_review', lang)}</button>
              )}
              {(r.status === 'resolved_existing' || r.status === 'approved_new') && r.resolvedItemId && (
                <>
                  <button type="button" onClick={() => onUseItem({ id: r.resolvedItemId!, name: r.scientificName, nameAr: r.nameAr, concentration: r.strength, dosageForm: r.dosageForm, unit: r.unit })}>{jt('reg_use_in_needs', lang)}</button>
                  {caps.canLink && planRevisionId && (
                    <button type="button" disabled={busy} onClick={() => void act(() => api.linkMaterialRequestToDraft(r.id, planRevisionId))}>{jt('reg_link', lang)}</button>
                  )}
                </>
              )}
              {open === r.id && (
                <div>
                  {isMyReview && (
                    <div>
                      {candidates.map((c) => (
                        <div key={c.centralItemId} role="group" aria-label={`${c.name} ${[c.concentration, c.dosageForm, c.unit].filter(Boolean).join(' ')}`}>
                          <span dir="ltr">{c.name} {[c.concentration, c.dosageForm, c.unit].filter(Boolean).join(' · ')}</span> — {c.grade === 'strong' ? jt('reg_strong', lang) : jt('reg_advisory', lang)}
                          {c.grade === 'advisory' && (
                            <label>
                              <input type="checkbox" checked={acks.has(c.centralItemId)}
                                onChange={(e) => { const n = new Set(acks); if (e.target.checked) n.add(c.centralItemId); else n.delete(c.centralItemId); setAcks(n); }} />
                              {jt('reg_ack', lang)}
                            </label>
                          )}
                          {nationalCodeEnabled && r.nationalCode && !c.nationalCode && <label><input type="checkbox" checked={assignCode.has(c.centralItemId)} onChange={(e)=>setAssignCode((old)=>{const n=new Set(old);if(e.target.checked)n.add(c.centralItemId);else n.delete(c.centralItemId);return n;})} />{lang==='ar'?'أؤكد حفظ الرمز الوطني على المادة الموجودة دون تغيير الباركود':'Assign the national code to this existing material; keep its barcode'}</label>}
                          {c.status === 'active' && (
                            <button type="button" disabled={busy || (strong.length > 0 && c.grade !== 'strong') || !!(nationalCodeEnabled && r.nationalCode && ((!c.nationalCode && !assignCode.has(c.centralItemId)) || (c.nationalCode && c.nationalCode!==r.nationalCode)))}
                              onClick={() => void resolveExisting(r, c)}>{jt('reg_resolve_existing', lang)}</button>
                          )}
                        </div>
                      ))}
                      <label>{jt('reg_note_label', lang)}
                        <input value={decisionNote} onChange={(e) => setDecisionNote(e.target.value)} disabled={busy} />
                      </label>
                      {strong.length > 0 && <p role="note">{jt('reg_strong_blocks', lang)}</p>}
                      {strong.length === 0 && tooMany && <p role="note">{jt('reg_too_many', lang).replace('__N__', String(MAX_REVIEWABLE_ADVISORY))}</p>}
                      {strong.length === 0 && !tooMany && !allAcked && <p role="note">{jt('reg_ack_needed', lang)}</p>}
                      <button type="button" disabled={busy || strong.length > 0 || tooMany || !allAcked}
                        onClick={() => void approveMaterial(r)}>{jt('reg_approve_new', lang)}</button>
                      <button type="button" disabled={busy || decisionNote.trim() === ''}
                        onClick={() => void act(() => api.requestMaterialInfo(r.id, r.version, decisionNote))}>{jt('reg_ask_info', lang)}</button>
                      <button type="button" disabled={busy || decisionNote.trim() === ''}
                        onClick={() => void act(() => api.rejectMaterialRequest(r.id, r.version, decisionNote))}>{jt('reject', lang)}</button>
                    </div>
                  )}
                  <h5>{jt('reg_history', lang)}</h5>
                  <ol>{events.map((e) => <li key={e.id}>{e.eventKind}{e.note ? ` — ${e.note}` : ''}</li>)}</ol>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
