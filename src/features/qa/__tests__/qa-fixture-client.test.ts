import { describe, it, expect } from 'vitest';
import { createQaFixtureClient } from '../qaFixtureClient';

/**
 * VISUAL-QA-HARNESS-A — the fixture client is SELECT-only. These lock the hard
 * constraint: reads return deterministic fixtures; every write path and every
 * unmapped/mutating RPC resolves to a clear QA error and touches nothing.
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
