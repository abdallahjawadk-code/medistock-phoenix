import { lazy, Suspense, useMemo, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';
import { PhoenixSelect } from '@/shared/ui/PhoenixSelect';
import { PhoenixToast } from '@/shared/ui/PhoenixToast';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixOrgScope } from '@/shared/ui/PhoenixOrgScope';
import { getWarehouseStock, type WarehouseStockBatch } from '@/features/network/network.service';
import { InstitutionIncomingSupplies } from '@/features/movement/InstitutionIncomingSupplies';
import { OutletDispatchOperations } from '@/features/outlet/OutletDispatchOperations';
import { InstitutionReturnReceipts } from '@/features/outlet/InstitutionReturnReceipts';
import { OutletReturnExceptions } from '@/features/outlet/OutletReturnExceptions';
import { getOrganizations } from '@/shared/supabase/services/organizations.service';
import { getAllCentralItems } from '@/shared/supabase/services/registry.service';
import { toCatalogMaterials } from './ocr/catalog-adapter';
import { useInventoryScopes } from './useInventoryScopes';
import { useWarehouseStockPermissions } from './useWarehouseStockPermissions';
import { useReturnReceivePermission } from './useReturnReceivePermission';
import { useOutletReturnExceptionResolvePermission } from './useOutletReturnExceptionResolvePermission';
import { useQuarantinePermission } from './useQuarantinePermission';
import { QuarantinePanel } from './QuarantinePanel';
import { useApproveCorrectionPermission } from './useApproveCorrectionPermission';
import { PendingCorrectionsPanel } from './PendingCorrectionsPanel';
import { SUPPLY_TYPES, supplyTypeLabelKey } from '@/shared/lib/supply-types';
import { isReplenishmentDestinationPointType } from '@/shared/lib/emergency-replenishment';
import { normalizedIncludes } from '@/shared/lib/search-normalize';
import { SourceBalancesPanel } from './SourceBalancesPanel';
import { getPaperReferencesFor } from '@/features/movement/paper-reference.service';
import { paperReferenceSummary } from '@/features/movement/ui/PaperReferenceFields';
import {
  receiveWarehouseStock, applyWarehouseStockMovement, getWarehouseStockMovements,
  getWarehouseReceiptLotGeneration, getWarehouseStockGeneration,
  newRequestId, classifyIntakeError, GENERATION_UNAVAILABLE_CODE,
  WAREHOUSE_ADJUSTMENT_TYPES, type WarehouseStockMovementType,
  type ReceiveWarehouseStockInput,
  requestWarehouseStockCorrection,
} from './warehouse-intake.service';
import type { SuggestionDocumentTarget } from './suggestion-document-navigation';

/**
 * INVENTORY-CENTER-INTAKE-A — the Inventory Management & Intake Center,
 * replacing the Availability Editor (screen 3).
 *
 * The editor let an operator type a quantity AND pick an availability
 * condition by hand, writing item_availability directly through
 * phoenix_upsert_availability. That made two competing sources of stock truth.
 * This screen has exactly one: the warehouse ledger. An operator states what
 * physically arrived or what physically moved; migration 065 posts the ledger
 * entry and migration 067 projects the resulting availability condition. There
 * is no condition dropdown here, and there never should be.
 *
 * Every permission gate below is UX convenience. The RPCs re-check warehouse
 * scope and permission server-side, so a mis-rendered button cannot become a
 * write.
 */

type Tab = 'intake' | 'stock' | 'ledger' | 'incoming' | 'dispatch' | 'returns' | 'return_exceptions' | 'quarantine' | 'corrections';

