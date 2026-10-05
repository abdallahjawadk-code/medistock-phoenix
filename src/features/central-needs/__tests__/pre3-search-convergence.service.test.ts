/**
 * PRE3-A + PRE3-B — the two searches the Annual Needs screen depends on,
 * exercised through the REAL service and the REAL shared material resolver
 * against an in-memory PostgREST stand-in.
 *
 * The stand-in is deliberately strict about the one property the old code got
 * wrong: like PostgREST, it applies every filter FIRST, then the order, then
 * the limit — whatever order the builder methods were called in. A service
 * that fetches "the first N rows" and filters them in the browser therefore
 * misses whatever lies past the cut, exactly as it did against the real server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Row = Record<string, unknown>;

interface Recorded { table: string; ops: Array<[string, ...unknown[]]> }

const db: Record<string, Row[]> = {};
const recorded: Recorded[] = [];
const failing = new Set<string>();
/** Simulates a server that ignores the status filter, to prove the client-side eligibility check. */
let ignoreStatusFilter = false;

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

/** Split a PostgREST logic tree on top-level commas, honouring "quoted" values. */
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

function unquote(value: string): string {
  if (!value.startsWith('"')) return value;
  return value.slice(1, -1).replace(/\\(.)/g, '$1');
}

/**
 * PostgREST `imatch` = PostgreSQL `~*`. Only the ARE subset the resolver emits
 * is accepted — literal characters, `[...]` classes, `*`, and a backslash before
 * an ASCII non-alphanumeric — which JavaScript (non-unicode mode, `i`) reads the
 * same way PostgreSQL does. Anything else throws, so this stand-in can never
 * quietly accept a pattern the real server would read differently.
 */
const IMATCH_SUBSET = /^(?:\\[\x20-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E]|\[[^\]\\]+\]|\*|[^\\[\]*.+?(){}|^$])*$/;
function imatchCondition(col: string, pattern: string): (row: Row) => boolean {
  if (!IMATCH_SUBSET.test(pattern)) throw new Error(`unsupported imatch pattern: ${pattern}`);
  const re = new RegExp(pattern, 'i');
  return (row) => typeof row[col] === 'string' && re.test(row[col] as string);
}

