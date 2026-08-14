/**
 * R1.1-P (P2-A) — HEALTH-SECTOR RESOURCE GROUPING.
 *
 * The institution screen rendered every distribution point in one flat
 * `points.map(...)`, so a sector's centres, its sector main and their outlets
 * were indistinguishable. These tests pin the canonical hierarchy, and — more
 * importantly — pin the two properties that make it TRUSTWORTHY rather than
 * merely tidy:
 *
 *   • nothing is grouped by NAME, only by facility_id / warehouse_id identity;
 *   • no pre-existing row is ever moved or hidden to make the picture clean.
 */
import { describe, it, expect } from 'vitest';
import {
  groupHealthSectorResources,
  isHealthSectorOwner,
  type GroupableFacility,
} from '../health-sector-grouping';

const SECTOR = { organizationKind: 'care_institution', institutionClass: 'health_sector' };

const wh = (
  id: string, facilityId: string | null,
  over: Partial<{ organizationId: string; warehouseKind: string; status: string }> = {},
) => ({
  id, facilityId,
  organizationId: over.organizationId ?? 'org-sector',
  warehouseKind: over.warehouseKind ?? 'institution',
  status: over.status ?? 'active',
});

const outlet = (id: string, warehouseId: string | null) => ({ id, warehouseId });

const facility = (id: string, name: string, status = 'active'): GroupableFacility =>
  ({ id, name, nameAr: `${name}-ar`, status });

describe('owner classification', () => {
  it('only a care_institution health_sector is grouped', () => {
    expect(isHealthSectorOwner('care_institution', 'health_sector')).toBe(true);
    expect(isHealthSectorOwner('care_institution', 'hospital')).toBe(false);
    expect(isHealthSectorOwner('care_institution', 'specialized_center')).toBe(false);
    expect(isHealthSectorOwner('pharmacy_department_authority', null)).toBe(false);
    expect(isHealthSectorOwner(null, null)).toBe(false);
    expect(isHealthSectorOwner(undefined, undefined)).toBe(false);
  });

  it('a hospital and a specialized centre keep their existing flat view (null)', () => {
    for (const institutionClass of ['hospital', 'specialized_center', null, undefined]) {
      expect(groupHealthSectorResources(
        { organizationKind: 'care_institution', institutionClass },
        [wh('w1', null)], [outlet('p1', 'w1')], [],
      )).toBeNull();
    }
    expect(groupHealthSectorResources(
      { organizationKind: 'pharmacy_department_authority', institutionClass: null },
      [], [], [],
    )).toBeNull();
  });
});

