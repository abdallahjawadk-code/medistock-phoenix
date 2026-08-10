/**
 * STAGE-E-E7-2 — behavioral test for `upsertReplenishmentRoute()`'s exact
 * canonical RPC call, and a source-level proof that the Facility Management
 * panel structurally cannot offer its action to a pharmacy_department_authority
 * organization (Migration 171's own institution_class-always-NULL contract
 * makes such an organization ineligible under Migration 164's composite FK,
 * so the panel must never even be reachable for one).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];

vi.mock('@/shared/supabase/client', () => ({
  supabaseConfigured: true,
  supabase: {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return { data: { ok: true, route_id: 'route-new', is_active: args.p_is_active }, error: null };
    },
  },
}));

const { upsertReplenishmentRoute } = await import('../../outlet/emergency-replenishment.service');

beforeEach(() => { rpcCalls.length = 0; });

describe('upsertReplenishmentRoute — exact canonical RPC call', () => {
  it('creates with p_route_id NULL and every field forwarded verbatim', async () => {
    const res = await upsertReplenishmentRoute({
      sourcePointId: 'pharmacy-1',
      destinationPointId: 'cart-1',
      isActive: true,
      notes: 'ER default route',
    });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe('phoenix_upsert_outlet_replenishment_route');
    expect(rpcCalls[0].args).toEqual({
      p_route_id: null,
      p_source_point_id: 'pharmacy-1',
      p_destination_point_id: 'cart-1',
      p_is_active: true,
      p_notes: 'ER default route',
    });
    expect(res.ok).toBe(true);
  });

  it('never writes directly to outlet_replenishment_routes — the RPC is the only mutation call site', () => {
    const src = readFileSync(
      join(__dirname, '../../outlet/emergency-replenishment.service.ts'), 'utf8',
    );
    expect(src).not.toMatch(/\.from\(['"]outlet_replenishment_routes['"]\)\.(insert|update|upsert)/);
  });
});

describe('Facility Management panel is structurally unreachable for a pharmacy_department_authority', () => {
  it('OrgDetailView only mounts FacilityManagementPanel behind isHealthSector, which is false for any organization_kind other than care_institution', () => {
    const screen = readFileSync(
      join(__dirname, '../InstitutionScreen.tsx'), 'utf8',
    );
    const gateLine = screen.match(/const isHealthSector = ([^;]+);/)?.[1] ?? '';
    expect(gateLine).toContain("o?.organizationKind === 'care_institution'");
    expect(gateLine).toContain("o?.institutionClass === 'health_sector'");
    // The panel's own JSX is wrapped in that exact gate — not a separate,
    // possibly-inconsistent condition.
    const gateIdx = screen.indexOf('{isHealthSector && (');
    const panelIdx = screen.indexOf('<FacilityManagementPanel');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(panelIdx).toBeGreaterThan(gateIdx);
    expect(screen.indexOf(')}', panelIdx)).toBeGreaterThan(panelIdx);
  });
});
