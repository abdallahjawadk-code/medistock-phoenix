/**
 * C5 (M217 companion) — the client service boundary.
 *
 *   §14  a refusal keeps `businessCode`, `sqlstate`, `message`, `details` and
 *        `hint` apart. `businessCode` is the message ONLY when it is one exact
 *        token; infrastructure SQLSTATEs the database never translates
 *        (40P01/55P03/57014/40001) are retryable and invent no code; a
 *        privilege refusal without a token is "action unavailable". The
 *        `reason=` token is read from `details`, never from human copy.
 *   §13  `listOverrides` reads the COMPLETE chain by keyset: server order
 *        `created_at DESC, id DESC`, page 1's first row as the ceiling, a
 *        strictly-older cursor carrying the exact timestamp text plus id, and
 *        an end ONLY on an explicitly empty page — never on a page that is
 *        exactly at the server's row cap. Any inconsistency throws.
 *
 * The PostgREST mock below EVALUATES the keyset filters the service sends over
 * an in-memory chain (with an optional server row cap), so every assertion is
 * about what the server would actually return for those exact requests.
 *
 * UI-F6 — the ceiling is proven ON ITS OWN, not just alongside the cursor: a
 * mock mode ignores the cursor expression, so only the ceiling filter can keep
 * a newer row out, and the client's ceiling check is identified by its own
 * refusal. Both tests fail if the ceiling filter or check is removed.
 * TR-6 — one combined case: > 1000 rows, a server cap below the requested
 * page size, microsecond ties across page boundaries, a +03 session offset,
 * and newer rows inserted while the pages are read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { T } from '@/shared/i18n/strings';

interface OverrideRow {
  id: string;
  source_record_id: string;
  target_entity: string;
  field_name: string;
  previous_value: unknown;
  final_value: unknown;
  final_value_text: string | null;
  override_reason: string;
  override_note: string | null;
  created_at: string;
  created_at_text: string;
}

interface Request {
  table: string;
  select: string;
  eqs: Array<[string, unknown]>;
  ors: string[];
  orders: Array<[string, boolean]>;
  limit: number | null;
}

/**
 * Exact microseconds of a fixture `timestamptz::text` in ISO DateStyle —
 * `YYYY-MM-DD HH:MM:SS[.ffffff]±HH[:MM[:SS]]`, any session offset (TR-6 uses
 * `+03`). An independent re-implementation, never the service's own parser.
 */
const microsCache = new Map<string, bigint>();
function micros(text: string): bigint {
  const cached = microsCache.get(text);
  if (cached !== undefined) return cached;
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?([+-])(\d{2})(?::(\d{2}))?(?::(\d{2}))?$/.exec(text);
  if (!m) throw new Error(`fixture timestamp ${text} is not ISO timestamptz text`);
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const offsetSeconds = BigInt(+m[9] * 3600 + +(m[10] ?? 0) * 60 + +(m[11] ?? 0)) * (m[8] === '-' ? -1n : 1n);
  const value = BigInt(ms) * 1000n + BigInt((m[7] ?? '').padEnd(6, '0')) - offsetSeconds * 1_000_000n;
  microsCache.set(text, value);
  return value;
}
const cmp = (a: OverrideRow, b: { text: string; id: string }) => {
  const d = micros(a.created_at_text) - micros(b.text);
  if (d !== 0n) return d < 0n ? -1 : 1;
  return a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
};

/** One parsed `created_at.lt."T",and(created_at.eq."T",id.<op>.ID)` keyset expression. */
interface KeysetExpr { key: { text: string; id: string }; op: 'lt' | 'lte' }

function parseKeyset(expr: string): KeysetExpr {
  const m = /^created_at\.lt\."([^"]+)",and\(created_at\.eq\."([^"]+)",id\.(lt|lte)\.([^)]+)\)$/.exec(expr);
  if (!m || m[1] !== m[2]) throw new Error(`unexpected keyset filter ${expr}`);
  return { key: { text: m[1], id: m[4] }, op: m[3] as 'lt' | 'lte' };
}