describe('the canonical hierarchy', () => {
  const warehouses = [
    wh('w-main', null),
    wh('w-a', 'fac-a'),
    wh('w-b', 'fac-b'),
  ];
  const outlets = [
    outlet('p-a-pharm', 'w-a'),
    outlet('p-a-crash', 'w-a'),
    outlet('p-b-pharm', 'w-b'),
  ];
  const facilities = [facility('fac-a', 'Centre A'), facility('fac-b', 'Centre B')];

  const groups = groupHealthSectorResources(SECTOR, warehouses, outlets, facilities)!;

  it('emits the sector main FIRST, as the supply root', () => {
    expect(groups[0].kind).toBe('sector_main');
    expect(groups[0].warehouses.map(w => w.id)).toEqual(['w-main']);
  });

  it('the sector main structurally holds no outlets', () => {
    expect(groups[0].allowsOutlets).toBe(false);
    expect(groups[0].outlets).toEqual([]);
  });

  it('each health centre carries its own depot and only its own outlets', () => {
    const a = groups.find(g => g.facility?.id === 'fac-a')!;
    const b = groups.find(g => g.facility?.id === 'fac-b')!;
    expect(a.warehouses.map(w => w.id)).toEqual(['w-a']);
    expect(a.outlets.map(o => o.id)).toEqual(['p-a-pharm', 'p-a-crash']);
    expect(b.outlets.map(o => o.id)).toEqual(['p-b-pharm']);
    expect(a.allowsOutlets).toBe(true);
  });

  it('centre A never sees centre B’s resources, and neither sees the sector main', () => {
    const a = groups.find(g => g.facility?.id === 'fac-a')!;
    expect(a.outlets.map(o => o.id)).not.toContain('p-b-pharm');
    expect(a.warehouses.map(w => w.id)).not.toContain('w-b');
    expect(a.warehouses.map(w => w.id)).not.toContain('w-main');
  });

  it('every outlet appears exactly once across the whole hierarchy', () => {
    const seen = groups.flatMap(g => g.outlets.map(o => o.id));
    expect(seen.sort()).toEqual(['p-a-crash', 'p-a-pharm', 'p-b-pharm']);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('a sector main with nothing under it is still emitted — its absence would be a claim', () => {
    const only = groupHealthSectorResources(SECTOR, [wh('w-main', null)], [], [])!;
    expect(only).toHaveLength(1);
    expect(only[0].kind).toBe('sector_main');
  });
});

describe('grouping is by IDENTITY, never by name', () => {
  it('two centres sharing a display name stay separate groups', () => {
    const groups = groupHealthSectorResources(
      SECTOR,
      [wh('w-a', 'fac-a'), wh('w-b', 'fac-b')],
      [outlet('p-a', 'w-a'), outlet('p-b', 'w-b')],
      [facility('fac-a', 'Al-Noor Center'), facility('fac-b', 'Al-Noor Center')],
    )!;
    const centres = groups.filter(g => g.kind === 'health_center');
    expect(centres).toHaveLength(2);
    expect(centres[0].outlets.map(o => o.id)).toEqual(['p-a']);
    expect(centres[1].outlets.map(o => o.id)).toEqual(['p-b']);
  });

  it('renaming a facility never moves a row between groups', () => {
    const before = groupHealthSectorResources(
      SECTOR, [wh('w-a', 'fac-a')], [outlet('p-a', 'w-a')], [facility('fac-a', 'Old Name')],
    )!;
    const after = groupHealthSectorResources(
      SECTOR, [wh('w-a', 'fac-a')], [outlet('p-a', 'w-a')], [facility('fac-a', 'Totally Different')],
    )!;
    expect(after.map(g => g.outlets.map(o => o.id)))
      .toEqual(before.map(g => g.outlets.map(o => o.id)));
  });
});

describe('historical and illegal shapes are reported honestly, never repaired', () => {
  it('an outlet attached to the sector main stays UNDER the sector main and is flagged', () => {
    const groups = groupHealthSectorResources(
      SECTOR,
      [wh('w-main', null), wh('w-a', 'fac-a')],
      [outlet('p-legacy', 'w-main'), outlet('p-a', 'w-a')],
      [facility('fac-a', 'Centre A')],
    )!;
    const main = groups.find(g => g.kind === 'sector_main')!;
    // Visible where it actually is…
    expect(main.outlets.map(o => o.id)).toEqual(['p-legacy']);
    // …and the structural rule is still reported as violated, not relaxed.
    expect(main.allowsOutlets).toBe(false);
    // Never relocated into a centre to make the hierarchy look correct.
    const centre = groups.find(g => g.facility?.id === 'fac-a')!;
    expect(centre.outlets.map(o => o.id)).toEqual(['p-a']);
  });

  it('an outlet with a NULL owning warehouse is surfaced, not dropped', () => {
    const groups = groupHealthSectorResources(
      SECTOR, [wh('w-main', null)], [outlet('p-orphan', null)], [],
    )!;
    const unassigned = groups.find(g => g.kind === 'unassigned')!;
    expect(unassigned.outlets.map(o => o.id)).toEqual(['p-orphan']);
    expect(unassigned.allowsOutlets).toBe(false);
  });

  it('an outlet owned by a warehouse outside the catalog is surfaced too', () => {
    const groups = groupHealthSectorResources(
      SECTOR, [wh('w-main', null)], [outlet('p-ghost', 'w-unknown')], [],
    )!;
    expect(groups.find(g => g.kind === 'unassigned')!.outlets.map(o => o.id)).toEqual(['p-ghost']);
  });

  it('the unassigned section is absent when there is nothing to report', () => {
    const groups = groupHealthSectorResources(
      SECTOR, [wh('w-a', 'fac-a')], [outlet('p-a', 'w-a')], [facility('fac-a', 'A')],
    )!;
    expect(groups.some(g => g.kind === 'unassigned')).toBe(false);
  });

  it('a depot bound to an unlisted facility keeps its rows in a centre group of its own', () => {
    const groups = groupHealthSectorResources(
      SECTOR,
      [wh('w-hidden', 'fac-archived')],
      [outlet('p-hidden', 'w-hidden')],
      [], // the archived facility was not supplied
    )!;
    const centre = groups.find(g => g.kind === 'health_center')!;
    expect(centre.facility).toBeNull();
    expect(centre.key).toBe('fac-archived');
    expect(centre.outlets.map(o => o.id)).toEqual(['p-hidden']);
    expect(groups.some(g => g.kind === 'unassigned')).toBe(false);
  });

  it('an INACTIVE depot and its outlets remain inspectable — status is not a filter here', () => {
    const groups = groupHealthSectorResources(
      SECTOR,
      [wh('w-a', 'fac-a', { status: 'inactive' })],
      [outlet('p-a', 'w-a')],
      [facility('fac-a', 'Centre A')],
    )!;
    const centre = groups.find(g => g.facility?.id === 'fac-a')!;
    expect(centre.warehouses.map(w => w.id)).toEqual(['w-a']);
    expect(centre.outlets.map(o => o.id)).toEqual(['p-a']);
  });

  it('a centre with a facility but no depot is shown as such, not omitted', () => {
    const groups = groupHealthSectorResources(
      SECTOR, [wh('w-main', null)], [], [facility('fac-empty', 'Empty Centre')],
    )!;
    const centre = groups.find(g => g.facility?.id === 'fac-empty')!;
    expect(centre.warehouses).toEqual([]);
    expect(centre.outlets).toEqual([]);
  });
});

describe('a central warehouse never becomes a phantom centre', () => {
  it('central-kind warehouses are excluded from sector topology entirely', () => {
    const groups = groupHealthSectorResources(
      SECTOR,
      [wh('w-central', null, { warehouseKind: 'central' }), wh('w-main', null)],
      [],
      [],
    )!;
    const allWarehouses = groups.flatMap(g => g.warehouses.map(w => w.id));
    expect(allWarehouses).toEqual(['w-main']);
  });
});
