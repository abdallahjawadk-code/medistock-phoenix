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
    <div dir={dir} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {toast && <div style={{ fontSize: '12px', color: 'var(--ok)' }}>{toast}</div>}
      {rows.map(row => (
        <QuarantineRow
          key={row.id}
          row={row}
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
  stock: WarehouseStockBatch[];
  canDispose: boolean;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onDone: (message: string) => void;
  onError: (message: string) => void;
  lang: 'ar' | 'en';
}

function QuarantineRow({ row, stock, canDispose, busy, onBusy, onDone, onError, lang }: RowProps) {
  const [mode, setMode] = useState<'none' | 'release' | 'destroy'>('none');
  const [quantity, setQuantity] = useState(String(row.quantity));
  const [reason, setReason] = useState('');
  const [destinationId, setDestinationId] = useState('');

  // Release must credit the SAME material/batch/expiry identity — the server
  // refuses any other lot outright, so only exact matches are ever offered.
  const matchingLots = useMemo(
    () => stock.filter(s =>
      s.scientificName.toLowerCase() === row.scientificName.toLowerCase()
      && (s.batchNumber ?? '') === (row.batchNumber ?? '')
      && (s.expiryDate ?? '') === (row.expiryDate ?? '')),
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
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: '13.5px', fontWeight: 700 }}>{row.scientificName}</div>
          <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '2px' }}>
            {[row.batchNumber, row.nationalCode, row.expiryDate].filter(Boolean).join(' · ') || '—'}
          </div>
          <div style={{ fontSize: '11.5px', color: 'var(--warn)', fontWeight: 700, marginTop: '3px' }}>
            {quarantineReasonLabel(row.quarantineReason, lang)}
          </div>
        </div>
        <div style={{ fontSize: '13px', fontWeight: 700 }}>
          {t('qz_quantity', lang)}: {row.quantity}
        </div>
      </div>

      {canDispose && mode === 'none' && (
        <div style={{ display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' }}>
          <PhoenixButton variant="secondary" onClick={() => { setMode('release'); setQuantity(String(row.quantity)); setReason(''); }}>
            {t('qz_release', lang)}
          </PhoenixButton>
          <PhoenixButton variant="ghost" onClick={() => { setMode('destroy'); setQuantity(String(row.quantity)); setReason(''); }}>
            {t('qz_destroy', lang)}
          </PhoenixButton>
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
