import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ManualLang } from '../manual/manual-needs.i18n';
import { newManualIdempotencyKey } from '../manual/manual-needs.service';
import type { AnnualCatalogScope } from './annual-catalog.contract';
import * as services from './annual-originals.service';
import type { AnnualOriginal, AnnualOriginalCaptureInput, AnnualOriginalWriteResult, AnnualOriginalUploadsPage } from './annual-originals.contract';
import { annualOriginalTimestampOrder } from './annual-originals.contract';
import { ot } from './annual-originals.i18n';

export const realAnnualOriginalsUiApi = {
  getAnnualOriginalsContract: services.getAnnualOriginalsContract,
  prepareAnnualOriginalFile: services.prepareAnnualOriginalFile,
  storeAnnualOriginal: services.storeAnnualOriginal,
  getAnnualOriginalReceipt: services.getAnnualOriginalReceipt,
  listAnnualOriginalUploads: services.listAnnualOriginalUploads,
  downloadAnnualOriginal: services.downloadAnnualOriginal,
  newIdempotencyKey: newManualIdempotencyKey,
};
export type AnnualOriginalsUiApi = typeof realAnnualOriginalsUiApi;

interface Props {
  lang: ManualLang;
  scope: AnnualCatalogScope;
  actorId: string;
  canWrite: boolean;
  disabled?: boolean;
  api?: AnnualOriginalsUiApi;
  onScopeLockChange?: (locked: boolean) => void;
  onReviewOriginal?: (original: AnnualOriginal, trigger: HTMLButtonElement) => void;
}

type UploadRow = AnnualOriginalUploadsPage['uploads'][number];
type ListFailure = 'initial' | 'reload' | 'more';
interface FileHistory { rows: UploadRow[]; cursor: string | null; loaded: boolean; busy: boolean; failure: ListFailure | null }

function FileMetadata({ row, lang }: { row: UploadRow; lang: ManualLang }) {
  const { original, upload } = row;
  return <>
    <p className="prism-original-filename"><bdi dir="auto">{upload.filename}</bdi></p>
    <dl className="prism-original-metadata">
      <div><dt>{ot('employee', lang)}</dt><dd><bdi>{upload.actorName}</bdi></dd></div>
      <div><dt>{ot('date', lang)}</dt><dd><time dateTime={upload.createdAt}><bdi>{new Date(upload.createdAt).toLocaleString(lang === 'ar' ? 'ar-IQ' : 'en-GB')}</bdi></time></dd></div>
      <div><dt>{ot('size', lang)}</dt><dd><bdi dir="ltr">{original.byteSize.toLocaleString('en-US')}</bdi></dd></div>
    </dl>
    <details><summary>{ot('details', lang)}</summary><dl className="prism-original-metadata">
      <div><dt>{ot('firstFilename', lang)}</dt><dd><bdi>{original.firstFilename}</bdi></dd></div>
      <div><dt>{ot('firstEmployee', lang)}</dt><dd><bdi>{original.createdByName}</bdi></dd></div>
      <div><dt>{ot('fingerprint', lang)}</dt><dd><code dir="ltr">{original.sha256}</code></dd></div>
    </dl></details>
  </>;
}

