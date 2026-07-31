/**
 * INVENTORY-CENTER-INTAKE-A — Network Management audit.
 *
 * The milestone required auditing Network Management against the Inventory
 * Center, movements and QR, and disabling any parallel stock writer.
 *
 * Finding: Network Management is NOT a parallel stock writer and never was.
 * Its mutations fall into three categories, none of which sets a stock level:
 *
 *   1. Network STRUCTURE (074) — create/update/activate warehouses.
 *   2. SCOPE assignment (076) — assign/revoke profile scopes.
 *   3. FORMAL MOVEMENTS (075/077) — transfer and return lifecycles, which are
 *      themselves the sanctioned way stock moves between warehouses.
 *
 * Its stock-related reads (getWarehouseStock, getTransfers, …) are plain
 * RLS-protected SELECTs. It therefore keeps its route AND its navigation entry:
 * it has unique value the Inventory Center does not duplicate. These tests pin
 * that conclusion so a future change cannot quietly turn it into a second
 * writer of stock truth.
 *
 * Source text is newline-normalized so a CRLF working copy matches CI's LF checkout.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(process.cwd(), 'src');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

const networkService = readSrc('features/network/network.service.ts');
const networkScreen = readSrc('features/network/NetworkManagementScreen.tsx');
const directSupply = readSrc('features/network/DirectSupplyOperations.tsx');

describe('Network Management is not a parallel stock writer', () => {
  it('never writes any table directly — every mutation is an RPC', () => {
    for (const source of [networkService, networkScreen, directSupply]) {
      expect(source).not.toMatch(/\.insert\(/);
      expect(source).not.toMatch(/\.upsert\(/);
      expect(source).not.toMatch(/\.from\('[a-z_]+'\)[\s\S]{0,200}?\.update\(/);
      expect(source).not.toMatch(/\.from\('[a-z_]+'\)[\s\S]{0,200}?\.delete\(/);
    }
  });

  it('never writes item_availability, warehouse_stock or outlet_stock', () => {
    for (const source of [networkService, networkScreen, directSupply]) {
      expect(source).not.toContain('phoenix_upsert_availability');
      expect(source).not.toContain('upsertAvailability');
      for (const table of ['item_availability', 'warehouse_stock', 'outlet_stock']) {
        expect(source).not.toMatch(
          new RegExp(`from\\('${table}'\\)[\\s\\S]{0,200}?\\.(insert|update|upsert|delete)\\(`),
        );
      }
    }
  });

  it('its stock reads are SELECT-only', () => {
    // Bound the slice from the function start to the next top-level export.
    // `indexOf('export interface Transfer')` would match TransferRequest far
    // EARLIER in the file and yield an empty slice that passes vacuously.
    const start = networkService.indexOf('export async function getWarehouseStock');
    expect(start).toBeGreaterThan(-1);
    const rest = networkService.slice(start + 1);
    const end = rest.indexOf('\nexport ');
    const stockRead = rest.slice(0, end === -1 ? undefined : end);
    expect(stockRead).toContain(".from('warehouse_stock')");
    expect(stockRead).toContain('.select(');
    expect(stockRead).not.toMatch(/\.(insert|update|upsert|delete)\(/);
  });

  it('uses no service_role or admin key', () => {
    for (const source of [networkService, networkScreen, directSupply]) {
      expect(source).not.toContain('service_role');
      expect(source).not.toContain('auth.admin');
    }
  });
});

describe('Network Management keeps its route and navigation entry', () => {
  it('screen 17 still renders NetworkManagementScreen', () => {
    const authenticatedApp = readSrc('app/AuthenticatedApp.tsx');
    expect(authenticatedApp).toMatch(/case 17:\s*return <NetworkManagementScreen[\s\S]*?initialSuggestionDocument=/);
  });

  it('it retains capabilities the Inventory Center does not provide', () => {
    // Warehouse structure management and scope assignment live only here.
    expect(networkService).toContain('phoenix_create_warehouse');
    expect(networkService).toContain('phoenix_assign_profile_scope');
    expect(networkService).toContain('phoenix_revoke_profile_scope');

    const inventoryScreen = readSrc('features/inventory/InventoryCenterScreen.tsx');
    expect(inventoryScreen).not.toContain('phoenix_create_warehouse');
    expect(inventoryScreen).not.toContain('phoenix_assign_profile_scope');
  });
});
