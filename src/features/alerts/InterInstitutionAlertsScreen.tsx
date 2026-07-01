import { useMemo, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixDialog } from '@/shared/ui/PhoenixDialog';
import {
  getLiveInterInstitutionAlertsWithState,
  updateInterOrgAlertState,
  reopenInterOrgAlert,
  getInterOrgAlertEvents,
  type LiveInterInstitutionAlertWithState,
  type LiveAlertType,
  type LiveAlertSeverity,
  type AlertLifecycleStatus,
  type AlertLifecycleEvent,
  type GetAlertEventsResult,
} from './inter-org-alert-lifecycle.service';

/**
 * LIVE-INTER-INSTITUTION-ALERTS-UI-A
 *
 * Reads exclusively through getLiveInterInstitutionAlertsWithState(), which
 * merges the live computation with persisted lifecycle state. This screen has no dependency on the
 * manual report layer's data path anywhere in its imports or types.
 * Permission enforcement (the inter-institution-alerts view permission or
 * its legacy backward-compatible equivalent, super_admin bypass, org-scoped
 * visibility) happens entirely server-side inside the RPC; this screen only
 * renders whatever it is given and surfaces a FORBIDDEN response as a
 * permission-denied state.
 */

const ALERT_TYPE_LABEL_KEY: Record<LiveAlertType, string> = {
  surplus_to_shortage: 'lia_type_surplus',
  near_expiry_to_shortage: 'lia_type_near_expiry',
};

const SEVERITY_BORDER: Record<LiveAlertSeverity, string> = {
  high: 'var(--err)',
  medium: 'var(--warn)',
};

function statusLabelKey(status: string): string {
  switch (status) {
    case 'surplus': return 'cond_surplus';
    case 'near_expiry': return 'cond_near_expiry';
    case 'missing': return 'cond_missing';
    case 'low_stock': return 'cond_low_stock';
    default: return '';
  }
}

function statusVariant(status: string): 'ok' | 'warn' | 'err' | 'neutral' {
  switch (status) {
    case 'surplus': return 'ok';
    case 'near_expiry': return 'warn';
    case 'missing': return 'err';
    case 'low_stock': return 'warn';
    default: return 'neutral';
  }
}

function orgName(name: string | null, nameAr: string | null, lang: 'ar' | 'en'): string {
  if (lang === 'ar') return nameAr || name || '—';
  return name || nameAr || '—';
}

function pointName(name: string | null, nameAr: string | null, lang: 'ar' | 'en'): string | null {
  const v = lang === 'ar' ? (nameAr || name) : (name || nameAr);
  return v || null;
}

const fieldStyle = {
  width: '100%', padding: '9px 12px', borderRadius: 'var(--r2)',
  border: '1px solid var(--brd)', background: 'var(--s)',
  color: 'var(--t)', fontSize: '12.5px',
} as const;

// ─── Main screen ─────────────────────────────────────────────────────────────

