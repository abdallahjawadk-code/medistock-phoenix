/**
 * R1.2C — OUTLET AFFORDANCE MIRROR, exhaustively.
 *
 * The helper is a total, pure function of (owner kind, institution class, point
 * type, clinical context), so this file does not sample it — it enumerates the
 * WHOLE product of those axes and checks every cell against a table written out
 * longhand from Migration 183's own matrix.
 *
 * That matters more than it usually would: the helper's job is to agree with
 * the database. A test that derived its expectations from a rule would agree
 * with a wrong rule just as happily.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  EMERGENCY_OUTLET_POINT_TYPES,
  canCreateOutlets,
  isClinicalContextRequired,
  isEmergencyOutletPointType,
  isOutletShapeSubmittable,
  isSelectableOutletWarehouse,
  isStoredOutletShapeLegal,
  legalClinicalContexts,
  normalizeClinicalContext,
  selectableOutletPointTypes,
  selectableOutletWarehouses,
  type ApprovedOutletPointType,
  type OutletOwner,
} from '../outlet-affordances';
import type { ClinicalLocationKind } from '../institution-hierarchy';

const HOSPITAL: OutletOwner    = { organizationKind: 'care_institution', institutionClass: 'hospital' };
const SPECIALIZED: OutletOwner = { organizationKind: 'care_institution', institutionClass: 'specialized_center' };
const SECTOR: OutletOwner      = { organizationKind: 'care_institution', institutionClass: 'health_sector' };
const AUTHORITY: OutletOwner   = { organizationKind: 'pharmacy_department_authority', institutionClass: null };
const LOADING: OutletOwner     = { organizationKind: undefined, institutionClass: undefined };

const TYPES: ApprovedOutletPointType[] = ['pharmacy', 'crash_cabinet', 'rescue_cart'];
const CONTEXTS: (ClinicalLocationKind | '')[] = ['emergency', 'non_emergency', ''];

const WH = { facilityId: null };
const DEPOT = { facilityId: 'facility-1' };

// ════════════════════════════════════════════════════════════════════════════
// 1. THE CREATE AFFORDANCE
// ════════════════════════════════════════════════════════════════════════════
describe('who may create an outlet at all', () => {
  it('a hospital, a specialized centre and a health sector may', () => {
    for (const owner of [HOSPITAL, SPECIALIZED, SECTOR]) expect(canCreateOutlets(owner)).toBe(true);
  });

  it('a PHARMACY DEPARTMENT AUTHORITY may NOT — it holds no dispensing outlets', () => {
    expect(canCreateOutlets(AUTHORITY)).toBe(false);
    expect(selectableOutletPointTypes(AUTHORITY)).toEqual([]);
    // …and no warehouse of its own is offered as an outlet owner either, so the
    // NULL-warehouse shape Migration 171 could not see is unreachable here too.
    expect(isSelectableOutletWarehouse(AUTHORITY, WH)).toBe(false);
    expect(isSelectableOutletWarehouse(AUTHORITY, DEPOT)).toBe(false);
    expect(selectableOutletWarehouses(AUTHORITY, [WH, DEPOT])).toEqual([]);
  });

  it('an owner that is still loading FAILS CLOSED rather than guessing', () => {
    expect(canCreateOutlets(LOADING)).toBe(false);
    expect(selectableOutletPointTypes(LOADING)).toEqual([]);
    expect(selectableOutletWarehouses(LOADING, [WH, DEPOT])).toEqual([]);
  });

  it('a care institution whose class is unrecognised FAILS CLOSED', () => {
    const future = { organizationKind: 'care_institution', institutionClass: 'ambulatory_surgery_center' } as unknown as OutletOwner;
    expect(canCreateOutlets(future)).toBe(false);
    expect(selectableOutletPointTypes(future)).toEqual([]);
  });

  it('a kind/class mismatch is not silently reinterpreted', () => {
    // An authority row can never carry an institution class; if one appears,
    // the KIND still decides, exactly as Migration 183 keys branch A on kind.
    const malformed = { organizationKind: 'pharmacy_department_authority', institutionClass: 'hospital' } as unknown as OutletOwner;
    expect(canCreateOutlets(malformed)).toBe(false);
    expect(selectableOutletPointTypes(malformed)).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. THE TYPE AFFORDANCE
// ════════════════════════════════════════════════════════════════════════════
describe('which outlet types are offered', () => {
  it('a HOSPITAL offers all three, rescue cart included', () => {
    expect(selectableOutletPointTypes(HOSPITAL)).toEqual(['pharmacy', 'crash_cabinet', 'rescue_cart']);
  });

  it('a SPECIALIZED CENTRE excludes the rescue cart — it runs no emergency department', () => {
    expect(selectableOutletPointTypes(SPECIALIZED)).toEqual(['pharmacy', 'crash_cabinet']);
    expect(selectableOutletPointTypes(SPECIALIZED)).not.toContain('rescue_cart');
  });

  it('a HEALTH SECTOR excludes the rescue cart — a health centre has no counterpart', () => {
    expect(selectableOutletPointTypes(SECTOR)).toEqual(['pharmacy', 'crash_cabinet']);
    expect(selectableOutletPointTypes(SECTOR)).not.toContain('rescue_cart');
  });

  it('the offered lists are frozen, so a caller cannot mutate the matrix', () => {
    for (const owner of [HOSPITAL, SPECIALIZED, SECTOR, AUTHORITY]) {
      expect(Object.isFrozen(selectableOutletPointTypes(owner))).toBe(true);
    }
    expect(Object.isFrozen(EMERGENCY_OUTLET_POINT_TYPES)).toBe(true);
  });

  it('the emergency types are exactly the crash cabinet and the rescue cart', () => {
    expect([...EMERGENCY_OUTLET_POINT_TYPES]).toEqual(['crash_cabinet', 'rescue_cart']);
    expect(isEmergencyOutletPointType('crash_cabinet')).toBe(true);
    expect(isEmergencyOutletPointType('rescue_cart')).toBe(true);
    expect(isEmergencyOutletPointType('pharmacy')).toBe(false);
    expect(isEmergencyOutletPointType('storage')).toBe(false);
    expect(isClinicalContextRequired('pharmacy')).toBe(false);
    expect(isClinicalContextRequired('crash_cabinet')).toBe(true);
    expect(isClinicalContextRequired('rescue_cart')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. THE CLINICAL CONTEXT — the inversion, stated cell by cell
// ════════════════════════════════════════════════════════════════════════════
describe('which clinical context each combination permits', () => {
  it('HOSPITAL · crash cabinet -> non_emergency (a ward cabinet)', () => {
    expect(legalClinicalContexts(HOSPITAL, 'crash_cabinet')).toEqual(['non_emergency']);
  });

  it('HOSPITAL · rescue cart -> emergency (the ED trolley)', () => {
    expect(legalClinicalContexts(HOSPITAL, 'rescue_cart')).toEqual(['emergency']);
  });

  it('SPECIALIZED · crash cabinet -> non_emergency', () => {
    expect(legalClinicalContexts(SPECIALIZED, 'crash_cabinet')).toEqual(['non_emergency']);
  });

  it('HEALTH SECTOR · crash cabinet -> emergency — the INVERSION', () => {
    // A health centre has no emergency department, so its crash cabinet IS the
    // emergency location. This cell is the one most likely to be "corrected"
    // into agreement with the hospital reading; it must not be.
    expect(legalClinicalContexts(SECTOR, 'crash_cabinet')).toEqual(['emergency']);
    expect(legalClinicalContexts(SECTOR, 'crash_cabinet'))
      .not.toEqual(legalClinicalContexts(HOSPITAL, 'crash_cabinet'));
  });

  it('a forbidden type has NO legal context at all', () => {
    expect(legalClinicalContexts(SPECIALIZED, 'rescue_cart')).toEqual([]);
    expect(legalClinicalContexts(SECTOR, 'rescue_cart')).toEqual([]);
    expect(legalClinicalContexts(AUTHORITY, 'pharmacy')).toEqual([]);
    expect(legalClinicalContexts(LOADING, 'crash_cabinet')).toEqual([]);
  });

  it('a PHARMACY is not over-constrained — an ER pharmacy is legitimate', () => {
    for (const owner of [HOSPITAL, SPECIALIZED, SECTOR]) {
      expect([...legalClinicalContexts(owner, 'pharmacy')].sort())
        .toEqual(['emergency', 'non_emergency']);
      expect(isOutletShapeSubmittable(owner, 'pharmacy', '', 'wh')).toBe(true);
      expect(isOutletShapeSubmittable(owner, 'pharmacy', 'emergency', 'wh')).toBe(true);
    }
  });

  it('every legal EMERGENCY combination has exactly one context, so it can be normalised', () => {
    for (const owner of [HOSPITAL, SPECIALIZED, SECTOR]) {
      for (const type of EMERGENCY_OUTLET_POINT_TYPES) {
        const legal = legalClinicalContexts(owner, type);
        if (legal.length === 0) continue; // the type is forbidden for this owner
        expect(legal, `${String(owner.institutionClass)}/${type}`).toHaveLength(1);
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. NORMALISATION — the stale-context bug
// ════════════════════════════════════════════════════════════════════════════
describe('changing the point type cannot preserve a stale incompatible context', () => {
  it('rescue cart -> crash cabinet drops emergency and adopts non_emergency', () => {
    expect(normalizeClinicalContext(HOSPITAL, 'crash_cabinet', 'emergency')).toBe('non_emergency');
  });

  it('crash cabinet -> rescue cart drops non_emergency and adopts emergency', () => {
    expect(normalizeClinicalContext(HOSPITAL, 'rescue_cart', 'non_emergency')).toBe('emergency');
  });

  it('inside a health sector the crash cabinet normalises to emergency, not non_emergency', () => {
    expect(normalizeClinicalContext(SECTOR, 'crash_cabinet', 'non_emergency')).toBe('emergency');
    expect(normalizeClinicalContext(SECTOR, 'crash_cabinet', '')).toBe('emergency');
  });

  it('a blank context is never left blank for an emergency type', () => {
    expect(normalizeClinicalContext(HOSPITAL, 'crash_cabinet', '')).toBe('non_emergency');
    expect(normalizeClinicalContext(HOSPITAL, 'rescue_cart', '')).toBe('emergency');
    expect(normalizeClinicalContext(SPECIALIZED, 'crash_cabinet', null)).toBe('non_emergency');
  });

  it('a pharmacy keeps a legal context and drops nothing legal', () => {
    expect(normalizeClinicalContext(HOSPITAL, 'pharmacy', 'emergency')).toBe('emergency');
    expect(normalizeClinicalContext(HOSPITAL, 'pharmacy', 'non_emergency')).toBe('non_emergency');
    expect(normalizeClinicalContext(HOSPITAL, 'pharmacy', '')).toBe('');
  });

  it('a forbidden combination normalises to blank rather than to a guess', () => {
    expect(normalizeClinicalContext(SPECIALIZED, 'rescue_cart', 'emergency')).toBe('');
    expect(normalizeClinicalContext(SECTOR, 'rescue_cart', 'emergency')).toBe('');
    expect(normalizeClinicalContext(AUTHORITY, 'crash_cabinet', 'non_emergency')).toBe('');
  });

  it('normalisation is IDEMPOTENT — re-running it never oscillates', () => {
    for (const owner of [HOSPITAL, SPECIALIZED, SECTOR, AUTHORITY, LOADING]) {
      for (const type of TYPES) {
        for (const context of CONTEXTS) {
          const once = normalizeClinicalContext(owner, type, context);
          expect(normalizeClinicalContext(owner, type, once)).toBe(once);
        }
      }
    }
  });

  it('normalisation always yields a SUBMITTABLE shape wherever one exists', () => {
    for (const owner of [HOSPITAL, SPECIALIZED, SECTOR]) {
      for (const type of selectableOutletPointTypes(owner)) {
        for (const context of CONTEXTS) {
          const normalized = normalizeClinicalContext(owner, type, context);
          expect(
            isOutletShapeSubmittable(owner, type, normalized, 'wh-1'),
            `${String(owner.institutionClass)}/${type}/${context}`,
          ).toBe(true);
        }
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. SUBMITTABILITY — the "*" and canSubmit now agree
// ════════════════════════════════════════════════════════════════════════════
describe('form validity', () => {
  it('a required emergency context can NEVER be left blank on submit', () => {
    // The exact defect R1.2C fixes: the label rendered "*" while canSubmit
    // ignored the field entirely.
    for (const owner of [HOSPITAL, SPECIALIZED, SECTOR]) {
      for (const type of selectableOutletPointTypes(owner)) {
        if (!isClinicalContextRequired(type)) continue;
        expect(isOutletShapeSubmittable(owner, type, '', 'wh-1'), `${type} blank`).toBe(false);
        expect(isOutletShapeSubmittable(owner, type, null, 'wh-1'), `${type} null`).toBe(false);
      }
    }
  });

  it('an emergency outlet must name an owning warehouse; a pharmacy need not', () => {
    expect(isOutletShapeSubmittable(HOSPITAL, 'crash_cabinet', 'non_emergency', null)).toBe(false);
    expect(isOutletShapeSubmittable(HOSPITAL, 'rescue_cart', 'emergency', '')).toBe(false);
    expect(isOutletShapeSubmittable(HOSPITAL, 'crash_cabinet', 'non_emergency', 'wh-1')).toBe(true);
    // Migration 021's nullable-warehouse freedom, preserved for a pharmacy.
    expect(isOutletShapeSubmittable(HOSPITAL, 'pharmacy', '', null)).toBe(true);
  });

  it('EXHAUSTIVE · every owner × type × context cell matches the declared matrix', () => {
    // The full truth table, written out rather than derived.
    const SUBMITTABLE = new Set([
      'hospital|pharmacy|emergency', 'hospital|pharmacy|non_emergency', 'hospital|pharmacy|',
      'hospital|crash_cabinet|non_emergency',
      'hospital|rescue_cart|emergency',
      'specialized_center|pharmacy|emergency', 'specialized_center|pharmacy|non_emergency', 'specialized_center|pharmacy|',
      'specialized_center|crash_cabinet|non_emergency',
      'health_sector|pharmacy|emergency', 'health_sector|pharmacy|non_emergency', 'health_sector|pharmacy|',
      'health_sector|crash_cabinet|emergency',
    ]);

    for (const owner of [HOSPITAL, SPECIALIZED, SECTOR, AUTHORITY, LOADING]) {
      for (const type of TYPES) {
        for (const context of CONTEXTS) {
          const key = `${String(owner.institutionClass ?? 'none')}|${type}|${context}`;
          expect(isOutletShapeSubmittable(owner, type, context, 'wh-1'), key)
            .toBe(SUBMITTABLE.has(key));
        }
      }
    }
  });

  it('an unknown point type is never submittable, for any owner', () => {
    for (const owner of [HOSPITAL, SPECIALIZED, SECTOR, AUTHORITY, LOADING]) {
      for (const type of ['storage', 'returns', 'dispensing', 'emergency', '']) {
        expect(isOutletShapeSubmittable(owner, type, 'emergency', 'wh-1'), type).toBe(false);
      }
    }
  });

  it('the stored-shape check is the SAME question, so history is judged identically', () => {
    // isStoredOutletShapeLegal exists to read honestly, not to apply a softer
    // rule — a second, laxer standard for existing rows is how illegal state
    // becomes permanent.
    for (const owner of [HOSPITAL, SPECIALIZED, SECTOR, AUTHORITY, LOADING]) {
      for (const type of TYPES) {
        for (const context of CONTEXTS) {
          expect(isStoredOutletShapeLegal(owner, type, context, 'wh-1'))
            .toBe(isOutletShapeSubmittable(owner, type, context, 'wh-1'));
        }
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. WAREHOUSE FILTERING — the Sector Main is never offered
// ════════════════════════════════════════════════════════════════════════════
describe('which warehouses may own an outlet', () => {
  it('inside a HEALTH SECTOR only facility-bound centre depots are offered', () => {
    expect(isSelectableOutletWarehouse(SECTOR, DEPOT)).toBe(true);
    // The Sector Main carries no facility — it is a supply root, never a
    // dispensing location, and the database refuses an outlet on it.
    expect(isSelectableOutletWarehouse(SECTOR, WH)).toBe(false);
    expect(selectableOutletWarehouses(SECTOR, [WH, DEPOT])).toEqual([DEPOT]);
  });

  it('a hospital and a specialized centre keep every warehouse', () => {
    for (const owner of [HOSPITAL, SPECIALIZED]) {
      expect(selectableOutletWarehouses(owner, [WH, DEPOT])).toEqual([WH, DEPOT]);
    }
  });

  it('filtering never mutates the caller list', () => {
    const list = [WH, DEPOT];
    selectableOutletWarehouses(SECTOR, list);
    expect(list).toEqual([WH, DEPOT]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. PURITY — this module is a mirror, and must be unable to become authority
// ════════════════════════════════════════════════════════════════════════════
describe('the helper is pure presentation', () => {
  const src = readFileSync(join(__dirname, '../outlet-affordances.ts'), 'utf8');

  it('performs no I/O, no database access and no service call', () => {
    const code = src.split('\n').filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    expect(code).not.toMatch(/\bfrom\s+['"](node:)?fs['"]/);
    expect(code).not.toMatch(/\bsupabase\b|\bcallRpc\b|\bfetch\(/);
    expect(code).not.toMatch(/\bfrom\s+['"]react['"]/);
    expect(code).not.toMatch(/\bprocess\.env\b/);
    expect(code).not.toMatch(/\bawait\b|\basync\b/);
  });

  it('imports only the hierarchy VOCABULARY, and only as types', () => {
    const imports = [...src.matchAll(/^import\s+(type\s+)?\{[\s\S]*?\}\s+from\s+'([^']+)';$/gm)];
    expect(imports.map(m => m[2])).toEqual(['./institution-hierarchy']);
    expect(imports[0][1], 'the vocabulary must be imported as types only').toBeTruthy();
  });

  it('does NOT turn institution-hierarchy.ts into a decision module', () => {
    const hierarchy = readFileSync(join(__dirname, '../institution-hierarchy.ts'), 'utf8');
    // CODE only: that module's header legitimately DOCUMENTS the outlet types
    // as part of the hierarchy it describes. What it must never acquire is a
    // rule that decides anything about them.
    const code = hierarchy
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
    expect(code).not.toContain('crash_cabinet');
    expect(code).not.toContain('rescue_cart');
    expect(code).not.toContain('canCreateOutlets');
    expect(code).not.toMatch(/legalClinicalContexts|selectableOutlet/);
    expect(hierarchy).toContain('TYPES AND VOCABULARY ONLY');
  });

  it('states outright that the database is the authority', () => {
    expect(src).toMatch(/phoenix_assert_active_outlet_topology_v1/);
    expect(src).toMatch(/That validator is the AUTHORITY/);
    expect(src).toMatch(/IT IS SHARED BY CREATE AND EDIT/);
    expect(src).toMatch(/IT FAILS CLOSED/);
  });

  it('declares no test bypass', () => {
    expect(src).not.toMatch(/\.(skip|only|todo)\(/);
  });
});
