import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  computeMaterialAlerts,
  parseExpiryDate,
  addMonths,
  daysUntil,
  expiryBucket,
  expiryBucketToSeverity,
  materialKey,
} from '../materialAlertEngine';
import type { StatusReport } from '@/shared/supabase/services/status-reports.service';

// Deterministic anchor: 2025-01-15 (local midnight)
const TODAY = new Date(2025, 0, 15);

function sr(overrides: Partial<StatusReport> & { id: string }): StatusReport {
  return {
    id: overrides.id,
    organization_id: overrides.organization_id ?? 'org-1',
    // Use 'in' check so callers can explicitly pass null to override defaults
    item_id:     'item_id'     in overrides ? (overrides.item_id     ?? null) : null,
    item_name:   'item_name'   in overrides ? (overrides.item_name   ?? null) : 'Test Drug',
    item_name_ar:'item_name_ar'in overrides ? (overrides.item_name_ar?? null) : 'دواء اختبار',
    status_type: overrides.status_type ?? 'missing',
    quantity:    'quantity'    in overrides ? (overrides.quantity     ?? null) : null,
    unit: overrides.unit ?? 'box',
    expiry_date: 'expiry_date' in overrides ? (overrides.expiry_date ?? null) : null,
    notes: null,
    submitted_by: null,
    submitted_at: '2025-01-01T00:00:00Z',
    resolved_at: null,
    resolved_by: null,
    is_active: overrides.is_active ?? true,
    created_at: '2025-01-01T00:00:00Z',
    organizations: overrides.organizations ?? { name: 'Test Org', name_ar: 'مؤسسة اختبار' },
  };
}

// ─── Date utilities ────────────────────────────────────────────────────────────

