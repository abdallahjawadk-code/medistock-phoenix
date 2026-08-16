import { useMemo, useState } from 'react';
import { t, tRpcError } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixSelect } from '@/shared/ui/PhoenixSelect';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { useEmergencyReplenishmentPermission } from '@/features/inventory/useEmergencyReplenishmentPermission';
import { useWarehouseDispatchCreatePermission } from '@/features/inventory/useWarehouseDispatchCreatePermission';
import { isReplenishmentDestinationPointType } from '@/shared/lib/emergency-replenishment';
import { InitialProvisioningLauncher } from './InitialProvisioningLauncher';
import { getOutletStock } from './outlet-stock.service';
import {
  getReversibleBatches,
  listReplenishmentRoutes,
  replenishEmergencyOutlet,
  reverseOutletReplenishment,
} from './emergency-replenishment.service';

/**
 * STAGE-E-E7-2 — the emergency-outlet corridor, as an operator surface.
 *
 * Two deliberately SEPARATE operations live here, and they are never merged
 * into one ambiguous control:
 *
 *   التعويض الدوري  (routine replenishment, Migration 168) — moves stock from
 *     this pharmacy to a rescue cart / crash cabinet along a configured route.
 *
 *   عكس التعويض     (reversal, Migration 169) — returns a PREVIOUS
 *     replenishment to the pharmacy it actually came from. This is NOT the
 *     general outlet → institution-warehouse return (Migration 071), which
 *     keeps its own tab and its own wording.
 *
 * Both submit exactly ONE canonical RPC. Nothing here writes outlet_stock,
 * computes a balance, or compensates a failure with a second write: the debit
 * and credit are one atomic server-side transaction, and the reversible
 * quantity is capped by the server's own read model rather than by arithmetic
 * performed in the browser.
 *
 * A `requestId` is generated once per submission and reused across retries, so
 * a double-click or a retried network call replays idempotently instead of
 * moving stock twice.
 */
export function EmergencyReplenishmentTab({
  orgId,
  distributionPointId,
  outletName,
  outletPointType,
  owningWarehouseId,
  lang,
}: {
  orgId: string;
  distributionPointId: string;
  outletName: string;
  /**
   * R1.2 / Migration 180: `distribution_points.point_type` of the selected
   * outlet. Initial provisioning commissions an EMERGENCY outlet only — the
   * database refuses a pharmacy destination with
   * `initial_provisioning_requires_emergency_outlet` — so the launcher below is
   * offered only for a crash cabinet or rescue cart. Optional so the deliberately
   * frozen presentation fixtures need no change; absent is treated as "not an
   * emergency outlet", i.e. fail closed.
   */
  outletPointType?: string | null;
  /**
   * R1.1-P (P3-A): the selected outlet's ONE owning warehouse
   * (`distribution_points.warehouse_id`), resolved upstream by
   * useInventoryScopes and passed straight through to the initial-provisioning
   * launcher. Carried rather than re-derived so the launcher never has to look
   * at an organization-wide warehouse list to find its source. Optional and
   * defaulting to null so the frozen presentation fixtures need no change —
   * absent means "no pairing", which offers nothing.
   */
  owningWarehouseId?: string | null;
  lang: 'ar' | 'en';
}) {
  const perms = useEmergencyReplenishmentPermission(orgId, distributionPointId);
  const initialProvisionPerm = useWarehouseDispatchCreatePermission(orgId, owningWarehouseId ?? null);
  const canInitialProvision = initialProvisionPerm.data === true;
  const [reloadKey, setReloadKey] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

  const routes = useAsync(
    async () => listReplenishmentRoutes(orgId),
    [orgId, reloadKey],
  );

  // Routes whose SOURCE is this outlet — the only ones this pharmacy may feed.
  const outgoing = useMemo(
    () => (routes.data ?? []).filter(r => r.sourcePointId === distributionPointId && r.isActive),
    [routes.data, distributionPointId],
  );

  if (routes.loading || perms.loading || initialProvisionPerm.loading) return <PhoenixLoadingState />;
  if (routes.error) return <PhoenixErrorState message={String(routes.error)} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {toast && (
        <PhoenixCard padding="12px" style={{ borderInlineStart: '3px solid var(--ok)' }}>
          <p style={{ fontSize: '12.5px', color: 'var(--t1)' }}>{toast}</p>
        </PhoenixCard>
      )}

      {/*
        R1.2 / Migration 180: commissioning is for EMERGENCY outlets only. A
        pharmacy has no initial-provisioning lifecycle — it is supplied by
        ordinary warehouse dispatch as often as needed — so the launcher is not
        offered here, while this pharmacy's OUTGOING routine-replenishment and
        reversal forms below stay exactly as they were. Fails closed: an unknown
        or absent point type offers nothing.

        UX only. The database refuses a pharmacy destination regardless of what
        this screen renders.
      */}
      {canInitialProvision && isReplenishmentDestinationPointType(outletPointType) && (
        <InitialProvisioningLauncher
          orgId={orgId}
          distributionPointId={distributionPointId}
          outletName={outletName}
          owningWarehouseId={owningWarehouseId ?? null}
          lang={lang}
        />
      )}

      {outgoing.length === 0 ? (
        <PhoenixEmptyState
          icon="package"
          title={t('route_none', lang)}
          description={t('repl_reverse_hint', lang)}
        />
      ) : (
        <>
          <ReplenishForm
            sourcePointId={distributionPointId}
            routes={outgoing}
            lang={lang}
            disabled={!perms.data?.canReplenish}
            onDone={(msg) => { setToast(msg); setReloadKey(k => k + 1); }}
          />
          <ReverseForm
            orgId={orgId}
            routes={outgoing}
            lang={lang}
            disabled={!perms.data?.canReverse}
            reloadKey={reloadKey}
            onDone={(msg) => { setToast(msg); setReloadKey(k => k + 1); }}
          />
        </>
      )}
    </div>
  );
}

