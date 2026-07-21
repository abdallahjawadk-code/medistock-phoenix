/**
 * E1 — InstitutionReturnReceipts mount reachability.
 *
 * Proves the return-receipt surface is genuinely reachable from the Inventory
 * Center, gated by the EXACT scoped permission the 071 receive RPC checks
 * (outlet_stock.return_receive on the destination warehouse) and never by a raw
 * role name, without disturbing the existing tabs, routes or screen numbers.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const screen = read('src', 'features', 'inventory', 'InventoryCenterScreen.tsx');
const code = stripComments(screen);
const hook = read('src', 'features', 'inventory', 'useReturnReceivePermission.ts');
const strings = read('src', 'shared', 'i18n', 'strings.ts');

describe('the return-receipt surface is mounted and reachable', () => {
  it('imports and renders InstitutionReturnReceipts', () => {
    expect(code).toContain("import { InstitutionReturnReceipts } from '@/features/outlet/InstitutionReturnReceipts'");
    expect(code).toContain('<InstitutionReturnReceipts');
  });

  it('adds a returns tab that is selectable and routes to the component', () => {
    expect(code).toContain("id: 'returns'");
    expect(code).toContain("labelKey: 'inv_tab_return_receipts'");
    expect(code).toContain("tab === 'returns' && canReceiveReturns");
  });

  it('passes the active warehouse as the receive destination', () => {
    const branch = code.slice(code.indexOf('<InstitutionReturnReceipts'), code.indexOf('<InstitutionReturnReceipts') + 260);
    expect(branch).toContain('destinationWarehouseId={activeWarehouseId}');
    expect(branch).toContain('canReceive={canReceiveReturns}');
  });
});

describe('the gate is the exact scoped permission, never a role name', () => {
  it('resolves visibility via useReturnReceivePermission', () => {
    expect(code).toContain('useReturnReceivePermission(activeOrgId, activeWarehouseId');
    expect(code).toContain('const canReceiveReturns = returnReceive.data ?? false');
    // The returns tab appears only when the scoped decision allows it.
    expect(code).toContain("...(canReceiveReturns ? [{ id: 'returns'");
  });

  it('asks the exact key the 071 receive RPC checks, scoped to the warehouse', () => {
    expect(hook).toContain("permissionKey: 'outlet_stock.return_receive'");
    expect(hook).toContain('warehouseId,');
    expect(hook).toContain('hasScopedPermission');
  });

  it('the tab gate names no raw role (only the super_admin preflight in the hook)', () => {
    expect(code).not.toMatch(/canReceiveReturns\s*=\s*role ===/);
    expect(code).not.toContain("role === 'point_operator'");
  });
});

describe('existing tabs, routes and screen numbers are preserved', () => {
  it('keeps every prior Inventory Center tab', () => {
    for (const key of ['inv_tab_intake', 'inv_tab_stock', 'inv_tab_ledger', 'inv_tab_incoming', 'inv_tab_dispatch']) {
      expect(screen).toContain(`'${key}'`);
    }
  });

  it('the new tab label is bilingual', () => {
    const line = strings.split('\n').find(l => l.trimStart().startsWith('inv_tab_return_receipts:'));
    expect(line).toBeTruthy();
    expect(line).toMatch(/ar:\s*'[^']+'/);
    expect(line).toMatch(/en:\s*'[^']+'/);
  });
});
