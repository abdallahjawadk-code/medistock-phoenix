export type ReportTab =
  | 'overview'
  | 'institutions'
  | 'materials'
  | 'movements'
  | 'custody'
  | 'supplementary'
  | 'corrections'
  | 'audit'
  | 'monthly'
  | 'library'
  | 'global';

export const REPORT_TAB_ORDER: readonly ReportTab[] = [
  'overview',
  'institutions',
  'materials',
  'movements',
  'custody',
  'supplementary',
  'corrections',
  'audit',
  'monthly',
  'library',
  'global',
];

const REPORTS_VIEW_TABS = new Set<ReportTab>([
  'overview',
  'institutions',
  'custody',
  'supplementary',
  'corrections',
  'library',
]);

const STATUS_CENTER_VIEW_TABS = new Set<ReportTab>([
  'materials',
  'movements',
  'monthly',
]);

/**
 * Phase C3 UNION contract. A tab is visible when its own existing frontend
 * permission (or role, for Global Search) allows it. Nothing here grants a
 * backend capability: every service/RPC/RLS check remains authoritative.
 */
export function allowedReportTabs(permissions: ReadonlySet<string>, role: string | null): ReportTab[] {
  return REPORT_TAB_ORDER.filter(tab => {
    if (REPORTS_VIEW_TABS.has(tab)) return permissions.has('reports.view');
    if (STATUS_CENTER_VIEW_TABS.has(tab)) return permissions.has('status_center.view');
    if (tab === 'audit') return permissions.has('audit.view');
    return tab === 'global' && role === 'super_admin';
  });
}

/** Keep the requested tab when allowed; otherwise land on the first allowed tab. */
export function resolveAllowedReportTab(
  requested: ReportTab,
  allowed: readonly ReportTab[],
): ReportTab | null {
  if (allowed.includes(requested)) return requested;
  return allowed[0] ?? null;
}
