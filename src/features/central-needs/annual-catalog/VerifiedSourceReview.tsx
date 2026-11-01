import { useEffect, useId, useRef, useState } from 'react';
import { PrismMaterialIdentity } from '@/shared/ui/prism/PrismMaterialIdentity';
import { MaterialPicker } from '../manual/MaterialPicker';
import type { CatalogOption } from '../manual/manual-journey.service';
import type { AnnualCatalogScope } from './annual-catalog.contract';
import type { AnnualOriginal } from './annual-originals.contract';
import { previewAnnualCanonical } from './annual-catalog.service';
import { getAnnualCatalogItemForNeeds } from './annual-needs.service';
import type { AnnualCanonicalPreview, AnnualCatalogItemResult } from './annual-catalog-server.contract';
import { SourceRecord } from './AnnualCatalogSources';
import { createVerifiedMembershipIntent, validateSourcePageInput, type SourceCapabilities, type SourcePageInput,
  type VerifiedMembership, type VerifiedMembershipIntent, type VerifiedSourcePage } from './verified-source.contract';
import { commitVerifiedMembership, discoverAnnualSourceProfiles, getVerifiedMembershipReceipt, isVerifiedSourceOutcomeUnknown,
  readAnnualSourcePage, VerifiedSourceError } from './verified-source.service';
import { canReviewSourceRow, sourceRowsMatchCanonical } from './verified-source-review-policy';
import { vt } from './verified-source.i18n';

const realApi = { discover: discoverAnnualSourceProfiles, readPage: readAnnualSourcePage, preview: previewAnnualCanonical,
  commit: commitVerifiedMembership, receipt: getVerifiedMembershipReceipt, current: getAnnualCatalogItemForNeeds, newRequestId: (): string => crypto.randomUUID() };
