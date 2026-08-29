/**
 * MOVEMENT-COMPOSER-A — the unified Direct Supply composer.
 *
 * REPLACES: "create the header, reopen it, type a material name, save again".
 * That flow created a request row the moment the parties were chosen, so every
 * abandoned attempt left an orphaned header behind, and it used
 * scientific_name as the material identity.
 *
 * Here the whole request is composed locally and NOTHING is persisted until the
 * operator confirms on the review step. That is enforced structurally: the only
 * call sites for createDirectTransferRequest / addTransferRequestLine in this
 * file are inside confirmAndCreate, which runs only from the review step's
 * confirm handler.
 *
 * The backend needs header-then-lines, which is not one transaction. This
 * presents it as one deliberate action while reporting exactly what landed —
 * see movement-commit.ts for the partial-failure and retry protocol.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import {
  createDirectTransferRequest, addTransferRequestLine,
  getWarehouseStock, getTransferRequestLines,
  type NetworkWarehouse,
} from '@/features/network/network.service';
import {
  draftLineFromStock, validateDraft, draftIsConfirmable, revalidateAgainstFreshStock,
  type DraftLine, type StockCandidate,
} from './composer-model';
import { commitDraft, planRetry, type CommitResult, type CommitProgress } from './movement-commit';
import { MovementComposerShell, type ComposerStep } from './ui/MovementComposerShell';
import { MovementPartySelector, pairedPartyLabel, type PartyOption } from './ui/MovementPartySelector';
import { StockMaterialPicker } from './ui/StockMaterialPicker';
import { MovementLineTable } from './ui/MovementLineTable';

const newKey = () =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

interface Props {
  /** Scoped, already-authorized central source warehouses. */
  sourceWarehouses: readonly NetworkWarehouse[];
  /** Institution warehouses the operator may supply to. */
  destinationWarehouses: readonly PartyOption[];
  organizations: Array<{ id: string; name: string }>;
  onCancel: () => void;
  onCreated: (requestId: string) => void;
}

