/**
 * OUTLET-RETURN-EXCEPTION-RESOLUTION-157 — OutletReturnExceptions mount
 * reachability.
 *
 * Proves the exception-resolution surface is genuinely reachable from the
 * Inventory Center, gated by the EXACT scoped permission the 157 resolution
 * RPC checks (outlet_stock.resolve_return_exception on the destination
 * warehouse) and never by a raw role name or the adjacent return_receive
 * key, without disturbing the existing tabs, routes or screen numbers.
 * Mirrors return-receipts-mount-contract.test.ts's own shape exactly.
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
const hook = read('src', 'features', 'inventory', 'useOutletReturnExceptionResolvePermission.ts');
const strings = read('src', 'shared', 'i18n', 'strings.ts');

describe('the return-exceptions surface is mounted and reachable', () => {
  it('imports and renders OutletReturnExceptions', () => {
    expect(code).toContain("import { OutletReturnExceptions } from '@/features/outlet/OutletReturnExceptions'");
    expect(code).toContain('<OutletReturnExceptions');
  });

  it('adds a return_exceptions tab that is selectable and routes to the component', () => {
    expect(code).toContain("id: 'return_exceptions'");
    expect(code).toContain("labelKey: 'inv_tab_return_exceptions'");
    expect(code).toContain("tab === 'return_exceptions' && canResolveExceptions");
  });

  it('passes the active warehouse as the resolution destination', () => {
    const branch = code.slice(code.indexOf('<OutletReturnExceptions'), code.indexOf('<OutletReturnExceptions') + 260);
    expect(branch).toContain('destinationWarehouseId={activeWarehouseId}');
    expect(branch).toContain('canResolve={canResolveExceptions}');
  });
});

describe('the gate is the exact scoped permission, distinct from return_receive, never a role name', () => {
  it('resolves visibility via useOutletReturnExceptionResolvePermission', () => {
    expect(code).toContain('useOutletReturnExceptionResolvePermission(activeOrgId, activeWarehouseId');
    expect(code).toContain('const canResolveExceptions = resolveException.data ?? false');
    // The tab appears only when the scoped decision allows it.
    expect(code).toContain("...(canResolveExceptions ? [{ id: 'return_exceptions'");
  });

  it('asks the exact key the 157 resolution RPC checks, scoped to the warehouse — not return_receive', () => {
    expect(hook).toContain("permissionKey: 'outlet_stock.resolve_return_exception'");
    expect(hook).toContain('warehouseId,');
    expect(hook).toContain('hasScopedPermission');
    expect(hook).not.toContain("permissionKey: 'outlet_stock.return_receive'");
  });

  it('the tab gate names no raw role (only the super_admin preflight in the hook)', () => {
    expect(code).not.toMatch(/canResolveExceptions\s*=\s*role ===/);
    expect(code).not.toContain("role === 'point_operator'");
  });
});

describe('existing tabs, routes and screen numbers are preserved', () => {
  it('keeps every prior Inventory Center tab, including the sibling returns tab', () => {
    for (const key of ['inv_tab_intake', 'inv_tab_stock', 'inv_tab_ledger', 'inv_tab_incoming', 'inv_tab_dispatch', 'inv_tab_return_receipts']) {
      expect(screen).toContain(`'${key}'`);
    }
  });

  it('the new tab label is bilingual', () => {
    const line = strings.split('\n').find(l => l.trimStart().startsWith('inv_tab_return_exceptions:'));
    expect(line).toBeTruthy();
    expect(line).toMatch(/ar:\s*'[^']+'/);
    expect(line).toMatch(/en:\s*'[^']+'/);
  });
});
