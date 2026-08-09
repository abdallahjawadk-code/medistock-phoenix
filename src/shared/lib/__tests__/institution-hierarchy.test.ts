import { describe, it, expect } from 'vitest';
import {
  ORGANIZATION_KINDS,
  INSTITUTION_CLASSES,
  FACILITY_CLASSES,
  CLINICAL_LOCATION_KINDS,
  isOrganizationKind,
  isInstitutionClass,
  isFacilityClass,
  isClinicalLocationKind,
  institutionClassOwnsFacilities,
} from '../institution-hierarchy';

describe('institution hierarchy vocabulary', () => {
  it('exposes exactly the two organization kinds', () => {
    expect([...ORGANIZATION_KINDS]).toEqual([
      'care_institution',
      'pharmacy_department_authority',
    ]);
  });

  it('exposes exactly the three top-level institution classes', () => {
    expect([...INSTITUTION_CLASSES]).toEqual([
      'hospital',
      'specialized_center',
      'health_sector',
    ]);
  });

  it('exposes exactly the two subordinate facility classes', () => {
    expect([...FACILITY_CLASSES]).toEqual([
      'primary_health_center',
      'subordinate_health_center',
    ]);
  });

  it('exposes exactly the two clinical location kinds', () => {
    expect([...CLINICAL_LOCATION_KINDS]).toEqual(['emergency', 'non_emergency']);
  });

  it('freezes every vocabulary so a caller cannot mutate it at runtime', () => {
    expect(Object.isFrozen(ORGANIZATION_KINDS)).toBe(true);
    expect(Object.isFrozen(INSTITUTION_CLASSES)).toBe(true);
    expect(Object.isFrozen(FACILITY_CLASSES)).toBe(true);
    expect(Object.isFrozen(CLINICAL_LOCATION_KINDS)).toBe(true);
  });
});

describe('organization_kind and institution_class are orthogonal, not overlapping', () => {
  it('keeps the two vocabularies fully disjoint', () => {
    const overlap = (ORGANIZATION_KINDS as readonly string[])
      .filter((k) => (INSTITUTION_CLASSES as readonly string[]).includes(k));
    expect(overlap).toEqual([]);
  });

  it.each(['hospital', 'specialized_center', 'health_sector'])(
    'rejects %s as an organization kind',
    (value) => {
      expect(isOrganizationKind(value)).toBe(false);
    },
  );

  it.each(['care_institution', 'pharmacy_department_authority'])(
    'rejects %s as an institution class',
    (value) => {
      expect(isInstitutionClass(value)).toBe(false);
    },
  );
});

describe('health centres are facilities, never institution classes', () => {
  // The specific flattening error this vocabulary exists to prevent.
  it.each(['primary_health_center', 'subordinate_health_center'])(
    'rejects %s as an institution class',
    (value) => {
      expect(isInstitutionClass(value)).toBe(false);
      expect(INSTITUTION_CLASSES as readonly string[]).not.toContain(value);
    },
  );

  it.each(['hospital', 'specialized_center', 'health_sector'])(
    'rejects %s as a facility class',
    (value) => {
      expect(isFacilityClass(value)).toBe(false);
      expect(FACILITY_CLASSES as readonly string[]).not.toContain(value);
    },
  );

  it('keeps the two vocabularies fully disjoint', () => {
    const overlap = (INSTITUTION_CLASSES as readonly string[])
      .filter((c) => (FACILITY_CLASSES as readonly string[]).includes(c));
    expect(overlap).toEqual([]);
  });
});

describe('guards are fail-closed', () => {
  const NOT_VALUES = [
    null,
    undefined,
    '',
    '   ',
    'HOSPITAL',
    'Hospital',
    ' hospital ',
    'hospitals',
    'clinic',
    0,
    1,
    true,
    false,
    {},
    [],
    ['hospital'],
  ];

  it.each(NOT_VALUES)('isOrganizationKind rejects %o', (value) => {
    expect(isOrganizationKind(value)).toBe(false);
  });

  it.each(NOT_VALUES)('isInstitutionClass rejects %o', (value) => {
    expect(isInstitutionClass(value)).toBe(false);
  });

  it.each(NOT_VALUES)('isFacilityClass rejects %o', (value) => {
    expect(isFacilityClass(value)).toBe(false);
  });

  it.each(NOT_VALUES)('isClinicalLocationKind rejects %o', (value) => {
    expect(isClinicalLocationKind(value)).toBe(false);
  });

  it('accepts each canonical token exactly', () => {
    for (const k of ORGANIZATION_KINDS) expect(isOrganizationKind(k)).toBe(true);
    for (const c of INSTITUTION_CLASSES) expect(isInstitutionClass(c)).toBe(true);
    for (const c of FACILITY_CLASSES) expect(isFacilityClass(c)).toBe(true);
    for (const c of CLINICAL_LOCATION_KINDS) expect(isClinicalLocationKind(c)).toBe(true);
  });

  it('does not accept a near-miss clinical kind', () => {
    expect(isClinicalLocationKind('non-emergency')).toBe(false);
    expect(isClinicalLocationKind('nonemergency')).toBe(false);
    expect(isClinicalLocationKind('er')).toBe(false);
  });
});

describe('institutionClassOwnsFacilities', () => {
  it('is true only for a health sector', () => {
    expect(institutionClassOwnsFacilities('health_sector')).toBe(true);
  });

  it.each(['hospital', 'specialized_center', null, undefined, '', 'HEALTH_SECTOR'])(
    'is false for %o',
    (value) => {
      expect(institutionClassOwnsFacilities(value)).toBe(false);
    },
  );
});
