/**
 * OUTLET-CORRIDOR-071 — the outlet → institution-warehouse return composer.
 *
 * An outlet sends material back to the institution warehouse it received it
 * from. Returns are built from PROVENANCE: every candidate is a real received
 * dispatch line, `originalDispatchLineId` is mandatory in 071's ADD-LINE RPC, so
 * a free-text return is impossible in the schema as well as in this UI. There is
 * no material typing, no OCR, and no manual balance change anywhere here.
 *
 * Like every composer in this app, NOTHING is persisted until the operator
 * confirms: requestOutletReturn and addOutletReturnLine appear ONLY inside
 * confirmAndCreate. A partial failure surfaces the created request id and offers
 * a retry that reloads canonical server lines and re-sends only what is absent.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { commitDraft, type CommitResult, type CommitProgress } from '@/features/movement/movement-commit';
import { MovementComposerShell, type ComposerStep } from '@/features/movement/ui/MovementComposerShell';
import { PaperReferenceFields, EMPTY_PAPER_REFERENCE, type PaperReferenceValue } from '@/features/movement/ui/PaperReferenceFields';
import { setPaperReference } from '@/features/movement/paper-reference.service';
import { OutletReturnProvenancePicker } from './OutletReturnProvenancePicker';
import {
  draftLineFromReturnable, validateOutletReturnDraft, outletReturnDraftConfirmable,
  revalidateOutletReturnDraft, planOutletReturnRetry,
  type OutletReturnableLine, type OutletReturnDraftLine,
} from './outlet-return-draft';
import { loadOutletReturnableSources } from './outlet-return-sources';
import { requestOutletReturn, addOutletReturnLine, getOutletReturnRequestLines } from './outlet-return.service';

const newKey = () =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

interface Props {
  /** The outlet composing the return (already scope-checked upstream). */
  distributionPointId: string;
  distributionPointName: string;
  onCancel: () => void;
  onCreated: (returnRequestId: string) => void;
}