export function InterInstitutionAlertsScreen() {
  const { lang } = useApp();
  const isMobile = window.innerWidth < 768;

  const [severityFilter, setSeverityFilter] = useState<LiveAlertSeverity | ''>('');
  const [typeFilter, setTypeFilter] = useState<LiveAlertType | ''>('');
  const [instFilter, setInstFilter] = useState('');
  const [search, setSearch] = useState('');

  const result = useAsync(() => getLiveInterInstitutionAlertsWithState(200), []);
  const [action, setAction] = useState<{ alert: LiveInterInstitutionAlertWithState; to: AlertLifecycleStatus } | null>(null);
  const [historyAlert, setHistoryAlert] = useState<LiveInterInstitutionAlertWithState | null>(null);

  const ok = result.data?.ok ?? false;
  const rpcError = result.data?.error;
  const forbidden = rpcError === 'FORBIDDEN';
  const allAlerts = result.data?.alerts ?? [];

  const summaryTotal = allAlerts.length;
  const summaryHigh = allAlerts.filter(a => a.severity === 'high').length;
  const summarySurplus = allAlerts.filter(a => a.alertType === 'surplus_to_shortage').length;
  const summaryNearExpiry = allAlerts.filter(a => a.alertType === 'near_expiry_to_shortage').length;

  const instMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of allAlerts) {
      if (!map.has(a.sourceOrganizationId)) map.set(a.sourceOrganizationId, orgName(a.sourceOrganizationName, a.sourceOrganizationNameAr, lang));
      if (!map.has(a.targetOrganizationId)) map.set(a.targetOrganizationId, orgName(a.targetOrganizationName, a.targetOrganizationNameAr, lang));
    }
    return map;
  }, [allAlerts, lang]);

  const filtered = useMemo(() => allAlerts.filter(a => {
    if (severityFilter && a.severity !== severityFilter) return false;
    if (typeFilter && a.alertType !== typeFilter) return false;
    if (instFilter && a.sourceOrganizationId !== instFilter && a.targetOrganizationId !== instFilter) return false;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      const haystack = [
        a.scientificName, a.concentration, a.dosageForm,
        a.sourceTradeName, a.targetTradeName,
        a.sourceOrganizationName, a.sourceOrganizationNameAr,
        a.targetOrganizationName, a.targetOrganizationNameAr,
      ].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  }), [allAlerts, severityFilter, typeFilter, instFilter, search]);

  return (
    <div style={{ maxWidth: '1040px', animation: 'fs .3s ease' }}>
      {/* Header */}
      <div style={{ marginBottom: '16px' }}>
        <h2 style={{ fontSize: isMobile ? '18px' : '22px', fontWeight: 700, letterSpacing: '-.3px' }}>
          {t('lia_title', lang)}
        </h2>
        <p style={{ fontSize: '12.5px', color: 'var(--t2)', marginTop: '3px', maxWidth: '640px' }} dir="auto">
          {t('lia_sub', lang)}
        </p>
      </div>

      {/* No auto-transfer disclaimer */}
      <div style={{ background: 'var(--info2)', border: '1px solid var(--info)', borderRadius: 'var(--r3)', padding: '10px 14px', marginBottom: '16px', fontSize: '12px', color: 'var(--info)', display: 'flex', alignItems: 'center', gap: '8px' }}>
        ℹ️ {t('iia_no_transfer', lang)}
      </div>

      {/* Summary cards */}
      {ok && allAlerts.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: '10px', marginBottom: '16px' }}>
          <div style={{ background: 'var(--s)', border: '1px solid var(--brd)', borderRadius: 'var(--r3)', padding: '12px 14px' }}>
            <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--info)' }}>{summaryTotal}</div>
            <div style={{ fontSize: '10.5px', color: 'var(--t2)', marginTop: '2px' }}>{t('lia_summary_total', lang)}</div>
          </div>
          <div style={{ background: 'var(--s)', border: '1px solid var(--brd)', borderRadius: 'var(--r3)', padding: '12px 14px' }}>
            <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--err)' }}>{summaryHigh}</div>
            <div style={{ fontSize: '10.5px', color: 'var(--t2)', marginTop: '2px' }}>{t('lia_summary_high', lang)}</div>
          </div>
          <div style={{ background: 'var(--s)', border: '1px solid var(--brd)', borderRadius: 'var(--r3)', padding: '12px 14px' }}>
            <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--ok)' }}>{summarySurplus}</div>
            <div style={{ fontSize: '10.5px', color: 'var(--t2)', marginTop: '2px' }}>{t('lia_summary_surplus', lang)}</div>
          </div>
          <div style={{ background: 'var(--s)', border: '1px solid var(--brd)', borderRadius: 'var(--r3)', padding: '12px 14px' }}>
            <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--warn)' }}>{summaryNearExpiry}</div>
            <div style={{ fontSize: '10.5px', color: 'var(--t2)', marginTop: '2px' }}>{t('lia_summary_near_expiry', lang)}</div>
          </div>
        </div>
      )}

      {/* Filters */}
      {ok && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '16px', alignItems: 'center' }}>
          <select
            id="lia-severity"
            value={severityFilter}
            onChange={e => setSeverityFilter(e.target.value as LiveAlertSeverity | '')}
            style={{ ...fieldStyle, width: 'auto', minWidth: '150px', appearance: 'none', cursor: 'pointer' }}
            aria-label={t('lia_severity_label', lang)}
          >
            <option value="">{t('lia_severity_label', lang)}: {t('sc_all', lang)}</option>
            <option value="high">{t('lia_severity_high', lang)}</option>
            <option value="medium">{t('lia_severity_medium', lang)}</option>
          </select>

          <select
            id="lia-type"
            value={typeFilter}
            onChange={e => setTypeFilter(e.target.value as LiveAlertType | '')}
            style={{ ...fieldStyle, width: 'auto', minWidth: '170px', appearance: 'none', cursor: 'pointer' }}
            aria-label={t('lia_type_label', lang)}
          >
            <option value="">{t('lia_type_label', lang)}: {t('sc_all', lang)}</option>
            <option value="surplus_to_shortage">{t('lia_type_surplus', lang)}</option>
            <option value="near_expiry_to_shortage">{t('lia_type_near_expiry', lang)}</option>
          </select>

          {instMap.size > 1 && (
            <select
              id="lia-inst"
              value={instFilter}
              onChange={e => setInstFilter(e.target.value)}
              style={{ ...fieldStyle, width: 'auto', minWidth: '160px', appearance: 'none', cursor: 'pointer' }}
              aria-label={t('avail_inst_label', lang)}
            >
              <option value="">{t('avail_inst_label', lang)}: {t('sc_all', lang)}</option>
              {[...instMap.entries()].map(([id, name]) => (
                <option key={id} value={id}>{name}</option>
              ))}
            </select>
          )}

          <div style={{ position: 'relative', flex: 1, minWidth: '150px' }}>
            <span style={{ position: 'absolute', insetInlineStart: '10px', top: '50%', transform: 'translateY(-50%)', fontSize: '14px', pointerEvents: 'none' }}>🔍</span>
            <input
              id="lia-search"
              type="search"
              dir="auto"
              placeholder={t('lia_search_ph', lang)}
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ ...fieldStyle, paddingInlineStart: '34px' }}
              aria-label={t('lia_search_ph', lang)}
            />
          </div>
        </div>
      )}

      {/* States */}
      {result.loading && <PhoenixLoadingState label={t('loading', lang)} />}

      {!result.loading && result.error && (
        <PhoenixErrorState title={t('load_error', lang)} message={t('alertLifecycle_error_generic', lang)} onRetry={result.reload} />
      )}

      {!result.loading && !result.error && !ok && forbidden && (
        <PhoenixEmptyState icon="🔒" title={t('lia_forbidden', lang)} />
      )}

      {!result.loading && !result.error && !ok && !forbidden && (
        <PhoenixErrorState title={t('load_error', lang)} message={t(lifecycleErrorKey(rpcError), lang)} onRetry={result.reload} />
      )}

      {!result.loading && !result.error && ok && filtered.length === 0 && (
        <PhoenixEmptyState icon="🔔" title={t('lia_empty', lang)} />
      )}

      {/* Alert cards */}
      {!result.loading && !result.error && ok && filtered.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {filtered.map(a => (
            <AlertCard
              key={a.alertKey}
              a={a}
              lang={lang}
              isMobile={isMobile}
              onAction={to => setAction({ alert: a, to })}
              onHistory={() => setHistoryAlert(a)}
            />
          ))}
        </div>
      )}
      <LifecycleActionDialog
        action={action}
        lang={lang}
        onClose={() => setAction(null)}
        onSuccess={() => {
          setAction(null);
          result.reload();
        }}
      />
      <AlertHistoryDialog alert={historyAlert} lang={lang} onClose={() => setHistoryAlert(null)} />
    </div>
  );
}

