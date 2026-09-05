import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';
import { PhoenixSelect } from '@/shared/ui/PhoenixSelect';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { getWarehouseStock, type WarehouseStockBatch } from '@/features/network/network.service';
import {
  getQuarantineStock, releaseQuarantineStock, destroyQuarantineStock,
  type QuarantineStockRow,
} from './quarantine.service';
import { isExactReleaseCandidate } from './stock-identity';
import { GUIDE_ANCHORS, guideAnchor } from '@/features/guide/guide.anchors';
import { useGuideCapabilities } from '@/features/guide/guide.surface';

const newRequestId = () =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

interface Props {
  warehouseId: string;
  /** Preflight only — both RPCs re-check server-side. */
  canDispose: boolean;
}

/**
 * QUARANTINE-DISPOSITION panel — views what a warehouse holds in quarantine
 * (069/071's mandatory- and explicit-decision holds) and disposes of it via
 * 099's release (credits a NAMED existing dispensable lot — never invents
 * one) or destroy (permanent, no credit anywhere) RPCs.
 */
export function QuarantinePanel({ warehouseId, canDispose }: Props) {
  const { lang, dir } = useApp();

  /**
   * INTERACTIVE-GUIDE-IG2 — publish the answers this panel was GIVEN, so the
   * guide reads a decision instead of re-deriving one.
   *
   * Being mounted at all already means the viewer may read these rows (the tab
   * is gated on that), and `canDispose` is the scoped per-warehouse answer the
   * release/destroy RPCs check. The warehouse is the scope, so a different
   * warehouse invalidates both answers.
   */
  useGuideCapabilities(
    'inventory.quarantine',
    { 'inventory.quarantine.view': true, 'inventory.quarantine.dispose': canDispose },
    'ready',
    `wh:${warehouseId}`,
  );

  const [rows, setRows] = useState<QuarantineStockRow[] | null>(null);
  const [stock, setStock] = useState<WarehouseStockBatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!warehouseId) { setRows([]); setStock([]); return; }
    setLoading(true);
    setError(null);
    try {
      const [q, s] = await Promise.all([
        getQuarantineStock(warehouseId),
        getWarehouseStock(warehouseId),
      ]);
      setRows(q);
      setStock(s);
    } catch {
      setError(t('err_generic', lang));
      setRows(null);
    } finally {
      setLoading(false);
    }
  }, [warehouseId, lang]);

  useEffect(() => { void reload(); }, [reload]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  };

  if (loading && rows === null) return <PhoenixLoadingState />;
  if (error) return <PhoenixErrorState title={t('err_generic', lang)} message={error} onRetry={reload} />;
  if (!rows || rows.length === 0) {
    return <PhoenixEmptyState icon="🔒" title={t('qz_empty_title', lang)} description={t('qz_empty_description', lang)} />;
  }

  return (
    <div {...guideAnchor(GUIDE_ANCHORS.quarantineList)} dir={dir} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {toast && <div style={{ fontSize: '12px', color: 'var(--ok)' }}>{toast}</div>}
      {rows.map((row, index) => (
        <QuarantineRow
          key={row.id}
          row={row}
          /* IG-2: only the FIRST card carries the row-level anchors. A repeated
             id across a list would give the guide several equal candidates and
             let it highlight an arbitrary record. */
          guideAnchored={index === 0}
          stock={stock}
          canDispose={canDispose}
          busy={busyId === row.id}
          onBusy={busy => setBusyId(busy ? row.id : null)}
          onDone={(msg) => { showToast(msg); void reload(); }}
          onError={showToast}
          lang={lang}
        />
      ))}
    </div>
  );
}

const quarantineReasonLabel = (reason: string, lang: 'ar' | 'en') => {
  const key = `qz_reason_${reason}`;
  const label = t(key, lang);
  return label === key ? reason : label;
};

interface RowProps {
  row: QuarantineStockRow;
  /** IG-2 — carry the guide's row-level anchors; true for the first row only. */
  guideAnchored: boolean;
  stock: WarehouseStockBatch[];
  canDispose: boolean;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onDone: (message: string) => void;
  onError: (message: string) => void;
  lang: 'ar' | 'en';
}