/** The server-side evaluation of one `or=(created_at.lt."T",and(created_at.eq."T",id.<op>.ID))` filter. */
function keysetFilter(expr: string): (r: OverrideRow) => boolean {
  const { key, op } = parseKeyset(expr);
  return op === 'lt' ? (r) => cmp(r, key) < 0 : (r) => cmp(r, key) <= 0;
}

let chain: OverrideRow[] = [];
let serverCap = Infinity;
/**
 * UI-F6 — a server that IGNORES the client's cursor expression (the one keyed
 * on the last row it just served, with the strict `lt`) and pages by its own
 * record of what it already served instead. Every other expression — the
 * ceiling — is still applied. Under this mode a row newer than the ceiling
 * can only be kept out by the ceiling filter itself, so a test run in it
 * FAILS if that filter is removed (and the client's ceiling check then throws).
 */
let cursorIgnoredByServer = false;
const served = new Set<string>();
let lastServed: OverrideRow | null = null;
const requests: Request[] = [];
/** Rows returned per request, in request order. */
const responseSizes: number[] = [];
/** Lets a test change the server between requests, or answer a request its own way. */
let beforeAnswer: (n: number, req: Request) => { data: unknown; error: unknown } | void = () => undefined;
const rpc = vi.fn();

function answer(req: Request): { data: unknown; error: unknown } {
  requests.push(req);
  const override = beforeAnswer(requests.length, req);
  if (override) {
    responseSizes.push(Array.isArray(override.data) ? override.data.length : -1);
    return override;
  }
  const applied = cursorIgnoredByServer
    ? req.ors.filter((expr) => {
      const { key, op } = parseKeyset(expr);
      return !(op === 'lt' && lastServed !== null && key.text === lastServed.created_at_text && key.id === lastServed.id);
    })
    : req.ors;
  const rows = chain
    .filter((r) => applied.every((expr) => keysetFilter(expr)(r)))
    .filter((r) => !cursorIgnoredByServer || !served.has(r.id))
    .sort((a, b) => -cmp(a, { text: b.created_at_text, id: b.id }))
    .slice(0, Math.min(req.limit ?? Infinity, serverCap));
  for (const r of rows) served.add(r.id);
  if (rows.length > 0) lastServed = rows[rows.length - 1];
  responseSizes.push(rows.length);
  return { data: rows, error: null };
}

vi.mock('@/shared/supabase/client', () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpc(...a),
    from: (table: string) => {
      const req: Request = { table, select: '', eqs: [], ors: [], orders: [], limit: null };
      const builder = {
        select: (s: string) => { req.select = s; return builder; },
        eq: (c: string, v: unknown) => { req.eqs.push([c, v]); return builder; },
        or: (e: string) => { req.ors.push(e); return builder; },
        order: (c: string, o: { ascending: boolean }) => { req.orders.push([c, o.ascending]); return builder; },
        limit: (n: number) => { req.limit = n; return builder; },
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve().then(() => answer(req)).then(resolve, reject),
      };
      return builder;
    },
  },
}));

const svc = await import('../central-needs.service');
const { centralNeedsErrorText } = await import('../central-needs.i18n');

const ts = (second: number, micro = 0) =>
  `2026-09-26 10:00:${String(second).padStart(2, '0')}.${String(micro).padStart(6, '0')}+00`;
const row = (id: string, createdAtText: string, over: Partial<OverrideRow> = {}): OverrideRow => ({
  id, source_record_id: `rec-${id}`, target_entity: 'sheet:0:row:1', field_name: 'qty',
  previous_value: '12 boxes', final_value: 12, final_value_text: '12', override_reason: 'recount', override_note: null,
  created_at: createdAtText.replace(' ', 'T').replace('+00', '+00:00'), created_at_text: createdAtText, ...over,
});
/** The i-th fixture instant: one microsecond apart, so row i is strictly newer than row i - 1. */
const at = (i: number) => ts(0, i);
/** n rows, oldest first, ids zero-padded so id order is also meaningful. */
const rows = (n: number) => Array.from({ length: n }, (_, i) => row(`o-${String(i).padStart(4, '0')}`, at(i)));

beforeEach(() => {
  chain = [];
  serverCap = Infinity;
  cursorIgnoredByServer = false;
  served.clear();
  lastServed = null;
  requests.length = 0;
  responseSizes.length = 0;
  beforeAnswer = () => undefined;
  rpc.mockReset();
});

