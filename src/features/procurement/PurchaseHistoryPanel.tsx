/**
 * INSTITUTION-LOCAL-PROCUREMENT-087 — purchase history, receipts and returns.
 *
 * Read-only over RLS-scoped canonical rows, plus two authorized actions:
 *   - official receipt documents (print · genuine XLSX · QR traceability) via
 *     the shared MovementDocumentActions, built ONLY from reloaded server rows;
 *   - a provenance-pinned supplier return per receipt line (capped server-side
 *     at the received quantity, reason-mandatory, idempotent).
 */
import { useState } from 'react';
import { t } from '@/shared/i18n/strings';
import type { Lang } from '@/shared/lib/types';
import { useAsync } from '@/shared/lib/useAsync';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';
import { PhoenixDialog } from '@/shared/ui/PhoenixDialog';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { MovementDocumentActions } from '@/features/movement/ui/MovementDocumentActions';
import {
  getOrderEvents, getOrderLines, getOrders, getReceiptLines, getReceipts,
  getReturnsForOrder, getSuppliers, newRequestId, returnToSupplier,
  type OrderRow, type ReceiptLineRow, type ReceiptRow, type SupplierRow,
} from './procurement.service';
import { buildProcurementReceiptDocument } from './procurement-receipt-source';
import { dash, procurementErrorKey } from './procurement-ui';
import { StatusBadge } from './OrderComposerPanel';

interface Props {
  orgId: string;
  warehouseId: string;
  warehouseName: string;
  canReturn: boolean;
  lang: Lang;
}

export function PurchaseHistoryPanel({ orgId, warehouseId, warehouseName, canReturn, lang }: Props) {
  const orders = useAsync(() => getOrders(warehouseId), [warehouseId]);
  const suppliers = useAsync(() => getSuppliers(orgId), [orgId]);
  const [openId, setOpenId] = useState<string | null>(null);

  if (orders.loading && !orders.data) return <PhoenixLoadingState />;
  if (orders.error) return <PhoenixErrorState message={orders.error} onRetry={orders.reload} />;
  const rows = orders.data ?? [];
  if (rows.length === 0) return <PhoenixEmptyState icon="package" title={t('lp_history_none', lang)} />;

  return (
    <div style={{ display: 'grid', gap: '10px' }} data-testid="lp-history">
      {rows.map(o => {
        const supplier = suppliers.data?.find(s => s.id === o.supplierId) ?? null;
        return (
          <PhoenixCard key={o.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: '13px', fontWeight: 700, display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                  {o.orderNumber} <StatusBadge status={o.status} lang={lang} />
                </div>
                <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '3px' }}>
                  {t('lp_supplier', lang)}: {dash(supplier ? (lang === 'ar' ? (supplier.nameAr || supplier.name) : supplier.name) : null)} ·{' '}
                  {t('lp_invoice', lang)}: {dash(o.invoiceNumber)} ·{' '}
                  {new Date(o.createdAt).toLocaleDateString(lang === 'ar' ? 'ar' : 'en')}
                </div>
              </div>
              <PhoenixButton variant="ghost" size="sm" onClick={() => setOpenId(openId === o.id ? null : o.id)}>
                {openId === o.id ? t('lp_close', lang) : t('lp_open', lang)}
              </PhoenixButton>
            </div>
            {openId === o.id && (
              <OrderDetail
                order={o}
                supplier={supplier}
                warehouseName={warehouseName}
                canReturn={canReturn}
                lang={lang}
              />
            )}
          </PhoenixCard>
        );
      })}
    </div>
  );
}

