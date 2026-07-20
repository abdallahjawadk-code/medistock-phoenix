/**
 * OUTLET-CORRIDOR-070 — the institution-warehouse → outlet dispatch composer.
 *
 * Mirrors DirectSupplyComposer's draft-first discipline for the 070 corridor:
 * the whole dispatch is composed locally and NOTHING is persisted until the
 * operator confirms on review. The only createWarehouseDispatch / addDispatchLine
 * call sites are inside confirmAndCreate.
 *
 * The material picker reads ONLY canonical institution warehouse stock
 * (getWarehouseStock) — every line's identity is a real warehouse_stock lot, never
 * a typed name or OCR result. The destination is an outlet belonging to THIS
 * institution warehouse; there is no central→outlet shortcut and no cross-scope
 * outlet. Partial-failure recovery and idempotent retry are the shared
 * movement-commit protocol.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';
import { PhoenixSelect } from '@/shared/ui/PhoenixSelect';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { getWarehouseStock } from '@/features/network/network.service';
import {
  draftLineFromStock, validateDraft, draftIsConfirmable, revalidateAgainstFreshStock,
  type DraftLine, type StockCandidate,
} from '@/features/movement/composer-model';
import { commitDraft, planRetry, type CommitResult, type CommitProgress } from '@/features/movement/movement-commit';
import { MovementComposerShell, type ComposerStep } from '@/features/movement/ui/MovementComposerShell';
import { StockMaterialPicker } from '@/features/movement/ui/StockMaterialPicker';
import { MovementLineTable } from '@/features/movement/ui/MovementLineTable';
import {
  createWarehouseDispatch, addDispatchLine, getWarehouseDispatchLines,
} from './dispatch.service';

const newKey = () =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const toCandidates = (batches: Awaited<ReturnType<typeof getWarehouseStock>>): StockCandidate[] =>
  batches.map(b => ({
    warehouseStockId: b.id, centralItemId: null, scientificName: b.scientificName,
    tradeName: null, concentration: null, dosageForm: null, unit: null,
    nationalCode: b.nationalCode, batchNumber: b.batchNumber, internalBatchReference: null,
    expiryDate: b.expiryDate, onHandQuantity: b.onHandQuantity,
    reservedQuantity: b.reservedQuantity, availableQuantity: b.availableQuantity,
  }));

interface Props {
  /** The institution warehouse dispatching (already scope-checked). */
  sourceWarehouseId: string;
  sourceWarehouseName: string;
  /** Outlets belonging to THIS warehouse's institution and permitted scope. */
  outlets: ReadonlyArray<{ id: string; name: string }>;
  onCancel: () => void;
  onCreated: (dispatchId: string) => void;
}

