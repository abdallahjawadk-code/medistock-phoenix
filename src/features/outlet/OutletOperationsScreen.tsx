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
 *   2. Stock & Batches   — on-hand list. Two deliberate, server-adjudicated
 *      quantity affordances live here and nowhere else: DISPENSE (136's
 *      atomic dispense+beneficiary RPC) and a physical-count CORRECTION
 *      (098's request/approve contract). Neither writes a balance from
 *      React — both submit to a SECURITY DEFINER RPC that re-checks scope,
 *      quantity and concurrency server-side.
 *   3. Returns           — compose an outlet → warehouse return (071 §A).
 *   4. Movement History  — READ-ONLY outlet ledger, plus the 134 dispense
 *      context recorded against each dispense row.
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
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { useInventoryScopes } from '@/features/inventory/useInventoryScopes';
import { useOutletCountPermission } from '@/features/inventory/useOutletCountPermission';
import { useMovementContextRecordPermission } from '@/features/inventory/useMovementContextRecordPermission';
import { useOutletDispensePermission } from '@/features/inventory/useOutletDispensePermission';
import { useOutletReceivePermission } from '@/features/inventory/useOutletReceivePermission';
import { useOutletReturnRequestPermission } from '@/features/inventory/useOutletReturnRequestPermission';
import { useOutletRecallPermission } from '@/features/inventory/useOutletRecallPermission';
import { InventoryIntelligencePanel } from '@/features/inventory/InventoryIntelligencePanel';
import { MovementDocumentActions } from '@/features/movement/ui/MovementDocumentActions';
import { EmergencyReplenishmentTab } from './EmergencyReplenishmentTab';
import { OutletIncomingSupplies } from './OutletIncomingSupplies';
import { OutletReturnComposer } from './OutletReturnComposer';
import { OutletRecallPanel } from './OutletRecallPanel';
import { OutletStockCorrectionModal } from './OutletStockCorrectionModal';
import { DispenseContextDialog } from './DispenseContextDialog';
import { DispenseComposerDialog } from './DispenseComposerDialog';
import { DispenseContextViewer } from './DispenseContextViewer';
import { CurrentMovementStatus } from './CurrentMovementStatus';
import { getOutletStock, getOutletStockMovements, type OutletStockRow, type OutletMovementRow } from './outlet-stock.service';
import { getDispenseContext, type DispenseContext } from './dispense-context.service';
import { getOutletReturnRequests, getOutletReturnRequestLines } from './outlet-return.service';
import { buildOutletReturnRequestReceipt } from './outlet-receipt-source';
import { getPaperReference } from '@/features/movement/paper-reference.service';
import type { SuggestionDocumentTarget } from '@/features/inventory/suggestion-document-navigation';

type OutletTab = 'incoming' | 'stock' | 'replenish' | 'returns' | 'history';
const dash = (v: string | number | null | undefined) => (v == null || v === '' ? '—' : String(v));

export function OutletOperationsScreen({
  initialSuggestionDocument,
  onOpenSuggestionDocument,
}: {
  initialSuggestionDocument?: SuggestionDocumentTarget;
  onOpenSuggestionDocument?: (target: SuggestionDocumentTarget) => void;
} = {}) {
  const { lang, dir, activeOrgId } = useApp();
  const scopes = useInventoryScopes(activeOrgId);
  const outlets = scopes.data?.manageableOutlets ?? [];

  const opensReturn =
    initialSuggestionDocument?.documentKind === 'outlet_return_request';
  const [outletId, setOutletId] = useState(
    opensReturn ? initialSuggestionDocument.sourceScopeId : '',
  );
  const [tab, setTab] = useState<OutletTab>(opensReturn ? 'returns' : 'incoming');

  const activeOutlet = useMemo(
    () => outlets.find(o => o.id === outletId) ?? outlets[0] ?? null,
    [outlets, outletId],
  );
  const outletName = activeOutlet ? (lang === 'ar' ? (activeOutlet.nameAr || activeOutlet.name) : activeOutlet.name) : '';

  const receivePerm = useOutletReceivePermission(activeOrgId, activeOutlet?.id ?? null);
  const canReceiveIncoming = receivePerm.data === true;
  const returnRequestPerm = useOutletReturnRequestPermission(activeOrgId, activeOutlet?.id ?? null);
  const canRequestReturn = returnRequestPerm.data === true;
  const recallPerm = useOutletRecallPermission(activeOrgId, activeOutlet?.warehouseId ?? null);
  const canRecallOutletStock = recallPerm.data === true;

  const header = (
    <div className="nexus-io-header nexus-io-header__row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap', marginBottom: '16px' }}>
      <div className="nexus-io-header__titles">
        <h2 className="nexus-io-header__title" style={{ fontSize: '22px', fontWeight: 700, letterSpacing: '-.3px' }}>{t('or_screen_title', lang)}</h2>
        <p className="nexus-io-header__subtitle" style={{ fontSize: '12.5px', color: 'var(--t2)', marginTop: '3px' }}>{t('or_screen_sub', lang)}</p>
      </div>
      {/* super_admin's profile has organization_id = null; without this the outlet
          catalog comes back empty and the screen dead-ends. */}
      <PhoenixOrgScope />
    </div>
  );

  if (!activeOrgId) {
    return <div dir={dir} className="nexus-outlet-ops">{header}<PhoenixEmptyState icon="hospital" title={t('no_org_scope', lang)} description={t('empty_hint', lang)} /></div>;
  }
  if (scopes.loading && outlets.length === 0) {
    return <div dir={dir} className="nexus-outlet-ops">{header}<PhoenixLoadingState /></div>;
  }
  if (outlets.length === 0 || !activeOutlet) {
    return <div dir={dir} className="nexus-outlet-ops">{header}<PhoenixEmptyState icon="package" title={t('or_no_outlet_scope', lang)} description={t('empty_hint', lang)} /></div>;
  }

  // MOVEMENT-TRACKING-MERGE: "movement history" and "movement status" are ONE
  // tab — سجل وتتبع الحركة / Movement History & Tracking — the ledger list plus
  // the 081/082 server-authoritative timeline tracker.
  // STAGE-E-E7-2: the emergency-replenishment corridor gets its own tab rather
  // than being folded into Returns — a replenishment reversal and a general
  // outlet→warehouse return are different operations with different corridors,
  // and merging their entry points would blur exactly that distinction.
  const tabs: Array<{ id: OutletTab; labelKey: string }> = [
    { id: 'incoming', labelKey: 'or_tab_incoming' },
    { id: 'stock', labelKey: 'or_tab_stock' },
    { id: 'replenish', labelKey: 'repl_routine' },
    { id: 'returns', labelKey: 'or_tab_returns' },
    { id: 'history', labelKey: 'or_tab_history' },
  ];

  return (
    <div dir={dir} className="nexus-outlet-ops">
      {header}

      {outlets.length > 1 && (
        <div className="nexus-io-context-bar" style={{ maxWidth: '360px', marginBottom: '14px' }}>
          <PhoenixSelect
            label={t('or_select_outlet', lang)}
            value={activeOutlet.id}
            onChange={e => setOutletId(e.target.value)}
            options={outlets.map(o => ({ value: o.id, label: lang === 'ar' ? (o.nameAr || o.name) : o.name }))}
          />
        </div>
      )}

      <div role="tablist" className="nexus-io-tabs" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '16px' }}>
        {tabs.map(x => (
          <button
            key={x.id}
            role="tab"
            aria-selected={tab === x.id}
            onClick={() => setTab(x.id)}
            className="nexus-io-tab"
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
          canReceive={canReceiveIncoming}
          lang={lang}
        />
      )}

      {tab === 'stock' && <OutletStockTab orgId={activeOrgId} distributionPointId={activeOutlet.id} lang={lang} />}

      {tab === 'replenish' && (
        <EmergencyReplenishmentTab
          key={activeOutlet.id}
          orgId={activeOrgId}
          distributionPointId={activeOutlet.id}
          outletName={outletName}
          // R1.2 / Migration 180: initial provisioning commissions an EMERGENCY
          // outlet only, so the tab needs the selected outlet's type to decide
          // whether to offer that action at all. Already resolved here by
          // useInventoryScopes — no extra fetch and no new boundary.
          outletPointType={activeOutlet.pointType}
          // R1.1-P (P3-A): the outlet's ONE owning warehouse, already resolved
          // here by useInventoryScopes. Initial provisioning must dispatch from
          // THIS depot — for a health-centre crash cabinet that is the centre's
          // own depot, never the sector main and never a sibling centre — so the
          // launcher is handed the pairing instead of an org-wide picker.
          owningWarehouseId={activeOutlet.warehouseId}
          lang={lang}
        />
      )}

      {tab === 'returns' && (
        <OutletReturnsTab
          distributionPointId={activeOutlet.id}
          outletName={outletName}
          lang={lang}
          canRequestReturn={canRequestReturn}
          canRecallOutletStock={canRecallOutletStock}
          initialRequestId={
            opensReturn ? initialSuggestionDocument.documentId : undefined
          }
        />
      )}

      {tab === 'history' && (
        <div className="nexus-io-content" style={{ display: 'grid', gap: '18px' }}>
          <CurrentMovementStatus lang={lang} />
          <OutletHistoryTab orgId={activeOrgId} distributionPointId={activeOutlet.id} lang={lang} />
        </div>
      )}

      <div style={{ marginTop: '24px' }} data-testid="outlet-suggestion-actions">
        <InventoryIntelligencePanel onOpenDocument={onOpenSuggestionDocument} />
      </div>
    </div>
  );
}

