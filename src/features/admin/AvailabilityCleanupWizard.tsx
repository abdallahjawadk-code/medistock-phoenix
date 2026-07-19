import { useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { normalizeRole } from '@/shared/lib/roles';
import {
  dryRunAvailabilityDeepClean, executeAvailabilityDeepClean, DEEP_CLEAN_AVAILABILITY_CONFIRMATION,
  type AvailabilityDeepCleanCounts,
} from '@/shared/supabase/services/admin-cleanup.service';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';

const fieldStyle = {
  width: '100%', padding: '9px 12px', borderRadius: 'var(--r2)',
  border: '1px solid var(--brd)', background: 'var(--s)',
  color: 'var(--t)', fontSize: '12.5px',
} as const;

interface Props {
  lang: 'ar' | 'en';
  role: string;
}

/**
 * Safe-to-render technical error detail. Only ever populated from Supabase/
 * PostgREST error fields (code/message/details/hint) or an RPC business
 * error code (e.g. INVALID_CONFIRMATION) — never from auth tokens, headers,
 * or env vars, none of which flow through these sources.
 */
interface TechnicalErrorDetail {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

function toTechnicalErrorDetail(err: unknown): TechnicalErrorDetail {
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    return {
      code: typeof e.code === 'string' ? e.code : undefined,
      message: typeof e.message === 'string' ? e.message : undefined,
      details: typeof e.details === 'string' ? e.details : undefined,
      hint: typeof e.hint === 'string' ? e.hint : undefined,
    };
  }
  if (typeof err === 'string') return { message: err };
  return {};
}

/**
 * Super Admin-only maintenance wizard for phoenix_clean_availability_data
 * (migration 055, PHASE3-DEEP-CLEAN-AVAILABILITY-DATA-A). Physically deletes
 * item_availability, item_availability_movements, and linked inter-org
 * alert/exchange rows — never institutions, outlets, QR links, users,
 * permissions, or material master data. Dry run is mandatory before execute
 * is even reachable; execute additionally requires a backup/export
 * acknowledgement checkbox and an exact typed confirmation phrase. Never
 * runs automatically on mount and never calls execute except through the
 * explicit confirm button after every guard passes — the frontend guards
 * are UX only, the real check is the server-side super_admin role check
 * inside the RPC itself.
 */
export function AvailabilityCleanupWizard({ lang, role }: Props) {
  const isSuper = normalizeRole(role) === 'super_admin';

  const [dryRunCounts, setDryRunCounts] = useState<AvailabilityDeepCleanCounts | null>(null);
  const [dryRunBusy, setDryRunBusy] = useState(false);
  const [dryRunError, setDryRunError] = useState<string | null>(null);

  const [backupAcknowledged, setBackupAcknowledged] = useState(false);
  const [confirmationText, setConfirmationText] = useState('');
  const [executeBusy, setExecuteBusy] = useState(false);
  const [executeError, setExecuteError] = useState<string | null>(null);
  const [executeErrorDetail, setExecuteErrorDetail] = useState<TechnicalErrorDetail | null>(null);
  const [executeResult, setExecuteResult] = useState<AvailabilityDeepCleanCounts | null>(null);

  if (!isSuper) return null;

  const confirmationMatches = confirmationText === DEEP_CLEAN_AVAILABILITY_CONFIRMATION;
  const canExecute = dryRunCounts !== null && backupAcknowledged && confirmationMatches && !executeBusy;

  async function onDryRun() {
    setDryRunBusy(true);
    setDryRunError(null);
    setExecuteResult(null);
    try {
      const res = await dryRunAvailabilityDeepClean();
      if (!res.ok) {
        setDryRunError(res.error);
        setDryRunCounts(null);
        return;
      }
      setDryRunCounts(res.counts);
    } catch {
      setDryRunError('NETWORK_ERROR');
      setDryRunCounts(null);
    } finally {
      setDryRunBusy(false);
    }
  }

  async function onExecute() {
    if (!canExecute) return;
    setExecuteBusy(true);
    setExecuteError(null);
    setExecuteErrorDetail(null);
    try {
      const res = await executeAvailabilityDeepClean(confirmationText);
      if (!res.ok) {
        // Business-rule rejection from the RPC itself (e.g.
        // INVALID_CONFIRMATION, INSUFFICIENT_ROLE, NOT_AUTHENTICATED) — the
        // RPC's own error code is the "technical detail" here, no Supabase
        // error object involved.
        setExecuteError(res.error);
        setExecuteErrorDetail({ code: res.error });
        return;
      }
      setExecuteResult(res.rowsDeletedByTable);
      setDryRunCounts(null);
      setBackupAcknowledged(false);
      setConfirmationText('');
    } catch (err) {
      // A thrown Supabase/PostgREST error (network failure or a genuine
      // Postgres exception raised inside the RPC — FK violation, RLS denial,
      // permission error, etc.). Capture its safe, well-known fields
      // (code/message/details/hint) so the real cause is diagnosable instead
      // of being replaced by a single generic string. These fields never
      // carry auth tokens, headers, or env vars — Supabase's PostgrestError
      // shape only ever contains this exact set.
      console.error('phoenix_clean_availability_data execute failed:', err);
      setExecuteError('NETWORK_ERROR');
      setExecuteErrorDetail(toTechnicalErrorDetail(err));
    } finally {
      setExecuteBusy(false);
    }
  }

  return (
    <PhoenixCard padding="18px" style={{ marginTop: '20px' }}>
      <h3 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '8px' }}>
        {t('acw_title', lang)}
      </h3>
      <div style={{ background: 'var(--err2)', border: '1px solid var(--err)', borderRadius: 'var(--r2)', padding: '10px 14px', marginBottom: '10px', fontSize: '12px', color: 'var(--err)' }} dir="auto">
<PhoenixIcon name="warning" size={13} inline /> {t('acw_delete_materials_warning', lang)}
      </div>
      <div style={{ background: 'var(--err2)', border: '1px solid var(--err)', borderRadius: 'var(--r2)', padding: '10px 14px', marginBottom: '14px', fontSize: '12px', color: 'var(--err)' }} dir="auto">
<PhoenixIcon name="warning" size={13} inline /> {t('acw_delete_movements_warning', lang)}
      </div>
      <p style={{ fontSize: '12px', color: 'var(--t2)', marginBottom: '6px' }} dir="auto">
        {t('acw_delete_alert_exchange_note', lang)}
      </p>
      <p style={{ fontSize: '12px', color: 'var(--t2)', marginBottom: '6px' }} dir="auto">
        {t('acw_preserved_data_explainer', lang)}
      </p>
      <p style={{ fontSize: '12px', color: 'var(--t2)', marginBottom: '10px' }} dir="auto">
        {t('acw_post_cleanup_effect_note', lang)}
      </p>

      <PhoenixButton variant="ghost" size="md" loading={dryRunBusy} onClick={onDryRun}>
        {t('acw_dry_run_button', lang)}
      </PhoenixButton>

      {dryRunError && (
        <p style={{ fontSize: '12px', color: 'var(--err)', marginTop: '10px' }} dir="auto">
          {t('acw_dry_run_failed', lang)}
        </p>
      )}

      {dryRunCounts && (
        <div style={{ marginTop: '14px', paddingTop: '12px', borderTop: '1px solid var(--brd)' }}>
          <div style={{ fontSize: '12.5px', fontWeight: 700, marginBottom: '8px' }}>{t('acw_counts_title', lang)}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '4px 12px', fontSize: '12px', color: 'var(--t2)' }}>
            <span>{t('acw_count_availability', lang)}</span><span>{dryRunCounts.item_availability}</span>
            <span>{t('acw_count_movements', lang)}</span><span>{dryRunCounts.item_availability_movements}</span>
            <span>{t('acw_count_alert_states', lang)}</span><span>{dryRunCounts.inter_org_alert_states}</span>
            <span>{t('acw_count_alert_events', lang)}</span><span>{dryRunCounts.inter_org_alert_events}</span>
            <span>{t('acw_count_exchange_requests', lang)}</span><span>{dryRunCounts.inter_org_exchange_requests}</span>
            <span>{t('acw_count_exchange_events', lang)}</span><span>{dryRunCounts.inter_org_exchange_events}</span>
          </div>

          <div style={{ marginTop: '16px', paddingTop: '12px', borderTop: '1px solid var(--brd)' }}>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '12px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={backupAcknowledged}
                onChange={e => setBackupAcknowledged(e.target.checked)}
              />
              <span dir="auto">{t('acw_backup_ack_label', lang)}</span>
            </label>

            <div style={{ marginTop: '12px' }}>
              <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }} dir="auto">
                {t('acw_confirmation_label', lang)}
              </label>
              <input
                type="text"
                value={confirmationText}
                onChange={e => setConfirmationText(e.target.value)}
                style={fieldStyle}
                dir="ltr"
                placeholder={DEEP_CLEAN_AVAILABILITY_CONFIRMATION}
                aria-label={t('acw_confirmation_label', lang)}
              />
            </div>

            {executeError && (
              <div style={{ marginTop: '10px' }}>
                <p style={{ fontSize: '12px', color: 'var(--err)' }} dir="auto">
                  {t('acw_execute_failed', lang)}
                </p>
                {executeErrorDetail && (executeErrorDetail.code || executeErrorDetail.message || executeErrorDetail.details || executeErrorDetail.hint) && (
                  <div style={{ marginTop: '6px', padding: '8px 10px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: 'var(--s)', fontSize: '11px', color: 'var(--t2)' }} dir="ltr">
                    <div style={{ fontWeight: 700, marginBottom: '4px' }} dir="auto">{t('acw_technical_details', lang)}</div>
                    {executeErrorDetail.code && (
                      <div><strong>{t('acw_error_code', lang)}:</strong> {executeErrorDetail.code}</div>
                    )}
                    {executeErrorDetail.message && (
                      <div><strong>{t('acw_error_message', lang)}:</strong> {executeErrorDetail.message}</div>
                    )}
                    {executeErrorDetail.details && (
                      <div><strong>{t('acw_error_details', lang)}:</strong> {executeErrorDetail.details}</div>
                    )}
                    {executeErrorDetail.hint && (
                      <div><strong>{t('acw_error_hint', lang)}:</strong> {executeErrorDetail.hint}</div>
                    )}
                  </div>
                )}
              </div>
            )}

            <div style={{ marginTop: '14px' }}>
              <PhoenixButton variant="primary" size="md" disabled={!canExecute} loading={executeBusy} onClick={onExecute}>
                {t('acw_execute_button', lang)}
              </PhoenixButton>
            </div>
          </div>
        </div>
      )}

      {executeResult && (
        <div style={{ marginTop: '14px', background: 'var(--info2)', border: '1px solid var(--info)', borderRadius: 'var(--r2)', padding: '10px 14px', fontSize: '12px', color: 'var(--info)' }} dir="auto">
          {t('acw_execute_success', lang)} — {t('acw_count_availability', lang)}: {executeResult.item_availability}, {t('acw_count_movements', lang)}: {executeResult.item_availability_movements}
        </div>
      )}
    </PhoenixCard>
  );
}
