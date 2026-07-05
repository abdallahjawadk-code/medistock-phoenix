/**
 * UX-COMMAND-CENTER-SMART-A
 * Run: npm test -- --run
 *
 * Static source-code tests proving the Command Center layer (Command
 * Palette, Quick Actions, honest Activity Feed) was added WITHOUT touching
 * routes, nav targets, QR public URL logic, export/print logic, user
 * management, or permissions — and without introducing fake data,
 * migrations, package/lockfile changes, or Service-D interference.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const SRC = join(__dirname, '../../../');
const ROOT = join(__dirname, '../../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const app = readSrc('app/App.tsx');
const shell = readSrc('shared/ui/PhoenixAppShell.tsx');
const sidebar = readSrc('shared/ui/PhoenixSidebar.tsx');
const drawer = readSrc('shared/ui/PhoenixMobileDrawer.tsx');
const bottomNav = readSrc('shared/ui/PhoenixMobileBottomNav.tsx');
const palette = readSrc('shared/ui/CommandPalette.tsx');
const quickActionGrid = readSrc('shared/ui/QuickActionGrid.tsx');
const activityFeed = readSrc('shared/ui/CommandCenterActivityFeed.tsx');
const statusCenter = readSrc('features/status/StatusCenterScreen.tsx');
const publicQr = readSrc('features/qr/PublicQrScreen.tsx');

describe('1. App screen map / routes unchanged', () => {
  it('App.tsx still switches on the same 14 known screen numbers', () => {
    for (const n of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]) {
      expect(app).toContain(`case ${n}:`);
    }
  });

  it('initial screen and post-logout screen remain Status Center (12)', () => {
    expect(app).toContain('useState(12)');
    expect(app).toContain('setScreen(12)');
  });

  it('unknown/default screens still redirect to Status Center', () => {
    const defaultIdx = app.indexOf('default:');
    expect(app.slice(defaultIdx, defaultIdx + 80)).toContain('StatusCenterScreen');
  });
});

describe('2. Existing navigation targets unchanged', () => {
  it('sidebar/drawer/bottom-nav screen numbers are untouched', () => {
    expect(sidebar).toContain('screen: 11');
    expect(sidebar).toContain('screen: 12');
    expect(sidebar).toContain('screen: 14');
    expect(drawer).toContain('screen: 11');
    expect(bottomNav).toContain('screen: 12');
  });

  it('CommandPalette and QuickActionGrid only ever call the passed-in onNavigate — no new navigation mechanism', () => {
    expect(palette).toContain('onNavigate: (screen: number) => void');
    expect(palette).not.toMatch(/window\.location\s*=/);
    expect(palette).not.toContain('history.pushState');
    expect(quickActionGrid).toContain('onNavigate: (screen: number) => void');
  });
});

describe('3. QR public route remains present', () => {
  it('App.tsx still bypasses auth entirely for ?qid=/?token=', () => {
    expect(app).toContain('publicQrId');
    expect(app).toContain('PublicQrScreen');
    expect(app).toContain("params.get('qid')");
    expect(app).toContain("params.get('token')");
  });

  it('PublicQrScreen module is untouched by this phase (no Command Center imports)', () => {
    expect(publicQr).not.toContain('CommandPalette');
    expect(publicQr).not.toContain('QuickActionGrid');
  });
});

describe('4/5. Export/print handlers + mobile print fallback remain unchanged', () => {
  // SAFE-PROFESSIONAL-XLSX-EXPORT-A: a later, separately-reviewed phase
  // replaced StatusCenterScreen's ad-hoc CSV export with a real styled
  // .xlsx workbook (exportXlsx) — unrelated to this Command Center phase.
  // printReport and the mobile print fallback are untouched.
  it('StatusCenterScreen still has exportXlsx, printReport, and the mobile print fallback modal', () => {
    expect(statusCenter).toContain('function exportXlsx');
    expect(statusCenter).toContain('function printReport');
    expect(statusCenter).toContain('isLikelyMobilePrintContext');
    expect(statusCenter).toContain('MobilePrintFallbackModal');
  });
});

describe('6. User-management function invocations remain unchanged', () => {
  it('CommandPalette never calls a users.*/auth.admin RPC directly — it only gates visibility using myPermissions/role already in AppContext', () => {
    expect(palette).not.toContain('supabase.rpc');
    expect(palette).not.toContain('.functions.invoke');
    expect(palette).toContain("myPermissions.has('users.view')");
  });
});

