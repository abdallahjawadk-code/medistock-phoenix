/**
 * LIVE-INTER-INSTITUTION-ALERTS-UI-A
 * Run: npm test -- --run
 *
 * Static source-code tests for the rebuilt InterInstitutionAlertsScreen,
 * now wired to getLiveInterInstitutionAlerts() (migration 036) instead of
 * the legacy institution_item_status_reports-based path.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const screen = readSrc('features/alerts/InterInstitutionAlertsScreen.tsx');
const strings = readSrc('shared/i18n/strings.ts');
const dashboardScreen = readSrc('features/dashboard/DashboardScreen.tsx');
const statusCenter = readSrc('features/status/StatusCenterScreen.tsx');

describe('InterInstitutionAlertsScreen: uses the live RPC service', () => {
  it('imports getLiveInterInstitutionAlerts from live-inter-institution-alerts.service', () => {
    expect(screen).toContain("from './live-inter-institution-alerts.service'");
    expect(screen).toContain('getLiveInterInstitutionAlerts');
  });

  it('calls getLiveInterInstitutionAlerts inside the data-loading hook', () => {
    expect(screen).toMatch(/useAsync\(\(\) => getLiveInterInstitutionAlerts\(/);
  });
});

describe('InterInstitutionAlertsScreen: legacy manual status-report path removed', () => {
  it('does not call getScopedInterInstitutionAlerts', () => {
    expect(screen).not.toContain('getScopedInterInstitutionAlerts');
  });

  it('does not call generateExchangeAlerts', () => {
    expect(screen).not.toContain('generateExchangeAlerts');
  });

  it('does not import StatusReport', () => {
    expect(screen).not.toContain('StatusReport');
  });

  it('does not import status-reports.service.ts', () => {
    expect(screen).not.toContain('status-reports.service');
  });

  it('does not reference institution_item_status_reports', () => {
    expect(screen).not.toContain('institution_item_status_reports');
  });

  it('does not import the legacy ./inter-institution-alerts.service or ./inter-institution-alerts helper', () => {
    expect(screen).not.toMatch(/from '\.\/inter-institution-alerts\.service'/);
    expect(screen).not.toMatch(/from '\.\/inter-institution-alerts'/);
  });

  it('does not import materialAlertEngine', () => {
    expect(screen).not.toContain('materialAlertEngine');
  });

  it('does not use mock/hardcoded alert data', () => {
    expect(screen).not.toMatch(/\b(fake|hardcode|hardcoded|demoAlert|mockAlert)\b/i);
  });
});

describe('InterInstitutionAlertsScreen: does not render supply_type', () => {
  it('no supply_type anywhere in the screen', () => {
    expect(screen).not.toContain('supply_type');
  });
});

describe('InterInstitutionAlertsScreen: forbidden wording removed', () => {
  it('does not use suggestion/suggested wording', () => {
    expect(screen.toLowerCase()).not.toMatch(/suggestion|suggested/);
  });

  it('does not use recommendation/recommended wording', () => {
    expect(screen.toLowerCase()).not.toMatch(/recommendation|recommended/);
  });

  it('does not use opportunity wording', () => {
    expect(screen.toLowerCase()).not.toMatch(/opportunit/);
  });

  it('does not use Arabic اقتراح/فرصة wording', () => {
    expect(screen).not.toContain('اقتراح');
    expect(screen).not.toContain('فرصة');
  });

  it('uses Alert/تنبيه and Required Action/إجراء مطلوب wording keys', () => {
    expect(screen).toContain('lia_title');
    expect(screen).toContain('lia_required_action');
    const titleLine = strings.split('\n').find(l => l.includes('lia_title:'));
    expect(titleLine).toContain('Inter-Institution Alerts');
    expect(titleLine).toContain('تنبيهات بين المؤسسات');
    const reqActionLine = strings.split('\n').find(l => l.includes('lia_required_action:'));
    expect(reqActionLine).toContain('Required Action');
    expect(reqActionLine).toContain('إجراء مطلوب');
  });

  it('none of the new lia_* strings use suggestion/recommendation/opportunity/اقتراح/فرصة', () => {
    const liaLines = strings.split('\n').filter(l => /^\s*lia_/.test(l));
    const joined = liaLines.join('\n');
    expect(joined.toLowerCase()).not.toMatch(/suggestion|suggested|recommendation|recommended|opportunit/);
    expect(joined).not.toContain('اقتراح');
    expect(joined).not.toContain('فرصة');
  });
});

describe('InterInstitutionAlertsScreen: live-availability wording', () => {
  it('subtitle communicates live-computed alerts', () => {
    expect(screen).toContain('lia_sub');
    const subLine = strings.split('\n').find(l => l.includes('lia_sub:'));
    expect(subLine).toContain('current live availability');
    expect(subLine).toContain('التوفر الحالي المباشر');
  });
});

describe('InterInstitutionAlertsScreen: summary cards', () => {
  it('renders all 4 required summary cards', () => {
    expect(screen).toContain('lia_summary_total');
    expect(screen).toContain('lia_summary_high');
    expect(screen).toContain('lia_summary_surplus');
    expect(screen).toContain('lia_summary_near_expiry');
  });

  it('summary counts are derived from severity and alertType fields', () => {
    expect(screen).toMatch(/a\.severity === 'high'/);
    expect(screen).toMatch(/a\.alertType === 'surplus_to_shortage'/);
    expect(screen).toMatch(/a\.alertType === 'near_expiry_to_shortage'/);
  });
});

describe('InterInstitutionAlertsScreen: filters', () => {
  it('has a severity filter', () => {
    expect(screen).toContain('severityFilter');
    expect(screen).toContain('lia_severity_label');
  });

  it('has an alert type filter', () => {
    expect(screen).toContain('typeFilter');
    expect(screen).toContain('lia_type_label');
  });

  it('has an institution filter derived from source/target org ids', () => {
    expect(screen).toContain('instFilter');
    expect(screen).toContain('sourceOrganizationId');
    expect(screen).toContain('targetOrganizationId');
  });

  it('search matches scientific_name, concentration, dosage_form, trade_name, and org names', () => {
    const fnStart = screen.indexOf('const filtered = useMemo');
    const fnBody = screen.slice(fnStart, fnStart + 900);
    expect(fnBody).toContain('a.scientificName');
    expect(fnBody).toContain('a.concentration');
    expect(fnBody).toContain('a.dosageForm');
    expect(fnBody).toContain('a.sourceTradeName');
    expect(fnBody).toContain('a.targetTradeName');
    expect(fnBody).toContain('a.sourceOrganizationName');
    expect(fnBody).toContain('a.targetOrganizationName');
  });
});

describe('InterInstitutionAlertsScreen: card fields', () => {
  it('renders alert_type and severity', () => {
    expect(screen).toContain('ALERT_TYPE_LABEL_KEY');
    expect(screen).toContain('a.severity');
  });

  it('renders source and target organization + distribution point', () => {
    expect(screen).toContain('a.sourceOrganizationName');
    expect(screen).toContain('a.sourceDistributionPointName');
    expect(screen).toContain('a.targetOrganizationName');
    expect(screen).toContain('a.targetDistributionPointName');
  });

  it('renders scientific_name, concentration, dosage_form', () => {
    expect(screen).toContain('a.scientificName');
    expect(screen).toContain('a.concentration');
    expect(screen).toContain('a.dosageForm');
  });

  it('renders source_trade_name and target_trade_name as display fields, not identity/matching logic', () => {
    expect(screen).toContain('a.sourceTradeName');
    expect(screen).toContain('a.targetTradeName');
    // trade name must never be compared against another trade name anywhere
    expect(screen).not.toMatch(/sourceTradeName\s*===?\s*.*targetTradeName/);
    expect(screen).not.toMatch(/tradeName.*match|match.*tradeName/i);
  });

  it('renders source_status and target_status', () => {
    expect(screen).toContain('a.sourceStatus');
    expect(screen).toContain('a.targetStatus');
  });

  it('renders source_quantity and target_quantity', () => {
    expect(screen).toContain('a.sourceQuantity');
    expect(screen).toContain('a.targetQuantity');
  });

  it('renders source_expiry_date only for near_expiry_to_shortage alerts', () => {
    expect(screen).toMatch(/a\.alertType === 'near_expiry_to_shortage' \? a\.sourceExpiryDate : null/);
  });

  it('renders computed_at', () => {
    expect(screen).toContain('a.computedAt');
    expect(screen).toContain('lia_computed_at');
  });
});

describe('InterInstitutionAlertsScreen: loading/error/empty/forbidden states', () => {
  it('shows a loading state', () => {
    expect(screen).toContain('PhoenixLoadingState');
    expect(screen).toMatch(/\{result\.loading && <PhoenixLoadingState/);
  });

  it('shows an error state on RPC/network failure', () => {
    expect(screen).toContain('PhoenixErrorState');
    expect(screen).toContain('result.reload');
  });

  it('shows the required bilingual empty-state message', () => {
    expect(screen).toContain('lia_empty');
    const line = strings.split('\n').find(l => l.includes('lia_empty:'));
    expect(line).toContain('No alerts at this time');
    expect(line).toContain('لا توجد تنبيهات حالياً');
  });

  it('handles a FORBIDDEN response with a permission-denied message', () => {
    expect(screen).toContain("rpcError === 'FORBIDDEN'");
    expect(screen).toContain('lia_forbidden');
    const line = strings.split('\n').find(l => l.includes('lia_forbidden:'));
    expect(line).toContain('You do not have permission to view these alerts');
    expect(line).toContain('لا تملك صلاحية عرض هذه التنبيهات');
  });
});

describe('InterInstitutionAlertsScreen: guardrails', () => {
  it('no SQL/migration reference in the screen', () => {
    expect(screen).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION|CREATE\s+POLICY|CREATE\s+TABLE/i);
  });

  it('no QR reference', () => {
    expect(screen).not.toMatch(/qr[_-]?token|QrToken|public.?qr|get_public_qr_payload/i);
  });

  it('no service_role or auth.admin', () => {
    expect(screen).not.toContain('service_role');
    expect(screen).not.toMatch(/auth\.admin/);
  });

  it('no Excel/XLSX import', () => {
    expect(screen).not.toMatch(/xlsx|exceljs|read-excel-file|sheetjs|papaparse/i);
  });

  it('Dashboard and StatusCenter are left unchanged this phase (safer option chosen)', () => {
    expect(dashboardScreen).not.toContain('getLiveInterInstitutionAlerts');
    expect(dashboardScreen).not.toContain('live-inter-institution-alerts.service');
    expect(statusCenter).not.toContain('getLiveInterInstitutionAlerts');
  });
});