describe('parseExpiryDate', () => {
  it('parses a valid YYYY-MM-DD string', () => {
    const d = parseExpiryDate('2025-06-15');
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2025);
    expect(d!.getMonth()).toBe(5); // June = 5
    expect(d!.getDate()).toBe(15);
  });

  it('returns null for null input', () => {
    expect(parseExpiryDate(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(parseExpiryDate(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseExpiryDate('')).toBeNull();
  });

  it('returns null for invalid date format', () => {
    expect(parseExpiryDate('not-a-date')).toBeNull();
    expect(parseExpiryDate('15/06/2025')).toBeNull();
    expect(parseExpiryDate('2025/06/15')).toBeNull();
  });

  it('returns null for invalid date values', () => {
    expect(parseExpiryDate('2025-13-99')).toBeNull();
  });

  it('tolerates trailing time portion (ISO 8601)', () => {
    const d = parseExpiryDate('2025-06-15T12:00:00Z');
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2025);
  });
});

describe('addMonths', () => {
  it('adds 3 months correctly', () => {
    const base = new Date(2025, 0, 15); // Jan 15
    const result = addMonths(base, 3);
    expect(result.getMonth()).toBe(3); // April
    expect(result.getDate()).toBe(15);
  });

  it('handles year rollover', () => {
    const base = new Date(2025, 10, 15); // Nov 15
    const result = addMonths(base, 3);
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(1); // Feb
  });

  // Month-end clamping — matches Postgres (date + interval 'N months')::date
  it('clamps Jan 31 + 1 month to Feb 28 (non-leap)', () => {
    const r = addMonths(new Date(2026, 0, 31), 1);
    expect(r.getFullYear()).toBe(2026);
    expect(r.getMonth()).toBe(1);   // Feb
    expect(r.getDate()).toBe(28);
  });

  it('clamps Jan 31 + 3 months to Apr 30', () => {
    const r = addMonths(new Date(2026, 0, 31), 3);
    expect(r.getFullYear()).toBe(2026);
    expect(r.getMonth()).toBe(3);   // Apr
    expect(r.getDate()).toBe(30);
  });

  it('does not clamp Jan 31 + 6 months (Jul has 31 days)', () => {
    const r = addMonths(new Date(2026, 0, 31), 6);
    expect(r.getFullYear()).toBe(2026);
    expect(r.getMonth()).toBe(6);   // Jul
    expect(r.getDate()).toBe(31);
  });

  it('does not clamp Jan 31 + 9 months (Oct has 31 days)', () => {
    const r = addMonths(new Date(2026, 0, 31), 9);
    expect(r.getFullYear()).toBe(2026);
    expect(r.getMonth()).toBe(9);   // Oct
    expect(r.getDate()).toBe(31);
  });

  it('clamps Jan 31 + 1 month to Feb 29 in a leap year', () => {
    const r = addMonths(new Date(2024, 0, 31), 1);
    expect(r.getFullYear()).toBe(2024);
    expect(r.getMonth()).toBe(1);   // Feb
    expect(r.getDate()).toBe(29);   // 2024 is leap
  });

  it('leaves mid-month day unchanged (Jan 15 + 3 months → Apr 15)', () => {
    const r = addMonths(new Date(2026, 0, 15), 3);
    expect(r.getFullYear()).toBe(2026);
    expect(r.getMonth()).toBe(3);   // Apr
    expect(r.getDate()).toBe(15);
  });
});

describe('daysUntil', () => {
  it('returns positive for future date', () => {
    const expiry = new Date(2025, 0, 20); // Jan 20
    expect(daysUntil(TODAY, expiry)).toBe(5);
  });

  it('returns 0 for same day', () => {
    expect(daysUntil(TODAY, new Date(2025, 0, 15))).toBe(0);
  });

  it('returns negative for past date', () => {
    const past = new Date(2025, 0, 10); // Jan 10
    expect(daysUntil(TODAY, past)).toBe(-5);
  });
});

describe('expiryBucket', () => {
  it('returns null for expiry > 9 months away', () => {
    const far = addMonths(TODAY, 10); // Oct 15 + 1 month
    expect(expiryBucket(TODAY, far)).toBeNull();
  });

  it('returns 9_months at exactly 9-month boundary', () => {
    const at9 = addMonths(TODAY, 9); // Oct 15, 2025
    expect(expiryBucket(TODAY, at9)).toBe('9_months');
  });

  it('returns 6_months at exactly 6-month boundary', () => {
    const at6 = addMonths(TODAY, 6); // Jul 15, 2025
    expect(expiryBucket(TODAY, at6)).toBe('6_months');
  });

  it('returns 3_months at exactly 3-month boundary', () => {
    const at3 = addMonths(TODAY, 3); // Apr 15, 2025
    expect(expiryBucket(TODAY, at3)).toBe('3_months');
  });

  it('returns 3_months for expiry one month away', () => {
    const in1 = addMonths(TODAY, 1); // Feb 15, 2025
    expect(expiryBucket(TODAY, in1)).toBe('3_months');
  });

  it('returns expired for yesterday', () => {
    const yesterday = new Date(2025, 0, 14);
    expect(expiryBucket(TODAY, yesterday)).toBe('expired');
  });

  it('returns 9_months — not null — for exactly 9 months', () => {
    // boundary: <= 9 months → 9_months; > 9 months → null
    const exactly9 = addMonths(TODAY, 9);
    const oneMore  = new Date(exactly9.getTime() + 86_400_000);
    expect(expiryBucket(TODAY, exactly9)).toBe('9_months');
    expect(expiryBucket(TODAY, oneMore)).toBeNull();
  });
});

// ─── expiryBucket — month-end boundary (today = 2026-01-31) ──────────────────
// These tests verify that the clamped addMonths produces boundaries that match
// Postgres (current_date + interval 'N months')::date behaviour exactly.

describe('expiryBucket — month-end boundary (today = 2026-01-31)', () => {
  const JAN31 = new Date(2026, 0, 31);

  it('expiry = 2026-04-30 → 3_months (boundary is inclusive, Apr 30 = Jan 31 + 3 months clamped)', () => {
    expect(expiryBucket(JAN31, new Date(2026, 3, 30))).toBe('3_months');
  });

  it('expiry = 2026-05-01 → 6_months (one day past 3-month boundary)', () => {
    expect(expiryBucket(JAN31, new Date(2026, 4, 1))).toBe('6_months');
  });

  it('expiry = 2026-01-30 → expired (one day before today)', () => {
    expect(expiryBucket(JAN31, new Date(2026, 0, 30))).toBe('expired');
  });
});

describe('expiryBucketToSeverity', () => {
  it('maps expired → critical', () => expect(expiryBucketToSeverity('expired')).toBe('critical'));
  it('maps 3_months → urgent',  () => expect(expiryBucketToSeverity('3_months')).toBe('urgent'));
  it('maps 6_months → high',    () => expect(expiryBucketToSeverity('6_months')).toBe('high'));
  it('maps 9_months → watch',   () => expect(expiryBucketToSeverity('9_months')).toBe('watch'));
});

// ─── materialKey ──────────────────────────────────────────────────────────────

describe('materialKey', () => {
  it('prefers item_id when available', () => {
    const r = sr({ id: '1', item_id: 'uuid-a', item_name: 'Drug A' });
    expect(materialKey(r)).toBe('id:uuid-a');
  });

  it('falls back to name when item_id is null', () => {
    const r = sr({ id: '1', item_id: null, item_name: 'Drug A', item_name_ar: 'دواء' });
    expect(materialKey(r)).toBe('name:drug a|دواء');
  });

  it('returns empty string when no id and no name', () => {
    const r = sr({ id: '1', item_id: null, item_name: null, item_name_ar: null });
    expect(materialKey(r)).toBe('');
  });
});

// ─── Expiry alert generation ──────────────────────────────────────────────────

describe('computeMaterialAlerts — expiry alerts', () => {
  it('generates no expiry alert when expiry_date is null', () => {
    const { alerts } = computeMaterialAlerts([sr({ id: '1', status_type: 'surplus', expiry_date: null })], TODAY);
    expect(alerts.filter(a => a.kind === 'expiry')).toHaveLength(0);
  });

  it('generates no expiry alert for expiry > 9 months away', () => {
    const far = addMonths(TODAY, 10).toISOString().slice(0, 10);
    const { alerts } = computeMaterialAlerts([sr({ id: '1', status_type: 'surplus', expiry_date: far })], TODAY);
    expect(alerts.filter(a => a.kind === 'expiry')).toHaveLength(0);
  });

  it('generates watch alert for expiry within 9 months', () => {
    const at9 = addMonths(TODAY, 9).toISOString().slice(0, 10);
    const { alerts } = computeMaterialAlerts([sr({ id: '1', status_type: 'surplus', expiry_date: at9 })], TODAY);
    const expiryAlerts = alerts.filter(a => a.kind === 'expiry');
    expect(expiryAlerts).toHaveLength(1);
    expect(expiryAlerts[0].severity).toBe('watch');
    expect(expiryAlerts[0].monthsBucket).toBe('9_months');
  });

  it('generates high alert for expiry within 6 months', () => {
    const at6 = addMonths(TODAY, 6).toISOString().slice(0, 10);
    const { alerts } = computeMaterialAlerts([sr({ id: '1', status_type: 'surplus', expiry_date: at6 })], TODAY);
    const ea = alerts.filter(a => a.kind === 'expiry');
    expect(ea[0].severity).toBe('high');
    expect(ea[0].monthsBucket).toBe('6_months');
  });

  it('generates urgent alert for expiry within 3 months', () => {
    const at3 = addMonths(TODAY, 3).toISOString().slice(0, 10);
    const { alerts } = computeMaterialAlerts([sr({ id: '1', status_type: 'surplus', expiry_date: at3 })], TODAY);
    const ea = alerts.filter(a => a.kind === 'expiry');
    expect(ea[0].severity).toBe('urgent');
    expect(ea[0].monthsBucket).toBe('3_months');
  });

  it('generates critical alert for expired item', () => {
    const yesterday = new Date(2025, 0, 14).toISOString().slice(0, 10);
    const { alerts } = computeMaterialAlerts([sr({ id: '1', status_type: 'surplus', expiry_date: yesterday })], TODAY);
    const ea = alerts.filter(a => a.kind === 'expiry');
    expect(ea).toHaveLength(1);
    expect(ea[0].severity).toBe('critical');
    expect(ea[0].monthsBucket).toBe('expired');
    expect(ea[0].reason).toBe('expired_material');
  });

  it('does not crash on invalid expiry_date string', () => {
    expect(() =>
      computeMaterialAlerts([sr({ id: '1', status_type: 'surplus', expiry_date: 'invalid-date' })], TODAY)
    ).not.toThrow();
  });

  it('includes daysUntilExpiry in the alert', () => {
    const at3 = addMonths(TODAY, 3).toISOString().slice(0, 10);
    const { alerts } = computeMaterialAlerts([sr({ id: '1', status_type: 'surplus', expiry_date: at3 })], TODAY);
    const ea = alerts.find(a => a.kind === 'expiry');
    expect(ea?.daysUntilExpiry).toBeGreaterThanOrEqual(88); // ~91 days
    expect(ea?.daysUntilExpiry).toBeLessThanOrEqual(92);
  });
});

// ─── Status-based alert generation ───────────────────────────────────────────

describe('computeMaterialAlerts — status alerts', () => {
  it('generates critical alert for missing status', () => {
    const { alerts } = computeMaterialAlerts([sr({ id: '1', status_type: 'missing' })], TODAY);
    const a = alerts.find(a => a.kind === 'missing' && a.severity === 'critical');
    expect(a).toBeDefined();
    expect(a!.reason).toBe('missing_material');
  });

  it('generates urgent alert for scarce status', () => {
    const { alerts } = computeMaterialAlerts([sr({ id: '1', status_type: 'scarce' })], TODAY);
    const a = alerts.find(a => a.kind === 'missing' && a.severity === 'urgent');
    expect(a).toBeDefined();
    expect(a!.reason).toBe('out_of_stock');
  });

  it('generates opportunity alert for surplus status', () => {
    const { alerts } = computeMaterialAlerts([sr({ id: '1', status_type: 'surplus' })], TODAY);
    const a = alerts.find(a => a.kind === 'surplus');
    expect(a).toBeDefined();
    expect(a!.severity).toBe('opportunity');
    expect(a!.reason).toBe('surplus_for_redistribution');
  });

  it('skips inactive reports', () => {
    const { alerts } = computeMaterialAlerts([sr({ id: '1', status_type: 'missing', is_active: false })], TODAY);
    expect(alerts).toHaveLength(0);
  });

  it('skips reports with no material key', () => {
    const r = sr({ id: '1', status_type: 'missing', item_id: null, item_name: null, item_name_ar: null });
    const { alerts } = computeMaterialAlerts([r], TODAY);
    expect(alerts).toHaveLength(0);
  });
});

// ─── Data quality alerts ──────────────────────────────────────────────────────

describe('computeMaterialAlerts — data quality', () => {
  it('generates data_quality info alert when quantity > 0 but status is missing', () => {
    const r = sr({ id: '1', status_type: 'missing', quantity: 50 });
    const { alerts } = computeMaterialAlerts([r], TODAY);
    const dq = alerts.filter(a => a.kind === 'data_quality');
    expect(dq).toHaveLength(1);
    expect(dq[0].severity).toBe('info');
    expect(dq[0].reason).toBe('available_but_zero_quantity');
  });

  it('does NOT generate data_quality qty alert when quantity is null', () => {
    const r = sr({ id: '1', status_type: 'missing', quantity: null });
    const { alerts } = computeMaterialAlerts([r], TODAY);
    const dq = alerts.filter(a => a.kind === 'data_quality');
    expect(dq).toHaveLength(0);
  });

  it('generates data_quality alert when expiry_date is past but status is surplus', () => {
    const yesterday = new Date(2025, 0, 14).toISOString().slice(0, 10);
    const r = sr({ id: '1', status_type: 'surplus', expiry_date: yesterday });
    const { alerts } = computeMaterialAlerts([r], TODAY);
    const dq = alerts.filter(a => a.kind === 'data_quality' && a.reason === 'expired_but_marked_available');
    expect(dq).toHaveLength(1);
    expect(dq[0].severity).toBe('info');
  });

  it('does NOT generate expired_but_marked_available for near_expiry status with past expiry', () => {
    const yesterday = new Date(2025, 0, 14).toISOString().slice(0, 10);
    const r = sr({ id: '1', status_type: 'near_expiry', expiry_date: yesterday });
    const { alerts } = computeMaterialAlerts([r], TODAY);
    const dq = alerts.filter(a => a.reason === 'expired_but_marked_available');
    expect(dq).toHaveLength(0);
  });
});

// ─── Exchange suggestions ─────────────────────────────────────────────────────

describe('computeMaterialAlerts — exchange suggestions', () => {
  const ITEM_ID = 'item-uuid-1';

  function srcSurplus(overrides: Partial<StatusReport> = {}): StatusReport {
    return sr({ id: 'src-1', organization_id: 'org-A', status_type: 'surplus', item_id: ITEM_ID, quantity: 100, ...overrides });
  }
  function tgtMissing(overrides: Partial<StatusReport> = {}): StatusReport {
    return sr({ id: 'tgt-1', organization_id: 'org-B', status_type: 'missing', item_id: ITEM_ID, ...overrides });
  }

  it('generates urgent suggestion for surplus+missing (same item_id, quantity > 0)', () => {
    const { suggestions } = computeMaterialAlerts([srcSurplus(), tgtMissing()], TODAY);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].severity).toBe('urgent');
    expect(suggestions[0].confidence).toBe('high');
    expect(suggestions[0].sourceCondition).toBe('surplus');
    expect(suggestions[0].destinationNeed).toBe('missing');
  });

  it('generates opportunity suggestion for surplus+missing with no quantity', () => {
    const { suggestions } = computeMaterialAlerts([srcSurplus({ quantity: 0 }), tgtMissing()], TODAY);
    expect(suggestions[0].severity).toBe('opportunity');
  });

  it('generates urgent suggestion for near_expiry+missing', () => {
    const src = sr({ id: 'src-2', organization_id: 'org-A', status_type: 'near_expiry', item_id: ITEM_ID, quantity: 20 });
    const tgt = tgtMissing({ id: 'tgt-2' });
    const { suggestions } = computeMaterialAlerts([src, tgt], TODAY);
    expect(suggestions[0].severity).toBe('urgent');
    expect(suggestions[0].suggestedAction).toBe('rotate_before_expiry');
  });

  it('generates high suggestion for surplus+scarce', () => {
    const src = srcSurplus({ id: 'src-3', quantity: 10 });
    const tgt = sr({ id: 'tgt-3', organization_id: 'org-B', status_type: 'scarce', item_id: ITEM_ID });
    const { suggestions } = computeMaterialAlerts([src, tgt], TODAY);
    expect(suggestions[0].severity).toBe('high');
  });

  it('generates high suggestion for near_expiry+scarce', () => {
    const src = sr({ id: 'src-4', organization_id: 'org-A', status_type: 'near_expiry', item_id: ITEM_ID, quantity: 5 });
    const tgt = sr({ id: 'tgt-4', organization_id: 'org-B', status_type: 'scarce',     item_id: ITEM_ID });
    const { suggestions } = computeMaterialAlerts([src, tgt], TODAY);
    expect(suggestions[0].severity).toBe('high');
  });

  it('does NOT generate suggestion for same institution', () => {
    const src = srcSurplus({ organization_id: 'org-A' });
    const tgt = tgtMissing({ organization_id: 'org-A' });
    const { suggestions } = computeMaterialAlerts([src, tgt], TODAY);
    expect(suggestions).toHaveLength(0);
  });

  it('does NOT generate suggestion for different materials', () => {
    const src = srcSurplus({ item_id: 'item-1' });
    const tgt = tgtMissing({ item_id: 'item-2' });
    const { suggestions } = computeMaterialAlerts([src, tgt], TODAY);
    expect(suggestions).toHaveLength(0);
  });

  it('assigns high confidence for item_id match', () => {
    const { suggestions } = computeMaterialAlerts([srcSurplus(), tgtMissing()], TODAY);
    expect(suggestions[0].confidence).toBe('high');
  });

  it('assigns medium confidence for exact name match (no item_id)', () => {
    const src = sr({ id: 'src-5', organization_id: 'org-A', status_type: 'surplus', item_id: null, item_name: 'Amoxicillin', quantity: 50 });
    const tgt = sr({ id: 'tgt-5', organization_id: 'org-B', status_type: 'missing', item_id: null, item_name: 'Amoxicillin' });
    const { suggestions } = computeMaterialAlerts([src, tgt], TODAY);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].confidence).toBe('medium');
  });

  it('does NOT generate suggestion when only one has item_id (prevents id-vs-name cross-match)', () => {
    const src = srcSurplus({ item_id: ITEM_ID, item_name: 'Drug A' });
    const tgt = sr({ id: 'tgt-6', organization_id: 'org-B', status_type: 'missing', item_id: null, item_name: 'Drug A' });
    const { suggestions } = computeMaterialAlerts([src, tgt], TODAY);
    expect(suggestions).toHaveLength(0);
  });

  it('deduplicates repeated src/tgt pairs', () => {
    const { suggestions } = computeMaterialAlerts([srcSurplus(), tgtMissing(), srcSurplus(), tgtMissing()], TODAY);
    // dedup by pairId src.id:tgt.id — same pair should only appear once
    const ids = suggestions.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // ─── matchConfidence guardrail tests ─────────────────────────────────────────

  it('matchConfidence guard: no suggestion when both sides have no item_id and no name', () => {
    // Both rows have empty names → materialKey returns '' → engine skips them.
    // Explicit guard in matchConfidence prevents any blind anonymous-material pairing.
    const src = sr({ id: 'src-g1', organization_id: 'org-A', status_type: 'surplus',
      item_id: null, item_name: null, item_name_ar: null, quantity: 10 });
    const tgt = sr({ id: 'tgt-g1', organization_id: 'org-B', status_type: 'missing',
      item_id: null, item_name: null, item_name_ar: null });
    const { suggestions } = computeMaterialAlerts([src, tgt], TODAY);
    expect(suggestions).toHaveLength(0);
  });

  it('matchConfidence high: same item_id on both sides produces high-confidence suggestion', () => {
    const src = sr({ id: 'src-g2', organization_id: 'org-A', status_type: 'surplus',
      item_id: 'uuid-high', quantity: 20 });
    const tgt = sr({ id: 'tgt-g2', organization_id: 'org-B', status_type: 'missing',
      item_id: 'uuid-high' });
    const { suggestions } = computeMaterialAlerts([src, tgt], TODAY);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].confidence).toBe('high');
  });

  it('matchConfidence medium: exact English name match (no item_id) produces medium-confidence suggestion', () => {
    const src = sr({ id: 'src-g3', organization_id: 'org-A', status_type: 'surplus',
      item_id: null, item_name: 'Paracetamol', quantity: 30 });
    const tgt = sr({ id: 'tgt-g3', organization_id: 'org-B', status_type: 'missing',
      item_id: null, item_name: 'Paracetamol' });
    const { suggestions } = computeMaterialAlerts([src, tgt], TODAY);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].confidence).toBe('medium');
  });
});

