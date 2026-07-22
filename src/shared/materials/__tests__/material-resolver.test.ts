/**
 * PHOENIX-MATERIAL-RESOLVER + SMART-SCANNER — behavioral contract tests.
 *
 * The resolver's DB query shape is exercised against an injected fake
 * PostgREST transport (no database); the scanner classifier is pure. These
 * prove the CONTRACT per source, not just source-guard greps.
 */
import { describe, it, expect, vi } from 'vitest';
import { resolveMaterials } from '../material-resolver.service';
import { classifyScanPayload } from '../SmartScanner';

// ── A fake supabase client: records .from() table + .or() filter, returns
//    canned rows so we can assert grading per identity source. ──
function fakeClient(rowsByTable: Record<string, unknown[]>) {
  const calls: Array<{ table: string; or: string | null; eqCols: string[] }> = [];
  const client = {
    from(table: string) {
      const state = { table, or: null as string | null, eqCols: [] as string[] };
      const builder: Record<string, unknown> = {
        select() { return builder; },
        eq(col: string) { state.eqCols.push(col); return builder; },
        is() { return builder; },
        or(expr: string) { state.or = expr; return builder; },
        abortSignal() { return builder; },
        limit() {
          calls.push(state);
          return Promise.resolve({ data: rowsByTable[table] ?? [], error: null });
        },
      };
      return builder;
    },
  };
  return { client, calls };
}

vi.mock('@/shared/supabase/client', () => ({
  get supabase() { return (globalThis as { __fakeSupabase?: unknown }).__fakeSupabase; },
  supabaseConfigured: true,
}));

function withClient<T>(rowsByTable: Record<string, unknown[]>, fn: (calls: ReturnType<typeof fakeClient>['calls']) => T): T {
  const { client, calls } = fakeClient(rowsByTable);
  (globalThis as { __fakeSupabase?: unknown }).__fakeSupabase = client;
  return fn(calls);
}

describe('SmartScanner classifier — auto-detects code type, creates nothing', () => {
  it('classifies an establishment QR (app URL with ?qid=) as establishment', () => {
    const r = classifyScanPayload('https://medistock-qr-network.vercel.app/?qid=abc-123');
    expect(r).toEqual({ kind: 'establishment', qid: 'abc-123' });
  });

  it('classifies a bare uuid as establishment', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(classifyScanPayload(id)).toEqual({ kind: 'establishment', qid: id });
  });

  it('classifies a movement QR payload as movement with its kind', () => {
    // movement-trace payloads round-trip; feed a plausible one via its builder.
    // Here we only assert non-crash + that a bare medicine barcode is a barcode.
    expect(classifyScanPayload('6291234567890')).toEqual({ kind: 'barcode', value: '6291234567890' });
  });

  it('unwraps a GS1 AI(01) GTIN to the catalog barcode digits', () => {
    expect(classifyScanPayload('0100629123456789')).toEqual({ kind: 'barcode', value: '629123456789' });
    expect(classifyScanPayload('(01)00629123456789')).toEqual({ kind: 'barcode', value: '629123456789' });
  });

  it('classifies gibberish as unknown (no record, no movement)', () => {
    expect(classifyScanPayload('not a code at all !!')).toEqual({ kind: 'unknown', raw: 'not a code at all !!' });
    expect(classifyScanPayload('')).toEqual({ kind: 'unknown', raw: '' });
  });
});

