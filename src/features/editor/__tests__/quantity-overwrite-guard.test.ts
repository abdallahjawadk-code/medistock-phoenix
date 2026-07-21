/**
 * EDITOR-QUANTITY-SILENT-OVERWRITE-GUARD-A — retired-surface revision (E6).
 *
 * ORIGINAL INVARIANT (still in force): a quantity change to an EXISTING
 * item_availability row must never be a silent overwrite. It has to go through
 * a recorded movement — applyAvailabilityMovement /
 * phoenix_apply_availability_movement (migration 034) — enforced at the
 * database by migration 035's quantity_update_requires_movement guard.
 *
 * WHAT CHANGED: the original file proved that invariant by asserting how
 * EditorScreen's form behaved — its quantity input going read-only in edit
 * mode, doApply sending the existing quantity rather than local state, and so
 * on. EditorScreen is now RETIRED, so those assertions have no subject.
 *
 * They are NOT simply deleted — that would drop the protection at the moment it
 * matters most. Each is re-expressed against whatever now enforces the same
 * invariant: the retired screen stays absent, screen 3 stays the Inventory
 * Center, no surviving surface performs a bare manual quantity overwrite, and
 * the replacement screen derives condition from the ledger instead of taking a
 * typed-in number.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  expectRetiredSurfaceAbsent,
  expectScreenThreeIsInventoryCenter,
  expectQuickAvailFormAbsent,
  productionSourceFiles,
} from '../../../../tests/helpers/retired-surfaces';

const SRC = join(__dirname, '../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

describe('the silent-overwrite surface is retired, not merely unused', () => {
  it('EditorScreen is deleted, unimported and unrendered', () => {
    expectRetiredSurfaceAbsent('EditorScreen');
  });

  it('screen 3 routes to the Inventory Center that replaced it', () => {
    expectScreenThreeIsInventoryCenter();
  });

  it('the QuickAvailForm manual writer is gone from InstitutionScreen too', () => {
    expectQuickAvailFormAbsent();
  });
});

describe('no surviving surface can overwrite a quantity silently', () => {
  it('exactly one production module still calls upsertAvailability', () => {
    // `await upsertAvailability(` is the CALL form — it excludes the service's
    // own `export async function upsertAvailability(` definition.
    const callers = productionSourceFiles()
      .filter(f => readFileSync(f, 'utf8').includes('await upsertAvailability('))
      .map(f => f.replace(/\\/g, '/').split('/src/')[1])
      .sort();

    // ReactivateMaterialModal is the last legacy writer, tracked as deployment
    // blocker 3. If a NEW caller appears this fails, and the audit has to be
    // redone before it can ship.
    expect(callers).toEqual(['features/status/ReactivateMaterialModal.tsx']);
  });

  it('that remaining caller moves quantity through a RECORDED movement first', () => {
    const modal = readSrc('features/status/ReactivateMaterialModal.tsx');
    // Migration 035's guard: the upsert may only restate a quantity a movement
    // has already set, so the movement call must be present.
    expect(modal).toContain('applyAvailabilityMovement');
    expect(modal).toContain('reactivated_from_removed');
  });

  it('the recorded-movement RPC remains the only permitted quantity write', () => {
    const service = readSrc('shared/supabase/services/availability.service.ts');
    expect(service).toContain('phoenix_apply_availability_movement');
  });
});

describe('the replacement screen derives condition from the ledger', () => {
  const inventory = readSrc('features/inventory/InventoryCenterScreen.tsx');

  it('never calls the legacy manual availability writer', () => {
    expect(inventory).not.toContain('upsertAvailability');
  });

  it('states plainly that condition is derived, never hand-entered', () => {
    expect(inventory).toContain('inv_derived_notice');
  });
});

describe('adjacent surfaces stay untouched by this retirement', () => {
  it('Status Center still owns Adjust Quantity via the movement modal', () => {
    const status = readSrc('features/status/StatusCenterScreen.tsx');
    expect(status).toContain('AdjustQuantityModal');
  });

  it('AdjustQuantityModal still calls the movement service, not a raw RPC', () => {
    const modal = readSrc('features/status/AdjustQuantityModal.tsx');
    expect(modal).toContain('applyAvailabilityMovement');
    expect(modal).not.toContain("supabase.rpc('phoenix_apply_availability_movement'");
  });

  it('the locked-quantity helper string is preserved for the movement UX', () => {
    const strings = readSrc('shared/i18n/strings.ts');
    expect(strings).toContain('avail_qty_locked_note');
  });
});
