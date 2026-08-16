/**
 * DIRECT-CENTRAL-TO-INSTITUTION-SUPPLY-077 — frontend wiring contract.
 * Static source-code assertions (the established repo convention — there is no
 * React test renderer wired up). Locks:
 *   • the manual "supply routes" tab + add-route button are GONE from the UI;
 *   • a route-free "direct supply" flow (institution -> its active warehouse)
 *     is wired to the new 077 RPC;
 *   • the Warehouses and Scope-assignment tabs are UNCHANGED;
 *   • the legacy route service functions are RETAINED (compat, just unused by UI);
 *   • no user permission key is changed and no screen is renumbered.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { T } from '@/shared/i18n/strings';

const FEAT = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(FEAT, rel), 'utf8');

const screen = read('NetworkManagementScreen.tsx');
const service = read('network.service.ts');
const operations = read('DirectSupplyOperations.tsx');
const returnComposer = read('../movement/DirectReturnComposer.tsx');

describe('077 UI — the manual supply-routes tab is retired', () => {
  it('has no routes tab id and no SupplyRoutesPanel component', () => {
    expect(screen).not.toMatch(/id:\s*'routes'/);
    expect(screen).not.toMatch(/function SupplyRoutesPanel/);
    expect(screen).not.toMatch(/<SupplyRoutesPanel/);
  });
  it('removes the route management widgets and the add-route button', () => {
    expect(screen).not.toMatch(/function SupplyRouteForm/);
    expect(screen).not.toMatch(/function RouteRow/);
    expect(screen).not.toMatch(/createSupplyRoute\(/);
    expect(screen).not.toMatch(/setSupplyRouteActive\(/);
    expect(screen).not.toMatch(/net_sr_add/);
  });
});

describe('077 UI — direct supply flow (institution -> active warehouse)', () => {
  it('renders a Direct Supply tab wired to the operational surface', () => {
    expect(screen).toMatch(/id:\s*'supply'/);
    expect(screen).toMatch(/net_tab_supply/);
    expect(screen).toMatch(/<DirectSupplyOperations/);
    expect(operations).toMatch(/export function DirectSupplyOperations/);
  });
  it('offers ONLY the selected institution\'s active warehouses', () => {
    expect(operations).toMatch(/warehouseKind === 'institution'\s*&&\s*w\.status === 'active'\s*&&\s*w\.organizationId === orgId/);
  });
  it('creates a DIRECT request via the route-free RPC wrapper', () => {
    expect(operations).toMatch(/createDirectTransferRequest\(/);
    expect(operations).toMatch(/destinationOrganizationId:\s*orgId/);
    expect(operations).toMatch(/destinationWarehouseId:\s*effTarget/);
    expect(operations).toMatch(/sourceWarehouseId:\s*effSource/);
  });
  it('the supply tab is gated on send authority (RPC re-checks server-side)', () => {
    expect(screen).toMatch(/myPermissions\.has\('warehouse_transfer\.send'\)/);
  });
});

describe('077 UI — the operational surface drives the WHOLE lifecycle (not create-only)', () => {
  it('forward: add / update / delete line, submit, cancel, review, send, receive', () => {
    for (const rx of [
      /addTransferRequestLine\(/, /updateTransferRequestLine\(/, /deleteTransferRequestLine\(/,
      /submitTransferRequest\(/, /cancelTransferRequest\(/, /reviewTransferRequest\(/,
      /sendDirectTransferLine\(/, /receiveTransferLine\(/,
    ]) expect(operations).toMatch(rx);
  });
  it('return: request / recall / add / submit / cancel / review / send / receive', () => {
    for (const rx of [
      /requestDirectReturn\(/, /recallDirectTransfer\(/, /addDirectReturnLine\(/,
    ]) expect(returnComposer).toMatch(rx);
    for (const rx of [
      /submitReturnRequest\(/, /cancelReturnRequest\(/, /reviewReturnRequest\(/,
      /sendDirectReturnLine\(/, /receiveReturnShipmentLine\(/,
    ]) expect(operations).toMatch(rx);
  });
  it('reads only DIRECT (route_id NULL) rows — legacy routed rows never surface', () => {
    expect(operations).toMatch(/getTransferRequests\(true\)/);
    expect(operations).toMatch(/getReturnRequests\(true\)/);
    // the read layer defaults to route_id IS NULL
    expect(service).toMatch(/if \(directOnly\) q = q\.is\('route_id', null\)/);
  });
  it('never renders or consults warehouse_supply_routes in the operational UI', () => {
    expect(operations).not.toMatch(/warehouse_supply_routes/);
    expect(operations).not.toMatch(/SupplyRoute/);
    expect(operations).not.toMatch(/route_id/);
  });
});

describe('077 UI — Warehouses + Scope tabs unchanged; screen not renumbered', () => {
  it('keeps the warehouses and scopes tabs', () => {
    expect(screen).toMatch(/id:\s*'warehouses'/);
    expect(screen).toMatch(/id:\s*'scopes'/);
    expect(screen).toMatch(/<WarehousesPanel/);
    expect(screen).toMatch(/<ScopeAssignmentsPanel/);
  });
  it('does not touch the users.edit_scope gate', () => {
    expect(screen).toMatch(/myPermissions\.has\('users\.edit_scope'\)/);
  });
});

describe('077 service — direct RPC wired, legacy route RPCs retained', () => {
  it('createDirectTransferRequest calls the 077 RPC with the right params', () => {
    expect(service).toMatch(/phoenix_create_direct_warehouse_transfer_request/);
    expect(service).toMatch(/p_source_warehouse_id:\s*input\.sourceWarehouseId/);
    expect(service).toMatch(/p_destination_organization_id:\s*input\.destinationOrganizationId/);
    expect(service).toMatch(/p_destination_warehouse_id:\s*input\.destinationWarehouseId/);
  });
  it('sendDirectTransferLine calls the 077 route-free send RPC', () => {
    expect(service).toMatch(/phoenix_send_direct_warehouse_transfer_line/);
  });
  it('keeps the legacy 075 route service functions (compat, not deleted)', () => {
    expect(service).toMatch(/export async function getSupplyRoutes/);
    expect(service).toMatch(/export function createSupplyRoute/);
    expect(service).toMatch(/phoenix_create_supply_route/);
  });
});

describe('077 i18n — new keys exist in both languages', () => {
  for (const key of ['net_tab_supply', 'net_ds_hint', 'net_ds_source', 'net_ds_institution',
                     'net_ds_warehouse', 'net_ds_number', 'net_ds_create', 'net_ds_created'] as const) {
    it(`${key} has ar + en`, () => {
      const entry = (T as Record<string, { ar: string; en: string }>)[key];
      expect(entry, `${key} missing`).toBeTruthy();
      expect(entry.ar.length).toBeGreaterThan(0);
      expect(entry.en.length).toBeGreaterThan(0);
    });
  }
});
