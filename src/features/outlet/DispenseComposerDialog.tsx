import { useRef, useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import { PhoenixDialog } from '@/shared/ui/PhoenixDialog';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixSelect } from '@/shared/ui/PhoenixSelect';
import {
  dispenseWithContext, classifyDispenseContextError, patientFefoRecommendation,
  type DispenseBeneficiaryType, type PatientReferenceType,
} from './dispense-context.service';
import type { OutletStockRow } from './outlet-stock.service';

interface Props {
  open: boolean;
  lot: OutletStockRow | null;
  /** STAGE-F-172: the outlet's other lots, used ONLY to compute a FEFO
   *  recommendation for the operator. Advisory — see patientFefoRecommendation. */
  lots?: readonly OutletStockRow[];
  lang: 'ar' | 'en';
  canDispense: boolean;
  onClose: () => void;
  onSuccess: (quantityAfter: number) => void;
}

const fieldStyle = {
  width: '100%', padding: '9px 11px', borderRadius: 'var(--r2)',
  border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)',
  fontSize: '13px', boxSizing: 'border-box',
} as const;
const labelStyle = {
  display: 'block', fontSize: '11.5px', fontWeight: 600,
  color: 'var(--t2)', marginBottom: '5px',
} as const;

/**
 * DISPENSE-WITH-CONTEXT-136 — the outlet dispense composer.
 *
 * The ONLY dispense entry point in the app. It never calls the bare dispense
 * RPC: it calls phoenix_dispense_outlet_stock_with_context, which moves the
 * quantity AND records who it was for in ONE server transaction. If the
 * beneficiary is invalid the server rolls the dispense back too, so the
 * operator can never end up with stock gone and no beneficiary recorded —
 * a guarantee the browser cannot provide by chaining two calls itself.
 *
 * The form is DISCRIMINATED on beneficiary type: only the fields valid for
 * the chosen type are rendered, and switching type clears the others so a
 * stale value from a previous choice can never be submitted. Every rule
 * enforced here is re-enforced server-side; this is preflight, not
 * authorization.
 */
