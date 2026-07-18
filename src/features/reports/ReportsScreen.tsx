import { useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { getDashboardMetrics, getInstitutionOverviews } from '@/shared/supabase/services/dashboard.service';
import { getLowStockItems } from '@/shared/supabase/services/availability.service';
import { AuditLogSection } from './AuditLogSection';
import { GlobalMaterialSearchPanel } from './GlobalMaterialSearchPanel';
import { useShadowObservation } from '@/shared/authz/useAuthorization';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixOrgScope } from '@/shared/ui/PhoenixOrgScope';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixScreenHeader } from '@/shared/ui/PhoenixScreenHeader';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';

type ReportTab = 'summary' | 'low' | 'missing' | 'comparison' | 'global' | 'audit';

interface LowRow {
  id: string;
  quantity: number;
  condition: string;
  expiry_date: string | null;
  local_items: { central_items: { name: string; name_ar: string; unit: string } | { name: string; name_ar: string; unit: string }[] } | null;
  distribution_points: { name: string; name_ar: string } | { name: string; name_ar: string }[] | null;
}

function one<T>(v: T | T[] | null | undefined): T | null {
  if (!v) return null;
  return Array.isArray(v) ? v[0] ?? null : v;
}

export function ReportsScreen() {
  const { lang, activeOrgId, authz, role } = useApp();
  const [tab, setTab] = useState<ReportTab>('summary');

  // PHASE-1-CONTROLLED-RBAC-ACTIVATION-SHADOW-MODE: observe only. This screen
  // has never been permission-gated; gating it now would newly block anyone
  // whose effective permissions lack reports.view, which is exactly the
  // production change shadow mode exists to avoid. The scoped engine runs, the
  // comparison is reported, and the screen renders as before.
  useShadowObservation(authz, 'reports.view', { organizationId: activeOrgId });
  const isMobile = window.innerWidth < 768;

  const metrics  = useAsync(() => getDashboardMetrics(activeOrgId ?? undefined), [activeOrgId]);
  const overview = useAsync(() => getInstitutionOverviews(), []);
  const lowStock = useAsync(() => activeOrgId ? getLowStockItems(activeOrgId) : Promise.resolve([]), [activeOrgId]);

  const lowRows = (lowStock.data ?? []) as unknown as LowRow[];
  const lowOnly = lowRows.filter(r => r.condition === 'low_stock' || r.condition === 'near_expiry');
  const missing = lowRows.filter(r => r.condition === 'missing' || r.condition === 'expired');

  const tabStyle = (active: boolean) => ({
    flex: 1, minWidth: '80px', padding: '8px 10px', borderRadius: 'var(--r2)', border: 'none',
    background: active ? 'var(--p)' : 'transparent',
    color: active ? '#fff' : 'var(--t2)',
    fontSize: '12px', fontWeight: 600, cursor: 'pointer', transition: 'all 150ms', whiteSpace: 'nowrap' as const,
  });

  const TABS: Array<{ id: ReportTab; labelKey: string }> = [
    { id: 'summary',    labelKey: 'tab_summary' },
    { id: 'low',        labelKey: 'tab_low' },
    { id: 'missing',    labelKey: 'tab_miss' },
    { id: 'comparison', labelKey: 'tab_comp' },
    ...(role === 'super_admin' ? [{ id: 'global' as const, labelKey: 'global_material_search' }] : []),
    { id: 'audit',      labelKey: 'tab_audit' },
  ];

  const itemName = (r: LowRow) => {
    const ci = one(r.local_items?.central_items);
    return lang === 'ar' ? ci?.name_ar ?? ci?.name ?? '—' : ci?.name ?? ci?.name_ar ?? '—';
  };
  const pointName = (r: LowRow) => {
    const dp = one(r.distribution_points);
    return lang === 'ar' ? dp?.name_ar ?? dp?.name ?? '' : dp?.name ?? dp?.name_ar ?? '';
  };

  // 'audit' is excluded here (PHASE2-HIDE-REPORTS-MOVE-AUDIT-TO-STATUS-CENTER-A):
  // AuditLogSection now renders its own no-org-scope empty state internally,
  // so this shared block must not also render one for 'audit' (would double up).
  const needsOrg = (tab === 'low' || tab === 'missing') && !activeOrgId;

  return (
    <div className="premium-page nexus-reports-page" style={{ maxWidth: '1100px', animation: 'fs .3s ease' }}>
      <PhoenixScreenHeader
        icon="reports"
        eyebrow={lang === 'ar' ? 'PHOENIX REPORTS · قراءة موثّقة' : 'PHOENIX REPORTS · VERIFIED READOUT'}
        title={t('nav_reports', lang)}
        description={t('reports_sub', lang)}
        actions={<PhoenixOrgScope />}
      />

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginBottom: '20px', background: 'var(--s2)', borderRadius: 'var(--r3)', padding: '4px', border: '1px solid var(--brd)' }}>
        {TABS.map(tb => (
          <button key={tb.id} style={tabStyle(tab === tb.id)} onClick={() => setTab(tb.id)}>{tb.id === 'global' ? (lang === 'ar' ? 'البحث الشامل عن مادة' : 'Global material search') : t(tb.labelKey, lang)}</button>
        ))}
      </div>

      {needsOrg && <PhoenixEmptyState icon="institutions" title={t('no_org_scope', lang)} description={t('empty_hint', lang)} />}

      {/* Summary */}
      {tab === 'summary' && (
        <>
          {metrics.loading && <PhoenixLoadingState label={t('loading', lang)} />}
          {!metrics.loading && metrics.error && <PhoenixErrorState title={t('load_error', lang)} message={metrics.error} onRetry={metrics.reload} />}
          {!metrics.loading && !metrics.error && metrics.data && (
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: isMobile ? '10px' : '14px', animation: 'fs .25s ease' }}>
              {[
                { val: metrics.data.availableItems, k: 'm_avail', c: 'var(--ok)' },
                { val: metrics.data.lowStockCount,  k: 'm_low',   c: 'var(--warn)' },
                { val: metrics.data.missingCount,   k: 'm_miss',  c: 'var(--err)' },
                { val: metrics.data.nearExpiryCount, k: 'm_exp',  c: 'var(--warn)' },
              ].map(item => (
                <PhoenixCard key={item.k} padding="18px">
                  <div style={{ fontSize: '26px', fontWeight: 700, color: item.c }}>{item.val}</div>
                  <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '3px' }}>{t(item.k, lang)}</div>
                </PhoenixCard>
              ))}
            </div>
          )}
        </>
      )}

      {/* Low stock */}
      {tab === 'low' && activeOrgId && (
        <>
          {lowStock.loading && <PhoenixLoadingState label={t('loading', lang)} />}
          {!lowStock.loading && lowStock.error && <PhoenixErrorState title={t('load_error', lang)} message={lowStock.error} onRetry={lowStock.reload} />}
          {!lowStock.loading && !lowStock.error && lowOnly.length === 0 && <PhoenixEmptyState icon="check" title={t('empty_avail', lang)} />}
          {!lowStock.loading && !lowStock.error && lowOnly.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', animation: 'fs .25s ease' }}>
              {lowOnly.map(r => (
                <div key={r.id} style={{ background: 'var(--s)', borderRadius: 'var(--r3)', padding: '14px', boxShadow: 'var(--sh-xs)', border: '1px solid var(--brd)', borderInlineStart: '3px solid var(--warn)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '6px' }}>
                    <span style={{ fontSize: '13px', fontWeight: 600 }}>{itemName(r)}</span>
                    <span style={{ padding: '2px 8px', borderRadius: 'var(--rpill)', background: 'var(--warn2)', color: 'var(--warn)', fontSize: '10.5px', fontWeight: 700 }}>{r.quantity} {t('units', lang)}</span>
                  </div>
                  <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', fontSize: '11px', color: 'var(--t2)' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}><PhoenixIcon name="location" size={12} /> {pointName(r)}</span>
                    {r.expiry_date && <span dir="ltr"><PhoenixIcon name="clock" size={12} style={{ verticalAlign: 'text-bottom', marginInlineEnd: '4px' }} /> {r.expiry_date}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Missing */}
      {tab === 'missing' && activeOrgId && (
        <>
          {lowStock.loading && <PhoenixLoadingState label={t('loading', lang)} />}
          {!lowStock.loading && lowStock.error && <PhoenixErrorState title={t('load_error', lang)} message={lowStock.error} onRetry={lowStock.reload} />}
          {!lowStock.loading && !lowStock.error && missing.length === 0 && <PhoenixEmptyState icon="check" title={t('empty_avail', lang)} />}
          {!lowStock.loading && !lowStock.error && missing.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', animation: 'fs .25s ease' }}>
              {missing.map(r => (
                <div key={r.id} style={{ background: 'var(--s)', borderRadius: 'var(--r3)', padding: '14px', boxShadow: 'var(--sh-xs)', border: '1px solid var(--err)', borderInlineStart: '3px solid var(--err)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '6px' }}>
                    <span style={{ fontSize: '13px', fontWeight: 600 }}>{itemName(r)}</span>
                    <span style={{ padding: '2px 8px', borderRadius: 'var(--rpill)', background: 'var(--err2)', color: 'var(--err)', fontSize: '10.5px', fontWeight: 700 }}>{t('miss', lang)}</span>
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--t2)', display: 'flex', alignItems: 'center', gap: '4px' }}><PhoenixIcon name="location" size={12} /> {pointName(r)}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Comparison */}
      {tab === 'comparison' && (
        <>
          {overview.loading && <PhoenixLoadingState label={t('loading', lang)} />}
          {!overview.loading && overview.error && <PhoenixErrorState title={t('load_error', lang)} message={overview.error} onRetry={overview.reload} />}
          {!overview.loading && !overview.error && (overview.data?.length ?? 0) === 0 && <PhoenixEmptyState icon="institutions" title={t('empty_orgs', lang)} />}
          {!overview.loading && !overview.error && (overview.data?.length ?? 0) > 0 && (
            <PhoenixCard padding="18px" style={{ animation: 'fs .25s ease' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {(overview.data ?? []).map(o => {
                  const total = o.available + o.low + o.missing;
                  const pct = total > 0 ? Math.round((o.available / total) * 100) : 0;
                  const c = pct >= 90 ? 'var(--p)' : pct >= 75 ? 'var(--ok)' : 'var(--warn)';
                  return (
                    <div key={o.id} style={{ fontSize: '12.5px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '6px' }}>
                        <span style={{ fontWeight: 600 }}>{lang === 'ar' ? o.name_ar : o.name}</span>
                        <span style={{ fontSize: '11px', color: c }}>{pct}%</span>
                      </div>
                      <div style={{ height: '8px', background: 'var(--brd)', borderRadius: 'var(--rpill)', overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${pct}%`, background: c, borderRadius: 'var(--rpill)' }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </PhoenixCard>
          )}
        </>
      )}

      {/* Super-admin-only live stock search across one or multiple institutions. */}
      {tab === 'global' && role === 'super_admin' && <GlobalMaterialSearchPanel />}

      {/* Audit — extracted into AuditLogSection (PHASE2-HIDE-REPORTS-MOVE-AUDIT-TO-STATUS-CENTER-A), also reused by StatusCenterScreen's new Audit Log tab. */}
      {tab === 'audit' && <AuditLogSection />}
    </div>
  );
}
