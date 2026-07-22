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
  it('NO production module calls upsertAvailability — the manual balance writer is fully retired', () => {
    // `await upsertAvailability(` is the CALL form — it excludes the service's
    // own `export async function upsertAvailability(` definition.
    const callers = productionSourceFiles()
      .filter(f => readFileSync(f, 'utf8').includes('await upsertAvailability('))
      .map(f => f.replace(/\\/g, '/').split('/src/')[1])
      .sort();

    // Was three, then one (ReactivateMaterialModal). Migration 084 converted the
    // last caller to visibility-only, so the manual balance writer is now
    // reachable from NO surface. A new caller here fails and forces a re-audit.
    expect(callers).toEqual([]);
  });

  it('the reactivation surface writes NO quantity — it only toggles catalogue visibility (084)', () => {
    const modal = readSrc('features/status/ReactivateMaterialModal.tsx');
    // The strongest possible form of "no silent overwrite": the surface makes no
    // quantity write at all. It clears the 053 removed marker via the
    // visibility RPC; quantity/condition stay derived from the canonical ledger.
    expect(modal).toContain('setAvailabilityVisibility');
    expect(modal).not.toContain('applyAvailabilityMovement');
    expect(modal).not.toContain('upsertAvailability');
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

describe('CANONICAL-STOCK-CUTOVER: Status Center corrections route to the canonical lot-level path', () => {
  it('Status Center no longer mounts the retired item_availability writer, and mounts the canonical correction launcher', () => {
    const status = readSrc('features/status/StatusCenterScreen.tsx');
    expect(status).not.toContain('<AdjustQuantityModal');
    expect(status).toContain('<AvailabilityStockCorrectionModal');
  });

  it('Status Center itself calls no item_availability quantity writer', () => {
    const status = readSrc('features/status/StatusCenterScreen.tsx');
    expect(status).not.toContain('applyAvailabilityMovement');
    expect(status).not.toContain('upsertAvailability');
  });

  it('the correction launcher forces explicit canonical lot selection and the guarded 086 path', () => {
    const launcher = readSrc('features/status/AvailabilityStockCorrectionModal.tsx');
    expect(launcher).toContain('getOutletStock(');
    expect(launcher).toContain('OutletStockCorrectionModal');
    expect(launcher).not.toContain('applyAvailabilityMovement');
  });
});
