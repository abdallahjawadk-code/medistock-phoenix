/**
 * OUTLET-CORRIDOR-070 §2A — the OUTLET's incoming supplies surface.
 *
 * This is the receiving end of the institution-warehouse → outlet hop. It shows
 * ONLY canonical lines that the outlet's parent institution warehouse actually
 * dispatched through migration 070, read RLS-scoped by destination outlet, and
 * it receives them through the single 070 receive RPC.
 *
 * Deliberately absent, and they must stay absent:
 *   - no free-text material entry, no catalog/material picker, no OCR intake —
 *     every field shown is the immutable dispatched snapshot from the server;
 *   - no direct balance editing — the outlet's stock rises only when
 *     phoenix_receive_outlet_dispatch_line succeeds on the server;
 *   - no cross-scope reach — the read is keyed to this outlet, and the RPC
 *     re-checks outlet scope server-side regardless of what this UI renders.
 *
 * The eligibility rules are NOT re-implemented here: they are the same shared
 * receive-model the institution corridor uses, so "safe to bulk-accept" means
 * exactly one thing across the whole app.
 */
import { useMemo, useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';
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
  getOutletDispatches, getDispatchLinesForDispatches, receiveOutletDispatchLine,
  type WarehouseDispatch, type WarehouseDispatchLine,
} from './dispatch.service';
import { getPaperReferencesFor } from '@/features/movement/paper-reference.service';
import { paperReferenceSummary } from '@/features/movement/ui/PaperReferenceFields';

type Lang = 'ar' | 'en';

const dash = (v: string | null | undefined) => (v == null || v === '' ? '—' : v);

/** Namespaces the derived idempotency token for this corridor. */
const RECEIVE_KIND = 'outlet_dispatch_receive';

interface ReceivePayload {
  dispatchLineId: string;
  receivedQuantity: number;
  differenceReason: string | null;
}

/**
 * The single injected writer: the 070 receive RPC.
 *
 * The request id is DERIVED by the shared runner from server-observed facts,
 * never minted here — so it is identical after a remount or page reload, and a
 * retry of a lost response cannot post stock a second time.
 */
const writeReceive: TokenedWriter<ReceivePayload> = (requestId, payload) =>
  receiveOutletDispatchLine({ requestId, ...payload });

/** The dispatched snapshot, in the shape the shared receive-model judges. */
const toReceivable = (l: WarehouseDispatchLine): ReceivableLine => ({
  id: l.id,
  scientificName: l.scientificName,
  batchNumber: l.batchNumber,
  expiryDate: l.expiryDate,
  sentQuantity: l.sentQuantity,
  receivedQuantity: l.receivedQuantity,
  status: l.status,
  differenceReason: l.differenceReason,
});

/**
 * A draft dispatch has not left the warehouse and a cancelled one never will,
 * so neither can present a line for receipt. Everything else is decided
 * per-line by the shared model.
 */
const DISPATCH_NOT_RECEIVABLE = new Set(['draft', 'cancelled']);

function receiveError(code: string | undefined, lang: Lang): string {
  const c = (code ?? '').toUpperCase();
  if (c.includes('FORBIDDEN') || c.includes('NOT_AUTHORIZED') || c === '42501') return t('net_err_not_authorized', lang);
  if (c.includes('CONFLICT') || c.includes('EXISTS')) return t('net_err_conflict', lang);
  if (c.endsWith('NOT_FOUND')) return t('net_err_not_found', lang);
  return t('net_err_invalid', lang);
}

interface Props {
  distributionPointId: string;
  outletName: string;
  canReceive: boolean;
  lang: Lang;
}

type LineState = { state: 'succeeded' | 'failed'; error: string | null };