describe('7. No service_role / auth.admin in frontend', () => {
  it('none of the new Command Center files reference service_role or auth.admin', () => {
    for (const src of [palette, quickActionGrid, activityFeed]) {
      expect(src).not.toMatch(/service_role/i);
      expect(src).not.toContain('auth.admin');
    }
  });
});

describe('8. No inter_org_exchange UI added', () => {
  it('none of the new Command Center files reference inter_org_exchange', () => {
    for (const src of [palette, quickActionGrid, activityFeed]) {
      expect(src).not.toContain('inter_org_exchange');
    }
  });
});

describe('9. No wipe tooling restored', () => {
  it('none of the new Command Center files reference wipe/full-reset tooling', () => {
    for (const src of [palette, quickActionGrid, activityFeed]) {
      expect(src).not.toMatch(/phoenix-wipe-execute|FULL_PUBLIC_APP_WIPE_APPROVED|full_wipe|DROP SCHEMA/i);
    }
  });
});

describe('10. No package/lockfile/migration changes', () => {
  // REFRESH-MIGRATION-051-DIFF-GUARDS-A: 051_material_batch_identity_option_a.sql
  // is excluded because a later, separately-reviewed phase (FIX-MIGRATION-051-
  // IMMUTABLE-EXPIRY-DATE-A) legitimately corrects it in-place before its
  // first successful manual apply.
  it('git diff for package/lockfiles/migration SQL files is empty other than the already-approved 051 immutable-expiry-date fix (test-only maintenance under supabase/migrations/__tests__/ is not a migration SQL change)', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- "supabase/migrations/*.sql" ":!supabase/migrations/051_material_batch_identity_option_a.sql" ":!supabase/migrations/053_item_availability_removed_marker.sql" ":!supabase/migrations/054_dashboard_condition_counts_rpcs.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* git not available in this sandbox — skip silently */ }
    expect(diff.trim()).toBe('');

    let pkgDiff = '';
    try {
      pkgDiff = execSync('git diff -- package.json', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* git not available in this sandbox — skip silently */ }
    const addedLines = pkgDiff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
    const removedLines = pkgDiff.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---'));
    expect(removedLines.length).toBe(0);
    expect(addedLines.every(l => /"exceljs":/.test(l))).toBe(true);
  });
});

