import { useMemo, useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';
import { PhoenixSelect } from '@/shared/ui/PhoenixSelect';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { getOrganizations } from '@/shared/supabase/services/organizations.service';
import {
  getAllWarehouses,
  createDirectTransferRequest, addTransferRequestLine, updateTransferRequestLine,
  deleteTransferRequestLine, submitTransferRequest, cancelTransferRequest,
  reviewTransferRequest, sendDirectTransferLine, receiveTransferLine,
  getTransferRequests, getTransferRequestLines, getTransfers, getTransferLines,
  getTransferLinesForTransfers, getWarehouseStock,
  requestDirectReturn, recallDirectTransfer, addDirectReturnLine, deleteReturnRequestLine,
  submitReturnRequest, cancelReturnRequest, reviewReturnRequest, sendDirectReturnLine,
  receiveReturnShipmentLine, getReturnRequests, getReturnRequestLines,
  getReturnShipments, getReturnShipmentLines,
  RETURN_REASON_CODES, RETURN_DISPOSITION_REASONS,
  type NetworkWarehouse, type RpcResult, type TransferRequest, type TransferRequestLine,
  type Transfer, type ReturnRequest, type ReturnRequestLine, type ReturnShipment,
} from './network.service';

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

const uuid = (): string =>
  (globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`);

const nameOf = (w: { name_ar: string; name: string } | undefined, lang: Lang): string =>
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
      background: status.error ? 'var(--err2)' : 'var(--ok2, #ecfdf5)',
      color: status.error ? 'var(--err)' : 'var(--ok, #047857)',
      border: `1px solid ${status.error ? 'var(--err)' : 'var(--ok, #047857)'}`,
    }}>{status.msg}</div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const done = ['fulfilled', 'received', 'approved'].includes(status);
  const bad = ['cancelled', 'rejected'].includes(status);
  const bg = done ? 'var(--ok2, #ecfdf5)' : bad ? 'var(--err2)' : 'var(--s2, #f1f5f9)';
  const fg = done ? 'var(--ok, #047857)' : bad ? 'var(--err)' : 'var(--t2)';
  return (
    <span style={{
      display: 'inline-block', padding: '1px 8px', borderRadius: 'var(--rpill)',
      fontSize: '10px', fontWeight: 700, background: bg, color: fg,
    }}>{status}</span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export function DirectSupplyOperations({ lang }: { lang: Lang }) {
  const [dirTab, setDirTab] = useState<'forward' | 'return'>('forward');
  const warehouses = useAsync(() => getAllWarehouses(), []);
  const whById = useMemo(
    () => new Map((warehouses.data ?? []).map(w => [w.id, w] as const)),
    [warehouses.data],
  );

  return (
    <div>
      <div role="tablist" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '14px' }}>
        {(['forward', 'return'] as const).map(id => (
          <button key={id} role="tab" aria-selected={dirTab === id} onClick={() => setDirTab(id)}
            className="premium-focus-ring"
            style={{
              padding: '8px 13px', minHeight: '40px', borderRadius: 'var(--r2)',
              border: '1px solid var(--brd)', cursor: 'pointer', fontSize: '12.5px', fontWeight: 600,
              background: dirTab === id ? 'var(--p)' : 'var(--s)', color: dirTab === id ? '#fff' : 'var(--t2)',
            }}>
            {t(id === 'forward' ? 'net_op_forward' : 'net_op_return', lang)}
          </button>
        ))}
      </div>

      {warehouses.loading && <PhoenixLoadingState />}
      {!warehouses.loading && dirTab === 'forward' && (
        <ForwardPanel lang={lang} warehouses={warehouses.data ?? []} whById={whById} />
      )}
      {!warehouses.loading && dirTab === 'return' && (
        <ReturnPanel lang={lang} warehouses={warehouses.data ?? []} whById={whById} />
      )}
    </div>
  );
}

// ─── FORWARD: central → institution ──────────────────────────────────────────

function ForwardPanel({ lang, warehouses, whById }: {
  lang: Lang; warehouses: NetworkWarehouse[]; whById: Map<string, NetworkWarehouse>;
}) {
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey(k => k + 1);
  const requests = useAsync(() => getTransferRequests(true), [reloadKey]);
  const incoming = useAsync(() => getTransfers(undefined, true), [reloadKey]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  const open = (requests.data ?? []).find(r => r.id === openId) ?? null;

  if (open) {
    return (
      <ForwardDetail lang={lang} request={open} whById={whById}
        onBack={() => { setOpenId(null); reload(); }}
        onStatus={setStatus} status={status} />
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
        <PhoenixButton onClick={() => setCreating(c => !c)}>{t('net_op_new', lang)}</PhoenixButton>
        <PhoenixButton variant="ghost" onClick={reload}>{t('net_op_refresh', lang)}</PhoenixButton>
      </div>

      <StatusLine status={status} />

      {creating && (
        <ForwardCreateForm lang={lang} warehouses={warehouses}
          onCancel={() => setCreating(false)}
          onDone={(res) => {
            if (res.ok) { setStatus({ msg: t('net_ds_created', lang), error: false }); setCreating(false); reload(); }
            else setStatus({ msg: opErrorMessage(res.error, lang), error: true });
          }} />
      )}

      <h4 style={{ fontSize: '12.5px', fontWeight: 700, margin: '14px 0 8px', color: 'var(--t2)' }}>{t('net_op_requests', lang)}</h4>
      {requests.loading && <PhoenixLoadingState />}
      {!requests.loading && (requests.data ?? []).length === 0 && <PhoenixEmptyState icon="📦" title={t('net_op_none', lang)} />}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {(requests.data ?? []).map(r => (
          <RequestRow key={r.id} label={r.requestNumber} status={r.status}
            sub={`${nameOf(whById.get(r.sourceWarehouseId), lang)} → ${nameOf(whById.get(r.destinationWarehouseId), lang)}`}
            onOpen={() => setOpenId(r.id)} lang={lang} />
        ))}
      </div>

      <h4 style={{ fontSize: '12.5px', fontWeight: 700, margin: '18px 0 8px', color: 'var(--t2)' }}>{t('net_op_incoming', lang)}</h4>
      {incoming.loading && <PhoenixLoadingState />}
      {!incoming.loading && (incoming.data ?? []).length === 0 && <PhoenixEmptyState icon="🚚" title={t('net_op_none', lang)} />}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {(incoming.data ?? []).map(tr => (
          <IncomingTransferRow key={tr.id} lang={lang} transfer={tr} whById={whById}
            onDone={(res) => {
              setStatus(res.ok ? { msg: t('net_op_done', lang), error: false } : { msg: opErrorMessage(res.error, lang), error: true });
              if (res.ok) reload();
            }} />
        ))}
      </div>
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
    <PhoenixCard padding="16px" style={{ marginBottom: '10px', borderColor: 'var(--p)' }}>
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
        <div style={{ marginTop: '10px' }}><PhoenixEmptyState icon="🏬" title={t('net_ds_no_warehouses', lang)} /></div>
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

function ForwardDetail({ lang, request, whById, onBack, onStatus, status }: {
  lang: Lang; request: TransferRequest; whById: Map<string, NetworkWarehouse>;
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

      <StatusLine status={status} />

      {isDraft && (
        <AddForwardLineForm lang={lang} requestId={request.id} onDone={(r) => set(r)} />
      )}

      {lines.loading && <PhoenixLoadingState />}
      {!lines.loading && (lines.data ?? []).length === 0 && <PhoenixEmptyState icon="🧾" title={t('net_op_none', lang)} />}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
        {(lines.data ?? []).map(l => (
          <ForwardLineRow key={l.id} lang={lang} line={l} isDraft={isDraft} canSend={canSend}
            stock={stock.data ?? []} onDone={set} />
        ))}
      </div>

      {isSubmitted && (lines.data ?? []).length > 0 && (
        <ReviewForm lang={lang} lines={lines.data ?? []}
          onSubmit={(decisions) => reviewTransferRequest(request.id, decisions).then(r => set(r))} />
      )}

      <div style={{ display: 'flex', gap: '8px', marginTop: '14px', flexWrap: 'wrap' }}>
        {isDraft && (lines.data ?? []).length > 0 && (
          <PhoenixButton onClick={async () => set(await submitTransferRequest(request.id))}>{t('net_op_submit', lang)}</PhoenixButton>
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
  const [name, setName] = useState('');
  const [qty, setQty] = useState('');
  const [busy, setBusy] = useState(false);
  const n = parseInt(qty, 10);
  const canAdd = name.trim() !== '' && Number.isFinite(n) && n > 0 && !busy;
  return (
    <PhoenixCard padding="12px 14px" style={{ marginBottom: '8px' }}>
      <div style={{ display: 'grid', gap: '8px', gridTemplateColumns: '2fr 1fr auto', alignItems: 'end' }}>
        <PhoenixInput label={t('net_op_scientific', lang)} value={name} onChange={e => setName(e.target.value)} />
        <PhoenixInput label={t('net_op_qty', lang)} type="number" value={qty} onChange={e => setQty(e.target.value)} />
        <PhoenixButton loading={busy} disabled={!canAdd} onClick={async () => {
          setBusy(true);
          const res = await addTransferRequestLine({ transferRequestId: requestId, scientificName: name.trim(), requestedQuantity: n });
          setBusy(false);
          if (res.ok) { setName(''); setQty(''); }
          onDone(res);
        }}>{t('net_op_add_line', lang)}</PhoenixButton>
      </div>
    </PhoenixCard>
  );
}

function ForwardLineRow({ lang, line, isDraft, canSend, stock, onDone }: {
  lang: Lang; line: TransferRequestLine; isDraft: boolean; canSend: boolean;
  stock: import('./network.service').WarehouseStockBatch[]; onDone: (r: RpcResult) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [sending, setSending] = useState(false);
  const [qty, setQty] = useState(String(line.requestedQuantity));
  const remaining = (line.approvedQuantity ?? 0) - line.fulfilledQuantity;
  const sendable = canSend && line.status !== 'rejected' && remaining > 0;

  return (
    <PhoenixCard padding="10px 14px">
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
          onCancel={() => setSending(false)}
          onDone={(r) => { setSending(false); onDone(r); }} />
      )}
    </PhoenixCard>
  );
}

function SendForwardLineForm({ lang, line, remaining, stock, onCancel, onDone }: {
  lang: Lang; line: TransferRequestLine; remaining: number;
  stock: import('./network.service').WarehouseStockBatch[]; onCancel: () => void; onDone: (r: RpcResult) => void;
}) {
  const candidates = stock.filter(s => s.scientificName.toLowerCase() === line.scientificName.toLowerCase() && s.availableQuantity > 0);
  const [stockId, setStockId] = useState('');
  const [qty, setQty] = useState(String(remaining));
  const [number, setNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const effStock = candidates.some(s => s.id === stockId) ? stockId : (candidates[0]?.id ?? '');
  const n = parseInt(qty, 10);
  const canSend = effStock !== '' && Number.isFinite(n) && n > 0 && n <= remaining && number.trim() !== '' && !busy;

  return (
    <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--brd)' }}>
      {candidates.length === 0 ? (
        <PhoenixEmptyState icon="📭" title={t('net_op_none', lang)} />
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
            <PhoenixButton size="sm" loading={busy} disabled={!canSend} onClick={async () => {
              setBusy(true);
              const res = await sendDirectTransferLine({
                requestId: uuid(), transferRequestId: line.transferRequestId, warehouseStockId: effStock,
                quantity: n, transferNumber: number.trim(), transferRequestLineId: line.id,
              });
              setBusy(false); onDone(res);
            }}>{t('net_op_send', lang)}</PhoenixButton>
            <PhoenixButton size="sm" variant="ghost" onClick={onCancel}>{t('net_cancel', lang)}</PhoenixButton>
          </div>
        </div>
      )}
    </div>
  );
}

function IncomingTransferRow({ lang, transfer, whById, onDone }: {
  lang: Lang; transfer: Transfer; whById: Map<string, NetworkWarehouse>; onDone: (r: RpcResult) => void;
}) {
  const [open, setOpen] = useState(false);
  const lines = useAsync(() => (open ? getTransferLines(transfer.id) : Promise.resolve([])), [open]);
  return (
    <PhoenixCard padding="10px 14px">
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
              onReceive={(rq, reason) => receiveTransferLine({
                requestId: uuid(), transferLineId: l.id, receivedQuantity: rq, differenceReason: reason,
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
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const open = (requests.data ?? []).find(r => r.id === openId) ?? null;

  if (open) {
    return (
      <ReturnDetail lang={lang} request={open} whById={whById}
        onBack={() => { setOpenId(null); reload(); }} onStatus={setStatus} status={status} />
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
        <PhoenixButton onClick={() => setCreating(c => !c)}>{t('net_op_new', lang)}</PhoenixButton>
        <PhoenixButton variant="ghost" onClick={reload}>{t('net_op_refresh', lang)}</PhoenixButton>
      </div>

      <StatusLine status={status} />

      {creating && (
        <ReturnCreateForm lang={lang} warehouses={warehouses}
          onCancel={() => setCreating(false)}
          onDone={(res) => {
            if (res.ok) { setStatus({ msg: t('net_op_done', lang), error: false }); setCreating(false); reload(); }
            else setStatus({ msg: opErrorMessage(res.error, lang), error: true });
          }} />
      )}

      <h4 style={{ fontSize: '12.5px', fontWeight: 700, margin: '14px 0 8px', color: 'var(--t2)' }}>{t('net_op_requests', lang)}</h4>
      {requests.loading && <PhoenixLoadingState />}
      {!requests.loading && (requests.data ?? []).length === 0 && <PhoenixEmptyState icon="↩️" title={t('net_op_none', lang)} />}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {(requests.data ?? []).map(r => (
          <RequestRow key={r.id} label={r.returnNumber} status={r.status}
            sub={`${nameOf(whById.get(r.sourceWarehouseId), lang)} → ${nameOf(whById.get(r.destinationWarehouseId), lang)}`}
            onOpen={() => setOpenId(r.id)} lang={lang} />
        ))}
      </div>

      <h4 style={{ fontSize: '12.5px', fontWeight: 700, margin: '18px 0 8px', color: 'var(--t2)' }}>{t('net_op_incoming', lang)}</h4>
      {incoming.loading && <PhoenixLoadingState />}
      {!incoming.loading && (incoming.data ?? []).length === 0 && <PhoenixEmptyState icon="🚚" title={t('net_op_none', lang)} />}
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

function ReturnCreateForm({ lang, warehouses, onCancel, onDone }: {
  lang: Lang; warehouses: NetworkWarehouse[]; onCancel: () => void; onDone: (r: RpcResult) => void;
}) {
  const [mode, setMode] = useState<'request' | 'recall'>('request');
  const [sourceId, setSourceId] = useState('');
  const [destId, setDestId] = useState('');
  const [number, setNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const institutions = warehouses.filter(w => w.warehouseKind === 'institution' && w.status === 'active');
  const centrals = warehouses.filter(w => w.warehouseKind === 'central' && w.status === 'active');
  const effSource = sourceId || (institutions[0]?.id ?? '');
  const effDest = destId || (centrals[0]?.id ?? '');
  const canSubmit = effSource !== '' && effDest !== '' && number.trim() !== '' && !busy;

  return (
    <PhoenixCard padding="16px" style={{ marginBottom: '10px', borderColor: 'var(--p)' }}>
      <div style={{ display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
        <PhoenixSelect label={t('net_op_status', lang)} value={mode} onChange={e => setMode(e.target.value as 'request' | 'recall')}
          options={[
            { value: 'request', label: t('net_op_return_request', lang) },
            { value: 'recall', label: t('net_op_recall', lang) },
          ]} />
        <PhoenixSelect label={t('net_op_return_source', lang)} value={effSource} onChange={e => setSourceId(e.target.value)}
          options={institutions.map(w => ({ value: w.id, label: nameOf(w, lang) }))} />
        <PhoenixSelect label={t('net_op_return_dest', lang)} value={effDest} onChange={e => setDestId(e.target.value)}
          options={centrals.map(w => ({ value: w.id, label: nameOf(w, lang) }))} />
        <PhoenixInput label={t('net_ds_number', lang)} value={number} onChange={e => setNumber(e.target.value)} />
      </div>
      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
        <PhoenixButton loading={busy} disabled={!canSubmit} onClick={async () => {
          setBusy(true);
          const input = { sourceWarehouseId: effSource, destinationWarehouseId: effDest, returnNumber: number.trim() };
          const res = mode === 'request' ? await requestDirectReturn(input) : await recallDirectTransfer(input);
          setBusy(false); onDone(res);
        }}>{mode === 'request' ? t('net_op_return_request', lang) : t('net_op_recall', lang)}</PhoenixButton>
        <PhoenixButton variant="ghost" onClick={onCancel}>{t('net_cancel', lang)}</PhoenixButton>
      </div>
    </PhoenixCard>
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

      <StatusLine status={status} />

      {isDraft && (
        <AddReturnLineForm lang={lang} requestId={request.id}
          transfers={transfers.data ?? []} sourceWarehouseId={request.sourceWarehouseId} onDone={set} />
      )}

      {lines.loading && <PhoenixLoadingState />}
      {!lines.loading && (lines.data ?? []).length === 0 && <PhoenixEmptyState icon="🧾" title={t('net_op_none', lang)} />}
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
    <PhoenixCard padding="12px 14px" style={{ marginBottom: '8px' }}>
      {linesByTransfer.loading ? <PhoenixLoadingState /> : candidates.length === 0 ? (
        <PhoenixEmptyState icon="📭" title={t('net_op_no_provenance', lang)} />
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
    <PhoenixCard padding="10px 14px">
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
              const res = await sendDirectReturnLine({ requestId: uuid(), returnRequestLineId: line.id, quantity: n, shipmentNumber: number.trim() });
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
    <PhoenixCard padding="10px 14px">
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
              onReceive={(rq, reason, disposition) => receiveReturnShipmentLine({
                requestId: uuid(), shipmentLineId: l.id, receivedQuantity: rq,
                differenceReason: reason, dispositionDecision: disposition,
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
    <PhoenixCard padding="10px 14px">
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
  if (done) return <div style={{ fontSize: '12px', color: 'var(--t2)' }}>{label} · ✓</div>;
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
  if (done) return <div style={{ fontSize: '12px', color: 'var(--t2)' }}>{label} · ✓</div>;
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