// ─── Alert card ───────────────────────────────────────────────────────────────

function AlertCard({ a, lang, isMobile, onAction, onHistory }: {
  a: LiveInterInstitutionAlertWithState;
  lang: 'ar' | 'en';
  isMobile: boolean;
  onAction: (to: AlertLifecycleStatus) => void;
  onHistory: () => void;
}) {
  const borderColor = SEVERITY_BORDER[a.severity] ?? 'var(--brd)';
  const severityVariant = a.severity === 'high' ? 'err' as const : 'warn' as const;
  const severityLabelKey = a.severity === 'high' ? 'lia_severity_high' : 'lia_severity_medium';

  const srcPoint = pointName(a.sourceDistributionPointName, a.sourceDistributionPointNameAr, lang);
  const tgtPoint = pointName(a.targetDistributionPointName, a.targetDistributionPointNameAr, lang);

  return (
    <PhoenixCard padding="16px" style={{ borderInlineStart: `3px solid ${borderColor}` }}>
      {/* Title + alert type + severity */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '10.5px', color: 'var(--t2)', fontWeight: 600 }}>{t('avail_scientific_name', lang)}</div>
          <div style={{ fontSize: '14px', fontWeight: 700 }} dir="auto">{a.scientificName}</div>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', fontSize: '11px', color: 'var(--t2)', marginTop: '2px' }}>
            {a.concentration && <span dir="auto">{t('avail_concentration', lang)}: {a.concentration}</span>}
            {a.dosageForm && <span dir="auto">{t('avail_dosage_form', lang)}: {a.dosageForm}</span>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
          <PhoenixStatusBadge
            variant={a.lifecycleStatus === 'resolved' ? 'ok' : a.lifecycleStatus === 'dismissed' ? 'neutral' : 'warn'}
            label={t(`alertLifecycle_status_${a.lifecycleStatus}`, lang)}
          />
          <PhoenixStatusBadge variant="neutral" label={t(ALERT_TYPE_LABEL_KEY[a.alertType], lang)} />
          <PhoenixStatusBadge variant={severityVariant} label={t(severityLabelKey, lang)} />
        </div>
      </div>

      {/* Source / Target */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '10px', marginBottom: '10px' }}>
        <PartyBlock
          roleLabel={t('source_institution', lang)}
          statusLabelKey={statusLabelKey(a.sourceStatus)}
          statusVar={statusVariant(a.sourceStatus)}
          orgLabel={orgName(a.sourceOrganizationName, a.sourceOrganizationNameAr, lang)}
          pointLabel={srcPoint}
          tradeName={a.sourceTradeName}
          quantity={a.sourceQuantity}
          expiryDate={a.alertType === 'near_expiry_to_shortage' ? a.sourceExpiryDate : null}
          lang={lang}
        />
        <PartyBlock
          roleLabel={t('destination_institution', lang)}
          statusLabelKey={statusLabelKey(a.targetStatus)}
          statusVar={statusVariant(a.targetStatus)}
          orgLabel={orgName(a.targetOrganizationName, a.targetOrganizationNameAr, lang)}
          pointLabel={tgtPoint}
          tradeName={a.targetTradeName}
          quantity={a.targetQuantity}
          expiryDate={null}
          lang={lang}
        />
      </div>

      <div style={{ background: 'var(--s2)', borderRadius: 'var(--r2)', padding: '10px 12px', marginBottom: '10px', fontSize: '11px', color: 'var(--t2)' }}>
        <div dir="ltr">{t('alertLifecycle_alertKey', lang)}: {a.alertKey}</div>
        <div>{t('alertLifecycle_firstSeen', lang)}: <span dir="ltr">{new Date(a.firstSeenAt).toLocaleString(lang)}</span></div>
        <div>{t('alertLifecycle_lastSeen', lang)}: <span dir="ltr">{new Date(a.lastSeenAt).toLocaleString(lang)}</span></div>
        {a.acknowledgedAt && <div>{t('alertLifecycle_acknowledgedAt', lang)}: <span dir="ltr">{new Date(a.acknowledgedAt).toLocaleString(lang)}</span> · {a.acknowledgedBy || '—'}</div>}
        {a.inProgressAt && <div>{t('alertLifecycle_inProgressAt', lang)}: <span dir="ltr">{new Date(a.inProgressAt).toLocaleString(lang)}</span> · {a.inProgressBy || '—'}</div>}
        {a.resolvedAt && <div>{t('alertLifecycle_resolvedAt', lang)}: <span dir="ltr">{new Date(a.resolvedAt).toLocaleString(lang)}</span> · {a.resolvedBy || '—'}</div>}
        {a.dismissedAt && <div>{t('alertLifecycle_dismissedAt', lang)}: <span dir="ltr">{new Date(a.dismissedAt).toLocaleString(lang)}</span> · {a.dismissedBy || '—'}</div>}
        {a.lifecycleReason && <div>{t('alertLifecycle_modal_reason', lang)}: {a.lifecycleReason}</div>}
        {a.lifecycleNotes && <div>{t('alertLifecycle_modal_notes', lang)}: {a.lifecycleNotes}</div>}
      </div>

      {/* Footer: required action + computed_at */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', borderTop: '1px solid var(--brd)', paddingTop: '10px' }}>
        <span style={{ fontSize: '11px', color: 'var(--warn)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
          ⚠ {t('lia_required_action', lang)}
        </span>
        <span style={{ fontSize: '10.5px', color: 'var(--t3)' }} dir="ltr">
          {t('lia_computed_at', lang)}: {new Date(a.computedAt).toLocaleString(lang === 'ar' ? 'ar' : 'en')}
        </span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '7px', marginTop: '10px' }}>
        {a.lifecycleStatus === 'open' && <ActionButton onClick={() => onAction('acknowledged')} label={t('alertLifecycle_action_acknowledge', lang)} />}
        {a.lifecycleStatus === 'acknowledged' && <ActionButton onClick={() => onAction('in_progress')} label={t('alertLifecycle_action_startProcessing', lang)} />}
        {a.lifecycleStatus === 'in_progress' && <ActionButton onClick={() => onAction('resolved')} label={t('alertLifecycle_action_resolve', lang)} />}
        {(['open', 'acknowledged', 'in_progress'] as AlertLifecycleStatus[]).includes(a.lifecycleStatus) && (
          <ActionButton onClick={() => onAction('dismissed')} label={t('alertLifecycle_action_dismiss', lang)} />
        )}
        {(['resolved', 'dismissed'] as AlertLifecycleStatus[]).includes(a.lifecycleStatus) && (
          <ActionButton onClick={() => onAction('open')} label={t('alertLifecycle_action_reopen', lang)} />
        )}
        <ActionButton onClick={onHistory} label={t('alertLifecycle_action_viewHistory', lang)} />
      </div>
    </PhoenixCard>
  );
}

