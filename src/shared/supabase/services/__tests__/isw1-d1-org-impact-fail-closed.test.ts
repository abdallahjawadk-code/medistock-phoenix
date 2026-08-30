/**
 * ISW1-D1 — behavioral proof that the organization archive gate FAILS CLOSED.
 *
 * The defect: getOrgDeleteImpact consumed every count as `res.count ?? 0` and
 * never inspected `res.error`. supabase-js resolves a failed count read to
 * `{ data: null, error, count: null }`, so a read that FAILED became a read that
 * returned ZERO — the exact value that opens the archive gate. With all four
 * gating counts faulted the UAT drove a real archive to `204` against an
 * organization whose warehouses, outlets, QR tokens and availability rows were
 * all still live.
 *
 * These are not source scans. The mock below stands in for the real PostgREST
 * client and every assertion reads what the function actually did with it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Per-table outcome the fake client should produce for the next call. */
type Outcome = { count: number | null; error: { message: string } | null };

const outcomes = new Map<string, Outcome>();
const seen: string[] = [];

const ok = (count: number): Outcome => ({ count, error: null });
const fail = (message = 'controlled failure'): Outcome => ({ count: null, error: { message } });

const ALL_TABLES = [
  'warehouses',
  'distribution_points',
  'qr_tokens',
  'item_availability',
  'profiles',
  'institution_item_status_reports',
];

/** Every table succeeds with `n`, unless overridden. */
function allSucceed(n = 0): void {
  outcomes.clear();
  for (const t of ALL_TABLES) outcomes.set(t, ok(n));
}

vi.mock('@/shared/supabase/client', () => ({
  supabaseConfigured: true,
  supabase: {
    from(table: string) {
      seen.push(table);
      const result = outcomes.get(table) ?? ok(0);
      // The real builder is a thenable that keeps returning itself as filters
      // are chained; only awaiting it produces the response.
      interface FakeBuilder {
        select: () => FakeBuilder;
        eq: () => FakeBuilder;
        neq: () => FakeBuilder;
        then: (resolve: (v: unknown) => unknown) => Promise<unknown>;
      }
      const builder: FakeBuilder = {
        select: () => builder,
        eq: () => builder,
        neq: () => builder,
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: null, error: result.error, count: result.count }).then(resolve),
      };
      return builder;
    },
  },
}));

vi.mock('../organizations.service', () => ({ invalidateOrganizationsCache: () => {} }));

const { getOrgDeleteImpact, IMPACT_READ_UNAVAILABLE } = await import('../lifecycle.service');

const ORG = '15c10000-0000-0000-0000-0000000000c0';

beforeEach(() => {
  seen.length = 0;
  allSucceed(0);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('all reads succeed', () => {
  it('permits archive when every dependency is genuinely zero', async () => {
    allSucceed(0);
    const impact = await getOrgDeleteImpact(ORG);
    expect(impact.canArchive).toBe(true);
    expect(impact.activeWarehouses).toBe(0);
  });

  it('blocks archive when dependencies genuinely exist', async () => {
    allSucceed(0);
    outcomes.set('warehouses', ok(1));
    const impact = await getOrgDeleteImpact(ORG);
    expect(impact.canArchive).toBe(false);
    expect(impact.activeWarehouses).toBe(1);
  });

  it('reads all six impact tables', async () => {
    await getOrgDeleteImpact(ORG);
    for (const t of ALL_TABLES) expect(seen).toContain(t);
  });
});

describe('a failed read never becomes a zero', () => {
  // The four classes that gate canArchive, plus the two that only feed canPurge.
  for (const table of ALL_TABLES) {
    it(`throws IMPACT_READ_UNAVAILABLE when ${table} fails`, async () => {
      allSucceed(0);
      outcomes.set(table, fail(`${table} exploded`));
      await expect(getOrgDeleteImpact(ORG)).rejects.toThrow(IMPACT_READ_UNAVAILABLE);
    });
  }

  it('throws when every read fails — the exact IS-W1 scenario', async () => {
    outcomes.clear();
    for (const t of ALL_TABLES) outcomes.set(t, fail());
    await expect(getOrgDeleteImpact(ORG)).rejects.toThrow(IMPACT_READ_UNAVAILABLE);
  });

  it('throws when a read succeeds but returns no count at all', async () => {
    allSucceed(0);
    outcomes.set('item_availability', { count: null, error: null });
    await expect(getOrgDeleteImpact(ORG)).rejects.toThrow(IMPACT_READ_UNAVAILABLE);
  });

  it('never resolves with a fabricated zero for a failed gating read', async () => {
    for (const table of ['warehouses', 'distribution_points', 'qr_tokens', 'item_availability']) {
      allSucceed(0);
      outcomes.set(table, fail());
      const settled = await getOrgDeleteImpact(ORG).then(
        (value) => ({ resolved: true as const, value }),
        (error: Error) => ({ resolved: false as const, error }),
      );
      // The pre-repair behaviour was `{ resolved: true, canArchive: true }`.
      expect(settled.resolved).toBe(false);
      if (!settled.resolved) expect(settled.error.message).toBe(IMPACT_READ_UNAVAILABLE);
    }
  });

  it('a failed read cannot be masked by other reads reporting zero', async () => {
    // Every other table honestly reports zero; only one is unavailable. The
    // gate must still close, because "unknown" is not "absent".
    allSucceed(0);
    outcomes.set('qr_tokens', fail());
    await expect(getOrgDeleteImpact(ORG)).rejects.toThrow(IMPACT_READ_UNAVAILABLE);
  });
});

describe('recovery', () => {
  it('recovers normally once the failing read succeeds again', async () => {
    allSucceed(0);
    outcomes.set('warehouses', fail());
    await expect(getOrgDeleteImpact(ORG)).rejects.toThrow(IMPACT_READ_UNAVAILABLE);

    allSucceed(0);
    const impact = await getOrgDeleteImpact(ORG);
    expect(impact.canArchive).toBe(true);

    // ...and a genuine dependency still blocks after recovery.
    allSucceed(0);
    outcomes.set('distribution_points', ok(2));
    const blocked = await getOrgDeleteImpact(ORG);
    expect(blocked.canArchive).toBe(false);
    expect(blocked.activePorts).toBe(2);
  });
});

describe('canPurge is held to the same standard', () => {
  it('cannot be derived from an unavailable profiles count', async () => {
    allSucceed(0);
    outcomes.set('profiles', fail());
    await expect(getOrgDeleteImpact(ORG)).rejects.toThrow(IMPACT_READ_UNAVAILABLE);
  });

  it('cannot be derived from an unavailable status-report count', async () => {
    allSucceed(0);
    outcomes.set('institution_item_status_reports', fail());
    await expect(getOrgDeleteImpact(ORG)).rejects.toThrow(IMPACT_READ_UNAVAILABLE);
  });
});
