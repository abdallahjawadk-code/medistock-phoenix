/**
 * OUTLET-CORRIDOR-070 — the institution-warehouse dispatch surface: create a
 * draft dispatch (draft-first composer), then SEND it to the outlet. Every
 * mutation is a 070 RPC that re-checks warehouse/outlet scope server-side.
 *
 * Sending is a deliberate, separate step from authoring: a dispatch is composed
 * and reviewed as a draft, and only phoenix_send_warehouse_dispatch (idempotent
 * on a fresh request id) actually moves stock and creates the outlet's pending
 * receipt. Outlet balances change only after the OUTLET confirms receipt on its
 * own surface — never here.
 */
import { useMemo, useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { runStockMutation, type TokenedWriter } from '@/shared/lib/stock-mutation-runner';
import { getPaperReference, setPaperReference } from '@/features/movement/paper-reference.service';
import { PaperReferenceFields, EMPTY_PAPER_REFERENCE, paperReferenceSummary, type PaperReferenceValue } from '@/features/movement/ui/PaperReferenceFields';
import { OutletDispatchComposer } from './OutletDispatchComposer';
import {
  getWarehouseDispatches, getWarehouseDispatchLines, sendWarehouseDispatch, cancelWarehouseDispatch,
  type WarehouseDispatch,
} from './dispatch.service';

type Lang = 'ar' | 'en';
type Status = { msg: string; error: boolean } | null;

/**
 * Sending a dispatch MOVES stock, so its request id is derived rather than
 * minted — a fresh id on retry would make each attempt a new operation and
 * double-post whenever a success response was lost. See
 * shared/lib/operation-token.
 */
const SEND_KIND = 'warehouse_dispatch_send';

const writeSend: TokenedWriter<{ dispatchId: string }> = (requestId, payload) =>
  sendWarehouseDispatch({ requestId, dispatchId: payload.dispatchId });

function opError(code: string | undefined, lang: Lang): string {
  const c = (code ?? '').toUpperCase();
  if (c.includes('FORBIDDEN') || c.includes('NOT_AUTHORIZED') || c === '42501') return t('net_err_not_authorized', lang);
  if (c.includes('CONFLICT') || c.includes('EXISTS')) return t('net_err_conflict', lang);
  if (c.endsWith('NOT_FOUND')) return t('net_err_not_found', lang);
  return t('net_err_invalid', lang);
}

function StatusLine({ status }: { status: Status }) {
  if (!status) return null;
  return (
    <div role="status" style={{
      margin: '10px 0', padding: '9px 12px', borderRadius: 'var(--r2)', fontSize: '12.5px',
      background: status.error ? 'var(--err2)' : 'var(--ok2, #ecfdf5)',
      color: status.error ? 'var(--err)' : 'var(--ok, #047857)',
      border: `1px solid ${status.error ? 'var(--err)' : 'var(--ok, #047857)'}`,
    }}>{status.msg}</div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const done = ['accepted', 'sent', 'partially_accepted'].includes(status);
  const bad = ['cancelled', 'rejected'].includes(status);
  return (
    <span style={{
      display: 'inline-block', padding: '1px 8px', borderRadius: 'var(--rpill)', fontSize: '10px', fontWeight: 700,
      background: done ? 'var(--ok2, #ecfdf5)' : bad ? 'var(--err2)' : 'var(--s2, #f1f5f9)',
      color: done ? 'var(--ok, #047857)' : bad ? 'var(--err)' : 'var(--t2)',
    }}>{status}</span>
  );
}

interface Props {
  warehouseId: string;
  warehouseName: string;
  outlets: ReadonlyArray<{ id: string; name: string }>;
  canDispatch: boolean;
  lang: Lang;
  initialDispatchId?: string;
}

export function OutletDispatchOperations({
  warehouseId,
  warehouseName,
  outlets,
  canDispatch,
  lang,
  initialDispatchId,
}: Props) {
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey(k => k + 1);
  const dispatches = useAsync(() => getWarehouseDispatches(warehouseId), [warehouseId, reloadKey]);
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const outletName = useMemo(() => new Map(outlets.map(o => [o.id, o.name])), [outlets]);

  if (creating) {
    return (
      <OutletDispatchComposer
        sourceWarehouseId={warehouseId}
        sourceWarehouseName={warehouseName}
        outlets={outlets}
        onCancel={() => setCreating(false)}
        onCreated={() => { setCreating(false); setStatus({ msg: t('net_ds_created', lang), error: false }); reload(); }}
      />
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
        <PhoenixButton onClick={() => setCreating(true)} disabled={!canDispatch || outlets.length === 0}>
          {t('net_op_new', lang)}
        </PhoenixButton>
        <PhoenixButton variant="ghost" onClick={reload}>{t('net_op_refresh', lang)}</PhoenixButton>
      </div>

      {outlets.length === 0 && <PhoenixEmptyState icon="institutions" title={t('net_ds_no_warehouses', lang)} />}
      <StatusLine status={status} />

      {dispatches.loading && <PhoenixLoadingState />}
      {!dispatches.loading && (dispatches.data ?? []).length === 0 && <PhoenixEmptyState icon="package" title={t('mv_dispatch_none', lang)} />}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {(dispatches.data ?? []).map(d => (
          <DispatchRow
            key={d.id} dispatch={d} outletName={outletName.get(d.destinationDistributionPointId) ?? '—'}
            canDispatch={canDispatch} lang={lang}
            initiallyOpen={d.id === initialDispatchId}
            onDone={(res) => {
              setStatus(res.ok ? { msg: t('net_op_done', lang), error: false } : { msg: opError(res.error, lang), error: true });
              if (res.ok) reload();
            }}
          />
        ))}
      </div>
    </div>
  );
}

function DispatchRow({ dispatch, outletName, canDispatch, lang, onDone, initiallyOpen }: {
  dispatch: WarehouseDispatch; outletName: string; canDispatch: boolean; lang: Lang;
  onDone: (res: { ok: boolean; error?: string }) => void;
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen ?? false);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const lines = useAsync(() => (open ? getWarehouseDispatchLines(dispatch.id) : Promise.resolve([])), [open, dispatch.id]);
  const isDraft = dispatch.status === 'draft';

  // PAPER-REFERENCE-CONTRACT-110: read-only once the dispatch has left draft
  // (server enforces this too — phoenix_set_paper_reference itself refuses a
  // non-draft edit); editable here while it hasn't.
  const [paperRefReload, setPaperRefReload] = useState(0);
  const paperRef = useAsync(
    () => (open ? getPaperReference('warehouse_dispatch', dispatch.id) : Promise.resolve(null)),
    [open, dispatch.id, paperRefReload],
  );
  const [editingRef, setEditingRef] = useState(false);
  const [refDraft, setRefDraft] = useState<PaperReferenceValue>(EMPTY_PAPER_REFERENCE);
  const [refBusy, setRefBusy] = useState(false);

  const send = async () => {
    // A dispatch leaves draft exactly once. While it is still draft the server
    // has not moved, so a retry after a lost response derives the same token
    // and the replay is deduplicated rather than shipping the goods twice.
    if (!isDraft) return;
    setBusy(true);
    onDone(await runStockMutation(writeSend, SEND_KIND, {
      entityId: dispatch.id,
      generation: dispatch.sentAt ? 1 : 0,
      payload: { dispatchId: dispatch.id },
    }));
    setBusy(false);
  };

  return (
    <PhoenixCard padding="10px 14px">
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '13px', fontWeight: 700 }}>{dispatch.dispatchNumber}</div>
          <div style={{ fontSize: '11px', color: 'var(--t2)' }}>{outletName}</div>
        </div>
        <StatusBadge status={dispatch.status} />
        <PhoenixButton size="sm" variant="ghost" onClick={() => setOpen(o => !o)}>{t('net_op_edit', lang)}</PhoenixButton>
        {isDraft && (
          <>
            <PhoenixButton size="sm" loading={busy} disabled={!canDispatch} onClick={send}>{t('net_op_send', lang)}</PhoenixButton>
            {!cancelling
              ? <PhoenixButton size="sm" variant="danger" onClick={() => setCancelling(true)}>{t('net_op_cancel_req', lang)}</PhoenixButton>
              : (
                <span style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <PhoenixInput placeholder={t('net_op_cancel_reason', lang)} value={reason} onChange={e => setReason(e.target.value)} style={{ minWidth: '150px' }} />
                  <PhoenixButton size="sm" variant="danger" disabled={reason.trim() === ''} onClick={async () => {
                    onDone(await cancelWarehouseDispatch(dispatch.id, reason.trim())); setCancelling(false);
                  }}>{t('net_op_cancel_req', lang)}</PhoenixButton>
                </span>
              )}
          </>
        )}
      </div>
      {open && (
        <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {lines.loading && <PhoenixLoadingState />}
          {(lines.data ?? []).map(l => (
            <div key={l.id} style={{ fontSize: '11.5px', color: 'var(--t2)' }}>
              {l.scientificName} · {l.batchNumber ?? '—'} · {t('mv_f_expiry_date', lang)} {l.expiryDate ?? '—'} · {t('net_op_qty', lang)} {l.sentQuantity}
              {l.receivedQuantity != null && <> · {t('mv_f_received_quantity', lang)} {l.receivedQuantity}</>}
            </div>
          ))}

          {/* PAPER-REFERENCE-CONTRACT-110 — editable while still draft, read-only after. */}
          <div style={{ marginTop: '6px', paddingTop: '6px', borderTop: '1px solid var(--brd)' }}>
            {editingRef ? (
              <div style={{ display: 'grid', gap: '8px' }}>
                <PaperReferenceFields lang={lang} value={refDraft} onChange={setRefDraft} disabled={refBusy} />
                <div style={{ display: 'flex', gap: '8px' }}>
                  <PhoenixButton size="sm" loading={refBusy} disabled={refDraft.number.trim() === ''} onClick={async () => {
                    setRefBusy(true);
                    await setPaperReference({
                      documentType: 'warehouse_dispatch', documentId: dispatch.id,
                      paperReferenceNumber: refDraft.number, paperReferenceDate: refDraft.date || null,
                      issuingAuthority: refDraft.authority || null,
                    });
                    setRefBusy(false);
                    setEditingRef(false);
                    setPaperRefReload(k => k + 1);
                  }}>{t('net_op_save', lang)}</PhoenixButton>
                  <PhoenixButton size="sm" variant="ghost" disabled={refBusy} onClick={() => setEditingRef(false)}>{t('net_cancel', lang)}</PhoenixButton>
                </div>
              </div>
            ) : (
              <div style={{ fontSize: '11px', color: 'var(--t2)', display: 'flex', alignItems: 'center', gap: '8px' }}>
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
        </div>
      )}
    </PhoenixCard>
  );
}
