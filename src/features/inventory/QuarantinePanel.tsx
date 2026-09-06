import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  const requestIdRef = useRef(0);

  // A release/destroy action already in flight when the operator switches
  // warehouse keeps running — its promise has no idea the component moved
  // on. When it settles, its onDone/onError closures are still the ones
  // captured at the render where the click happened, bound to THAT
  // warehouse's row and (via onDone) THAT warehouse's own `reload`. Calling
  // that stale `reload()` would legitimately claim the newest requestId and
  // overwrite the CURRENT warehouse's already-rendered rows with the old
  // warehouse's data — the generation counter above only orders requests
  // against each other, it does not know one of them is answering on behalf
  // of a warehouse the operator already left. Read via a ref (not the
  // `warehouseId` closed over by the stale callback) so the check reflects
  // whichever warehouse is ACTUALLY selected at the moment the action
  // completes, not the one selected when the row was rendered.
  const currentWarehouseIdRef = useRef(warehouseId);
  currentWarehouseIdRef.current = warehouseId;

  // OWNERSHIP of the single, panel-level `busyId` slot — comparing
  // warehouseId alone (above) is not enough for this, and must not be
  // asked to do this job.
  //
  // `rows` is cleared to null on every warehouseId change (below), so EVERY
  // QuarantineRow instance unmounts on a switch — including a later
  // revisit of the identical warehouse, which remounts a FRESH instance for
  // the identical row id once its data is refetched. A token minted once
  // per QuarantineRow MOUNT (its own useRef initializer) is therefore
  // automatically distinct between "row A1 before the trip to B" and "row
  // A1 after returning from B", even though `warehouseId` reads the same
  // string both times and `row.id` is identical.
  //
  // A completion is allowed to touch `busyId` only if its token still
  // matches the one most recently granted — this is what actually answers
  // "does this completion still own the slot", which warehouseId cannot:
  //   - A1 starts (owns the slot) → operator leaves to B and back to A → A1's
  //     STALE completion finally arrives while the slot is unclaimed: token
  //     still matches (nothing else claimed it) → the slot is released, so
  //     the remaining row is never stuck "busy" once the operator returns.
  //   - A1 starts → leaves to B and back to A → A2 starts (claims a NEW
  //     token) → A1's stale completion NOW arrives: token no longer
  //     matches (A2 owns it) → discarded outright, A2's busy state and form
  //     are completely untouched.
  const activeActionRef = useRef<{ token: symbol; warehouseId: string } | null>(null);

  // A switch to a different warehouse must drop the previous warehouse's
  // rows (and, with them, any release/destroy form open on one of those
  // rows — each row unmounts once its `key` leaves `rows`) BEFORE the new
  // warehouse's own fetch resolves. Without this, the old rows/forms stay
  // mounted and interactive for the whole pending window, and an operator
  // can submit a disposal against stock that belonged to the warehouse they
  // already navigated away from. This must run whenever warehouseId itself
  // changes, not on every reload() (e.g. the post-action refresh in onDone
  // reloads the SAME warehouse and should not blank the list).
  useEffect(() => {
    setRows(null);
    setStock([]);
    setError(null);
  }, [warehouseId]);

  const reload = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (!warehouseId) { setRows([]); setStock([]); return; }
    setLoading(true);
    setError(null);
    try {
      const [q, s] = await Promise.all([
        getQuarantineStock(warehouseId),
        getWarehouseStock(warehouseId),
      ]);
      // A later warehouse switch (or another reload()) may have started
      // after this request but resolved before it. Discard this response —
      // committing it now would overwrite the current warehouse's already-
      // rendered, more current rows with stale ones.
      if (requestIdRef.current !== requestId) return;
      setRows(q);
      setStock(s);
    } catch {
      if (requestIdRef.current !== requestId) return;
      setError(t('err_generic', lang));
      setRows(null);
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
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
          onBusyStart={() => {
            const token = Symbol(row.id);
            activeActionRef.current = { token, warehouseId: row.warehouseId };
            setBusyId(row.id);
            return token;
          }}
          onDone={(token, msg) => {
            // A newer action (on this row after a remount, or on a
            // different one) already claimed the slot — this completion is
            // answering for an action nothing depends on any more.
            if (activeActionRef.current?.token !== token) return;
            activeActionRef.current = null;
            setBusyId(null);
            // Releasing the slot above must happen regardless of which
            // warehouse is displayed now (that is what keeps a row from
            // getting stuck "busy" forever), but do not resubmit or
            // auto-restore the abandoned warehouse's context otherwise —
            // just refuse to let its completion touch the warehouse the
            // operator is actually looking at now.
            if (row.warehouseId !== currentWarehouseIdRef.current) return;
            showToast(msg);
            void reload();
          }}
          onError={(token, msg) => {
            if (activeActionRef.current?.token !== token) return;
            activeActionRef.current = null;
            setBusyId(null);
            if (row.warehouseId !== currentWarehouseIdRef.current) return;
            showToast(msg);
          }}
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
  /** Claims the panel's single busy slot and returns a token identifying THIS action — pass it back to onDone/onError so a stale, superseded completion can be told apart from the one currently owning the slot. */
  onBusyStart: () => symbol;
  onDone: (token: symbol, message: string) => void;
  onError: (token: symbol, message: string) => void;
  lang: 'ar' | 'en';
}

function QuarantineRow({ row, stock, canDispose, busy, onBusyStart, onDone, onError, lang }: RowProps) {
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
    const token = onBusyStart();
    const result = await releaseQuarantineStock({
      requestId: newRequestId(), quarantineStockId: row.id, quantity: quantityNum,
      reason: reason.trim(), destinationWarehouseStockId: destinationId,
    });
    if (result.ok) {
      onDone(token, t('qz_release_ok', lang));
      setMode('none');
    } else {
      onError(token, t('qz_action_failed', lang) + (result.error ? `: ${result.error}` : ''));
    }
  };

  const submitDestroy = async () => {
    if (busy || !quantityValid || !reasonValid) return;
    const token = onBusyStart();
    const result = await destroyQuarantineStock({
      requestId: newRequestId(), quarantineStockId: row.id, quantity: quantityNum, reason: reason.trim(),
    });
    if (result.ok) {
      onDone(token, t('qz_destroy_ok', lang));
      setMode('none');
    } else {
      onError(token, t('qz_action_failed', lang) + (result.error ? `: ${result.error}` : ''));
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
