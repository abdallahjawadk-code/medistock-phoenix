import { useMemo, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { formatStableDateTime } from '@/shared/lib/date';
import { getOrganization } from '@/shared/supabase/services/organizations.service';
import { useExactThresholdPermission, useInventoryScopes } from './useInventoryScopes';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixToast } from '@/shared/ui/PhoenixToast';
import { InventoryReasonDialog } from './InventoryReasonDialog';
import { InventoryDraftDocumentDialog } from './InventoryDraftDocumentDialog';
import { InventoryThresholdModal } from './InventoryThresholdModal';
import {
  useInventoryAlerts,
  useInventoryThresholds,
  useInventoryTransferSuggestions,
  isSuggestionStale,
  INVENTORY_PERMISSION_KEYS as PK,
  INVENTORY_SUGGESTION_STALENESS_DEFAULT_MINUTES,
} from './useInventoryIntelligence';
import {
  acknowledgeInventoryAlert,
  resolveInventoryAlert,
  dismissInventoryAlert,
  rejectInventoryTransferSuggestion,
  recomputeInventoryAlerts,
  suggestInventoryTransfers,
  createTransferDraftFromSuggestion,
  getInventorySuggestionPolicy,
  type InventoryAlert,
  type InventoryThreshold,
  type InventoryTransferSuggestion,
} from './inventory-intelligence.service';
import {
  SIGNAL_LABEL_KEY, SEVERITY_LABEL_KEY, SEVERITY_BADGE_VARIANT,
  SEVERITY_BORDER, SCOPE_LABEL_KEY, SEVERITY_RANK,
} from './inventory-display';

type PendingAction =
  | { kind: 'resolve' | 'dismiss'; alert: InventoryAlert }
  | { kind: 'reject'; suggestion: InventoryTransferSuggestion }
  | null;