function ActionButton({ label, onClick, disabled = false }: { label: string; onClick: () => void; disabled?: boolean }) {
  return <button type="button" onClick={onClick} disabled={disabled} style={{ padding: '7px 11px', borderRadius: 'var(--r2)', border: '1px solid var(--p)', background: 'var(--p2)', color: 'var(--pd)', fontSize: '11.5px', fontWeight: 600, cursor: disabled ? 'wait' : 'pointer' }}>{label}</button>;
}

function lifecycleErrorKey(error?: string): string {
  const value = (error ?? '').toLowerCase();
  if (value.includes('not_authenticated')) return 'alertLifecycle_error_notAuthenticated';
  if (value.includes('forbidden')) return 'alertLifecycle_error_forbidden';
  if (value.includes('alert_not_found')) return 'alertLifecycle_error_alertNotFound';
  if (value.includes('invalid_transition')) return 'alertLifecycle_error_invalidTransition';
  if (value.includes('reason_required')) return 'alertLifecycle_error_reasonRequired';
  if (value.includes('invalid_target_status')) return 'alertLifecycle_error_invalidTargetStatus';
  if (value.includes('cannot_reopen_active_alert')) return 'alertLifecycle_error_cannotReopenActiveAlert';
  return 'alertLifecycle_error_generic';
}

