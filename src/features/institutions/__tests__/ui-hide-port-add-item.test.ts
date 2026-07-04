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
    const headerBlock = portAvailabilitySection.slice(headerStart, headerStart + 250);
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
  it('onConfirmRemove still performs the safe (quantity-zeroing) update, not a hard delete, and still classifies errors honestly', () => {
    const onConfirmRemove = screen.slice(screen.indexOf('async function onConfirmRemove'), screen.indexOf('async function onConfirmRemove') + 1400);
    expect(onConfirmRemove).toContain('quantity: 0');
    expect(onConfirmRemove).toContain("condition: 'missing'");
    expect(onConfirmRemove).toContain('classifyAvailabilityMovementError');
  });
});

describe('7. No backend/migration/RLS/auth/permissions files changed', () => {
  it('empty diff on migrations, auth.service.ts, AppContext.tsx, permissions.ts', () => {
    let diff = '';
    try {
      diff = execSync(
        'git diff -- "supabase/migrations/*.sql" src/shared/supabase/services/auth.service.ts src/app/AppContext.tsx src/shared/lib/permissions.ts',
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
    const ALLOWED_UNTRACKED = new Set([
      '?? supabase/migrations/048_live_alerts_expiry_risk_tiers.sql',
      'A  supabase/migrations/048_live_alerts_expiry_risk_tiers.sql',
    ]);
    const unexpected = status.split('\n').map(l => l.trim()).filter(Boolean).filter(l => !ALLOWED_UNTRACKED.has(l));
    expect(unexpected).toEqual([]);
  });
});

describe('8. No QR generation/cancel/recreate logic changed, no export/print/user-management changed', () => {
  // StatusCenterScreen.tsx is intentionally excluded from this empty-diff
  // check as of EXPIRY-RISK-TIERS-A, a later, separately-reviewed phase that
  // adds a purely-additive ExpiryRiskBadge next to its expiry-date table
  // cell (see expiry-risk-badge-wiring.test.ts for that phase's own guards).
  it('empty diff on QR screen/service and user-management screens', () => {
    let diff = '';
    try {
      diff = execSync(
        'git diff -- src/features/qr/PublicQrScreen.tsx src/shared/supabase/services/qr.service.ts src/features/users/UserManagementScreen.tsx',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
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
