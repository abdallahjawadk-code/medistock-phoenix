import { useMemo } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { roleLandingScreen } from '@/shared/authz/screen-access';
import { useIsMobileViewport } from '@/shared/ui/useResponsiveViewport';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { useCommandCenter } from './useCommandCenter';
import {
  deriveCriticalSignals,
  deriveKpis,
  derivePanels,
  deriveStockHealth,
} from './command-center.model';
import { CommandCenterHeader } from './panels/CommandCenterHeader';
import { KpiGrid, KpiGridSkeleton } from './panels/KpiGrid';
import { StockHealthPanel } from './panels/StockHealthPanel';
import { TrendPanel } from './panels/TrendPanel';
import { NetworkOverviewPanel } from './panels/NetworkOverviewPanel';
import { CriticalSignalsPanel } from './panels/CriticalSignalsPanel';
import { SystemStatusStrip } from './panels/SystemStatusStrip';

interface Props {
  onNavigate: (screen: number) => void;
}

/** A titled shell so every panel shares one heading rhythm and hairline. */
function Panel({
  titleKey,
  icon,
  children,
  className,
}: {
  titleKey: string;
  icon: Parameters<typeof PhoenixIcon>[0]['name'];
  children: React.ReactNode;
  className?: string;
}) {
  const { lang } = useApp();
  return (
    <section className={`rac3-panel${className ? ` ${className}` : ''}`}>
      <h2 className="rac3-panel__title">
        <span className="rac3-panel__title-icon" aria-hidden="true">
          <PhoenixIcon name={icon} size={15} />
        </span>
        {t(titleKey, lang)}
      </h2>
      <div className="rac3-panel__body">{children}</div>
    </section>
  );
}

/**
 * RAC-3 — the role-aware Phoenix Command Center.
 *
 * ONE authorized request builds this entire screen: Migration 199's
 * `phoenix_command_center_read_contract`. Every panel is a projection of that
 * single payload, so there is no N+1, no per-card fetch and no polling.
 *
 * Authorization is the server's. This component reads the `capabilities` the
 * contract returned to decide what to draw, and because the whole payload
 * arrives in that one gated call, an unauthorized panel has no data to hide —
 * it is simply absent. Nothing here infers authority from a role name.
 */
