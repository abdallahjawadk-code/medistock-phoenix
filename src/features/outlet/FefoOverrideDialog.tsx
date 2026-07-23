import { useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { PhoenixDialog } from '@/shared/ui/PhoenixDialog';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import type { StockCandidate } from '@/features/movement/composer-model';
import type { FefoBatch } from './dispatch.service';

interface Props {
  open: boolean;
  /** The batch the operator picked — NOT the FEFO-earliest one. */
  picked: StockCandidate | null;
  /** Every eligible batch for this material, FEFO-ordered (earliest first). */
  alternatives: FefoBatch[];
  /** Preflight only — the RPC re-checks server-side. */
  canOverride: boolean;
  /** Cancelling performs NO write of any kind — the line is never added. */
  onCancel: () => void;
  /** Only called with a non-empty, trimmed reason. */
  onConfirmOverride: (reason: string) => void;
  /** Switches the picker's selection to the given (earliest, compliant) batch. */
  onUseAlternative: (stockId: string) => void;
  lang: 'ar' | 'en';
}

/**
 * FEFO-REASONED-OVERRIDE (097/102) — shown whenever the operator picks a
 * batch that is NOT the earliest-expiry eligible one for that material.
 * Earliest-first alternatives are always shown, regardless of permission.
 * The override option (a checkbox + mandatory reason) is offered ONLY to
 * holders of `inventory.fefo_override` on this warehouse; anyone else sees
 * the alternatives with no way to proceed with their original pick.
 * Cancelling never adds the line — the picker's own commit path is the only
 * write, and it never fires from this dialog.
 */
export function FefoOverrideDialog({
  open, picked, alternatives, canOverride, onCancel, onConfirmOverride, onUseAlternative, lang,
}: Props) {
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);

  if (!open || !picked) return null;

  const earliest = alternatives[0] ?? null;
  const reasonValid = reason.trim() !== '';

  function reset() {
    setReason('');
    setConfirmed(false);
  }

  function handleCancel() {
    reset();
    onCancel();
  }

  function handleConfirm() {
    if (!reasonValid) return;
    const r = reason.trim();
    reset();
    onConfirmOverride(r);
  }

  return (
    <PhoenixDialog open={open} onClose={handleCancel} title={t('fefo_override_title', lang)} maxWidth={520}>
      <p style={{ fontSize: '12.5px', color: 'var(--warn)', marginBottom: '12px' }} dir="auto">
        <PhoenixIcon name="warning" size={13} inline /> {t('fefo_override_warning', lang)}
      </p>

      <div style={{ background: 'var(--s2)', border: '1px solid var(--brd)', borderRadius: 'var(--r2)', padding: '10px 12px', marginBottom: '12px', fontSize: '12px' }}>
        <div style={{ fontWeight: 700 }} dir="auto">{picked.scientificName}</div>
        <div style={{ color: 'var(--t2)', marginTop: '3px' }} dir="ltr">
          {t('fefo_picked_batch', lang)}: {picked.batchNumber ?? '—'} · {picked.expiryDate ?? '—'}
        </div>
      </div>

      <p style={{ fontSize: '12px', color: 'var(--t2)', marginBottom: '8px' }} dir="auto">{t('fefo_alternatives_title', lang)}</p>
      <div style={{ display: 'grid', gap: '6px', marginBottom: '14px' }} data-testid="fefo-alternatives">
        {alternatives.map(alt => (
          <div key={alt.stockId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', padding: '8px 10px', border: '1px solid var(--brd)', borderRadius: 'var(--r2)', background: 'var(--s)' }}>
            <div style={{ fontSize: '12px' }} dir="ltr">
              {alt.batchNumber ?? '—'} · {alt.expiryDate ?? '—'} · {t('mv_available', lang)}: {alt.availableQuantity}
            </div>
            {alt.stockId !== picked.warehouseStockId && (
              <PhoenixButton variant="ghost" size="sm" onClick={() => { reset(); onUseAlternative(alt.stockId); }}>
                {t('fefo_use_this_batch', lang)}
              </PhoenixButton>
            )}
          </div>
        ))}
        {earliest === null && (
          <p style={{ fontSize: '12px', color: 'var(--t2)' }} dir="auto">{t('fefo_no_alternatives', lang)}</p>
        )}
      </div>

      {!canOverride ? (
        <p style={{ fontSize: '12.5px', color: 'var(--err)', textAlign: 'center' }} dir="auto">{t('fefo_override_no_permission', lang)}</p>
      ) : (
        <>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', minHeight: '44px', padding: '4px 2px', fontSize: '12.5px', marginBottom: '10px', cursor: 'pointer' }}>
            <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} style={{ width: '18px', height: '18px', flexShrink: 0 }} />
            {t('fefo_confirm_override_checkbox', lang)}
          </label>
          {confirmed && (
            <div style={{ marginBottom: '10px' }}>
              <label htmlFor="fefo-reason" style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>
                {t('fefo_override_reason_label', lang)} *
              </label>
              <input id="fefo-reason" type="text" dir="auto" value={reason} onChange={e => setReason(e.target.value)}
                style={{ width: '100%', minHeight: '44px', padding: '9px 11px', borderRadius: 'var(--r2)', border: `1px solid ${reasonValid ? 'var(--brd)' : 'var(--err)'}`, background: 'var(--s)', color: 'var(--t)', fontSize: '13px', boxSizing: 'border-box' }} />
              {!reasonValid && <p style={{ fontSize: '11px', color: 'var(--err)', marginTop: '4px' }}>{t('fefo_override_reason_required', lang)}</p>}
            </div>
          )}
        </>
      )}

      <div style={{ display: 'flex', gap: '10px', marginTop: '4px' }}>
        <PhoenixButton variant="ghost" size="md" style={{ flex: 1 }} onClick={handleCancel}>{t('mv_cancel', lang)}</PhoenixButton>
        {canOverride && (
          <PhoenixButton variant="primary" size="md" style={{ flex: 2 }} disabled={!confirmed || !reasonValid} onClick={handleConfirm}>
            {t('fefo_confirm_override', lang)}
          </PhoenixButton>
        )}
      </div>
    </PhoenixDialog>
  );
}