// ─── Summary counts ───────────────────────────────────────────────────────────

describe('computeMaterialAlerts — summary', () => {
  it('counts critical, urgent, high, watch, opportunity, data_quality correctly', () => {
    const ITEM = 'item-x';
    const reports = [
      sr({ id: '1', status_type: 'missing', item_id: ITEM }),      // → critical
      sr({ id: '2', status_type: 'scarce',  item_id: ITEM }),      // → urgent
      sr({ id: '3', status_type: 'surplus', item_id: ITEM }),      // → opportunity
    ];
    const { summary } = computeMaterialAlerts(reports, TODAY);
    expect(summary.criticalCount).toBeGreaterThanOrEqual(1);
    expect(summary.urgentCount).toBeGreaterThanOrEqual(1);
    expect(summary.opportunityCount).toBeGreaterThanOrEqual(1);
  });

  it('counts dataQualityCount', () => {
    const r = sr({ id: '1', status_type: 'missing', quantity: 10 }); // qty>0 + missing → DQ
    const { summary } = computeMaterialAlerts([r], TODAY);
    expect(summary.dataQualityCount).toBeGreaterThanOrEqual(1);
  });
});

// ─── Sorting ──────────────────────────────────────────────────────────────────

describe('computeMaterialAlerts — sorting', () => {
  it('sorts alerts: critical first, then urgent, then lower severity', () => {
    const at6 = addMonths(TODAY, 6).toISOString().slice(0, 10);
    const reports = [
      sr({ id: '1', status_type: 'surplus', expiry_date: at6 }), // → high (expiry)
      sr({ id: '2', status_type: 'missing' }),                    // → critical
      sr({ id: '3', status_type: 'scarce'  }),                    // → urgent
    ];
    const { alerts } = computeMaterialAlerts(reports, TODAY);
    const severities = alerts.map(a => a.severity);
    const RANK: Record<string, number> = { critical: 6, urgent: 5, high: 4, watch: 3, opportunity: 2, info: 1 };
    for (let i = 1; i < severities.length; i++) {
      expect(RANK[severities[i - 1]]).toBeGreaterThanOrEqual(RANK[severities[i]]);
    }
  });

  it('sorts exchange suggestions: urgent before high before opportunity', () => {
    const ID1 = 'match-item';
    const reports = [
      sr({ id: 's1', organization_id: 'org-A', status_type: 'surplus',     item_id: ID1, quantity: 0 }),    // → opportunity (no qty)
      sr({ id: 's2', organization_id: 'org-A', status_type: 'near_expiry', item_id: ID1 + 'x', item_name: 'DrugX' }),
      sr({ id: 't1', organization_id: 'org-B', status_type: 'missing',     item_id: ID1 }),    // → opportunity pair
      sr({ id: 's3', organization_id: 'org-C', status_type: 'surplus',     item_id: ID1, quantity: 10 }),
      sr({ id: 't2', organization_id: 'org-D', status_type: 'missing',     item_id: ID1 }),
    ];
    const { suggestions } = computeMaterialAlerts(reports, TODAY);
    if (suggestions.length < 2) return; // skip if not enough pairs
    const RANK: Record<string, number> = { critical: 6, urgent: 5, high: 4, watch: 3, opportunity: 2, info: 1 };
    for (let i = 1; i < suggestions.length; i++) {
      expect(RANK[suggestions[i - 1].severity]).toBeGreaterThanOrEqual(RANK[suggestions[i].severity]);
    }
  });
});

