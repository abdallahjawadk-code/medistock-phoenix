/**
 * AVAILABILITY-ALERTS-QR-POLISH-B
 * Run: npm test -- --run
 *
 * Tests for:
 *  - computeInternalAlerts (src/features/status/internalAlerts.ts) — pure
 *    client-side same-institution surplus/near-expiry -> missing/low-stock
 *    matching, computed entirely from already-loaded live availability rows
 *    (no I/O, no new RPC/SQL).
 *  - InternalAlertsSection / OutletMaterialGroups — safe rendering: no
 *    distribution-point id, no supply_type, no forbidden wording.
 *  - StatusCenterScreen wiring: internal alerts + outlet view added
 *    additively, without breaking the existing table/filters/export.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { computeInternalAlerts, type InternalAlertRow } from '@/features/status/internalAlerts';

const SRC = join(__dirname, '../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

function row(overrides: Partial<InternalAlertRow>): InternalAlertRow {
  return {
    distribution_points: { id: 'p1', name: 'Point 1', name_ar: 'منفذ 1' },
    scientific_name: 'Paracetamol',
    trade_name: 'Panadol',
    concentration: '500mg',
    dosage_form: 'Tablet',
    quantity: 10,
    effective_status: 'available',
    condition: 'available',
    ...overrides,
  };
}

describe('computeInternalAlerts: matches surplus/near-expiry against missing/low-stock at a DIFFERENT outlet in the same org', () => {
  it('matches surplus at point A with missing at point B (same material)', () => {
    const rows: InternalAlertRow[] = [
      row({ distribution_points: { id: 'a', name: 'A', name_ar: 'أ' }, effective_status: 'surplus', quantity: 50 }),
      row({ distribution_points: { id: 'b', name: 'B', name_ar: 'ب' }, effective_status: 'missing', quantity: 0 }),
    ];
    const matches = computeInternalAlerts(rows);
    expect(matches).toHaveLength(1);
    expect(matches[0].sourcePointId).toBe('a');
    expect(matches[0].targetPointId).toBe('b');
    expect(matches[0].sourceStatus).toBe('surplus');
    expect(matches[0].targetStatus).toBe('missing');
    expect(matches[0].severity).toBe('high');
  });

  it('matches near_expiry at point A with low_stock at point B, severity medium', () => {
    const rows: InternalAlertRow[] = [
      row({ distribution_points: { id: 'a', name: 'A', name_ar: 'أ' }, effective_status: 'near_expiry', quantity: 20 }),
      row({ distribution_points: { id: 'b', name: 'B', name_ar: 'ب' }, effective_status: 'low_stock', quantity: 2 }),
    ];
    const matches = computeInternalAlerts(rows);
    expect(matches).toHaveLength(1);
    expect(matches[0].sourceStatus).toBe('near_expiry');
    expect(matches[0].targetStatus).toBe('low_stock');
    expect(matches[0].severity).toBe('medium');
  });

  it('does NOT match rows at the exact same distribution point', () => {
    const rows: InternalAlertRow[] = [
      row({ distribution_points: { id: 'a', name: 'A', name_ar: 'أ' }, effective_status: 'surplus' }),
      row({ distribution_points: { id: 'a', name: 'A', name_ar: 'أ' }, effective_status: 'missing' }),
    ];
    expect(computeInternalAlerts(rows)).toHaveLength(0);
  });

  it('does NOT match different materials', () => {
    const rows: InternalAlertRow[] = [
      row({ distribution_points: { id: 'a', name: 'A', name_ar: 'أ' }, effective_status: 'surplus', scientific_name: 'Amoxicillin' }),
      row({ distribution_points: { id: 'b', name: 'B', name_ar: 'ب' }, effective_status: 'missing', scientific_name: 'Paracetamol' }),
    ];
    expect(computeInternalAlerts(rows)).toHaveLength(0);
  });

  it('does NOT match different concentration/dosage form (exact match required, mirrors materialAlertEngine)', () => {
    const rows: InternalAlertRow[] = [
      row({ distribution_points: { id: 'a', name: 'A', name_ar: 'أ' }, effective_status: 'surplus', concentration: '500mg' }),
      row({ distribution_points: { id: 'b', name: 'B', name_ar: 'ب' }, effective_status: 'missing', concentration: '250mg' }),
    ];
    expect(computeInternalAlerts(rows)).toHaveLength(0);
  });

  it('does not match trade_name — only scientific_name/concentration/dosage_form are identity fields', () => {
    const rows: InternalAlertRow[] = [
      row({ distribution_points: { id: 'a', name: 'A', name_ar: 'أ' }, effective_status: 'surplus', trade_name: 'BrandX' }),
      row({ distribution_points: { id: 'b', name: 'B', name_ar: 'ب' }, effective_status: 'missing', trade_name: 'BrandY' }),
    ];
    // Same scientific_name/concentration/dosage_form (from the row() default) → still matches
    // regardless of differing trade_name, proving trade_name is not part of the match key.
    expect(computeInternalAlerts(rows)).toHaveLength(1);
  });

  it('is case/whitespace-insensitive when matching (normalized comparison)', () => {
    const rows: InternalAlertRow[] = [
      row({ distribution_points: { id: 'a', name: 'A', name_ar: 'أ' }, effective_status: 'surplus', scientific_name: '  Paracetamol  ' }),
      row({ distribution_points: { id: 'b', name: 'B', name_ar: 'ب' }, effective_status: 'missing', scientific_name: 'PARACETAMOL' }),
    ];
    expect(computeInternalAlerts(rows)).toHaveLength(1);
  });

  it('returns an empty array (not fake/mock data) when there is no real match', () => {
    const rows: InternalAlertRow[] = [
      row({ distribution_points: { id: 'a', name: 'A', name_ar: 'أ' }, effective_status: 'available' }),
    ];
    expect(computeInternalAlerts(rows)).toEqual([]);
  });

  it('sorts high severity before medium severity', () => {
    const rows: InternalAlertRow[] = [
      row({ distribution_points: { id: 'a', name: 'A', name_ar: 'أ' }, effective_status: 'near_expiry', scientific_name: 'Zinc' }),
      row({ distribution_points: { id: 'b', name: 'B', name_ar: 'ب' }, effective_status: 'low_stock', scientific_name: 'Zinc' }),
      row({ distribution_points: { id: 'c', name: 'C', name_ar: 'ج' }, effective_status: 'surplus', scientific_name: 'Amoxicillin' }),
      row({ distribution_points: { id: 'd', name: 'D', name_ar: 'د' }, effective_status: 'missing', scientific_name: 'Amoxicillin' }),
    ];
    const matches = computeInternalAlerts(rows);
    expect(matches).toHaveLength(2);
    expect(matches[0].severity).toBe('high');
    expect(matches[1].severity).toBe('medium');
  });

  it('does not consider expired or available rows as supply/demand candidates', () => {
    const rows: InternalAlertRow[] = [
      row({ distribution_points: { id: 'a', name: 'A', name_ar: 'أ' }, effective_status: 'expired' }),
      row({ distribution_points: { id: 'b', name: 'B', name_ar: 'ب' }, effective_status: 'missing' }),
    ];
    expect(computeInternalAlerts(rows)).toHaveLength(0);
  });
});

describe('InternalAlertsSection: no technical id/wording exposure', () => {
  const src = readSrc('features/status/InternalAlertsSection.tsx');

  it('does not render distribution point ids', () => {
    expect(src).not.toMatch(/\{m\.sourcePointId\}/);
    expect(src).not.toMatch(/\{m\.targetPointId\}/);
  });

  it('does not reference supply_type, alert_key, or exchange fields', () => {
    expect(src).not.toContain('supply_type');
    expect(src).not.toContain('alert_key');
    expect(src).not.toContain('inter_org_exchange');
  });

  it('has no action button (reporting-only, no exchange-request CTA)', () => {
    expect(src).not.toMatch(/<button/);
    expect(src).not.toContain('createInterOrgExchangeRequest');
  });

  it('has no forbidden wording', () => {
    expect(src.toLowerCase()).not.toMatch(/suggestion|suggested|recommendation|recommended|opportunit/);
    expect(src).not.toContain('اقتراح');
    expect(src).not.toContain('فرصة');
  });

  it('uses the preferred Arabic term for internal alerts', () => {
    expect(src).toContain("t('sc_internal_alerts_title'");
  });
});

describe('OutletMaterialGroups: no technical id exposure, groups by distribution point', () => {
  const src = readSrc('features/status/OutletMaterialGroups.tsx');

  it('does not render distribution_points.id anywhere', () => {
    expect(src).not.toMatch(/\{dp\?\.id\}/);
    expect(src).not.toMatch(/>\{key\}</);
  });

  it('does not reference supply_type, alert_key, or exchange fields', () => {
    expect(src).not.toContain('supply_type');
    expect(src).not.toContain('alert_key');
    expect(src).not.toContain('inter_org_exchange');
  });

  it('groups rows by distribution_points.id', () => {
    expect(src).toContain('dp?.id');
    expect(src).toContain('byPoint');
  });

  it('uses the preferred Arabic term for outlet grouping', () => {
    expect(src).toContain('sc_outlet_empty');
  });
});

describe('StatusCenterScreen: new sections wired in additively', () => {
  const screen = readSrc('features/status/StatusCenterScreen.tsx');

  it('imports and renders InternalAlertsSection', () => {
    expect(screen).toContain("import { InternalAlertsSection } from './InternalAlertsSection'");
    expect(screen).toContain('<InternalAlertsSection matches={internalAlerts} />');
  });

  it('imports and renders OutletMaterialGroups behind a view-mode toggle', () => {
    expect(screen).toContain("import { OutletMaterialGroups } from './OutletMaterialGroups'");
    expect(screen).toContain("viewMode === 'outlet'");
    expect(screen).toContain('<OutletMaterialGroups rows={rows} />');
  });

  it('the existing table view still renders by default and export/print are unaffected', () => {
    expect(screen).toContain("useState<'table' | 'outlet'>('table')");
    expect(screen).toContain('function exportCsv()');
    expect(screen).toContain('function printReport()');
  });

  it('internal alerts are computed from the full unfiltered live rows (allRows), not the filtered table rows', () => {
    expect(screen).toContain('computeInternalAlerts(allRows)');
  });

  it('does not reference the exchange RPCs/service from these new sections', () => {
    expect(screen).not.toContain('createInterOrgExchangeRequest');
    expect(screen).not.toContain('inter-org-exchange.service');
  });
});
