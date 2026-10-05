/**
 * PRE3 Run 4 — the canonical resolver's EXACT-CANDIDATE mode.
 *
 * A one-click material suggestion is legitimate only when exactly ONE active
 * registered item carries a row's text exactly. These tests prove the two
 * halves that claim rests on:
 *
 *   SUPERSET     the server-side terms return EVERY active item the client rule
 *                (normalizeSearchText equality on name / name_ar / trade_name,
 *                or the national code verbatim) could call exact — proven
 *                exhaustively over the mirrored alphabet and by fuzzing with
 *                characters outside it;
 *   COMPLETENESS the set counts as complete only when every request's exact
 *                count is within the cap and equals the rows received, and every
 *                row is active. Truncation, a missing count, a capped server
 *                window, an inactive row, an over-long query, an unconfigured
 *                client and a failure all prove nothing.
 *
 * The `match` terms are evaluated here with JavaScript RegExp (non-unicode
 * mode), which reads the emitted ARE subset — literals, `\` before an ASCII
 * non-alphanumeric, bracket expressions with ranges, `*`, `^`, `$` — the way
 * PostgreSQL does for BMP text; the real PostgreSQL 18 + PostgREST v16.4 runs
 * are recorded separately (Agent C, run 4 evidence).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeSearchText } from '@/shared/lib/search-normalize';

type Row = Record<string, unknown>;

/** Characters by code point — invisible and look-alike characters are never written literally here. */
const U = (...cps: number[]): string => String.fromCodePoint(...cps);
const NBSP = U(0xa0);
const BOM = U(0xfeff);
const LSEP = U(0x2028);
const FATHA = U(0x064e);
const SHADDA = U(0x0651);
const TATWEEL = U(0x0640);
const DAGGER_ALIF = U(0x0670);
const HAMZA_ABOVE = U(0x0654);

// ── An in-memory PostgREST stand-in: FILTER → ORDER → LIMIT like the server,
//    `count=exact` over the filtered set, optional db-max-rows, recorded ops. ──
const db: { central_items: Row[] } = { central_items: [] };
const recorded: Array<{ table: string; ops: Array<[string, ...unknown[]]> }> = [];
const state = { maxRows: null as number | null, failWith: null as null | { message: string; code: string }, dropCount: false };

function splitOr(expr: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < expr.length; i += 1) {
    const ch = expr[i];
    if (quoted && ch === '\\') { current += ch + expr[i + 1]; i += 1; continue; }
    if (ch === '"') quoted = !quoted;
    if (ch === ',' && !quoted) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  parts.push(current);
  return parts;
}
const unquote = (v: string) => (v.startsWith('"') ? v.slice(1, -1).replace(/\\(.)/gs, '$1') : v);
function orCondition(part: string): (row: Row) => boolean {
  const m = /^([a-z_]+)\.(match)\.(.*)$/s.exec(part);
  if (!m) throw new Error(`unsupported or() term: ${part}`);
  const re = new RegExp(unquote(m[3]));
  return (row) => typeof row[m[1]] === 'string' && re.test(row[m[1]] as string);
}