export function DispenseComposerDialog({ open, lot, lots, lang, canDispense, onClose, onSuccess }: Props) {
  const [quantity, setQuantity] = useState('');
  const [beneficiaryType, setBeneficiaryType] = useState<DispenseBeneficiaryType>('patient');
  const [patientName, setPatientName] = useState('');
  const [patientReferenceType, setPatientReferenceType] = useState<PatientReferenceType>('chart');
  const [patientIdentifier, setPatientIdentifier] = useState('');
  const [internalOrderReference, setInternalOrderReference] = useState('');
  const [reason, setReason] = useState('');
  const [contextNotes, setContextNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Stable across a lost-response retry of THIS attempt, so the server
  // dedupes rather than double-dispensing. Cleared on success/close/conflict.
  const requestIdRef = useRef<string | null>(null);

  /** Switching beneficiary type must not leave another type's value behind. */
  function selectBeneficiaryType(next: DispenseBeneficiaryType) {
    setBeneficiaryType(next);
    setPatientName(''); setPatientIdentifier(''); setPatientReferenceType('chart');
    setInternalOrderReference('');
    setError(null);
  }

  function reset() {
    setQuantity('');
    selectBeneficiaryType('patient');
    setReason(''); setContextNotes(''); setError(null);
    requestIdRef.current = null;
  }

  function resetAndClose() {
    if (busy) return;
    reset();
    onClose();
  }

  if (!open || !lot) return null;

  // STAGE-F-172: which batch of THIS exact material FEFO would take first at
  // this outlet. Advisory only — it reserves nothing and blocks nothing; the
  // operator may still dispense the batch they physically hold, and the
  // canonical RPC remains the sole authority over the final debit.
  const fefoPick = lots && lots.length > 0
    ? patientFefoRecommendation(lots, {
        scientificName: lot.scientificName,
        nationalCode: lot.nationalCode,
        concentration: lot.concentration,
        dosageForm: lot.dosageForm,
        unit: lot.unit,
      })
    : null;

  const qtyNum = quantity === '' ? null : Number(quantity);
  const qtyInvalid = quantity !== '' && (qtyNum === null || !Number.isInteger(qtyNum) || qtyNum <= 0);
  const qtyExceeds = qtyNum !== null && qtyNum > lot.availableQuantity;

  // Patient: a name is always required; a reference NUMBER and its TYPE are
  // only meaningful together (the server enforces the same pairing).
  const patientNameMissing = beneficiaryType === 'patient' && patientName.trim() === '';
  // STAGE-F-172: the reference NUMBER is no longer optional for a patient
  // dispense — the server now requires the document type, and refuses a type
  // with no number (patient_identifier_required_for_reference_type). The type
  // itself always has a value, so only the number can be missing.
  const patientRefIncomplete = beneficiaryType === 'patient' && patientIdentifier.trim() === '';
  const internalOrderMissing = beneficiaryType === 'internal_order' && internalOrderReference.trim() === '';

  const canSubmit =
    canDispense && !busy &&
    qtyNum !== null && Number.isInteger(qtyNum) && qtyNum > 0 && !qtyExceeds &&
    !patientNameMissing && !patientRefIncomplete && !internalOrderMissing;

  async function handleSubmit() {
    if (!canSubmit || qtyNum === null) return;
    setBusy(true);
    setError(null);
    if (!requestIdRef.current) requestIdRef.current = crypto.randomUUID();
    try {
      const result = await dispenseWithContext({
        requestId: requestIdRef.current,
        outletStockId: lot!.id,
        quantity: qtyNum,
        beneficiaryType,
        patientName: patientName.trim() || undefined,
        patientIdentifier: patientIdentifier.trim() || undefined,
        // Only send a reference type when a number accompanies it — the
        // server refuses one without the other.
        patientReferenceType: patientIdentifier.trim() ? patientReferenceType : undefined,
        internalOrderReference: internalOrderReference.trim() || undefined,
        reason: reason.trim() || undefined,
        contextNotes: contextNotes.trim() || undefined,
      });
      requestIdRef.current = null;
      const after = result.quantityAfter;
      reset();
      onSuccess(after);
      onClose();
    } catch (e) {
      const key = classifyDispenseContextError(e);
      // Anything that means "the world moved" must start a FRESH operation;
      // replaying the same request id would only replay the same failure.
      if (key === 'dispense_context_conflict' || key === 'dispense_insufficient_stock') {
        requestIdRef.current = null;
      }
      setError(t(key, lang));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PhoenixDialog open={open} onClose={resetAndClose} title={t('dsp_title', lang)} maxWidth={520}>
      <div className="nexus-io-dispense-body">
      <div className="nexus-io-dispense-context-block" style={{ background: 'var(--s2)', border: '1px solid var(--brd)', borderRadius: 'var(--r2)', padding: '12px 14px', marginBottom: '14px', fontSize: '12.5px' }}>
        <div style={{ fontWeight: 700, marginBottom: '4px' }} dir="auto">{lot.scientificName}</div>
        <div style={{ color: 'var(--t2)', display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
          {lot.batchNumber && <span dir="ltr">{lot.batchNumber}</span>}
          {lot.expiryDate && <span dir="ltr">{lot.expiryDate}</span>}
        </div>
        <div style={{ marginTop: '6px', fontSize: '13px' }}>
          {t('mv_available', lang)}: <strong>{lot.availableQuantity}</strong>
        </div>
        {/* STAGE-F-172: FEFO advice, never a claim. It does not reserve, hold
            or guarantee this batch — the canonical RPC re-locks and re-checks
            whichever row is finally submitted. */}
        {fefoPick && fefoPick.id !== lot.id && (
          <div role="note" style={{ marginTop: '8px', fontSize: '11.5px', color: 'var(--warn)' }} dir="auto">
            <PhoenixIcon name="warning" size={12} inline />{' '}
            {t('dsp_fefo_earlier_batch', lang)}{' '}
            <span dir="ltr">{fefoPick.batchNumber ?? '—'}</span>
            {fefoPick.expiryDate && <> · <span dir="ltr">{fefoPick.expiryDate}</span></>}
          </div>
        )}
        {fefoPick && fefoPick.id === lot.id && (
          <div style={{ marginTop: '8px', fontSize: '11.5px', color: 'var(--ok)' }} dir="auto">
            {t('dsp_fefo_is_earliest', lang)}
          </div>
        )}
      </div>

      {!canDispense ? (
        <p style={{ fontSize: '12.5px', color: 'var(--err)', textAlign: 'center' }} dir="auto">{t('dsp_no_permission', lang)}</p>
      ) : (
        <>
          <div style={{ marginBottom: '12px' }}>
            <label htmlFor="dsp-qty" style={labelStyle}>{t('dsp_quantity_label', lang)} *</label>
            <input
              id="dsp-qty" type="number" step={1} min={1} value={quantity}
              onChange={e => setQuantity(e.target.value)}
              aria-invalid={qtyInvalid || qtyExceeds}
              style={{ ...fieldStyle, border: `1px solid ${qtyInvalid || qtyExceeds ? 'var(--err)' : 'var(--brd)'}` }}
            />
            {qtyInvalid && <p role="alert" style={{ fontSize: '11px', color: 'var(--err)', marginTop: '4px' }}>{t('dsp_quantity_invalid', lang)}</p>}
            {qtyExceeds && <p role="alert" style={{ fontSize: '11px', color: 'var(--err)', marginTop: '4px' }}>{t('dsp_quantity_exceeds', lang)}</p>}
          </div>

          <div style={{ marginBottom: '12px' }}>
            <PhoenixSelect
              label={t('dc_beneficiary_type_label', lang)}
              value={beneficiaryType}
              onChange={e => selectBeneficiaryType(e.target.value as DispenseBeneficiaryType)}
              options={[
                // STAGE-F-172: crash_cart is retired as a dispensing
                // beneficiary. The cart is a real outlet holding real
                // outlet_stock, fed by Migration 168's routed corridor —
                // not a free-text beneficiary on a pharmacy debit.
                { value: 'patient', label: t('dc_type_patient', lang) },
                { value: 'internal_order', label: t('dc_type_internal_order', lang) },
              ]}
            />
          </div>

          {beneficiaryType === 'patient' && (
            <>
              <p style={{ fontSize: '11px', color: 'var(--t3)', marginBottom: '10px' }} dir="auto">
                <PhoenixIcon name="lock" size={12} inline /> {t('dc_patient_privacy_note', lang)}
              </p>
              <div style={{ marginBottom: '12px' }}>
                <label htmlFor="dsp-patient-name" style={labelStyle}>{t('dc_patient_name_label', lang)} *</label>
                <input id="dsp-patient-name" type="text" dir="auto" value={patientName}
                  onChange={e => setPatientName(e.target.value)}
                  aria-invalid={patientNameMissing}
                  style={{ ...fieldStyle, border: `1px solid ${patientNameMissing ? 'var(--err)' : 'var(--brd)'}` }} />
                {patientNameMissing && <p role="alert" style={{ fontSize: '11px', color: 'var(--err)', marginTop: '4px' }}>{t('dsp_patient_name_required', lang)}</p>}
              </div>
              <div style={{ marginBottom: '12px' }}>
                <PhoenixSelect
                  label={t('dsp_reference_type_label', lang)}
                  value={patientReferenceType}
                  onChange={e => setPatientReferenceType(e.target.value as PatientReferenceType)}
                  options={[
                    // STAGE-F-172: 'pass' is retired for NEW patient
                    // dispensing (the server refuses it); historical rows
                    // keep rendering in DispenseContextViewer. Which of
                    // card/chart is legal for THIS outlet is decided
                    // server-side from its clinical context.
                    { value: 'chart', label: t('dsp_ref_chart', lang) },
                    { value: 'card', label: t('dsp_ref_card', lang) },
                  ]}
                />
              </div>
              <div style={{ marginBottom: '12px' }}>
                <label htmlFor="dsp-patient-ref" style={labelStyle}>{t('dsp_reference_number_label', lang)}</label>
                <input id="dsp-patient-ref" type="text" dir="auto" value={patientIdentifier}
                  onChange={e => setPatientIdentifier(e.target.value)} style={fieldStyle} />
              </div>
            </>
          )}

          {beneficiaryType === 'internal_order' && (
            <div style={{ marginBottom: '12px' }}>
              <label htmlFor="dsp-order" style={labelStyle}>{t('dc_internal_order_reference_label', lang)} *</label>
              <input id="dsp-order" type="text" dir="auto" value={internalOrderReference}
                onChange={e => setInternalOrderReference(e.target.value)}
                aria-invalid={internalOrderMissing}
                style={{ ...fieldStyle, border: `1px solid ${internalOrderMissing ? 'var(--err)' : 'var(--brd)'}` }} />
              {internalOrderMissing && <p role="alert" style={{ fontSize: '11px', color: 'var(--err)', marginTop: '4px' }}>{t('dc_internal_order_required', lang)}</p>}
            </div>
          )}

          <div style={{ marginBottom: '12px' }}>
            <label htmlFor="dsp-reason" style={labelStyle}>{t('dsp_reason_label', lang)}</label>
            <input id="dsp-reason" type="text" dir="auto" value={reason}
              onChange={e => setReason(e.target.value)} style={fieldStyle} />
          </div>

          <div style={{ marginBottom: '14px' }}>
            <label htmlFor="dsp-context-notes" style={labelStyle}>{t('dc_notes_label', lang)}</label>
            <textarea id="dsp-context-notes" dir="auto" rows={2} value={contextNotes}
              onChange={e => setContextNotes(e.target.value)} style={{ ...fieldStyle, resize: 'vertical' }} />
          </div>

          {qtyNum !== null && !qtyInvalid && !qtyExceeds && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', padding: '10px', borderRadius: 'var(--r2)', marginBottom: '14px', background: 'var(--ok2)', border: '1px solid var(--ok)', fontSize: '13px', fontWeight: 700 }}>
              <span>{t('mvmt_preview_before', lang)}: {lot.availableQuantity}</span>
              <span>→</span>
              <span style={{ color: 'var(--ok)' }}>{t('mvmt_preview_after', lang)}: {lot.availableQuantity - qtyNum}</span>
            </div>
          )}

          <p style={{ fontSize: '11px', color: 'var(--t3)', marginBottom: '10px' }} dir="auto">{t('dsp_atomic_note', lang)}</p>

          {error && <p role="alert" style={{ fontSize: '12px', color: 'var(--err)', textAlign: 'center', marginBottom: '10px' }}><PhoenixIcon name="warning" size={13} inline /> {error}</p>}

          <div style={{ display: 'flex', gap: '10px' }}>
            <PhoenixButton variant="ghost" size="md" style={{ flex: 1 }} onClick={resetAndClose} disabled={busy}>{t('dc_cancel', lang)}</PhoenixButton>
            <PhoenixButton variant="primary" size="md" style={{ flex: 2 }} loading={busy} disabled={!canSubmit} onClick={handleSubmit}>{t('dsp_submit', lang)}</PhoenixButton>
          </div>
        </>
      )}
      </div>
    </PhoenixDialog>
  );
}
