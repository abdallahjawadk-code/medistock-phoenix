/**
 * MOVEMENT-COMPOSER-A — Institution Incoming Supplies.
 *
 * THE DEFINING CONSTRAINT: this screen creates nothing. It displays only
 * server-loaded, already-dispatched transfer lines and receives them.
 *
 * There is deliberately NO StockMaterialPicker, no manual material entry, no
 * catalog reconstruction and no OCR anywhere in this file. The receiving
 * officer is checking physical goods against an immutable dispatch record; any
 * ability to invent or edit a material here would let the record be bent to fit
 * whatever arrived, which is precisely what a receipt exists to prevent.
 *
 * Stock appears only after the server confirms the receive RPC — never
 * optimistically. A line is re-read from the canonical server state after every
 * attempt, so what the operator sees is what the ledger holds.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import {
  getTransfers, getIncomingTransferLines, receiveTransferLine,
  type Transfer, type IncomingTransferLine,
} from '@/features/network/network.service';
import { assessReceive, bulkEligibleLines, validateReceive, type ReceivableLine } from './receive-model';
import { parseMovementQrPayload } from './movement-trace';
import { pairedPartyLabel } from './ui/MovementPartySelector';

const dash = (v: string | number | null | undefined) =>
  (v === null || v === undefined || v === '' ? '—' : String(v));

const newRequestId = () =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const toReceivable = (line: IncomingTransferLine): ReceivableLine => ({
  id: line.id,
  scientificName: line.scientificName,
  batchNumber: line.batchNumber,
  expiryDate: line.expiryDate,
  sentQuantity: line.sentQuantity,
  receivedQuantity: line.receivedQuantity,
  status: line.status,
  differenceReason: line.differenceReason,
});

interface Props {
  /** The institution warehouse receiving goods. Already scope-checked. */
  destinationWarehouseId: string;
  institutionName: string;
  warehouseName: string;
  canReceive: boolean;
}