/* ── التعويض الدوري — routine replenishment (168) ── */

function ReplenishForm({
  sourcePointId, routes, lang, disabled, onDone,
}: {
  sourcePointId: string;
  routes: { id: string; destinationPointId: string; destinationPointType: string | null }[];
  lang: 'ar' | 'en';
  disabled: boolean;
  onDone: (msg: string) => void;
}) {
  const [routeId, setRouteId] = useState(routes[0]?.id ?? '');
  const [stockId, setStockId] = useState('');
  const [qty, setQty] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Generated once per attempt and REUSED across retries — that is what makes
   *  a retry idempotent rather than a second movement. */
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());

  const stock = useAsync(async () => getOutletStock(sourcePointId), [sourcePointId]);
  const selected = (stock.data ?? []).find(s => s.id === stockId);
  const quantity = Number(qty);
  const canSubmit = Boolean(routeId && stockId && Number.isInteger(quantity) && quantity > 0
    && selected && quantity <= selected.availableQuantity && !disabled);

  async function onSubmit() {
    if (!canSubmit || busy) return;
    setBusy(true);
    setError(null);
    const res = await replenishEmergencyOutlet({
      requestId, routeId, sourceOutletStockId: stockId, quantity,
    });
    setBusy(false);
    if (!res.ok) { setError(tRpcError(res.error, lang)); return; }
    onDone(res.data?.idempotent_replay ? t('repl_replayed', lang) : t('repl_done', lang));
    // A completed act gets a fresh idempotency key; retrying the PREVIOUS one
    // must never start a new movement.
    setRequestId(crypto.randomUUID());
    setStockId(''); setQty('');
  }

  return (
    <PhoenixCard padding="16px">
      <h3 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '4px' }}>{t('repl_routine', lang)}</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '12px' }}>
        <PhoenixSelect
          label={t('repl_route', lang)}
          value={routeId}
          onChange={e => setRouteId(e.target.value)}
          options={routes.map(r => ({
            value: r.id,
            label: `${t('route_destination', lang)} · ${r.destinationPointType === 'rescue_cart'
              ? t('port_type_rescue_cart', lang) : t('port_type_crash_cabinet', lang)}`,
          }))}
        />
        {stock.loading ? <PhoenixLoadingState /> : (stock.data ?? []).length === 0 ? (
          <p style={{ fontSize: '12px', color: 'var(--warn)' }}>{t('repl_no_stock', lang)}</p>
        ) : (
          <PhoenixSelect
            label={t('repl_batch', lang)}
            value={stockId}
            onChange={e => setStockId(e.target.value)}
            options={[
              { value: '', label: '—' },
              ...(stock.data ?? []).filter(s => s.availableQuantity > 0).map(s => ({
                value: s.id,
                label: `${s.scientificName} · ${s.batchNumber ?? '—'} · ${t('repl_available', lang)} ${s.availableQuantity}`,
              })),
            ]}
          />
        )}
        <div>
          <label htmlFor="repl-qty" style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>
            {t('repl_quantity', lang)} *
          </label>
          <input
            id="repl-qty"
            type="number"
            min={1}
            max={selected?.availableQuantity ?? undefined}
            value={qty}
            onChange={e => setQty(e.target.value)}
            style={{
              width: '100%', maxWidth: '100%', boxSizing: 'border-box', minHeight: '44px',
              padding: '10px 12px', borderRadius: 'var(--r3)', border: '1px solid var(--brd)',
              background: 'var(--s)', color: 'var(--t1)', fontSize: '13px',
            }}
            dir="ltr"
          />
          {selected && (
            <p style={{ fontSize: '11px', color: 'var(--t3)', marginTop: '5px' }}>
              {t('repl_available', lang)}: {selected.availableQuantity}
            </p>
          )}
        </div>
        {error && <p style={{ fontSize: '12px', color: 'var(--err)' }}>{error}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <PhoenixButton
            variant="primary"
            size="md"
            loading={busy}
            disabled={!canSubmit || busy}
            onClick={onSubmit}
          >
            {t('repl_submit', lang)}
          </PhoenixButton>
        </div>
      </div>
    </PhoenixCard>
  );
}

