/**
 * LIVE-ALERTS-DASHBOARD-SUMMARY-A
 * Run: npm test -- --run
 *
 * Static source-code tests for the Dashboard's rebuilt inter-institution
 * alert summary widget, now backed by getLiveInterInstitutionAlerts()
 * (migration 036) instead of generateExchangeAlerts() over the manual
 * status-report layer.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const dashboard = readSrc('features/dashboard/DashboardScreen.tsx');
const strings = readSrc('shared/i18n/strings.ts');

describe('DashboardScreen: uses the live inter-institution alerts service', () => {
  it('imports getLiveInterInstitutionAlerts from live-inter-institution-alerts.service', () => {
    expect(dashboard).toContain("from '@/features/alerts/live-inter-institution-alerts.service'");
    expect(dashboard).toContain('getLiveInterInstitutionAlerts');
  });

  it('loads live alerts with a safe limit via useAsync', () => {
    expect(dashboard).toMatch(/useAsync\(\(\) => getLiveInterInstitutionAlerts\(200\), \[\]\)/);
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
  it('computes total, high severity, surplus_to_shortage, and near_expiry_to_shortage counts', () => {
    expect(dashboard).toMatch(/const liveTotal = liveList\.length/);
    expect(dashboard).toMatch(/const liveHigh = liveList\.filter\(a => a\.severity === 'high'\)\.length/);
    expect(dashboard).toMatch(/const liveSurplus = liveList\.filter\(a => a\.alertType === 'surplus_to_shortage'\)\.length/);
    expect(dashboard).toMatch(/const liveNearExpiry = liveList\.filter\(a => a\.alertType === 'near_expiry_to_shortage'\)\.length/);
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
  it('the new Live Inter-Institution Alerts section has no suggestion/recommendation/opportunity/اقتراح/فرصة', () => {
    // Scoped to the NEW widget only: the untouched, separate
    // computeMaterialAlerts()-based "Smart Material Alerts" widget
    // legitimately still uses the legacy AlertSeverity value 'opportunity'
    // as a Record key (SEVERITY_BORDER_COLOR) — that is pre-existing,
    // unrelated local/material-alert code, not new live-alert wording.
    const sectionStart = dashboard.indexOf('d_live_alerts_title');
    const sectionEnd = dashboard.indexOf('Institution status cards');
    const section = dashboard.slice(sectionStart, sectionEnd);
    expect(section.toLowerCase()).not.toMatch(/suggestion|suggested|recommendation|recommended|opportunit/);
    expect(section).not.toContain('اقتراح');
    expect(section).not.toContain('فرصة');
  });

  it('the new d_live_alerts_title key is clean and matches the required bilingual wording', () => {
    const line = strings.split('\n').find(l => l.includes('d_live_alerts_title:'));
    expect(line).toContain('Live Inter-Institution Alerts');
    expect(line).toContain('تنبيهات حية بين المؤسسات');
    expect(line?.toLowerCase()).not.toMatch(/suggestion|recommendation|opportunit/);
    expect(line).not.toContain('اقتراح');
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
