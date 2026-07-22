/**
 * INSTITUTION-LOCAL-PROCUREMENT-087 — receiving (partial or full).
 *
 * Lists approved / partially-received orders and posts what physically
 * arrived. The ONE write here is phoenix_procurement_receive_order:
 *   - a caller-held requestId makes a retry after a network failure replay
 *     the SAME posting instead of double-entering stock;
 *   - the order generation read with the rows makes a cross-device race
 *     surface as a stale-view conflict (40001) instead of over-posting;
 *   - the server caps every line at its ordered quantity regardless of what
 *     this UI displays.
 * Nothing here touches warehouse_stock directly.
 */
import { useState } from 'react';
import { t } from '@/shared/i18n/strings';
import type { Lang } from '@/shared/lib/types';
import { useAsync } from '@/shared/lib/useAsync';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import {
  getOrderLines, getOrders, newRequestId, receiveOrder,
  type OrderLineRow, type OrderRow, type ReceiveLineInput,
} from './procurement.service';
import { dash, procurementErrorKey } from './procurement-ui';
import { StatusBadge } from './OrderComposerPanel';

interface Props {
  warehouseId: string;
  lang: Lang;
}

export function ReceivingPanel({ warehouseId, lang }: Props) {
  const orders = useAsync(
    () => getOrders(warehouseId, ['approved', 'partially_received']),
    [warehouseId],
  );

  if (orders.loading && !orders.data) return <PhoenixLoadingState />;
  if (orders.error) return <PhoenixErrorState message={orders.error} onRetry={orders.reload} />;
  const rows = orders.data ?? [];
  if (rows.length === 0) return <PhoenixEmptyState icon="package" title={t('lp_receiving_none', lang)} />;

  return (
    <div style={{ display: 'grid', gap: '10px' }} data-testid="lp-receiving">
      {rows.map(o => (
        <ReceiveCard key={o.id} order={o} lang={lang} onPosted={() => orders.reload()} />
      ))}
    </div>
  );
}

interface LineEntry {
  quantity: string;
  batchNumber: string;
  noBatch: boolean;
  expiryDate: string;
  unitPrice: string;
}

function entryFor(line: OrderLineRow): LineEntry {
  return {
    quantity: '',
    batchNumber: line.batchNumber ?? '',
    noBatch: line.batchNumber === null,
    expiryDate: line.expiryDate ?? '',
    unitPrice: line.unitPrice === null ? '' : String(line.unitPrice),
  };
}