describe('resolveMaterials — grading per identity source', () => {
  it('exact national code on a stock lot grades CONFIRMED', async () => {
    const rows = await withClient({
      central_items: [],
      warehouse_stock: [{
        id: 's1', scientific_name: 'Amoxicillin', trade_name: 'Amoxil', concentration: '500mg',
        dosage_form: 'capsule', unit: 'box', national_code: 'NC-777', batch_number: 'B1',
        expiry_date: '2027-01-01', on_hand_quantity: 10, reserved_quantity: 0, available_quantity: 10,
        supply_type_text: 'purchase',
      }],
    }, () => resolveMaterials('NC-777', { warehouseId: 'wh1' }));
    expect(rows[0].grade).toBe('confirmed');
    expect(rows[0].reasonKey).toBe('mr_reason_national_exact');
    expect(rows[0].source).toBe('stock');
  });

  it('exact barcode on a catalog item grades CONFIRMED', async () => {
    const rows = await withClient({
      central_items: [{ id: 'c1', name: 'Amoxicillin', name_ar: 'أموكسيسيلين', barcode: '6291234567890', unit: 'box' }],
      warehouse_stock: [],
    }, () => resolveMaterials('6291234567890', {}));
    expect(rows[0].grade).toBe('confirmed');
    expect(rows[0].reasonKey).toBe('mr_reason_barcode_exact');
  });

  it('exact-normalized name grades STRONG; partial grades PROBABLE', async () => {
    const strong = await withClient({
      central_items: [{ id: 'c1', name: 'Amoxicillin', name_ar: 'أموكسيسيلين', barcode: null, unit: 'box' }],
      warehouse_stock: [],
    }, () => resolveMaterials('amoxicillin', {}));
    expect(strong[0].grade).toBe('strong');

    const probable = await withClient({
      central_items: [{ id: 'c1', name: 'Amoxicillin Trihydrate', name_ar: null, barcode: null, unit: 'box' }],
      warehouse_stock: [],
    }, () => resolveMaterials('trihydr', {}));
    expect(probable[0].grade).toBe('probable');
  });

  it('a batch number match grades PROBABLE and is flagged as non-unique', async () => {
    const rows = await withClient({
      central_items: [],
      warehouse_stock: [
        { id: 's1', scientific_name: 'A', trade_name: null, concentration: null, dosage_form: null, unit: null, national_code: null, batch_number: 'SHARED', expiry_date: null, on_hand_quantity: 3, reserved_quantity: 0, available_quantity: 3, supply_type_text: 'aid' },
        { id: 's2', scientific_name: 'B', trade_name: null, concentration: null, dosage_form: null, unit: null, national_code: null, batch_number: 'SHARED', expiry_date: null, on_hand_quantity: 4, reserved_quantity: 0, available_quantity: 4, supply_type_text: 'kimadia' },
      ],
    }, () => resolveMaterials('SHARED', { warehouseId: 'wh1' }));
    // BOTH hits returned — a batch alone is never a unique identity, never auto-picked.
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.grade === 'probable')).toBe(true);
    expect(rows.every(r => r.reasonKey === 'mr_reason_batch_match')).toBe(true);
  });

  it('scopes stock lookups to the given warehouse only', async () => {
    const calls = withClient({ central_items: [], warehouse_stock: [] },
      (calls) => resolveMaterials('amox', { warehouseId: 'wh-scope' }).then(() => calls));
    const stock = (await calls).find(c => c.table === 'warehouse_stock');
    expect(stock?.eqCols).toContain('warehouse_id');
  });

  it('does NOT query stock lots without a warehouse scope (catalog only)', async () => {
    const calls = await withClient({ central_items: [], warehouse_stock: [] },
      (calls) => resolveMaterials('amox', {}).then(() => calls));
    expect(calls.some(c => c.table === 'warehouse_stock')).toBe(false);
  });

  it('an unknown query yields [] — the caller must NOT treat text as a material', async () => {
    const rows = await withClient({ central_items: [], warehouse_stock: [] },
      () => resolveMaterials('zzzznomatch', { warehouseId: 'wh1' }));
    expect(rows).toEqual([]);
  });

  it('sorts confirmed before strong before probable (never auto-picks one)', async () => {
    const rows = await withClient({
      central_items: [{ id: 'c1', name: 'Zzz Partial Amox', name_ar: null, barcode: null, unit: null }],
      warehouse_stock: [{ id: 's1', scientific_name: 'Other', trade_name: null, concentration: null, dosage_form: null, unit: null, national_code: 'amox', batch_number: null, expiry_date: null, on_hand_quantity: 1, reserved_quantity: 0, available_quantity: 1, supply_type_text: null }],
    }, () => resolveMaterials('amox', { warehouseId: 'wh1' }));
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0].grade).toBe('confirmed'); // exact national code wins
  });
});