/* ── عكس التعويض — reversal (169), distinct from the general return (071) ── */

function ReverseForm({
  orgId, routes, lang, disabled, reloadKey, onDone,
}: {
  orgId: string;
  routes: { id: string; destinationPointId: string }[];
  lang: 'ar' | 'en';
  disabled: boolean;
  reloadKey: number;
  onDone: (msg: string) => void;
}) {
  const [routeId, setRouteId] = useState(routes[0]?.id ?? '');
  const [batchId, setBatchId] = useState('');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());

  const route = routes.find(r => r.id === routeId);
  const reversible = useAsync(
    async () => route
      ? getReversibleBatches({ organizationId: orgId, destinationPointId: route.destinationPointId })
      : [],
    [orgId, route?.destinationPointId, reloadKey],
  );

  const selected = (reversible.data ?? []).find(b => b.destinationOutletStockId === batchId);
  const quantity = Number(qty);
  const canSubmit = Boolean(routeId && batchId && Number.isInteger(quantity) && quantity > 0
    && selected && quantity <= selected.remainingReversibleQuantity && !disabled);

  async function onSubmit() {
    if (!canSubmit || busy) return;
    setBusy(true);
    setError(null);
    const res = await reverseOutletReplenishment({
      requestId, routeId, destinationOutletStockId: batchId, quantity,
      reason: reason.trim() || null,
    });
    setBusy(false);
    if (!res.ok) { setError(tRpcError(res.error, lang)); return; }
    onDone(res.data?.idempotent_replay ? t('repl_replayed', lang) : t('repl_reverse_done', lang));
    setRequestId(crypto.randomUUID());
    setBatchId(''); setQty(''); setReason('');
  }

  return (
    <PhoenixCard padding="16px">
      <h3 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '4px' }}>{t('repl_reverse', lang)}</h3>
      <p style={{ fontSize: '11.5px', color: 'var(--t3)', lineHeight: 1.6 }}>{t('repl_reverse_hint', lang)}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '12px' }}>
        <PhoenixSelect
          label={t('repl_route', lang)}
          value={routeId}
          onChange={e => { setRouteId(e.target.value); setBatchId(''); }}
          options={routes.map(r => ({ value: r.id, label: r.id.slice(0, 8) }))}
        />
        {reversible.loading ? <PhoenixLoadingState /> : (reversible.data ?? []).length === 0 ? (
          <p style={{ fontSize: '12px', color: 'var(--t3)' }}>{t('repl_no_reversible', lang)}</p>
        ) : (
          <PhoenixSelect
            label={t('repl_batch', lang)}
            value={batchId}
            onChange={e => setBatchId(e.target.value)}
            options={[
              { value: '', label: '—' },
              ...(reversible.data ?? []).map(b => ({
                value: b.destinationOutletStockId,
                label: `${b.scientificName} · ${b.batchNumber ?? '—'} · ${t('repl_reversible', lang)} ${b.remainingReversibleQuantity}`,
              })),
            ]}
          />
        )}
        <div>
          <label htmlFor="rev-qty" style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>
            {t('repl_quantity', lang)} *
          </label>
          <input
            id="rev-qty"
            type="number"
            min={1}
            max={selected?.remainingReversibleQuantity ?? undefined}
            value={qty}
            onChange={e => setQty(e.target.value)}
            style={{
              width: '100%', maxWidth: '100%', boxSizing: 'border-box', minHeight: '44px',
              padding: '10px 12px', borderRadius: 'var(--r3)', border: '1px solid var(--brd)',
              background: 'var(--s)', color: 'var(--t1)', fontSize: '13px',
            }}
            dir="ltr"
          />
          {selected && (
            <p style={{ fontSize: '11px', color: 'var(--t3)', marginTop: '5px' }}>
              {t('repl_reversible', lang)}: {selected.remainingReversibleQuantity}
            </p>
          )}
        </div>
        <div>
          <label htmlFor="rev-reason" style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>
            {t('repl_reason', lang)}
          </label>
          <input
            id="rev-reason"
            type="text"
            value={reason}
            onChange={e => setReason(e.target.value)}
            style={{
              width: '100%', maxWidth: '100%', boxSizing: 'border-box', minHeight: '44px',
              padding: '10px 12px', borderRadius: 'var(--r3)', border: '1px solid var(--brd)',
              background: 'var(--s)', color: 'var(--t1)', fontSize: '13px',
            }}
            dir="auto"
          />
        </div>
        {error && <p style={{ fontSize: '12px', color: 'var(--err)' }}>{error}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <PhoenixButton
            variant="secondary"
            size="md"
            loading={busy}
            disabled={!canSubmit || busy}
            onClick={onSubmit}
          >
            {t('repl_reverse_submit', lang)}
          </PhoenixButton>
        </div>
      </div>
    </PhoenixCard>
  );
}
