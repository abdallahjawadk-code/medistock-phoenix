/** @vitest-environment jsdom */
/**
 * PRE3 N1 — the session enumeration behind "Session K of N", proven against an
 * in-memory PostgREST stand-in that behaves like the real one where it matters:
 *
 *   * FILTER → ORDER → LIMIT, whatever order the builder methods were called in;
 *   * EVERY response is capped at `max_rows` (1000, supabase/config.toml), with
 *     no error and no sign of the cut — exactly what real PostgREST v16.4 did to
 *     the old unpaged read (HTTP 200, `Content-Range: 0-999/*`);
 *   * `Prefer: count=exact` counts the filtered rows before the limit, and a
 *     HEAD request answers the count alone;
 *   * the keyset logic tree `started_at.gt."t",and(started_at.eq."t",id.gt.<id>)`
 *     is evaluated, timestamps compared as exact instants (microseconds).
 *
 * The service tests run the REAL `listImportSessions` / `searchWorkSessions`;
 * the screen tests render the REAL screen over the same stand-in.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { T, t } from '@/shared/i18n/strings';
import type { ImportSession, PlanRevision, ReviewReadiness } from '../central-needs.service';
import type { OrgRow } from '@/shared/supabase/services/organizations.service';

// ---------------------------------------------------------------------------
// The PostgREST stand-in
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const MAX_ROWS_DEFAULT = 1000;
const TIME_COLUMNS = new Set(['started_at', 'uploaded_at', 'registered_at']);
const TS = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2})(?::?(\d{2}))?)$/;

/** Exact instant in microseconds — an independent parser, not the service's. */
function instant(text: unknown): bigint {
  const m = typeof text === 'string' ? TS.exec(text) : null;
  if (!m) throw new Error(`stand-in: not a timestamptz: ${String(text)}`);
  const [, y, mo, d, h, mi, s, frac = '', zone, sign, oh = '0', om = '0'] = m;
  const seconds = BigInt(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) / 1000);
  const offset = zone === 'Z' ? 0n : BigInt((+oh * 3600 + +om * 60) * (sign === '-' ? -1 : 1));
  return (seconds - offset) * 1_000_000n + BigInt(frac.padEnd(6, '0'));
}

function compareCell(col: string, a: unknown, b: unknown): number {
  if (TIME_COLUMNS.has(col)) {
    const x = instant(a);
    const y = instant(b);
    return x === y ? 0 : x < y ? -1 : 1;
  }
  const x = String(a);
  const y = String(b);
  return x === y ? 0 : x < y ? -1 : 1;
}

