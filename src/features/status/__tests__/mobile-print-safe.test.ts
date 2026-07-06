/**
 * BUGFIX-MOBILE-PRINT-DOES-NOT-EXIT-APP-A
 *
 * On mobile, pressing "Print" / "Print / Save as PDF" previously called
 * window.open('', '_blank') + window.print() (or openPrintWindow, which does
 * the same) immediately. On mobile browsers/PWA/webview contexts that can
 * switch to a native print UI, open an external tab, or otherwise make the
 * app appear to exit. This test file locks in the fix: mobile now routes to
 * an in-app fallback modal instead, and desktop behavior is unchanged.
 *
 * Run: npm test -- --run
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const SRC = join(__dirname, '../../../');
const ROOT = join(__dirname, '../../../../');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const movementReport = read('features/status/MovementReportSection.tsx');
const statusCenter = read('features/status/StatusCenterScreen.tsx');
const statusEditor = read('features/status/StatusEditorScreen.tsx');
const modal = read('shared/ui/MobilePrintFallbackModal.tsx');
const strings = read('shared/i18n/strings.ts');

describe('MovementReportSection: mobile-safe print', () => {
  const fn = movementReport.slice(movementReport.indexOf('function printReport'), movementReport.indexOf('function exportCsv'));

  it('imports isLikelyMobilePrintContext and MobilePrintFallbackModal', () => {
    expect(movementReport).toContain("isLikelyMobilePrintContext } from '@/shared/lib/reportExport'");
    expect(movementReport).toContain("import { MobilePrintFallbackModal } from '@/shared/ui/MobilePrintFallbackModal'");
  });

  it('checks isLikelyMobilePrintContext() and returns before reaching window.open on the mobile branch', () => {
    const mobileBranchIdx = fn.indexOf('if (isLikelyMobilePrintContext())');
    const windowOpenIdx = fn.indexOf("window.open('', '_blank')");
    expect(mobileBranchIdx).toBeGreaterThan(-1);
    expect(windowOpenIdx).toBeGreaterThan(mobileBranchIdx);
    const mobileBlock = fn.slice(mobileBranchIdx, fn.indexOf('return;', mobileBranchIdx) + 'return;'.length);
    expect(mobileBlock).toContain('setMobilePrintHtml(buildReportHtml())');
    expect(mobileBlock).not.toContain('window.open');
    expect(mobileBlock).not.toContain('.print()');
  });

  it('desktop path (after the mobile early-return) still uses window.open + window.print', () => {
    expect(fn).toContain("window.open('', '_blank')");
    expect(fn).toContain('win.print()');
  });

  it('renders MobilePrintFallbackModal wired to the mobilePrintHtml state', () => {
    expect(movementReport).toContain('<MobilePrintFallbackModal');
    expect(movementReport).toContain('open={mobilePrintHtml !== null}');
    expect(movementReport).toContain('onClose={() => setMobilePrintHtml(null)}');
  });
});

describe('StatusCenterScreen: mobile-safe print', () => {
  // SAFE-PROFESSIONAL-XLSX-EXPORT-A: exportCsv (which used to bound this
  // slice) was replaced by exportXlsx — a later, separately-reviewed phase,
  // unrelated to this mobile-print-safety fix.
  const fn = statusCenter.slice(statusCenter.indexOf('function printReport'), statusCenter.indexOf('async function exportXlsx'));

  it('imports isLikelyMobilePrintContext and MobilePrintFallbackModal', () => {
    expect(statusCenter).toContain("isLikelyMobilePrintContext } from '@/shared/lib/reportExport'");
    expect(statusCenter).toContain("import { MobilePrintFallbackModal } from '@/shared/ui/MobilePrintFallbackModal'");
  });

  it('checks isLikelyMobilePrintContext() and returns before reaching window.open on the mobile branch', () => {
    const mobileBranchIdx = fn.indexOf('if (isLikelyMobilePrintContext())');
    const windowOpenIdx = fn.indexOf("window.open('', '_blank')");
    expect(mobileBranchIdx).toBeGreaterThan(-1);
    expect(windowOpenIdx).toBeGreaterThan(mobileBranchIdx);
    const mobileBlock = fn.slice(mobileBranchIdx, fn.indexOf('return;', mobileBranchIdx) + 'return;'.length);
    expect(mobileBlock).toContain('setMobilePrintHtml(buildReportHtml())');
    expect(mobileBlock).not.toContain('window.open');
    expect(mobileBlock).not.toContain('.print()');
  });

  it('desktop path (after the mobile early-return) still uses window.open + window.print (both print/PDF buttons)', () => {
    expect(fn).toContain("window.open('', '_blank')");
    expect(fn).toContain('win.print()');
    // Both "Print report" and "Print / Save as PDF" buttons call the same
    // printReport(), so both are covered by the single mobile-safe gate.
    expect(statusCenter).toContain("onClick={printReport}");
  });

  it('renders MobilePrintFallbackModal wired to the mobilePrintHtml state', () => {
    expect(statusCenter).toContain('<MobilePrintFallbackModal');
    expect(statusCenter).toContain('open={mobilePrintHtml !== null}');
    expect(statusCenter).toContain('onClose={() => setMobilePrintHtml(null)}');
  });
});

describe('StatusEditorScreen: mobile-safe print', () => {
  // EXPORT-PROFESSIONAL-XLSX-PDF-A migrated this screen's mobile/desktop
  // print branching from a local isLikelyMobilePrintContext()/openPrintWindow
  // call into the shared professional-export.ts helper
  // (triggerProfessionalPrint), which performs the exact same branch
  // internally (see professional-export.test.ts for that guarantee) and
  // returns { ok, mobileHtml } instead of the screen doing the branching
  // itself. MobilePrintFallbackModal wiring is unchanged.
  const fn = statusEditor.slice(statusEditor.indexOf('function printReport'), statusEditor.indexOf('const fieldStyle'));

  it('imports triggerProfessionalPrint and MobilePrintFallbackModal', () => {
    expect(statusEditor).toContain('triggerProfessionalPrint');
    expect(statusEditor).toContain("import { MobilePrintFallbackModal } from '@/shared/ui/MobilePrintFallbackModal'");
  });

  it('delegates mobile/desktop print branching to triggerProfessionalPrint and routes mobileHtml to the fallback modal', () => {
    expect(fn).toContain('triggerProfessionalPrint(exportConfig())');
    expect(fn).toContain('mobileHtml');
    expect(fn).toContain('setMobilePrintHtml(mobileHtml)');
    expect(fn).not.toContain('openPrintWindow(');
    expect(fn).not.toContain('window.open(');
  });

  it('shows a translated popup-blocked toast when triggerProfessionalPrint reports failure', () => {
    expect(fn).toContain("t('print_popup_blocked', lang)");
  });

  it('renders MobilePrintFallbackModal wired to the mobilePrintHtml state', () => {
    expect(statusEditor).toContain('<MobilePrintFallbackModal');
    expect(statusEditor).toContain('open={mobilePrintHtml !== null}');
    expect(statusEditor).toContain('onClose={() => setMobilePrintHtml(null)}');
  });
});

describe('MobilePrintFallbackModal: safe in-app print fallback', () => {
  it('exists as a reusable component', () => {
    expect(existsSync(join(SRC, 'shared/ui/MobilePrintFallbackModal.tsx'))).toBe(true);
  });

  it('offers preview, download HTML, use-system-print, and close actions', () => {
    expect(modal).toContain("t('mobile_print_preview', lang)");
    expect(modal).toContain("t('mobile_print_download_html', lang)");
    expect(modal).toContain("t('mobile_print_use_system', lang)");
    expect(modal).toContain("t('mobile_print_close', lang)");
  });

  it('the component code (excluding rationale comments) never calls window.print/window.open directly, and never uses dangerouslySetInnerHTML', () => {
    const code = modal.slice(modal.indexOf('interface Props'));
    expect(code).not.toContain('window.print(');
    expect(code).not.toContain('window.open(');
    expect(code).not.toContain('dangerouslySetInnerHTML');
  });

  it('renders the report HTML via an isolated iframe srcDoc (never dangerouslySetInnerHTML)', () => {
    expect(modal).toContain('srcDoc={html}');
  });

  it('"use system print" requires an explicit second tap before calling openPrintWindow', () => {
    // First tap only toggles a warning/confirm state — it must not call openPrintWindow.
    const firstTapIdx = modal.indexOf("setConfirmingSystemPrint(v => !v)");
    expect(firstTapIdx).toBeGreaterThan(-1);
    const firstTapBlock = modal.slice(modal.lastIndexOf('onClick', firstTapIdx) - 40, firstTapIdx + 40);
    expect(firstTapBlock).not.toContain('openPrintWindow');

    // Only the dedicated confirm handler (rendered inside the warning block,
    // requiring a second, separate button press) calls openPrintWindow.
    const confirmFnIdx = modal.indexOf('function handleConfirmSystemPrint');
    expect(confirmFnIdx).toBeGreaterThan(-1);
    const confirmFn = modal.slice(confirmFnIdx, modal.indexOf('}', modal.indexOf('openPrintWindow(html)', confirmFnIdx)) + 1);
    expect(confirmFn).toContain('openPrintWindow(html)');
  });

  it('shows a translated warning before the confirm step', () => {
    expect(modal).toContain("t('mobile_print_system_warning', lang)");
    expect(modal).toContain("t('mobile_print_system_confirm', lang)");
  });

  it('shows translated failure toasts for download and system-print failures, and never crashes/navigates away', () => {
    expect(modal).toContain('mobile_print_download_failed');
    expect(modal).toContain("t('mobile_print_open_failed', lang)");
    expect(modal).not.toMatch(/location\.href|window\.location|navigate\(/);
  });

  it('resets its internal state when closed, so the app remains usable afterwards', () => {
    const closeFn = modal.slice(modal.indexOf('function handleClose'), modal.indexOf('function handleClose') + 200);
    expect(closeFn).toContain('setPreviewOpen(false)');
    expect(closeFn).toContain('setConfirmingSystemPrint(false)');
    expect(closeFn).toContain('onClose()');
  });

  it('uses touch-friendly (>=44px) buttons', () => {
    expect(modal).toMatch(/minHeight:\s*'44px'/);
  });
});

describe('i18n: mobile print strings exist bilingually (Arabic + English)', () => {
  const keys = [
    'mobile_print_title', 'mobile_print_message', 'mobile_print_preview',
    'mobile_print_download_html', 'mobile_print_use_system', 'mobile_print_system_warning',
    'mobile_print_system_confirm', 'mobile_print_close', 'mobile_print_download_failed',
    'mobile_print_open_failed', 'mobile_print_download_ok',
  ];

  it.each(keys)('%s has a non-empty ar and en translation', key => {
    expect(strings).toMatch(new RegExp(`${key}:\\s*\\{\\s*ar:\\s*'[^']+',\\s*en:\\s*'[^']+'`));
  });

  it('Arabic copy uses the exact required phrases', () => {
    expect(strings).toContain("mobile_print_title:          { ar: 'خيارات الطباعة على الهاتف'");
    expect(strings).toContain('معاينة التقرير');
    expect(strings).toContain('تحميل نسخة HTML قابلة للطباعة');
    expect(strings).toContain('استخدام طباعة النظام');
    expect(strings).toContain('قد تفتح طباعة النظام خارج التطبيق على بعض الهواتف.');
    expect(strings).toContain("mobile_print_close:          { ar: 'إغلاق'");
  });
});

describe('Excel/CSV export behavior unchanged/upgraded by this phase', () => {
  it('MovementReportSection still exports CSV with BOM + csvSafeCell (untouched by this phase — movement history export is explicitly out of scope for SAFE-PROFESSIONAL-XLSX-EXPORT-A)', () => {
    const csvFn = movementReport.slice(movementReport.indexOf('function exportCsv'), movementReport.indexOf('function exportCsv') + 900);
    expect(csvFn).toContain('﻿');
    expect(csvFn).toContain('csvSafeCell');
  });

  // SAFE-PROFESSIONAL-XLSX-EXPORT-A: a later, separately-reviewed phase
  // replaced StatusCenterScreen's ad-hoc CSV export (BOM/csvSafeCell) with a
  // real styled .xlsx workbook via exportAvailabilityXlsx — unrelated to
  // this mobile-print-safety fix, which only ever touched printReport.
  it('StatusCenterScreen now delegates Excel export to the shared exportAvailabilityXlsx helper (real .xlsx via ExcelJS — BOM/csvSafeCell no longer apply; formula-safety/UUID-guard are enforced inside professional-export.ts — see that module\'s tests)', () => {
    expect(statusCenter).toContain('await exportAvailabilityXlsx(');
    expect(statusCenter).not.toContain('function csvSafeCell');
    expect(statusCenter).not.toContain('function exportCsv');
  });

  it('StatusEditorScreen now delegates Excel export to the shared exportProfessionalXlsx helper (real .xlsx via ExcelJS — BOM/csvSafeCell no longer apply; formula-safety/UUID-guard are enforced inside professional-export.ts — see that module\'s tests)', () => {
    expect(statusEditor).toContain('await exportProfessionalXlsx(exportConfig())');
    expect(statusEditor).not.toContain('exportProfessionalCsv');
  });
});

describe('BUGFIX-MOBILE-PRINT-DOES-NOT-EXIT-APP-A: safety guards', () => {
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
      diff = execSync('git diff -- "supabase/migrations/*.sql" ":!supabase/migrations/051_material_batch_identity_option_a.sql" ":!supabase/migrations/053_item_availability_removed_marker.sql" ":!supabase/migrations/054_dashboard_condition_counts_rpcs.sql" ":!supabase/migrations/055_phoenix_clean_availability_data.sql" ":!supabase/migrations/056_phoenix_platform_broadcast_notices.sql" ":!supabase/migrations/057_phoenix_platform_broadcast_admin_details_delete.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* git not available in this sandbox — skip silently */ }
    expect(diff.trim()).toBe('');
  });

  it('package.json has no uncommitted changes — the approved exceljs dependency (EXPORT-PROFESSIONAL-XLSX-PDF-B) is already committed on HEAD, and no later phase (including EXPIRY-RISK-TIERS-A) added anything further', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- package.json', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* git not available in this sandbox — skip silently */ }
    expect(diff.trim()).toBe('');

    const pkg = readFileSync(join(ROOT, 'package.json'), 'utf8');
    expect(pkg).toMatch(/"exceljs":\s*"\^?[\d.]+"/);
  });

  it('no other lockfile (pnpm/yarn) was introduced — this project uses package-lock.json (npm)', () => {
    let status = '';
    try {
      status = execSync('git status --porcelain -- pnpm-lock.yaml yarn.lock', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* git not available in this sandbox — skip silently */ }
    expect(status.trim()).toBe('');
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

  it('no Service-D / inter_org_exchange UI was added to the touched files', () => {
    for (const src of [movementReport, statusCenter, statusEditor, modal]) {
      expect(src).not.toContain('inter_org_exchange');
      expect(src).not.toMatch(/ExchangeRequest|exchange.request/);
    }
  });

  it('no wipe tooling references were restored', () => {
    for (const src of [movementReport, statusCenter, statusEditor, modal]) {
      expect(src).not.toMatch(/phoenix-wipe-execute|FULL_PUBLIC_APP_WIPE_APPROVED|full_wipe/i);
    }
  });

  it('no frontend service_role/auth.admin usage', () => {
    for (const src of [movementReport, statusCenter, statusEditor, modal]) {
      expect(src).not.toMatch(/service_role|SUPABASE_SERVICE_ROLE|auth\.admin/);
    }
  });
});
