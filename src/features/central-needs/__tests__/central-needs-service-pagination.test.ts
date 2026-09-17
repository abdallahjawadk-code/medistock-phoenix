/**
 * CN-2B — `listSourceRecords()` pagination + fail-closed completeness.
 *
 * PostgREST's own configured `max_rows` (supabase/config.toml) silently
 * truncates any unpaginated select; the pre-B2 implementation issued exactly
 * one such query. This locks down the `.range()`-based replacement: correct
 * page boundaries at a REQUESTED PAGE_SIZE=500, and a fail-closed completeness
 * check (retrieved `record_ordinal`s must be exactly {1..N}, proven from
 * M210's own `UNIQUE(import_session_id, record_ordinal)` + `WITH ORDINALITY`
 * INSERT path — see PAGINATION-CONTRACT.md in the
 * CN2A-B2-PAGINATION-PREIMPLEMENT evidence bundle) that throws rather than
 * ever returning a partial dataset.
 *
 * Termination does NOT depend on the server actually honoring the requested
 * range size: a short non-empty page proves nothing (a server-side result
 * cap below 500 looks identical to "last page" if length alone were trusted),
 * so only a genuinely EMPTY page concludes pagination. `offset` always
 * advances by the batch's ACTUAL length, never by the requested PAGE_SIZE.
 * The "server cap" describe block below exercises this directly with a mock
 * that caps its response independently of the requested `from`/`to`,
 * including at cap=1 over 10,001 records — a case that would have needed
 * more than 10,000 page calls under an earlier, now-removed fixed
 * page-count ceiling, and would have incorrectly failed a valid dataset.
 * There is NO such ceiling any more: completeness is validated ordinal-by-
 * ordinal as each page arrives (not after the whole fetch finishes), so a
 * backend that never produces a genuinely empty page — because it is
 * legitimately huge, or because it is replaying an already-seen page — is
 * stopped by that per-row check, not by a page-count guess a large enough
 * real dataset could otherwise exceed. The "fail-closed completeness"
 * describe block below includes a repeated-page attack scenario proving
 * this directly.
 *
 * The mock below stands in for the real PostgREST client: every assertion
 * reads the actual `.range()` calls captured, not a source scan.
 */
import { describe, expect, it, vi } from 'vitest';

interface MockRow {
  id: string;
  import_session_id: string;
  record_ordinal: number;
  target_entity: string;
  field_name: string;
  source_values: unknown;
  source_provenance: unknown;
}

type PageHandler = (params: {
  table: string;
  select: string;
  eqColumn: string;
  eqValue: unknown;
  orderColumn: string;
  ascending: boolean;
  from: number;
  to: number;
}) => { data: MockRow[] | null; error: { message: string } | null };

const rangeCalls: Array<{ from: number; to: number }> = [];
let handler: PageHandler = () => ({ data: [], error: null });

vi.mock('@/shared/supabase/client', () => ({
  supabase: {
    from: (table: string) => ({
      select: (select: string) => ({
        eq: (eqColumn: string, eqValue: unknown) => ({
          order: (orderColumn: string, opts: { ascending: boolean }) => ({
            range: (from: number, to: number) => {
              rangeCalls.push({ from, to });
              return Promise.resolve(
                handler({ table, select, eqColumn, eqValue, orderColumn, ascending: opts.ascending, from, to }),
              );
            },
          }),
        }),
      }),
    }),
  },
}));

const { listSourceRecords, CentralNeedsError } = await import('../central-needs.service');

const PAGE_SIZE = 500;

function makeRow(ordinal: number): MockRow {
  return {
    id: `rec-${ordinal}`,
    import_session_id: 'session-1',
    record_ordinal: ordinal,
    target_entity: `sheet:0:row:${ordinal}`,
    field_name: 'f',
    source_values: { value: ordinal },
    source_provenance: null,
  };
}

/** A well-formed backend holding exactly N contiguous records, 1..N. */
function wellFormedBackend(n: number): PageHandler {
  const all = Array.from({ length: n }, (_, i) => makeRow(i + 1));
  return ({ from, to }) => ({ data: all.slice(from, to + 1), error: null });
}

function resetMocks(h: PageHandler) {
  rangeCalls.length = 0;
  handler = h;
}