function escapeRe(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** PostgREST ILIKE: `%`/`*` any run, `_` one char, `\` escapes the next char; case-insensitive. */
function ilikeMatches(value: unknown, pattern: string): boolean {
  if (typeof value !== 'string') return false;
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) { i += 1; re += escapeRe(pattern[i]); continue; }
    if (ch === '%' || ch === '*') re += '.*';
    else if (ch === '_') re += '.';
    else re += escapeRe(ch);
  }
  return new RegExp(`^${re}$`, 'isu').test(value);
}

/** Split a logic tree on top-level commas (outside parentheses and double quotes). */
function splitTopLevel(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < expr.length; i += 1) {
    const ch = expr[i];
    if (quoted) { if (ch === '\\') i += 1; else if (ch === '"') quoted = false; continue; }
    if (ch === '"') quoted = true;
    else if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) { parts.push(expr.slice(start, i)); start = i + 1; }
  }
  if (depth !== 0 || quoted) throw new Error(`stand-in: unbalanced logic tree: ${expr}`);
  parts.push(expr.slice(start));
  return parts;
}

function comparison(col: string, op: string, value: string): (row: Row) => boolean {
  return (row) => {
    if (row[col] === null || row[col] === undefined) return false;
    const c = compareCell(col, row[col], value);
    switch (op) {
      case 'eq': return c === 0;
      case 'gt': return c > 0;
      case 'gte': return c >= 0;
      case 'lt': return c < 0;
      case 'lte': return c <= 0;
      default: throw new Error(`stand-in: unsupported operator ${op}`);
    }
  };
}

function logicNode(text: string): (row: Row) => boolean {
  if (text.startsWith('and(') && text.endsWith(')')) {
    const nodes = splitTopLevel(text.slice(4, -1)).map(logicNode);
    return (row) => nodes.every((n) => n(row));
  }
  const m = /^([a-z_]+)\.(eq|gt|gte|lt|lte)\.(.*)$/s.exec(text);
  if (!m) throw new Error(`stand-in: unsupported logic-tree term: ${text}`);
  let value = m[3];
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) throw new Error(`stand-in: bad quoted value: ${value}`);
    value = value.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return comparison(m[1], m[2], value);
}

interface FakeRequest {
  table: string;
  head: boolean;
  count: boolean;
  ops: Array<[string, ...unknown[]]>;
  limit: number | null;
  /** Rows actually returned (after the max_rows cap); -1 for a transport failure. */
  rows: number;
  counted: number | null;
}

interface FakeResponse { data: Row[] | null; error: { message: string; code: string } | null; count: number | null }

interface Server {
  maxRows: number;
  db: Record<string, Row[]>;
  log: FakeRequest[];
  /** Runs before a request is answered: insert rows between pages, hold a page open, … */
  before?: (req: FakeRequest, pageNo: number) => void | Promise<void>;
  /** Tampers with an answer: a repeated page, an omitted row, a missing count, … */
  tamper?: (req: FakeRequest, res: FakeResponse, pageNo: number) => FakeResponse;
  /** A transport failure for this request. */
  fail?: (req: FakeRequest, pageNo: number) => boolean;
  /** Honour the `or` keyset filter (a broken proxy may not). */
  honourOr: boolean;
}

const server: Server = { maxRows: MAX_ROWS_DEFAULT, db: {}, log: [], honourOr: true };

function resetServer() {
  server.maxRows = MAX_ROWS_DEFAULT;
  server.db = {};
  server.log = [];
  server.before = undefined;
  server.tamper = undefined;
  server.fail = undefined;
  server.honourOr = true;
}

/** Enumeration pages of central_needs_import_sessions (GET with an exact count) seen so far. */
const sessionPages = () => server.log.filter((r) => r.table === 'central_needs_import_sessions' && r.count && !r.head);

class FakeQuery implements PromiseLike<FakeResponse> {
  private readonly filters: Array<(row: Row) => boolean> = [];
  private readonly orders: Array<{ col: string; ascending: boolean }> = [];
  private readonly req: FakeRequest;
  private from = 0;
  private to: number | null = null;

  constructor(table: string) {
    this.req = { table, head: false, count: false, ops: [], limit: null, rows: 0, counted: null };
  }

  select(cols: string, opts?: { count?: string; head?: boolean }) {
    this.req.ops.push(['select', cols]);
    this.req.count = opts?.count === 'exact';
    this.req.head = opts?.head === true;
    return this;
  }
  eq(col: string, value: unknown) { this.req.ops.push(['eq', col, value]); this.filters.push(comparison(col, 'eq', String(value))); return this; }
  gt(col: string, value: string) { this.req.ops.push(['gt', col, value]); this.filters.push(comparison(col, 'gt', value)); return this; }
  gte(col: string, value: string) { this.req.ops.push(['gte', col, value]); this.filters.push(comparison(col, 'gte', value)); return this; }
  lte(col: string, value: string) { this.req.ops.push(['lte', col, value]); this.filters.push(comparison(col, 'lte', value)); return this; }
  in(col: string, values: unknown[]) { this.req.ops.push(['in', col, values]); this.filters.push((row) => values.includes(row[col])); return this; }
  ilike(col: string, pattern: string) { this.req.ops.push(['ilike', col, pattern]); this.filters.push((row) => ilikeMatches(row[col], pattern)); return this; }
  or(expr: string) {
    this.req.ops.push(['or', expr]);
    const nodes = splitTopLevel(expr).map(logicNode);
    if (server.honourOr) this.filters.push((row) => nodes.some((n) => n(row)));
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.req.ops.push(['order', col]);
    this.orders.push({ col, ascending: opts?.ascending !== false });
    return this;
  }
  limit(n: number) { this.req.ops.push(['limit', n]); this.req.limit = n; this.to = n - 1; return this; }
  range(from: number, to: number) { this.req.ops.push(['range', from, to]); this.from = from; this.to = to; return this; }

  private async resolve(): Promise<FakeResponse> {
    server.log.push(this.req);
    const pageNo = this.req.table === 'central_needs_import_sessions' && this.req.count && !this.req.head ? sessionPages().length : 0;
    await server.before?.(this.req, pageNo);
    if (server.fail?.(this.req, pageNo)) {
      this.req.rows = -1;
      return { data: null, error: { message: 'TypeError: fetch failed', code: '' }, count: null };
    }
    // FILTER → ORDER → LIMIT, then the server's own cap.
    const filtered = (server.db[this.req.table] ?? []).filter((row) => this.filters.every((f) => f(row)));
    const ordered = [...filtered].sort((a, b) => {
      for (const o of this.orders) {
        const c = compareCell(o.col, a[o.col], b[o.col]);
        if (c !== 0) return o.ascending ? c : -c;
      }
      return 0;
    });
    const end = this.to === null ? ordered.length : this.to + 1;
    const page = ordered.slice(this.from, Math.min(end, this.from + server.maxRows)).map((row) => ({ ...row }));
    let res: FakeResponse = {
      data: this.req.head ? null : page,
      error: null,
      count: this.req.count ? filtered.length : null,
    };
    if (server.tamper) res = server.tamper(this.req, res, pageNo);
    this.req.rows = res.data?.length ?? 0;
    this.req.counted = res.count;
    return res;
  }

  then<A = FakeResponse, B = never>(
    onfulfilled?: ((value: FakeResponse) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.resolve().then(onfulfilled, onrejected);
  }
}

vi.mock('@/shared/supabase/client', () => ({
  supabase: {
    from: (table: string) => new FakeQuery(table),
    rpc: async () => ({ data: null, error: { message: 'stand-in: no rpc', code: 'XX000' }, count: null }),
  },
  supabaseConfigured: true,
  __installQaSupabaseClient: () => undefined,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG = 'org-1';
const REV = '11111111-1111-4111-8111-111111111111';
const REV_B = '22222222-2222-4222-8222-222222222222';

/** A deterministic, well-mixed canonical uuid (no real randomness in a test). */
function uuidFor(seed: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  let out = '';
  for (let round = 0; out.length < 32; round += 1) {
    for (const ch of `${seed}#${round}`) {
      h1 = Math.imul(h1 ^ ch.charCodeAt(0), 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ ch.charCodeAt(0), 0x5bd1e995) >>> 0;
    }
    out += h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
  }
  const hex = out.slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = '89ab'[parseInt(hex[16], 16) % 4];
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Start times one MICROSECOND apart — all inside one millisecond, so a millisecond clock cannot order them. */
const startedAt = (group: number) => `2026-01-01T08:00:00.${String(group).padStart(6, '0')}+00:00`;

