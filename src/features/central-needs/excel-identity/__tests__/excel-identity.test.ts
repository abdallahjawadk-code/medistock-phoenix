import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { extractIdentityCandidates, type SheetCells } from '../identity-extract';
import { suggestForCandidate, type ResolverHit } from '../identity-suggest';
import { runIdentityAssist, MAX_IDENTITY_LOOKUPS } from '../identity-assist';
import * as publicApi from '../index';

const QTY = ['987654321', '13579.25', '424242', '55001', '56002'];

/** A row whose cell reads are recorded by column index. */
const spy = (cells: Array<string | number | null>) => {
  const seen = new Set<number>();
  const row = new Proxy(cells, {
    get(t, k, r) { if (typeof k === 'string' && /^\d+$/.test(k)) seen.add(Number(k)); return Reflect.get(t, k, r); },
  });
  return { row: row as unknown as string[], seen };
};

const sheet: SheetCells = [
  ['Annual plan 2027', null, null, null, null, null],
  ['No', 'Medicine name', 'Strength', 'Dosage form', 'Unit', 'Annual quantity', 'Total'],
  [1, 'Paracetamol', '500 mg', 'Tablet', 'box', QTY[0], QTY[2]],
  [2, 'Amoxicillin', '250mg', 'Capsule', 'box', QTY[1], 7],
  [3, null, null, null, null, 55001, 56002],
];
const arabic: SheetCells = [
  ['الرقم', 'اسم المادة', 'التركيز', 'الشكل الصيدلاني', 'الوحدة', 'الاحتياج السنوي', 'الرمز'],
  [1, 'باراسيتامول', '٥٠٠ ملغم', 'اقراص', 'علبة', QTY[0], '1234567'],
];

describe('A3 default state: the header row MUST be confirmed', () => {
  it('without a confirmed header nothing is read at all (spy on every row, including the header zone)', () => {
    const rows = Array.from({ length: 30 }, (_, i) => spy([`Medicine name ${i}`, 700000 + i, 'x']));
    for (const options of [undefined, {}, { headerRow: undefined }, { headerRow: null }] as unknown[]) {
      const r = extractIdentityCandidates(rows.map((x) => x.row), 0, options as never);
      expect(r).toEqual({ headerRow: null, candidates: [], warnings: ['header_confirmation_required'] });
    }
    rows.forEach((x, i) => expect(x.seen.size, `row ${i}`).toBe(0));
  });

  it('the type system also refuses a call without the confirmation (compile-time half of the guarantee)', () => {
    // @ts-expect-error - options with a required headerRow are mandatory
    extractIdentityCandidates(sheet, 0);
    // @ts-expect-error - an empty options object is not a confirmation
    extractIdentityCandidates(sheet, 0, {});
    expect(true).toBe(true);
  });

  it('an out-of-range or non-integer confirmation is refused without reading', () => {
    const rows = [spy(['Medicine name']), spy(['Aspirin'])];
    for (const headerRow of [-1, 2, 99, 1.5, Number.NaN]) {
      expect(extractIdentityCandidates(rows.map((x) => x.row), 0, { headerRow }).warnings, String(headerRow)).toEqual(['no_header']);
    }
    rows.forEach((x) => expect(x.seen.size).toBe(0));
  });
});

