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
/**
 * R1.2C moved the narrowing rules out of this screen and into ONE shared,
 * exhaustively-tested affordance helper, so create and edit cannot develop two
 * opinions. Every R1.1 property below is preserved — it is simply asserted
 * against the module that now owns it. See
 * src/shared/lib/__tests__/outlet-affordances.test.ts for the matrix itself.
 */
const affordances = read('shared/lib/outlet-affordances.ts');
const networkService = read('features/network/network.service.ts');
const networkScreen = read('features/network/NetworkManagementScreen.tsx');
const depotPanel = read('features/institutions/WarehouseFacilityAssignmentPanel.tsx');
const preapply = read('../docs/phoenix/r1-1-181-production-preapply-readonly.sql');

describe('the outlet surface is narrowed inside a health sector', () => {
  it('the section receives the organization classification rather than re-deriving it', () => {
    // R1.2C passes the KIND/CLASS pair instead of a derived boolean, because a
    // boolean cannot tell a specialized centre from a hospital, nor a pharmacy
    // department authority from an organization that is still loading.
    expect(screen).toMatch(/<PortSection[\s\S]{0,1600}owner=\{outletOwner\}/);
    expect(screen).toMatch(
      /const outletOwner: OutletOwner = useMemo\([\s\S]{0,200}organizationKind: o\?\.organizationKind, institutionClass: o\?\.institutionClass/,
    );
    expect(screen).toMatch(/owner: OutletOwner;/);
    // The health-sector derivation this screen already had is still reused for
    // the facilities panel, not duplicated.
    expect(screen).toMatch(
      /const isHealthSector = o\?\.organizationKind === 'care_institution' && o\?\.institutionClass === 'health_sector'/,
    );
  });

  it('only facility-bound centre depots may own an outlet', () => {
    // The screen delegates; the rule itself lives once, in the helper.
    expect(screen).toMatch(
      /const selectableWarehouses = useMemo\(\s*\n\s*\(\) => selectableOutletWarehouses\(owner, warehouses\)/,
    );
    expect(affordances).toMatch(
      /classify\(owner\) === 'health_sector'\) return warehouse\.facilityId !== null;/,
    );
  });

  it('a rescue cart is not offered inside a health sector', () => {
    expect(screen).toMatch(/const allowed = selectableOutletPointTypes\(owner\);/);
    expect(screen).toMatch(/APPROVED_POINT_TYPES\.filter\(type => allowed\.includes\(type\.value\)\)/);
    // health_sector offers pharmacy and crash_cabinet — never a rescue cart.
    expect(affordances).toMatch(
      /case 'health_sector':\s*return Object\.freeze\(\['pharmacy', 'crash_cabinet'\] as const\);/,
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
    expect(screen).toMatch(/Migration 183/);
    expect(affordances).toMatch(/sector main is a supply root, not a dispensing location/);
    // The helper must say outright that it is a mirror, never the boundary.
    expect(affordances).toMatch(/That validator is the AUTHORITY\. Nothing here\s*\n \* is\./);
    expect(affordances).toMatch(/IT IS PURE\./);
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

  it('the health-centre panel actually uses the atomic writer', () => {
    expect(depotPanel).toContain('createHealthCenterWarehouse({');
    expect(depotPanel).not.toContain('assignWarehouseFacility({');
    expect(depotPanel).not.toContain('createWarehouse({');
    expect(screen).toMatch(/<WarehouseFacilityAssignmentPanel[\s\S]{0,400}canManage=\{isSuper\}/);
  });

  it('the network screen fixes sector-main kind/main and displays depots separately', () => {
    expect(networkScreen).toContain("warehouseKind: isHealthSector ? 'institution' : kind");
    expect(networkScreen).toContain('isMain: isHealthSector ? true : isMain');
    expect(networkScreen).toContain("title={t('net_wh_sector_main', lang)}");
    expect(networkScreen).toContain("title={t('net_wh_center_depots', lang)}");
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

describe('the operator receives a reusable read-only Production gate', () => {
  it('classifies every active health sector and exposes operational evidence', () => {
    for (const classification of ['TARGET_READY', 'SAFE_LEGACY_RECONCILABLE', 'AMBIGUOUS_STOP']) {
      expect(preapply).toContain(classification);
    }
    for (const evidence of [
      'facilities', 'warehouses', 'outlets', 'warehouse_stock_rows', 'outlet_stock_rows',
      'warehouse_movement_rows', 'outlet_movement_rows', 'dispatch_rows',
      'transfer_request_rows', 'supply_route_rows', 'replenishment_route_rows',
      'availability_rows', 'dispense_context_rows',
    ]) expect(preapply, evidence).toContain(evidence);
  });

  it('contains no write or lock statement', () => {
    const executable = preapply.replace(/^\s*--.*$/gm, '');
    expect(executable).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE|FOR\s+(UPDATE|SHARE))\b/i);
  });
});
