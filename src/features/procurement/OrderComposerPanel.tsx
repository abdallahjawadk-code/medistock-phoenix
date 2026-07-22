/**
 * INSTITUTION-LOCAL-PROCUREMENT-087 — order composer.
 *
 * Draft-first: a purchase order is composed as a DRAFT (header + lines),
 * then submitted into the approval queue. Every write is a migration-087 RPC;
 * submit carries the order generation read from the server so a submit racing
 * a concurrent edit surfaces as a stale-view conflict instead of acting on
 * lines the submitter never saw.
 */
import { useState } from 'react';
import { t } from '@/shared/i18n/strings';
import type { Lang } from '@/shared/lib/types';
import { useAsync } from '@/shared/lib/useAsync';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';
import { PhoenixSelect } from '@/shared/ui/PhoenixSelect';
import { PhoenixDialog } from '@/shared/ui/PhoenixDialog';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import {
  addOrderLine, cancelOrder, createOrder, getOrderLines, getOrders, getSuppliers,
  removeOrderLine, submitOrder, type OrderRow,
} from './procurement.service';
import { dash, procurementErrorKey, STATUS_LABEL_KEY, STATUS_TONE } from './procurement-ui';

interface Props {
  orgId: string;
  warehouseId: string;
  canManage: boolean;
  lang: Lang;
}

interface NewOrderForm {
  orderNumber: string;
  supplierId: string;
  invoiceNumber: string;
  invoiceDate: string;
  currency: string;
  notes: string;
}

interface NewLineForm {
  scientificName: string;
  quantity: string;
  tradeName: string;
  concentration: string;
  dosageForm: string;
  unit: string;
  nationalCode: string;
  batchNumber: string;
  expiryDate: string;
  unitPrice: string;
}

const EMPTY_LINE: NewLineForm = {
  scientificName: '', quantity: '', tradeName: '', concentration: '', dosageForm: '',
  unit: '', nationalCode: '', batchNumber: '', expiryDate: '', unitPrice: '',
};

export function StatusBadge({ status, lang }: { status: OrderRow['status']; lang: Lang }) {
  const tone = STATUS_TONE[status];
  return (
    <span style={{
      fontSize: '10.5px', fontWeight: 700, borderRadius: '999px', padding: '2px 10px',
      background: tone.bg, color: tone.fg, whiteSpace: 'nowrap',
    }}>
      {t(STATUS_LABEL_KEY[status], lang)}
    </span>
  );
}

