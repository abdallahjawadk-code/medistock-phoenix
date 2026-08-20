/**
 * LIVE-ALERTS-DASHBOARD-SUMMARY-A
 * Run: npm test -- --run
 *
 * Static source-code tests for the Dashboard's rebuilt inter-institution
 * alert summary widget, instead of generateExchangeAlerts() over the manual
 * status-report layer.
 *
 * ALERT-CQRS-BOUNDARY-190 (G4.1): the widget is now backed by the PURE
 * queryLiveInterOrgAlertSummary() rather than the write-capable with_state
 * hybrid. The counters and their meaning are unchanged — they are simply
 * computed server-side now, and rendering the Dashboard no longer writes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const dashboard = readSrc('features/dashboard/DashboardScreen.tsx');
const strings = readSrc('shared/i18n/strings.ts');

describe('DashboardScreen: uses the live inter-institution alerts service', () => {
  it('imports the lifecycle-aware alert service', () => {
    expect(dashboard).toContain("from '@/features/alerts/inter-org-alert-lifecycle.service'");
    expect(dashboard).toContain('queryLiveInterOrgAlertSummary');
  });

  it('loads the live alert summary with a safe limit via useAsync', () => {
    expect(dashboard).toMatch(/useAsync\(\(\) => queryLiveInterOrgAlertSummary\(200\), \[\]\)/);
  });

  // The hard G4.1 invariant: DASHBOARD_ALERT_READ_CAUSES_WRITE = FALSE.
  it('opening the Dashboard causes ZERO inter-org alert writes', () => {
    // Not the write-capable hybrid, not its paged wrapper, and NOT the refresh
    // COMMAND — the Dashboard must never issue one.
    expect(dashboard).not.toContain('getLiveInterInstitutionAlertsWithState');
    expect(dashboard).not.toContain('getLiveInterInstitutionAlertsPage');
    expect(dashboard).not.toContain('refreshInterOrgAlertLifecycle');
    expect(dashboard).not.toContain('phoenix_get_live_inter_institution_alerts_with_state');
    // …and it no longer ships 200 alert objects to reduce them in the browser.
    expect(dashboard).not.toContain('lifecycleStatus');
    expect(dashboard).not.toMatch(/liveResult\?\.alerts/);
  });

  it('reads the four counters straight off the server-computed summary', () => {
    expect(dashboard).toContain('liveResult?.total');
    expect(dashboard).toContain('liveResult?.high');
    expect(dashboard).toContain('liveResult?.surplusToShortage');
    expect(dashboard).toContain('liveResult?.nearExpiryToShortage');
  });
});

describe('DashboardScreen: old manual status-report exchange path removed from this widget', () => {
  it('no longer imports or calls generateExchangeAlerts', () => {
    expect(dashboard).not.toContain('generateExchangeAlerts');
    expect(dashboard).not.toContain("from '@/features/status/exchange-alerts'");
  });

  it('no longer uses the old exchange-summary i18n keys (ea_title, d_exchange_total, d_exchange_high, ea_priority_medium, ea_manual)', () => {
    expect(dashboard).not.toContain("t('ea_title'");
    expect(dashboard).not.toContain("t('d_exchange_total'");
    expect(dashboard).not.toContain("t('d_exchange_high'");
    expect(dashboard).not.toContain("t('ea_priority_medium'");
    expect(dashboard).not.toContain('ea_manual');
  });
});

describe('DashboardScreen: legacy local/material alert engine intentionally retained', () => {
  it('still imports computeMaterialAlerts for the separate Smart Material Alerts widget (not inter-institution, left untouched)', () => {
    expect(dashboard).toContain('computeMaterialAlerts');
    expect(dashboard).toContain('smart_material_alerts');
  });

  it('still imports getStatusReports (needed by computeMaterialAlerts, unrelated to the live inter-institution summary)', () => {
    expect(dashboard).toContain("from '@/shared/supabase/services/status-reports.service'");
    expect(dashboard).toContain('getStatusReports');
  });

  it('documents why computeMaterialAlerts/getStatusReports remain (legacy/local alert path, not inter-institution)', () => {
    expect(dashboard).toMatch(/SEPARATE, single-institution/i);
    expect(dashboard).toMatch(/NOT inter-institution matching/i);
  });
});

describe('DashboardScreen: live summary counts', () => {
  // ALERT-CQRS-BOUNDARY-190 (G4.1): the four counters are identical in meaning
  // but are now COMPUTED SERVER-SIDE by the pure summary query instead of being
  // reduced in the browser over 200 fetched alert objects. The active-lifecycle
  // rule (open/acknowledged/in_progress) moved into the RPC and is proved there
  // by 190's dynamic suite; what this test guards on the client is that each
  // rendered counter comes straight off the server payload and is not
  // re-derived here.
  it('reads total, high severity, surplus_to_shortage and near_expiry_to_shortage from the server', () => {
    expect(dashboard).toMatch(/const liveTotal = liveOk \? \(liveResult\?\.total \?\? 0\) : 0/);
    expect(dashboard).toMatch(/const liveHigh = liveOk \? \(liveResult\?\.high \?\? 0\) : 0/);
    expect(dashboard).toMatch(/const liveSurplus = liveOk \? \(liveResult\?\.surplusToShortage \?\? 0\) : 0/);
    expect(dashboard).toMatch(/const liveNearExpiry = liveOk \? \(liveResult\?\.nearExpiryToShortage \?\? 0\) : 0/);
    // No client-side reduction of an alert list survives the cutover.
    expect(dashboard).not.toMatch(/liveList/);
    expect(dashboard).not.toMatch(/\.filter\(a => a\.severity === 'high'\)/);
  });

  it('renders all 4 counts using PhoenixMetricCard with the shared lia_summary_* labels', () => {
    expect(dashboard).toContain("t('lia_summary_total', lang)");
    expect(dashboard).toContain("t('lia_summary_high', lang)");
    expect(dashboard).toContain("t('lia_summary_surplus', lang)");
    expect(dashboard).toContain("t('lia_summary_near_expiry', lang)");
  });
});

describe('DashboardScreen: navigation to InterInstitutionAlertsScreen', () => {
  it('links to screen 13 (existing InterInstitutionAlertsScreen route) from the live summary', () => {
    const sectionStart = dashboard.indexOf('d_live_alerts_title');
    const sectionEnd = dashboard.indexOf('Institution status cards');
    const section = dashboard.slice(sectionStart, sectionEnd);
    expect(section).toMatch(/onNavigate\(13\)/);
    expect(section).toContain('view_all_alerts');
  });
});

describe('DashboardScreen: does not render supply_type', () => {
  it('no supply_type anywhere in the dashboard screen', () => {
    expect(dashboard).not.toContain('supply_type');
  });
});

describe('DashboardScreen: new live-alert wording has no forbidden terms', () => {
  it('the new Live Transfer Suggestions section has no opportunity/فرصة promotional wording', () => {
    // Scoped to the NEW widget only: the untouched, separate
    // computeMaterialAlerts()-based "Smart Material Alerts" widget
    // legitimately still uses the legacy AlertSeverity value 'opportunity'
    // as a Record key (SEVERITY_BORDER_COLOR) — that is pre-existing,
    // unrelated local/material-alert code, not new live-alert wording.
    const sectionStart = dashboard.indexOf('d_live_alerts_title');
    const sectionEnd = dashboard.indexOf('Institution status cards');
    const section = dashboard.slice(sectionStart, sectionEnd);
    expect(section.toLowerCase()).not.toMatch(/opportunit/); // suggestion is the mandated term (UNIFIED-DOMAIN)
    // اقتراح is the mandated Transfer-Suggestions term (UNIFIED-DOMAIN §11).
    expect(section).not.toContain('فرصة');
  });

  it('the new d_live_alerts_title key is clean and matches the required bilingual wording', () => {
    const line = strings.split('\n').find(l => l.includes('d_live_alerts_title:'));
    expect(line).toContain('Live Transfer Suggestions'); // UNIFIED-DOMAIN §11
    expect(line).toContain('اقتراحات مناقلات حية');
    expect(line?.toLowerCase()).not.toMatch(/opportunit/);

    expect(line).not.toContain('فرصة');
  });

  it('reused lia_* strings (already verified clean in a prior phase) are used, not new tainted wording', () => {
    expect(dashboard).toContain('lia_sub');
    expect(dashboard).toContain('lia_summary_total');
    expect(dashboard).toContain('lia_summary_high');
    expect(dashboard).toContain('lia_summary_surplus');
    expect(dashboard).toContain('lia_summary_near_expiry');
    expect(dashboard).toContain('lia_empty');
  });
});

describe('DashboardScreen: loading/error/empty/forbidden behavior for the live summary', () => {
  it('shows a loading state while the live alerts RPC is in flight', () => {
    const sectionStart = dashboard.indexOf('d_live_alerts_title');
    const sectionEnd = dashboard.indexOf('Institution status cards');
    const section = dashboard.slice(sectionStart, sectionEnd);
    expect(section).toContain('PhoenixLoadingState');
    expect(section).toMatch(/liveAlerts\.loading && <PhoenixLoadingState/);
  });

  it('shows a safe error state (with retry) on RPC/network failure, without crashing the rest of the dashboard', () => {
    const sectionStart = dashboard.indexOf('d_live_alerts_title');
    const sectionEnd = dashboard.indexOf('Institution status cards');
    const section = dashboard.slice(sectionStart, sectionEnd);
    expect(section).toContain('PhoenixErrorState');
    expect(section).toContain('liveAlerts.reload');
  });

  it('hides the live summary entirely (no crash) when the RPC reports FORBIDDEN', () => {
    expect(dashboard).toContain("liveRpcError === 'FORBIDDEN'");
    expect(dashboard).toMatch(/\{!liveForbidden && \(/);
  });

  it('shows a zero-count empty state with the required bilingual message', () => {
    const sectionStart = dashboard.indexOf('d_live_alerts_title');
    const sectionEnd = dashboard.indexOf('Institution status cards');
    const section = dashboard.slice(sectionStart, sectionEnd);
    expect(section).toContain('liveTotal === 0');
    expect(section).toContain('lia_empty');
  });
});

describe('Guards: no SQL/migration/RPC/QR/quantity-movement/service_role/Excel changes in this widget', () => {
  it('no SQL/migration reference in the dashboard screen', () => {
    expect(dashboard).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION|CREATE\s+POLICY|CREATE\s+TABLE/i);
  });

  it('no QR reference', () => {
    expect(dashboard).not.toMatch(/qr[_-]?token|QrToken|public.?qr|get_public_qr_payload/i);
  });

  it('no quantity-movement reference (applyAvailabilityMovement, phoenix_apply_availability_movement)', () => {
    expect(dashboard).not.toContain('applyAvailabilityMovement');
    expect(dashboard).not.toContain('phoenix_apply_availability_movement');
  });

  it('no service_role or auth.admin', () => {
    expect(dashboard).not.toContain('service_role');
    expect(dashboard).not.toMatch(/auth\.admin/);
  });

  it('no Excel/XLSX import', () => {
    expect(dashboard).not.toMatch(/xlsx|exceljs|read-excel-file|sheetjs|papaparse/i);
  });
});