interface SessionFixture {
  /** In insertion order (deliberately scrambled). */
  rows: Row[];
  /** The true order: started_at, then id. */
  ordered: string[];
}

/**
 * `n` sessions of `rev`. Every `group` consecutive sessions share ONE start
 * time (a single import transaction); groups are one microsecond apart. Rows
 * are inserted in a scrambled order, so an answer that ignores the ordering —
 * or orders without the id tie-break — comes back visibly wrong.
 */
function sessionsOf(rev: string, n: number, group = 7, status: (i: number) => string = () => 'processing'): SessionFixture {
  const rows: Row[] = Array.from({ length: n }, (_, i) => ({
    id: uuidFor(`${rev}:${i}`),
    plan_revision_id: rev,
    source_file_id: uuidFor(`${rev}:file:${i}`),
    status: status(i),
    preview_digest: 'd'.repeat(64),
    authoritative_digest: null,
    parser_identity: null,
    started_at: startedAt(Math.floor(i / group)),
    completed_at: null,
    notes: null,
    entry_path: `many/e-${String(i).padStart(4, '0')}.xlsx`,
  }));
  const ordered = [...rows]
    .sort((a, b) => compareCell('started_at', a.started_at, b.started_at) || compareCell('id', a.id, b.id))
    .map((r) => r.id as string);
  // Scramble: a stride walk visits every index exactly once (gcd(stride, n) = 1).
  const stride = [7919, 104729, 1299709].find((p) => n % p !== 0) ?? 1;
  const scrambled = Array.from({ length: n }, (_, k) => rows[(k * stride) % n]);
  return { rows: scrambled, ordered };
}

function sourceFilesOf(rows: Row[]): Row[] {
  return rows.map((r) => ({
    id: r.source_file_id, plan_revision_id: r.plan_revision_id,
    original_filename: `src-${String(r.entry_path).slice(7)}`, uploaded_at: r.started_at,
  }));
}

function install(...fixtures: SessionFixture[]) {
  server.db.central_needs_import_sessions = fixtures.flatMap((f) => f.rows);
  server.db.central_needs_source_files = fixtures.flatMap((f) => sourceFilesOf(f.rows));
  server.db.central_needs_import_batches = [];
  server.db.central_needs_import_batch_entries = [];
}

// ---------------------------------------------------------------------------
// The module under test (session reads real; everything else the screen reads is stubbed)
// ---------------------------------------------------------------------------

const listPlanRevisions = vi.fn();
const listImportBatches = vi.fn();
const listOverrides = vi.fn();
const fetchReviewReadiness = vi.fn();
const listNeedLineLineage = vi.fn();
const listBeneficiaryColumns = vi.fn();
const listBeneficiaryRegions = vi.fn();
const listSourceRecords = vi.fn();
const listDispositions = vi.fn();
const searchBatchEntries = vi.fn();
const getOrganizations = vi.fn();

const appState = {
  lang: 'en' as 'ar' | 'en', dir: 'ltr' as 'ltr' | 'rtl', activeOrgId: ORG,
  profile: { organization_id: ORG },
  myPermissions: new Set(['central_needs.import', 'central_needs.edit', 'central_needs.approve']),
};

vi.mock('@/app/AppContext', () => ({ useApp: () => appState }));
vi.mock('@/shared/supabase/services/organizations.service', () => ({ getOrganizations: () => getOrganizations() }));
vi.mock('@/shared/supabase/services/warehouses.service', () => ({ getWarehouses: async () => [] }));
vi.mock('../central-needs.service', async () => {
  const actual = await vi.importActual<typeof import('../central-needs.service')>('../central-needs.service');
  return {
    ...actual,
    // listImportSessions and searchWorkSessions are the REAL ones.
    listPlanRevisions: (...a: unknown[]) => listPlanRevisions(...a),
    listImportBatches: (...a: unknown[]) => listImportBatches(...a),
    listOverrides: (...a: unknown[]) => listOverrides(...a),
    fetchReviewReadiness: (...a: unknown[]) => fetchReviewReadiness(...a),
    listNeedLineLineage: (...a: unknown[]) => listNeedLineLineage(...a),
    listBeneficiaryColumns: (...a: unknown[]) => listBeneficiaryColumns(...a),
    listBeneficiaryRegions: (...a: unknown[]) => listBeneficiaryRegions(...a),
    listSourceRecords: (...a: unknown[]) => listSourceRecords(...a),
    listDispositions: (...a: unknown[]) => listDispositions(...a),
    searchBatchEntries: (...a: unknown[]) => searchBatchEntries(...a),
    searchSourceFiles: vi.fn(async () => []),
    searchCentralItems: vi.fn(async () => []),
    setRecordDisposition: vi.fn(),
    recordFieldOverride: vi.fn(),
  };
});

