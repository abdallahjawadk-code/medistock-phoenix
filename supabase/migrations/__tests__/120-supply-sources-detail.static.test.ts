/**
 * SUPPLY-SOURCES-DETAIL-120 — static contract.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const sql = readFileSync(join(__dirname, '../120_phoenix_supply_sources_detail.sql'), 'utf8');

describe('120 — supply sources detail contract', () => {
  it('reads warehouse_stock/outlet_stock provenance columns directly — no new classification math', () => {
    expect(sql).not.toMatch(/reorder_point|target_max/);
    expect(sql).toContain('FROM public.warehouse_stock ws');
    expect(sql).toContain('FROM public.outlet_stock os');
  });

  it('shares the exact same closed bucket vocabulary as 119', () => {
    expect(sql).toContain("'kimadia', 'aid', 'purchase_central', 'purchase_supplementary', 'unclassified'");
  });

  it('is organization-scoped and requires reports.view', () => {
    expect(sql).toContain("'reports.view', p_organization_id, NULL, NULL");
    expect(sql).toContain('ws.organization_id = p_organization_id');
    expect(sql).toContain('os.organization_id = p_organization_id');
  });

  it('is a granted read-only function, no write grant anywhere', () => {
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.phoenix_supply_sources_detail(uuid, text) TO authenticated');
    expect(sql).not.toMatch(/INSERT INTO|UPDATE public\.|DELETE FROM/);
  });
});
