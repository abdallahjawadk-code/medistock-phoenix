/**
 * SUBPURCHASE-DIRECT-ENTRY (089) — the simple supplementary-purchase entry.
 *
 * One human-confirmed act records a material the institution ALREADY bought
 * into its own warehouse: material (registered-only, via the unified
 * resolver — or fresh identity typed HERE, the ONE screen besides the
 * Inventory Center allowed to register), batch, expiry, quantity, price,
 * purchase date, invoice/reference, optional supplier, notes. No order/
 * supplier/approval workflow is shown; provenance is pinned SERVER-side to
 * purchase/supplementary — no supply-type field exists here.
 *
 * Safety: requestId idempotency (kept across a lost-response retry, re-minted
 * on any payload edit), mandatory human confirmation, official server
 * numbers in the result, and a fail-closed readiness gate — against a
 * pre-089 production the submit refuses with an explicit "awaiting migration"
 * message (RPC absent → 42883/PGRST202).
 */
import { useEffect, useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { supabase, supabaseConfigured } from '@/shared/supabase/client';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixMaterialResolver } from '@/shared/materials/PhoenixMaterialResolver';
import type { ResolvedMaterial } from '@/shared/materials/material-resolver.service';
import { newRequestId, getDuplicateCandidates, type DuplicateCandidate } from './procurement.service';

interface Props {
  lang: 'ar' | 'en';
  warehouseId: string;
  onDone: (messageKey: string) => void;
}

interface EntryResult {
  ok: boolean;
  idempotent_replay?: boolean;
  order_number?: string;
  receipt_number?: string;
}