describe('A3 confirmed header: reads the header row and the identity columns, nothing else', () => {
  it('returns identity columns only', () => {
    const r = extractIdentityCandidates(sheet, 0, { headerRow: 1 });
    expect(r.headerRow).toBe(1);
    expect(r.candidates.map((c) => c.name)).toEqual(['Paracetamol', 'Amoxicillin']);
    expect(r.candidates[0]).toMatchObject({ strength: '500 mg', form: 'Tablet', unit: 'box', row: 2, sheetIndex: 0 });
  });

  it('SENTINEL quantity cells: no quantity value from any column appears anywhere in the output', () => {
    const json = JSON.stringify([extractIdentityCandidates(sheet, 0, { headerRow: 1 }), extractIdentityCandidates(arabic, 0, { headerRow: 0 })]);
    for (const s of QTY) expect(json, s).not.toContain(s);
    for (const c of extractIdentityCandidates(sheet, 0, { headerRow: 1 }).candidates) {
      expect(Object.keys(c).sort()).toEqual(['code', 'columns', 'form', 'name', 'row', 'sheetIndex', 'strength', 'tradeName', 'unit']);
    }
  });

  it('cells of the quantity / unknown columns are NEVER read; rows above the header are NEVER read', () => {
    const title = spy(['Plan 2027', 820000, 'x', 'y', 'z']);
    const header = spy(['No', 'Medicine name', 'Strength', 'Annual quantity', 'Notes']);
    const data = Array.from({ length: 20 }, (_, i) => spy([i, `Drug ${i}`, `${i} mg`, 830000 + i, 'note']));
    const r = extractIdentityCandidates([title.row, header.row, ...data.map((d) => d.row)], 0, { headerRow: 1 });
    expect(r.candidates).toHaveLength(20);
    expect(title.seen.size).toBe(0);
    data.forEach((d) => expect([...d.seen].sort(), 'only name + strength may be read').toEqual([1, 2]));
    expect(JSON.stringify(r)).not.toMatch(/820000|83000\d|83001\d/);
  });

  it('ONE identity header: only that column is read from each data row', () => {
    const data = [spy(['Aspirin', 111111, 'x']), spy(['Ibuprofen', 222222, 'y'])];
    const r = extractIdentityCandidates([['Medicine name', 'Annual quantity', 'Notes'], ...data.map((d) => d.row)], 0, { headerRow: 0 });
    expect(r.candidates.map((c) => c.name)).toEqual(['Aspirin', 'Ibuprofen']);
    data.forEach((d) => expect([...d.seen]).toEqual([0]));
    expect(JSON.stringify(r)).not.toMatch(/111111|222222/);
  });

  it('Arabic headers work and Arabic text is kept unconverted', () => {
    const [c] = extractIdentityCandidates(arabic, 0, { headerRow: 0 }).candidates;
    expect(c).toMatchObject({ name: 'باراسيتامول', form: 'اقراص', unit: 'علبة', code: '1234567' });
  });

  it('manual header choice works for any row of the sheet', () => {
    const grid: SheetCells = [['x'], ['y'], ['Drug name', 'Qty'], ['Zinc', 9], ['Iron', 8]];
    expect(extractIdentityCandidates(grid, 0, { headerRow: 2 }).candidates.map((c) => c.name)).toEqual(['Zinc', 'Iron']);
  });
});

describe('A3 absent and misleading headers', () => {
  it('a confirmed row with NO recognisable labels yields nothing and reads no data row', () => {
    const data = [spy(['Aspirin', 910001]), spy(['Zinc', 910002])];
    const r = extractIdentityCandidates([['foo', 'bar'], ...data.map((d) => d.row)], 0, { headerRow: 0 });
    expect(r).toEqual({ headerRow: 0, candidates: [], warnings: ['no_name_column'] });
    data.forEach((d) => expect(d.seen.size).toBe(0));
  });

  it('ambiguity is refused, never resolved by guessing: two name columns', () => {
    expect(extractIdentityCandidates([['Medicine name', 'Drug name'], ['a', 'b']], 0, { headerRow: 0 })).toMatchObject({ candidates: [], warnings: ['ambiguous_name_column'] });
  });

  it('a TITLE row confirmed by mistake: the real header line below is dropped as header-like, and the quantity column stays untouched', () => {
    const title = spy(['Description', 'Total']);
    const real = spy(['Medicine name', 'Qty']);
    const data = spy(['Aspirin', 840001]);
    const r = extractIdentityCandidates([title.row, real.row, data.row], 0, { headerRow: 0 });
    expect(r.candidates.map((c) => c.name)).toEqual(['Aspirin']);   // the header-like line is not a candidate
    expect(r.warnings).toContain('header_like_row');
    expect([...real.seen]).toEqual([0]);                            // only the (mis-assigned) identity column was read
    expect(JSON.stringify(r)).not.toMatch(/840001/);
  });

  it('an identity-looking header over a QUANTITY column: numeric and digits-only cells are never names - nothing leaks', () => {
    const numeric = extractIdentityCandidates([['Description', 'x'], [4500, 1], [4600, 2]], 0, { headerRow: 0 });
    expect(numeric).toMatchObject({ candidates: [], warnings: ['name_column_not_text'] });
    const digitsText = extractIdentityCandidates([['Description'], ['4500'], ['4600.5']], 0, { headerRow: 0 });
    expect(digitsText).toMatchObject({ candidates: [], warnings: ['name_column_not_text'] });
    expect(JSON.stringify([numeric, digitsText])).not.toMatch(/4500|4600/);
  });

  it('numeric cells are not accepted as strength/form/unit; a code must be text or a 6-14 digit integer', () => {
    const r = extractIdentityCandidates([
      ['Medicine name', 'Strength', 'Dosage form', 'Unit', 'Code'],
      ['Aspirin', 500, 12, 24, 77],
      ['Zinc', '500 mg', 'Tablet', 'box', 1234567],
      ['Iron', '10 mg', 'Tablet', 'box', '8901234'],
    ], 0, { headerRow: 0 });
    expect(r.candidates[0]).toMatchObject({ name: 'Aspirin', strength: null, form: null, unit: null, code: null });
    expect(r.candidates[1]).toMatchObject({ strength: '500 mg', code: '1234567' });
    expect(r.candidates[2]).toMatchObject({ code: '8901234' });
  });

  it('a row with a code but no name is reported, never guessed; formula text is neutralised; length is bounded; oversize sheets are refused', () => {
    const a = extractIdentityCandidates([['Medicine name', 'Code'], [null, '777'], ['Aspirin', '1']], 0, { headerRow: 0 });
    expect(a.candidates.map((c) => c.name)).toEqual(['Aspirin']);
    expect(a.warnings).toContain('row_without_name');
    const b = extractIdentityCandidates([['Medicine name'], ['=HYPERLINK("http://x")'], ['A'.repeat(1000)]], 0, { headerRow: 0 });
    expect(b.candidates[0].name.startsWith("'=")).toBe(true);
    expect(b.candidates[1].name.length).toBeLessThanOrEqual(300);
    expect(extractIdentityCandidates(Array.from({ length: 5001 }, () => ['x']), 0, { headerRow: 0 })).toMatchObject({ candidates: [], warnings: ['sheet_too_large'] });
  });
});