// ============================================================================
// §14 — the error representation.
// ============================================================================
describe('C5 §14 — CentralNeedsError keeps businessCode, sqlstate, message, details and hint apart', () => {
  it('an exact business token is the businessCode; sqlstate, details and hint are kept verbatim', () => {
    const e = svc.centralNeedsErrorFromPostgrest({
      code: '23514', message: 'need_line_quantity_lineage_unsafe',
      details: 'session=s1 source_record=r1 need_line=n1 reason=source_quantity_override_mismatch', hint: 'repin',
    });
    expect(e).toBeInstanceOf(svc.CentralNeedsError);
    expect(e).toMatchObject({
      businessCode: 'need_line_quantity_lineage_unsafe', code: 'need_line_quantity_lineage_unsafe',
      sqlstate: '23514', message: 'need_line_quantity_lineage_unsafe',
      details: 'session=s1 source_record=r1 need_line=n1 reason=source_quantity_override_mismatch',
      hint: 'repin', retryable: false,
    });
  });

  it.each([
    ['40P01', 'deadlock detected'],
    ['55P03', 'canceling statement due to lock timeout'],
    ['57014', 'canceling statement due to statement timeout'],
    ['40001', 'could not serialize access due to concurrent update'],
  ])('infrastructure SQLSTATE %s invents no business code and is retryable', (sqlstate, message) => {
    const e = svc.centralNeedsErrorFromPostgrest({ code: sqlstate, message, details: null, hint: null });
    expect(e.businessCode).toBe('central_needs_request_failed');
    expect(e.code).toBe('central_needs_request_failed');
    expect(e.sqlstate).toBe(sqlstate);
    expect(e.message).toBe(message);
    expect(e.retryable).toBe(true);
    // The old first-token heuristic produced 'deadlock', 'canceling', 'could'.
    expect(['deadlock', 'canceling', 'could']).not.toContain(e.businessCode);
  });

  it('a privilege refusal without a token (e.g. a frozen EXECUTE) is "action unavailable", never a fake code', () => {
    const e = svc.centralNeedsErrorFromPostgrest({ code: '42501', message: 'permission denied for function phoenix_central_needs_approve_revision' });
    expect(e).toMatchObject({ businessCode: 'central_needs_action_unavailable', sqlstate: '42501', retryable: false });
    // A 42501 that DOES carry a token keeps its token.
    expect(svc.centralNeedsErrorFromPostgrest({ code: '42501', message: 'forbidden_central_needs' }).businessCode)
      .toBe('forbidden_central_needs');
  });

  it('a non-token message with no SQLSTATE (transport failure) is "request failed"; a token with a suffix is not a token', () => {
    expect(svc.centralNeedsErrorFromPostgrest({ message: 'TypeError: Failed to fetch' }))
      .toMatchObject({ businessCode: 'central_needs_request_failed', sqlstate: null, retryable: false });
    expect(svc.centralNeedsErrorFromPostgrest({ code: 'P0001', message: 'suggestion_no_longer_available: provenance_gone' }).businessCode)
      .toBe('central_needs_request_failed');
    expect(svc.centralNeedsErrorFromPostgrest(null).businessCode).toBe('central_needs_request_failed');
  });

  it('the constructor stays compatible with new CentralNeedsError(code, message)', () => {
    const e = new svc.CentralNeedsError('need_line_lineage_stale', 'need_line_lineage_stale');
    expect(e).toMatchObject({
      name: 'CentralNeedsError', code: 'need_line_lineage_stale', businessCode: 'need_line_lineage_stale',
      sqlstate: null, details: null, hint: null, retryable: false,
    });
  });

  it('a refused RPC surfaces every field through the service, and is never retried', async () => {
    rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '23514', message: 'central_needs_approval_eligibility_changed', hint: null,
        details: 'blocker=need_line_beneficiary_ineligible need_line=n1 beneficiary=b1 reason=archived' },
    });
    const refused = await svc.approveRevision('rev-1').catch((e: unknown) => e);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(refused).toMatchObject({
      businessCode: 'central_needs_approval_eligibility_changed', sqlstate: '23514',
      details: 'blocker=need_line_beneficiary_ineligible need_line=n1 beneficiary=b1 reason=archived',
    });
    expect(svc.reasonOf((refused as { details: string }).details)).toBe('archived');
  });

  it('reads reason= only as a whole token of details, and never from a message', () => {
    expect(svc.reasonOf('session=s source_record=r need_line=n reason=source_quantity_override_binding_invalid'))
      .toBe('source_quantity_override_binding_invalid');
    expect(svc.reasonOf('reason=invalid_evidence')).toBe('invalid_evidence');
    expect(svc.reasonOf('session=s xreason=nope')).toBeNull();
    expect(svc.reasonOf(null)).toBeNull();
    expect(svc.reasonOf(undefined)).toBeNull();
    expect(svc.sourceRecordOf('session=s source_record=r-1 need_line=n reason=x')).toBe('r-1');
    const e = svc.centralNeedsErrorFromPostgrest({ code: '23514', message: 'need_line_quantity_lineage_unsafe reason=forged', details: null });
    expect(svc.reasonOf(e.details)).toBeNull();
  });

  it('renders retryable contention as "try again", a pinned reason by its own sentence, and a code by its own', () => {
    const retry = svc.centralNeedsErrorFromPostgrest({ code: '40P01', message: 'deadlock detected' });
    expect(centralNeedsErrorText(retry, 'en')).toBe(T.cn2b_err_retryable_contention.en);
    expect(centralNeedsErrorText(retry, 'ar')).toBe(T.cn2b_err_retryable_contention.ar);

    const reasoned = svc.centralNeedsErrorFromPostgrest({
      code: '23514', message: 'central_needs_approval_eligibility_changed',
      details: 'blocker=need_line_warehouse_org_mismatch need_line=n1 beneficiary=b1 warehouse=w1 reason=not_owned',
    });
    expect(centralNeedsErrorText(reasoned, 'en')).toBe(T.cn2b_err_central_needs_approval_eligibility_changed__not_owned.en);

    const unknownReason = svc.centralNeedsErrorFromPostgrest({
      code: '23514', message: 'central_needs_approval_eligibility_changed', details: 'reason=some_future_reason',
    });
    expect(centralNeedsErrorText(unknownReason, 'en')).toBe(T.cn2b_err_central_needs_approval_eligibility_changed.en);

    const frozen = svc.centralNeedsErrorFromPostgrest({ code: '42501', message: 'permission denied for function x' });
    expect(centralNeedsErrorText(frozen, 'ar')).toBe(T.cn2b_err_central_needs_action_unavailable.ar);
    // The string path is unchanged: an untranslated code degrades to itself.
    expect(centralNeedsErrorText('some_future_code', 'en')).toBe('some_future_code');
  });
});

