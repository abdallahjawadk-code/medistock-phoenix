import { describe, expect, it } from 'vitest';
import {
  REPORT_TAB_ACCESS,
  allowedReportTabs,
  resolveAllowedReportTab,
  type ReportTab,
} from '../report-tab-access';

describe('Phase C3 report-tab UNION authorization contract', () => {
  it('records the exact pre-C3 gate for every tab instead of inferred groups', () => {
    expect(REPORT_TAB_ACCESS).toEqual({
      overview: { kind: 'authenticated_rls' },
      institutions: { kind: 'authenticated_rls' },
      materials: { kind: 'authenticated_rls' },
      movements: { kind: 'permission', permission: 'status_center.view' },
      custody: { kind: 'authenticated_rls' },
      supplementary: { kind: 'authenticated_rls' },
      corrections: { kind: 'authenticated_rls' },
      audit: { kind: 'permission', permission: 'audit.view' },
      monthly: { kind: 'authenticated_rls' },
      library: { kind: 'authenticated_rls' },
      global: { kind: 'role', role: 'super_admin' },
    });
  });

  it('keeps every previously ungated RLS-authoritative tab available to an authenticated user', () => {
    expect(allowedReportTabs(new Set(), 'viewer')).toEqual([
      'overview', 'institutions', 'materials', 'custody', 'supplementary',
      'corrections', 'monthly', 'library',
    ]);
  });

  it('does not let reports.view invent gates for custody or corrections', () => {
    expect(allowedReportTabs(new Set(['reports.view']), 'viewer'))
      .toEqual(allowedReportTabs(new Set(), 'viewer'));
    expect(REPORT_TAB_ACCESS.custody.kind).toBe('authenticated_rls');
    expect(REPORT_TAB_ACCESS.corrections.kind).toBe('authenticated_rls');
  });

  it('uses status_center.view only for Movements, not Materials or Monthly', () => {
    const withoutPermission = allowedReportTabs(new Set(), 'warehouse_officer');
    const withPermission = allowedReportTabs(new Set(['status_center.view']), 'warehouse_officer');
    expect(withPermission.filter(tab => !withoutPermission.includes(tab))).toEqual(['movements']);
    expect(REPORT_TAB_ACCESS.monthly.kind).toBe('authenticated_rls');
  });

  it.each(['warehouse_officer', 'institution_admin', 'central_warehouse_manager'])(
    'does not hide Monthly from the existing %s workflow role for lack of a new permission',
    role => expect(allowedReportTabs(new Set(), role)).toContain('monthly'),
  );

  it('keeps audit.view as an independent additive tab gate', () => {
    const allowed = allowedReportTabs(new Set(['audit.view']), 'viewer');
    expect(allowed).toContain('audit');
    expect(REPORT_TAB_ACCESS.audit).toEqual({ kind: 'permission', permission: 'audit.view' });
  });

  it('keeps Global Search super_admin-only even when another role has every tab permission', () => {
    const permissions = new Set(['reports.view', 'status_center.view', 'audit.view']);
    expect(allowedReportTabs(permissions, 'institution_admin')).not.toContain('global');
    expect(allowedReportTabs(permissions, 'super_admin')).toContain('global');
  });

  it('uses UNION rather than requiring an intersection of permissions', () => {
    const allowed = allowedReportTabs(new Set(), 'viewer');
    expect(allowed.length).toBeGreaterThan(0);
  });

  it('falls back to the first allowed tab when a requested tab is forbidden', () => {
    const allowed: ReportTab[] = ['materials', 'movements', 'monthly'];
    expect(resolveAllowedReportTab('overview', allowed)).toBe('materials');
    expect(resolveAllowedReportTab('monthly', allowed)).toBe('monthly');
  });

  it('returns null when no tab is allowed', () => {
    expect(resolveAllowedReportTab('overview', [])).toBeNull();
  });

  it('returns no tabs when there is no authenticated profile role', () => {
    expect(allowedReportTabs(new Set(['reports.view', 'status_center.view', 'audit.view']), null)).toEqual([]);
  });
});
