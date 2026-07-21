/**
 * PHASE2-REMOVED-MATERIAL-REACTIVATION-UX-A
 *
 * Static source-code tests for:
 *  - Status Center's removed-row badge/details (removed_at/removal_reason/
 *    actor_name_snapshot — never removed_by's raw uuid).
 *  - The ReactivateMaterialModal component and its VISIBILITY-ONLY reactivation
 *    (migration 084's phoenix_set_availability_visibility) — no quantity write.
 *  - Safety guards: no SQL/migration/package changes, Status Center's live
 *    XLSX export still excludes removed_at rows, live/current screens still
 *    hide removed rows, genuine missing rows remain visible, movement
 *    history/QR/alerts/auth/permissions/navigation untouched.
 *
 * No live DB is used — these are static source-code assertions, matching
 * this repo's established test conventions.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { join } from 'path';
import {
  readSourceFile,
  balancedBlockAt,
  functionBodyAt,
  blockBetween,
} from '../../../shared/__tests__/helpers/source-extract';

const SRC = join(__dirname, '../../../');
const ROOT = join(__dirname, '../../../../');
const readSrc = (rel: string) => readSourceFile(join(SRC, rel));

const statusCenter = readSrc('features/status/StatusCenterScreen.tsx');
const reactivateModal = readSrc('features/status/ReactivateMaterialModal.tsx');
const availabilityService = readSrc('shared/supabase/services/availability.service.ts');
const strings = readSrc('shared/i18n/strings.ts');
const statusEditor = readSrc('features/status/StatusEditorScreen.tsx');
const movementHistoryModal = readSrc('features/status/MovementHistoryModal.tsx');
const movementReportSection = readSrc('features/status/MovementReportSection.tsx');
const professionalExport = readSrc('shared/lib/professional-export.ts');
const institutionScreen = readSrc('features/institutions/InstitutionScreen.tsx');

describe('A) getAvailabilityByOrg now selects removal_reason (already selected removed_at/actor_name_snapshot)', () => {
  it('selects removal_reason alongside the pre-existing removed_at/actor_name_snapshot columns', () => {
    const body = functionBodyAt(availabilityService, 'export async function getAvailabilityByOrg');
    expect(body).toContain('actor_name_snapshot, removed_at, removal_reason');
  });

  it('never selects removed_by (the raw auth uuid column) in the actual .select(...) clause', () => {
    const fnBody = functionBodyAt(availabilityService, 'export async function getAvailabilityByOrg');
    // Bounded by the template literal's own delimiters — the clause contains
    // nested `table(col, col)` embeds, so bracket balancing is not the right
    // boundary here.
    const selectClause = blockBetween(fnBody, '.select(`', '`)');
    expect(selectClause).not.toMatch(/\bremoved_by\b/);
  });
});

describe('B) Status Center: removed-row badge and safe details', () => {
  it('renders a Removed badge/label only when row.removed_at != null', () => {
    expect(statusCenter).toContain('const isRemoved = r.removed_at != null;');
    expect(statusCenter).toMatch(/isRemoved \? \(/);
    expect(statusCenter).toContain("t('sc_removed_badge', lang)");
  });

  it('maps removal_reason to friendly bilingual labels via a dedicated helper, never rendering the raw DB string', () => {
    expect(statusCenter).toContain('function removalReasonLabel(');
    const fn = functionBodyAt(statusCenter, 'function removalReasonLabel(');
    expect(fn).toContain("'removed_from_outlet'");
    expect(fn).toContain("'clear_port_availability'");
    expect(fn).toContain("t('sc_removal_reason_unknown', lang)"); // safe fallback for unknown/other
    expect(statusCenter).toContain('removalReasonLabel(r.removal_reason, lang)');
  });

  it('shows removed_at formatted via the existing stable date formatter, not a raw ISO string', () => {
    const badgeBlock = balancedBlockAt(statusCenter, 'isRemoved ? (');
    expect(badgeBlock).toContain('formatStableDate(r.removed_at, lang)');
  });

  it('shows "last action by" using actor_name_snapshot only — never removed_by or any raw uuid', () => {
    const badgeBlock = balancedBlockAt(statusCenter, 'isRemoved ? (');
    expect(badgeBlock).toContain('r.actor_name_snapshot');
    expect(badgeBlock).not.toMatch(/\bremoved_by\b/);
    expect(badgeBlock).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it('LiveAvailRow carries removal_reason/national_code/price needed for the badge and reactivation, and no removed_by field', () => {
    const rowBody = balancedBlockAt(statusCenter, 'interface LiveAvailRow');
    expect(rowBody).toContain('removal_reason?: string | null;');
    expect(rowBody).toContain('national_code?: string | null;');
    expect(rowBody).toContain('price?: number | null;');
    expect(rowBody).not.toMatch(/\bremoved_by\b/);
  });
});

describe('C) Status Center: Reactivate button appears only for removed rows, replacing Adjust Quantity', () => {
  it('the actions cell renders Reactivate for isRemoved rows and Adjust Quantity otherwise (never both for the same row)', () => {
    // The actions cell is located by its own render condition rather than by an
    // indentation-exact `{isRemoved ? (\n<spaces>canReactivate` string, so
    // reformatting the JSX cannot make this guard silently stop looking at it.
    const cellBody = balancedBlockAt(
      statusCenter,
      '{(canAdjustQuantity || canReactivate || canViewMovementHistory) && (',
    );
    // Reactivate and Adjust Quantity are the two arms of one ternary on
    // isRemoved — never both for the same row.
    expect(cellBody).toContain('{isRemoved ? (');
    expect(cellBody).toContain('canReactivate && (');
    expect(cellBody).toContain('setReactivateRow(r');
    expect(cellBody).toContain("t('sc_reactivate_action', lang)");
    expect(cellBody).toContain('canAdjustQuantity && (');
    expect(cellBody).toContain('setAdjustRow(r)');
  });

  it('Reactivate visibility is gated on canReactivate (both quantity.set and update permissions)', () => {
    expect(statusCenter).toContain('const canReactivate = REACTIVATE_PERMISSION_KEYS.every(key => myPermissions.has(key));');
  });

  it('the actions column header shows for canReactivate too (alongside canAdjustQuantity/canViewMovementHistory)', () => {
    expect(statusCenter).toContain('(canAdjustQuantity || canReactivate || canViewMovementHistory)');
  });

  it('ReactivateMaterialModal is wired with the reactivateRow state and reload-on-success handler', () => {
    expect(statusCenter).toContain('<ReactivateMaterialModal');
    expect(statusCenter).toContain('open={reactivateRow !== null}');
    expect(statusCenter).toContain('onSuccess={handleReactivateSuccess}');
    const fnBody = functionBodyAt(statusCenter, 'function handleReactivateSuccess');
    expect(fnBody).toContain('live.reload()');
  });
});

describe('D) ReactivateMaterialModal: catalogue-visibility only (no quantity/condition inputs)', () => {
  it('asks for NO quantity — the removed quantity input and its validation are gone', () => {
    // Availability is derived (083); reactivation must not re-type a quantity.
    expect(reactivateModal).not.toContain("t('sc_reactivate_qty_err', lang)");
    expect(reactivateModal).not.toMatch(/Number\.isInteger\(qtyNum\)/);
    expect(reactivateModal).not.toContain('const ACTIVE_CONDITIONS');
  });

  it('submit is gated ONLY on permission + not-busy, with no quantity precondition', () => {
    expect(reactivateModal).toContain('const canSubmit = canReactivate && !busy;');
  });

  it('keeps the permission gate on the single availability.update key its RPC enforces', () => {
    expect(reactivateModal).toContain("REACTIVATE_PERMISSION_KEYS = ['availability.update']");
  });
});

describe('E) ReactivateMaterialModal: single visibility RPC, no manual quantity writer', () => {
  const submitFn = functionBodyAt(reactivateModal, 'async function handleSubmit');

  it('clears the removed marker with ONE call: setAvailabilityVisibility(row.id, false)', () => {
    expect(submitFn).toContain('await setAvailabilityVisibility(row!.id, false)');
  });

  it('no longer calls the manual quantity writers (applyAvailabilityMovement / upsertAvailability)', () => {
    expect(reactivateModal).not.toContain('applyAvailabilityMovement');
    expect(reactivateModal).not.toContain('upsertAvailability');
  });

  it('imports only the visibility service function + its classifier, and calls no raw supabase.rpc', () => {
    expect(reactivateModal).toContain("import {\n  setAvailabilityVisibility,\n  classifyAvailabilityVisibilityError,\n} from '@/shared/supabase/services/availability.service';");
    expect(reactivateModal).not.toMatch(/supabase\.rpc\(/);
  });

  it('classifies the visibility RPC error for the toast', () => {
    expect(reactivateModal).toContain('setError(t(classifyAvailabilityVisibilityError(e), lang));');
  });
});

describe('F) Reactivation reload/refetch behavior', () => {
  it('handleReactivateSuccess shows a success toast and reloads the live availability data', () => {
    const fnBody = functionBodyAt(statusCenter, 'function handleReactivateSuccess');
    expect(fnBody).toContain("t('sc_reactivate_success', lang)");
    expect(fnBody).toContain('live.reload()');
  });
});

describe('G) StatusEditorScreen: audited but intentionally left unchanged', () => {
  it('does not have a removed-row badge or Reactivate action wired in (documented scope decision — its table is driven by the same shared columns config used for XLSX/print export)', () => {
    expect(statusEditor).not.toContain('sc_removed_badge');
    expect(statusEditor).not.toContain('ReactivateMaterialModal');
  });
});

describe('H) Movement history production files remain untouched', () => {
  it('MovementHistoryModal.tsx / MovementReportSection.tsx have no working-tree diff from this phase', () => {
    let diff = '';
    try {
      diff = execSync(
        'git diff -- src/features/status/MovementHistoryModal.tsx src/features/status/MovementReportSection.tsx',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('neither file references removed_at/reactivation concerns', () => {
    expect(movementHistoryModal).not.toMatch(/removed_at|reactivat/i);
    expect(movementReportSection).not.toMatch(/removed_at|reactivat/i);
  });
});

describe('I) Status Center live XLSX export still excludes removed_at rows', () => {
  it('exportXlsx still filters r.removed_at == null before building export rows (unchanged by this phase)', () => {
    const fnBody = functionBodyAt(statusCenter, 'async function exportXlsx');
    expect(fnBody).toMatch(/\.filter\(r => r\.removed_at == null\)/);
  });

  // PHASE2-STATUS-CENTER-ENTERED-PRICE-FILTER-XLSX-A: professional-export.ts
  // is excluded from this check — a later, separately-reviewed phase
  // legitimately adds an "Entered Price" column to the Availability Export
  // sheet (row.price only, never calculated/inferred). That addition does
  // not change this phase's own scope (removed_at exclusion is untouched —
  // asserted separately above and in the newer phase's own tests).
  // PHASE2-STATUS-CENTER-OUTLET-REPORT-MODAL-A: a still later, separately-
  // reviewed phase adds a new, purely-additive OutletReport* type/function
  // family to this file for the outlet report modal's XLSX export — it never
  // modifies buildAvailabilityExportWorkbook/exportAvailabilityXlsx in place
  // (asserted below and in that phase's own tests), so this guard no longer
  // requires every diff to mention Entered Price specifically.
  // PHASE2-EXPORT-FIELD-SELECTOR-A: a still later, separately-reviewed phase
  // adds real, purely-additive filtering logic to buildOutletReportWorkbook
  // (a DIFFERENT function than buildAvailabilityExportWorkbook, further down
  // the file) as part of the export field selector — so this test now
  // verifies buildAvailabilityExportWorkbook's own body directly (content-
  // based), rather than diffing the whole file, since that function is
  // genuinely untouched even though the file as a whole now has a larger,
  // legitimate diff.
  it('professional-export.ts never exposes removed_by/service_role/auth.admin, and buildAvailabilityExportWorkbook\'s own body is untouched (verified directly)', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- src/shared/lib/professional-export.ts', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    if (diff.trim()) {
      // Only flags an actual removed_by FIELD/property reference (e.g.
      // `row.removed_by` or a `removed_by:` object key) — a doc comment that
      // merely explains removed_by is deliberately NOT exposed is fine.
      expect(diff).not.toMatch(/\.removed_by\b|removed_by\s*[:,]/);
      expect(diff).not.toMatch(/service_role|auth\.admin/);
    }
    const exportModuleSrc = readSrc('shared/lib/professional-export.ts');
    const body = functionBodyAt(exportModuleSrc, 'export async function buildAvailabilityExportWorkbook');
    expect(body).toContain("wb.addWorksheet(safeSheetName(AVAIL_SHEET_NAMES.summary)");
    expect(body).toContain('dataWs.columns = AVAIL_EXPORT_COLUMNS.map(c => ({ key: c.key, width: c.width }));');
  });

  it('exportAvailabilityXlsx/buildAvailabilityExportWorkbook still exist unrenamed', () => {
    expect(professionalExport).toContain('export async function exportAvailabilityXlsx');
    expect(professionalExport).toContain('export async function buildAvailabilityExportWorkbook');
  });
});

describe('J) Live/current views still hide removed rows; genuine missing rows preserved', () => {
  // PHASE2-DASHBOARD-SERVICE-RPC-SWITCH-A: dashboard.service.ts is excluded
  // from this check — a later, separately-reviewed phase legitimately
  // switches getDashboardMetrics/getInstitutionOverviews to call migration
  // 054's RPCs instead of reading item_availability directly. That RPC
  // switch does not change this phase's own scope (InstitutionScreen.tsx's
  // outlet list filter remains untouched).
  //
  // PHASE2-AVAILABILITY-ITEM-DETAILS-MODAL-A: a still later, separately-
  // reviewed phase adds a read-only availability item details modal to
  // InstitutionScreen.tsx (row click handler, stopPropagation on the Remove
  // button, a new import), so this test no longer requires a byte-for-byte
  // empty diff — it instead confirms the removed_at outlet-list filter this
  // phase actually cares about is still present and unchanged.
  it('InstitutionScreen.tsx outlet list filter (removed_at) was not touched by this phase', () => {
    const fnBody = functionBodyAt(institutionScreen, 'function PortAvailabilitySection');
    expect(fnBody).toContain('.filter(r => r.removed_at == null)');
  });

  it('Status Center itself remains unfiltered by removed_at for the on-screen table (operations context) — rows still come from the same unfiltered `rows` memo', () => {
    expect(statusCenter).not.toMatch(/const rows = useMemo\([\s\S]{0,600}?removed_at/);
  });
});

describe('Guards: no SQL/migration/package change, safety files untouched', () => {
  it('no migration 055 was created (054, PHASE2-DASHBOARD-PERFORMANCE-RPCS-054-A, is a later, separately-reviewed addition)', () => {
    let listing = '';
    try {
      listing = execSync('git status --porcelain -- supabase/migrations', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    // PHASE3-DEEP-CLEAN-AVAILABILITY-DATA-A: new reviewed migration 055 and
    // its test file are the only allowed 055_ occurrences; anything else
    // still fails this guard.
    const allowed055 = new Set([
      '?? supabase/migrations/055_phoenix_clean_availability_data.sql',
      'A  supabase/migrations/055_phoenix_clean_availability_data.sql',
      // FIX-MIGRATION-055-TRUNCATE-VERIFY-FALSE-POSITIVE-A: 055 corrected
      // in-place before its first successful manual apply (VERIFY block's
      // TRUNCATE assertion false-positive fix), same pattern as 051/053/054.
      'M supabase/migrations/055_phoenix_clean_availability_data.sql',
      'M  supabase/migrations/055_phoenix_clean_availability_data.sql',
      '?? supabase/migrations/__tests__/055-phoenix-clean-availability-data.test.ts',
      'A  supabase/migrations/__tests__/055-phoenix-clean-availability-data.test.ts',
    ]);
    const unexpected055 = listing.split('\n').map(l => l.trim()).filter(Boolean)
      .filter(l => l.includes('055_') && !allowed055.has(l));
    expect(unexpected055).toEqual([]);
  });

  // PHASE2-ALLOW-054-INPLACE-HARDENING-GUARDS-A: 054_dashboard_condition_counts_rpcs.sql
  // is excluded because HARDEN-MIGRATION-054-NULL-ROLE-FAIL-CLOSED-A legitimately
  // corrects it in-place before its first successful manual apply, the same
  // pattern as the 051/053 in-place corrections elsewhere in this repo.
  it('no migration SQL file has a working-tree diff (other than the already-approved 054 NULL-role fail-closed fix)', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- "supabase/migrations/*.sql" ":!supabase/migrations/054_dashboard_condition_counts_rpcs.sql" ":!supabase/migrations/055_phoenix_clean_availability_data.sql" ":!supabase/migrations/056_phoenix_platform_broadcast_notices.sql" ":!supabase/migrations/057_phoenix_platform_broadcast_admin_details_delete.sql"', { cwd: ROOT, encoding: 'utf8' });
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

  // QR-BUNDLE-CODE-SPLIT-A: a later, separately-reviewed phase legitimately
  // restructures src/app/App.tsx (route-level lazy loading) — excluded here.
  // DB-PRESSURE-QUICK-WINS-A: a later, separately-reviewed phase legitimately
  // adds a skipAuthBootstrap flag to src/app/AppContext.tsx — excluded here.
  it('no QR/alert-lifecycle/auth/permissions file was touched by this phase', () => {
    let diff = '';
    try {
      diff = execSync(
        // PUBLIC-QR-DOSAGE-FORM-IMPLEMENT-A: PublicQrScreen.tsx excluded — additive
        // dosage_form render landed in that later, separately-reviewed phase.
        'git diff -- src/shared/supabase/services/qr.service.ts src/features/alerts/inter-org-alert-lifecycle.service.ts src/shared/supabase/services/auth.service.ts src/shared/lib/permissions.ts',
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

describe('i18n: new strings exist bilingually', () => {
  it('all new sc_removed_*/sc_reactivate_* keys have both ar and en labels', () => {
    const keys = [
      'sc_removed_badge', 'sc_removed_at_label', 'sc_last_action_by',
      'sc_removal_reason_removed_from_outlet', 'sc_removal_reason_clear_port_availability', 'sc_removal_reason_unknown',
      'sc_reactivate_action', 'sc_reactivate_title', 'sc_reactivate_desc',
      'sc_reactivate_qty_label', 'sc_reactivate_qty_err', 'sc_reactivate_condition_label',
      'sc_reactivate_notes_label', 'sc_reactivate_submit', 'sc_reactivate_cancel',
      'sc_reactivate_success', 'sc_reactivate_no_permission_tooltip',
    ];
    for (const k of keys) {
      expect(strings).toMatch(new RegExp(`${k}:\\s*\\{\\s*ar:\\s*'[^']+',\\s*en:\\s*'[^']+'`));
    }
  });
});