function QuarantineRow({ row, guideAnchored, stock, canDispose, busy, onBusy, onDone, onError, lang }: RowProps) {
  const [mode, setMode] = useState<'none' | 'release' | 'destroy'>('none');
  const [quantity, setQuantity] = useState(String(row.quantity));
  const [reason, setReason] = useState('');
  const [destinationId, setDestinationId] = useState('');

  // Release must credit the EXACT canonical lot identity — the server refuses
  // any other destination outright, so only exact matches are ever offered.
  //
  // R1.5-E: this previously compared lower-cased scientific name + batch +
  // expiry. That triple is not a lot: 088's warehouse_stock_identity_uniq also
  // carries internal_batch_reference, supply_type and purchase_origin, so two
  // rows matching on the old triple can be genuinely different physical stock
  // from different provenance. Offering one as the destination for the other
  // proposed crediting the wrong lot. Identity now comes from the database's
  // own material_identity_key plus the remaining lot dimensions.
  const matchingLots = useMemo(
    () => stock.filter(s => isExactReleaseCandidate(s, row)),
    [stock, row],
  );

  useEffect(() => {
    if (mode === 'release' && !destinationId && matchingLots.length > 0) {
      setDestinationId(matchingLots[0].id);
    }
  }, [mode, matchingLots, destinationId]);

  const quantityNum = Number(quantity);
  const quantityValid = Number.isInteger(quantityNum) && quantityNum > 0 && quantityNum <= row.quantity;
  const reasonValid = reason.trim() !== '';

  const submitRelease = async () => {
    if (busy || !quantityValid || !reasonValid || !destinationId) return;
    onBusy(true);
    const result = await releaseQuarantineStock({
      requestId: newRequestId(), quarantineStockId: row.id, quantity: quantityNum,
      reason: reason.trim(), destinationWarehouseStockId: destinationId,
    });
    onBusy(false);
    if (result.ok) {
      onDone(t('qz_release_ok', lang));
      setMode('none');
    } else {
      onError(t('qz_action_failed', lang) + (result.error ? `: ${result.error}` : ''));
    }
  };

  const submitDestroy = async () => {
    if (busy || !quantityValid || !reasonValid) return;
    onBusy(true);
    const result = await destroyQuarantineStock({
      requestId: newRequestId(), quarantineStockId: row.id, quantity: quantityNum, reason: reason.trim(),
    });
    onBusy(false);
    if (result.ok) {
      onDone(t('qz_destroy_ok', lang));
      setMode('none');
    } else {
      onError(t('qz_action_failed', lang) + (result.error ? `: ${result.error}` : ''));
    }
  };

  return (
    <PhoenixCard>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <div {...(guideAnchored ? guideAnchor(GUIDE_ANCHORS.quarantineRowIdentity) : {})} style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: '13.5px', fontWeight: 700 }}>{row.scientificName}</div>
          <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '2px' }}>
            {[row.batchNumber, row.nationalCode, row.expiryDate].filter(Boolean).join(' · ') || '—'}
          </div>
          <div style={{ fontSize: '11.5px', color: 'var(--warn)', fontWeight: 700, marginTop: '3px' }}>
            {quarantineReasonLabel(row.quarantineReason, lang)}
          </div>
        </div>
        <div {...(guideAnchored ? guideAnchor(GUIDE_ANCHORS.quarantineRowQuantity) : {})} style={{ fontSize: '13px', fontWeight: 700 }}>
          {t('qz_quantity', lang)}: {row.quantity}
        </div>
      </div>

      {canDispose && mode === 'none' && (
        <div style={{ display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' }}>
          {/* IG-2 anchors sit on WRAPPERS, not on the buttons, so the guide
              cannot acquire a handle on an operational control. Opening these
              forms is the operator's action alone: the release form selects a
              default destination lot the moment it opens, which is real
              business-form state the guide must never set. */}
          <span {...(guideAnchored ? guideAnchor(GUIDE_ANCHORS.quarantineReleaseAction) : {})} style={{ display: 'inline-flex' }}>
            <PhoenixButton variant="secondary" onClick={() => { setMode('release'); setQuantity(String(row.quantity)); setReason(''); }}>
              {t('qz_release', lang)}
            </PhoenixButton>
          </span>
          <span {...(guideAnchored ? guideAnchor(GUIDE_ANCHORS.quarantineDestroyAction) : {})} style={{ display: 'inline-flex' }}>
            <PhoenixButton variant="ghost" onClick={() => { setMode('destroy'); setQuantity(String(row.quantity)); setReason(''); }}>
              {t('qz_destroy', lang)}
            </PhoenixButton>
          </span>
        </div>
      )}

      {mode === 'release' && (
        <div style={{ display: 'grid', gap: '8px', marginTop: '10px' }}>
          {matchingLots.length === 0 ? (
            <div style={{ fontSize: '12px', color: 'var(--err)' }}>{t('qz_no_matching_lot', lang)}</div>
          ) : (
            <PhoenixSelect
              label={t('qz_destination_lot', lang)}
              value={destinationId}
              onChange={e => setDestinationId(e.target.value)}
              options={matchingLots.map(l => ({ value: l.id, label: `${l.batchNumber ?? '—'} (${l.onHandQuantity})` }))}
            />
          )}
          <PhoenixInput label={t('qz_quantity', lang)} value={quantity} inputMode="numeric" disabled={busy}
            onChange={e => setQuantity(e.target.value)} />
          <PhoenixInput label={t('qz_reason', lang)} value={reason} disabled={busy}
            onChange={e => setReason(e.target.value)} />
          <div style={{ display: 'flex', gap: '8px' }}>
            <PhoenixButton disabled={busy || !quantityValid || !reasonValid || !destinationId} onClick={() => void submitRelease()}>
              {t('qz_confirm_release', lang)}
            </PhoenixButton>
            <PhoenixButton variant="ghost" disabled={busy} onClick={() => setMode('none')}>{t('mv_cancel', lang)}</PhoenixButton>
          </div>
        </div>
      )}

      {mode === 'destroy' && (
        <div style={{ display: 'grid', gap: '8px', marginTop: '10px' }}>
          <PhoenixInput label={t('qz_quantity', lang)} value={quantity} inputMode="numeric" disabled={busy}
            onChange={e => setQuantity(e.target.value)} />
          <PhoenixInput label={t('qz_reason', lang)} value={reason} disabled={busy}
            onChange={e => setReason(e.target.value)} />
          <div style={{ display: 'flex', gap: '8px' }}>
            <PhoenixButton disabled={busy || !quantityValid || !reasonValid} onClick={() => void submitDestroy()}>
              {t('qz_confirm_destroy', lang)}
            </PhoenixButton>
            <PhoenixButton variant="ghost" disabled={busy} onClick={() => setMode('none')}>{t('mv_cancel', lang)}</PhoenixButton>
          </div>
        </div>
      )}
    </PhoenixCard>
  );
}
