/**
 * FRONTEND-LIVE-REMOVED-AT-FILTERS-A
 * Run: npm test -- --run
 *
 * Migration 053 added an explicit removed_at/removed_by/removal_reason
 * marker to item_availability so future "remove from outlet"/clear-port
 * operations can be reliably distinguished from a genuine, still-open
 * shortage. The DB migration itself already filters removed_at IS NULL
 * inside two RPCs (get_public_qr_payload,
 * phoenix_get_live_inter_institution_alerts_with_state). This phase wires
 * the same removed_at filter into the remaining frontend/service reads that
 * query item_availability directly, so intentionally removed materials
 * disappear from every other live/current/user-facing surface too — while
 * remaining fully visible in operations/status center (reactivation
 * context) and movement history (audit trail).
 *
 * No live DB is used — these are static source-code assertions, matching
 * this repo's established test conventions (028/042/051/052/053).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

const ROOT = join(__dirname, '../../../../../');
const readSrc = (rel: string) => readFileSync(join(ROOT, 'src', rel), 'utf8');

const dashboardService    = readSrc('shared/supabase/services/dashboard.service.ts');
const availabilityService = readSrc('shared/supabase/services/availability.service.ts');
const institutionScreen   = readSrc('features/institutions/InstitutionScreen.tsx');
const editorScreen        = readSrc('features/editor/EditorScreen.tsx');
const lifecycleService    = readSrc('shared/supabase/services/lifecycle.service.ts');
const movementHistoryModal = readSrc('features/status/MovementHistoryModal.tsx');
const movementReportSection = readSrc('features/status/MovementReportSection.tsx');
const qrService           = readSrc('shared/supabase/services/qr.service.ts');
const publicQrScreen      = readSrc('features/qr/PublicQrScreen.tsx');
const interOrgAlertLifecycleService = readSrc('features/alerts/inter-org-alert-lifecycle.service.ts');
const types = readFileSync(join(ROOT, 'src/shared/lib/types.ts'), 'utf8');

describe('A) Dashboard: live stock counts ignore removed_at rows', () => {
  it('getDashboardMetrics filters .is(\'removed_at\', null) on its item_availability read', () => {
    const start = dashboardService.indexOf('export async function getDashboardMetrics');
    const end = dashboardService.indexOf('export async function getStatusReportCounts');
    const body = dashboardService.slice(start, end);
    const line = body.split('\n').find(l => l.includes("from('item_availability')"));
    expect(line).toBeDefined();
    expect(line).toContain(".is('removed_at', null)");
  });

  it('getInstitutionOverviews filters .is(\'removed_at\', null) on its item_availability read', () => {
    const start = dashboardService.indexOf('export async function getInstitutionOverviews');
    const body = dashboardService.slice(start, start + 800);
    const line = body.split('\n').find(l => l.includes("from('item_availability')"));
    expect(line).toBeDefined();
    expect(line).toContain(".is('removed_at', null)");
  });

  it('does not globally hide missing/shortage rows — only the removed_at filter was added, condition-bucketing logic is untouched', () => {
    const start = dashboardService.indexOf('export async function getDashboardMetrics');
    const end = dashboardService.indexOf('export async function getStatusReportCounts');
    const body = dashboardService.slice(start, end);
    expect(body).toContain("r.condition === 'missing'");
  });
});

describe('B) Low-stock/shortage report: removed rows excluded, genuine missing/low-stock rows kept', () => {
  it('getLowStockItems filters .is(\'removed_at\', null) alongside its existing condition filter', () => {
    const start = availabilityService.indexOf('export async function getLowStockItems');
    const end = availabilityService.indexOf('export async function getAvailabilityByOrg');
    const body = availabilityService.slice(start, end);
    expect(body).toMatch(/\.in\('condition', \['low_stock', 'missing', 'near_expiry', 'expired'\]\)\s*\n\s*\.is\('removed_at', null\)/);
  });

  it('still targets the same four conditions as before (missing/near_expiry/expired/low_stock are still real, reportable shortage states when not removed)', () => {
    const start = availabilityService.indexOf('export async function getLowStockItems');
    const end = availabilityService.indexOf('export async function getAvailabilityByOrg');
    const body = availabilityService.slice(start, end);
    expect(body).toContain("'low_stock', 'missing', 'near_expiry', 'expired'");
  });
});

describe('C) Institution current outlet list: hides removed rows, keeps genuine missing rows', () => {
  const fnStart = institutionScreen.indexOf('function PortAvailabilitySection');
  const fnBody = institutionScreen.slice(fnStart, institutionScreen.indexOf('function QuickAvailForm'));

  it('filters on removed_at, not the old blunt quantity=0/condition=missing heuristic', () => {
    expect(fnBody).toContain('filter(r => r.removed_at == null)');
    expect(fnBody).not.toMatch(/\.filter\(r => !\(r\.quantity === 0 && r\.condition === 'missing'\)\)/);
  });

  it('AvailRow carries removed_at so the filter has data to read', () => {
    const rowStart = institutionScreen.indexOf('interface AvailRow');
    const rowBody = institutionScreen.slice(rowStart, institutionScreen.indexOf('interface LocalRow'));
    expect(rowBody).toMatch(/removed_at\?:\s*string \| null;/);
  });

  it('a genuine still-open shortage (removed_at null, condition=missing) is not filtered out — only removed_at gates visibility', () => {
    // Structurally: the filter predicate references only removed_at, so a
    // row with condition==='missing' and removed_at===null passes through.
    expect(fnBody).not.toMatch(/condition === 'missing'/);
  });

  it('getAvailabilityByPoint (the underlying read) now selects removed_at', () => {
    const start = availabilityService.indexOf('export async function getAvailabilityByPoint');
    const body = availabilityService.slice(start, start + 900);
    expect(body).toMatch(/port_name, supply_type, removed_at,/);
  });

  it('getAvailabilityByPoint does NOT filter removed_at at the DB level (EditorScreen, the other consumer, needs to see removed rows to reactivate them)', () => {
    const start = availabilityService.indexOf('export async function getAvailabilityByPoint');
    const end = availabilityService.indexOf('export async function upsertAvailability');
    const body = availabilityService.slice(start, end);
    expect(body).not.toMatch(/\.is\('removed_at', null\)/);
  });
});

describe('D) EditorScreen reactivation path is not broken', () => {
  it('EditorScreen still consumes the same unfiltered getAvailabilityByPoint data for identity/duplicate matching', () => {
    expect(editorScreen).toContain('getAvailabilityByPoint(pointId)');
    expect(editorScreen).toContain('pointAvailability.data');
  });

  it('EditorScreen does not add its own removed_at filter that would hide removed rows from reactivation matching', () => {
    expect(editorScreen).not.toMatch(/removed_at/);
  });
});

describe('E) getAvailabilityByOrg (Status Center / operations context) remains unfiltered by design', () => {
  it('no .is(\'removed_at\', null) was added to getAvailabilityByOrg — migration 053\'s own header states staff need to see removed rows to manage/reactivate them', () => {
    const start = availabilityService.indexOf('export async function getAvailabilityByOrg');
    const body = availabilityService.slice(start, start + 1400);
    expect(body).not.toContain(".is('removed_at', null)");
  });

  // SAFE-PROFESSIONAL-XLSX-EXPORT-A: a later, separately-reviewed phase adds
  // actor_name_snapshot/removed_at to this same SELECT (both already-existing,
  // non-sensitive columns) so StatusCenterScreen's XLSX export can show a
  // "Last Updated By" display name and exclude removed_at rows from the
  // export — the query itself still applies no removed_at filter, so this
  // file's own guard above still holds.
  it('getAvailabilityByOrg additionally selects actor_name_snapshot and removed_at (read-only, no new query source, no filter added)', () => {
    const start = availabilityService.indexOf('export async function getAvailabilityByOrg');
    const body = availabilityService.slice(start, start + 1400);
    expect(body).toContain('actor_name_snapshot, removed_at');
  });

  it('StatusCenterScreen (the consumer) is untouched by this phase, except the later, separately-reviewed SAFE-PROFESSIONAL-XLSX-EXPORT-A CSV-to-XLSX export replacement', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- src/features/status/StatusCenterScreen.tsx', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    if (diff.trim()) {
      expect(diff).toMatch(/exportAvailabilityXlsx|removed_at/);
      expect(diff).not.toMatch(/service_role|auth\.admin/);
      expect(diff).not.toMatch(/CREATE (OR REPLACE )?FUNCTION/);
    }
  });
});

describe('F) Public QR remains protected and unchanged (already DB/RPC-filtered)', () => {
  it('qr.service.ts is untouched by this phase', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- src/shared/supabase/services/qr.service.ts', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('PublicQrScreen.tsx is untouched by this phase', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- src/features/qr/PublicQrScreen.tsx', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('qr.service.ts still calls the get_public_qr_payload RPC (DB-side removed_at filtering, unaffected)', () => {
    expect(qrService).toContain('get_public_qr_payload');
  });

  it('PublicQrScreen has no direct item_availability query of its own to worry about', () => {
    expect(publicQrScreen).not.toContain("from('item_availability')");
  });
});

describe('G) Inter-institution alerts remain DB-protected; no frontend alert lifecycle change', () => {
  it('inter-org-alert-lifecycle.service.ts is untouched by this phase', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- src/features/alerts/inter-org-alert-lifecycle.service.ts', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('it still calls the phoenix_get_live_inter_institution_alerts_with_state RPC (DB-side removed_at filtering, unaffected)', () => {
    expect(interOrgAlertLifecycleService).toContain('phoenix_get_live_inter_institution_alerts_with_state');
  });

  it('no frontend item_availability query was added for alerts in this phase', () => {
    expect(interOrgAlertLifecycleService).not.toContain("from('item_availability')");
  });
});

describe('H) Movement history remains unfiltered and complete', () => {
  it('MovementHistoryModal.tsx is untouched by this phase', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- src/features/status/MovementHistoryModal.tsx', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('MovementReportSection.tsx is untouched by this phase', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- src/features/status/MovementReportSection.tsx', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('neither reads item_availability directly with a removed_at filter — movements are read from item_availability_movements, unaffected by the marker', () => {
    expect(movementHistoryModal).not.toMatch(/removed_at/);
    expect(movementReportSection).not.toMatch(/removed_at/);
  });

  it('getAvailabilityMovementsByItem / getAvailabilityMovementsReport (their data sources) are untouched by this phase', () => {
    const byItemStart = availabilityService.indexOf('export async function getAvailabilityMovementsByItem');
    const byItemEnd = availabilityService.indexOf('export async function getAvailabilityMovementsReport');
    expect(availabilityService.slice(byItemStart, byItemEnd)).not.toMatch(/removed_at/);

    const reportStart = availabilityService.indexOf('export async function getAvailabilityMovementsReport');
    const reportEnd = availabilityService.indexOf('export async function getLowStockItems');
    expect(availabilityService.slice(reportStart, reportEnd)).not.toMatch(/removed_at/);
  });
});

describe('I) lifecycle.service.ts (org delete-impact count) is untouched — removed rows still count against safe deletion', () => {
  it('getOrgDeleteImpact has no removed_at filter added', () => {
    expect(lifecycleService).not.toMatch(/removed_at/);
  });

  it('lifecycle.service.ts has no working-tree diff from this phase', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- src/shared/supabase/services/lifecycle.service.ts', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });
});

describe('J) AvailabilityRecord type gains an optional removed_at field only', () => {
  it('removed_at?: string | null was added to AvailabilityRecord', () => {
    const start = types.indexOf('export interface AvailabilityRecord');
    const end = types.indexOf('export interface QrToken');
    const body = types.slice(start, end);
    expect(body).toMatch(/removed_at\?:\s*string \| null;/);
  });

  it('no other interface in types.ts was touched by this phase (removed_at is scoped to AvailabilityRecord only)', () => {
    const beforeRecord = types.slice(0, types.indexOf('export interface AvailabilityRecord'));
    const afterRecord = types.slice(types.indexOf('export interface QrToken'));
    expect(beforeRecord).not.toContain('removed_at');
    expect(afterRecord).not.toContain('removed_at');
  });
});

describe('Guards: no SQL/migration/DB change, no package/lockfile change, no unrelated production files touched', () => {
  it('no migration 055 was created (054, PHASE2-DASHBOARD-PERFORMANCE-RPCS-054-A, is a later, separately-reviewed addition)', () => {
    let listing = '';
    try {
      listing = execSync('git status --porcelain -- supabase/migrations', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(listing).not.toMatch(/055_/);
  });

  it('no migration SQL file has a working-tree diff', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- "supabase/migrations/*.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('no package/lockfile diff', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- package.json package-lock.json pnpm-lock.yaml yarn.lock', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('no service_role/auth.admin/RPC/CREATE FUNCTION reference introduced in any touched file', () => {
    for (const src of [dashboardService, availabilityService, institutionScreen]) {
      expect(src).not.toMatch(/service_role|auth\.admin/i);
      expect(src).not.toMatch(/CREATE (OR REPLACE )?FUNCTION/i);
    }
  });

  it('no WhatsApp/auth/session/permission file was touched by this phase', () => {
    let diff = '';
    try {
      diff = execSync(
        'git diff -- src/shared/supabase/services/auth.service.ts src/shared/lib/permissions.ts src/app/AppContext.tsx',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
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
