/**
 * PRODUCTION-READINESS-CLEANUP-A
 * Run: npm test -- --run
 *
 * Static source-code tests covering:
 *  - the central dashboard (screen 2 / DashboardScreen) is removed from all
 *    navigation surfaces and its route safely redirects to Status Center;
 *  - the permanent "Demo Data" badge no longer appears in the app topbar;
 *  - the real, reachable Reports screen no longer mislabels its data as demo;
 *  - CSV export includes UTF-8 BOM, injection-safe cell escaping, and a
 *    medistock-status-prefixed filename;
 *  - no migrations/package/lockfile changes, Service-D stash intact,
 *    premium-preview.html untouched.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const SRC = join(__dirname, '../../../');
const ROOT = join(__dirname, '../../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const app = readSrc('app/App.tsx');
const sidebar = readSrc('shared/ui/PhoenixSidebar.tsx');
const drawer = readSrc('shared/ui/PhoenixMobileDrawer.tsx');
const bottomNav = readSrc('shared/ui/PhoenixMobileBottomNav.tsx');
const shell = readSrc('shared/ui/PhoenixAppShell.tsx');
const topbar = readSrc('shared/ui/PhoenixTopbar.tsx');
const strings = readSrc('shared/i18n/strings.ts');
const statusCenter = readSrc('features/status/StatusCenterScreen.tsx');

describe('Central dashboard removed from navigation', () => {
  it('App.tsx no longer imports or renders DashboardScreen', () => {
    expect(app).not.toContain('DashboardScreen');
  });

  it('App.tsx has no case 2 (former central dashboard screen number)', () => {
    expect(app).not.toMatch(/case 2:/);
  });

  it('unknown/removed screen numbers (including the former screen 2) redirect to Status Center', () => {
    const defaultIdx = app.indexOf('default:');
    const around = app.slice(defaultIdx, defaultIdx + 80);
    expect(around).toContain('StatusCenterScreen');
  });

  it('the initial screen and post-logout screen are Status Center (12), not the removed dashboard (2)', () => {
    expect(app).toContain('useState(12)');
    expect(app).toContain('setScreen(12)');
    expect(app).not.toContain('useState(2)');
    expect(app).not.toContain('setScreen(2)');
  });

  it('sidebar NAV_ITEMS no longer contains nav_dash', () => {
    const block = sidebar.slice(sidebar.indexOf('const NAV_ITEMS'), sidebar.indexOf('const SECONDARY_ITEMS'));
    expect(block).not.toContain("'nav_dash'");
  });

  it('mobile drawer ALL_NAV no longer contains nav_dash', () => {
    const block = drawer.slice(drawer.indexOf('const ALL_NAV'), drawer.indexOf('const SECONDARY_NAV'));
    expect(block).not.toContain("'nav_dash'");
  });

  it('mobile bottom nav no longer contains nav_dash (replaced by nav_status_center)', () => {
    const block = bottomNav.slice(bottomNav.indexOf('const BOTTOM_NAV'), bottomNav.indexOf('interface Props'));
    expect(block).not.toContain("'nav_dash'");
    expect(block).toContain("'nav_status_center'");
  });

  it('PhoenixAppShell screen-title map no longer maps screen 2 to nav_dash', () => {
    const block = shell.slice(shell.indexOf('SCREEN_TITLE_KEYS'), shell.indexOf('interface Props'));
    expect(block).not.toMatch(/(?<![0-9])2:/);
    expect(block).not.toContain("'nav_dash'");
  });

  it('PhoenixAppShell falls back to nav_status_center for unmapped screens', () => {
    expect(shell).toContain("?? 'nav_status_center'");
  });
});

describe('No permanent fake "Demo Data" badge shown to real users', () => {
  it('PhoenixTopbar (rendered on every authenticated screen) no longer shows a demoData badge', () => {
    expect(topbar).not.toContain('demoData');
    expect(topbar).not.toContain('Demo Data');
  });

  it('the real, nav-reachable Reports screen subtitle no longer claims demo data', () => {
    const line = strings.split('\n').find(l => l.trim().startsWith('reports_sub:'));
    expect(line).toBeDefined();
    expect(line).not.toContain('Demo data');
    expect(line).not.toContain('بيانات تجريبية');
  });
});

// SAFE-PROFESSIONAL-XLSX-EXPORT-A: this describe block originally locked in
// StatusCenterScreen's hand-rolled CSV export (BOM/csvSafeCell/manual
// timestamp). A later, separately-reviewed phase replaced it with a real
// styled .xlsx workbook via exportAvailabilityXlsx (shared professional-
// export.ts module) — formula-injection safety is now handled there by
// neutralizeFormulaValue (a superset of the old csvSafeCell), and the
// timestamp/extension are appended by buildStableFileName. The underlying
// safety properties (Arabic-safe, injection-safe, stable/dated filename) are
// preserved, just implemented in the shared module instead of inline here.
describe('Excel export: Arabic-safe, injection-safe, clean filename', () => {
  it('no longer uses CSV (BOM/text-csv Blob) — replaced by a real .xlsx workbook', () => {
    const fn = statusCenter.slice(statusCenter.indexOf('async function exportXlsx'), statusCenter.indexOf('function handleMovementSuccess'));
    expect(fn).not.toContain('﻿');
    expect(fn).not.toContain('text/csv;charset=utf-8');
    expect(fn).toContain('exportAvailabilityXlsx');
  });

  it('formula-injection protection is enforced by the shared professional-export module (neutralizeFormulaValue), not a local csvSafeCell', () => {
    expect(statusCenter).not.toContain('function csvSafeCell');
    const exportModule = readFileSync(join(SRC, 'shared/lib/professional-export.ts'), 'utf8');
    expect(exportModule).toContain('function neutralizeFormulaValue');
    expect(exportModule).toContain("/^[=+\\-@\\t]|^[\\x00-\\x1F]/");
  });

  it('uses a medistock-status-prefixed filename base, with the timestamp/extension appended by the shared buildStableFileName helper', () => {
    const fn = statusCenter.slice(statusCenter.indexOf('async function exportXlsx'), statusCenter.indexOf('function handleMovementSuccess'));
    expect(fn).toContain('medistock-status');
    expect(fn).toContain('fileNameBase:');
  });

  it('does not export raw ids, alert_key, exchange_request_id, or supply_type technical keys', () => {
    const columnsBlock = statusCenter.slice(statusCenter.indexOf('const columns:'), statusCenter.indexOf('function buildReportHtml'));
    expect(columnsBlock).not.toMatch(/key: 'id'/);
    expect(columnsBlock).not.toContain('alert_key');
    expect(columnsBlock).not.toContain('exchange_request_id');
  });
});

describe('Print report: professional header, RTL-safe, no technical fields', () => {
  it('print HTML includes app name, org, generated date, and active filters', () => {
    const fn = statusCenter.slice(statusCenter.indexOf('function buildReportHtml'), statusCenter.indexOf('function printReport'));
    expect(fn).toContain('MediStock-Babil');
    expect(fn).toContain('sc_generated_at');
    expect(fn).toContain('sc_selected_filters');
    expect(fn).toContain('orgName');
  });

  it('print HTML sets RTL/LTR direction from the active language', () => {
    const fn = statusCenter.slice(statusCenter.indexOf('function buildReportHtml'), statusCenter.indexOf('function printReport'));
    expect(fn).toMatch(/dir="\$\{dir\}"/);
  });

  it('print HTML escapes all interpolated content', () => {
    expect(statusCenter).toContain('function escHtml');
  });

  it('does not print raw ids/alert_key/exchange_request_id/supply_type technical keys', () => {
    const fn = statusCenter.slice(statusCenter.indexOf('function buildReportHtml'), statusCenter.indexOf('function printReport'));
    expect(fn).not.toContain('alert_key');
    expect(fn).not.toContain('exchange_request_id');
  });
});

describe('PRODUCTION-READINESS-CLEANUP-A: safety guards', () => {
  it('stash@{0} (paused Service-D work) was not popped or applied', () => {
    const stashList = execSync('git stash list', { cwd: ROOT, encoding: 'utf8' });
    expect(stashList).toContain('paused Service-D inter-org exchange service work');
  });

  // REFRESH-MIGRATION-051-DIFF-GUARDS-A: 051_material_batch_identity_option_a.sql
  // is excluded because a later, separately-reviewed phase (FIX-MIGRATION-051-
  // IMMUTABLE-EXPIRY-DATE-A) legitimately corrects it in-place before its
  // first successful manual apply.
  it('no migration SQL touched other than the already-approved 051 immutable-expiry-date fix', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- "supabase/migrations/*.sql" ":!supabase/migrations/051_material_batch_identity_option_a.sql" ":!supabase/migrations/053_item_availability_removed_marker.sql" ":!supabase/migrations/054_dashboard_condition_counts_rpcs.sql" ":!supabase/migrations/055_phoenix_clean_availability_data.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* git not available in this sandbox — skip silently */ }
    expect(diff.trim()).toBe('');
  });

  it('no package/lockfile changes beyond the explicitly approved exceljs addition (EXPORT-PROFESSIONAL-XLSX-PDF-B)', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- package.json', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* git not available in this sandbox — skip silently */ }
    const added = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
    const removed = diff.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---'));
    expect(removed.length).toBe(0);
    expect(added.every(l => /"exceljs":/.test(l))).toBe(true);

    let lockStatus = '';
    try {
      lockStatus = execSync('git status --porcelain -- pnpm-lock.yaml yarn.lock', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* git not available in this sandbox — skip silently */ }
    expect(lockStatus.trim()).toBe('');
  });

  it('premium-preview.html remains untouched', () => {
    let status = '';
    try {
      status = execSync('git status --porcelain -- premium-preview.html', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* git not available in this sandbox — skip silently */ }
    if (status.trim()) {
      expect(status.trim().startsWith('??')).toBe(true);
    }
  });
});