const {
  CentralNeedsError, listImportSessions, rankImportSessions, reasonOf, searchWorkSessions,
  WORK_SESSION_SEARCH_MAX_LIMIT,
} = await import('../central-needs.service');
const { centralNeedsErrorText } = await import('../central-needs.i18n');
const { CentralNeedsScreen } = await import('../CentralNeedsScreen');

beforeEach(() => {
  vi.clearAllMocks();
  resetServer();
});
afterEach(() => cleanup());

const ids = (sessions: readonly ImportSession[]) => sessions.map((s) => s.id);

async function refusalOf(promise: Promise<unknown>): Promise<InstanceType<typeof CentralNeedsError>> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(CentralNeedsError);
  return error as InstanceType<typeof CentralNeedsError>;
}

// ---------------------------------------------------------------------------
// Service: complete, ordered, paged past max_rows
// ---------------------------------------------------------------------------

describe('PRE3 N1 — listImportSessions returns EVERY session of the revision, in (started_at, id) order', () => {
  it.each([
    [0, 1, false], [1, 1, false], [499, 1, false], [500, 1, false], [501, 2, true],
    [999, 2, true], [1000, 2, true], [1001, 3, true], [2001, 5, true],
  ])('%i sessions → all of them, in order, no duplicates (%i keyset pages, closing count: %s)', async (n, pages, closingCount) => {
    const fixture = sessionsOf(REV, n);
    install(fixture);
    const sessions = await listImportSessions(REV);
    expect(ids(sessions)).toEqual(fixture.ordered);
    expect(new Set(ids(sessions)).size).toBe(n);
    // The number every screen shows: "Session K of N" over ALL of them.
    const ranks = rankImportSessions(sessions);
    expect(ranks.size).toBe(n);
    if (n > 0) expect(ranks.get(fixture.ordered[n - 1])).toEqual({ ordinal: n, total: n });

    expect(sessionPages()).toHaveLength(pages);
    const heads = server.log.filter((r) => r.head);
    expect(heads).toHaveLength(closingCount ? 1 : 0);
    expect(server.log).toHaveLength(pages + (closingCount ? 1 : 0));
    for (const req of server.log) {
      // Never a client-side bound above max_rows, and every answer within it.
      expect(req.limit === null || req.limit <= MAX_ROWS_DEFAULT).toBe(true);
      expect(req.rows).toBeLessThanOrEqual(MAX_ROWS_DEFAULT);
      expect(req.ops).toContainEqual(['eq', 'plan_revision_id', REV]);
    }
  });

  it('each page is filtered, then keyset-bounded, then ordered by started_at and id, then limited', async () => {
    install(sessionsOf(REV, 1001));
    await listImportSessions(REV);
    const [first, second, third] = sessionPages();
    expect(first.ops.map((op) => op[0])).toEqual(['select', 'eq', 'order', 'order', 'limit']);
    expect(first.ops.filter((op) => op[0] === 'order')).toEqual([['order', 'started_at'], ['order', 'id']]);
    for (const page of [second, third]) {
      expect(page.ops.map((op) => op[0])).toEqual(['select', 'eq', 'or', 'order', 'order', 'limit']);
      const or = page.ops.find((op) => op[0] === 'or')?.[1] as string;
      expect(or).toMatch(/^started_at\.gt\."[^"]+",and\(started_at\.eq\."[^"]+",id\.gt\.[0-9a-f-]{36}\)$/);
    }
    expect(server.log.at(-1)).toMatchObject({ head: true, count: true });
  });

  it('a server that caps every page far below the request (7 rows) still yields every session, once', async () => {
    server.maxRows = 7;
    const fixture = sessionsOf(REV, 1001, 3);
    install(fixture);
    const sessions = await listImportSessions(REV);
    expect(ids(sessions)).toEqual(fixture.ordered);
    expect(sessionPages()).toHaveLength(Math.ceil(1001 / 7));
  }, 30_000);

  it('ties: 1001 sessions with ONE start time (one import transaction) come back in id order across every page boundary', async () => {
    const fixture = sessionsOf(REV, 1001, 1001);
    install(fixture);
    const sessions = await listImportSessions(REV);
    expect(ids(sessions)).toEqual([...fixture.ordered]);
    expect(ids(sessions)).toEqual([...ids(sessions)].sort());
    expect(new Set(sessions.map((s) => s.startedAt)).size).toBe(1);
  });

  it('start times one microsecond apart (one millisecond for all 2001) keep their exact order across page boundaries', async () => {
    const fixture = sessionsOf(REV, 2001, 7);
    install(fixture);
    const sessions = await listImportSessions(REV);
    expect(ids(sessions)).toEqual(fixture.ordered);
    // The order is NOT the id order: the microsecond really decides.
    expect(ids(sessions)).not.toEqual([...ids(sessions)].sort());
  });

  it('is identical on every call — deterministic pagination', async () => {
    install(sessionsOf(REV, 1001));
    const a = ids(await listImportSessions(REV));
    const b = ids(await listImportSessions(REV));
    expect(b).toEqual(a);
  });

  it('revision isolation: another revision\'s sessions never appear, and every request is scoped to the revision', async () => {
    const mine = sessionsOf(REV, 1001);
    const theirs = sessionsOf(REV_B, 1001);
    install(mine, theirs);
    const sessions = await listImportSessions(REV);
    expect(ids(sessions)).toEqual(mine.ordered);
    expect(sessions.every((s) => s.planRevisionId === REV)).toBe(true);
    for (const req of server.log) expect(req.ops).toContainEqual(['eq', 'plan_revision_id', REV]);
  });
});

