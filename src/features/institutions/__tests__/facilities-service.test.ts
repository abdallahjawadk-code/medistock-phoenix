/**
 * STAGE-E-E7-2 — behavioral tests for facilities.service.ts, capturing the
 * ACTUAL RPC name and positional/keyword arguments sent to `supabase.rpc`.
 * Not a source-scan: the mock below stands in for the real PostgREST client
 * and every assertion reads what was actually captured, mirroring the
 * discipline established in organization-classification-writer.test.ts (the
 * regression that pattern was built to catch was invisible to any
 * source-scan).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];

vi.mock('@/shared/supabase/client', () => ({
  supabaseConfigured: true,
  supabase: {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (fn === 'phoenix_upsert_organization_facility') {
        return { data: { ok: true, facility_id: 'fac-new', facility_class: args.p_facility_class, status: 'active' }, error: null };
      }
      if (fn === 'phoenix_assign_warehouse_facility') {
        return { data: { ok: true, warehouse_id: args.p_warehouse_id, old_facility_id: null, new_facility_id: args.p_facility_id }, error: null };
      }
      return { data: null, error: { message: 'unexpected_rpc' } };
    },
  },
}));

const { upsertOrganizationFacility, assignWarehouseFacility } = await import('../facilities.service');

beforeEach(() => { rpcCalls.length = 0; });

describe('upsertOrganizationFacility — exact canonical RPC call', () => {
  it('creates with p_facility_id NULL and every field forwarded verbatim', async () => {
    const res = await upsertOrganizationFacility({
      organizationId: 'org-1',
      facilityClass: 'primary_health_center',
      name: 'Center One',
      nameAr: 'مركز واحد',
      code: 'hc-1',
      isActive: true,
    });

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe('phoenix_upsert_organization_facility');
    expect(rpcCalls[0].args).toEqual({
      p_facility_id: null,
      p_organization_id: 'org-1',
      p_facility_class: 'primary_health_center',
      p_name: 'Center One',
      p_name_ar: 'مركز واحد',
      p_code: 'hc-1',
      p_is_active: true,
    });
    expect(res.ok).toBe(true);
  });

  it('update passes the existing facility id, not null', async () => {
    await upsertOrganizationFacility({
      facilityId: 'fac-existing',
      organizationId: 'org-1',
      facilityClass: 'subordinate_health_center',
      name: 'Center Two',
      nameAr: 'مركز اثنان',
      isActive: false,
    });
    expect(rpcCalls[0].args.p_facility_id).toBe('fac-existing');
    expect(rpcCalls[0].args.p_is_active).toBe(false);
    // Omitted code defaults to null, never undefined (PostgREST would drop
    // an undefined key rather than send an explicit NULL).
    expect(rpcCalls[0].args.p_code).toBeNull();
  });

  it('never writes directly to organization_facilities — the RPC is the only call site', async () => {
    const src = await import('fs').then(fs => fs.readFileSync(
      new URL('../facilities.service.ts', import.meta.url), 'utf8',
    ));
    expect(src).not.toMatch(/\.from\(['"]organization_facilities['"]\)\.(insert|update|upsert)/);
  });
});

describe('assignWarehouseFacility — exact canonical RPC call', () => {
  it('sends exactly the two positional arguments the RPC declares', async () => {
    const res = await assignWarehouseFacility({ warehouseId: 'wh-1', facilityId: 'fac-1' });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe('phoenix_assign_warehouse_facility');
    expect(rpcCalls[0].args).toEqual({ p_warehouse_id: 'wh-1', p_facility_id: 'fac-1' });
    expect(res.ok).toBe(true);
  });

  it('a null facilityId (clearing the assignment) is sent as explicit null, not omitted', async () => {
    await assignWarehouseFacility({ warehouseId: 'wh-1', facilityId: null });
    expect(rpcCalls[0].args).toEqual({ p_warehouse_id: 'wh-1', p_facility_id: null });
  });

  it('never writes directly to warehouses.facility_id — the RPC is the only call site', async () => {
    const src = await import('fs').then(fs => fs.readFileSync(
      new URL('../facilities.service.ts', import.meta.url), 'utf8',
    ));
    expect(src).not.toMatch(/\.from\(['"]warehouses['"]\)\.(update|upsert)/);
  });
});
