/**
 * OUTLET-CORRIDOR — Screen 18, Outlet Operations.
 *
 * The single surface an outlet operator works from. It is scoped to the outlets
 * this profile is actually assigned to (migration 062 point assignments, via
 * useInventoryScopes.manageableOutlets) — never to a role name — and every
 * mutation it hosts re-checks that scope server-side. super_admin and an
 * org-level manager see every outlet in the active organization.
 *
 * Four tabs, each a window on canonical server truth:
 *   1. Incoming Supplies — receive 070 dispatches (OutletIncomingSupplies).
 *   2. Stock & Batches   — READ-ONLY on-hand, no balance editing anywhere.
 *   3. Returns           — compose an outlet → warehouse return (071 §A).
 *   4. Movement History  — READ-ONLY outlet ledger.
 *
 * No free-text material entry, no OCR, no manual balance change lives here.
 */
import { useMemo, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { PhoenixOrgScope } from '@/shared/ui/PhoenixOrgScope';
import { PhoenixSelect } from '@/shared/ui/PhoenixSelect';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { useInventoryScopes } from '@/features/inventory/useInventoryScopes';
import { OutletIncomingSupplies } from './OutletIncomingSupplies';
import { OutletReturnComposer } from './OutletReturnComposer';
import { getOutletStock, getOutletStockMovements } from './outlet-stock.service';

type OutletTab = 'incoming' | 'stock' | 'returns' | 'history';
const dash = (v: string | number | null | undefined) => (v == null || v === '' ? '—' : String(v));

export function OutletOperationsScreen() {
  const { lang, dir, activeOrgId } = useApp();
  const scopes = useInventoryScopes(activeOrgId);
  const outlets = scopes.data?.manageableOutlets ?? [];

  const [outletId, setOutletId] = useState('');
  const [tab, setTab] = useState<OutletTab>('incoming');

  const activeOutlet = useMemo(
    () => outlets.find(o => o.id === outletId) ?? outlets[0] ?? null,
    [outlets, outletId],
  );
  const outletName = activeOutlet ? (lang === 'ar' ? (activeOutlet.nameAr || activeOutlet.name) : activeOutlet.name) : '';

  const header = (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap', marginBottom: '16px' }}>
      <div>
        <h2 style={{ fontSize: '22px', fontWeight: 700, letterSpacing: '-.3px' }}>{t('or_screen_title', lang)}</h2>
        <p style={{ fontSize: '12.5px', color: 'var(--t2)', marginTop: '3px' }}>{t('or_screen_sub', lang)}</p>
      </div>
      {/* super_admin's profile has organization_id = null; without this the outlet
          catalog comes back empty and the screen dead-ends. */}
      <PhoenixOrgScope />
    </div>
  );

  if (!activeOrgId) {
    return <div dir={dir}>{header}<PhoenixEmptyState icon="hospital" title={t('no_org_scope', lang)} description={t('empty_hint', lang)} /></div>;
  }
  if (scopes.loading && outlets.length === 0) {
    return <div dir={dir}>{header}<PhoenixLoadingState /></div>;
  }
  if (outlets.length === 0 || !activeOutlet) {
    return <div dir={dir}>{header}<PhoenixEmptyState icon="package" title={t('or_no_outlet_scope', lang)} description={t('empty_hint', lang)} /></div>;
  }

  const tabs: Array<{ id: OutletTab; labelKey: string }> = [
    { id: 'incoming', labelKey: 'or_tab_incoming' },
    { id: 'stock', labelKey: 'or_tab_stock' },
    { id: 'returns', labelKey: 'or_tab_returns' },
    { id: 'history', labelKey: 'or_tab_history' },
  ];

  return (
    <div dir={dir}>
      {header}

      {outlets.length > 1 && (
        <div style={{ maxWidth: '360px', marginBottom: '14px' }}>
          <PhoenixSelect
            label={t('or_select_outlet', lang)}
            value={activeOutlet.id}
            onChange={e => setOutletId(e.target.value)}
            options={outlets.map(o => ({ value: o.id, label: lang === 'ar' ? (o.nameAr || o.name) : o.name }))}
          />
        </div>
      )}

      <div role="tablist" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '16px' }}>
        {tabs.map(x => (
          <button
            key={x.id}
            role="tab"
            aria-selected={tab === x.id}
            onClick={() => setTab(x.id)}
            style={{
              padding: '8px 14px', minHeight: '44px', borderRadius: 'var(--r3)',
              border: '1px solid var(--brd)', cursor: 'pointer', fontSize: '12.5px', fontWeight: 600,
              background: tab === x.id ? 'var(--p2)' : 'var(--s)',
              color: tab === x.id ? 'var(--pd)' : 'var(--t2)',
            }}
          >
            {t(x.labelKey, lang)}
          </button>
        ))}
      </div>

      {tab === 'incoming' && (
        <OutletIncomingSupplies
          key={activeOutlet.id}
          distributionPointId={activeOutlet.id}
          outletName={outletName}
          canReceive
          lang={lang}
        />
      )}

      {tab === 'stock' && <OutletStockTab distributionPointId={activeOutlet.id} lang={lang} />}

      {tab === 'returns' && <OutletReturnsTab distributionPointId={activeOutlet.id} outletName={outletName} lang={lang} />}

      {tab === 'history' && <OutletHistoryTab distributionPointId={activeOutlet.id} lang={lang} />}
    </div>
  );
}