export function InventoryIntelligencePanel() {
  const { lang, activeOrgId, myPermissions } = useApp();

  const canView       = myPermissions.has(PK.viewSignals);
  const canManage     = myPermissions.has(PK.manageAlerts);
  const canRecompute  = myPermissions.has(PK.recompute);
  const canThresholds = myPermissions.has(PK.manageThresholds);
  const canSuggest    = myPermissions.has(PK.suggestTransfers);
  const canAct        = myPermissions.has(PK.actOnSuggestions);

  const alerts = useInventoryAlerts();
  const suggestions = useInventoryTransferSuggestions();
  const thresholds = useInventoryThresholds();
  const stalenessPolicy = useAsync(
    () => (activeOrgId ? getInventorySuggestionPolicy(activeOrgId) : Promise.resolve(null)),
    [activeOrgId],
  );
  const stalenessMaxAgeMs = (stalenessPolicy.data ?? INVENTORY_SUGGESTION_STALENESS_DEFAULT_MINUTES) * 60_000;
  const orgThresholdPermission = useExactThresholdPermission(activeOrgId, null, null, canThresholds);
  const canManageOrgDefault = orgThresholdPermission.data === true;
  const scopes = useInventoryScopes(activeOrgId, canManageOrgDefault);
  const org = useAsync(() => (activeOrgId ? getOrganization(activeOrgId) : Promise.resolve(null)), [activeOrgId]);
  const orgLabel = org.data ? (lang === 'ar' ? org.data.name_ar : org.data.name) : null;

  const [pending, setPending] = useState<PendingAction>(null);
  const [draftTarget, setDraftTarget] = useState<InventoryTransferSuggestion | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [thresholdOpen, setThresholdOpen] = useState(false);
  const [editingThreshold, setEditingThreshold] = useState<InventoryThreshold | null>(null);

  const sortedAlerts = useMemo(
    () => (alerts.data ?? []).slice().sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]),
    [alerts.data],
  );

  function flash(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2200);
  }

  async function runAck(alert: InventoryAlert) {
    setBusy(true);
    const res = await acknowledgeInventoryAlert(alert.id);
    setBusy(false);
    if (res.ok) { flash(t('inv_saved', lang)); alerts.reload(); }
    else flash(res.error ?? 'error');
  }

  async function confirmPending(reason: string) {
    if (!pending) return;
    setBusy(true);
    let res;
    if (pending.kind === 'reject') res = await rejectInventoryTransferSuggestion(pending.suggestion.id, reason);
    else if (pending.kind === 'resolve') res = await resolveInventoryAlert(pending.alert.id, reason);
    else res = await dismissInventoryAlert(pending.alert.id, reason);
    setBusy(false);
    if (res.ok) {
      flash(t('inv_saved', lang));
      if (pending.kind === 'reject') suggestions.reload(); else alerts.reload();
    } else {
      flash(res.error ?? 'error');
    }
    setPending(null);
  }

  async function confirmDraft(documentNumber: string) {
    if (!draftTarget) return;
    setBusy(true);
    const res = await createTransferDraftFromSuggestion(draftTarget.id, documentNumber);
    setBusy(false);
    setDraftTarget(null);
    if (res.ok) {
      flash(t('inv_draft_created', lang));
      suggestions.reload();
    } else {
      flash(res.error ?? 'error');
    }
  }

  /** ONE refresh act: recompute alerts + regenerate suggestions (permission-gated pieces). */
  async function runRefreshAll() {
    if (!activeOrgId) return;
    setBusy(true);
    if (canRecompute) {
      const res = await recomputeInventoryAlerts(activeOrgId);
      if (res.ok) alerts.reload();
    }
    if (canSuggest) {
      const res2 = await suggestInventoryTransfers(activeOrgId);
      if (res2.ok) suggestions.reload();
    }
    setBusy(false);
    flash(t('inv_saved', lang));
  }

  if (!canView) {
    return (
      <PhoenixEmptyState icon="lock" title={t('inv_title', lang)} description={t('inv_denied', lang)} />
    );
  }

  const reasonTitle =
    pending?.kind === 'resolve' ? t('inv_action_resolve', lang)
    : pending?.kind === 'dismiss' ? t('inv_action_dismiss', lang)
    : t('inv_action_reject', lang);

  return (
    <div style={{ animation: 'fs .3s ease' }}>
      {/* Header + primary actions */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px', marginBottom: '16px' }}>
        <div>
          <h3 className="premium-section-header" style={{ fontSize: '15px', fontWeight: 700 }}>{t('inv_title', lang)}</h3>
          <p style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '3px' }} dir="auto">{t('inv_subtitle', lang)}</p>
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {/* INTELLIGENCE-SIMPLIFICATION: the analysis follows every canonical
              movement automatically server-side; the two manual actions
              (recompute + regenerate) are ONE "refresh data" act. */}
          {(canRecompute || canSuggest) && (
            <PhoenixButton variant="secondary" size="sm" loading={busy} onClick={runRefreshAll}>
              ↻ {t('inv_action_refresh_data', lang)}
            </PhoenixButton>
          )}
          {canThresholds && (
            <PhoenixButton variant="ghost" size="sm" onClick={() => { setEditingThreshold(null); setThresholdOpen(true); }}>
              <PhoenixIcon name="settings" size={13} inline /> {t('inv_threshold_add', lang)}
            </PhoenixButton>
          )}
        </div>
      </div>

      {/* ── Alerts ─────────────────────────────────────────────────────────── */}
      <h4 style={{ fontSize: '13px', fontWeight: 700, marginBottom: '10px' }}>{t('inv_alerts_title', lang)}</h4>
      {alerts.loading && <PhoenixLoadingState label={t('loading', lang)} />}
      {!alerts.loading && alerts.error && (
        <PhoenixErrorState title={t('load_error', lang)} message={alerts.error} onRetry={alerts.reload} />
      )}
      {!alerts.loading && !alerts.error && sortedAlerts.length === 0 && (
        <div style={{ padding: '14px 16px', borderRadius: 'var(--r3)', background: 'var(--s)', border: '1px solid var(--brd)', color: 'var(--t2)', fontSize: '12.5px', textAlign: 'center', marginBottom: '20px' }}>
          <PhoenixIcon name="check" size={13} inline /> {t('inv_empty_alerts', lang)}
        </div>
      )}
      {!alerts.loading && !alerts.error && sortedAlerts.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '22px' }}>
          {sortedAlerts.map(a => (
            <PhoenixCard key={a.id} padding="10px 14px" style={{ borderInlineStart: `3px solid ${SEVERITY_BORDER[a.severity]}` }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <PhoenixStatusBadge variant={SEVERITY_BADGE_VARIANT[a.severity]} label={t(SIGNAL_LABEL_KEY[a.signalType], lang)} />
                    <span style={{ fontSize: '12.5px', fontWeight: 700 }} dir="auto">{a.scientificName}</span>
                    {a.nationalCode && <span style={{ fontSize: '10.5px', color: 'var(--t2)' }} dir="ltr">{a.nationalCode}</span>}
                  </div>
                  <div style={{ fontSize: '10.5px', color: 'var(--t2)', marginTop: '3px' }}>
                    {t(SCOPE_LABEL_KEY[a.scopeKind], lang)} · {t(SEVERITY_LABEL_KEY[a.severity], lang)}
                    {a.observedAvailable != null && ` · ${t('avail', lang)}: ${a.observedAvailable}`}
                    {a.expiryDate && <span dir="ltr"> · ⏱ {a.expiryDate}</span>}
                    {a.status !== 'open' && ` · ${a.status}`}
                  </div>
                </div>
                {canManage && (
                  <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', flexShrink: 0 }}>
                    {a.status === 'open' && (
                      <PhoenixButton variant="ghost" size="sm" disabled={busy} onClick={() => runAck(a)}>
                        {t('inv_action_acknowledge', lang)}
                      </PhoenixButton>
                    )}
                    <PhoenixButton variant="ghost" size="sm" disabled={busy} onClick={() => setPending({ kind: 'resolve', alert: a })}>
                      {t('inv_action_resolve', lang)}
                    </PhoenixButton>
                    <PhoenixButton variant="warn" size="sm" disabled={busy} onClick={() => setPending({ kind: 'dismiss', alert: a })}>
                      {t('inv_action_dismiss', lang)}
                    </PhoenixButton>
                  </div>
                )}
              </div>
            </PhoenixCard>
          ))}
        </div>
      )}

      {/* ── Transfer recommendations (no generic accept — one draft per suggestion) ── */}
      <h4 style={{ fontSize: '13px', fontWeight: 700, marginBottom: '6px' }}>{t('inv_suggestions_title', lang)}</h4>
      <div role="note" style={{ fontSize: '11.5px', color: 'var(--warn)', background: 'var(--warn2)', border: '1px solid var(--warn)', borderRadius: 'var(--r2)', padding: '8px 10px', marginBottom: '10px' }} dir="auto">
        <PhoenixIcon name="warning" size={12} inline /> {t('inv_recommendation_note', lang)}
      </div>
      {suggestions.loading && <PhoenixLoadingState label={t('loading', lang)} />}
      {!suggestions.loading && suggestions.error && (
        <PhoenixErrorState title={t('load_error', lang)} message={suggestions.error} onRetry={suggestions.reload} />
      )}
      {!suggestions.loading && !suggestions.error && (suggestions.data ?? []).length === 0 && (
        <div style={{ padding: '14px 16px', borderRadius: 'var(--r3)', background: 'var(--s)', border: '1px solid var(--brd)', color: 'var(--t2)', fontSize: '12.5px', textAlign: 'center', marginBottom: '22px' }}>
          {t('inv_empty_suggestions', lang)}
        </div>
      )}
      {!suggestions.loading && !suggestions.error && (suggestions.data ?? []).length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '22px' }}>
          {(suggestions.data ?? []).map(s => {
            const stale = isSuggestionStale(s, stalenessMaxAgeMs);
            return (
              <PhoenixCard key={s.id} padding="10px 14px" style={{ borderInlineStart: '3px solid var(--p)' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                      {s.status === 'accepted' ? (
                        <PhoenixStatusBadge variant="ok" label={t('inv_draft_status_badge', lang)} />
                      ) : (
                        <PhoenixStatusBadge variant="primary" label={t('inv_recommendation_only', lang)} />
                      )}
                      {s.crossOrg && <PhoenixStatusBadge variant="info" label={t('inv_cross_org', lang)} />}
                      <span style={{ fontSize: '12.5px', fontWeight: 700 }} dir="auto">{s.scientificName}</span>
                    </div>
                    <div style={{ fontSize: '10.5px', color: 'var(--t2)', marginTop: '3px' }}>
                      {t(SCOPE_LABEL_KEY[s.sourceScopeKind], lang)} → {t(SCOPE_LABEL_KEY[s.targetScopeKind], lang)}
                      {' · '}{t('inv_qty', lang)}: {s.suggestedQuantity}
                      {s.fefoBatchNumber && <span dir="ltr"> · {t('inv_batch', lang)}: {s.fefoBatchNumber}</span>}
                    </div>
                    <div style={{ fontSize: '10px', color: 'var(--t2)', marginTop: '3px' }} dir="ltr">
                      {t('inv_last_validated', lang)}: {formatStableDateTime(s.lastValidatedAt, lang)}
                    </div>
                    {s.status === 'accepted' && s.draftDocumentNumber && (
                      <div style={{ fontSize: '10.5px', color: 'var(--ok)', marginTop: '3px' }} dir="auto">
                        <PhoenixIcon name="check" size={12} inline /> {t('inv_draft_document_number_label', lang)}: <span dir="ltr">{s.draftDocumentNumber}</span>
                      </div>
                    )}
                    {s.status === 'open' && stale && (
                      <div style={{ fontSize: '10.5px', color: 'var(--warn)', marginTop: '3px' }} dir="auto">
                        <PhoenixIcon name="warning" size={12} inline /> {t('inv_stale_note', lang)}
                      </div>
                    )}
                  </div>
                  {/* Two independent, narrow actions on ONE suggestion at a time —
                      never a generic/bulk accept. Draft is offered only while
                      open and fresh; a stale suggestion offers only "revalidate"
                      (the refresh-data action above regenerates it). */}
                  {canAct && s.status === 'open' && (
                    <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                      {!stale && (
                        <PhoenixButton variant="primary" size="sm" disabled={busy} onClick={() => setDraftTarget(s)}>
                          {t('inv_draft_create_action', lang)}
                        </PhoenixButton>
                      )}
                      <PhoenixButton variant="ghost" size="sm" disabled={busy} onClick={() => setPending({ kind: 'reject', suggestion: s })}>
                        {t('inv_action_reject', lang)}
                      </PhoenixButton>
                    </div>
                  )}
                </div>
              </PhoenixCard>
            );
          })}
        </div>
      )}

      {/* ── Thresholds ─────────────────────────────────────────────────────── */}
      <h4 style={{ fontSize: '13px', fontWeight: 700, marginBottom: '10px' }}>{t('inv_thresholds_title', lang)}</h4>
      {thresholds.loading && <PhoenixLoadingState label={t('loading', lang)} />}
      {!thresholds.loading && thresholds.error && (
        <PhoenixErrorState title={t('load_error', lang)} message={thresholds.error} onRetry={thresholds.reload} />
      )}
      {!thresholds.loading && !thresholds.error && (thresholds.data ?? []).length === 0 && (
        <div style={{ padding: '14px 16px', borderRadius: 'var(--r3)', background: 'var(--s)', border: '1px solid var(--brd)', color: 'var(--t2)', fontSize: '12.5px', textAlign: 'center' }}>
          {t('inv_empty_thresholds', lang)}
        </div>
      )}
      {!thresholds.loading && !thresholds.error && (thresholds.data ?? []).length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
          {(thresholds.data ?? []).map(th => (
            <div key={th.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', padding: '8px 12px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: 'var(--s)', flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                <span style={{ fontSize: '12px', fontWeight: 600 }} dir="auto">{th.scientificName}</span>
                <span style={{ fontSize: '10.5px', color: 'var(--t2)', marginInlineStart: '8px' }} dir="auto">
                  {/* Organization name first, then the scope name (UX spec). */}
                  {orgLabel ? `${orgLabel} · ` : ''}
                  {t(SCOPE_LABEL_KEY[th.scopeKind], lang)}
                  {th.scopeId === null
                    ? ` · ${t('inv_th_org_default', lang)}`
                    : (() => {
                        const s = scopes.data?.resolve(th.scopeKind, th.scopeId);
                        const nm = s ? (lang === 'ar' ? (s.nameAr || s.name) : (s.name || s.nameAr)) : null;
                        return ` · ${t('inv_th_scope_specific', lang)}${nm ? `: ${nm}` : ''}`;
                      })()}
                  {th.nationalCode === null ? ` · ${t('inv_th_wildcard', lang)}` : ` · ${th.nationalCode}`}
                </span>
              </div>
              <div style={{ fontSize: '10.5px', color: 'var(--t2)', display: 'flex', gap: '10px' }} dir="ltr">
                <span>{t('inv_th_reorder_point', lang)}: {th.reorderPoint ?? '—'}</span>
                <span>{t('inv_th_target_max', lang)}: {th.targetMax ?? '—'}</span>
                <span>{t('inv_th_near_expiry_days', lang)}: {th.nearExpiryDays ?? 270}</span>
                {!th.isActive && <PhoenixStatusBadge variant="neutral" label="—" />}
              </div>
              {canThresholds && (th.scopeId === null
                ? canManageOrgDefault
                : scopes.data?.canManage(th.scopeKind, th.scopeId)) && (
                <PhoenixButton
                  variant="ghost"
                  size="sm"
                  onClick={() => { setEditingThreshold(th); setThresholdOpen(true); }}
                >
                  {t('inv_action_edit', lang)}
                </PhoenixButton>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Dialogs & toast */}
      <InventoryReasonDialog
        open={pending !== null}
        title={reasonTitle}
        variant={pending?.kind === 'resolve' ? 'primary' : 'danger'}
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={confirmPending}
      />
      <InventoryDraftDocumentDialog
        open={draftTarget !== null}
        busy={busy}
        onCancel={() => setDraftTarget(null)}
        onConfirm={confirmDraft}
      />
      {activeOrgId && (
        <InventoryThresholdModal
          open={thresholdOpen}
          organizationId={activeOrgId}
          organizationLabel={orgLabel}
          editing={editingThreshold}
          onCancel={() => { setThresholdOpen(false); setEditingThreshold(null); }}
          onSaved={() => { setThresholdOpen(false); setEditingThreshold(null); flash(t('inv_saved', lang)); thresholds.reload(); scopes.reload(); }}
        />
      )}
      {toast && <PhoenixToast message={toast} />}
    </div>
  );
}
