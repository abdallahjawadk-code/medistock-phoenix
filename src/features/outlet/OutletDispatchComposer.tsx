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
import { commitDraft, planRetry, type CommitResult, type CommitProgress, type RpcOutcome } from '@/features/movement/movement-commit';
import { MovementComposerShell, type ComposerStep } from '@/features/movement/ui/MovementComposerShell';
import { StockMaterialPicker } from '@/features/movement/ui/StockMaterialPicker';
import { MovementLineTable } from '@/features/movement/ui/MovementLineTable';
import { PaperReferenceFields, EMPTY_PAPER_REFERENCE, type PaperReferenceValue } from '@/features/movement/ui/PaperReferenceFields';
import { setPaperReference } from '@/features/movement/paper-reference.service';
import {
  createWarehouseDispatch, addDispatchLine, getWarehouseDispatchLines,
  getFefoAlternatives, type FefoBatch,
} from './dispatch.service';
import { createInitialProvisioningDispatch } from './emergency-replenishment.service';
import { FefoOverrideDialog } from './FefoOverrideDialog';
import { useFefoOverridePermission } from '@/features/inventory/useFefoOverridePermission';
import { operationToken } from '@/shared/lib/operation-token';
import { canonicalIntent } from '@/shared/lib/canonical-intent';

const newKey = () =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

/**
 * 106's server-side idempotency key for one add-line attempt, derived the
 * SAME way every other stock mutation in this app derives its request id
 * (operation-token.ts / stock-mutation-runner.ts) rather than minted fresh
 * per call: stable across a retry of the identical attempt (same line,
 * unchanged quantity/override), but a DIFFERENT value the instant the
 * operator edits the quantity or the confirmed override reason — which 106's
 * own conflict check (23505) would otherwise correctly reject as "same
 * request id, different payload" if this derivation reused a stale token.
 *
 * `generation` is a constant 0: unlike a receive/send RPC that advances an
 * existing row's server-tracked progress, add-line only ever CREATES a new
 * row for a given draft line, so there is no canonical "already partially
 * done" measure to fold in — planRetry (movement-commit.ts) is what excludes
 * a line the server already confirmed from ever reaching this function again.
 *
 * Fails closed: if Web Crypto is unavailable, this throws
 * (OperationTokenUnavailableError) rather than falling back to an unguarded
 * call — the caller must not add a dispatch line it cannot safely retry.
 */
async function deriveDispatchLineRequestId(line: {
  idempotencyKey: string; warehouseStockId: string; quantity: number;
}, fefoOverride: boolean, overrideReason: string | null): Promise<string> {
  return operationToken({
    kind: 'outlet_dispatch_add_line',
    entityId: line.idempotencyKey,
    generation: 0,
    intent: canonicalIntent({
      warehouseStockId: line.warehouseStockId,
      quantity: line.quantity,
      fefoOverride,
      overrideReason,
    }),
  });
}

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
  /**
   * STAGE-E-E7-2: when true, the header is created via Migration 166's
   * `phoenix_create_initial_provisioning_dispatch` (التجهيز الأولي) instead of
   * the ordinary `phoenix_create_warehouse_dispatch` (070) — a distinct RPC,
   * so this dispatch is flagged `is_initial_provisioning` and counts against
   * the outlet's own one-shot lifecycle slot. Every other step (FEFO material
   * picker, line commit, retry protocol) is identical on purpose: this is the
   * same battle-tested composer, not a second implementation of dispatch
   * creation. Callers are responsible for only offering this when the
   * destination outlet has not already consumed its slot.
   */
  isInitialProvisioning?: boolean;
}