/** Tab 2 — read-only on-hand batches. No control here can change a balance. */
function OutletStockTab({ distributionPointId, lang }: { distributionPointId: string; lang: 'ar' | 'en' }) {
  const stock = useAsync(() => getOutletStock(distributionPointId), [distributionPointId]);
  if (stock.loading && !stock.data) return <PhoenixLoadingState />;
  const rows = stock.data ?? [];
  if (rows.length === 0) return <PhoenixEmptyState icon="package" title={t('or_stock_none', lang)} />;

  return (
    <div style={{ display: 'grid', gap: '10px' }} data-testid="outlet-stock-list">
      {rows.map(r => (
        <PhoenixCard key={r.id}>
          <div style={{ fontSize: '13px', fontWeight: 700 }}>{r.scientificName}</div>
          <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '3px' }}>
            {dash(r.tradeName)} · {dash(r.concentration)} · {dash(r.dosageForm)} · {dash(r.unit)}
          </div>
          <div style={{ fontSize: '11.5px', color: 'var(--t2)' }}>
            {t('mv_f_batch_number', lang)}: {dash(r.batchNumber)} ·{' '}
            {t('mv_f_expiry_date', lang)}: {dash(r.expiryDate)} ·{' '}
            {t('mv_f_national_code', lang)}: {dash(r.nationalCode)}
          </div>
          <div style={{ fontSize: '12px', fontWeight: 700, marginTop: '4px' }}>
            {t('mv_available', lang)}: {r.availableQuantity}
            <span style={{ fontWeight: 400, color: 'var(--t2)' }}>
              {' '}({t('mv_f_received_quantity', lang)}: {r.onHandQuantity} · {t('mv_returned_against', lang)}: {r.reservedQuantity})
            </span>
          </div>
        </PhoenixCard>
      ))}
    </div>
  );
}

/** Tab 3 — compose a return. Draft-first; nothing persists before confirmation. */
function OutletReturnsTab({ distributionPointId, outletName, lang }: { distributionPointId: string; outletName: string; lang: 'ar' | 'en' }) {
  const [instanceKey, setInstanceKey] = useState(0);
  const [created, setCreated] = useState<string | null>(null);
  return (
    <div>
      {created && (
        <div data-testid="outlet-return-created" style={{ background: 'var(--ok2)', border: '1px solid var(--ok)', borderRadius: 'var(--r3)', padding: '10px 14px', fontSize: '12px', color: 'var(--ok)', marginBottom: '12px' }}>
          {t('mv_line_succeeded', lang)} · <code>{created}</code>
        </div>
      )}
      <OutletReturnComposer
        key={instanceKey}
        distributionPointId={distributionPointId}
        distributionPointName={outletName}
        onCancel={() => { setCreated(null); setInstanceKey(k => k + 1); }}
        onCreated={id => { setCreated(id); setInstanceKey(k => k + 1); }}
      />
    </div>
  );
}

/** Tab 4 — read-only movement ledger. */
function OutletHistoryTab({ distributionPointId, lang }: { distributionPointId: string; lang: 'ar' | 'en' }) {
  const history = useAsync(() => getOutletStockMovements(distributionPointId), [distributionPointId]);
  if (history.loading && !history.data) return <PhoenixLoadingState />;
  const rows = history.data ?? [];
  if (rows.length === 0) return <PhoenixEmptyState icon="package" title={t('or_history_none', lang)} />;

  return (
    <div style={{ display: 'grid', gap: '8px' }} data-testid="outlet-history-list">
      {rows.map(r => (
        <PhoenixCard key={r.id}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: '12.5px', fontWeight: 700 }}>{r.scientificName}</div>
              <div style={{ fontSize: '11px', color: 'var(--t2)' }}>
                {t('mv_f_batch_number', lang)}: {dash(r.batchNumber)} · {t('mv_f_expiry_date', lang)}: {dash(r.expiryDate)}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--t2)' }}>
                {r.movementType} · {dash(r.actorName)} · {new Date(r.createdAt).toLocaleString(lang === 'ar' ? 'ar' : 'en')}
                {r.reason ? ` · ${r.reason}` : ''}
              </div>
            </div>
            <div style={{ fontSize: '13px', fontWeight: 700, whiteSpace: 'nowrap' }}>
              {r.onHandDelta >= 0 ? '+' : ''}{r.onHandDelta}
              <span style={{ fontWeight: 400, color: 'var(--t2)' }}> → {r.onHandAfter}</span>
            </div>
          </div>
        </PhoenixCard>
      ))}
    </div>
  );
}