export function DirectEntryPanel({ lang, warehouseId, onDone }: Props) {
  const [requestId, setRequestId] = useState(() => newRequestId());
  const [material, setMaterial] = useState<ResolvedMaterial | null>(null);
  const [newIdentity, setNewIdentity] = useState(false);
  const [scientificName, setScientificName] = useState('');
  const [tradeName, setTradeName] = useState('');
  const [concentration, setConcentration] = useState('');
  const [dosageForm, setDosageForm] = useState('');
  const [unit, setUnit] = useState('');
  const [nationalCode, setNationalCode] = useState('');
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[]>([]);
  const [batch, setBatch] = useState('');
  const [noBatch, setNoBatch] = useState(false);
  const [expiry, setExpiry] = useState('');
  const [qty, setQty] = useState('');
  const [price, setPrice] = useState('');
  const [purchaseDate, setPurchaseDate] = useState('');
  const [invoice, setInvoice] = useState('');
  const [supplier, setSupplier] = useState('');
  const [notes, setNotes] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EntryResult | null>(null);

  /** Any payload edit = a NEW logical attempt (fresh idempotency key). */
  const touch = () => { setRequestId(newRequestId()); setConfirmed(false); };

  const effectiveName = material?.scientificName ?? (newIdentity ? scientificName.trim() : '');
  const qtyN = parseInt(qty, 10);
  const valid = effectiveName !== ''
    && Number.isFinite(qtyN) && qtyN > 0
    && (noBatch ? batch.trim() === '' : batch.trim() !== '')
    && confirmed && !busy;

  // 117 — advisory-only duplicate suggestion while typing a NEW identity.
  // Never blocks submission; purely a "did you mean...?" hint.
  useEffect(() => {
    if (!newIdentity || material !== null || scientificName.trim().length < 2) {
      setDuplicates([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void getDuplicateCandidates(warehouseId, scientificName, tradeName, nationalCode)
        .then(rows => { if (!cancelled) setDuplicates(rows); });
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [newIdentity, material, warehouseId, scientificName, tradeName, nationalCode]);

  async function submit() {
    if (!valid || !supabaseConfigured) return;
    setBusy(true);
    setError(null);
    const { data, error: rpcError } = await supabase.rpc('phoenix_subpurchase_direct_entry', {
      p_request_id: requestId,
      p_warehouse_id: warehouseId,
      p_scientific_name: effectiveName,
      p_quantity: qtyN,
      p_batch_number: batch.trim() || null,
      p_has_no_batch: noBatch,
      p_expiry_date: expiry || null,
      p_unit_price: price.trim() === '' ? null : Number(price),
      p_purchase_date: purchaseDate || null,
      p_invoice_number: invoice.trim() || null,
      p_supplier_name: supplier.trim() || null,
      p_notes: notes.trim() || null,
      p_central_item_id: material?.centralItemId ?? null,
      p_trade_name: (material?.tradeName ?? tradeName.trim()) || null,
      p_concentration: (material?.concentration ?? concentration.trim()) || null,
      p_dosage_form: (material?.dosageForm ?? dosageForm.trim()) || null,
      p_unit: (material?.unit ?? unit.trim()) || null,
      p_national_code: nationalCode.trim() || null,
    });
    setBusy(false);
    if (rpcError) {
      // Fail-closed readiness gate: the RPC exists only once 089 is applied.
      if (rpcError.code === '42883' || rpcError.code === 'PGRST202' || /function/i.test(rpcError.message ?? '')) {
        setError(t('sp_awaiting_migration', lang));
        return;
      }
      setError(rpcError.message);
      return;
    }
    const payload = data as EntryResult;
    setResult(payload);
    setRequestId(newRequestId());
    setConfirmed(false);
    onDone(payload.idempotent_replay ? 'sp_entry_replayed' : 'sp_entry_ok');
  }

  const fieldRow = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 200px), 1fr))', gap: '10px' } as const;

  return (
    <div style={{ display: 'grid', gap: '12px' }} data-testid="subpurchase-direct-entry">
      <PhoenixCard>
        <h4 style={{ fontSize: '13.5px', fontWeight: 700, marginBottom: '4px' }}>{t('sp_entry_title', lang)}</h4>
        <p style={{ fontSize: '11.5px', color: 'var(--t2)', marginBottom: '12px' }} dir="auto">{t('sp_entry_sub', lang)}</p>

        {/* Material: registered-first; a NEW identity may be registered HERE
            (the one screen besides the Inventory Center allowed to). */}
        {material === null && !newIdentity && (
          <>
            <PhoenixMaterialResolver lang={lang} warehouseId={warehouseId} onSelect={m => { setMaterial(m); touch(); }} />
            <div style={{ marginTop: '8px' }}>
              <PhoenixButton variant="ghost" size="sm" onClick={() => { setNewIdentity(true); touch(); }}>
                + {t('sp_register_new_material', lang)}
              </PhoenixButton>
            </div>
          </>
        )}
        {material !== null && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', fontSize: '12.5px', padding: '8px 12px', borderRadius: 'var(--r2)', background: 'var(--s2)', border: '1px solid var(--brd)' }}>
            <strong dir="auto">{material.scientificName}{material.tradeName ? ` (${material.tradeName})` : ''}</strong>
            <PhoenixButton variant="ghost" size="sm" onClick={() => { setMaterial(null); touch(); }}>✕</PhoenixButton>
          </div>
        )}
        {newIdentity && material === null && (
          <div style={{ marginTop: '10px', display: 'grid', gap: '10px' }}>
            <div style={fieldRow}>
              <PhoenixInput label={t('inv_scientific_name', lang)} value={scientificName} onChange={e => { setScientificName(e.target.value); touch(); }} />
              <PhoenixInput label={t('inv_trade_name', lang)} value={tradeName} onChange={e => { setTradeName(e.target.value); touch(); }} />
              <PhoenixInput label={t('inv_concentration', lang)} value={concentration} onChange={e => { setConcentration(e.target.value); touch(); }} />
              <PhoenixInput label={t('inv_dosage_form', lang)} value={dosageForm} onChange={e => { setDosageForm(e.target.value); touch(); }} />
              <PhoenixInput label={t('inv_unit', lang)} value={unit} onChange={e => { setUnit(e.target.value); touch(); }} />
              <PhoenixInput label={t('sp_national_code_optional', lang)} value={nationalCode} onChange={e => { setNationalCode(e.target.value); touch(); }} />
            </div>

            {/* 117 — advisory-only, never blocks creating a new material. */}
            {duplicates.length > 0 && (
              <div data-testid="subpurchase-duplicate-hint" role="status" style={{ padding: '8px 12px', borderRadius: 'var(--r2)', background: 'var(--warn2)', border: '1px solid var(--warn)', display: 'grid', gap: '6px' }}>
                <div style={{ fontSize: '12px', fontWeight: 700 }} dir="auto">{t('sp_duplicate_hint_title', lang)}</div>
                <div style={{ display: 'grid', gap: '4px' }}>
                  {duplicates.map(d => (
                    <div key={`${d.source}-${d.sourceId}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', fontSize: '11.5px', flexWrap: 'wrap' }}>
                      <span dir="auto">
                        {d.scientificName}{d.tradeName ? ` (${d.tradeName})` : ''}
                        {' '}· {t(d.source === 'catalog' ? 'sp_duplicate_source_catalog' : 'sp_duplicate_source_lot', lang)}
                      </span>
                      {d.source === 'catalog' && (
                        <PhoenixButton
                          variant="ghost" size="sm"
                          onClick={() => {
                            setMaterial({
                              source: 'catalog',
                              centralItemId: d.sourceId,
                              warehouseStockId: null,
                              scientificName: d.scientificName,
                              tradeName: d.tradeName,
                              concentration: d.concentration,
                              dosageForm: d.dosageForm,
                              unit: null,
                              nationalCode: d.nationalCode,
                              barcode: d.nationalCode,
                              batchNumber: null,
                              expiryDate: null,
                              onHand: null,
                              reserved: null,
                              available: null,
                              supplyType: null,
                              grade: 'confirmed',
                              reasonKey: 'sp_duplicate_use_this',
                            } satisfies ResolvedMaterial);
                            setNewIdentity(false);
                            touch();
                          }}
                        >
                          {t('sp_duplicate_use_this', lang)}
                        </PhoenixButton>
                      )}
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: '10.5px', color: 'var(--t2)' }} dir="auto">{t('sp_duplicate_hint_note', lang)}</div>
              </div>
            )}

            <PhoenixButton variant="ghost" size="sm" onClick={() => { setNewIdentity(false); touch(); }}>
              {t('sp_back_to_search', lang)}
            </PhoenixButton>
          </div>
        )}
      </PhoenixCard>

      <PhoenixCard>
        <div style={fieldRow}>
          <PhoenixInput label={t('mv_f_batch_number', lang)} value={batch} disabled={noBatch} onChange={e => { setBatch(e.target.value); touch(); }} />
          <PhoenixInput label={t('mv_f_expiry_date', lang)} type="date" value={expiry} onChange={e => { setExpiry(e.target.value); touch(); }} />
          <PhoenixInput label={t('inv_quantity_received', lang)} type="number" min={1} step={1} value={qty} onChange={e => { setQty(e.target.value); touch(); }} />
          <PhoenixInput label={t('inv_unit_price', lang)} type="number" min={0} step="0.01" value={price} onChange={e => { setPrice(e.target.value); touch(); }} />
          <PhoenixInput label={t('sp_purchase_date', lang)} type="date" value={purchaseDate} onChange={e => { setPurchaseDate(e.target.value); touch(); }} />
          <PhoenixInput label={t('sp_invoice_ref', lang)} value={invoice} onChange={e => { setInvoice(e.target.value); touch(); }} />
          <PhoenixInput label={t('sp_supplier_optional', lang)} value={supplier} onChange={e => { setSupplier(e.target.value); touch(); }} />
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', minHeight: '44px' }}>
          <input type="checkbox" checked={noBatch} onChange={e => { setNoBatch(e.target.checked); if (e.target.checked) setBatch(''); touch(); }} />
          {t('inv_no_batch_number', lang)}
        </label>
        <PhoenixInput label={t('inv_notes', lang)} value={notes} onChange={e => { setNotes(e.target.value); touch(); }} />

        {/* MANDATORY human confirmation — nothing posts without it. */}
        <label style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '12px', marginTop: '10px', cursor: 'pointer' }}>
          <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} data-testid="subpurchase-confirm" />
          <span dir="auto">{t('sp_confirm_entry', lang)}</span>
        </label>

        {error && <p role="alert" style={{ fontSize: '12px', color: 'var(--err)', marginTop: '8px' }} dir="auto">{error}</p>}

        <div style={{ marginTop: '12px' }}>
          <PhoenixButton onClick={() => void submit()} disabled={!valid} loading={busy}>
            {t('sp_submit_entry', lang)}
          </PhoenixButton>
        </div>
      </PhoenixCard>

      {result && result.ok && (
        <PhoenixCard data-testid="subpurchase-result">
          <div style={{ fontSize: '12.5px', display: 'grid', gap: '4px' }}>
            <div><strong>{t('sp_entry_recorded', lang)}</strong></div>
            <div dir="ltr">{t('sp_official_order_no', lang)}: <code>{result.order_number}</code></div>
            <div dir="ltr">{t('sp_official_receipt_no', lang)}: <code>{result.receipt_number}</code></div>
          </div>
        </PhoenixCard>
      )}
    </div>
  );
}
