/**
 * LIVE-INTER-INSTITUTION-ALERTS-UI-A
 * Run: npm test -- --run
 *
 * Static source-code tests for the rebuilt InterInstitutionAlertsScreen,
 * now wired to getLiveInterInstitutionAlertsWithState() instead of
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

const UUID_LITERAL_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe('InterInstitutionAlertsScreen: uses the lifecycle RPC service', () => {
  it('imports getLiveInterInstitutionAlertsWithState from inter-org-alert-lifecycle.service', () => {
    expect(screen).toContain("from './inter-org-alert-lifecycle.service'");
    expect(screen).toContain('getLiveInterInstitutionAlertsWithState');
  });

  it('calls getLiveInterInstitutionAlertsWithState inside the data-loading hook', () => {
    expect(screen).toMatch(/useAsync\(\(\) => getLiveInterInstitutionAlertsWithState\(/);
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
  it('does not use opportunity/promotional wording (suggestion IS the mandated term now)', () => {
    expect(screen.toLowerCase()).not.toMatch(/opportunit/);
  });

  it('does not use recommendation/recommended wording', () => {
    expect(screen.toLowerCase()).not.toMatch(/recommendation|recommended/);
  });

  it('does not use opportunity wording', () => {
    expect(screen.toLowerCase()).not.toMatch(/opportunit/);
  });

  it('does not use Arabic فرصة wording (اقتراح is the mandated term now)', () => {
    expect(screen).not.toContain('فرصة');
    void 0;
    expect(screen).not.toContain('فرصة');
  });

  it('uses Alert/تنبيه and Required Action/إجراء مطلوب wording keys', () => {
    expect(screen).toContain('lia_title');
    expect(screen).toContain('lia_required_action');
    const titleLine = strings.split('\n').find(l => l.includes('lia_title:'));
    expect(titleLine).toContain('Transfer Suggestions'); // UNIFIED-DOMAIN §11
    expect(titleLine).toContain('اقتراحات المناقلات');
    const reqActionLine = strings.split('\n').find(l => l.includes('lia_required_action:'));
    expect(reqActionLine).toContain('Required Action');
    expect(reqActionLine).toContain('إجراء مطلوب');
  });

  it('none of the new lia_* strings use suggestion/recommendation/opportunity/اقتراح/فرصة', () => {
    const liaLines = strings.split('\n').filter(l => /^\s*lia_/.test(l));
    const joined = liaLines.join('\n');
    expect(joined.toLowerCase()).not.toMatch(/opportunit/); // UNIFIED-DOMAIN: suggestion/recommendation are sanctioned terms
    expect(joined).not.toContain('فرصة');
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

describe('INTER-INSTITUTION-ALERTS-SMART-VIEW-A: smart summary + grouping (read-only display only)', () => {
  it('adds missing/low_stock summary chips derived from the already-fetched targetStatus field', () => {
    expect(screen).toContain('lia_summary_missing');
    expect(screen).toContain('lia_summary_low_stock');
    expect(screen).toMatch(/a\.targetStatus === 'missing'/);
    expect(screen).toMatch(/a\.targetStatus === 'low_stock'/);
  });

  it('does not invent new statuses — missing/low_stock are already used by statusLabelKey/statusVariant', () => {
    expect(screen).toMatch(/case 'missing': return 'cond_missing'/);
    expect(screen).toMatch(/case 'low_stock': return 'cond_low_stock'/);
  });

  it('has a read-only group-by toggle (none/material/institution) computed from the already-filtered list', () => {
    expect(screen).toContain('groupMode');
    expect(screen).toContain("useState<GroupMode>('none')");
    expect(screen).toContain('lia_group_label');
    expect(screen).toContain('lia_group_material');
    expect(screen).toContain('lia_group_institution');
    expect(screen).toMatch(/for \(const a of sortedFiltered\)/);
  });

  it('organization/material ids used for grouping are internal Map keys only, never rendered as visible text', () => {
    expect(screen).not.toMatch(/>\{a\.targetOrganizationId\}</);
    expect(screen).not.toMatch(/>\{key\}</);
    const groupsBlock = screen.slice(screen.indexOf('const groups = useMemo'), screen.indexOf('const groups = useMemo') + 700);
    expect(groupsBlock).not.toMatch(/<span[^>]*>\{key\}/);
  });

  it('grouping does not add a new fetch/RPC — same result.data.alerts source as the flat view', () => {
    const fnStart = screen.indexOf('const groups = useMemo');
    const fnBody = screen.slice(fnStart, fnStart + 700);
    expect(fnBody).not.toMatch(/supabase\.|\.rpc\(|await /);
  });

  it('has a smart-view badge label but no exchange/approval wording anywhere near it', () => {
    expect(screen).toContain('lia_smart_view_badge');
    const badgeBlock = screen.slice(screen.indexOf('lia_smart_view_badge') - 200, screen.indexOf('lia_smart_view_badge') + 100);
    expect(badgeBlock).not.toMatch(/exchange|approve|reject|request/i);
  });
});

describe('INTER-INSTITUTION-ALERTS-SMART-VIEW-A: no exchange workflow, no Service-D, no forbidden wording', () => {
  it('no exchange-request button/CTA text', () => {
    expect(screen).not.toMatch(/create.{0,3}exchange|request.{0,3}exchange|send.{0,3}request/i);
    expect(screen).not.toContain('createInterOrgExchangeRequest');
  });

  it('no approval/rejection workflow wording', () => {
    expect(screen).not.toMatch(/\bapprove\b|\breject\b|\bapproval\b/i);
    expect(screen).not.toContain('موافقة');
    expect(screen).not.toContain('رفض');
    expect(screen).not.toContain('طلب تبادل');
    expect(screen).not.toContain('إنشاء طلب');
  });

  it('does not import the Service-D exchange service', () => {
    expect(screen).not.toMatch(/from '\.\/inter-org-exchange\.service'/);
    expect(screen).not.toContain('inter_org_exchange');
  });

  it('no new exchange RPC usage', () => {
    expect(screen).not.toMatch(/phoenix_create_inter_org_exchange_request|phoenix_update_inter_org_exchange_status|phoenix_get_inter_org_exchange_events|phoenix_get_inter_org_exchange_requests/);
  });

  it('does not render alert_key, exchange_request_id, or raw supply_type', () => {
    expect(screen).not.toMatch(/>\{a\.alertKey\}</);
    expect(screen).not.toContain('exchange_request_id');
    expect(screen).not.toContain('supply_type');
  });

  it('none of the new lia_*/smart-view strings use forbidden wording (including new Arabic terms)', () => {
    const liaLines = strings.split('\n').filter(l => /^\s*lia_/.test(l));
    const joined = liaLines.join('\n');
    expect(joined.toLowerCase()).not.toMatch(/opportunit/); // UNIFIED-DOMAIN: suggestion/recommendation are sanctioned terms
    expect(joined).not.toContain('فرصة');
    expect(joined).not.toContain('فرصة');
    expect(joined).not.toContain('توصية');
    expect(joined).not.toContain('طلب تبادل');
    expect(joined).not.toContain('إنشاء طلب');
    expect(joined).not.toContain('موافقة');
    expect(joined).not.toContain('رفض');
  });

  it('filters/grouping are read-only display controls only — no onClick side effects that call RPCs', () => {
    expect(screen).not.toMatch(/onChange={e => setGroupMode[^}]*}\s*>\s*[^<]*supabase/);
  });
});

