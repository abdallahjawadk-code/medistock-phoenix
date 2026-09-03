/**
 * MOVEMENT-COMPOSER-A — the unified Direct Return composer.
 *
 * Returns are built from PROVENANCE, not from generic material entry. Every
 * candidate is a real received transfer line, `originalTransferLineId` travels
 * into the RPC, and migration 069 makes that column NOT NULL — so a free-text
 * return is impossible in the schema as well as in this UI.
 *
 * Like the supply composer, NOTHING is persisted until the operator confirms:
 * requestDirectReturn / recallDirectTransfer and addDirectReturnLine appear only
 * inside confirmAndCreate.
 *
 * Both existing modes are preserved: an institution-initiated return request and
 * a central recall. They are different authorizations against different RPCs and
 * are not merged.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t, tRpcError } from '@/shared/i18n/strings';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';
import { PhoenixSelect } from '@/shared/ui/PhoenixSelect';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import {
  requestDirectReturn, recallDirectTransfer, addDirectReturnLine,
  getTransfers, getIncomingTransferLines, getWarehouseStock, getReturnRequestLines,
  type NetworkWarehouse,
} from '@/features/network/network.service';
import { validateDraft, draftIsConfirmable, type DraftLine } from './composer-model';
import { computeProvenanceCaps } from './provenance';
import { commitDraft, planRetry, type CommitResult, type CommitProgress } from './movement-commit';
import { MovementComposerShell, type ComposerStep } from './ui/MovementComposerShell';
import { MovementPartySelector, pairedPartyLabel, type PartyOption } from './ui/MovementPartySelector';
import { ProvenanceReturnPicker, type ReturnCandidate } from './ui/ProvenanceReturnPicker';
import { MovementLineTable } from './ui/MovementLineTable';

const newKey = () =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

export type ReturnMode = 'request' | 'recall';

interface Props {
  /** Institution warehouses that may originate a return. */
  institutionWarehouses: readonly PartyOption[];
  organizations: Array<{ id: string; name: string }>;
  /** Permitted central destination warehouses. */
  centralWarehouses: readonly NetworkWarehouse[];
  onCancel: () => void;
  onCreated: (returnRequestId: string) => void;
  onRecalled: () => void;
}

