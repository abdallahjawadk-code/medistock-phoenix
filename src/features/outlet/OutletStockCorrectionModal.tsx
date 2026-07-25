import { useRef, useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import { PhoenixDialog } from '@/shared/ui/PhoenixDialog';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { correctOutletStock, classifyOutletCorrectionError, type OutletStockRow } from './outlet-stock.service';

/**
 * SECOND-PERSON-CORRECTION-APPROVAL — outlet-stock lot correction.
 *
 * The ONLY outlet correction UI. It operates on a canonical outlet_stock LOT
 * (never item_availability, which is a read-only projection) through the
 * REQUEST RPC phoenix_request_outlet_stock_correction (migration 098):
 * idempotent, non-negative, reservation-safe, reason-mandatory, outlet_stock.
 * count-scoped, and append-only. A variance within the organization's
 * configured threshold applies immediately; anything larger is queued as a
 * PENDING request — outlet_stock is untouched until a DIFFERENT authorized
 * person approves it (see PendingCorrectionsPanel). The lot's last-read
 * generation is sent as expectedGeneration so a stale correction fails closed
 * with a conflict rather than overwriting a fresher count — on conflict the
 * operator must reload and re-count. Nothing is written to a stock table from
 * React; the server adjudicates.
 */
interface Props {
  open: boolean;
  lot: OutletStockRow | null;
  lang: 'ar' | 'en';
  canCorrect: boolean;
  onClose: () => void;
  /** requiresApproval distinguishes "applied now" from "queued, pending a
   *  second person" so the caller can show the right confirmation. */
  onSuccess: (requiresApproval: boolean) => void;
}

export function OutletStockCorrectionModal({ open, lot, lang, canCorrect, onClose, onSuccess }: Props) {
  const [counted, setCounted] = useState('');
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Stable request id for THIS correction attempt: reused across a lost-response
  // retry (so the guarded RPC dedupes it), cleared on success/close/conflict.
  const requestIdRef = useRef<string | null>(null);

  function resetAndClose() {
    if (busy) return;
    setCounted(''); setReason(''); setNotes(''); setError(null);
    requestIdRef.current = null;
    onClose();
  }

  if (!open || !lot) return null;

  const countedNum = counted === '' ? null : Number(counted);
  const countedInvalid = counted !== '' && (countedNum === null || !Number.isInteger(countedNum) || countedNum < 0);
  const reasonMissing = !reason.trim();
  const canSubmit = canCorrect && countedNum !== null && Number.isInteger(countedNum) && countedNum >= 0 && !reasonMissing && !busy;

  const previewAfter = countedNum !== null && !Number.isNaN(countedNum) ? countedNum : null;

  async function handleSubmit() {
    if (!canSubmit || countedNum === null) return;
    setBusy(true);
    setError(null);
    if (!requestIdRef.current) requestIdRef.current = crypto.randomUUID();
    try {
      const result = await correctOutletStock({
        requestId: requestIdRef.current,
        outletStockId: lot!.id,
        countedQuantity: countedNum,
        reason: reason.trim(),
        expectedGeneration: lot!.generation,
        notes: notes.trim() || undefined,
      });
      requestIdRef.current = null;
      onSuccess(result.requiresApproval);
      resetAndClose();
    } catch (e) {
      const key = classifyOutletCorrectionError(e);
      // A generation/request conflict means the canonical row moved — the next
      // attempt must be a fresh operation against a reloaded generation.
      if (key === 'outlet_correct_generation_conflict' || key === 'outlet_correct_request_conflict') {
        requestIdRef.current = null;
      }
      setError(t(key, lang));
    } finally {
      setBusy(false);
    }
  }

  const fieldStyle = { width: '100%', padding: '9px 11px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', fontSize: '13px' } as const;
  const labelStyle = { display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' } as const;

  return (
    <PhoenixDialog open={open} onClose={resetAndClose} title={t('oc_correct_title', lang)} maxWidth={480}>
      <div style={{ background: 'var(--s2)', border: '1px solid var(--brd)', borderRadius: 'var(--r2)', padding: '12px 14px', marginBottom: '14px', fontSize: '12.5px' }}>
        <div style={{ fontWeight: 700, marginBottom: '4px' }} dir="auto">
          {lot.scientificName || '—'}{lot.tradeName ? ` (${lot.tradeName})` : ''}
        </div>
        <div style={{ color: 'var(--t2)', display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
          {lot.concentration && <span dir="auto">{lot.concentration}</span>}
          {lot.dosageForm && <span dir="auto">{lot.dosageForm}</span>}
          {lot.batchNumber && <span dir="ltr">{lot.batchNumber}</span>}
          {lot.expiryDate && <span dir="ltr">{lot.expiryDate}</span>}
        </div>
        <div style={{ marginTop: '6px', fontSize: '13px' }}>
          {t('mvmt_current_qty', lang)}: <strong>{lot.onHandQuantity}</strong>
          {lot.reservedQuantity > 0 && <span style={{ color: 'var(--t3)' }}> · {t('mv_returned_against', lang)}: {lot.reservedQuantity}</span>}
        </div>
      </div>

      <p style={{ fontSize: '12px', color: 'var(--t2)', marginBottom: '6px' }} dir="auto">{t('oc_correct_desc', lang)}</p>
      <p style={{ fontSize: '11.5px', color: 'var(--t3)', marginBottom: '14px' }} dir="auto">{t('oc_may_require_approval', lang)}</p>

      {!canCorrect ? (
        <p style={{ fontSize: '12.5px', color: 'var(--err)', textAlign: 'center' }}>{t('oc_no_permission', lang)}</p>
      ) : (
        <>
          <div style={{ marginBottom: '12px' }}>
            <label htmlFor="oc-counted" style={labelStyle}>{t('oc_counted_label', lang)} *</label>
            <input id="oc-counted" type="number" step={1} min={0} value={counted}
              onChange={e => setCounted(e.target.value)}
              style={{ ...fieldStyle, border: `1px solid ${countedInvalid ? 'var(--err)' : 'var(--brd)'}` }} />
            {countedInvalid && <p style={{ fontSize: '11px', color: 'var(--err)', marginTop: '4px' }}><PhoenixIcon name="warning" size={13} inline /> {t('oc_counted_err', lang)}</p>}
          </div>

          <div style={{ marginBottom: '12px' }}>
            <label htmlFor="oc-reason" style={labelStyle}>{t('oc_reason_label', lang)} *</label>
            <input id="oc-reason" type="text" dir="auto" value={reason} onChange={e => setReason(e.target.value)}
              style={{ ...fieldStyle, border: `1px solid ${reasonMissing ? 'var(--err)' : 'var(--brd)'}` }} />
            {reasonMissing && <p style={{ fontSize: '11px', color: 'var(--err)', marginTop: '4px' }}><PhoenixIcon name="warning" size={13} inline /> {t('oc_reason_required', lang)}</p>}
          </div>

          <div style={{ marginBottom: '14px' }}>
            <label htmlFor="oc-notes" style={labelStyle}>{t('oc_notes_label', lang)}</label>
            <textarea id="oc-notes" dir="auto" rows={2} value={notes} onChange={e => setNotes(e.target.value)}
              style={{ ...fieldStyle, resize: 'vertical' }} />
          </div>

          {previewAfter !== null && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', padding: '10px', borderRadius: 'var(--r2)', marginBottom: '14px', background: 'var(--ok2)', border: '1px solid var(--ok)', fontSize: '13px', fontWeight: 700 }}>
              <span>{t('mvmt_preview_before', lang)}: {lot.onHandQuantity}</span>
              <span>→</span>
              <span style={{ color: 'var(--ok)' }}>{t('mvmt_preview_after', lang)}: {previewAfter}</span>
            </div>
          )}

          {error && <p role="alert" style={{ fontSize: '12px', color: 'var(--err)', textAlign: 'center', marginBottom: '10px' }}><PhoenixIcon name="warning" size={13} inline /> {error}</p>}

          <div style={{ display: 'flex', gap: '10px' }}>
            <PhoenixButton variant="ghost" size="md" style={{ flex: 1 }} onClick={resetAndClose} disabled={busy}>{t('oc_cancel', lang)}</PhoenixButton>
            <PhoenixButton variant="primary" size="md" style={{ flex: 2 }} loading={busy} disabled={!canSubmit} onClick={handleSubmit}>{t('oc_submit', lang)}</PhoenixButton>
          </div>
        </>
      )}
    </PhoenixDialog>
  );
}