class FakeQuery implements PromiseLike<{ data: Row[] | null; error: unknown; count: number | null }> {
  private filters: Array<(row: Row) => boolean> = [];
  private orders: string[] = [];
  private max: number | null = null;
  private wantCount = false;
  private readonly rec: { table: string; ops: Array<[string, ...unknown[]]> };
  constructor(private readonly table: string) { this.rec = { table, ops: [] }; recorded.push(this.rec); }
  select(cols: string, opts?: { count?: string }) { this.rec.ops.push(['select', cols, opts?.count ?? null]); this.wantCount = opts?.count === 'exact'; return this; }
  eq(col: string, value: unknown) { this.rec.ops.push(['eq', col, value]); this.filters.push((r) => String(r[col]) === String(value)); return this; }
  or(expr: string) {
    this.rec.ops.push(['or', expr]);
    const conds = splitOr(expr).map(orCondition);
    this.filters.push((r) => conds.some((c) => c(r)));
    return this;
  }
  order(col: string) { this.rec.ops.push(['order', col]); this.orders.push(col); return this; }
  limit(n: number) { this.rec.ops.push(['limit', n]); this.max = n; return this; }
  abortSignal() { return this; }
  private resolve() {
    if (state.failWith) return { data: null, error: state.failWith, count: null };
    let rows = db.central_items.filter((r) => this.filters.every((f) => f(r)));
    const count = rows.length;
    rows = [...rows].sort((a, b) => {
      for (const col of this.orders) if (a[col] !== b[col]) return String(a[col]) < String(b[col]) ? -1 : 1;
      return 0;
    });
    if (this.max !== null) rows = rows.slice(0, this.max);
    if (state.maxRows !== null) rows = rows.slice(0, state.maxRows);
    return { data: rows, error: null, count: this.wantCount && !state.dropCount ? count : null };
  }
  then<A = { data: Row[] | null; error: unknown; count: number | null }, B = never>(
    ok?: ((v: { data: Row[] | null; error: unknown; count: number | null }) => A | PromiseLike<A>) | null,
    ko?: ((r: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve(this.resolve()).then(ok, ko);
  }
}

const configured = { value: true };
vi.mock('@/shared/supabase/client', () => ({
  supabase: { from: (table: string) => new FakeQuery(table) },
  get supabaseConfigured() { return configured.value; },
}));

const {
  EXACT_CANDIDATE_CAP,
  EXACT_MIRRORED_RANGES,
  EXACT_REQUEST_MAX_OR_BYTES,
  exactCodePattern,
  exactNamePattern,
  exactStrayDroppedPattern,
  exactUnmirroredPattern,
  planExactCatalogCandidates,
  resolveExactCatalogCandidates,
} = await import('../material-resolver.service');

function reset() {
  db.central_items = [];
  recorded.length = 0;
  state.maxRows = null;
  state.failWith = null;
  state.dropCount = false;
  configured.value = true;
}
beforeEach(reset);
afterEach(reset);

// ── The client exactness rule, over a raw catalog row (centralItemExactlyNames' fields). ──
function clientExact(row: Row, text: string): boolean {
  const raw = text.trim();
  const norm = normalizeSearchText(raw);
  if (norm === '') return false;
  for (const col of ['name', 'name_ar', 'trade_name']) {
    const v = row[col];
    if (typeof v === 'string' && normalizeSearchText(v) === norm) return true;
  }
  const code = typeof row.barcode === 'string' ? row.barcode.trim() : '';
  return code !== '' && code === raw;
}

/** Rows the planned terms select (status ignored here — this is the superset predicate alone). */
function plannedSelect(rows: Row[], text: string): Set<unknown> {
  const plan = planExactCatalogCandidates(text);
  const hit = new Set<unknown>();
  for (const req of plan.requests) {
    const conds = splitOr(req.terms.join(',')).map(orCondition);
    for (const r of rows) if (conds.some((c) => c(r))) hit.add(r.id);
  }
  return hit;
}

const mirrored: string[] = EXACT_MIRRORED_RANGES.flatMap(([lo, hi]) =>
  Array.from({ length: hi - lo + 1 }, (_, i) => String.fromCodePoint(lo + i)));
const image = (ch: string) => normalizeSearchText(`0${ch}0`).slice(1, -1);

/** Deterministic PRNG (mulberry32). */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const item = (id: string, over: Row = {}): Row => ({
  id, name: `zz ${id}`, name_ar: null, trade_name: null, barcode: null, unit: 'tablet',
  concentration: null, dosage_form: null, status: 'active', ...over,
});

describe('the mirrored alphabet is exactly what the server can mirror', () => {
  it('every mirrored character normalizes on its own to at most ONE character', () => {
    const bad = mirrored.filter((ch) => Array.from(image(ch)).length > 1);
    expect(bad).toEqual([]);
    expect(mirrored.length).toBeGreaterThan(500);
  });

  it('normalization is per-character on the alphabet: every ordered pair normalizes to the two images side by side', () => {
    const imageOf = new Map(mirrored.map((ch) => [ch, image(ch)]));
    const failures: string[] = [];
    for (const a of mirrored) {
      for (const b of mirrored) {
        const got = normalizeSearchText(`0${a}${b}0`).slice(1, -1);
        if (got !== (imageOf.get(a) as string) + (imageOf.get(b) as string)) failures.push(`${a.codePointAt(0)}+${b.codePointAt(0)}`);
        if (failures.length > 5) break;
      }
    }
    expect(failures).toEqual([]);
  });

  it('the characters normalization cannot reproduce on the server are OUTSIDE it', () => {
    const outside = [
      U(0xfe8d), U(0xfefb), U(0xfdf2), // presentation forms / ligatures (alef isolated, lam-alef, Allah)
      U(0x0653), U(0x0654), U(0x0655), U(0x0301), // composing marks (decomposed madda/hamza, NFD Latin acute)
      U(0xff21), U(0x212a), U(0x2122), U(0x338e), U(0xaa), U(0xb2), // fullwidth A, Kelvin, trade mark, mg square, ordinal a, superscript 2
      U(0x2002), U(0x202f), U(0x3000), // exotic spaces (NFKC -> space)
      U(0x03a3), U(0x0130), U(0x0675), // capital sigma, dotted capital I, high-hamza alef
      U(0x1f600), // outside the BMP
    ];
    const set = new Set(mirrored);
    for (const ch of outside) expect(set.has(ch), `U+${ch.codePointAt(0)?.toString(16)}`).toBe(false);
    const unmir = new RegExp(exactUnmirroredPattern());
    for (const ch of outside) expect(unmir.test(`abc${ch}`), `U+${ch.codePointAt(0)?.toString(16)}`).toBe(true);
    for (const ch of mirrored) if (unmir.test(ch)) throw new Error(`UNMIR matches mirrored U+${ch.codePointAt(0)?.toString(16)}`);
  });
});

describe('SUPERSET — the planned terms select every row the client rule calls exact', () => {
  it('property: any text over the alphabet is selected for its own normalized form (R(q) or the stray-mark term)', () => {
    const rnd = prng(20261005);
    // Weighted pool: real-looking Arabic/Latin, variants, marks, spaces, plus the full alphabet.
    const pool = [...'باراسيتامول إيبوبروفين أموكسيسيلين ParacetamolIBUPROFEN 500mg', FATHA, SHADDA, TATWEEL, DAGGER_ALIF,
      NBSP, BOM, LSEP, '\t', 'ة', 'ى', 'ئ', 'ؤ', 'آ', 'ٱ', U(0xb5), U(0x039c), U(0xc9), ...mirrored];
    const r = new RegExp(exactStrayDroppedPattern());
    let checked = 0;
    for (let i = 0; i < 4000; i += 1) {
      const len = 1 + Math.floor(rnd() * 14);
      let s = '';
      for (let j = 0; j < len; j += 1) s += pool[Math.floor(rnd() * pool.length)];
      const q = normalizeSearchText(s);
      if (q.length < 2) continue;
      checked += 1;
      const pattern = exactNamePattern(q);
      expect(pattern, JSON.stringify(s)).not.toBeNull();
      const selected = new RegExp(pattern as string).test(s) || r.test(s);
      expect(selected, JSON.stringify({ s, q, pattern })).toBe(true);
    }
    expect(checked).toBeGreaterThan(3000);
  });

  it('fuzz: a catalog mixing mirrored and unmirrored spellings — every client-exact row is selected', () => {
    const rnd = prng(424242);
    const bases = ['باراسيتامول', 'ايبوبروفين', 'اموكسيسيلين 500 ملغ', 'Paracetamol 500 mg', 'Amoxil', 'سيفترياكسون ١ غرام', `${U(0xb5)}g 50`, 'Crème'];
    const isArabicBlock = (ch: string) => (ch.codePointAt(0) as number) >= 0x0600 && (ch.codePointAt(0) as number) <= 0x06ff;
    const decorate = (s: string): string => {
      let out = '';
      for (const ch of s) {
        let c = ch;
        const roll = rnd();
        // alef: hamza seats, wasla, presentation form, decomposed hamza (alef + U+0654)
        if (ch === 'ا' && roll < 0.3) c = ['أ', 'إ', 'آ', 'ٱ', U(0xfe8d), `ا${HAMZA_ABOVE}`][Math.floor(rnd() * 6)];
        // yeh: alef maqsura, yeh-hamza, presentation form, decomposed (yeh + U+0654)
        else if (ch === 'ي' && roll < 0.3) c = ['ى', 'ئ', U(0xfef1), `ي${HAMZA_ABOVE}`][Math.floor(rnd() * 4)];
        else if (ch === 'ه' && roll < 0.2) c = 'ة';
        else if (ch === ' ' && roll < 0.3) c = [NBSP, U(0x2002), U(0x3000)][Math.floor(rnd() * 3)];
        else if (/[a-z]/.test(ch) && roll < 0.3) c = rnd() < 0.7 ? ch.toUpperCase() : U(0xff21 + ch.charCodeAt(0) - 97);
        out += c;
        if (isArabicBlock(ch) && rnd() < 0.15) out += [FATHA, SHADDA, TATWEEL, DAGGER_ALIF][Math.floor(rnd() * 4)];
        if (/[A-Za-z]/.test(ch) && rnd() < 0.03) out += FATHA; // a stray mark after a Latin letter
      }
      const edge = ['', ' ', NBSP, BOM, '\t', FATHA];
      return edge[Math.floor(rnd() * edge.length)] + out + edge[Math.floor(rnd() * edge.length)];
    };
    const rows: Row[] = [];
    for (let i = 0; i < 1500; i += 1) {
      const base = bases[Math.floor(rnd() * bases.length)];
      const col = ['name', 'name_ar', 'trade_name'][Math.floor(rnd() * 3)];
      rows.push(item(`r${i}`, { [col]: decorate(rnd() < 0.15 ? `${base} x` : base) }));
    }
    let exactTotal = 0;
    for (const base of bases) {
      const oracle = rows.filter((r) => clientExact(r, base)).map((r) => r.id);
      const selected = plannedSelect(rows, base);
      exactTotal += oracle.length;
      for (const id of oracle) expect(selected.has(id), `${base}: ${id} ${JSON.stringify(rows.find((r) => r.id === id))}`).toBe(true);
    }
    expect(exactTotal).toBeGreaterThan(300);
  });

  it('both Arabic directions, harakat, tatweel, case, NBSP and surrounding whitespace are matched by R(q) itself', () => {
    const cases: Array<[string, string]> = [
      ['ايبوبروفين', 'إيبوبروفين'], ['إيبوبروفين', 'ايبوبروفين'], ['أموكسيسيلين', 'إموكسيسيلين'],
      ['باراسيتامول', `ب${FATHA}ار${FATHA}اس${U(0x0650)}يت${FATHA}ام${U(0x064f)}ول`], ['باراسيتامول', `باراسي${TATWEEL}${TATWEEL}${TATWEEL}تامول`],
      ['مضاد حيوية', 'مضاد حيويه'], ['مستشفى', 'مستشفي'],
      ['Paracetamol 500 mg', 'PARACETAMOL 500 MG'], ['Paracetamol 500 mg', `Paracetamol${NBSP}500${NBSP}mg`],
      ['Paracetamol', '  Paracetamol\t'], ['Paracetamol', `${BOM}Paracetamol${LSEP}`], ['الكلور', 'ٱلكلور'],
      [`${U(0xb5)}g`, `${U(0x03bc)}g`], [U(0x03b1, 0x03b2), U(0x0391, 0x0392)], ['crème', 'CRÈME'],
    ];
    for (const [query, stored] of cases) {
      const q = normalizeSearchText(query);
      expect(normalizeSearchText(stored), `${query} ~ ${stored}`).toBe(q);
      expect(new RegExp(exactNamePattern(q) as string).test(stored), `${query} -> ${stored}`).toBe(true);
    }
  });

  it('R(q) is anchored: a longer, shorter or different name is not selected by it', () => {
    const r = new RegExp(exactNamePattern(normalizeSearchText('باراسيتامول')) as string);
    for (const stored of ['باراسيتامول 500', 'كودائين باراسيتامول', 'باراسيتامو', 'Paracetamol']) expect(r.test(stored), stored).toBe(false);
    const p = new RegExp(exactNamePattern('paracetamol') as string);
    for (const stored of ['Paracetamol 500 mg', 'Paracetamol + Codeine', 'Paracetamo']) expect(p.test(stored), stored).toBe(false);
  });

  it('a query whose characters no mirrored text can produce gets no R(q) — the UNMIR term alone covers it', () => {
    expect(exactNamePattern(`mg${U(0xffff)}`)).toBeNull();
    const TM = U(0x2122);
    const plan = planExactCatalogCandidates(`Panadol${TM}`);
    // The trade-mark sign normalizes to "tm": mirrored characters CAN produce that, so R(q) exists…
    expect(plan.requests[0].terms.some((t) => t.startsWith('name.match."^'))).toBe(true);
    // …and a stored trade-mark sign is caught by UNMIR, so either spelling is selected.
    const rows = [item('a', { name: `Panadol${TM}` }), item('b', { name: 'PANADOLTM' })];
    expect([...plannedSelect(rows, `Panadol${TM}`)].sort()).toEqual(['a', 'b']);
  });

  it('the national code is matched verbatim, trimmed as the client trims it, and nothing looser', () => {
    const r = new RegExp(exactCodePattern('6291000000028') as string);
    for (const stored of ['6291000000028', ' 6291000000028 ', `${NBSP}6291000000028${U(0x3000)}`, `${BOM}6291000000028`]) expect(r.test(stored), stored).toBe(true);
    for (const stored of ['62910000000289', '6291000000028x', '06291000000028', '6291 000000028']) expect(r.test(stored), stored).toBe(false);
    expect(exactCodePattern(`a${U(0)}b`)).toBeNull();
    expect(exactCodePattern(`a${String.fromCharCode(0xd800)}b`)).toBeNull();
  });

  it('every ASCII character is literal-safe in R(q) and the code term (no breakout, no wildcard)', () => {
    for (let cp = 0x21; cp <= 0x7e; cp += 1) {
      const ch = String.fromCodePoint(cp);
      const text = `a${ch}b${ch}`;
      const code = new RegExp(exactCodePattern(text) as string);
      expect(code.test(text), ch).toBe(true);
      expect(code.test(`a${ch === 'x' ? 'y' : 'x'}b${ch}`), ch).toBe(false);
      const q = normalizeSearchText(text);
      const name = new RegExp(exactNamePattern(q) as string);
      expect(name.test(text), ch).toBe(true);
    }
  });
});

describe('COMPLETENESS — the requests and what counts as proven', () => {
  it('asks four ACTIVE-only, exact-counted, capped requests: one per name column and one for the national code', async () => {
    db.central_items = [item('ci-para', { name: 'Paracetamol', barcode: '6291000000028' })];
    const res = await resolveExactCatalogCandidates('Paracetamol');
    expect(res.complete).toBe(true);
    expect(recorded).toHaveLength(4);
    for (const q of recorded) {
      expect(q.table).toBe('central_items');
      expect(q.ops[0]).toEqual(['select', 'id, name, name_ar, barcode, unit, status, trade_name, concentration, dosage_form', 'exact']);
      expect(q.ops).toContainEqual(['eq', 'status', 'active']);
      expect(q.ops).toContainEqual(['limit', EXACT_CANDIDATE_CAP + 1]);
      expect(q.ops.filter((o) => o[0] === 'order').map((o) => o[1])).toEqual(['name', 'id']);
    }
    const targets = recorded.map((q) => (q.ops.find((o) => o[0] === 'or')?.[1] as string).match(/^([a-z_]+)\.match\./)?.[1]);
    expect(targets).toEqual(['name', 'name_ar', 'trade_name', 'barcode']);
    for (const q of recorded.slice(0, 3)) {
      const or = q.ops.find((o) => o[0] === 'or')?.[1] as string;
      expect(splitOr(or)).toHaveLength(3); // R(q), STRAY, UNMIR
    }
  });

  it('every exact twin is returned whatever its alphabetical place — the window is never the point', async () => {
    const partials = Array.from({ length: 40 }, (_, i) => item(`p${String(i).padStart(2, '0')}`, { name: `Paracetamol + Codeine ${i}` }));
    db.central_items = [
      ...partials,
      item('a-first', { name: 'Paracetamol', concentration: '500 mg' }),
      item('z-last', { name: 'Ω-late', name_ar: 'باراسيتامول', trade_name: 'Paracetamol' }),
    ];
    const res = await resolveExactCatalogCandidates('paracetamol');
    expect(res.complete).toBe(true);
    expect(res.items.map((m) => m.centralItemId).sort()).toEqual(['a-first', 'z-last']);
  });

  it('more than CAP rows is TRUNCATED: not complete, whatever the rows received say', async () => {
    db.central_items = [
      item('exact', { name: 'Paracetamol' }),
      // unmirrored rows (an alef presentation form): fetched whatever they say
      ...Array.from({ length: EXACT_CANDIDATE_CAP + 1 }, (_, i) => item(`u${i}`, { name_ar: `${U(0xfe8d)}${i}` })),
    ];
    const res = await resolveExactCatalogCandidates('Paracetamol');
    expect(res.complete).toBe(false);
    expect(res.incompleteReason).toBe('truncated');
  });

  it('exactly CAP rows is still complete', async () => {
    db.central_items = [
      item('exact', { name: 'Paracetamol' }),
      // unmirrored rows (a fullwidth A)
      ...Array.from({ length: EXACT_CANDIDATE_CAP - 1 }, (_, i) => item(`u${i}`, { name: `x${U(0xff21)}${i}` })),
    ];
    const res = await resolveExactCatalogCandidates('Paracetamol');
    expect(res.complete).toBe(true);
  });

  it('a server that caps rows below the count (db-max-rows) is not complete', async () => {
    db.central_items = [item('a', { name: 'Paracetamol' }), item('b', { name: 'PARACETAMOL' }), item('c', { name: 'paracetamol' })];
    state.maxRows = 2;
    const res = await resolveExactCatalogCandidates('Paracetamol');
    expect(res.complete).toBe(false);
    expect(res.incompleteReason).toBe('truncated');
  });

  it('a reply without an exact count proves nothing', async () => {
    db.central_items = [item('a', { name: 'Paracetamol' })];
    state.dropCount = true;
    const res = await resolveExactCatalogCandidates('Paracetamol');
    expect(res.complete).toBe(false);
    expect(res.incompleteReason).toBe('count_unavailable');
  });

  it('an inactive row in a reply means the active filter was not applied: not complete', async () => {
    db.central_items = [item('a', { name: 'Paracetamol' }), item('b', { name: 'Paracetamol', status: 'discontinued' })];
    const first = await resolveExactCatalogCandidates('Paracetamol');
    expect(first.complete).toBe(true);
    expect(first.items.map((m) => m.centralItemId)).toEqual(['a']);
    // A server ignoring the status filter returns the inactive twin.
    db.central_items = [item('a', { name: 'Paracetamol' })];
    const leaked = { ...item('b', { name: 'Paracetamol', status: 'discontinued' }) };
    const original = FakeQuery.prototype.eq;
    FakeQuery.prototype.eq = function eq(this: FakeQuery, col: string, value: unknown) { return col === 'status' ? this : original.call(this, col, value); };
    db.central_items.push(leaked);
    try {
      const res = await resolveExactCatalogCandidates('Paracetamol');
      expect(res.complete).toBe(false);
      expect(res.incompleteReason).toBe('inactive_row_returned');
    } finally {
      FakeQuery.prototype.eq = original;
    }
  });

  it('an over-long text sends nothing and proves nothing', async () => {
    const long = `ب${FATHA}`.repeat(400);
    const plan = planExactCatalogCandidates(long);
    expect(plan.unprovable).toBe('query_too_long');
    expect(Math.max(...plan.requests.map((r) => r.encodedBytes))).toBeGreaterThan(EXACT_REQUEST_MAX_OR_BYTES);
    const res = await resolveExactCatalogCandidates(long);
    expect(res).toEqual({ items: [], complete: false, incompleteReason: 'query_too_long' });
    expect(recorded).toHaveLength(0);
  });

  it('typical names fit the request budget: a 40-character Arabic name and an 80-character Latin one', () => {
    const ar = planExactCatalogCandidates('اموكسيسيلين مع حامض الكلافيولانيك 625 ملغ');
    expect(ar.unprovable).toBeNull();
    const en = planExactCatalogCandidates('Amoxicillin + Clavulanic Acid 625 mg film-coated tablets (blister of 14)');
    expect(en.unprovable).toBeNull();
  });

  it('too short, unconfigured or failed is never "complete"', async () => {
    expect(await resolveExactCatalogCandidates('p')).toEqual({ items: [], complete: false, incompleteReason: 'not_searchable' });
    configured.value = false;
    expect(await resolveExactCatalogCandidates('Paracetamol')).toEqual({ items: [], complete: false, incompleteReason: 'not_configured' });
    configured.value = true;
    state.failWith = { message: 'boom', code: 'XX000' };
    await expect(resolveExactCatalogCandidates('Paracetamol')).rejects.toMatchObject({ code: 'XX000' });
  });

  it('returns catalog results through the same mapping as the search (active, discriminators, national code)', async () => {
    db.central_items = [item('ci-amox', { name: 'Amoxicillin', name_ar: 'أموكسيسيلين', trade_name: 'Amoxil', concentration: '500 mg', dosage_form: 'Capsule', barcode: ' 6291000000011 ', unit: 'capsule' })];
    const [m] = (await resolveExactCatalogCandidates('Amoxil')).items;
    expect(m).toMatchObject({
      source: 'catalog', centralItemId: 'ci-amox', scientificName: 'Amoxicillin', nameAr: 'أموكسيسيلين', tradeName: 'Amoxil',
      concentration: '500 mg', dosageForm: 'Capsule', nationalCode: '6291000000011', unit: 'capsule',
    });
    expect(m.canonical.eligibility).toMatchObject({ active: true, selectable: true });
  });
});
