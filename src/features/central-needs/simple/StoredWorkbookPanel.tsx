/**
 * E1.1 — persistent original-workbook access after authoritative import.
 *
 * The original source stays immutable in private Storage. This component does
 * not edit it and does not create business state. It asks the existing trusted
 * source-download endpoint for a short-lived signed URL, downloads the original
 * bytes in memory, verifies SHA-256 against the registered ImportBatch, and
 * only then hands a transient File to the SAME CN-2A browser preview worker E1
 * already uses. The resulting evidence is rendered by the unchanged read-only
 * ExcelWorkbookViewer.
 *
 * Signed URLs, bytes, Files and parsed results are session-memory only. Nothing
 * is written to localStorage/sessionStorage/indexedDB and no source object is
 * mutated.
 *
 * AUXILIARY, NOT A TASK CARD. Simple Mode shows exactly ONE main task card for
 * the current step. This panel is a supporting evidence surface beside it, so
 * it carries its own `cn2b-stored-workbook` block and never `cn2b-simple-card`.
 *
 * E2-A — TRUSTED PHYSICAL SELECTION. Only after the bytes were verified and
 * parsed does the panel read the batch's own entries (`listBatchEntries`, a
 * read under the existing RLS) and ask `sourceIdentityBridge` to prove which
 * entry each displayed workbook is. Proven: the viewer lets the human select a
 * cell, a column or a rectangle, reported to `onSelectionChange` as physical
 * coordinates plus that identity. Not proven (read failed, or any mismatch):
 * the source stays visible exactly as in E1.1, and selection stays off — no
 * guess, no fallback. Selection lives in React memory only and ends with the
 * viewer, the batch or the revision.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import {
  listBatchEntries,
  requestSourceDownload,
  type ImportBatch,
} from '../central-needs.service';
import {
  detectContainerKind,
  useCentralNeedsPreview,
  type PreviewOutcome,
} from '../useCentralNeedsPreview';
import { ExcelWorkbookViewer, type ViewerSelectionOptions } from '../excel-first/ExcelWorkbookViewer';
import { bridgeSourceIdentity, type SourceIdentityResult } from '../excel-first/sourceIdentityBridge';
import { selectionKey, type WorkbookSelection } from '../excel-first/workbookSelection';

type StoredWorkbookError =
  | 'download_failed'
  | 'integrity_mismatch'
  | 'integrity_unavailable'
  | 'metadata_mismatch';

/** The bridge's verdict for ONE parsed outcome; a read failure is a refusal too. */
type SourceTrust = {
  outcome: PreviewOutcome;
  result: SourceIdentityResult | { ok: false; reason: 'entries_unavailable' };
};

interface Props {
  lang: 'ar' | 'en';
  batches: ImportBatch[];
  /** E2-A: the human's physical selection in the trusted source, or null. Memory only. */
  onSelectionChange?: (selection: WorkbookSelection | null) => void;
}

const normalizedSha = (sha: string): string => sha.trim().toLowerCase();

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('integrity_unavailable');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function expectedPreviewKind(batch: ImportBatch): 'file' | 'archive' {
  return batch.containerKind === 'zip' ? 'archive' : 'file';
}

