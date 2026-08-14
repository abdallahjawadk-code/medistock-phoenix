/**
 * R1.1-P (P2-B) — DIRECT-SUPPLY CORRIDOR ENDPOINT PROJECTION.
 *
 * Migration 165 has had TWO legal direct-supply branches since Stage E, both
 * committing through the same `phoenix_create_direct_warehouse_transfer_request`
 * RPC. The frontend only ever constructed Branch A, so a health sector could
 * not supply its own centres from the interface at all.
 *
 * These tests pin both corridors, and every negative the topology depends on:
 * a sector may not supply another sector's centre, may not supply itself, and a
 * centre depot may never act as a Branch-B source.
 *
 * The database remains the authority — `phoenix_assert_direct_supply_endpoints`
 * re-validates every pair. This projection exists so the interface does not
 * offer a pairing the server would refuse.
 */
import { describe, it, expect } from 'vitest';
import {
  DIRECT_SUPPLY_BRANCHES,
  directSupplySources,
  directSupplyDestinations,
} from '../direct-supply-corridors';

const wh = (
  id: string,
  over: Partial<{ organizationId: string; warehouseKind: string; status: string; facilityId: string | null }> = {},
) => ({
  id,
  organizationId: over.organizationId ?? 'org-sector-1',
  warehouseKind: over.warehouseKind ?? 'institution',
  status: over.status ?? 'active',
  facilityId: over.facilityId ?? null,
});

const ORGS = [
  { id: 'org-authority', institutionClass: null },
  { id: 'org-sector-1', institutionClass: 'health_sector' },
  { id: 'org-sector-2', institutionClass: 'health_sector' },
  { id: 'org-hospital', institutionClass: 'hospital' },
  { id: 'org-specialized', institutionClass: 'specialized_center' },
];

const CATALOG = [
  wh('w-central', { organizationId: 'org-authority', warehouseKind: 'central' }),
  wh('w-central-off', { organizationId: 'org-authority', warehouseKind: 'central', status: 'inactive' }),
  wh('w-hospital', { organizationId: 'org-hospital' }),
  wh('w-specialized', { organizationId: 'org-specialized' }),
  wh('w-s1-main', { organizationId: 'org-sector-1' }),
  wh('w-s1-centre-a', { organizationId: 'org-sector-1', facilityId: 'fac-a' }),
  wh('w-s1-centre-b', { organizationId: 'org-sector-1', facilityId: 'fac-b' }),
  wh('w-s1-centre-off', { organizationId: 'org-sector-1', facilityId: 'fac-off', status: 'inactive' }),
  wh('w-s2-main', { organizationId: 'org-sector-2' }),
  wh('w-s2-centre', { organizationId: 'org-sector-2', facilityId: 'fac-foreign' }),
];

const byId = (id: string) => CATALOG.find(w => w.id === id)!;
const ids = (rows: { id: string }[]) => rows.map(r => r.id).sort();

const S1_SUPPLYABLE = new Set(['fac-a', 'fac-b']);

it('exposes exactly the two branches Migration 165 defines — no generic third', () => {
  expect([...DIRECT_SUPPLY_BRANCHES]).toEqual(['central_to_institution', 'sector_to_health_center']);
});