export function OutletDispatchComposer({
  sourceWarehouseId, sourceWarehouseName, outlets, onCancel, onCreated,
}: Props) {
  const { lang, dir } = useApp();

  const [step, setStep] = useState<ComposerStep>('parties');
  const [outletId, setOutletId] = useState('');
  const [externalReference, setExternalReference] = useState('');
  const [notes, setNotes] = useState('');

  const [lines, setLines] = useState<DraftLine[]>([]);
  const [stock, setStock] = useState<StockCandidate[]>([]);
  const [stockLoading, setStockLoading] = useState(false);
  const [staleKeys, setStaleKeys] = useState<string[]>([]);

  const [committing, setCommitting] = useState(false);
  const [progress, setProgress] = useState<CommitProgress | null>(null);
  const [result, setResult] = useState<CommitResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadStock = useCallback(async () => {
    if (!sourceWarehouseId) { setStock([]); return; }
    setStockLoading(true);
    try {
      setStock(toCandidates(await getWarehouseStock(sourceWarehouseId)));
    } catch {
      setStock([]);
    } finally {
      setStockLoading(false);
    }
  }, [sourceWarehouseId]);

  useEffect(() => { void loadStock(); }, [loadStock]);

  const issues = useMemo(() => validateDraft(lines, 'supply'), [lines]);
  const confirmable = useMemo(() => draftIsConfirmable(lines, 'supply'), [lines]);
  const partiesComplete = Boolean(sourceWarehouseId && outletId);
  const outlet = outlets.find(o => o.id === outletId) ?? null;

  const enterReview = async () => {
    setStep('review');
    setStaleKeys([]);
    const batches = await getWarehouseStock(sourceWarehouseId).catch(() => null);
    if (!batches) return;
    const fresh = toCandidates(batches);
    setStock(fresh);
    const revalidated = revalidateAgainstFreshStock(lines, fresh);
    setLines(revalidated.lines);
    setStaleKeys(revalidated.changed);
  };

  // ── the ONLY place this file persists anything ────────────────────────────
  const confirmAndCreate = async () => {
    if (!confirmable || committing) return;
    setCommitting(true);
    setError(null);

    const outcome = await commitDraft(lines, {
      createHeader: () => createWarehouseDispatch({
        warehouseId: sourceWarehouseId,
        destinationDistributionPointId: outletId,
        dispatchNumber: externalReference.trim(),
        notes: notes.trim() || null,
      }),
      addLine: (dispatchId, line) => addDispatchLine({
        dispatchId,
        warehouseStockId: line.warehouseStockId as string,
        quantity: line.quantity,
      }),
      onProgress: setProgress,
    });

    setResult(outcome);
    setCommitting(false);
    setProgress(null);
    if (outcome.complete && outcome.requestId) onCreated(outcome.requestId);
  };

  const retryUnsent = async () => {
    if (!result?.requestId || committing) return;
    setCommitting(true);
    setError(null);

    const serverLines = await getWarehouseDispatchLines(result.requestId).catch(() => null);
    if (!serverLines) {
      setError(t('err_generic', lang));
      setCommitting(false);
      return;
    }

    const plan = planRetry(lines, serverLines.map(l => ({
      id: l.id, scientificName: l.scientificName, batchNumber: l.batchNumber,
      expiryDate: l.expiryDate, originalTransferLineId: null, requestedQuantity: l.sentQuantity,
    })), 'supply');

    const retried = await commitDraft(plan.toSend, {
      createHeader: () => Promise.resolve({ ok: true, data: { id: result.requestId as string } }),
      addLine: (dispatchId, line) => addDispatchLine({
        dispatchId, warehouseStockId: line.warehouseStockId as string, quantity: line.quantity,
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
      <PhoenixButton disabled={!confirmable || committing} onClick={confirmAndCreate} data-testid="confirm-create-outlet-dispatch">
        {t('mv_create_outlet_dispatch', lang)}
      </PhoenixButton>
    )
    : null;

  return (
    <MovementComposerShell
      lang={lang}
      dir={dir}
      title={t('mv_doc_outlet_dispatch', lang)}
      step={step}
      onStep={next => { if (next === 'review') void enterReview(); else setStep(next); }}
      canAdvance={step === 'parties' ? partiesComplete : lines.length > 0}
      nothingPersistedYet={!result && !committing}
      onCancel={onCancel}
      footer={footer}
    >
      {step === 'parties' && (
        <div style={{ display: 'grid', gap: '14px' }}>
          <PhoenixInput label={t('inv_warehouse', lang)} value={sourceWarehouseName} disabled onChange={() => { /* fixed source */ }} />
          <PhoenixSelect
            label={t('mv_outlet', lang)}
            value={outletId}
            onChange={e => setOutletId(e.target.value)}
            options={[{ value: '', label: t('inv_select_warehouse', lang) }, ...outlets.map(o => ({ value: o.id, label: o.name }))]}
          />
          <PhoenixInput label={t('mv_external_reference', lang)} value={externalReference} onChange={e => setExternalReference(e.target.value)} />
          <p style={{ fontSize: '11px', color: 'var(--t2)', marginTop: '-6px' }}>{t('mv_external_reference_hint', lang)}</p>
          <PhoenixInput label={t('inv_notes', lang)} value={notes} onChange={e => setNotes(e.target.value)} />
        </div>
      )}

      {step === 'materials' && (
        <StockMaterialPicker
          lang={lang}
          candidates={stock}
          usedStockIds={lines.map(l => l.warehouseStockId).filter((v): v is string => Boolean(v))}
          loading={stockLoading}
          onAdd={(candidate, quantity) => setLines(previous => [...previous, draftLineFromStock(candidate, quantity, newKey())])}
        />
      )}

      {step === 'review' && (
        <div style={{ display: 'grid', gap: '12px' }}>
          <PhoenixCard>
            <div style={{ fontSize: '12.5px', display: 'grid', gap: '4px' }}>
              <div><strong>{t('inv_warehouse', lang)}:</strong> {sourceWarehouseName}</div>
              <div><strong>{t('mv_outlet', lang)}:</strong> {outlet?.name ?? '—'}</div>
              <div><strong>{t('mv_external_reference', lang)}:</strong> {externalReference.trim() || '—'}</div>
            </div>
          </PhoenixCard>

          {staleKeys.length > 0 && (
            <div style={{ background: 'var(--warn2)', border: '1px solid var(--warn)', borderRadius: 'var(--r3)', padding: '10px 14px', fontSize: '12px', color: 'var(--warn)' }}>
              {t('mv_e_quantity_exceeds_available', lang)} — {staleKeys.length}
            </div>
          )}

          {result?.partial && (
            <div data-testid="outlet-dispatch-partial-failure" style={{ background: 'var(--err2)', border: '1px solid var(--err)', borderRadius: 'var(--r3)', padding: '12px 14px', fontSize: '12px', color: 'var(--err)' }}>
              <strong>{t('mv_partial_title', lang)}</strong>
              <div style={{ marginTop: '4px' }}>{t('mv_partial_hint', lang)}</div>
              <div style={{ marginTop: '8px' }}>
                <PhoenixButton variant="secondary" disabled={committing} onClick={retryUnsent}>{t('mv_retry_unsent', lang)}</PhoenixButton>
              </div>
            </div>
          )}

          {error && (
            <div style={{ background: 'var(--err2)', border: '1px solid var(--err)', borderRadius: 'var(--r3)', padding: '10px 14px', fontSize: '12px', color: 'var(--err)' }}>{error}</div>
          )}

          {committing && progress && <div style={{ fontSize: '12px', color: 'var(--t2)' }}>{progress.completed} / {progress.total}</div>}
          {committing && !progress && <PhoenixLoadingState />}

          <MovementLineTable
            lang={lang}
            lines={lines}
            issues={issues}
            lineStates={lineStates}
            readOnly={committing || Boolean(result)}
            onChangeQuantity={(key, quantity) => setLines(previous => previous.map(l => (l.idempotencyKey === key ? { ...l, quantity } : l)))}
            onRemove={key => setLines(previous => previous.filter(l => l.idempotencyKey !== key))}
          />
        </div>
      )}
    </MovementComposerShell>
  );
}