export function StoredWorkbookPanel({ lang, batches, onSelectionChange }: Props) {
  const latestBatchId = batches.length > 0 ? batches[batches.length - 1].id : '';
  const [selectedBatchId, setSelectedBatchId] = useState(latestBatchId);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<StoredWorkbookError | null>(null);
  const [integrityVerified, setIntegrityVerified] = useState(false);
  const operationSeq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const preview = useCentralNeedsPreview();
  /** The batch whose downloaded bytes passed metadata and SHA-256 verification, for the current open. */
  const verifiedBatch = useRef<ImportBatch | null>(null);
  const [trust, setTrust] = useState<SourceTrust | null>(null);

  const selectedBatch = useMemo(
    () => batches.find((batch) => batch.id === selectedBatchId) ?? (batches.length > 0 ? batches[batches.length - 1] : null),
    [batches, selectedBatchId],
  );

  // A newly finalized batch becomes the natural default. A manual choice among
  // older batches remains stable until the newest batch identity actually changes.
  useEffect(() => {
    if (!latestBatchId) return;
    setSelectedBatchId(latestBatchId);
    operationSeq.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    verifiedBatch.current = null;
    setDownloading(false);
    setError(null);
    setIntegrityVerified(false);
    preview.reset();
  }, [latestBatchId, preview.reset]);

  useEffect(() => () => {
    operationSeq.current += 1;
    abortRef.current?.abort();
  }, []);

  // --- E2-A: prove the displayed workbooks' identity, then allow selection ---
  const readyOutcome = preview.state.phase === 'ready' ? preview.state.outcome : null;

  useEffect(() => {
    const batch = verifiedBatch.current;
    if (!readyOutcome || !batch) return undefined;
    let cancelled = false;
    listBatchEntries(batch.id).then(
      (entries) => {
        if (cancelled) return;
        setTrust({
          outcome: readyOutcome,
          result: bridgeSourceIdentity({ batch, kind: readyOutcome.kind, result: readyOutcome.result, entries }),
        });
      },
      () => {
        if (!cancelled) setTrust({ outcome: readyOutcome, result: { ok: false, reason: 'entries_unavailable' } });
      },
    );
    return () => { cancelled = true; };
  }, [readyOutcome]);

  // A verdict only ever applies to the outcome it was computed for.
  const currentTrust = trust && readyOutcome && trust.outcome === readyOutcome ? trust.result : null;
  const identities = currentTrust && currentTrust.ok ? currentTrust.identities : null;

  const selectionListener = useRef(onSelectionChange);
  useEffect(() => {
    selectionListener.current = onSelectionChange;
  });
  const lastSelection = useRef('');
  const forwardSelection = useCallback((selection: WorkbookSelection | null) => {
    const key = selection ? selectionKey(selection) : '';
    if (key === lastSelection.current) return;
    lastSelection.current = key;
    selectionListener.current?.(selection);
  }, []);
  // No proven identity (closed, re-opened, refused, another batch): no selection.
  useEffect(() => {
    if (!identities) forwardSelection(null);
  }, [identities, forwardSelection]);
  useEffect(() => () => forwardSelection(null), [forwardSelection]);

  const viewerSelection = useMemo<ViewerSelectionOptions | undefined>(
    () => (identities ? { identities, onChange: forwardSelection } : undefined),
    [identities, forwardSelection],
  );

  function closeViewer() {
    operationSeq.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    verifiedBatch.current = null;
    setDownloading(false);
    setError(null);
    setIntegrityVerified(false);
    preview.reset();
  }

  function chooseBatch(id: string) {
    closeViewer();
    setSelectedBatchId(id);
  }

  async function openStoredWorkbook() {
    if (!selectedBatch || downloading || preview.state.phase === 'parsing') return;

    const op = operationSeq.current + 1;
    operationSeq.current = op;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setDownloading(true);
    setError(null);
    setIntegrityVerified(false);
    verifiedBatch.current = null;
    preview.reset();

    try {
      const descriptor = await requestSourceDownload(selectedBatch.id);
      if (op !== operationSeq.current) return;

      const metadataMatches =
        descriptor.originalFilename === selectedBatch.containerFilename
        && descriptor.containerKind === selectedBatch.containerKind
        && typeof descriptor.containerSha256 === 'string'
        && normalizedSha(descriptor.containerSha256) === normalizedSha(selectedBatch.containerSha256)
        && detectContainerKind(new File([], descriptor.originalFilename)) === expectedPreviewKind(selectedBatch);
      if (!metadataMatches) {
        setError('metadata_mismatch');
        return;
      }

      const response = await fetch(descriptor.url, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
      if (op !== operationSeq.current) return;
      if (!response.ok) {
        setError('download_failed');
        return;
      }

      const bytes = await response.arrayBuffer();
      if (op !== operationSeq.current) return;

      let actualSha: string;
      try {
        actualSha = await sha256Hex(bytes);
      } catch {
        setError('integrity_unavailable');
        return;
      }
      if (op !== operationSeq.current) return;

      if (normalizedSha(actualSha) !== normalizedSha(selectedBatch.containerSha256)) {
        setError('integrity_mismatch');
        return;
      }

      setIntegrityVerified(true);
      verifiedBatch.current = selectedBatch;
      const file = new File([bytes], descriptor.originalFilename, {
        type: 'application/octet-stream',
        lastModified: 0,
      });
      await preview.parse(file);
    } catch (e) {
      if (op !== operationSeq.current) return;
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setError('download_failed');
    } finally {
      if (op === operationSeq.current) {
        setDownloading(false);
        abortRef.current = null;
      }
    }
  }

  if (!selectedBatch) return null;

  const errorKey = error === 'integrity_mismatch'
    ? 'cn2b_stored_workbook_integrity_error'
    : error === 'integrity_unavailable'
      ? 'cn2b_stored_workbook_integrity_unavailable'
      : error === 'metadata_mismatch'
        ? 'cn2b_stored_workbook_metadata_error'
        : 'cn2b_stored_workbook_load_error';

  const viewerOpen = preview.state.phase !== 'idle';

  return (
    <section className="cn2b-stored-workbook" data-testid="cn2b-stored-workbook-panel" aria-labelledby="cn2b-stored-workbook-title"
      data-source-identity={readyOutcome ? (identities ? 'trusted' : currentTrust ? 'unproven' : 'pending') : undefined}
      data-source-identity-reason={currentTrust && !currentTrust.ok ? currentTrust.reason : undefined}
    >
      <p className="cn2b-stored-workbook__eyebrow">
        <PhoenixIcon name="file" size={15} inline aria-hidden="true" /> {t('cn2b_stored_workbook_persisted', lang)}
      </p>
      <h2 className="cn2b-stored-workbook__title" id="cn2b-stored-workbook-title">
        {t('cn2b_stored_workbook_title', lang)}
      </h2>
      <p className="cn2b-stored-workbook__lead">{t('cn2b_stored_workbook_hint', lang)}</p>

      {batches.length > 1 && (
        <label className="cn2b-simple-field">
          <span className="cn2b-simple-field__label">{t('cn2b_stored_workbook_choose', lang)}</span>
          <select
            className="cn2b-select"
            value={selectedBatch.id}
            disabled={downloading || preview.state.phase === 'parsing'}
            onChange={(event) => chooseBatch(event.target.value)}
            data-testid="cn2b-stored-workbook-select"
          >
            {batches.map((batch) => (
              <option key={batch.id} value={batch.id}>{batch.containerFilename}</option>
            ))}
          </select>
        </label>
      )}

      <dl className="cn2b-simple-evidence__list">
        <div className="cn2b-simple-evidence__row">
          <dt className="cn2b-simple-evidence__field">{t('cn2b_col_container', lang)}</dt>
          <dd className="cn2b-simple-evidence__value" data-testid="cn2b-stored-workbook-filename"><bdi>{selectedBatch.containerFilename}</bdi></dd>
        </div>
        <div className="cn2b-simple-evidence__row">
          <dt className="cn2b-simple-evidence__field">{t('cn2b_col_kind', lang)}</dt>
          <dd className="cn2b-simple-evidence__value">{t(selectedBatch.containerKind === 'zip' ? 'cn2b_kind_zip' : 'cn2b_kind_file', lang)}</dd>
        </div>
        <div className="cn2b-simple-evidence__row">
          <dt className="cn2b-simple-evidence__field">SHA-256</dt>
          <dd className="cn2b-simple-evidence__value"><code className="cn2b-code" data-testid="cn2b-stored-workbook-sha">{selectedBatch.containerSha256}</code></dd>
        </div>
      </dl>

      {error && (
        <div className="cn2b-simple-error" role="alert" data-testid="cn2b-stored-workbook-error">
          <PhoenixIcon name="warning" size={16} inline aria-hidden="true" /> {t(errorKey, lang)}
        </div>
      )}

      {integrityVerified && (
        <p className="cn2b-simple-notice" role="status" data-testid="cn2b-stored-workbook-integrity-ok">
          <PhoenixIcon name="check" size={16} inline aria-hidden="true" /> {t('cn2b_stored_workbook_integrity_ok', lang)}
        </p>
      )}

      <div className="cn2b-stored-workbook__actions">
        <PhoenixButton
          type="button"
          variant="primary"
          disabled={downloading || preview.state.phase === 'parsing'}
          onClick={() => void openStoredWorkbook()}
          data-testid="cn2b-stored-workbook-open"
        >
          {downloading ? t('cn2b_stored_workbook_loading', lang) : t('cn2b_stored_workbook_open', lang)}
        </PhoenixButton>
        {viewerOpen && (
          <PhoenixButton type="button" variant="ghost" onClick={closeViewer} data-testid="cn2b-stored-workbook-close">
            {t('close', lang)}
          </PhoenixButton>
        )}
      </div>

      {preview.state.phase === 'parsing' && (
        <p className="cn2b-stored-workbook__hint" role="status">{t('cn2b_parsing', lang)}</p>
      )}
      {preview.state.phase === 'failed' && (
        <div className="cn2b-simple-error" role="alert" data-testid="cn2b-stored-workbook-parse-error">
          <PhoenixIcon name="warning" size={16} inline aria-hidden="true" /> {t('cn2b_preview_failed', lang)} ({preview.state.reason})
        </div>
      )}
      {preview.state.phase === 'ready' && (
        <ExcelWorkbookViewer
          lang={lang}
          kind={preview.state.outcome.kind}
          result={preview.state.outcome.result}
          selection={viewerSelection}
        />
      )}
    </section>
  );
}