describe('BRANCH A — central → institution', () => {
  const B = 'central_to_institution' as const;

  it('sources are active central warehouses only', () => {
    expect(ids(directSupplySources(B, CATALOG, ORGS))).toEqual(['w-central']);
  });

  it('POSITIVE: a hospital, a specialized centre and a health-sector main are all offered', () => {
    const dest = ids(directSupplyDestinations(B, CATALOG, byId('w-central')));
    expect(dest).toContain('w-hospital');
    expect(dest).toContain('w-specialized');
    expect(dest).toContain('w-s1-main');
    expect(dest).toContain('w-s2-main');
  });

  it('NEGATIVE: a health-CENTRE depot is never offered to a central source', () => {
    const dest = ids(directSupplyDestinations(B, CATALOG, byId('w-central')));
    expect(dest).not.toContain('w-s1-centre-a');
    expect(dest).not.toContain('w-s1-centre-b');
    expect(dest).not.toContain('w-s2-centre');
  });

  it('NEGATIVE: no central warehouse is offered as a destination', () => {
    expect(ids(directSupplyDestinations(B, CATALOG, byId('w-central')))).not.toContain('w-central');
  });

  it('inactive endpoints are excluded on both sides', () => {
    expect(ids(directSupplySources(B, CATALOG, ORGS))).not.toContain('w-central-off');
    expect(ids(directSupplyDestinations(B, CATALOG, byId('w-central')))).not.toContain('w-s1-centre-off');
  });
});

describe('BRANCH B — sector main → same-sector health centre', () => {
  const B = 'sector_to_health_center' as const;

  it('sources are the sector MAINS of health-sector organizations only', () => {
    expect(ids(directSupplySources(B, CATALOG, ORGS))).toEqual(['w-s1-main', 'w-s2-main']);
  });

  it('NEGATIVE: a centre depot can never be a Branch-B source', () => {
    const sources = ids(directSupplySources(B, CATALOG, ORGS));
    expect(sources).not.toContain('w-s1-centre-a');
    expect(sources).not.toContain('w-s2-centre');
  });

  it('NEGATIVE: a hospital or specialized-centre warehouse is not a sector main', () => {
    const sources = ids(directSupplySources(B, CATALOG, ORGS));
    expect(sources).not.toContain('w-hospital');
    expect(sources).not.toContain('w-specialized');
  });

  it('NEGATIVE: a central warehouse is not a Branch-B source', () => {
    expect(ids(directSupplySources(B, CATALOG, ORGS))).not.toContain('w-central');
  });

  it('POSITIVE: its OWN sector’s active centre depots are offered', () => {
    expect(ids(directSupplyDestinations(B, CATALOG, byId('w-s1-main'), S1_SUPPLYABLE)))
      .toEqual(['w-s1-centre-a', 'w-s1-centre-b']);
  });

  it('NEGATIVE: a FOREIGN sector’s centre is never offered', () => {
    const dest = ids(directSupplyDestinations(B, CATALOG, byId('w-s1-main'), S1_SUPPLYABLE));
    expect(dest).not.toContain('w-s2-centre');

    // …and symmetrically from the other side.
    const other = ids(directSupplyDestinations(
      B, CATALOG, byId('w-s2-main'), new Set(['fac-foreign']),
    ));
    expect(other).toEqual(['w-s2-centre']);
    expect(other).not.toContain('w-s1-centre-a');
  });

  it('NEGATIVE: sector main → sector main is impossible, including itself', () => {
    const dest = ids(directSupplyDestinations(B, CATALOG, byId('w-s1-main'), S1_SUPPLYABLE));
    expect(dest).not.toContain('w-s1-main');
    expect(dest).not.toContain('w-s2-main');
  });

  it('NEGATIVE: an inactive centre depot is not offered', () => {
    const dest = ids(directSupplyDestinations(
      B, CATALOG, byId('w-s1-main'), new Set(['fac-a', 'fac-b', 'fac-off']),
    ));
    expect(dest).not.toContain('w-s1-centre-off');
  });

  it('FAILS CLOSED with no source chosen — an unscoped list would span sectors', () => {
    expect(directSupplyDestinations(B, CATALOG, null, S1_SUPPLYABLE)).toEqual([]);
  });

  it('FAILS CLOSED while the facility list is unresolved, rather than offering every depot', () => {
    expect(directSupplyDestinations(B, CATALOG, byId('w-s1-main'), null)).toEqual([]);
    expect(directSupplyDestinations(B, CATALOG, byId('w-s1-main'), undefined)).toEqual([]);
  });

  /**
   * A real transient, pinned deliberately. `useAsync` keeps the PREVIOUS
   * result for one render after its deps change, so switching the source from
   * sector 1 to sector 2 briefly pairs sector 2's main with sector 1's facility
   * ids. The same-organization conjunct is what makes that harmless — remove it
   * and this transient becomes a cross-sector leak.
   */
  it('a STALE facility set from another sector cannot produce a foreign destination', () => {
    const staleFromSector1 = new Set(['fac-a', 'fac-b']);
    expect(directSupplyDestinations(B, CATALOG, byId('w-s2-main'), staleFromSector1)).toEqual([]);

    const staleFromSector2 = new Set(['fac-foreign']);
    expect(directSupplyDestinations(B, CATALOG, byId('w-s1-main'), staleFromSector2)).toEqual([]);
  });

  it('a facility that is not an ACTIVE health centre is excluded (165 refuses it)', () => {
    // fac-b omitted from the supplyable set, e.g. archived or wrongly classed.
    expect(ids(directSupplyDestinations(B, CATALOG, byId('w-s1-main'), new Set(['fac-a']))))
      .toEqual(['w-s1-centre-a']);
  });
});