// ---------------------------------------------------------------------------
// Service: fail closed — never a partial list
// ---------------------------------------------------------------------------

describe('PRE3 N1 — an enumeration that cannot be proven complete is refused, never returned partially', () => {
  const expectRefusal = async (reason: string) => {
    const error = await refusalOf(listImportSessions(REV));
    expect(error.businessCode).toBe('import_sessions_read_inconsistent');
    expect(reasonOf(error.details)).toBe(reason);
    return error;
  };

  it('a session that appears BEHIND the cursor between pages (an earlier-started import commits late)', async () => {
    const fixture = sessionsOf(REV, 1001);
    install(fixture);
    server.before = (_req, pageNo) => {
      if (pageNo === 2) {
        server.db.central_needs_import_sessions.push({ ...fixture.rows[0], id: uuidFor('late'), started_at: startedAt(0) });
      }
    };
    await expectRefusal('count_mismatch');
  });

  it('a session that appears AHEAD of the cursor between pages', async () => {
    const fixture = sessionsOf(REV, 1001);
    install(fixture);
    server.before = (_req, pageNo) => {
      if (pageNo === 2) {
        server.db.central_needs_import_sessions.push({ ...fixture.rows[0], id: uuidFor('new'), started_at: '2027-01-01T00:00:00+00:00' });
      }
    };
    await expectRefusal('count_mismatch');
  });

  it('a session that appears after the last page but before the closing count', async () => {
    const fixture = sessionsOf(REV, 1001);
    install(fixture);
    server.before = (req) => {
      if (req.head) server.db.central_needs_import_sessions.push({ ...fixture.rows[0], id: uuidFor('tail'), started_at: startedAt(0) });
    };
    await expectRefusal('count_mismatch');
  });

  it('a repeated page (a stale proxy answers page 2 with page 1)', async () => {
    install(sessionsOf(REV, 1001));
    let firstPage: Row[] | null = null;
    server.tamper = (_req, res, pageNo) => {
      if (pageNo === 1) firstPage = res.data;
      return pageNo === 2 ? { ...res, data: firstPage } : res;
    };
    await expectRefusal('duplicate');
  });

  it('a server that ignores the keyset bound (answers every page from the start)', async () => {
    install(sessionsOf(REV, 1001));
    server.honourOr = false;
    await expectRefusal('count_mismatch');
  });

  it('a row omitted at a page boundary', async () => {
    install(sessionsOf(REV, 1001));
    server.tamper = (_req, res, pageNo) => (pageNo === 2 && res.data ? { ...res, data: res.data.slice(1) } : res);
    // The omitted row is behind the next cursor: the next page's count no longer matches.
    await expectRefusal('count_mismatch');
  });

  it('rows out of order inside a page', async () => {
    install(sessionsOf(REV, 1001));
    server.tamper = (_req, res, pageNo) => {
      if (pageNo !== 2 || !res.data) return res;
      const data = [...res.data];
      [data[3], data[4]] = [data[4], data[3]];
      return { ...res, data };
    };
    await expectRefusal('out_of_order');
  });

  it('a page without an exact count', async () => {
    install(sessionsOf(REV, 10));
    server.tamper = (_req, res) => ({ ...res, count: null });
    await expectRefusal('count_unavailable');
  });

  it('a closing count that is unavailable', async () => {
    install(sessionsOf(REV, 1001));
    server.tamper = (req, res) => (req.head ? { ...res, count: null } : res);
    await expectRefusal('count_unavailable');
  });

  it('a page with more rows than its own count', async () => {
    install(sessionsOf(REV, 10));
    server.tamper = (_req, res) => ({ ...res, count: 3 });
    await expectRefusal('overlong_page');
  });

  it('an empty page while the count says sessions remain', async () => {
    install(sessionsOf(REV, 1001));
    server.tamper = (_req, res, pageNo) => (pageNo === 3 ? { ...res, data: [] } : res);
    await expectRefusal('count_mismatch');
  });

  it('a row of another revision', async () => {
    install(sessionsOf(REV, 1001));
    server.tamper = (_req, res, pageNo) => (pageNo === 2 && res.data
      ? { ...res, data: res.data.map((r, i) => (i === 10 ? { ...r, plan_revision_id: REV_B } : r)) }
      : res);
    await expectRefusal('foreign_revision');
  });

  it('a start time that is not an exact timestamptz text', async () => {
    install(sessionsOf(REV, 3));
    server.tamper = (_req, res) => (res.data ? { ...res, data: res.data.map((r, i) => (i === 1 ? { ...r, started_at: 'infinity' } : r)) } : res);
    await expectRefusal('unparsable_row');
  });

  it('a transport failure on a LATER page throws — the pages already read are never returned', async () => {
    install(sessionsOf(REV, 2001));
    server.fail = (_req, pageNo) => pageNo === 3;
    const error = await refusalOf(listImportSessions(REV));
    expect(error.businessCode).toBe('central_needs_request_failed');
    expect(sessionPages()).toHaveLength(3);
  });

  it('a failed closing count throws', async () => {
    install(sessionsOf(REV, 1001));
    server.fail = (req) => req.head;
    const error = await refusalOf(listImportSessions(REV));
    expect(error.businessCode).toBe('central_needs_request_failed');
  });
});

