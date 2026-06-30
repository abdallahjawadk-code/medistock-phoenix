/**
 * STATUS-CENTER-REAL-AVAILABILITY-MATRIX-A
 * Static source tests: verify StatusCenter gained a live availability matrix
 * (reading item_availability) without removing the manual status reports
 * workflow, and without pulling in alert engines / cross-institution matching.
 * Run: npm test -- --run
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../../');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const screen  = read('features/status/StatusCenterScreen.tsx');
const strings = read('shared/i18n/strings.ts');

// ============================================================================
// Live availability matrix data source
// ============================================================================

describe('StatusCenter: live availability matrix', () => {
  it('(1) imports and uses getAvailabilityByOrg', () => {
    expect(screen).toContain("import { getAvailabilityByOrg }");
    expect(screen).toContain('getAvailabilityByOrg(effectiveOrgId)');
  });

  it('(2) manual status reports calls remain present', () => {
    expect(screen).toContain('getStatusReports(');
    expect(screen).toContain('createStatusReport');
    expect(screen).toContain('updateStatusReport');
    expect(screen).toContain('resolveStatusReport');
  });

  it('(3) the live matrix uses effective_status', () => {
    expect(screen).toContain('effective_status');
  });

  it('(3b) raw condition and effective status are both displayed', () => {
    expect(screen).toContain('sc_raw_condition');
    expect(screen).toContain('sc_effective_status');
  });

  it('(4) summary covers all 6 canonical statuses', () => {
    expect(screen).toContain('CANONICAL_STATUSES');
    const block = screen.slice(screen.indexOf('CANONICAL_STATUSES: CanonicalStatus[] = ['), screen.indexOf('];', screen.indexOf('CANONICAL_STATUSES: CanonicalStatus[] = [')));
    for (const s of ['available', 'low_stock', 'missing', 'surplus', 'near_expiry', 'expired']) {
      expect(block).toContain(`'${s}'`);
    }
  });

  it('renders a LiveAvailabilityMatrix component fed by getAvailabilityByOrg data', () => {
    expect(screen).toContain('function LiveAvailabilityMatrix');
    expect(screen).toContain('<LiveAvailabilityMatrix');
    expect(screen).toContain('liveAvailability');
  });

  it('matrix is separate from the manual reports list (its own section header)', () => {
    expect(screen).toContain('sc_manual_reports');
    expect(screen).toContain('sc_live_matrix');
  });
});

// ============================================================================
// i18n
// ============================================================================

describe('StatusCenter live matrix i18n', () => {
  it('(5) empty-state text exists in Arabic and English', () => {
    expect(strings).toContain('sc_live_empty');
    expect(strings).toMatch(/sc_live_empty:\s*\{\s*ar:\s*'لا توجد سجلات توفر حية بعد\.'/);
    expect(strings).toMatch(/sc_live_empty:[^}]*en:\s*'No live availability records yet\.'/);
  });

  it('matrix label keys exist bilingually', () => {
    for (const key of ['sc_live_matrix', 'sc_manual_reports', 'sc_raw_condition', 'sc_effective_status', 'sc_expiry_bucket']) {
      expect(strings).toMatch(new RegExp(`${key}:\\s*\\{\\s*ar:\\s*'[^']+',\\s*en:\\s*'[^']+'`));
    }
  });
});

// ============================================================================
// Workflow preservation + isolation guards
// ============================================================================

describe('StatusCenter: workflow preserved & phase isolation', () => {
  it('(6) manual status report workflow (Add/Edit/Resolve form) is not removed', () => {
    expect(screen).toContain('function ReportForm');
    expect(screen).toContain("t('sc_add', lang)");
    expect(screen).toContain('onResolve');
  });

  it('(7) no alert engine import/use is introduced', () => {
    expect(screen).not.toMatch(/materialAlertEngine/);
    expect(screen).not.toMatch(/computeMaterialAlerts/);
    expect(screen).not.toMatch(/generateExchangeAlerts/);
  });

  it('(8) no inter-institution matching import/use is introduced', () => {
    expect(screen).not.toMatch(/inter-institution-alerts/);
    expect(screen).not.toMatch(/buildScopedAlertsFromReports/);
    expect(screen).not.toMatch(/scopeAlertsForActor/);
  });

  it('(9) no Supabase writes are added for the live matrix', () => {
    const start = screen.indexOf('function LiveAvailabilityMatrix');
    const end = screen.indexOf('function ReportForm');
    const matrix = screen.slice(start, end);
    expect(matrix).not.toMatch(/\.(insert|update|upsert|delete|rpc)\s*\(/);
  });

  it('(10) no fake/mock availability rows are introduced', () => {
    expect(screen).not.toMatch(/mock/i);
    expect(screen).not.toMatch(/fakeRows|sampleRows|dummyData|placeholderRows/);
    // The matrix renders only rows passed in from the service data.
    expect(screen).toContain('rows={(liveAvailability.data ?? [])');
  });

  it('reads only the active org (no cross-institution data)', () => {
    expect(screen).toContain('effectiveOrgId ? getAvailabilityByOrg(effectiveOrgId) : Promise.resolve([])');
  });

  it('does not expose contact/phone data in the matrix', () => {
    const start = screen.indexOf('function LiveAvailabilityMatrix');
    const end = screen.indexOf('function ReportForm');
    const matrix = screen.slice(start, end);
    expect(matrix).not.toMatch(/phone|contact/i);
  });
});
