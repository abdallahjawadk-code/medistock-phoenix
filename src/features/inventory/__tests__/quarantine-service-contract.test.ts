/**
 * QUARANTINE-DISPOSITION — service contract: every mutation targets the EXACT
 * existing 099 RPC with the exact parameter names, reads are RLS-scoped
 * SELECTs only, and the permission hook checks the SAME scoped key the RPCs
 * (and 105's widened read policy) check. Static source assertions, matching
 * the repo convention (e.g. outlet-services-contract.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');
const service = read('quarantine.service.ts');
const hook = read('useQuarantinePermission.ts');

describe('quarantine.service maps to the exact 099 RPCs', () => {
  it('releaseQuarantineStock → phoenix_release_quarantine_stock', () => {
    expect(service).toContain('export function releaseQuarantineStock');
    expect(service).toContain("'phoenix_release_quarantine_stock'");
  });
  it('destroyQuarantineStock → phoenix_destroy_quarantine_stock', () => {
    expect(service).toContain('export function destroyQuarantineStock');
    expect(service).toContain("'phoenix_destroy_quarantine_stock'");
  });
  it('release never invents a destination — it targets a caller-named EXISTING lot', () => {
    expect(service).toMatch(/p_destination_warehouse_stock_id: input\.destinationWarehouseStockId/);
  });
  it('getQuarantineStock is a read-only, RLS-scoped SELECT — never a table write', () => {
    expect(service).toMatch(/\.from\('warehouse_quarantine_stock'\)\s*\n\s*\.select\(/);
    expect(service).not.toMatch(/\.from\([^)]*\)\.(insert|update|upsert|delete)/);
    expect(service).not.toMatch(/service_role|auth\.admin/);
  });
});

describe('useQuarantinePermission checks the same key 099/105 check', () => {
  it("checks 'warehouse_transfer.return_request', scoped by warehouseId, never distributionPointId", () => {
    expect(hook).toMatch(/permissionKey: 'warehouse_transfer\.return_request'/);
    expect(hook).toMatch(/warehouseId,/);
    expect(hook).toMatch(/distributionPointId: null/);
  });
  it('super_admin bypasses the scoped check, exactly like every other permission hook in this feature', () => {
    // QUARANTINE-PANEL-STALE-WAREHOUSE-RACE fix: the role is read once into
    // a local `profileRole` (part of the current-context key the fix uses to
    // guard against cross-warehouse attribution), so the literal expression
    // is `profileRole === 'super_admin'` now, not `profile.role === ...`.
    expect(hook).toMatch(/profileRole === 'super_admin'/);
    expect(hook).toContain("const profileRole = profile?.role ?? null");
  });
});
