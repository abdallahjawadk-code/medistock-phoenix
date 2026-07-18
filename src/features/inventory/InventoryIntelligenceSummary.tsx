import { useMemo, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixMetricCard } from '@/shared/ui/PhoenixMetricCard';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import {
  useInventoryAlerts,
  useInventoryTransferSuggestions,
  INVENTORY_PERMISSION_KEYS as PK,
} from './useInventoryIntelligence';
import { acknowledgeInventoryAlert } from './inventory-intelligence.service';
import { SIGNAL_LABEL_KEY, SCOPE_LABEL_KEY, SEVERITY_BORDER, SEVERITY_RANK } from './inventory-display';

/**
 * Compact inventory-intelligence summary, embedded on the Dashboard and Status
 * Center. Shows count cards + a short list of the highest-severity active
 * alerts as dismissible / acknowledgeable pop-ups. RLS already scopes every
 * alert to the organizations/scopes the caller may see, so this only surfaces
 * the RELEVANT orgs/scopes' alerts — never a third org's. Suggestions are shown
 * as a COUNT only; the full recommendation-only list (no Accept) lives in the
 * panel.
 *
 * The whole block hides when the caller lacks inventory.view_signals, mirroring
 * the dashboard's existing FORBIDDEN-hides-section pattern.
 */
interface Props {
  /** Optional: navigate to a fuller inventory view (e.g. Status Center). */
  onViewAll?: () => void;
}

export function InventoryIntelligenceSummary({ onViewAll }: Props) {
  const { lang, myPermissions } = useApp();
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;

  const canView    = myPermissions.has(PK.viewSignals);
  const canManage  = myPermissions.has(PK.manageAlerts);

  const alerts = useInventoryAlerts();
  const suggestions = useInventoryTransferSuggestions();

  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);

  const list = alerts.data ?? [];
  const total = list.length;
  const high = list.filter(a => a.severity === 'high').length;
  const expiry = list.filter(a => a.signalType === 'near_expiry' || a.signalType === 'expired').length;
  const openSuggestions = (suggestions.data ?? []).length;

  const popups = useMemo(
    () => list
      .filter(a => a.severity === 'high' && a.status === 'open' && !dismissed.has(a.id))
      .sort((x, y) => SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity])
      .slice(0, 3),
    [list, dismissed],
  );

  if (!canView) return null;

  async function ack(id: string) {
    setBusyId(id);
    const res = await acknowledgeInventoryAlert(id);
    setBusyId(null);
    if (res.ok) alerts.reload();
    else setDismissed(prev => new Set(prev).add(id)); // hide on failure too; RLS/permission is authoritative
  }

  return (
    <div style={{ marginBottom: isMobile ? '20px' : '28px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '10px' }}>
        <h3 className="premium-section-header" style={{ fontSize: '14px', fontWeight: 700 }}>{t('inv_title', lang)}</h3>
        {onViewAll && (
          <PhoenixButton variant="ghost" size="sm" onClick={onViewAll}>{t('inv_view_all', lang)} →</PhoenixButton>
        )}
      </div>

      {alerts.loading && <PhoenixLoadingState label={t('loading', lang)} />}
      {!alerts.loading && alerts.error && (
        <PhoenixErrorState title={t('load_error', lang)} message={alerts.error} onRetry={alerts.reload} />
      )}

      {!alerts.loading && !alerts.error && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: isMobile ? '10px' : '14px', marginBottom: popups.length > 0 ? '12px' : 0 }}>
            <PhoenixMetricCard icon="🔔" value={total}  label={t('inv_summary_total', lang)} iconBg="var(--info2)" />
            <PhoenixMetricCard icon="🔴" value={high}   label={t('inv_summary_high', lang)} iconBg="var(--err2)" valueColor="var(--err)" />
            <PhoenixMetricCard icon="⏱️" value={expiry} label={t('inv_summary_expiry', lang)} iconBg="var(--warn2)" valueColor="var(--warn)" />
            <PhoenixMetricCard icon="🔁" value={openSuggestions} label={t('inv_summary_suggestions', lang)} iconBg="var(--p2)" valueColor="var(--pd)" />
          </div>

          {/* Dismissible / acknowledgeable high-severity pop-ups (relevant scopes only). */}
          {popups.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {popups.map(a => (
                <PhoenixCard key={a.id} padding="9px 12px" style={{ borderInlineStart: `3px solid ${SEVERITY_BORDER[a.severity]}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                        <PhoenixStatusBadge variant="err" label={t(SIGNAL_LABEL_KEY[a.signalType], lang)} />
                        <span style={{ fontSize: '12px', fontWeight: 700 }} dir="auto">{a.scientificName}</span>
                      </div>
                      <div style={{ fontSize: '10px', color: 'var(--t2)', marginTop: '2px' }}>
                        {t(SCOPE_LABEL_KEY[a.scopeKind], lang)}
                        {a.observedAvailable != null && ` · ${t('avail', lang)}: ${a.observedAvailable}`}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                      {canManage && (
                        <PhoenixButton variant="ghost" size="sm" disabled={busyId === a.id} onClick={() => ack(a.id)}>
                          {t('inv_action_acknowledge', lang)}
                        </PhoenixButton>
                      )}
                      <PhoenixButton
                        variant="ghost" size="sm"
                        aria-label={t('inv_dismiss_popup', lang)}
                        onClick={() => setDismissed(prev => new Set(prev).add(a.id))}
                      >
                        ✕
                      </PhoenixButton>
                    </div>
                  </div>
                </PhoenixCard>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