export function OrderComposerPanel({ orgId, warehouseId, canManage, lang }: Props) {
  const suppliers = useAsync(() => getSuppliers(orgId), [orgId]);
  const orders = useAsync(
    () => getOrders(warehouseId, ['draft', 'submitted', 'rejected', 'cancelled']),
    [warehouseId],
  );
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState<NewOrderForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const activeSuppliers = (suppliers.data ?? []).filter(s => s.status === 'active');

  const create = async () => {
    if (!creating) return;
    setBusy(true);
    setErrorKey(null);
    const result = await createOrder({
      warehouseId,
      supplierId: creating.supplierId,
      orderNumber: creating.orderNumber.trim(),
      invoiceNumber: creating.invoiceNumber.trim() || null,
      invoiceDate: creating.invoiceDate || null,
      currency: creating.currency.trim() || null,
      notes: creating.notes.trim() || null,
    });
    setBusy(false);
    if (!result.ok) {
      setErrorKey(procurementErrorKey(result.error));
      return;
    }
    setCreating(null);
    setOpenId((result.data?.order_id as string) ?? null);
    orders.reload();
  };

  if ((orders.loading && !orders.data) || (suppliers.loading && !suppliers.data)) return <PhoenixLoadingState />;
  if (orders.error) return <PhoenixErrorState message={orders.error} onRetry={orders.reload} />;
  const rows = orders.data ?? [];

  return (
    <div data-testid="lp-orders">
      {canManage && (
        <div style={{ marginBottom: '12px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <PhoenixButton
            onClick={() => {
              setErrorKey(null);
              setCreating({
                orderNumber: '', supplierId: activeSuppliers[0]?.id ?? '',
                invoiceNumber: '', invoiceDate: '', currency: 'IQD', notes: '',
              });
            }}
            disabled={activeSuppliers.length === 0}
          >
            {t('lp_order_new', lang)}
          </PhoenixButton>
          {activeSuppliers.length === 0 && (
            <span style={{ fontSize: '12px', color: 'var(--t2)', alignSelf: 'center' }}>{t('lp_order_needs_supplier', lang)}</span>
          )}
        </div>
      )}

      {rows.length === 0 ? (
        <PhoenixEmptyState icon="package" title={t('lp_orders_none', lang)} description={canManage ? t('lp_orders_none_hint', lang) : undefined} />
      ) : (
        <div style={{ display: 'grid', gap: '10px' }}>
          {rows.map(o => (
            <PhoenixCard key={o.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: '13px', fontWeight: 700, display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                    {o.orderNumber} <StatusBadge status={o.status} lang={lang} />
                  </div>
                  <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '3px' }}>
                    {t('lp_supplier', lang)}: {dash(suppliers.data?.find(s => s.id === o.supplierId)?.name)} ·{' '}
                    {t('lp_invoice', lang)}: {dash(o.invoiceNumber)} ·{' '}
                    {new Date(o.createdAt).toLocaleDateString(lang === 'ar' ? 'ar' : 'en')}
                  </div>
                  {o.status === 'rejected' && o.decisionNotes && (
                    <div style={{ fontSize: '11.5px', color: 'var(--err)', marginTop: '3px' }}>
                      {t('lp_decision_notes', lang)}: {o.decisionNotes}
                    </div>
                  )}
                </div>
                <PhoenixButton variant="ghost" size="sm" onClick={() => setOpenId(openId === o.id ? null : o.id)}>
                  {openId === o.id ? t('lp_close', lang) : t('lp_open', lang)}
                </PhoenixButton>
              </div>
              {openId === o.id && (
                <DraftEditor
                  order={o}
                  canManage={canManage}
                  lang={lang}
                  onChanged={() => orders.reload()}
                />
              )}
            </PhoenixCard>
          ))}
        </div>
      )}

      <PhoenixDialog open={creating !== null} onClose={() => setCreating(null)} title={t('lp_order_new', lang)}>
        {creating && (
          <div style={{ display: 'grid', gap: '10px' }}>
            <PhoenixInput label={t('lp_order_number', lang)} value={creating.orderNumber} onChange={e => setCreating({ ...creating, orderNumber: e.target.value })} />
            <PhoenixSelect
              label={t('lp_supplier', lang)}
              value={creating.supplierId}
              onChange={e => setCreating({ ...creating, supplierId: e.target.value })}
              options={activeSuppliers.map(s => ({ value: s.id, label: lang === 'ar' ? (s.nameAr || s.name) : s.name }))}
            />
            <PhoenixInput label={t('lp_invoice', lang)} value={creating.invoiceNumber} onChange={e => setCreating({ ...creating, invoiceNumber: e.target.value })} />
            <PhoenixInput label={t('lp_invoice_date', lang)} type="date" value={creating.invoiceDate} onChange={e => setCreating({ ...creating, invoiceDate: e.target.value })} />
            <PhoenixInput label={t('lp_currency', lang)} value={creating.currency} onChange={e => setCreating({ ...creating, currency: e.target.value })} />
            <PhoenixInput label={t('lp_notes', lang)} value={creating.notes} onChange={e => setCreating({ ...creating, notes: e.target.value })} />
            {errorKey && <div role="alert" style={{ fontSize: '12px', color: 'var(--err)' }}>{t(errorKey, lang)}</div>}
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <PhoenixButton variant="ghost" onClick={() => setCreating(null)}>{t('lp_cancel', lang)}</PhoenixButton>
              <PhoenixButton onClick={create} disabled={busy || creating.orderNumber.trim() === '' || creating.supplierId === ''}>
                {busy ? t('lp_saving', lang) : t('lp_create', lang)}
              </PhoenixButton>
            </div>
          </div>
        )}
      </PhoenixDialog>
    </div>
  );
}

/** Line editor + submit/cancel for one opened order (editable only while draft). */
function DraftEditor({ order, canManage, lang, onChanged }: {
  order: OrderRow;
  canManage: boolean;
  lang: Lang;
  onChanged: () => void;
}) {
  const lines = useAsync(() => getOrderLines(order.id), [order.id]);
  const [line, setLine] = useState<NewLineForm>(EMPTY_LINE);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);

  const isDraft = order.status === 'draft';
  const editable = canManage && isDraft;

  const fail = (code: string | undefined) => setErrorKey(procurementErrorKey(code));

  const addLine = async () => {
    const qty = Number.parseInt(line.quantity, 10);
    setBusy(true);
    setErrorKey(null);
    const result = await addOrderLine(order.id, {
      scientificName: line.scientificName.trim(),
      orderedQuantity: Number.isFinite(qty) ? qty : 0,
      tradeName: line.tradeName.trim() || null,
      concentration: line.concentration.trim() || null,
      dosageForm: line.dosageForm.trim() || null,
      unit: line.unit.trim() || null,
      nationalCode: line.nationalCode.trim() || null,
      batchNumber: line.batchNumber.trim() || null,
      expiryDate: line.expiryDate || null,
      unitPrice: line.unitPrice.trim() === '' ? null : Number(line.unitPrice),
    });
    setBusy(false);
    if (!result.ok) return fail(result.error);
    setLine(EMPTY_LINE);
    lines.reload();
    onChanged();
  };

  const remove = async (lineId: string) => {
    setBusy(true);
    setErrorKey(null);
    const result = await removeOrderLine(lineId);
    setBusy(false);
    if (!result.ok) return fail(result.error);
    lines.reload();
    onChanged();
  };

  const submit = async () => {
    setBusy(true);
    setErrorKey(null);
    const result = await submitOrder(order.id, order.orderGeneration);
    setBusy(false);
    if (!result.ok) return fail(result.error);
    onChanged();
  };

  const cancel = async () => {
    setBusy(true);
    setErrorKey(null);
    const result = await cancelOrder(order.id, cancelReason.trim(), order.orderGeneration);
    setBusy(false);
    if (!result.ok) return fail(result.error);
    setConfirmCancel(false);
    onChanged();
  };

  if (lines.loading && !lines.data) return <PhoenixLoadingState />;
  const rows = lines.data ?? [];

  return (
    <div style={{ marginTop: '12px', borderTop: '1px solid var(--brd)', paddingTop: '12px' }} data-testid="lp-draft-editor">
      {rows.length === 0 ? (
        <div style={{ fontSize: '12px', color: 'var(--t2)', marginBottom: '10px' }}>{t('lp_lines_none', lang)}</div>
      ) : (
        <div style={{ display: 'grid', gap: '6px', marginBottom: '10px' }}>
          {rows.map(l => (
            <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <strong>{l.scientificName}</strong>
                <span style={{ color: 'var(--t2)' }}>
                  {' '}· {dash(l.concentration)} · {dash(l.dosageForm)} · {t('lp_qty', lang)}: {l.orderedQuantity}
                  {l.unitPrice !== null ? ` · ${t('lp_unit_price', lang)}: ${l.unitPrice}` : ''}
                  {l.batchNumber ? ` · ${t('mv_f_batch_number', lang)}: ${l.batchNumber}` : ''}
                </span>
              </div>
              {editable && (
                <PhoenixButton variant="ghost" size="sm" disabled={busy} onClick={() => remove(l.id)}>
                  {t('lp_remove', lang)}
                </PhoenixButton>
              )}
            </div>
          ))}
        </div>
      )}

      {editable && (
        <div style={{ display: 'grid', gap: '8px', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', marginBottom: '10px' }}>
          <PhoenixInput label={t('lp_line_name', lang)} value={line.scientificName} onChange={e => setLine({ ...line, scientificName: e.target.value })} />
          <PhoenixInput label={t('lp_qty', lang)} type="number" min={1} value={line.quantity} onChange={e => setLine({ ...line, quantity: e.target.value })} />
          <PhoenixInput label={t('lp_trade_name', lang)} value={line.tradeName} onChange={e => setLine({ ...line, tradeName: e.target.value })} />
          <PhoenixInput label={t('mv_f_concentration', lang)} value={line.concentration} onChange={e => setLine({ ...line, concentration: e.target.value })} />
          <PhoenixInput label={t('mv_f_dosage_form', lang)} value={line.dosageForm} onChange={e => setLine({ ...line, dosageForm: e.target.value })} />
          <PhoenixInput label={t('lp_unit', lang)} value={line.unit} onChange={e => setLine({ ...line, unit: e.target.value })} />
          <PhoenixInput label={t('mv_f_national_code', lang)} value={line.nationalCode} onChange={e => setLine({ ...line, nationalCode: e.target.value })} />
          <PhoenixInput label={t('mv_f_batch_number', lang)} value={line.batchNumber} onChange={e => setLine({ ...line, batchNumber: e.target.value })} />
          <PhoenixInput label={t('mv_f_expiry_date', lang)} type="date" value={line.expiryDate} onChange={e => setLine({ ...line, expiryDate: e.target.value })} />
          <PhoenixInput label={t('lp_unit_price', lang)} type="number" min={0} value={line.unitPrice} onChange={e => setLine({ ...line, unitPrice: e.target.value })} />
        </div>
      )}

      {errorKey && (
        <div role="alert" style={{ fontSize: '12px', color: 'var(--err)', marginBottom: '8px' }}>
          {t(errorKey, lang)}
          {errorKey === 'lp_err_stale' && (
            <PhoenixButton variant="ghost" size="sm" onClick={() => { lines.reload(); onChanged(); }} style={{ marginInlineStart: '8px' }}>
              {t('lp_reload', lang)}
            </PhoenixButton>
          )}
        </div>
      )}

      {editable && (
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <PhoenixButton
            variant="ghost"
            disabled={busy || line.scientificName.trim() === '' || !(Number.parseInt(line.quantity, 10) > 0)}
            onClick={addLine}
          >
            {t('lp_line_add', lang)}
          </PhoenixButton>
          <PhoenixButton disabled={busy || rows.length === 0} onClick={submit}>
            {t('lp_submit', lang)}
          </PhoenixButton>
          <PhoenixButton variant="ghost" disabled={busy} onClick={() => setConfirmCancel(true)}>
            {t('lp_cancel_order', lang)}
          </PhoenixButton>
        </div>
      )}
      {canManage && !isDraft && (order.status === 'submitted') && (
        <div style={{ display: 'flex', gap: '8px' }}>
          <PhoenixButton variant="ghost" disabled={busy} onClick={() => setConfirmCancel(true)}>
            {t('lp_cancel_order', lang)}
          </PhoenixButton>
        </div>
      )}

      <PhoenixDialog open={confirmCancel} onClose={() => setConfirmCancel(false)} title={t('lp_cancel_order', lang)}>
        <div style={{ display: 'grid', gap: '10px' }}>
          <PhoenixInput label={t('lp_cancel_reason', lang)} value={cancelReason} onChange={e => setCancelReason(e.target.value)} />
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <PhoenixButton variant="ghost" onClick={() => setConfirmCancel(false)}>{t('lp_back', lang)}</PhoenixButton>
            <PhoenixButton disabled={busy || cancelReason.trim() === ''} onClick={cancel}>
              {t('lp_cancel_confirm', lang)}
            </PhoenixButton>
          </div>
        </div>
      </PhoenixDialog>
    </div>
  );
}
