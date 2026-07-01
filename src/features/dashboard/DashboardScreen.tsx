import { useMemo } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import {
  getDashboardMetrics,
  getInstitutionOverviews,
  getStatusReportCounts,
} from '@/shared/supabase/services/dashboard.service';
import { getStatusReports } from '@/shared/supabase/services/status-reports.service';
import { computeMaterialAlerts, getExpiryBucketStyle } from '@/features/alerts/materialAlertEngine';
import { getLiveInterInstitutionAlertsWithState } from '@/features/alerts/inter-org-alert-lifecycle.service';
import { PhoenixMetricCard } from '@/shared/ui/PhoenixMetricCard';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';

interface Props { onNavigate: (screen: number) => void; }

// ─── Severity → left-border color ────────────────────────────────────────────

const SEVERITY_BORDER_COLOR: Record<string, string> = {
  critical:    'var(--err)',
  urgent:      '#dc2626',
  high:        'var(--warn)',
  watch:       '#d97706',
  opportunity: 'var(--p)',
  info:        'var(--brd)',
};

// ─── Expiry bucket badge ──────────────────────────────────────────────────────

function ExpiryBucketBadge({ bucket, lang }: { bucket: string; lang: 'ar' | 'en' }) {
  const style = getExpiryBucketStyle(bucket);
  if (!style) return null;
  let label = '';
  if      (bucket === 'expired')  label = t('filter_expired',  lang);
  else if (bucket === '3_months') label = t('filter_3_months', lang);
  else if (bucket === '6_months') label = t('filter_6_months', lang);
  else if (bucket === '9_months') label = t('filter_9_months', lang);
  return (
    <span style={{
      padding: '1px 7px', borderRadius: 'var(--rpill)',
      border: `1px solid ${style.color}`, background: style.bg, color: style.color,
      fontSize: '10px', fontWeight: 700, whiteSpace: 'nowrap',
    }}>
      {label}
    </span>
  );
}