const hit = (o: Partial<ResolverHit> = {}): ResolverHit => ({
  source: 'catalog', centralItemId: 'item-1', scientificName: 'Paracetamol', tradeName: null, concentration: '500 mg',
  dosageForm: 'Tablet', unit: 'box', nationalCode: null, grade: 'confirmed', ...o,
});
const cand = extractIdentityCandidates(sheet, 0, { headerRow: 1 }).candidates[0];

describe('identity suggestion', () => {
  it('suggests a unique, conflict-free, confirmed catalog hit - and only suggests', async () => {
    const s = await suggestForCandidate(cand, async () => [hit()]);
    expect(s.kind).toBe('exact_unique');
    expect(s.options[0]).toMatchObject({ centralItemId: 'item-1', conflicts: [] });
  });
  it('a strength or form conflict is surfaced, not suggested (dose/form are never conflated)', async () => {
    expect((await suggestForCandidate(cand, async () => [hit({ concentration: '250 mg' })])).kind).toBe('conflict');
    const s = await suggestForCandidate(cand, async () => [hit({ dosageForm: 'Syrup' })]);
    expect(s).toMatchObject({ kind: 'conflict' });
    expect(s.options[0].conflicts).toEqual(['form']);
  });
  it('two candidates, or a non-confirmed grade, stay ambiguous for a human', async () => {
    expect((await suggestForCandidate(cand, async () => [hit(), hit({ centralItemId: 'item-2' })])).kind).toBe('ambiguous');
    expect((await suggestForCandidate(cand, async () => [hit({ grade: 'strong' })])).kind).toBe('ambiguous');
  });
  it('an API failure is lookup_failed, never "none"', async () => {
    expect((await suggestForCandidate(cand, async () => { throw new Error('503'); })).kind).toBe('lookup_failed');
    expect((await suggestForCandidate(cand, async () => [])).kind).toBe('none');
  });
  it('stock lots are dropped and no stock/quantity field can travel with a suggestion', async () => {
    const stock = { ...hit({ centralItemId: 'item-9' }), source: 'stock' as const, onHand: 999, available: 888, batchNumber: 'B1' };
    const catalogWithStock = { ...hit(), onHand: 777, reserved: 1, available: 5 };
    const s = await suggestForCandidate(cand, async () => [stock as ResolverHit, catalogWithStock as ResolverHit]);
    expect(s.kind).toBe('exact_unique');
    const json = JSON.stringify(s);
    for (const bad of ['onHand', 'available', 'reserved', 'batchNumber', '777', '888', '999']) expect(json, bad).not.toContain(bad);
  });
  it('queries by code when present, else by name', async () => {
    const resolve = vi.fn(async () => [hit()]);
    await suggestForCandidate({ ...cand, code: '1234567' }, resolve);
    await suggestForCandidate({ ...cand, code: null }, resolve);
    expect(resolve.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['1234567', 'Paracetamol']);
  });
});

