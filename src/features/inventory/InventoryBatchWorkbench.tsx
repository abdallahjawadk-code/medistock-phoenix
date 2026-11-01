import { useState, type ReactNode } from 'react';
import type { WarehouseStockBatch } from '@/features/network/network.service';
import { t } from '@/shared/i18n/strings';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import '@/shared/ui/prism/prism-fonts.css';
import './inventory-batch-workbench.css';

interface Props {
  batches: readonly WarehouseStockBatch[];
  lang: 'ar' | 'en';
  renderBatch: (batch: WarehouseStockBatch, selection: { selected: boolean; onSelect: () => void }) => ReactNode;
}

/** Read-only view state. The caller retains filtering, scope, stock reads and
 * every existing operation. Never carry a selected row outside visible results. */
export function InventoryBatchWorkbench({ batches, lang, renderBatch }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = batches.find(batch => batch.id === selectedId) ?? batches[0];
  const title = lang === 'ar' ? 'ملف المادة' : 'Material details';
  const unknown = lang === 'ar' ? 'غير مسجل' : 'Not recorded';
  const field = (value: string | null) => <bdi>{value || unknown}</bdi>;
  return (
    <div className="prism-stock-workbench" lang={lang} dir={lang === 'ar' ? 'rtl' : 'ltr'}>
      <div className="nexus-it-batch-list prism-stock-workbench__list">
        {batches.map(batch => renderBatch(batch, { selected: batch.id === selected?.id, onSelect: () => setSelectedId(batch.id) }))}
      </div>
      {selected && <aside className="prism-stock-detail" aria-label={title} dir={lang === 'ar' ? 'rtl' : 'ltr'}>
        <p className="prism-stock-detail__eyebrow">{title}</p>
        <p className="prism-stock-detail__scope">{lang === 'ar' ? 'بيانات الدفعة المحددة في المخزن' : 'Selected warehouse batch'}</p>
        <span className="prism-stock-detail__symbol" aria-hidden="true"><PhoenixIcon name="medical" size={48} /></span>
        <h3><bdi>{selected.scientificName}</bdi></h3>
        <p className="prism-stock-detail__code">{field(selected.nationalCode)}</p>
        <div className="prism-stock-detail__balances">
          <div><span>{t('inv_available', lang)}</span><strong><bdi>{selected.availableQuantity}</bdi></strong></div>
          <div><span>{t('inv_on_hand', lang)}</span><strong><bdi>{selected.onHandQuantity}</bdi></strong></div>
          <div><span>{t('inv_reserved', lang)}</span><strong><bdi>{selected.reservedQuantity}</bdi></strong></div>
        </div>
        <dl>
          <div><dt>{t('inv_concentration', lang)}</dt><dd>{field(selected.concentration)}</dd></div>
          <div><dt>{t('inv_dosage_form', lang)}</dt><dd>{field(selected.dosageForm)}</dd></div>
          <div><dt>{t('unit', lang)}</dt><dd>{field(selected.unit)}</dd></div>
          <div><dt>{t('inv_batch_number', lang)}</dt><dd>{field(selected.batchNumber)}</dd></div>
          <div><dt>{t('expiry', lang)}</dt><dd>{field(selected.expiryDate)}</dd></div>
        </dl>
      </aside>}
    </div>
  );
}