function OrderDetail({ order, supplier, warehouseName, canReturn, lang }: {
  order: OrderRow;
  supplier: SupplierRow | null;
  warehouseName: string;
  canReturn: boolean;
  lang: Lang;
}) {
  const [reloadNonce, setReloadNonce] = useState(0);
  const detail = useAsync(async () => {
    const [lines, receipts, returns, events] = await Promise.all([
      getOrderLines(order.id),
      getReceipts(order.id),
      getReturnsForOrder(order.id),
      getOrderEvents(order.id),
    ]);
    const receiptLines = new Map<string, ReceiptLineRow[]>();
    await Promise.all(receipts.map(async r => {
      receiptLines.set(r.id, await getReceiptLines(r.id));
    }));
    return { lines, receipts, returns, events, receiptLines };
  }, [order.id, reloadNonce]);

  const [returnFor, setReturnFor] = useState<{ receipt: ReceiptRow; line: ReceiptLineRow } | null>(null);

  if (detail.loading && !detail.data) return <PhoenixLoadingState />;
  if (detail.error) return <PhoenixErrorState message={detail.error} onRetry={() => setReloadNonce(n => n + 1)} />;
  const d = detail.data;
  if (!d) return null;

  const returnedFor = (receiptLineId: string) =>
    d.returns.filter(r => r.receiptLineId === receiptLineId).reduce((s, r) => s + r.quantity, 0);

  return (
    <div style={{ marginTop: '12px', borderTop: '1px solid var(--brd)', paddingTop: '12px', display: 'grid', gap: '14px' }}>
      {/* ordered lines */}
      <div>
        <div style={{ fontSize: '12px', fontWeight: 700, marginBottom: '6px' }}>{t('lp_detail_lines', lang)}</div>
        {d.lines.map(l => (
          <div key={l.id} style={{ fontSize: '12px' }}>
            <strong>{l.scientificName}</strong>
            <span style={{ color: 'var(--t2)' }}>
              {' '}· {t('lp_ordered', lang)}: {l.orderedQuantity} · {t('lp_received_so_far', lang)}: {l.receivedQuantity}
              {l.unitPrice !== null ? ` · ${t('lp_unit_price', lang)}: ${l.unitPrice}` : ''}
            </span>
          </div>
        ))}
      </div>

      {/* receipts with official documents */}
      <div>
        <div style={{ fontSize: '12px', fontWeight: 700, marginBottom: '6px' }}>{t('lp_detail_receipts', lang)}</div>
        {d.receipts.length === 0 && <div style={{ fontSize: '12px', color: 'var(--t2)' }}>{t('lp_detail_no_receipts', lang)}</div>}
        {d.receipts.map(r => {
          const rls = d.receiptLines.get(r.id) ?? [];
          const doc = buildProcurementReceiptDocument({
            order, supplier, receipt: r, receiptLines: rls, orderLines: d.lines,
            warehouseName, organizationName: null,
          });
          return (
            <div key={r.id} style={{ border: '1px solid var(--brd)', borderRadius: 'var(--r3)', padding: '10px 12px', marginBottom: '8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                <div style={{ fontSize: '12px' }}>
                  <strong>{r.receiptNumber}</strong>
                  <span style={{ color: 'var(--t2)' }}>
                    {' '}· {new Date(r.createdAt).toLocaleString(lang === 'ar' ? 'ar' : 'en')} · {dash(r.receivedByName)}
                  </span>
                </div>
                <MovementDocumentActions document={doc} lang={lang} canSeePrices />
              </div>
              <div style={{ marginTop: '6px', display: 'grid', gap: '4px' }}>
                {rls.map(rl => {
                  const ol = d.lines.find(x => x.id === rl.orderLineId);
                  const returned = returnedFor(rl.id);
                  return (
                    <div key={rl.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '11.5px', flexWrap: 'wrap', alignItems: 'center' }}>
                      <span>
                        {ol?.scientificName ?? '—'} · {t('lp_qty', lang)}: {rl.quantity}
                        {' '}· {t('mv_f_batch_number', lang)}: {dash(rl.batchNumber)}
                        {' '}· {t('mv_f_expiry_date', lang)}: {dash(rl.expiryDate)}
                        {returned > 0 && <span style={{ color: 'var(--err)' }}> · {t('lp_returned', lang)}: {returned}</span>}
                      </span>
                      {canReturn && returned < rl.quantity && (
                        <PhoenixButton variant="ghost" size="sm" onClick={() => setReturnFor({ receipt: r, line: rl })}>
                          {t('lp_return_action', lang)}
                        </PhoenixButton>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* returns */}
      {d.returns.length > 0 && (
        <div>
          <div style={{ fontSize: '12px', fontWeight: 700, marginBottom: '6px' }}>{t('lp_detail_returns', lang)}</div>
          {d.returns.map(r => (
            <div key={r.id} style={{ fontSize: '11.5px', color: 'var(--t2)' }}>
              −{r.quantity} · {r.reason} · {dash(r.actorName)} · {new Date(r.createdAt).toLocaleString(lang === 'ar' ? 'ar' : 'en')}
            </div>
          ))}
        </div>
      )}

      {/* lifecycle trail */}
      <div>
        <div style={{ fontSize: '12px', fontWeight: 700, marginBottom: '6px' }}>{t('lp_detail_events', lang)}</div>
        {d.events.map(e => (
          <div key={e.id} style={{ fontSize: '11.5px', color: 'var(--t2)' }}>
            {e.eventType}{e.toStatus ? ` → ${t(`lp_status_${e.toStatus}`, lang)}` : ''} · {dash(e.actorName)} ·{' '}
            {new Date(e.createdAt).toLocaleString(lang === 'ar' ? 'ar' : 'en')}
            {e.notes ? ` · ${e.notes}` : ''}
          </div>
        ))}
      </div>

      <ReturnDialog
        target={returnFor}
        lang={lang}
        alreadyReturned={returnFor ? returnedFor(returnFor.line.id) : 0}
        onClose={() => setReturnFor(null)}
        onDone={() => { setReturnFor(null); setReloadNonce(n => n + 1); }}
      />
    </div>
  );
}

/** Provenance-pinned supplier return for one receipt line. */
function ReturnDialog({ target, lang, alreadyReturned, onClose, onDone }: {
  target: { receipt: ReceiptRow; line: ReceiptLineRow } | null;
  lang: Lang;
  alreadyReturned: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [requestId, setRequestId] = useState(() => newRequestId());

  const max = target ? target.line.quantity - alreadyReturned : 0;

  const post = async () => {
    if (!target) return;
    const qty = Number.parseInt(quantity, 10);
    setBusy(true);
    setErrorKey(null);
    const result = await returnToSupplier(requestId, target.line.id, qty, reason.trim());
    setBusy(false);
    if (!result.ok) {
      setErrorKey(procurementErrorKey(result.error));
      return;
    }
    setQuantity('');
    setReason('');
    setRequestId(newRequestId());
    onDone();
  };

  return (
    <PhoenixDialog open={target !== null} onClose={onClose} title={t('lp_return_title', lang)}>
      {target && (
        <div style={{ display: 'grid', gap: '10px' }}>
          <div style={{ fontSize: '12px', color: 'var(--t2)' }}>
            {t('lp_return_hint', lang)} · {t('mv_f_batch_number', lang)}: {dash(target.line.batchNumber)} ·{' '}
            {t('lp_return_max', lang)}: {max}
          </div>
          <PhoenixInput
            label={t('lp_qty', lang)} type="number" min={1} max={max}
            value={quantity}
            onChange={e => { setQuantity(e.target.value); setRequestId(newRequestId()); }}
          />
          <PhoenixInput
            label={t('lp_return_reason', lang)}
            value={reason}
            onChange={e => { setReason(e.target.value); setRequestId(newRequestId()); }}
          />
          {errorKey && <div role="alert" style={{ fontSize: '12px', color: 'var(--err)' }}>{t(errorKey, lang)}</div>}
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <PhoenixButton variant="ghost" onClick={onClose}>{t('lp_back', lang)}</PhoenixButton>
            <PhoenixButton
              disabled={busy || reason.trim() === '' || !(Number.parseInt(quantity, 10) > 0) || Number.parseInt(quantity, 10) > max}
              onClick={post}
            >
              {busy ? t('lp_posting', lang) : t('lp_return_confirm', lang)}
            </PhoenixButton>
          </div>
        </div>
      )}
    </PhoenixDialog>
  );
}