// ---------------------------------------------------------------------------
// Service: search hits beyond row 1000
// ---------------------------------------------------------------------------

describe('PRE3 N1 — Work Session search past row 1000', () => {
  it('an exact session UUID beyond row 1000 is a hit, and the complete list numbers it', async () => {
    const fixture = sessionsOf(REV, 2001);
    install(fixture, sessionsOf(REV_B, 50));
    const target = fixture.ordered[1499];
    for (const typed of [target, target.toUpperCase(), target.replace(/-/g, '')]) {
      expect(await searchWorkSessions(REV, typed)).toEqual({
        hits: [{ importSessionId: target, matchedOn: ['session_id'] }], truncated: false,
      });
    }
    const sessions = await listImportSessions(REV);
    expect(rankImportSessions(sessions).get(target)).toEqual({ ordinal: 1500, total: 2001 });
    // Revision-scoped: the same id searched in another revision is no hit.
    expect(await searchWorkSessions(REV_B, target)).toEqual({ hits: [], truncated: false });
  });

  it('a UUID prefix beyond row 1000 is a hit, and every hit is in the complete list', async () => {
    const fixture = sessionsOf(REV, 2001);
    install(fixture);
    const target = fixture.ordered[1800];
    const prefix = target.slice(0, 13); // 8 hex, a hyphen, 4 hex
    const result = await searchWorkSessions(REV, prefix);
    expect(result.hits.map((h) => h.importSessionId)).toContain(target);
    const ranks = rankImportSessions(await listImportSessions(REV));
    for (const hit of result.hits) {
      expect(hit.importSessionId.startsWith(prefix)).toBe(true);
      expect(ranks.has(hit.importSessionId)).toBe(true);
    }
    expect(ranks.get(target)?.ordinal).toBe(1801);
  });

  it('an entry-path match beyond row 1000 is found by the server, not by a first-N window', async () => {
    const fixture = sessionsOf(REV, 2001);
    install(fixture);
    const row = fixture.rows.find((r) => r.id === fixture.ordered[1990]) as Row;
    const result = await searchWorkSessions(REV, String(row.entry_path));
    expect(result.hits).toEqual([{ importSessionId: row.id, matchedOn: ['entry_path'] }]);
  });

  it('a bound above max_rows is reduced, so a cut is still reported (never silently capped)', async () => {
    install(sessionsOf(REV, 2001));
    const result = await searchWorkSessions(REV, 'many/', 5000);
    expect(result.truncated).toBe(true);
    expect(result.hits).toHaveLength(WORK_SESSION_SEARCH_MAX_LIMIT);
    for (const req of server.log) expect(req.limit).toBeLessThanOrEqual(MAX_ROWS_DEFAULT);
  });
});

// ---------------------------------------------------------------------------
// Screen: the selector over the complete, paged list
// ---------------------------------------------------------------------------

const REVISION: PlanRevision = { id: REV, planId: 'plan-1', organizationId: ORG, planYear: 2026, revisionNumber: 1, status: 'draft' };
const REVISION_B: PlanRevision = { ...REVISION, id: REV_B, planId: 'plan-2', planYear: 2025 };
const readinessOf = (rev: string) => ({ planRevisionId: rev, status: 'draft', ready: false, blockers: [] }) as unknown as ReviewReadiness;

/** 1001 sessions; the first, second and LAST (the 1001st) are completed, so selectable. */
function screenFixture(rev = REV, n = 1001) {
  return sessionsOf(rev, n, 7, () => 'processing');
}
function complete(fixture: SessionFixture, positions: number[]) {
  const wanted = new Set(positions.map((p) => fixture.ordered[p]));
  for (const row of fixture.rows) if (wanted.has(row.id as string)) row.status = 'completed';
}

function loadOthers() {
  listPlanRevisions.mockResolvedValue([REVISION]);
  listImportBatches.mockResolvedValue([]);
  listOverrides.mockResolvedValue([]);
  fetchReviewReadiness.mockImplementation(async (rev: string) => readinessOf(rev));
  listNeedLineLineage.mockResolvedValue({ needLines: [], sources: [] });
  listBeneficiaryColumns.mockResolvedValue([]);
  listBeneficiaryRegions.mockResolvedValue([]);
  listSourceRecords.mockResolvedValue([]);
  listDispositions.mockResolvedValue([]);
  searchBatchEntries.mockResolvedValue([]);
  getOrganizations.mockResolvedValue([] as OrgRow[]);
}

/*
 * DOM helpers. With 1001 sessions on screen, accessible-name queries over the
 * whole document (getByRole / getByLabelText) take tens of seconds in jsdom, so
 * these look elements up directly — by the same labels and roles.
 */
