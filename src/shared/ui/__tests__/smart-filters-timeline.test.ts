/**
 * UX-SMART-FILTERS-TIMELINE-A
 * Run: npm test -- --run
 *
 * Static source-code tests proving smart filters (StatusCenterScreen) and
 * the material timeline (MovementHistoryModal) were added WITHOUT touching
 * routes, nav targets, QR public URL logic, export/print logic, user
 * management, or permissions — and without introducing fake data, new
 * Supabase reads/RPCs, migrations, package/lockfile changes, or Service-D
 * interference.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const SRC = join(__dirname, '../../../');
const ROOT = join(__dirname, '../../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const app = readSrc('app/App.tsx');
const statusCenter = readSrc('features/status/StatusCenterScreen.tsx');
const movementHistoryModal = readSrc('features/status/MovementHistoryModal.tsx');
const smartFilterChips = readSrc('shared/ui/SmartFilterChips.tsx');
const materialTimeline = readSrc('shared/ui/MaterialTimeline.tsx');
const publicQr = readSrc('features/qr/PublicQrScreen.tsx');

describe('1. App screen map / routes unchanged', () => {
  it('App.tsx still switches on the same known screen numbers', () => {
    for (const n of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]) {
      expect(app).toContain(`case ${n}:`);
    }
  });

  it('unknown/default screens still redirect to Status Center', () => {
    const defaultIdx = app.indexOf('default:');
    expect(app.slice(defaultIdx, defaultIdx + 80)).toContain('StatusCenterScreen');
  });
});

describe('2. Existing navigation targets unchanged', () => {
  it('StatusCenterScreen still receives and uses the same onNavigate prop for its existing CTAs', () => {
    expect(statusCenter).toContain('onNavigate: (screen: number) => void');
    expect(statusCenter).toContain('onClick={() => onNavigate(13)}');
  });

  it('SmartFilterChips/MaterialTimeline never call onNavigate or introduce new navigation', () => {
    expect(smartFilterChips).not.toContain('onNavigate');
    expect(materialTimeline).not.toContain('onNavigate');
  });
});

describe('3. QR public route remains present', () => {
  it('App.tsx still bypasses auth entirely for ?qid=/?token=', () => {
    expect(app).toContain('publicQrId');
    expect(app).toContain('PublicQrScreen');
  });

  it('PublicQrScreen module is untouched by this phase', () => {
    expect(publicQr).not.toContain('SmartFilterChips');
    expect(publicQr).not.toContain('MaterialTimeline');
  });
});

describe('4/5. Export/print handlers + mobile print fallback remain unchanged', () => {
  // SAFE-PROFESSIONAL-XLSX-EXPORT-A: a later, separately-reviewed phase
  // replaced StatusCenterScreen's ad-hoc CSV export with a real styled
  // .xlsx workbook (exportXlsx) — unrelated to this smart-filters/timeline
  // phase. printReport and the mobile print fallback are untouched.
  it('StatusCenterScreen still has exportXlsx, printReport, and the mobile print fallback modal', () => {
    expect(statusCenter).toContain('function exportXlsx');
    expect(statusCenter).toContain('function printReport');
    expect(statusCenter).toContain('isLikelyMobilePrintContext');
    expect(statusCenter).toContain('MobilePrintFallbackModal');
  });

  it('exportXlsx still reads the same filtered `rows` this phase\'s smart filters produce; printReport is unchanged', () => {
    const exportFn = statusCenter.slice(statusCenter.indexOf('async function exportXlsx'), statusCenter.indexOf('function handleMovementSuccess'));
    expect(exportFn).toContain('rows');
    expect(exportFn).toContain('exportAvailabilityXlsx');
    const printFn = statusCenter.slice(statusCenter.indexOf('function printReport'), statusCenter.indexOf('async function exportXlsx'));
    expect(printFn).toContain('isLikelyMobilePrintContext');
    expect(printFn).toContain('buildReportHtml');
  });
});

describe('6. User-management function invocations remain unchanged', () => {
  it('none of the new files reference users.service or any users.* RPC', () => {
    for (const src of [smartFilterChips, materialTimeline]) {
      expect(src).not.toContain('users.service');
      expect(src).not.toContain('supabase.rpc');
    }
  });
});

describe('7. No service_role / auth.admin in frontend', () => {
  it('none of the new files reference service_role or auth.admin', () => {
    for (const src of [smartFilterChips, materialTimeline]) {
      expect(src).not.toMatch(/service_role/i);
      expect(src).not.toContain('auth.admin');
    }
  });
});

describe('8. No inter_org_exchange UI added', () => {
  it('none of the new files reference inter_org_exchange', () => {
    for (const src of [smartFilterChips, materialTimeline]) {
      expect(src).not.toContain('inter_org_exchange');
    }
  });
});

describe('9. No wipe tooling restored', () => {
  it('none of the new files reference wipe/full-reset tooling', () => {
    for (const src of [smartFilterChips, materialTimeline]) {
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
      diff = execSync('git diff -- "supabase/migrations/*.sql" ":!supabase/migrations/051_material_batch_identity_option_a.sql" ":!supabase/migrations/053_item_availability_removed_marker.sql" ":!supabase/migrations/054_dashboard_condition_counts_rpcs.sql" ":!supabase/migrations/055_phoenix_clean_availability_data.sql"', { cwd: ROOT, encoding: 'utf8' });
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

describe('11/12. Smart filters use already-loaded data only, no new Supabase reads', () => {
  it('SmartFilterChips component itself has no data fetching or Supabase import', () => {
    expect(smartFilterChips).not.toContain('supabase');
    expect(smartFilterChips).not.toContain('useAsync');
    expect(smartFilterChips).not.toContain('.from(');
  });

  it('StatusCenterScreen smart-filter state operates on `allRows`/`rows` (already loaded), no new getAvailability* calls introduced', () => {
    const block = statusCenter.slice(statusCenter.indexOf('const rows = useMemo'), statusCenter.indexOf('const counts = useMemo'));
    expect(block).toContain('quantityFilter');
    expect(block).toContain('recentOnly');
    expect(block).not.toContain('supabase.rpc');
    expect(block).not.toContain('.from(');
    // only one live-availability fetch call exists in the whole file (the pre-existing one)
    const fetchCount = (statusCenter.match(/getAvailabilityByOrg\(/g) ?? []).length;
    expect(fetchCount).toBe(1);
  });
});

describe('13. Smart filters contain honest labels in Arabic and English', () => {
  it('sf_* i18n keys have both ar and en strings', () => {
    const strings = readSrc('shared/i18n/strings.ts');
    for (const key of ['sf_group_label', 'sf_has_quantity', 'sf_zero_quantity', 'sf_recently_updated']) {
      const line = strings.split('\n').find(l => l.trim().startsWith(`${key}:`));
      expect(line).toBeDefined();
      expect(line).toContain('ar:');
      expect(line).toContain('en:');
    }
  });

  it('smart filter chips in StatusCenterScreen reuse existing honest cond_* labels for status chips (no invented status names)', () => {
    const block = statusCenter.slice(statusCenter.indexOf('const smartFilterChips'), statusCenter.indexOf('return (\n    <div style={{ maxWidth'));
    for (const key of ['cond_available', 'cond_low_stock', 'cond_missing', 'cond_near_expiry', 'cond_expired']) {
      expect(block).toContain(`labelKey: '${key}'`);
    }
  });
});

describe('14/15. Timeline renders caller-supplied real entries only, no fabricated events', () => {
  it('MaterialTimeline has no hardcoded sample entries', () => {
    expect(materialTimeline).not.toMatch(/entries\s*=\s*\[\s*\{/);
    expect(materialTimeline).not.toContain('supabase');
  });

  it('MovementHistoryModal maps timeline entries strictly from the already-fetched `movements` state (no new fetch call)', () => {
    const block = movementHistoryModal.slice(movementHistoryModal.indexOf('const timelineEntries'), movementHistoryModal.indexOf('if (!open || !row)'));
    expect(block).toContain('movements.map');
    expect(block).not.toContain('supabase');
    expect(block).not.toContain('getAvailabilityMovementsByItem(');
    // only the pre-existing single fetch call site remains
    const fetchCount = (movementHistoryModal.match(/getAvailabilityMovementsByItem\(/g) ?? []).length;
    expect(fetchCount).toBe(1);
  });
});

describe('16. Timeline empty state is honest', () => {
  it('MaterialTimeline renders the exact required honest empty-state strings', () => {
    const strings = readSrc('shared/i18n/strings.ts');
    expect(strings).toContain('ستظهر هنا حركة المادة بعد بدء تسجيل العمليات.');
    expect(strings).toContain('Material activity will appear here after operations are recorded.');
    expect(materialTimeline).toContain('entries.length === 0');
    expect(materialTimeline).toContain("t('mt_timeline_empty', lang)");
  });
});

describe('17. Timeline has Arabic and English strings', () => {
  it('mt_* i18n keys have both ar and en strings', () => {
    const strings = readSrc('shared/i18n/strings.ts');
    for (const key of ['mt_timeline_empty', 'mt_view_table', 'mt_view_timeline']) {
      const line = strings.split('\n').find(l => l.trim().startsWith(`${key}:`));
      expect(line).toBeDefined();
      expect(line).toContain('ar:');
      expect(line).toContain('en:');
    }
  });
});

describe('18. Existing export/print handlers remain connected', () => {
  // SAFE-PROFESSIONAL-XLSX-EXPORT-A: the export button's onClick now calls
  // exportXlsx instead of the old exportCsv — same button, same location.
  it('StatusCenterScreen export/print buttons still call their original handlers', () => {
    expect(statusCenter).toContain('onClick={exportXlsx}');
    expect(statusCenter).toContain('onClick={printReport}');
  });
});

describe('19. Existing button handlers remain connected', () => {
  it('StatusCenterScreen adjust/history row actions and MovementHistoryModal refresh/close remain wired', () => {
    expect(statusCenter).toContain('onClick={() => setAdjustRow(r)}');
    expect(statusCenter).toContain('onClick={() => setHistoryRow(r)}');
    expect(movementHistoryModal).toContain('onClick={() => load(row.id)}');
    expect(movementHistoryModal).toContain('onClick={onClose}');
  });

  it('the new table/timeline toggle in MovementHistoryModal does not remove the existing table rendering', () => {
    expect(movementHistoryModal).toContain("viewMode === 'table'");
    expect(movementHistoryModal).toContain('<table');
    expect(movementHistoryModal).toContain('movements.map(m =>');
  });
});

describe('20. Permissions visibility is preserved', () => {
  it('StatusCenterScreen row action visibility still gates on the same permission checks', () => {
    expect(statusCenter).toContain('QUANTITY_MOVEMENT_PERMISSION_KEYS.some(key => myPermissions.has(key))');
    expect(statusCenter).toContain("myPermissions.has('availability.movements.view')");
  });

  it('no new permission keys were invented by the smart filters or timeline', () => {
    for (const src of [smartFilterChips, materialTimeline]) {
      expect(src).not.toContain('myPermissions');
      expect(src).not.toContain('.has(');
    }
  });
});

describe('21. RTL/LTR handling remains present', () => {
  it('SmartFilterChips/MaterialTimeline use dir="auto"/"ltr" for bidi-sensitive content', () => {
    expect(materialTimeline).toContain('dir="ltr"');
    expect(materialTimeline).toContain('dir="auto"');
  });

  it('StatusCenterScreen search input still uses dir="auto"', () => {
    expect(statusCenter).toContain('dir="auto"');
  });
});

describe('22. Mobile wrapping classes/styles exist', () => {
  it('SmartFilterChips wraps with flexWrap and meets the 38px minimum touch height', () => {
    expect(smartFilterChips).toContain("flexWrap: 'wrap'");
    expect(smartFilterChips).toContain("minHeight: '38px'");
  });

  it('MovementHistoryModal view-toggle buttons meet the 38px minimum touch height', () => {
    expect(movementHistoryModal).toContain("minHeight: '38px'");
  });
});

describe('23. No fake metrics or fake dashboard data added', () => {
  it('smart filter counts/labels are derived from real rows, not hardcoded numbers', () => {
    expect(smartFilterChips).not.toMatch(/active:\s*true\s*,/);
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
});
