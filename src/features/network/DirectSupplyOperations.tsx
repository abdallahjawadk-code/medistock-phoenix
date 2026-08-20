import { useMemo, useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';
import { PhoenixSelect } from '@/shared/ui/PhoenixSelect';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { getOrganizations } from '@/shared/supabase/services/organizations.service';
import { listOrganizationFacilities } from '@/features/institutions/facilities.service';
import {
  DIRECT_SUPPLY_BRANCHES,
  directSupplyDestinations,
  directSupplySources,
  type DirectSupplyBranch,
} from '@/shared/lib/direct-supply-corridors';
import {
  getOrganizationWarehouseRoles,
  type WarehouseStructuralRole,
} from '@/shared/supabase/services/scope-topology.service';
import { supabase } from '@/shared/supabase/client';
import { PhoenixMaterialResolver } from '@/shared/materials/PhoenixMaterialResolver';
import type { ResolvedMaterial } from '@/shared/materials/material-resolver.service';
import {
  getAllWarehouses,
  createDirectTransferRequest, addTransferRequestLine, updateTransferRequestLine,
  deleteTransferRequestLine, submitTransferRequest, cancelTransferRequest,
  reviewTransferRequest, sendDirectTransferLine, receiveTransferLine,
  getTransferRequests, getTransferRequestLines, getTransfers, getTransferLines,
  getTransferLinesForTransfers, getWarehouseStock,
  addDirectReturnLine, deleteReturnRequestLine,
  submitReturnRequest, cancelReturnRequest, reviewReturnRequest, sendDirectReturnLine,
  receiveReturnShipmentLine, getReturnRequests, getReturnRequestLines,
  getReturnShipments, getReturnShipmentLines,
  RETURN_REASON_CODES, RETURN_DISPOSITION_REASONS,
  type NetworkWarehouse, type RpcResult, type TransferRequest, type TransferRequestLine,
  type Transfer, type ReturnRequest, type ReturnRequestLine, type ReturnShipment,
} from './network.service';
import { runStockMutation, type TokenedWriter } from '@/shared/lib/stock-mutation-runner';
import { getFefoAlternatives, type FefoBatch } from '@/features/outlet/dispatch.service';
import { FefoOverrideDialog } from '@/features/outlet/FefoOverrideDialog';
import { useFefoOverridePermission } from '@/features/inventory/useFefoOverridePermission';
import type { StockCandidate } from '@/features/movement/composer-model';
import { DirectSupplyComposer } from '@/features/movement/DirectSupplyComposer';
import { DirectReturnComposer } from '@/features/movement/DirectReturnComposer';
import { InstitutionIncomingSupplies } from '@/features/movement/InstitutionIncomingSupplies';
import { MovementDocumentActions } from '@/features/movement/ui/MovementDocumentActions';
import { buildSupplyRequestReceipt } from '@/features/movement/receipt-source';
import type { PartyOption } from '@/features/movement/ui/MovementPartySelector';
import { getPaperReference, setPaperReference } from '@/features/movement/paper-reference.service';
import { PaperReferenceFields, EMPTY_PAPER_REFERENCE, paperReferenceSummary, type PaperReferenceValue } from '@/features/movement/ui/PaperReferenceFields';

/**
 * W077-COMPOSER — rollback switch for the forward create-authoring UX. When
 * `draftFirst` is true the draft-first DirectSupplyComposer owns the "new
 * request" action (canonical stock/batch picker, nothing persisted before
 * review, honest partial-failure recovery). Flip to false to restore the legacy
 * create-header-then-add-lines form while parity is being proven. Both paths
 * commit through the SAME lifecycle RPCs (createDirectTransferRequest +
 * addTransferRequestLine) — there is never a second writer. The legacy form is
 * removed in a follow-up cleanup commit once parity tests and screenshots pass.
 */
const FORWARD_CREATE = { draftFirst: true };

/**
 * Every stock-moving RPC below goes through the shared runner, which DERIVES
 * its request id from server-observed facts instead of minting one per attempt.
 * A minted id makes each retry a new logical operation and double-posts
 * whenever a success response is lost — and a remembered id cannot survive the
 * page reload that most often prompts the retry. See shared/lib/operation-token.
 *
 * The `generation` for a SEND is the server's cumulative `fulfilledQuantity`,
 * so retrying one shipment reuses its token while a later legitimate split
 * shipment gets a distinct one. For a RECEIVE it is `receivedQuantity`.
 */
const writeTransferSend: TokenedWriter<{
  transferRequestId: string; warehouseStockId: string; quantity: number;
  transferNumber: string; transferRequestLineId: string;
  fefoOverride?: boolean; overrideReason?: string | null;
}> = (requestId, p) => sendDirectTransferLine({ requestId, ...p });

const writeTransferReceive: TokenedWriter<{
  transferLineId: string; receivedQuantity: number; differenceReason: string | null;
}> = (requestId, p) => receiveTransferLine({ requestId, ...p });

const writeReturnSend: TokenedWriter<{
  returnRequestLineId: string; quantity: number; shipmentNumber: string;
}> = (requestId, p) => sendDirectReturnLine({ requestId, ...p });

const writeReturnReceive: TokenedWriter<{
  shipmentLineId: string; receivedQuantity: number;
  differenceReason: string | null; dispositionDecision: string | null;
}> = (requestId, p) => receiveReturnShipmentLine({ requestId, ...p });

/**
 * W077-COMPOSER — the return counterpart of FORWARD_CREATE. When `draftFirst` is
 * true the provenance-anchored DirectReturnComposer owns the "new return" action
 * (both institution-initiated request AND central recall modes preserved,
 * safeReturnable caps, nothing persisted before review). The retired header-only
 * recall form cannot represent Migration 185's required provenance selector.
 */
const RETURN_CREATE = { draftFirst: true };

/**
 * W077-COMPOSER — rollback switch for the forward RECEIVE section. When enabled,
 * the institution incoming-supplies surface (full immutable dispatch record,
 * bulk "accept all safe" + individual receipt with discrepancy reason, canonical
 * reload after every attempt) replaces the compact per-transfer IncomingTransferRow.
 * Both drive the SAME receiveTransferLine RPC with a fresh idempotency token per
 * attempt — one writer. The receive button is gated on the real receive
 * permission (warehouse_transfer.receive) + super_admin, which the RPC re-checks
 * server-side regardless. Flip to false to restore the legacy rows.
 */
const RECEIVE_UPGRADE = { enabled: true };

/**
 * W077 — the FULL operational surface for route-free direct supply. Not just a
 * create-request form: it drives the whole lifecycle for both directions —
 * central→institution supply (create / add / update / delete / submit / review /
 * send / receive) and institution→central return (request / recall / add /
 * submit / review / send / receive). Every mutation is a SECURITY DEFINER RPC
 * (network.service) that re-checks scope server-side; every read is RLS-scoped.
 * The legacy supply-route table is never created, listed, or consulted here —
 * the read layer surfaces only direct (unrouted) rows.
 */

type Lang = 'ar' | 'en';
type Status = { msg: string; error: boolean } | null;

const nameOf =(w: { name_ar: string; name: string } | undefined, lang: Lang): string =>
  !w ? '—' : (lang === 'ar' ? (w.name_ar || w.name) : (w.name || w.name_ar));

function opErrorMessage(code: string | undefined, lang: Lang): string {
  const c = (code ?? '').toUpperCase();
  if (c.includes('FORBIDDEN') || c.includes('NOT_AUTHORIZED') || c === '42501') return t('net_err_not_authorized', lang);
  if (c.includes('CONFLICT') || c.includes('EXISTS')) return t('net_err_conflict', lang);
  if (c.endsWith('NOT_FOUND')) return t('net_err_not_found', lang);
  if (c === 'UNKNOWN_ERROR') return t('net_err_generic', lang);
  return t('net_err_invalid', lang);
}

function StatusLine({ status }: { status: Status }) {
  if (!status) return null;
  return (
    <div role="status" style={{
      margin: '10px 0', padding: '9px 12px', borderRadius: 'var(--r2)', fontSize: '12.5px',
      background: status.error ? 'var(--err2)' : 'var(--ok2)',
      color: status.error ? 'var(--err)' : 'var(--ok)',
      border: `1px solid ${status.error ? 'var(--err)' : 'var(--ok)'}`,
    }}>{status.msg}</div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const done = ['fulfilled', 'received', 'approved'].includes(status);
  const bad = ['cancelled', 'rejected'].includes(status);
  const bg = done ? 'var(--ok2)' : bad ? 'var(--err2)' : 'var(--s2)';
  const fg = done ? 'var(--ok)' : bad ? 'var(--err)' : 'var(--t2)';
  return (
    <span style={{
      display: 'inline-block', padding: '1px 8px', borderRadius: 'var(--rpill)',
      fontSize: '10px', fontWeight: 700, background: bg, color: fg,
    }}>{status}</span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export function DirectSupplyOperations({
  lang,
  initialTransferRequestId,
}: {
  lang: Lang;
  initialTransferRequestId?: string;
}) {
  const [dirTab, setDirTab] = useState<'forward' | 'return'>('forward');
  const warehouses = useAsync(() => getAllWarehouses(), []);
  const whById = useMemo(
    () => new Map((warehouses.data ?? []).map(w => [w.id, w] as const)),
    [warehouses.data],
  );

  return (
    <div className="nexus-it-panel">
      <div role="tablist" className="nexus-it-tabs nexus-it-tabs--sub" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '14px' }}>
        {(['forward', 'return'] as const).map(id => (
          <button key={id} role="tab" aria-selected={dirTab === id} onClick={() => setDirTab(id)}
            className="premium-focus-ring nexus-it-tab"
            style={{
              padding: '8px 13px', minHeight: '40px', borderRadius: 'var(--r2)',
              border: '1px solid var(--brd)', cursor: 'pointer', fontSize: '12.5px', fontWeight: 600,
              background: dirTab === id ? 'var(--p)' : 'var(--s)', color: dirTab === id ? 'var(--on-accent)' : 'var(--t2)',
            }}>
            {t(id === 'forward' ? 'net_op_forward' : 'net_op_return', lang)}
          </button>
        ))}
      </div>

      {warehouses.loading && <PhoenixLoadingState />}
      {!warehouses.loading && dirTab === 'forward' && (
        <ForwardPanel
          lang={lang}
          warehouses={warehouses.data ?? []}
          whById={whById}
          initialTransferRequestId={initialTransferRequestId}
        />
      )}
      {!warehouses.loading && dirTab === 'return' && (
        <ReturnPanel lang={lang} warehouses={warehouses.data ?? []} whById={whById} />
      )}
    </div>
  );
}

// ─── FORWARD: central → institution ──────────────────────────────────────────

function ForwardPanel({ lang, warehouses, whById, initialTransferRequestId }: {
  lang: Lang;
  warehouses: NetworkWarehouse[];
  whById: Map<string, NetworkWarehouse>;
  initialTransferRequestId?: string;
}) {
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey(k => k + 1);
  const requests = useAsync(() => getTransferRequests(true), [reloadKey]);
  const incoming = useAsync(() => getTransfers(undefined, true), [reloadKey]);
  const orgs = useAsync(() => getOrganizations(), []);
  const [openId, setOpenId] = useState<string | null>(initialTransferRequestId ?? null);
  const [creating, setCreating] = useState(false);
  const [receiveDestId, setReceiveDestId] = useState('');
  const [status, setStatus] = useState<Status>(null);

  const open = (requests.data ?? []).find(r => r.id === openId) ?? null;

  // §1 — this tab is the central SENDER's surface (gated on warehouse_transfer.send).
  // Receiving belongs to the institution officer, so here the incoming section is
  // a READ-ONLY in-transit monitor. The single authoritative receive-mutation
  // entry lives in the Institution Inventory Center → Incoming tab, gated on
  // warehouse_transfer.receive. A send-only actor therefore cannot receive.
  const canReceive = false;

  // Party data for the draft-first composer. Same RLS-scoped warehouse list the
  // legacy form used, filtered to the eligible endpoints; the RPC re-checks
  // source/destination scope server-side on every call regardless of this UI.
  const orgNameById = useMemo(
    () => new Map((orgs.data ?? []).map(o => [o.id, lang === 'ar' ? o.name_ar : o.name] as const)),
    [orgs.data, lang],
  );
  /**
   * R1.1-P (P2-B) — the operator picks a CORRIDOR first.
   *
   * Migration 165 has had two legal direct-supply branches since Stage E, but
   * the frontend only ever constructed Branch A, so a health sector could not
   * supply its own centres from the interface. Both now exist, and they are
   * presented as named corridors rather than as one undifferentiated warehouse
   * list — "central → institution" and "sector main → health centre" have
   * different sources, different destinations and different meanings, and a
   * single flat list hid all three differences.
   *
   * No new RPC and no new migration: both corridors commit through the same
   * createDirectTransferRequest, and the server re-validates the endpoints.
   */
  const [branch, setBranch] = useState<DirectSupplyBranch>('central_to_institution');
  const [sectorSourceId, setSectorSourceId] = useState('');

  /**
   * G4.2 — the STRUCTURAL ROLE of every warehouse that could be a Branch-B
   * source, from Migration 191.
   *
   * Scoped to HEALTH SECTORS only, deliberately. A Branch-B source is by
   * definition a sector main, so no other organization class can contribute
   * one; asking 191 about a hospital would be a query whose answer this screen
   * cannot use. Sectors are few, and the alternative — one round trip per
   * organization in the whole network — is an N+1 over data the corridor does
   * not need.
   *
   * A role that has not loaded leaves the warehouse with NO role, and
   * `directSupplySources` treats an absent role as "not the sector main". The
   * picker is therefore EMPTY while loading rather than briefly offering a
   * source the server would refuse — the fail-closed direction.
   */
  const sectorRoles = useAsync(async () => {
    const sectorOrgIds = [...new Set(
      (orgs.data ?? [])
        .filter(o => o.institutionClass === 'health_sector')
        .map(o => o.id),
    )];
    const merged = new Map<string, WarehouseStructuralRole>();
    for (const id of sectorOrgIds) {
      for (const [whId, role] of await getOrganizationWarehouseRoles(id)) merged.set(whId, role);
    }
    return merged;
  }, [orgs.data]);

  const warehousesWithRole = useMemo(
    () => warehouses.map(w => ({ ...w, structuralRole: sectorRoles.data?.get(w.id) ?? null })),
    [warehouses, sectorRoles.data],
  );

  const corridorSources = useMemo(
    () => directSupplySources(branch, warehousesWithRole, orgs.data ?? []),
    [branch, warehousesWithRole, orgs.data],
  );

  /**
   * Branch B is scoped to ONE sector main, chosen here rather than inside the
   * composer, because its legal destinations depend on which sector it is. The
   * composer then receives an already-correlated pair-set, which is what makes
   * a foreign sector's centre unselectable by construction instead of merely
   * refused after submission.
   */
  const sectorSource = useMemo(
    () => corridorSources.find(w => w.id === sectorSourceId) ?? corridorSources[0] ?? null,
    [corridorSources, sectorSourceId],
  );
  const branchSource = branch === 'sector_to_health_center' ? sectorSource : null;

  /**
   * The source sector's ACTIVE health-centre facilities — read only for Branch
   * B, and only once a source is chosen. 165 refuses an inactive or
   * wrongly-classed facility, so an unresolved list must yield no destinations.
   *
   * The result is STAMPED with the organization it was fetched for. `useAsync`
   * keeps the previous result for one render after its deps change, so
   * switching from sector 1 to sector 2 briefly pairs sector 2's main with
   * sector 1's facility ids. Rejecting a result whose stamp does not match the
   * current source is the same guard useInventoryScopes applies to a fast
   * organization switch, and it resolves the mismatch HERE rather than relying
   * only on the same-organization conjunct downstream.
   */
  const sectorFacilities = useAsync(
    async () => {
      if (branch !== 'sector_to_health_center' || !branchSource) return null;
      const organizationId = branchSource.organizationId;
      return { organizationId, facilities: await listOrganizationFacilities(organizationId) };
    },
    [branch, branchSource?.organizationId],
  );
  const supplyableFacilityIds = useMemo(() => {
    const loaded = sectorFacilities.data;
    if (branch !== 'sector_to_health_center' || !branchSource) return null;
    if (sectorFacilities.loading || sectorFacilities.error) return null;
    // A result for a DIFFERENT sector is not an answer about this one.
    if (!loaded || loaded.organizationId !== branchSource.organizationId) return null;
    return new Set(
      loaded.facilities
        .filter(f => f.status === 'active'
          && (f.facilityClass === 'primary_health_center' || f.facilityClass === 'subordinate_health_center'))
        .map(f => f.id),
    );
  }, [branch, branchSource, sectorFacilities.data, sectorFacilities.loading, sectorFacilities.error]);

  const sourceWarehouses = useMemo(
    () => branch === 'sector_to_health_center'
      ? (branchSource ? [branchSource] : [])
      : corridorSources,
    [branch, branchSource, corridorSources],
  );

  const corridorDestinations = useMemo(
    () => directSupplyDestinations(branch, warehouses, branchSource, supplyableFacilityIds),
    [branch, warehouses, branchSource, supplyableFacilityIds],
  );

  const destinationParties = useMemo<PartyOption[]>(
    () => corridorDestinations.map(w => ({
      id: w.id,
      organizationId: w.organizationId,
      organizationName: orgNameById.get(w.organizationId) ?? '—',
      warehouseName: lang === 'ar' ? (w.name_ar || w.name) : (w.name || w.name_ar),
    })),
    [corridorDestinations, orgNameById, lang],
  );

  // Only organizations that actually own an eligible destination on this
  // corridor. Offering one with no reachable warehouse produces an empty second
  // dropdown and reads as a broken screen.
  const organizationOptions = useMemo(() => {
    const eligible = new Set(corridorDestinations.map(w => w.organizationId));
    return (orgs.data ?? [])
      .filter(o => eligible.has(o.id))
      .map(o => ({ id: o.id, name: lang === 'ar' ? o.name_ar : o.name }));
  }, [orgs.data, corridorDestinations, lang]);

  // Distinct institution warehouses that actually have incoming transfers. The
  // incoming-supplies surface is per-warehouse, so the operator selects which
  // depot to receive into; each shows its own canonical, server-reloaded lines.
  const receiveDestinations = useMemo(() => {
    const seen = new Map<string, { id: string; institutionName: string; warehouseName: string }>();
    for (const tr of incoming.data ?? []) {
      if (seen.has(tr.destinationWarehouseId)) continue;
      seen.set(tr.destinationWarehouseId, {
        id: tr.destinationWarehouseId,
        institutionName: orgNameById.get(tr.destinationOrganizationId) ?? '—',
        warehouseName: nameOf(whById.get(tr.destinationWarehouseId), lang),
      });
    }
    return [...seen.values()];
  }, [incoming.data, whById, orgNameById, lang]);
  const effectiveReceiveDest = receiveDestinations.some(d => d.id === receiveDestId)
    ? receiveDestId : (receiveDestinations[0]?.id ?? '');
  const activeReceiveDest = receiveDestinations.find(d => d.id === effectiveReceiveDest) ?? null;

  if (open) {
    return (
      <ForwardDetail lang={lang} request={open} whById={whById} orgNameById={orgNameById}
        onBack={() => { setOpenId(null); reload(); }}
        onStatus={setStatus} status={status} />
    );
  }

  // Draft-first authoring takes over the panel exactly like the detail view does:
  // one reachable create entry, and nothing is persisted until the review step.
  if (creating && FORWARD_CREATE.draftFirst) {
    return (
      <DirectSupplyComposer
        sourceWarehouses={sourceWarehouses}
        destinationWarehouses={destinationParties}
        organizations={organizationOptions}
        onCancel={() => setCreating(false)}
        onCreated={(requestId) => {
          setCreating(false);
          setStatus({ msg: t('net_ds_created', lang), error: false });
          reload();
          // Hand off to the existing lifecycle container so the operator can
          // submit → review → send → receive without a second create path.
          setOpenId(requestId);
        }}
      />
    );
  }

  return (
    <div>
      <div className="nexus-it-toolbar" style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
        <PhoenixButton onClick={() => setCreating(c => !c)}>{t('net_op_new', lang)}</PhoenixButton>
        <PhoenixButton variant="ghost" onClick={reload}>{t('net_op_refresh', lang)}</PhoenixButton>
      </div>

      {/* R1.1-P (P2-B): the corridor is chosen before authoring, so the composer
          opens with endpoints that already belong to one another. */}
      <PhoenixCard padding="12px" style={{ marginBottom: '10px' }} data-testid="direct-supply-corridor">
        <h4 style={{ fontSize: '12.5px', fontWeight: 700, marginBottom: '8px' }}>{t('ds_corridor', lang)}</h4>
        <div role="radiogroup" aria-label={t('ds_corridor', lang)} style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {DIRECT_SUPPLY_BRANCHES.map(b => (
            <button
              key={b}
              type="button"
              role="radio"
              aria-checked={branch === b}
              onClick={() => { setBranch(b); setSectorSourceId(''); }}
              style={{
                padding: '8px 14px', minHeight: '44px', borderRadius: 'var(--r3)',
                border: '1px solid var(--brd)', cursor: 'pointer', fontSize: '12.5px', fontWeight: 600,
                background: branch === b ? 'var(--p2)' : 'var(--s)',
                color: branch === b ? 'var(--pd)' : 'var(--t2)',
              }}
            >
              {t(b === 'central_to_institution' ? 'ds_corridor_central' : 'ds_corridor_sector', lang)}
            </button>
          ))}
        </div>
        <p style={{ fontSize: '11px', color: 'var(--t3)', marginTop: '8px', lineHeight: 1.5 }}>
          {t(branch === 'central_to_institution' ? 'ds_corridor_central_hint' : 'ds_corridor_sector_hint', lang)}
        </p>

        {/* Branch B needs its sector main named before any destination exists. */}
        {branch === 'sector_to_health_center' && (
          corridorSources.length === 0 ? (
            <p style={{ fontSize: '12px', color: 'var(--warn)', marginTop: '8px' }}>{t('ds_no_sector_main', lang)}</p>
          ) : (
            <div style={{ maxWidth: '360px', marginTop: '10px' }}>
              <PhoenixSelect
                label={t('ds_sector_source', lang)}
                value={sectorSource?.id ?? ''}
                onChange={e => setSectorSourceId(e.target.value)}
                options={corridorSources.map(w => ({
                  value: w.id,
                  label: `${orgNameById.get(w.organizationId) ?? '—'} — ${lang === 'ar' ? (w.name_ar || w.name) : (w.name || w.name_ar)}`,
                }))}
              />
              {supplyableFacilityIds !== null && corridorDestinations.length === 0 && (
                <p style={{ fontSize: '12px', color: 'var(--warn)', marginTop: '8px' }}>{t('ds_no_center_depot', lang)}</p>
              )}
            </div>
          )
        )}
      </PhoenixCard>

      <StatusLine status={status} />

      {creating && !FORWARD_CREATE.draftFirst && (
        <ForwardCreateForm lang={lang} warehouses={warehouses}
          onCancel={() => setCreating(false)}
          onDone={(res) => {
            if (res.ok) { setStatus({ msg: t('net_ds_created', lang), error: false }); setCreating(false); reload(); }
            else setStatus({ msg: opErrorMessage(res.error, lang), error: true });
          }} />
      )}

      <h4 style={{ fontSize: '12.5px', fontWeight: 700, margin: '14px 0 8px', color: 'var(--t2)' }}>{t('net_op_requests', lang)}</h4>
      {requests.loading && <PhoenixLoadingState />}
      {!requests.loading && (requests.data ?? []).length === 0 && <PhoenixEmptyState icon="package" title={t('net_op_none', lang)} />}
      <div className="nexus-it-row-list" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {(requests.data ?? []).map(r => (
          <RequestRow key={r.id} label={r.requestNumber} status={r.status}
            sub={`${nameOf(whById.get(r.sourceWarehouseId), lang)} → ${nameOf(whById.get(r.destinationWarehouseId), lang)}`}
            onOpen={() => setOpenId(r.id)} lang={lang} />
        ))}
      </div>

      <h4 style={{ fontSize: '12.5px', fontWeight: 700, margin: '18px 0 8px', color: 'var(--t2)' }}>{t('net_op_incoming', lang)}</h4>
      {incoming.loading && <PhoenixLoadingState />}

      {RECEIVE_UPGRADE.enabled ? (
        <>
          {!incoming.loading && receiveDestinations.length === 0 && <PhoenixEmptyState icon="route" title={t('net_op_none', lang)} />}
          {receiveDestinations.length > 1 && (
            <div style={{ maxWidth: '360px', marginBottom: '10px' }}>
              <PhoenixSelect
                label={t('net_op_receive', lang)}
                value={effectiveReceiveDest}
                onChange={e => setReceiveDestId(e.target.value)}
                options={receiveDestinations.map(d => ({ value: d.id, label: `${d.institutionName} — ${d.warehouseName}` }))}
              />
            </div>
          )}
          {activeReceiveDest && (
            <InstitutionIncomingSupplies
              key={activeReceiveDest.id}
              destinationWarehouseId={activeReceiveDest.id}
              institutionName={activeReceiveDest.institutionName}
              warehouseName={activeReceiveDest.warehouseName}
              canReceive={canReceive}
            />
          )}
        </>
      ) : (
        <>
          {!incoming.loading && (incoming.data ?? []).length === 0 && <PhoenixEmptyState icon="route" title={t('net_op_none', lang)} />}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {(incoming.data ?? []).map(tr => (
              <IncomingTransferRow key={tr.id} lang={lang} transfer={tr} whById={whById}
                onDone={(res) => {
                  setStatus(res.ok ? { msg: t('net_op_done', lang), error: false } : { msg: opErrorMessage(res.error, lang), error: true });
                  if (res.ok) reload();
                }} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ForwardCreateForm({ lang, warehouses, onCancel, onDone }: {
  lang: Lang; warehouses: NetworkWarehouse[]; onCancel: () => void; onDone: (r: RpcResult) => void;
}) {
  const orgs = useAsync(() => getOrganizations(), []);
  const [orgId, setOrgId] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [targetId, setTargetId] = useState('');
  const [number, setNumber] = useState('');
  const [busy, setBusy] = useState(false);

  const centrals = warehouses.filter(w => w.warehouseKind === 'central' && w.status === 'active');
  const institutions = warehouses.filter(w => w.warehouseKind === 'institution' && w.status === 'active' && w.organizationId === orgId);
  const effSource = sourceId || (centrals[0]?.id ?? '');
  const effTarget = institutions.some(w => w.id === targetId) ? targetId : (institutions[0]?.id ?? '');
  const canSubmit = orgId !== '' && effSource !== '' && effTarget !== '' && number.trim() !== '' && !busy;
  const orgOptions = (orgs.data ?? []).map(o => ({ value: o.id, label: lang === 'ar' ? o.name_ar : o.name }));

  return (
    <PhoenixCard className="nexus-it-form-card" padding="16px" style={{ marginBottom: '10px', borderColor: 'var(--p)' }}>
      <p style={{ fontSize: '11.5px', color: 'var(--t2)', margin: '0 0 10px' }}>{t('net_ds_hint', lang)}</p>
      <div style={{ display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
        <PhoenixSelect label={t('net_ds_source', lang)} value={effSource} onChange={e => setSourceId(e.target.value)}
          options={centrals.map(w => ({ value: w.id, label: nameOf(w, lang) }))} />
        <PhoenixSelect label={t('net_ds_institution', lang)} value={orgId}
          options={[{ value: '', label: t('net_select_org_first', lang) }, ...orgOptions]}
          onChange={e => { setOrgId(e.target.value); setTargetId(''); }} />
        <PhoenixSelect label={t('net_ds_warehouse', lang)} value={effTarget} onChange={e => setTargetId(e.target.value)}
          options={institutions.map(w => ({ value: w.id, label: nameOf(w, lang) }))} />
        <PhoenixInput label={t('net_ds_number', lang)} value={number} onChange={e => setNumber(e.target.value)} />
      </div>
      {orgId !== '' && institutions.length === 0 && (
        <div style={{ marginTop: '10px' }}><PhoenixEmptyState icon="warehouse" title={t('net_ds_no_warehouses', lang)} /></div>
      )}
      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
        <PhoenixButton loading={busy} disabled={!canSubmit} onClick={async () => {
          setBusy(true);
          const res = await createDirectTransferRequest({
            sourceWarehouseId: effSource, destinationOrganizationId: orgId,
            destinationWarehouseId: effTarget, requestNumber: number.trim(),
          });
          setBusy(false); onDone(res);
        }}>{t('net_ds_create', lang)}</PhoenixButton>
        <PhoenixButton variant="ghost" onClick={onCancel}>{t('net_cancel', lang)}</PhoenixButton>
      </div>
    </PhoenixCard>
  );
}

function ForwardDetail({ lang, request, whById, orgNameById, onBack, onStatus, status }: {
  lang: Lang; request: TransferRequest; whById: Map<string, NetworkWarehouse>;
  orgNameById: Map<string, string>;
  onBack: () => void; onStatus: (s: Status) => void; status: Status;
}) {
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey(k => k + 1);
  const lines = useAsync(() => getTransferRequestLines(request.id), [reloadKey]);
  const stock = useAsync(() => getWarehouseStock(request.sourceWarehouseId), [reloadKey]);
  const isDraft = request.status === 'draft';
  const isSubmitted = request.status === 'submitted';
  const canSend = ['approved', 'partially_approved', 'partially_fulfilled'].includes(request.status);

  const set = (res: RpcResult, okKey = 'net_op_done') => {
    onStatus(res.ok ? { msg: t(okKey, lang), error: false } : { msg: opErrorMessage(res.error, lang), error: true });
    if (res.ok) reload();
  };

  // The request document, built ONLY from server-reloaded canonical rows (never
  // an unsaved draft). Watermarked honestly — a request is not a movement receipt.
  const requestDocument = useMemo(
    () => buildSupplyRequestReceipt({
      request,
      lines: lines.data ?? [],
      source: {
        organizationName: orgNameById.get(request.sourceOrganizationId) ?? null,
        warehouseName: nameOf(whById.get(request.sourceWarehouseId), lang),
      },
      destination: {
        organizationName: orgNameById.get(request.destinationOrganizationId) ?? null,
        warehouseName: nameOf(whById.get(request.destinationWarehouseId), lang),
      },
    }),
    [request, lines.data, orgNameById, whById, lang],
  );

  // TRANSFER-REGULATORY-ACK state: per-request, reset on navigation.
  const [regAck, setRegAck] = useState(false);
  const recordAck = async (action: 'transfer.create_ack' | 'transfer.review_ack') => {
    try {
      await supabase.rpc('phoenix_record_regulatory_ack', {
        p_entity_type: 'warehouse_transfer_request',
        p_entity_id: request.id,
        p_action: action,
      });
    } catch { /* best-effort audit record; the transfer RPC's own audit rows still capture the action */ }
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px', flexWrap: 'wrap' }}>
        <PhoenixButton size="sm" variant="ghost" onClick={onBack}>← {t('net_op_back', lang)}</PhoenixButton>
        <strong style={{ fontSize: '14px' }}>{request.requestNumber}</strong>
        <StatusBadge status={request.status} />
        <span style={{ fontSize: '11.5px', color: 'var(--t2)' }}>
          {nameOf(whById.get(request.sourceWarehouseId), lang)} → {nameOf(whById.get(request.destinationWarehouseId), lang)}
        </span>
      </div>

      {/* Receipt · genuine XLSX · QR — from the canonical request document above. */}
      {!lines.loading && (
        <div style={{ marginBottom: '10px' }}>
          <MovementDocumentActions document={requestDocument} lang={lang} />
        </div>
      )}

      <StatusLine status={status} />

      {isDraft && (
        <AddForwardLineForm lang={lang} requestId={request.id} onDone={(r) => set(r)} />
      )}

      {lines.loading && <PhoenixLoadingState />}
      {!lines.loading && (lines.data ?? []).length === 0 && <PhoenixEmptyState icon="file" title={t('net_op_none', lang)} />}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
        {(lines.data ?? []).map(l => (
          <ForwardLineRow key={l.id} lang={lang} line={l} isDraft={isDraft} canSend={canSend}
            stock={stock.data ?? []} onDone={set}
            organizationId={request.sourceOrganizationId} warehouseId={request.sourceWarehouseId} />
        ))}
      </div>

      {/* TRANSFER-REGULATORY-ACK: viewing needs nothing; CREATING (submit) or
          APPROVING (review) requires the explicit confirmation below. The ack
          is recorded in the audit trail (who/when) via
          phoenix_record_regulatory_ack and is NEVER an automated ruling that
          the transfer is permissible. */}
      {((isDraft || isSubmitted) && (lines.data ?? []).length > 0) && (
        <div style={{ marginTop: '14px', padding: '10px 14px', borderRadius: 'var(--r3)', background: 'var(--warn2)', border: '1px solid var(--warn)' }}>
          <p style={{ fontSize: '11.5px', color: 'var(--warn)', marginBottom: '8px' }} dir="auto">{t('ts_regulatory_notice', lang)}</p>
          <label style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '12px', cursor: 'pointer' }}>
            <input type="checkbox" checked={regAck} onChange={e => setRegAck(e.target.checked)} data-testid="transfer-reg-ack" />
            <span dir="auto">{t('ts_ack_checkbox', lang)}</span>
          </label>
          {!regAck && <p style={{ fontSize: '10.5px', color: 'var(--t2)', marginTop: '5px' }}>{t('ts_ack_required', lang)}</p>}
        </div>
      )}

      {isSubmitted && (lines.data ?? []).length > 0 && regAck && (
        <ReviewForm lang={lang} lines={lines.data ?? []}
          onSubmit={async (decisions) => {
            await recordAck('transfer.review_ack');
            return reviewTransferRequest(request.id, decisions).then(r => set(r));
          }} />
      )}

      <div style={{ display: 'flex', gap: '8px', marginTop: '14px', flexWrap: 'wrap' }}>
        {isDraft && (lines.data ?? []).length > 0 && (
          <PhoenixButton disabled={!regAck} onClick={async () => {
            if (!regAck) return;
            await recordAck('transfer.create_ack');
            set(await submitTransferRequest(request.id));
          }}>{t('net_op_submit', lang)}</PhoenixButton>
        )}
        {(isDraft || isSubmitted) && (
          <CancelControl lang={lang} onCancel={(reason) => cancelTransferRequest(request.id, reason).then(set)} />
        )}
      </div>
    </div>
  );
}

function AddForwardLineForm({ lang, requestId, onDone }: {
  lang: Lang; requestId: string; onDone: (r: RpcResult) => void;
}) {
  // REGISTERED-MATERIAL-ONLY: a transfer line is composed from a resolver
  // SELECTION, never from typed text. The selection carries the registered
  // identity (central item / concentration / dosage / unit) into the line.
  const [selected, setSelected] = useState<ResolvedMaterial | null>(null);
  const [qty, setQty] = useState('');
  const [busy, setBusy] = useState(false);
  const n = parseInt(qty, 10);
  const canAdd = selected !== null && Number.isFinite(n) && n > 0 && !busy;
  return (
    <PhoenixCard className="nexus-it-form-card" padding="12px 14px" style={{ marginBottom: '8px' }}>
      <div style={{ display: 'grid', gap: '8px' }}>
        {selected === null ? (
          <PhoenixMaterialResolver lang={lang} onSelect={setSelected} />
        ) : (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', fontSize: '12.5px', padding: '8px 12px', borderRadius: 'var(--r2)', background: 'var(--s2)', border: '1px solid var(--brd)' }}>
            <strong dir="auto">{selected.scientificName}{selected.tradeName ? ` (${selected.tradeName})` : ''}</strong>
            <PhoenixButton variant="ghost" size="sm" onClick={() => setSelected(null)}>✕</PhoenixButton>
          </div>
        )}
        <div style={{ display: 'grid', gap: '8px', gridTemplateColumns: '1fr auto', alignItems: 'end' }}>
          <PhoenixInput label={t('net_op_qty', lang)} type="number" value={qty} onChange={e => setQty(e.target.value)} />
          <PhoenixButton loading={busy} disabled={!canAdd} onClick={async () => {
            if (!selected) return;
            setBusy(true);
            const res = await addTransferRequestLine({
              transferRequestId: requestId,
              scientificName: selected.scientificName,
              requestedQuantity: n,
              centralItemId: selected.centralItemId,
              concentration: selected.concentration,
              dosageForm: selected.dosageForm,
              unit: selected.unit,
            });
            setBusy(false);
            if (res.ok) { setSelected(null); setQty(''); }
            onDone(res);
          }}>{t('net_op_add_line', lang)}</PhoenixButton>
        </div>
      </div>
    </PhoenixCard>
  );
}

function ForwardLineRow({ lang, line, isDraft, canSend, stock, onDone, organizationId, warehouseId }: {
  lang: Lang; line: TransferRequestLine; isDraft: boolean; canSend: boolean;
  stock: import('./network.service').WarehouseStockBatch[]; onDone: (r: RpcResult) => void;
  organizationId: string; warehouseId: string;
}) {
  const [editing, setEditing] = useState(false);
  const [sending, setSending] = useState(false);
  const [qty, setQty] = useState(String(line.requestedQuantity));
  const remaining = (line.approvedQuantity ?? 0) - line.fulfilledQuantity;
  const sendable = canSend && line.status !== 'rejected' && remaining > 0;

  return (
    <PhoenixCard className="nexus-it-row-card" padding="10px 14px">
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '13px', fontWeight: 600 }}>{line.scientificName}</div>
          <div style={{ fontSize: '11px', color: 'var(--t2)' }}>
            {t('net_op_requested_qty', lang)}: {line.requestedQuantity}
            {line.approvedQuantity != null && <> · {t('net_op_approved_qty', lang)}: {line.approvedQuantity}</>}
            {line.fulfilledQuantity > 0 && <> · {t('net_op_fulfilled_qty', lang)}: {line.fulfilledQuantity}</>}
          </div>
        </div>
        <StatusBadge status={line.status} />
        {isDraft && !editing && (
          <>
            <PhoenixButton size="sm" variant="ghost" onClick={() => setEditing(true)}>{t('net_op_edit', lang)}</PhoenixButton>
            <PhoenixButton size="sm" variant="danger" onClick={async () => onDone(await deleteTransferRequestLine(line.id))}>{t('net_op_delete', lang)}</PhoenixButton>
          </>
        )}
        {sendable && !sending && (
          <PhoenixButton size="sm" onClick={() => setSending(true)}>{t('net_op_send_line', lang)}</PhoenixButton>
        )}
      </div>

      {isDraft && editing && (
        <div style={{ display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'end' }}>
          <PhoenixInput label={t('net_op_qty', lang)} type="number" value={qty} onChange={e => setQty(e.target.value)} />
          <PhoenixButton size="sm" onClick={async () => {
            const n = parseInt(qty, 10);
            if (!Number.isFinite(n) || n <= 0) return;
            const res = await updateTransferRequestLine({ transferRequestLineId: line.id, requestedQuantity: n });
            setEditing(false); onDone(res);
          }}>{t('net_op_save', lang)}</PhoenixButton>
          <PhoenixButton size="sm" variant="ghost" onClick={() => setEditing(false)}>{t('net_cancel', lang)}</PhoenixButton>
        </div>
      )}

      {sending && (
        <SendForwardLineForm lang={lang} line={line} remaining={remaining} stock={stock}
          organizationId={organizationId} warehouseId={warehouseId}
          onCancel={() => setSending(false)}
          onDone={(r) => { setSending(false); onDone(r); }} />
      )}
    </PhoenixCard>
  );
}

function SendForwardLineForm({ lang, line, remaining, stock, organizationId, warehouseId, onCancel, onDone }: {
  lang: Lang; line: TransferRequestLine; remaining: number;
  stock: import('./network.service').WarehouseStockBatch[];
  organizationId: string; warehouseId: string;
  onCancel: () => void; onDone: (r: RpcResult) => void;
}) {
  const candidates = stock.filter(s => s.scientificName.toLowerCase() === line.scientificName.toLowerCase() && s.availableQuantity > 0);
  const [stockId, setStockId] = useState('');
  const [qty, setQty] = useState(String(remaining));
  const [number, setNumber] = useState('');
  const [busy, setBusy] = useState(false);
  // FEFO-REASONED-OVERRIDE-097/102/150 — Route 1's own guarded RPC already
  // enforces FEFO server-side (150); this dialog is the same preflight UX
  // Route 2 already has (FefoOverrideDialog.tsx / useFefoOverridePermission),
  // reused verbatim rather than building a second one.
  const [fefoPrompt, setFefoPrompt] = useState<{ picked: StockCandidate; alternatives: FefoBatch[] } | null>(null);
  const canOverrideFefo = useFefoOverridePermission(organizationId, warehouseId).data ?? false;
  const effStock = candidates.some(s => s.id === stockId) ? stockId : (candidates[0]?.id ?? '');
  const n = parseInt(qty, 10);
  const canSend = effStock !== '' && Number.isFinite(n) && n > 0 && n <= remaining && number.trim() !== '' && !busy;

  const doSend = async (fefoOverride: boolean, overrideReason: string | null) => {
    setBusy(true);
    const res = await runStockMutation(writeTransferSend, 'transfer_line_send', {
      entityId: line.id,
      generation: line.fulfilledQuantity,
      payload: {
        transferRequestId: line.transferRequestId, warehouseStockId: effStock,
        quantity: n, transferNumber: number.trim(), transferRequestLineId: line.id,
        fefoOverride, overrideReason,
      },
    });
    setBusy(false); onDone(res);
  };

  const handleSendClick = async () => {
    const picked = candidates.find(s => s.id === effStock);
    if (!picked) return;
    setBusy(true);
    let alternatives: FefoBatch[] = [];
    try {
      alternatives = await getFefoAlternatives(organizationId, warehouseId, picked.scientificName, picked.nationalCode);
    } catch { /* fail open to the RPC's own server-side gate — this is UX-preflight only */ }
    setBusy(false);
    const earliest = alternatives[0] ?? null;
    if (earliest !== null && earliest.stockId !== picked.id) {
      setFefoPrompt({
        picked: {
          warehouseStockId: picked.id, centralItemId: null, scientificName: picked.scientificName,
          tradeName: null, concentration: null, dosageForm: null, unit: null,
          nationalCode: picked.nationalCode, batchNumber: picked.batchNumber, internalBatchReference: null,
          expiryDate: picked.expiryDate, onHandQuantity: picked.onHandQuantity,
          reservedQuantity: picked.reservedQuantity, availableQuantity: picked.availableQuantity,
        },
        alternatives,
      });
      return;
    }
    await doSend(false, null);
  };

  return (
    <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--brd)' }}>
      {candidates.length === 0 ? (
        <PhoenixEmptyState icon="package" title={t('net_op_none', lang)} />
      ) : (
        <div style={{ display: 'grid', gap: '8px', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', alignItems: 'end' }}>
          <PhoenixSelect label={t('net_op_pick_batch', lang)} value={effStock} onChange={e => setStockId(e.target.value)}
            options={candidates.map(s => ({
              value: s.id,
              label: `${s.batchNumber ?? '—'} · ${t('net_op_expiry', lang)} ${s.expiryDate ?? '—'} · ${t('net_op_available', lang)} ${s.availableQuantity}`,
            }))} />
          <PhoenixInput label={t('net_op_qty', lang)} type="number" value={qty} onChange={e => setQty(e.target.value)} />
          <PhoenixInput label={t('net_op_number', lang)} value={number} onChange={e => setNumber(e.target.value)} />
          <div style={{ display: 'flex', gap: '6px' }}>
            <PhoenixButton size="sm" loading={busy} disabled={!canSend} onClick={() => void handleSendClick()}>
              {t('net_op_send', lang)}
            </PhoenixButton>
            <PhoenixButton size="sm" variant="ghost" onClick={onCancel}>{t('net_cancel', lang)}</PhoenixButton>
          </div>
        </div>
      )}

      <FefoOverrideDialog
        open={fefoPrompt !== null}
        picked={fefoPrompt?.picked ?? null}
        alternatives={fefoPrompt?.alternatives ?? []}
        canOverride={canOverrideFefo}
        onCancel={() => setFefoPrompt(null)}
        onConfirmOverride={(reason) => { setFefoPrompt(null); void doSend(true, reason); }}
        onUseAlternative={(stockIdToUse) => { setFefoPrompt(null); setStockId(stockIdToUse); }}
        lang={lang}
      />
    </div>
  );
}

function IncomingTransferRow({ lang, transfer, whById, onDone }: {
  lang: Lang; transfer: Transfer; whById: Map<string, NetworkWarehouse>; onDone: (r: RpcResult) => void;
}) {
  const [open, setOpen] = useState(false);
  const lines = useAsync(() => (open ? getTransferLines(transfer.id) : Promise.resolve([])), [open]);
  return (
    <PhoenixCard className="nexus-it-row-card" padding="10px 14px">
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '13px', fontWeight: 600 }}>{transfer.transferNumber}</div>
          <div style={{ fontSize: '11px', color: 'var(--t2)' }}>{nameOf(whById.get(transfer.destinationWarehouseId), lang)}</div>
        </div>
        <StatusBadge status={transfer.status} />
        <PhoenixButton size="sm" variant="ghost" onClick={() => setOpen(o => !o)}>{t('net_op_receive', lang)}</PhoenixButton>
      </div>
      {open && (
        <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {lines.loading && <PhoenixLoadingState />}
          {(lines.data ?? []).map(l => (
            <ReceiveLineForm key={l.id} lang={lang} label={`${l.scientificName} · ${l.batchNumber ?? '—'}`}
              sent={l.sentQuantity} done={l.status !== 'in_transit'}
              onReceive={(rq, reason) => runStockMutation(writeTransferReceive, 'transfer_line_receive', {
                entityId: l.id,
                generation: l.receivedQuantity ?? 0,
                payload: { transferLineId: l.id, receivedQuantity: rq, differenceReason: reason },
              }).then(onDone)} />
          ))}
        </div>
      )}
    </PhoenixCard>
  );
}

// ─── RETURN: institution → central ───────────────────────────────────────────

function ReturnPanel({ lang, warehouses, whById }: {
  lang: Lang; warehouses: NetworkWarehouse[]; whById: Map<string, NetworkWarehouse>;
}) {
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey(k => k + 1);
  const requests = useAsync(() => getReturnRequests(true), [reloadKey]);
  const incoming = useAsync(() => getReturnShipments(undefined, true), [reloadKey]);
  const orgs = useAsync(() => getOrganizations(), []);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const open = (requests.data ?? []).find(r => r.id === openId) ?? null;

  // Party data for the provenance-anchored composer — same RLS-scoped list. The
  // return source is an institution warehouse; the destination is a central one.
  const orgNameById = useMemo(
    () => new Map((orgs.data ?? []).map(o => [o.id, lang === 'ar' ? o.name_ar : o.name] as const)),
    [orgs.data, lang],
  );
  const institutionParties = useMemo<PartyOption[]>(
    () => warehouses
      .filter(w => w.warehouseKind === 'institution' && w.status === 'active')
      .map(w => ({
        id: w.id,
        organizationId: w.organizationId,
        organizationName: orgNameById.get(w.organizationId) ?? '—',
        warehouseName: lang === 'ar' ? (w.name_ar || w.name) : (w.name || w.name_ar),
      })),
    [warehouses, orgNameById, lang],
  );
  const centralWarehouses = useMemo(
    () => warehouses.filter(w => w.warehouseKind === 'central' && w.status === 'active'),
    [warehouses],
  );
  const organizationOptions = useMemo(
    () => (orgs.data ?? []).map(o => ({ id: o.id, name: lang === 'ar' ? o.name_ar : o.name })),
    [orgs.data, lang],
  );

  if (open) {
    return (
      <ReturnDetail lang={lang} request={open} whById={whById}
        onBack={() => { setOpenId(null); reload(); }} onStatus={setStatus} status={status} />
    );
  }

  // Draft-first return authoring takes over the panel; nothing is persisted until
  // the review step. Both request and recall modes live inside the composer.
  if (creating && RETURN_CREATE.draftFirst) {
    return (
      <DirectReturnComposer
        institutionWarehouses={institutionParties}
        organizations={organizationOptions}
        centralWarehouses={centralWarehouses}
        onCancel={() => setCreating(false)}
        onCreated={(returnRequestId) => {
          setCreating(false);
          setStatus({ msg: t('net_op_done', lang), error: false });
          reload();
          setOpenId(returnRequestId);
        }}
        onRecalled={() => {
          setCreating(false);
          setStatus({ msg: t('net_op_done', lang), error: false });
          reload();
        }}
      />
    );
  }

  return (
    <div>
      <div className="nexus-it-toolbar" style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
        <PhoenixButton onClick={() => setCreating(c => !c)}>{t('net_op_new', lang)}</PhoenixButton>
        <PhoenixButton variant="ghost" onClick={reload}>{t('net_op_refresh', lang)}</PhoenixButton>
      </div>

      <StatusLine status={status} />

      <h4 style={{ fontSize: '12.5px', fontWeight: 700, margin: '14px 0 8px', color: 'var(--t2)' }}>{t('net_op_requests', lang)}</h4>
      {requests.loading && <PhoenixLoadingState />}
      {!requests.loading && (requests.data ?? []).length === 0 && <PhoenixEmptyState icon="↩️" title={t('net_op_none', lang)} />}
      <div className="nexus-it-row-list" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {(requests.data ?? []).map(r => (
          <RequestRow key={r.id} label={r.returnNumber} status={r.status}
            sub={`${nameOf(whById.get(r.sourceWarehouseId), lang)} → ${nameOf(whById.get(r.destinationWarehouseId), lang)}`}
            onOpen={() => setOpenId(r.id)} lang={lang} />
        ))}
      </div>

      <h4 style={{ fontSize: '12.5px', fontWeight: 700, margin: '18px 0 8px', color: 'var(--t2)' }}>{t('net_op_incoming', lang)}</h4>
      {incoming.loading && <PhoenixLoadingState />}
      {!incoming.loading && (incoming.data ?? []).length === 0 && <PhoenixEmptyState icon="route" title={t('net_op_none', lang)} />}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {(incoming.data ?? []).map(sh => (
          <IncomingReturnRow key={sh.id} lang={lang} shipment={sh} whById={whById}
            onDone={(res) => {
              setStatus(res.ok ? { msg: t('net_op_done', lang), error: false } : { msg: opErrorMessage(res.error, lang), error: true });
              if (res.ok) reload();
            }} />
        ))}
      </div>
    </div>
  );
}

function ReturnDetail({ lang, request, whById, onBack, onStatus, status }: {
  lang: Lang; request: ReturnRequest; whById: Map<string, NetworkWarehouse>;
  onBack: () => void; onStatus: (s: Status) => void; status: Status;
}) {
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey(k => k + 1);
  const lines = useAsync(() => getReturnRequestLines(request.id), [reloadKey]);
  // Provenance candidates: direct transfer lines received at the return SOURCE warehouse.
  const transfers = useAsync(() => getTransfers(request.sourceWarehouseId, true), [reloadKey]);
  const isDraft = request.status === 'draft';
  const isSubmitted = request.status === 'submitted';
  const canSend = ['approved', 'partially_approved', 'partially_fulfilled'].includes(request.status);

  const set = (res: RpcResult) => {
    onStatus(res.ok ? { msg: t('net_op_done', lang), error: false } : { msg: opErrorMessage(res.error, lang), error: true });
    if (res.ok) reload();
  };

  // PAPER-REFERENCE-CONTRACT-110: no receipt document exists for this document
  // type (warehouse_return_request is a routed institution↔central corridor
  // distinct from outlet_return_request, which already carries its own
  // receipt) — so this detail view carries the field directly, editable
  // while still draft, read-only after (server-enforced regardless).
  const paperRef = useAsync(() => getPaperReference('warehouse_return_request', request.id), [reloadKey]);
  const [editingRef, setEditingRef] = useState(false);
  const [refDraft, setRefDraft] = useState<PaperReferenceValue>(EMPTY_PAPER_REFERENCE);
  const [refBusy, setRefBusy] = useState(false);

  return (
    <div>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px', flexWrap: 'wrap' }}>
        <PhoenixButton size="sm" variant="ghost" onClick={onBack}>← {t('net_op_back', lang)}</PhoenixButton>
        <strong style={{ fontSize: '14px' }}>{request.returnNumber}</strong>
        <StatusBadge status={request.status} />
        <span style={{ fontSize: '11.5px', color: 'var(--t2)' }}>
          {nameOf(whById.get(request.sourceWarehouseId), lang)} → {nameOf(whById.get(request.destinationWarehouseId), lang)}
        </span>
      </div>

      <div style={{ marginBottom: '10px' }}>
        {editingRef ? (
          <div style={{ display: 'grid', gap: '8px' }}>
            <PaperReferenceFields lang={lang} value={refDraft} onChange={setRefDraft} disabled={refBusy} />
            <div style={{ display: 'flex', gap: '8px' }}>
              <PhoenixButton size="sm" loading={refBusy} disabled={refDraft.number.trim() === ''} onClick={async () => {
                setRefBusy(true);
                await setPaperReference({
                  documentType: 'warehouse_return_request', documentId: request.id,
                  paperReferenceNumber: refDraft.number, paperReferenceDate: refDraft.date || null,
                  issuingAuthority: refDraft.authority || null,
                });
                setRefBusy(false);
                setEditingRef(false);
                reload();
              }}>{t('net_op_save', lang)}</PhoenixButton>
              <PhoenixButton size="sm" variant="ghost" disabled={refBusy} onClick={() => setEditingRef(false)}>{t('net_cancel', lang)}</PhoenixButton>
            </div>
          </div>
        ) : (
          <div style={{ fontSize: '11.5px', color: 'var(--t2)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span>{t('mv_h_paper_reference_number', lang)}: {paperReferenceSummary(paperRef.data)}</span>
            {isDraft && (
              <PhoenixButton size="sm" variant="ghost" onClick={() => {
                setRefDraft({
                  number: paperRef.data?.paperReferenceNumber ?? '',
                  date: paperRef.data?.paperReferenceDate ?? '',
                  authority: paperRef.data?.issuingAuthority ?? '',
                });
                setEditingRef(true);
              }}>{t('net_op_edit', lang)}</PhoenixButton>
            )}
          </div>
        )}
      </div>

      <StatusLine status={status} />

      {isDraft && (
        <AddReturnLineForm lang={lang} requestId={request.id}
          transfers={transfers.data ?? []} sourceWarehouseId={request.sourceWarehouseId} onDone={set} />
      )}

      {lines.loading && <PhoenixLoadingState />}
      {!lines.loading && (lines.data ?? []).length === 0 && <PhoenixEmptyState icon="file" title={t('net_op_none', lang)} />}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
        {(lines.data ?? []).map(l => (
          <ReturnLineRow key={l.id} lang={lang} line={l} isDraft={isDraft} canSend={canSend} onDone={set} />
        ))}
      </div>

      {isSubmitted && (lines.data ?? []).length > 0 && (
        <ReviewForm lang={lang}
          lines={(lines.data ?? []).map(l => ({ id: l.id, scientificName: l.scientificName, requestedQuantity: l.requestedQuantity }))}
          onSubmit={(decisions) => reviewReturnRequest(request.id, decisions).then(set)} />
      )}

      <div style={{ display: 'flex', gap: '8px', marginTop: '14px', flexWrap: 'wrap' }}>
        {isDraft && (lines.data ?? []).length > 0 && (
          <PhoenixButton onClick={async () => set(await submitReturnRequest(request.id))}>{t('net_op_submit', lang)}</PhoenixButton>
        )}
        {(isDraft || isSubmitted) && (
          <CancelControl lang={lang} onCancel={(reason) => cancelReturnRequest(request.id, reason).then(set)} />
        )}
      </div>
    </div>
  );
}

function AddReturnLineForm({ lang, requestId, transfers, sourceWarehouseId, onDone }: {
  lang: Lang; requestId: string; transfers: Transfer[]; sourceWarehouseId: string; onDone: (r: RpcResult) => void;
}) {
  // Flatten received lines of direct transfers into this institution warehouse —
  // one batched query, not one per transfer.
  const relevantIds = transfers.filter(tr => tr.destinationWarehouseId === sourceWarehouseId).map(tr => tr.id);
  const relevantKey = relevantIds.join(',');
  const linesByTransfer = useAsync(
    () => getTransferLinesForTransfers(relevantKey === '' ? [] : relevantKey.split(',')),
    [relevantKey],
  );
  const candidates = (linesByTransfer.data ?? []).filter(l => l.status !== 'in_transit');
  const [originalId, setOriginalId] = useState('');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState<string>(RETURN_REASON_CODES[0]);
  const [busy, setBusy] = useState(false);
  const effOriginal = candidates.some(c => c.id === originalId) ? originalId : (candidates[0]?.id ?? '');
  const n = parseInt(qty, 10);
  const canAdd = effOriginal !== '' && Number.isFinite(n) && n > 0 && !busy;

  return (
    <PhoenixCard className="nexus-it-form-card" padding="12px 14px" style={{ marginBottom: '8px' }}>
      {linesByTransfer.loading ? <PhoenixLoadingState /> : candidates.length === 0 ? (
        <PhoenixEmptyState icon="package" title={t('net_op_no_provenance', lang)} />
      ) : (
        <div style={{ display: 'grid', gap: '8px', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', alignItems: 'end' }}>
          <PhoenixSelect label={t('net_op_original_line', lang)} value={effOriginal} onChange={e => setOriginalId(e.target.value)}
            options={candidates.map(c => ({ value: c.id, label: `${c.scientificName} · ${c.batchNumber ?? '—'} · ${c.sentQuantity}` }))} />
          <PhoenixInput label={t('net_op_qty', lang)} type="number" value={qty} onChange={e => setQty(e.target.value)} />
          <PhoenixSelect label={t('net_op_reason_code', lang)} value={reason} onChange={e => setReason(e.target.value)}
            options={RETURN_REASON_CODES.map(code => ({ value: code, label: t(`net_op_reason_${code}`, lang) }))} />
          <PhoenixButton loading={busy} disabled={!canAdd} onClick={async () => {
            setBusy(true);
            const res = await addDirectReturnLine({ returnRequestId: requestId, originalTransferLineId: effOriginal, requestedQuantity: n, reasonCode: reason });
            setBusy(false);
            if (res.ok) setQty('');
            onDone(res);
          }}>{t('net_op_add_line', lang)}</PhoenixButton>
        </div>
      )}
    </PhoenixCard>
  );
}

function ReturnLineRow({ lang, line, isDraft, canSend, onDone }: {
  lang: Lang; line: ReturnRequestLine; isDraft: boolean; canSend: boolean; onDone: (r: RpcResult) => void;
}) {
  const [sending, setSending] = useState(false);
  const remaining = (line.approvedQuantity ?? 0) - line.fulfilledQuantity;
  const sendable = canSend && line.status !== 'rejected' && remaining > 0;
  const [qty, setQty] = useState(String(remaining));
  const [number, setNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const n = parseInt(qty, 10);
  const canDoSend = Number.isFinite(n) && n > 0 && n <= remaining && number.trim() !== '' && !busy;

  return (
    <PhoenixCard className="nexus-it-row-card" padding="10px 14px">
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '13px', fontWeight: 600 }}>{line.scientificName} · {line.batchNumber ?? '—'}</div>
          <div style={{ fontSize: '11px', color: 'var(--t2)' }}>
            {t('net_op_requested_qty', lang)}: {line.requestedQuantity}
            {line.approvedQuantity != null && <> · {t('net_op_approved_qty', lang)}: {line.approvedQuantity}</>}
            {line.fulfilledQuantity > 0 && <> · {t('net_op_fulfilled_qty', lang)}: {line.fulfilledQuantity}</>}
            {' · '}{t(`net_op_reason_${line.reasonCode}`, lang)}
          </div>
        </div>
        <StatusBadge status={line.status} />
        {isDraft && (
          <PhoenixButton size="sm" variant="danger" onClick={async () => onDone(await deleteReturnRequestLine(line.id))}>{t('net_op_delete', lang)}</PhoenixButton>
        )}
        {sendable && !sending && (
          <PhoenixButton size="sm" onClick={() => setSending(true)}>{t('net_op_send_line', lang)}</PhoenixButton>
        )}
      </div>
      {sending && (
        <div style={{ display: 'grid', gap: '8px', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', alignItems: 'end', marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--brd)' }}>
          <PhoenixInput label={t('net_op_qty', lang)} type="number" value={qty} onChange={e => setQty(e.target.value)} />
          <PhoenixInput label={t('net_op_number', lang)} value={number} onChange={e => setNumber(e.target.value)} />
          <div style={{ display: 'flex', gap: '6px' }}>
            <PhoenixButton size="sm" loading={busy} disabled={!canDoSend} onClick={async () => {
              setBusy(true);
              const res = await runStockMutation(writeReturnSend, 'return_line_send', {
                entityId: line.id,
                generation: line.fulfilledQuantity,
                payload: { returnRequestLineId: line.id, quantity: n, shipmentNumber: number.trim() },
              });
              setBusy(false); setSending(false); onDone(res);
            }}>{t('net_op_send', lang)}</PhoenixButton>
            <PhoenixButton size="sm" variant="ghost" onClick={() => setSending(false)}>{t('net_cancel', lang)}</PhoenixButton>
          </div>
        </div>
      )}
    </PhoenixCard>
  );
}

function IncomingReturnRow({ lang, shipment, whById, onDone }: {
  lang: Lang; shipment: ReturnShipment; whById: Map<string, NetworkWarehouse>; onDone: (r: RpcResult) => void;
}) {
  const [open, setOpen] = useState(false);
  const lines = useAsync(() => (open ? getReturnShipmentLines(shipment.id) : Promise.resolve([])), [open]);
  return (
    <PhoenixCard className="nexus-it-row-card" padding="10px 14px">
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '13px', fontWeight: 600 }}>{shipment.shipmentNumber}</div>
          <div style={{ fontSize: '11px', color: 'var(--t2)' }}>{nameOf(whById.get(shipment.destinationWarehouseId), lang)}</div>
        </div>
        <StatusBadge status={shipment.status} />
        <PhoenixButton size="sm" variant="ghost" onClick={() => setOpen(o => !o)}>{t('net_op_receive', lang)}</PhoenixButton>
      </div>
      {open && (
        <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {lines.loading && <PhoenixLoadingState />}
          {(lines.data ?? []).map(l => (
            <ReceiveReturnLineForm key={l.id} lang={lang} label={`${l.scientificName} · ${l.batchNumber ?? '—'}`}
              sent={l.sentQuantity} done={l.status !== 'in_transit'}
              onReceive={(rq, reason, disposition) => runStockMutation(writeReturnReceive, 'return_shipment_receive', {
                entityId: l.id,
                generation: l.receivedQuantity ?? 0,
                payload: {
                  shipmentLineId: l.id, receivedQuantity: rq,
                  differenceReason: reason, dispositionDecision: disposition,
                },
              }).then(onDone)} />
          ))}
        </div>
      )}
    </PhoenixCard>
  );
}

// ─── shared operational bits ─────────────────────────────────────────────────

function RequestRow({ label, status, sub, onOpen, lang }: {
  label: string; status: string; sub: string; onOpen: () => void; lang: Lang;
}) {
  return (
    <PhoenixCard className="nexus-it-row-card" padding="10px 14px">
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '13px', fontWeight: 700 }}>{label}</div>
          <div style={{ fontSize: '11px', color: 'var(--t2)' }}>{sub}</div>
        </div>
        <StatusBadge status={status} />
        <PhoenixButton size="sm" variant="ghost" onClick={onOpen}>{t('net_op_edit', lang)}</PhoenixButton>
      </div>
    </PhoenixCard>
  );
}

function ReviewForm({ lang, lines, onSubmit }: {
  lang: Lang;
  lines: Array<{ id: string; scientificName: string; requestedQuantity: number }>;
  onSubmit: (decisions: Array<{ line_id: string; approved_quantity: number }>) => void;
}) {
  const [vals, setVals] = useState<Record<string, string>>(() =>
    Object.fromEntries(lines.map(l => [l.id, String(l.requestedQuantity)])));
  const [busy, setBusy] = useState(false);
  return (
    <PhoenixCard padding="14px" style={{ marginTop: '12px', borderColor: 'var(--p)' }}>
      <div style={{ fontSize: '12.5px', fontWeight: 700, marginBottom: '8px' }}>{t('net_op_review', lang)}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {lines.map(l => (
          <div key={l.id} style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <span style={{ flex: 1, fontSize: '12.5px' }}>{l.scientificName}</span>
            <PhoenixInput type="number" value={vals[l.id] ?? ''} onChange={e => setVals(v => ({ ...v, [l.id]: e.target.value }))}
              style={{ maxWidth: '110px' }} />
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' }}>
        <PhoenixButton size="sm" variant="ghost"
          onClick={() => setVals(Object.fromEntries(lines.map(l => [l.id, String(l.requestedQuantity)])))}>
          {t('net_op_approve_all', lang)}
        </PhoenixButton>
        <PhoenixButton size="sm" loading={busy} onClick={async () => {
          const decisions = lines.map(l => ({ line_id: l.id, approved_quantity: Math.max(0, parseInt(vals[l.id] ?? '0', 10) || 0) }));
          setBusy(true); await onSubmit(decisions); setBusy(false);
        }}>{t('net_op_submit_review', lang)}</PhoenixButton>
      </div>
    </PhoenixCard>
  );
}

function CancelControl({ lang, onCancel }: { lang: Lang; onCancel: (reason: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  if (!open) return <PhoenixButton variant="danger" onClick={() => setOpen(true)}>{t('net_op_cancel_req', lang)}</PhoenixButton>;
  return (
    <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
      <PhoenixInput placeholder={t('net_op_cancel_reason', lang)} value={reason} onChange={e => setReason(e.target.value)} style={{ minWidth: '160px' }} />
      <PhoenixButton variant="danger" loading={busy} disabled={reason.trim() === ''} onClick={async () => {
        setBusy(true); await onCancel(reason.trim()); setBusy(false); setOpen(false); setReason('');
      }}>{t('net_op_cancel_req', lang)}</PhoenixButton>
      <PhoenixButton variant="ghost" onClick={() => setOpen(false)}>{t('net_cancel', lang)}</PhoenixButton>
    </div>
  );
}

function ReceiveLineForm({ lang, label, sent, done, onReceive }: {
  lang: Lang; label: string; sent: number; done: boolean; onReceive: (rq: number, reason: string | null) => void;
}) {
  const [qty, setQty] = useState(String(sent));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const n = parseInt(qty, 10);
  const needsReason = Number.isFinite(n) && n !== sent;
  const canReceive = Number.isFinite(n) && n >= 0 && n <= sent && (!needsReason || reason.trim() !== '') && !busy;
  if (done) return <div style={{ fontSize: '12px', color: 'var(--t2)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>{label} · <PhoenixIcon name="check" size={12} inline /></div>;
  return (
    <div style={{ display: 'grid', gap: '8px', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', alignItems: 'end' }}>
      <span style={{ fontSize: '12.5px', gridColumn: '1 / -1' }}>{label} ({sent})</span>
      <PhoenixInput label={t('net_op_received_qty', lang)} type="number" value={qty} onChange={e => setQty(e.target.value)} />
      {needsReason && <PhoenixInput label={t('net_op_diff_reason', lang)} value={reason} onChange={e => setReason(e.target.value)} />}
      <PhoenixButton size="sm" loading={busy} disabled={!canReceive} onClick={async () => {
        setBusy(true); await onReceive(n, needsReason ? reason.trim() : null); setBusy(false);
      }}>{t('net_op_receive', lang)}</PhoenixButton>
    </div>
  );
}

function ReceiveReturnLineForm({ lang, label, sent, done, onReceive }: {
  lang: Lang; label: string; sent: number; done: boolean;
  onReceive: (rq: number, reason: string | null, disposition: string | null) => void;
}) {
  const [qty, setQty] = useState(String(sent));
  const [reason, setReason] = useState('');
  const [disposition, setDisposition] = useState('');
  const [busy, setBusy] = useState(false);
  const n = parseInt(qty, 10);
  const needsReason = Number.isFinite(n) && n !== sent;
  const canReceive = Number.isFinite(n) && n >= 0 && n <= sent && (!needsReason || reason.trim() !== '') && !busy;
  if (done) return <div style={{ fontSize: '12px', color: 'var(--t2)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>{label} · <PhoenixIcon name="check" size={12} inline /></div>;
  return (
    <div style={{ display: 'grid', gap: '8px', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', alignItems: 'end' }}>
      <span style={{ fontSize: '12.5px', gridColumn: '1 / -1' }}>{label} ({sent})</span>
      <PhoenixInput label={t('net_op_received_qty', lang)} type="number" value={qty} onChange={e => setQty(e.target.value)} />
      {needsReason && <PhoenixInput label={t('net_op_diff_reason', lang)} value={reason} onChange={e => setReason(e.target.value)} />}
      {/* Disposition is REQUIRED only for the three fail-closed reasons; the server
          decides it deterministically for every mandatory-quarantine reason. Offering
          it always is harmless — it is ignored server-side when not consulted. */}
      <PhoenixSelect label={t('net_op_disposition', lang)} value={disposition} onChange={e => setDisposition(e.target.value)}
        options={[
          { value: '', label: '—' },
          { value: 'restockable', label: t('net_op_disp_restock', lang) },
          { value: 'quarantined', label: t('net_op_disp_quarantine', lang) },
        ]} />
      <PhoenixButton size="sm" loading={busy} disabled={!canReceive} onClick={async () => {
        setBusy(true); await onReceive(n, needsReason ? reason.trim() : null, disposition || null); setBusy(false);
      }}>{t('net_op_receive', lang)}</PhoenixButton>
    </div>
  );
}

// Re-export the fail-closed reason set for callers/tests that assert coverage.
export { RETURN_DISPOSITION_REASONS };
