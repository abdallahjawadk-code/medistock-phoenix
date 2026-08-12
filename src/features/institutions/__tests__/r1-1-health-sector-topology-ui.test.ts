/**
 * R1.1 / MIGRATION 181 — health-sector topology UI parity.
 *
 * The database is the topology authority: Migration 181 refuses an outlet on
 * the sector main, refuses a rescue cart inside a health sector, and refuses a
 * facility-less centre depot, for EVERY writer including a raw RLS-protected
 * client INSERT. These assertions only prove the screens stop OFFERING shapes
 * the server now always rejects — they are convenience, never the boundary.
 *
 * The boundary itself is proved in
 * supabase/migrations/__tests__/181-health-sector-topology.dynamic.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const screen = read('features/institutions/InstitutionScreen.tsx');
const networkService = read('features/network/network.service.ts');

describe('the outlet surface is narrowed inside a health sector', () => {
  it('the section receives the organization class rather than re-deriving it', () => {
    expect(screen).toMatch(/<PortSection[\s\S]{0,1200}isHealthSector=\{isHealthSector\}/);
    expect(screen).toMatch(/isHealthSector: boolean;/);
    // The existing derivation is reused, not duplicated.
    expect(screen).toMatch(
      /const isHealthSector = o\?\.organizationKind === 'care_institution' && o\?\.institutionClass === 'health_sector'/,
    );
  });

  it('only facility-bound centre depots may own an outlet', () => {
    expect(screen).toMatch(
      /const selectableWarehouses = useMemo\(\s*\n\s*\(\) => \(isHealthSector \? warehouses\.filter\(w => w\.facilityId !== null\) : warehouses\)/,
    );
  });

  it('a rescue cart is not offered inside a health sector', () => {
    expect(screen).toMatch(
      /const selectablePointTypes = useMemo\(\s*\n\s*\(\) => \(isHealthSector\s*\n?\s*\? APPROVED_POINT_TYPES\.filter\(type => type\.value !== 'rescue_cart'\)/,
    );
  });

  it('both the CREATE and the EDIT form use the narrowed lists', () => {
    // Create form.
    expect(screen).toMatch(/<AddPortForm[\s\S]{0,400}warehouses=\{selectableWarehouses\}[\s\S]{0,80}pointTypes=\{selectablePointTypes\}/);
    expect(screen).toMatch(/\{pointTypes\.map\(type => \(/);
    // Edit form inside PortCard.
    expect(screen).toMatch(/<PortCard[\s\S]{0,400}assignableWarehouses=\{selectableWarehouses\}[\s\S]{0,80}pointTypes=\{selectablePointTypes\}/);
    expect(screen).toMatch(/\{assignableWarehouses\.map\(w => \(/);
    expect(screen).toMatch(/\{pointTypes\.map\(pt => <option/);
  });

  it('the CURRENT owner is still resolvable for display, even if no longer assignable', () => {
    // PortCard keeps the full list for the name lookup and takes the narrowed
    // one only for the move target, so a legacy owner still renders.
    expect(screen).toMatch(/warehouses: Warehouse\[\];[\s\S]{0,200}assignableWarehouses: Warehouse\[\];/);
  });

  it('the narrowing is documented as UX, not authority', () => {
    expect(screen).toMatch(/Migration 181/);
    expect(screen).toMatch(/sector main is a supply root, not a dispensing location/);
  });
});

describe('centre-depot creation is atomic', () => {
  it('a dedicated service calls the dedicated RPC', () => {
    expect(networkService).toMatch(/export function createHealthCenterWarehouse\(input: \{/);
    expect(networkService).toMatch(/callRpc\('phoenix_create_health_center_warehouse', \{/);
    for (const p of ['p_organization_id', 'p_facility_id', 'p_name', 'p_name_ar', 'p_code']) {
      expect(networkService, p).toContain(p);
    }
  });

  it('it does not route through the generic creator, which has no facility', () => {
    const fn = networkService.slice(
      networkService.indexOf('export function createHealthCenterWarehouse'),
      networkService.indexOf('export function updateWarehouse'),
    );
    expect(fn).not.toContain("callRpc('phoenix_create_warehouse'");
    expect(fn).not.toContain('p_is_main');
    expect(fn).not.toContain('p_warehouse_kind');
  });

  it('the generic creator is preserved unchanged for every other organization class', () => {
    expect(networkService).toMatch(/export function createWarehouse\(input: \{[\s\S]{0,300}callRpc\('phoenix_create_warehouse', \{/);
    expect(networkService).toContain('p_warehouse_kind: input.warehouseKind');
    expect(networkService).toContain('p_is_main: input.isMain ?? false');
  });

  it('explains why a second writer exists at all', () => {
    expect(networkService).toMatch(/takes no facility/);
    expect(networkService).toMatch(/no intermediate illegal state/);
  });
});

describe('R1.1 introduces no unit domain in the client', () => {
  it('no unit vocabulary appears in the touched surfaces', () => {
    for (const forbidden of ['health_center_unit', 'unitStock', 'unit_stock']) {
      expect(screen, forbidden).not.toContain(forbidden);
      expect(networkService, forbidden).not.toContain(forbidden);
    }
  });
});
