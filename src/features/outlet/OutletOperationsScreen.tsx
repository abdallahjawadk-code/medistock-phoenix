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
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { useInventoryScopes } from '@/features/inventory/useInventoryScopes';
import { useOutletCountPermission } from '@/features/inventory/useOutletCountPermission';
import { MovementDocumentActions } from '@/features/movement/ui/MovementDocumentActions';
import { OutletIncomingSupplies } from './OutletIncomingSupplies';
import { OutletReturnComposer } from './OutletReturnComposer';
import { OutletStockCorrectionModal } from './OutletStockCorrectionModal';
import { CurrentMovementStatus } from './CurrentMovementStatus';
import { getOutletStock, getOutletStockMovements, type OutletStockRow } from './outlet-stock.service';
import { getOutletReturnRequests, getOutletReturnRequestLines } from './outlet-return.service';
import { buildOutletReturnRequestReceipt } from './outlet-receipt-source';
import { getPaperReference } from '@/features/movement/paper-reference.service';

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

  // MOVEMENT-TRACKING-MERGE: "movement history" and "movement status" are ONE
  // tab — سجل وتتبع الحركة / Movement History & Tracking — the ledger list plus
  // the 081/082 server-authoritative timeline tracker.
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

      {tab === 'stock' && <OutletStockTab orgId={activeOrgId} distributionPointId={activeOutlet.id} lang={lang} />}

      {tab === 'returns' && <OutletReturnsTab distributionPointId={activeOutlet.id} outletName={outletName} lang={lang} />}

      {tab === 'history' && (
        <div style={{ display: 'grid', gap: '18px' }}>
          <CurrentMovementStatus lang={lang} />
          <OutletHistoryTab distributionPointId={activeOutlet.id} lang={lang} />
        </div>
      )}
    </div>
  );
}

/**
 * Tab 2 — on-hand batches. Read-only for outlet operators: no operator control
 * can change a balance. The ONE deliberate exception is a physical-count
 * CORRECTION, shown per-lot only to actors holding the scoped `outlet_stock.count`
 * permission on this outlet (useOutletCountPermission). Even then nothing is
 * written from React: the correction is submitted to the guarded canonical RPC
 * phoenix_count_outlet_stock_guarded (migration 086, via OutletStockCorrectionModal),
 * which the server adjudicates — expected-generation, non-negative, reservation-
 * safe, reason-mandatory, append-only movement + audit. item_availability is a
 * read-only projection and is never touched here.
 */
function OutletStockTab({ orgId, distributionPointId, lang }: { orgId: string | null; distributionPointId: string; lang: 'ar' | 'en' }) {
  const stock = useAsync(() => getOutletStock(distributionPointId), [distributionPointId]);
  const countPerm = useOutletCountPermission(orgId, distributionPointId);
  const canCorrect = countPerm.data === true;
  const [correctLot, setCorrectLot] = useState<OutletStockRow | null>(null);
  const [correctionMessage, setCorrectionMessage] = useState<string | null>(null);

  if (stock.loading && !stock.data) return <PhoenixLoadingState />;
  const rows = stock.data ?? [];
  if (rows.length === 0) return <PhoenixEmptyState icon="package" title={t('or_stock_none', lang)} />;

  return (
    <div style={{ display: 'grid', gap: '10px' }} data-testid="outlet-stock-list">
      {rows.map(r => (
        <PhoenixCard key={r.id}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'flex-start' }}>
            <div style={{ minWidth: 0, flex: 1 }}>
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
            </div>
            {canCorrect && (
              <PhoenixButton variant="ghost" size="sm" onClick={() => setCorrectLot(r)}>
                {t('oc_correct_action', lang)}
              </PhoenixButton>
            )}
          </div>
        </PhoenixCard>
      ))}

      {correctionMessage && (
        <div style={{ fontSize: '12px', color: 'var(--ok)', textAlign: 'center' }}>{correctionMessage}</div>
      )}

      <OutletStockCorrectionModal
        open={correctLot !== null}
        lot={correctLot}
        lang={lang}
        canCorrect={canCorrect}
        onClose={() => setCorrectLot(null)}
        onSuccess={(requiresApproval) => {
          setCorrectLot(null);
          setCorrectionMessage(t(requiresApproval ? 'oc_submitted_for_approval' : 'oc_applied_immediately', lang));
          setTimeout(() => setCorrectionMessage(null), 5000);
          stock.reload();
        }}
      />
    </div>
  );
}

/** Tab 3 — compose a return. Draft-first; nothing persists before confirmation. */
function OutletReturnsTab({ distributionPointId, outletName, lang }: { distributionPointId: string; outletName: string; lang: 'ar' | 'en' }) {
  const [instanceKey, setInstanceKey] = useState(0);
  const [created, setCreated] = useState<string | null>(null);

  // The receipt is built ONLY from freshly reloaded server rows for the created
  // request — never from the local draft. Missing/denied rows yield no document.
  const receipt = useAsync(async () => {
    if (!created) return null;
    const [requests, lines, paperReference] = await Promise.all([
      getOutletReturnRequests(distributionPointId),
      getOutletReturnRequestLines(created),
      getPaperReference('outlet_return_request', created),
    ]);
    const request = requests.find(r => r.id === created);
    if (!request) return null;
    return buildOutletReturnRequestReceipt({
      request, lines,
      source: { organizationName: null, warehouseName: outletName },
      destination: { organizationName: null, warehouseName: null },
      paperReference,
    });
  }, [created, distributionPointId]);

  return (
    <div>
      {created && (
        <div data-testid="outlet-return-created" style={{ background: 'var(--ok2)', border: '1px solid var(--ok)', borderRadius: 'var(--r3)', padding: '10px 14px', fontSize: '12px', color: 'var(--ok)', marginBottom: '12px' }}>
          {t('mv_line_succeeded', lang)} · <code>{created}</code>
        </div>
      )}
      {created && receipt.data && (
        <div style={{ marginBottom: '14px' }} data-testid="outlet-return-receipt-actions">
          <MovementDocumentActions document={receipt.data} lang={lang} />
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
