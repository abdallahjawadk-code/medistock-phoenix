import { describe, expect, it } from 'vitest';
import {
  allowedReportTabs,
  resolveAllowedReportTab,
  type ReportTab,
} from '../report-tab-access';

describe('Phase C3 report-tab UNION authorization contract', () => {
  it('grants the shell when reports.view permits at least one reporting tab', () => {
    expect(allowedReportTabs(new Set(['reports.view']), 'outlet_officer')).toEqual([
      'overview', 'institutions', 'custody', 'supplementary', 'corrections', 'library',
    ]);
  });

  it('keeps status-center tabs independent from reports.view', () => {
    expect(allowedReportTabs(new Set(['status_center.view']), 'warehouse_officer')).toEqual([
      'materials', 'movements', 'monthly',
    ]);
  });

  it('keeps audit access independent from reports and status permissions', () => {
    expect(allowedReportTabs(new Set(['audit.view']), 'viewer')).toEqual(['audit']);
  });

  it('keeps Global Search super_admin-only even when another role has every tab permission', () => {
    const permissions = new Set(['reports.view', 'status_center.view', 'audit.view']);
    expect(allowedReportTabs(permissions, 'institution_admin')).not.toContain('global');
    expect(allowedReportTabs(permissions, 'super_admin')).toContain('global');
  });

  it('uses UNION rather than requiring an intersection of permissions', () => {
    const allowed = allowedReportTabs(new Set(['audit.view']), 'viewer');
    expect(allowed.length).toBeGreaterThan(0);
    expect(allowed).toEqual(['audit']);
  });

  it('falls back to the first allowed tab when a requested tab is forbidden', () => {
    const allowed: ReportTab[] = ['materials', 'movements', 'monthly'];
    expect(resolveAllowedReportTab('overview', allowed)).toBe('materials');
    expect(resolveAllowedReportTab('monthly', allowed)).toBe('monthly');
  });

  it('returns null when no tab is allowed', () => {
    expect(resolveAllowedReportTab('overview', [])).toBeNull();
  });
});
