import { useRef, useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import { PhoenixDialog } from '@/shared/ui/PhoenixDialog';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixSelect } from '@/shared/ui/PhoenixSelect';
import {
  recordDispenseContext, classifyDispenseContextError,
  type DispenseBeneficiaryType, type OutletMovementForContext,
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
  const [crashCartReference, setCrashCartReference] = useState('');
  const [internalOrderReference, setInternalOrderReference] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef<string | null>(null);

  function reset() {
    setBeneficiaryType('patient'); setPatientIdentifier(''); setPatientName('');
    setCrashCartReference(''); setInternalOrderReference(''); setNotes(''); setError(null);
    requestIdRef.current = null;
  }

  function resetAndClose() {
    if (busy) return;
    reset();
    onClose();
  }

  if (!open || !movement) return null;

  const patientValid = beneficiaryType !== 'patient' || patientIdentifier.trim() !== '' || patientName.trim() !== '';
  const crashCartValid = beneficiaryType !== 'crash_cart' || crashCartReference.trim() !== '';
  const internalOrderValid = beneficiaryType !== 'internal_order' || internalOrderReference.trim() !== '';
  const canSubmit = canRecord && patientValid && crashCartValid && internalOrderValid && !busy;

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
        crashCartReference: crashCartReference.trim() || undefined,
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
      <div style={{ background: 'var(--s2)', border: '1px solid var(--brd)', borderRadius: 'var(--r2)', padding: '12px 14px', marginBottom: '14px', fontSize: '12.5px' }}>
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
                { value: 'patient', label: t('dc_type_patient', lang) },
                { value: 'crash_cart', label: t('dc_type_crash_cart', lang) },
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
                <label htmlFor="dc-patient-id" style={labelStyle}>{t('dc_patient_identifier_label', lang)}</label>
                <input id="dc-patient-id" type="text" dir="auto" value={patientIdentifier} onChange={e => setPatientIdentifier(e.target.value)} style={fieldStyle} />
              </div>
              <div style={{ marginBottom: '12px' }}>
                <label htmlFor="dc-patient-name" style={labelStyle}>{t('dc_patient_name_label', lang)}</label>
                <input id="dc-patient-name" type="text" dir="auto" value={patientName} onChange={e => setPatientName(e.target.value)} style={fieldStyle} />
              </div>
              {!patientValid && <p style={{ fontSize: '11px', color: 'var(--err)', marginBottom: '10px' }}>{t('dc_patient_required', lang)}</p>}
            </>
          )}

          {beneficiaryType === 'crash_cart' && (
            <div style={{ marginBottom: '12px' }}>
              <label htmlFor="dc-cart-ref" style={labelStyle}>{t('dc_crash_cart_reference_label', lang)} *</label>
              <input id="dc-cart-ref" type="text" dir="auto" value={crashCartReference} onChange={e => setCrashCartReference(e.target.value)}
                style={{ ...fieldStyle, border: `1px solid ${crashCartValid ? 'var(--brd)' : 'var(--err)'}` }} />
              {!crashCartValid && <p style={{ fontSize: '11px', color: 'var(--err)', marginTop: '4px' }}>{t('dc_crash_cart_required', lang)}</p>}
            </div>
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
