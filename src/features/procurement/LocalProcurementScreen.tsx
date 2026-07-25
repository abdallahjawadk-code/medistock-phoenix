/**
 * SUPPLEMENTARY-PURCHASES-REDESIGN — Screen 19, المشتريات الفرعية workspace.
 *
 * Three tabs only: direct entry (089/116), history & receipts, returns. The
 * full supplier/order/approval/receiving cycle (087) is NOT surfaced here —
 * its RPCs and tables remain in place (history/returns read them, and 089's
 * direct entry still composes the same canonical rows internally for audit),
 * but the interactive multi-step workflow UI is intentionally hidden: this
 * screen's contract is a single human-confirmed act, not a visible
 * order -> approval -> receive cycle.
 *
 * Scope: the profile's assigned institution warehouses (062), re-checked
 * per-warehouse by useProcurementPermissions and AGAIN server-side inside
 * every RPC. Nothing here writes a stock table directly: stock enters only
 * through the canonical RPCs, and item_availability stays a read-only
 * projection.
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
import { DirectEntryPanel } from './DirectEntryPanel';
import { PurchaseHistoryPanel } from './PurchaseHistoryPanel';

type Tab = 'entry' | 'history' | 'returns';

export function LocalProcurementScreen() {
  const { lang, dir, activeOrgId } = useApp();
  const scopes = useInventoryScopes(activeOrgId);
  const warehouses = scopes.data?.manageableWarehouses ?? [];

  const [warehouseId, setWarehouseId] = useState('');
  const [tab, setTab] = useState<Tab>('entry');

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
    // SUBPURCHASE-DIRECT-ENTRY (089/116): the ONLY entry surface — one simple
    // act, no visible order/supplier/approval cycle.
    { id: 'entry', labelKey: 'sp_tab_entry', show: p.canManage && p.canReceive },
    { id: 'history', labelKey: 'sp_tab_history', show: true },
    { id: 'returns', labelKey: 'sp_tab_returns', show: p.canReturn },
  ];
  const visibleTabs = tabs.filter(x => x.show);
  const activeTab = visibleTabs.some(x => x.id === tab) ? tab : (visibleTabs[0]?.id ?? 'history');

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

      {activeTab === 'entry' && (
        <DirectEntryPanel key={activeWarehouse.id} lang={lang} warehouseId={activeWarehouse.id} onDone={() => { /* result card is the feedback */ }} />
      )}

      {activeTab === 'history' && (
        <PurchaseHistoryPanel
          key={activeWarehouse.id}
          orgId={activeOrgId}
          warehouseId={activeWarehouse.id}
          warehouseName={warehouseName}
          canReturn={false}
          lang={lang}
        />
      )}
      {activeTab === 'returns' && p.canReturn && (
        <PurchaseHistoryPanel
          key={`${activeWarehouse.id}-returns`}
          orgId={activeOrgId}
          warehouseId={activeWarehouse.id}
          warehouseName={warehouseName}
          canReturn={p.canReturn}
          lang={lang}
        />
      )}
    </div>
  );
}