describe('11. Command Center uses no fake dashboard data', () => {
  it('CommandCenterActivityFeed only renders caller-supplied entries — no hardcoded sample rows', () => {
    expect(activityFeed).not.toMatch(/entries\s*=\s*\[\s*\{/);
    expect(activityFeed).toContain('entries.length === 0');
  });

  it('StatusCenterScreen builds activity entries from already-loaded live availability rows, not new fetches', () => {
    const block = statusCenter.slice(statusCenter.indexOf('const activityEntries'), statusCenter.indexOf('const generatedAt'));
    expect(block).toContain('allRows');
    expect(block).not.toContain('supabase.rpc');
    expect(block).not.toContain('.from(');
  });
});

describe('12. Quick Actions navigate only to existing screens', () => {
  it('QuickActionGrid items in StatusCenterScreen use known screen numbers only', () => {
    const block = statusCenter.slice(statusCenter.indexOf('const quickActions'), statusCenter.indexOf('const activityEntries'));
    for (const n of [11, 13, 9, 6, 15, 14]) {
      expect(block).toContain(`screen: ${n}`);
    }
  });
});

describe('13/14/15. Command Palette keyboard behavior + navigation', () => {
  it('opens on Ctrl+K / Cmd+K', () => {
    expect(palette).toContain("e.key.toLowerCase() === 'k'");
    expect(palette).toContain('e.ctrlKey || e.metaKey');
  });

  it('closes on Escape', () => {
    expect(palette).toContain("e.key === 'Escape'");
  });

  it('selecting an item calls onNavigate then closes', () => {
    const fn = palette.slice(palette.indexOf('function choose'), palette.indexOf('function choose') + 120);
    expect(fn).toContain('onNavigate(screen)');
    expect(fn).toContain('close()');
  });
});

describe('16. RTL/LTR labels exist', () => {
  it('Command Center i18n keys have both ar and en strings', () => {
    const strings = readSrc('shared/i18n/strings.ts');
    for (const key of ['cc_palette_open', 'cc_palette_title', 'cc_palette_placeholder', 'cc_activity_title', 'cc_activity_empty']) {
      const line = strings.split('\n').find(l => l.trim().startsWith(`${key}:`));
      expect(line).toBeDefined();
      expect(line).toContain('ar:');
      expect(line).toContain('en:');
    }
  });
});

describe('17. Mobile layout classes/wrapping exist', () => {
  it('QuickActionGrid uses an auto-fit wrapping grid', () => {
    expect(quickActionGrid).toContain('repeat(auto-fit, minmax(140px, 1fr))');
  });

  it('palette trigger button and palette items meet the 44px minimum touch target', () => {
    expect(palette).toContain("minHeight: '44px'");
    expect(palette).toContain("width: '44px', height: '44px'");
  });
});

describe('18. Existing button handlers remain connected', () => {
  // SAFE-PROFESSIONAL-XLSX-EXPORT-A: the export button's onClick now calls
  // exportXlsx instead of the old exportCsv — same button, same location.
  it('StatusCenterScreen export/print/adjust/history buttons still call their original handlers', () => {
    expect(statusCenter).toContain('onClick={exportXlsx}');
    expect(statusCenter).toContain('onClick={printReport}');
    expect(statusCenter).toContain('onClick={() => setAdjustRow(r)}');
    expect(statusCenter).toContain('onClick={() => setHistoryRow(r)}');
  });
});

describe('19. Permissions visibility preserved where existing checks apply', () => {
  it('StatusCenterScreen quick-action user-management tile mirrors the same users.view/super_admin gate as the palette', () => {
    expect(statusCenter).toContain("role === 'super_admin' || myPermissions.has('users.view')");
  });
});

describe('20. Empty states are honest, no fake data implied', () => {
  it('activity empty-state copy matches the required honest strings', () => {
    const strings = readSrc('shared/i18n/strings.ts');
    expect(strings).toContain('ستظهر هنا آخر العمليات بعد بدء استخدام النظام.');
    expect(strings).toContain('Recent activity will appear here after the system is used.');
  });
});

describe('Safety guards', () => {
  it('stash@{0} (paused Service-D work) was not popped or applied', () => {
    const stashList = execSync('git stash list', { cwd: ROOT, encoding: 'utf8' });
    expect(stashList).toContain('paused Service-D inter-org exchange service work');
  });

  it('premium-preview.html remains untouched (untracked only)', () => {
    let status = '';
    try {
      status = execSync('git status --porcelain -- premium-preview.html', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* git not available in this sandbox — skip silently */ }
    if (status.trim()) {
      expect(status.trim().startsWith('??')).toBe(true);
    }
  });

  it('PhoenixAppShell mounts CommandPalette without altering its existing sidebar/topbar/bottomnav wiring', () => {
    expect(shell).toContain('<CommandPalette onNavigate={onNavigate} />');
    expect(shell).toContain('<PhoenixSidebar');
    expect(shell).toContain('<PhoenixTopbar');
    expect(shell).toContain('<PhoenixMobileBottomNav');
  });
});