export function InventoryCenterScreen({
  initialSuggestionDocument,
}: {
  initialSuggestionDocument?: SuggestionDocumentTarget;
} = {}) {
  const { lang, dir, activeOrgId, role, myPermissions } = useApp();

  const scopes = useInventoryScopes(activeOrgId);
  const opensDispatch = initialSuggestionDocument?.documentKind === 'warehouse_dispatch';
  const [warehouseId, setWarehouseId] = useState(
    opensDispatch ? initialSuggestionDocument.sourceScopeId : '',
  );

  // §1 receiver reachability — the institution officer's incoming-supplies
  // surface lives HERE, gated on the real receive permission, so a receive-only
  // actor (no warehouse_transfer.send, hence no Network → Supply tab) can still
  // reach it. The RPC re-checks scope/permission server-side regardless.
  const canReceive = role === 'super_admin' || myPermissions.has('warehouse_transfer.receive');
  // §2 — institution-warehouse → outlet dispatch (070). Authoring is gated on
  // create; the send RPC re-checks warehouse_dispatch.send server-side.
  const canDispatch = role === 'super_admin' || myPermissions.has('warehouse_dispatch.create');
  const orgs = useAsync(() => getOrganizations(), []);

  const manageableWarehouses = scopes.data?.manageableWarehouses ?? [];
  // Never leave a stale warehouse selected after an org switch — the catalog is
  // refetched per organization and an id from the former org must not survive.
  const activeWarehouseId = manageableWarehouses.some(w => w.id === warehouseId) ? warehouseId : '';

  const perms = useWarehouseStockPermissions(activeOrgId, activeWarehouseId || null);
  const canAdjust = perms.data?.canAdjust ?? false;
  const canCorrect = perms.data?.canCorrect ?? false;

  // §071 — receiving OUTLET RETURNS into THIS warehouse. Gated on the exact
  // scoped key the receive RPC checks (outlet_stock.return_receive on the
  // destination warehouse), never a role name. The RPC re-checks server-side.
  const returnReceive = useReturnReceivePermission(activeOrgId, activeWarehouseId || null);
  const canReceiveReturns = returnReceive.data ?? false;

  // OUTLET-RETURN-EXCEPTION-RESOLUTION-157 — resolving stuck exception_pending
  // outlet-return lines at THIS warehouse. Gated on the distinct scoped key
  // 157's resolution RPC checks (outlet_stock.resolve_return_exception on the
  // destination warehouse), never a role name or the adjacent return_receive
  // key. The RPC re-checks server-side.
  const resolveException = useOutletReturnExceptionResolvePermission(activeOrgId, activeWarehouseId || null);
  const canResolveExceptions = resolveException.data ?? false;

  // QUARANTINE-DISPOSITION — gated on the exact scoped key 099's release/
  // destroy RPCs check (warehouse_transfer.return_request on the quarantine
  // row's own warehouse), matching 105's widened read policy.
  const quarantinePerm = useQuarantinePermission(activeOrgId, activeWarehouseId || null);
  const canDisposeQuarantine = quarantinePerm.data ?? false;

  // SECOND-PERSON-CORRECTION-APPROVAL — both keys are ORG-WIDE (never
  // warehouse/outlet-scoped), matching phoenix_status_center_authorized.
  const canApproveOutletCorrection = useApproveCorrectionPermission(activeOrgId, 'outlet_stock.approve_correction').data ?? false;
  const canApproveWarehouseCorrection = useApproveCorrectionPermission(activeOrgId, 'warehouse_stock.approve_correction').data ?? false;
  const canApproveAnyCorrection = canApproveOutletCorrection || canApproveWarehouseCorrection;

  const [tab, setTab] = useState<Tab>(opensDispatch ? 'dispatch' : 'intake');
  const [toast, setToast] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const stock = useAsync<WarehouseStockBatch[]>(
    () => (activeWarehouseId ? getWarehouseStock(activeWarehouseId) : Promise.resolve([])),
    [activeWarehouseId, reloadKey],
  );

  const warehouseOptions = useMemo(
    () => manageableWarehouses.map(w => ({
      value: w.id,
      label: lang === 'ar' ? (w.nameAr || w.name) : (w.name || w.nameAr),
    })),
    [manageableWarehouses, lang],
  );

  // Cosmetic paired-identity for the incoming-supplies header (institution — depot).
  const institutionName = useMemo(() => {
    const o = (orgs.data ?? []).find(x => x.id === activeOrgId);
    return o ? (lang === 'ar' ? o.name_ar : o.name) : '';
  }, [orgs.data, activeOrgId, lang]);
  const activeWarehouseName = warehouseOptions.find(o => o.value === activeWarehouseId)?.label ?? '';
  // CLOSED-CUSTODY-102-B: an institution warehouse receives ONLY from pharmacy-
  // department (central) stores via the canonical transfer/return receive
  // corridors — never by hand-typed or OCR-assisted entry. The server enforces
  // this unconditionally (migration 103); this is the UX reflection of that
  // same rule, not the authority for it.
  const activeWarehouseKind = manageableWarehouses.find(w => w.id === activeWarehouseId)?.warehouseKind ?? null;
  const isInstitutionWarehouse = activeWarehouseKind === 'institution';
  // Outlets belonging to the selected institution warehouse (parent link), and
  // within the officer's manageable scope — the only valid ORDINARY dispatch
  // destinations.
  //
  // R1.2 / Migration 180: emergency outlets (crash cabinet, rescue cart) are
  // excluded here. Warehouse/depot direct supply to them is legal ONLY through
  // the dedicated initial-provisioning corridor, which has its own entry point
  // (InitialProvisioningLauncher -> phoenix_create_initial_provisioning_dispatch);
  // thereafter they are supplied by routine pharmacy->emergency replenishment
  // (Migration 168). Offering one here would offer an action the server now
  // always refuses with emergency_outlet_requires_initial_provisioning.
  //
  // This filter is UX, NOT the security boundary. The authority boundary is
  // enforced in the database by Migration 180 for every caller, including ones
  // that never go through this screen.
  const outletsForWarehouse = useMemo(
    () => (scopes.data?.manageableOutlets ?? [])
      .filter(o => o.warehouseId === activeWarehouseId)
      .filter(o => !isReplenishmentDestinationPointType(o.pointType))
      .map(o => ({ id: o.id, name: lang === 'ar' ? (o.nameAr || o.name) : (o.name || o.nameAr) })),
    [scopes.data, activeWarehouseId, lang],
  );

  const header = (
    <div className="nexus-it-header" style={{ marginBottom: '16px' }}>
      <div className="nexus-it-header__row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
        <div className="nexus-it-header__titles">
          <h2 className="nexus-it-header__title" style={{ fontSize: '22px', fontWeight: 700, letterSpacing: '-.3px' }}>{t('inv_center_title', lang)}</h2>
          <p className="nexus-it-header__subtitle" style={{ fontSize: '12.5px', color: 'var(--t2)', marginTop: '3px' }}>{t('inv_center_sub', lang)}</p>
        </div>
        {/* A super_admin's profile has organization_id = null, so without this
            selector activeOrgId stays null, the warehouse catalog comes back
            empty, and the screen dead-ends on "no warehouse permissions".
            Every other org-scoped screen already uses this control. */}
        <PhoenixOrgScope />
      </div>
    </div>
  );

  if (!activeOrgId) {
    return (
      <div dir={dir} className="nexus-inventory-transfers nexus-inventory-transfers--center">
        {header}
        <PhoenixEmptyState icon="hospital" title={t('no_org_scope', lang)} description={t('empty_hint', lang)} />
      </div>
    );
  }

  if (scopes.loading) return <div dir={dir} className="nexus-inventory-transfers nexus-inventory-transfers--center">{header}<PhoenixLoadingState /></div>;

  if (manageableWarehouses.length === 0) {
    return (
      <div dir={dir} className="nexus-inventory-transfers nexus-inventory-transfers--center">
        {header}
        <PhoenixEmptyState icon="🔒" title={t('inv_center_denied', lang)} />
      </div>
    );
  }

  // PhoenixToast is a passive announcer with no dismiss affordance — every
  // call site in this codebase clears it on a timer, so this screen does too.
  const showToast = (messageKey: string) => {
    setToast(t(messageKey, lang));
    setTimeout(() => setToast(null), 4000);
  };

  const afterWrite = (messageKey: string) => {
    showToast(messageKey);
    setReloadKey(k => k + 1);
  };

  // 078 generation conflict: the canonical lot moved under the operator. Reload
  // the canonical stock so the retry is composed against fresh truth — the
  // retry itself stays an EXPLICIT operator act, never automatic.
  const reloadCanonicalStock = () => setReloadKey(k => k + 1);

  return (
    <div dir={dir} className="nexus-inventory-transfers nexus-inventory-transfers--center">
      {header}

      <PhoenixCard className="nexus-it-context-bar">
        <PhoenixSelect
          label={t('inv_warehouse', lang)}
          value={activeWarehouseId}
          onChange={e => setWarehouseId(e.target.value)}
          options={[{ value: '', label: t('inv_select_warehouse', lang) }, ...warehouseOptions]}
        />
        {activeWarehouseId && !perms.loading && !canAdjust && !canCorrect && (
          <p className="nexus-it-context-bar__hint" style={{ fontSize: '12px', color: 'var(--warn)', marginTop: '8px' }}>
            {t('inv_read_only_scope', lang)}
          </p>
        )}
      </PhoenixCard>

      <div role="tablist" className="nexus-it-tabs" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', margin: '16px 0' }}>
        {([
          { id: 'intake' as const, labelKey: 'inv_tab_intake' },
          { id: 'stock' as const, labelKey: 'inv_tab_stock' },
          { id: 'ledger' as const, labelKey: 'inv_tab_ledger' },
          // Shown only to holders of the receive permission — the authoritative
          // institution incoming-supplies receipt entry.
          ...(canReceive ? [{ id: 'incoming' as const, labelKey: 'inv_tab_incoming' }] : []),
          // §2 — institution-warehouse → outlet dispatch, for dispatch authorizers.
          ...(canDispatch ? [{ id: 'dispatch' as const, labelKey: 'inv_tab_dispatch' }] : []),
          // §071 — receiving outlet returns into this warehouse, for holders of
          // the scoped outlet_stock.return_receive permission on it.
          ...(canReceiveReturns ? [{ id: 'returns' as const, labelKey: 'inv_tab_return_receipts' }] : []),
          // OUTLET-RETURN-EXCEPTION-RESOLUTION-157 — resolving stuck
          // exception_pending lines, for holders of the scoped
          // outlet_stock.resolve_return_exception permission on it.
          ...(canResolveExceptions ? [{ id: 'return_exceptions' as const, labelKey: 'inv_tab_return_exceptions' }] : []),
          // QUARANTINE-DISPOSITION — for holders of the scoped
          // warehouse_transfer.return_request permission on it (099/105).
          ...(canDisposeQuarantine ? [{ id: 'quarantine' as const, labelKey: 'inv_tab_quarantine' }] : []),
          // SECOND-PERSON-CORRECTION-APPROVAL — org-wide, for holders of
          // outlet_stock.approve_correction and/or warehouse_stock.approve_correction (098/101).
          ...(canApproveAnyCorrection ? [{ id: 'corrections' as const, labelKey: 'cor_pending_title' }] : []),
        ]).map(x => (
          <button
            key={x.id}
            role="tab"
            aria-selected={tab === x.id}
            onClick={() => setTab(x.id)}
            className="nexus-it-tab"
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

      <div className="nexus-it-notice" style={{ background: 'var(--p2)', border: '1px solid var(--p)', borderRadius: 'var(--r3)', padding: '12px 14px', fontSize: '12px', color: 'var(--pd)', marginBottom: '16px' }}>
        {t('inv_derived_notice', lang)}
      </div>

      <div className="nexus-it-content">
      {!activeWarehouseId ? (
        <PhoenixEmptyState icon="📦" title={t('inv_select_warehouse', lang)} />
      ) : tab === 'intake' ? (
        isInstitutionWarehouse ? (
          <PhoenixEmptyState
            icon="🔒"
            title={t('inv_institution_intake_blocked_title', lang)}
            description={t('inv_institution_intake_blocked_description', lang)}
          />
        ) : (
          <IntakeTab
            warehouseId={activeWarehouseId}
            canSubmit={canAdjust}
            lang={lang}
            stock={stock.data ?? []}
            onSuccess={afterWrite}
            onError={showToast}
            onConflictReload={reloadCanonicalStock}
          />
        )
      ) : tab === 'stock' ? (
        <div className="nexus-it-stock-panel" style={{ display: 'grid', gap: '12px' }}>
        {/* SOURCE-BALANCES-PANEL (088): fail-closed readiness gate inside. */}
        <SourceBalancesPanel warehouseId={activeWarehouseId} />
        <StockList
          state={stock}
          lang={lang}
          canAdjust={canAdjust}
          canCorrect={canCorrect}
          isInstitutionWarehouse={isInstitutionWarehouse}
          onSuccess={afterWrite}
          onError={showToast}
          onConflictReload={reloadCanonicalStock}
        />
        </div>
      ) : tab === 'incoming' && canReceive ? (
        <InstitutionIncomingSupplies
          destinationWarehouseId={activeWarehouseId}
          institutionName={institutionName}
          warehouseName={activeWarehouseName}
          canReceive={canReceive}
        />
      ) : tab === 'dispatch' && canDispatch ? (
        <OutletDispatchOperations
          warehouseId={activeWarehouseId}
          warehouseName={activeWarehouseName}
          outlets={outletsForWarehouse}
          canDispatch={canDispatch}
          lang={lang}
          initialDispatchId={
            opensDispatch ? initialSuggestionDocument.documentId : undefined
          }
        />
      ) : tab === 'returns' && canReceiveReturns ? (
        <InstitutionReturnReceipts
          destinationWarehouseId={activeWarehouseId}
          warehouseName={activeWarehouseName}
          canReceive={canReceiveReturns}
          lang={lang}
        />
      ) : tab === 'return_exceptions' && canResolveExceptions ? (
        <OutletReturnExceptions
          destinationWarehouseId={activeWarehouseId}
          warehouseName={activeWarehouseName}
          canResolve={canResolveExceptions}
          lang={lang}
        />
      ) : tab === 'quarantine' && canDisposeQuarantine ? (
        <QuarantinePanel warehouseId={activeWarehouseId} canDispose={canDisposeQuarantine} />
      ) : tab === 'corrections' && canApproveAnyCorrection ? (
        <PendingCorrectionsPanel
          canApproveOutlet={canApproveOutletCorrection}
          canApproveWarehouse={canApproveWarehouseCorrection}
        />
      ) : (
        <LedgerList batches={stock.data ?? []} lang={lang} />
      )}
      </div>

      {toast && <PhoenixToast message={toast} />}
    </div>
  );
}

// ─── Intake tab: manual entry, with OCR as an optional assist ────────────────

interface IntakeTabProps {
  warehouseId: string;
  canSubmit: boolean;
  lang: 'ar' | 'en';
  stock: WarehouseStockBatch[];
  onSuccess: (messageKey: string) => void;
  onError: (messageKey: string) => void;
  /** 078 generation conflict — reload canonical stock; retry stays explicit. */
  onConflictReload: () => void;
}

/**
 * PHARMA-OCR-A: manual entry is the default and is ALWAYS available — the OCR
 * flow is opened deliberately and can be abandoned back to this form at any
 * point. OcrIntakeFlow is lazily imported so neither the OCR code nor the
 * Tesseract engine is present in this screen's chunk until an operator asks
 * for it.
 */
const OcrIntakeFlow = lazy(() =>
  import('./ocr/OcrIntakeFlow').then(module => ({ default: module.OcrIntakeFlow })),
);

function IntakeTab({ warehouseId, canSubmit, lang, stock, onSuccess, onError, onConflictReload }: IntakeTabProps) {
  const [mode, setMode] = useState<'manual' | 'ocr'>('manual');

  // The authorized catalog is fetched only when OCR is opened — matching data
  // is useless to the manual form and would be a wasted round trip.
  const catalog = useAsync(
    () => (mode === 'ocr' ? getAllCentralItems().then(toCatalogMaterials) : Promise.resolve([])),
    [mode],
  );

  const existingBatches = useMemo(
    () => stock.map(batch => ({
      warehouseStockId: batch.id,
      warehouseId: batch.warehouseId,
      scientificName: batch.scientificName,
      nationalCode: batch.nationalCode,
      batchNumber: batch.batchNumber,
      expiryDate: batch.expiryDate,
      onHandQuantity: batch.onHandQuantity,
    })),
    [stock],
  );

  if (mode === 'ocr') {
    return (
      <Suspense fallback={<PhoenixLoadingState />}>
        <OcrIntakeFlow
          warehouseId={warehouseId}
          catalog={catalog.data ?? []}
          existingBatches={existingBatches}
          canSubmitIntake={canSubmit}
          onCancel={() => setMode('manual')}
          onSubmitted={onSuccess}
          onConflict={onConflictReload}
        />
      </Suspense>
    );
  }

  return (
    <>
      <div style={{ marginBottom: '10px' }}>
        <PhoenixButton variant="ghost" onClick={() => setMode('ocr')} disabled={!canSubmit}>
          {t('ocr_open', lang)}
        </PhoenixButton>
      </div>
      <IntakeForm
        warehouseId={warehouseId}
        canSubmit={canSubmit}
        lang={lang}
        onSuccess={onSuccess}
        onError={onError}
        onConflictReload={onConflictReload}
      />
    </>
  );
}

// ─── Manual intake ───────────────────────────────────────────────────────────

interface IntakeFormProps {
  warehouseId: string;
  canSubmit: boolean;
  lang: 'ar' | 'en';
  onSuccess: (messageKey: string) => void;
  onError: (messageKey: string) => void;
  /** 078 generation conflict — reload canonical stock; retry stays explicit. */
  onConflictReload: () => void;
}

/**
 * The manual entry path. `requestId` is minted once per in-progress entry and
 * held across retries: if the first submit times out, pressing the button again
 * replays the SAME idempotency key, and migration 065 returns the original
 * result instead of posting the quantity a second time. A fresh key is minted
 * after a confirmed success clears the form — and by `touch()` whenever ANY
 * payload field is edited, because a changed payload is a NEW logical attempt,
 * not a retry of the previous one (the server's request fingerprint would
 * reject the mismatch anyway; the fresh key makes the intent explicit).
 *
 * 078 discipline: submit performs a FRESH canonical generation read of the
 * exact lot identity the server resolves, immediately before the post. An
 * absent lot is generation 0 (a first receipt); a failed read refuses without
 * calling any writer and never degrades to 0 or null.
 */
function IntakeForm({ warehouseId, canSubmit, lang, onSuccess, onError, onConflictReload }: IntakeFormProps) {
  const [requestId, setRequestId] = useState(newRequestId);
  const [scientificName, setScientificName] = useState('');
  const [tradeName, setTradeName] = useState('');
  const [concentration, setConcentration] = useState('');
  const [dosageForm, setDosageForm] = useState('');
  const [unit, setUnit] = useState('');
  const [quantity, setQuantity] = useState('');
  const [nationalCode, setNationalCode] = useState('');
  const [noNationalCode, setNoNationalCode] = useState(false);
  const [batchNumber, setBatchNumber] = useState('');
  const [noBatchNumber, setNoBatchNumber] = useState(false);
  const [expiryDate, setExpiryDate] = useState('');
  const [unitPrice, setUnitPrice] = useState('');
  const [supplyType, setSupplyType] = useState('');
  const [sourceDocument, setSourceDocument] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);

  const qty = Number(quantity);
  const quantityValid = Number.isInteger(qty) && qty > 0;
  const supplyTypeValid = supplyType !== '';
  // Mirrors migration 065's explicit_identity_flags_required / *_flag_mismatch
  // checks so the operator is told BEFORE a round trip. The RPC still enforces it.
  const identityResolved =
    (noNationalCode ? nationalCode.trim() === '' : nationalCode.trim() !== '')
    && (noBatchNumber ? batchNumber.trim() === '' : batchNumber.trim() !== '');
  const formValid = scientificName.trim() !== '' && quantityValid && identityResolved && supplyTypeValid;

  const reset = () => {
    setRequestId(newRequestId());
    setScientificName(''); setTradeName(''); setConcentration(''); setDosageForm('');
    setUnit(''); setQuantity(''); setNationalCode(''); setNoNationalCode(false);
    setBatchNumber(''); setNoBatchNumber(false); setExpiryDate(''); setUnitPrice('');
    setSupplyType(''); setSourceDocument(''); setNotes('');
    setAttempted(false);
  };

  /**
   * Editing ANY payload field starts a NEW logical attempt with its own
   * idempotency key. Only an UNCHANGED resubmit (a lost-response retry) keeps
   * the previous key so migration 065 can replay it instead of double-posting.
   */
  const touch = () => setRequestId(newRequestId());

  const submit = async () => {
    setAttempted(true);
    if (!formValid || busy) return;
    setBusy(true);
    try {
      const base: Omit<ReceiveWarehouseStockInput, 'expectedGeneration'> = {
        requestId,
        warehouseId,
        scientificName: scientificName.trim(),
        quantity: qty,
        hasNoNationalCode: noNationalCode,
        hasNoBatchNumber: noBatchNumber,
        centralItemId: null,
        tradeName: tradeName.trim() || null,
        concentration: concentration.trim() || null,
        dosageForm: dosageForm.trim() || null,
        unit: unit.trim() || null,
        nationalCode: nationalCode.trim() || null,
        batchNumber: batchNumber.trim() || null,
        expiryDate: expiryDate || null,
        unitPrice: unitPrice.trim() === '' ? null : Number(unitPrice),
        supplyType,
        purchaseOrigin: supplyType === 'purchase' ? 'central' : null,
        sourceDocumentNumber: sourceDocument.trim() || null,
        notes: notes.trim() || null,
      };
      // Fresh canonical generation read, immediately before the post. A failed
      // read refuses here — it never reaches a writer and never becomes 0.
      const generation = await getWarehouseReceiptLotGeneration(base);
      if (!generation.ok) {
        onError(classifyIntakeError(GENERATION_UNAVAILABLE_CODE));
        return;
      }
      const result = await receiveWarehouseStock({ ...base, expectedGeneration: generation.generation });
      if (result.ok) {
        onSuccess(result.data?.replayed ? 'inv_intake_replayed' : 'inv_intake_ok');
        reset();
      } else {
        const errorKey = classifyIntakeError(result.error);
        onError(errorKey);
        // The canonical lot moved between the read and the post: reload the
        // canonical view and leave the retry to an explicit operator act.
        if (errorKey === 'inv_err_generation_conflict') onConflictReload();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <PhoenixCard>
      <p style={{ fontSize: '12px', color: 'var(--t2)', margin: '0 0 12px' }}>
        {t('inv_central_manual_note', lang)}
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 220px), 1fr))', gap: '12px' }}>
        <PhoenixInput
          label={t('inv_scientific_name', lang)}
          value={scientificName}
          onChange={e => { setScientificName(e.target.value); touch(); }}
          error={attempted && !scientificName.trim() ? t('inv_err_invalid', lang) : undefined}
        />
        <PhoenixInput label={t('inv_trade_name', lang)} value={tradeName} onChange={e => { setTradeName(e.target.value); touch(); }} />
        <PhoenixInput label={t('inv_concentration', lang)} value={concentration} onChange={e => { setConcentration(e.target.value); touch(); }} />
        <PhoenixInput label={t('inv_dosage_form', lang)} value={dosageForm} onChange={e => { setDosageForm(e.target.value); touch(); }} />
        <PhoenixInput label={t('inv_unit', lang)} value={unit} onChange={e => { setUnit(e.target.value); touch(); }} />
        <PhoenixInput
          label={t('inv_quantity_received', lang)}
          type="number"
          min={1}
          step={1}
          value={quantity}
          onChange={e => { setQuantity(e.target.value); touch(); }}
          error={attempted && !quantityValid ? t('inv_err_qty_positive', lang) : undefined}
        />
        <PhoenixInput
          label={t('inv_national_code', lang)}
          value={nationalCode}
          disabled={noNationalCode}
          onChange={e => { setNationalCode(e.target.value); touch(); }}
        />
        <PhoenixInput
          label={t('inv_batch_number', lang)}
          value={batchNumber}
          disabled={noBatchNumber}
          onChange={e => { setBatchNumber(e.target.value); touch(); }}
        />
        <PhoenixInput label={t('inv_expiry_date', lang)} type="date" value={expiryDate} onChange={e => { setExpiryDate(e.target.value); touch(); }} />
        <PhoenixInput label={t('inv_unit_price', lang)} type="number" min={0} step="0.01" value={unitPrice} onChange={e => { setUnitPrice(e.target.value); touch(); }} />
        {/* CANONICAL-SUPPLY-PROVENANCE-088: CLOSED three-value vocabulary — never
            free text. A 'purchase' at a pharmacy-department warehouse is saved
            as a CENTRAL purchase server-side. */}
        <div>
          <PhoenixSelect
            label={t('inv_supply_type', lang)}
            value={supplyType}
            onChange={e => { setSupplyType(e.target.value); touch(); }}
            options={[
              { value: '', label: '—' },
              ...SUPPLY_TYPES.map(x => ({ value: x, label: t(supplyTypeLabelKey(x), lang) })),
            ]}
          />
          {supplyType === 'purchase' && (
            <p style={{ fontSize: '11px', color: 'var(--t2)', marginTop: '4px' }}>
              {t('st_purchase_central_note', lang)}
            </p>
          )}
          {attempted && !supplyTypeValid && (
            <p style={{ fontSize: '11px', color: 'var(--err)', marginTop: '4px' }}>
              {t('inv_err_invalid', lang)}
            </p>
          )}
        </div>
        <PhoenixInput label={t('inv_source_document', lang)} value={sourceDocument} onChange={e => { setSourceDocument(e.target.value); touch(); }} />
      </div>

      {/* Explicit acknowledgements — a blank field is NOT read as "none exists". */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', minHeight: '44px' }}>
          <input
            type="checkbox"
            checked={noNationalCode}
            onChange={e => { setNoNationalCode(e.target.checked); if (e.target.checked) setNationalCode(''); touch(); }}
          />
          {t('inv_no_national_code', lang)}
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', minHeight: '44px' }}>
          <input
            type="checkbox"
            checked={noBatchNumber}
            onChange={e => { setNoBatchNumber(e.target.checked); if (e.target.checked) setBatchNumber(''); touch(); }}
          />
          {t('inv_no_batch_number', lang)}
        </label>
      </div>

      <PhoenixInput label={t('inv_notes', lang)} value={notes} onChange={e => { setNotes(e.target.value); touch(); }} />

      {attempted && !identityResolved && (
        <p style={{ fontSize: '12px', color: 'var(--err)', marginTop: '8px' }}>
          {t('inv_err_identity_flags_required', lang)}
        </p>
      )}

      <div style={{ marginTop: '14px' }}>
        <PhoenixButton onClick={submit} disabled={!canSubmit || busy}>
          {busy ? t('inv_retry_intake', lang) : t('inv_submit_intake', lang)}
        </PhoenixButton>
      </div>
    </PhoenixCard>
  );
}

// ─── Warehouse stock + correction movements ──────────────────────────────────

interface StockListProps {
  state: { data: WarehouseStockBatch[] | null; loading: boolean };
  lang: 'ar' | 'en';
  canAdjust: boolean;
  canCorrect: boolean;
  /** CLOSED-CUSTODY-102-B: institution warehouses may only ever be corrected
   *  (second-person-approval-gated, migration 101), never freely add/subtract/
   *  set_exact'd — that quantity must come from a canonical receive corridor. */
  isInstitutionWarehouse: boolean;
  onSuccess: (messageKey: string) => void;
  onError: (messageKey: string) => void;
  /** 078 generation conflict — reload canonical stock; retry stays explicit. */
  onConflictReload: () => void;
}

function StockList({ state, lang, canAdjust, canCorrect, isInstitutionWarehouse, onSuccess, onError, onConflictReload }: StockListProps) {
  // MATERIAL-SMART-SEARCH: one normalized query over the four identity fields
  // (scientific, trade, national code, batch) — AR/EN, hamza/taa/diacritic
  // folding, case-insensitive; the query is NEVER treated as a new material.
  const [query, setQuery] = useState('');
  if (state.loading) return <PhoenixLoadingState />;
  const batches = (state.data ?? []).filter(b =>
    !query.trim()
    || normalizedIncludes(b.scientificName ?? '', query)
    || normalizedIncludes(b.nationalCode ?? '', query)
    || normalizedIncludes(b.batchNumber ?? '', query));
  if ((state.data ?? []).length === 0) return <PhoenixEmptyState icon="📭" title={t('inv_no_stock', lang)} />;

  return (
    <div className="nexus-it-stock-list" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <input
        type="search"
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder={t('inv_stock_search', lang)}
        aria-label={t('inv_stock_search', lang)}
        className="premium-field nexus-it-search"
        dir="auto"
        style={{ width: '100%', padding: '10px 12px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', fontSize: '13px' }}
      />
      {batches.length === 0 && <PhoenixEmptyState icon="search" title={t('cc_palette_no_results', lang)} />}
      <div className="nexus-it-batch-list">
      {batches.map(b => (
        <BatchRow
          key={b.id}
          batch={b}
          lang={lang}
          canAdjust={canAdjust}
          canCorrect={canCorrect}
          isInstitutionWarehouse={isInstitutionWarehouse}
          onSuccess={onSuccess}
          onError={onError}
          onConflictReload={onConflictReload}
        />
      ))}
      </div>
    </div>
  );
}

interface BatchRowProps {
  batch: WarehouseStockBatch;
  lang: 'ar' | 'en';
  canAdjust: boolean;
  canCorrect: boolean;
  isInstitutionWarehouse: boolean;
  onSuccess: (messageKey: string) => void;
  onError: (messageKey: string) => void;
  /** 078 generation conflict — reload canonical stock; retry stays explicit. */
  onConflictReload: () => void;
}

function BatchRow({ batch, lang, canAdjust, canCorrect, isInstitutionWarehouse, onSuccess, onError, onConflictReload }: BatchRowProps) {
  const [open, setOpen] = useState(false);
  const [requestId, setRequestId] = useState(newRequestId);
  const [movementType, setMovementType] = useState<WarehouseStockMovementType>('add');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const amountNum = Number(amount);
  const needsReason = movementType === 'correction' || movementType === 'set_exact';
  const amountValid = Number.isInteger(amountNum) && (needsReason ? amountNum >= 0 : amountNum > 0);
  const valid = amountValid && (!needsReason || reason.trim() !== '');

  // 'correction' is only offered to warehouse_stock.correct holders; add/subtract
  // need warehouse_stock.adjust. The RPC picks the same key server-side.
  // CLOSED-CUSTODY-102-B: at an institution warehouse, add/subtract/set_exact
  // would invent or erase quantity outside any canonical corridor — the server
  // (migration 103) refuses them unconditionally there, so only 'correction'
  // is ever offered for this batch's row.
  const allowedTypes = WAREHOUSE_ADJUSTMENT_TYPES.filter(x => {
    if (isInstitutionWarehouse && x !== 'correction') return false;
    return x === 'correction' ? canCorrect : canAdjust;
  });

  /** A changed payload is a NEW logical attempt; only an unchanged retry replays. */
  const touch = () => setRequestId(newRequestId());

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      // Fresh canonical generation read of THIS lot, immediately before the
      // post (078). A failed read refuses without calling any writer.
      const generation = await getWarehouseStockGeneration(batch.id);
      if (!generation.ok) {
        onError(classifyIntakeError(GENERATION_UNAVAILABLE_CODE));
        return;
      }

      // SECOND-PERSON-CORRECTION-APPROVAL (101): 'correction' NEVER goes
      // through the raw apply RPC directly — that would bypass the
      // approval gate entirely. add/subtract keep the existing path (a
      // different concept: recording physical movement, not adjudicating a
      // discrepancy), and remain unreachable at institution warehouses
      // regardless (103).
      if (movementType === 'correction') {
        const result = await requestWarehouseStockCorrection({
          requestId,
          warehouseStockId: batch.id,
          newQuantity: amountNum,
          reason: reason.trim(),
          expectedGeneration: generation.generation,
        });
        if (result.ok) {
          onSuccess(result.data?.requires_approval ? 'inv_correction_pending' : 'inv_movement_ok');
          setRequestId(newRequestId());
          setAmount(''); setReason(''); setOpen(false);
        } else {
          const errorKey = classifyIntakeError(result.error);
          onError(errorKey);
          if (errorKey === 'inv_err_generation_conflict') onConflictReload();
        }
        return;
      }

      const result = await applyWarehouseStockMovement({
        requestId,
        warehouseStockId: batch.id,
        movementType,
        amount: amountNum,
        reason: reason.trim() || null,
        expectedGeneration: generation.generation,
      });
      if (result.ok) {
        onSuccess('inv_movement_ok');
        setRequestId(newRequestId());
        setAmount(''); setReason(''); setOpen(false);
      } else {
        const errorKey = classifyIntakeError(result.error);
        onError(errorKey);
        // The canonical lot moved between the read and the post: reload and
        // leave the retry to an explicit operator act.
        if (errorKey === 'inv_err_generation_conflict') onConflictReload();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <PhoenixCard className="nexus-it-batch-row">
      <div className="nexus-it-batch-row__head" style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <div className="nexus-it-batch-row__id">
          <div className="nexus-it-batch-row__name" style={{ fontSize: '13.5px', fontWeight: 700 }}>{batch.scientificName}</div>
          <div className="nexus-it-batch-row__meta" style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '2px' }}>
            {[batch.batchNumber, batch.nationalCode, batch.expiryDate].filter(Boolean).join(' · ') || '—'}
          </div>
        </div>
        <div className="nexus-it-batch-row__stats" style={{ display: 'flex', gap: '14px', fontSize: '12px' }}>
          <span className="nexus-it-stat nexus-it-stat--onhand">{t('inv_on_hand', lang)}: <strong>{batch.onHandQuantity}</strong></span>
          <span className="nexus-it-stat nexus-it-stat--reserved">{t('inv_reserved', lang)}: <strong>{batch.reservedQuantity}</strong></span>
          <span className={`nexus-it-stat nexus-it-stat--available${batch.availableQuantity === 0 ? ' nexus-it-stat--zero' : ''}`}>{t('inv_available', lang)}: <strong>{batch.availableQuantity}</strong></span>
        </div>
      </div>

      {allowedTypes.length > 0 && (
        <div style={{ marginTop: '10px' }}>
          <PhoenixButton variant="ghost" onClick={() => setOpen(o => !o)}>
            {t('inv_movement', lang)}
          </PhoenixButton>
        </div>
      )}

      {open && allowedTypes.length > 0 && (
        <div className="nexus-it-movement-form" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 200px), 1fr))', gap: '10px', marginTop: '10px' }}>
          <PhoenixSelect
            label={t('inv_movement', lang)}
            value={movementType}
            onChange={e => { setMovementType(e.target.value as WarehouseStockMovementType); touch(); }}
            options={allowedTypes.map(x => ({
              value: x,
              label: t(x === 'add' ? 'inv_mv_add' : x === 'subtract' ? 'inv_mv_subtract' : 'inv_mv_correction', lang),
            }))}
          />
          <PhoenixInput
            label={t('inv_amount', lang)}
            type="number"
            min={needsReason ? 0 : 1}
            step={1}
            value={amount}
            onChange={e => { setAmount(e.target.value); touch(); }}
          />
          <PhoenixInput
            label={t('inv_reason', lang)}
            value={reason}
            onChange={e => { setReason(e.target.value); touch(); }}
            error={needsReason && reason.trim() === '' ? t('inv_err_reason_required', lang) : undefined}
          />
          <div style={{ display: 'flex', alignItems: 'flex-end' }}>
            <PhoenixButton onClick={submit} disabled={!valid || busy}>
              {t('inv_apply_movement', lang)}
            </PhoenixButton>
          </div>
        </div>
      )}
    </PhoenixCard>
  );
}

