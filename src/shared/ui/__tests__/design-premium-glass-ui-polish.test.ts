/**
 * DESIGN-PREMIUM-GLASS-UI-POLISH-A
 *
 * This phase is CSS/className-only polish on top of the pre-existing premium
 * design system (see premium-visual-system.test.ts). It extends the already-
 * built glass/depth/3D tokens to a few remaining screens (empty states,
 * public QR page, outlet material rows, action bars) without touching any
 * routing, RPC, permission, CSV/print, or QR business logic.
 *
 * These tests prove: (a) the new design classes exist and are wired where
 * expected, and (b) nothing load-bearing (routes, nav targets, QR route,
 * export/print handlers, user-management edge-function calls, permission
 * checks) was touched by this phase.
 *
 * Run: npm test -- --run
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const SRC = join(__dirname, '../../../');
const ROOT = join(__dirname, '../../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const app = readSrc('app/App.tsx');
const emptyState = readSrc('shared/ui/PhoenixEmptyState.tsx');
const publicQr = readSrc('features/qr/PublicQrScreen.tsx');
const qrScreen = readSrc('features/qr/QrScreen.tsx');
const institution = readSrc('features/institutions/InstitutionScreen.tsx');
const statusCenter = readSrc('features/status/StatusCenterScreen.tsx');
const statusEditor = readSrc('features/status/StatusEditorScreen.tsx');
const movementReport = readSrc('features/status/MovementReportSection.tsx');
const outletGroups = readSrc('features/status/OutletMaterialGroups.tsx');
const usersScreen = readSrc('features/users/UserManagementScreen.tsx');
const usersService = readSrc('shared/supabase/services/users.service.ts');
const css = readSrc('shared/lib/global.css');

describe('1. Route paths (screen-number switch) were not changed', () => {
  it('App.tsx still maps the same screen numbers to the same components', () => {
    const expected: [number, string][] = [
      [3, 'EditorScreen'], [4, 'RegistryScreen'], [5, 'MeshScreen'], [6, 'QrScreen'],
      [7, 'HealthScreen'], [8, 'IntakeFrozenScreen'], [9, 'ReportsScreen'],
      [10, 'MobileCommandScreen'], [11, 'InstitutionScreen'], [12, 'StatusCenterScreen'],
      [13, 'InterInstitutionAlertsScreen'], [14, 'UserManagementScreen'],
      [15, 'MyAccountScreen'], [16, 'StatusEditorScreen'],
    ];
    for (const [num, component] of expected) {
      expect(app).toContain(`case ${num}:`);
      const idx = app.indexOf(`case ${num}:`);
      expect(app.slice(idx, idx + 80)).toContain(component);
    }
  });

  it('the initial/default screen (Status Center, 12) is unchanged', () => {
    expect(app).toContain('useState(12)');
  });
});

describe('2. Navigation link targets were not changed', () => {
  it('the "Open Exchange Center" navigation target (screen 13) is unchanged', () => {
    expect(statusCenter).toContain('onNavigate(13)');
  });
});

describe('3. QR public route/link remains present and unchanged', () => {
  it('App.tsx still reads ?qid=/?token= from the URL for the anonymous public QR route', () => {
    expect(app).toContain("params.get('qid')");
    expect(app).toContain("params.get('token')");
    expect(app).toContain('PublicQrScreen');
  });

  it('PublicQrScreen still calls getPublicQrPayload(publicId) — no new data source', () => {
    expect(publicQr).toContain('getPublicQrPayload(publicId)');
  });

  it('PublicQrScreen visual polish is additive (className only) around the existing structure', () => {
    expect(publicQr).toContain('premium-qr-public-shell');
    expect(publicQr).toContain('premium-qr-trust-note');
    // The trust/no-internal-IDs note text itself is unchanged.
    expect(publicQr).toContain("t('qr_no_expose', lang)");
  });
});

describe('4. CSV export helper remains unchanged', () => {
  it('reportExport.ts (buildCsvContent/csvSafeCell) was not touched by this phase', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- src/shared/lib/reportExport.ts', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });
});

describe('5. Mobile print fallback remains present', () => {
  it('MobilePrintFallbackModal.tsx was not touched by this phase', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- src/shared/ui/MobilePrintFallbackModal.tsx', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('StatusCenterScreen/MovementReportSection/StatusEditorScreen still wire MobilePrintFallbackModal', () => {
    for (const src of [statusCenter, movementReport, statusEditor]) {
      expect(src).toContain('MobilePrintFallbackModal');
    }
  });
});

describe('6. User management function invocations remain unchanged', () => {
  it('users.service.ts still exports the same user-lifecycle functions (later phases may add read-only helpers additively, e.g. UX-WHATSAPP-ALERT-CONTACT-WIRING-A\'s getOrgStatusContactsForOrgs, without touching this logic)', () => {
    for (const fn of [
      'export async function listUsers', 'export async function getEffectivePermissions',
      'export async function assignProfilePermissions', 'export async function resetProfilePermissions',
      'export async function createUserViaEdge', 'export async function disableUserViaEdge',
      'export async function enableUserViaEdge', 'export async function recycleUserViaEdge',
      'export async function rotatePasswordViaEdge', 'export async function getOrgStatusContacts(',
    ]) {
      expect(usersService).toContain(fn);
    }
  });

  it('UserManagementScreen.tsx still invokes the same user-management functions (later phases may add UI additively, e.g. UX-WHATSAPP-INSTITUTION-CONTACT-A\'s ContactSection button, without touching this logic)', () => {
    for (const fn of [
      'createUserViaEdge', 'disableUserViaEdge', 'enableUserViaEdge',
      'recycleUserViaEdge', 'rotatePasswordViaEdge',
      'assignProfilePermissions', 'resetProfilePermissions', 'listUsers', 'getEffectivePermissions',
    ]) {
      expect(usersScreen).toContain(fn);
    }
  });

  it('createUserViaEdge/disableUserViaEdge/enableUserViaEdge/rotatePasswordViaEdge still call supabase.functions.invoke', () => {
    for (const fn of ['admin-create-user', 'admin-user-lifecycle']) {
      expect(usersService).toContain(`supabase.functions.invoke('${fn}'`);
    }
    expect(usersScreen).toContain('createUserViaEdge');
    expect(usersScreen).toContain('rotatePasswordViaEdge');
  });
});

describe('7. No service_role/auth.admin in frontend', () => {
  it('every file touched by this phase is free of service_role/auth.admin', () => {
    for (const src of [emptyState, publicQr, institution, statusCenter, statusEditor, movementReport, outletGroups, css]) {
      expect(src).not.toMatch(/service_role|SUPABASE_SERVICE_ROLE|auth\.admin/);
    }
  });
});

describe('8. No inter_org_exchange UI added', () => {
  it('every file touched by this phase is free of inter_org_exchange', () => {
    for (const src of [emptyState, publicQr, institution, statusCenter, statusEditor, movementReport, outletGroups, css]) {
      expect(src).not.toContain('inter_org_exchange');
    }
  });
});

describe('9. No wipe tooling restored', () => {
  it('every file touched by this phase is free of wipe-tooling references', () => {
    for (const src of [emptyState, publicQr, institution, statusCenter, statusEditor, movementReport, outletGroups, css]) {
      expect(src).not.toMatch(/phoenix-wipe-execute|FULL_PUBLIC_APP_WIPE_APPROVED|full_wipe/i);
    }
  });
});

describe('10. No package/lockfile/migration changes', () => {
  it('no package/lockfile diff beyond the explicitly approved exceljs addition (EXPORT-PROFESSIONAL-XLSX-PDF-B)', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- package.json', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    const added = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
    const removed = diff.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---'));
    expect(removed.length).toBe(0);
    expect(added.every(l => /"exceljs":/.test(l))).toBe(true);

    let lockStatus = '';
    try {
      lockStatus = execSync('git status --porcelain -- pnpm-lock.yaml yarn.lock', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(lockStatus.trim()).toBe('');
  });

  // REFRESH-MIGRATION-051-DIFF-GUARDS-A: 051_material_batch_identity_option_a.sql
  // is excluded from the diff check because a later, separately-reviewed
  // phase (FIX-MIGRATION-051-IMMUTABLE-EXPIRY-DATE-A) legitimately corrects
  // it in-place before its first successful manual apply.
  it('no existing migration SQL was modified (other than the already-approved 051 immutable-expiry-date fix), and no unreviewed migration SQL was created — only the separately-reviewed migration 045 (DB-MY-ACCOUNT-WHATSAPP-RPC-A) is allowed as an untracked addition (test-only maintenance under supabase/migrations/__tests__/ is not a migration SQL change; 044 is already committed and no longer appears here)', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- "supabase/migrations/*.sql" ":!supabase/migrations/051_material_batch_identity_option_a.sql" ":!supabase/migrations/053_item_availability_removed_marker.sql" ":!supabase/migrations/054_dashboard_condition_counts_rpcs.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
    let status = '';
    try {
      status = execSync('git status --porcelain -- "supabase/migrations/*.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    const ALLOWED_UNTRACKED = new Set([
      '?? supabase/migrations/045_phoenix_update_my_whatsapp_phone_rpc.sql',
      'A  supabase/migrations/045_phoenix_update_my_whatsapp_phone_rpc.sql',
      '?? supabase/migrations/046_phoenix_set_my_org_whatsapp_contact_rpc.sql',
      'A  supabase/migrations/046_phoenix_set_my_org_whatsapp_contact_rpc.sql',
      '?? supabase/migrations/047_phoenix_live_alerts_contact_fields.sql',
      'A  supabase/migrations/047_phoenix_live_alerts_contact_fields.sql',
      '?? supabase/migrations/048_live_alerts_expiry_risk_tiers.sql',
      'A  supabase/migrations/048_live_alerts_expiry_risk_tiers.sql',
      '?? supabase/migrations/049_add_national_code_to_item_availability.sql',
      'A  supabase/migrations/049_add_national_code_to_item_availability.sql',
      '?? supabase/migrations/050_phoenix_upsert_availability_national_code.sql',
      'A  supabase/migrations/050_phoenix_upsert_availability_national_code.sql',
      '?? supabase/migrations/051_material_batch_identity_option_a.sql',
      'A  supabase/migrations/051_material_batch_identity_option_a.sql',
      // Trimmed forms of " M ..." (unstaged modify) / "M  ..." (staged modify) —
      // status.split('\n').map(l => l.trim()) strips only the leading char.
      'M supabase/migrations/051_material_batch_identity_option_a.sql',
      'M  supabase/migrations/051_material_batch_identity_option_a.sql',
      // QR-EFFECTIVE-CONDITION-QUANTITY-ZERO-052-A: new reviewed migration,
      // prepared but not yet applied/committed.
      '?? supabase/migrations/052_qr_effective_condition_quantity_zero.sql',
      'A  supabase/migrations/052_qr_effective_condition_quantity_zero.sql',
      // DB-REMOVED-OUTLET-MATERIAL-MARKER-053-A: new reviewed migration,
      // prepared but not yet applied/committed.
      '?? supabase/migrations/053_item_availability_removed_marker.sql',
      'A  supabase/migrations/053_item_availability_removed_marker.sql',
      // FIX-MIGRATION-053-REMOVED-BY-FK-A: 053 corrected in-place before its
      // first successful manual apply (removed_by FK creation/verification
      // fix), same pattern as the 051 immutable-expiry-date correction.
      'M supabase/migrations/053_item_availability_removed_marker.sql',
      'M  supabase/migrations/053_item_availability_removed_marker.sql',
      // PHASE2-DASHBOARD-PERFORMANCE-RPCS-054-A: new reviewed migration,
      // prepared but not yet applied/committed.
      '?? supabase/migrations/054_dashboard_condition_counts_rpcs.sql',
      'A  supabase/migrations/054_dashboard_condition_counts_rpcs.sql',
      // HARDEN-MIGRATION-054-NULL-ROLE-FAIL-CLOSED-A: 054 corrected in-place
      // before its first successful manual apply, same pattern as 051/053.
      'M supabase/migrations/054_dashboard_condition_counts_rpcs.sql',
      'M  supabase/migrations/054_dashboard_condition_counts_rpcs.sql',
      // PHASE3-DEEP-CLEAN-AVAILABILITY-DATA-A: new reviewed migration,
      // prepared but not yet applied/committed.
      '?? supabase/migrations/055_phoenix_clean_availability_data.sql',
      'A  supabase/migrations/055_phoenix_clean_availability_data.sql',
    ]);
    const unexpected = status.split('\n').map(l => l.trim()).filter(Boolean).filter(l => !ALLOWED_UNTRACKED.has(l));
    expect(unexpected).toEqual([]);
  });

  it('no docs/ changes', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- docs/', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });
});

describe('11. Premium design tokens/classes exist (this phase\'s additions)', () => {
  it('defines the new empty-state, material-row, and QR-shell utility classes', () => {
    for (const className of ['premium-empty-icon', 'premium-material-row', 'premium-qr-public-shell', 'premium-qr-trust-note']) {
      expect(css).toContain(className);
    }
  });

  it('wires the new classes into the components that use them', () => {
    expect(emptyState).toContain('premium-empty-icon');
    expect(emptyState).toContain('premium-action-button');
    expect(institution).toContain('premium-material-row');
    expect(outletGroups).toContain('hover');
  });

  it('reuses existing premium-action-bar utility on export/print/filter rows (no new duplicate class invented)', () => {
    for (const src of [statusCenter, statusEditor, movementReport]) {
      expect(src).toContain('premium-action-bar');
    }
    expect(css).toContain('.premium-action-bar');
  });
});

describe('12. RTL/LTR direction handling remains present', () => {
  it('dir="auto"/dir="rtl"/dir="ltr" usage is preserved in every touched screen', () => {
    for (const src of [publicQr, institution, statusCenter, statusEditor, movementReport, outletGroups]) {
      expect(src).toMatch(/dir=["'](auto|rtl|ltr)["']|dir=\{/);
    }
  });
});

describe('13. Mobile action bars wrap/stack and do not hide export/print buttons', () => {
  it('the export/print/filter action-bar containers keep flexWrap alongside the new className', () => {
    expect(statusCenter).toContain("className=\"premium-action-bar\" style={{ display: 'flex', gap: '6px', marginInlineStart: 'auto', flexWrap: 'wrap' }}");
    expect(statusEditor).toContain("className=\"premium-action-bar\" style={{ display: 'flex', gap: '6px', marginInlineStart: 'auto', flexWrap: 'wrap' }}");
    expect(movementReport).toContain("className=\"premium-action-bar\" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}");
  });

  it('no export/print button was removed from any of the three screens', () => {
    expect(statusCenter).toContain("t('sc_export_excel', lang)");
    expect(statusCenter).toContain("t('sc_print_report', lang)");
    expect(statusEditor).toContain("t('se_export_excel', lang)");
    expect(statusEditor).toContain("t('se_print', lang)");
    expect(movementReport).toContain("t('mvmt_report_export_csv', lang)");
  });
});

describe('14. Existing button handlers remain connected', () => {
  // SAFE-PROFESSIONAL-XLSX-EXPORT-A: the export button's onClick now calls
  // exportXlsx instead of the old exportCsv — same button, same location.
  it('onClick handlers for export/print/remove actions are unchanged in the touched files', () => {
    expect(statusCenter).toContain('onClick={exportXlsx}');
    expect(statusCenter).toContain('onClick={printReport}');
    expect(institution).toContain('onClick={(e) => { e.stopPropagation(); setRemoveError(null); setRemoveTarget(r); }}');
  });

  it('PhoenixEmptyState action button still calls action.onClick', () => {
    expect(emptyState).toContain('onClick={action.onClick}');
  });
});

describe('15. No route path was renamed', () => {
  it('the screen-number constants used across nav components are unchanged (spot check against App.tsx cases)', () => {
    // QrScreen is screen 6 (App.tsx case 6) — confirm the nav-target number
    // wasn't renumbered anywhere touched by this phase.
    const caseSixIdx = app.indexOf('case 6:');
    expect(app.slice(caseSixIdx, caseSixIdx + 40)).toContain('QrScreen');
  });

  it('qrScreen file itself is untouched by this phase', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- src/features/qr/QrScreen.tsx', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
    expect(qrScreen.length).toBeGreaterThan(0);
  });
});

describe('Safety: Service-D stash and premium-preview.html untouched', () => {
  it('stash@{0} (paused Service-D work) was not popped or applied', () => {
    const stashList = execSync('git stash list', { cwd: ROOT, encoding: 'utf8' });
    expect(stashList).toContain('paused Service-D inter-org exchange service work');
  });

  it('premium-preview.html remains untouched', () => {
    let status = '';
    try {
      status = execSync('git status --porcelain -- premium-preview.html', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    if (status.trim()) {
      expect(status.trim().startsWith('??')).toBe(true);
    }
  });

  it('supabase/.temp/ (CLI cache) was not staged', () => {
    const status = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' });
    const tempLine = status.split('\n').find(l => l.includes('supabase/.temp'));
    if (tempLine) {
      expect(tempLine.trim().startsWith('??')).toBe(true);
    }
  });
});
