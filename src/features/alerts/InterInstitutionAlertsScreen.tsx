import { useMemo, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixDialog } from '@/shared/ui/PhoenixDialog';
import { WhatsAppContactButton } from '@/shared/ui/WhatsAppContactButton';
import { buildMaterialContactMessage } from '@/shared/lib/whatsapp';
import { getExpiryRiskLabel, getExpiryRiskTone, type ExpiryRiskTier } from '@/shared/lib/expiry-risk';
import {
  getLiveInterInstitutionAlertsPage,
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
 *
 * INTER-INSTITUTION-ALERTS-SMART-VIEW-A: adds two more summary chips
 * (missing/low_stock, both derived from the already-fetched targetStatus
 * field — no new statuses, no new fetch) and a read-only "group by" display
 * toggle (none / material / institution) that only reorganizes the already-
 * filtered `filtered` array into local groups for rendering. Distribution
 * point/organization ids are used only as internal Map keys — never
 * rendered — and no lifecycle/exchange behavior is touched by any of this.
 *
 * INTER-INSTITUTION-ALERTS-SMART-VIEW-B: adds a read-only "sort by" display
 * toggle (default / severity / missing-first / low-stock-first /
 * near-expiry-first / newest) that only reorders the already-filtered
 * `filtered` array (via sortAlerts, a pure function over existing fields —
 * severity, targetStatus, alertType, computedAt), and a read-only "critical
 * lane" showing up to a handful of the highest-severity missing/low-stock
 * alerts already present in `filtered`. Both are pure display reorderings —
 * no new fetch, no new RPC, no action buttons, no exchange-workflow wording.
 */

const ALERT_TYPE_LABEL_KEY: Record<LiveAlertType, string> = {
  surplus_to_shortage: 'lia_type_surplus',
  near_expiry_to_shortage: 'lia_type_near_expiry',
};

const SEVERITY_BORDER: Record<LiveAlertSeverity, string> = {
  high: 'var(--err)',
  medium: 'var(--warn)',
};

/**
 * FINAL-POLISH-PERMISSIONS-QR-A (F-03): permission required per TARGET
 * lifecycle status — mirrors the exact server-side checks the migration 039
 * update/reopen RPCs enforce (RPC names live only in the lifecycle service):
 *   open→acknowledged  requires inter_institution_alerts.acknowledge
 *   acknowledged→in_progress requires inter_institution_alerts.manage
 *   in_progress→resolved requires inter_institution_alerts.resolve
 *   any→dismissed      requires inter_institution_alerts.dismiss
 *   reopen (→open)     requires inter_institution_alerts.manage
 * super_admin needs no special-casing here: AppContext tops up myPermissions
 * with every catalog key for super_admin, and the RPCs bypass server-side.
 * Buttons for transitions the user cannot perform are simply not rendered —
 * the server checks remain authoritative and rejected calls still surface
 * translated errors via lifecycleErrorKey.
 */
const TRANSITION_PERMISSION: Record<AlertLifecycleStatus, string> = {
  open:         'inter_institution_alerts.manage',
  acknowledged: 'inter_institution_alerts.acknowledge',
  in_progress:  'inter_institution_alerts.manage',
  resolved:     'inter_institution_alerts.resolve',
  dismissed:    'inter_institution_alerts.dismiss',
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
  if (lang === 'ar') return nameAr || name || t('common_notSpecified', lang);
  return name || nameAr || t('common_notSpecified', lang);
}

function pointName(name: string | null, nameAr: string | null, lang: 'ar' | 'en'): string {
  const v = lang === 'ar' ? (nameAr || name) : (name || nameAr);
  return v || t('common_notSpecified', lang);
}

/**
 * ALERT-CARDS-EXPIRY-RISK-BADGES-UI-A: migration 048's
 * source_expiry_risk_tier is a plain string off the RPC — validate against
 * the known tier vocabulary (shared with the existing frontend-only
 * EXPIRY-RISK-TIERS-A helper) before handing it to getExpiryRiskLabel/
 * getExpiryRiskTone, so an unexpected/future value never crashes the badge —
 * it's simply omitted instead.
 */
const KNOWN_EXPIRY_RISK_TIERS: readonly ExpiryRiskTier[] = ['expired', 'critical_3m', 'warning_6m', 'watch_9m', 'normal', 'unknown'];
function asExpiryRiskTier(value: string | null | undefined): ExpiryRiskTier | null {
  return (KNOWN_EXPIRY_RISK_TIERS as readonly string[]).includes(value ?? '') ? (value as ExpiryRiskTier) : null;
}

/** Bilingual "N days remaining" / "Expired N days ago" line for migration 048's source_expiry_days_remaining. */
function formatExpiryDaysRemaining(days: number, lang: 'ar' | 'en'): string {
  if (days < 0) {
    const n = Math.abs(days);
    return lang === 'ar' ? `منتهي منذ ${n} يوم` : `Expired ${n} days ago`;
  }
  return lang === 'ar' ? `بقي ${days} يوم` : `${days} days remaining`;
}

/**
 * UX-WHATSAPP-ALERT-CONTACT-WIRING-A: which institution(s) a WhatsApp button
 * should target for this alert, relative to the current actor.
 *
 * migration 036/039's RPCs guarantee that for any NON-super actor, their own
 * organization is always either the source or the target of every alert they
 * are allowed to see — so exactly one "other institution" always exists for
 * them. super_admin (or an actor with no org scope) may see alerts where
 * neither side is their own org, so both counterparts are offered instead.
 * Never returns the current actor's own organization as a contact target.
 */
interface AlertContactTarget {
  key: 'source' | 'target';
  orgId: string;
  orgName: string;
  labelKey: string;
}

function resolveAlertContactTargets(
  a: LiveInterInstitutionAlertWithState,
  activeOrgId: string | null,
  isSuper: boolean,
  lang: 'ar' | 'en',
): AlertContactTarget[] {
  const srcName = orgName(a.sourceOrganizationName, a.sourceOrganizationNameAr, lang);
  const tgtName = orgName(a.targetOrganizationName, a.targetOrganizationNameAr, lang);

  if (isSuper || !activeOrgId) {
    return [
      { key: 'source', orgId: a.sourceOrganizationId, orgName: srcName, labelKey: 'wa_alert_contact_source' },
      { key: 'target', orgId: a.targetOrganizationId, orgName: tgtName, labelKey: 'wa_alert_contact_target' },
    ];
  }
  if (activeOrgId === a.sourceOrganizationId) {
    return [{ key: 'target', orgId: a.targetOrganizationId, orgName: tgtName, labelKey: 'wa_alert_contact_other_institution' }];
  }
  if (activeOrgId === a.targetOrganizationId) {
    return [{ key: 'source', orgId: a.sourceOrganizationId, orgName: srcName, labelKey: 'wa_alert_contact_other_institution' }];
  }
  // Neither side matches the actor's own org — should not happen given the
  // RPC's scoping guarantee, but never guess: show no contact target.
  return [];
}

const fieldStyle = {
  width: '100%', padding: '9px 12px', borderRadius: 'var(--r2)',
  border: '1px solid var(--brd)', background: 'var(--s)',
  color: 'var(--t)', fontSize: '12.5px',
} as const;

type GroupMode = 'none' | 'material' | 'institution';

/** Display-only grouping key/label — computed from fields the alert already has. */
function materialGroupKey(a: LiveInterInstitutionAlertWithState): string {
  return [a.scientificName, a.concentration ?? '', a.dosageForm ?? ''].join('|').toLowerCase();
}

function materialGroupLabel(a: LiveInterInstitutionAlertWithState): string {
  return [a.scientificName, a.concentration, a.dosageForm].filter(Boolean).join(' · ');
}

type SortMode = 'default' | 'severity' | 'missing' | 'lowStock' | 'nearExpiry' | 'newest';

/** Display-only reordering of an already-loaded alert array — pure, no I/O. */
function sortAlerts(list: LiveInterInstitutionAlertWithState[], mode: SortMode): LiveInterInstitutionAlertWithState[] {
  if (mode === 'default') return list;
  const arr = [...list];
  switch (mode) {
    case 'severity':
      arr.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1));
      break;
    case 'missing':
      arr.sort((a, b) => (a.targetStatus === b.targetStatus ? 0 : a.targetStatus === 'missing' ? -1 : 1));
      break;
    case 'lowStock':
      arr.sort((a, b) => (a.targetStatus === b.targetStatus ? 0 : a.targetStatus === 'low_stock' ? -1 : 1));
      break;
    case 'nearExpiry':
      arr.sort((a, b) => (a.alertType === b.alertType ? 0 : a.alertType === 'near_expiry_to_shortage' ? -1 : 1));
      break;
    case 'newest':
      arr.sort((a, b) => new Date(b.computedAt).getTime() - new Date(a.computedAt).getTime());
      break;
  }
  return arr;
}