export function DashboardScreen({ onNavigate }: Props) {
  const { lang, activeOrgId, configured } = useApp();
  const isMobile = window.innerWidth < 768;

  const metrics = useAsync(() => getDashboardMetrics(activeOrgId ?? undefined), [activeOrgId]);
  const insts   = useAsync(() => getInstitutionOverviews(), []);
  const srCounts = useAsync(() => getStatusReportCounts(activeOrgId ?? undefined), [activeOrgId]);
  const allReports = useAsync(
    () => getStatusReports({ activeOnly: true }).catch(() => []),
    [],
  );

  // LIVE-ALERTS-DASHBOARD-SUMMARY-A: live, item_availability-based
  // inter-institution alert summary (migration 036's
  // phoenix_get_live_inter_institution_alerts RPC). Replaces the former
  // "Exchange alerts summary" widget, which was computed client-side over
  // the manual status-report layer's cross-institution matching helper.
  // computeMaterialAlerts() below is a SEPARATE, single-institution
  // local/material alert path (expiry + missing status per institution) —
  // it is NOT inter-institution matching and is left untouched.
  const liveAlerts = useAsync(() => getLiveInterInstitutionAlertsWithState(200), []);
  const liveResult = liveAlerts.data;
  const liveOk = liveResult?.ok ?? false;
  const liveRpcError = liveResult?.error;
  const liveForbidden = liveRpcError === 'FORBIDDEN';
  const liveList = liveOk
    ? (liveResult?.alerts ?? []).filter(a => ['open', 'acknowledged', 'in_progress'].includes(a.lifecycleStatus))
    : [];
  const liveTotal = liveList.length;
  const liveHigh = liveList.filter(a => a.severity === 'high').length;
  const liveSurplus = liveList.filter(a => a.alertType === 'surplus_to_shortage').length;
  const liveNearExpiry = liveList.filter(a => a.alertType === 'near_expiry_to_shortage').length;

  const m = metrics.data;
  const sr = srCounts.data;

  const materialAlertResult = useMemo(
    () => allReports.data ? computeMaterialAlerts(allReports.data) : null,
    [allReports.data],
  );
  const topSmartAlerts = materialAlertResult
    ? materialAlertResult.alerts.filter(a => a.severity === 'critical' || a.severity === 'urgent').slice(0, 3)
    : [];

  return (
    <div className="premium-page premium-dashboard" style={{ maxWidth: '1320px', animation: 'fs .3s ease' }}>
      {/* Header */}
      <div className="premium-command-hero" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px', marginBottom: '22px' }}>
        <div>
          <div className="premium-command-kicker">MediStock-Babil</div>
          <h2 style={{ fontSize: isMobile ? '18px' : '22px', fontWeight: 700, letterSpacing: '-.3px' }}>
            {t('d_central', lang)}
          </h2>
          <p style={{ fontSize: '12.5px', color: 'var(--t2)', marginTop: '3px' }}>
            {m ? `${t('m_upd', lang)}: ${m.lastUpdated}` : t('dash_sub', lang)}
          </p>
        </div>
        <button
          onClick={() => onNavigate(3)}
          style={{ padding: '10px 16px', borderRadius: 'var(--r3)', border: 'none', background: 'var(--p)', color: '#fff', fontSize: '13px', fontWeight: 600, cursor: 'pointer', transition: 'all 120ms', whiteSpace: 'nowrap' }}
        >
          ✏️ {t('nav_editor', lang)}
        </button>
      </div>

      {!configured && (
        <div role="status" style={{ marginBottom: '18px', padding: '10px 14px', borderRadius: 'var(--r3)', background: 'var(--warn2)', border: '1px solid var(--warn)', color: 'var(--warn)', fontSize: '12px', fontWeight: 600 }}>
          ⚠ {t('config_msg', lang)}
        </div>
      )}

      {/* Infrastructure metrics */}
      {metrics.loading && <PhoenixLoadingState label={t('loading', lang)} />}
      {!metrics.loading && metrics.error && (
        <PhoenixErrorState title={t('load_error', lang)} message={metrics.error} onRetry={metrics.reload} />
      )}
      {!metrics.loading && !metrics.error && m && (
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: isMobile ? '10px' : '14px', marginBottom: isMobile ? '20px' : '28px' }}>
          <PhoenixMetricCard icon="🏥" value={m.activeInstitutions} label={t('m_inst', lang)} iconBg="var(--p2)" />
          <PhoenixMetricCard icon="🏬" value={m.activeWarehouses}   label={t('d_warehouses', lang)} iconBg="var(--p2)" />
          <PhoenixMetricCard icon="📍" value={m.activePorts}        label={t('d_ports', lang)} iconBg="var(--p2)" />
          <PhoenixMetricCard icon="📱" value={m.activeQrCodes}      label={t('d_qr_active', lang)} iconBg="var(--ok2)" />
          <PhoenixMetricCard icon="🚫" value={m.disabledQrCodes}    label={t('d_qr_disabled', lang)} iconBg="var(--skel)" />
          <PhoenixMetricCard icon="💊" value={m.availableItems}     label={t('m_avail', lang)} iconBg="var(--ok2)" />
          <PhoenixMetricCard icon="⚠️" value={m.lowStockCount}      label={t('m_low', lang)} iconBg="var(--warn2)" valueColor="var(--warn)" />
          <PhoenixMetricCard icon="❌" value={m.missingCount}       label={t('m_miss', lang)} iconBg="var(--err2)" valueColor="var(--err)" />
          <PhoenixMetricCard icon="⏱️" value={m.nearExpiryCount}    label={t('m_exp', lang)} iconBg="var(--warn2)" valueColor="var(--warn)" />
          <PhoenixMetricCard icon="📦" value={m.surplusCount}       label={t('d_surplus', lang)} iconBg="var(--ok2)" valueColor="var(--ok)" />
          <PhoenixMetricCard icon="🕐" value={m.lastUpdated}        label={t('m_upd', lang)} iconBg="var(--info2)" />
          {sr && <PhoenixMetricCard icon="📋" value={sr.active} label={t('d_reports_active', lang)} iconBg="var(--info2)" />}
        </div>
      )}

      {/* Status Reports summary */}
      {sr && (sr.active > 0 || sr.resolved > 0) && (
        <>
          <h3 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '12px' }}>{t('d_status_reports', lang)}</h3>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: isMobile ? '10px' : '14px', marginBottom: isMobile ? '20px' : '28px' }}>
            <PhoenixMetricCard icon="⚠️" value={sr.scarce}     label={t('d_scarce', lang)} iconBg="var(--warn2)" valueColor="var(--warn)" />
            <PhoenixMetricCard icon="📦" value={sr.surplus}     label={t('d_surplus', lang)} iconBg="var(--ok2)" valueColor="var(--ok)" />
            <PhoenixMetricCard icon="⏱️" value={sr.nearExpiry}  label={t('m_exp', lang)} iconBg="var(--warn2)" valueColor="var(--warn)" />
            <PhoenixMetricCard icon="❌" value={sr.missing}     label={t('m_miss', lang)} iconBg="var(--err2)" valueColor="var(--err)" />
          </div>
        </>
      )}

      {/* Live Inter-Institution Alerts summary — LIVE-ALERTS-DASHBOARD-SUMMARY-A.
          Hidden entirely (no header, no crash) when the RPC reports FORBIDDEN;
          otherwise always shows its own loading/error/empty states independent
          of the rest of the dashboard. */}
      {!liveForbidden && (
        <>
          <h3 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '4px' }}>{t('d_live_alerts_title', lang)}</h3>
          <p style={{ fontSize: '11.5px', color: 'var(--t2)', marginBottom: '12px' }} dir="auto">{t('lia_sub', lang)}</p>

          {liveAlerts.loading && <PhoenixLoadingState label={t('loading', lang)} />}

          {!liveAlerts.loading && liveAlerts.error && (
            <PhoenixErrorState title={t('load_error', lang)} message={liveAlerts.error} onRetry={liveAlerts.reload} />
          )}

          {!liveAlerts.loading && !liveAlerts.error && !liveOk && (
            <PhoenixErrorState title={t('load_error', lang)} message={liveRpcError ?? t('load_error', lang)} onRetry={liveAlerts.reload} />
          )}

          {!liveAlerts.loading && !liveAlerts.error && liveOk && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: isMobile ? '10px' : '14px', marginBottom: '12px' }}>
                <PhoenixMetricCard icon="🔔" value={liveTotal}      label={t('lia_summary_total', lang)} iconBg="var(--info2)" />
                <PhoenixMetricCard icon="🔴" value={liveHigh}       label={t('lia_summary_high', lang)} iconBg="var(--err2)" valueColor="var(--err)" />
                <PhoenixMetricCard icon="📦" value={liveSurplus}    label={t('lia_summary_surplus', lang)} iconBg="var(--ok2)" valueColor="var(--ok)" />
                <PhoenixMetricCard icon="⏱️" value={liveNearExpiry} label={t('lia_summary_near_expiry', lang)} iconBg="var(--warn2)" valueColor="var(--warn)" />
              </div>

              {liveTotal === 0 ? (
                <div style={{
                  padding: '14px 16px', borderRadius: 'var(--r3)',
                  background: 'var(--s)', border: '1px solid var(--brd)',
                  color: 'var(--t2)', fontSize: '12.5px', textAlign: 'center',
                  marginBottom: isMobile ? '20px' : '28px',
                }}>
                  ✓ {t('lia_empty', lang)}
                </div>
              ) : (
                <div style={{ marginBottom: isMobile ? '20px' : '28px' }}>
                  <button
                    onClick={() => onNavigate(13)}
                    style={{ padding: '5px 12px', borderRadius: 'var(--r2)', border: '1px solid var(--p)', background: 'var(--p2)', color: 'var(--pd)', fontSize: '11.5px', fontWeight: 600, cursor: 'pointer' }}
                  >
                    {t('view_all_alerts', lang)} →
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* Smart Material Alerts compact widget — always shown when data is loaded */}
      {materialAlertResult && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '10px' }}>
            <h3 style={{ fontSize: '14px', fontWeight: 700 }}>{t('smart_material_alerts', lang)}</h3>
            <button
              onClick={() => onNavigate(13)}
              style={{ padding: '5px 12px', borderRadius: 'var(--r2)', border: '1px solid var(--err)', background: 'var(--err2)', color: 'var(--err)', fontSize: '11.5px', fontWeight: 600, cursor: 'pointer' }}
            >
              {t('view_all_alerts', lang)} →
            </button>
          </div>

          {topSmartAlerts.length === 0 ? (
            <div style={{
              padding: '14px 16px', borderRadius: 'var(--r3)',
              background: 'var(--s)', border: '1px solid var(--brd)',
              color: 'var(--t2)', fontSize: '12.5px', textAlign: 'center',
              marginBottom: isMobile ? '20px' : '28px',
            }}>
              ✓ {t('no_critical_alerts_now', lang)}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: isMobile ? '20px' : '28px' }}>
              {topSmartAlerts.map(a => {
                const name = lang === 'ar' ? (a.materialNameAr || a.materialName) : (a.materialName || a.materialNameAr);
                const inst = lang === 'ar' ? (a.institutionNameAr || a.institutionName) : (a.institutionName || a.institutionNameAr);
                const borderColor  = SEVERITY_BORDER_COLOR[a.severity] ?? 'var(--brd)';
                const sevVariant   = (a.severity === 'critical' || a.severity === 'urgent') ? 'err' as const : a.severity === 'high' ? 'warn' as const : 'neutral' as const;
                const sevKey       = a.severity === 'critical' ? 'critical' : a.severity === 'urgent' ? 'urgent' : a.severity === 'high' ? 'high' : 'watch';
                return (
                  <PhoenixCard key={a.id} padding="10px 14px" hover onClick={() => onNavigate(13)}
                    style={{ borderInlineStart: `3px solid ${borderColor}` }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <span style={{ fontSize: '12.5px', fontWeight: 700 }} dir="auto">{name || '—'}</span>
                        <div style={{ fontSize: '10.5px', color: 'var(--t2)', marginTop: '2px' }} dir="auto">{inst}</div>
                        {a.expiryDate && (
                          <div style={{ fontSize: '10px', color: 'var(--t2)', marginTop: '3px' }} dir="ltr">
                            ⏱ {t('iia_expiry', lang)}: {a.expiryDate}
                          </div>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap', flexShrink: 0 }}>
                        {a.kind === 'expiry' && a.monthsBucket && (
                          <ExpiryBucketBadge bucket={a.monthsBucket} lang={lang} />
                        )}
                        <PhoenixStatusBadge variant={sevVariant} label={t(sevKey, lang)} />
                      </div>
                    </div>
                  </PhoenixCard>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Institution status cards */}
      <h3 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '12px' }}>{t('inst_status', lang)}</h3>
      {insts.loading && <PhoenixLoadingState label={t('loading', lang)} />}
      {!insts.loading && insts.error && (
        <PhoenixErrorState title={t('load_error', lang)} message={insts.error} onRetry={insts.reload} />
      )}
      {!insts.loading && !insts.error && insts.data && insts.data.length === 0 && (
        <PhoenixEmptyState icon="🏥" title={t('empty_orgs', lang)} description={t('d_no_data', lang)} />
      )}
      {!insts.loading && !insts.error && insts.data && insts.data.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(2, 1fr)', gap: '12px', marginBottom: isMobile ? '20px' : '28px' }}>
          {insts.data.map(inst => {
            const warn = inst.missing > 0 || inst.low > 5;
            const total = inst.available + inst.low + inst.missing;
            const pct = total > 0 ? Math.round((inst.available / total) * 100) : 0;
            return (
              <PhoenixCard
                key={inst.id}
                onClick={() => onNavigate(11)}
                hover
                padding="16px"
                border={warn ? '1px solid var(--warn)' : '1px solid var(--brd)'}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '11px' }}>
                  <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: warn ? 'var(--warn)' : 'var(--ok)', flexShrink: 0 }} />
                  <span style={{ fontSize: '12.5px', fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {lang === 'ar' ? inst.name_ar : inst.name}
                  </span>
                  <PhoenixStatusBadge variant={warn ? 'warn' : 'ok'} label={t(warn ? 'safemode' : 'healthy', lang)} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px', textAlign: 'center', marginBottom: '10px' }}>
                  <div><div style={{ fontSize: '15px', fontWeight: 700 }}>{inst.available}</div><div style={{ fontSize: '10px', color: 'var(--t2)' }}>{t('avail', lang)}</div></div>
                  <div><div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--warn)' }}>{inst.low}</div><div style={{ fontSize: '10px', color: 'var(--t2)' }}>{t('low', lang)}</div></div>
                  <div><div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--err)' }}>{inst.missing}</div><div style={{ fontSize: '10px', color: 'var(--t2)' }}>{t('miss', lang)}</div></div>
                </div>
                <div style={{ height: '3px', background: 'var(--brd)', borderRadius: 'var(--rpill)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${pct}%`, background: warn ? 'var(--warn)' : 'var(--p)', borderRadius: 'var(--rpill)' }} />
                </div>
              </PhoenixCard>
            );
          })}
        </div>
      )}

      {/* Quick actions */}
      <h3 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '12px' }}>{t('quick', lang)}</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxWidth: isMobile ? undefined : '480px' }}>
        {[
          { screen: 11, icon: '🏛️', labelKey: 'nav_institutions', descKey: 'inst_sub' },
          { screen: 12, icon: '📋', labelKey: 'nav_status_center', descKey: 'sc_sub' },
          { screen: 3,  icon: '✏️', labelKey: 'nav_editor', descKey: 'editor_desc' },
          { screen: 9,  icon: '📈', labelKey: 'nav_reports', descKey: 'reports_desc' },
        ].map(item => (
          <button
            key={item.screen}
            onClick={() => onNavigate(item.screen)}
            style={{
              display: 'flex', alignItems: 'center', gap: '12px',
              padding: '13px 14px', borderRadius: 'var(--r3)',
              border: '1px solid var(--brd)', background: 'var(--s)',
              color: 'var(--t)', textAlign: 'start', width: '100%',
              cursor: 'pointer', transition: 'all 120ms',
            }}
          >
            <span style={{ fontSize: '20px', flexShrink: 0 }}>{item.icon}</span>
            <div>
              <div style={{ fontSize: '12.5px', fontWeight: 600 }}>{t(item.labelKey, lang)}</div>
              <div style={{ fontSize: '11px', color: 'var(--t2)', marginTop: '2px' }}>{t(item.descKey, lang)}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