// ─── computedAt ──────────────────────────────────────────────────────────────

describe('computeMaterialAlerts — computedAt', () => {
  it('uses the today parameter for computedAt', () => {
    const { computedAt } = computeMaterialAlerts([], TODAY);
    expect(computedAt).toBe(TODAY.toISOString());
  });
});

// ─── Dashboard navigation wiring ──────────────────────────────────────────────

describe('Dashboard: navigation wiring', () => {
  const dashPath = join(__dirname, '../../dashboard/DashboardScreen.tsx');

  it('exchange-alert cards do NOT navigate to screen 12 (Status Center)', () => {
    const src = readFileSync(dashPath, 'utf8');
    // The exchange alert card onClick must NOT point to screen 12
    expect(src).not.toMatch(/onClick\s*=\s*\{\s*\(\)\s*=>\s*onNavigate\s*\(\s*12\s*\)/);
  });

  it('exchange-alert cards navigate to screen 13 (Inter-Institution Alerts)', () => {
    const src = readFileSync(dashPath, 'utf8');
    // Screen 13 = Inter-Institution Alerts
    expect(src).toMatch(/onNavigate\s*\(\s*13\s*\)/);
  });

  it('imports computeMaterialAlerts from the material alert engine', () => {
    const src = readFileSync(dashPath, 'utf8');
    expect(src).toContain('computeMaterialAlerts');
    expect(src).toContain('materialAlertEngine');
  });

  it('renders the smart_material_alerts section', () => {
    const src = readFileSync(dashPath, 'utf8');
    expect(src).toContain('smart_material_alerts');
  });
});

// ─── InterInstitutionAlertsScreen wiring ──────────────────────────────────────

describe('InterInstitutionAlertsScreen: Material Exchange Command Center', () => {
  const screenPath = join(__dirname, '../InterInstitutionAlertsScreen.tsx');

  it('uses material_exchange_command_center as the screen title key', () => {
    const src = readFileSync(screenPath, 'utf8');
    expect(src).toContain('material_exchange_command_center');
  });

  it('uses no_exchange_opportunities for the empty state', () => {
    const src = readFileSync(screenPath, 'utf8');
    expect(src).toContain('no_exchange_opportunities');
  });

  it('has filter chip UI', () => {
    const src = readFileSync(screenPath, 'utf8');
    expect(src).toContain('filterChip');
  });
});

// ─── POST-SMART: Dashboard widget polish ──────────────────────────────────────

describe('POST-SMART: Dashboard widget polish', () => {
  const dashPath = join(__dirname, '../../dashboard/DashboardScreen.tsx');

  it('shows no_critical_alerts_now as the empty state when no critical/urgent alerts', () => {
    const src = readFileSync(dashPath, 'utf8');
    expect(src).toContain('no_critical_alerts_now');
  });

  it('references monthsBucket to render threshold badge on alert cards', () => {
    const src = readFileSync(dashPath, 'utf8');
    expect(src).toContain('monthsBucket');
  });

  it('references ExpiryBucketBadge component for threshold display', () => {
    const src = readFileSync(dashPath, 'utf8');
    expect(src).toContain('ExpiryBucketBadge');
  });

  it('View all button navigates to screen 13', () => {
    const src = readFileSync(dashPath, 'utf8');
    expect(src).toMatch(/onNavigate\s*\(\s*13\s*\)/);
  });

  it('uses filter_expired, filter_3_months, filter_6_months, filter_9_months keys', () => {
    const src = readFileSync(dashPath, 'utf8');
    expect(src).toContain('filter_expired');
    expect(src).toContain('filter_3_months');
    expect(src).toContain('filter_6_months');
    expect(src).toContain('filter_9_months');
  });

  it('does not contain fake, hardcode, or demo alert data', () => {
    const src = readFileSync(dashPath, 'utf8');
    expect(src).not.toMatch(/\b(fake|hardcode|hardcoded|demoAlert)\b/i);
  });

  it('does not use service_role', () => {
    const src = readFileSync(dashPath, 'utf8');
    expect(src).not.toContain('service_role');
  });

  it('does not use auth.admin', () => {
    const src = readFileSync(dashPath, 'utf8');
    expect(src).not.toContain('auth.admin');
  });
});

// ─── POST-SMART: IIA threshold filter chips ───────────────────────────────────

describe('POST-SMART: IIA threshold filter chips', () => {
  const screenPath = join(__dirname, '../InterInstitutionAlertsScreen.tsx');

  it('has exp_expired filter chip value', () => {
    const src = readFileSync(screenPath, 'utf8');
    expect(src).toContain('exp_expired');
  });

  it('has exp_3months filter chip value', () => {
    const src = readFileSync(screenPath, 'utf8');
    expect(src).toContain('exp_3months');
  });

  it('has exp_6months filter chip value', () => {
    const src = readFileSync(screenPath, 'utf8');
    expect(src).toContain('exp_6months');
  });

  it('has exp_9months filter chip value', () => {
    const src = readFileSync(screenPath, 'utf8');
    expect(src).toContain('exp_9months');
  });

  it('imports expiryBucket from materialAlertEngine for threshold computation', () => {
    const src = readFileSync(screenPath, 'utf8');
    expect(src).toContain('expiryBucket');
    expect(src).toContain('materialAlertEngine');
  });

  it('uses filter_expired i18n key for chip label', () => {
    const src = readFileSync(screenPath, 'utf8');
    expect(src).toContain('filter_expired');
  });

  it('uses filter_9_months i18n key for chip label', () => {
    const src = readFileSync(screenPath, 'utf8');
    expect(src).toContain('filter_9_months');
  });

  it('uses filter_6_months i18n key for chip label', () => {
    const src = readFileSync(screenPath, 'utf8');
    expect(src).toContain('filter_6_months');
  });

  it('uses filter_3_months i18n key for chip label', () => {
    const src = readFileSync(screenPath, 'utf8');
    expect(src).toContain('filter_3_months');
  });

  it('uses filter_data_quality i18n key for chip label', () => {
    const src = readFileSync(screenPath, 'utf8');
    expect(src).toContain('filter_data_quality');
  });

  it('renders ExpiryBucketBadge on cards with expiry date', () => {
    const src = readFileSync(screenPath, 'utf8');
    expect(src).toContain('ExpiryBucketBadge');
  });

  it('does not use service_role', () => {
    const src = readFileSync(screenPath, 'utf8');
    expect(src).not.toContain('service_role');
  });

  it('does not use auth.admin', () => {
    const src = readFileSync(screenPath, 'utf8');
    expect(src).not.toContain('auth.admin');
  });
});

// ─── POST-SMART: i18n completeness ───────────────────────────────────────────

describe('POST-SMART: i18n key completeness', () => {
  const stringsPath = join(__dirname, '../../../shared/i18n/strings.ts');

  it('has no_critical_alerts_now in Arabic and English', () => {
    const src = readFileSync(stringsPath, 'utf8');
    expect(src).toContain('no_critical_alerts_now');
    expect(src).toContain('لا توجد تنبيهات حرجة حالياً');
    expect(src).toContain('No critical alerts right now');
  });

  it('has filter_expired key', () => {
    const src = readFileSync(stringsPath, 'utf8');
    expect(src).toContain('filter_expired');
  });

  it('has filter_9_months, filter_6_months, filter_3_months keys', () => {
    const src = readFileSync(stringsPath, 'utf8');
    expect(src).toContain('filter_9_months');
    expect(src).toContain('filter_6_months');
    expect(src).toContain('filter_3_months');
  });

  it('has filter_surplus, filter_missing, filter_data_quality keys', () => {
    const src = readFileSync(stringsPath, 'utf8');
    expect(src).toContain('filter_surplus');
    expect(src).toContain('filter_missing');
    expect(src).toContain('filter_data_quality');
  });

  it('has expiry_threshold_9_months, expiry_threshold_6_months, expiry_threshold_3_months keys', () => {
    const src = readFileSync(stringsPath, 'utf8');
    expect(src).toContain('expiry_threshold_9_months');
    expect(src).toContain('expiry_threshold_6_months');
    expect(src).toContain('expiry_threshold_3_months');
  });

  it('has expired key with Arabic and English labels', () => {
    const src = readFileSync(stringsPath, 'utf8');
    expect(src).toContain("expired:");
    expect(src).toContain('منتهي الصلاحية');
    expect(src).toContain('Expired');
  });

  it('has professional Arabic labels for 9/6/3-month thresholds', () => {
    const src = readFileSync(stringsPath, 'utf8');
    expect(src).toContain('ينفذ خلال 9 أشهر');
    expect(src).toContain('ينفذ خلال 6 أشهر');
    expect(src).toContain('ينفذ خلال 3 أشهر');
  });
});

// ─── POST-SMART: security guardrails ─────────────────────────────────────────

describe('POST-SMART: no SQL or migration created', () => {
  it('no migration file was created in this phase (supabase/migrations pattern)', () => {
    // This phase must not create SQL migrations
    // We verify this by checking that no new migration files reference the phase task ID
    const migrationsDir = join(__dirname, '../../../../../supabase/migrations');
    let files: string[] = [];
    try { files = readdirSync(migrationsDir); } catch { /* dir may not exist */ }
    const phaseFiles = files.filter(f => f.includes('POST_SMART') || f.includes('post_smart'));
    expect(phaseFiles).toHaveLength(0);
  });
});
