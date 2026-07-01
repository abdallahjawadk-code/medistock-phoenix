import { useState } from 'react';
import { t } from '@/shared/i18n/strings';
import {
  applyAvailabilityMovement,
  classifyAvailabilityMovementError,
  type AvailabilityMovementType,
  type ApplyAvailabilityMovementResult,
} from '@/shared/supabase/services/availability.service';
import { PhoenixDialog } from '@/shared/ui/PhoenixDialog';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';

/**
 * AVAILABILITY-QUANTITY-MOVEMENT-UI-A
 *
 * Controlled quantity-movement modal. Calls applyAvailabilityMovement()
 * (migration 034's phoenix_apply_availability_movement RPC) — this is the
 * only write path; the modal never touches item_availability or
 * item_availability_movements directly. Movement type options are filtered
 * by the caller's permission set before this component ever sees them, but
 * the RPC independently re-enforces the same permission matrix server-side
 * (this modal's filtering is UX-only, not the security boundary).
 */

export interface AdjustQuantityRow {
  id: string;
  scientific_name: string | null;
  trade_name: string | null;
  concentration: string | null;
  dosage_form: string | null;
  quantity: number;
  distribution_points: { id: string; name: string; name_ar: string } | null;
}

interface MovementOption {
  value: AvailabilityMovementType;
  permKey: string;
  labelKey: string;
}

const MOVEMENT_OPTIONS: MovementOption[] = [
  { value: 'set_exact',  permKey: 'availability.quantity.set',      labelKey: 'mvmt_set_exact' },
  { value: 'add',        permKey: 'availability.quantity.add',      labelKey: 'mvmt_add' },
  { value: 'subtract',   permKey: 'availability.quantity.subtract', labelKey: 'mvmt_subtract' },
  { value: 'correction', permKey: 'availability.quantity.correct',  labelKey: 'mvmt_correction' },
];

/** The 4 quantity-movement permission keys — exported so callers (e.g. the
 * row action button) can decide visibility without duplicating this list. */
export const QUANTITY_MOVEMENT_PERMISSION_KEYS = MOVEMENT_OPTIONS.map(o => o.permKey);

interface Props {
  open: boolean;
  row: AdjustQuantityRow | null;
  lang: 'ar' | 'en';
  myPermissions: Set<string>;
  onClose: () => void;
  onSuccess: (result: ApplyAvailabilityMovementResult) => void;
}