// ─── Main screen ─────────────────────────────────────────────────────────────

export function InterInstitutionAlertsScreen() {
  const { lang, myPermissions, activeOrgId, role } = useApp();
  const isMobile = window.innerWidth < 768;
  // UX-WHATSAPP-ALERT-CONTACT-WIRING-A: decides whether both alert
  // counterparts are offered as contact targets, or just the one "other
  // institution" relative to the actor's own org (see resolveAlertContactTargets).
  const isSuper = role === 'super_admin';

  // F-03: lifecycleStatus decides which action is RELEVANT; effective
  // permission decides whether it is VISIBLE at all.
  const canTransition = (to: AlertLifecycleStatus) => myPermissions.has(TRANSITION_PERMISSION[to]);

  const [severityFilter, setSeverityFilter] = useState<LiveAlertSeverity | ''>('');
  const [typeFilter, setTypeFilter] = useState<LiveAlertType | ''>('');
  const [instFilter, setInstFilter] = useState('');
  const [search, setSearch] = useState('');
  const [groupMode, setGroupMode] = useState<GroupMode>('none');
  const [sortMode, setSortMode] = useState<SortMode>('default');

  // REVIEWER FIX (Phase 2): real server-side pagination — the screen summary
  // is never silently built on just the first 200 rows. Page size chosen to
  // keep card lists scannable; total_count always reflects the full,
  // server-computed set (up to the feed's own 500-row safety ceiling).
  const PAGE_SIZE = 50;
  const [page, setPage] = useState(0);
  const result = useAsync(() => getLiveInterInstitutionAlertsPage(PAGE_SIZE, page * PAGE_SIZE), [page]);
  const [action, setAction] = useState<{ alert: LiveInterInstitutionAlertWithState; to: AlertLifecycleStatus } | null>(null);
  const [historyAlert, setHistoryAlert] = useState<LiveInterInstitutionAlertWithState | null>(null);

  const ok = result.data?.ok ?? false;
  const rpcError = result.data?.error;
  const forbidden = rpcError === 'FORBIDDEN';
  const allAlerts = result.data?.alerts ?? [];
  const totalCount = result.data?.totalCount ?? 0;
  const pageCount = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  // UX-ALERTS-LIVE-WHATSAPP-CONTACT-WIRING-A: contact phones now come
  // straight off each alert row (alert.sourceContactPhone/targetContactPhone),
  // resolved server-side by migration 047 inside the same SECURITY DEFINER
  // RPC that already computes the alert — no separate client-side
  // organization_status_contacts query, so no RLS dependency and no risk of
  // reintroducing the unstable-dependency freeze the old lookup effect had.

  // REVIEWER FIX (Phase 2): the total tile now reflects the server-computed
  // total across ALL pages (result.data.totalCount), not just the current
  // page's row count — the other breakdown tiles below remain current-page
  // counts (labeled as such) since a full cross-page breakdown would need a
  // separate aggregate RPC, out of scope for this pass.
  const summaryTotal = totalCount;
  const summaryHigh = allAlerts.filter(a => a.severity === 'high').length;
  const summarySurplus = allAlerts.filter(a => a.alertType === 'surplus_to_shortage').length;
  const summaryNearExpiry = allAlerts.filter(a => a.alertType === 'near_expiry_to_shortage').length;
  const summaryMissing = allAlerts.filter(a => a.targetStatus === 'missing').length;
  const summaryLowStock = allAlerts.filter(a => a.targetStatus === 'low_stock').length;

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

  // Display-only reordering of the already-filtered alerts — no new data
  // source, pure sort over existing fields (severity/targetStatus/alertType/
  // computedAt).
  const sortedFiltered = useMemo(() => sortAlerts(filtered, sortMode), [filtered, sortMode]);

  // Display-only "critical lane" — the handful of highest-severity
  // missing/low-stock alerts already present in `filtered`. No new data
  // source, no action, just a highlighted display subset.
  const criticalAlerts = useMemo(() => {
    return filtered
      .filter(a => a.severity === 'high' && (a.targetStatus === 'missing' || a.targetStatus === 'low_stock'))
      .sort((a, b) => (a.targetStatus === b.targetStatus ? 0 : a.targetStatus === 'missing' ? -1 : 1))
      .slice(0, isMobile ? 3 : 5);
  }, [filtered, isMobile]);

  // Display-only regrouping of the already-sorted, already-filtered alerts —
  // no new data source. Organization/material keys are internal Map keys
  // only, never rendered; only their display labels (org name / material
  // name) are shown.
  const groups = useMemo(() => {
    if (groupMode === 'none') return null;
    const map = new Map<string, { label: string; items: LiveInterInstitutionAlertWithState[] }>();
    for (const a of sortedFiltered) {
      const key = groupMode === 'material' ? materialGroupKey(a) : a.targetOrganizationId;
      const label = groupMode === 'material'
        ? materialGroupLabel(a)
        : orgName(a.targetOrganizationName, a.targetOrganizationNameAr, lang);
      if (!map.has(key)) map.set(key, { label, items: [] });
      map.get(key)!.items.push(a);
    }
    return [...map.values()].sort((x, y) => x.label.localeCompare(y.label));
  }, [sortedFiltered, groupMode, lang]);

  return (
    <div className="premium-page premium-alerts-page" style={{ maxWidth: '1180px', animation: 'fs .3s ease' }}>
      {/* Header */}
      <div style={{ marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <h2 className="premium-section-header" style={{ fontSize: isMobile ? '20px' : '26px', fontWeight: 700, letterSpacing: '-.3px' }}>
            {t('lia_title', lang)}
          </h2>
          <span style={{ fontSize: '10.5px', fontWeight: 700, color: 'var(--p)', background: 'var(--p2)', border: '1px solid var(--p)', borderRadius: 'var(--rpill)', padding: '2px 10px' }}>
            <PhoenixIcon name="sparkle" size={12} inline /> {t('lia_smart_view_badge', lang)}
          </span>
        </div>
        <p style={{ fontSize: '12.5px', color: 'var(--t2)', marginTop: '3px', maxWidth: '640px' }} dir="auto">
          {t('lia_sub', lang)}
        </p>
      </div>

      {/* No auto-transfer disclaimer */}
      <div style={{ background: 'var(--info2)', border: '1px solid var(--info)', borderRadius: 'var(--r3)', padding: '10px 14px', marginBottom: '8px', fontSize: '12px', color: 'var(--info)', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <PhoenixIcon name="info" size={15} inline /> {t('iia_no_transfer', lang)}
      </div>
      {/* REVIEWER FIX: this screen's alerts are always the peer-institution,
          no-execution-corridor discovery layer — a permanent, honest note,
          never silently omitted. */}
      <div style={{ background: 'var(--s2)', border: '1px solid var(--brd)', borderRadius: 'var(--r3)', padding: '10px 14px', marginBottom: '16px', fontSize: '11.5px', color: 'var(--t2)', display: 'flex', alignItems: 'center', gap: '8px' }} dir="auto">
        <PhoenixIcon name="info" size={15} inline /> {t('lia_not_executable_note', lang)}
      </div>

      {/* Summary cards */}
      {ok && allAlerts.length > 0 && (
        <div style={{ marginBottom: '16px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--t2)', marginBottom: '6px' }}>{t('lia_summary_section_label', lang)}</div>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px' }}>
            <div className="premium-depth-card premium-3d-hover" style={{ borderRadius: 'var(--r3)', padding: '12px 14px' }}>
              <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--info)' }}>{summaryTotal}</div>
              <div style={{ fontSize: '10.5px', color: 'var(--t2)', marginTop: '2px' }}>{t('lia_summary_total', lang)}</div>
            </div>
            <div className="premium-depth-card premium-3d-hover" style={{ borderRadius: 'var(--r3)', padding: '12px 14px' }}>
              <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--err)' }}>{summaryHigh}</div>
              <div style={{ fontSize: '10.5px', color: 'var(--t2)', marginTop: '2px' }}>{t('lia_summary_high', lang)}</div>
            </div>
            <div className="premium-depth-card premium-3d-hover" style={{ borderRadius: 'var(--r3)', padding: '12px 14px' }}>
              <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--err)' }}>{summaryMissing}</div>
              <div style={{ fontSize: '10.5px', color: 'var(--t2)', marginTop: '2px' }}>{t('lia_summary_missing', lang)}</div>
            </div>
            <div className="premium-depth-card premium-3d-hover" style={{ borderRadius: 'var(--r3)', padding: '12px 14px' }}>
              <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--warn)' }}>{summaryLowStock}</div>
              <div style={{ fontSize: '10.5px', color: 'var(--t2)', marginTop: '2px' }}>{t('lia_summary_low_stock', lang)}</div>
            </div>
            <div className="premium-depth-card premium-3d-hover" style={{ borderRadius: 'var(--r3)', padding: '12px 14px' }}>
              <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--ok)' }}>{summarySurplus}</div>
              <div style={{ fontSize: '10.5px', color: 'var(--t2)', marginTop: '2px' }}>{t('lia_summary_surplus', lang)}</div>
            </div>
            <div className="premium-depth-card premium-3d-hover" style={{ borderRadius: 'var(--r3)', padding: '12px 14px' }}>
              <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--warn)' }}>{summaryNearExpiry}</div>
              <div style={{ fontSize: '10.5px', color: 'var(--t2)', marginTop: '2px' }}>{t('lia_summary_near_expiry', lang)}</div>
            </div>
          </div>
        </div>
      )}

      {/* Critical lane — display-only highlight of the highest-severity
          missing/low-stock alerts already present in `filtered` */}
      {ok && criticalAlerts.length > 0 && (
        <div style={{ marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--err)', display: 'inline-flex', alignItems: 'center', gap: '5px' }}><PhoenixIcon name="fire" size={13} inline /> {t('lia_critical_lane_title', lang)}</span>
            <span style={{ fontSize: '10.5px', color: 'var(--t2)' }}>{t('lia_critical_lane_sub', lang)}</span>
          </div>
          <div style={{ display: 'flex', gap: '10px', overflowX: 'auto', paddingBottom: '4px' }}>
            {criticalAlerts.map(a => (
              <CriticalAlertCard key={a.alertKey} a={a} lang={lang} />
            ))}
          </div>
        </div>
      )}

      {/* Filters */}
      {ok && (
        <div className="premium-glass-panel" style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '18px', alignItems: 'center', padding: '12px', borderRadius: 'var(--r4)' }}>
          <select
            id="lia-severity"
            value={severityFilter}
            onChange={e => setSeverityFilter(e.target.value as LiveAlertSeverity | '')}
            className="premium-field"
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
            className="premium-field"
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
              className="premium-field"
              style={{ ...fieldStyle, width: 'auto', minWidth: '160px', appearance: 'none', cursor: 'pointer' }}
              aria-label={t('avail_inst_label', lang)}
            >
              <option value="">{t('avail_inst_label', lang)}: {t('sc_all', lang)}</option>
              {[...instMap.entries()].map(([id, name]) => (
                <option key={id} value={id}>{name}</option>
              ))}
            </select>
          )}

          <select
            id="lia-group"
            value={groupMode}
            onChange={e => setGroupMode(e.target.value as GroupMode)}
            className="premium-field"
            style={{ ...fieldStyle, width: 'auto', minWidth: '160px', appearance: 'none', cursor: 'pointer' }}
            aria-label={t('lia_group_label', lang)}
          >
            <option value="none">{t('lia_group_label', lang)}: {t('lia_group_none', lang)}</option>
            <option value="material">{t('lia_group_material', lang)}</option>
            <option value="institution">{t('lia_group_institution', lang)}</option>
          </select>

          <select
            id="lia-sort"
            value={sortMode}
            onChange={e => setSortMode(e.target.value as SortMode)}
            className="premium-field"
            style={{ ...fieldStyle, width: 'auto', minWidth: '170px', appearance: 'none', cursor: 'pointer' }}
            aria-label={t('lia_sort_label', lang)}
          >
            <option value="default">{t('lia_sort_label', lang)}: {t('lia_sort_default', lang)}</option>
            <option value="severity">{t('lia_sort_severity', lang)}</option>
            <option value="missing">{t('lia_sort_missing', lang)}</option>
            <option value="lowStock">{t('lia_sort_lowstock', lang)}</option>
            <option value="nearExpiry">{t('lia_sort_nearexpiry', lang)}</option>
            <option value="newest">{t('lia_sort_newest', lang)}</option>
          </select>

          <div style={{ position: 'relative', flex: 1, minWidth: '150px' }}>
            <span style={{ position: 'absolute', insetInlineStart: '10px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--t2)', display: 'inline-flex' }} aria-hidden="true"><PhoenixIcon name="search" size={14} /></span>
            <input
              id="lia-search"
              type="search"
              className="premium-field"
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
        <PhoenixEmptyState icon="lock" title={t('lia_forbidden', lang)} />
      )}

      {!result.loading && !result.error && !ok && !forbidden && (
        <PhoenixErrorState title={t('load_error', lang)} message={t(lifecycleErrorKey(rpcError), lang)} onRetry={result.reload} />
      )}

      {!result.loading && !result.error && ok && filtered.length === 0 && (
        <PhoenixEmptyState icon="alerts" title={t('lia_empty', lang)} />
      )}

      {/* Alert cards — flat list, or grouped for display only when groupMode !== 'none' */}
      {!result.loading && !result.error && ok && filtered.length > 0 && (
        <div style={{ fontSize: '10.5px', color: 'var(--t2)', marginBottom: '10px' }}>
          {sortedFiltered.length} {t('lia_visible_alerts_label', lang)}
        </div>
      )}
      {!result.loading && !result.error && ok && filtered.length > 0 && (
        groups === null ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {sortedFiltered.map(a => (
              <AlertCard
                key={a.alertKey}
                a={a}
                lang={lang}
                canTransition={canTransition}
                onAction={to => setAction({ alert: a, to })}
                onHistory={() => setHistoryAlert(a)}
                activeOrgId={activeOrgId}
                isSuper={isSuper}
              />
            ))}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>
            {groups.map(g => (
              <div key={g.label}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', paddingBottom: '6px', borderBottom: '1px solid var(--brd)' }}>
                  <span style={{ fontSize: '13px', fontWeight: 700 }} dir="auto">{g.label}</span>
                  <span style={{ fontSize: '10.5px', color: 'var(--t2)' }}>({g.items.length})</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {g.items.map(a => (
                    <AlertCard
                      key={a.alertKey}
                      a={a}
                      lang={lang}
                      canTransition={canTransition}
                      onAction={to => setAction({ alert: a, to })}
                      onHistory={() => setHistoryAlert(a)}
                      activeOrgId={activeOrgId}
                      isSuper={isSuper}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )
      )}
      {/* REVIEWER FIX (Phase 2): real server-side pagination with an honest
          total — never a silent first-200 truncation. */}
      {!result.loading && !result.error && ok && totalCount > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', marginTop: '18px', fontSize: '11.5px', color: 'var(--t2)' }}>
          <ActionButton disabled={page <= 0} onClick={() => setPage(p => Math.max(0, p - 1))} label={t('lia_page_prev', lang)} />
          <span dir="ltr">
            {t('lia_page_label', lang)} {page + 1} / {pageCount} · {t('lia_page_total', lang)}: {totalCount}
          </span>
          <ActionButton disabled={page + 1 >= pageCount} onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))} label={t('lia_page_next', lang)} />
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

// ─── Critical lane card (compact, read-only, no actions) ──────────────────────

function CriticalAlertCard({ a, lang }: { a: LiveInterInstitutionAlertWithState; lang: 'ar' | 'en' }) {
  const tgtOrg = orgName(a.targetOrganizationName, a.targetOrganizationNameAr, lang);
  const tgtPoint = pointName(a.targetDistributionPointName, a.targetDistributionPointNameAr, lang);
  return (
    <div style={{ flex: '0 0 auto', minWidth: '190px', maxWidth: '220px', background: 'var(--err2)', border: '1px solid var(--err)', borderRadius: 'var(--r3)', padding: '10px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '6px', marginBottom: '4px' }}>
        <span style={{ fontSize: '12px', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} dir="auto">{a.scientificName}</span>
        <PhoenixStatusBadge variant="err" label={t(a.targetStatus === 'missing' ? 'cond_missing' : 'cond_low_stock', lang)} />
      </div>
      <div style={{ fontSize: '10.5px', color: 'var(--t2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} dir="auto">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}><PhoenixIcon name="hospital" size={13} inline /> {tgtOrg} · {tgtPoint}</span>
      </div>
    </div>
  );
}

// ─── Alert card ───────────────────────────────────────────────────────────────

function AlertCard({ a, lang, canTransition, onAction, onHistory, activeOrgId, isSuper }: {
  a: LiveInterInstitutionAlertWithState;
  lang: 'ar' | 'en';
  /** F-03: true when the current user holds the server-required permission for this target status. */
  canTransition: (to: AlertLifecycleStatus) => boolean;
  onAction: (to: AlertLifecycleStatus) => void;
  onHistory: () => void;
  /** UX-WHATSAPP-ALERT-CONTACT-WIRING-A */
  activeOrgId: string | null;
  isSuper: boolean;
}) {
  const borderColor = SEVERITY_BORDER[a.severity] ?? 'var(--brd)';
  const severityVariant = a.severity === 'high' ? 'err' as const : 'warn' as const;
  const severityLabelKey = a.severity === 'high' ? 'lia_severity_high' : 'lia_severity_medium';

  const srcPoint = pointName(a.sourceDistributionPointName, a.sourceDistributionPointNameAr, lang);
  const tgtPoint = pointName(a.targetDistributionPointName, a.targetDistributionPointNameAr, lang);
  const contactTargets = resolveAlertContactTargets(a, activeOrgId, isSuper, lang);

  return (
    <PhoenixCard
      padding="16px"
      style={{ borderInlineStart: `3px solid ${borderColor}` }}
      className={`premium-mobile-card premium-mobile-enter${a.severity === 'high' ? ' premium-mobile-card-critical' : ' premium-mobile-card-warning'}`}
    >
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
          {/* REVIEWER FIX: no live execution corridor exists between two peer
              institutions — this is a permanent, honest label on every
              discovery-layer alert, never omitted. */}
          <PhoenixStatusBadge variant="neutral" label={t('lia_not_executable_badge', lang)} />
        </div>
      </div>

      {/* Source / Target */}
      <div className="institution-flow" style={{ marginBottom: '12px' }}>
        <PartyBlock
          roleLabel={t('alertLifecycle_institution_sourceInstitution', lang)}
          pointRoleLabel={t('alertLifecycle_institution_sourcePoint', lang)}
          statusLabelKey={statusLabelKey(a.sourceStatus)}
          statusVar={statusVariant(a.sourceStatus)}
          orgLabel={orgName(a.sourceOrganizationName, a.sourceOrganizationNameAr, lang)}
          pointLabel={srcPoint}
          tradeName={a.sourceTradeName}
          quantity={a.sourceQuantity}
          expiryDate={a.alertType === 'near_expiry_to_shortage' ? a.sourceExpiryDate : null}
          expiryRiskTier={a.alertType === 'near_expiry_to_shortage' ? a.sourceExpiryRiskTier : null}
          expiryDaysRemaining={a.alertType === 'near_expiry_to_shortage' ? a.sourceExpiryDaysRemaining : null}
          lang={lang}
        />
        <div className="institution-flow__connector" aria-hidden="true">→</div>
        <PartyBlock
          roleLabel={t('alertLifecycle_institution_targetInstitution', lang)}
          pointRoleLabel={t('alertLifecycle_institution_targetPoint', lang)}
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

      {/* Timeline metadata — the technical alertKey is intentionally NOT rendered
          here (UI-FINAL-LUXURY-DESIGN-POLISH-A): it stays internal for React keys,
          updateInterOrgAlertState, reopenInterOrgAlert and getInterOrgAlertEvents. */}
      <div style={{ background: 'var(--s2)', borderRadius: 'var(--r2)', padding: '10px 12px', marginBottom: '10px', fontSize: '11px', color: 'var(--t2)', border: '1px solid color-mix(in srgb, var(--brd) 60%, transparent)' }}>
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
          <PhoenixIcon name="warning" size={12} inline /> {t('lia_required_action', lang)}
        </span>
        <span style={{ fontSize: '10.5px', color: 'var(--t3)' }} dir="ltr">
          {t('lia_computed_at', lang)}: {new Date(a.computedAt).toLocaleString(lang === 'ar' ? 'ar' : 'en')}
        </span>
      </div>
      <div className="premium-action-bar" style={{ marginTop: '12px' }}>
        {a.lifecycleStatus === 'open' && canTransition('acknowledged') && <ActionButton onClick={() => onAction('acknowledged')} label={t('alertLifecycle_action_acknowledge', lang)} />}
        {a.lifecycleStatus === 'acknowledged' && canTransition('in_progress') && <ActionButton onClick={() => onAction('in_progress')} label={t('alertLifecycle_action_startProcessing', lang)} />}
        {a.lifecycleStatus === 'in_progress' && canTransition('resolved') && <ActionButton onClick={() => onAction('resolved')} label={t('alertLifecycle_action_resolve', lang)} />}
        {(['open', 'acknowledged', 'in_progress'] as AlertLifecycleStatus[]).includes(a.lifecycleStatus) && canTransition('dismissed') && (
          <ActionButton onClick={() => onAction('dismissed')} label={t('alertLifecycle_action_dismiss', lang)} />
        )}
        {(['resolved', 'dismissed'] as AlertLifecycleStatus[]).includes(a.lifecycleStatus) && canTransition('open') && (
          <ActionButton onClick={() => onAction('open')} label={t('alertLifecycle_action_reopen', lang)} />
        )}
        <ActionButton onClick={onHistory} label={t('alertLifecycle_action_viewHistory', lang)} />
      </div>

      {/* UX-ALERTS-LIVE-WHATSAPP-CONTACT-WIRING-A: read-only WhatsApp contact —
          never bypasses/duplicates the action handlers above; phone comes
          directly off this alert row (source_contact_phone/target_contact_phone,
          resolved server-side by migration 047 inside the same RPC that
          computed the alert), never a separate client-side query, honest
          empty state otherwise. */}
      {contactTargets.length > 0 && (
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px' }}>
          {contactTargets.map(target => (
            <WhatsAppContactButton
              key={target.key}
              phone={target.key === 'source' ? a.sourceContactPhone : a.targetContactPhone}
              lang={lang}
              label={`${t(target.labelKey, lang)}: ${target.orgName}`}
              message={buildMaterialContactMessage({
                material: a.scientificName,
                status: t(statusLabelKey(a.targetStatus), lang),
                sourceInstitution: orgName(a.sourceOrganizationName, a.sourceOrganizationNameAr, lang),
                targetInstitution: orgName(a.targetOrganizationName, a.targetOrganizationNameAr, lang),
                outlet: tgtPoint,
                // This screen (migration 036) is a discovery/coordination layer
                // only — it never computes a real transfer quantity, so
                // sourceQuantity is always labeled explicitly as a raw balance,
                // never as a ready transfer amount (reviewer fix, Phase 3).
                quantity: a.sourceQuantity > 0 ? a.sourceQuantity : undefined,
                quantityLabel: 'balance',
                expiryDate: a.alertType === 'near_expiry_to_shortage' ? a.sourceExpiryDate : undefined,
                lastUpdate: new Date(a.computedAt).toLocaleString(lang === 'ar' ? 'ar' : 'en'),
                context: 'alert',
              }, lang)}
            />
          ))}
        </div>
      )}
    </PhoenixCard>
  );
}

function ActionButton({ label, onClick, disabled = false }: { label: string; onClick: () => void; disabled?: boolean }) {
  return <button className="premium-action-button" type="button" onClick={onClick} disabled={disabled} style={{ borderRadius: 'var(--r2)', border: '1px solid var(--p)', background: 'var(--p2)', color: 'var(--pd)', fontSize: '12px', fontWeight: 700, cursor: disabled ? 'wait' : 'pointer' }}>{label}</button>;
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
          <textarea className="premium-field" value={reason} onChange={e => setReason(e.target.value)} rows={3} style={{ ...fieldStyle, resize: 'vertical', marginTop: '5px' }} />
        </label>}
        <label style={{ display: 'block', fontSize: '12px', marginBottom: '10px' }}>
          {t('alertLifecycle_modal_notes', lang)}
          <textarea className="premium-field" value={notes} onChange={e => setNotes(e.target.value)} rows={3} style={{ ...fieldStyle, resize: 'vertical', marginTop: '5px' }} />
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
      {!history.loading && !history.error && history.data?.ok && history.data.events.length === 0 && <PhoenixEmptyState icon="clock" title={t('alertLifecycle_history_empty', lang)} />}
      {!history.loading && !history.error && history.data?.ok && <div className="history-timeline">{history.data.events.map((event, index) => (
        <div className="history-event" key={`${event.createdAt}:${index}`} style={{ fontSize: '12px' }}>
          <strong>{event.eventType}</strong>
          <div dir="ltr">{new Date(event.createdAt).toLocaleString(lang)}</div>
          <div>{event.fromStatus || '—'} → {event.toStatus || '—'}</div>
          {(event.actorNameSnapshot || event.actorEmailSnapshot || event.actorRoleSnapshot) && <div>{[event.actorNameSnapshot, event.actorEmailSnapshot, event.actorRoleSnapshot].filter(Boolean).join(' · ')}</div>}
          {event.reason && <div>{t('alertLifecycle_modal_reason', lang)}: {event.reason}</div>}
          {event.notes && <div>{t('alertLifecycle_modal_notes', lang)}: {event.notes}</div>}
        </div>
      ))}</div>}
    </PhoenixDialog>
  );
}

// ─── Party block ──────────────────────────────────────────────────────────────

function PartyBlock({ roleLabel, pointRoleLabel, statusLabelKey: statusKey, statusVar, orgLabel, pointLabel, tradeName, quantity, expiryDate, expiryRiskTier, expiryDaysRemaining, lang }: {
  roleLabel: string;
  pointRoleLabel: string;
  statusLabelKey: string;
  statusVar: 'ok' | 'warn' | 'err' | 'neutral';
  orgLabel: string;
  pointLabel: string;
  tradeName: string | null;
  quantity: number;
  expiryDate: string | null;
  /** ALERT-CARDS-EXPIRY-RISK-BADGES-UI-A: migration 048 fields, only ever passed for the near-expiry source party. */
  expiryRiskTier?: string | null;
  expiryDaysRemaining?: number | null;
  lang: 'ar' | 'en';
}) {
  const riskTier = asExpiryRiskTier(expiryRiskTier);
  return (
    <div className="institution-card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px', marginBottom: '4px' }}>
        <span style={{ fontSize: '10.5px', color: 'var(--t2)', fontWeight: 600 }}>{roleLabel}</span>
        {statusKey && <PhoenixStatusBadge variant={statusVar} label={t(statusKey, lang)} />}
      </div>
      <div style={{ fontSize: '12.5px', fontWeight: 600 }} dir="auto">{orgLabel}</div>
      <div style={{ fontSize: '10px', color: 'var(--t3)', marginTop: '8px', fontWeight: 700 }}>{pointRoleLabel}</div>
      <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '4px' }} dir="auto"><PhoenixIcon name="hospital" size={12} inline /> {pointLabel}</div>
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
      {/* ALERT-CARDS-EXPIRY-RISK-BADGES-UI-A: migration 048's
          source_expiry_risk_tier/source_expiry_days_remaining, rendered only
          alongside the existing expiry date line above (i.e. only for the
          near-expiry source party) — reuses the existing frontend-only
          EXPIRY-RISK-TIERS-A tier vocabulary/labels/tones for visual
          consistency. Absent/unrecognized tier or non-numeric days simply
          omits these lines; never crashes, never blocks rendering. */}
      {expiryDate && riskTier && (
        <div style={{ marginTop: '4px' }}>
          <PhoenixStatusBadge variant={getExpiryRiskTone(riskTier)} label={getExpiryRiskLabel(riskTier, lang)} />
        </div>
      )}
      {expiryDate && typeof expiryDaysRemaining === 'number' && (
        <div style={{ fontSize: '10.5px', color: 'var(--t3)', marginTop: '2px' }} dir="auto">
          {formatExpiryDaysRemaining(expiryDaysRemaining, lang)}
        </div>
      )}
    </div>
  );
}
