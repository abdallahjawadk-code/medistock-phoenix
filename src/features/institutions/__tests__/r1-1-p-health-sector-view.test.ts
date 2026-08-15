/**
 * R1.1-P (P2-A + P3-B) — the health-sector institution view, and the outlet
 * topology it must keep agreeing with.
 *
 * The grouping logic itself is proved exhaustively in
 * shared/lib/__tests__/health-sector-grouping.test.ts. This file pins the
 * WIRING — that the screen actually uses the shared grouping, keeps the R1.2C
 * outlet matrix as the single source of what is legal, and does not grow a
 * second copy of either.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  selectableOutletWarehouses,
  selectableOutletPointTypes,
  legalClinicalContexts,
  canCreateOutlets,
} from '@/shared/lib/outlet-affordances';

const SRC = join(__dirname, '../../../');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const screen = read('features/institutions/InstitutionScreen.tsx');

const SECTOR = { organizationKind: 'care_institution', institutionClass: 'health_sector' } as const;
const HOSPITAL = { organizationKind: 'care_institution', institutionClass: 'hospital' } as const;

describe('the screen uses the ONE shared grouping helper', () => {
  it('imports and calls groupHealthSectorResources rather than grouping inline', () => {
    expect(screen).toContain("from '@/shared/lib/health-sector-grouping'");
    expect(screen).toContain('groupHealthSectorResources(owner, warehouses, points, facilities)');
  });

  it('reuses the facilities the screen already loaded — no new read for grouping', () => {
    expect(screen).toContain('facilities={facilities.data ?? []}');
    // listOrganizationFacilities is called exactly once in the screen.
    expect(screen.match(/listOrganizationFacilities\(/g) ?? []).toHaveLength(1);
  });

  it('keeps the flat grid for every non-health-sector owner', () => {
    expect(screen).toContain('sectorGroups === null && (');
    expect(screen).toContain('{points.map(renderPortCard)}');
  });

  it('renders the sector main visually distinct from the centres beneath it', () => {
    expect(screen).toContain('data-testid={`sector-group-${group.kind}`}');
    expect(screen).toContain("group.kind === 'sector_main'");
    expect(screen).toContain("t('hsg_sector_main_no_outlets', lang)");
  });

  it('labels a legacy illegal shape instead of hiding or relocating it', () => {
    expect(screen).toContain('!group.allowsOutlets && group.outlets.length > 0');
    expect(screen).toContain("t('hsg_legacy_shape', lang)");
  });

  it('never writes, normalizes or repairs a historical row while rendering', () => {
    const groupComponent = screen.slice(screen.indexOf('function SectorResourceGroup'));
    expect(groupComponent).not.toMatch(/\.update\(|\.insert\(|\.delete\(|updatePoint|assignWarehouse/);
  });
});

describe('the R1.2C outlet matrix remains the single authority on what is legal', () => {
  it('the screen still consults the shared affordances, not a second matrix', () => {
    expect(screen).toContain("from '@/shared/lib/outlet-affordances'");
    expect(screen).toContain('selectableOutletWarehouses(owner, warehouses)');
    expect(screen).toContain('selectableOutletPointTypes(owner)');
    expect(screen).toContain('canCreateOutlets(owner)');
  });

  it('SECTOR MAIN has no outlet-create affordance: a facility-less depot is unselectable', () => {
    const warehouses = [
      { id: 'w-main', facilityId: null },
      { id: 'w-centre', facilityId: 'fac-a' },
    ];
    expect(selectableOutletWarehouses(SECTOR, warehouses).map(w => w.id)).toEqual(['w-centre']);
  });

  it('a hospital keeps every warehouse selectable — grouping changed nothing for it', () => {
    const warehouses = [{ id: 'w1', facilityId: null }, { id: 'w2', facilityId: null }];
    expect(selectableOutletWarehouses(HOSPITAL, warehouses).map(w => w.id)).toEqual(['w1', 'w2']);
  });

  it('NO RESCUE CART in a health-centre topology, and the crash cabinet IS the emergency location', () => {
    expect(selectableOutletPointTypes(SECTOR)).not.toContain('rescue_cart');
    expect([...selectableOutletPointTypes(SECTOR)]).toEqual(['pharmacy', 'crash_cabinet']);
    expect([...legalClinicalContexts(SECTOR, 'crash_cabinet')]).toEqual(['emergency']);
  });

  it('the hospital inversion is preserved: its crash cabinet is NON-emergency, its rescue cart emergency', () => {
    expect([...legalClinicalContexts(HOSPITAL, 'crash_cabinet')]).toEqual(['non_emergency']);
    expect([...legalClinicalContexts(HOSPITAL, 'rescue_cart')]).toEqual(['emergency']);
  });

  it('a pharmacy department authority still holds no outlets at all', () => {
    expect(canCreateOutlets({ organizationKind: 'pharmacy_department_authority', institutionClass: null }))
      .toBe(false);
  });
});
