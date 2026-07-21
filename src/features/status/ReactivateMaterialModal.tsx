import { useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import {
  setAvailabilityVisibility,
  classifyAvailabilityVisibilityError,
} from '@/shared/supabase/services/availability.service';
import { PhoenixDialog } from '@/shared/ui/PhoenixDialog';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';

/**
 * AVAILABILITY-CATALOGUE-VISIBILITY-084 (supersedes PHASE2-REMOVED-MATERIAL-
 * REACTIVATION-UX-A's two-step flow).
 *
 * Reactivation is now CATALOGUE VISIBILITY ONLY. Migration 083 made physical
 * availability a server-derived projection (phoenix_available_stock); a removed
 * catalogue row's quantity is no longer stock truth, so reactivating it must not
 * ask an operator to re-type a quantity. This modal simply clears migration
 * 053's removed marker via phoenix_set_availability_visibility (migration 084) —
 * ONE RPC, no quantity write, no condition write. The stored quantity/condition
 * are left exactly as they were; what the outlet actually has is derived from
 * the canonical ledgers.
 *
 * The previous movement-then-upsert path (a manual quantity writer) is GONE from
 * this surface. The parity-gated revoke of those writers is migration 085
 * (prepared).
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

/** The single permission key migration 084's RPC independently re-enforces for a
 *  visibility change. UX-only gating — never the security boundary. */
export const REACTIVATE_PERMISSION_KEYS = ['availability.update'];

interface Props {
  open: boolean;
  row: ReactivateRow | null;
  lang: 'ar' | 'en';
  myPermissions: Set<string>;
  onClose: () => void;
  onSuccess: () => void;
}

export function ReactivateMaterialModal({ open, row, lang, myPermissions, onClose, onSuccess }: Props) {
  const canReactivate = REACTIVATE_PERMISSION_KEYS.every(key => myPermissions.has(key));

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function resetAndClose() {
    if (busy) return; // loading state prevents duplicate submit / mid-flight cancel
    setError(null);
    onClose();
  }

  if (!open || !row) return null;

  const canSubmit = canReactivate && !busy;

  async function handleSubmit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      // Visibility only: clear the 053 removed marker. Quantity/condition are
      // never sent and never changed — availability is derived (083).
      await setAvailabilityVisibility(row!.id, false);
      onSuccess();
      resetAndClose();
    } catch (e) {
      setError(t(classifyAvailabilityVisibilityError(e), lang));
    } finally {
      setBusy(false);
    }
  }

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
