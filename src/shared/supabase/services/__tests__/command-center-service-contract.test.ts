import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(__dirname, '../command-center.service.ts'),
  'utf8',
);

describe('RAC-2 command center frontend service contract', () => {
  it('calls only the canonical server-side Command Center RPC', () => {
    expect(source).toContain("supabase.rpc('phoenix_command_center_read_contract'");
    expect(source).toContain('p_organization_id: scope.organizationId ?? null');
    expect(source).toContain('p_warehouse_id: scope.warehouseId ?? null');
    expect(source).toContain('p_distribution_point_id: scope.distributionPointId ?? null');
  });

  it('does not implement role-string authorization or client-side KPI aggregation', () => {
    expect(source).not.toMatch(/super_admin|institution_admin|warehouse_officer|outlet_officer/);
    expect(source).not.toMatch(/\.from\(['"](?:item_availability|warehouse_stock|outlet_stock|organizations|warehouses|distribution_points)['"]\)/);
    expect(source).not.toMatch(/reduce\(|filter\(/);
  });

  it('pins trend as deferred and exposes typed server-derived capabilities', () => {
    expect(source).toContain("trend_status: 'deferred_pending_measurement'");
    expect(source).toContain('dashboard_view: boolean');
    expect(source).toContain('alerts_view: boolean');
    expect(source).toContain('reports_view: boolean');
  });
});
