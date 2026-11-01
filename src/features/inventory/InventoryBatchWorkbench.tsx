import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { WarehouseStockBatch } from '@/features/network/network.service';
import { t } from '@/shared/i18n/strings';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import '@/shared/ui/prism/prism-fonts.css';
import './inventory-batch-workbench.css';

interface Props {
  batches: readonly WarehouseStockBatch[];
  lang: 'ar' | 'en';
  renderBatch: (batch: WarehouseStockBatch, selection: { selected: boolean; onSelect: (trigger?: HTMLElement) => void }) => ReactNode;
}

/** Read-only view state. The caller retains filtering, scope, stock reads and
 * every existing operation. Never carry a selected row outside visible results. */
export function InventoryBatchWorkbench({ batches, lang, renderBatch }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const restoreFocus = useRef(true);
  const wasOpen = useRef(false);
  const selected = batches.find(batch => batch.id === selectedId) ?? batches[0];
  const selectionRemoved = selectedId !== null && !batches.some(batch => batch.id === selectedId);
  useEffect(() => {
    if (detailOpen && selectionRemoved) {
      const active = document.activeElement;
      restoreFocus.current = active === document.body || Boolean(headingRef.current?.closest('aside')?.contains(active));
      setDetailOpen(false);
    }
  }, [detailOpen, selectionRemoved]);
  useEffect(() => {
    const media = window.matchMedia?.('(max-width: 1100px)');
    const focusDetails = () => {
      headingRef.current?.focus({ preventScroll: true });
      headingRef.current?.closest('aside')?.scrollIntoView?.({ block: 'start', behavior: 'auto' });
    };
    if (media?.matches) {
      if (detailOpen && !selectionRemoved) focusDetails();
      else if (!detailOpen && wasOpen.current && restoreFocus.current) {
        (triggerRef.current?.isConnected ? triggerRef.current : listRef.current)?.focus({ preventScroll: true });
      }
    }
    const onViewportChange = () => {
      if (!detailOpen) return;
      const active = document.activeElement;
      if (media?.matches && (active === triggerRef.current || active === document.body)) focusDetails();
      else if (!media?.matches && active?.classList.contains('prism-stock-detail__back')) headingRef.current?.focus({ preventScroll: true });
    };
    media?.addEventListener?.('change', onViewportChange);
    wasOpen.current = detailOpen;
    return () => media?.removeEventListener?.('change', onViewportChange);
  }, [detailOpen, selected?.id, selectionRemoved]);
  const title = lang === 'ar' ? 'ملف المادة' : 'Material details';
  const unknown = lang === 'ar' ? 'غير مسجل' : 'Not recorded';
  const field = (value: string | null) => <bdi>{value || unknown}</bdi>;
  return (
    <div className="prism-stock-workbench" data-detail-open={detailOpen} lang={lang} dir={lang === 'ar' ? 'rtl' : 'ltr'}>
      <div ref={listRef} role="group" aria-label={lang === 'ar' ? 'دفعات المخزن' : 'Warehouse batches'} tabIndex={-1} className="nexus-it-batch-list prism-stock-workbench__list">
        {batches.map(batch => renderBatch(batch, { selected: batch.id === selected?.id, onSelect: trigger => {
          triggerRef.current = trigger ?? null;
          restoreFocus.current = true;
          setSelectedId(batch.id);
          setDetailOpen(true);
        } }))}
      </div>
      {selected && <aside className="prism-stock-detail" aria-label={title} dir={lang === 'ar' ? 'rtl' : 'ltr'}>
        {detailOpen && <button type="button" className="prism-stock-detail__back" onClick={() => setDetailOpen(false)}>
          {lang === 'ar' ? 'العودة إلى الدفعات' : 'Back to batches'}
        </button>}
        <p className="prism-stock-detail__eyebrow">{title}</p>
        <p className="prism-stock-detail__scope">{lang === 'ar' ? 'بيانات الدفعة المحددة في المخزن' : 'Selected warehouse batch'}</p>
        <span className="prism-stock-detail__symbol" aria-hidden="true"><PhoenixIcon name="medical" size={48} /></span>
        <h3 ref={headingRef} tabIndex={-1}><bdi>{selected.scientificName}</bdi></h3>
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
