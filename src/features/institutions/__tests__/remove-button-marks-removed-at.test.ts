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
  // The function is short (single RPC call + toast/reload/catch) — a fixed
  // window comfortably covers it without spilling into the next function.
  return screen.slice(start, start + 900);
}

describe('A) The exact reported bug: the movement RPC call is no longer gated on quantity !== 0', () => {
  it('onConfirmRemove has no `if (removeTarget.quantity !== 0)` guard around the movement call', () => {
    const body = onConfirmRemoveBody();
    expect(body).not.toMatch(/if\s*\(\s*removeTarget\.quantity\s*!==\s*0\s*\)/);
  });

  it('applyAvailabilityMovement is called unconditionally as the first statement in the try block', () => {
    const body = onConfirmRemoveBody();
    const tryIdx = body.indexOf('try {');
    const callIdx = body.indexOf('await applyAvailabilityMovement(');
    expect(tryIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(tryIdx);
    // No `if` between try{ and the call.
    const between = body.slice(tryIdx, callIdx);
    expect(between).not.toMatch(/\bif\s*\(/);
  });
});

describe('B) The RPC call uses the exact parameters migration 053 requires', () => {
  const body = onConfirmRemoveBody();
  const callStart = body.indexOf('await applyAvailabilityMovement(');
  const callEnd = body.indexOf(');', callStart) + 2;
  const call = body.slice(callStart, callEnd);

  it('itemAvailabilityId is the target row id', () => {
    expect(call).toContain('itemAvailabilityId: removeTarget.id');
  });

  it('movementType is set_exact (not subtract, not add, not correction)', () => {
    expect(call).toContain("movementType: 'set_exact'");
    expect(call).not.toContain("movementType: 'subtract'");
    expect(call).not.toContain("movementType: 'add'");
    expect(call).not.toContain("movementType: 'correction'");
  });

  it('amount is exactly 0', () => {
    expect(call).toContain('amount: 0');
  });

  it('reason is the exact literal removed_from_outlet migration 053 branches on', () => {
    expect(call).toContain("reason: 'removed_from_outlet'");
  });

  it('this is a genuine RPC call (via the service wrapper), not a direct table write', () => {
    expect(screen).not.toMatch(/onConfirmRemove[\s\S]{0,900}\.from\('item_availability'\)/);
  });
});

describe('C) Works even when the row is already at quantity 0 (the exact failure scenario)', () => {
  it('applyAvailabilityMovement (the service wrapper) forwards amount=0 to the RPC without any client-side skip for zero quantity', () => {
    const start = availabilityService.indexOf('export async function applyAvailabilityMovement');
    const end = availabilityService.indexOf('\n}', start);
    const body = availabilityService.slice(start, end);
    expect(body).not.toMatch(/if\s*\(.*amount/);
    expect(body).toContain('p_amount:               input.amount');
  });

  it('phoenix_apply_availability_movement (migration 034) accepts set_exact with amount=0 — amount must be >= 0 for set_exact, not > 0 like add/subtract', () => {
    const migration034 = readFileSync(join(ROOT, 'supabase/migrations/034_phoenix_apply_availability_movement_rpc.sql'), 'utf8');
    expect(migration034).toMatch(/p_movement_type IN \('set_exact', 'correction'\) AND p_amount < 0/);
    expect(migration034).not.toMatch(/p_movement_type IN \('set_exact'.*\) AND p_amount <= 0/);
  });
});

describe('D) No subtract-0 path was used instead', () => {
  it('onConfirmRemove never uses movementType: \'subtract\'', () => {
    expect(onConfirmRemoveBody()).not.toContain("movementType: 'subtract'");
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
    expect(onConfirmRemoveBody()).toContain('applyAvailabilityMovement');
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
    expect(body).toContain('classifyAvailabilityMovementError(e)');
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