function orCondition(part: string): (row: Row) => boolean {
  const m = /^([a-z_]+)\.(eq|ilike|imatch)\.(.*)$/s.exec(part);
  if (!m) throw new Error(`unsupported or() term: ${part}`);
  const [, col, op, raw] = m;
  if (op === 'eq') {
    const v = unquote(raw);
    return (row) => row[col] !== null && row[col] !== undefined && String(row[col]) === v;
  }
  // A quoted logic-tree value: PostgREST reads `\x` as `x`.
  if (op === 'imatch') return imatchCondition(col, unquote(raw));
  // Inside a quoted logic-tree value the LIKE escape survives as `\\` → `\`.
  const pattern = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(["\\])/g, '$1') : raw;
  return (row) => ilikeMatches(row[col], pattern);
}

class FakeQuery implements PromiseLike<{ data: Row[] | null; error: unknown }> {
  private filters: Array<(row: Row) => boolean> = [];
  private orders: Array<{ col: string; ascending: boolean }> = [];
  private max: number | null = null;
  private embedBatches = false;
  private readonly rec: Recorded;

  constructor(private readonly table: string) {
    this.rec = { table, ops: [] };
    recorded.push(this.rec);
  }

  select(cols: string) { this.rec.ops.push(['select', cols]); this.embedBatches = cols.includes('central_needs_import_batches('); return this; }
  eq(col: string, value: unknown) {
    this.rec.ops.push(['eq', col, value]);
    if (!(ignoreStatusFilter && col === 'status')) this.filters.push((row) => String(row[col]) === String(value));
    return this;
  }
  ilike(col: string, pattern: string) { this.rec.ops.push(['ilike', col, pattern]); this.filters.push((row) => ilikeMatches(row[col], pattern)); return this; }
  gte(col: string, value: string) { this.rec.ops.push(['gte', col, value]); this.filters.push((row) => String(row[col]) >= value); return this; }
  lte(col: string, value: string) { this.rec.ops.push(['lte', col, value]); this.filters.push((row) => String(row[col]) <= value); return this; }
  in(col: string, values: unknown[]) { this.rec.ops.push(['in', col, values]); this.filters.push((row) => values.includes(row[col])); return this; }
  or(expr: string) {
    this.rec.ops.push(['or', expr]);
    const conditions = splitOr(expr).map(orCondition);
    this.filters.push((row) => conditions.some((c) => c(row)));
    return this;
  }
  order(col: string, opts: { ascending: boolean }) { this.rec.ops.push(['order', col]); this.orders.push({ col, ascending: opts.ascending }); return this; }
  limit(n: number) { this.rec.ops.push(['limit', n]); this.max = n; return this; }
  abortSignal() { return this; }

  private resolve(): { data: Row[] | null; error: unknown } {
    if (failing.has(this.table)) return { data: null, error: { message: 'boom', code: 'XX000' } };
    // FILTER → ORDER → LIMIT, as the server does, regardless of call order.
    let rows = (db[this.table] ?? []).filter((row) => this.filters.every((f) => f(row)));
    rows = [...rows].sort((a, b) => {
      for (const o of this.orders) {
        const av = a[o.col] as string | number;
        const bv = b[o.col] as string | number;
        if (av === bv) continue;
        return (av < bv ? -1 : 1) * (o.ascending ? 1 : -1);
      }
      return 0;
    });
    if (this.max !== null) rows = rows.slice(0, this.max);
    if (this.embedBatches) {
      rows = rows.map((row) => ({
        ...row,
        central_needs_import_batches: (db.central_needs_import_batches ?? []).find((b) => b.id === row.batch_id) ?? null,
      }));
    }
    return { data: rows, error: null };
  }

  then<A = { data: Row[] | null; error: unknown }, B = never>(
    onfulfilled?: ((value: { data: Row[] | null; error: unknown }) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve(this.resolve()).then(onfulfilled, onrejected);
  }
}

vi.mock('@/shared/supabase/client', () => ({
  supabase: { from: (table: string) => new FakeQuery(table) },
  supabaseConfigured: true,
}));

const service = await import('../central-needs.service');
const {
  CentralNeedsError,
  centralItemDiscriminators,
  centralItemExactlyNames,
  centralItemQueryIsSearchable,
  parseSessionOrdinal,
  rankImportSessions,
  searchBatchEntries,
  searchCentralItems,
  searchWorkSessions,
  sessionIdRange,
} = service;

const ROOT = join(__dirname, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

function reset() {
  for (const key of Object.keys(db)) delete db[key];
  recorded.length = 0;
  failing.clear();
  ignoreStatusFilter = false;
}
beforeEach(reset);
afterEach(reset);

const queriesOn = (table: string) => recorded.filter((r) => r.table === table);

// =============================================================================
// PRE3-A — material resolution convergence
// =============================================================================

const CATALOG: Row[] = [
  { id: 'ci-amox-500', name: 'Amoxicillin', name_ar: 'أموكسيسيلين', trade_name: 'Amoxil', concentration: '500 mg', dosage_form: 'Capsule', unit: 'capsule', barcode: '6291000000011', status: 'active' },
  { id: 'ci-amox-susp', name: 'Amoxicillin', name_ar: 'أموكسيسيلين', trade_name: 'Moxypen', concentration: '250 mg/5 ml', dosage_form: 'Suspension', unit: 'bottle', barcode: null, status: 'active' },
  { id: 'ci-amox-old', name: 'Amoxicillin', name_ar: 'أموكسيسيلين', trade_name: 'Amoxil', concentration: '1 g', dosage_form: 'Tablet', unit: 'tablet', barcode: null, status: 'discontinued' },
  { id: 'ci-para', name: 'Paracetamol', name_ar: 'باراسيتامول', trade_name: 'Panadol', concentration: '500 mg', dosage_form: 'Tablet', unit: 'tablet', barcode: '6291000000028', status: 'active' },
  { id: 'ci-strep', name: 'Streptomycin', name_ar: 'ستربتومايسين', trade_name: 'Strepto', concentration: '1 g', dosage_form: 'Vial', unit: 'vial', barcode: null, status: 'inactive' },
  // Stored WITHOUT a hamza: an operator typing the hamza form must still find it.
  { id: 'ci-ibu', name: 'Ibuprofen', name_ar: 'ايبوبروفين', trade_name: null, concentration: null, dosage_form: null, unit: 'tablet', barcode: null, status: 'active' },
];

describe('PRE3-A — Annual Needs resolves materials through the ONE shared resolver', () => {
  beforeEach(() => { db.central_items = CATALOG.map((r) => ({ ...r })); });

  it('1 · searchCentralItems is the shared resolver, not a narrow name-only ILIKE of its own', async () => {
    const src = read('src/features/central-needs/central-needs.service.ts');
    const body = src.match(/export async function searchCentralItems\([\s\S]*?\n\}\n/)?.[0] ?? '';
    expect(body).toContain('resolveMaterials(query, {');
    expect(body).not.toMatch(/\.from\('central_items'\)/);
    expect(src).toMatch(/import \{ resolveMaterials, type MatchGrade \} from '@\/shared\/materials\/material-resolver\.service';/);
    // The old narrow resolver is gone from the whole service.
    expect(src).not.toMatch(/\.ilike\('name', `%\$\{query\}%`\)/);

    await searchCentralItems('Panadol');
    const [q] = queriesOn('central_items');
    expect(q.ops).toContainEqual(['eq', 'status', 'active']);
    const or = q.ops.find((op) => op[0] === 'or')?.[1] as string;
    for (const col of ['name', 'name_ar', 'trade_name']) expect(or).toContain(`${col}.ilike.`);
    expect(or).toContain('barcode.eq.');
  });

  it('2 · an inactive or discontinued catalog row is never offered, even when its name matches exactly', async () => {
    const amox = await searchCentralItems('Amoxicillin');
    expect(amox.map((i) => i.id).sort()).toEqual(['ci-amox-500', 'ci-amox-susp']);
    expect(await searchCentralItems('Strepto')).toEqual([]);
    expect(await searchCentralItems('Streptomycin')).toEqual([]);
  });

  it('2b · defence in depth: a row that arrives without active status is still dropped client-side', async () => {
    ignoreStatusFilter = true;
    const amox = await searchCentralItems('Amoxicillin');
    expect(amox.map((i) => i.id)).not.toContain('ci-amox-old');
    expect(await searchCentralItems('Strepto')).toEqual([]);
  });

  it('3 · trade_name is genuinely searchable, exact and partial, and graded as a name', async () => {
    const panadol = await searchCentralItems('Panadol');
    expect(panadol.map((i) => i.id)).toEqual(['ci-para']);
    expect(panadol[0]).toMatchObject({ grade: 'strong', reasonKey: 'mr_reason_name_exact', tradeName: 'Panadol' });
    const moxy = await searchCentralItems('Moxy');
    expect(moxy.map((i) => i.id)).toEqual(['ci-amox-susp']);
    expect(moxy[0]).toMatchObject({ grade: 'strong', reasonKey: 'mr_reason_name_prefix' });
  });

  it('3b · every candidate carries its discriminators, and a NULL field stays null', async () => {
    const [amox500] = (await searchCentralItems('Amoxil'));
    expect(amox500).toMatchObject({
      id: 'ci-amox-500', name: 'Amoxicillin', nameAr: 'أموكسيسيلين', tradeName: 'Amoxil',
      concentration: '500 mg', dosageForm: 'Capsule', unit: 'capsule', nationalCode: '6291000000011',
    });
    expect(centralItemDiscriminators(amox500).map((d) => d.labelKey)).toEqual([
      'cn2b_material_name_ar', 'inv_trade_name', 'inv_concentration', 'inv_dosage_form', 'inv_national_code',
    ]);
    const [ibu] = await searchCentralItems('Ibuprofen');
    // The resolver falls back to name_ar for a missing trade name; that is the
    // Arabic name, already shown as such — never presented as a trade name.
    expect(ibu).toMatchObject({ nameAr: 'ايبوبروفين', tradeName: null, concentration: null, dosageForm: null, nationalCode: null });
    expect(centralItemDiscriminators(ibu).map((d) => d.labelKey)).toEqual(['cn2b_material_name_ar']);
  });

  it('3c · the national-code semantic (catalog barcode) matches exactly and grades confirmed', async () => {
    const hits = await searchCentralItems('6291000000028');
    expect(hits.map((i) => i.id)).toEqual(['ci-para']);
    expect(hits[0].grade).toBe('confirmed');
  });

  it('4 · AR/EN normalization: hamza and case variants still find the registered material', async () => {
    expect((await searchCentralItems('إيبوبروفين')).map((i) => i.id)).toEqual(['ci-ibu']);
    expect((await searchCentralItems('PANADOL')).map((i) => i.id)).toEqual(['ci-para']);
    expect((await searchCentralItems('باراسيتامول')).map((i) => i.id)).toEqual(['ci-para']);
    const item = { id: 'x', name: 'Ibuprofen', unit: 'tablet', nameAr: 'إيبوبروفين', tradeName: 'Brufen' };
    expect(centralItemExactlyNames(item, '  ايبوبروفين ')).toBe(true);
    expect(centralItemExactlyNames(item, 'IBUPROFEN')).toBe(true);
    expect(centralItemExactlyNames(item, 'brufen')).toBe(true);
    // Exact only — a near miss is never an exact match.
    expect(centralItemExactlyNames(item, 'Ibuprofe')).toBe(false);
    expect(centralItemExactlyNames(item, 'Ibuprofen 400')).toBe(false);
  });

  it('a query shorter than two normalized characters searches nothing and is "keep typing", not "no match"', async () => {
    expect(centralItemQueryIsSearchable('a')).toBe(false);
    expect(centralItemQueryIsSearchable(' \u064B\u064B ')).toBe(false);
    expect(centralItemQueryIsSearchable('ab')).toBe(true);
    expect(await searchCentralItems('a')).toEqual([]);
    expect(queriesOn('central_items')).toHaveLength(0);
  });

  it('a failed catalog read is a refusal, never an empty "not registered" answer', async () => {
    failing.add('central_items');
    await expect(searchCentralItems('Panadol')).rejects.toBeInstanceOf(CentralNeedsError);
  });

  it('9 · the PRE3 production files introduce no catalog or stock write', () => {
    // The data layer: no table mutator at all, and the catalog is only ever read by the resolver.
    for (const rel of ['src/features/central-needs/central-needs.service.ts', 'src/shared/materials/material-resolver.service.ts']) {
      const src = read(rel);
      expect(src, rel).not.toMatch(/\.(insert|update|upsert|delete)\s*\(/);
    }
    expect(read('src/shared/materials/material-resolver.service.ts')).not.toMatch(/\.rpc\(/);
    expect(read('src/features/central-needs/central-needs.service.ts')).not.toMatch(/from\('(central_items|warehouse_stock|outlet_stock)'\)/);
    // The UI: no direct data access of its own.
    for (const rel of [
      'src/features/central-needs/simple/SimpleMaterialCard.tsx',
      'src/features/central-needs/CentralNeedsDispositionTable.tsx',
      'src/features/central-needs/CentralNeedsScreen.tsx',
    ]) {
      const src = read(rel);
      expect(src, rel).not.toMatch(/from ['"]@\/shared\/supabase\/client['"]/);
      expect(src, rel).not.toMatch(/\.from\('/);
    }
  });
});

// =============================================================================
// PRE3-A — Arabic spelling variants match in BOTH directions
// =============================================================================

// Stored spellings as a catalog really holds them (the first two are verbatim
// from 004_phoenix_seed_demo_data.sql): with hamza, taa marbuta, alef maksura,
// hamza carriers, harakat and tatweel.
const VARIANT_CATALOG: Row[] = [
  { id: 'ci-amox-004', name: 'Amoxicillin 500mg Capsules', name_ar: 'أموكسيسيلين 500 ملغ كبسولات', trade_name: null, unit: 'box', barcode: '6921234560001', status: 'active' },
  { id: 'ci-para-004', name: 'Paracetamol 500mg Tablets', name_ar: 'باراسيتامول 500 ملغ أقراص', trade_name: null, unit: 'box', barcode: '6921234560002', status: 'active' },
  { id: 'ci-azith', name: 'Azithromycin', name_ar: 'آزيثرومايسين', trade_name: null, unit: 'box', barcode: null, status: 'active' },
  { id: 'ci-vitc', name: 'Vitamin C', name_ar: 'فيتامين سي فوارة', trade_name: null, unit: 'box', barcode: null, status: 'active' },
  { id: 'ci-antipyretic', name: 'Antipyretic', name_ar: 'خافض الحمى', trade_name: null, unit: 'box', barcode: null, status: 'active' },
  { id: 'ci-oxid', name: 'Antioxidant', name_ar: 'مؤكسدات', trade_name: null, unit: 'box', barcode: null, status: 'active' },
  { id: 'ci-aqueous', name: 'Aqueous solution', name_ar: 'محلول مائي', trade_name: null, unit: 'bottle', barcode: null, status: 'active' },
  { id: 'ci-alef-wasla', name: 'Aspirin', name_ar: 'ٱسبرين', trade_name: null, unit: 'box', barcode: null, status: 'active' },
  { id: 'ci-harakat', name: 'Paracetamol (vocalised)', name_ar: 'ب\u064Eار\u064Eاس\u0650يت\u064Eام\u064Fول', trade_name: null, unit: 'box', barcode: null, status: 'active' },
  { id: 'ci-shadda', name: 'Metronidazole', name_ar: 'مترون\u0651يدازول', trade_name: null, unit: 'box', barcode: null, status: 'active' },
  { id: 'ci-tatweel', name: 'Insulin', name_ar: 'انس\u0640\u0640ولين', trade_name: null, unit: 'vial', barcode: null, status: 'active' },
  { id: 'ci-ibu-trade', name: 'Ibuprofen', name_ar: 'ايبوبروفين', trade_name: 'إيبوفين', unit: 'tablet', barcode: null, status: 'active' },
  { id: 'ci-literal', name: 'Literal', name_ar: 'دواء (500) a.b ملغ', trade_name: null, unit: 'box', barcode: null, status: 'active' },
  { id: 'ci-akb', name: 'Akb', name_ar: 'اكب', trade_name: null, unit: 'box', barcode: null, status: 'active' },
];

describe('PRE3-A — Arabic spelling variants match in BOTH directions, on the server', () => {
  beforeEach(() => { db.central_items = VARIANT_CATALOG.map((r) => ({ ...r })); });
  const ids = async (q: string, limit?: number) => (await searchCentralItems(q, limit)).map((i) => i.id);

  it('4c · a row stored WITH a variant is found by the plain spelling — every folded pair', async () => {
    const cases: Array<[string, string]> = [
      ['اموكسيسيلين', 'ci-amox-004'],   // أ stored
      ['اقراص', 'ci-para-004'],          // أ stored mid-text
      ['ازيثرومايسين', 'ci-azith'],      // آ stored
      ['اسبرين', 'ci-alef-wasla'],       // ٱ stored
      ['فواره', 'ci-vitc'],              // ة stored
      ['خافض الحمي', 'ci-antipyretic'],  // ى stored
      ['موكسدات', 'ci-oxid'],            // ؤ stored
      ['محلول مايي', 'ci-aqueous'],      // ئ stored
      ['باراسيتامول', 'ci-harakat'],     // fatha/kasra/damma stored
      ['مترونيدازول', 'ci-shadda'],      // shadda stored
      ['انسولين', 'ci-tatweel'],         // tatweel stored
      ['ايبوفين', 'ci-ibu-trade'],       // إ stored in trade_name
      ['إموكسيسيلين', 'ci-amox-004'],   // a DIFFERENT variant than the stored one
    ];
    for (const [query, id] of cases) expect(await ids(query), query).toContain(id);
  });

  it('4d · the reverse direction still holds: a variant query finds the plain stored spelling', async () => {
    expect(await ids('إيبوبروفين')).toContain('ci-ibu-trade');
    expect(await ids('أنسولين')).toContain('ci-tatweel');
  });

  it('4e · a variant match grades like the name it is, so the one-click exact suggestion still works', async () => {
    const [hit] = await searchCentralItems('اموكسيسيلين 500 ملغ كبسولات');
    expect(hit).toMatchObject({ id: 'ci-amox-004', grade: 'strong', reasonKey: 'mr_reason_name_exact' });
    expect(centralItemExactlyNames(hit, 'اموكسيسيلين 500 ملغ كبسولات')).toBe(true);
  });

  it('4f · the server limits the SYMMETRIC set: a hamza-spelled row past the first page is still returned', async () => {
    db.central_items = [
      ...Array.from({ length: 40 }, (_, i) => ({ id: `ci-other-${i}`, name: `Aaa ${String(i).padStart(2, '0')}`, name_ar: `دواء آخر ${i}`, trade_name: null, unit: 'box', barcode: null, status: 'active' })),
      { id: 'ci-late', name: 'Zz Amoxicillin', name_ar: 'أموكسيسيلين', trade_name: null, unit: 'box', barcode: null, status: 'active' },
    ];
    expect(await ids('اموكسيسيلين', 5)).toEqual(['ci-late']);
    const [q] = queriesOn('central_items');
    expect(q.ops.map((op) => op[0])).toEqual(['select', 'eq', 'or', 'order', 'order', 'limit']);
    expect(q.ops.find((op) => op[0] === 'limit')?.[1]).toBe(5);
  });

  it('4g · regex metacharacters in the query stay literal — never a pattern, never a broken filter', async () => {
    expect(await ids('ا.ب')).toEqual([]);                      // '.' is not "any character" (would hit اكب)
    expect(await ids('دواء (500) a.b')).toEqual(['ci-literal']);
    for (const q of ['ا+', 'ا?ب', 'ا|ب', '(ا', 'ا)', '[ا]', 'ا{2}', '^ا', 'ا$', 'ا\\', 'ا"', 'ا,ب', 'ا*']) {
      await expect(searchCentralItems(q), q).resolves.toBeInstanceOf(Array);
    }
    const or = queriesOn('central_items')[1].ops.find((op) => op[0] === 'or')?.[1] as string;
    expect(or).toContain('name_ar.imatch."');
    expect(or).toContain('\\\\(500\\\\)');                    // `\(` inside the quoted value
    // ...and the stand-in itself refuses an unescaped metacharacter, so the loop above has teeth.
    expect(() => orCondition('name_ar.imatch."a.b"')).toThrow(/unsupported imatch/);
    expect(() => orCondition('name_ar.imatch."a\\\\.b"')).not.toThrow();
  });

  it('4h · English and over-long queries are unchanged: no imatch term is sent', async () => {
    await searchCentralItems('Panadol');
    await searchCentralItems('ب'.repeat(31));
    for (const q of queriesOn('central_items')) {
      expect(q.ops.find((op) => op[0] === 'or')?.[1] as string).not.toContain('.imatch.');
    }
  });
});

// =============================================================================
// PRE3-B — Work Session / source search
// =============================================================================

const REV = 'rev-a';
const REV_OTHER = 'rev-z';
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';
const S4 = '44444444-4444-4444-8444-444444444444';
const S_OTHER = '22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function sessionFixture() {
  db.central_needs_import_sessions = [
    { id: S1, plan_revision_id: REV, source_file_id: 'f1', started_at: '2026-01-01 10:00:00.000001+00', entry_path: 'north/clinic-a.xlsx' },
    { id: S2, plan_revision_id: REV, source_file_id: 'f2', started_at: '2026-01-01 10:00:00.000002+00', entry_path: 'south/clinic-b.xlsx' },
    { id: S3, plan_revision_id: REV, source_file_id: 'f3', started_at: '2026-01-02 09:00:00+00', entry_path: null },
    { id: S4, plan_revision_id: REV, source_file_id: 'f4', started_at: '2026-01-03 09:00:00+00', entry_path: null },
    { id: S_OTHER, plan_revision_id: REV_OTHER, source_file_id: 'f9', started_at: '2026-01-01 08:00:00+00', entry_path: 'south/clinic-b.xlsx' },
  ];
  db.central_needs_import_batches = [
    { id: 'b1', plan_revision_id: REV, container_filename: 'Hospitals-2026.zip', registered_at: '2026-01-01 10:00:00+00' },
    { id: 'b2', plan_revision_id: REV, container_filename: 'standalone-budget.xlsx', registered_at: '2026-01-02 09:00:00+00' },
    { id: 'b9', plan_revision_id: REV_OTHER, container_filename: 'Hospitals-2026.zip', registered_at: '2026-01-01 08:00:00+00' },
  ];
  db.central_needs_import_batch_entries = [
    { id: 'e1', batch_id: 'b1', plan_revision_id: REV, entry_ordinal: 1, archive_entry_path: 'north/clinic-a.xlsx', entry_sha256: 'aa'.repeat(32), import_session_id: S1 },
    { id: 'e2', batch_id: 'b1', plan_revision_id: REV, entry_ordinal: 2, archive_entry_path: 'south/clinic-b.xlsx', entry_sha256: 'bb'.repeat(32), import_session_id: S2 },
    { id: 'e3', batch_id: 'b2', plan_revision_id: REV, entry_ordinal: 1, archive_entry_path: null, entry_sha256: 'cc'.repeat(32), import_session_id: S3 },
    { id: 'e9', batch_id: 'b9', plan_revision_id: REV_OTHER, entry_ordinal: 1, archive_entry_path: 'south/clinic-b.xlsx', entry_sha256: 'dd'.repeat(32), import_session_id: S_OTHER },
  ];
  db.central_needs_source_files = [
    { id: 'f1', plan_revision_id: REV, original_filename: 'clinic-a.xlsx', uploaded_at: '2026-01-01 10:00:00+00' },
    { id: 'f2', plan_revision_id: REV, original_filename: 'clinic-b.xlsx', uploaded_at: '2026-01-01 10:00:00+00' },
    { id: 'f3', plan_revision_id: REV, original_filename: 'standalone-budget.xlsx', uploaded_at: '2026-01-02 09:00:00+00' },
    { id: 'f4', plan_revision_id: REV, original_filename: 'legacy-plan_2025.xlsx', uploaded_at: '2026-01-03 09:00:00+00' },
    { id: 'f9', plan_revision_id: REV_OTHER, original_filename: 'legacy-plan_2025.xlsx', uploaded_at: '2026-01-01 08:00:00+00' },
  ];
}

const hitIds = (r: { hits: Array<{ importSessionId: string }> }) => r.hits.map((h) => h.importSessionId);
const matchedOn = (r: { hits: Array<{ importSessionId: string; matchedOn: string[] }> }, id: string) =>
  r.hits.find((h) => h.importSessionId === id)?.matchedOn;

describe('PRE3-B — Work Session search is decided by the server, inside one revision', () => {
  beforeEach(sessionFixture);

  it('10 · a container filename finds every session of that container — and only in this revision', async () => {
    const zip = await searchWorkSessions(REV, 'hospitals-2026');
    expect(hitIds(zip)).toEqual([S1, S2]);
    expect(matchedOn(zip, S1)).toEqual(['container_filename']);
    const standalone = await searchWorkSessions(REV, 'standalone-budget');
    expect(hitIds(standalone)).toEqual([S3]);
    expect(matchedOn(standalone, S3)).toEqual(['container_filename', 'source_filename']);
  });

  it('10b · a stored source filename finds a session that has no batch at all', async () => {
    const legacy = await searchWorkSessions(REV, 'legacy-plan');
    expect(hitIds(legacy)).toEqual([S4]);
    expect(matchedOn(legacy, S4)).toEqual(['source_filename']);
  });

  it('11 · an archive entry path matches (and the same path in another revision does not)', async () => {
    const south = await searchWorkSessions(REV, 'south/clinic');
    expect(hitIds(south)).toEqual([S2]);
    expect(matchedOn(south, S2)).toEqual(['entry_path']);
    expect(hitIds(south)).not.toContain(S_OTHER);
  });

  it('12 · the full session UUID matches exactly, in any letter case', async () => {
    const full = await searchWorkSessions(REV, S3);
    expect(hitIds(full)).toEqual([S3]);
    expect(matchedOn(full, S3)).toEqual(['session_id']);
    expect(hitIds(await searchWorkSessions(REV, S3.toUpperCase()))).toEqual([S3]);
    const idQuery = queriesOn('central_needs_import_sessions').find((q) => q.ops.some((op) => op[0] === 'eq' && op[1] === 'id'));
    expect(idQuery?.ops).toContainEqual(['eq', 'id', S3]);
  });

  it('13 · a UUID prefix matches by range, with or without hyphens, inside this revision only', async () => {
    const prefix = await searchWorkSessions(REV, '2222');
    expect(hitIds(prefix)).toEqual([S2]);
    expect(matchedOn(prefix, S2)).toEqual(['session_id_prefix']);
    expect(hitIds(await searchWorkSessions(REV, '22222222-22'))).toEqual([S2]);
    expect(sessionIdRange('22222222-22')).toEqual({
      lo: '22222222-2200-0000-0000-000000000000', hi: '22222222-22ff-ffff-ffff-ffffffffffff', exact: false,
    });
    // Hyphens only where a UUID has them; fewer than four hex digits is not an id.
    expect(sessionIdRange('2222-2')).toBeNull();
    expect(sessionIdRange('222')).toBeNull();
    expect(sessionIdRange('clinic')).toBeNull();
    expect(sessionIdRange(S1)).toMatchObject({ lo: S1, hi: S1, exact: true });
  });

  it('LIKE metacharacters in the term are matched as text, not as a pattern', async () => {
    // `_` would match any one character if it were not escaped.
    expect(hitIds(await searchWorkSessions(REV, 'plan_2025'))).toEqual([S4]);
    expect(hitIds(await searchWorkSessions(REV, 'plan%2025'))).toEqual([]);
    expect(hitIds(await searchWorkSessions(REV, 'clinic_a'))).toEqual([]);
  });

  it('18 · an empty term is no search at all — bounded and intentional, no query is sent', async () => {
    expect(await searchWorkSessions(REV, '   ')).toEqual({ hits: [], truncated: false });
    expect(recorded).toHaveLength(0);
  });

  it('a cut is reported, never hidden: each query asks for one row more than it keeps', async () => {
    const cut = await searchWorkSessions(REV, 'hospitals', 1);
    expect(cut.truncated).toBe(true);
    expect(cut.hits).toHaveLength(1);
    recorded.length = 0;
    const whole = await searchWorkSessions(REV, 'hospitals', 2);
    expect(whole.truncated).toBe(false);
    for (const q of recorded) expect(q.ops.find((op) => op[0] === 'limit')?.[1]).toBe(3);
  });

  it('a failed query is a refusal, never "no session matched"', async () => {
    failing.add('central_needs_import_sessions');
    await expect(searchWorkSessions(REV, 'clinic')).rejects.toBeInstanceOf(CentralNeedsError);
  });

  it('17 · every Work Session query filters, then orders, then limits — and is scoped to the revision', async () => {
    await searchWorkSessions(REV, 'clinic');
    expect(recorded.length).toBeGreaterThan(0);
    for (const q of recorded) {
      const kinds = q.ops.map((op) => op[0]);
      expect(kinds.at(-1), q.table).toBe('limit');
      expect(kinds.lastIndexOf('order'), q.table).toBeLessThan(kinds.indexOf('limit'));
      const lastFilter = Math.max(...['eq', 'ilike', 'in', 'gte', 'lte'].map((k) => kinds.lastIndexOf(k)));
      expect(lastFilter, q.table).toBeLessThan(kinds.indexOf('order'));
      expect(q.ops).toContainEqual(['eq', 'plan_revision_id', REV]);
    }
  });
});

describe('PRE3-B — the stable Work Session number', () => {
  const base = { planRevisionId: REV, sourceFileId: 'f', previewDigest: null, authoritativeDigest: null, parserIdentity: null, completedAt: null, notes: null };
  const SESSIONS = [
    { ...base, id: S4, status: 'completed' as const, startedAt: '2026-01-03 09:00:00+00' },
    { ...base, id: S2, status: 'completed' as const, startedAt: '2026-01-01 10:00:00.000002+00' },
    { ...base, id: S3, status: 'failed' as const, startedAt: '2026-01-02 09:00:00+00' },
    { ...base, id: S1, status: 'completed' as const, startedAt: '2026-01-01 10:00:00.000001+00' },
  ];

  it('14 · numbers every session of the revision by start time (to the microsecond), then id — whatever the input order', () => {
    const ranks = rankImportSessions(SESSIONS);
    expect([S1, S2, S3, S4].map((id) => ranks.get(id))).toEqual([
      { ordinal: 1, total: 4 }, { ordinal: 2, total: 4 }, { ordinal: 3, total: 4 }, { ordinal: 4, total: 4 },
    ]);
    expect(rankImportSessions([...SESSIONS].reverse())).toEqual(ranks);
    // A tie on start time is broken by id, deterministically.
    const tie = rankImportSessions([
      { ...base, id: S2, status: 'completed', startedAt: '2026-01-01T00:00:00Z' },
      { ...base, id: S1, status: 'completed', startedAt: '2026-01-01T00:00:00Z' },
    ]);
    expect(tie.get(S1)?.ordinal).toBe(1);
    expect(tie.get(S2)?.ordinal).toBe(2);
  });

  it('14b · a session number is typed as "3", "#3", "٣" or "۳"; anything else is not a number', () => {
    for (const typed of ['3', '#3', ' # 3 ', '٣', '#٣', '۳']) expect(parseSessionOrdinal(typed), typed).toBe(3);
    for (const typed of ['0', '#', '3a', '3/4', 'session 3', '']) expect(parseSessionOrdinal(typed), typed).toBeNull();
  });
});

describe('PRE3-B — evidence search filters on the server before it limits', () => {
  function bigArchive() {
    db.central_needs_import_batches = [
      { id: 'b1', plan_revision_id: REV, container_filename: 'Hospitals-2026.zip', registered_at: '2026-01-01 10:00:00+00' },
      { id: 'b2', plan_revision_id: REV, container_filename: 'Clinics-annex.zip', registered_at: '2026-01-02 10:00:00+00' },
    ];
    db.central_needs_import_batch_entries = Array.from({ length: 150 }, (_, i) => ({
      id: `e${String(i + 1).padStart(3, '0')}`, batch_id: 'b1', plan_revision_id: REV, entry_ordinal: i + 1,
      archive_entry_path: `region/facility-${String(i + 1).padStart(3, '0')}.xlsx`,
      entry_sha256: `${(i + 1).toString(16).padStart(4, '0')}${'e'.repeat(60)}`, import_session_id: `sess-${i + 1}`,
    }));
    db.central_needs_import_batch_entries.push({
      id: 'x1', batch_id: 'b2', plan_revision_id: REV, entry_ordinal: 1,
      archive_entry_path: 'annex/extra.xlsx', entry_sha256: 'f'.repeat(64), import_session_id: 'sess-x',
    });
  }
  beforeEach(bigArchive);

  it('16 · an entry far past the former first-100 cut is found', async () => {
    const hits = await searchBatchEntries(REV, 'facility-140');
    expect(hits.map((h) => h.id)).toEqual(['e140']);
    expect(hits[0]).toMatchObject({ archiveEntryPath: 'region/facility-140.xlsx', containerFilename: 'Hospitals-2026.zip', entryOrdinal: 140 });
  });

  it('16b · a container filename finds its entries; a fingerprint prefix finds its entry', async () => {
    expect((await searchBatchEntries(REV, 'clinics-annex')).map((h) => h.id)).toEqual(['x1']);
    expect((await searchBatchEntries(REV, '008c')).map((h) => h.id)).toEqual(['e140']);
  });

  it('17b · the evidence query filters, orders by (batch, ordinal) and limits — no browser-side filtering remains', async () => {
    await searchBatchEntries(REV, 'facility-14');
    const entryQueries = queriesOn('central_needs_import_batch_entries');
    const byPath = entryQueries.find((q) => q.ops.some((op) => op[0] === 'ilike' && op[1] === 'archive_entry_path'));
    expect(byPath?.ops.map((op) => op[0])).toEqual(['select', 'eq', 'ilike', 'order', 'order', 'limit']);
    expect(byPath?.ops.filter((op) => op[0] === 'order').map((op) => op[1])).toEqual(['batch_id', 'entry_ordinal']);
    const src = read('src/features/central-needs/central-needs.service.ts');
    const body = src.match(/export async function searchBatchEntries\([\s\S]*?\n\}\n/)?.[0] ?? '';
    expect(body).not.toMatch(/\.filter\(\(e\)/);
    expect(body).not.toMatch(/toLowerCase\(\)\.includes/);
  });

  it('18b · an empty term is one bounded, ordered listing', async () => {
    const all = await searchBatchEntries(REV, '');
    expect(all).toHaveLength(100);
    expect(all[0].id).toBe('e001');
    expect(recorded).toHaveLength(1);
    expect(recorded[0].ops.map((op) => op[0])).toEqual(['select', 'eq', 'order', 'order', 'limit']);
  });
});