function LifecycleActionDialog({ action, lang, onClose, onSuccess }: {
  action: { alert: LiveInterInstitutionAlertWithState; to: AlertLifecycleStatus } | null;
  lang: 'ar' | 'en';
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const required = action?.to === 'resolved' || action?.to === 'dismissed' || action?.to === 'open';
  const close = () => {
    if (loading) return;
    setReason(''); setNotes(''); setError(''); onClose();
  };
  const submit = async () => {
    if (!action) return;
    if (required && !reason.trim()) {
      setError(t('alertLifecycle_modal_reasonRequired', lang));
      return;
    }
    setLoading(true); setError('');
    try {
      const response = action.to === 'open'
        ? await reopenInterOrgAlert(action.alert.alertKey, reason.trim(), notes.trim() || undefined)
        : await updateInterOrgAlertState(action.alert.alertKey, action.to, reason.trim() || undefined, notes.trim() || undefined);
      if (!response.ok) {
        setError(t(lifecycleErrorKey(response.error), lang));
        return;
      }
      setReason(''); setNotes(''); onSuccess();
    } catch {
      setError(t('alertLifecycle_error_generic', lang));
    } finally {
      setLoading(false);
    }
  };
  const actionKey = action?.to === 'open' ? 'reopen' : action?.to === 'in_progress' ? 'startProcessing' : action?.to === 'acknowledged' ? 'acknowledge' : action?.to ?? '';
  return (
    <PhoenixDialog open={!!action} onClose={close} title={t(`alertLifecycle_action_${actionKey}`, lang)}>
      {action && <div>
        <div style={{ fontSize: '12px', color: 'var(--t2)', marginBottom: '12px' }}>
          {t(`alertLifecycle_status_${action.alert.lifecycleStatus}`, lang)} → {t(`alertLifecycle_status_${action.to}`, lang)}
        </div>
        {required && <label style={{ display: 'block', fontSize: '12px', marginBottom: '10px' }}>
          {t('alertLifecycle_modal_reason', lang)}
          <textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} style={{ ...fieldStyle, resize: 'vertical', marginTop: '5px' }} />
        </label>}
        <label style={{ display: 'block', fontSize: '12px', marginBottom: '10px' }}>
          {t('alertLifecycle_modal_notes', lang)}
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} style={{ ...fieldStyle, resize: 'vertical', marginTop: '5px' }} />
        </label>
        {error && <div role="alert" style={{ color: 'var(--err)', fontSize: '12px', marginBottom: '10px' }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <ActionButton onClick={close} disabled={loading} label={t('alertLifecycle_modal_cancel', lang)} />
          <ActionButton onClick={submit} disabled={loading} label={loading ? t('loading', lang) : t('alertLifecycle_modal_confirm', lang)} />
        </div>
      </div>}
    </PhoenixDialog>
  );
}

function AlertHistoryDialog({ alert, lang, onClose }: { alert: LiveInterInstitutionAlertWithState | null; lang: 'ar' | 'en'; onClose: () => void }) {
  const history = useAsync(
    () => alert
      ? getInterOrgAlertEvents(alert.alertKey)
      : Promise.resolve<GetAlertEventsResult>({ ok: true, events: [] as AlertLifecycleEvent[] }),
    [alert?.alertKey],
  );
  return (
    <PhoenixDialog open={!!alert} onClose={onClose} title={t('alertLifecycle_history_title', lang)} maxWidth={680}>
      {history.loading && <PhoenixLoadingState label={t('alertLifecycle_history_loading', lang)} />}
      {!history.loading && history.error && <PhoenixErrorState title={t('alertLifecycle_history_error', lang)} message={t('alertLifecycle_error_generic', lang)} onRetry={history.reload} />}
      {!history.loading && !history.error && history.data && !history.data.ok && <PhoenixErrorState title={t('alertLifecycle_history_error', lang)} message={t(lifecycleErrorKey(history.data.error), lang)} onRetry={history.reload} />}
      {!history.loading && !history.error && history.data?.ok && history.data.events.length === 0 && <PhoenixEmptyState icon="🕘" title={t('alertLifecycle_history_empty', lang)} />}
      {!history.loading && !history.error && history.data?.ok && history.data.events.map((event, index) => (
        <div key={`${event.createdAt}:${index}`} style={{ borderBottom: '1px solid var(--brd)', padding: '10px 0', fontSize: '12px' }}>
          <strong>{event.eventType}</strong>
          <div dir="ltr">{new Date(event.createdAt).toLocaleString(lang)}</div>
          <div>{event.fromStatus || '—'} → {event.toStatus || '—'}</div>
          {(event.actorNameSnapshot || event.actorEmailSnapshot || event.actorRoleSnapshot) && <div>{[event.actorNameSnapshot, event.actorEmailSnapshot, event.actorRoleSnapshot].filter(Boolean).join(' · ')}</div>}
          {event.reason && <div>{t('alertLifecycle_modal_reason', lang)}: {event.reason}</div>}
          {event.notes && <div>{t('alertLifecycle_modal_notes', lang)}: {event.notes}</div>}
        </div>
      ))}
    </PhoenixDialog>
  );
}

// ─── Party block ──────────────────────────────────────────────────────────────

function PartyBlock({ roleLabel, statusLabelKey: statusKey, statusVar, orgLabel, pointLabel, tradeName, quantity, expiryDate, lang }: {
  roleLabel: string;
  statusLabelKey: string;
  statusVar: 'ok' | 'warn' | 'err' | 'neutral';
  orgLabel: string;
  pointLabel: string | null;
  tradeName: string | null;
  quantity: number;
  expiryDate: string | null;
  lang: 'ar' | 'en';
}) {
  return (
    <div style={{ background: 'var(--s2)', borderRadius: 'var(--r2)', padding: '10px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px', marginBottom: '4px' }}>
        <span style={{ fontSize: '10.5px', color: 'var(--t2)', fontWeight: 600 }}>{roleLabel}</span>
        {statusKey && <PhoenixStatusBadge variant={statusVar} label={t(statusKey, lang)} />}
      </div>
      <div style={{ fontSize: '12.5px', fontWeight: 600 }} dir="auto">{orgLabel}</div>
      {pointLabel && <div style={{ fontSize: '11px', color: 'var(--t2)', marginTop: '2px' }} dir="auto">🏥 {pointLabel}</div>}
      <div style={{ marginTop: '6px', fontSize: '11.5px', color: 'var(--t2)' }}>
        {t('qty', lang)}: <strong style={{ color: 'var(--t)' }}>{quantity}</strong>
      </div>
      {tradeName && (
        <div style={{ fontSize: '11px', color: 'var(--t2)', marginTop: '2px' }} dir="auto">
          {t('avail_trade_name', lang)}: {tradeName}
        </div>
      )}
      {expiryDate && (
        <div style={{ fontSize: '11px', color: 'var(--warn)', marginTop: '2px' }} dir="ltr">
          ⏱ {t('expiry', lang)}: {expiryDate}
        </div>
      )}
    </div>
  );
}
