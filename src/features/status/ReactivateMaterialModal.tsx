import { useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import {
  applyAvailabilityMovement,
  classifyAvailabilityMovementError,
  upsertAvailability,
  classifyAvailabilitySaveError,
} from '@/shared/supabase/services/availability.service';
import type { AvailabilityCondition } from '@/shared/lib/types';
import { PhoenixDialog } from '@/shared/ui/PhoenixDialog';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';

/**
 * PHASE2-REMOVED-MATERIAL-REACTIVATION-UX-A
 *
 * Explicit, confirmation-gated reactivation for a row currently marked
 * removed (migration 053's removed_at/removed_by/removal_reason). No new
 * RPC — this calls the same two existing, already-audited write paths used
 * elsewhere in the app, in the specific order migration 053's own upsert
 * logic requires:
 *
 *   A) applyAvailabilityMovement(set_exact, amount=<new quantity>,
 *      reason='reactivated_from_removed') — the only permitted quantity-write
 *      path (migration 035's hard guard). Does NOT touch removed_at/removed_by/
 *      removal_reason itself (only phoenix_apply_availability_movement's
 *      OWN 'removed_from_outlet' reason branch does that); this call just
 *      moves the stored quantity to match what the user is about to confirm,
 *      and is recorded in item_availability_movements like any other movement.
 *
 *   B) upsertAvailability(...) with the SAME identity fields as the existing
 *      row (so phoenix_upsert_availability's identity match resolves to an
 *      UPDATE of this exact row, never an insert) and quantity equal to what
 *      step A just set (migration 035's quantity_update_requires_movement
 *      guard requires this) plus an ACTIVE condition. Migration 053's
 *      v_reactivates branch then clears removed_at/removed_by/removal_reason
 *      in this same call.
 *
 * If step A succeeds but step B fails, the row is left with its new quantity
 * but removed_at is still set — it remains correctly hidden from every
 * live/current view (dashboard, institution outlet list, public QR, live
 * inter-institution alerts) exactly as before, which is safer than any
 * partially-reactivated state. Movement history is preserved either way,
 * since step A's movement row is written unconditionally by the RPC.
 *
 * condition='missing' is deliberately NOT offered here: migration 053's
 * v_reactivates is only true when the existing quantity is > 0 OR the
 * submitted condition is one of available/surplus/near_expiry/low_stock —
 * 'missing' would silently fail to clear the removed marker, leaving the
 * row confusingly quantity>0-but-still-hidden.
 */

export interface ReactivateRow {
  id: string;
  scientific_name: string | null;
  trade_name: string | null;
  dosage_form: string | null;
  concentration: string | null;
  batch_number: string | null;
  national_code: string | null;
  expiry_date: string | null;
  notes: string | null;
  supply_type: string | null;
  price: number | null;
  quantity: number;
  distribution_points: { id: string; name: string; name_ar: string } | null;
}

/** Active conditions only — 'missing' would not clear removed_at (see module doc above). */
const ACTIVE_CONDITIONS: AvailabilityCondition[] = ['available', 'low_stock', 'surplus', 'near_expiry'];

/** The two permission keys migration 053's own RPCs independently re-enforce for this two-step flow (movement then update). UX-only gating — never the security boundary. */
export const REACTIVATE_PERMISSION_KEYS = ['availability.quantity.set', 'availability.update'];

interface Props {
  open: boolean;
  row: ReactivateRow | null;
  lang: 'ar' | 'en';
  organizationId: string;
  myPermissions: Set<string>;
  onClose: () => void;
  onSuccess: () => void;
}

export function ReactivateMaterialModal({ open, row, lang, organizationId, myPermissions, onClose, onSuccess }: Props) {
  const canReactivate = REACTIVATE_PERMISSION_KEYS.every(key => myPermissions.has(key));

  const [quantity, setQuantity] = useState('');
  const [condition, setCondition] = useState<AvailabilityCondition>('available');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function resetAndClose() {
    if (busy) return; // loading state prevents duplicate submit / mid-flight cancel
    setQuantity('');
    setCondition('available');
    setNote('');
    setError(null);
    onClose();
  }

  if (!open || !row) return null;

  const qtyNum = quantity === '' ? null : Number(quantity);
  const qtyInvalid = quantity !== '' && (qtyNum === null || !Number.isInteger(qtyNum) || qtyNum <= 0);
  const canSubmit = canReactivate && qtyNum !== null && Number.isInteger(qtyNum) && qtyNum > 0 && !busy;

  async function handleSubmit() {
    if (!canSubmit || qtyNum === null) return;
    setBusy(true);
    setError(null);
    let movementDone = false;
    try {
      await applyAvailabilityMovement({
        itemAvailabilityId: row!.id,
        movementType: 'set_exact',
        amount: qtyNum,
        reason: 'reactivated_from_removed',
        notes: note.trim() || undefined,
      });
      movementDone = true;

      await upsertAvailability({
        distributionPointId: row!.distribution_points?.id ?? '',
        organizationId,
        scientificName: row!.scientific_name ?? '',
        tradeName: row!.trade_name ?? undefined,
        dosageForm: row!.dosage_form ?? undefined,
        concentrationValue: row!.concentration ?? undefined,
        price: row!.price ?? undefined,
        quantity: qtyNum,
        condition,
        batchNumber: row!.batch_number ?? undefined,
        expiryDate: row!.expiry_date ?? undefined,
        notes: row!.notes ?? undefined,
        supplyType: row!.supply_type ?? undefined,
        nationalCode: row!.national_code ?? undefined,
      });

      onSuccess();
      resetAndClose();
    } catch (e) {
      // Step A (movement) and step B (upsert) surface differently-shaped RPC
      // errors — classify against whichever step actually failed so the
      // toast stays accurate rather than always assuming the movement path.
      setError(t(movementDone ? classifyAvailabilitySaveError(e) : classifyAvailabilityMovementError(e), lang));
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
    <PhoenixDialog open={open} onClose={resetAndClose} title={t('sc_reactivate_title', lang)} maxWidth={480}>
      {/* Material identity */}
      <div style={{ background: 'var(--s2)', border: '1px solid var(--brd)', borderRadius: 'var(--r2)', padding: '12px 14px', marginBottom: '12px', fontSize: '12.5px' }}>
        <div style={{ fontWeight: 700, marginBottom: '4px' }} dir="auto">
          {row.scientific_name || '—'}{row.trade_name ? ` (${row.trade_name})` : ''}
        </div>
        <div style={{ color: 'var(--t2)', display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
          {row.concentration && <span dir="auto">{row.concentration}</span>}
          {row.dosage_form && <span dir="auto">{row.dosage_form}</span>}
          {row.batch_number && <span dir="ltr">{row.batch_number}</span>}
          {row.expiry_date && <span dir="ltr">{row.expiry_date}</span>}
          {dpName && <span dir="auto"><PhoenixIcon name="hospital" size={13} inline /> {dpName}</span>}
        </div>
      </div>

      <p style={{ fontSize: '12px', color: 'var(--t2)', marginBottom: '14px' }} dir="auto">
        {t('sc_reactivate_desc', lang)}
      </p>

      {!canReactivate ? (
        <p style={{ fontSize: '12.5px', color: 'var(--err)', textAlign: 'center' }}>
          {t('sc_reactivate_no_permission_tooltip', lang)}
        </p>
      ) : (
        <>
          {/* New quantity */}
          <div style={{ marginBottom: '12px' }}>
            <label htmlFor="reactivate-qty" style={labelStyle}>{t('sc_reactivate_qty_label', lang)} *</label>
            <input
              id="reactivate-qty"
              type="number"
              step={1}
              min={1}
              value={quantity}
              onChange={e => setQuantity(e.target.value)}
              style={{ ...fieldStyle, border: `1px solid ${qtyInvalid ? 'var(--err)' : 'var(--brd)'}` }}
            />
            {qtyInvalid && (
              <p style={{ fontSize: '11px', color: 'var(--err)', marginTop: '4px' }}>
<PhoenixIcon name="warning" size={13} inline /> {t('sc_reactivate_qty_err', lang)}
              </p>
            )}
          </div>

          {/* Active condition only — 'missing' is intentionally excluded */}
          <div style={{ marginBottom: '12px' }}>
            <label htmlFor="reactivate-condition" style={labelStyle}>{t('sc_reactivate_condition_label', lang)} *</label>
            <select
              id="reactivate-condition"
              value={condition}
              onChange={e => setCondition(e.target.value as AvailabilityCondition)}
              style={{ ...fieldStyle, appearance: 'none', cursor: 'pointer' }}
            >
              {ACTIVE_CONDITIONS.map(c => (
                <option key={c} value={c}>{t('cond_' + c, lang)}</option>
              ))}
            </select>
          </div>

          {/* Optional note (recorded on the movement, not stored on the material) */}
          <div style={{ marginBottom: '14px' }}>
            <label htmlFor="reactivate-note" style={labelStyle}>{t('sc_reactivate_notes_label', lang)}</label>
            <textarea
              id="reactivate-note"
              dir="auto"
              rows={2}
              value={note}
              onChange={e => setNote(e.target.value)}
              style={{ ...fieldStyle, resize: 'vertical' }}
            />
          </div>

          {error && (
            <p role="alert" style={{ fontSize: '12px', color: 'var(--err)', textAlign: 'center', marginBottom: '10px' }}>
<PhoenixIcon name="warning" size={13} inline /> {error}
            </p>
          )}

          <div style={{ display: 'flex', gap: '10px' }}>
            <PhoenixButton variant="ghost" size="md" style={{ flex: 1 }} onClick={resetAndClose} disabled={busy}>
              {t('sc_reactivate_cancel', lang)}
            </PhoenixButton>
            <PhoenixButton variant="primary" size="md" style={{ flex: 2 }} loading={busy} disabled={!canSubmit} onClick={handleSubmit}>
              {t('sc_reactivate_submit', lang)}
            </PhoenixButton>
          </div>
        </>
      )}
    </PhoenixDialog>
  );
}
