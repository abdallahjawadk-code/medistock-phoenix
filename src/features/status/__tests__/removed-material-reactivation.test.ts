/**
 * PHASE2-REMOVED-MATERIAL-REACTIVATION-UX-A
 *
 * Static source-code tests for:
 *  - Status Center's removed-row badge/details (removed_at/removal_reason/
 *    actor_name_snapshot — never removed_by's raw uuid).
 *  - The new ReactivateMaterialModal component and its two-step, existing-RPC
 *    reactivation flow (applyAvailabilityMovement then upsertAvailability).
 *  - Safety guards: no SQL/migration/package changes, Status Center's live
 *    XLSX export still excludes removed_at rows, live/current screens still
 *    hide removed rows, genuine missing rows remain visible, movement
 *    history/QR/alerts/auth/permissions/navigation untouched.
 *
 * No live DB is used — these are static source-code assertions, matching
 * this repo's established test conventions.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

const SRC = join(__dirname, '../../../');
const ROOT = join(__dirname, '../../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const statusCenter = readSrc('features/status/StatusCenterScreen.tsx');
const reactivateModal = readSrc('features/status/ReactivateMaterialModal.tsx');
const availabilityService = readSrc('shared/supabase/services/availability.service.ts');
const strings = readSrc('shared/i18n/strings.ts');
const statusEditor = readSrc('features/status/StatusEditorScreen.tsx');
const movementHistoryModal = readSrc('features/status/MovementHistoryModal.tsx');
const movementReportSection = readSrc('features/status/MovementReportSection.tsx');
const professionalExport = readSrc('shared/lib/professional-export.ts');

describe('A) getAvailabilityByOrg now selects removal_reason (already selected removed_at/actor_name_snapshot)', () => {
  it('selects removal_reason alongside the pre-existing removed_at/actor_name_snapshot columns', () => {
    const start = availabilityService.indexOf('export async function getAvailabilityByOrg');
    const body = availabilityService.slice(start, start + 1400);
    expect(body).toContain('actor_name_snapshot, removed_at, removal_reason');
  });

  it('never selects removed_by (the raw auth uuid column) in the actual .select(...) clause', () => {
    const start = availabilityService.indexOf('export async function getAvailabilityByOrg');
    const selectStart = availabilityService.indexOf('.select(`', start);
    const selectEnd = availabilityService.indexOf('`)', selectStart);
    const selectClause = availabilityService.slice(selectStart, selectEnd);
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
    const fn = statusCenter.slice(statusCenter.indexOf('function removalReasonLabel('), statusCenter.indexOf('function removalReasonLabel(') + 500);
    expect(fn).toContain("'removed_from_outlet'");
    expect(fn).toContain("'clear_port_availability'");
    expect(fn).toContain("t('sc_removal_reason_unknown', lang)"); // safe fallback for unknown/other
    expect(statusCenter).toContain('removalReasonLabel(r.removal_reason, lang)');
  });

  it('shows removed_at formatted via the existing stable date formatter, not a raw ISO string', () => {
    const badgeBlock = statusCenter.slice(statusCenter.indexOf('isRemoved ? ('), statusCenter.indexOf('isRemoved ? (') + 900);
    expect(badgeBlock).toContain('formatStableDate(r.removed_at, lang)');
  });

  it('shows "last action by" using actor_name_snapshot only — never removed_by or any raw uuid', () => {
    const badgeBlock = statusCenter.slice(statusCenter.indexOf('isRemoved ? ('), statusCenter.indexOf('isRemoved ? (') + 900);
    expect(badgeBlock).toContain('r.actor_name_snapshot');
    expect(badgeBlock).not.toMatch(/\bremoved_by\b/);
    expect(badgeBlock).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it('LiveAvailRow carries removal_reason/national_code/price needed for the badge and reactivation, and no removed_by field', () => {
    const rowStart = statusCenter.indexOf('interface LiveAvailRow');
    const rowBody = statusCenter.slice(rowStart, statusCenter.indexOf('\n}', rowStart));
    expect(rowBody).toContain('removal_reason?: string | null;');
    expect(rowBody).toContain('national_code?: string | null;');
    expect(rowBody).toContain('price?: number | null;');
    expect(rowBody).not.toMatch(/\bremoved_by\b/);
  });
});

describe('C) Status Center: Reactivate button appears only for removed rows, replacing Adjust Quantity', () => {
  it('the actions cell renders Reactivate for isRemoved rows and Adjust Quantity otherwise (never both for the same row)', () => {
    const cellStart = statusCenter.indexOf('{isRemoved ? (\n                            canReactivate');
    expect(cellStart).toBeGreaterThan(-1);
    const cellBody = statusCenter.slice(cellStart, cellStart + 900);
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
    const fnStart = statusCenter.indexOf('function handleReactivateSuccess');
    const fnBody = statusCenter.slice(fnStart, fnStart + 300);
    expect(fnBody).toContain('live.reload()');
  });
});

describe('D) ReactivateMaterialModal: quantity/condition validation', () => {
  it('excludes condition=missing from the selectable active conditions (migration 053 would not clear removed_at for it)', () => {
    const block = reactivateModal.slice(reactivateModal.indexOf('const ACTIVE_CONDITIONS'), reactivateModal.indexOf('const ACTIVE_CONDITIONS') + 200);
    expect(block).toContain("'available'");
    expect(block).toContain("'low_stock'");
    expect(block).toContain("'surplus'");
    expect(block).toContain("'near_expiry'");
    expect(block).not.toContain("'missing'");
  });

  it('requires a positive integer quantity before submit is enabled', () => {
    expect(reactivateModal).toMatch(/Number\.isInteger\(qtyNum\) && qtyNum > 0/);
    expect(reactivateModal).toContain('const canSubmit = canReactivate && qtyNum !== null && Number.isInteger(qtyNum) && qtyNum > 0 && !busy;');
  });

  it('shows a validation error for a non-positive or non-integer quantity', () => {
    expect(reactivateModal).toContain("t('sc_reactivate_qty_err', lang)");
    expect(reactivateModal).toMatch(/qtyInvalid = quantity !== '' && \(qtyNum === null \|\| !Number\.isInteger\(qtyNum\) \|\| qtyNum <= 0\)/);
  });
});

describe('E) ReactivateMaterialModal: two-step RPC call order (no new RPC)', () => {
  const submitFn = reactivateModal.slice(reactivateModal.indexOf('async function handleSubmit'), reactivateModal.indexOf('const fieldStyle ='));

  it('calls applyAvailabilityMovement first with set_exact/desired quantity/reactivated_from_removed reason', () => {
    const movementIdx = submitFn.indexOf('await applyAvailabilityMovement(');
    expect(movementIdx).toBeGreaterThan(-1);
    const call = submitFn.slice(movementIdx, submitFn.indexOf(');', movementIdx));
    expect(call).toContain("movementType: 'set_exact'");
    expect(call).toContain('amount: qtyNum');
    expect(call).toContain("reason: 'reactivated_from_removed'");
  });

  it('calls upsertAvailability second, after the movement call, with the same identity fields and the chosen active condition', () => {
    const movementIdx = submitFn.indexOf('await applyAvailabilityMovement(');
    const upsertIdx = submitFn.indexOf('await upsertAvailability(');
    expect(upsertIdx).toBeGreaterThan(movementIdx);
    const call = submitFn.slice(upsertIdx, submitFn.indexOf('});', upsertIdx));
    expect(call).toContain('quantity: qtyNum');
    expect(call).toContain('condition,');
    expect(call).toContain('scientificName: row!.scientific_name');
    expect(call).toContain('distributionPointId: row!.distribution_points?.id');
    expect(call).toContain('batchNumber: row!.batch_number');
    expect(call).toContain('nationalCode: row!.national_code');
  });

  it('never introduces a new RPC name — only the two existing service functions are imported/called', () => {
    expect(reactivateModal).toContain("import {\n  applyAvailabilityMovement,\n  classifyAvailabilityMovementError,\n  upsertAvailability,\n  classifyAvailabilitySaveError,\n} from '@/shared/supabase/services/availability.service';");
    expect(reactivateModal).not.toMatch(/supabase\.rpc\(/);
  });

  it('does not allow submit before the movement step even begins if the row is falsy (defensive guard)', () => {
    expect(reactivateModal).toContain('if (!canSubmit || qtyNum === null) return;');
  });

  it('classifies the error against whichever step actually failed (movementDone flag), not always the movement classifier', () => {
    expect(reactivateModal).toContain('let movementDone = false;');
    expect(reactivateModal).toContain('movementDone = true;');
    expect(reactivateModal).toContain('setError(t(movementDone ? classifyAvailabilitySaveError(e) : classifyAvailabilityMovementError(e), lang));');
  });
});

describe('F) Reactivation reload/refetch behavior', () => {
  it('handleReactivateSuccess shows a success toast and reloads the live availability data', () => {
    const fnStart = statusCenter.indexOf('function handleReactivateSuccess');
    const fnBody = statusCenter.slice(fnStart, fnStart + 300);
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
    const fnStart = statusCenter.indexOf('async function exportXlsx');
    const fnBody = statusCenter.slice(fnStart, fnStart + 900);
    expect(fnBody).toMatch(/\.filter\(r => r\.removed_at == null\)/);
  });

  it('professional-export.ts (the shared XLSX builder) was not modified by this phase', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- src/shared/lib/professional-export.ts', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('exportAvailabilityXlsx/buildAvailabilityExportWorkbook still exist unrenamed', () => {
    expect(professionalExport).toContain('export async function exportAvailabilityXlsx');
    expect(professionalExport).toContain('export async function buildAvailabilityExportWorkbook');
  });
});

describe('J) Live/current views still hide removed rows; genuine missing rows preserved', () => {
  it('InstitutionScreen.tsx outlet list filter and dashboard.service.ts removed_at filters were not touched by this phase', () => {
    let diff = '';
    try {
      diff = execSync(
        'git diff -- src/features/institutions/InstitutionScreen.tsx src/shared/supabase/services/dashboard.service.ts',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('Status Center itself remains unfiltered by removed_at for the on-screen table (operations context) — rows still come from the same unfiltered `rows` memo', () => {
    expect(statusCenter).not.toMatch(/const rows = useMemo\([\s\S]{0,600}?removed_at/);
  });
});

describe('Guards: no SQL/migration/package change, safety files untouched', () => {
  it('no migration 054 was created', () => {
    let listing = '';
    try {
      listing = execSync('git status --porcelain -- supabase/migrations', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(listing).not.toMatch(/054_/);
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

  it('no QR/alert-lifecycle/auth/permissions/navigation file was touched by this phase', () => {
    let diff = '';
    try {
      diff = execSync(
        'git diff -- src/features/qr/PublicQrScreen.tsx src/shared/supabase/services/qr.service.ts src/features/alerts/inter-org-alert-lifecycle.service.ts src/shared/supabase/services/auth.service.ts src/shared/lib/permissions.ts src/app/AppContext.tsx src/app/App.tsx',
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