/**
 * Tab 2 — on-hand batches. No operator control changes a balance directly.
 * Two deliberate, server-adjudicated exceptions live here:
 *
 *   * DISPENSE (136), shown per-lot only to actors holding BOTH scoped
 *     outlet_stock.dispense AND movement_context.record on this outlet
 *     (useOutletDispensePermission) — the composed act needs both, and both
 *     are re-checked server-side. It calls the ATOMIC
 *     phoenix_dispense_outlet_stock_with_context, never the bare dispense
 *     RPC, so stock can never leave the outlet without a recorded
 *     beneficiary.
 *   * A physical-count CORRECTION, shown per-lot only to actors holding the scoped `outlet_stock.count`
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
  const dispensePerm = useOutletDispensePermission(orgId, distributionPointId);
  const canDispense = dispensePerm.data === true;
  const [correctLot, setCorrectLot] = useState<OutletStockRow | null>(null);
  const [dispenseLot, setDispenseLot] = useState<OutletStockRow | null>(null);
  const [correctionMessage, setCorrectionMessage] = useState<string | null>(null);

  if (stock.loading && !stock.data) return <PhoenixLoadingState />;
  const rows = stock.data ?? [];
  if (rows.length === 0) return <PhoenixEmptyState icon="package" title={t('or_stock_none', lang)} />;

  return (
    <div className="nexus-io-row-list" style={{ display: 'grid', gap: '10px' }} data-testid="outlet-stock-list">
      {rows.map(r => (
        <PhoenixCard key={r.id} className={`nexus-io-stock-row${r.availableQuantity === 0 ? ' nexus-io-stock-row--zero' : ''}`}>
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
              <div className="nexus-io-stock-row__qty" style={{ fontSize: '12px', fontWeight: 700, marginTop: '4px' }}>
                {t('mv_available', lang)}: {r.availableQuantity}
                <span style={{ fontWeight: 400, color: 'var(--t2)' }}>
                  {' '}({t('mv_f_received_quantity', lang)}: {r.onHandQuantity} · {t('mv_returned_against', lang)}: {r.reservedQuantity})
                </span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {canDispense && r.availableQuantity > 0 && (
                <PhoenixButton className="nexus-io-action-dispense" variant="primary" size="sm" onClick={() => setDispenseLot(r)}>
                  {t('dsp_action', lang)}
                </PhoenixButton>
              )}
              {canCorrect && (
                <PhoenixButton className="nexus-io-action-correct" variant="ghost" size="sm" onClick={() => setCorrectLot(r)}>
                  {t('oc_correct_action', lang)}
                </PhoenixButton>
              )}
            </div>
          </div>
        </PhoenixCard>
      ))}

      {correctionMessage && (
        <div style={{ fontSize: '12px', color: 'var(--ok)', textAlign: 'center' }}>{correctionMessage}</div>
      )}

      <DispenseComposerDialog
        open={dispenseLot !== null}
        lot={dispenseLot}
        lots={rows}
        lang={lang}
        canDispense={canDispense}
        onClose={() => setDispenseLot(null)}
        onSuccess={() => {
          setDispenseLot(null);
          setCorrectionMessage(t('dsp_succeeded', lang));
          setTimeout(() => setCorrectionMessage(null), 5000);
          stock.reload();
        }}
      />

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
function OutletReturnsTab({
  distributionPointId,
  outletName,
  lang,
  canRequestReturn,
  canRecallOutletStock,
  initialRequestId,
}: {
  distributionPointId: string;
  outletName: string;
  lang: 'ar' | 'en';
  canRequestReturn: boolean;
  canRecallOutletStock: boolean;
  initialRequestId?: string;
}) {
  const [instanceKey, setInstanceKey] = useState(0);
  const [created, setCreated] = useState<string | null>(initialRequestId ?? null);
  const openedFromSuggestion = initialRequestId != null;

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
    <div style={{ display: 'grid', gap: '16px' }}>
      {canRecallOutletStock && (
        <OutletRecallPanel
          key={distributionPointId}
          distributionPointId={distributionPointId}
          lang={lang}
          onRecalled={() => receipt.reload()}
        />
      )}
      {created && receipt.loading && <PhoenixLoadingState label={t('loading', lang)} />}
      {created && receipt.error && (
        <PhoenixErrorState
          title={t('load_error', lang)}
          message={receipt.error}
          onRetry={receipt.reload}
        />
      )}
      {created && !receipt.loading && !receipt.error && receipt.data && (
        <div data-testid="outlet-return-created" style={{ background: 'var(--ok2)', border: '1px solid var(--ok)', borderRadius: 'var(--r3)', padding: '10px 14px', fontSize: '12px', color: 'var(--ok)', marginBottom: '12px' }}>
          {t(openedFromSuggestion ? 'inv_document_opened' : 'mv_line_succeeded', lang)} · <code>{created}</code>
        </div>
      )}
      {created && !receipt.loading && !receipt.error && !receipt.data && (
        <div
          role="status"
          data-testid="outlet-return-unavailable"
          style={{ background: 'var(--warn2)', border: '1px solid var(--warn)', borderRadius: 'var(--r3)', padding: '10px 14px', fontSize: '12px', color: 'var(--warn)', marginBottom: '12px' }}
        >
          {t('inv_draft_unavailable', lang)}
        </div>
      )}
      {created && receipt.data && (
        <div style={{ marginBottom: '14px' }} data-testid="outlet-return-receipt-actions">
          <MovementDocumentActions document={receipt.data} lang={lang} />
        </div>
      )}
      {canRequestReturn && (
        <OutletReturnComposer
          key={instanceKey}
          distributionPointId={distributionPointId}
          distributionPointName={outletName}
          onCancel={() => { setCreated(null); setInstanceKey(k => k + 1); }}
          onCreated={id => { setCreated(id); setInstanceKey(k => k + 1); }}
        />
      )}
    </div>
  );
}

/**
 * Tab 4 — read-only movement ledger. The ONE deliberate exception, exactly
 * mirroring OutletStockTab's correction affordance: a 'dispense' row may
 * carry a MOVEMENT-DISPENSE-CONTEXT (134) record — WHO/WHAT it was for. The
 * action is shown only to actors holding the scoped movement_context.record
 * permission on this outlet (useMovementContextRecordPermission); anyone
 * else who can see the row still sees the recorded context (server-masked
 * per their own view_sensitive standing), just not the record action.
 */
