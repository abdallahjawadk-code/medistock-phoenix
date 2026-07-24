import { describe, it, expect } from 'vitest';
import { createQaFixtureClient, QA_RPC_CALLS, clearQaRpcCalls } from '../qaFixtureClient';
import { QA_MUTATION_OUTCOMES, QA_FEFO_LIVE_PROOF_DISPATCH_HEADER } from '../qaData';

/**
 * VISUAL-QA-HARNESS-A — the fixture client performs no writes. These lock the
 * hard constraint: reads return deterministic fixtures; every table write path
 * and every RPC outside the small migration-071 allowlist resolves to a clear
 * QA error and touches nothing. The allowlisted RPCs return a canned LOCAL
 * outcome so post-write screens can be captured — they contact no database and
 * decide no permission.
 */
describe('QA fixture client (read-only)', () => {
  const client = createQaFixtureClient();

  it('resolves SELECT reads from deterministic fixtures', async () => {
    const { data, error } = await client.from('organizations').select('*');
    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
    expect((data as unknown[]).length).toBeGreaterThan(0);
  });

  it('applies eq filtering so persona scoping narrows results', async () => {
    const { data } = await client.from('warehouses').select('*').eq('warehouseKind', 'central');
    expect((data as Array<{ warehouseKind: string }>).every(r => r.warehouseKind === 'central')).toBe(true);
  });

  it('returns an empty array for unknown tables (clean empty state)', async () => {
    const { data, error } = await client.from('table_that_does_not_exist').select('*');
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it.each(['insert', 'update', 'upsert', 'delete'] as const)(
    'rejects %s with an explicit QA read-only error and no data', async (op) => {
      const builder = client.from('organizations') as unknown as Record<string, () => PromiseLike<{ data: unknown; error: { code: string } | null }>>;
      const { data, error } = await builder[op]();
      expect(data).toBeNull();
      expect(error?.code).toBe('QA_READONLY');
    },
  );

  it('rejects unmapped / mutating RPCs with the QA read-only error', async () => {
    const { data, error } = await client.rpc('assign_profile_role', {});
    expect(data).toBeNull();
    expect((error as { code?: string } | null)?.code).toBe('QA_READONLY');
  });
});

/**
 * The allowlist exists so post-write surfaces (the canonical receipt) can be
 * captured. It must stay a SMALL, EXPLICIT list that fails closed by default —
 * these tests are what stops it quietly becoming "the harness can write".
 */
describe('simulated mutation outcomes are narrow and fail closed', () => {
  const client = createQaFixtureClient();

  it('resolves an allowlisted 071 write RPC to its deterministic outcome', async () => {
    const { data, error } = await client.rpc('phoenix_receive_outlet_return_shipment_line', {});
    expect(error).toBeNull();
    expect((data as { ok?: boolean } | null)?.ok).toBe(true);
  });

  it('returns the canonical request id the commit runner reads back', async () => {
    const { data } = await client.rpc('phoenix_request_outlet_return', {});
    // movement-commit's readId looks for exactly this key.
    expect((data as Record<string, unknown>)['return_request_id'])
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it.each([
    'phoenix_cancel_outlet_return_request',
    'phoenix_review_outlet_return_request',
    'phoenix_send_outlet_return_shipment_line',
    'phoenix_delete_outlet_return_request_line',
    'phoenix_recall_outlet_stock',
    'phoenix_create_warehouse_dispatch',
    'phoenix_upsert_availability',
  ])('still fails closed for the non-allowlisted write RPC %s', async (fn) => {
    const { data, error } = await client.rpc(fn, {});
    expect(data).toBeNull();
    expect((error as { code?: string } | null)?.code).toBe('QA_READONLY');
  });

  it('keeps the allowlist small enough to review at a glance', () => {
    expect(Object.keys(QA_MUTATION_OUTCOMES).length).toBeLessThanOrEqual(6);
  });

  it('allowlists only migration-071 outlet-return writes', () => {
    for (const name of Object.keys(QA_MUTATION_OUTCOMES)) {
      expect(name).toMatch(/^phoenix_(request|add|submit|receive)_outlet_return/);
    }
  });

  it('no table write is reachable, allowlist or not', async () => {
    const builder = client.from('outlet_return_shipment_lines') as unknown as
      Record<string, () => PromiseLike<{ data: unknown; error: { code: string } | null }>>;
    const { data, error } = await builder.update();
    expect(data).toBeNull();
    expect(error?.code).toBe('QA_READONLY');
  });
});

/**
 * FEFO-REASON-REQUESTID-LIVE-PROOF — the ONE narrow, args-scoped synthetic
 * success for `phoenix_create_warehouse_dispatch`. It is deliberately NOT in
 * QA_MUTATION_OUTCOMES (see qaData.ts) so it stays excluded there for every
 * OTHER call shape — only the exact warehouse→outlet header this one live
 * proof drives gets a fabricated id back.
 */
describe('FEFO live-proof: args-scoped synthetic success for phoenix_create_warehouse_dispatch', () => {
  it('returns a fabricated header id ONLY for the exact warehouse/outlet header the proof drives', async () => {
    const client = createQaFixtureClient();
    const { data, error } = await client.rpc('phoenix_create_warehouse_dispatch', {
      p_warehouse_id: QA_FEFO_LIVE_PROOF_DISPATCH_HEADER.warehouseId,
      p_destination_distribution_point_id: QA_FEFO_LIVE_PROOF_DISPATCH_HEADER.outletId,
      p_dispatch_number: '',
      p_document_number: null,
      p_default_currency: null,
      p_notes: null,
    });
    expect(error).toBeNull();
    expect((data as { ok?: boolean; id?: string } | null)?.ok).toBe(true);
    expect((data as { id?: string }).id).toBe(QA_FEFO_LIVE_PROOF_DISPATCH_HEADER.dispatchId);
  });

  it.each([
    ['different warehouse, same outlet', { p_warehouse_id: 'qa-wh-inst-a-empty', p_destination_distribution_point_id: 'qa-outlet-1' }],
    ['same warehouse, different outlet', { p_warehouse_id: 'qa-wh-inst-a', p_destination_distribution_point_id: 'qa-outlet-2' }],
    ['no args at all', {}],
  ])('still fails closed with QA_READONLY for %s — the scoping is exact-args, not a blanket allow', async (_label, args) => {
    const client = createQaFixtureClient();
    const { data, error } = await client.rpc('phoenix_create_warehouse_dispatch', args);
    expect(data).toBeNull();
    expect((error as { code?: string } | null)?.code).toBe('QA_READONLY');
  });

  it('QA_MUTATION_OUTCOMES (the real allowlist) is untouched by this addition', () => {
    expect(QA_MUTATION_OUTCOMES).not.toHaveProperty('phoenix_create_warehouse_dispatch');
  });

  it('the call is still logged to QA_RPC_CALLS exactly as sent, before the synthetic answer', async () => {
    const client = createQaFixtureClient();
    clearQaRpcCalls();
    const args = {
      p_warehouse_id: QA_FEFO_LIVE_PROOF_DISPATCH_HEADER.warehouseId,
      p_destination_distribution_point_id: QA_FEFO_LIVE_PROOF_DISPATCH_HEADER.outletId,
    };
    await client.rpc('phoenix_create_warehouse_dispatch', args);
    expect(QA_RPC_CALLS).toHaveLength(1);
    expect(QA_RPC_CALLS[0]).toEqual({ name: 'phoenix_create_warehouse_dispatch', args });
  });
});