export function InstitutionIncomingSupplies({
  destinationWarehouseId, institutionName, warehouseName, canReceive,
}: Props) {
  const { lang, dir } = useApp();

  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [lines, setLines] = useState<IncomingTransferLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [lineStates, setLineStates] = useState<Record<string, { state: 'succeeded' | 'failed'; error: string | null }>>({});
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [qrFilter, setQrFilter] = useState<string | null>(null);
  const [scanInput, setScanInput] = useState('');

  /** Canonical reload. Called on mount and after EVERY receive attempt. */
  const reload = useCallback(async () => {
    if (!destinationWarehouseId) { setTransfers([]); setLines([]); return; }
    setLoading(true);
    setError(null);
    try {
      const list = await getTransfers(destinationWarehouseId, true);
      setTransfers(list);
      // ONE batched query for every transfer's lines — never a per-transfer loop.
      const all = await getIncomingTransferLines(list.map(x => x.id));
      setLines(all);
    } catch {
      setError(t('err_generic', lang));
      setTransfers([]);
      setLines([]);
    } finally {
      setLoading(false);
    }
  }, [destinationWarehouseId, lang]);

  useEffect(() => { void reload(); }, [reload]);

  const transferById = useMemo(() => new Map(transfers.map(x => [x.id, x])), [transfers]);

  /**
   * QR only LOCATES a canonical transfer by opaque uuid. It carries no material
   * data and grants nothing — the lines still come from the RLS-scoped read.
   */
  const applyScan = (raw: string) => {
    const payload = parseMovementQrPayload(raw.trim());
    if (!payload) { setError(t('mv_tracking_no_results', lang)); return; }
    setError(null);
    setQrFilter(payload.id);
  };

  const visibleLines = useMemo(() => {
    if (!qrFilter) return lines;
    // Match either the transfer uuid or an individual line uuid.
    return lines.filter(l => l.transferId === qrFilter || l.id === qrFilter);
  }, [lines, qrFilter]);

  const pending = useMemo(
    () => visibleLines.filter(l => assessReceive(toReceivable(l)).individuallyReceivable),
    [visibleLines],
  );
  const bulkSet = useMemo(
    () => bulkEligibleLines(pending.map(toReceivable)),
    [pending],
  );

  // ── receiving ─────────────────────────────────────────────────────────────

  const receiveOne = async (line: IncomingTransferLine, quantity: number, reason: string | null) => {
    const result = await receiveTransferLine({
      // A fresh idempotency token per ATTEMPT of this line.
      requestId: newRequestId(),
      transferLineId: line.id,
      receivedQuantity: quantity,
      differenceReason: reason,
    });
    return result;
  };

  const receiveIndividually = async (line: IncomingTransferLine) => {
    if (busy || !canReceive) return;
    const typed = quantities[line.id] ?? String(line.sentQuantity);
    const quantity = Number(typed);
    const reason = (reasons[line.id] ?? '').trim() || null;

    const issues = validateReceive(toReceivable(line), quantity, reason);
    if (issues.length > 0) {
      setLineStates(s => ({ ...s, [line.id]: { state: 'failed', error: t(`mv_rc_${issues[0].code}`, lang) } }));
      return;
    }

    setBusy(true);
    const result = await receiveOne(line, quantity, reason);
    setLineStates(s => ({
      ...s,
      [line.id]: result.ok ? { state: 'succeeded', error: null } : { state: 'failed', error: result.error ?? null },
    }));
    // Canonical reload: stock exists only once the server says so.
    await reload();
    setBusy(false);
  };

  /**
   * Accept every SAFE eligible line. Deliberately conservative — anything
   * expired, flagged, already handled or quantity-adjusted is excluded and must
   * be received individually with a stated reason.
   */
  const acceptAllSafe = async () => {
    if (busy || !canReceive || bulkSet.length === 0) return;
    setBusy(true);
    setProgress({ done: 0, total: bulkSet.length });

    const states: Record<string, { state: 'succeeded' | 'failed'; error: string | null }> = {};
    let done = 0;
    for (const safe of bulkSet) {
      const line = lines.find(l => l.id === safe.id);
      if (!line) continue;
      const result = await receiveOne(line, line.sentQuantity, null);
      states[line.id] = result.ok
        ? { state: 'succeeded', error: null }
        : { state: 'failed', error: result.error ?? null };
      done += 1;
      setProgress({ done, total: bulkSet.length });
    }

    setLineStates(s => ({ ...s, ...states }));
    setProgress(null);
    await reload();
    setBusy(false);
  };

  // ── render ────────────────────────────────────────────────────────────────

  if (loading && lines.length === 0) return <PhoenixLoadingState />;

  const failures = Object.entries(lineStates).filter(([, v]) => v.state === 'failed');
  const successes = Object.entries(lineStates).filter(([, v]) => v.state === 'succeeded');

  return (
    <div dir={dir} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div>
        <h3 style={{ fontSize: '16px', fontWeight: 700 }}>{t('mv_incoming_title', lang)}</h3>
        <p style={{ fontSize: '12.5px', color: 'var(--t2)', marginTop: '3px' }}>
          {pairedPartyLabel(institutionName, warehouseName)}
        </p>
      </div>

      {/* QR locates a canonical transfer; it never supplies material data. */}
      <PhoenixCard>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <PhoenixInput
            label={t('mv_tracking_scan', lang)}
            value={scanInput}
            onChange={e => setScanInput(e.target.value)}
            style={{ minWidth: '260px' }}
          />
          <PhoenixButton variant="secondary" onClick={() => applyScan(scanInput)}>
            {t('mv_tracking_scan', lang)}
          </PhoenixButton>
          {qrFilter && (
            <PhoenixButton variant="ghost" onClick={() => { setQrFilter(null); setScanInput(''); }}>
              {t('mv_cancel', lang)}
            </PhoenixButton>
          )}
        </div>
      </PhoenixCard>

      {error && (
        <div style={{ background: 'var(--err2)', border: '1px solid var(--err)', borderRadius: 'var(--r3)', padding: '10px 14px', fontSize: '12px', color: 'var(--err)' }}>
          {error}
        </div>
      )}

      {(failures.length > 0 || successes.length > 0) && (
        <div
          data-testid="incoming-outcome"
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
          disabled={!canReceive || busy || bulkSet.length === 0}
          onClick={acceptAllSafe}
          data-testid="accept-all-safe"
        >
          {t('mv_accept_all_safe', lang)} ({bulkSet.length})
        </PhoenixButton>
        {progress && <span style={{ fontSize: '12px', color: 'var(--t2)' }}>{progress.done} / {progress.total}</span>}
        <PhoenixButton variant="ghost" disabled={busy} onClick={() => void reload()}>
          {t('retry', lang)}
        </PhoenixButton>
      </div>

      {pending.length === 0 ? (
        <PhoenixEmptyState icon="package" title={t('mv_incoming_none', lang)} />
      ) : (
        <div style={{ display: 'grid', gap: '10px' }} data-testid="incoming-lines">
          {pending.map(line => {
            const transfer = transferById.get(line.transferId);
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
                    <div style={{ fontSize: '13px', fontWeight: 700 }}>{line.scientificName}</div>

                    {/* Complete immutable product record — nothing reconstructed. */}
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
                    <div style={{ fontSize: '11.5px', color: 'var(--t2)' }}>
                      {t('mv_h_source', lang)}: {dash(transfer?.transferNumber)} ·{' '}
                      {t('mv_h_trace_key', lang)}: <code>{line.transferId}</code>
                    </div>

                    {eligibility.exclusions.length > 0 && (
                      <div style={{ fontSize: '11.5px', color: 'var(--warn)', fontWeight: 700, marginTop: '4px' }}>
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