export function OutletDispatchComposer({
  sourceWarehouseId, sourceWarehouseName, outlets, onCancel, onCreated,
  isInitialProvisioning = false,
}: Props) {
  const { lang, dir, activeOrgId } = useApp();

  const [step, setStep] = useState<ComposerStep>('parties');
  const [outletId, setOutletId] = useState('');
  const [externalReference, setExternalReference] = useState('');
  const [notes, setNotes] = useState('');
  // PAPER-REFERENCE-CONTRACT-110: optional third field-set, distinct from
  // externalReference — set on the created dispatch only if the operator
  // actually typed a number, never a required precondition to create.
  const [paperRef, setPaperRef] = useState<PaperReferenceValue>(EMPTY_PAPER_REFERENCE);

  const [lines, setLines] = useState<DraftLine[]>([]);
  const [stock, setStock] = useState<StockCandidate[]>([]);
  const [stockLoading, setStockLoading] = useState(false);
  const [staleKeys, setStaleKeys] = useState<string[]>([]);

  const [committing, setCommitting] = useState(false);
  const [progress, setProgress] = useState<CommitProgress | null>(null);
  const [result, setResult] = useState<CommitResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // FEFO-REASONED-OVERRIDE (097/102) — a non-earliest pick is never added
  // silently. `fefoPrompt` holds the candidate awaiting a decision;
  // `lineOverrides` records, per draft line (keyed by its stable
  // idempotencyKey), the override reason actually confirmed — read back at
  // commit time so addDispatchLine passes the SAME override it was granted
  // for, never a fresh unaudited one.
  const canOverrideFefo = useFefoOverridePermission(activeOrgId, sourceWarehouseId).data ?? false;
  const [fefoPrompt, setFefoPrompt] = useState<{ candidate: StockCandidate; quantity: number; alternatives: FefoBatch[] } | null>(null);
  const [lineOverrides, setLineOverrides] = useState<Record<string, string>>({});
  const [fefoCheckBusy, setFefoCheckBusy] = useState(false);

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

  /**
   * Every pick is checked against 072's own FEFO order BEFORE it ever enters
   * the draft. A compliant pick adds immediately (identical to before this
   * feature existed); a non-compliant one opens FefoOverrideDialog and adds
   * NOTHING until the operator explicitly decides — cancelling never adds
   * the line.
   */
  const handlePick = async (candidate: StockCandidate, quantity: number) => {
    if (!activeOrgId || fefoCheckBusy) return;
    setFefoCheckBusy(true);
    try {
      const alternatives = await getFefoAlternatives(
        activeOrgId, sourceWarehouseId, candidate.scientificName, candidate.nationalCode,
      );
      const earliest = alternatives[0] ?? null;
      if (!earliest || earliest.stockId === candidate.warehouseStockId) {
        setLines(previous => [...previous, draftLineFromStock(candidate, quantity, newKey())]);
      } else {
        setFefoPrompt({ candidate, quantity, alternatives });
      }
    } catch {
      // A failed compliance READ must never fall through to a silent add —
      // fail closed and let the operator retry the pick.
      setError(t('err_generic', lang));
    } finally {
      setFefoCheckBusy(false);
    }
  };

  const handleFefoConfirmOverride = (reason: string) => {
    if (!fefoPrompt) return;
    const key = newKey();
    setLines(previous => [...previous, draftLineFromStock(fefoPrompt.candidate, fefoPrompt.quantity, key)]);
    setLineOverrides(previous => ({ ...previous, [key]: reason }));
    setFefoPrompt(null);
  };

  const handleFefoUseAlternative = (stockId: string) => {
    if (!fefoPrompt) return;
    const alt = stock.find(s => s.warehouseStockId === stockId);
    if (alt) setLines(previous => [...previous, draftLineFromStock(alt, fefoPrompt.quantity, newKey())]);
    setFefoPrompt(null);
  };

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
      createHeader: () => isInitialProvisioning
        ? createInitialProvisioningDispatch({
            warehouseId: sourceWarehouseId,
            destinationDistributionPointId: outletId,
            dispatchNumber: externalReference.trim(),
            notes: notes.trim() || null,
          }).then((r): RpcOutcome => ({
            ok: r.ok,
            error: r.error,
            data: (r.data as unknown as Record<string, unknown> | undefined) ?? null,
          }))
        : createWarehouseDispatch({
            warehouseId: sourceWarehouseId,
            destinationDistributionPointId: outletId,
            dispatchNumber: externalReference.trim(),
            notes: notes.trim() || null,
          }),
      addLine: async (dispatchId, line) => {
        const fefoOverride = line.idempotencyKey in lineOverrides;
        const overrideReason = lineOverrides[line.idempotencyKey] ?? null;
        let requestId: string;
        try {
          requestId = await deriveDispatchLineRequestId(
            { idempotencyKey: line.idempotencyKey, warehouseStockId: line.warehouseStockId as string, quantity: line.quantity },
            fefoOverride, overrideReason,
          );
        } catch {
          // Fail closed, matching operation-token.ts's own rule: a line that
          // cannot derive a stable retry key must not be added at all.
          return { ok: false, error: 'operation_token_unavailable' };
        }
        return addDispatchLine({
          dispatchId,
          warehouseStockId: line.warehouseStockId as string,
          quantity: line.quantity,
          // The SAME override reason confirmed at pick-time, never re-derived —
          // a retry of this line must replay the identical decision, not ask
          // the server to accept a fresh unaudited one.
          fefoOverride,
          overrideReason,
          requestId,
        });
      },
      onProgress: setProgress,
    });

    // The dispatch header exists (in 'draft') the instant createHeader
    // succeeds, independent of how the lines land — so a paper reference is
    // attached here even on a partial line failure, rather than only on full
    // success. Best-effort: a failure here must never undo a created dispatch.
    if (outcome.requestId && paperRef.number.trim() !== '') {
      await setPaperReference({
        documentType: 'warehouse_dispatch',
        documentId: outcome.requestId,
        paperReferenceNumber: paperRef.number,
        paperReferenceDate: paperRef.date || null,
        issuingAuthority: paperRef.authority || null,
      }).catch(() => { /* best-effort; the dispatch itself is unaffected */ });
    }

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
      expiryDate: l.expiryDate,
      // Unused on this path: a dispatch line commits to one specific physical
      // batch, so 'batch' identity below matches on batchNumber/expiryDate,
      // not material identity.
      concentration: null, dosageForm: null, unit: null,
      originalTransferLineId: null, requestedQuantity: l.sentQuantity,
    })), 'batch');

    const retried = await commitDraft(plan.toSend, {
      createHeader: () => Promise.resolve({ ok: true, data: { id: result.requestId as string } }),
      addLine: async (dispatchId, line) => {
        const fefoOverride = line.idempotencyKey in lineOverrides;
        const overrideReason = lineOverrides[line.idempotencyKey] ?? null;
        let requestId: string;
        try {
          requestId = await deriveDispatchLineRequestId(
            { idempotencyKey: line.idempotencyKey, warehouseStockId: line.warehouseStockId as string, quantity: line.quantity },
            fefoOverride, overrideReason,
          );
        } catch {
          return { ok: false, error: 'operation_token_unavailable' };
        }
        return addDispatchLine({
          dispatchId, warehouseStockId: line.warehouseStockId as string, quantity: line.quantity,
          fefoOverride, overrideReason, requestId,
        });
      },
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
      title={isInitialProvisioning ? t('prov_initial', lang) : t('mv_doc_outlet_dispatch', lang)}
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
          <PaperReferenceFields lang={lang} value={paperRef} onChange={setPaperRef} />
        </div>
      )}

      {step === 'materials' && (
        <StockMaterialPicker
          lang={lang}
          candidates={stock}
          usedStockIds={lines.map(l => l.warehouseStockId).filter((v): v is string => Boolean(v))}
          loading={stockLoading || fefoCheckBusy}
          onAdd={(candidate, quantity) => void handlePick(candidate, quantity)}
        />
      )}

      <FefoOverrideDialog
        open={fefoPrompt !== null}
        picked={fefoPrompt?.candidate ?? null}
        alternatives={fefoPrompt?.alternatives ?? []}
        canOverride={canOverrideFefo}
        onCancel={() => setFefoPrompt(null)}
        onConfirmOverride={handleFefoConfirmOverride}
        onUseAlternative={handleFefoUseAlternative}
        lang={lang}
      />

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
