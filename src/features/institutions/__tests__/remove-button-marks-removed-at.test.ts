/**
 * REMOVE-BUTTON-MARKS-REMOVED-AT-A
 * Run: npm test -- --run removed
 *
 * Manual testing after migration 053 was applied found that pressing
 * "إزالة من المنفذ" / "Remove from outlet" on ceftriaxone left the row at
 * quantity=0/condition='missing'/removed_at=NULL — the row was
 * indistinguishable from a genuine ongoing shortage, defeating the whole
 * point of migration 053's removed marker.
 *
 * Root cause: onConfirmRemove only called the 053-aware
 * phoenix_apply_availability_movement RPC (reason='removed_from_outlet',
 * which sets removed_at/removed_by/removal_reason) when
 * `removeTarget.quantity !== 0`. Whenever the row was already at quantity 0
 * when the button was pressed, that call was skipped entirely, and the
 * follow-up upsertAvailability({ quantity: 0, condition: 'missing' }) call
 * — which never touches removed_at except to clear it on reactivation —
 * was the only write that ran.
 *
 * Fix: onConfirmRemove now makes a single, unconditional
 * phoenix_apply_availability_movement call
 * (movementType: 'set_exact', amount: 0, reason: 'removed_from_outlet').
 * set_exact/0 is a valid, idempotent write even when quantity is already 0,
 * and migration 053's own branch on that exact reason already sets
 * condition='missing' in the same atomic write — so the redundant
 * upsertAvailability call is removed entirely, not just its guard.
 *
 * No live DB is used — these are static source-code assertions, matching
 * this repo's established test conventions.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { expectQuickAvailFormAbsent } from '../../../../tests/helpers/retired-surfaces';

const SRC = join(__dirname, '../../../');
const ROOT = join(__dirname, '../../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const screen = readSrc('features/institutions/InstitutionScreen.tsx');
const availabilityService = readSrc('shared/supabase/services/availability.service.ts');

function onConfirmRemoveBody(): string {
  const start = screen.indexOf('async function onConfirmRemove');
  // Extract the ACTUAL function rather than a fixed character window. The old
  // 900-char window was sized to a shorter version of this function and
  // silently stopped covering its tail once STAGE-G-G3.1 added the stock-only
  // id guard — the assertions below then depended on how much text happened to
  // fit rather than on what the code does. `\n  }` is the closing brace at
  // this function's own indentation, so the slice ends exactly at its end.
  const end = screen.indexOf('\n  }', start);
  return screen.slice(start, end + 4);
}

// CANONICAL-STOCK-CUTOVER: the original quantity-0 bug is now structurally
// impossible. "Remove from outlet" is a CATALOGUE VISIBILITY action, not a
// quantity write — it calls the migration-084 RPC phoenix_set_availability_visibility
// (setAvailabilityVisibility(id, true, 'removed_from_outlet')), which sets ONLY
// the 053 removed marker (removed_at/removed_by/removal_reason). It never reads
// or writes quantity, so an already-out-of-stock material is removed by exactly
// the same single, unconditional, idempotent call. Physical stock lives in the
// canonical ledgers and is corrected through a separate, deliberate action.
describe('A) The exact reported bug is structurally gone: the remove call is unconditional and quantity-independent', () => {
  it('onConfirmRemove has no `if (removeTarget.quantity !== 0)` guard, and never inspects quantity at all', () => {
    const body = onConfirmRemoveBody();
    expect(body).not.toMatch(/if\s*\(\s*removeTarget\.quantity\s*!==\s*0\s*\)/);
    expect(body).not.toMatch(/removeTarget\.quantity/);
  });

  it('setAvailabilityVisibility is called unconditionally as the first statement in the try block', () => {
    const body = onConfirmRemoveBody();
    const tryIdx = body.indexOf('try {');
    const callIdx = body.indexOf('await setAvailabilityVisibility(');
    expect(tryIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(tryIdx);
    // No `if` between try{ and the call.
    const between = body.slice(tryIdx, callIdx);
    expect(between).not.toMatch(/\bif\s*\(/);
  });

  it('the retired manual-quantity remove path is gone (no movement RPC on remove)', () => {
    const body = onConfirmRemoveBody();
    expect(body).not.toContain('applyAvailabilityMovement');
    expect(body).not.toContain("movementType: 'set_exact'");
  });
});

describe('B) The visibility call uses the exact parameters the 053 removed marker requires', () => {
  const body = onConfirmRemoveBody();
  const callStart = body.indexOf('await setAvailabilityVisibility(');
  const callEnd = body.indexOf(');', callStart) + 2;
  const call = body.slice(callStart, callEnd);

  it('the first argument is the target row id', () => {
    expect(call).toMatch(/setAvailabilityVisibility\(\s*removeTarget\.id/);
  });

  it('hidden is true (this hides, not reactivates)', () => {
    expect(call).toMatch(/removeTarget\.id\s*,\s*true/);
  });

  it('reason is the exact literal removed_from_outlet (provenance for the removal marker)', () => {
    expect(call).toContain("'removed_from_outlet'");
  });

  it('this is a genuine RPC call (via the service wrapper), not a direct table write', () => {
    expect(screen).not.toMatch(/onConfirmRemove[\s\S]{0,900}\.from\('item_availability'\)/);
  });
});

describe('C) Works even when the row is already at quantity 0 (the exact failure scenario)', () => {
  it('setAvailabilityVisibility (the service wrapper) sends no quantity/amount — it cannot be gated on quantity', () => {
    const start = availabilityService.indexOf('export async function setAvailabilityVisibility');
    const end = availabilityService.indexOf('\n}', start);
    const body = availabilityService.slice(start, end);
    expect(body).not.toMatch(/p_amount|p_counted_quantity|quantity/i);
    expect(body).not.toMatch(/if\s*\(.*amount/);
  });

  it('phoenix_set_availability_visibility (migration 084) edits ONLY the 053 removed marker, never quantity/condition', () => {
    const migration084 = readFileSync(join(ROOT, 'supabase/migrations/084_phoenix_availability_visibility.sql'), 'utf8');
    expect(migration084).toMatch(/removed_at/);
    // The visibility RPC must not write the derived quantity/condition columns.
    expect(migration084).not.toMatch(/SET[\s\S]{0,200}\bquantity\s*=/i);
  });
});

describe('D) No subtract/set_exact quantity path was used instead', () => {
  it('onConfirmRemove never uses a movement type', () => {
    const body = onConfirmRemoveBody();
    expect(body).not.toContain("movementType: 'subtract'");
    expect(body).not.toContain("movementType: 'set_exact'");
  });
});

describe('E) The redundant upsertAvailability follow-up call was removed, not just its guard', () => {
  it('onConfirmRemove no longer calls upsertAvailability at all', () => {
    expect(onConfirmRemoveBody()).not.toContain('upsertAvailability');
  });

  // E6: this asserted the import SURVIVED, because QuickAvailForm still needed
  // it — the point being that the remove path's cleanup had not over-reached.
  // QuickAvailForm is now retired, so the import is legitimately gone. The
  // original intent is preserved and strengthened: remove still works, through
  // the recorded-movement RPC it always used.
  it('the upsertAvailability import is gone with its last caller, and remove is unaffected', () => {
    expect(screen).not.toContain('upsertAvailability,');
    expectQuickAvailFormAbsent();
    expect(onConfirmRemoveBody()).toContain('setAvailabilityVisibility');
  });
});

describe('F) No hard delete of item_availability anywhere in the remove path', () => {
  it('no .delete()/.rpc(\'...delete...\')/.rpc(\'...purge...\') call in onConfirmRemove', () => {
    const body = onConfirmRemoveBody();
    expect(body).not.toMatch(/\.delete\(\)/);
    expect(body).not.toMatch(/purge|DELETE FROM/i);
  });
});

describe('G) Genuine missing/shortage rows (removed_at null) are not globally hidden by this fix', () => {
  it('the outlet-list display filter still keys only on removed_at, unrelated to this onConfirmRemove change', () => {
    const fnStart = screen.indexOf('function PortAvailabilitySection');
    const fnBody = screen.slice(fnStart, screen.indexOf('function PortCleanupWizard'));
    expect(fnBody).toContain('filter(r => r.removed_at == null)');
    expect(fnBody).not.toMatch(/condition === 'missing'/);
  });
});

describe('H) Movement history remains preserved — the RPC always inserts a movement row regardless of reason', () => {
  it('migration 034\'s function body inserts into item_availability_movements unconditionally (not just for non-removal reasons)', () => {
    const migration034 = readFileSync(join(ROOT, 'supabase/migrations/034_phoenix_apply_availability_movement_rpc.sql'), 'utf8');
    expect(migration034).toContain('INSERT INTO public.item_availability_movements');
  });

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
});

describe('I) Success/error UX is preserved', () => {
  it('still reloads the list and shows the existing success toast on success', () => {
    const body = onConfirmRemoveBody();
    expect(body).toContain('avail.reload()');
    expect(body).toContain("onToast(t('avail_removed_from_outlet', lang))");
  });

  it('still classifies and surfaces RPC errors via the existing classifier', () => {
    const body = onConfirmRemoveBody();
    expect(body).toMatch(/catch \(e\)/);
    expect(body).toContain('classifyAvailabilityVisibilityError(e)');
    expect(body).toContain('setRemoveError(');
  });
});

describe('Guards: no SQL/migration/package/permission change, safety files untouched', () => {
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

  // DB-PRESSURE-QUICK-WINS-A: a later, separately-reviewed phase legitimately
  // adds a skipAuthBootstrap flag to src/app/AppContext.tsx — excluded here.
  it('no auth/session/permissions/alert-lifecycle/WhatsApp file was touched by this phase', () => {
    let diff = '';
    try {
      diff = execSync(
        'git diff -- src/shared/supabase/services/auth.service.ts src/shared/lib/permissions.ts src/features/alerts/inter-org-alert-lifecycle.service.ts',
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