export function CommandCenterScreen({ onNavigate }: Props) {
  const { lang, role, activeOrgId } = useApp();
  const isMobile = useIsMobileViewport();

  /**
   * The REQUESTED scope only.
   *
   * `activeOrgId` is a UI selection, never authority: Migration 199 re-derives
   * the effective organization from the actor's own profile and refuses a
   * scope this actor may not read. A super_admin with no organization selected
   * sends nulls, which the contract answers at global scope.
   */
  const { data, loading, refreshing, failure, lastLoadedAt, refresh } = useCommandCenter(
    useMemo(() => ({ organizationId: activeOrgId ?? null }), [activeOrgId]),
  );

  const kpis = useMemo(() => (data ? deriveKpis(data) : []), [data]);
  const health = useMemo(() => (data ? deriveStockHealth(data) : []), [data]);
  const signals = useMemo(() => (data ? deriveCriticalSignals(data) : []), [data]);
  const panels = useMemo(
    () => (data ? derivePanels(data.capabilities) : null),
    [data],
  );

  const scopeKind = data?.scope.kind ?? null;

  // ── Authorization refusal ────────────────────────────────────────────────
  // Presented as a refusal, never as "no data". The payload has already been
  // dropped by the hook, and the way out is the actor's own canonical landing
  // — rendered as a button rather than an automatic redirect, because this
  // screen may itself be that landing and a redirect would loop.
  if (failure && (failure.kind === 'unauthorized' || failure.kind === 'unauthenticated')) {
    const fallback = roleLandingScreen(role);
    return (
      <div className="rac3 nexus-command-center" data-rac3-state="unauthorized">
        <PhoenixEmptyState
          icon="lock"
          title={t('rac3_unauthorized_title', lang)}
          description={t('rac3_unauthorized_msg', lang)}
          action={
            fallback === 22
              ? undefined
              : { label: t('rac3_unauthorized_action', lang), onClick: () => onNavigate(fallback) }
          }
        />
      </div>
    );
  }

  // ── The RPC is absent / the scope request was rejected / transport failed ─
  if (failure && !data) {
    const titleKey =
      failure.kind === 'invalid_scope' ? 'rac3_invalid_scope_title'
      : failure.kind === 'unavailable' ? 'rac3_unavailable_title'
      : 'load_error';
    const msgKey =
      failure.kind === 'invalid_scope' ? 'rac3_invalid_scope_msg'
      : failure.kind === 'unavailable' ? 'rac3_unavailable_msg'
      : 'rac3_network_msg';
    return (
      <div className="rac3 nexus-command-center" data-rac3-state="error">
        <PhoenixErrorState
          title={t(titleKey, lang)}
          message={t(msgKey, lang)}
          onRetry={failure.kind === 'network' ? refresh : undefined}
        />
      </div>
    );
  }

  // ── First load ───────────────────────────────────────────────────────────
  if (loading && !data) {
    return (
      <div className="rac3 nexus-command-center" data-rac3-state="loading">
        <CommandCenterHeader scopeKind={null} refreshing onRefresh={refresh} />
        <KpiGridSkeleton />
      </div>
    );
  }

  // ── Supabase not configured in this build ────────────────────────────────
  if (!data || !panels) {
    return (
      <div className="rac3 nexus-command-center" data-rac3-state="empty">
        <PhoenixEmptyState icon="status" title={t('rac3_empty_title', lang)} description={t('rac3_empty_msg', lang)} />
      </div>
    );
  }

  const alertsAction = panels.alertsLink ? () => onNavigate(13) : undefined;

  /**
   * Mobile order is operational urgency; desktop leads with the KPI overview.
   *
   * These are two different orderings of the same authorized panels, not two
   * different datasets — a phone in a corridor needs the critical states
   * first, while a desk operator reads the overview then drills down.
   */
  const signalsPanel = panels.criticalSignals ? (
    <Panel titleKey="rac3_panel_signals" icon="warning" className="rac3-panel--signals">
      <CriticalSignalsPanel signals={signals} onOpenAlerts={alertsAction} />
    </Panel>
  ) : null;

  const healthPanel = panels.stockHealth ? (
    <Panel titleKey="rac3_panel_health" icon="medical" className="rac3-panel--health">
      <StockHealthPanel slices={health} />
    </Panel>
  ) : null;

  const networkPanel = panels.network ? (
    <Panel titleKey="rac3_panel_network" icon="network" className="rac3-panel--network">
      <NetworkOverviewPanel network={data.network} scopeKind={data.scope.kind} />
    </Panel>
  ) : null;

  const trendPanel = (
    <Panel titleKey="rac3_panel_trend" icon="reports" className="rac3-panel--trend">
      <TrendPanel status={data.trend_status} />
    </Panel>
  );

  const kpiBlock = (
    <section className="rac3-kpis" aria-label={t('rac3_panel_kpis', lang)}>
      <h2 className="rac3-panel__title rac3-panel__title--bare">
        <span className="rac3-panel__title-icon" aria-hidden="true">
          <PhoenixIcon name="status" size={15} />
        </span>
        {t('rac3_panel_kpis', lang)}
      </h2>
      <KpiGrid kpis={kpis} />
    </section>
  );

  return (
    <div className="rac3 nexus-command-center" data-rac3-state="ready" data-rac3-scope={data.scope.kind}>
      <CommandCenterHeader scopeKind={scopeKind} refreshing={refreshing} onRefresh={refresh} />

      <SystemStatusStrip
        lastLoadedAt={lastLoadedAt}
        refreshing={refreshing}
        nearExpiryDays={data.near_expiry_days}
      />

      {isMobile ? (
        <div className="rac3-stack">
          {signalsPanel}
          {kpiBlock}
          {healthPanel}
          {networkPanel}
          {trendPanel}
        </div>
      ) : (
        <div className="rac3-grid">
          <div className="rac3-grid__main">
            {kpiBlock}
            {healthPanel}
          </div>
          {/* Removing Quick Actions left the side track roughly 290px shorter
              than the main one. Trend — the lowest-priority panel, and a
              deferred state rather than live data — moves down here to close
              that gap, which keeps Critical Signals at the top of the column
              where an operator looks first. No panel is duplicated and no new
              content was invented to fill the space. */}
          <aside className="rac3-grid__side">
            {signalsPanel}
            {networkPanel}
            {trendPanel}
          </aside>
        </div>
      )}
    </div>
  );
}