const notHidden = (el: Element) => el.closest('[hidden]') === null;
/** The ONE visible Work Session selector (the other stages that hold one are hidden). */
const selector = (): HTMLElement => {
  const visible = [...document.querySelectorAll<HTMLElement>('section.cn2b-work-session')].filter(notHidden);
  expect(visible).toHaveLength(1);
  expect(visible[0]).toHaveAttribute('aria-label', T.cn2b_work_session.en);
  return visible[0];
};
const searchBox = () => selector().querySelector('input[type="search"]') as HTMLInputElement;
const workSessionSelect = () => selector().querySelector('select') as HTMLSelectElement;
const optionTexts = () => [...selector().querySelectorAll('option')].map((o) => o.textContent ?? '');
const hitList = () => selector().querySelector(`ul[aria-label="${T.cn2b_work_session_search_results.en}"]`);
const hitButtons = () => [...(hitList()?.querySelectorAll('button') ?? [])];
const phase = () => (selector().querySelector('.cn2b-searchstate') as HTMLElement | null)?.dataset.phase ?? null;
const unlistedNote = () => selector().querySelector<HTMLElement>('[data-testid="cn2b-work-session-unlisted"]');
const ordinal = (k: number, n: number) => T.cn2b_work_session_ordinal.en.replace('__K__', String(k)).replace('__N__', String(n));
const revisionSelect = () => {
  const label = [...document.querySelectorAll('label.cn2b-field')]
    .find((l) => l.querySelector('.cn2b-field__label')?.textContent === T.cn2b_revision.en);
  return label?.querySelector('select') as HTMLSelectElement;
};
const workflowNav = () => document.querySelector(`nav[aria-label="${T.cn2b_workflow_label.en}"]`) as HTMLElement;

function openReviewStage() {
  const review = [...workflowNav().querySelectorAll('button')]
    .find((b) => new RegExp(T.cn2b_stage_review.en, 'i').test(b.textContent ?? ''));
  fireEvent.click(review as HTMLButtonElement);
}

async function openReview(firstSession: string) {
  render(<CentralNeedsScreen initialMode="advanced" />);
  await waitFor(() => expect(listSourceRecords).toHaveBeenCalledWith(firstSession), { timeout: 5000 });
  openReviewStage();
  await waitFor(() => expect(workSessionSelect()).toBeEnabled());
}

