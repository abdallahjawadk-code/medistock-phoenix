import { t } from '@/shared/i18n/strings';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import type { DispenseContext } from './dispense-context.service';

const typeLabelKey: Record<DispenseContext['beneficiaryType'], string> = {
  patient: 'dc_type_patient',
  crash_cart: 'dc_type_crash_cart',
  internal_order: 'dc_type_internal_order',
};

/**
 * MOVEMENT-DISPENSE-CONTEXT (134) — inline, read-only display of a recorded
 * dispense context. Renders exactly what phoenix_get_movement_dispense_
 * context returned: if patientIdentityMasked is true, patientIdentifier/
 * patientName are already null from the server (movement_context.
 * view_sensitive not held) — this component only shows the masked-state
 * indicator, it never reconstructs a hidden value client-side.
 */
export function DispenseContextViewer({ context, lang }: { context: DispenseContext; lang: 'ar' | 'en' }) {
  return (
    <div style={{ marginTop: '6px', padding: '8px 10px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: 'var(--s2)', fontSize: '11.5px' }} data-testid="dispense-context-viewer">
      <div style={{ fontWeight: 700, marginBottom: '4px' }} dir="auto">
        {t(typeLabelKey[context.beneficiaryType], lang)}
      </div>
      {context.beneficiaryType === 'patient' && (
        context.patientIdentityMasked ? (
          <div style={{ color: 'var(--t3)' }} dir="auto"><PhoenixIcon name="lock" size={12} inline /> {t('dc_identity_masked', lang)}</div>
        ) : (
          <div style={{ color: 'var(--t2)' }} dir="auto">
            {context.patientName ?? '—'}{context.patientIdentifier ? ` · ${context.patientIdentifier}` : ''}
          </div>
        )
      )}
      {context.beneficiaryType === 'crash_cart' && (
        <div style={{ color: 'var(--t2)' }} dir="auto">{context.crashCartReference}</div>
      )}
      {context.beneficiaryType === 'internal_order' && (
        <div style={{ color: 'var(--t2)' }} dir="auto">{context.internalOrderReference}</div>
      )}
      {context.notes && <div style={{ color: 'var(--t3)', marginTop: '3px' }} dir="auto">{context.notes}</div>}
    </div>
  );
}
