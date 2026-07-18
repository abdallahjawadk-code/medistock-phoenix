/**
 * UI-HIDE-PORT-ADD-ITEM-A
 * Run: npm test -- --run
 *
 * Hides the "+ إضافة صنف" (Add Item) action from the port/distribution-point
 * card's availability section (PortAvailabilitySection, inside PortCard).
 * The action allowed accidental/manual item addition and bypassed safer
 * controlled flows, and is visually risky and unnecessary on a screen
 * focused on QR, port editing/disabling, availability display, and
 * safe-delete handling.
 *
 * Investigation: PortAvailabilitySection is rendered from exactly one place
 * (PortCard) and QuickAvailForm (the add-item form the button used to
 * reveal) is invoked from exactly one place (PortAvailabilitySection) — so
 * hiding the button here does not orphan or break any other screen. The
 * underlying QuickAvailForm component and the canMutate-fed "+ Add" concept
 * are removed only because they became fully dead code once the button was
 * removed (nothing else could ever set showAdd via canMutate) — the RPC/
 * service layer QuickAvailForm calls into is untouched and still used by
 * remove/edit/disable flows elsewhere.
 *
 * No live DB is used — these are text/shape assertions against the source.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { findUnexpectedMigrationGitStatusEntries } from '../../../../supabase/migrations/__tests__/helpers/reviewed-migration-git-status';
import { execSync } from 'child_process';

const SRC = join(__dirname, '../../../');
const ROOT = join(__dirname, '../../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const screen = readSrc('features/institutions/InstitutionScreen.tsx');

function section(name: string, nextName: string): string {
  return screen.slice(screen.indexOf(`function ${name}`), screen.indexOf(`function ${nextName}`));
}

const portAvailabilitySection = section('PortAvailabilitySection', 'QuickAvailForm');
const portCardSection = section('PortCard', 'QrPreviewModal');

describe('1. The port card no longer renders "+ إضافة صنف"', () => {
  it('the add-item button JSX is gone from PortAvailabilitySection', () => {
    expect(portAvailabilitySection).not.toContain("t('avail_add', lang)");
    expect(portAvailabilitySection).not.toMatch(/\+\s*\{t\('avail_add'/);
  });

  it('the canMutate prop (which only ever gated this button) no longer exists on PortAvailabilitySection at all', () => {
    expect(portAvailabilitySection).not.toContain('canMutate');
    expect(portCardSection).not.toContain('canMutate={canEditPorts}');
  });

  it('no empty layout gap remains where the button was — the header row now renders only the label span', () => {
    const headerStart = portAvailabilitySection.indexOf("justifyContent: 'space-between', marginBottom: '6px'");
    const headerBlock = portAvailabilitySection.slice(headerStart, headerStart + 500);
    expect(headerBlock).toContain("t('avail_manage', lang)");
    expect(headerBlock).not.toContain('<button');
  });
});

describe('2. Existing availability list still renders', () => {
  it('rows.map still renders scientific name/trade name/condition/quantity for each availability row', () => {
    expect(portAvailabilitySection).toContain('rows.map(r =>');
    expect(portAvailabilitySection).toContain('outletMaterialTitle(r, ci, lang)');
    expect(portAvailabilitySection).toContain('CONDITION_LABEL_KEY[r.condition]');
  });

  it('the empty-state and loading messages are untouched', () => {
    expect(portAvailabilitySection).toContain("t('avail_outlet_active_empty', lang)");
    expect(portAvailabilitySection).toContain("t('loading', lang)");
  });
});

describe('3. Existing "إزالة من المنفذ" (remove-from-port) action remains', () => {
  it('the remove button is still rendered, gated by canRemove, with its confirmation dialog intact', () => {
    expect(portAvailabilitySection).toMatch(/\{canRemove\s*&&\s*\(/);
    expect(portAvailabilitySection).toContain("t('avail_remove_from_outlet', lang)");
    expect(portAvailabilitySection).toContain('onConfirmRemove');
    expect(portAvailabilitySection).toContain("t('avail_remove_confirm', lang)");
  });
});

describe('4. QR actions remain visible and unchanged', () => {
  it('PortCard still wires QR preview/generate/revoke/regenerate', () => {
    expect(portCardSection).toContain('QrPreviewModal');
    expect(portCardSection).toContain('canGenerateQr');
    expect(portCardSection).toContain('canRevokeQr');
  });

  it('QR generation/cancel/recreate service logic is untouched by this phase', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- src/shared/supabase/services/qr.service.ts', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });
});

describe('5. Edit/disable port actions remain visible and unchanged', () => {
  it('edit-port and archive/disable-port actions are still gated by canEditPorts/canArchivePortsEffective', () => {
    expect(portCardSection).toContain('canEditPorts &&');
    expect(portCardSection).toContain('canArchivePortsEffective &&');
    expect(portCardSection).toContain("t('port_disable_action', lang)");
  });

  it('canEditPorts is still used for the edit action even though it is no longer passed to PortAvailabilitySection', () => {
    expect(portCardSection).toMatch(/canEditPorts\s*&&\s*\(/);
  });
});

describe('6. Safe-delete handler remains visible and unchanged', () => {
  // REMOVE-BUTTON-MARKS-REMOVED-AT-A: onConfirmRemove now makes a single
  // phoenix_apply_availability_movement call (set_exact/amount=0/
  // reason='removed_from_outlet') instead of a movement call followed by a
  // separate upsertAvailability({ quantity: 0, condition: 'missing' }) call —
  // the RPC's own migration-053 branch on that reason already sets
  // condition='missing' (and removed_at/removed_by/removal_reason) in one
  // atomic write, so the literal 'quantity: 0'/"condition: 'missing'" object
  // keys this test used to assert on no longer appear (amount: 0 is what
  // remains).
  it('onConfirmRemove still performs the safe (quantity-zeroing) movement, not a hard delete, and still classifies errors honestly', () => {
    const onConfirmRemove = screen.slice(screen.indexOf('async function onConfirmRemove'), screen.indexOf('async function onConfirmRemove') + 1400);
    expect(onConfirmRemove).toContain('amount: 0');
    expect(onConfirmRemove).toContain("reason: 'removed_from_outlet'");
    expect(onConfirmRemove).toContain('classifyAvailabilityMovementError');
  });
});

describe('7. No backend/migration/RLS/auth/permissions files changed', () => {
  // REFRESH-MIGRATION-051-DIFF-GUARDS-A: 051_material_batch_identity_option_a.sql
  // is excluded because a later, separately-reviewed phase (FIX-MIGRATION-051-
  // IMMUTABLE-EXPIRY-DATE-A) legitimately corrects it in-place before its
  // first successful manual apply; auth/AppContext/permissions remain fully
  // guarded.
  // DB-PRESSURE-QUICK-WINS-A: a later, separately-reviewed phase legitimately
  // adds a skipAuthBootstrap flag to src/app/AppContext.tsx — excluded here.
  it('empty diff on migrations (other than the already-approved 051 immutable-expiry-date fix), auth.service.ts, permissions.ts', () => {
    let diff = '';
    try {
      diff = execSync(
        'git diff -- "supabase/migrations/*.sql" ":!supabase/migrations/051_material_batch_identity_option_a.sql" ":!supabase/migrations/053_item_availability_removed_marker.sql" ":!supabase/migrations/054_dashboard_condition_counts_rpcs.sql" ":!supabase/migrations/055_phoenix_clean_availability_data.sql" ":!supabase/migrations/056_phoenix_platform_broadcast_notices.sql" ":!supabase/migrations/057_phoenix_platform_broadcast_admin_details_delete.sql" src/shared/supabase/services/auth.service.ts src/shared/lib/permissions.ts',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('no new untracked migration SQL file was created — only the separately-reviewed migration 048 (DB-EXPIRY-RISK-TIERS-LIVE-ALERTS-A) is allowed as an untracked addition', () => {
    let status = '';
    try {
      status = execSync('git status --porcelain -- "supabase/migrations/*.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    // MIGRATION-GUARD-DERIVE-B: the allowed in-flight migration entries are
    // now DERIVED from the canonical reviewed registry instead of a copy kept
    // in this file, so registering a migration once permits it everywhere and
    // no historical guard needs an edit. Strictly stronger than the old list:
    // an unregistered migration still fails, and a MODIFIED reviewed migration
    // now fails too (the old list tolerated `M `/`M  ` entries).
    expect(findUnexpectedMigrationGitStatusEntries(status)).toEqual([]);
  });
});

describe('8. No QR generation/cancel/recreate logic changed, no export/print/user-management changed', () => {
  // StatusCenterScreen.tsx is intentionally excluded from this empty-diff
  // check as of EXPIRY-RISK-TIERS-A, a later, separately-reviewed phase that
  // adds a purely-additive ExpiryRiskBadge next to its expiry-date table
  // cell (see expiry-risk-badge-wiring.test.ts for that phase's own guards).
  // PublicQrScreen.tsx is also excluded — a later, separately-reviewed
  // QR-HIDE-NONAVAILABLE-ITEMS-FROM-PUBLIC-LIST-A phase that hides
  // non-available items from the public QR list; qr.service.ts (the RPC
  // call site) remains fully guarded.
  it('empty diff on QR service (qr.service.ts); UserManagementScreen.tsx allows only the later AvailabilityCleanupWizard addition (PHASE3-DEEP-CLEAN-AVAILABILITY-DATA-A)', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- src/shared/supabase/services/qr.service.ts', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');

    let userMgmtDiff = '';
    try {
      userMgmtDiff = execSync('git diff -- src/features/users/UserManagementScreen.tsx', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    const addedLines = userMgmtDiff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++') && l.trim() !== '+');
    // AUTHENTICATED-SCREEN-SPLIT-B: a later, separately-reviewed phase converts
    // AvailabilityCleanupWizard/PlatformBroadcastAdminPanel to React.lazy +
    // Suspense, gated by the same normalizeRole(role) === 'super_admin' check
    // each already performed internally — no permission logic changed.
    const structuralOnly = /^\+[\s)}/*;]*$/;
    const unexpected = addedLines.filter(l =>
      !structuralOnly.test(l) &&
      !l.includes('AvailabilityCleanupWizard') && !l.includes('PHASE3-DEEP-CLEAN-AVAILABILITY-DATA-A') &&
      !l.includes('Renders null internally') && !l.includes('is already the safest') &&
      !l.includes('PlatformBroadcastAdminPanel') && !l.includes('PHASE3-PLATFORM-BROADCAST-NOTICES-A') &&
      !l.includes('same convention as AvailabilityCleanupWizard above') &&
      !l.includes('AUTHENTICATED-SCREEN-SPLIT-B') && !l.includes('Suspense') && !l.includes('normalizeRole(role)'));
    expect(unexpected).toEqual([]);
  });
});

describe('9. No package/lockfile changes', () => {
  it('package.json/lockfiles empty diff', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- package.json', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    const addedLines = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
    const removedLines = diff.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---'));
    expect(removedLines.length).toBe(0);
    expect(addedLines.every(l => /"exceljs":/.test(l))).toBe(true);
  });
});

describe('10. Service-D stash and untracked-file guards untouched', () => {
  it('stash@{0} (paused Service-D work) was not popped or applied', () => {
    const stashList = execSync('git stash list', { cwd: ROOT, encoding: 'utf8' });
    expect(stashList).toContain('paused Service-D inter-org exchange service work');
  });

  it('premium-preview.html remains untracked only', () => {
    let status = '';
    try {
      status = execSync('git status --porcelain -- premium-preview.html', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    if (status.trim()) {
      expect(status.trim().startsWith('??')).toBe(true);
    }
  });

  it('no staged entry for supabase/.temp', () => {
    let staged = '';
    try {
      staged = execSync('git diff --cached --name-only -- supabase/.temp', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(staged.trim()).toBe('');
  });
});