describe('PRE3 N1 — the screen numbers, lists and finds sessions past row 1000', () => {
  it('"Session K of N" counts all 1001 sessions; the 1001st is listed and selectable', async () => {
    loadOthers();
    const fixture = screenFixture();
    complete(fixture, [0, 1, 1000]);
    install(fixture);
    await openReview(fixture.ordered[0]);
    const options = optionTexts();
    expect(options).toHaveLength(3);
    expect(options[0]).toContain(ordinal(1, 1001));
    expect(options[1]).toContain(ordinal(2, 1001));
    expect(options[2]).toContain(ordinal(1001, 1001));
    expect(screen.getByText(`${T.cn2b_sessions_completed_of.en}: 3/1001`)).toBeInTheDocument();
  }, 30_000);

  it('an exact UUID of the 1001st session is a hit with its true number — never "no session matches"', async () => {
    loadOthers();
    const fixture = screenFixture();
    complete(fixture, [0, 1000]);
    install(fixture);
    await openReview(fixture.ordered[0]);
    fireEvent.change(searchBox(), { target: { value: fixture.ordered[1000].toUpperCase() } });
    await waitFor(() => expect(phase()).toBe('done'));
    expect(selector()).not.toHaveTextContent(T.cn2b_work_session_search_empty.en);
    expect(unlistedNote()).toBeNull();
    expect(hitButtons()).toHaveLength(1);
    expect(hitButtons()[0]).toHaveTextContent(ordinal(1001, 1001));
    expect(hitButtons()[0]).toHaveTextContent(T.cn2b_work_session_match_session_id.en);
    expect(hitButtons()[0]).toBeEnabled();
  }, 30_000);

  it('a UUID prefix beyond row 1000, and "#1001", find the same session', async () => {
    loadOthers();
    const fixture = screenFixture();
    complete(fixture, [0, 1000]);
    install(fixture);
    await openReview(fixture.ordered[0]);
    fireEvent.change(searchBox(), { target: { value: fixture.ordered[1000].slice(0, 13) } });
    await waitFor(() => expect(phase()).toBe('done'));
    expect(hitButtons().some((b) => b.textContent?.includes(ordinal(1001, 1001)))).toBe(true);
    fireEvent.change(searchBox(), { target: { value: '#1001' } });
    await waitFor(() => expect(phase()).toBe('done'));
    await waitFor(() => expect(hitButtons()).toHaveLength(1));
    expect(hitButtons()[0]).toHaveTextContent(ordinal(1001, 1001));
    expect(hitButtons()[0]).toHaveTextContent(T.cn2b_work_session_match_ordinal.en);
  }, 30_000);

  it('a hit for a session the loaded list does not hold is reported as an out-of-date list — never dropped, never "no match" — and Reload brings it in', async () => {
    loadOthers();
    const fixture = screenFixture(REV, 12);
    complete(fixture, [0, 11]);
    install(fixture);
    await openReview(fixture.ordered[0]);
    // An import that began after the list was read.
    const late = { ...fixture.rows[0], id: uuidFor('late-import'), status: 'completed', started_at: '2026-06-01T00:00:00+00:00', entry_path: 'late/arrival.xlsx' };
    server.db.central_needs_import_sessions.push(late);
    fireEvent.change(searchBox(), { target: { value: late.id } });
    await waitFor(() => expect(phase()).toBe('done'));
    expect(selector()).not.toHaveTextContent(T.cn2b_work_session_search_empty.en);
    const note = unlistedNote();
    expect(note).not.toBeNull();
    expect(note).toHaveAttribute('data-unlisted', '1');
    expect(note).toHaveTextContent(t('cn2b_work_session_search_unlisted', 'en').replace('__N__', '1'));
    expect(selector()).toHaveTextContent(`${T.cn2b_work_session_search_results.en}: 1`);
    expect(hitButtons()).toHaveLength(0);

    fireEvent.click(within(note as HTMLElement).getByRole('button', { name: t('cn2b_work_session_reload', 'en') }));
    await waitFor(() => expect(hitButtons()).toHaveLength(1));
    expect(unlistedNote()).toBeNull();
    expect(hitButtons()[0]).toHaveTextContent(ordinal(13, 13));
  }, 30_000);

  it('an enumeration that cannot be proven complete is a refusal on screen, and no session list or total is drawn', async () => {
    loadOthers();
    const fixture = screenFixture();
    complete(fixture, [0, 1000]);
    install(fixture);
    server.before = (_req, pageNo) => {
      if (pageNo === 2) server.db.central_needs_import_sessions.push({ ...fixture.rows[0], id: uuidFor('behind'), started_at: startedAt(0) });
    };
    render(<CentralNeedsScreen initialMode="advanced" />);
    const refusal = centralNeedsErrorText({ businessCode: 'import_sessions_read_inconsistent', details: 'reason=count_mismatch' }, 'en');
    await waitFor(() => expect(screen.getByText(refusal)).toBeInTheDocument(), { timeout: 5000 });
    expect(screen.queryByText(new RegExp(`${T.cn2b_sessions_completed_of.en}: `))).toBeNull();
    expect(document.body.textContent ?? '').not.toMatch(/Session \d+ of \d+/);
    expect(listSourceRecords).not.toHaveBeenCalled();
  }, 30_000);

  it('a transport failure on a later page is a refusal on screen, never a partial list', async () => {
    loadOthers();
    const fixture = screenFixture();
    complete(fixture, [0, 1000]);
    install(fixture);
    server.fail = (_req, pageNo) => pageNo === 2;
    render(<CentralNeedsScreen initialMode="advanced" />);
    const refusal = centralNeedsErrorText(new CentralNeedsError('central_needs_request_failed', 'TypeError: fetch failed'), 'en');
    await waitFor(() => expect(screen.getByText(refusal)).toBeInTheDocument(), { timeout: 5000 });
    expect(document.body.textContent ?? '').not.toMatch(/Session \d+ of \d+/);
    expect(listSourceRecords).not.toHaveBeenCalled();
  }, 30_000);

  it('a revision switch while the previous revision is still paging never shows the previous revision\'s sessions', async () => {
    loadOthers();
    listPlanRevisions.mockResolvedValue([REVISION, REVISION_B]);
    const a = screenFixture(REV, 1001);
    complete(a, [0, 1000]);
    const b = screenFixture(REV_B, 4);
    complete(b, [2]);
    install(a, b);
    await openReview(a.ordered[0]);
    expect(optionTexts()[1]).toContain(ordinal(1001, 1001));

    // Hold revision A's keyset pages (page 2 on) open; re-read A, and switch to B meanwhile.
    let releaseA!: () => void;
    const held = new Promise<void>((resolve) => { releaseA = resolve; });
    const scopedToA = (req: FakeRequest) => req.ops.some((op) => op[0] === 'eq' && op[1] === 'plan_revision_id' && op[2] === REV);
    const keysetPage = (req: FakeRequest) => req.ops.some((op) => op[0] === 'or');
    server.before = (req) => (scopedToA(req) && keysetPage(req) ? held : undefined);
    const logBefore = server.log.length;
    fireEvent.change(revisionSelect(), { target: { value: REV_B } });
    fireEvent.change(revisionSelect(), { target: { value: REV } });
    fireEvent.change(revisionSelect(), { target: { value: REV_B } });
    await waitFor(() => expect(listSourceRecords).toHaveBeenCalledWith(b.ordered[2]), { timeout: 5000 });
    // A's enumeration really is mid-way: its page 1 answered, its page 2 is held open.
    expect(server.log.slice(logBefore).some((r) => scopedToA(r) && keysetPage(r))).toBe(true);
    openReviewStage();
    await waitFor(() => expect(optionTexts()).toEqual([expect.stringContaining(ordinal(3, 4))]));

    releaseA();
    // A's read now completes (its closing count is requested) — and must change nothing.
    await waitFor(() => expect(server.log.slice(logBefore).some((r) => scopedToA(r) && r.head)).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(optionTexts()).toEqual([expect.stringContaining(ordinal(3, 4))]);
    expect(document.body.textContent ?? '').not.toContain('of 1001');
    expect(screen.getByText(`${T.cn2b_sessions_completed_of.en}: 1/4`)).toBeInTheDocument();
  }, 30_000);
});
