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
import { getOrganizations } from '@/shared/supabase/services/organizations.service';
import { getAllCentralItems } from '@/shared/supabase/services/registry.service';
import { toCatalogMaterials } from './ocr/catalog-adapter';
import { useInventoryScopes } from './useInventoryScopes';
import { useWarehouseStockPermissions } from './useWarehouseStockPermissions';
import {
  receiveWarehouseStock, applyWarehouseStockMovement, getWarehouseStockMovements,
  newRequestId, classifyIntakeError,
  WAREHOUSE_ADJUSTMENT_TYPES, type WarehouseStockMovementType,
} from './warehouse-intake.service';

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

type Tab = 'intake' | 'stock' | 'ledger' | 'incoming';

export function InventoryCenterScreen() {
  const { lang, dir, activeOrgId, role, myPermissions } = useApp();

  const scopes = useInventoryScopes(activeOrgId);
  const [warehouseId, setWarehouseId] = useState('');

  // §1 receiver reachability — the institution officer's incoming-supplies
  // surface lives HERE, gated on the real receive permission, so a receive-only
  // actor (no warehouse_transfer.send, hence no Network → Supply tab) can still
  // reach it. The RPC re-checks scope/permission server-side regardless.
  const canReceive = role === 'super_admin' || myPermissions.has('warehouse_transfer.receive');
  const orgs = useAsync(() => getOrganizations(), []);

  const manageableWarehouses = scopes.data?.manageableWarehouses ?? [];
  // Never leave a stale warehouse selected after an org switch — the catalog is
  // refetched per organization and an id from the former org must not survive.
  const activeWarehouseId = manageableWarehouses.some(w => w.id === warehouseId) ? warehouseId : '';

  const perms = useWarehouseStockPermissions(activeOrgId, activeWarehouseId || null);
  const canAdjust = perms.data?.canAdjust ?? false;
  const canCorrect = perms.data?.canCorrect ?? false;

  const [tab, setTab] = useState<Tab>('intake');
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

  const header = (
    <div style={{ marginBottom: '16px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
        <div>
          <h2 style={{ fontSize: '22px', fontWeight: 700, letterSpacing: '-.3px' }}>{t('inv_center_title', lang)}</h2>
          <p style={{ fontSize: '12.5px', color: 'var(--t2)', marginTop: '3px' }}>{t('inv_center_sub', lang)}</p>
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
      <div dir={dir}>
        {header}
        <PhoenixEmptyState icon="hospital" title={t('no_org_scope', lang)} description={t('empty_hint', lang)} />
      </div>
    );
  }

  if (scopes.loading) return <div dir={dir}>{header}<PhoenixLoadingState /></div>;

  if (manageableWarehouses.length === 0) {
    return (
      <div dir={dir}>
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

  return (
    <div dir={dir}>
      {header}

      <PhoenixCard>
        <PhoenixSelect
          label={t('inv_warehouse', lang)}
          value={activeWarehouseId}
          onChange={e => setWarehouseId(e.target.value)}
          options={[{ value: '', label: t('inv_select_warehouse', lang) }, ...warehouseOptions]}
        />
        {activeWarehouseId && !perms.loading && !canAdjust && !canCorrect && (
          <p style={{ fontSize: '12px', color: 'var(--warn)', marginTop: '8px' }}>
            {t('inv_read_only_scope', lang)}
          </p>
        )}
      </PhoenixCard>

      <div role="tablist" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', margin: '16px 0' }}>
        {([
          { id: 'intake' as const, labelKey: 'inv_tab_intake' },
          { id: 'stock' as const, labelKey: 'inv_tab_stock' },
          { id: 'ledger' as const, labelKey: 'inv_tab_ledger' },
          // Shown only to holders of the receive permission — the authoritative
          // institution incoming-supplies receipt entry.
          ...(canReceive ? [{ id: 'incoming' as const, labelKey: 'inv_tab_incoming' }] : []),
        ]).map(x => (
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

      <div style={{ background: 'var(--p2)', border: '1px solid var(--p)', borderRadius: 'var(--r3)', padding: '12px 14px', fontSize: '12px', color: 'var(--pd)', marginBottom: '16px' }}>
        {t('inv_derived_notice', lang)}
      </div>

      {!activeWarehouseId ? (
        <PhoenixEmptyState icon="📦" title={t('inv_select_warehouse', lang)} />
      ) : tab === 'intake' ? (
        <IntakeTab
          warehouseId={activeWarehouseId}
          canSubmit={canAdjust}
          lang={lang}
          stock={stock.data ?? []}
          onSuccess={afterWrite}
          onError={showToast}
        />
      ) : tab === 'stock' ? (
        <StockList
          state={stock}
          lang={lang}
          canAdjust={canAdjust}
          canCorrect={canCorrect}
          onSuccess={afterWrite}
          onError={showToast}
        />
      ) : tab === 'incoming' && canReceive ? (
        <InstitutionIncomingSupplies
          destinationWarehouseId={activeWarehouseId}
          institutionName={institutionName}
          warehouseName={activeWarehouseName}
          canReceive={canReceive}
        />
      ) : (
        <LedgerList batches={stock.data ?? []} lang={lang} />
      )}

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

function IntakeTab({ warehouseId, canSubmit, lang, stock, onSuccess, onError }: IntakeTabProps) {
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
}

/**
 * The manual entry path. `requestId` is minted once per in-progress entry and
 * held across retries: if the first submit times out, pressing the button again
 * replays the SAME idempotency key, and migration 065 returns the original
 * result instead of posting the quantity a second time. A fresh key is minted
 * only after a confirmed success clears the form.
 */
function IntakeForm({ warehouseId, canSubmit, lang, onSuccess, onError }: IntakeFormProps) {
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
  // Mirrors migration 065's explicit_identity_flags_required / *_flag_mismatch
  // checks so the operator is told BEFORE a round trip. The RPC still enforces it.
  const identityResolved =
    (noNationalCode ? nationalCode.trim() === '' : nationalCode.trim() !== '')
    && (noBatchNumber ? batchNumber.trim() === '' : batchNumber.trim() !== '');
  const formValid = scientificName.trim() !== '' && quantityValid && identityResolved;

  const reset = () => {
    setRequestId(newRequestId());
    setScientificName(''); setTradeName(''); setConcentration(''); setDosageForm('');
    setUnit(''); setQuantity(''); setNationalCode(''); setNoNationalCode(false);
    setBatchNumber(''); setNoBatchNumber(false); setExpiryDate(''); setUnitPrice('');
    setSupplyType(''); setSourceDocument(''); setNotes('');
    setAttempted(false);
  };

  const submit = async () => {
    setAttempted(true);
    if (!formValid || busy) return;
    setBusy(true);
    try {
      const result = await receiveWarehouseStock({
        requestId,
        warehouseId,
        scientificName,
        quantity: qty,
        hasNoNationalCode: noNationalCode,
        hasNoBatchNumber: noBatchNumber,
        tradeName: tradeName.trim() || null,
        concentration: concentration.trim() || null,
        dosageForm: dosageForm.trim() || null,
        unit: unit.trim() || null,
        nationalCode: nationalCode.trim() || null,
        batchNumber: batchNumber.trim() || null,
        expiryDate: expiryDate || null,
        unitPrice: unitPrice.trim() === '' ? null : Number(unitPrice),
        supplyType: supplyType.trim() || null,
        sourceDocumentNumber: sourceDocument.trim() || null,
        notes: notes.trim() || null,
      });
      if (result.ok) {
        onSuccess(result.data?.replayed ? 'inv_intake_replayed' : 'inv_intake_ok');
        reset();
      } else {
        onError(classifyIntakeError(result.error));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <PhoenixCard>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 220px), 1fr))', gap: '12px' }}>
        <PhoenixInput
          label={t('inv_scientific_name', lang)}
          value={scientificName}
          onChange={e => setScientificName(e.target.value)}
          error={attempted && !scientificName.trim() ? t('inv_err_invalid', lang) : undefined}
        />
        <PhoenixInput label={t('inv_trade_name', lang)} value={tradeName} onChange={e => setTradeName(e.target.value)} />
        <PhoenixInput label={t('inv_concentration', lang)} value={concentration} onChange={e => setConcentration(e.target.value)} />
        <PhoenixInput label={t('inv_dosage_form', lang)} value={dosageForm} onChange={e => setDosageForm(e.target.value)} />
        <PhoenixInput label={t('inv_unit', lang)} value={unit} onChange={e => setUnit(e.target.value)} />
        <PhoenixInput
          label={t('inv_quantity_received', lang)}
          type="number"
          min={1}
          step={1}
          value={quantity}
          onChange={e => setQuantity(e.target.value)}
          error={attempted && !quantityValid ? t('inv_err_qty_positive', lang) : undefined}
        />
        <PhoenixInput
          label={t('inv_national_code', lang)}
          value={nationalCode}
          disabled={noNationalCode}
          onChange={e => setNationalCode(e.target.value)}
        />
        <PhoenixInput
          label={t('inv_batch_number', lang)}
          value={batchNumber}
          disabled={noBatchNumber}
          onChange={e => setBatchNumber(e.target.value)}
        />
        <PhoenixInput label={t('inv_expiry_date', lang)} type="date" value={expiryDate} onChange={e => setExpiryDate(e.target.value)} />
        <PhoenixInput label={t('inv_unit_price', lang)} type="number" min={0} step="0.01" value={unitPrice} onChange={e => setUnitPrice(e.target.value)} />
        <PhoenixInput label={t('inv_supply_type', lang)} value={supplyType} onChange={e => setSupplyType(e.target.value)} />
        <PhoenixInput label={t('inv_source_document', lang)} value={sourceDocument} onChange={e => setSourceDocument(e.target.value)} />
      </div>

      {/* Explicit acknowledgements — a blank field is NOT read as "none exists". */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', minHeight: '44px' }}>
          <input
            type="checkbox"
            checked={noNationalCode}
            onChange={e => { setNoNationalCode(e.target.checked); if (e.target.checked) setNationalCode(''); }}
          />
          {t('inv_no_national_code', lang)}
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', minHeight: '44px' }}>
          <input
            type="checkbox"
            checked={noBatchNumber}
            onChange={e => { setNoBatchNumber(e.target.checked); if (e.target.checked) setBatchNumber(''); }}
          />
          {t('inv_no_batch_number', lang)}
        </label>
      </div>

      <PhoenixInput label={t('inv_notes', lang)} value={notes} onChange={e => setNotes(e.target.value)} />

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
  onSuccess: (messageKey: string) => void;
  onError: (messageKey: string) => void;
}

function StockList({ state, lang, canAdjust, canCorrect, onSuccess, onError }: StockListProps) {
  if (state.loading) return <PhoenixLoadingState />;
  const batches = state.data ?? [];
  if (batches.length === 0) return <PhoenixEmptyState icon="📭" title={t('inv_no_stock', lang)} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {batches.map(b => (
        <BatchRow
          key={b.id}
          batch={b}
          lang={lang}
          canAdjust={canAdjust}
          canCorrect={canCorrect}
          onSuccess={onSuccess}
          onError={onError}
        />
      ))}
    </div>
  );
}

interface BatchRowProps {
  batch: WarehouseStockBatch;
  lang: 'ar' | 'en';
  canAdjust: boolean;
  canCorrect: boolean;
  onSuccess: (messageKey: string) => void;
  onError: (messageKey: string) => void;
}

function BatchRow({ batch, lang, canAdjust, canCorrect, onSuccess, onError }: BatchRowProps) {
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
  const allowedTypes = WAREHOUSE_ADJUSTMENT_TYPES.filter(
    x => (x === 'correction' ? canCorrect : canAdjust),
  );

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const result = await applyWarehouseStockMovement({
        requestId,
        warehouseStockId: batch.id,
        movementType,
        amount: amountNum,
        reason: reason.trim() || null,
      });
      if (result.ok) {
        onSuccess('inv_movement_ok');
        setRequestId(newRequestId());
        setAmount(''); setReason(''); setOpen(false);
      } else {
        onError(classifyIntakeError(result.error));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <PhoenixCard>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: '13.5px', fontWeight: 700 }}>{batch.scientificName}</div>
          <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '2px' }}>
            {[batch.batchNumber, batch.nationalCode, batch.expiryDate].filter(Boolean).join(' · ') || '—'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '14px', fontSize: '12px' }}>
          <span>{t('inv_on_hand', lang)}: <strong>{batch.onHandQuantity}</strong></span>
          <span>{t('inv_reserved', lang)}: <strong>{batch.reservedQuantity}</strong></span>
          <span>{t('inv_available', lang)}: <strong>{batch.availableQuantity}</strong></span>
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
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 200px), 1fr))', gap: '10px', marginTop: '10px' }}>
          <PhoenixSelect
            label={t('inv_movement', lang)}
            value={movementType}
            onChange={e => setMovementType(e.target.value as WarehouseStockMovementType)}
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
            onChange={e => setAmount(e.target.value)}
          />
          <PhoenixInput
            label={t('inv_reason', lang)}
            value={reason}
            onChange={e => setReason(e.target.value)}
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

  return (
    <PhoenixCard>
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
            <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {(movements.data ?? []).map(m => (
                <li key={m.id} style={{ fontSize: '12px', borderBottom: '1px solid var(--brd)', paddingBottom: '8px' }}>
                  <strong>{m.movementType}</strong> {m.quantityBefore} → {m.quantityAfter}
                  {' · '}{new Date(m.createdAt).toLocaleString(lang === 'ar' ? 'ar' : 'en')}
                  {m.actorNameSnapshot ? ` · ${m.actorNameSnapshot}` : ''}
                  {m.reason ? ` · ${m.reason}` : ''}
                </li>
              ))}
            </ul>
          )}
    </PhoenixCard>
  );
}
