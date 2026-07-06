/**
 * PHASE2-DASHBOARD-SERVICE-RPC-SWITCH-A
 * Run: npm test -- --run dashboard
 *
 * Migration 054 (supabase/migrations/054_dashboard_condition_counts_rpcs.sql)
 * added two DB-side counting RPCs — phoenix_get_dashboard_condition_counts
 * and phoenix_get_institution_condition_counts — so the dashboard no longer
 * has to fetch every item_availability row and count conditions in JS. This
 * phase switches dashboard.service.ts's getDashboardMetrics/
 * getInstitutionOverviews to call those RPCs instead.
 *
 * No live DB is used — these are static source-code assertions, matching
 * this repo's established test conventions (028/042/051/052/053/054).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

const ROOT = join(__dirname, '../../../../../');
const readSrc = (rel: string) => readFileSync(join(ROOT, 'src', rel), 'utf8');

const dashboardService = readSrc('shared/supabase/services/dashboard.service.ts');

function extractFunction(src: string, name: string, endMarker: string): string {
  const start = src.indexOf(`export async function ${name}`);
  expect(start).toBeGreaterThan(-1);
  const end = endMarker ? src.indexOf(endMarker, start) : src.length;
  return end > -1 ? src.slice(start, end) : src.slice(start);
}

const fnDashboardMetrics = extractFunction(
  dashboardService, 'getDashboardMetrics', 'export async function getStatusReportCounts',
);
const fnInstitutionOverviews = extractFunction(
  dashboardService, 'getInstitutionOverviews', '',
);

describe('PHASE2-DASHBOARD-SERVICE-RPC-SWITCH-A: getDashboardMetrics uses phoenix_get_dashboard_condition_counts', () => {
  it('calls supabase.rpc(\'phoenix_get_dashboard_condition_counts\', { p_org_id: ... })', () => {
    expect(fnDashboardMetrics).toContain("supabase.rpc('phoenix_get_dashboard_condition_counts', { p_org_id: orgId ?? null })");
  });

  it('no longer selects item_availability rows to count conditions in JS', () => {
    expect(fnDashboardMetrics).not.toMatch(/from\('item_availability'\)/);
    expect(fnDashboardMetrics).not.toMatch(/conditions\.filter/);
  });

  it('passes the caller-provided orgId as p_org_id when present', () => {
    expect(fnDashboardMetrics).toContain('p_org_id: orgId ?? null');
  });

  it('passes null as p_org_id when orgId is missing (orgId ?? null evaluates to null for undefined)', () => {
    // Structural proof: the single expression `orgId ?? null` is the only
    // value passed for p_org_id — there is no separate "if no orgId" branch
    // that could diverge from `null` when orgId is undefined.
    const rpcCallLine = fnDashboardMetrics.split('\n').find(l => l.includes('supabase.rpc('));
    expect(rpcCallLine).toBeDefined();
    expect(rpcCallLine).toMatch(/p_org_id:\s*orgId\s*\?\?\s*null/);
  });

  it('throws on RPC error (explicit error handling, no silent fallback)', () => {
    expect(fnDashboardMetrics).toContain('if (countsRes.error) throw countsRes.error;');
  });

  it('defaults every missing/undefined jsonb key to 0', () => {
    expect(fnDashboardMetrics).toContain('counts.available ?? 0');
    expect(fnDashboardMetrics).toContain('counts.low_stock ?? 0');
    expect(fnDashboardMetrics).toContain('counts.missing ?? 0');
    expect(fnDashboardMetrics).toContain('counts.near_expiry ?? 0');
    expect(fnDashboardMetrics).toContain('counts.surplus ?? 0');
  });

  it('parses the RPC response defensively via a Partial<...> type (no assumption every key exists)', () => {
    expect(fnDashboardMetrics).toMatch(/const counts = \(countsRes\.data \?\? \{\}\) as Partial<\{/);
  });

  it('preserves the exact DashboardMetrics return shape (field names/order callers rely on)', () => {
    expect(fnDashboardMetrics).toMatch(
      /return\s*\{\s*activeInstitutions:.*\n\s*activeWarehouses:.*\n\s*activePorts:.*\n\s*activeQrCodes:.*\n\s*disabledQrCodes:.*\n\s*availableItems:.*\n\s*lowStockCount:.*\n\s*missingCount:.*\n\s*nearExpiryCount:.*\n\s*surplusCount:.*\n\s*lastUpdated:/,
    );
  });

  it('still counts warehouses/distribution_points/qr_tokens the same way as before (unrelated to the RPC switch)', () => {
    expect(fnDashboardMetrics).toContain("from('warehouses')");
    expect(fnDashboardMetrics).toContain("from('distribution_points')");
    expect(fnDashboardMetrics).toContain("from('qr_tokens')");
  });

  it('still returns the offline/unconfigured default shape unchanged', () => {
    expect(fnDashboardMetrics).toMatch(/if \(!supabaseConfigured\) return \{/);
  });
});

describe('PHASE2-DASHBOARD-SERVICE-RPC-SWITCH-A: getInstitutionOverviews uses phoenix_get_institution_condition_counts', () => {
  it('calls supabase.rpc(\'phoenix_get_institution_condition_counts\') with no arguments', () => {
    expect(fnInstitutionOverviews).toContain("supabase.rpc('phoenix_get_institution_condition_counts')");
  });

  it('no longer selects item_availability rows for organization_id/condition counting', () => {
    expect(fnInstitutionOverviews).not.toMatch(/from\('item_availability'\)/);
    expect(fnInstitutionOverviews).not.toMatch(/byOrg\.set\(r\.organization_id/);
  });

  it('still fetches organizations for name/status/city metadata the RPC does not return', () => {
    expect(fnInstitutionOverviews).toContain("supabase.from('organizations')");
    expect(fnInstitutionOverviews).toContain("select('id, name, name_ar, code, status, city')");
    expect(fnInstitutionOverviews).toContain("eq('status', 'active')");
  });

  it('throws on either the organizations or the RPC error (explicit error handling, no silent fallback)', () => {
    expect(fnInstitutionOverviews).toContain('if (orgsRes.error) throw orgsRes.error;');
    expect(fnInstitutionOverviews).toContain('if (countsRes.error) throw countsRes.error;');
  });

  it('merges RPC counts into organization rows by organization_id', () => {
    expect(fnInstitutionOverviews).toMatch(/byOrg\s*=\s*new Map\(counts\.map\(c => \[c\.organization_id, c\]\)\)/);
    expect(fnInstitutionOverviews).toContain('byOrg.get(o.id)');
  });

  it('defaults available/low/missing to 0 for an organization with no matching count row', () => {
    expect(fnInstitutionOverviews).toContain('c?.available ?? 0');
    expect(fnInstitutionOverviews).toContain('c?.low ?? 0');
    expect(fnInstitutionOverviews).toContain('c?.missing ?? 0');
  });

  it('preserves the exact InstitutionOverview return shape (id/name/name_ar/code/status/city/available/low/missing)', () => {
    expect(fnInstitutionOverviews).toMatch(
      /return\s*\{\s*id:\s*o\.id,\s*name:\s*o\.name,\s*name_ar:\s*o\.name_ar,\s*code:\s*o\.code,\s*\n\s*status:\s*o\.status,\s*city:\s*o\.city\s*\?\?\s*'',\s*\n\s*available:.*low:.*missing:/,
    );
  });

  it('still returns the offline/unconfigured empty array unchanged', () => {
    expect(fnInstitutionOverviews).toMatch(/if \(!supabaseConfigured\) return \[\];/);
  });
});

describe('PHASE2-DASHBOARD-SERVICE-RPC-SWITCH-A: no sensitive fields exposed', () => {
  it('never selects/returns removed_by, item ids, or raw auth uuids from the RPCs', () => {
    expect(fnDashboardMetrics).not.toContain('removed_by');
    expect(fnInstitutionOverviews).not.toContain('removed_by');
    expect(fnInstitutionOverviews).not.toMatch(/\bitem_availability_id\b/);
  });
});

describe('PHASE2-DASHBOARD-SERVICE-RPC-SWITCH-A: unrelated behavior untouched', () => {
  it('getStatusReportCounts (unrelated to this RPC switch) is unchanged in shape/behavior', () => {
    expect(dashboardService).toContain("from('institution_item_status_reports')");
    expect(dashboardService).toContain('scarce:');
  });

  it('no migration SQL file was created or modified by this phase', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- "supabase/migrations/*.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');

    const migrationsDir = join(ROOT, 'supabase/migrations');
    const matches = readdirSync(migrationsDir).filter(f => f.startsWith('055_'));
    expect(matches).toEqual([]);
  });

  it('no package/lockfile diff', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- package.json package-lock.json pnpm-lock.yaml yarn.lock', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('no QR/alerts/movement-history/auth/permissions/navigation files changed', () => {
    let diff = '';
    try {
      diff = execSync(
        'git diff -- src/shared/supabase/services/qr.service.ts src/features/qr/PublicQrScreen.tsx ' +
        'src/features/alerts/inter-org-alert-lifecycle.service.ts src/features/status/MovementHistoryModal.tsx ' +
        'src/features/status/MovementReportSection.tsx src/shared/supabase/services/auth.service.ts ' +
        'src/app/AppContext.tsx src/shared/lib/permissions.ts src/app/App.tsx',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  // PHASE2-STATUS-CENTER-ENTERED-PRICE-FILTER-XLSX-A: a later, separately-
  // reviewed phase legitimately adds a user-entered-price column/filter to
  // both of these files (row.price only, never calculated/inferred) — that
  // addition does not change this phase's own dashboard-RPC-switch scope.
  it('Status Center XLSX export changes (if any) are limited to the later, separately-reviewed Entered Price / Outlet Report Modal additions', () => {
    let diff = '';
    try {
      diff = execSync(
        'git diff -- src/shared/lib/professional-export.ts src/features/status/StatusCenterScreen.tsx',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* ignore */ }
    if (diff.trim()) {
      expect(diff).toMatch(/enteredPrice|priceFilterMode|OutletAvailabilityReportModal|outletOptions|OutletReportRow/);
      expect(diff).not.toMatch(/phoenix_get_dashboard_condition_counts|phoenix_get_institution_condition_counts/);
    }
  });

  it('premium-preview.html remains untracked (only "??" status if present)', () => {
    let status = '';
    try {
      status = execSync('git status --porcelain -- premium-preview.html', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    if (status.trim()) {
      expect(status.trim().startsWith('??')).toBe(true);
    }
  });

  it('supabase/.temp/ was not staged', () => {
    const status = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' });
    const tempLine = status.split('\n').find(l => l.includes('supabase/.temp'));
    if (tempLine) {
      expect(tempLine.trim().startsWith('??')).toBe(true);
    }
  });

  it('Service-D stash (paused inter-org exchange service work) remains untouched', () => {
    const stashList = execSync('git stash list', { cwd: ROOT, encoding: 'utf8' });
    expect(stashList).toContain('paused Service-D inter-org exchange service work');
  });
});
