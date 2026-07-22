/**
 * INSTITUTION-LOCAL-PROCUREMENT-087 — approval queue.
 *
 * Shows submitted orders for the selected warehouse. Approve/reject carries
 * the order generation read from the server row, so a decision racing a
 * concurrent change surfaces as a stale-view conflict; the server ALSO
 * enforces that the submitter can never approve their own order.
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
import { decideOrder, getOrderLines, getOrders, type OrderRow } from './procurement.service';
import { dash, procurementErrorKey } from './procurement-ui';

interface Props {
  warehouseId: string;
  lang: Lang;
}

export function ApprovalQueuePanel({ warehouseId, lang }: Props) {
  const orders = useAsync(() => getOrders(warehouseId, ['submitted']), [warehouseId]);

  if (orders.loading && !orders.data) return <PhoenixLoadingState />;
  if (orders.error) return <PhoenixErrorState message={orders.error} onRetry={orders.reload} />;
  const rows = orders.data ?? [];
  if (rows.length === 0) return <PhoenixEmptyState icon="package" title={t('lp_approvals_none', lang)} />;

  return (
    <div style={{ display: 'grid', gap: '10px' }} data-testid="lp-approvals">
      {rows.map(o => (
        <ApprovalCard key={o.id} order={o} lang={lang} onDecided={() => orders.reload()} />
      ))}
    </div>
  );
}

function ApprovalCard({ order, lang, onDecided }: { order: OrderRow; lang: Lang; onDecided: () => void }) {
  const lines = useAsync(() => getOrderLines(order.id), [order.id]);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const decide = async (approve: boolean) => {
    setBusy(true);
    setErrorKey(null);
    const result = await decideOrder(order.id, approve, notes.trim() || null, order.orderGeneration);
    setBusy(false);
    if (!result.ok) {
      setErrorKey(procurementErrorKey(result.error));
      return;
    }
    onDecided();
  };

  const total = (lines.data ?? []).reduce(
    (sum, l) => (l.unitPrice === null ? sum : sum + l.unitPrice * l.orderedQuantity), 0);

  return (
    <PhoenixCard>
      <div style={{ fontSize: '13px', fontWeight: 700 }}>{order.orderNumber}</div>
      <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '3px' }}>
        {t('lp_invoice', lang)}: {dash(order.invoiceNumber)} ·{' '}
        {t('lp_submitted_at', lang)}: {order.submittedAt ? new Date(order.submittedAt).toLocaleString(lang === 'ar' ? 'ar' : 'en') : '—'}
        {order.ocrAssisted && <> · <span style={{ color: 'var(--pd)' }}>{t('lp_ocr_assisted', lang)}</span></>}
      </div>

      {lines.loading && !lines.data ? <PhoenixLoadingState /> : (
        <div style={{ margin: '10px 0', display: 'grid', gap: '4px' }}>
          {(lines.data ?? []).map(l => (
            <div key={l.id} style={{ fontSize: '12px' }}>
              <strong>{l.scientificName}</strong>
              <span style={{ color: 'var(--t2)' }}>
                {' '}· {dash(l.concentration)} · {t('lp_qty', lang)}: {l.orderedQuantity}
                {l.unitPrice !== null ? ` · ${t('lp_unit_price', lang)}: ${l.unitPrice}` : ''}
              </span>
            </div>
          ))}
          {total > 0 && (
            <div style={{ fontSize: '12px', fontWeight: 700, marginTop: '4px' }}>
              {t('lp_total_value', lang)}: {total.toLocaleString(lang === 'ar' ? 'ar' : 'en')} {dash(order.currency)}
            </div>
          )}
        </div>
      )}

      <PhoenixInput label={t('lp_decision_notes', lang)} value={notes} onChange={e => setNotes(e.target.value)} />
      {errorKey && (
        <div role="alert" style={{ fontSize: '12px', color: 'var(--err)', marginTop: '6px' }}>
          {t(errorKey, lang)}
          {errorKey === 'lp_err_stale' && (
            <PhoenixButton variant="ghost" size="sm" onClick={onDecided} style={{ marginInlineStart: '8px' }}>
              {t('lp_reload', lang)}
            </PhoenixButton>
          )}
        </div>
      )}
      <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
        <PhoenixButton disabled={busy} onClick={() => decide(true)}>{t('lp_approve', lang)}</PhoenixButton>
        <PhoenixButton variant="ghost" disabled={busy} onClick={() => decide(false)}>{t('lp_reject', lang)}</PhoenixButton>
      </div>
    </PhoenixCard>
  );
}