// ============================================================================
// §13 — keyset override reading.
// ============================================================================
describe('C5 §13 — listOverrides reads the complete chain by keyset', () => {
  it('asks for created_at DESC, id DESC with the exact text columns, and page 1 carries no keyset filter', async () => {
    chain = rows(3);
    const out = await svc.listOverrides('rev-1');
    expect(out.map((o) => o.id)).toEqual(['o-0002', 'o-0001', 'o-0000']);
    const first = requests[0];
    expect(first.table).toBe('central_needs_field_overrides');
    expect(first.eqs).toEqual([['plan_revision_id', 'rev-1']]);
    expect(first.orders).toEqual([['created_at', false], ['id', false]]);
    expect(first.select).toContain('created_at_text:created_at::text');
    expect(first.select).toContain('final_value_text:final_value::text');
    expect(first.limit).toBe(500);
    expect(first.ors).toEqual([]);
    // A short page is NOT trusted as the end: the read ends on an empty page.
    expect(requests).toHaveLength(2);
    expect(requests[1].ors).toHaveLength(2);
  });

  it('pins page 1’s first row as the ceiling and pages strictly older by exact text + id', async () => {
    chain = rows(5);
    serverCap = 2;
    await svc.listOverrides('rev-1');
    const ceiling = `created_at.lt."${at(4)}",and(created_at.eq."${at(4)}",id.lte.o-0004)`;
    expect(requests.map((r) => r.ors)).toEqual([
      [],
      [ceiling, `created_at.lt."${at(3)}",and(created_at.eq."${at(3)}",id.lt.o-0003)`],
      [ceiling, `created_at.lt."${at(1)}",and(created_at.eq."${at(1)}",id.lt.o-0001)`],
      [ceiling, `created_at.lt."${at(0)}",and(created_at.eq."${at(0)}",id.lt.o-0000)`],
    ]);
  });

  it('never ends on a page exactly at the server row cap — a capped server below the requested size still yields everything', async () => {
    chain = rows(7);
    serverCap = 3; // below the requested 500: every full page is "short" and exactly at the cap
    const out = await svc.listOverrides('rev-1');
    expect(out).toHaveLength(7);
    expect(new Set(out.map((o) => o.id)).size).toBe(7);
    // 3 + 3 + 1, then the explicit empty page that confirms exhaustion.
    expect(requests).toHaveLength(4);
  });

  it('continues past a page exactly the requested size (500) and reads all 1203 rows', async () => {
    chain = rows(1203);
    const out = await svc.listOverrides('rev-1');
    expect(out).toHaveLength(1203);
    expect(requests.map((r) => r.limit)).toEqual([500, 500, 500, 500]);
    // Newest first, never re-sorted on the client.
    expect(out[0].id).toBe('o-1202');
    expect(out[out.length - 1].id).toBe('o-0000');
  }, 30_000);

  // UI-F6 — against an honest server the strictly-older cursor alone would
  // also keep the late row out, so that run cannot tell whether the ceiling
  // works. The second run uses a server that IGNORES the cursor expression:
  // there only the ceiling filter can exclude the late row, and removing it
  // makes the read return the late row first, which the client refuses.
  it.each([
    ['an honest server', false],
    ['a server that ignores the cursor (only the CEILING filter can exclude it)', true],
  ])('excludes an override recorded after page 1 (newer than the ceiling) — %s', async (_label, ignoreCursor) => {
    cursorIgnoredByServer = ignoreCursor;
    chain = rows(4);
    serverCap = 2;
    beforeAnswer = (n) => {
      if (n === 2) chain.push(row('o-late', ts(59, 999999)));
    };
    const out = await svc.listOverrides('rev-1');
    expect(out.map((o) => o.id)).toEqual(['o-0003', 'o-0002', 'o-0001', 'o-0000']);
    // 2 + 2 + the explicitly empty page, which would have carried the late row had no ceiling applied.
    expect(responseSizes).toEqual([2, 2, 0]);
    // Every later request carries a filter that, evaluated ON ITS OWN over the
    // server's final rows, admits exactly the rows at or below page 1's first
    // row and never the late one.
    const original = chain.filter((r) => r.id !== 'o-late').map((r) => r.id).sort();
    for (const req of requests.slice(1)) {
      const alone = req.ors.map((expr) => chain.filter(keysetFilter(expr)).map((r) => r.id).sort());
      expect(alone).toContainEqual(original);
    }
  });

  it('orders a microsecond apart and ties by id DESC, exactly as the server does', async () => {
    chain = [
      row('b', ts(1, 1)), row('a', ts(1, 1)), row('c', ts(1, 0)), row('z', ts(1, 2)),
    ];
    const out = await svc.listOverrides('rev-1');
    expect(out.map((o) => o.id)).toEqual(['z', 'b', 'a', 'c']);
    expect(out[0]).toMatchObject({ createdAtText: ts(1, 2), finalValue: 12, finalValueText: '12', sourceRecordId: 'rec-z' });
  });

  it('FAILS CLOSED on a duplicate id across pages', async () => {
    chain = rows(4);
    serverCap = 2;
    // Page 2 replays o-0002 (already read on page 1) ahead of an older row.
    beforeAnswer = (n) => (n === 2 ? { data: [chain[2], chain[1]].map((r) => ({ ...r })), error: null } : undefined);
    await expect(svc.listOverrides('rev-1')).rejects.toMatchObject({ businessCode: 'field_overrides_read_inconsistent' });
  });

  it('FAILS CLOSED on a row that is not strictly older than the one before it', async () => {
    beforeAnswer = (n) => (n === 1 ? { data: [row('x', ts(1)), row('y', ts(2))], error: null } : { data: [], error: null });
    await expect(svc.listOverrides('rev-1')).rejects.toMatchObject({ businessCode: 'field_overrides_read_inconsistent' });
  });

  it('FAILS CLOSED when a later page returns a row newer than the ceiling — refused BY THE CEILING CHECK', async () => {
    beforeAnswer = (n) => (n === 1
      ? { data: [row('x', ts(5)), row('w', ts(4))], error: null }
      : n === 2 ? { data: [row('late', ts(9))], error: null } : { data: [], error: null });
    // UI-F6 — a row above the ceiling is also not older than the cursor, so
    // the out-of-order check would refuse it too. The message pins WHICH check
    // refused it: without the client's own ceiling comparison this fails.
    await expect(svc.listOverrides('rev-1')).rejects.toMatchObject({
      businessCode: 'field_overrides_read_inconsistent',
      message: expect.stringMatching(/^override late is newer than the read ceiling$/),
    });
  });

  it('a server that ignores both keyset filters is refused by the ceiling check, never returned mixed', async () => {
    chain = rows(3);
    serverCap = 2;
    // Page 2 of a server honouring no filter at all: a row newer than page 1
    // was recorded meanwhile and comes back first.
    beforeAnswer = (n) => {
      if (n === 2) {
        chain.push(row('o-late', ts(59, 999999)));
        return { data: [chain[3], chain[0]], error: null };
      }
      return undefined;
    };
    await expect(svc.listOverrides('rev-1')).rejects.toMatchObject({
      businessCode: 'field_overrides_read_inconsistent',
      message: expect.stringMatching(/^override o-late is newer than the read ceiling$/),
    });
  });

  // TR-6 — the v1.8 §20 "> 1000 keyset pagination under concurrent insert"
  // requirement as ONE combined case: more than 1000 overrides, a server row
  // cap BELOW the requested page size (so every full page is "short"), pairs
  // of rows tied on the same microsecond (so page boundaries fall inside a
  // tie and exercise the `created_at.eq … id.lt` branch), timestamps printed
  // in a non-UTC session offset (+03), and newer overrides recorded while the
  // pages are being read. Run against an honest server and against one that
  // ignores the cursor, where only the ceiling keeps the newer rows out.
  it.each([
    ['an honest server', false],
    ['a server that ignores the cursor', true],
  ])('TR-6: 2503 rows, a 300-row server cap, ties, +03 offsets and concurrent newer inserts — %s', async (_label, ignoreCursor) => {
    cursorIgnoredByServer = ignoreCursor;
    const N = 2503;
    // Row i: instant 10:00:00 UTC + floor(i/2) µs, printed as +03 local time.
    const tsPlus3 = (micro: number, second = 0) =>
      `2026-09-26 13:00:${String(second).padStart(2, '0')}.${String(micro).padStart(6, '0')}+03`;
    chain = Array.from({ length: N }, (_, i) => row(`o-${String(i).padStart(4, '0')}`, tsPlus3(Math.floor(i / 2))));
    const expected = [...chain].reverse().map((r) => r.id);
    serverCap = 300; // below the requested 500
    const late: string[] = [];
    beforeAnswer = (n) => {
      // Newer overrides land before pages 2, 3 and 4 (one second later, so strictly above the ceiling).
      if (n >= 2 && n <= 4) {
        const id = `o-late-${n}`;
        chain.push(row(id, tsPlus3(n, 1)));
        late.push(id);
      }
    };

    const out = await svc.listOverrides('rev-1');
    const ids = out.map((o) => o.id);

    // Every row at or below the ceiling, exactly once, in server order.
    expect(ids).toHaveLength(N);
    expect(new Set(ids).size).toBe(N);
    expect(ids).toEqual(expected);
    // None of the rows recorded during the read.
    expect(late).toEqual(['o-late-2', 'o-late-3', 'o-late-4']);
    for (const id of late) expect(ids).not.toContain(id);
    // Ends ONLY on an explicitly empty page: 8 full capped pages, one short
    // page (103 rows) that is NOT trusted as the end, then the empty page.
    expect(responseSizes).toEqual([300, 300, 300, 300, 300, 300, 300, 300, 103, 0]);
    expect(requests.map((r) => r.limit)).toEqual(Array(10).fill(500));
    // The ceiling is page 1's first row, pinned on every later request.
    const ceiling = `created_at.lt."${tsPlus3(1251)}",and(created_at.eq."${tsPlus3(1251)}",id.lte.o-2502)`;
    for (const req of requests.slice(1)) expect(req.ors[0]).toBe(ceiling);
    // A page boundary inside a tie: page 1 ends on o-2203 (instant 1101), and
    // page 2's cursor asks for its tie partner o-2202 by id.
    expect(requests[1].ors[1]).toBe(`created_at.lt."${tsPlus3(1101)}",and(created_at.eq."${tsPlus3(1101)}",id.lt.o-2203)`);
    expect(ids[300]).toBe('o-2202');
  }, 60_000);

  // UI-F7 — the exact `created_at::text` shapes PostgreSQL 17 printed on the
  // loopback rig (read-only probe, 2026-09-26) under TimeZone Asia/Baghdad,
  // Asia/Kolkata and Asia/Riyadh (1900 LMT), DateStyle ISO — and what it
  // prints under a non-ISO DateStyle, which must fail closed.
  it('orders real ISO offsets (+03, +05:30, LMT +03:06:52) by their exact instants', async () => {
    chain = [
      row('lmt', '1900-01-01 03:06:52+03:06:52'), // 1900-01-01 00:00:00 UTC
      row('bgd', '2026-09-26 13:00:00.000001+03'), // 2026-09-26 10:00:00.000001 UTC
      row('kol', '2026-09-26 15:30:00.123456+05:30'), // 2026-09-26 10:00:00.123456 UTC
    ];
    const out = await svc.listOverrides('rev-1');
    expect(out.map((o) => o.id)).toEqual(['kol', 'bgd', 'lmt']);
    expect(out.map((o) => o.createdAtText)).toEqual([
      '2026-09-26 15:30:00.123456+05:30', '2026-09-26 13:00:00.000001+03', '1900-01-01 03:06:52+03:06:52',
    ]);
  });

  it('FAILS CLOSED on a non-ISO DateStyle timestamp text', async () => {
    beforeAnswer = () => ({ data: [{ ...row('x', ts(1)), created_at_text: '26/09/2026 10:00:00.5 UTC' }], error: null });
    await expect(svc.listOverrides('rev-1')).rejects.toMatchObject({ businessCode: 'field_overrides_read_inconsistent' });
  });

  it('FAILS CLOSED on a row without an exact timestamp text', async () => {
    beforeAnswer = () => ({ data: [{ ...row('x', ts(1)), created_at_text: 'yesterday' }], error: null });
    await expect(svc.listOverrides('rev-1')).rejects.toMatchObject({ businessCode: 'field_overrides_read_inconsistent' });
  });

  it('throws on a LATER-page error rather than returning the part it already read', async () => {
    chain = rows(4);
    serverCap = 2;
    beforeAnswer = (n) => (n === 2 ? { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } } : undefined);
    const refused = await svc.listOverrides('rev-1').catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(svc.CentralNeedsError);
    expect(refused).toMatchObject({ businessCode: 'central_needs_request_failed', sqlstate: '57014', retryable: true });
  });
});

describe('C5 §14 — recording an override returns its id, which the caller never auto-pins', () => {
  it('returns override_id from the canonical RPC', async () => {
    rpc.mockResolvedValueOnce({ data: { ok: true, override_id: 'ovr-9', source_record_id: 'r1' }, error: null });
    const out = await svc.recordFieldOverride({ sourceRecordId: 'r1', finalValue: 12.5, overrideReason: 'recount' });
    expect(out).toEqual({ overrideId: 'ovr-9' });
    expect(rpc).toHaveBeenCalledWith('phoenix_central_needs_record_field_override', expect.objectContaining({
      p_source_record_id: 'r1', p_final_value: 12.5, p_override_reason: 'recount',
    }));
  });
});