function OutletHistoryTab({ orgId, distributionPointId, lang }: { orgId: string | null; distributionPointId: string; lang: 'ar' | 'en' }) {
  const history = useAsync(() => getOutletStockMovements(distributionPointId), [distributionPointId]);
  const contextPerm = useMovementContextRecordPermission(orgId, distributionPointId);
  const canRecordContext = contextPerm.data === true;
  const [contextMovement, setContextMovement] = useState<OutletMovementRow | null>(null);
  const [contextReloadKey, setContextReloadKey] = useState(0);

  if (history.loading && !history.data) return <PhoenixLoadingState />;
  const rows = history.data ?? [];
  if (rows.length === 0) return <PhoenixEmptyState icon="package" title={t('or_history_none', lang)} />;

  return (
    <div className="nexus-io-row-list" style={{ display: 'grid', gap: '8px' }} data-testid="outlet-history-list">
      {rows.map(r => (
        <PhoenixCard key={r.id} className="nexus-io-history-row">
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
              {r.movementType === 'dispense' && (
                <DispenseContextSlot
                  key={`${r.id}-${contextReloadKey}`}
                  movementId={r.id}
                  lang={lang}
                  canRecord={canRecordContext}
                  onRecordClick={() => setContextMovement(r)}
                />
              )}
            </div>
            <div style={{ fontSize: '13px', fontWeight: 700, whiteSpace: 'nowrap' }}>
              {r.onHandDelta >= 0 ? '+' : ''}{r.onHandDelta}
              <span style={{ fontWeight: 400, color: 'var(--t2)' }}> → {r.onHandAfter}</span>
            </div>
          </div>
        </PhoenixCard>
      ))}

      <DispenseContextDialog
        open={contextMovement !== null}
        movement={contextMovement}
        lang={lang}
        canRecord={canRecordContext}
        onClose={() => setContextMovement(null)}
        onSuccess={() => setContextReloadKey(k => k + 1)}
      />
    </div>
  );
}

/** One movement row's dispense-context slot: fetches on mount, shows the
 *  viewer if a context already exists, otherwise a "Record context" action
 *  (only if the caller may record). Isolated per-row so a slow/failed
 *  lookup for one movement never blocks the rest of the ledger. */
function DispenseContextSlot({
  movementId, lang, canRecord, onRecordClick,
}: { movementId: string; lang: 'ar' | 'en'; canRecord: boolean; onRecordClick: () => void }) {
  const ctx = useAsync(() => getDispenseContext(movementId), [movementId]);

  if (ctx.loading) return null;
  const context: DispenseContext | null = ctx.data;

  if (context) return <DispenseContextViewer context={context} lang={lang} />;
  if (!canRecord) return null;

  return (
    <div style={{ marginTop: '4px' }}>
      <PhoenixButton variant="ghost" size="sm" onClick={onRecordClick}>
        {t('dc_record_action', lang)}
      </PhoenixButton>
    </div>
  );
}