// ─── Ledger ──────────────────────────────────────────────────────────────────

function LedgerList({ batches, lang }: { batches: WarehouseStockBatch[]; lang: 'ar' | 'en' }) {
  const [batchId, setBatchId] = useState('');
  const activeBatchId = batches.some(b => b.id === batchId) ? batchId : '';
  const movements = useAsync(
    () => (activeBatchId ? getWarehouseStockMovements(activeBatchId) : Promise.resolve([])),
    [activeBatchId],
  );
  // PAPER-REFERENCE-CONTRACT-110: one batched read for every movement row
  // shown, never a per-row lookup (this list can be up to 100 rows deep —
  // see getWarehouseStockMovements' own cap).
  const movementIds = useMemo(() => (movements.data ?? []).map(m => m.id), [movements.data]);
  const paperRefs = useAsync(
    () => getPaperReferencesFor('warehouse_stock_movement', movementIds),
    [movementIds.join(',')],
  );

  return (
    <PhoenixCard className="nexus-it-ledger">
      <PhoenixSelect
        label={t('inv_tab_ledger', lang)}
        value={activeBatchId}
        onChange={e => setBatchId(e.target.value)}
        options={[
          { value: '', label: '—' },
          ...batches.map(b => ({
            value: b.id,
            label: [b.scientificName, b.batchNumber].filter(Boolean).join(' · '),
          })),
        ]}
      />
      {movements.loading ? <PhoenixLoadingState />
        : (movements.data ?? []).length === 0
          ? <PhoenixEmptyState icon="🗒️" title={t('inv_no_movements', lang)} />
          : (
            <ul className="nexus-it-ledger-list" style={{ listStyle: 'none', padding: 0, margin: '12px 0 0', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {(movements.data ?? []).map(m => (
                <li key={m.id} className="nexus-it-ledger-row" style={{ fontSize: '12px', borderBottom: '1px solid var(--brd)', paddingBottom: '8px' }}>
                  <strong>{m.movementType}</strong> {m.quantityBefore} → {m.quantityAfter}
                  {' · '}{new Date(m.createdAt).toLocaleString(lang === 'ar' ? 'ar' : 'en')}
                  {m.actorNameSnapshot ? ` · ${m.actorNameSnapshot}` : ''}
                  {m.reason ? ` · ${m.reason}` : ''}
                  {' · '}{t('mv_h_paper_reference_number', lang)}: {paperReferenceSummary(paperRefs.data?.get(m.id))}
                </li>
              ))}
            </ul>
          )}
    </PhoenixCard>
  );
}