export function DirectSupplyComposer({
  sourceWarehouses, destinationWarehouses, organizations, onCancel, onCreated,
}: Props) {
  const { lang, dir } = useApp();

  const [step, setStep] = useState<ComposerStep>('parties');
  const [sourceWarehouseId, setSourceWarehouseId] = useState('');
  const [destinationOrgId, setDestinationOrgId] = useState('');
  const [destinationWarehouseId, setDestinationWarehouseId] = useState('');
  /**
   * Operator-typed value. NOT a controlled serial — no atomic allocator exists
   * (see docs/phoenix/proposals/sequential-document-numbers.md). It is labelled
   * as an external reference and the request's uuid remains the trace key.
   */
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

  const loadStock = useCallback(async (warehouseId: string) => {
    if (!warehouseId) { setStock([]); return; }
    setStockLoading(true);
    try {
      const batches = await getWarehouseStock(warehouseId);
      setStock(batches.map(b => ({
        warehouseStockId: b.id,
        // MATERIAL IDENTITY — carried from the authoritative stock row, never
        // nulled and never defaulted. The send RPC matches a request line to
        // stock on central_item_id + scientific_name + concentration +
        // dosage_form + unit; a line composed without them matches nothing and
        // is refused with direct_request_line_material_mismatch, which made
        // every composed request unsendable against identity-bearing stock.
        centralItemId: b.centralItemId,
        scientificName: b.scientificName,
        tradeName: null,
        concentration: b.concentration,
        dosageForm: b.dosageForm,
        unit: b.unit,
        nationalCode: b.nationalCode,
        batchNumber: b.batchNumber,
        internalBatchReference: null,
        expiryDate: b.expiryDate,
        onHandQuantity: b.onHandQuantity,
        reservedQuantity: b.reservedQuantity,
        availableQuantity: b.availableQuantity,
      })));
    } catch {
      setStock([]);
    } finally {
      setStockLoading(false);
    }
  }, []);

  useEffect(() => { void loadStock(sourceWarehouseId); }, [sourceWarehouseId, loadStock]);

  const issues = useMemo(() => validateDraft(lines, 'supply'), [lines]);
  const confirmable = useMemo(() => draftIsConfirmable(lines, 'supply'), [lines]);
  /**
   * The official-letter number is REQUIRED, not optional.
   *
   * phoenix_create_direct_warehouse_transfer_request (migration 077) takes the
   * number ONLY from p_request_number and raises request_number_required on an
   * empty or whitespace-only value. MediStock generates the trace identity, not
   * this number, so there is nothing to fall back to. Trimmed here so that a
   * whitespace-only entry is refused locally rather than becoming a raw 400.
   * draftIsConfirmable deliberately stays line-only; this is a header field.
   */
  const referenceMissing = externalReference.trim() === '';

  const partiesComplete = Boolean(sourceWarehouseId && destinationOrgId && destinationWarehouseId);
  const sourceWarehouse = sourceWarehouses.find(w => w.id === sourceWarehouseId) ?? null;
  const destination = destinationWarehouses.find(w => w.id === destinationWarehouseId) ?? null;

  // ── review: re-fetch and revalidate before anything is created ────────────

  const enterReview = async () => {
    setStep('review');
    setStaleKeys([]);
    if (!sourceWarehouseId) return;
    const batches = await getWarehouseStock(sourceWarehouseId).catch(() => null);
    if (!batches) return;
    // Same MATERIAL IDENTITY contract as loadStock, and load-bearing for the
    // same reason: this re-fetch calls setStock(fresh), and the shell allows
    // stepping BACK to the materials step, where draftLineFromStock composes new
    // lines out of exactly these candidates. Dropping the identity here would
    // therefore reintroduce the defect for any line added after visiting review.
    // (revalidateAgainstFreshStock itself only adjusts maxQuantity — it never
    // rewrites a line's identity — so it is not the mechanism at risk.)
    const fresh: StockCandidate[] = batches.map(b => ({
      warehouseStockId: b.id, centralItemId: b.centralItemId, scientificName: b.scientificName,
      tradeName: null, concentration: b.concentration, dosageForm: b.dosageForm, unit: b.unit,
      nationalCode: b.nationalCode, batchNumber: b.batchNumber, internalBatchReference: null,
      expiryDate: b.expiryDate, onHandQuantity: b.onHandQuantity,
      reservedQuantity: b.reservedQuantity, availableQuantity: b.availableQuantity,
    }));
    setStock(fresh);
    const revalidated = revalidateAgainstFreshStock(lines, fresh);
    setLines(revalidated.lines);
    setStaleKeys(revalidated.changed);
  };

  // ── the ONLY place this file persists anything ────────────────────────────

  const confirmAndCreate = async () => {
    if (!confirmable || referenceMissing || committing) return;
    setCommitting(true);
    setError(null);

    const outcome = await commitDraft(lines, {
      createHeader: () => createDirectTransferRequest({
        sourceWarehouseId,
        destinationOrganizationId: destinationOrgId,
        destinationWarehouseId,
        requestNumber: externalReference.trim(),
        notes: notes.trim() || null,
      }),
      addLine: (requestId, line) => addTransferRequestLine({
        transferRequestId: requestId,
        // Identity travels as the catalog id where one exists; the name is
        // carried because the RPC requires it, not as the identity.
        scientificName: line.scientificName,
        requestedQuantity: line.quantity,
        centralItemId: line.centralItemId,
        concentration: line.concentration,
        dosageForm: line.dosageForm,
        unit: line.unit,
        notes: line.notes,
      }),
      onProgress: setProgress,
    });

    setResult(outcome);
    setCommitting(false);
    setProgress(null);
    if (outcome.complete && outcome.requestId) onCreated(outcome.requestId);
  };

  /**
   * Retry after a partial failure.
   *
   * NEVER re-runs the whole sequence: the header already exists, and
   * phoenix_add_warehouse_transfer_request_line is not idempotent. The canonical
   * server lines are reloaded first and only genuinely-absent lines are re-sent.
   */
  const retryUnsent = async () => {
    if (!result?.requestId || committing) return;
    setCommitting(true);
    setError(null);

    const serverLines = await getTransferRequestLines(result.requestId).catch(() => null);
    if (!serverLines) {
      setError(t('err_generic', lang));
      setCommitting(false);
      return;
    }

    const plan = planRetry(lines, serverLines.map(l => ({
      id: l.id,
      scientificName: l.scientificName,
      batchNumber: null,
      expiryDate: null,
      originalTransferLineId: null,
      requestedQuantity: l.requestedQuantity,
    })), 'supply');

    const retried = await commitDraft(plan.toSend, {
      // The header exists — creating another would duplicate the request.
      createHeader: () => Promise.resolve({ ok: true, data: { id: result.requestId as string } }),
      addLine: (requestId, line) => addTransferRequestLine({
        transferRequestId: requestId,
        scientificName: line.scientificName,
        requestedQuantity: line.quantity,
        centralItemId: line.centralItemId,
        concentration: line.concentration,
        dosageForm: line.dosageForm,
        unit: line.unit,
        notes: line.notes,
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

  // ── render ────────────────────────────────────────────────────────────────

  const footer = step === 'review' && !result
    ? (
      <PhoenixButton
        disabled={!confirmable || referenceMissing || committing}
        onClick={confirmAndCreate}
        data-testid="confirm-create-supply-request"
      >
        {t('mv_create_supply_request', lang)}
      </PhoenixButton>
    )
    : null;

  return (
    <MovementComposerShell
      lang={lang}
      dir={dir}
      title={t('mv_doc_supply_request', lang)}
      step={step}
      onStep={next => { if (next === 'review') void enterReview(); else setStep(next); }}
      canAdvance={step === 'parties' ? partiesComplete : lines.length > 0}
      nothingPersistedYet={!result && !committing}
      onCancel={onCancel}
      footer={footer}
    >
      {step === 'parties' && (
        <div style={{ display: 'grid', gap: '14px' }}>
          <MovementPartySelector
            lang={lang}
            label={t('inv_warehouse', lang)}
            organizations={[{ id: '__central', name: t('nav_network', lang) }]}
            warehouses={sourceWarehouses.map(w => ({
              id: w.id, organizationId: '__central',
              organizationName: t('nav_network', lang),
              warehouseName: lang === 'ar' ? (w.name_ar || w.name) : (w.name || w.name_ar),
            }))}
            selectedOrganizationId="__central"
            selectedWarehouseId={sourceWarehouseId}
            onSelectOrganization={() => { /* central source is fixed */ }}
            onSelectWarehouse={setSourceWarehouseId}
          />

          <MovementPartySelector
            lang={lang}
            label={t('nav_institutions', lang)}
            organizations={organizations}
            warehouses={destinationWarehouses}
            selectedOrganizationId={destinationOrgId}
            selectedWarehouseId={destinationWarehouseId}
            onSelectOrganization={setDestinationOrgId}
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
        <StockMaterialPicker
          lang={lang}
          candidates={stock}
          usedStockIds={lines.map(l => l.warehouseStockId).filter((v): v is string => Boolean(v))}
          loading={stockLoading}
          onAdd={(candidate, quantity) =>
            setLines(previous => [...previous, draftLineFromStock(candidate, quantity, newKey())])}
        />
      )}

      {step === 'review' && (
        <div style={{ display: 'grid', gap: '12px' }}>
          <PhoenixCard>
            <div style={{ fontSize: '12.5px', display: 'grid', gap: '4px' }}>
              <div><strong>{t('mv_h_source', lang)}:</strong>{' '}
                {pairedPartyLabel(t('nav_network', lang), sourceWarehouse
                  ? (lang === 'ar' ? (sourceWarehouse.name_ar || sourceWarehouse.name) : sourceWarehouse.name)
                  : null)}
              </div>
              <div><strong>{t('mv_h_destination', lang)}:</strong>{' '}
                {pairedPartyLabel(destination?.organizationName ?? null, destination?.warehouseName ?? null)}
              </div>
              <div><strong>{t('mv_external_reference', lang)}:</strong> {externalReference.trim() || '—'}</div>
              <div><strong>{t('inv_notes', lang)}:</strong> {notes.trim() || '—'}</div>
            </div>
          </PhoenixCard>

          {referenceMissing && (
            <div
              data-testid="supply-external-reference-required"
              style={{ background: 'var(--warn2)', border: '1px solid var(--warn)', borderRadius: 'var(--r3)', padding: '10px 14px', fontSize: '12px', color: 'var(--warn)' }}
            >
              {t('mv_external_reference_required', lang)}
            </div>
          )}

          {staleKeys.length > 0 && (
            <div style={{
              background: 'var(--warn2)', border: '1px solid var(--warn)',
              borderRadius: 'var(--r3)', padding: '10px 14px', fontSize: '12px', color: 'var(--warn)',
            }}>
              {t('mv_e_quantity_exceeds_available', lang)} — {staleKeys.length}
            </div>
          )}

          {result?.partial && (
            <div
              data-testid="supply-partial-failure"
              style={{
                background: 'var(--err2)', border: '1px solid var(--err)',
                borderRadius: 'var(--r3)', padding: '12px 14px', fontSize: '12px', color: 'var(--err)',
              }}
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
            <div style={{ fontSize: '12px', color: 'var(--t2)' }}>
              {progress.completed} / {progress.total}
            </div>
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