describe('listSourceRecords — page-boundary correctness (PAGE_SIZE=500)', () => {
  // Termination now requires a genuinely EMPTY page (see the file header),
  // so every non-zero n costs one extra "empty page" probe call beyond
  // ceil(n/500) data-returning calls — including an n that isn't an exact
  // multiple of 500, which a length-based termination would have stopped on
  // early. This is the corrected, `max_rows`-independent page-count formula.
  const cases: Array<{ n: number; expectedPages: number }> = [
    { n: 0, expectedPages: 1 },
    { n: 1, expectedPages: 2 },
    { n: 499, expectedPages: 2 },
    { n: 500, expectedPages: 2 },
    { n: 501, expectedPages: 3 },
    { n: 999, expectedPages: 3 },
    { n: 1000, expectedPages: 3 },
    { n: 1001, expectedPages: 4 },
    { n: 1999, expectedPages: 5 },
    { n: 2000, expectedPages: 5 },
    { n: 2001, expectedPages: 6 },
    { n: 2500, expectedPages: 6 },
  ];

  for (const { n, expectedPages } of cases) {
    it(`n=${n}: retrieves exactly ${n} records via ${expectedPages} page call(s), ordinals 1..${n}`, async () => {
      resetMocks(wellFormedBackend(n));
      const records = await listSourceRecords('session-1');
      expect(records).toHaveLength(n);
      expect(records.map((r) => r.recordOrdinal)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
      expect(rangeCalls).toHaveLength(expectedPages);
      // Call i requests starting at min(i*PAGE_SIZE, n) — a well-formed
      // backend returns a full PAGE_SIZE batch until the remainder is
      // smaller, so offset only ever lands short of a clean i*PAGE_SIZE
      // multiple on the FINAL (empty-triggering) call.
      for (let i = 0; i < rangeCalls.length; i += 1) {
        const expectedFrom = Math.min(i * PAGE_SIZE, n);
        expect(rangeCalls[i]).toEqual({ from: expectedFrom, to: expectedFrom + PAGE_SIZE - 1 });
      }
    });
  }

  it('n=0: returns [] without throwing (the documented zero-record case)', async () => {
    resetMocks(wellFormedBackend(0));
    await expect(listSourceRecords('session-1')).resolves.toEqual([]);
  });

  it('maps every field, not merely record_ordinal', async () => {
    resetMocks(wellFormedBackend(2));
    const records = await listSourceRecords('session-1');
    expect(records[0]).toEqual({
      id: 'rec-1',
      importSessionId: 'session-1',
      recordOrdinal: 1,
      targetEntity: 'sheet:0:row:1',
      fieldName: 'f',
      sourceValues: { value: 1 },
      sourceProvenance: null,
    });
  });

  it('sends the exact filter and order the RPC-free read path depends on', async () => {
    resetMocks(wellFormedBackend(1));
    let captured: Parameters<PageHandler>[0] | undefined;
    // Must still terminate under the new empty-page-required semantics: the
    // first call returns the one row, every call after returns empty.
    let call = 0;
    handler = (params) => {
      call += 1;
      if (call === 1) { captured = params; return { data: [makeRow(1)], error: null }; }
      return { data: [], error: null };
    };
    await listSourceRecords('session-42');
    expect(captured).toMatchObject({
      table: 'central_needs_source_records',
      eqColumn: 'import_session_id',
      eqValue: 'session-42',
      orderColumn: 'record_ordinal',
      ascending: true,
    });
  });
});

describe('listSourceRecords — server-side result cap below PAGE_SIZE (max_rows-independent)', () => {
  // The mock caps its OWN response length regardless of the requested
  // from/to — exactly what a lower PostgREST `max_rows` (or any other
  // server-side row ceiling) does. Pagination correctness here proves
  // PAGINATION_DEPENDS_ON_MAX_ROWS = NO: a length-based "short page ends
  // pagination" rule would silently drop the remainder; the corrected rule
  // (terminate only on an empty page) must not.
  function cappedBackend(n: number, cap: number): PageHandler {
    const all = Array.from({ length: n }, (_, i) => makeRow(i + 1));
    return ({ from }) => {
      if (from >= n) return { data: [], error: null };
      const count = Math.min(cap, n - from);
      return { data: all.slice(from, from + count), error: null };
    };
  }

  it('server cap 250, requested page size 500, 1200 records: retrieves all 1200, no loss, no duplicates', async () => {
    resetMocks(cappedBackend(1200, 250));
    const records = await listSourceRecords('session-1');
    expect(records).toHaveLength(1200);
    expect(records.map((r) => r.recordOrdinal)).toEqual(Array.from({ length: 1200 }, (_, i) => i + 1));
    const distinctOrdinals = new Set(records.map((r) => r.recordOrdinal));
    expect(distinctOrdinals.size).toBe(1200); // no duplicates
    // Every call requested a full PAGE_SIZE range regardless of the cap.
    for (const call of rangeCalls) expect(call.to - call.from + 1).toBe(PAGE_SIZE);
  });

  it('server cap 137, more than 1000 records: retrieves every record, no loss, no duplicates', async () => {
    const n = 1500;
    resetMocks(cappedBackend(n, 137));
    const records = await listSourceRecords('session-1');
    expect(records).toHaveLength(n);
    expect(records.map((r) => r.recordOrdinal)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
    expect(new Set(records.map((r) => r.recordOrdinal)).size).toBe(n);
  });

  it('server cap 1, requested page size 500, 10,001 records: retrieves every record, no loss (proves there is no fixed page-count ceiling)', async () => {
    // This needs 10,001 data-returning page calls plus one final empty page
    // -- more than the 10,000-page ceiling this correction removed. Under
    // the old MAX_PAGES-bounded loop this exact valid dataset would have
    // incorrectly thrown source_records_pagination_loop_exceeded.
    const n = 10_001;
    resetMocks(cappedBackend(n, 1));
    const records = await listSourceRecords('session-1');
    expect(records).toHaveLength(n);
    expect(records.map((r) => r.recordOrdinal)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
    expect(rangeCalls.length).toBe(n + 1); // n one-row pages + one empty terminating page
  }, 30_000);
});

describe('listSourceRecords — fail-closed on query error', () => {
  it('throws through CentralNeedsError on a first-page error, never returning partial data', async () => {
    resetMocks(() => ({ data: null, error: { message: 'connection_reset' } }));
    await expect(listSourceRecords('session-1')).rejects.toThrow(CentralNeedsError);
  });

  it('throws on a LATER-page error even though earlier pages succeeded', async () => {
    let call = 0;
    resetMocks(({ from }) => {
      call += 1;
      if (call === 1) return { data: Array.from({ length: PAGE_SIZE }, (_, i) => makeRow(from + i + 1)), error: null };
      return { data: null, error: { message: 'timeout' } };
    });
    await expect(listSourceRecords('session-1')).rejects.toThrow(CentralNeedsError);
  });
});

describe('listSourceRecords — fail-closed completeness (never sorted or repaired silently)', () => {
  // Each malformed batch must be returned exactly once, then an empty page,
  // so pagination terminates normally and the completeness check — not the
  // loop-exceeded guard — is what catches the malformation.
  function oneShotThenEmpty(data: MockRow[]): PageHandler {
    let served = false;
    return () => {
      if (served) return { data: [], error: null };
      served = true;
      return { data, error: null };
    };
  }

  it('throws source_records_duplicate_ordinal when the same ordinal appears twice', async () => {
    resetMocks(oneShotThenEmpty([makeRow(1), makeRow(2), makeRow(2)]));
    await expect(listSourceRecords('session-1')).rejects.toMatchObject({ code: 'source_records_duplicate_ordinal' });
  });

  it('throws source_records_ordinal_gap_at_start when the first ordinal is not 1', async () => {
    resetMocks(oneShotThenEmpty([makeRow(2), makeRow(3)]));
    await expect(listSourceRecords('session-1')).rejects.toMatchObject({ code: 'source_records_ordinal_gap_at_start' });
  });

  it('throws source_records_ordinal_gap on a mid-sequence gap', async () => {
    resetMocks(oneShotThenEmpty([makeRow(1), makeRow(2), makeRow(4)]));
    await expect(listSourceRecords('session-1')).rejects.toMatchObject({ code: 'source_records_ordinal_gap' });
  });

  it('throws source_records_ordinal_gap on an out-of-order sequence (never sorts it silently)', async () => {
    resetMocks(oneShotThenEmpty([makeRow(1), makeRow(3), makeRow(2)]));
    await expect(listSourceRecords('session-1')).rejects.toMatchObject({ code: 'source_records_ordinal_gap' });
  });

  it('a malicious/repeated-page backend (the same page served again instead of advancing) fails closed via duplicate-ordinal detection, with NO page-count ceiling involved', async () => {
    // Page 1 returns ordinals 1..PAGE_SIZE; every request after that keeps
    // returning that exact same page instead of advancing or ever going
    // empty. There is no MAX_PAGES guard any more -- this must be caught by
    // ordinal validation, on the very first row of the second page (its
    // ordinal 1 was already seen), not by a fixed loop-count ceiling.
    const repeatedPage = Array.from({ length: PAGE_SIZE }, (_, i) => makeRow(i + 1));
    resetMocks(() => ({ data: repeatedPage, error: null }));
    await expect(listSourceRecords('session-1')).rejects.toMatchObject({ code: 'source_records_duplicate_ordinal' });
    expect(rangeCalls).toHaveLength(2); // fails on the second page's first row -- no unbounded retry
  });
});

describe('listSourceRecords — B2 anchor evidence survives pagination', () => {
  it('an anchor record\'s columnHeaderEvidence, however deep its page, comes back unchanged', async () => {
    const n = 1200; // spans 3 pages at PAGE_SIZE=500
    const all = Array.from({ length: n }, (_, i) => makeRow(i + 1));
    all[999].source_provenance = {
      sheetIndex: 0,
      coordinate: { row: 999, col: 2, a1: 'C1000' },
      columnHeaderEvidence: [{ coordinate: { row: 0, col: 2, a1: 'C1' }, rawText: 'Qty' }],
    };
    resetMocks(({ from, to }) => ({ data: all.slice(from, to + 1), error: null }));
    const records = await listSourceRecords('session-1');
    expect(records).toHaveLength(n);
    const anchor = records.find((r) => r.recordOrdinal === 1000)!;
    expect(anchor.sourceProvenance).toEqual({
      sheetIndex: 0,
      coordinate: { row: 999, col: 2, a1: 'C1000' },
      columnHeaderEvidence: [{ coordinate: { row: 0, col: 2, a1: 'C1' }, rawText: 'Qty' }],
    });
  });
});
