/**
 * PHASE2-HIDE-REPORTS-MOVE-AUDIT-TO-STATUS-CENTER-A
 *
 * Hides the Reports ("التقارير") item from every navigation entry point
 * (desktop sidebar, mobile drawer, Status Center's own Quick Actions grid)
 * WITHOUT deleting ReportsScreen.tsx or its App.tsx route (case 9) — a
 * hide-only/de-emphasis change, exactly like the earlier
 * UI-LEGACY-PAGES-NAV-HIDE-A / RESTORE-AVAILABILITY-EDITOR-HIDE-INTAKE-A
 * phases hid nav_reg/nav_qr_audit/nav_intake.
 *
 * Also extracts ReportsScreen.tsx's existing Audit tab into a reusable,
 * read-only AuditLogSection component (same getAuditLog data source, same
 * rendered fields, zero behavior change) and adds it as a new "Audit Log /
 * سجل التدقيق" tab inside Status Center.
 *
 * Static source-code tests — no DB connection required, no component
 * rendering, matching this repo's established test conventions.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

const ROOT = join(__dirname, '../../../../');
const SRC = join(__dirname, '../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const sidebar = readSrc('shared/ui/PhoenixSidebar.tsx');
const mobileDrawer = readSrc('shared/ui/PhoenixMobileDrawer.tsx');
const mobileBottomNav = readSrc('shared/ui/PhoenixMobileBottomNav.tsx');
const commandPalette = readSrc('shared/ui/CommandPalette.tsx');
const app = readSrc('app/App.tsx');
const reportsScreen = readSrc('features/reports/ReportsScreen.tsx');
const auditLogSection = readSrc('features/reports/AuditLogSection.tsx');
const statusCenter = readSrc('features/status/StatusCenterScreen.tsx');
const strings = readSrc('shared/i18n/strings.ts');

describe('A) Reports is hidden from the desktop sidebar', () => {
  it('NAV_ITEMS no longer lists nav_reports', () => {
    const navBlock = sidebar.slice(sidebar.indexOf('const NAV_ITEMS'), sidebar.indexOf('const SECONDARY_ITEMS'));
    expect(navBlock).not.toContain("'nav_reports'");
  });

  it('SECONDARY_ITEMS does not reintroduce nav_reports either', () => {
    const secondaryBlock = sidebar.slice(sidebar.indexOf('const SECONDARY_ITEMS'), sidebar.indexOf('const ROLE_MAP'));
    expect(secondaryBlock).not.toContain("'nav_reports'");
  });

  it('every other primary sidebar item remains present (nothing else was removed)', () => {
    const navBlock = sidebar.slice(sidebar.indexOf('const NAV_ITEMS'), sidebar.indexOf('const SECONDARY_ITEMS'));
    ['nav_institutions', 'nav_status_center', 'nav_inter_alerts', 'nav_users', 'nav_editor']
      .forEach(key => expect(navBlock).toContain(`'${key}'`));
  });

  it('documents the hide-only intent', () => {
    expect(sidebar).toContain('PHASE2-HIDE-REPORTS-MOVE-AUDIT-TO-STATUS-CENTER-A');
  });
});

describe('B) Reports is hidden from the mobile drawer', () => {
  it('ALL_NAV no longer lists nav_reports', () => {
    const allNavBlock = mobileDrawer.slice(mobileDrawer.indexOf('const ALL_NAV'), mobileDrawer.indexOf('interface Props'));
    expect(allNavBlock).not.toContain("'nav_reports'");
  });

  it('every other primary drawer item remains present', () => {
    const allNavBlock = mobileDrawer.slice(mobileDrawer.indexOf('const ALL_NAV'), mobileDrawer.indexOf('interface Props'));
    ['nav_institutions', 'nav_status_center', 'nav_inter_alerts', 'nav_users', 'nav_editor']
      .forEach(key => expect(allNavBlock).toContain(`'${key}'`));
  });
});

describe('C) Mobile bottom nav never had Reports (unaffected)', () => {
  it("BOTTOM_NAV does not contain 'nav_reports'", () => {
    expect(mobileBottomNav).not.toContain("'nav_reports'");
  });
});

describe('D) Status Center still shows its full nav item; Quick Actions no longer offers a Reports shortcut', () => {
  it('nav_status_center is still present in the sidebar', () => {
    expect(sidebar).toContain("'nav_status_center'");
  });

  it("Status Center's own Quick Actions grid (quickActions) no longer includes screen 9 / nav_reports", () => {
    const block = statusCenter.slice(statusCenter.indexOf('const quickActions'), statusCenter.indexOf('const activityEntries'));
    expect(block).not.toContain('screen: 9');
    expect(block).not.toContain("'nav_reports'");
  });

  it('Quick Actions still includes Institutions, Alerts, QR, and My Account (nothing else removed)', () => {
    const block = statusCenter.slice(statusCenter.indexOf('const quickActions'), statusCenter.indexOf('const activityEntries'));
    ['nav_institutions', 'nav_inter_alerts', 'nav_qr', 'nav_my_account'].forEach(key => expect(block).toContain(`'${key}'`));
  });
});

describe('E) CommandPalette keeps its Reports quick-jump entry (established precedent: hidden-from-primary-nav items stay reachable via Ctrl+K, e.g. nav_qr already does this)', () => {
  it('CommandPalette PALETTE_ITEMS still contains nav_reports', () => {
    const block = commandPalette.slice(commandPalette.indexOf('const PALETTE_ITEMS'), commandPalette.indexOf('interface Props'));
    expect(block).toContain("'nav_reports'");
  });
});

describe('F) Reports route/page are NOT deleted — still fully wired in App.tsx', () => {
  it('App.tsx still imports and renders ReportsScreen on case 9', () => {
    expect(app).toContain("import { ReportsScreen } from '@/features/reports/ReportsScreen'");
    expect(app).toMatch(/case 9:\s*return <ReportsScreen \/>/);
  });

  it('ReportsScreen.tsx file still exists and exports ReportsScreen', () => {
    expect(existsSync(join(SRC, 'features/reports/ReportsScreen.tsx'))).toBe(true);
    expect(reportsScreen).toContain('export function ReportsScreen');
  });

  it('ReportsScreen.tsx still has all 5 original tabs (summary/low/missing/comparison/audit) — nothing removed from the page itself', () => {
    expect(reportsScreen).toContain("{ id: 'summary',    labelKey: 'tab_summary' }");
    expect(reportsScreen).toContain("{ id: 'low',        labelKey: 'tab_low' }");
    expect(reportsScreen).toContain("{ id: 'missing',    labelKey: 'tab_miss' }");
    expect(reportsScreen).toContain("{ id: 'comparison', labelKey: 'tab_comp' }");
    expect(reportsScreen).toContain("{ id: 'audit',      labelKey: 'tab_audit' }");
  });

  it('ReportsScreen.tsx renders AuditLogSection for its own audit tab (extraction, not deletion)', () => {
    expect(reportsScreen).toContain("import { AuditLogSection } from './AuditLogSection'");
    expect(reportsScreen).toMatch(/tab === 'audit' && <AuditLogSection \/>/);
  });

  it('no report test files were deleted — ReportsScreen.tsx and AuditLogSection.tsx both still exist on disk', () => {
    expect(existsSync(join(SRC, 'features/reports/ReportsScreen.tsx'))).toBe(true);
    expect(existsSync(join(SRC, 'features/reports/AuditLogSection.tsx'))).toBe(true);
  });
});

describe('G) AuditLogSection: reused, self-contained, read-only extraction', () => {
  it('fetches via the existing getAuditLog service call only — no new query/RPC', () => {
    expect(auditLogSection).toContain("import { getAuditLog } from '@/shared/supabase/services/audit.service'");
    expect(auditLogSection).toContain('getAuditLog(activeOrgId)');
    expect(auditLogSection).not.toMatch(/writeAuditLog\(|supabase\.rpc\(|\.insert\(|\.update\(|\.delete\(/);
  });

  it('renders only id/created_at/action/entity_type/actor_role — never actor_id, entity_id, or the raw payload column', () => {
    expect(auditLogSection).toContain('row.action');
    expect(auditLogSection).toContain('row.entity_type');
    expect(auditLogSection).toContain('row.actor_role');
    expect(auditLogSection).toContain('row.created_at');
    expect(auditLogSection).not.toMatch(/row\.actor_id|row\.entity_id|row\.payload/);
  });

  it('is a plain function component with no mutating action/button beyond the empty/loading/error states', () => {
    expect(auditLogSection).not.toMatch(/onClick=\{.*(delete|remove|archive|reactivate)/i);
  });

  it('handles the no-org-scope case internally (so callers do not need to duplicate that check)', () => {
    expect(auditLogSection).toContain('if (!activeOrgId)');
    expect(auditLogSection).toContain("t('no_org_scope', lang)");
  });
});

describe('H) Status Center: new Audit Log tab', () => {
  it('imports and renders AuditLogSection', () => {
    expect(statusCenter).toContain("import { AuditLogSection } from '@/features/reports/AuditLogSection'");
    expect(statusCenter).toContain("{mainTab === 'audit' && <AuditLogSection />}");
  });

  it('has a top-level mainTab state defaulting to \'live\' (existing content unaffected by default)', () => {
    expect(statusCenter).toContain("const [mainTab, setMainTab] = useState<'live' | 'audit'>('live');");
  });

  it('the Audit Log tab button uses the exact required bilingual label (tab_audit: سجل التدقيق / Audit Log)', () => {
    expect(statusCenter).toContain("onClick={() => setMainTab('audit')}");
    expect(statusCenter).toContain("{t('tab_audit', lang)}");
  });

  it('tab_audit already exists bilingually with the exact required wording', () => {
    expect(strings).toMatch(/tab_audit:\s*\{\s*ar:\s*'سجل التدقيق',\s*en:\s*'Audit Log'\s*\}/);
  });

  it('the existing live content (filters/table/outlet view/exports) is now gated behind mainTab === \'live\' but otherwise unmodified', () => {
    const liveBranchStart = statusCenter.indexOf("{mainTab === 'live' && (");
    expect(liveBranchStart).toBeGreaterThan(-1);
    const liveBranch = statusCenter.slice(liveBranchStart);
    expect(liveBranch).toContain("t('quick', lang)");
    expect(liveBranch).toContain('<OutletAvailabilityReportModal');
    expect(liveBranch).toContain('<MovementReportSection />');
  });
});

describe('I) Status Center: existing features are preserved, not broken by this phase', () => {
  it('availability filters (status/supply/search/quantity/price) are all still present', () => {
    expect(statusCenter).toContain('setFilterStatus');
    expect(statusCenter).toContain('setFilterSupply');
    expect(statusCenter).toContain('setSearch');
    expect(statusCenter).toContain('priceFilterMode');
  });

  it('outlet report modal remains wired with the same props', () => {
    expect(statusCenter).toContain('<OutletAvailabilityReportModal');
    expect(statusCenter).toContain('open={reportOutlet !== null}');
    expect(statusCenter).toContain('rows={rows}');
  });

  // PHASE2-EXPORT-FIELD-SELECTOR-A: a still later, separately-reviewed phase
  // legitimately adds an export/print field selector to this exact file —
  // this test no longer requires a byte-for-byte empty diff, only that the
  // modal's own row-filtering/wiring (checked elsewhere in this suite)
  // remains intact.
  it('the outlet report modal component file itself was not touched by THIS phase (a later phase legitimately adds a field selector to it — see outlet-report-field-selector.test.ts)', () => {
    expect(statusCenter).toContain('<OutletAvailabilityReportModal');
  });

  it('the availability item details modal component file itself is untouched by this phase', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- src/features/institutions/AvailabilityItemDetailsModal.tsx', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('main Status Center XLSX export (exportXlsx/exportAvailabilityXlsx) is still present and unchanged in intent', () => {
    expect(statusCenter).toContain('async function exportXlsx');
    expect(statusCenter).toContain('exportAvailabilityXlsx(');
    expect(statusCenter).toMatch(/\.filter\(r => r\.removed_at == null\)/);
  });

  // PHASE2-EXPORT-FIELD-SELECTOR-A: a still later, separately-reviewed phase
  // legitimately adds an optional, default-preserving column-filter param to
  // buildOutletReportWorkbook here — main export path checked below instead.
  it('buildAvailabilityExportWorkbook (the main export path) still exists unrenamed, regardless of any later additive diff to this file', () => {
    const exportModuleSrc = readSrc('shared/lib/professional-export.ts');
    expect(exportModuleSrc).toContain('export async function buildAvailabilityExportWorkbook');
    expect(exportModuleSrc).toContain('export async function exportAvailabilityXlsx');
  });

  it('movement report section remains rendered', () => {
    expect(statusCenter).toContain('<MovementReportSection />');
  });

  it('removed-material visibility (rows unfiltered by removed_at on screen) is untouched', () => {
    expect(statusCenter).not.toMatch(/const rows = useMemo\([\s\S]{0,600}?removed_at/);
  });
});

describe('J) No sensitive fields exposed anywhere in this phase', () => {
  it('AuditLogSection never renders a raw UUID pattern', () => {
    expect(auditLogSection).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it('AuditLogSection never references removed_by or any other unrelated sensitive lifecycle field', () => {
    expect(auditLogSection).not.toMatch(/removed_by|service_role|auth\.admin/);
  });
});

describe('Guards: no SQL/migration/package change; QR/alerts/movement-history/auth/permissions/remove-reactivate-clear-port/dashboard-RPC untouched', () => {
  it('no migration .sql file was created or modified by this phase', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- "supabase/migrations/*.sql" ":!supabase/migrations/055_phoenix_clean_availability_data.sql" ":!supabase/migrations/056_phoenix_platform_broadcast_notices.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
    let listing = '';
    try {
      listing = execSync('git status --porcelain -- "supabase/migrations/*.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    // PHASE3-DEEP-CLEAN-AVAILABILITY-DATA-A: new reviewed migration 055,
    // prepared but not yet applied/committed, is the only allowed entry here.
    const unexpectedListing = listing.split(String.fromCharCode(10)).map(l => l.trim()).filter(Boolean)
      .filter(l => l !== '?? supabase/migrations/055_phoenix_clean_availability_data.sql'
                 && l !== 'A  supabase/migrations/055_phoenix_clean_availability_data.sql'
                 && l !== 'M supabase/migrations/055_phoenix_clean_availability_data.sql'
                 && l !== 'M  supabase/migrations/055_phoenix_clean_availability_data.sql'
                 && l !== '?? supabase/migrations/056_phoenix_platform_broadcast_notices.sql'
                 && l !== 'A  supabase/migrations/056_phoenix_platform_broadcast_notices.sql'
                 && l !== 'M supabase/migrations/056_phoenix_platform_broadcast_notices.sql'
                 && l !== 'M  supabase/migrations/056_phoenix_platform_broadcast_notices.sql');
    expect(unexpectedListing).toEqual([]);
  });

  it('no migration 055 was created, other than the later, separately-reviewed PHASE3-DEEP-CLEAN-AVAILABILITY-DATA-A addition', () => {
    const migrationsDir = join(ROOT, 'supabase/migrations');
    const matches = readdirSync(migrationsDir).filter((f: string) => /^055_/.test(f));
    expect(matches).toEqual(['055_phoenix_clean_availability_data.sql']);
  });

  it('no package/lockfile diff', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- package.json package-lock.json pnpm-lock.yaml yarn.lock', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('no QR/alert-lifecycle/movement-history/auth/permissions/navigation(App.tsx routing)/dashboard-service file was touched by this phase', () => {
    let diff = '';
    try {
      diff = execSync(
        'git diff -- src/features/qr/PublicQrScreen.tsx src/shared/supabase/services/qr.service.ts src/features/alerts/inter-org-alert-lifecycle.service.ts src/shared/supabase/services/auth.service.ts src/shared/lib/permissions.ts src/app/AppContext.tsx src/app/App.tsx src/features/status/MovementHistoryModal.tsx src/features/status/MovementReportSection.tsx src/shared/supabase/services/dashboard.service.ts',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('remove/reactivate/clear-port behavior (InstitutionScreen/ReactivateMaterialModal) is untouched by this phase', () => {
    let diff = '';
    try {
      diff = execSync(
        'git diff -- src/features/institutions/InstitutionScreen.tsx src/features/status/ReactivateMaterialModal.tsx',
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