describe('INTER-INSTITUTION-ALERTS-SMART-VIEW-B: priority sort + critical lane (read-only display only)', () => {
  it('has a read-only sort-by toggle computed from the already-filtered list, no new fetch', () => {
    expect(screen).toContain('sortMode');
    expect(screen).toContain("useState<SortMode>('default')");
    expect(screen).toContain('lia_sort_label');
    expect(screen).toContain('lia_sort_severity');
    expect(screen).toContain('lia_sort_missing');
    expect(screen).toContain('lia_sort_lowstock');
    expect(screen).toContain('lia_sort_nearexpiry');
    expect(screen).toContain('lia_sort_newest');
  });

  it('sortAlerts is a pure function over already-fetched fields only (severity/targetStatus/alertType/computedAt)', () => {
    const fnStart = screen.indexOf('function sortAlerts');
    const fnBody = screen.slice(fnStart, screen.indexOf('\n}', fnStart) + 2);
    expect(fnBody).toContain('a.severity');
    expect(fnBody).toContain('a.targetStatus');
    expect(fnBody).toContain('a.alertType');
    expect(fnBody).toContain('a.computedAt');
    expect(fnBody).not.toMatch(/supabase\.|\.rpc\(|await /);
  });

  it('does not invent new statuses — sort options reuse missing/low_stock/near_expiry_to_shortage already used elsewhere in the screen', () => {
    expect(screen).toMatch(/a\.targetStatus === 'missing'/);
    expect(screen).toMatch(/a\.targetStatus === 'low_stock'/);
    expect(screen).toMatch(/a\.alertType === 'near_expiry_to_shortage'/);
  });

  it('has a read-only critical lane limited to a small number of already-filtered high-severity alerts', () => {
    expect(screen).toContain('criticalAlerts');
    expect(screen).toContain('lia_critical_lane_title');
    expect(screen).toMatch(/\.slice\(0, isMobile \? 3 : 5\)/);
    const fnStart = screen.indexOf('const criticalAlerts = useMemo');
    const fnBody = screen.slice(fnStart, fnStart + 500);
    expect(fnBody).toContain('filtered');
    expect(fnBody).not.toMatch(/supabase\.|\.rpc\(|await /);
  });

  it('critical lane cards are read-only — no action buttons, no exchange wiring', () => {
    const fnStart = screen.indexOf('function CriticalAlertCard');
    const fnBody = screen.slice(fnStart, screen.indexOf('\n}\n', fnStart) + 3);
    expect(fnBody).not.toMatch(/<button|ActionButton/);
    expect(fnBody).not.toContain('onAction');
    expect(fnBody).not.toContain('inter_org_exchange');
  });

  it('critical lane cards do not expose ids/uuid/alert_key/exchange fields, only names', () => {
    const fnStart = screen.indexOf('function CriticalAlertCard');
    const fnBody = screen.slice(fnStart, screen.indexOf('\n}\n', fnStart) + 3);
    expect(fnBody).not.toMatch(UUID_LITERAL_RE);
    expect(fnBody).not.toMatch(/>\{a\.targetOrganizationId\}</);
    expect(fnBody).not.toContain('alert_key');
    expect(fnBody).not.toContain('supply_type');
    expect(fnBody).not.toContain('exchange_request_id');
  });

  it('has a visible-alerts count label derived from the already-filtered/sorted list', () => {
    expect(screen).toContain('lia_visible_alerts_label');
    expect(screen).toMatch(/\{sortedFiltered\.length\} \{t\('lia_visible_alerts_label', lang\)\}/);
  });

  it('no forbidden wording near the sort/critical-lane additions', () => {
    const liaLines = strings.split('\n').filter(l => /^\s*lia_(sort_|critical_lane_|visible_alerts_)/.test(l));
    const joined = liaLines.join('\n');
    expect(joined.toLowerCase()).not.toMatch(/opportunit/); // UNIFIED-DOMAIN: suggestion/recommendation are sanctioned terms
    expect(joined).not.toContain('فرصة');
    expect(joined).not.toContain('فرصة');
    expect(joined).not.toContain('توصية');
    expect(joined).not.toContain('طلب تبادل');
    expect(joined).not.toContain('إنشاء طلب');
    expect(joined).not.toContain('موافقة');
    expect(joined).not.toContain('رفض');
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

  it('StatusCenter is left unchanged; Dashboard is now wired to the live summary (LIVE-ALERTS-DASHBOARD-SUMMARY-A)', () => {
    expect(dashboardScreen).toContain('getLiveInterInstitutionAlertsWithState');
    expect(dashboardScreen).toContain('inter-org-alert-lifecycle.service');
    expect(statusCenter).not.toContain('getLiveInterInstitutionAlerts');
  });
});
