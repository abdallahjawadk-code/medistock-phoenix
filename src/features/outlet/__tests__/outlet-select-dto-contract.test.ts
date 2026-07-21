/**
 * OUTLET-CORRIDOR-070/071 — selected columns ↔ row DTO contract.
 *
 * WHY THIS EXISTS: supabase-js infers `GenericStringError[]` from a
 * concatenated-const `.select()` string, so these reads cast through `unknown`
 * (see the `as unknown as …Row[]` sites, precedent: commit 38a015b). That cast
 * is load-bearing for the production build, but it also switches OFF the only
 * compiler check that the selected column list still matches the row interface.
 *
 * Nothing else would catch a drift: add a field to a Row interface without
 * adding it to the column list and the compiler stays silent while the mapper
 * reads `undefined` at runtime. These tests are that missing check.
 *
 * Static source assertions, matching the convention in
 * outlet-services-contract.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');
const dispatch = read('dispatch.service.ts');
const ret = read('outlet-return.service.ts');

/** Concatenate every single-quoted chunk of an expression, then split on commas. */
const splitColumns = (expr: string): string[] =>
  (expr.match(/'([^']*)'/g) ?? [])
    .map((s) => s.slice(1, -1))
    .join('')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);

/** Columns from a `const NAME = 'a, b' + 'c';` declaration. */
function columnsFromConst(src: string, name: string): string[] {
  const m = src.match(new RegExp(`const ${name}\\s*=([\\s\\S]*?);`));
  if (!m) throw new Error(`column constant ${name} not found`);
  const cols = splitColumns(m[1]);
  if (cols.length === 0) throw new Error(`column constant ${name} parsed empty`);
  return cols;
}

/** Columns from an inline `.from('table')….select('a, b')`. */
function columnsFromInlineSelect(src: string, table: string): string[] {
  const m = src.match(new RegExp(`\\.from\\('${table}'\\)[\\s\\S]{0,120}?\\.select\\(([^)]*)\\)`));
  if (!m) throw new Error(`inline select for ${table} not found`);
  const cols = splitColumns(m[1]);
  if (cols.length === 0) throw new Error(`inline select for ${table} parsed empty`);
  return cols;
}

/** Field names declared on a row interface. */
function rowFields(src: string, name: string): string[] {
  const m = src.match(new RegExp(`interface ${name}\\s*\\{([\\s\\S]*?)\\}`));
  if (!m) throw new Error(`row interface ${name} not found`);
  const fields = (m[1].match(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g) ?? []).map((s) =>
    s.replace(/\s*:$/, '').trim(),
  );
  if (fields.length === 0) throw new Error(`row interface ${name} parsed empty`);
  return fields;
}

interface Pair {
  label: string;
  src: string;
  columns: () => string[];
  row: string;
}

const PAIRS: Pair[] = [
  {
    label: '070 warehouse_dispatches → WarehouseDispatchRow',
    src: dispatch,
    columns: () => columnsFromConst(dispatch, 'DISPATCH_COLUMNS'),
    row: 'WarehouseDispatchRow',
  },
  {
    label: '070 warehouse_dispatch_lines → WarehouseDispatchLineRow',
    src: dispatch,
    columns: () => columnsFromConst(dispatch, 'DISPATCH_LINE_COLUMNS'),
    row: 'WarehouseDispatchLineRow',
  },
  {
    label: '071 outlet_return_requests → OutletReturnRequestRow',
    src: ret,
    columns: () => columnsFromConst(ret, 'RETURN_REQUEST_COLUMNS'),
    row: 'OutletReturnRequestRow',
  },
  {
    label: '071 outlet_return_request_lines → OutletReturnRequestLineRow',
    src: ret,
    columns: () => columnsFromConst(ret, 'RETURN_LINE_COLUMNS'),
    row: 'OutletReturnRequestLineRow',
  },
  {
    label: '071 outlet_return_shipments → OutletReturnShipmentRow',
    src: ret,
    columns: () => columnsFromInlineSelect(ret, 'outlet_return_shipments'),
    row: 'OutletReturnShipmentRow',
  },
  {
    label: '071 outlet_return_shipment_lines → OutletReturnShipmentLineRow',
    src: ret,
    columns: () => columnsFromInlineSelect(ret, 'outlet_return_shipment_lines'),
    row: 'OutletReturnShipmentLineRow',
  },
];

describe('selected columns exactly match the row DTO the result is cast to', () => {
  for (const p of PAIRS) {
    it(`${p.label} — no missing, no extra`, () => {
      const columns = [...p.columns()].sort();
      const fields = [...rowFields(p.src, p.row)].sort();
      // Exact set equality in BOTH directions: a selected column with no row
      // field is dead weight; a row field with no selected column is `undefined`
      // at runtime with no compiler error, because of the `unknown` cast.
      expect(columns).toEqual(fields);
    });

    it(`${p.label} — every selected column is actually read by the mapper`, () => {
      for (const col of p.columns()) {
        expect(p.src).toContain(`r.${col}`);
      }
    });
  }
});

describe('the reads stay explicitly columned', () => {
  it('never selects * (which would silently drift from the row DTO)', () => {
    expect(dispatch).not.toMatch(/\.select\(\s*'\s*\*\s*'\s*\)/);
    expect(ret).not.toMatch(/\.select\(\s*'\s*\*\s*'\s*\)/);
  });

  // Only CONCATENATED-const selects confuse supabase-js into GenericStringError[].
  // A single inline literal select infers correctly, so the shipment reads cast
  // bare on purpose — casting those through `unknown` would be noise.
  const CONCATENATED_CONST_ROWS: Array<[string, string]> = [
    ['dispatch.service.ts', 'WarehouseDispatchRow'],
    ['dispatch.service.ts', 'WarehouseDispatchLineRow'],
    ['outlet-return.service.ts', 'OutletReturnRequestRow'],
    ['outlet-return.service.ts', 'OutletReturnRequestLineRow'],
  ];

  for (const [file, row] of CONCATENATED_CONST_ROWS) {
    it(`${file}: ${row} casts through unknown, so tsc -b stays green`, () => {
      const src = file === 'dispatch.service.ts' ? dispatch : ret;
      // A bare `data as SomeRow[]` on a concatenated-const select is TS2352 and
      // breaks `npm run build`. Note `tsc --noEmit` does NOT catch it.
      expect(src).not.toMatch(new RegExp(`data as ${row}\\[\\]`));
      expect(src).toMatch(new RegExp(`data as unknown as ${row}\\[\\]`));
    });
  }
});
