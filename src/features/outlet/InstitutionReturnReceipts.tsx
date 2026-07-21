/**
 * OUTLET-CORRIDOR-071 §B — the institution warehouse's INCOMING RETURN receipts.
 *
 * This is the receiving end of the outlet → institution-warehouse return hop. It
 * shows ONLY canonical return-shipment lines whose destination is this warehouse
 * (read RLS-scoped), and receives them through the single 071 receive RPC.
 *
 * A returned line is received into a DISPOSITION: `quarantined` (hold — the safe
 * default, and the only disposition the bulk action uses) or `restockable` (back
 * to sellable stock, a per-line human decision). The disposition is part of the
 * mutation, so the derived idempotency token distinguishes a restock from a hold
 * of the same line — two different intents can never be silently deduplicated.
 *
 * Deliberately absent, and must stay absent: no free-text material entry, no
 * OCR, no manual balance change. Stock moves only when the server RPC succeeds,
 * and every field shown is the immutable shipped snapshot.
 */
import { useMemo, useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';
import { PhoenixSelect } from '@/shared/ui/PhoenixSelect';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import {
  assessReceive, bulkEligibleLines, validateReceive, type ReceivableLine,
} from '@/features/movement/receive-model';
import {
  runStockMutation, runStockMutations, confirmedEntityIds,
  type TokenedWriter,
} from '@/shared/lib/stock-mutation-runner';
import {
  getOutletReturnShipments, getReturnShipmentLinesForShipments, receiveOutletReturnShipmentLine,
  type OutletReturnShipment, type OutletReturnShipmentLine,
} from './outlet-return.service';

type Lang = 'ar' | 'en';

const dash = (v: string | null | undefined) => (v == null || v === '' ? '—' : v);

/** Namespaces the derived idempotency token for this corridor. */
const RECEIVE_KIND = 'outlet_return_shipment_receive';

/** The two dispositions 071 accepts. Quarantine is the safe default. */
export type ReturnDisposition = 'quarantined' | 'restockable';

interface ReturnReceivePayload {
  shipmentLineId: string;
  receivedQuantity: number;
  differenceReason: string | null;
  dispositionDecision: ReturnDisposition;
}

/**
 * The single injected writer: the 071 receive RPC. The request id is DERIVED by
 * the shared runner from server-observed facts (never minted), so a retry of a
 * lost response cannot receive the same line twice, and a restock vs a hold of
 * one line derive DIFFERENT tokens because disposition is in the payload.
 */
const writeReturnReceive: TokenedWriter<ReturnReceivePayload> = (requestId, payload) =>
  receiveOutletReturnShipmentLine({ requestId, ...payload });

/** The shipped snapshot, in the shape the shared receive-model judges. */
const toReceivable = (l: OutletReturnShipmentLine): ReceivableLine => ({
  id: l.id,
  scientificName: l.scientificName,
  batchNumber: l.batchNumber,
  expiryDate: l.expiryDate,
  sentQuantity: l.sentQuantity,
  receivedQuantity: l.receivedQuantity,
  status: l.status,
  differenceReason: l.differenceReason,
});

/** A shipment not in transit (already received or rejected) presents no line. */
const SHIPMENT_NOT_RECEIVABLE = new Set(['received', 'received_with_difference', 'rejected']);

function receiveError(code: string | undefined, lang: Lang): string {
  const c = (code ?? '').toUpperCase();
  if (c.includes('FORBIDDEN') || c.includes('NOT_AUTHORIZED') || c === '42501') return t('net_err_not_authorized', lang);
  if (c.includes('CONFLICT') || c.includes('EXISTS') || c.includes('ALREADY')) return t('net_err_conflict', lang);
  if (c.endsWith('NOT_FOUND')) return t('net_err_not_found', lang);
  return t('net_err_invalid', lang);
}

interface Props {
  destinationWarehouseId: string;
  warehouseName: string;
  canReceive: boolean;
  lang: Lang;
}

type LineState = { state: 'succeeded' | 'failed'; error: string | null };

export function InstitutionReturnReceipts({ destinationWarehouseId, warehouseName, canReceive, lang }: Props) {
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey(k => k + 1);

  const shipments = useAsync(
    () => getOutletReturnShipments(destinationWarehouseId),
    [destinationWarehouseId, reloadKey],
  );

  const receivable = useMemo(
    () => (shipments.data ?? []).filter(s => !SHIPMENT_NOT_RECEIVABLE.has(s.status)),
    [shipments.data],
  );
  const shipmentIds = useMemo(() => receivable.map(s => s.id), [receivable]);
  const shipmentById = useMemo(
    () => new Map<string, OutletReturnShipment>(receivable.map(s => [s.id, s])),
    [receivable],
  );

  const lines = useAsync(
    () => getReturnShipmentLinesForShipments(shipmentIds),
    [shipmentIds.join(','), reloadKey],
  );

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [lineStates, setLineStates] = useState<Record<string, LineState>>({});
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [dispositions, setDispositions] = useState<Record<string, ReturnDisposition>>({});
  const [deselected, setDeselected] = useState<Record<string, boolean>>({});

  const allLines = useMemo(() => lines.data ?? [], [lines.data]);
  const pending = useMemo(
    () => allLines.filter(l => assessReceive(toReceivable(l)).individuallyReceivable),
    [allLines],
  );
  const bulkSet = useMemo(() => bulkEligibleLines(pending.map(toReceivable)), [pending]);

  /** Server truth about what has actually been received — drives token derivation. */
  const confirmed = useMemo(
    () => confirmedEntityIds(allLines, l => l.receivedQuantity !== null),
    [allLines],
  );

  const eligibleForBulk = useMemo(() => new Set(bulkSet.map(l => l.id)), [bulkSet]);
  const selectedBulkIds = useMemo(
    () => bulkSet.map(l => l.id).filter(id => !deselected[id]),
    [bulkSet, deselected],
  );

  const dispositionOf = (id: string): ReturnDisposition => dispositions[id] ?? 'quarantined';

  // ── receiving — the ONLY mutation on this surface ─────────────────────────

  const receiveIndividually = async (line: OutletReturnShipmentLine) => {
    if (busy || !canReceive || confirmed.has(line.id)) return;

    const typed = quantities[line.id] ?? String(line.sentQuantity);
    const quantity = Number(typed);
    const reason = (reasons[line.id] ?? '').trim() || null;

    const issues = validateReceive(toReceivable(line), quantity, reason);
    if (issues.length > 0) {
      setLineStates(s => ({ ...s, [line.id]: { state: 'failed', error: t(`mv_rc_${issues[0].code}`, lang) } }));
      return;
    }

    setBusy(true);
    const result = await runStockMutation(writeReturnReceive, RECEIVE_KIND, {
      entityId: line.id,
      generation: line.receivedQuantity ?? 0,
      payload: {
        shipmentLineId: line.id, receivedQuantity: quantity,
        differenceReason: reason, dispositionDecision: dispositionOf(line.id),
      },
    });
    setLineStates(s => ({
      ...s,
      [line.id]: result.ok
        ? { state: 'succeeded', error: null }
        : { state: 'failed', error: receiveError(result.error, lang) },
    }));
    // Canonical reload: custody moves only once the SERVER confirms.
    reload();
    setBusy(false);
  };

  /**
   * Receive every SAFE line at its full quantity, INTO QUARANTINE.
   *
   * Bulk never restocks: putting a returned pharmaceutical back into sellable
   * stock is a per-line human decision. Bulk only clears the safe lines into a
   * hold, from which restockable ones can then be received individually.
   */
  const receiveAllSafeToQuarantine = async () => {
    if (busy || !canReceive || selectedBulkIds.length === 0) return;
    setBusy(true);
    setProgress({ done: 0, total: selectedBulkIds.length });

    const outcome = await runStockMutations(writeReturnReceive, {
      kind: RECEIVE_KIND,
      items: selectedBulkIds.map(id => {
        const line = allLines.find(l => l.id === id)!;
        return {
          entityId: id,
          generation: line.receivedQuantity ?? 0,
          payload: {
            shipmentLineId: id, receivedQuantity: line.sentQuantity,
            differenceReason: null, dispositionDecision: 'quarantined' as const,
          },
        };
      }),
      eligibleIds: eligibleForBulk,
      confirmedIds: confirmed,
      onProgress: (done, total) => setProgress({ done, total }),
    });

    const states: Record<string, LineState> = {};
    for (const id of outcome.succeeded) states[id] = { state: 'succeeded', error: null };
    for (const f of outcome.failed) states[f.entityId] = { state: 'failed', error: receiveError(f.error, lang) };

    setLineStates(s => ({ ...s, ...states }));
    setProgress(null);
    reload();
    setBusy(false);
  };

  // ── render ────────────────────────────────────────────────────────────────

  const loading = shipments.loading || lines.loading;
  if (loading && allLines.length === 0) return <PhoenixLoadingState />;

  const failures = Object.entries(lineStates).filter(([, v]) => v.state === 'failed');
  const successes = Object.entries(lineStates).filter(([, v]) => v.state === 'succeeded');

  return (
    <div dir={dir} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div>
        <h3 style={{ fontSize: '16px', fontWeight: 700 }}>{t('mv_return_receipts_title', lang)}</h3>
        <p style={{ fontSize: '12.5px', color: 'var(--t2)', marginTop: '3px' }}>
          {t('mv_h_destination', lang)}: {warehouseName}
        </p>
      </div>

      {(failures.length > 0 || successes.length > 0) && (
        <div
          data-testid="return-receipt-outcome"
          style={{
            background: failures.length > 0 ? 'var(--err2)' : 'var(--ok2)',
            border: `1px solid ${failures.length > 0 ? 'var(--err)' : 'var(--ok)'}`,
            borderRadius: 'var(--r3)', padding: '12px 14px', fontSize: '12px',
            color: failures.length > 0 ? 'var(--err)' : 'var(--ok)',
          }}
        >
          <strong>{failures.length > 0 ? t('mv_partial_title', lang) : t('mv_line_succeeded', lang)}</strong>
          <div style={{ marginTop: '4px' }}>
            {t('mv_line_succeeded', lang)}: {successes.length} · {t('mv_line_failed', lang)}: {failures.length}
          </div>
          {failures.length > 0 && <div style={{ marginTop: '4px' }}>{t('mv_partial_hint', lang)}</div>}
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <PhoenixButton
          disabled={!canReceive || busy || selectedBulkIds.length === 0}
          onClick={() => void receiveAllSafeToQuarantine()}
          data-testid="return-receive-all-safe"
        >
          {t('mv_receive_to_quarantine', lang)} ({selectedBulkIds.length})
        </PhoenixButton>
        {progress && (
          <span data-testid="return-receive-progress" style={{ fontSize: '12px', color: 'var(--t2)' }}>
            {progress.done} / {progress.total}
          </span>
        )}
        <PhoenixButton variant="ghost" disabled={busy} onClick={reload}>{t('retry', lang)}</PhoenixButton>
      </div>

      {pending.length === 0 ? (
        <PhoenixEmptyState icon="package" title={t('mv_return_receipts_none', lang)} />
      ) : (
        <div style={{ display: 'grid', gap: '10px' }} data-testid="return-receipt-lines">
          {pending.map(line => {
            const parent = shipmentById.get(line.shipmentId);
            const eligibility = assessReceive(toReceivable(line));
            const state = lineStates[line.id];
            const typed = quantities[line.id] ?? String(line.sentQuantity);
            const reason = reasons[line.id] ?? '';
            const quantity = Number(typed);
            const issues = validateReceive(toReceivable(line), quantity, reason.trim() || null);

            return (
              <PhoenixCard key={line.id}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      {eligibleForBulk.has(line.id) && (
                        <input
                          type="checkbox"
                          data-testid={`return-select-${line.id}`}
                          aria-label={t('mv_receive_to_quarantine', lang)}
                          checked={!deselected[line.id]}
                          disabled={busy || !canReceive}
                          onChange={e => setDeselected(d => ({ ...d, [line.id]: !e.target.checked }))}
                        />
                      )}
                      <div style={{ fontSize: '13px', fontWeight: 700 }}>{line.scientificName}</div>
                    </div>

                    {/* Immutable shipped snapshot + provenance to the original dispatch. */}
                    <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '3px' }}>
                      {t('mv_f_batch_number', lang)}: {dash(line.batchNumber)} ·{' '}
                      {t('mv_f_expiry_date', lang)}: {dash(line.expiryDate)}
                    </div>
                    <div style={{ fontSize: '11.5px', color: 'var(--t2)' }}>
                      {t('mv_f_moved_quantity', lang)}: <strong>{line.sentQuantity}</strong> ·{' '}
                      {t('mv_h_source', lang)}: {dash(parent?.shipmentNumber)} ·{' '}
                      {t('mv_f_original_supply_reference', lang)}: <code>{line.originalDispatchLineId}</code>
                    </div>

                    {eligibility.exclusions.length > 0 && (
                      <div
                        data-testid={`return-exclusions-${line.id}`}
                        style={{ fontSize: '11.5px', color: 'var(--warn)', fontWeight: 700, marginTop: '4px' }}
                      >
                        {eligibility.exclusions.map(e => t(`mv_rx_${e}`, lang)).join(' · ')}
                      </div>
                    )}
                    {issues.length > 0 && (
                      <div style={{ fontSize: '11.5px', color: 'var(--err)', fontWeight: 700, marginTop: '3px' }}>
                        {issues.map(i => t(`mv_rc_${i.code}`, lang)).join(' · ')}
                      </div>
                    )}
                    {state?.error && (
                      <div style={{ fontSize: '11.5px', color: 'var(--err)', marginTop: '3px' }}>{state.error}</div>
                    )}
                  </div>

                  <div style={{ display: 'grid', gap: '6px', minWidth: '230px' }}>
                    <PhoenixInput
                      label={t('mv_f_received_quantity', lang)}
                      value={typed}
                      inputMode="numeric"
                      disabled={busy || !canReceive}
                      onChange={e => setQuantities(q => ({ ...q, [line.id]: e.target.value }))}
                    />
                    <PhoenixSelect
                      label={t('mv_f_disposition', lang)}
                      value={dispositionOf(line.id)}
                      disabled={busy || !canReceive}
                      onChange={e => setDispositions(d => ({ ...d, [line.id]: e.target.value as ReturnDisposition }))}
                      options={[
                        { value: 'quarantined', label: t('net_op_disp_quarantine', lang) },
                        { value: 'restockable', label: t('net_op_disp_restock', lang) },
                      ]}
                    />
                    {quantity !== line.sentQuantity && (
                      <PhoenixInput
                        label={t('mv_difference_reason', lang)}
                        value={reason}
                        disabled={busy || !canReceive}
                        onChange={e => setReasons(r => ({ ...r, [line.id]: e.target.value }))}
                      />
                    )}
                    <PhoenixButton
                      disabled={busy || !canReceive || issues.length > 0}
                      onClick={() => void receiveIndividually(line)}
                    >
                      {t('mv_receive_line', lang)}
                    </PhoenixButton>
                  </div>
                </div>
              </PhoenixCard>
            );
          })}
        </div>
      )}
    </div>
  );
}
