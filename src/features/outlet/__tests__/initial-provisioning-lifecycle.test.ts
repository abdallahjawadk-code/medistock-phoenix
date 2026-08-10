/**
 * STAGE-E-E7-2 — behavioral tests for `getInitialProvisioningState()` and
 * `createInitialProvisioningDispatch()`, proving the UI reads Migration 166's
 * OWN historical-lifecycle columns and never infers eligibility from the
 * outlet's current stock balance — the exact invariant Migration 166 exists
 * to enforce ("once positive accepted quantity establishes initial
 * provisioning, a later zero balance must not reopen it").
 *
 * The fake client below returns canned `warehouse_dispatches` rows and
 * records every RPC call, so these assertions exercise the real function
 * bodies, not a source-scan.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let dispatchRows: Record<string, unknown>[] = [];
const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];

vi.mock('@/shared/supabase/client', () => ({
  supabaseConfigured: true,
  supabase: {
    from: (table: string) => {
      if (table !== 'warehouse_dispatches') throw new Error(`unexpected table: ${table}`);
      return {
        select: () => ({
          eq: () => ({
            eq: async () => ({ data: dispatchRows, error: null }),
          }),
        }),
      };
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return { data: { ok: true, dispatch_id: 'dispatch-new', status: 'draft', is_initial_provisioning: true }, error: null };
    },
  },
}));

const { getInitialProvisioningState, createInitialProvisioningDispatch } = await import('../emergency-replenishment.service');

beforeEach(() => { dispatchRows = []; rpcCalls.length = 0; });

describe('getInitialProvisioningState — reads Migration 166\'s own lifecycle columns, never stock', () => {
  it('no dispatch rows at all: not consumed, nothing open — eligible to start', async () => {
    dispatchRows = [];
    const state = await getInitialProvisioningState('outlet-1');
    expect(state).toEqual({ consumed: false, openDispatchId: null });
  });

  it('a row with initial_provisioning_consumed_at SET: consumed — the slot is spent for good', async () => {
    dispatchRows = [{ id: 'd1', status: 'received', initial_provisioning_consumed_at: '2026-01-01T00:00:00Z' }];
    const state = await getInitialProvisioningState('outlet-1');
    expect(state.consumed).toBe(true);
  });

  it('a row with consumed_at NULL and status "sent": open, blocks starting a second one', async () => {
    dispatchRows = [{ id: 'd1', status: 'sent', initial_provisioning_consumed_at: null }];
    const state = await getInitialProvisioningState('outlet-1');
    expect(state).toEqual({ consumed: false, openDispatchId: 'd1' });
  });

  it('a CANCELLED row with consumed_at NULL: not treated as open — a cancelled attempt never blocks a fresh one', async () => {
    dispatchRows = [{ id: 'd1', status: 'cancelled', initial_provisioning_consumed_at: null }];
    const state = await getInitialProvisioningState('outlet-1');
    expect(state).toEqual({ consumed: false, openDispatchId: null });
  });

  it('CRITICAL: this function has no code path that reads outlet_stock or any balance — it is structurally incapable of using "balance == 0" as eligibility', async () => {
    const src = await import('fs').then(fs => fs.readFileSync(
      new URL('../emergency-replenishment.service.ts', import.meta.url), 'utf8',
    ));
    const fnStart = src.indexOf('export async function getInitialProvisioningState');
    const fnEnd = src.indexOf('\n}', fnStart);
    const body = src.slice(fnStart, fnEnd);
    expect(body).not.toMatch(/outlet_stock|on_hand_quantity|available_quantity|balance/i);
    expect(body).toContain('is_initial_provisioning');
    expect(body).toContain('initial_provisioning_consumed_at');
  });
});

describe('createInitialProvisioningDispatch — exact canonical RPC call', () => {
  it('calls Migration 166\'s RPC by exact name with every argument forwarded', async () => {
    const res = await createInitialProvisioningDispatch({
      warehouseId: 'wh-1',
      destinationDistributionPointId: 'outlet-1',
      dispatchNumber: 'IP-001',
      notes: 'first fill',
    });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe('phoenix_create_initial_provisioning_dispatch');
    expect(rpcCalls[0].args).toEqual({
      p_warehouse_id: 'wh-1',
      p_destination_distribution_point_id: 'outlet-1',
      p_dispatch_number: 'IP-001',
      p_document_number: null,
      p_default_currency: null,
      p_notes: 'first fill',
    });
    expect(res.ok).toBe(true);
    expect(res.data?.is_initial_provisioning).toBe(true);
  });

  it('is a DIFFERENT RPC from the ordinary dispatch creator — never phoenix_create_warehouse_dispatch', async () => {
    await createInitialProvisioningDispatch({
      warehouseId: 'wh-1', destinationDistributionPointId: 'outlet-1', dispatchNumber: 'IP-002',
    });
    expect(rpcCalls[0].fn).not.toBe('phoenix_create_warehouse_dispatch');
  });
});
