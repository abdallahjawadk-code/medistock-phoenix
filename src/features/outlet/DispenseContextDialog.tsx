import { useRef, useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import { PhoenixDialog } from '@/shared/ui/PhoenixDialog';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixSelect } from '@/shared/ui/PhoenixSelect';
import {
  recordDispenseContext, classifyDispenseContextError,
  type DispenseBeneficiaryType, type OutletMovementForContext,
  type StageFPatientReferenceType,
} from './dispense-context.service';

interface Props {
  open: boolean;
  movement: OutletMovementForContext | null;
  lang: 'ar' | 'en';
  canRecord: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

const fieldStyle = { width: '100%', padding: '9px 11px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', fontSize: '13px', boxSizing: 'border-box' } as const;
const labelStyle = { display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' } as const;

/**
 * MOVEMENT-DISPENSE-CONTEXT (134) — the only UI entry point for recording
 * WHO/WHAT a dispense movement was for. Insert-only and idempotent on
 * requestId (the same stable-ref-across-retry pattern as
 * OutletStockCorrectionModal): a lost-response retry replays cleanly, but a
 * genuinely different payload for an already-recorded movement is refused
 * server-side (movement_id_conflict) and surfaced as an error here, never
 * silently overwritten. Patient identity fields are never re-displayed
 * after submit — this dialog only writes, it never reads back the
 * (possibly masked) recorded value; see DispenseContextViewer for that.
 */
export function DispenseContextDialog({ open, movement, lang, canRecord, onClose, onSuccess }: Props) {
  const [beneficiaryType, setBeneficiaryType] = useState<DispenseBeneficiaryType>('patient');
  const [patientIdentifier, setPatientIdentifier] = useState('');
  const [patientName, setPatientName] = useState('');
  const [patientReferenceType, setPatientReferenceType] = useState<'' | StageFPatientReferenceType>('');
  const [internalOrderReference, setInternalOrderReference] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef<string | null>(null);

  function reset() {
    setBeneficiaryType('patient'); setPatientIdentifier(''); setPatientName('');
    setPatientReferenceType(''); setInternalOrderReference(''); setNotes(''); setError(null);
    requestIdRef.current = null;
  }

  function resetAndClose() {
    if (busy) return;
    reset();
    onClose();
  }

  if (!open || !movement) return null;

  // STAGE-F-172: a patient dispense now needs BOTH the reference number and
  // the document it was read from — the server refuses either alone
  // (patient_reference_type_required / patient_identifier_required_for_
  // reference_type), and refuses a document type that is illegal for the
  // outlet's clinical context. The database remains the authority; this is an
  // affordance so the operator is not sent to a guaranteed refusal.
  const patientValid = beneficiaryType !== 'patient'
    || (patientIdentifier.trim() !== '' && patientReferenceType !== '');
  const internalOrderValid = beneficiaryType !== 'internal_order' || internalOrderReference.trim() !== '';
  const canSubmit = canRecord && patientValid && internalOrderValid && !busy;

  async function handleSubmit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    if (!requestIdRef.current) requestIdRef.current = crypto.randomUUID();
    try {
      await recordDispenseContext({
        requestId: requestIdRef.current,
        movementId: movement!.id,
        beneficiaryType,
        patientIdentifier: patientIdentifier.trim() || undefined,
        patientName: patientName.trim() || undefined,
        patientReferenceType: patientReferenceType || undefined,
        internalOrderReference: internalOrderReference.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      requestIdRef.current = null;
      reset();
      onSuccess();
      onClose();
    } catch (e) {
      const key = classifyDispenseContextError(e);
      // A genuine conflict means another payload already won for this
      // movement — retrying the SAME request id would only replay that
      // failure, so the next attempt (if any) must be a fresh operation.
      if (key === 'dispense_context_conflict') requestIdRef.current = null;
      setError(t(key, lang));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PhoenixDialog open={open} onClose={resetAndClose} title={t('dc_dialog_title', lang)} maxWidth={480}>
      <div className="nexus-io-dispense-context-block" style={{ background: 'var(--s2)', border: '1px solid var(--brd)', borderRadius: 'var(--r2)', padding: '12px 14px', marginBottom: '14px', fontSize: '12.5px' }}>
        <div style={{ fontWeight: 700 }} dir="auto">{movement.scientificName}</div>
        <div style={{ color: 'var(--t2)', marginTop: '3px' }} dir="ltr">
          {movement.batchNumber ?? '—'} · {new Date(movement.createdAt).toLocaleString(lang === 'ar' ? 'ar' : 'en')}
        </div>
      </div>

      {!canRecord ? (
        <p style={{ fontSize: '12.5px', color: 'var(--err)', textAlign: 'center' }} dir="auto">{t('dc_no_permission', lang)}</p>
      ) : (
        <>
          <div style={{ marginBottom: '12px' }}>
            <PhoenixSelect
              label={t('dc_beneficiary_type_label', lang)}
              value={beneficiaryType}
              onChange={e => setBeneficiaryType(e.target.value as DispenseBeneficiaryType)}
              options={[
                // STAGE-F-172: 'crash_cart' is retired for NEW dispensing.
                // The cart is a real outlet holding real outlet_stock, fed by
                // Migration 168's routed corridor — not a free-text
                // beneficiary on a pharmacy debit. Historical rows keep
                // rendering through DispenseContextViewer.
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
              {/* STAGE-F-172: the document the reference number was read from.
                  Only card (Visit Card) and chart (Patient Chart) are offered;
                  'pass' is retired for new dispensing. Which of the two is
                  legal depends on the outlet's clinical context and is decided
                  server-side — an illegal choice is refused, never silently
                  accepted. */}
              <div style={{ marginBottom: '12px' }}>
                <PhoenixSelect
                  label={`${t('dc_patient_ref_type_label', lang)} *`}
                  value={patientReferenceType}
                  onChange={e => setPatientReferenceType(e.target.value as '' | StageFPatientReferenceType)}
                  options={[
                    { value: '', label: t('dc_patient_ref_type_choose', lang) },
                    { value: 'card', label: t('dc_patient_ref_card', lang) },
                    { value: 'chart', label: t('dc_patient_ref_chart', lang) },
                  ]}
                />
              </div>
              <div style={{ marginBottom: '12px' }}>
                <label htmlFor="dc-patient-id" style={labelStyle}>{t('dc_patient_identifier_label', lang)} *</label>
                <input id="dc-patient-id" type="text" dir="auto" value={patientIdentifier} onChange={e => setPatientIdentifier(e.target.value)} style={fieldStyle} />
              </div>
              <div style={{ marginBottom: '12px' }}>
                <label htmlFor="dc-patient-name" style={labelStyle}>{t('dc_patient_name_label', lang)}</label>
                <input id="dc-patient-name" type="text" dir="auto" value={patientName} onChange={e => setPatientName(e.target.value)} style={fieldStyle} />
              </div>
              {!patientValid && <p style={{ fontSize: '11px', color: 'var(--err)', marginBottom: '10px' }}>{t('dc_patient_ref_required', lang)}</p>}
            </>
          )}

          {beneficiaryType === 'internal_order' && (
            <div style={{ marginBottom: '12px' }}>
              <label htmlFor="dc-order-ref" style={labelStyle}>{t('dc_internal_order_reference_label', lang)} *</label>
              <input id="dc-order-ref" type="text" dir="auto" value={internalOrderReference} onChange={e => setInternalOrderReference(e.target.value)}
                style={{ ...fieldStyle, border: `1px solid ${internalOrderValid ? 'var(--brd)' : 'var(--err)'}` }} />
              {!internalOrderValid && <p style={{ fontSize: '11px', color: 'var(--err)', marginTop: '4px' }}>{t('dc_internal_order_required', lang)}</p>}
            </div>
          )}

          <div style={{ marginBottom: '14px' }}>
            <label htmlFor="dc-notes" style={labelStyle}>{t('dc_notes_label', lang)}</label>
            <textarea id="dc-notes" dir="auto" rows={2} value={notes} onChange={e => setNotes(e.target.value)} style={{ ...fieldStyle, resize: 'vertical' }} />
          </div>

          {error && <p role="alert" style={{ fontSize: '12px', color: 'var(--err)', textAlign: 'center', marginBottom: '10px' }}><PhoenixIcon name="warning" size={13} inline /> {error}</p>}

          <div style={{ display: 'flex', gap: '10px' }}>
            <PhoenixButton variant="ghost" size="md" style={{ flex: 1 }} onClick={resetAndClose} disabled={busy}>{t('dc_cancel', lang)}</PhoenixButton>
            <PhoenixButton variant="primary" size="md" style={{ flex: 2 }} loading={busy} disabled={!canSubmit} onClick={handleSubmit}>{t('dc_submit', lang)}</PhoenixButton>
          </div>
        </>
      )}
    </PhoenixDialog>
  );
}
