/**
 * STAGE-E-1 vocabulary contract.
 *
 * Stage E rests on several vocabularies that already exist and MUST NOT drift
 * while it is built. This file pins them so a change fails loudly here rather
 * than silently downstream.
 *
 * Two mechanisms are used together:
 *
 *   1. COMPILE-TIME bidirectional type equality (`AssertEqual`). A runtime array
 *      only proves the listed members are valid; it cannot detect a SEVENTH
 *      member being added to a union. The type-level assertion catches both
 *      additions and removals, and `npm run typecheck` enforces it.
 *
 *   2. RUNTIME assertions over the real exported values and, where the value is
 *      a literal in a source file, over that file's text — the same
 *      source-reading contract style used elsewhere in this repo.
 *
 * This file asserts NON-CHANGE. It is not a place to add Stage-E behaviour.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

import type { RawAvailabilityCondition } from '../status/canonical';
import type {
  ApprovedPointType,
  LegacyPointType,
  WarehouseKind,
} from '@/shared/supabase/services/warehouses.service';
import type { CanonicalSupplyType, PurchaseOrigin } from '../supply-types';
import { SUPPLY_TYPES } from '../supply-types';
import { REASON_CODE_LABEL_KEY } from '../movement-labels';

const SRC = join(__dirname, '../../../');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');

/** Bidirectional type equality: true only when A and B are the same union. */
type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe('the pinning mechanism itself discriminates', () => {
  // Without this, every AssertEqual below could be vacuously `true` and the
  // whole file would pin nothing. A narrower union must resolve to `false`,
  // and a wider one must too — both directions are checked by typecheck.
  it('resolves to false for a narrower union', () => {
    const narrower: AssertEqual<RawAvailabilityCondition, 'available'> = false;
    expect(narrower).toBe(false);
  });

  it('resolves to false for a wider union', () => {
    const wider: AssertEqual<
      RawAvailabilityCondition,
      | 'available' | 'low_stock' | 'missing' | 'surplus' | 'near_expiry' | 'expired'
      | 'near_stockout'
    > = false;
    expect(wider).toBe(false);
  });

  it('resolves to true only for an exact match', () => {
    const same: AssertEqual<'a' | 'b', 'b' | 'a'> = true;
    expect(same).toBe(true);
  });
});

describe('Availability vocabulary is unchanged (absolute non-change)', () => {
  it('accepts exactly the six migration-001 conditions, at type level', () => {
    const exact: AssertEqual<
      RawAvailabilityCondition,
      'available' | 'low_stock' | 'missing' | 'surplus' | 'near_expiry' | 'expired'
    > = true;
    expect(exact).toBe(true);
  });

  it('has NOT introduced near_stockout anywhere in the availability vocabulary', () => {
    const canonical = read('shared/lib/status/canonical.ts');
    expect(canonical).not.toContain('near_stockout');
  });

  it('keeps the two extended states outside the six-value condition set', () => {
    // `unknown` / `not_stocked` are epistemic states, deliberately separate.
    const canonical = read('shared/lib/status/canonical.ts');
    expect(canonical).toContain("| 'unknown'");
    expect(canonical).toContain("| 'not_stocked'");
  });
});

describe('Outlet point-type vocabulary is unchanged', () => {
  it('approves exactly pharmacy | crash_cabinet | rescue_cart', () => {
    const exact: AssertEqual<
      ApprovedPointType,
      'pharmacy' | 'crash_cabinet' | 'rescue_cart'
    > = true;
    expect(exact).toBe(true);
  });

  it('still reads the four legacy point types', () => {
    const exact: AssertEqual<
      LegacyPointType,
      'dispensing' | 'storage' | 'returns' | 'emergency'
    > = true;
    expect(exact).toBe(true);
  });

  it('has not introduced a per-outlet-type stock table reference', () => {
    const service = read('shared/supabase/services/warehouses.service.ts');
    for (const forbidden of ['pharmacy_stock', 'rescue_cart_stock', 'crash_cabinet_stock']) {
      expect(service).not.toContain(forbidden);
    }
  });
});

describe('Warehouse kind vocabulary is unchanged', () => {
  // Widening this is unsafe: existing server-side guards test it by equality,
  // and supplementary/local procurement requires 'institution' exactly.
  it('is exactly central | institution', () => {
    const exact: AssertEqual<WarehouseKind, 'central' | 'institution'> = true;
    expect(exact).toBe(true);
  });

  it('has not added a facility-role value to warehouse kind', () => {
    const service = read('shared/supabase/services/warehouses.service.ts');
    for (const forbidden of [
      'sector_depot',
      'hospital_depot',
      'specialized_center_depot',
      'primary_health_center_depot',
      'subordinate_health_center_depot',
    ]) {
      expect(service).not.toContain(forbidden);
    }
  });
});

describe('Supply provenance vocabulary is unchanged', () => {
  it('is exactly aid | purchase | kimadia', () => {
    const exact: AssertEqual<CanonicalSupplyType, 'aid' | 'purchase' | 'kimadia'> = true;
    expect(exact).toBe(true);
    expect([...SUPPLY_TYPES]).toEqual(['aid', 'purchase', 'kimadia']);
  });

  it('keeps purchase origin at central | supplementary', () => {
    const exact: AssertEqual<PurchaseOrigin, 'central' | 'supplementary'> = true;
    expect(exact).toBe(true);
  });
});

describe('Movement reason-code vocabulary is unchanged', () => {
  it('still carries exactly the 16 migration-125 reason codes', () => {
    expect(Object.keys(REASON_CODE_LABEL_KEY).sort()).toEqual(
      [
        'corrected',
        'counted',
        'damaged',
        'dispensed',
        'excess',
        'expired',
        'legacy_unclassified',
        'near_expiry',
        'other',
        'quality_issue',
        'recalled',
        'received',
        'released',
        'shipment_error',
        'temperature_excursion',
        'transferred',
      ].sort(),
    );
  });

  it('already provides the reason code the replenishment corridor will reuse', () => {
    // No new reason code is needed for Stage E; 'transferred' already exists.
    expect(REASON_CODE_LABEL_KEY).toHaveProperty('transferred');
  });
});

describe('Crash cabinet display name', () => {
  const strings = read('shared/i18n/strings.ts');

  it('uses the authoritative Arabic label دولاب الصدمة', () => {
    expect(strings).toContain("port_type_crash_cabinet: { ar: 'دولاب الصدمة'");
  });

  it('no longer uses the previous label دولاب صدمة', () => {
    expect(strings).not.toContain("ar: 'دولاب صدمة'");
  });

  it('keeps the persisted key crash_cabinet unrenamed', () => {
    const service = read('shared/supabase/services/warehouses.service.ts');
    expect(service).toContain("'crash_cabinet'");
    expect(strings).toContain('port_type_crash_cabinet');
  });
});