export function OutletIncomingSupplies({ distributionPointId, outletName, canReceive, lang }: Props) {
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey(k => k + 1);

  const dispatches = useAsync(() => getOutletDispatches(distributionPointId), [distributionPointId, reloadKey]);

  const receivable = useMemo(
    () => (dispatches.data ?? []).filter(d => !DISPATCH_NOT_RECEIVABLE.has(d.status)),
    [dispatches.data],
  );
  const dispatchIds = useMemo(() => receivable.map(d => d.id), [receivable]);
  const dispatchById = useMemo(
    () => new Map<string, WarehouseDispatch>(receivable.map(d => [d.id, d])),
    [receivable],
  );

  const lines = useAsync(
    () => getDispatchLinesForDispatches(dispatchIds),
    [dispatchIds.join(','), reloadKey],
  );

  // PAPER-REFERENCE-CONTRACT-110: one batched read for every visible dispatch,
  // never a per-line lookup — this screen can list many lines across few
  // parent dispatches.
  const paperRefs = useAsync(
    () => getPaperReferencesFor('warehouse_dispatch', dispatchIds),
    [dispatchIds.join(','), reloadKey],
  );

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [lineStates, setLineStates] = useState<Record<string, LineState>>({});
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [deselected, setDeselected] = useState<Record<string, boolean>>({});

  const allLines = useMemo(() => lines.data ?? [], [lines.data]);
  const pending = useMemo(
    () => allLines.filter(l => assessReceive(toReceivable(l)).individuallyReceivable),
    [allLines],
  );
  const bulkSet = useMemo(() => bulkEligibleLines(pending.map(toReceivable)), [pending]);

  /**
   * Server truth about what has actually been received. This is also what
   * drives token derivation, so it must come from a canonical read — never
   * from local optimism, or the token stops being stable across a reload.
   */
  const confirmed = useMemo(
    () => confirmedEntityIds(allLines, l => l.receivedQuantity !== null),
    [allLines],
  );

  /** Bulk acts on eligible lines the operator has not explicitly unticked. */
  const eligibleForBulk = useMemo(() => new Set(bulkSet.map(l => l.id)), [bulkSet]);
  const selectedBulkIds = useMemo(
    () => bulkSet.map(l => l.id).filter(id => !deselected[id]),
    [bulkSet, deselected],
  );

  // ── receiving — the ONLY mutation on this surface ─────────────────────────

  const receiveIndividually = async (line: WarehouseDispatchLine) => {
    if (busy || !canReceive) return;
    // Already proven received — retrying would be a second operation.
    if (confirmed.has(line.id)) return;

    const typed = quantities[line.id] ?? String(line.sentQuantity);
    const quantity = Number(typed);
    const reason = (reasons[line.id] ?? '').trim() || null;

    const issues = validateReceive(toReceivable(line), quantity, reason);
    if (issues.length > 0) {
      setLineStates(s => ({ ...s, [line.id]: { state: 'failed', error: t(`mv_rc_${issues[0].code}`, lang) } }));
      return;
    }

    setBusy(true);
    const result = await runStockMutation(writeReceive, RECEIVE_KIND, {
      entityId: line.id,
      // Server-derived, so a reload re-derives the same token.
      generation: line.receivedQuantity ?? 0,
      payload: { dispatchLineId: line.id, receivedQuantity: quantity, differenceReason: reason },
    });
    setLineStates(s => ({
      ...s,
      [line.id]: result.ok
        ? { state: 'succeeded', error: null }
        : { state: 'failed', error: receiveError(result.error, lang) },
    }));
    // Canonical reload: the outlet holds stock only once the SERVER says so.
    reload();
    setBusy(false);
  };

  /**
   * Accept every SAFE line at its full dispatched quantity.
   *
   * Conservative on purpose. Anything expired, already handled, already flagged,
   * quantity-adjusted or in an unexpected state is excluded by the shared model
   * and has to be received individually with a stated reason — bulk acceptance
   * must never become a way to wave through the lines that need a human.
   */
  const acceptAllSafe = async () => {
    if (busy || !canReceive || selectedBulkIds.length === 0) return;
    setBusy(true);
    setProgress({ done: 0, total: selectedBulkIds.length });

    const outcome = await runStockMutations(writeReceive, {
      kind: RECEIVE_KIND,
      // Only lines the operator actually chose, intersected with what the
      // shared model judged safe, minus anything the server already confirmed.
      items: selectedBulkIds.map(id => {
        const line = allLines.find(l => l.id === id)!;
        return {
          entityId: id,
          generation: line.receivedQuantity ?? 0,
          payload: {
            dispatchLineId: id, receivedQuantity: line.sentQuantity, differenceReason: null,
          },
        };
      }),
      eligibleIds: eligibleForBulk,
      confirmedIds: confirmed,
      // Truthful progress: attempts RESOLVED, successes and failures alike.
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

  const loading = dispatches.loading || lines.loading;
  if (loading && allLines.length === 0) return <PhoenixLoadingState />;

  const failures = Object.entries(lineStates).filter(([, v]) => v.state === 'failed');
  const successes = Object.entries(lineStates).filter(([, v]) => v.state === 'succeeded');

  return (
    <div dir={dir} className="nexus-io-content" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div>
        <h3 style={{ fontSize: '16px', fontWeight: 700 }}>{t('mv_incoming_title', lang)}</h3>
        <p style={{ fontSize: '12.5px', color: 'var(--t2)', marginTop: '3px' }}>
          {t('mv_outlet', lang)}: {outletName}
        </p>
      </div>

      {(failures.length > 0 || successes.length > 0) && (
        <div
          data-testid="outlet-incoming-outcome"
          className={`nexus-io-notice ${failures.length > 0 ? 'nexus-io-notice--error' : 'nexus-io-notice--ok'}`}
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

      <div className="nexus-io-toolbar" style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <PhoenixButton
          disabled={!canReceive || busy || selectedBulkIds.length === 0}
          onClick={() => void acceptAllSafe()}
          data-testid="outlet-accept-all-safe"
        >
          {t('mv_accept_all_safe', lang)} ({selectedBulkIds.length})
        </PhoenixButton>
        {progress && (
          <span data-testid="outlet-receive-progress" style={{ fontSize: '12px', color: 'var(--t2)' }}>
            {progress.done} / {progress.total}
          </span>
        )}
        <PhoenixButton variant="ghost" disabled={busy} onClick={reload}>{t('retry', lang)}</PhoenixButton>
      </div>

      {pending.length === 0 ? (
        <PhoenixEmptyState icon="package" title={t('mv_incoming_none', lang)} />
      ) : (
        <div className="nexus-io-row-list" style={{ display: 'grid', gap: '10px' }} data-testid="outlet-incoming-lines">
          {pending.map(line => {
            const parent = dispatchById.get(line.dispatchId);
            const eligibility = assessReceive(toReceivable(line));
            const state = lineStates[line.id];
            const typed = quantities[line.id] ?? String(line.sentQuantity);
            const reason = reasons[line.id] ?? '';
            const quantity = Number(typed);
            const issues = validateReceive(toReceivable(line), quantity, reason.trim() || null);

            return (
              <PhoenixCard key={line.id} className="nexus-io-row-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      {/* Bulk acts only on eligible lines still ticked here. */}
                      {eligibleForBulk.has(line.id) && (
                        <input
                          type="checkbox"
                          data-testid={`outlet-select-${line.id}`}
                          aria-label={t('mv_accept_all_safe', lang)}
                          checked={!deselected[line.id]}
                          disabled={busy || !canReceive}
                          onChange={e => setDeselected(d => ({ ...d, [line.id]: !e.target.checked }))}
                        />
                      )}
                      <div style={{ fontSize: '13px', fontWeight: 700 }}>{line.scientificName}</div>
                    </div>

                    {/* The complete immutable dispatched snapshot — nothing reconstructed. */}
                    <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '3px' }}>
                      {dash(line.tradeName)} · {dash(line.concentration)} · {dash(line.dosageForm)} · {dash(line.unit)}
                    </div>
                    <div style={{ fontSize: '11.5px', color: 'var(--t2)' }}>
                      {t('mv_f_national_code', lang)}: {dash(line.nationalCode)} ·{' '}
                      {t('mv_f_batch_number', lang)}: {dash(line.batchNumber)} ·{' '}
                      {t('mv_f_internal_batch_reference', lang)}: {dash(line.internalBatchReference)} ·{' '}
                      {t('mv_f_expiry_date', lang)}: {dash(line.expiryDate)}
                    </div>
                    <div style={{ fontSize: '11.5px', color: 'var(--t2)' }}>
                      {t('mv_f_moved_quantity', lang)}: <strong>{line.sentQuantity}</strong> ·{' '}
                      {t('mv_f_supply_type', lang)}: {dash(line.supplyTypeText)}
                    </div>
                    {/* Source and destination, both server-derived. */}
                    <div style={{ fontSize: '11.5px', color: 'var(--t2)' }}>
                      {t('mv_h_source', lang)}: {dash(parent?.dispatchNumber)} ·{' '}
                      {t('mv_h_destination', lang)}: {outletName} ·{' '}
                      {t('mv_h_trace_key', lang)}: <code>{line.dispatchId}</code>
                    </div>
                    <div style={{ fontSize: '11.5px', color: 'var(--t2)' }}>
                      {t('mv_h_paper_reference_number', lang)}: {paperReferenceSummary(paperRefs.data?.get(line.dispatchId))}
                    </div>

                    {eligibility.exclusions.length > 0 && (
                      <div
                        data-testid={`outlet-exclusions-${line.id}`}
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

                  <div style={{ display: 'grid', gap: '6px', minWidth: '220px' }}>
                    <PhoenixInput
                      label={t('mv_f_received_quantity', lang)}
                      value={typed}
                      inputMode="numeric"
                      disabled={busy || !canReceive}
                      onChange={e => setQuantities(q => ({ ...q, [line.id]: e.target.value }))}
                    />
                    {/* A quantity that differs from what was dispatched must be explained. */}
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
