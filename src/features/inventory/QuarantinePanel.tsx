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
import { GUIDE_ANCHORS, guideAnchor } from '@/features/guide/guide.anchors';
import { useGuideExampleRow, useGuidePresence } from '@/features/guide/guide.surface';

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

  // Registry of PENDING disposal operations, one entry per (warehouseId,
  // row id) — never a single shared slot, and never scoped to any one
  // QuarantineRow's own mount lifecycle.
  //
  // A single shared slot (an earlier version of this fix) cannot represent
  // two rows each having their own action in flight at once: starting an
  // action on A2 would overwrite the ONE slot that A1's still-pending
  // action was relying on, silently re-enabling A1's own confirm button —
  // exactly a double-submission hazard, not merely a cross-warehouse one.
  // Protecting only the latest action from a stale completion is not the
  // same thing as protecting every pending action.
  //
  // Keyed on (warehouseId, row id), not the row's own component instance:
  // `rows` is cleared to null and refetched on every warehouseId change
  // (below), so revisiting a warehouse remounts a BRAND NEW QuarantineRow
  // for the identical row id, with no memory of anything the previous
  // mount did. This registry is the only thing that still remembers "this
  // row already has a request outstanding" across that remount — a switch
  // away and back must not lose track of a still-pending action, and a
  // fresh attempt to confirm the SAME row again while its earlier request
  // is still in flight must be refused, not treated as a brand new one.
  //
  // Release and destroy on the same row deliberately share one entry —
  // starting either kind of action blocks the other on that row, since
  // both would resolve the identical quarantine_stock_id server-side.
  const pendingActionsRef = useRef<Record<string, symbol>>({});
  // Mirrors pendingActionsRef's key set into render-visible state — a ref
  // alone never triggers a re-render when a row's busy status changes.
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(new Set());
  const actionKey = useCallback(
    (rowWarehouseId: string, rowId: string) => `${rowWarehouseId}::${rowId}`,
    [],
  );

  // The actual guard against a duplicate submission: claims the row's slot
  // SYNCHRONOUSLY, directly against the ref, at the moment an action is
  // about to be sent — never by trusting the `busy` PROP alone. `busy` is
  // derived from React state, which can lag a rapid, same-tick second
  // invocation by a full render; a ref write is immediate. Returns null,
  // starting nothing, if the row already has an action outstanding.
  const tryStartAction = useCallback((rowWarehouseId: string, rowId: string): symbol | null => {
    const key = actionKey(rowWarehouseId, rowId);
    if (key in pendingActionsRef.current) return null;
    const token = Symbol(key);
    pendingActionsRef.current[key] = token;
    setBusyKeys(new Set(Object.keys(pendingActionsRef.current)));
    return token;
  }, [actionKey]);

  // Releases the row's slot ONLY if `token` is still the one on file. A
  // completion whose token no longer matches is answering for an action
  // nothing depends on any more (superseded by a fresh attempt on the same
  // row) and must not release — or otherwise touch — whatever currently
  // occupies that slot.
  const finishAction = useCallback((rowWarehouseId: string, rowId: string, token: symbol): boolean => {
    const key = actionKey(rowWarehouseId, rowId);
    if (pendingActionsRef.current[key] !== token) return false;
    delete pendingActionsRef.current[key];
    setBusyKeys(new Set(Object.keys(pendingActionsRef.current)));
    return true;
  }, [actionKey]);

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

  /**
   * IG-2 — ONE declared example row, chosen by identity and kept.
   *
   * `index === 0` was not enough. This list is ordered by expiry date and is
   * reloaded after every disposition, so "the first row" can become a
   * DIFFERENT lot while a step is explaining it — the operator would read about
   * one record while the highlight moved to another. Freezing the id means the
   * example either stays the record it was, or is released; it is never
   * silently swapped.
   */
  const rowIds = useMemo(() => (rows ?? []).map(r => r.id), [rows]);
  const exampleRowId = useGuideExampleRow(rowIds);

  // Which branch will render, decided ONCE so the presence declaration below
  // and the JSX beneath it cannot drift apart.
  const showLoading = loading && rows === null;
  const showError = !showLoading && error !== null;
  const showRegion = !showLoading && !showError;

  /**
   * IG-2 — what is on screen, which is neither a permission nor a data state.
   *
   * The region key covers the populated list AND the empty state, because both
   * are the same region of the screen and the step naming it ("this is where
   * quarantined lots appear") is true of both. The row keys are false whenever
   * there is no example row to point at, so the steps about a row are REMOVED
   * rather than falling back to a centred card that would describe a record the
   * operator cannot see.
   */
  useGuidePresence('inventory.quarantine', {
    'inventory.quarantine.region': showRegion,
    'inventory.quarantine.row': showRegion && exampleRowId !== null,
    'inventory.quarantine.rowActions': showRegion && exampleRowId !== null && canDispose,
  });

  if (showLoading) return <PhoenixLoadingState />;
  if (showError) return <PhoenixErrorState title={t('err_generic', lang)} message={error ?? ''} onRetry={reload} />;
  if (!rows || rows.length === 0) {
    /* The empty state IS the list region: same anchor, so the step explaining
       what this tab lists keeps a real, correctly-placed target instead of
       falling back to a centred card. */
    return (
      <div {...guideAnchor(GUIDE_ANCHORS.quarantineList)} dir={dir}>
        <PhoenixEmptyState icon="🔒" title={t('qz_empty_title', lang)} description={t('qz_empty_description', lang)} />
      </div>
    );
  }

  return (
    <div {...guideAnchor(GUIDE_ANCHORS.quarantineList)} dir={dir} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {toast && <div style={{ fontSize: '12px', color: 'var(--ok)' }}>{toast}</div>}
      {rows.map(row => (
        <QuarantineRow
          key={row.id}
          row={row}
          /* IG-2: exactly one card carries the row-level anchors, and it is the
             frozen example above — never "whichever happens to be first now". */
          guideAnchored={row.id === exampleRowId}
          stock={stock}
          canDispose={canDispose}
          busy={busyKeys.has(actionKey(row.warehouseId, row.id))}
          onBusyStart={() => tryStartAction(row.warehouseId, row.id)}
          onDone={(token, msg) => {
            const released = finishAction(row.warehouseId, row.id, token);
            // A fresh attempt on this SAME row already claimed the slot —
            // this completion is answering for an action nothing depends
            // on any more.
            if (!released) return;
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
            const released = finishAction(row.warehouseId, row.id, token);
            if (!released) return;
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
  /** IG-2 — carry the guide's row-level anchors; true for the first row only. */
  guideAnchored: boolean;
  stock: WarehouseStockBatch[];
  canDispose: boolean;
  busy: boolean;
  /** Tries to claim this row's action slot, synchronously. Returns a token identifying THIS action — pass it back to onDone/onError so a stale, superseded completion can be told apart from the one currently owning the slot — or null if the row already has an action in flight, in which case nothing must be sent. */
  onBusyStart: () => symbol | null;
  onDone: (token: symbol, message: string) => void;
  onError: (token: symbol, message: string) => void;
  lang: 'ar' | 'en';
}

function QuarantineRow({ row, guideAnchored, stock, canDispose, busy, onBusyStart, onDone, onError, lang }: RowProps) {
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
    if (!token) return; // another action for this row is already in flight — refuse, do not resubmit
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
    if (!token) return;
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

      {(canDispose || mode !== 'none') && (
        /* IG-2 — the disposition AREA, present in every mode of this card.
           The precise button-wrapper anchors inside it vanish the moment the
           operator opens a form, and a step must not then fall back to a
           centred card and have that counted as success: the concept is still
           on screen, only in a different shape. So the release/destroy steps
           keep their precise anchor first and declare this region as the
           fallback.

           The condition is `canDispose || mode !== 'none'` and not plain
           `canDispose` so that this wrapper is present in exactly the states
           where the buttons or a form were already rendered — it adds a
           container, and changes no operational behaviour. */
        <div {...(guideAnchored ? guideAnchor(GUIDE_ANCHORS.quarantineRowActions) : {})}>
          {canDispose && mode === 'none' && (
            <div style={{ display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' }}>
              {/* IG-2 anchors sit on WRAPPERS, never on the buttons, so the
                  guide cannot acquire a handle on an operational control.
                  Opening these forms is the operator's action alone: the
                  release form selects a default destination lot the moment it
                  opens, which is real business-form state the guide must never
                  set. */}
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
        </div>
      )}
    </PhoenixCard>
  );
}
