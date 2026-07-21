/**
 * AVAILABILITY-EDITOR-DUPLICATE-RESOLUTION-B-PREP-A — retired-surface revision
 * (E6).
 *
 * ORIGINAL SUBJECT: EditorScreen's frontend preparation for migration 051 —
 * the strict 7-column existing-row match, similar-product detection, the
 * independent-row confirmation panel, the quantity lock applying ONLY to an
 * exact match, and the rule that identity fields are never silently cleared or
 * auto-filled from a similar row.
 *
 * WHY IT CHANGED: all of those behaviours lived inside EditorScreen's manual
 * availability form. That screen is RETIRED, so they no longer exist to assert.
 *
 * WHERE THE INVARIANTS LIVE NOW — none were dropped:
 *
 *   · the 7-column identity and its UPDATE-vs-INSERT resolution are database
 *     properties, proven by
 *     supabase/migrations/__tests__/051-material-batch-identity-option-a.test.ts;
 *   · "a quantity change needs a recorded movement" — the reason the quantity
 *     lock existed — is enforced by migration 035 and guarded in
 *     quantity-overwrite-guard.test.ts against the surviving writer;
 *   · "no silent clearing or auto-fill of identity fields" is moot without a
 *     manual form, and becomes the absence guard below.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  expectRetiredSurfaceAbsent,
  expectScreenThreeIsInventoryCenter,
  expectQuickAvailFormAbsent,
  productionSourceFiles,
} from '../../../../tests/helpers/retired-surfaces';

const REPO = join(__dirname, '../../../../');
const SRC = join(__dirname, '../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const TEST_051 = 'supabase/migrations/__tests__/051-material-batch-identity-option-a.test.ts';

describe('the manual duplicate-resolution form is retired', () => {
  it('EditorScreen is deleted, unimported and unrendered', () => {
    expectRetiredSurfaceAbsent('EditorScreen');
  });

  it('screen 3 routes to the Inventory Center', () => {
    expectScreenThreeIsInventoryCenter();
  });

  it('the QuickAvailForm manual writer is retired too', () => {
    expectQuickAvailFormAbsent();
  });
});

describe('no surviving surface re-implements a client-side identity match', () => {
  it('no production module computes its own strict existing-row key', () => {
    const offenders = productionSourceFiles().filter(f => {
      const text = readFileSync(f, 'utf8');
      return text.includes('strictExactExistingRow') || text.includes('primarySimilarRow');
    });
    expect(offenders).toEqual([]);
  });

  it('the Inventory Center performs no manual availability write at all', () => {
    const inventory = readSrc('features/inventory/InventoryCenterScreen.tsx');
    expect(inventory).not.toContain('upsertAvailability');
    // Condition is derived from the ledger, so there is no identity form in
    // which duplicates would need resolving.
    expect(inventory).toContain('inv_derived_notice');
  });
});

describe('the invariants that outlived the screen still have owners', () => {
  it('migration 051 keeps its own test for the identity resolution', () => {
    expect(existsSync(join(REPO, TEST_051))).toBe(true);
  });

  it('migration 051 SQL is unchanged by this cleanup and stays manual-apply-only', () => {
    const sql = readFileSync(
      join(REPO, 'supabase/migrations/051_material_batch_identity_option_a.sql'),
      'utf8',
    );
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toContain('Does NOT modify any frontend file');
  });

  it('the quantity-lock rationale is now guarded against the surviving writer', () => {
    const guard = readSrc('features/editor/__tests__/quantity-overwrite-guard.test.ts');
    expect(guard).toContain('applyAvailabilityMovement');
    expect(guard).toContain('ReactivateMaterialModal');
  });
});