export function DirectReturnComposer({
  institutionWarehouses, organizations, centralWarehouses, onCancel, onCreated, onRecalled,
}: Props) {
  const { lang, dir } = useApp();

  const [step, setStep] = useState<ComposerStep>('parties');
  const [mode, setMode] = useState<ReturnMode>('request');
  const [sourceOrgId, setSourceOrgId] = useState('');
  const [sourceWarehouseId, setSourceWarehouseId] = useState('');
  const [destinationWarehouseId, setDestinationWarehouseId] = useState('');
  /** Operator-typed. NOT a controlled serial — the uuid is the trace key. */
  const [externalReference, setExternalReference] = useState('');
  const [notes, setNotes] = useState('');

  const [candidates, setCandidates] = useState<ReturnCandidate[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [staleKeys, setStaleKeys] = useState<string[]>([]);

  const [committing, setCommitting] = useState(false);
  const [progress, setProgress] = useState<CommitProgress | null>(null);
  const [result, setResult] = useState<CommitResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Build returnable provenance for the selected institution warehouse.
   *
   * Three batched reads, joined in memory — never an N+1 walk:
   *   1. transfers INTO this warehouse,
   *   2. all their lines in ONE query,
   *   3. current stock of this warehouse in ONE query,
   * then matched on resulting_warehouse_stock_id so the physical cap is real.
   */
  const loadCandidates = useCallback(async (warehouseId: string) => {
    if (!warehouseId) { setCandidates([]); return; }
    setCandidatesLoading(true);
    try {
      const transfers = await getTransfers(warehouseId, true);
      const [allLines, stock] = await Promise.all([
        getIncomingTransferLines(transfers.map(x => x.id)),
        getWarehouseStock(warehouseId),
      ]);
      const stockById = new Map(stock.map(s => [s.id, s]));
      const transferById = new Map(transfers.map(x => [x.id, x]));

      const next: ReturnCandidate[] = allLines
        // Only lines the institution actually RECEIVED can be returned.
        .filter(l => l.receivedQuantity !== null && l.receivedQuantity > 0)
        .map(l => {
          const physical = l.resultingWarehouseStockId ? stockById.get(l.resultingWarehouseStockId) : undefined;
          return {
            originalTransferLineId: l.id,
            receivedQuantity: l.receivedQuantity,
            returnedQuantity: l.returnedQuantity,
            resultingWarehouseStockId: l.resultingWarehouseStockId,
            onHandQuantity: physical?.onHandQuantity ?? null,
            reservedQuantity: physical?.reservedQuantity ?? null,
            scientificName: l.scientificName,
            tradeName: l.tradeName,
            concentration: l.concentration,
            dosageForm: l.dosageForm,
            unit: l.unit,
            nationalCode: l.nationalCode,
            batchNumber: l.batchNumber,
            internalBatchReference: l.internalBatchReference,
            expiryDate: l.expiryDate,
            originalTransferNumber: transferById.get(l.transferId)?.transferNumber ?? null,
            originalTransferId: l.transferId,
            receivedAt: l.receivedAt,
            sourceWarehouseName: null,
          };
        })
        // Nothing left to return is not a candidate.
        .filter(c => computeProvenanceCaps(c).safeReturnable > 0);

      setCandidates(next);
    } catch {
      setCandidates([]);
    } finally {
      setCandidatesLoading(false);
    }
  }, []);

  useEffect(() => { void loadCandidates(sourceWarehouseId); }, [sourceWarehouseId, loadCandidates]);

  const issues = useMemo(() => validateDraft(lines, 'return'), [lines]);
  const confirmable = useMemo(() => draftIsConfirmable(lines, 'return'), [lines]);
  const canConfirm = confirmable && (mode !== 'recall' || lines.length === 1);
  /**
   * The official-letter number is REQUIRED, not optional.
   *
   * Both RPCs this composer can reach normalise the number the same way and
   * refuse it when it is blank: phoenix_request_direct_warehouse_return
   * (migration 077) and, for the recall mode, phoenix_recall_warehouse_transfer_line
   * (migration 185) each compute NULLIF(btrim(p_return_number), '') and raise
   * return_number_required when it is NULL. Nothing generates this number on
   * the operator's behalf. Trimmed so a whitespace-only entry is refused here
   * instead of becoming a raw 400.
   */
  const referenceMissing = externalReference.trim() === '';
  const partiesComplete = Boolean(sourceOrgId && sourceWarehouseId && destinationWarehouseId);

  const source = institutionWarehouses.find(w => w.id === sourceWarehouseId) ?? null;
  const destination = centralWarehouses.find(w => w.id === destinationWarehouseId) ?? null;

  /** Re-derive provenance and physical caps immediately before creating. */
  const enterReview = async () => {
    setStep('review');
    setStaleKeys([]);
    await loadCandidates(sourceWarehouseId);
  };

  // Recompute caps against freshly loaded provenance whenever it changes.
  useEffect(() => {
    if (step !== 'review' || candidates.length === 0) return;
    const byProvenance = new Map(candidates.map(c => [c.originalTransferLineId, computeProvenanceCaps(c).safeReturnable]));
    const changed: string[] = [];
    setLines(previous => previous.map(line => {
      if (!line.originalTransferLineId) return line;
      const cap = byProvenance.get(line.originalTransferLineId) ?? 0;
      if (cap !== line.maxQuantity) {
        changed.push(line.idempotencyKey);
        return { ...line, maxQuantity: cap };
      }
      return line;
    }));
    if (changed.length > 0) setStaleKeys(changed);
  }, [step, candidates]);

  // ── the ONLY place this file persists anything ────────────────────────────

  const confirmAndCreate = async () => {
    if (!canConfirm || referenceMissing || committing) return;
    setCommitting(true);
    setError(null);

    if (mode === 'recall') {
      // Migration 185's selector materializes the complete current-custody
      // obligation and intentionally returns counts only. It is not a header
      // creator, so never fabricate a request id or append draft lines to it.
      const line = lines.length === 1 ? lines[0] : null;
      if (!line?.originalTransferLineId) {
        setError(t('err_generic', lang));
        setCommitting(false);
        return;
      }
      const recalled = await recallDirectTransfer({
        originalTransferLineId: line.originalTransferLineId,
        returnNumber: externalReference.trim(),
        notes: notes.trim() || null,
      });
      setCommitting(false);
      if (!recalled.ok) {
        setError(tRpcError(recalled.error, lang));
        return;
      }
      onRecalled();
      return;
    }

    const outcome = await commitDraft(lines, {
      createHeader: () => requestDirectReturn({
          sourceWarehouseId,
          destinationWarehouseId,
          returnNumber: externalReference.trim(),
          notes: notes.trim() || null,
        }),
      addLine: (returnRequestId, line) => addDirectReturnLine({
        returnRequestId,
        // Provenance is mandatory and is what identifies the material.
        originalTransferLineId: line.originalTransferLineId as string,
        requestedQuantity: line.quantity,
        reasonCode: line.reasonCode as string,
        reasonText: line.reasonText,
      }),
      onProgress: setProgress,
    });

    setResult(outcome);
    setCommitting(false);
    setProgress(null);
    if (outcome.complete && outcome.requestId) onCreated(outcome.requestId);
  };

  /** Retry reloads canonical server lines; provenance is the match key. */
  const retryUnsent = async () => {
    if (!result?.requestId || committing) return;
    setCommitting(true);
    setError(null);

    const serverLines = await getReturnRequestLines(result.requestId).catch(() => null);
    if (!serverLines) {
      setError(t('err_generic', lang));
      setCommitting(false);
      return;
    }

    const plan = planRetry(lines, serverLines.map(l => ({
      id: l.id,
      scientificName: l.scientificName,
      // Unused on this path: a return line always carries a real
      // originalTransferLineId, so planRetry matches on provenance and never
      // falls back to either identity key these feed.
      batchNumber: null,
      expiryDate: null,
      concentration: null,
      dosageForm: null,
      unit: null,
      originalTransferLineId: l.originalTransferLineId,
      requestedQuantity: l.requestedQuantity,
    })), 'return');

    const retried = await commitDraft(plan.toSend, {
      // The return request exists — creating another would duplicate it.
      createHeader: () => Promise.resolve({ ok: true, data: { id: result.requestId as string } }),
      addLine: (returnRequestId, line) => addDirectReturnLine({
        returnRequestId,
        originalTransferLineId: line.originalTransferLineId as string,
        requestedQuantity: line.quantity,
        reasonCode: line.reasonCode as string,
        reasonText: line.reasonText,
      }),
      onProgress: setProgress,
    });

    setResult(previous => ({
      requestId: result.requestId,
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

  const lineStates = useMemo(() => {
    if (!result) return undefined;
    return Object.fromEntries(result.lines.map(l => [l.idempotencyKey, { state: l.state, error: l.error }]));
  }, [result]);

  const footer = step === 'review' && !result
    ? (
      <PhoenixButton
        disabled={!canConfirm || referenceMissing || committing}
        onClick={confirmAndCreate}
        data-testid="confirm-create-return-request"
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
          <PhoenixSelect
            label={t('mv_return_mode', lang)}
            value={mode}
            onChange={e => setMode(e.target.value as ReturnMode)}
            options={[
              { value: 'request', label: t('mv_return_mode_request', lang) },
              { value: 'recall', label: t('mv_return_mode_recall', lang) },
            ]}
          />

          {/* Institution FIRST, then only its own depots. */}
          <MovementPartySelector
            lang={lang}
            label={t('nav_institutions', lang)}
            organizations={organizations}
            warehouses={institutionWarehouses}
            selectedOrganizationId={sourceOrgId}
            selectedWarehouseId={sourceWarehouseId}
            onSelectOrganization={setSourceOrgId}
            onSelectWarehouse={setSourceWarehouseId}
          />

          <MovementPartySelector
            lang={lang}
            label={t('nav_network', lang)}
            organizations={[{ id: '__central', name: t('nav_network', lang) }]}
            warehouses={centralWarehouses.map(w => ({
              id: w.id, organizationId: '__central',
              organizationName: t('nav_network', lang),
              warehouseName: lang === 'ar' ? (w.name_ar || w.name) : (w.name || w.name_ar),
            }))}
            selectedOrganizationId="__central"
            selectedWarehouseId={destinationWarehouseId}
            onSelectOrganization={() => { /* central destination is fixed */ }}
            onSelectWarehouse={setDestinationWarehouseId}
          />

          <PhoenixInput
            label={t('mv_external_reference', lang)}
            value={externalReference}
            onChange={e => setExternalReference(e.target.value)}
          />
          <p style={{ fontSize: '11px', color: 'var(--t2)', marginTop: '-6px' }}>
            {t('mv_external_reference_hint', lang)}
          </p>

          <PhoenixInput label={t('inv_notes', lang)} value={notes} onChange={e => setNotes(e.target.value)} />
        </div>
      )}

      {step === 'materials' && (
        <ProvenanceReturnPicker
          lang={lang}
          candidates={candidates}
          loading={candidatesLoading}
          usedProvenanceIds={lines.map(l => l.originalTransferLineId).filter((v): v is string => Boolean(v))}
          onAdd={(candidate, quantity, reasonCode, reasonText) => setLines(previous => [...previous, {
            idempotencyKey: newKey(),
            warehouseStockId: null,
            originalTransferLineId: candidate.originalTransferLineId,
            centralItemId: null,
            scientificName: candidate.scientificName,
            tradeName: candidate.tradeName,
            concentration: candidate.concentration,
            dosageForm: candidate.dosageForm,
            unit: candidate.unit,
            nationalCode: candidate.nationalCode,
            batchNumber: candidate.batchNumber,
            internalBatchReference: candidate.internalBatchReference,
            expiryDate: candidate.expiryDate,
            quantity,
            maxQuantity: computeProvenanceCaps(candidate).safeReturnable,
            reasonCode,
            reasonText,
            notes: null,
          }])}
        />
      )}

      {step === 'review' && (
        <div style={{ display: 'grid', gap: '12px' }}>
          <PhoenixCard>
            <div style={{ fontSize: '12.5px', display: 'grid', gap: '4px' }}>
              <div><strong>{t('mv_return_mode', lang)}:</strong>{' '}
                {t(mode === 'recall' ? 'mv_return_mode_recall' : 'mv_return_mode_request', lang)}
              </div>
              <div><strong>{t('mv_h_source', lang)}:</strong>{' '}
                {pairedPartyLabel(source?.organizationName ?? null, source?.warehouseName ?? null)}
              </div>
              <div><strong>{t('mv_h_destination', lang)}:</strong>{' '}
                {pairedPartyLabel(t('nav_network', lang), destination
                  ? (lang === 'ar' ? (destination.name_ar || destination.name) : destination.name)
                  : null)}
              </div>
              <div><strong>{t('mv_external_reference', lang)}:</strong> {externalReference.trim() || '—'}</div>
            </div>
          </PhoenixCard>

          {referenceMissing && (
            <div
              data-testid="return-external-reference-required"
              style={{ background: 'var(--warn2)', border: '1px solid var(--warn)', borderRadius: 'var(--r3)', padding: '10px 14px', fontSize: '12px', color: 'var(--warn)' }}
            >
              {t('mv_external_reference_required', lang)}
            </div>
          )}

          {staleKeys.length > 0 && (
            <div style={{ background: 'var(--warn2)', border: '1px solid var(--warn)', borderRadius: 'var(--r3)', padding: '10px 14px', fontSize: '12px', color: 'var(--warn)' }}>
              {t('mv_e_quantity_exceeds_available', lang)} — {staleKeys.length}
            </div>
          )}

          {result?.partial && (
            <div
              data-testid="return-partial-failure"
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

          <MovementLineTable
            lang={lang}
            lines={lines}
            issues={issues}
            lineStates={lineStates}
            readOnly={committing || Boolean(result)}
            onChangeQuantity={(key, quantity) =>
              setLines(previous => previous.map(l => (l.idempotencyKey === key ? { ...l, quantity } : l)))}
            onRemove={key => setLines(previous => previous.filter(l => l.idempotencyKey !== key))}
          />
        </div>
      )}
    </MovementComposerShell>
  );
}