describe('A3 integration point: the ONLY way in enforces the same behaviour', () => {
  it('runIdentityAssist without a confirmed header reads nothing and never calls the resolver', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => spy(['Medicine name', 950000 + i]));
    const resolve = vi.fn(async () => [hit()]);
    const r = await runIdentityAssist({ sheet: rows.map((x) => x.row), sheetIndex: 0, confirmedHeaderRow: undefined, resolve });
    expect(r.extraction.warnings).toEqual(['header_confirmation_required']);
    expect(r.items).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
    rows.forEach((x) => expect(x.seen.size).toBe(0));
  });

  it('with a confirmed header it looks up each candidate by typed code/name only, and returns identity suggestions only', async () => {
    const resolve = vi.fn(async (q: string) => [hit({ centralItemId: `id-${q}` })]);
    const r = await runIdentityAssist({ sheet, sheetIndex: 0, confirmedHeaderRow: 1, resolve });
    expect(resolve.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['Paracetamol', 'Amoxicillin']);
    expect(r.items).toHaveLength(2);
    const json = JSON.stringify(r);
    for (const s of QTY) expect(json, s).not.toContain(s);
  });

  it('the lookup count is bounded', async () => {
    const big: SheetCells = [['Medicine name'], ...Array.from({ length: MAX_IDENTITY_LOOKUPS + 25 }, (_, i) => [`Drug ${i}`])];
    const resolve = vi.fn(async () => [] as ResolverHit[]);
    const r = await runIdentityAssist({ sheet: big, sheetIndex: 0, confirmedHeaderRow: 0, resolve });
    expect(resolve).toHaveBeenCalledTimes(MAX_IDENTITY_LOOKUPS);
    expect(r.truncated).toBe(true);
  });

  it('the package entry does NOT expose the raw extractor, so a screen can only reach the enforced path', () => {
    expect(Object.keys(publicApi).sort()).toEqual(['MAX_IDENTITY_LOOKUPS', 'lazySheetCells', 'runIdentityAssist']);
    expect((publicApi as Record<string, unknown>).extractIdentityCandidates).toBeUndefined();
  });

  it('IMPORT BOUNDARY: no module outside this package imports the extractor/suggester/assist directly; only the package entry is allowed', () => {
    const root = join(__dirname, '..', '..', '..', '..');            // src/
    const pkg = join(root, 'features', 'central-needs', 'excel-identity');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full); continue; }
        if (!/\.(ts|tsx)$/.test(e.name) || full.startsWith(pkg)) continue;
        const text = readFileSync(full, 'utf8');
        // module SPECIFIERS only (static `from`, dynamic `import()`, `vi.mock`/`require`): a data-testid or a comment is not an import
        for (const m of text.matchAll(/(?:from|import\s*\(|require\s*\(|vi\.mock\s*\()\s*['"]([^'"]+)['"]/g)) {
          const spec = m[1];
          if (/excel-identity/.test(spec) && !/excel-identity\/?$|excel-identity\/index$/.test(spec)) offenders.push(`${relative(root, full)}: ${spec}`);
          if (/(^|\/)identity-(extract|suggest|assist)$/.test(spec)) offenders.push(`${relative(root, full)}: ${spec}`);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  it('nothing from this package can reach the needs writer: no import of the manual service, no quantity-shaped key, no I/O', () => {
    for (const f of ['identity-extract.ts', 'identity-suggest.ts', 'identity-assist.ts', 'index.ts']) {
      const src = readFileSync(join(__dirname, '..', f), 'utf8');
      expect(src, f).not.toMatch(/manual-needs|addManualNeedLine|correctManualNeedLine|quantity_text|quantityText|p_quantity/);
      expect(src, f).not.toMatch(/supabase|fetch\(|localStorage|sessionStorage|indexedDB|console\./);
    }
    const keys = JSON.stringify(Object.keys(extractIdentityCandidates(sheet, 0, { headerRow: 1 }).candidates[0]));
    expect(keys).not.toMatch(/quantity|qty|amount|need|total|count/i);
  });
});
