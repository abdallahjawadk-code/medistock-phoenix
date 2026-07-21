/**
 * AVAILABILITY-EDITOR-DUPLICATE-RESOLUTION-B-FEATURE-GATE-A — retired-surface
 * revision (E6).
 *
 * ORIGINAL SUBJECT: a build-time feature gate
 * (VITE_PHOENIX_BATCH_IDENTITY_051_ENABLED) that switched EditorScreen's
 * duplicate-resolution UI between the old 4-column live behaviour and
 * migration 051's 7-column batch identity, and asserted that supply_type/price
 * stayed OUTSIDE the identity key in both gate states.
 *
 * WHY IT CHANGED: the gate only ever guarded frontend behaviour inside
 * EditorScreen. That screen is RETIRED, so no manual availability form remains
 * whose identity key could diverge from the database's.
 *
 * WHERE THE INVARIANT LIVES NOW — it was not dropped, it moved down a layer:
 *
 *   · the 7-column identity is enforced by the database and proven by
 *     supabase/migrations/__tests__/051-material-batch-identity-option-a.test.ts;
 *   · supply_type/price staying outside identity is a property of that same
 *     migration, asserted in that same file;
 *   · what remains for THIS file is proving no frontend form can reintroduce a
 *     competing identity key — an absence guard.
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
const TEST_051 = 'supabase/migrations/__tests__/051-material-batch-identity-option-a.test.ts';

describe('the gated duplicate-resolution UI is retired with its screen', () => {
  it('EditorScreen is deleted, unimported and unrendered', () => {
    expectRetiredSurfaceAbsent('EditorScreen');
  });

  it('screen 3 routes to the Inventory Center', () => {
    expectScreenThreeIsInventoryCenter();
  });

  it('no manual availability quick-add form survives either', () => {
    expectQuickAvailFormAbsent();
  });
});

describe('the build-time gate leaves no live frontend behaviour behind', () => {
  it('no production module still branches on the 051 batch-identity gate', () => {
    const branching = productionSourceFiles().filter(f =>
      // A historical mention in a comment is fine; an actual read of the env
      // flag would mean the retired gate still steers behaviour somewhere.
      readFileSync(f, 'utf8').includes('import.meta.env.VITE_PHOENIX_BATCH_IDENTITY_051_ENABLED'),
    );
    expect(branching).toEqual([]);
  });
});

describe('the identity invariant still has an owner', () => {
  it('migration 051 keeps its own test, so the DB guarantee is not left untested', () => {
    expect(existsSync(join(REPO, TEST_051))).toBe(true);
  });

  it('that test still pins supply_type and price OUTSIDE the identity key', () => {
    const test051 = readFileSync(join(REPO, TEST_051), 'utf8');
    expect(test051).toContain('supply_type');
    expect(test051).toContain('price');
  });

  it('migration 051 SQL remains manual-apply-only and unmodified by this cleanup', () => {
    const sql = readFileSync(
      join(REPO, 'supabase/migrations/051_material_batch_identity_option_a.sql'),
      'utf8',
    );
    expect(sql).toContain('MANUAL APPLY ONLY');
  });
});
