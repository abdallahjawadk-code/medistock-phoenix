/**
 * INSTITUTION-LOCAL-PROCUREMENT-087 — Screen 19, Local Procurement workspace.
 *
 * The single surface an institution works from to purchase locally: suppliers,
 * order composing, the approval queue, partial/full receiving, and purchase
 * history with printable receipts (print · genuine XLSX · QR traceability).
 *
 * Scope: the profile's assigned institution warehouses (062), re-checked
 * per-warehouse by useProcurementPermissions and AGAIN server-side inside
 * every migration-087 RPC. Nothing here writes a stock table: stock enters
 * only through phoenix_procurement_receive_order, and item_availability stays
 * a read-only projection.
 *
 * OCR: deliberately absent. If an OCR draft ever pre-fills the composer it is
 * still a reviewable DRAFT that walks submit → approve → receive like any
 * hand-typed order (the ocr_assisted provenance flag exists for that path);
 * OCR can never post stock.
 */
import { useMemo, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixOrgScope } from '@/shared/ui/PhoenixOrgScope';
import { PhoenixSelect } from '@/shared/ui/PhoenixSelect';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { useInventoryScopes } from '@/features/inventory/useInventoryScopes';
import { useProcurementPermissions } from './useProcurementPermissions';
import { SupplierPanel } from './SupplierPanel';
import { OrderComposerPanel } from './OrderComposerPanel';
import { ApprovalQueuePanel } from './ApprovalQueuePanel';
import { ReceivingPanel } from './ReceivingPanel';
import { PurchaseHistoryPanel } from './PurchaseHistoryPanel';

type Tab = 'orders' | 'approvals' | 'receiving' | 'history' | 'suppliers';

export function LocalProcurementScreen() {
  const { lang, dir, activeOrgId } = useApp();
  const scopes = useInventoryScopes(activeOrgId);
  const warehouses = scopes.data?.manageableWarehouses ?? [];

  const [warehouseId, setWarehouseId] = useState('');
  const [tab, setTab] = useState<Tab>('orders');

  const activeWarehouse = useMemo(
    () => warehouses.find(w => w.id === warehouseId) ?? warehouses[0] ?? null,
    [warehouses, warehouseId],
  );
  const perms = useProcurementPermissions(activeOrgId, activeWarehouse?.id ?? null);

  const header = (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap', marginBottom: '16px' }}>
      <div>
        <h2 style={{ fontSize: '22px', fontWeight: 700, letterSpacing: '-.3px' }}>{t('lp_screen_title', lang)}</h2>
        <p style={{ fontSize: '12.5px', color: 'var(--t2)', marginTop: '3px' }}>{t('lp_screen_sub', lang)}</p>
      </div>
      <PhoenixOrgScope />
    </div>
  );

  if (!activeOrgId) {
    return <div dir={dir}>{header}<PhoenixEmptyState icon="hospital" title={t('no_org_scope', lang)} description={t('empty_hint', lang)} /></div>;
  }
  if ((scopes.loading && warehouses.length === 0) || (perms.loading && !perms.data)) {
    return <div dir={dir}>{header}<PhoenixLoadingState /></div>;
  }
  if (warehouses.length === 0 || !activeWarehouse) {
    return <div dir={dir}>{header}<PhoenixEmptyState icon="package" title={t('lp_no_warehouse_scope', lang)} description={t('empty_hint', lang)} /></div>;
  }
  // Denied state: the screen never dead-ends silently — it says why.
  if (perms.data && !perms.data.canView) {
    return <div dir={dir}>{header}<PhoenixEmptyState icon="lock" title={t('lp_denied_title', lang)} description={t('lp_denied_hint', lang)} /></div>;
  }

  const p = perms.data ?? { canView: false, canManage: false, canApprove: false, canReceive: false, canReturn: false };
  const warehouseName = lang === 'ar' ? (activeWarehouse.nameAr || activeWarehouse.name) : activeWarehouse.name;

  const tabs: Array<{ id: Tab; labelKey: string; show: boolean }> = [
    { id: 'orders', labelKey: 'lp_tab_orders', show: true },
    { id: 'approvals', labelKey: 'lp_tab_approvals', show: p.canApprove },
    { id: 'receiving', labelKey: 'lp_tab_receiving', show: p.canReceive },
    { id: 'history', labelKey: 'lp_tab_history', show: true },
    { id: 'suppliers', labelKey: 'lp_tab_suppliers', show: true },
  ];
  const visibleTabs = tabs.filter(x => x.show);
  const activeTab = visibleTabs.some(x => x.id === tab) ? tab : 'orders';

  return (
    <div dir={dir}>
      {header}

      {warehouses.length > 1 && (
        <div style={{ maxWidth: '360px', marginBottom: '14px' }}>
          <PhoenixSelect
            label={t('lp_select_warehouse', lang)}
            value={activeWarehouse.id}
            onChange={e => setWarehouseId(e.target.value)}
            options={warehouses.map(w => ({ value: w.id, label: lang === 'ar' ? (w.nameAr || w.name) : w.name }))}
          />
        </div>
      )}

      <div role="tablist" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '16px' }}>
        {visibleTabs.map(x => (
          <button
            key={x.id}
            role="tab"
            aria-selected={activeTab === x.id}
            onClick={() => setTab(x.id)}
            style={{
              padding: '8px 14px', minHeight: '44px', borderRadius: 'var(--r3)',
              border: '1px solid var(--brd)', cursor: 'pointer', fontSize: '12.5px', fontWeight: 600,
              background: activeTab === x.id ? 'var(--p2)' : 'var(--s)',
              color: activeTab === x.id ? 'var(--pd)' : 'var(--t2)',
            }}
          >
            {t(x.labelKey, lang)}
          </button>
        ))}
      </div>

      {activeTab === 'orders' && (
        <OrderComposerPanel
          key={activeWarehouse.id}
          orgId={activeOrgId}
          warehouseId={activeWarehouse.id}
          canManage={p.canManage}
          lang={lang}
        />
      )}
      {activeTab === 'approvals' && p.canApprove && (
        <ApprovalQueuePanel key={activeWarehouse.id} warehouseId={activeWarehouse.id} lang={lang} />
      )}
      {activeTab === 'receiving' && p.canReceive && (
        <ReceivingPanel key={activeWarehouse.id} warehouseId={activeWarehouse.id} lang={lang} />
      )}
      {activeTab === 'history' && (
        <PurchaseHistoryPanel
          key={activeWarehouse.id}
          orgId={activeOrgId}
          warehouseId={activeWarehouse.id}
          warehouseName={warehouseName}
          canReturn={p.canReturn}
          lang={lang}
        />
      )}
      {activeTab === 'suppliers' && (
        <SupplierPanel orgId={activeOrgId} canManage={p.canManage} lang={lang} />
      )}
    </div>
  );
}