export function AdjustQuantityModal({ open, row, lang, myPermissions, onClose, onSuccess }: Props) {
  const availableOptions = MOVEMENT_OPTIONS.filter(o => myPermissions.has(o.permKey));

  const [movementType, setMovementType] = useState<AvailabilityMovementType | ''>('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function resetAndClose() {
    if (busy) return; // loading state prevents duplicate submit / mid-flight cancel
    setMovementType('');
    setAmount('');
    setReason('');
    setNotes('');
    setError(null);
    onClose();
  }

  if (!open || !row) return null;

  const currentQty = row.quantity;
  const amountNum = amount === '' ? null : Number(amount);
  const selectedType = movementType || (availableOptions[0]?.value ?? '');

  const isPositiveOnly = selectedType === 'add' || selectedType === 'subtract';
  const isCorrection = selectedType === 'correction';

  // Client-side preview only — the RPC independently recomputes and enforces
  // this server-side using the authoritative row value, never trusting this preview.
  let previewAfter: number | null = null;
  if (amountNum !== null && !Number.isNaN(amountNum) && selectedType) {
    if (selectedType === 'set_exact' || selectedType === 'correction') previewAfter = amountNum;
    else if (selectedType === 'add') previewAfter = currentQty + amountNum;
    else if (selectedType === 'subtract') previewAfter = currentQty - amountNum;
  }
  const previewNegative = previewAfter !== null && previewAfter < 0;

  const amountInvalid = amountNum === null || Number.isNaN(amountNum)
    ? false // don't show a range error before the user has typed anything
    : (isPositiveOnly ? amountNum <= 0 : amountNum < 0);

  const reasonMissing = isCorrection && !reason.trim();

  const canSubmit = !!selectedType
    && amountNum !== null && !Number.isNaN(amountNum)
    && !amountInvalid
    && !reasonMissing
    && !previewNegative
    && !busy;

  async function handleSubmit() {
    if (!canSubmit || !selectedType || amountNum === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await applyAvailabilityMovement({
        itemAvailabilityId: row!.id,
        movementType: selectedType,
        amount: amountNum,
        reason: reason.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      onSuccess(result);
      resetAndClose();
    } catch (e) {
      setError(t(classifyAvailabilityMovementError(e), lang));
    } finally {
      setBusy(false);
    }
  }

  const fieldStyle = { width: '100%', padding: '9px 11px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', fontSize: '13px' } as const;
  const labelStyle = { display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' } as const;

  const dpName = row.distribution_points
    ? (lang === 'ar' ? (row.distribution_points.name_ar || row.distribution_points.name) : row.distribution_points.name)
    : null;

  return (
    <PhoenixDialog open={open} onClose={resetAndClose} title={t('sc_adjust_qty_title', lang)} maxWidth={480}>
      {/* Material identity */}
      <div style={{ background: 'var(--s2)', border: '1px solid var(--brd)', borderRadius: 'var(--r2)', padding: '12px 14px', marginBottom: '16px', fontSize: '12.5px' }}>
        <div style={{ fontWeight: 700, marginBottom: '4px' }} dir="auto">
          {row.scientific_name || '—'}{row.trade_name ? ` (${row.trade_name})` : ''}
        </div>
        <div style={{ color: 'var(--t2)', display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
          {row.concentration && <span dir="auto">{row.concentration}</span>}
          {row.dosage_form && <span dir="auto">{row.dosage_form}</span>}
          {dpName && <span dir="auto">🏥 {dpName}</span>}
        </div>
        <div style={{ marginTop: '6px', fontSize: '13px' }}>
          {t('mvmt_current_qty', lang)}: <strong>{currentQty}</strong>
        </div>
      </div>

      {availableOptions.length === 0 ? (
        <p style={{ fontSize: '12.5px', color: 'var(--err)', textAlign: 'center' }}>
          {t('sc_adjust_qty_no_permission_tooltip', lang)}
        </p>
      ) : (
        <>
          {/* Movement type */}
          <div style={{ marginBottom: '12px' }}>
            <label htmlFor="mvmt-type" style={labelStyle}>{t('mvmt_type_label', lang)}</label>
            <select
              id="mvmt-type"
              value={selectedType}
              onChange={e => setMovementType(e.target.value as AvailabilityMovementType)}
              style={{ ...fieldStyle, appearance: 'none', cursor: 'pointer' }}
            >
              {availableOptions.map(o => (
                <option key={o.value} value={o.value}>{t(o.labelKey, lang)}</option>
              ))}
            </select>
          </div>

          {/* Amount */}
          <div style={{ marginBottom: '12px' }}>
            <label htmlFor="mvmt-amount" style={labelStyle}>{t('mvmt_amount', lang)} *</label>
            <input
              id="mvmt-amount"
              type="number"
              step={1}
              min={isPositiveOnly ? 1 : 0}
              value={amount}
              onChange={e => setAmount(e.target.value)}
              style={{ ...fieldStyle, border: `1px solid ${amountInvalid ? 'var(--err)' : 'var(--brd)'}` }}
            />
            {amountInvalid && (
              <p style={{ fontSize: '11px', color: 'var(--err)', marginTop: '4px' }}>
                ⚠ {t(isPositiveOnly ? 'mvmt_amount_err_positive' : 'mvmt_amount_err_non_negative', lang)}
              </p>
            )}
          </div>

          {/* Reason */}
          <div style={{ marginBottom: '12px' }}>
            <label htmlFor="mvmt-reason" style={labelStyle}>
              {t('mvmt_reason', lang)}{isCorrection ? ' *' : ''}
            </label>
            <input
              id="mvmt-reason"
              type="text"
              dir="auto"
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder={t('mvmt_reason_ph', lang)}
              style={{ ...fieldStyle, border: `1px solid ${reasonMissing ? 'var(--err)' : 'var(--brd)'}` }}
            />
            {reasonMissing && (
              <p style={{ fontSize: '11px', color: 'var(--err)', marginTop: '4px' }}>⚠ {t('mvmt_reason_required_err', lang)}</p>
            )}
          </div>

          {/* Notes */}
          <div style={{ marginBottom: '14px' }}>
            <label htmlFor="mvmt-notes" style={labelStyle}>{t('mvmt_notes', lang)}</label>
            <textarea
              id="mvmt-notes"
              dir="auto"
              rows={2}
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder={t('mvmt_notes_ph', lang)}
              style={{ ...fieldStyle, resize: 'vertical' }}
            />
          </div>

          {/* Before/after preview */}
          {previewAfter !== null && (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
              padding: '10px', borderRadius: 'var(--r2)', marginBottom: '14px',
              background: previewNegative ? 'var(--err2)' : 'var(--ok2)',
              border: `1px solid ${previewNegative ? 'var(--err)' : 'var(--ok)'}`,
              fontSize: '13px', fontWeight: 700,
            }}>
              <span>{t('mvmt_preview_before', lang)}: {currentQty}</span>
              <span>→</span>
              <span style={{ color: previewNegative ? 'var(--err)' : 'var(--ok)' }}>
                {t('mvmt_preview_after', lang)}: {previewAfter}
              </span>
            </div>
          )}
          {previewNegative && (
            <p style={{ fontSize: '11.5px', color: 'var(--err)', textAlign: 'center', marginBottom: '10px' }}>
              ⚠ {t('mvmt_preview_negative_err', lang)}
            </p>
          )}

          {error && (
            <p role="alert" style={{ fontSize: '12px', color: 'var(--err)', textAlign: 'center', marginBottom: '10px' }}>
              ⚠ {error}
            </p>
          )}

          <div style={{ display: 'flex', gap: '10px' }}>
            <PhoenixButton variant="ghost" size="md" style={{ flex: 1 }} onClick={resetAndClose} disabled={busy}>
              {t('mvmt_cancel', lang)}
            </PhoenixButton>
            <PhoenixButton variant="primary" size="md" style={{ flex: 2 }} loading={busy} disabled={!canSubmit} onClick={handleSubmit}>
              {t('mvmt_submit', lang)}
            </PhoenixButton>
          </div>
        </>
      )}
    </PhoenixDialog>
  );
}