/** One actor/owner/year context. A pending write keeps its exact bytes and key until reconciliation. */
function ScopedOriginalFiles({ lang, scope, actorId, canWrite, disabled = false, api = realAnnualOriginalsUiApi, onScopeLockChange, onReviewOriginal }: Props) {
  const [capability, setCapability] = useState<'loading' | 'ready' | 'absent' | 'failed'>('loading');
  const [history, setHistory] = useState<FileHistory>({ rows: [], cursor: null, loaded: false, busy: false, failure: null });
  const historyRef = useRef(history); historyRef.current = history;
  const [prepared, setPrepared] = useState<AnnualOriginalCaptureInput | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [pending, setPending] = useState<AnnualOriginalCaptureInput | null>(null);
  const [writeState, setWriteState] = useState<'idle' | 'saving' | 'unknown' | 'checking' | 'retry'>('idle');
  const [receipt, setReceipt] = useState<AnnualOriginalWriteResult | null>(null);
  const [notice, setNotice] = useState<'prepareFailed' | 'refused' | 'receiptFailed' | 'downloadFailed' | null>(null);
  const [downloading, setDownloading] = useState(false);
  const active = useRef(false);
  const generation = useRef(0);
  const preparation = useRef(0);
  const listPending = useRef(false);
  const refreshQueued = useRef(false);
  const mutationPending = useRef(false);
  const pendingRef = useRef<AnnualOriginalCaptureInput | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const hintId = useId();
  const historyId = useId();
  const fileId = useId();
  const locked = preparing || pending !== null;
  const busy = writeState === 'saving' || writeState === 'checking';
  const ownerOrgId = scope.ownerOrgId, planningYear = scope.planningYear;

  const loadHistory = useCallback(async (more = false) => {
    if (!active.current || listPending.current) return;
    const previous = historyRef.current;
    if (more && (!previous.loaded || previous.cursor === null || previous.failure === 'reload')) return;
    const mine = generation.current;
    const current = () => active.current && generation.current === mine;
    listPending.current = true;
    setHistory((old) => ({ ...old, busy: true, failure: null }));
    try {
      const page = await api.listAnnualOriginalUploads({ ownerOrgId, planningYear }, 25, more ? previous.cursor : null);
      if (!current()) return;
      const rows = new Map((more ? previous.rows : []).map((row) => [row.upload.uploadId, row]));
      let last = more ? previous.rows[previous.rows.length - 1]?.upload : undefined;
      for (const row of page.uploads) {
        const time = annualOriginalTimestampOrder(row.upload.createdAt);
        const lastTime = last ? annualOriginalTimestampOrder(last.createdAt) : null;
        if (rows.has(row.upload.uploadId) || (last && lastTime !== null
          && (time < lastTime || (time === lastTime && row.upload.uploadId <= last.uploadId)))) {
          throw new Error('annual_original_page_overlap');
        }
        rows.set(row.upload.uploadId, row); last = row.upload;
      }
      setHistory({ rows: [...rows.values()], cursor: page.nextAfterUploadId, loaded: true, busy: false, failure: null });
    } catch {
      if (current()) setHistory((old) => ({ ...old, busy: false, failure: more ? 'more' : old.loaded ? 'reload' : 'initial' }));
    } finally {
      if (current()) {
        listPending.current = false;
        if (refreshQueued.current) { refreshQueued.current = false; void loadHistory(); }
      }
    }
  }, [api, ownerOrgId, planningYear]);

  const discover = useCallback(async () => {
    const mine = generation.current;
    setCapability('loading');
    try {
      const result = await api.getAnnualOriginalsContract();
      if (!active.current || generation.current !== mine) return;
      setCapability(result === null ? 'absent' : 'ready');
      if (result !== null) void loadHistory();
    } catch { if (active.current && generation.current === mine) setCapability('failed'); }
  }, [api, loadHistory]);

  useEffect(() => {
    active.current = true; generation.current += 1;
    void discover();
    return () => { active.current = false; generation.current += 1; listPending.current = false; refreshQueued.current = false; };
  }, [discover]);
  useEffect(() => { onScopeLockChange?.(locked); return () => onScopeLockChange?.(false); }, [locked, onScopeLockChange]);
  useEffect(() => {
    if (pending === null) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [pending]);

  const chooseFile = async (file: File | undefined) => {
    if (!file || pendingRef.current || disabled || !canWrite || capability !== 'ready') return;
    const mine = generation.current, selection = ++preparation.current;
    const current = () => active.current && generation.current === mine && preparation.current === selection;
    setPrepared(null); setPreparing(true); setReceipt(null); setNotice(null);
    try {
      const input = await api.prepareAnnualOriginalFile({ scope: { ownerOrgId, planningYear }, actorId, file, idempotencyKey: api.newIdempotencyKey() });
      if (current()) setPrepared(input);
    } catch { if (current()) setNotice('prepareFailed'); }
    finally { if (current()) setPreparing(false); }
  };

  const accepted = (result: AnnualOriginalWriteResult) => {
    setReceipt(result); setPrepared(null); setPending(null); pendingRef.current = null;
    setWriteState('idle'); setNotice(null);
    if (fileInput.current) fileInput.current.value = '';
    if (listPending.current) refreshQueued.current = true; else void loadHistory();
  };

  const capture = async (retry = false) => {
    const input = retry ? pendingRef.current : prepared;
    if (!input || mutationPending.current || disabled || !canWrite || capability !== 'ready'
      || (retry ? writeState !== 'retry' : pendingRef.current !== null)) return;
    const mine = generation.current;
    const current = () => active.current && generation.current === mine;
    mutationPending.current = true; pendingRef.current = input; setPending(input); setWriteState('saving'); setNotice(null);
    try {
      const result = await api.storeAnnualOriginal(input);
      if (current()) accepted(result);
    } catch (error) {
      if (!current()) return;
      if (retry || services.isAnnualOriginalOutcomeUnknown(error)) setWriteState('unknown');
      else { pendingRef.current = null; setPending(null); setWriteState('idle'); setNotice('refused'); }
    } finally { if (current()) mutationPending.current = false; }
  };

  const reconcile = async () => {
    const input = pendingRef.current;
    if (!input || mutationPending.current) return;
    const mine = generation.current;
    const current = () => active.current && generation.current === mine;
    mutationPending.current = true; setWriteState('checking'); setNotice(null);
    try {
      const response = await api.getAnnualOriginalReceipt(services.annualOriginalIntent(input));
      if (!current()) return;
      if (response.result) accepted(response.result); else setWriteState('retry');
    } catch { if (current()) { setWriteState('unknown'); setNotice('receiptFailed'); } }
    finally { if (current()) mutationPending.current = false; }
  };

  const download = async (row: UploadRow) => {
    if (downloading) return;
    const mine = generation.current;
    setDownloading(true); setNotice(null);
    try {
      const result = await api.downloadAnnualOriginal({ ownerOrgId, planningYear }, row.original.originalId);
      if (!active.current || generation.current !== mine) return;
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement('a'); link.href = url; link.download = row.upload.filename;
      document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { if (active.current && generation.current === mine) setNotice('downloadFailed'); }
    finally { if (active.current && generation.current === mine) setDownloading(false); }
  };

  return <section className="prism-annual-originals" lang={lang} dir={lang === 'ar' ? 'rtl' : 'ltr'} aria-labelledby={titleId}>
    <div className="prism-annual-editor__header"><h3 id={titleId}>{ot('title', lang)}</h3><span className="prism-original-year">{ot('year', lang)} <bdi dir="ltr">{planningYear}</bdi></span></div>
    <p className="prism-search-hint">{ot('purpose', lang)}</p>
    {capability === 'loading' && <p role="status">{ot('loading', lang)}</p>}
    {capability === 'absent' && <p role="note" className="prism-notice">{ot('unavailable', lang)}</p>}
    {capability === 'failed' && <div className="prism-notice prism-notice--error"><p role="alert">{ot('capabilityFailed', lang)}</p><button type="button" onClick={() => void discover()}>{ot('retryCapability', lang)}</button></div>}
    {capability === 'ready' && <>
      <p role="note" className="prism-notice prism-notice--warning">{ot('trust', lang)}</p>
      {canWrite ? <div className="prism-original-upload">
        <input ref={fileInput} id={fileId} type="file" accept=".xls,.xlsx,.csv" aria-label={ot('choose', lang)} hidden
          disabled={disabled || locked} onChange={(event) => void chooseFile(event.target.files?.[0])} />
        <button type="button" className="prism-original-choose" aria-controls={fileId} aria-describedby={hintId}
          disabled={disabled || locked} onClick={() => fileInput.current?.click()}>{ot('choose', lang)}</button>
        <p id={hintId} className="prism-search-hint">{ot('limits', lang)}</p>
        {preparing && <p role="status">{ot('preparing', lang)}</p>}
        {prepared && !pending && <div className="prism-original-selection"><p>{ot('selected', lang)}</p><bdi dir="auto">{prepared.filename}</bdi>
          <span>{ot('size', lang)}: <bdi dir="ltr">{prepared.byteSize.toLocaleString('en-US')}</bdi></span>
          <button type="button" className="prism-button-primary" disabled={disabled || locked} onClick={() => void capture()}>{ot('save', lang)} <bdi dir="ltr">{planningYear}</bdi></button>
        </div>}
      </div> : <p className="prism-search-hint">{ot('readOnly', lang)}</p>}
      {notice && <p role="alert" className="prism-notice prism-notice--error">{ot(notice, lang)}</p>}
      {busy && <p role="status">{ot(writeState === 'saving' ? 'saving' : 'checking', lang)}</p>}
      {pending && !busy && <div className="prism-notice prism-notice--warning">
        <p role="status">{ot(writeState === 'retry' ? 'receiptAbsent' : 'unknown', lang)}</p>
        <p><bdi dir="auto">{pending.filename}</bdi> · {ot('year', lang)} <bdi dir="ltr">{planningYear}</bdi></p>
        <div className="prism-form-actions"><button type="button" onClick={() => void reconcile()}>{ot('reconcile', lang)}</button>
          {writeState === 'retry' && canWrite && <button type="button" disabled={disabled} onClick={() => void capture(true)}>{ot('retrySame', lang)}</button>}
        </div>
      </div>}
      {receipt && <div className="prism-notice prism-notice--success"><p role="status">{ot(receipt.deduplicated ? 'deduplicated' : 'saved', lang)}</p>
        <p><bdi>{receipt.upload.filename}</bdi> · {ot('employee', lang)}: <bdi>{receipt.upload.actorName}</bdi></p>
      </div>}
      {downloading && <p role="status">{ot('downloading', lang)}</p>}
      <section className="prism-original-history" aria-labelledby={historyId} aria-busy={history.busy}>
        <div className="prism-annual-editor__header"><h4 id={historyId}>{ot('history', lang)}</h4>
          <button type="button" disabled={history.busy || busy} onClick={() => void loadHistory()}>{ot('refresh', lang)}</button></div>
        {history.busy && <p role="status">{ot('listLoading', lang)}</p>}
        {history.failure && <div className="prism-notice prism-notice--error"><p role="alert">{ot(history.failure === 'reload' ? 'refreshFailed' : history.failure === 'more' ? 'moreFailed' : 'listFailed', lang)}</p>
          <button type="button" disabled={history.busy} onClick={() => void loadHistory(history.failure === 'more')}>{ot(history.failure === 'more' ? 'more' : 'refresh', lang)}</button></div>}
        {history.loaded && <p className="prism-search-hint">{ot('shown', lang)}: <bdi dir="ltr">{history.rows.length}</bdi></p>}
        {history.loaded && !history.busy && !history.failure && history.rows.length === 0 && <p>{ot('empty', lang)}</p>}
        <ol>{history.rows.map((row) => <li key={row.upload.uploadId} className="prism-original-record"><FileMetadata row={row} lang={lang} />
          <button type="button" disabled={downloading} onClick={() => void download(row)} aria-label={`${ot('download', lang)}: ${row.upload.filename}`}>{ot('download', lang)}</button>
          {onReviewOriginal && <button type="button" disabled={disabled || locked} onClick={event => onReviewOriginal(row.original, event.currentTarget)} aria-label={`${lang === 'ar' ? 'مراجعة هوية المواد' : 'Review material identity'}: ${row.upload.filename}`}>
            {lang === 'ar' ? 'مراجعة هوية المواد' : 'Review material identity'}
          </button>}
        </li>)}</ol>
        {history.cursor && history.failure === null && <button type="button" disabled={history.busy} onClick={() => void loadHistory(true)}>{ot('more', lang)}</button>}
      </section>
    </>}
  </section>;
}

export function AnnualOriginalFiles(props: Props) {
  return <ScopedOriginalFiles key={`${props.actorId}:${props.scope.ownerOrgId}:${props.scope.planningYear}`} {...props} />;
}