describe('the two corridors never overlap', () => {
  it('no warehouse is a legal source on both branches', () => {
    const a = new Set(directSupplySources('central_to_institution', CATALOG, ORGS).map(w => w.id));
    const b = new Set(directSupplySources('sector_to_health_center', CATALOG, ORGS).map(w => w.id));
    for (const id of a) expect(b.has(id), `${id} is a source on both branches`).toBe(false);
  });

  it('no warehouse is a legal destination on both branches', () => {
    const a = new Set(directSupplyDestinations('central_to_institution', CATALOG, byId('w-central')).map(w => w.id));
    const b = new Set(directSupplyDestinations('sector_to_health_center', CATALOG, byId('w-s1-main'), S1_SUPPLYABLE).map(w => w.id));
    for (const id of a) expect(b.has(id), `${id} is a destination on both branches`).toBe(false);
  });
});

describe('the frontend uses the existing RPC and adds no corridor machinery', () => {
  it('commits through createDirectTransferRequest only — no new RPC, no route table', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const root = join(__dirname, '../../../');
    const composer = readFileSync(join(root, 'features/movement/DirectSupplyComposer.tsx'), 'utf8');
    const ops = readFileSync(join(root, 'features/network/DirectSupplyOperations.tsx'), 'utf8');
    const corridors = readFileSync(join(root, 'shared/lib/direct-supply-corridors.ts'), 'utf8');

    expect(composer).toContain('createDirectTransferRequest(');
    for (const src of [composer, ops, corridors]) {
      expect(src).not.toContain('warehouse_supply_routes');
      expect(src).not.toMatch(/phoenix_create_direct_warehouse_transfer_request_v2|phoenix_create_sector_transfer/);
    }
    // The corridor model is a pure projection: no database access at all.
    expect(corridors).not.toContain('supabase');
    expect(corridors).not.toContain('rpc(');
  });

  /**
   * The transient proved above is contained by the same-organization conjunct,
   * but relying on that alone leaves a stale answer flowing through the UI —
   * which also flashed a misleading "no supplyable depots" warning. The wiring
   * therefore STAMPS the facilities read with the organization it was fetched
   * for and rejects a result that does not match the current source, the same
   * guard useInventoryScopes applies to a fast organization switch.
   */
  it('the facilities read is stamped with its organization and a mismatched result is rejected', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const ops = readFileSync(
      join(__dirname, '../../../', 'features/network/DirectSupplyOperations.tsx'), 'utf8',
    );
    expect(ops).toContain('return { organizationId, facilities: await listOrganizationFacilities(organizationId) };');
    expect(ops).toContain('loaded.organizationId !== branchSource.organizationId) return null;');
    // …and an unresolved read yields no destinations rather than every depot.
    expect(ops).toContain('if (sectorFacilities.loading || sectorFacilities.error) return null;');
  });
});