function ReceiveCard({ order, lang, onPosted }: { order: OrderRow; lang: Lang; onPosted: () => void }) {
  const lines = useAsync(() => getOrderLines(order.id), [order.id]);
  const [entries, setEntries] = useState<Record<string, LineEntry>>({});
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  // Held for the LIFETIME of one posting attempt so a user-initiated retry
  // after a timeout replays the same idempotency key. Re-minted only after a
  // confirmed success or when the payload is edited.
  const [requestId, setRequestId] = useState(() => newRequestId());

  const entry = (line: OrderLineRow): LineEntry => entries[line.id] ?? entryFor(line);
  const setEntry = (lineId: string, patch: Partial<LineEntry>, line: OrderLineRow) => {
    setEntries(prev => ({ ...prev, [lineId]: { ...(prev[lineId] ?? entryFor(line)), ...patch } }));
    // Editing the payload makes this a NEW semantic request.
    setRequestId(newRequestId());
    setErrorKey(null);
  };

  const post = async () => {
    const rows = lines.data ?? [];
    const payload: ReceiveLineInput[] = [];
    for (const l of rows) {
      const e = entry(l);
      const qty = Number.parseInt(e.quantity, 10);
      if (!Number.isFinite(qty) || qty <= 0) continue;
      payload.push({
        orderLineId: l.id,
        quantity: qty,
        batchNumber: e.noBatch ? null : (e.batchNumber.trim() || null),
        hasNoBatchNumber: e.noBatch || e.batchNumber.trim() === '',
        expiryDate: e.expiryDate || null,
        unitPrice: e.unitPrice.trim() === '' ? null : Number(e.unitPrice),
      });
    }
    if (payload.length === 0) {
      setErrorKey('lp_err_nothing_to_receive');
      return;
    }
    setBusy(true);
    setErrorKey(null);
    const result = await receiveOrder(requestId, order.id, payload, order.orderGeneration);
    setBusy(false);
    if (!result.ok) {
      setErrorKey(procurementErrorKey(result.error));
      return;
    }
    setSuccess(result.data?.receipt_number ?? null);
    setEntries({});
    setRequestId(newRequestId());
    onPosted();
  };

  const rows = lines.data ?? [];

  return (
    <PhoenixCard>
      <div style={{ fontSize: '13px', fontWeight: 700, display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        {order.orderNumber} <StatusBadge status={order.status} lang={lang} />
      </div>
      <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '3px' }}>
        {t('lp_invoice', lang)}: {dash(order.invoiceNumber)}
      </div>

      {success && (
        <div data-testid="lp-receipt-posted" style={{ background: 'var(--ok2)', border: '1px solid var(--ok)', borderRadius: 'var(--r3)', padding: '8px 12px', fontSize: '12px', color: 'var(--ok)', margin: '10px 0' }}>
          {t('lp_receipt_posted', lang)} · <code>{success}</code> — {t('lp_receipt_posted_hint', lang)}
        </div>
      )}

      {lines.loading && !lines.data ? <PhoenixLoadingState /> : (
        <div style={{ display: 'grid', gap: '12px', marginTop: '10px' }}>
          {rows.map(l => {
            const remaining = l.orderedQuantity - l.receivedQuantity;
            const e = entry(l);
            return (
              <div key={l.id} style={{ borderTop: '1px solid var(--brd)', paddingTop: '10px' }}>
                <div style={{ fontSize: '12.5px', fontWeight: 700 }}>
                  {l.scientificName}
                  <span style={{ fontWeight: 400, color: 'var(--t2)' }}>
                    {' '}· {dash(l.concentration)} · {dash(l.dosageForm)}
                  </span>
                </div>
                <div style={{ fontSize: '11.5px', color: 'var(--t2)', margin: '2px 0 8px' }}>
                  {t('lp_ordered', lang)}: {l.orderedQuantity} · {t('lp_received_so_far', lang)}: {l.receivedQuantity} ·{' '}
                  <strong style={{ color: remaining > 0 ? 'var(--pd)' : 'var(--ok)' }}>{t('lp_remaining', lang)}: {remaining}</strong>
                </div>
                {remaining > 0 && (
                  <div style={{ display: 'grid', gap: '8px', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
                    <PhoenixInput
                      label={t('lp_receive_qty', lang)} type="number" min={0} max={remaining}
                      value={e.quantity}
                      onChange={ev => setEntry(l.id, { quantity: ev.target.value }, l)}
                    />
                    <PhoenixInput
                      label={t('mv_f_batch_number', lang)}
                      value={e.batchNumber}
                      disabled={e.noBatch}
                      onChange={ev => setEntry(l.id, { batchNumber: ev.target.value }, l)}
                    />
                    <PhoenixInput
                      label={t('mv_f_expiry_date', lang)} type="date"
                      value={e.expiryDate}
                      onChange={ev => setEntry(l.id, { expiryDate: ev.target.value }, l)}
                    />
                    <PhoenixInput
                      label={t('lp_unit_price', lang)} type="number" min={0}
                      value={e.unitPrice}
                      onChange={ev => setEntry(l.id, { unitPrice: ev.target.value }, l)}
                    />
                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--t2)' }}>
                      <input
                        type="checkbox"
                        checked={e.noBatch}
                        onChange={ev => setEntry(l.id, { noBatch: ev.target.checked, batchNumber: ev.target.checked ? '' : e.batchNumber }, l)}
                      />
                      {t('lp_no_batch', lang)}
                    </label>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {errorKey && (
        <div role="alert" style={{ fontSize: '12px', color: 'var(--err)', marginTop: '10px' }}>
          {t(errorKey, lang)}
          {errorKey === 'lp_err_stale' && (
            <PhoenixButton variant="ghost" size="sm" onClick={onPosted} style={{ marginInlineStart: '8px' }}>
              {t('lp_reload', lang)}
            </PhoenixButton>
          )}
        </div>
      )}

      <div style={{ marginTop: '12px' }}>
        <PhoenixButton disabled={busy || rows.length === 0} onClick={post}>
          {busy ? t('lp_posting', lang) : t('lp_post_receipt', lang)}
        </PhoenixButton>
      </div>
    </PhoenixCard>
  );
}
