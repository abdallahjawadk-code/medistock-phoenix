/**
 * OUTLET-RETURN-EXCEPTION-RESOLUTION-157 — the institution warehouse's queue
 * of stuck exception_pending outlet-return shipment lines (a zero-quantity
 * receipt: 135's own receive RPC set custody_state='exception_pending' and
 * created no stock/quarantine row of any kind).
 *
 * Two owner-mandated resolution paths, mutually exclusive per line:
 *   - corrected_receipt  — the zero-entry was a mistake; a real quantity DID
 *     arrive. Requires a quantity and a restockable/quarantined decision.
 *   - confirmed_no_stock — genuinely nothing arrived. A mandatory-reason
 *     administrative closure, no stock movement of any kind.
 *
 * The ORIGINAL exception line is never rewritten by either path (157's own
 * RPC contract) — resolving removes a line from THIS list (it no longer
 * satisfies "exception_pending AND not yet resolved"), but never changes
 * outlet_return_shipment_lines.custody_state itself.
 */
import { useMemo, useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';
import { PhoenixSelect } from '@/shared/ui/PhoenixSelect';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import {
  runStockMutation, type TokenedWriter,
} from '@/shared/lib/stock-mutation-runner';
import {
  getExceptionPendingLines, resolveOutletReturnException,
  type OutletReturnShipmentLine,
} from './outlet-return.service';

type Lang = 'ar' | 'en';
type ResolutionKind = 'corrected_receipt' | 'confirmed_no_stock';

const dash = (v: string | null | undefined) => (v == null || v === '' ? '—' : v);

/** Namespaces the derived idempotency token for this corridor. */
const RESOLVE_KIND = 'outlet_return_exception_resolve';

interface ResolvePayload {
  returnShipmentLineId: string;
  resolutionKind: ResolutionKind;
  reason: string;
  correctedQuantity: number | null;
  dispositionDecision: 'restockable' | 'quarantined' | null;
}

/**
 * The single injected writer: the 157 resolution RPC. The request id is
 * DERIVED (stock-mutation-runner.ts), never minted, so a retry of a lost
 * response cannot resolve the same line twice — and switching resolution
 * kind/quantity/disposition/reason for the same line derives a DIFFERENT
 * token, so it is never mistaken for a replay of the first attempt.
 */
const writeResolveException: TokenedWriter<ResolvePayload> = (requestId, payload) =>
  resolveOutletReturnException({
    requestId,
    returnShipmentLineId: payload.returnShipmentLineId,
    resolutionKind: payload.resolutionKind,
    reason: payload.reason,
    correctedQuantity: payload.correctedQuantity,
    dispositionDecision: payload.dispositionDecision,
  });

function resolveError(code: string | undefined, lang: Lang): string {
  const c = (code ?? '').toUpperCase();
  if (c.includes('FORBIDDEN') || c.includes('NOT_AUTHORIZED') || c === '42501') return t('net_err_not_authorized', lang);
  if (c.includes('ALREADY_RESOLVED')) return t('mv_exception_already_resolved', lang);
  if (c.includes('CONFLICT') || c === '23505') return t('net_err_conflict', lang);
  if (c.endsWith('NOT_FOUND')) return t('net_err_not_found', lang);
  return t('net_err_invalid', lang);
}

interface Props {
  destinationWarehouseId: string;
  warehouseName: string;
  canResolve: boolean;
  lang: Lang;
}

type LineState = { state: 'succeeded' | 'failed'; error: string | null };
type LineForm = {
  kind: ResolutionKind;
  reason: string;
  quantity: string;
  disposition: 'restockable' | 'quarantined';
};

const defaultForm = (line: OutletReturnShipmentLine): LineForm => ({
  kind: 'confirmed_no_stock', reason: '', quantity: String(line.sentQuantity), disposition: 'restockable',
});

export function OutletReturnExceptions({ destinationWarehouseId, warehouseName, canResolve, lang }: Props) {
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey(k => k + 1);

  const lines = useAsync(
    () => getExceptionPendingLines(destinationWarehouseId),
    [destinationWarehouseId, reloadKey],
  );

  const [busy, setBusy] = useState(false);
  const [lineStates, setLineStates] = useState<Record<string, LineState>>({});
  const [forms, setForms] = useState<Record<string, LineForm>>({});

  const allLines = useMemo(() => lines.data ?? [], [lines.data]);
  const formOf = (line: OutletReturnShipmentLine): LineForm => forms[line.id] ?? defaultForm(line);
  const setForm = (id: string, patch: Partial<LineForm>) =>
    setForms(f => ({ ...f, [id]: { ...(f[id] ?? defaultForm(allLines.find(l => l.id === id)!)), ...patch } }));

  const resolveLine = async (line: OutletReturnShipmentLine) => {
    if (busy || !canResolve) return;
    const form = formOf(line);
    const reason = form.reason.trim();
    if (reason === '') {
      setLineStates(s => ({ ...s, [line.id]: { state: 'failed', error: t('mv_exception_reason_required', lang) } }));
      return;
    }
    const quantity = form.kind === 'corrected_receipt' ? Number(form.quantity) : null;
    if (form.kind === 'corrected_receipt' && (!Number.isFinite(quantity) || (quantity as number) <= 0)) {
      setLineStates(s => ({ ...s, [line.id]: { state: 'failed', error: t('mv_exception_quantity_invalid', lang) } }));
      return;
    }

    setBusy(true);
    const result = await runStockMutation(writeResolveException, RESOLVE_KIND, {
      entityId: line.id,
      generation: 0, // resolution only ever happens once per line (157's UNIQUE constraint) — no partial-progress measure to fold in, same reasoning as add-line's own generation:0.
      payload: {
        returnShipmentLineId: line.id,
        resolutionKind: form.kind,
        reason,
        correctedQuantity: form.kind === 'corrected_receipt' ? quantity : null,
        dispositionDecision: form.kind === 'corrected_receipt' ? form.disposition : null,
      },
    });
    setLineStates(s => ({
      ...s,
      [line.id]: result.ok
        ? { state: 'succeeded', error: null }
        : { state: 'failed', error: resolveError(result.error, lang) },
    }));
    // Canonical reload: a resolved line disappears from this queue only once
    // the SERVER confirms (query excludes lines with a resolution row).
    reload();
    setBusy(false);
  };

  if (lines.loading && allLines.length === 0) return <PhoenixLoadingState />;

  const failures = Object.entries(lineStates).filter(([, v]) => v.state === 'failed');
  const successes = Object.entries(lineStates).filter(([, v]) => v.state === 'succeeded');

  return (
    <div dir={dir} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div>
        <h3 style={{ fontSize: '16px', fontWeight: 700 }}>{t('mv_return_exceptions_title', lang)}</h3>
        <p style={{ fontSize: '12.5px', color: 'var(--t2)', marginTop: '3px' }}>
          {t('mv_h_destination', lang)}: {warehouseName}
        </p>
      </div>

      {(failures.length > 0 || successes.length > 0) && (
        <div
          data-testid="return-exception-outcome"
          style={{
            background: failures.length > 0 ? 'var(--err2)' : 'var(--ok2)',
            border: `1px solid ${failures.length > 0 ? 'var(--err)' : 'var(--ok)'}`,
            borderRadius: 'var(--r3)', padding: '12px 14px', fontSize: '12px',
            color: failures.length > 0 ? 'var(--err)' : 'var(--ok)',
          }}
        >
          <strong>{failures.length > 0 ? t('mv_partial_title', lang) : t('mv_line_succeeded', lang)}</strong>
          <div style={{ marginTop: '4px' }}>
            {t('mv_line_succeeded', lang)}: {successes.length} · {t('mv_line_failed', lang)}: {failures.length}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <PhoenixButton variant="ghost" disabled={busy} onClick={reload}>{t('retry', lang)}</PhoenixButton>
      </div>

      {allLines.length === 0 ? (
        <PhoenixEmptyState icon="check" title={t('mv_return_exceptions_none', lang)} />
      ) : (
        <div style={{ display: 'grid', gap: '10px' }} data-testid="return-exception-lines">
          {allLines.map(line => {
            const form = formOf(line);
            const state = lineStates[line.id];

            return (
              <PhoenixCard key={line.id}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: '13px', fontWeight: 700 }}>{line.scientificName}</div>
                    <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '3px' }}>
                      {t('mv_f_batch_number', lang)}: {dash(line.batchNumber)} ·{' '}
                      {t('mv_f_expiry_date', lang)}: {dash(line.expiryDate)}
                    </div>
                    <div style={{ fontSize: '11.5px', color: 'var(--t2)' }}>
                      {t('mv_f_moved_quantity', lang)}: <strong>{line.sentQuantity}</strong> ·{' '}
                      {t('mv_f_original_supply_reference', lang)}: <code>{line.originalDispatchLineId}</code>
                    </div>
                    <div style={{ fontSize: '11.5px', color: 'var(--warn)', fontWeight: 700, marginTop: '4px' }}>
                      {t('mv_f_return_reason', lang)}: {dash(line.differenceReason)}
                    </div>
                    {state?.error && (
                      <div style={{ fontSize: '11.5px', color: 'var(--err)', marginTop: '3px' }}>{state.error}</div>
                    )}
                  </div>

                  <div style={{ display: 'grid', gap: '6px', minWidth: '260px' }}>
                    <PhoenixSelect
                      label={t('mv_f_resolution_kind', lang)}
                      value={form.kind}
                      disabled={busy || !canResolve}
                      onChange={e => setForm(line.id, { kind: e.target.value as ResolutionKind })}
                      options={[
                        { value: 'confirmed_no_stock', label: t('mv_resolution_confirmed_no_stock', lang) },
                        { value: 'corrected_receipt', label: t('mv_resolution_corrected_receipt', lang) },
                      ]}
                    />
                    {form.kind === 'corrected_receipt' && (
                      <>
                        <PhoenixInput
                          label={t('mv_f_corrected_quantity', lang)}
                          value={form.quantity}
                          inputMode="numeric"
                          disabled={busy || !canResolve}
                          onChange={e => setForm(line.id, { quantity: e.target.value })}
                        />
                        <PhoenixSelect
                          label={t('mv_f_disposition', lang)}
                          value={form.disposition}
                          disabled={busy || !canResolve}
                          onChange={e => setForm(line.id, { disposition: e.target.value as 'restockable' | 'quarantined' })}
                          options={[
                            { value: 'restockable', label: t('net_op_disp_restock', lang) },
                            { value: 'quarantined', label: t('net_op_disp_quarantine', lang) },
                          ]}
                        />
                      </>
                    )}
                    <PhoenixInput
                      label={t('mv_f_resolution_reason', lang)}
                      value={form.reason}
                      disabled={busy || !canResolve}
                      onChange={e => setForm(line.id, { reason: e.target.value })}
                    />
                    <PhoenixButton
                      disabled={busy || !canResolve}
                      onClick={() => void resolveLine(line)}
                      data-testid={`resolve-exception-${line.id}`}
                    >
                      {t('mv_resolve_exception', lang)}
                    </PhoenixButton>
                  </div>
                </div>
              </PhoenixCard>
            );
          })}
        </div>
      )}
    </div>
  );
}