export function OutletReturnComposer({
  distributionPointId, distributionPointName, onCancel, onCreated,
}: Props) {
  const { lang, dir } = useApp();

  const [step, setStep] = useState<ComposerStep>('parties');
  const [externalReference, setExternalReference] = useState('');
  const [notes, setNotes] = useState('');
  // PAPER-REFERENCE-CONTRACT-110: optional, distinct from externalReference.
  const [paperRef, setPaperRef] = useState<PaperReferenceValue>(EMPTY_PAPER_REFERENCE);

  const [sources, setSources] = useState<OutletReturnableLine[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [lines, setLines] = useState<OutletReturnDraftLine[]>([]);
  const [staleKeys, setStaleKeys] = useState<string[]>([]);

  const [committing, setCommitting] = useState(false);
  const [progress, setProgress] = useState<CommitProgress | null>(null);
  const [result, setResult] = useState<CommitResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadSources = useCallback(async () => {
    if (!distributionPointId) { setSources([]); return; }
    setSourcesLoading(true);
    try {
      setSources(await loadOutletReturnableSources(distributionPointId));
    } catch {
      setSources([]);
    } finally {
      setSourcesLoading(false);
    }
  }, [distributionPointId]);

  useEffect(() => { void loadSources(); }, [loadSources]);

  const issues = useMemo(() => validateOutletReturnDraft(lines, sources), [lines, sources]);
  const confirmable = useMemo(() => outletReturnDraftConfirmable(lines, sources), [lines, sources]);
  const partiesComplete = Boolean(distributionPointId);

  /** Re-derive returnable provenance and caps immediately before creating. */
  const enterReview = async () => {
    setStep('review');
    setStaleKeys([]);
    if (!distributionPointId) return;
    const fresh = await loadOutletReturnableSources(distributionPointId).catch(() => null);
    if (!fresh) return;
    setSources(fresh);
    const revalidated = revalidateOutletReturnDraft(lines, fresh);
    setLines(revalidated.lines);
    setStaleKeys(revalidated.changed);
  };

  // ── the ONLY place this file persists anything ────────────────────────────
  const confirmAndCreate = async () => {
    if (!confirmable || committing) return;
    setCommitting(true);
    setError(null);

    const outcome = await commitDraft<OutletReturnDraftLine>(lines, {
      createHeader: () => requestOutletReturn({
        distributionPointId,
        returnNumber: externalReference.trim(),
        notes: notes.trim() || null,
      }),
      addLine: (returnRequestId, line) => addOutletReturnLine({
        returnRequestId,
        originalDispatchLineId: line.originalDispatchLineId,
        requestedQuantity: line.quantity,
        reasonCode: line.reasonCode,
        reasonText: line.reasonText,
      }),
      onProgress: setProgress,
    });

    // The return request header exists (in 'draft') the instant createHeader
    // succeeds — attach the paper reference here regardless of line outcome.
    if (outcome.requestId && paperRef.number.trim() !== '') {
      await setPaperReference({
        documentType: 'outlet_return_request',
        documentId: outcome.requestId,
        paperReferenceNumber: paperRef.number,
        paperReferenceDate: paperRef.date || null,
        issuingAuthority: paperRef.authority || null,
      }).catch(() => { /* best-effort; the return request itself is unaffected */ });
    }

    setResult(outcome);
    setCommitting(false);
    setProgress(null);
    if (outcome.complete && outcome.requestId) onCreated(outcome.requestId);
  };

  /** Retry reloads canonical server lines; dispatch-line provenance is the key. */
  const retryUnsent = async () => {
    if (!result?.requestId || committing) return;
    setCommitting(true);
    setError(null);

    const serverLines = await getOutletReturnRequestLines(result.requestId).catch(() => null);
    if (!serverLines) {
      setError(t('net_err_generic', lang));
      setCommitting(false);
      return;
    }

    const plan = planOutletReturnRetry(lines, serverLines.map(l => l.originalDispatchLineId));
    const requestId = result.requestId;

    const retried = await commitDraft<OutletReturnDraftLine>(plan.toSend, {
      // The return request exists — creating another would duplicate it.
      createHeader: () => Promise.resolve({ ok: true, data: { id: requestId } }),
      addLine: (returnRequestId, line) => addOutletReturnLine({
        returnRequestId,
        originalDispatchLineId: line.originalDispatchLineId,
        requestedQuantity: line.quantity,
        reasonCode: line.reasonCode,
        reasonText: line.reasonText,
      }),
      onProgress: setProgress,
    });

    setResult(previous => ({
      requestId,
      headerError: null,
      lines: [
        ...(previous?.lines ?? []).filter(l => !plan.toSend.some(s => s.idempotencyKey === l.idempotencyKey)),
        ...retried.lines,
      ],
      complete: retried.complete && plan.alreadyPresent.length + retried.lines.length === lines.length,
      partial: !retried.complete,
    }));
    setCommitting(false);
    setProgress(null);
  };

  const footer = step === 'review' && !result
    ? (
      <PhoenixButton
        disabled={!confirmable || committing}
        onClick={confirmAndCreate}
        data-testid="confirm-create-outlet-return"
      >
        {t('mv_create_return_request', lang)}
      </PhoenixButton>
    )
    : null;

  return (
    <MovementComposerShell
      lang={lang}
      dir={dir}
      title={t('mv_doc_return_request', lang)}
      step={step}
      onStep={next => { if (next === 'review') void enterReview(); else setStep(next); }}
      canAdvance={step === 'parties' ? partiesComplete : lines.length > 0}
      nothingPersistedYet={!result && !committing}
      onCancel={onCancel}
      footer={footer}
    >
      {step === 'parties' && (
        <div style={{ display: 'grid', gap: '14px' }}>
          <PhoenixInput label={t('mv_h_source', lang)} value={distributionPointName} disabled onChange={() => { /* fixed source */ }} />
          <PhoenixInput
            label={t('mv_external_reference', lang)}
            value={externalReference}
            onChange={e => setExternalReference(e.target.value)}
          />
          <p style={{ fontSize: '11px', color: 'var(--t2)', marginTop: '-6px' }}>{t('mv_external_reference_hint', lang)}</p>
          <PhoenixInput label={t('inv_notes', lang)} value={notes} onChange={e => setNotes(e.target.value)} />
          <PaperReferenceFields lang={lang} value={paperRef} onChange={setPaperRef} />
        </div>
      )}

      {step === 'materials' && (
        <OutletReturnProvenancePicker
          lang={lang}
          candidates={sources}
          existingLines={[]}
          loading={sourcesLoading}
          usedProvenanceIds={lines.map(l => l.originalDispatchLineId)}
          onAdd={(candidate, quantity, reasonCode, reasonText) =>
            setLines(previous => [...previous, draftLineFromReturnable(candidate, quantity, reasonCode, reasonText, newKey())])}
        />
      )}

      {step === 'review' && (
        <div style={{ display: 'grid', gap: '12px' }}>
          <PhoenixCard>
            <div style={{ fontSize: '12.5px', display: 'grid', gap: '4px' }}>
              <div><strong>{t('mv_h_source', lang)}:</strong> {distributionPointName}</div>
              <div><strong>{t('mv_external_reference', lang)}:</strong> {externalReference.trim() || '—'}</div>
            </div>
          </PhoenixCard>

          {staleKeys.length > 0 && (
            <div style={{ background: 'var(--warn2)', border: '1px solid var(--warn)', borderRadius: 'var(--r3)', padding: '10px 14px', fontSize: '12px', color: 'var(--warn)' }}>
              {t('mv_e_quantity_exceeds_available', lang)} — {staleKeys.length}
            </div>
          )}

          {result?.partial && (
            <div
              data-testid="outlet-return-partial-failure"
              style={{ background: 'var(--err2)', border: '1px solid var(--err)', borderRadius: 'var(--r3)', padding: '12px 14px', fontSize: '12px', color: 'var(--err)' }}
            >
              <strong>{t('mv_partial_title', lang)}</strong>
              <div style={{ marginTop: '4px' }}>{t('mv_partial_hint', lang)}</div>
              <div style={{ marginTop: '8px' }}>
                <PhoenixButton variant="secondary" disabled={committing} onClick={retryUnsent}>
                  {t('mv_retry_unsent', lang)}
                </PhoenixButton>
              </div>
            </div>
          )}

          {error && (
            <div style={{ background: 'var(--err2)', border: '1px solid var(--err)', borderRadius: 'var(--r3)', padding: '10px 14px', fontSize: '12px', color: 'var(--err)' }}>
              {error}
            </div>
          )}

          {committing && progress && (
            <div style={{ fontSize: '12px', color: 'var(--t2)' }}>{progress.completed} / {progress.total}</div>
          )}
          {committing && !progress && <PhoenixLoadingState />}

          <div style={{ display: 'grid', gap: '8px' }} data-testid="outlet-return-review-lines">
            {lines.map(line => {
              const lineState = result?.lines.find(r => r.idempotencyKey === line.idempotencyKey);
              const issue = issues.find(i => i.idempotencyKey === line.idempotencyKey);
              return (
                <PhoenixCard key={line.idempotencyKey}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: '12.5px', fontWeight: 700 }}>{line.scientificName}</div>
                      <div style={{ fontSize: '11px', color: 'var(--t2)' }}>
                        {t('mv_f_batch_number', lang)}: {line.batchNumber ?? '—'} ·{' '}
                        {t('mv_f_expiry_date', lang)}: {line.expiryDate ?? '—'} ·{' '}
                        {t('mv_f_original_supply_reference', lang)}: {line.dispatchNumber ?? '—'}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--t2)' }}>
                        {t('mv_f_return_reason', lang)}: {t(`net_op_reason_${line.reasonCode}`, lang)}
                        {line.reasonText ? ` — ${line.reasonText}` : ''}
                      </div>
                      {issue && (
                        <div style={{ fontSize: '11px', color: 'var(--err)', fontWeight: 700, marginTop: '2px' }}>
                          {t('mv_e_quantity_exceeds_available', lang)}
                        </div>
                      )}
                      {lineState?.error && (
                        <div style={{ fontSize: '11px', color: 'var(--err)', fontWeight: 700, marginTop: '2px' }}>{lineState.error}</div>
                      )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <div style={{ fontSize: '13px', fontWeight: 700 }}>
                        {line.quantity}{line.unit ? ` ${line.unit}` : ''} / {line.maxQuantity}
                      </div>
                      {!result && !committing && (
                        <PhoenixButton
                          variant="secondary"
                          onClick={() => setLines(previous => previous.filter(l => l.idempotencyKey !== line.idempotencyKey))}
                        >
                          {t('mv_remove_line', lang)}
                        </PhoenixButton>
                      )}
                    </div>
                  </div>
                </PhoenixCard>
              );
            })}
          </div>
        </div>
      )}
    </MovementComposerShell>
  );
}