export type VerifiedSourceReviewApi = typeof realApi;
interface Props {
  lang: 'ar' | 'en'; scope: AnnualCatalogScope; actorId: string; original: AnnualOriginal; canWrite: boolean; disabled?: boolean;
  search: (query: string) => Promise<CatalogOption[]>; api?: VerifiedSourceReviewApi;
  onFresh: (item: AnnualCatalogItemResult) => void; onScopeLockChange?: (locked: boolean) => void; onClose: () => void;
}
function ScopedReview({ lang, scope, actorId, original, canWrite, disabled = false, search, api = realApi, onFresh, onScopeLockChange, onClose }: Props) {
  const titleId = useId(), title = useRef<HTMLHeadingElement | null>(null), live = useRef(false), running = useRef(false);
  const [caps, setCaps] = useState<SourceCapabilities | null>(null), [profile, setProfile] = useState('');
  const [read, setRead] = useState<{ input: SourcePageInput; page: VerifiedSourcePage } | null>(null);
  const [keys, setKeys] = useState<string[]>([]), [choice, setChoice] = useState<CatalogOption | null>(null);
  const [preview, setPreview] = useState<AnnualCanonicalPreview | null>(null), [reason, setReason] = useState('');
  const [busy, setBusy] = useState(true), [error, setError] = useState<'failed' | 'denied' | null>(null);
  const [pending, setPending] = useState<VerifiedMembershipIntent | null>(null), [retry, setRetry] = useState(false);
  const [currentId, setCurrentId] = useState<string | null>(null), [verified, setVerified] = useState<VerifiedMembership | null>(null);
  const [saved, setSaved] = useState(false);
  const locked = busy || pending !== null || currentId !== null;
  useEffect(() => { onScopeLockChange?.(locked); return () => onScopeLockChange?.(false); }, [locked, onScopeLockChange]);
  const owner = scope.ownerOrgId, year = scope.planningYear;
  useEffect(() => {
    let current = true;
    live.current = true; running.current = true; setBusy(true); title.current?.focus();
    void api.discover({ ownerOrgId: owner, planningYear: year }, actorId).then(value => { if (current && live.current) setCaps(value); })
      .catch(() => { if (current && live.current) setError('failed'); }).finally(() => { if (current && live.current) { setBusy(false); running.current = false; } });
    return () => { current = false; live.current = false; };
  }, [api, owner, year, actorId]);
  const operate = async (action: () => Promise<void>) => {
    if (running.current || disabled) return;
    running.current = true; setBusy(true); setError(null);
    try { await action(); } catch (failure) {
      if (live.current) setError(failure instanceof VerifiedSourceError && ['forbidden','not_authenticated','source_session_changed'].includes(failure.code) ? 'denied' : 'failed');
    } finally { if (live.current) { running.current = false; setBusy(false); } }
  };
  const clearChoices = () => { setKeys([]); setChoice(null); setPreview(null); setReason(''); setSaved(false); setVerified(null); };
  const refresh = () => void operate(async () => {
    const value = await api.discover(scope, actorId); if (!live.current) return;
    setCaps(value); setProfile(''); setRead(null); clearChoices();
  });
  const readPage = (cursor: string | null) => void operate(async () => {
    const selected = caps?.profiles[Number(profile)]; if (profile === '' || !selected || !caps?.readAvailable) return;
    const input = validateSourcePageInput({ scope, original: { originalId: original.originalId, sha256: original.sha256,
      byteSize: original.byteSize, firstFilename: original.firstFilename }, profile: selected, cursor, pageSize: caps.maxPageRows });
    const page = await api.readPage(input, actorId); if (!live.current) return;
    setRead({ input, page }); clearChoices();
  });
  const pick = (item: CatalogOption) => void operate(async () => {
    setChoice(item); setPreview(null);
    const result = await api.preview(scope, item.id); if (live.current) setPreview(result);
  });
  const selectedRows = read?.page.rows.filter(row => keys.includes(row.occurrenceKey)) ?? [];
  const matches = preview !== null && preview.eligible && sourceRowsMatchCanonical(selectedRows, preview.canonicalSnapshot);
  const committable = canWrite && caps?.commitState === 'ready';
  const fresh = async (result: VerifiedMembership) => {
    if (!live.current) return; setVerified(result); setCurrentId(result.membership.annualItemId); setRetry(false);
    try {
      const item = await api.current(scope, result.membership.annualItemId); if (!live.current) return;
      onFresh(item); setCurrentId(null); setPending(null); setSaved(true);
      setKeys([]); setChoice(null); setPreview(null); setReason('');
    } catch { if (live.current) setError('failed'); }
  };
  const send = (same = false) => void operate(async () => {
    if (!committable || (!same && (!matches || !read || !preview || !reason.trim()))) return;
    const intent = same ? pending : read && preview ? createVerifiedMembershipIntent({ actorId, requestId: api.newRequestId(),
      source: read.input, page: read.page, occurrenceKeys: keys, canonical: preview, reason }) : null;
    if (!intent) return; setPending(intent); setRetry(false); setSaved(false);
    try { const result = await api.commit(intent); if (live.current) await fresh(result); }
    catch (failure) {
      if (!live.current) return;
      // A later retry refusal cannot establish that the original ambiguous attempt rolled back.
      if (!same && !isVerifiedSourceOutcomeUnknown(failure)) { setPending(null); setChoice(null); setPreview(null); }
      setError(failure instanceof VerifiedSourceError && failure.code === 'forbidden' ? 'denied' : 'failed');
    }
  });
  const receipt = () => void operate(async () => {
    if (!pending) return; setRetry(false);
    const result = await api.receipt(pending); if (!live.current) return;
    if (result.status === 'committed') await fresh(result.result); else setRetry(true);
  });
  const reread = () => void operate(async () => { if (verified && currentId) await fresh(verified); });
  return <section className="prism-verified-source" aria-labelledby={titleId} lang={lang} dir={lang === 'ar' ? 'rtl' : 'ltr'} data-testid="verified-source-review">
    <header className="prism-annual-editor__header"><h3 id={titleId} ref={title} tabIndex={-1}>{vt('title', lang)}</h3><button type="button" disabled={locked || disabled} onClick={onClose}>{vt('close', lang)}</button></header>
    <p><bdi>{original.firstFilename}</bdi> · <bdi>{year}</bdi></p><p className="prism-search-hint">{vt('hint', lang)}</p>
    {busy && <p role="status">{vt('loading', lang)}</p>}
    {error && <p role="alert" className="prism-notice prism-notice--error">{vt(error, lang)}</p>}
    {caps && !caps.readAvailable && <p role="status" className="prism-notice">{vt('waiting', lang)}</p>}
    {caps?.readAvailable && <>
      <fieldset disabled={locked || disabled} className="prism-source-profile"><label>{vt('profile', lang)}<select value={profile} onChange={event => { setProfile(event.target.value); setRead(null); clearChoices(); }}>
        <option value="">{vt('choose', lang)}</option>{caps.profiles.map((p, index) => <option key={`${p.id}:${p.version}:${p.sha256}`} value={index}>{p.id} · {p.version}</option>)}
      </select></label><button type="button" disabled={profile === ''} onClick={() => readPage(null)}>{vt('read', lang)}</button></fieldset>
      {!committable && <p className="prism-notice">{vt('noCommit', lang)}</p>}
    </>}
    {read?.page.preparationStatus === 'held' && <p role="status" className="prism-notice prism-notice--warning">{vt('held', lang)}</p>}
    {read?.page.preparationStatus === 'prepared' && <>
      {read.page.rows.length === 0 && <p>{vt('none', lang)}</p>}
      <fieldset disabled={locked || disabled}><legend>{vt('rows', lang)}</legend>
        {read.page.rows.map(row => {
          const allowed = canReviewSourceRow(row, read.page.classifications ?? []);
          return <div className="prism-source-review-row" key={row.occurrenceKey}>
            <label><input type="checkbox" checked={keys.includes(row.occurrenceKey)} disabled={!allowed || !committable} onChange={event => {
              setKeys(old => event.target.checked ? [...old, row.occurrenceKey] : old.filter(key => key !== row.occurrenceKey)); setChoice(null); setPreview(null); setReason('');
            }} />{vt('selectRow', lang)} {row.source.row + 1}</label>
            {!allowed && <p className="prism-notice prism-notice--warning">{vt('rowHeld', lang)}</p>}
            <ul><SourceRecord occurrence={row} lang={lang} /></ul>
          </div>;
        })}
      </fieldset>
      {read.page.nextCursor && <button type="button" disabled={locked || disabled} onClick={() => readPage(read.page.nextCursor)}>{vt('next', lang)}</button>}
      {keys.length > 0 && committable && <fieldset disabled={locked || disabled}>
        <MaterialPicker lang={lang} scopeKey={JSON.stringify([actorId, owner, year, original.originalId, profile, read.input.cursor, keys])}
          search={search} selected={choice ? [choice] : []} onPick={pick} onRemove={() => { setChoice(null); setPreview(null); }} />
        {preview && <section aria-label={vt('canonical', lang)}><PrismMaterialIdentity name={(lang === 'ar' ? preview.canonicalSnapshot.nameAr : null) ?? preview.canonicalSnapshot.scientificName ?? ''}
          nationalCode={preview.canonicalSnapshot.nationalCode} concentration={preview.canonicalSnapshot.concentration} dosageForm={preview.canonicalSnapshot.dosageForm} unit={preview.canonicalSnapshot.unit} />
          {!matches && <p role="alert" className="prism-notice prism-notice--warning">{vt('conflict', lang)}</p>}
          <label>{vt('reason', lang)}<input value={reason} maxLength={2000} onChange={event => setReason(event.target.value)} /></label>
          <button type="button" disabled={!matches || !reason.trim()} onClick={() => send()}>{vt('confirm', lang)}</button>
        </section>}
      </fieldset>}
    </>}
    {pending && currentId === null && !busy && <div className="prism-notice prism-notice--warning"><p role="status">{vt(retry ? 'retryNote' : 'unknown', lang)}</p>
      <button type="button" disabled={busy || disabled} onClick={receipt}>{vt('receipt', lang)}</button>
      {retry && <button type="button" disabled={busy || disabled || !committable} onClick={() => send(true)}>{vt('retry', lang)}</button>}
    </div>}
    {currentId && !busy && <div className="prism-notice prism-notice--warning"><p role="status">{vt('currentFailed', lang)}</p><button type="button" disabled={busy || disabled} onClick={reread}>{vt('current', lang)}</button></div>}
    {saved && verified && <div className="prism-notice prism-notice--success"><p role="status">{vt('saved', lang)}</p>
      <p>{vt('verified', lang)} · {vt('employee', lang)}: <bdi>{verified.c4Verification.reviewedByName}</bdi> · <time dateTime={verified.c4Verification.reviewedAt}>{new Date(verified.c4Verification.reviewedAt).toLocaleString(lang === 'ar' ? 'ar-IQ' : 'en-GB')}</time></p>
    </div>}
    <button type="button" disabled={locked || disabled} onClick={refresh}>{vt('refresh', lang)}</button>
  </section>;
}
export function VerifiedSourceReview(props: Props) {
  return <ScopedReview key={JSON.stringify([props.actorId, props.scope.ownerOrgId, props.scope.planningYear, props.original.originalId, props.original.sha256, props.original.byteSize, props.original.firstFilename])} {...props} />;
}
