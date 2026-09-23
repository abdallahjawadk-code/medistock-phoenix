/**
 * C4 — the region service boundary, against a recording stand-in for the
 * PostgREST client (every assertion reads the calls actually made).
 *
 *   * listBeneficiaryRegions / listScopeColumnMappings page in deterministic
 *     order and end ONLY on an empty page; a short page is never the end; the
 *     offset advances by rows actually returned. Torn or inconsistent reads
 *     fail closed.
 *   * setBeneficiaryRegions sends one RPC with the exact fence and witnesses
 *     and never retries.
 *   * fetchRevisionLifecycle maps the M215 `revisions` array.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Filter = [string, string, unknown];
interface Query { table: string; select: string; filters: Filter[]; order: string[]; from: number; to: number }
type Page = { data: unknown[] | null; error: { message: string } | null };

const queries: Query[] = [];
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let pageHandler: (q: Query) => Page = () => ({ data: [], error: null });
let rpcHandler: (fn: string, args: Record<string, unknown>) => { data: unknown; error: { message: string } | null } =
  () => ({ data: null, error: null });

vi.mock('@/shared/supabase/client', () => ({
  supabase: {
    from: (table: string) => {
      const q: Query = { table, select: '', filters: [], order: [], from: -1, to: -1 };
      const chain = {
        select: (s: string) => { q.select = s; return chain; },
        eq: (c: string, v: unknown) => { q.filters.push(['eq', c, v]); return chain; },
        is: (c: string, v: unknown) => { q.filters.push(['is', c, v]); return chain; },
        order: (c: string, o: { ascending: boolean }) => { q.order.push(`${c}:${o.ascending ? 'asc' : 'desc'}`); return chain; },
        range: (from: number, to: number) => {
          q.from = from; q.to = to;
          queries.push({ ...q, filters: [...q.filters], order: [...q.order] });
          return Promise.resolve(pageHandler(q));
        },
      };
      return chain;
    },
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return Promise.resolve(rpcHandler(fn, args));
    },
  },
}));

const svc = await import('../central-needs.service');

const row = (i: number, over: Record<string, unknown> = {}) => ({
  version_id: `v${String(i).padStart(4, '0')}`, region_id: `r${i}`, version_no: 1, supersedes_version_id: null,
  plan_revision_id: 'rev', import_session_id: 's1', sheet_index: 0,
  row_start: i * 10, row_end: i * 10 + 5, column_start: 1, column_end: 1,
  decision: 'beneficiary', beneficiary_organization_id: 'org', decision_reason: 'why', decided_by: 'u', decided_at: 't',
  ...over,
});

beforeEach(() => {
  queries.length = 0;
  rpcCalls.length = 0;
  pageHandler = () => ({ data: [], error: null });
  rpcHandler = () => ({ data: null, error: null });
});

describe('listBeneficiaryRegions — ACTIVE working view, paged to an EMPTY page', () => {
  it('reads ACTIVE versions only, of this revision (and scope), in the deterministic order', async () => {
    await svc.listBeneficiaryRegions({ planRevisionId: 'rev', importSessionId: 's1', sheetIndex: 2 });
    expect(queries[0].table).toBe('central_needs_beneficiary_regions');
    expect(queries[0].filters).toEqual([
      ['eq', 'plan_revision_id', 'rev'], ['is', 'retired_at', null], ['eq', 'import_session_id', 's1'], ['eq', 'sheet_index', 2],
    ]);
    expect(queries[0].order).toEqual(['import_session_id:asc', 'sheet_index:asc', 'row_start:asc', 'column_start:asc', 'version_id:asc']);
    expect(queries[0].select).not.toMatch(/retired_|anchor|quantity/);
  });

  it('a SHORT page is not the end: it keeps reading, advancing by rows actually returned, until an empty page', async () => {
    const all = Array.from({ length: 7 }, (_, i) => row(i));
    // A server cap of 3 rows per response, whatever range was requested.
    pageHandler = (q) => ({ data: all.slice(q.from, q.from + 3), error: null });
    const out = await svc.listBeneficiaryRegions({ planRevisionId: 'rev' });
    expect(out.map((v) => v.versionId)).toEqual(all.map((r) => r.version_id));
    expect(queries.map((q) => q.from)).toEqual([0, 3, 6, 7]);
    expect(queries.map((q) => q.to)).toEqual([499, 502, 505, 506]);
  });

  it.each([
    ['a duplicate version', [row(1), row(1)]],
    ['an out-of-order key', [row(2), row(1)]],
    ['two ACTIVE versions of one region', [row(1), row(2, { region_id: 'r1' })]],
    ['two ACTIVE versions with one geometry', [row(1), row(2, { row_start: 10, row_end: 15 })]],
    ['intersecting ACTIVE rectangles', [row(1), row(2, { row_start: 12 })]],
  ])('fails closed on %s', async (_label, rows) => {
    let served = false;
    pageHandler = () => {
      if (served) return { data: [], error: null };
      served = true;
      return { data: rows as unknown[], error: null };
    };
    await expect(svc.listBeneficiaryRegions({ planRevisionId: 'rev' }))
      .rejects.toMatchObject({ code: 'beneficiary_regions_read_inconsistent' });
  });

  it('a read error is surfaced, never an empty or partial layer', async () => {
    let n = 0;
    pageHandler = () => (n++ === 0 ? { data: [row(1)], error: null } : { data: null, error: { message: 'permission denied for table x' } });
    await expect(svc.listBeneficiaryRegions({ planRevisionId: 'rev' })).rejects.toBeInstanceOf(svc.CentralNeedsError);
  });
});

describe('listScopeColumnMappings — the exact M213 fence values', () => {
  it('returns id and mapped_at VERBATIM, pages to an empty page, and is scoped to one (session, sheet)', async () => {
    const rows = [
      { id: 'm1', import_session_id: 's1', sheet_index: 0, column_index: 2, decision: 'beneficiary', beneficiary_organization_id: 'o', mapped_at: '2026-09-01T10:00:00.123456+00:00' },
      { id: 'm2', import_session_id: 's1', sheet_index: 0, column_index: 5, decision: 'non_beneficiary', beneficiary_organization_id: null, mapped_at: '2026-09-02T10:00:00.000001+00:00' },
    ];
    pageHandler = (q) => ({ data: rows.slice(q.from, q.from + 1), error: null });
    const out = await svc.listScopeColumnMappings({ planRevisionId: 'rev', importSessionId: 's1', sheetIndex: 0 });
    expect(out.map((m) => m.mappedAt)).toEqual(['2026-09-01T10:00:00.123456+00:00', '2026-09-02T10:00:00.000001+00:00']);
    expect(out[1].beneficiaryOrganizationId).toBeNull();
    expect(queries.map((q) => q.from)).toEqual([0, 1, 2]);
    expect(queries[0].filters).toEqual([['eq', 'plan_revision_id', 'rev'], ['eq', 'import_session_id', 's1'], ['eq', 'sheet_index', 0]]);
  });
});

describe('setBeneficiaryRegions — one fenced call, never retried', () => {
  const input = {
    planRevisionId: 'rev', importSessionId: 's1', sheetIndex: 0,
    renderedParserIdentity: { contractVersion: '1.2.0', sheetjsVersion: '0.20.3', sheetjsTarballSha256: 'abc' },
    expectedSheetName: 'Sheet1', expectedVersionIds: ['v1', 'v2'], reason: 'split the column',
    changes: [
      { op: 'convert_column' as const, columnIndex: 5, expectedMappingId: 'm1', previousDecision: 'non_beneficiary' as const,
        previousBeneficiaryOrganizationId: null, previousMappedAt: '2026-09-01T10:00:00.123456+00:00' },
      { op: 'add' as const, rowStart: 0, rowEnd: 1_048_575, columnStart: 5, columnEnd: 5, decision: 'beneficiary' as const, beneficiaryOrganizationId: 'org' },
      { op: 'replace' as const, versionId: 'v1', rowStart: 1, rowEnd: 2, columnStart: 1, columnEnd: 1, decision: 'non_beneficiary' as const, beneficiaryOrganizationId: null },
      { op: 'remove' as const, versionId: 'v2' },
    ],
  };

  it('sends the exact arguments: fence, witnesses, verbatim M213 fence, explicit geometry', async () => {
    rpcHandler = () => ({
      data: { ok: true, plan_revision_id: 'rev', import_session_id: 's1', sheet_index: 0, operation_batch_id: 'b',
        active_versions: [row(3)], changes: [{ op: 'remove', regionId: 'r2', previousVersionId: 'v2', newVersionId: null }],
        converted_columns: [{ columnIndex: 5, retiredMappingId: 'm1' }] },
      error: null,
    });
    const out = await svc.setBeneficiaryRegions(input);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe('phoenix_central_needs_set_beneficiary_regions');
    expect(rpcCalls[0].args).toEqual({
      p_plan_revision_id: 'rev', p_import_session_id: 's1', p_sheet_index: 0,
      p_rendered_parser_identity: { contractVersion: '1.2.0', sheetjsVersion: '0.20.3', sheetjsTarballSha256: 'abc' },
      p_expected_sheet_name: 'Sheet1', p_expected_version_ids: ['v1', 'v2'], p_reason: 'split the column',
      p_changes: [
        { op: 'convert_column', columnIndex: 5, expectedMappingId: 'm1', previousDecision: 'non_beneficiary',
          previousBeneficiaryOrganizationId: null, previousMappedAt: '2026-09-01T10:00:00.123456+00:00' },
        { op: 'add', rowStart: 0, rowEnd: 1_048_575, columnStart: 5, columnEnd: 5, decision: 'beneficiary', beneficiaryOrganizationId: 'org' },
        { op: 'replace', versionId: 'v1', rowStart: 1, rowEnd: 2, columnStart: 1, columnEnd: 1, decision: 'non_beneficiary', beneficiaryOrganizationId: null },
        { op: 'remove', versionId: 'v2' },
      ],
    });
    expect(out.activeVersions.map((v) => v.versionId)).toEqual(['v0003']);
    expect(out.convertedColumns).toEqual([{ columnIndex: 5, retiredMappingId: 'm1' }]);
  });

  it('a stale refusal is surfaced with its code and is never retried', async () => {
    rpcHandler = () => ({ data: null, error: { message: 'beneficiary_region_stale' } });
    await expect(svc.setBeneficiaryRegions(input)).rejects.toMatchObject({ code: 'beneficiary_region_stale' });
    expect(rpcCalls).toHaveLength(1);
  });
});

describe('fetchRevisionLifecycle — maps the M215 revisions array', () => {
  it('keeps every revision with its status and effective flag', async () => {
    rpcHandler = () => ({
      data: { plan_id: 'p', effective_revision_id: 'r2', events: [],
        revisions: [{ id: 'r1', revision_number: 1, status: 'approved', effective: true },
          { id: 'r2', revision_number: 2, status: 'approved', effective: true }] },
      error: null,
    });
    const out = await svc.fetchRevisionLifecycle('org', 2026);
    expect(out.revisions).toEqual([
      { id: 'r1', revisionNumber: 1, status: 'approved', effective: true },
      { id: 'r2', revisionNumber: 2, status: 'approved', effective: true },
    ]);
  });
});
